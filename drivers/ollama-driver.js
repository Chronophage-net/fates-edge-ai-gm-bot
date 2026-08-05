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

class OllamaDriver extends AIDriver {
    constructor() {
        super();
        this.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        this.model = process.env.OLLAMA_MODEL || 'mistral';
        this.apiKey = process.env.OLLAMA_API_KEY || null;
        this.timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10); // local models are slow
        this.maxRetries = parseInt(process.env.OLLAMA_MAX_RETRIES || '1', 10);
        // Highly model-dependent (a 7B local model might be 4k-8k, others
        // much larger) -- operators running Ollama should set this to
        // match whatever OLLAMA_MODEL actually is. Defaults conservative.
        this.contextWindow = parseInt(process.env.OLLAMA_CONTEXT_WINDOW || '8192', 10);

        // CHANGED: the interactive recovery flow below (readline prompts
        // for "pull this model?" / "choose a model") is genuinely good UX
        // for a developer running this at a terminal, but it is a
        // deployment hazard for a headless process (systemd service,
        // Docker without -it, nohup, ...): process.stdin is closed or
        // never produces input in those contexts, so `rl.question()`
        // never resolves and the bot hangs forever instead of failing
        // fast where a process supervisor could restart it. Set
        // HEADLESS=true (or the more specific OLLAMA_NONINTERACTIVE=true)
        // in production to skip the prompts and throw immediately instead.
        this.headless = process.env.HEADLESS === 'true' || process.env.OLLAMA_NONINTERACTIVE === 'true';
    }

    async initialize() {
        try {
            await this._makeRequest('Hello', 1);
            console.log(`✅ Ollama connection OK (model: ${this.model})`);
        } catch (e) {
            console.error(`❌ Ollama initialization error: ${e.message}`);
            await this._recoverModel(e.message, true);
        }
    }

    async generateResponse(context, onToken) {
        // Trim to fit this model's real context window before sending --
        // see ai-driver.js's trimToFit(). This matters MORE for Ollama
        // than the hosted APIs: a local model's context window is often
        // small (4k-8k), and the Ollama API will otherwise silently
        // truncate the oldest part of the prompt itself -- which, given
        // how ai-gm-bot.js orders the system prompt, tends to mean the
        // rules/character data goes first, leaving the model to narrate
        // with no mechanical grounding at all.
        const { systemPrompt, messages } = this.trimToFit(context);
        const prompt = systemPrompt + '\n\n' +
            messages.map(m => `${m.role}: ${m.content}`).join('\n') +
            '\nassistant:';

        try {
            if (onToken && typeof onToken === 'function') {
                return await this._makeStreamingRequest(prompt, 400, 0.8, onToken);
            }
            const data = await this._makeRequest(prompt, 400, 0.8);
            return (data.response || '').trim();
        } catch (e) {
            console.error(`❌ Ollama generation error: ${e.message}`);
            if (e.message.includes('410') || e.message.includes('retired') || e.message.includes('not found') || e.message.includes('model')) {
                await this._recoverModel(e.message, false);
            }
            throw e;
        }
    }

    async _makeRequest(prompt, numPredict = 400, temperature = 0.8) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        // CHANGED: previously a bare fetch() with no timeout and no
        // retry -- a hung or transiently-erroring local Ollama server
        // (model still loading, brief resource contention, etc.) would
        // just throw once and give up, unlike deepseek-driver.js's
        // retry/backoff. Now uses the same shared helper.
        const response = await this._fetchWithRetries(
            `${this.baseUrl}/api/generate`,
            {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: this.model,
                    prompt,
                    stream: false,
                    options: { temperature, num_predict: numPredict }
                })
            },
            {
                retries: this.maxRetries,
                timeoutMs: this.timeoutMs,
                describeError: (status, text) => `HTTP ${status}: ${text}`
            }
        );

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        return data;
    }

    /**
     * Streaming path -- Ollama's /api/generate with stream:true returns
     * newline-delimited JSON objects (one per token), not SSE. No retry
     * here for the same reason as deepseek-driver.js's streaming path: a
     * partially-consumed stream can't be transparently resumed. Always
     * resolves with the full assembled text.
     */
    async _makeStreamingRequest(prompt, numPredict, temperature, onToken) {
        const headers = { 'Content-Type': 'application/json' };
        if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let full = '';
        try {
            const response = await fetch(`${this.baseUrl}/api/generate`, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: this.model,
                    prompt,
                    stream: true,
                    options: { temperature, num_predict: numPredict }
                }),
                signal: controller.signal
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}: ${errBody}`);
            }
            if (!response.body) {
                throw new Error('Ollama streaming response had no body.');
            }

            const decoder = new TextDecoder();
            let buffer = '';
            for await (const bytes of response.body) {
                buffer += decoder.decode(bytes, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).trim();
                    buffer = buffer.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (parsed.error) throw new Error(parsed.error);
                        if (parsed.response) {
                            full += parsed.response;
                            onToken(parsed.response);
                        }
                        if (parsed.done) return full.trim();
                    } catch (e) {
                        if (e.message && !e.message.startsWith('Unexpected')) throw e; // real API error, not a JSON parse hiccup
                    }
                }
            }
            return full.trim();
        } finally {
            clearTimeout(timer);
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
                body: JSON.stringify({ name: modelName, stream: false })
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
            await this._makeRequest('Hello', 1);
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
