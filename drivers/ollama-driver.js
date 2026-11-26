const AIDriver = require('./ai-driver');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

function ask(query) {
    return new Promise(resolve => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(query, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

const { parseNDJSONStream, stripThinking } = AIDriver;

// Is this error Ollama saying the model is missing (vs. a timeout, an
// overloaded server, or a bad prompt)? Only then is model recovery useful.
const isMissingModelError = e => e?.status === 404 || /model ['"]?[^'"\s]*['"]? not found|try pulling it|pull model/i.test(String(e?.message || ''));

class OllamaDriver extends AIDriver {
    constructor() {
        super();
        this.baseUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
        // gemma3 is a current, non-thinking chat model that narrates well;
        // 12b needs roughly 8 GB of VRAM. Use gemma3:4b on smaller machines.
        this.model = process.env.OLLAMA_MODEL || 'gemma3:12b';
        this.apiKey = process.env.OLLAMA_API_KEY || null;
        // Idle timeout: local models can take a while to load and start.
        this.timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
        this.maxRetries = parseInt(process.env.OLLAMA_MAX_RETRIES || '1', 10);
        this.temperature = parseFloat(process.env.OLLAMA_TEMPERATURE || '0.8');
        // Sent to Ollama as num_ctx AND used by trimToFit(), so the prompt
        // the bot builds and the window Ollama allocates always match.
        // Set it to what your model and memory support (`ollama show`).
        this.contextWindow = parseInt(process.env.OLLAMA_CONTEXT_WINDOW || '8192', 10);
        this.maxTokens = parseInt(process.env.OLLAMA_MAX_TOKENS || '1200', 10);
        // Keep the model in memory between turns. Ollama's default is 5m,
        // which meant the first message after a quiet spell waited for a
        // full model reload.
        this.keepAlive = process.env.OLLAMA_KEEP_ALIVE || '30m';
        // Thinking models (qwen3.x, gemma4, deepseek-r1, gpt-oss) think by
        // default, which is slow at a live table. OLLAMA_THINK=true or
        // low|medium|high turns it on; models without the switch ignore it.
        const think = (process.env.OLLAMA_THINK || 'false').toLowerCase();
        this.think = think === 'true' ? true : think === 'false' ? false : think;
        this.sendThink = true;

        // HEADLESS=true (or OLLAMA_NONINTERACTIVE=true) skips the
        // interactive model-recovery prompts, which would hang a service
        // with no terminal attached.
        this.headless = process.env.HEADLESS === 'true' || process.env.OLLAMA_NONINTERACTIVE === 'true';
    }

    _headers() {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
        return headers;
    }

    _body(messages, numPredict, stream) {
        return {
            model: this.model,
            messages,
            stream,
            keep_alive: this.keepAlive,
            ...(this.sendThink ? { think: this.think } : {}),
            options: { temperature: this.temperature, num_predict: numPredict, num_ctx: this.contextWindow },
        };
    }

    async initialize() {
        try {
            await this._chat([{ role: 'user', content: 'Hello' }], 1);
            console.log(`✅ Ollama connection OK (model: ${this.model})`);
        } catch (e) {
            console.error(`❌ Ollama initialization error: ${e.message}`);
            await this._recoverModel(e.message, true);
        }
    }

    async generateResponse(context, onToken) {
        // Trimming matters most here: local context windows are small, and
        // Ollama would otherwise cut the start of the prompt (the rules and
        // character sheets) itself.
        const { systemPrompt, messages } = this.trimToFit(context);
        const chat = [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))];
        try {
            return await this._chat(chat, this.maxTokens, typeof onToken === 'function' ? onToken : null);
        } catch (e) {
            if (e.name !== 'AbortError') console.error(`❌ Ollama generation error: ${e.message}`);
            // Only a missing model is worth recovery; a timeout or a busy
            // server is not, and recovery may prompt at the terminal.
            if (isMissingModelError(e)) await this._recoverModel(e.message, false);
            throw e;
        }
    }

    /**
     * One /api/chat call, streamed or not. Retries once without `think`
     * if the server rejects it (older Ollama, or a model without the
     * switch), and remembers that.
     */
    async _chat(messages, numPredict, onToken = null) {
        try {
            return await this._chatOnce(messages, numPredict, onToken);
        } catch (e) {
            if (this.sendThink && e.status === 400 && /think/i.test(e.message)) {
                this.sendThink = false;
                console.warn(`⚠️  Ollama model "${this.model}" does not take the think option; sending without it.`);
                return this._chatOnce(messages, numPredict, onToken);
            }
            throw e;
        }
    }

    async _chatOnce(messages, numPredict, onToken) {
        const stream = !!onToken;
        const response = await this._fetchWithRetries(`${this.baseUrl}/api/chat`, {
            method: 'POST', headers: this._headers(), body: JSON.stringify(this._body(messages, numPredict, stream)),
        }, { retries: stream ? 0 : this.maxRetries, timeoutMs: this.timeoutMs, stream });

        if (!stream) {
            const data = await response.json();
            if (data.error) throw new Error(data.error);
            const content = stripThinking(data.message?.content);
            this._finish(data, messages, content);
            return content;
        }

        const guard = response.guard;
        let full = '';
        try {
            if (!response.body) throw new Error('Ollama streaming response had no body.');
            for await (const part of parseNDJSONStream(response.body, guard.touch)) {
                if (part.error) throw new Error(part.error);
                const delta = part.message?.content;
                if (delta) { full += delta; onToken(delta); }
                if (part.done) { const content = stripThinking(full); this._finish(part, messages, content); return content; }
            }
            return stripThinking(full);
        } catch (e) {
            if (e.name === 'AbortError') throw this._abortError(guard, `${this.baseUrl}/api/chat`, this.timeoutMs);
            throw e;
        } finally {
            guard.done();
        }
    }

    /** Usage and truncation bookkeeping from Ollama's final object. */
    _finish(data, messages, content) {
        const truncated = !!(data.done_reason && !['stop', 'load', 'unload'].includes(data.done_reason));
        if (truncated) console.warn(`⚠️  Ollama done_reason was "${data.done_reason}" (model: ${this.model}) — response may be truncated.`);
        if (typeof data.prompt_eval_count === 'number' || typeof data.eval_count === 'number') {
            this.recordUsage({ promptTokens: data.prompt_eval_count || 0, completionTokens: data.eval_count || 0, truncated });
        } else {
            this.recordUsage({
                promptTokens: messages.reduce((n, m) => n + this.estimateTokens(m.content), 0),
                completionTokens: this.estimateTokens(content), estimated: true, truncated,
            });
        }
    }

    async _recoverModel(errorMessage, isStartup) {
        // CHANGED: fail fast in headless deployments instead of hanging
        // on a readline prompt that will never receive input. Still logs
        // the available models first, since that's useful in server logs
        // even when nobody's there to answer interactively.
        if (this.headless) {
            console.error('🚫 Ollama model unavailable and HEADLESS=true — skipping interactive recovery.');
            try {
                const response = await fetch(`${this.baseUrl}/api/tags`, {
                    headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}
                });
                if (response.ok) {
                    const data = await response.json();
                    const names = (data.models || []).map(m => m.name);
                    console.error(`   Available models on ${this.baseUrl}: ${names.length ? names.join(', ') : '(none)'}`);
                }
            } catch (e) {
                console.error(`   (Could not fetch model list: ${e.message})`);
            }
            console.error(`   Fix: pull the model manually (ollama pull ${this.model}) or set OLLAMA_MODEL to one of the models listed above, then restart.`);
            throw new Error(`Ollama model "${this.model}" is unavailable (HEADLESS mode, no interactive recovery): ${errorMessage}`);
        }

        console.log('\n🔧 Model recovery starting...\n');

        try {
            const response = await fetch(`${this.baseUrl}/api/tags`, {
                headers: this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch model list (HTTP ${response.status})`);
            }

            const data = await response.json();
            let models = data.models || [];

            // Filter out remote-only models? Better keep them but notify
            const localModels = models.filter(m => m.details && m.details.format !== 'remote');
            const remoteModels = models.filter(m => !localModels.includes(m));

            console.log('📋 Available models:');
            if (localModels.length > 0) {
                console.log('   Local:');
                localModels.forEach((m, i) => {
                    const size = m.size ? `${(m.size / 1e9).toFixed(1)}GB` : 'unknown size';
                    console.log(`     ${i + 1}) ${m.name} (${size})`);
                });
            } else {
                console.log('   (no local models found)');
            }

            if (remoteModels.length > 0) {
                console.log('   Remote (cloud):');
                remoteModels.forEach((m, i) => {
                    console.log(`     ${i + localModels.length + 1}) ${m.name} (remote)`);
                });
            }

            // If no local models and user originally requested a model, offer to pull it
            if (localModels.length === 0) {
                console.log(`\n🔄 No local models available. Would you like to pull the requested model "${this.model}"?`);
                const answer = await ask('Pull this model? (y/n, default: y): ');
                if (answer.toLowerCase() !== 'n') {
                    await this._pullAndSetModel(this.model);
                    return;
                }
            }

            // Otherwise, let user choose
            const choice = await ask('\nSelect a model number (or type a new model name to pull): ');
            const num = parseInt(choice, 10);
            let selectedModel = '';

            if (!isNaN(num) && num >= 1 && num <= models.length) {
                selectedModel = models[num - 1].name;
            } else if (choice.trim()) {
                selectedModel = choice.trim();
            }

            if (!selectedModel) {
                console.log('❌ No model selected. Continuing with current (non‑working) model.');
                return;
            }

            // If model not in the list, pull it
            const isInList = models.some(m => m.name === selectedModel);
            if (!isInList) {
                await this._pullAndSetModel(selectedModel);
            } else {
                // Model is already local (or remote), just switch
                this._updateModel(selectedModel);
                await this._testNewModel();
            }
        } catch (e) {
            console.error(`❌ Recovery failed: ${e.message}`);
            console.error('   Please manually pull a model with: ollama pull <model-name>');
        }
    }

    async _pullAndSetModel(modelName) {
        console.log(`⬇️  Pulling model "${modelName}"... (this may take a while)`);
        try {
            const pullRes = await fetch(`${this.baseUrl}/api/pull`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {})
                },
                body: JSON.stringify({ model: modelName, stream: false })
            });

            if (!pullRes.ok) {
                const pullErr = await pullRes.text();
                throw new Error(`Pull failed: ${pullErr}`);
            }
            console.log(`✅ Model "${modelName}" pulled successfully.`);
            this._updateModel(modelName);
            await this._testNewModel();
        } catch (e) {
            console.error(`❌ Pull failed: ${e.message}`);
            console.error('   You can try manually: ollama pull ' + modelName);
            // If pull fails, we don't update the model; recovery ends with original broken model
        }
    }

    _updateModel(newModel) {
        this.model = newModel;
        process.env.OLLAMA_MODEL = newModel;

        const envPath = path.resolve(process.cwd(), '.env');
        if (fs.existsSync(envPath)) {
            let envContent = fs.readFileSync(envPath, 'utf-8');
            const lines = envContent.split(/\r?\n/);
            const newLines = lines.map(line => {
                if (line.startsWith('OLLAMA_MODEL=')) {
                    return `OLLAMA_MODEL=${newModel}`;
                }
                return line;
            });
            if (!lines.some(l => l.startsWith('OLLAMA_MODEL='))) {
                newLines.push(`OLLAMA_MODEL=${newModel}`);
            }
            fs.writeFileSync(envPath, newLines.join('\n'));
            console.log(`   .env file updated with OLLAMA_MODEL=${newModel}`);
        }
    }

    async _testNewModel() {
        try {
            await this._chat([{ role: 'user', content: 'Hello' }], 1);
            console.log(`✅ New model "${this.model}" is working.\n`);
        } catch (testErr) {
            console.error(`⚠️  New model test failed: ${testErr.message}`);
            console.error('   The model may still be loading. Try restarting the bot.\n');
        }
    }
}

OllamaDriver.meta = {
    name: 'Ollama',
    description: 'Local or cloud Ollama server. Needs base URL + model (optional API key).',
    requiredEnv: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL']
};

module.exports = OllamaDriver;
