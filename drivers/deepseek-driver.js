// drivers/deepseek-driver.js
const AIDriver = require('./ai-driver');

const API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Status codes worth retrying — transient by nature, not the caller's fault.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

class DeepSeekDriver extends AIDriver {
    constructor() {
        super();
        this.apiKey = process.env.DEEPSEEK_API_KEY;
        if (!this.apiKey) {
            throw new Error('DEEPSEEK_API_KEY environment variable is required for DeepSeek driver');
        }
        this.model = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
        // CHANGED: 400 was too low in practice -- a GM turn routinely
        // needs room for a paragraph or two of narration PLUS several
        // mechanical tags ([NPC CREATE], [ROLL]/[CALL FOR ROLL], [APPLY
        // HARM], etc.), each of which costs real completion tokens before
        // any of the actual prose. At 400 the model frequently got cut off
        // mid-tag, which left a dangling, unclosed bracket for
        // processSpecialTags() to untangle (see closeUnterminatedAITags())
        // and made every turn feel slow/stuck resolving garbage. 1200 gives
        // realistic headroom while still being cheap; override via
        // DEEPSEEK_MAX_TOKENS if a campaign needs more or less.
        this.maxTokens = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '1200', 10);
        this.temperature = parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.8');
        this.timeoutMs = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '30000', 10);
        this.maxRetries = parseInt(process.env.DEEPSEEK_MAX_RETRIES || '2', 10);
        // DeepSeek V4's real context window; overridable in case a
        // different model alias is configured.
        this.contextWindow = parseInt(process.env.DEEPSEEK_CONTEXT_WINDOW || '64000', 10);
        // NEW: optional passthrough for whatever reasoning-control knob
        // this model/endpoint actually honors -- official DeepSeek
        // "deepseek-reasoner" doesn't expose one, but several
        // OpenAI-compatible aggregators/proxies serving DeepSeek models
        // (and this account's model alias, "deepseek-v4-pro", isn't a
        // published DeepSeek Platform model name, so it may well be
        // fronted by one) accept "reasoning_effort" the same way OpenAI's
        // o-series does. Unset by default -- sending an unrecognized
        // field is normally harmless (ignored), but this stays opt-in
        // rather than guessing a value, since an unsupported endpoint's
        // behavior on an unknown field isn't guaranteed. If the empty-
        // content-on-truncation issue (see generateResponse()'s retry
        // logic below) keeps recurring, setting this to "low"/"minimal"
        // is worth trying to cut the invisible reasoning-token spend at
        // the source instead of just retrying after the fact.
        this.reasoningEffort = process.env.DEEPSEEK_REASONING_EFFORT || null;
        // NEW: the empty-content-on-truncation retry (see
        // generateResponse()) re-sends the WHOLE prompt again at a
        // higher max_tokens -- essentially double-billing that turn's
        // prompt tokens if it fires. Both the multiplier and the ability
        // to disable it entirely are configurable, since how often it's
        // worth firing (and how much headroom to give it) depends on how
        // often this failure mode actually shows up for a given
        // model/endpoint -- see the "Truncated replies" dashboard stat
        // (modules/status-server.js) to gauge that empirically instead
        // of guessing.
        this.emptyRetryMultiplier = parseFloat(process.env.DEEPSEEK_EMPTY_RETRY_MULTIPLIER || '4');
        this.emptyRetryEnabled = process.env.DEEPSEEK_EMPTY_RETRY_ENABLED !== 'false';
    }

    /**
     * Shared request logic for both the startup connectivity check and
     * real generation calls, so error handling/timeouts/retries can't
     * drift between the two paths.
     */
    async _request(body, { retries = 0 } = {}) {
        let attempt = 0;
        let lastErr;

        while (attempt <= retries) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), this.timeoutMs);

            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${this.apiKey}`
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal
                });
                clearTimeout(timer);

                if (!response.ok) {
                    const errText = await response.text().catch(() => '(no body)');
                    const err = new Error(this._describeError(response.status, errText));
                    err.status = response.status;
                    if (RETRYABLE_STATUSES.has(response.status) && attempt < retries) {
                        lastErr = err;
                        attempt++;
                        await this._backoff(attempt);
                        continue;
                    }
                    throw err;
                }

                return await response.json();
            } catch (e) {
                clearTimeout(timer);
                if (e.name === 'AbortError') {
                    lastErr = new Error(`DeepSeek request timed out after ${this.timeoutMs}ms.`);
                } else {
                    lastErr = e;
                }
                // Retry network-level failures too (e.g. ECONNRESET), not just HTTP statuses.
                if (attempt < retries && (e.name === 'AbortError' || !e.status)) {
                    attempt++;
                    await this._backoff(attempt);
                    continue;
                }
                throw lastErr;
            }
        }
        throw lastErr;
    }

    _backoff(attempt) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        return new Promise(resolve => setTimeout(resolve, delay));
    }

    _describeError(status, errText) {
        if (status === 401) return 'DeepSeek API key is invalid (401).';
        if (status === 429) return 'DeepSeek rate limit exceeded (429).';
        if (status === 400) return `DeepSeek bad request (400): ${errText}`;
        if (status >= 500) return `DeepSeek server error (${status}). ${errText}`;
        return `DeepSeek API error (${status}): ${errText}`;
    }

    async initialize() {
        console.log(`🔍 Testing DeepSeek connection (model: ${this.model})…`);
        // Let failures propagate — main.js already wraps this call in a
        // try/catch and should treat a bad key as a hard startup failure,
        // not a warning it prints once and then ignores.
        await this._request({
            model: this.model,
            messages: [{ role: 'user', content: 'Hello' }],
            max_tokens: 1,
            temperature: 0
        });
        console.log(`✅ DeepSeek connection OK (model: ${this.model})`);
    }

    async generateResponse(context, onToken) {
        if (!context || typeof context.systemPrompt !== 'string') {
            throw new Error('generateResponse() requires a string context.systemPrompt');
        }
        // Trim to fit this model's real context window BEFORE sending --
        // see ai-driver.js's trimToFit(). This is a last-resort safety
        // net; the orchestrator should already be sending a pruned
        // prompt, but a driver should never blindly trust that and let
        // the provider silently truncate whatever it feels like instead.
        const { systemPrompt, messages: history } = this.trimToFit(context);

        if (onToken && typeof onToken === 'function') {
            return this._generateStreaming(systemPrompt, history, onToken);
        }

        // NEW ("empty content, finish_reason: length"): confirmed live --
        // this model can burn its ENTIRE max_tokens budget on invisible
        // reasoning/thinking tokens (returned separately as
        // `reasoning_content`, if the API exposes it at all) and hit the
        // ceiling before ever emitting a single character of the actual
        // reply, leaving `choice.message.content` empty/null while
        // finish_reason still reads "length". That's indistinguishable,
        // from the caller's side, from a genuinely truncated normal
        // reply -- except the caller gets NOTHING instead of a partial
        // sentence to work with. One capped retry with a much larger
        // budget and an explicit "stop deliberating, answer now"
        // instruction gives the model room to actually finish a turn
        // instead of the table silently losing it. Only retries when
        // content came back empty; a normal (non-empty) truncated reply
        // still returns as-is, same as before.
        // NEW: retry is now off-by-default-config'able (DEEPSEEK_EMPTY_RETRY_ENABLED=false
        // to disable) and its budget multiplier tunable (DEEPSEEK_EMPTY_RETRY_MULTIPLIER,
        // default 4x) -- see the constructor. Disabling collapses this to
        // the original single-attempt behavior.
        const attemptTokenBudgets = this.emptyRetryEnabled
            ? [this.maxTokens, Math.min(Math.round(this.maxTokens * this.emptyRetryMultiplier), this.contextWindow)]
            : [this.maxTokens];
        let lastChoice = null;
        for (let i = 0; i < attemptTokenBudgets.length; i++) {
            const isRetry = i > 0;
            const body = {
                model: this.model,
                messages: isRetry
                    ? [
                        { role: 'system', content: systemPrompt },
                        ...history,
                        { role: 'user', content: '(Your previous reply ran out of room before producing any visible text. Skip any extended internal deliberation and answer directly now, within the length budget already given to you.)' },
                    ]
                    : [{ role: 'system', content: systemPrompt }, ...history],
                max_tokens: attemptTokenBudgets[i],
                temperature: this.temperature,
                stream: false,
                // NEW: optional passthrough -- see constructor. Omitted
                // entirely (not sent as null/undefined) when unset, so an
                // endpoint that validates unknown-but-present fields
                // strictly still isn't affected by default.
                ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {})
            };

            let data;
            try {
                data = await this._request(body, { retries: this.maxRetries });
            } catch (e) {
                console.error('DeepSeek request failed. Prompt length:', systemPrompt.length,
                    'History length:', history.length);
                throw e;
            }

            if (!data.choices || data.choices.length === 0) {
                throw new Error('DeepSeek returned no choices in response');
            }

            const choice = data.choices[0];
            lastChoice = choice;
            const truncated = !!(choice.finish_reason && choice.finish_reason !== 'stop');
            const content = (choice.message?.content || '').trim();

            if (truncated) {
                console.warn(`⚠️  DeepSeek finish_reason was "${choice.finish_reason}" (model: ${this.model}, attempt ${i + 1}/${attemptTokenBudgets.length}, max_tokens ${attemptTokenBudgets[i]}) — response may be truncated or filtered.`);
                if (!content && choice.message?.reasoning_content) {
                    console.warn(`⚠️  ...content was empty but reasoning_content was present (${choice.message.reasoning_content.length} chars) -- the model spent its whole budget "thinking" and never got to an answer.`);
                }
            }

            if (data.usage) {
                this.recordUsage({
                    promptTokens: data.usage.prompt_tokens || 0,
                    completionTokens: data.usage.completion_tokens || 0,
                    truncated
                });
            } else {
                this.recordUsage({
                    promptTokens: this.estimateTokens(systemPrompt) + history.reduce((n, m) => n + this.estimateTokens(m.content), 0),
                    completionTokens: this.estimateTokens(content),
                    estimated: true,
                    truncated
                });
            }

            const shouldRetry = truncated && !content && i < attemptTokenBudgets.length - 1;
            if (!shouldRetry) {
                return content;
            }
            // NEW: counted separately from recordUsage()'s per-call stats
            // (this is a retry EVENT, not a token count) and surfaced on
            // the status dashboard -- see modules/status-server.js --
            // so how often this expensive-double-prompt path actually
            // fires is visible instead of only ever showing up as a
            // console warning.
            this.usage.emptyContentRetries = (this.usage.emptyContentRetries || 0) + 1;
            console.warn(`⚠️  Empty content on a truncated reply -- retrying once with max_tokens ${attemptTokenBudgets[i + 1]}.`);
        }

        return (lastChoice?.message?.content || '').trim();
    }

    /**
     * Streaming path (OpenAI-compatible SSE). No retry here -- a stream
     * that fails partway through can't be resumed transparently, so this
     * makes a single attempt and lets the caller fall back to a
     * non-streaming retry if it cares to. Always resolves with the full
     * assembled text, same as the non-streaming path, so callers that
     * don't care about the intermediate onToken events still work.
     */
    async _generateStreaming(systemPrompt, history, onToken) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let full = '';
        try {
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'system', content: systemPrompt }, ...history],
                    max_tokens: this.maxTokens,
                    temperature: this.temperature,
                    stream: true,
                    // OpenAI-compatible option DeepSeek's API also
                    // supports -- emits a final usage-only chunk so
                    // streamed replies feed the session token total too.
                    stream_options: { include_usage: true },
                    // NEW: same optional passthrough as the non-streaming
                    // path -- see constructor.
                    ...(this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {})
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '(no body)');
                throw new Error(this._describeError(response.status, errText));
            }
            if (!response.body) {
                throw new Error('DeepSeek streaming response had no body.');
            }

            let usage = null;
            let finishReason = null;
            for await (const chunk of parseSSEStream(response.body)) {
                if (chunk === '[DONE]') break;
                try {
                    const parsed = JSON.parse(chunk);
                    const delta = parsed.choices?.[0]?.delta?.content;
                    if (delta) {
                        full += delta;
                        onToken(delta);
                    }
                    // NEW: the final content-bearing chunk carries finish_reason
                    // (it's null on every delta chunk until then) -- capture it
                    // the same way the non-streaming path does, so a truncated
                    // streamed reply also counts toward the dashboard's
                    // "Truncated replies" stat instead of only ever being
                    // logged for non-streaming calls.
                    if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason;
                    if (parsed.usage) usage = parsed.usage;
                } catch (e) {
                    // Malformed/partial SSE frame -- skip it rather than abort the whole stream.
                }
            }
            const truncated = !!(finishReason && finishReason !== 'stop');
            if (truncated) {
                console.warn(`⚠️  DeepSeek (streaming) finish_reason was "${finishReason}" (model: ${this.model}) — response may be truncated or filtered.`);
            }
            if (usage) {
                this.recordUsage({
                    promptTokens: usage.prompt_tokens || 0,
                    completionTokens: usage.completion_tokens || 0,
                    truncated
                });
            } else {
                this.recordUsage({
                    promptTokens: this.estimateTokens(systemPrompt) + history.reduce((n, m) => n + this.estimateTokens(m.content), 0),
                    completionTokens: this.estimateTokens(full),
                    estimated: true,
                    truncated
                });
            }
            return full.trim();
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Parses a fetch() Response body (Node ReadableStream) of OpenAI-style
 * SSE ("data: {...}\n\n" frames) into an async iterator of raw data
 * payload strings. Shared shape with any other OpenAI-compatible SSE
 * stream, so it's exported for reuse rather than duplicated per driver.
 */
async function* parseSSEStream(body) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of frame.split('\n')) {
                if (line.startsWith('data:')) {
                    yield line.slice(5).trim();
                }
            }
        }
    }
}

DeepSeekDriver.meta = {
    name: 'DeepSeek',
    description: 'Uses the DeepSeek V4 API (deepseek-v4-pro or deepseek-v4-flash). Requires an API key.',
    requiredEnv: ['DEEPSEEK_API_KEY']
};

module.exports = DeepSeekDriver;