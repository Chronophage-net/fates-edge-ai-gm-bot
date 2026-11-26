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

        // ── Session token usage (for the status dashboard) ──────────
        // Every driver accumulates here via recordUsage() after each
        // generateResponse() call. Prefer real usage figures the
        // provider's API returns; drivers fall back to estimateTokens()
        // when the API doesn't report it (e.g. Ollama's non-streaming
        // response does, but the streaming path doesn't always).
        this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0, estimated: false, truncatedCalls: 0 };
    }

    /**
     * Optional async setup (load models, etc.)
     */
    async initialize() {}

    /**
     * Accumulate token usage from one generateResponse() call into this
     * driver's running session total. `estimated: true` means at least
     * one call so far had to fall back to estimateTokens() rather than a
     * real API-reported count, so the dashboard can label the total
     * "~approx" instead of implying precision it doesn't have.
     */
    recordUsage({ promptTokens = 0, completionTokens = 0, estimated = false, truncated = false } = {}) {
        this.usage.promptTokens += promptTokens;
        this.usage.completionTokens += completionTokens;
        this.usage.totalTokens += promptTokens + completionTokens;
        this.usage.calls += 1;
        if (estimated) this.usage.estimated = true;
        // NEW: surfaces on the status dashboard as "Truncated replies" --
        // a call whose provider-reported finish_reason wasn't "stop"
        // (hit the max_tokens ceiling, or was filtered) hit a real ceiling
        // regardless of how short the average completion length looks in
        // the aggregate totals above.
        if (truncated) this.usage.truncatedCalls += 1;
    }

    /** Current session usage totals, for the status dashboard. */
    getUsage() {
        return { ...this.usage };
    }

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

    // ── Cancellation ───────────────────────────────────────────────

    /**
     * The abort signal of the GM turn this call belongs to, if any
     * (modules/turn-lifecycle.js). When a turn is superseded -- a newer
     * message, a role change, a reconnect -- its in-flight model request
     * is cancelled instead of running on and billing tokens nobody reads.
     */
    _turnSignal() {
        try { return require('../modules/turn-lifecycle').signal() || null; } catch { return null; }
    }

    /**
     * An abort signal that fires on the turn's cancellation or after
     * `timeoutMs` of inactivity. Call touch() whenever data arrives
     * (streaming) to restart the idle clock, and done() when finished.
     */
    _requestGuard(timeoutMs) {
        const controller = new AbortController();
        let timedOut = false;
        let timer = null;
        const arm = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
        };
        arm();
        const turn = this._turnSignal();
        const onTurnAbort = () => controller.abort();
        if (turn) {
            if (turn.aborted) controller.abort();
            else turn.addEventListener('abort', onTurnAbort, { once: true });
        }
        return {
            signal: controller.signal,
            touch: arm,
            timedOut: () => timedOut,
            cancelled: () => !!turn?.aborted,
            done: () => { clearTimeout(timer); turn?.removeEventListener('abort', onTurnAbort); },
        };
    }

    /** The error to throw when a guarded request was aborted. */
    _abortError(guard, url, timeoutMs) {
        if (guard.cancelled()) {
            const err = new Error('Model request cancelled: the turn was superseded.');
            err.name = 'AbortError';
            return err;
        }
        return new Error(`Request to ${url} timed out after ${timeoutMs}ms without a response.`);
    }

    // ── Shared HTTP retry/backoff/timeout helper ───────────────────

    /**
     * Fetch from a raw HTTP API with timeout, cancellation and
     * retry/backoff on transient failures (429/5xx/network errors).
     * Honors a 429/503 Retry-After header. Returns the Response; for a
     * streamed body pass `{ stream: true }` and read it with the returned
     * guard (`response.guard`) so the idle timeout keeps running until the
     * stream ends -- call guard.done() when finished.
     *
     * @param {string} url
     * @param {object} fetchOptions - passed to fetch() (signal is managed here)
     * @param {object} [opts]
     * @param {number} [opts.retries=2]
     * @param {number} [opts.timeoutMs=30000] - idle timeout
     * @param {boolean} [opts.stream=false]
     * @param {Set<number>} [opts.retryableStatuses]
     * @param {(status:number, bodyText:string) => string} [opts.describeError]
     */
    async _fetchWithRetries(url, fetchOptions = {}, opts = {}) {
        const retries = opts.retries ?? 2;
        const timeoutMs = opts.timeoutMs ?? 30000;
        const retryableStatuses = opts.retryableStatuses || new Set([429, 500, 502, 503, 504]);
        const describeError = opts.describeError || ((status, text) => `HTTP ${status}: ${text}`);

        let lastErr;
        for (let attempt = 0; attempt <= retries; attempt++) {
            const guard = this._requestGuard(timeoutMs);
            let keepGuard = false;
            try {
                const response = await fetch(url, { ...fetchOptions, signal: guard.signal });
                if (!response.ok) {
                    const errText = await response.text().catch(() => '(no body)');
                    const err = new Error(describeError(response.status, errText));
                    err.status = response.status;
                    if (retryableStatuses.has(response.status) && attempt < retries) {
                        lastErr = err;
                        await this._backoff(attempt + 1, response.headers?.get?.('retry-after'));
                        continue;
                    }
                    throw err;
                }
                if (opts.stream) { keepGuard = true; response.guard = guard; }
                return response;
            } catch (e) {
                if (e.name === 'AbortError') {
                    const err = this._abortError(guard, url, timeoutMs);
                    if (err.name === 'AbortError') throw err; // cancelled: never retry
                    lastErr = err;
                } else {
                    lastErr = e;
                }
                // Retry timeouts and network failures (e.g. ECONNRESET), not 4xx.
                if (attempt < retries && !lastErr.status) {
                    await this._backoff(attempt + 1);
                    continue;
                }
                throw lastErr;
            } finally {
                if (!keepGuard) guard.done();
            }
        }
        throw lastErr;
    }

    /**
     * Exponential backoff with jitter, capped at 8s. A server-sent
     * Retry-After (seconds or an HTTP date) wins when present, capped at 30s.
     */
    _backoff(attempt, retryAfter = null) {
        let delay = Math.min(1000 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
        if (retryAfter) {
            const seconds = Number(retryAfter);
            const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
            if (Number.isFinite(ms) && ms > 0) delay = Math.min(ms, 30000);
        }
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}

/**
 * Parse an OpenAI-style SSE body ("data: {...}" frames separated by a
 * blank line, LF or CRLF) into an async iterator of data payload strings.
 * Calls `onData` for every received chunk so a caller's idle timeout can
 * be refreshed.
 */
async function* parseSSEStream(body, onData = null) {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const bytes of body) {
        onData?.();
        buffer += decoder.decode(bytes, { stream: true }).replace(/\r\n?/g, '\n');
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
            if (data) yield data.trim();
        }
    }
    const tail = buffer.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
    if (tail) yield tail;
}

/**
 * Parse a newline-delimited JSON body (Ollama) into an async iterator of
 * objects; `onData` as above. Lines that are not JSON are skipped.
 */
async function* parseNDJSONStream(body, onData = null) {
    const decoder = new TextDecoder();
    let buffer = '';
    const parse = line => { try { return JSON.parse(line); } catch { return undefined; } };
    for await (const bytes of body) {
        onData?.();
        buffer += decoder.decode(bytes, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            const obj = line ? parse(line) : undefined;
            if (obj !== undefined) yield obj;
        }
    }
    const obj = buffer.trim() ? parse(buffer.trim()) : undefined;
    if (obj !== undefined) yield obj;
}

/** Drop any <think>...</think> block a local model writes into its reply. */
function stripThinking(text) {
    return String(text || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim();
}

module.exports = AIDriver;
module.exports.parseSSEStream = parseSSEStream;
module.exports.parseNDJSONStream = parseNDJSONStream;
module.exports.stripThinking = stripThinking;
