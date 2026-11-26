// drivers/deepseek-driver.js
const AIDriver = require('./ai-driver');
const { parseSSEStream } = AIDriver;

// DeepSeek's OpenAI-format API. Models (api-docs.deepseek.com, Nov 2026):
//   deepseek-v4-pro  -- the default; strongest
//   deepseek-flash   -- faster and cheaper (V4.1 Flash)
// Both have a 1M-token context and think by default. `deepseek-v4-flash`
// is a legacy alias that DeepSeek now serves with deepseek-flash.
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const LEGACY_MODELS = { 'deepseek-v4-flash': 'deepseek-flash' };

class DeepSeekDriver extends AIDriver {
    constructor() {
        super();
        this.apiKey = process.env.DEEPSEEK_API_KEY;
        if (!this.apiKey) {
            throw new Error('DEEPSEEK_API_KEY environment variable is required for DeepSeek driver');
        }
        const configured = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
        if (LEGACY_MODELS[configured]) {
            console.warn(`⚠️  DEEPSEEK_MODEL=${configured} is a legacy name; DeepSeek serves it with ${LEGACY_MODELS[configured]}. Using that.`);
        }
        this.model = LEGACY_MODELS[configured] || configured;
        this.url = `${(process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;

        // Visible reply budget: a paragraph or two of narration plus its
        // mechanical tags ([ROLL], [APPLY HARM], ...). 400 cut replies off
        // mid-tag; 1200 leaves room. DEEPSEEK_MAX_TOKENS overrides.
        this.maxTokens = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '1200', 10);
        this.temperature = parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.8');
        // Idle timeout: how long to wait with no data before giving up.
        this.timeoutMs = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '60000', 10);
        this.maxRetries = parseInt(process.env.DEEPSEEK_MAX_RETRIES || '2', 10);
        // The models accept 1M tokens, but every prompt token is billed on
        // every turn. This is the budget trimToFit() works to, not the
        // model's ceiling; raise DEEPSEEK_CONTEXT_WINDOW (up to 1000000)
        // for very long campaigns.
        this.contextWindow = parseInt(process.env.DEEPSEEK_CONTEXT_WINDOW || '128000', 10);

        // Thinking mode is DeepSeek's default, but a live table wants a
        // quick narrated reply: thinking adds latency, ignores temperature,
        // and could spend the whole token budget before writing any visible
        // text (the empty-reply failure). Off by default here; set
        // DEEPSEEK_THINKING=enabled to turn it on, with
        // DEEPSEEK_REASONING_EFFORT=low|high|max.
        this.thinking = (process.env.DEEPSEEK_THINKING || 'disabled').toLowerCase() === 'enabled';
        this.reasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT || (this.thinking ? 'low' : null);
        // Extra completion budget for reasoning tokens when thinking is on.
        this.reasoningTokens = parseInt(process.env.DEEPSEEK_REASONING_TOKENS || '4000', 10);

        // Safety net for a reply that ran out of room before any visible
        // text: one retry with a larger budget. DEEPSEEK_EMPTY_RETRY_ENABLED
        // =false disables it; DEEPSEEK_EMPTY_RETRY_MULTIPLIER sizes it.
        this.emptyRetryMultiplier = parseFloat(process.env.DEEPSEEK_EMPTY_RETRY_MULTIPLIER || '4');
        this.emptyRetryEnabled = process.env.DEEPSEEK_EMPTY_RETRY_ENABLED !== 'false';
    }

    _headers() {
        return { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` };
    }

    _describeError(status, errText) {
        if (status === 401) return 'DeepSeek API key is invalid (401).';
        if (status === 402) return 'DeepSeek account has insufficient balance (402).';
        if (status === 429) return 'DeepSeek rate limit exceeded (429).';
        if (status === 400) return `DeepSeek bad request (400): ${errText}`;
        if (status >= 500) return `DeepSeek server error (${status}). ${errText}`;
        return `DeepSeek API error (${status}): ${errText}`;
    }

    /** Request body shared by every call; thinking and sampling settings live here only. */
    _body(messages, maxTokens, extra = {}) {
        return {
            model: this.model,
            messages,
            max_tokens: maxTokens,
            thinking: { type: this.thinking ? 'enabled' : 'disabled' },
            // Ignored in thinking mode, so only sent without it.
            ...(this.thinking ? {} : { temperature: this.temperature }),
            ...(this.thinking && this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {}),
            ...extra,
        };
    }

    _budget() {
        return this.maxTokens + (this.thinking ? this.reasoningTokens : 0);
    }

    async _request(body, { retries = 0 } = {}) {
        const response = await this._fetchWithRetries(this.url, {
            method: 'POST', headers: this._headers(), body: JSON.stringify(body),
        }, { retries, timeoutMs: this.timeoutMs, describeError: (s, t) => this._describeError(s, t) });
        return response.json();
    }

    async initialize() {
        console.log(`🔍 Testing DeepSeek connection (model: ${this.model}, thinking ${this.thinking ? 'on' : 'off'})…`);
        // A bad key or model is a hard startup failure, not a warning.
        await this._request({ model: this.model, messages: [{ role: 'user', content: 'Hello' }], max_tokens: 1, thinking: { type: 'disabled' } });
        console.log(`✅ DeepSeek connection OK (model: ${this.model})`);
    }

    _recordUsage(usage, prompt, content, truncated) {
        if (usage) {
            this.recordUsage({ promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, truncated });
            const cached = usage.prompt_cache_hit_tokens;
            if (Number.isFinite(cached)) this.usage.cachedPromptTokens = (this.usage.cachedPromptTokens || 0) + cached;
        } else {
            this.recordUsage({ promptTokens: prompt, completionTokens: this.estimateTokens(content), estimated: true, truncated });
        }
    }

    async generateResponse(context, onToken) {
        if (!context || typeof context.systemPrompt !== 'string') {
            throw new Error('generateResponse() requires a string context.systemPrompt');
        }
        // Last-resort trim to the configured budget (see ai-driver.js).
        const { systemPrompt, messages: history } = this.trimToFit(context, { reserveTokens: this._budget() });
        const messages = [{ role: 'system', content: systemPrompt }, ...history];
        const promptEstimate = this.estimateTokens(systemPrompt) + history.reduce((n, m) => n + this.estimateTokens(m.content), 0);

        if (typeof onToken === 'function') {
            return this._generateStreaming(messages, onToken, promptEstimate);
        }

        const budgets = this.emptyRetryEnabled
            ? [this._budget(), Math.min(Math.round(this._budget() * this.emptyRetryMultiplier), this.contextWindow)]
            : [this._budget()];
        for (let i = 0; i < budgets.length; i++) {
            const retrying = i > 0;
            const body = this._body(retrying
                ? [...messages, { role: 'user', content: '(Your previous reply ran out of room before producing any visible text. Answer directly now, within the length budget already given to you.)' }]
                : messages, budgets[i]);

            let data;
            try {
                data = await this._request(body, { retries: this.maxRetries });
            } catch (e) {
                if (e.name !== 'AbortError') console.error('DeepSeek request failed. Prompt length:', systemPrompt.length, 'History length:', history.length);
                throw e;
            }
            if (!data.choices || data.choices.length === 0) throw new Error('DeepSeek returned no choices in response');

            const choice = data.choices[0];
            const truncated = !!(choice.finish_reason && choice.finish_reason !== 'stop');
            const content = (choice.message?.content || '').trim();
            if (truncated) {
                console.warn(`⚠️  DeepSeek finish_reason was "${choice.finish_reason}" (model: ${this.model}, attempt ${i + 1}/${budgets.length}, max_tokens ${budgets[i]}) — response may be truncated or filtered.`);
                if (!content && choice.message?.reasoning_content) {
                    console.warn(`⚠️  ...content was empty but reasoning_content was present (${choice.message.reasoning_content.length} chars) -- the budget went to thinking.`);
                }
            }
            this._recordUsage(data.usage, promptEstimate, content, truncated);

            if (!(truncated && !content && i < budgets.length - 1)) return content;
            this.usage.emptyContentRetries = (this.usage.emptyContentRetries || 0) + 1;
            console.warn(`⚠️  Empty content on a truncated reply -- retrying once with max_tokens ${budgets[i + 1]}.`);
        }
        return '';
    }

    /**
     * Streaming (OpenAI-compatible SSE). The timeout is an idle timeout,
     * refreshed by every chunk, so a long reply that keeps arriving is
     * never cut off; only a stalled one is. Reasoning deltas are skipped.
     */
    async _generateStreaming(messages, onToken, promptEstimate) {
        const response = await this._fetchWithRetries(this.url, {
            method: 'POST', headers: this._headers(),
            body: JSON.stringify(this._body(messages, this._budget(), { stream: true, stream_options: { include_usage: true } })),
        }, { retries: this.maxRetries, timeoutMs: this.timeoutMs, stream: true, describeError: (s, t) => this._describeError(s, t) });
        const guard = response.guard;
        let full = '';
        let usage = null;
        let finishReason = null;
        try {
            if (!response.body) throw new Error('DeepSeek streaming response had no body.');
            for await (const chunk of parseSSEStream(response.body, guard.touch)) {
                if (chunk === '[DONE]') break;
                let parsed;
                try { parsed = JSON.parse(chunk); } catch { continue; } // skip a malformed frame
                const delta = parsed.choices?.[0]?.delta?.content;
                if (delta) { full += delta; onToken(delta); }
                if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
                if (parsed.usage) usage = parsed.usage;
            }
        } catch (e) {
            if (e.name === 'AbortError') throw this._abortError(guard, this.url, this.timeoutMs);
            throw e;
        } finally {
            guard.done();
        }
        const truncated = !!(finishReason && finishReason !== 'stop');
        if (truncated) console.warn(`⚠️  DeepSeek (streaming) finish_reason was "${finishReason}" (model: ${this.model}) — response may be truncated or filtered.`);
        this._recordUsage(usage, promptEstimate, full, truncated);
        return full.trim();
    }
}

DeepSeekDriver.meta = {
    name: 'DeepSeek',
    description: 'Uses the DeepSeek API (deepseek-v4-pro, or deepseek-flash for speed). Requires an API key.',
    requiredEnv: ['DEEPSEEK_API_KEY']
};

module.exports = DeepSeekDriver;
module.exports.parseSSEStream = parseSSEStream;
