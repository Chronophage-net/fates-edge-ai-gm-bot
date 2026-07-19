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
        this.maxTokens = parseInt(process.env.OPENAI_MAX_TOKENS || '400', 10);
        this.temperature = parseFloat(process.env.OPENAI_TEMPERATURE || '0.8');
        this.client = new OpenAI({ apiKey: this.apiKey });
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
        }
    }

    async generateResponse(context) {
        const messages = [
            { role: 'system', content: context.systemPrompt },
            ...context.messages
        ];

        try {
            const completion = await this.client.chat.completions.create({
                model: this.model,
                messages,
                max_tokens: this.maxTokens,
                temperature: this.temperature,
            });

            if (!completion.choices || completion.choices.length === 0) {
                throw new Error('OpenAI returned no choices in response');
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
}

OpenAIDriver.meta = {
    name: 'OpenAI',
    description: 'Uses GPT-4o-mini (or another OpenAI model). Requires an API key.',
    requiredEnv: ['OPENAI_API_KEY']
};

module.exports = OpenAIDriver;