// modules/commands/index.js
// Public API for the commands module. This directory replaces the old
// single-file modules/commands.js (2300+ lines, two ~600-1200 line
// mega-functions) -- split into focused files that mirror the file's
// natural seams, with the two large dispatcher functions
// (handleBotCommand, processSpecialTags) each kept whole in their own
// file since their internal control flow shares mutable local state
// that would be risky to split further mechanically.
//
//   api-client.js        - global (outside-room) HTTP helpers
//   tokens.js             - whiteboard grid-combat token helpers + encounter icon
//   characters-sync.js     - character create/sync against the server
//   npc-actions.js           - NPC attack/social/spell resolver
//   tag-repair.js              - fuzzy repair of AI-emitted [TAG ...] syntax drift
//   gm-commands.js               - !gm command dispatcher (handleBotCommand)
//   process-tags.js                - [TAG ...] directive processor (processSpecialTags)
//   messages.js                     - static/templated chat messages
//
// This file re-exports the exact same public surface the old flat
// modules/commands.js exported, so every existing require('./modules/commands')
// call site (ai-gm-bot.js, tests) keeps working unchanged.

const { handleBotCommand } = require('./gm-commands');
const { processSpecialTags } = require('./process-tags');
const { generateStartupMessage, generateEtiquetteReminder } = require('./messages');
const { globalApiRequest } = require('./api-client');
const { syncCharactersFromServer } = require('./characters-sync');
const { repairAITagSyntax } = require('./tag-repair');

module.exports = {
    handleBotCommand,
    processSpecialTags,
    generateStartupMessage,
    generateEtiquetteReminder,
    globalApiRequest,
    syncCharactersFromServer, // shared with index.js's performAggressiveSync
    repairAITagSyntax, // exported for unit testing the fuzzy tag repair in isolation
};
