/**
 * Abstract AI Driver – defines the contract for all backends.
 */
class AIDriver {
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
     * @returns {Promise<string>} – the generated reply
     */
    async generateResponse(context) {
        throw new Error('generateResponse() must be implemented by driver');
    }

    /**
     * Optional cleanup on shutdown.
     */
    async shutdown() {}
}

module.exports = AIDriver;
