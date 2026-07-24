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
        this.maxTokens = parseInt(process.env.DEEPSEEK_MAX_TOKENS || '400', 10);
        this.temperature = parseFloat(process.env.DEEPSEEK_TEMPERATURE || '0.8');
        this.timeoutMs = parseInt(process.env.DEEPSEEK_TIMEOUT_MS || '30000', 10);
        this.maxRetries = parseInt(process.env.DEEPSEEK_MAX_RETRIES || '2', 10);
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

    async generateResponse(context) {
        if (!context || typeof context.systemPrompt !== 'string') {
            throw new Error('generateResponse() requires a string context.systemPrompt');
        }
        const history = Array.isArray(context.messages) ? context.messages : [];

        const body = {
            model: this.model,
            messages: [{ role: 'system', content: context.systemPrompt }, ...history],
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            stream: false
        };

        let data;
        try {
            data = await this._request(body, { retries: this.maxRetries });
        } catch (e) {
            console.error('DeepSeek request failed. Prompt length:', context.systemPrompt.length,
                'History length:', history.length);
            throw e;
        }

        if (!data.choices || data.choices.length === 0) {
            throw new Error('DeepSeek returned no choices in response');
        }

        const choice = data.choices[0];
        if (choice.finish_reason && choice.finish_reason !== 'stop') {
            console.warn(`⚠️  DeepSeek finish_reason was "${choice.finish_reason}" (model: ${this.model}) — response may be truncated or filtered.`);
        }

        return (choice.message?.content || '').trim();
    }
}

DeepSeekDriver.meta = {
    name: 'DeepSeek',
    description: 'Uses the DeepSeek V4 API (deepseek-v4-pro or deepseek-v4-flash). Requires an API key.',
    requiredEnv: ['DEEPSEEK_API_KEY']
};

module.exports = DeepSeekDriver;