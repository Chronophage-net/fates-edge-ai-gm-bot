// modules/commands/messages.js
// Extracted from the original monolithic modules/commands.js.
// Static/templated chat messages (etiquette reminder, room startup).

function generateEtiquetteReminder() {
    return `📜 **Fate's Edge – Game Etiquette**\n\n` +
        `**Optimal Play = Most Fun**\n` +
        `• Spend Boons freely – they fuel drama, not hoarding.\n` +
        `• Embrace failure – it generates Story Beats (SB) that make the story interesting.\n` +
        `• Patrons are allies who demand payment – Obligation is plot, not punishment.\n` +
        `• Flavor is free – describe your actions vividly, but keep it concise.\n` +
        `• The GM is a fan of the players – we are co-creators, not adversaries.\n` +
        `• Safety tools (X-Card, Lines, Veils) are always available – speak up if uncomfortable.\n` +
        `• When in doubt, make a ruling that keeps the story moving.\n\n` +
        `**Remember:** The dice are not the story; they are the spark. Let them sing.`;
}

// ─── Startup Message ──────────────────────────────────────────────
function generateStartupMessage(region, playerCount, charactersExist, botName = 'AI_GM') {
    let message = `🌟 Welcome to Fate's Edge! I am ${botName}, your AI Game Master. ` +
        `I'm here to guide the story, react to your choices, and keep the pressure on. ` +
        `Let's begin.\n\n`;

    if (region && region !== 'unknown') {
        message += `📍 **Current Region:** ${region}\n`;
        message += `The world around you is alive with ancient magic and hidden dangers. ` +
            `Every choice echoes across the Amaranthine.\n\n`;
    } else {
        message += `📍 **Region:** Unknown – but the world is vast and full of stories.\n\n`;
    }

    if (playerCount > 0) {
        message += `👥 **Players online:** ${playerCount}\n\n`;
    } else {
        message += `👤 **No other players connected yet.** You are the first to arrive.\n\n`;
    }

    if (!charactersExist) {
        message += `**No characters found.**\n` +
            `To begin, create a character with:\n` +
            `\`!gm create <YourCharacterName>\`\n` +
            `Then customize stats with \`!gm setattr\` and \`!gm setskill\`.\n` +
            `You can also use \`!gm help\` for all commands.\n\n`;
    } else {
        message += `✅ **Characters exist.** Use \`!gm status\` to see them.\n\n`;
    }

    message += `**What will you do?**\n` +
        `• Explore the region: \`!gm region\`\n` +
        `• Check your status: \`!gm status\`\n` +
        `• Roll dice: \`!gm roll "Name" Attribute+Skill DV Position\`\n` +
        `• Get help: \`!gm help\`\n` +
        `• See etiquette: \`!gm etiquette\`\n\n` +
        `**The story awaits. Make your move.**`;

    return message;
}

module.exports = { generateEtiquetteReminder, generateStartupMessage };
