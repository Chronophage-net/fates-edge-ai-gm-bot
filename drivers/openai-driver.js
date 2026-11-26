const { OpenAI } = require('openai');
const AIDriver = require('./ai-driver');

// Current OpenAI models (developers.openai.com, Nov 2026): gpt-6.2-astra
// and gpt-6.2-sol (flagships), gpt-6.1-terra (fast) and gpt-6-luna
// (cheapest). All reason; only Terra and Luna accept reasoning_effort
// "none". Terra is the default: quick enough for live narration.
const DEFAULT_MODEL = 'gpt-6.1-terra';

// GPT-5 onward and the o-series are reasoning models: they take
// max_completion_tokens (reasoning tokens count against it) and an effort.
const isReasoningModel = model => /^(o\d|gpt-([5-9]|\d{2}))/i.test(model);
const acceptsNoReasoning = model => /terra|luna|gpt-5\.[1-9]/i.test(model);

class OpenAIDriver extends AIDriver {
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey || process.env.OPENAI_API_KEY;
        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is required for OpenAI driver');
        }
        this.model = model || process.env.OPENAI_MODEL || DEFAULT_MODEL;
        // Visible reply budget (narration plus mechanical tags).
        this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || '1200', 10);
        this.temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.8');
        // A prompt budget for trimToFit(), not the model's ceiling: every
        // prompt token is billed on every turn.
        this.contextWindow = parseInt(process.env.OPENAI_CONTEXT_WINDOW || '128000', 10);
        this.timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '60000', 10);
        this.maxRetries = parseInt(process.env.OPENAI_MAX_RETRIES || '2', 10);

        // Live narration wants a fast reply, so reasoning is kept as low as
        // the model allows unless OPENAI_REASONING_EFFORT says otherwise.
        this.reasoning = isReasoningModel(this.model);
        this.reasoningEffort = process.env.OPENAI_REASONING_EFFORT
            || (this.reasoning ? (acceptsNoReasoning(this.model) ? 'none' : 'low') : null);
        // Reasoning tokens come out of the same completion budget, so the
        // visible budget gets this much on top when the model reasons.
        this.reasoningTokens = parseInt(process.env.OPENAI_REASONING_TOKENS || '4000', 10);

        // Parameter support differs between models and between OpenAI and
        // OpenAI-compatible servers (OPENAI_BASE_URL). Rejected parameters
        // are dropped or swapped once and remembered.
        this.params = {
            tokenField: 'max_completion_tokens',
            temperature: !this.reasoning || this.reasoningEffort === 'none',
            effort: !!this.reasoningEffort,
        };

        // The SDK retries 429/5xx with backoff and applies the timeout.
        this.client = new OpenAI({
            apiKey: this.apiKey,
            ...(process.env.OPENAI_BASE_URL ? { baseURL: process.env.OPENAI_BASE_URL } : {}),
            timeout: this.timeoutMs,
            maxRetries: this.maxRetries,
        });
    }

    _budget() {
        const reasons = this.params.effort && this.reasoningEffort && this.reasoningEffort !== 'none';
        return this.maxTokens + (reasons ? this.reasoningTokens : 0);
    }

    _request(messages, budget, extra = {}) {
        return {
            model: this.model,
            messages,
            [this.params.tokenField]: budget,
            ...(this.params.temperature ? { temperature: this.temperature } : {}),
            ...(this.params.effort ? { reasoning_effort: this.reasoningEffort } : {}),
            ...extra,
        };
    }

    /** Adjust to a 400 that names an unsupported parameter; true if worth retrying. */
    _adaptTo(error) {
        if (error?.status !== 400) return false;
        const text = String(error.message || '');
        if (this.params.temperature && /temperature/i.test(text)) { this.params.temperature = false; return true; }
        if (this.params.effort && /reasoning_effort|reasoning effort/i.test(text)) {
            // "none" refused: use the lowest effort every reasoning model takes.
            if (this.reasoningEffort === 'none') { this.reasoningEffort = 'low'; this.params.temperature = false; return true; }
            this.params.effort = false; return true;
        }
        if (/max_completion_tokens/i.test(text) && this.params.tokenField === 'max_completion_tokens') { this.params.tokenField = 'max_tokens'; return true; }
        if (/max_tokens/i.test(text) && this.params.tokenField === 'max_tokens') { this.params.tokenField = 'max_completion_tokens'; return true; }
        return false;
    }

    async _create(build, options) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                return await this.client.chat.completions.create(build(), options);
            } catch (e) {
                if (!this._adaptTo(e)) throw e;
                console.warn(`⚠️  OpenAI rejected a parameter for ${this.model}; adjusted and retrying (${e.message}).`);
            }
        }
        return this.client.chat.completions.create(build(), options);
    }

    async initialize() {
        try {
            console.log(`🔍 Testing OpenAI connection (model: ${this.model}${this.reasoningEffort ? `, reasoning ${this.reasoningEffort}` : ''})…`);
            await this._create(() => this._request([{ role: 'user', content: 'Hello' }], 16), {});
            console.log(`✅ OpenAI connection OK (model: ${this.model})`);
        } catch (e) {
            console.error(`❌ OpenAI initialization error: ${e.message}`);
            if (e.status === 401) console.error('   Your API key may be invalid. Check your OPENAI_API_KEY.');
            else if (e.status === 404) console.error(`   Model "${this.model}" is not available to this key. Set OPENAI_MODEL.`);
            else if (e.status === 429) console.error('   Rate limit or quota exceeded. Wait a moment before restarting.');
            else console.error('   Could not reach the OpenAI API.');
            // A bad key or model is a hard startup failure.
            throw e;
        }
    }

    _recordUsage(usage, promptEstimate, content, truncated) {
        if (usage) {
            this.recordUsage({ promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, truncated });
            const cached = usage.prompt_tokens_details?.cached_tokens;
            if (Number.isFinite(cached)) this.usage.cachedPromptTokens = (this.usage.cachedPromptTokens || 0) + cached;
        } else {
            this.recordUsage({ promptTokens: promptEstimate, completionTokens: this.estimateTokens(content), estimated: true, truncated });
        }
    }

    _friendlyError(e) {
        if (e.name === 'AbortError' || e.name === 'APIUserAbortError') {
            const err = new Error('Model request cancelled: the turn was superseded.');
            err.name = 'AbortError';
            return err;
        }
        if (e.status === 401) return new Error('OpenAI API key is invalid (401).');
        if (e.status === 404) return new Error(`OpenAI model "${this.model}" was not found (404). Set OPENAI_MODEL.`);
        if (e.status === 429) return new Error('OpenAI rate limit or quota exceeded (429).');
        if (e.status >= 500) return new Error(`OpenAI server error (${e.status}). Try again later.`);
        return new Error(`OpenAI API error: ${e.message}`);
    }

    async generateResponse(context, onToken) {
        // Last-resort trim to the prompt budget (see ai-driver.js).
        const { systemPrompt, messages: history } = this.trimToFit(context, { reserveTokens: this._budget() });
        const messages = [{ role: 'system', content: systemPrompt }, ...history];
        const promptEstimate = this.estimateTokens(systemPrompt) + history.reduce((n, m) => n + this.estimateTokens(m.content), 0);
        // Cancel the request when the GM turn is superseded.
        const signal = this._turnSignal();
        const options = signal ? { signal } : {};

        try {
            if (typeof onToken === 'function') return await this._generateStreaming(messages, onToken, promptEstimate, options);

            // A reasoning model can spend its whole budget before writing
            // any visible text; one retry with a larger budget recovers that.
            const budgets = [this._budget(), this._budget() * 3];
            for (let i = 0; i < budgets.length; i++) {
                const completion = await this._create(() => this._request(messages, budgets[i]), options);
                const choice = completion.choices?.[0];
                if (!choice) throw new Error('OpenAI returned no choices in response');
                const content = (choice.message?.content || '').trim();
                const truncated = !!(choice.finish_reason && choice.finish_reason !== 'stop');
                if (truncated) console.warn(`⚠️  OpenAI finish_reason was "${choice.finish_reason}" (model: ${this.model}) — response may be truncated or filtered.`);
                this._recordUsage(completion.usage, promptEstimate, content, truncated);
                if (content || !truncated || i === budgets.length - 1) return content;
                this.usage.emptyContentRetries = (this.usage.emptyContentRetries || 0) + 1;
                console.warn(`⚠️  Empty content on a truncated reply -- retrying once with a ${budgets[i + 1]}-token budget.`);
            }
            return '';
        } catch (e) {
            throw this._friendlyError(e);
        }
    }

    /** Streaming via the SDK's async iterator; resolves with the full text. */
    async _generateStreaming(messages, onToken, promptEstimate, options) {
        const stream = await this._create(() => this._request(messages, this._budget(), {
            stream: true,
            // One final chunk with the same usage object as non-streaming.
            stream_options: { include_usage: true },
        }), options);

        let full = '';
        let usage = null;
        let finishReason = null;
        for await (const part of stream) {
            const delta = part.choices?.[0]?.delta?.content;
            if (delta) { full += delta; onToken(delta); }
            if (part.choices?.[0]?.finish_reason) finishReason = part.choices[0].finish_reason;
            if (part.usage) usage = part.usage;
        }
        const truncated = !!(finishReason && finishReason !== 'stop');
        if (truncated) console.warn(`⚠️  OpenAI (streaming) finish_reason was "${finishReason}" (model: ${this.model}) — response may be truncated or filtered.`);
        this._recordUsage(usage, promptEstimate, full, truncated);
        return full.trim();
    }
}

OpenAIDriver.meta = {
    name: 'OpenAI',
    description: 'Uses OpenAI (default gpt-6.1-terra) or any OpenAI-compatible server via OPENAI_BASE_URL. Requires an API key.',
    requiredEnv: ['OPENAI_API_KEY']
};

module.exports = OpenAIDriver;
module.exports.isReasoningModel = isReasoningModel;
