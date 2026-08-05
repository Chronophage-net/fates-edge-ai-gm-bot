/**
 * Abstract AI Driver – defines the contract for all backends.
 *
 * Also hosts shared, driver-agnostic utilities so behavior doesn't drift
 * between backends (see review feedback: "Retry Inconsistency" and "The
 * Token Tax"):
 *   - contextWindow / estimateTokens / trimToFit — every driver knows its
 *     own model's context window and trims context to fit BEFORE sending,
 *     instead of silently letting the provider's API truncate whatever it
 *     feels like (which, for local models especially, tends to drop the
 *     character sheets and rules text first since ai-gm-bot.js puts them
 *     early in the system prompt).
 *   - _fetchWithRetries — a shared retry/backoff/timeout helper for
 *     drivers that talk to a raw HTTP API (DeepSeek, Ollama) instead of an
 *     SDK with its own retry handling (OpenAI).
 */
class AIDriver {
    constructor() {
        // Conservative default for an unknown/local model. Subclasses
        // should override with their actual model's real window, and
        // ideally let it be overridden via an env var since e.g. Ollama's
        // context window depends entirely on which model the operator
        // pointed it at.
        this.contextWindow = 8192;
    }

    /**
     * Optional async setup (load models, etc.)
     */
    async initialize() {}

    /**
     * Generate a narrative response from a conversation history.
     *
     * @param {Object} context
     * @param {string} context.systemPrompt – system instructions for the GM
     * @param {Array}  context.messages – array of { role: 'user'|'assistant', content: string }
     * @param {Function} [onToken] – optional streaming callback, called
     *   with each incremental text chunk as it arrives. Drivers that
     *   support streaming should call this if provided; either way, the
     *   full assembled reply is still returned/resolved at the end, so
     *   callers that don't care about streaming can ignore the parameter
     *   entirely and nothing changes for them.
     * @returns {Promise<string>} – the generated reply
     */
    async generateResponse(context, onToken) {
        throw new Error('generateResponse() must be implemented by driver');
    }

    /**
     * Optional cleanup on shutdown.
     */
    async shutdown() {}

    // ── Context-window trimming ────────────────────────────────────

    /**
     * Rough token estimate. Not tokenizer-accurate (that would require a
     * per-model tokenizer dependency this bot has no other need for), but
     * good enough to budget against a context window with a safety
     * margin — English prose averages ~4 characters/token.
     */
    estimateTokens(text) {
        return Math.ceil((text || '').length / 4);
    }

    /**
     * Trims {systemPrompt, messages} to fit inside this.contextWindow,
     * minus room for the response itself. Two-stage:
     *   1. If the system prompt alone is too large, truncate its MIDDLE
     *      (keeping the head — instructions/rules — and the tail — which
     *      in ai-gm-bot.js's construction ends with the live character
     *      sheets and current Story Beats — since those are exactly what
     *      review feedback flagged as getting silently dropped by
     *      provider-side truncation).
     *   2. Drop the OLDEST chat messages first until what's left fits,
     *      always keeping at least the single most recent message so a
     *      reply is still possible.
     *
     * @param {{systemPrompt: string, messages: Array}} context
     * @param {{reserveTokens?: number}} [opts] – tokens to reserve for
     *   the model's own response (defaults to this.maxTokens if the
     *   driver set one, else 500).
     */
    trimToFit(context, opts = {}) {
        const reserve = opts.reserveTokens || this.maxTokens || 500;
        // Small fixed safety margin — token estimate is approximate, and
        // providers count a few extra tokens per message for role/formatting.
        const budget = Math.max(512, this.contextWindow - reserve - 200);

        let systemPrompt = context.systemPrompt || '';
        let messages = Array.isArray(context.messages) ? context.messages.slice() : [];

        let sysTokens = this.estimateTokens(systemPrompt);
        const maxSysTokens = Math.floor(budget * 0.7); // leave room for at least some history
        if (sysTokens > maxSysTokens) {
            const maxChars = maxSysTokens * 4;
            const headLen = Math.floor(maxChars * 0.6);
            const tailLen = maxChars - headLen;
            const notice = '\n\n[...system context trimmed to fit this model\'s context window...]\n\n';
            systemPrompt = systemPrompt.slice(0, headLen) + notice + systemPrompt.slice(-tailLen);
            sysTokens = this.estimateTokens(systemPrompt);
            console.warn(`[${this.constructor.name}] System prompt truncated to fit contextWindow=${this.contextWindow} (was ~${this.estimateTokens(context.systemPrompt)} tokens).`);
        }

        let remaining = budget - sysTokens;
        const kept = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            const t = this.estimateTokens(messages[i]?.content || '');
            if (t > remaining && kept.length > 0) break; // always keep at least the newest message
            kept.unshift(messages[i]);
            remaining -= t;
            if (remaining <= 0) break;
        }
        if (kept.length < messages.length) {
            console.warn(`[${this.constructor.name}] Dropped ${messages.length - kept.length} oldest message(s) to fit contextWindow=${this.contextWindow}.`);
        }

        return { systemPrompt, messages: kept };
    }

    // ── Shared HTTP retry/backoff/timeout helper ───────────────────

    /**
     * Fetch JSON from a raw HTTP API with timeout + retry/backoff on
     * transient failures (429/5xx/network errors). Shared so this logic
     * doesn't have to be hand-rolled (and drift) in every driver that
     * talks to a plain HTTP API instead of an SDK — see review feedback:
     * DeepSeek had this, OpenAI/Ollama didn't.
     *
     * @param {string} url
     * @param {object} fetchOptions - passed to fetch() as-is (method,
     *   headers, body, ...). `signal` is added/overridden internally.
     * @param {object} [opts]
     * @param {number} [opts.retries=2]
     * @param {number} [opts.timeoutMs=30000]
     * @param {Set<number>} [opts.retryableStatuses] - HTTP statuses worth
     *   retrying. Defaults to {429,500,502,503,504}.
     * @param {(status:number, bodyText:string) => string} [opts.describeError]
     *   - formats a human-readable error message for a non-ok response.
     */
    async _fetchWithRetries(url, fetchOptions = {}, opts = {}) {
        const retries = opts.retries ?? 2;
        const timeoutMs = opts.timeoutMs ?? 30000;
        const retryableStatuses = opts.retryableStatuses || new Set([429, 500, 502, 503, 504]);
        const describeError = opts.describeError || ((status, text) => `HTTP ${status}: ${text}`);

        let attempt = 0;
        let lastErr;

        while (attempt <= retries) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await fetch(url, { ...fetchOptions, signal: controller.signal });
                clearTimeout(timer);

                if (!response.ok) {
                    const errText = await response.text().catch(() => '(no body)');
                    const err = new Error(describeError(response.status, errText));
                    err.status = response.status;
                    if (retryableStatuses.has(response.status) && attempt < retries) {
                        lastErr = err;
                        attempt++;
                        await this._backoff(attempt);
                        continue;
                    }
                    throw err;
                }

                return response;
            } catch (e) {
                clearTimeout(timer);
                if (e.name === 'AbortError') {
                    lastErr = new Error(`Request to ${url} timed out after ${timeoutMs}ms.`);
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
}

module.exports = AIDriver;
