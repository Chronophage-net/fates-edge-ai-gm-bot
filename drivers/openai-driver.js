const { OpenAI } = require('openai');
const AIDriver = require('./ai-driver');

class OpenAIDriver extends AIDriver {
    constructor(apiKey, model) {
        super();
        this.apiKey = apiKey || process.env.OPENAI_API_KEY;
        if (!this.apiKey) {
            throw new Error('OPENAI_API_KEY environment variable is required for OpenAI driver');
        }
        this.model = model || process.env.OPENAI_MODEL || 'gpt-4o-mini';
        // CHANGED: see deepseek-driver.js -- 400 tokens routinely truncated
        // mid-tag. 1200 matches the other drivers' new default; override
        // via OPENAI_MAX_TOKENS.
        this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || '1200', 10);
        this.temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.8');
        // gpt-4o-mini's real context window; overridable for other models.
        this.contextWindow = parseInt(process.env.OPENAI_CONTEXT_WINDOW || '128000', 10);
        this.timeoutMs = parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10);
        this.maxRetries = parseInt(process.env.OPENAI_MAX_RETRIES || '2', 10);

        // CHANGED: previously had no retries and no timeout at all --
        // the SDK's own `timeout`/`maxRetries` client options handle both
        // uniformly (it already retries 429/5xx with backoff internally
        // when maxRetries > 0), matching what deepseek-driver.js hand-rolls.
        // No custom retry loop needed here; the official SDK already does
        // the right thing once you actually tell it to.
        this.client = new OpenAI({
            apiKey: this.apiKey,
            timeout: this.timeoutMs,
            maxRetries: this.maxRetries
        });
    }

    async initialize() {
        try {
            console.log(`🔍 Testing OpenAI connection (model: ${this.model})…`);
            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages: [{ role: 'user', content: 'Hello' }],
                max_tokens: 1,
                temperature: 0
            });
            console.log(`✅ OpenAI connection OK (model: ${this.model})`);
        } catch (e) {
            console.error(`❌ OpenAI initialization error: ${e.message}`);
            if (e.status === 401) {
                console.error('   Your API key may be invalid. Check your OPENAI_API_KEY.');
            } else if (e.status === 429) {
                console.error('   Rate limit exceeded. Wait a moment before restarting.');
            } else {
                console.error('   Could not reach OpenAI API.');
            }
            // CHANGED: this used to swallow the error entirely, so a bad
            // key or unreachable API left the bot silently "initialized"
            // and connected to chat, failing every real message instead
            // of failing fast at startup. Let it propagate like
            // deepseek-driver.js already does -- main.js treats an
            // initialize() failure as a hard startup failure now.
            throw e;
        }
    }

    async generateResponse(context, onToken) {
        // Trim to fit this model's real context window before sending --
        // see ai-driver.js's trimToFit(). Last-resort safety net; the
        // orchestrator should already be sending a pruned prompt.
        const { systemPrompt, messages: history } = this.trimToFit(context);
        const messages = [{ role: 'system', content: systemPrompt }, ...history];

        try {
            if (onToken && typeof onToken === 'function') {
                return await this._generateStreaming(messages, onToken, systemPrompt, history);
            }

            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
            });

            if (!completion.choices || completion.choices.length === 0) {
                throw new Error('OpenAI returned no choices in response');
            }

            // NEW: mirror deepseek-driver.js's truncation warning.
            const finishReason = completion.choices[0].finish_reason;
            if (finishReason && finishReason !== 'stop') {
                console.warn(`⚠️  OpenAI finish_reason was "${finishReason}" (model: ${this.model}) — response may be truncated or filtered.`);
            }

            if (completion.usage) {
                this.recordUsage({
                    promptTokens: completion.usage.prompt_tokens || 0,
                    completionTokens: completion.usage.completion_tokens || 0
                });
            } else {
                this.recordUsage({
                    promptTokens: this.estimateTokens(systemPrompt) + history.reduce((n, m) => n + this.estimateTokens(m.content), 0),
                    completionTokens: this.estimateTokens(completion.choices[0].message?.content || ''),
                    estimated: true
                });
            }

            return (completion.choices[0].message?.content || '').trim();
        } catch (e) {
            let errMsg = `OpenAI API error: ${e.message}`;
            if (e.status === 401) errMsg = 'OpenAI API key is invalid (401).';
            if (e.status === 429) errMsg = 'OpenAI rate limit exceeded (429). Slow down.';
            if (e.status === 500) errMsg = 'OpenAI server error (500). Try again later.';
            throw new Error(errMsg);
        }
    }

    /**
     * Streaming path via the SDK's own async-iterator support
     * (`stream: true`). Always resolves with the full assembled text so
     * callers that don't pass onToken see identical behavior to before.
     */
    async _generateStreaming(messages, onToken, systemPrompt, history) {
        const stream = await this.client.chat.completions.create({
            model: this.model,
            messages,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            stream: true,
            // Asks the API to emit one final chunk carrying the same
            // `usage` object the non-streaming path gets, so streamed
            // replies feed the session token total too instead of being
            // invisible to it.
            stream_options: { include_usage: true }
        });

        let full = '';
        let usage = null;
        for await (const part of stream) {
            const delta = part.choices?.[0]?.delta?.content;
            if (delta) {
                full += delta;
                onToken(delta);
            }
            if (part.usage) usage = part.usage;
        }
        if (usage) {
            this.recordUsage({
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0
            });
        } else {
            this.recordUsage({
                promptTokens: this.estimateTokens(systemPrompt || '') + (history || []).reduce((n, m) => n + this.estimateTokens(m.content), 0),
                completionTokens: this.estimateTokens(full),
                estimated: true
            });
        }
        return full.trim();
    }
}

OpenAIDriver.meta = {
    name: 'OpenAI',
    description: 'Uses GPT-4o-mini (or another OpenAI model). Requires an API key.',
    requiredEnv: ['OPENAI_API_KEY']
};

module.exports = OpenAIDriver;
