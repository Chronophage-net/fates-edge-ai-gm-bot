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

    async generateResponse(context) {
        const prompt = context.systemPrompt + '\n\n' +
            context.messages.map(m => `${m.role}: ${m.content}`).join('\n') +
            '\nassistant:';

        try {
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

        const response = await fetch(`${this.baseUrl}/api/generate`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model: this.model,
                prompt,
                stream: false,
                options: { temperature, num_predict: numPredict }
            })
        });

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`HTTP ${response.status}: ${errBody}`);
        }

        const data = await response.json();
        if (data.error) {
            throw new Error(data.error);
        }
        return data;
    }

    async _recoverModel(errorMessage, isStartup) {
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