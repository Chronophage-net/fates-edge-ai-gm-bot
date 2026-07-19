const AIDriver = require('./ai-driver');

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
    }

    async initialize() {
        try {
            console.log(`🔍 Testing DeepSeek connection (model: ${this.model})…`);
            const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                body: JSON.stringify({
                    model: this.model,
                    messages: [{ role: 'user', content: 'Hello' }],
                    max_tokens: 1,
                    temperature: 0
                })
            });

            if (!response.ok) {
                const errText = await response.text();
                if (response.status === 401) {
                    throw new Error('Invalid API key (401). Check your DEEPSEEK_API_KEY.');
                } else if (response.status === 429) {
                    throw new Error('Rate limited (429). Wait a moment before restarting.');
                } else {
                    throw new Error(`DeepSeek API test failed (${response.status}): ${errText}`);
                }
            }

            const data = await response.json();
            console.log(`✅ DeepSeek connection OK (model: ${this.model})`);
        } catch (e) {
            console.error(`❌ DeepSeek initialization error: ${e.message}`);
        }
    }

    async generateResponse(context) {
        const messages = [
            { role: 'system', content: context.systemPrompt },
            ...context.messages
        ];

        const body = {
            model: this.model,
            messages,
            max_tokens: this.maxTokens,
            temperature: this.temperature,
            stream: false
        };

        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.apiKey}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errText = await response.text();
            console.error('DeepSeek request payload:', JSON.stringify(body, null, 2).slice(0, 500));
            let errMsg = `DeepSeek API error (${response.status}): ${errText}`;
            if (response.status === 401) errMsg = 'DeepSeek API key is invalid (401).';
            if (response.status === 429) errMsg = 'DeepSeek rate limit exceeded (429). Slow down.';
            if (response.status === 400) errMsg = `DeepSeek bad request (400): ${errText}`;
            if (response.status === 500) errMsg = 'DeepSeek server error (500). Try again later.';
            throw new Error(errMsg);
        }

        const data = await response.json();

        if (!data.choices || data.choices.length === 0) {
            throw new Error('DeepSeek returned no choices in response');
        }

        return (data.choices[0].message?.content || '').trim();
    }
}

DeepSeekDriver.meta = {
    name: 'DeepSeek',
    description: 'Uses the DeepSeek V4 API (deepseek-v4-pro or deepseek-v4-flash). Requires an API key.',
    requiredEnv: ['DEEPSEEK_API_KEY']
};

module.exports = DeepSeekDriver;
