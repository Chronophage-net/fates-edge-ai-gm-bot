#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
// Loaded first (before anything else logs) so the console.log/warn/error
// monkey-patch is in place from the very first startup line -- see
// modules/logger.js for why: LOG_LEVEL filtering + the status
// dashboard's live feed both depend on it.
const logger = require('./modules/logger');
const characters = require('./modules/characters');
const commandHandler = require('./modules/commands');
const adventureDirector = require('./modules/adventure-director');
const adventureContext = require('./modules/adventure-context');
const rulesIndexModule = require('./modules/rules-index');
const statusServer = require('./modules/status-server');
const knowledgeIndex = require('./modules/knowledge-index');
const assistantSuggestions = require('./modules/assistant-suggestions');
const { generateStartupMessage, generateEtiquetteReminder } = commandHandler;

// -------------------------------------------------------------------
// 0. Manual .env loader
// -------------------------------------------------------------------
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf-8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    const commentIdx = val.indexOf('#');
    if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    const cleanVal =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
        ? val.slice(1, -1)
        : val;
    process.env[key] = cleanVal;
  }
}
const envPath = path.resolve(process.cwd(), '.env');
loadEnvFile(envPath);

// -------------------------------------------------------------------
// 1. Configuration validation
// -------------------------------------------------------------------
function envIsReady() {
  const provider = (process.env.AI_PROVIDER || 'ollama').toLowerCase();
  const requiredVars = {
    ollama: ['OLLAMA_BASE_URL', 'OLLAMA_MODEL'],
    openai: ['OPENAI_API_KEY'],
    deepseek: ['DEEPSEEK_API_KEY']
  };
  const vars = requiredVars[provider];
  if (!vars) {
    console.error(`❌ Unknown AI provider "${provider}". Supported: ollama, openai, deepseek`);
    return false;
  }
  for (const v of vars) {
    if (!process.env[v]) {
      console.warn(`⚠️  Missing env var: ${v}`);
      return false;
    }
  }
  return true;
}
if (!envIsReady()) {
  console.warn('\n⚠️  .env missing or incomplete – launching configuration helper…\n');
  const result = spawnSync('node', ['./configure-bot.js'], {
    stdio: 'inherit',
    shell: true,
  });
  if (result.error) {
    console.error('❌ Failed to launch configure-bot.js:', result.error);
    process.exit(1);
  }
  loadEnvFile(envPath);
  if (!envIsReady()) {
    console.error('❌ Configuration still incomplete. Exiting.');
    process.exit(1);
  }
}

// ============================================================
// HELPER: derive HTTP API base from WebSocket URL
// ============================================================
function getApiBaseUrl(wsUrl) {
    if (!wsUrl) return 'http://localhost:10000/api';
    const url = new URL(wsUrl);
    url.protocol = url.protocol.replace('ws', 'http');
    url.pathname = '/api';
    return url.toString().replace(/\/$/, '');
}

// -------------------------------------------------------------------
// 2. Load drivers and modules
// -------------------------------------------------------------------
const AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();

let driver;
try {
  if (AI_PROVIDER === 'ollama') {
    const OllamaDriver = require('./drivers/ollama-driver');
    driver = new OllamaDriver();
    console.log(`🤖 Loaded Ollama driver (model: ${process.env.OLLAMA_MODEL})`);
  } else if (AI_PROVIDER === 'openai') {
    const OpenAIDriver = require('./drivers/openai-driver');
    driver = new OpenAIDriver(process.env.OPENAI_API_KEY, process.env.AI_MODEL || 'gpt-4o-mini');
    console.log(`🤖 Loaded OpenAI driver (model: ${driver.model})`);
  } else if (AI_PROVIDER === 'deepseek') {
    const DeepSeekDriver = require('./drivers/deepseek-driver');
    driver = new DeepSeekDriver();
    console.log(`🤖 Loaded DeepSeek driver (model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro'})`);
  } else {
    console.error(`❌ Unsupported AI provider: ${AI_PROVIDER}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`❌ Failed to load driver: ${e.message}`);
  process.exit(1);
}

const { WorldManager } = require('./modules/world-manager.js');
const { Orchestrator } = require('./modules/gm-orchestrator.js');

// -------------------------------------------------------------------
// 3. Configuration constants
// -------------------------------------------------------------------
const WS_URL = process.env.WS_URL || 'ws://localhost:10000';
const ROOM_CODE = process.env.ROOM || 'AC12';
const BOT_NAME = process.env.BOT_NAME || 'AI_GM';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);
const SUMMARISE_EVERY = parseInt(process.env.SUMMARISE_EVERY || '10', 10);
const API_KEY = process.env.API_KEY || '';

// ---- GM takeover delay (milliseconds) ----
const GM_TAKEOVER_DELAY = parseInt(process.env.GM_TAKEOVER_DELAY) || 10000;
// ---- max clients to remember for whisper dedupe ----
const MAX_WHISPERED_CLIENTS = 10;
// ---- aggressive sync interval ----
const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS) || 30000;

const API_BASE = getApiBaseUrl(WS_URL);
console.log(`🌐 API base: ${API_BASE}`);

let orchestrator = null;
let worldManager = null;

// -------------------------------------------------------------------
// 4. Base system prompt (rules will be prepended later)
// -------------------------------------------------------------------
// CHANGED: the ADD/APPLY boon example below now matches what
// commands.js's applyRegex actually accepts (both APPLY and ADD as the
// verb). Previously the prompt told the model to use "[ADD BOON ...]"
// while the regex only recognized "[APPLY ...]", so every boon grant the
// model faithfully produced per these instructions silently failed to
// parse. Fixed on both sides for belt-and-suspenders safety.

const BASE_SYSTEM_PROMPT = (process.env.SYSTEM_PROMPT ||
  'You are the Game Master for a Fate\'s Edge session. Provide vivid, concise narration. Use game mechanics appropriately.') +

  '\n\n' +
  '═══════════════════════════════════════════════════════════════\n' +
  'I. CRITICAL ROLL DISCIPLINE\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'You MUST call for a roll on EVERY player action that has risk, uncertainty, or opposition. Trivial actions (walking through a door, picking up a mundane object, speaking a sentence) require no roll—everything else does.\n\n' +

  'You are calling FOR a roll, not making one. A real GM says "make a Presence roll" and then waits for the player to actually pick up the dice — they never secretly roll on the player\'s behalf the instant the words leave their mouth. Do the same: use [CALL FOR ROLL "CharacterName" Attribute+Skill DV Position "optional one-sentence suggestion"] to ask for the roll, then STOP — end your turn there and let the engine hand it to the player. It is never your job to resolve a player\'s roll for them.\n\n' +

  'Format: Embed the tag naturally within your narrative sentence. NEVER put it on its own line or as a separate paragraph. The trailing quoted suggestion is optional but encouraged — use it the way a good GM thinks out loud: point out an unconventional but valid approach (a character with low Presence could lean on Melee to intimidate through sheer physical threat instead), remind them why you picked this DV/Position, or flag a complication their choice might invite. Keep it to one sentence; you are nudging, not deciding for them.\n\n' +

  'Example: "You edge toward the opening, [CALL FOR ROLL "Asadef" Wits+Stealth DV 3 Controlled "You could also risk a quick, showy dash instead of a careful creep — same DV, but Athletics might read better with your build."] — how do you want to play it?"\n\n' +

  'CRITICAL: You MUST wait for the actual roll result before narrating any outcome. NEVER invent, simulate, describe, or format a dice result yourself—in ANY form. No emoji, no bolded numbers, no HTML, no bracketed summary, and no calling [ROLL ...] to resolve it yourself either. The player (or their `!gm roll` command / VTT roll button) produces the real result, and the engine will hand it back to you as context on your next turn. If you type something that looks like a finished outcome, you have violated this rule.\n\n' +

  '[ROLL "CharacterName" Attribute+Skill DV Position] (no trailing suggestion) still exists and resolves a roll immediately — reserve it for rolls that are not a player waiting on your call: an NPC\'s own check, or a roll the player has already explicitly told you to make on their behalf.\n\n' +

  'When a player types a number in response to a menu:\n' +
  '1. Describe the action briefly (1 sentence).\n' +
  '2. Call for the roll with [CALL FOR ROLL ...] and stop.\n' +
  '3. On your NEXT turn, once the real result is in your context, narrate the full outcome.\n\n' +

  'If no character is selected, respond with: "⚠️ Please select a character in the VTT or create one with !gm create <name>."\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'II. MANDATORY MECHANICAL TAGS\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'You have a GM pool of Story Beats (SB). Use [SPEND SB N] to introduce a complication.\n\n' +

  'Create timers: [TIMER "Name" segments N "onFill message"]\n' +
  'Tick timers: [TICK TIMER "Name" N]\n\n' +

  'Draw cards: [DRAW count region]\n' +
  'Crown Spread: [CROWN region]\n\n' +

  'Set position: [SET POSITION Dominant|Controlled|Desperate]\n' +
  'Set DV: [SET DV N]\n\n' +

  'Resource changes: [APPLY HARM Name N], [APPLY FATIGUE Name N], [APPLY BOON Name N] ("ADD" works interchangeably).\n\n' +

  'NPC spellcasting: [NPC CAST "Spell Name" TargetName]\n\n' +

  'You were given only a SECTION INDEX of the rules, not the full rulebook text, to save space. ' +
  'If a scene needs the exact wording of a specific rule (e.g. precise Grapple mechanics, Ward costs, ' +
  'Downtime procedures) rather than the core loop you already know, request it with ' +
  '[LOOKUP RULE "Section Title or keyword"] and its full text will be inserted in place of the tag.\n\n' +

  'Start an encounter: [ENCOUNTER START "Name" type] — type is optional, one of combat|obstruction|skill_challenge|trap_ward|lockpick|heist|social (defaults to combat if omitted).\n' +
  'Encounter resolution: [ENCOUNTER RESOLVE clean|partial|miss "notes"]\n\n' +

  'Encounters are not always fights. Check the "Active Encounter" block in your scene context for its type and vocabulary before narrating: combat uses Harm/Heal and attacks; obstruction and skill_challenge use Progress/Setback; trap_ward uses Disarm Progress/Trigger; lockpick uses Tumblers/Jam; heist uses Heat/Cover; social uses Leverage/Resistance. Only narrate attacks, weapons, or [APPLY HARM ...] when the active encounter is type combat (or has no type at all, which also means combat). For every other type, narrate in that type\'s own vocabulary instead — e.g. a lockpick encounter is about tumblers catching or a pick slipping, not blows landing.\n\n' +

  'Scene advancement: [SCENE COMPLETE "brief note on how it ended"] — use only at genuine dramatic scene breaks, not after every exchange.\n\n' +

  'Knowledge state: your scene context may include a KNOWLEDGE STATE block listing this module\'s secrets, each with an id, the full truth (GM eyes only), what the players currently know, and (for unrevealed ones) a reveal condition. Treat this as the authoritative, explicit answer to "what am I allowed to tell the players right now?" — not the _gmhints prose elsewhere, which is a looser, older mechanism. When play actually satisfies a listed reveal condition (players witness it, an NPC confesses, a clue makes it undeniable), narrate the reveal AND call [REVEAL "id"] in the same turn so the game\'s own state matches your narration. Never state, imply, or let an NPC confess an unrevealed entry\'s truth without also emitting its [REVEAL "id"] tag; conversely, never emit [REVEAL "id"] without actually narrating that reveal. [HIDE "id"] undoes a mistaken reveal — use it only to correct an error, not as a normal narrative tool.\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'III. NPC CREATION & TOKEN MANAGEMENT (NON-NEGOTIABLE)\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'The instant a new named character completes their FIRST line of dialogue or receives more than one sentence of description, you MUST call [NPC CREATE "Name" "Role" "Motivation"] BEFORE their second sentence of speech. This is not optional. It registers them mechanically and drops their token.\n\n' +

  'Optionally add a 4th quoted argument for their home/current location: [NPC CREATE "Name" "Role" "Motivation" "Location"]. Only include it if the scene actually establishes one -- do NOT invent a location just to fill the slot. Plenty of NPCs wander, travel, or simply have no fixed address; omit the 4th argument entirely for those. If an NPC\'s whereabouts become known or change later (they relocate, you learn where they\'ve been hiding, etc.), update it with [NPC LOCATION "Name" "Place"] -- or [NPC LOCATION "Name" ""] to clear a location that\'s no longer accurate rather than leaving stale info behind.\n\n' +

  'During combat or movement, use:\n' +
  '[TOKEN MOVE "Name" col row] — reposition an existing token.\n' +
  '[TOKEN REMOVE "Name"] — remove a specific combatant mid-fight.\n\n' +

  'Enemy tokens clear automatically on [ENCOUNTER RESOLVE]. Do not manually clear them.\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'IV. OUTCOME MATRIX (APPLY AFTER ROLL RESULT)\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'Clean Success: Successes ≥ DV, SB = 0 → Full success, no complication.\n' +
  'Success with SB: Successes ≥ DV, SB > 0 → Success; GM may spend SB to introduce a cost.\n' +
  'Partial: 0 < Successes < DV → Progress with complication; player gains 1 Boon; auto-tick relevant timer.\n' +
  'Miss: Successes = 0 → No progress; GM escalates the situation; player gains 2 Boons; auto-tick timer.\n\n' +

  'Default to DV 3, Controlled Position when uncertain.\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'V. DRAMATIC PACING & NARRATION (UNIVERSAL GUARDRAILS)\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'Guard dramatic escalation. Reveal root causes, hierarchies, inner workings, and final-act mechanics ONLY when players earn them through investigation or reach the appropriate narrative act. In early scenes, NPCs are witnesses to symptoms—what they see, feel, or have lost—not omniscient expositors of the module\'s internal logic.\n\n' +

  'When uncertain, have NPCs offer actionable leads (locations to visit, people to question, documents to find) rather than summarizing answers. Treat the module\'s act structure as a promise to the players: Act I establishes the mystery, Act II uncovers the machinery, Act III resolves it.\n\n' +

  'If a module provides gmHints in its metadata, or explicit KNOWLEDGE STATE entries (see section II above), treat those as immutable constraints on your narration. If a player asks directly about a forbidden or unrevealed revelation, deflect gracefully toward an investigation location—do not answer, lie, or hedge awkwardly.\n\n' +

  'Keep narration vivid but lean. Frame the situation, call the roll, then narrate the outcome. Let failure generate Story Beats—it drives the story forward. Stay in the fiction at all times. NEVER narrate your interpretation of the player\'s intent (e.g., "I understand you want to move on"). If a player message is terse or ambiguous, respond by continuing the story in-world.\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'VI. STRICT PROHIBITIONS (ZERO TOLERANCE)\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  '- NEVER narrate a risky player action without a [CALL FOR ROLL ...] tag.\n' +
  '- NEVER write, simulate, or format a dice result yourself.\n' +
  '- NEVER resolve a player\'s own roll for them (that includes using [ROLL ...] on their behalf) — call for it and wait.\n' +
  '- NEVER introduce a named NPC without an immediate [NPC CREATE] tag.\n' +
  '- NEVER reveal Act II/III mechanics, hierarchies, or the engine\'s internal logic in Act I.\n' +
  '- NEVER summarize module secrets through NPC monologue—always deflect to investigation.\n' +
  '- NEVER state an unrevealed KNOWLEDGE STATE entry\'s truth to players, and NEVER emit [REVEAL ...] without actually narrating that reveal in the same turn (or vice versa).\n' +
  '- NEVER break the fourth wall to explain your reasoning. Stay in the fiction.';

// Build adventure manifest (if script exists)
try {
  const { buildManifest } = require('./scripts/build-adventure-manifest');
  buildManifest();
  console.log('📚 Adventure manifest built.');
} catch (e) {
  console.warn('⚠️ Could not build adventure manifest:', e.message);
}

// -------------------------------------------------------------------
// 5. WebSocket and connection
// -------------------------------------------------------------------
let ws = null;
let connected = false;
let myRole = 'player';
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;

let startupMessageSent = false;
let playerCount = 0;
let charactersExist = false;
let campaignSeeded = false;
let seedRequested = false;
// NEW: guards against re-scheduling the seed/adventure-prompt startup
// timers every time this bot reconnects and re-claims GM within the same
// process lifetime (WS drops and re-handshakes happen far more often
// than actual process restarts). The seedCampaign() call itself is
// already guarded by `campaignSeeded`, and maybePromptOnStartup() checks
// live server state before showing a menu, but repeatedly re-arming
// these timers on every reconnect is still wasted work and a source of
// races (e.g. a reconnect firing maybePromptOnStartup while a player is
// mid-selection). Scheduling them only once per process is simpler and
// sufficient -- a genuine process restart naturally resets this flag too.
let startupSequenceStarted = false;

// ---- GM auto‑claim state ----
let currentGMId = null;
let gmTakeoverTimer = null;
let gmTakeoverWarningSent = false;

// ---- whisper dedupe list ----
let lastWhisperedClients = [];

// ---- aggressive sync ----
let syncInterval = null;
let initialSyncDone = false;

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------
function getSocketId() {
    return ws ? ws._socketId || null : null;
}
let mySocketId = null;

function shouldWhisper(clientId) {
    return clientId && clientId !== mySocketId && !lastWhisperedClients.includes(clientId);
}

function sendWhisper(targetClientId, text) {
    const message = {
        text: String(text),
        sender: 'GM',
        recipient: targetClientId,
        whisper: true,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        timestamp: Date.now(),
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        local: false,
        sent: false
    };
    console.log(`📤 Sending whisper to ${targetClientId}:`, text.slice(0, 60) + '…');
    sendWS('chat-message', { message });
}

function buildGreetingMessage(clientName) {
    let msg = `👋 Welcome, ${clientName}! I am ${BOT_NAME}, your AI Game Master.\n\n`;
    if (orchestrator) {
        const state = orchestrator.campaign.state;
        if (state && state.scene) {
            const scene = state.scene;
            const region = scene.region || 'unknown';
            const location = scene.location || 'unknown';
            const position = scene.position || 'Controlled';
            const sb = state.sb || 0;
            msg += `📍 **Current Scene:** ${location} (${region})\n`;
            msg += `⚔️ **Position:** ${position}\n`;
            msg += `🎲 **Story Beats:** ${sb}\n`;
            if (state.adventure && state.adventure.module) {
                msg += `📖 **Adventure:** ${state.adventure.module.title}\n`;
                const act = state.adventure.currentAct;
                const sceneIdx = state.adventure.currentScene;
                if (act !== undefined && sceneIdx !== undefined) {
                    const actObj = state.adventure.module.acts[act];
                    if (actObj) {
                        msg += `📌 **Act:** ${actObj.title}\n`;
                        const sceneObj = actObj.scenes[sceneIdx];
                        if (sceneObj) msg += `🎭 **Scene:** ${sceneObj.title}\n`;
                    }
                }
            }
        }
        msg += `\nUse \`!gm help\` to see available commands. Let's begin!`;
    } else {
        msg += `📡 I'm still syncing with the campaign data. Stand by…`;
    }
    return msg;
}

// GM takeover timer
function startGmTakeoverTimer() {
    if (gmTakeoverTimer) return;
    if (myRole === 'gm') return;
    if (!gmTakeoverWarningSent) {
        sendChat(`⚠️ The Game Master has disconnected. I will assume the role in ${GM_TAKEOVER_DELAY/1000} seconds unless another player takes over.`);
        gmTakeoverWarningSent = true;
    }
    gmTakeoverTimer = setTimeout(() => {
        gmTakeoverTimer = null;
        gmTakeoverWarningSent = false;
        if (myRole !== 'gm' && !currentGMId) {
            // NEW: Assistant GM mode deliberately does NOT auto-promote
            // itself to full GM the way an ordinary player-role bot does.
            // Assistant GM exists specifically to hold back from narrative
            // authority; silently flipping to full GM on a timer the
            // moment the human disappears would undermine the entire
            // point of the mode. Ask instead, and only act on an explicit
            // `!gm confirm-takeover` from someone in the room (see the
            // handler in commands.js's handleBotCommand()).
            if (myRole === 'assistant-gm') {
                console.log('👑 No GM present, but I am Assistant GM – asking before taking full control.');
                sendChat(
                    `⚠️ No Game Master is present. As Assistant GM I can keep holding pending ` +
                    `suggestions, but I won't take full narrative control on my own. Reply ` +
                    `\`!gm confirm-takeover\` if you'd like me to assume full GM duties.`
                );
            } else {
                console.log('👑 No GM present – requesting GM role.');
                sendWS('request_gm');
            }
        } else {
            console.log('ℹ️ GM takeover cancelled – GM already exists or I am GM.');
        }
    }, GM_TAKEOVER_DELAY);
}

function cancelGmTakeoverTimer() {
    if (gmTakeoverTimer) {
        clearTimeout(gmTakeoverTimer);
        gmTakeoverTimer = null;
        gmTakeoverWarningSent = false;
    }
}

// ---- Aggressive sync functions ----
async function performAggressiveSync() {
    // Assistant GM mode still needs live character/adventure state to run
    // its mechanical duties (rolls, resource math, timers) correctly --
    // only the narrative-authority tags are held back (see commands.js's
    // isAssistant branches), so this sync loop runs the same as full GM.
    if (!orchestrator || (myRole !== 'gm' && myRole !== 'assistant-gm')) {
        return;
    }
    try {
        // CHANGED: this used to do its own SEPARATE, cruder wholesale
        // REPLACE of the entire local character store via
        // characters.loadCharacters() every sync tick -- a second,
        // independent implementation of essentially the same logic as
        // !gm discover, and a riskier one (a full replace discards any
        // local-only state that hasn't yet round-tripped through the
        // server between ticks, rather than merging field-by-field).
        // Now shares the exact same, proven merge logic !gm discover
        // uses, so periodic background sync and manual discovery can
        // never disagree with each other again.
        const { synced, error } = await commandHandler.syncCharactersFromServer({
            apiRequest,
            charactersModule: characters,
        });
        if (error) {
            console.warn('⚠️ Aggressive sync:', error);
        } else if (synced > 0) {
            // DEBUG: fires every SYNC_INTERVAL_MS while this bot is GM --
            // pure noise for the terminal/dashboard at normal verbosity.
            // Set LOG_LEVEL=debug to see it.
            logger.debug(`🔄 Aggressive sync: merged ${synced} character(s) from server.`);
        }
        await adventureContext.invalidate();
        initialSyncDone = true;
    } catch (e) {
        console.warn('⚠️ Aggressive sync failed:', e.message);
    }
}

function startAggressiveSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    if (myRole === 'gm' || myRole === 'assistant-gm') {
        performAggressiveSync().catch(() => {});
        syncInterval = setInterval(performAggressiveSync, SYNC_INTERVAL_MS);
        console.log(`🔄 Aggressive sync started (every ${SYNC_INTERVAL_MS/1000}s)`);
    }
}

function stopAggressiveSync() {
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
        console.log('🔄 Aggressive sync stopped');
    }
}

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  console.log(`🔌 Connecting to ${WS_URL}?room=${ROOM_CODE}`);
  ws = new WebSocket(`${WS_URL}?room=${ROOM_CODE}`);

  ws.on('open', () => {
    connected = true;
    reconnectAttempts = 0;
    console.log('🟢 WebSocket connected');
    ws.send(JSON.stringify({ type: 'handshake', campaignCode: ROOM_CODE, clientName: BOT_NAME, role: 'gm', password: '', clientEmail: '' }));
  });

  ws.on('message', async (data) => {
    const raw = data.toString();
    const lines = raw.split('\n').filter(line => line.trim());
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        // DEBUG: every inbound WS frame, including presence pings and
        // state-updated broadcasts that can fire multiple times a
        // second -- the single noisiest line in the whole bot. Set
        // LOG_LEVEL=debug to see the raw wire traffic.
        logger.debug(`⬇️  ${msg.type}`, JSON.stringify(msg).slice(0, 120));
        await handleMessage(msg);
      } catch (e) {
        console.warn('⚠️  Non‑JSON message:', line);
      }
    }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    console.log(`🔌 Disconnected (code ${code})${reason ? `: ${reason}` : ''}`);
    stopAggressiveSync();
    scheduleReconnect();
  });
  ws.on('error', (err) => console.error('🔴 WebSocket error:', err.message));
}

function scheduleReconnect() {
  const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY);
  console.log(`⏳ Reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);
  reconnectTimer = setTimeout(() => { reconnectAttempts++; connect(); }, delay);
}

function sendWS(type, data = {}) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const payload = JSON.stringify({ type, ...data });
    ws.send(payload);
    console.log(`⬆️  Sent: ${type}`);
  }
}

function sendChat(text) {
  const msgText = typeof text === 'string' ? text : String(text);
  const message = {
    text: msgText,
    sender: 'GM',
    recipient: 'all',
    whisper: false,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    timestamp: Date.now(),
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    local: false,
    sent: false
  };
  console.log('📤 Sending chat:', JSON.stringify({ type: 'chat-message', message }));
  sendWS('chat-message', { message });
}

// -------------------------------------------------------------------
// 6. API helpers
// -------------------------------------------------------------------
async function apiRequest(method, pathSegments, body = null) {
  const url = `${API_BASE}/rooms/${ROOM_CODE}/${pathSegments.join('/')}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': API_KEY,
    },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);

  // CHANGED: response.json() used to be called unconditionally, so any
  // non-JSON body (most commonly an HTML fallback/404 page from a route
  // that doesn't actually exist server-side, e.g. `!gm room-state`
  // hitting a path that isn't mounted) failed with a cryptic
  // "Unexpected token '<', "<!DOCTYPE "... is not valid JSON" instead of
  // saying what actually went wrong. Now we read the body as text first
  // and only attempt JSON.parse on it, so a bad route/path is reported
  // as exactly that -- with the real HTTP status and a snippet of what
  // came back -- instead of a JSON-parser error that gives no clue this
  // was actually a routing problem, not a data problem.
  const raw = await response.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (e) {
    const snippet = raw.slice(0, 120).replace(/\s+/g, ' ').trim();
    throw new Error(
      `API returned non-JSON response (HTTP ${response.status} ${response.statusText}) ` +
      `for ${method} ${url} -- likely a route that doesn't exist server-side. ` +
      `Body starts with: "${snippet}"`
    );
  }

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${data.error || response.statusText}`);
  }
  return data;
}

// -------------------------------------------------------------------
// 7. Initialisation
// -------------------------------------------------------------------
async function initGame() {
  worldManager = new WorldManager();
  await worldManager.loadAll();

  const serverUrl = API_BASE.replace(/\/api$/, '');
  orchestrator = new Orchestrator(worldManager, {
    roomCode: ROOM_CODE,
    serverUrl: serverUrl,
    defaultRegion: process.env.DEFAULT_REGION || 'acasia-broken-marches',
    apiKey: API_KEY
  });

  await orchestrator.initialize();
  await orchestrator.campaign.load();
  if (orchestrator.campaign.campaignCode) {
    console.log(`📂 Loaded campaign ${orchestrator.campaign.campaignCode}`);
  } else {
    console.log('📂 Started new campaign.');
  }

  // CHANGED (fix for "spurious crown spreads"): campaignSeeded is an
  // in-memory flag that only gets set true AFTER seedCampaign() runs in
  // THIS process. It has no idea a Crown Spread was already drawn and
  // persisted in a previous process lifetime (any restart/redeploy/
  // crash-and-recover resets it to false). handshake_ack then
  // unconditionally schedules `if (!campaignSeeded) seedCampaign()` 5
  // seconds after becoming GM -- so a restarted process would silently
  // redraw and re-announce an entirely new Crown Spread on top of a
  // campaign that was already seeded, with no way to tell the two
  // apart in chat except "wait, didn't we already do this?" Deriving
  // the flag from whether state.crownSpread already exists (set once,
  // by seedCampaign's own processCrownSpread(), and persisted via
  // campaign.save()) means a restart correctly recognizes prior seeding
  // and skips the redundant redraw.
  if (orchestrator.campaign.state && orchestrator.campaign.state.crownSpread) {
    campaignSeeded = true;
    console.log('🌱 Campaign was already seeded in a prior session -- skipping re-seed.');
  }

  return orchestrator;
}

// -------------------------------------------------------------------
// 8. Campaign Seeding via Crown Spread (with rich region data)
// -------------------------------------------------------------------
async function seedCampaign(region = null) {
  if (campaignSeeded) {
    console.log('Campaign already seeded.');
    return;
  }
  if (!orchestrator) {
    console.warn('Orchestrator not ready for seeding.');
    return;
  }
  const regionName = region || orchestrator.options.defaultRegion || 'Acasia';
  console.log(`🌱 Seeding campaign with Crown Spread for ${regionName}...`);
  seedRequested = true;
  sendWS('crown-spread', { region: regionName });
  setTimeout(() => {
    if (seedRequested) {
      seedRequested = false;
      console.warn('Crown Spread request timed out – seeding cancelled.');
      sendChat('*Crown Spread request timed out. Please try !gm seed manually.*');
    }
  }, 15000);
}

function processCrownSpread(data) {
  if (!seedRequested) return;
  seedRequested = false;
  if (campaignSeeded) return;

  const cards = data.cards || [];
  const mainCards = data.mainCards || [];
  const wildcard = data.wildcard || {};
  const result = data.result || {};
  const synthesis = result.synthesis || 'A mysterious reading...';
  const positions = result.positions || [];

  const state = orchestrator.campaign.state;
  state.crownSpread = {
    cards,
    mainCards,
    wildcard,
    synthesis,
    positions,
    region: data.region || orchestrator.options.defaultRegion,
    timestamp: Date.now()
  };

  state.timers = state.timers || {};
  state.timers['Campaign Arc'] = { segments: 10, current: 0 };

  const regionName = data.region || orchestrator.options.defaultRegion || 'Acasia';
  const regionData = orchestrator.world?.getRegion(regionName);
  
  const interpretation = generateCrownSpreadInterpretation(positions, regionData, regionName, orchestrator.world);
  
  const rootPos = positions.find(p => p.key === 'root');
  const hook = rootPos?.meaning || 'The story begins...';
  
  state.facts = state.facts || {};
  state.facts['campaign_seed'] = synthesis;
  state.facts['campaign_hook'] = hook;
  state.facts['campaign_region'] = regionName;
  for (const [key, value] of Object.entries({ campaign_seed: synthesis, campaign_hook: hook, campaign_region: regionName })) {
    knowledgeIndex.indexFact(orchestrator.campaign.campaignCode, key, value).catch(() => {});
  }

  orchestrator.campaign.save().catch(err => console.error('Error saving seeded campaign:', err));
  campaignSeeded = true;

  let announce = `👑 **Crown Spread – Campaign Seed**\n\n`;
  announce += `*${synthesis}*\n\n---\n\n`;
  
  if (positions.length > 0) {
    for (const pos of positions) {
      const icon = pos.icon || '•';
      const label = pos.label || 'Position';
      const meaning = pos.meaning || '—';
      const card = pos.card || {};
      const cardStr = card.rankName && card.suitName ? `(${card.rankName} of ${card.suitName})` : '';
      announce += `**${icon} ${label}** ${cardStr}\n`;
      announce += `*${meaning}*\n\n`;
    }
  }
  
  if (interpretation) {
    announce += `---\n\n${interpretation}\n\n`;
  }
  
  announce += `📅 **Campaign Arc Timer** (10 segments) started.`;
  
  sendChat(announce);
  console.log('✅ Campaign seeded with Crown Spread.');
}

function generateCrownSpreadInterpretation(positions, regionData, regionName, worldManager) {
  if (!positions || positions.length === 0) {
    return `The cards reveal a story unfolding in ${regionName}. The world is alive with possibilities, and your choices will shape what comes next.`;
  }

  const posMap = {
    'root': { label: 'Root', desc: 'The foundation of this story — what has already been set in motion.' },
    'crest': { label: 'Crest', desc: 'A rising influence or challenge that will shape the path ahead.' },
    'crown': { label: 'Crown', desc: 'The heart of the conflict — the prize, the cost, the turning point.' },
    'left': { label: 'Left Hand', desc: 'An ally, obstacle, or bond that will prove crucial.' },
    'right': { label: 'Right Hand', desc: 'A hidden factor, unexpected twist, or secret waiting to be uncovered.' },
    'wildcard': { label: 'Wildcard', desc: 'The unpredictable element — a force that defies easy categorization.' }
  };

  let parts = [];
  for (const pos of positions) {
    const key = pos.key || 'position';
    const info = posMap[key] || { label: key, desc: 'A factor in the story' };
    const meaning = pos.meaning || 'A mystery unfolds.';
    parts.push(`**${info.label}:** ${meaning}`);
  }

  let regionFlavor = '';
  if (regionData) {
    const tagline = regionData.overview?.tagline || regionData.tagline || '';
    const mood = regionData.overview?.mood || regionData.mood || '';
    if (tagline) regionFlavor += `\n*"${tagline}"*`;
    if (mood) regionFlavor += `\n*Mood: ${mood}*`;
    
    const startHook = regionData.overview?.starting_location || regionData.starting_hook || '';
    if (startHook) regionFlavor += `\n\n${startHook}`;

    const factions = regionData.regional_diagnostic?.faction_triad || regionData.factions || [];
    if (factions.length > 0) {
      const chosen = factions[Math.floor(Math.random() * factions.length)];
      const name = chosen.faction || chosen.name || 'A local power';
      const goal = chosen.goal || chosen.goals || 'pursuing its own agenda';
      regionFlavor += `\n\n**Key Power:** *${name}* — ${goal}`;
    }

    const npcs = regionData.npcs || [];
    if (npcs.length > 0) {
      const npc = npcs[Math.floor(Math.random() * npcs.length)];
      regionFlavor += `\n**Notable Figure:** *${npc.name}* — ${npc.role || 'a presence in the region'}`;
    }

    const curse = regionData.curse_timer || regionData.curse || {};
    if (curse.name) {
      regionFlavor += `\n\n*The ${curse.name} ticks in the background — a pressure that will shape the campaign.*`;
    }
  } else if (worldManager) {
    const fallback = worldManager.getRegion(regionName);
    if (fallback) {
      regionFlavor += `\n*${fallback.overview?.tagline || 'A land of mystery and conflict.'}*`;
    }
  }

  let interpretation = parts.join('\n\n');
  if (regionFlavor) {
    interpretation += `\n\n---\n\n**🌍 The World of ${regionName}**\n${regionFlavor}`;
  }

  interpretation += `\n\n**The cards are laid. The world is waiting. What do you do?**`;
  return interpretation;
}

// -------------------------------------------------------------------
// 9. Message handler – UPDATED with whisper, GM takeover, and aggressive sync
// -------------------------------------------------------------------
async function handleMessage(msg) {
  // ─── STATE UPDATED – auto‑sync characters ──────────────────────────
  if (msg.type === 'state-updated') {
    let charList = null;
    if (msg.characters && Array.isArray(msg.characters)) {
      charList = msg.characters;
    } else if (msg.state && msg.state.characters && Array.isArray(msg.state.characters)) {
      charList = msg.state.characters;
    }
    if (charList && charList.length > 0) {
      const charObj = {};
      for (const c of charList) {
        if (c.name) {
          charObj[c.name.toLowerCase()] = { ...c };
        }
      }
      characters.loadCharacters(charObj);
      // DEBUG: fires on every state-updated broadcast -- see the
      // inbound-message note above.
      logger.debug(`📥 Auto‑synced ${charList.length} characters from state-updated.`);
    } else {
      logger.debug('ℹ️  state-updated received with no character data.');
    }
    return;
  }

  // ─── IGNORE CHARACTER-SELECT EVENTS ─────────────────────────────
  //
  // FIX ("stuck GM takeover / aggressive sync never toggling"): this used
  // to also early-return on msg.type === 'presence', which silently made
  // the ENTIRE real presence handler below (tracks currentGMId, starts/
  // cancels the GM-takeover timer, corrects myRole and starts/stops
  // aggressive sync when it changes, and fires the deferred startup
  // message once a GM is confirmed present) permanently unreachable dead
  // code -- every 'presence' broadcast returned right here instead. In
  // practice that meant: currentGMId never updated (so this bot could
  // never detect and take over for a disconnected GM), myRole never
  // self-corrected from the server's own view of it, aggressive sync
  // never started/stopped in response to a role change picked up via
  // presence (only via the one-time handshake_ack/gm_role_update paths),
  // and startupMessageSent's presence-triggered fallback never fired --
  // which is what could leave the "(The GM is composing a reply...)"
  // message (or the missing startup greeting) looking permanently stuck
  // with nothing to follow it up. Only character-select is actually
  // noise this bot has no use for; presence must fall through.
  if (msg.type === 'character-select') {
      return;
  }

  // ─── CROWN SPREAD ──────────────────────────────────────────────────
  if (msg.type === 'crown-spread') {
    processCrownSpread(msg);
    return;
  }

  // ─── PRESENCE – track GM and player count ────────────────────────
  if (msg.type === 'presence') {
    const clients = msg.clients || [];
    playerCount = clients.length;
    const gmClient = clients.find(c => c.role === 'gm');
    const previousGMId = currentGMId;
    currentGMId = gmClient ? gmClient.id : null;

    if (!currentGMId && myRole !== 'gm') {
      startGmTakeoverTimer();
    } else if (currentGMId) {
      cancelGmTakeoverTimer();
    }

    const myClient = clients.find(c => c.id === mySocketId);
    if (myClient && myClient.role !== myRole) {
      const previousRole = myRole;
      myRole = myClient.role;
      console.log(`🔁 Role updated from presence: ${myRole}`);
      if (myRole === 'gm' || myRole === 'assistant-gm') {
        startAggressiveSync();
      } else {
        stopAggressiveSync();
      }
      if (myRole === 'assistant-gm' && previousRole !== 'assistant-gm') {
        sendChat(`🤝 I'm now Assistant GM. I'll keep the mechanics running and hold narrative suggestions for GM approval — see \`!gm suggestions\`.`);
      } else if (previousRole === 'assistant-gm' && myRole !== 'assistant-gm') {
        // Stepping out of the seat entirely (demoted to player/spectator,
        // or promoted to full GM) -- any suggestions left unreviewed from
        // before this moment are stale; don't carry them forward.
        const cleared = assistantSuggestions.clear();
        if (cleared > 0) console.log(`🗑️ Cleared ${cleared} pending Assistant GM suggestion(s) on role change.`);
      }
    }

    console.debug(`👥 ${playerCount} clients in room`);
    if (!startupMessageSent && connected && myRole === 'gm' && orchestrator) {
      scheduleStartupMessage();
    }
    return;
  }

  // ─── PLAYER‑JOINED – whisper greeting ────────────────────────────
  if (msg.type === 'player-joined') {
    const clientId = msg.clientId;
    const clientName = msg.clientName || 'Player';
    if (shouldWhisper(clientId)) {
      const greeting = buildGreetingMessage(clientName);
      sendWhisper(clientId, greeting);
      lastWhisperedClients.push(clientId);
      if (lastWhisperedClients.length > MAX_WHISPERED_CLIENTS) {
        lastWhisperedClients.shift();
      }
    }
    return;
  }

  // ─── HANDSHAKE ACK ────────────────────────────────────────────────
  if (msg.type === 'handshake_ack') {
    myRole = msg.clientRole || msg.role || 'player';
    mySocketId = msg.clientId || null;
    console.log(`🤝 Handshake OK. Role: ${myRole}, ClientID: ${mySocketId}`);
    if (myRole === 'assistant-gm') {
      // NEW: Assistant GM connects with a real role already assigned by
      // the server (the human GM promoted this bot the same way they'd
      // promote a Co-GM -- see fates-edge-apps' room.js ASSIGNABLE_ROLES).
      // It never requests the full GM seat on its own.
      console.log('🤝 I am the Assistant GM.');
      if (!orchestrator) await initGame();
      await orchestrator.campaign.save();
      console.log('📂 Campaign sync complete.');
      startAggressiveSync();
      // Deliberately skip the full-GM-only onboarding flows below
      // (auto-seed, adventure-director's startup prompt, the greeting
      // message) -- those are narrative-authority decisions that belong
      // to whichever human holds the actual GM seat, not to this mode.
    } else if (myRole !== 'gm') {
      console.log('📢 I am not the GM – will request GM role.');
      sendWS('request_gm');
    } else {
      console.log('👑 I am the Game Master!');
      if (!orchestrator) await initGame();
      await orchestrator.campaign.save();
      console.log('📂 Campaign sync complete.');
      scheduleStartupMessage();

      if (!startupSequenceStarted) {
        startupSequenceStarted = true;

        // CHANGED: automatic Crown-Spread campaign seeding on startup is
        // now OPT-IN (set AUTO_SEED_CAMPAIGN=true in .env to restore the
        // old always-on behavior). Two reasons:
        //   1. campaign.load() ties persistence to an explicit
        //      campaignCode (the same one !gm upload/!gm load use) --
        //      without confirming world-manager.js's actual persistence
        //      behavior, there's no guarantee state.crownSpread survives
        //      a restart, so the "skip if already seeded" check from the
        //      previous fix can't be fully relied on to prevent repeats.
        //   2. It's redundant with adventure-director.js's own "Draw a
        //      Crown Spread and build a new adventure" selection-menu
        //      option, which does a strictly better version of the same
        //      thing (a full structured adventure with acts/scenes/NPCs,
        //      not just a flavor-text reading) -- as a deliberate choice
        //      instead of an unconditional one. Running both was two
        //      competing onboarding flows firing on every boot.
        // Manual seeding is still available any time via `!gm seed`.
        if (process.env.AUTO_SEED_CAMPAIGN === 'true') {
          setTimeout(() => {
            if (!campaignSeeded && orchestrator) {
              seedCampaign();
            }
          }, 5000);
        }

        setTimeout(() => {
          adventureDirector.maybePromptOnStartup({
            orchestrator,
            apiRequest,
            globalApiRequest: commandHandler.globalApiRequest,
            driver,
            sendChat,
            playerCount,
          }).catch(err => console.warn('[AdventureDirector] startup prompt failed:', err.message));
        }, 5500);
      }

      startAggressiveSync();
    }
    cancelGmTakeoverTimer();
    return;
  }

  // ─── GM VOTE REQUEST ──────────────────────────────────────────────
  if (msg.type === 'gm_vote_request') {
    if (myRole === 'gm') {
      console.log(`🗳️  Auto‑approving GM request from ${msg.requesterName}`);
      sendWS('approve_gm', { targetId: msg.requesterId });
    }
    return;
  }

  // ─── GM ROLE UPDATE (for this bot) ───────────────────────────────
  if (msg.type === 'gm_role_update') {
    const newRole = msg.role;
    if (newRole === 'gm' && myRole !== 'gm') {
      cancelGmTakeoverTimer();
      sendChat(`👑 I have assumed the role of Game Master.`);
      startAggressiveSync();
    } else if (newRole !== 'gm' && myRole === 'gm') {
      stopAggressiveSync();
    }
    myRole = newRole;
    console.log(`🔁 Role changed to: ${myRole}`);
    return;
  }

  // ─── SERVER ANNOUNCEMENT ──────────────────────────────────────────
  if (msg.type === 'server_announcement') {
    const text = msg.message || '';
    if (text.includes('Game Master has disconnected') && myRole !== 'gm') {
      startGmTakeoverTimer();
    }
    sendChat(`*${text}*`);
    return;
  }

  // ─── ROLL RESULT ──────────────────────────────────────────────────
  if (msg.type === 'roll-result' || msg.type === 'roll-dice') {
    const outcome = msg.outcome || '';
    const storyBeats = msg.storyBeats || 0;

    // CHANGED: previously hardcoded `ref: 'Scene Progress'`, a timer
    // name that only exists by coincidence. Real scenes -- especially
    // Crown-Spread-generated ones -- name their timers whatever the LLM
    // chose (see buildAdventurePrompt in adventure-director.js), so this
    // call almost always threw "Timer not found", got swallowed by the
    // catch below, and silently never ticked anything. Now we ask the
    // adventure engine what the current scene's first timer is actually
    // called and use that instead. If the scene has no timers at all (or
    // no adventure is loaded), we skip the call entirely rather than
    // firing a request we know will fail.
    if (outcome === 'Partial' || outcome === 'Miss') {
      try {
        const timerName = await adventureContext.getFirstSceneTimerName({ apiRequest });
        if (timerName) {
          await apiRequest('POST', ['adventure', 'timer'], {
            ref: timerName,
            amount: 1,
            scope: 'scene'
          });
          adventureContext.invalidate();
          console.log(`⏱️ Auto-ticked scene timer "${timerName}" due to Partial/Miss.`);
        } else {
          console.log('⏱️ No scene timer to auto-tick (no adventure loaded, or scene has no timers).');
        }
      } catch (e) {
        console.warn('Failed to auto-tick timer:', e.message);
      }
    }

    // Add story beats
    if (storyBeats > 0 && orchestrator) {
      orchestrator.addStoryBeats(storyBeats);
      await orchestrator.campaign.save();
      console.log(`🎲 Added ${storyBeats} Story Beats from roll.`);
    }
    return;
  }

  // ─── CHAT MESSAGES ────────────────────────────────────────────────
  let text = '', sender = 'Unknown';
  if (msg.type === 'chat-message' && msg.message) {
    text = msg.message.text || '';
    sender = msg.message.sender || 'Unknown';
  } else if (msg.type === 'chat_message' && msg.value) {
    text = msg.value.text || '';
    sender = msg.value.sender || 'Unknown';
  } else if (msg.type === 'chat-message') {
    text = msg.text || '';
    sender = msg.sender || 'Unknown';
  }
  if (!text && !sender) return;

  console.log(`💬 [${sender}] ${text}`);

  if (sender === BOT_NAME || sender === 'GM') return;

  // ─── Check for direct ROLL tags in user messages ────────────────
  // CHANGED: previously, if a player's [ROLL ...] tag didn't match the
  // full "Name" Attribute+Skill DV N Position shape (e.g. missing DV/
  // Position entirely, as in `[ROLL "Asadef" Wits+Stealth]`),
  // processSpecialTags() would return the text completely unchanged,
  // `processed !== text` would be false, and -- because there was no
  // early return in that case -- execution fell straight through into
  // the normal AI-narration path below. The raw bracket tag then got
  // pushed into conversation history as if it were an ordinary chat
  // line, and the LLM (having seen [ROLL ...] examples in its own
  // system prompt) would hallucinate a fake tool invocation/result
  // around it instead of anything real ever being rolled. Now we
  // validate the tag shape up front: a malformed tag gets an immediate,
  // honest usage hint and never reaches the LLM at all.
  if (text.includes('[ROLL "')) {
    const wellFormedRoll = /\[ROLL\s*"[^"]+"\s*[A-Za-z\+]+\s*DV\s*\d+\s*[A-Za-z]+\s*\]/i.test(text);
    if (!wellFormedRoll) {
      sendChat(
        `*(That roll tag is missing something. Format is ` +
        `\`[ROLL "Name" Attribute+Skill DV N Position]\` — e.g. ` +
        `\`[ROLL "Asadef" Wits+Stealth DV 3 Controlled]\`.)*`
      );
      return;
    }
    try {
      // NEW: same 20s hard ceiling as the AI-narration tag pass below --
      // a single well-formed roll tag should resolve almost instantly,
      // but this still guards against a hang instead of leaving the
      // player staring at nothing. See that call site's comment for why.
      const processed = await Promise.race([
        commandHandler.processSpecialTags(text, {
          orchestrator,
          charactersModule: characters,
          sendChat,
          ws,
          apiRequest,
          myRole,
          driver, // NEW: [SCENE COMPLETE] may need to generate new content
        }, sender),
        new Promise((_, reject) => setTimeout(() => reject(new Error('processSpecialTags timed out after 20s')), 20000)),
      ]);
      if (processed !== text) {
        sendChat(processed);
        recordRollResultInHistory(`${sender}: ${text}`, processed);
        await orchestrator.campaign.save();
        return;
      }
      // Well-formed by the regex above but still unresolved by
      // processSpecialTags (e.g. an internal parsing edge case) --
      // don't let it silently fall through to the LLM either.
      console.warn('⚠️ Roll tag matched shape check but was not resolved:', text);
      sendChat('*(Could not process that roll tag. Please check the character name and try again.)*');
      return;
    } catch (err) {
      console.warn('Failed to process roll tag:', err.message);
      sendChat(`*Error processing roll: ${err.message}*`);
      return;
    }
  }

  // ─── !GM COMMAND ──────────────────────────────────────────────────
  if (text.startsWith('!gm')) {
    try {
      const response = await commandHandler.handleBotCommand(sender, text, {
        orchestrator,
        charactersModule: characters,
        sendChat,
        ws,
        apiRequest,
        myRole,
        seedCampaign: () => seedCampaign(),
        driver,
        playerCount,
        globalApiRequest: commandHandler.globalApiRequest,
      });
      if (response && typeof response === 'string') {
        sendChat(response);
        // NEW: a `!gm roll ...` command resolves a real roll the exact
        // same way a player-typed [ROLL "..."] tag does (see the block
        // above) but via a totally separate code path in commands.js's
        // handleBotCommand() -- so it needs the same recording into
        // conversation history or the AI never learns the roll happened.
        if (/^!gm\s+roll\b/i.test(text.trim())) {
          recordRollResultInHistory(`${sender}: ${text}`, response);
        }
      }
      await orchestrator.campaign.save();
    } catch (err) {
      console.error('❌ Command handler error:', err.message);
      sendChat('*Error processing command.*');
    }
    return;
  }

  // ─── AI RESPONSE (only if GM or Assistant GM) ────────────────────
  // Assistant GM still narrates and still resolves mechanical tags
  // immediately -- processSpecialTags() (see commands.js) is what holds
  // back the narrative-authority ones (FACT/NPC CREATE/SCENE COMPLETE)
  // into the suggestion queue when context.myRole === 'assistant-gm'.
  if (myRole !== 'gm' && myRole !== 'assistant-gm') return;

  if (!orchestrator) {
    await initGame();
  }

  const conv = orchestrator.campaign.state.conversation || [];
  conv.push({ role: 'user', content: `${sender}: ${text}` });
  if (conv.length > MAX_HISTORY * 2) conv.splice(0, conv.length - MAX_HISTORY);
  orchestrator.campaign.state.conversation = conv;

  let messagesSinceLastSummary = orchestrator.campaign.state.messagesSinceLastSummary || 0;
  messagesSinceLastSummary++;
  orchestrator.campaign.state.messagesSinceLastSummary = messagesSinceLastSummary;
  if (messagesSinceLastSummary >= SUMMARISE_EVERY && conv.length >= SUMMARISE_EVERY) {
    await summariseStory();
    orchestrator.campaign.state.messagesSinceLastSummary = 0;
  }

  // Build system prompt with rules from orchestrator
  //
  // CHANGED (contextual pruning, not RAG -- the game state is small and
  // already structured/indexed in memory, it just doesn't need to be
  // fully re-sent every single turn): this used to prepend the ENTIRE
  // rules.txt (600+ lines) to every system prompt regardless of whether
  // the current turn needed any of it. Now only a compact index of
  // section titles goes in by default; the model is told to ask for a
  // specific section by name via `[LOOKUP RULE "Section Title"]` when it
  // actually needs the full text of a rule, and that tag gets resolved
  // (see processSpecialTags() in commands.js) the same inline way [ROLL
  // ...] already is. This is a plain keyword lookup against an in-memory
  // list, not a vector search -- there's nothing here to retrieve that
  // isn't already a direct key.
  let fullSystemPrompt = BASE_SYSTEM_PROMPT;
  if (orchestrator && orchestrator.world && orchestrator.world.rules) {
    const rulesIndex = rulesIndexModule.buildIndex(orchestrator.world.rules);
    fullSystemPrompt = rulesIndex + '\n\n' + fullSystemPrompt;
  }

  const summary = orchestrator.campaign.getSummary();
  if (summary) fullSystemPrompt += '\n\nCampaign Summary:\n' + summary;

  // NEW: continuity from PAST completed adventures -- a handful of
  // compact LLM-generated summaries (see adventure-director.js's
  // finalizeAdventure()), not raw chat transcript. This is the actual
  // mechanism for "history to draw on without ingesting insane amounts
  // of history" -- each entry is ~150-200 words, capped at the last 10
  // completed adventures.
  const archive = orchestrator.campaign.state.adventureArchive;
  if (archive?.length) {
    fullSystemPrompt += '\n\nPast Completed Adventures (for continuity/reference only -- not currently active):\n';
    for (const entry of archive) {
      fullSystemPrompt += `- "${entry.title}": ${entry.summary}\n`;
    }
  }

  // Add facts
  const factsText = orchestrator.campaign.state.facts ? Object.entries(orchestrator.campaign.state.facts).map(([k,v]) => `- ${k}: ${v}`).join('\n') : '';
  if (factsText) fullSystemPrompt += '\n\nCurrent World Facts:\n' + factsText;

  // NEW: relevance-ranked long-term memory retrieval (Elasticsearch,
  // optional -- see modules/knowledge-index.js). The block above dumps
  // ALL of campaignState.facts every turn, which is fine for a short
  // campaign but grows unbounded over a long one and eventually crowds
  // out everything else in the prompt. When ES is configured, this
  // additionally pulls just the handful of facts/NPCs/past-summary
  // snippets that are actually relevant to what the player just said --
  // e.g. "who told you about the well?" surfaces the NPC and fact docs
  // that mention it, however many sessions ago they were created,
  // without needing them in the always-on facts dump or raw chat
  // history at all. No-ops (empty array) when ES isn't configured, so
  // this is purely additive.
  if (knowledgeIndex.isEnabled()) {
    try {
      const memoryHits = await knowledgeIndex.search(orchestrator.campaign.campaignCode, text, { size: 5 });
      if (memoryHits.length) {
        fullSystemPrompt += '\n\nRelevant Memory (retrieved -- may include past facts, NPCs, or session summaries; use only what\'s actually relevant to this turn):\n' +
          memoryHits.map(h => `- [${h.type}] ${h.text}`).join('\n');
      }
    } catch (e) {
      console.warn('⚠️  Knowledge index retrieval failed:', e.message);
    }
  }

  // Live adventure scene context
  try {
    const sceneContext = await adventureContext.getSceneContextForPrompt({ apiRequest });
    if (sceneContext) fullSystemPrompt += sceneContext;

    // NEW: also inject an excerpt of the full adventure doc text, if one
    // exists for the currently loaded module (manifest-backed modules
    // only -- AI-generated Crown Spread adventures have no doc file and
    // this will just return null, which is fine). Bounded to 4000 chars
    // so a full module doc doesn't blow the context budget on every turn.
    const doc = await adventureContext.getAdventureDoc({ apiRequest });
    if (doc) fullSystemPrompt += '\n\nAdventure Reference Text (excerpt):\n' + doc.slice(0, 4000);
  } catch (e) {
    console.warn('[AdventureContext] Failed to build scene context for prompt:', e.message);
  }

  // Character sheets
  //
  // CHANGED (contextual pruning): this used to dump EVERY character's
  // full sheet (attributes, skills, talents, bonds, complications,
  // assets, followers) on every single turn, regardless of whether
  // anyone but the active speaker was even involved. For a 5-player
  // party that's most of the token budget spent re-sending data the
  // model won't use most turns. Now only the character(s) actually
  // relevant to THIS turn get the full sheet: whoever is speaking
  // (`sender`), plus anyone else explicitly named in their message (so
  // "I help Lena climb" still gives the model Lena's real stats, not
  // just her name). Everyone else gets a compact one-line status --
  // exactly what a human GM actually holds in their head about a
  // character who isn't currently the focus.
  const allChars = characters.getAll();
  const charNames = Object.keys(allChars);
  if (charNames.length > 0) {
    const lowerText = (text || '').toLowerCase();
    const relevantNames = new Set();
    const senderMatch = charNames.find(n => n.toLowerCase() === String(sender).toLowerCase());
    if (senderMatch) relevantNames.add(senderMatch);
    for (const name of charNames) {
      if (lowerText.includes(name.toLowerCase())) relevantNames.add(name);
    }
    // Fallback: no character resolves to the sender and none were named
    // (e.g. the GM is talking, or a brand-new player hasn't picked a
    // character yet) -- give full detail to all of them rather than
    // guess wrong and silently withhold stats the model actually needs.
    const giveFullDetail = relevantNames.size > 0 ? relevantNames : new Set(charNames);

    fullSystemPrompt += '\n\n**Player Characters:**\n';
    for (const name of charNames) {
      const c = allChars[name];
      if (!giveFullDetail.has(name)) {
        fullSystemPrompt += `\n${name} (Tier ${c.tier || 1}): Harm ${c.harm || 0}, Fatigue ${c.fatigue || 0}, Boons ${c.boons || 0}, Obligation ${c.obligation || 0}. ` +
          `(Not the current focus -- full sheet omitted this turn; it'll be included automatically if they're named or acting.)\n`;
        continue;
      }
      fullSystemPrompt += `\n${name} (Tier ${c.tier || 1}):\n`;
      fullSystemPrompt += `  Harm: ${c.harm || 0}, Fatigue: ${c.fatigue || 0}, Boons: ${c.boons || 0}, Obligation: ${c.obligation || 0}\n`;
      fullSystemPrompt += `  Attributes: `;
      const attrs = c.attributes || {};
      const attrStr = Object.entries(attrs).map(([k,v]) => `${k}: ${v}`).join(', ');
      fullSystemPrompt += attrStr || 'None\n';
      fullSystemPrompt += `  Skills: `;
      const skills = c.skills || {};
      const skillStr = Object.entries(skills).map(([k,v]) => `${k}: ${v}`).join(', ');
      fullSystemPrompt += skillStr || 'None\n';
      if (c.talents && c.talents.length) {
        fullSystemPrompt += `  Talents: ${c.talents.join(', ')}\n`;
      }
      if (c.bonds && c.bonds.length) {
        fullSystemPrompt += `  Bonds: ${c.bonds.map(b => `${b.target} (${b.description})`).join(', ')}\n`;
      }
      if (c.complications && c.complications.length) {
        fullSystemPrompt += `  Complications: ${c.complications.join(', ')}\n`;
      }
      if (c.assets && c.assets.length) {
        fullSystemPrompt += `  Assets: ${c.assets.join(', ')}\n`;
      }
      if (c.followers && c.followers.length) {
        fullSystemPrompt += `  Followers: ${c.followers.map(f => `${f.name} (Cap ${f.cap})`).join(', ')}\n`;
      }
    }
  }

  fullSystemPrompt += `\n\nStory Beats available: ${orchestrator.campaign.state.sb || 0}.`;

  // ─── NEW: Strip self-authored fake roll-result cards ──────────────
  // Diagnosis: the model has been fed its own past roll results as full
  // rendered HTML (see below -- conv stored the whole <div
  // class="roll-result">...</div> block verbatim), and after enough
  // exposure it started reproducing that exact visual template directly
  // in its own prose instead of emitting a [ROLL ...] tag -- complete
  // with invented dice values and an outcome label that doesn't actually
  // follow the successes-vs-DV rule (since the model is just imitating
  // the shape of a result, not really evaluating one). A REAL
  // roll-result block can only ever exist in the bot's own output
  // because processSpecialTags() inserted it -- it is never legitimate
  // for that exact marker to appear in the model's raw reply. So: if
  // `<div class="roll-result">` shows up in `reply` BEFORE any tag
  // processing has run, it's fabricated by definition. Strip it.
  function stripHallucinatedRollCards(text) {
    const marker = '<div class="roll-result">';
    let result = text;
    let searchFrom = 0;
    while (true) {
      const idx = result.indexOf(marker, searchFrom);
      if (idx === -1) break;
      // Balance div depth from idx to find where this specific block closes,
      // since formatRollResult() nests several sibling <div> tags inside it.
      const tagRegex = /<div\b[^>]*>|<\/div>/gi;
      tagRegex.lastIndex = idx;
      let depth = 0;
      let end = -1;
      let m;
      while ((m = tagRegex.exec(result)) !== null) {
        depth += m[0].toLowerCase().startsWith('</div') ? -1 : 1;
        if (depth === 0) { end = tagRegex.lastIndex; break; }
      }
      if (end === -1) { searchFrom = idx + marker.length; continue; } // malformed; skip past it, don't loop forever
      console.warn('⚠️ Stripped a self-authored (fabricated) roll-result card from the AI reply -- it should have used a [ROLL ...] tag instead.');
      result = result.slice(0, idx) + result.slice(end);
      searchFrom = idx;
    }

    // NEW: also catch the COMPACT-format hallucination -- confirmed live
    // in an actual play log: "[Unknown rolled Wits+Investigation vs DV 3
    // (Controlled): 2 successes -> Success with SB]". This is the exact
    // template compactRollCardsForHistory() (below) writes into
    // conversation history -- proof the model imitates whatever
    // result-shaped text it's shown, in whatever format that happens to
    // be, not just the rich HTML card. The telltale "Unknown" name (real
    // code always has the actual resolved character name) confirms this
    // is fabricated, not a real substitution. Strip any bracket text
    // matching this shape from the raw reply the same way.
    const compactPattern = /\[[^\[\]]*\brolled\b[^\[\]]*\b(?:successes|Successes)\b[^\[\]]*->[^\[\]]*\]/g;
    const compactMatches = result.match(compactPattern);
    if (compactMatches) {
      console.warn('⚠️ Stripped a self-authored (fabricated) compact roll-summary from the AI reply:', compactMatches);
      result = result.replace(compactPattern, '');
    }

    // NEW: third detection layer -- a real production example showed the
    // model imitating a roll result as PLAIN BOLD/EMOJI MARKDOWN, with no
    // HTML tags and no bracket-arrow shorthand at all (e.g. "**Unknown**
    // rolls **Wits+Insight** (2d10) vs DV 3 (Controlled): 🎲 5 4 ✅
    // Successes: 0 | 💀 Story Beats: 0 **Miss** +2 Boons Current: Harm 0,
    // Fatigue 0, Boons 0"). Neither pattern above has any HTML/bracket
    // marker to anchor on for this form. Since the model can apparently
    // imitate a roll result in essentially unlimited surface forms, this
    // anchors on the one signature that's actually reliable regardless of
    // wrapping: the "✅ Successes: N" + "💀 Story Beats: N" phrase
    // combination together with the 🎲 dice-emoji line, which essentially
    // never occurs in ordinary narrative prose. Captures an optional
    // "Name rolls Pool (Nd10) vs DV N (Position):" line before it and an
    // optional "Current: Harm ..." line after it, since real (and
    // fabricated) cards usually include both.
    const hallmarkPattern = /(?:[*_]{0,2}[\w\s]{1,40}?[*_]{0,2}\s*rolls\s*[*_]{0,2}[\w+ ]{1,40}?[*_]{0,2}\s*\(\d+d10\)\s*vs\s*DV\s*\d+[^\n]*:?\s*\n)?[^\n]*🎲[^\n]*\n[^\n]*✅\s*Successes:\s*\d+[^\n]*💀\s*Story Beats:\s*\d+[^\n]*\n(?:[^\n]*\n){0,4}?[^\n]*Current:\s*Harm[^\n]*/gi;
    const hallmarkMatches = result.match(hallmarkPattern);
    if (hallmarkMatches) {
      console.warn('⚠️ Stripped a self-authored (fabricated) plain-text roll card from the AI reply:', hallmarkMatches);
      result = result.replace(hallmarkPattern, '');
    }

    return result;
  }

  // ─── NEW: Compact real roll-result cards before storing in history ─
  // The rich HTML card is great for the player (sendChat gets the full
  // version), but storing that same HTML in conversation history is
  // exactly what taught the model to imitate it (see above). Replace
  // each real roll-result block with a short plain-text summary for
  // whatever gets fed back to the LLM as chat history, breaking that
  // reinforcement loop without losing the roll's outcome as context.
  function compactRollCardsForHistory(text) {
    const marker = '<div class="roll-result">';
    let result = text;
    let searchFrom = 0;
    while (true) {
      const idx = result.indexOf(marker, searchFrom);
      if (idx === -1) break;
      const tagRegex = /<div\b[^>]*>|<\/div>/gi;
      tagRegex.lastIndex = idx;
      let depth = 0;
      let end = -1;
      let m;
      while ((m = tagRegex.exec(result)) !== null) {
        depth += m[0].toLowerCase().startsWith('</div') ? -1 : 1;
        if (depth === 0) { end = tagRegex.lastIndex; break; }
      }
      if (end === -1) { searchFrom = idx + marker.length; continue; }
      const block = result.slice(idx, end);
      const nameMatch = block.match(/<strong>([^<]+)<\/strong>\s*rolls\s*<strong>([^<]+)<\/strong>[^]*?vs DV (\d+) \(([^)]+)\)/i);
      const successesMatch = block.match(/Successes:\s*(\d+)/i);
      const outcomeMatch = block.match(/outcome-tag[^>]*>([^<]+)</i);
      // CHANGED: this used to be a rigid "[Name rolled X vs DV Y (Z): N
      // successes -> Outcome]" bracket template -- but that's exactly
      // the shape a confirmed real-world play log showed the model
      // imitating (see stripHallucinatedRollCards() above). Plain prose
      // is less "fill-in-the-template"-looking while carrying the same
      // information, which should reduce (though maybe not eliminate)
      // how tempting it is to copy verbatim.
      const summary = nameMatch
        ? `(${nameMatch[1]}'s ${nameMatch[2]} check against DV ${nameMatch[3]}, ${nameMatch[4]} position, came back with ${successesMatch ? successesMatch[1] : 'an unclear number of'} successes -- ${outcomeMatch ? outcomeMatch[1].toLowerCase() : 'an unclear result'}.)`
        : '(a roll was resolved.)';
      result = result.slice(0, idx) + summary + result.slice(end);
      searchFrom = idx + summary.length;
    }
    return result;
  }

  // ─── Helper: feed a player-executed roll back into AI context ──────
  // NEW (companion to the [CALL FOR ROLL ...] change above): the GM no
  // longer resolves a player's roll inline as part of its own narration,
  // so the AI never automatically "sees" the outcome the way it used to
  // (previously the roll happened synchronously inside the same message
  // it was narrating, however blindly). Now that a roll can complete via
  // `!gm roll ...` or a player-typed `[ROLL "..."]` tag -- both of which
  // return their result directly to chat via sendChat() and historically
  // never touched orchestrator.campaign.state.conversation at all -- that
  // result has to be explicitly recorded into history, or the next AI
  // turn would have no idea a roll even happened. Uses
  // compactRollCardsForHistory() (defined above) so the same
  // anti-imitation compacting applies here as it does to the AI's own
  // output.
  function recordRollResultInHistory(promptLine, resultText) {
    if (!orchestrator) return;
    const state = orchestrator.campaign.state;
    const arr = state.conversation || [];
    arr.push({
      role: 'user',
      content: `${promptLine}\n[dice engine] ${compactRollCardsForHistory(resultText)}`
    });
    if (arr.length > MAX_HISTORY * 2) arr.splice(0, arr.length - MAX_HISTORY);
    state.conversation = arr;
  }

  // ─── Helper: Call for a roll if AI forgot ──────────────────────────
  // CHANGED (auto-roll was a bad player experience): this used to insert
  // a [ROLL ...] tag, which processSpecialTags() then resolved
  // immediately -- meaning if the model presented options without
  // remembering its own roll tag, the fallback didn't just remind it to
  // ask for a roll, it secretly rolled the dice FOR the player without
  // them ever being asked. That's not how a real GM runs a table. Now
  // this inserts [CALL FOR ROLL ...] instead, which only prompts the
  // player for the roll (see commands.js's processSpecialTags()) and
  // waits for them to actually make it via `!gm roll` or the VTT.
  function forceRollIfMissing(response, context) {
    // Check if the response contains numbered options (e.g., "1. Do something")
    const hasOptions = /\d\.[^\n]+\n/.test(response);
    const hasRoll = /\[(?:CALL FOR ROLL|ROLL)\s*"[^"]+"/.test(response);

    // If there are options but no roll, try to infer the default roll
    if (hasOptions && !hasRoll) {
      const defaultChar = context.sender || 'Player';
      const firstOption = response.match(/\d\.\s*([^\n]+)/);
      if (firstOption) {
        const action = firstOption[1];
        let attr = 'Wits';
        let skill = 'Insight';
        if (action.includes('attack') || action.includes('hit') || action.includes('fight')) {
          attr = 'Body'; skill = 'Melee';
        } else if (action.includes('sneak') || action.includes('hide') || action.includes('stealth')) {
          attr = 'Wits'; skill = 'Stealth';
        } else if (action.includes('persuade') || action.includes('talk') || action.includes('convince')) {
          attr = 'Presence'; skill = 'Sway';
        } else if (action.includes('climb') || action.includes('jump') || action.includes('run')) {
          attr = 'Body'; skill = 'Athletics';
        } else if (action.includes('investigate') || action.includes('search') || action.includes('look')) {
          attr = 'Wits'; skill = 'Investigation';
        } else if (action.includes('lore') || action.includes('know') || action.includes('recall')) {
          attr = 'Wits'; skill = 'Lore';
        }
        const rollTag = `[CALL FOR ROLL "${defaultChar}" ${attr}+${skill} DV 3 Controlled]`;
        const matchIndex = response.indexOf(firstOption[0]);
        if (matchIndex !== -1) {
          return response.slice(0, matchIndex) + rollTag + '\n' + response.slice(matchIndex);
        }
      }
    }
    return response;
  }

  // ─── Generate AI Response ────────────────────────────────────────
  //
  // CHANGED ("The Silent Void"): a local model can take 10-30+ seconds
  // to respond, during which the chat just... says nothing. True
  // token-by-token streaming to the client would need the socket
  // server's chat protocol to support appending to/editing an existing
  // message, which it currently doesn't (sendChat() always posts a
  // brand-new message) -- that's a socket-server change, out of scope
  // here. What IS safely fixable on the bot's side: don't make fast
  // providers (OpenAI/DeepSeek, typically 2-7s) post a needless
  // "thinking" message on every single reply, but DO let the player know
  // something is happening if it's taking noticeably long. The drivers
  // now support real streaming internally (see generateResponse(context,
  // onToken) on each driver) for whenever the socket protocol grows
  // message-editing support; this is the practical stopgap within
  // today's protocol.
  const typingTimer = setTimeout(() => {
    sendChat('*(The GM is composing a reply...)*');
  }, 2500);

  try {
    const reply = await driver.generateResponse({
      systemPrompt: fullSystemPrompt,
      messages: conv.slice(-MAX_HISTORY)
    });
    clearTimeout(typingTimer);

    let clean = reply.trim();

    // NEW: strip any fake, model-authored roll-result card BEFORE any
    // tag processing runs -- see stripHallucinatedRollCards() above for
    // why this exact marker can only be legitimate as bot-inserted output.
    clean = stripHallucinatedRollCards(clean);

    // CHANGED (ROOT FIX for "special tags don't seem to be parsing"):
    // forceRollIfMissing() INSERTS a synthetic [ROLL ...] tag into the
    // text. The old code ran processSpecialTags() FIRST and
    // forceRollIfMissing() SECOND -- meaning any tag this fallback
    // injected was inserted only *after* tag-resolution already
    // happened, and was never resolved. It went out to chat as a raw,
    // literal "[ROLL "Name" Wits+Insight DV 3 Controlled]" string. Any
    // time the model presented numbered options without including its
    // own roll tag (which happens often, roll-tag compliance from LLMs
    // is inherently imperfect), this is exactly what players would see.
    // Fix: insert the fallback tag FIRST, then resolve ALL tags
    // (including the injected one) in a single processSpecialTags pass.
    clean = forceRollIfMissing(clean, { sender });

    // NEW: hard ceiling on tag processing itself, independent of the
    // per-tag 5s withTimeout()s already inside processSpecialTags()
    // (commands.js). Those cover individual API calls, but a truncated/
    // malformed reply (see the raised token defaults in drivers/*.js --
    // this is the belt to that belt-and-suspenders) can still produce an
    // unusual number of tags or an edge case those inner guards don't
    // anticipate, and a chain of several sequential 5s waits already
    // reads as "frozen" to someone watching chat. If tag processing
    // hasn't finished within 20s, give up on it and send the raw
    // (untagged) reply rather than leaving the table staring at nothing.
    const rawBeforeTags = clean;
    try {
      clean = await Promise.race([
        commandHandler.processSpecialTags(clean, {
          orchestrator,
          charactersModule: characters,
          sendChat,
          ws,
          apiRequest,
          myRole,
          driver, // NEW: [SCENE COMPLETE] may need to generate new content
        }, sender), // NEW: pass sender through so "me" resolves consistently here too
        new Promise((_, reject) => setTimeout(() => reject(new Error('processSpecialTags timed out after 20s')), 20000)),
      ]);
    } catch (e) {
      console.error('⚠️ Tag processing did not finish in time, sending unresolved reply:', e.message);
      clean = rawBeforeTags;
    }

    // NEW: catch any tag-shaped text that survived processing --
    // malformed tags, typos in verb/keyword, or anything the regexes
    // don't yet cover show up here in logs instead of silently reaching
    // players as literal bracket text.
    const leftover = clean.match(/\[[A-Z][A-Z\s]*[^\]]*\]/g);
    if (leftover) {
      console.warn('⚠️ Unresolved tag(s) in AI response:', leftover);
    }

    if (clean) {
      sendChat(clean);
      // NEW: store a compacted (roll-cards-summarized) version in
      // conversation history rather than the full rich HTML that
      // sendChat() just used -- see compactRollCardsForHistory() above.
      // Players still see the nice card; the model stops being shown
      // (and imitating) the exact template turn after turn.
      const forHistory = compactRollCardsForHistory(clean);
      conv.push({ role: 'assistant', content: forHistory });
      if (conv.length > MAX_HISTORY * 2) conv.splice(0, conv.length - MAX_HISTORY);
      orchestrator.campaign.state.conversation = conv;
      await orchestrator.campaign.save();
    }
  } catch (err) {
    clearTimeout(typingTimer);
    console.error('❌ LLM error:', err.message);
    sendChat('*The story pauses. (AI error)*');
  }
}

// -------------------------------------------------------------------
// 10. Summarisation (unchanged)
// -------------------------------------------------------------------
async function summariseStory() {
  if (!driver || !orchestrator) return;
  const conv = orchestrator.campaign.state.conversation || [];
  const recent = conv.slice(-SUMMARISE_EVERY).map(m => `${m.role}: ${m.content}`).join('\n');
  const existing = orchestrator.campaign.getSummary() ? `Previous summary:\n${orchestrator.campaign.getSummary()}\n\n` : '';
  const prompt = existing + recent + '\n\nWrite a concise campaign summary (max 200 words) including key characters, locations, and unresolved plot threads.';
  try {
    const fresh = await driver.generateResponse({
      systemPrompt: 'You are a summariser. Output only the summary text.',
      messages: [{ role: 'user', content: prompt }]
    });
    if (fresh && fresh.trim()) {
      orchestrator.campaign.setSummary(fresh.trim());
      // Indexed into Elasticsearch too, if configured (see
      // modules/knowledge-index.js) -- each summary becomes its own
      // searchable snapshot rather than overwriting the last one, so
      // "what happened with X a few sessions ago" stays answerable even
      // after orchestrator.campaign's single current-summary field has
      // moved on.
      knowledgeIndex.indexSummary(orchestrator.campaign.campaignCode, fresh.trim()).catch(() => {});
    }
  } catch (e) {
    console.error('Summarisation failed:', e.message);
  }
}

// -------------------------------------------------------------------
// 11. Startup Message Scheduler (unchanged)
// -------------------------------------------------------------------
function scheduleStartupMessage() {
  if (startupMessageSent) return;
  setTimeout(() => {
    if (startupMessageSent) return;
    if (!orchestrator) {
      console.warn('Orchestrator not ready for startup message.');
      return;
    }
    const allChars = characters.getAll();
    const hasCharacters = Object.keys(allChars).length > 0;
    charactersExist = hasCharacters;

    const region = orchestrator.currentScene?.region || orchestrator.options.defaultRegion || 'unknown';
    // BUGFIX: region JSON stores the display name under `title`, not
    // `name` (which doesn't exist on these records) -- this always fell
    // through to the raw slug/id before.
    const regionName = orchestrator.world?.getRegion(region)?.title || region;

    const msg = generateStartupMessage(regionName, playerCount, hasCharacters, 'GM');
    sendChat(msg);
    startupMessageSent = true;
    console.log('📨 Startup message sent.');
  }, 2000);
}

// -------------------------------------------------------------------
// 11b. Status dashboard snapshot
// -------------------------------------------------------------------
// Pure read of live module-scope state -- no side effects -- so
// status-server.js can call this on every dashboard poll/push tick
// without worrying about mutating anything.
function buildStatusSnapshot() {
  const adv = adventureContext.getCachedStateSync();
  const allChars = characters.getAll ? characters.getAll() : {};
  const party = Object.values(allChars || {}).map(c => ({
    name: c.name,
    summary: [
      c.harm ? `harm ${c.harm}` : null,
      c.fatigue ? `fatigue ${c.fatigue}` : null,
    ].filter(Boolean).join(', ') || 'unharmed'
  }));

  // ─── AI GM Session Panel data ────────────────────────────────────
  // NEW: the bot has always tracked conversation/facts/sb/obligation
  // internally (gm-orchestrator.js's campaign state, characters.js) but
  // never surfaced any of it anywhere a GM could actually look at it —
  // it lived entirely in this process's memory (and the campaign JSON
  // file on disk) until now. Piggybacks on the existing status-server.js
  // dashboard/`/api/state` + SSE plumbing rather than inventing a new
  // transport: same read-only snapshot pattern as everything above.
  const campaignState = orchestrator?.state || null;
  const sbBank = campaignState?.sb || 0;
  const facts = campaignState?.facts || {};
  // Last 12 conversation turns (see handleMessage()'s `conv.push(...)`
  // and generateAndSendResponse()'s assistant-side push) — "what the bot
  // currently remembers" in the most literal, verifiable sense: this
  // (plus any earlier summary — see campaign.getSummary()) is the exact
  // context window the model itself sees.
  const recentMemory = (campaignState?.conversation || []).slice(-12).map(m => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content.slice(0, 400) : ''
  }));
  const memorySummary = orchestrator?.campaign?.getSummary?.() || null;

  // Obligation totals per Patron. Characters didn't carry a `.patron`
  // field over the wire until now (see vtt-connected.js's
  // pushCharactersToServer()) — anything synced before that fix, or a
  // character with no Patron bond set, is grouped under "Unbound"
  // rather than silently dropped.
  const obligationByPatron = {};
  for (const c of Object.values(allChars || {})) {
    const patronName = c.patron || 'Unbound';
    if (!obligationByPatron[patronName]) {
      obligationByPatron[patronName] = { patron: patronName, total: 0, characters: [] };
    }
    const obligation = c.obligation || 0;
    obligationByPatron[patronName].total += obligation;
    obligationByPatron[patronName].characters.push({ name: c.name, obligation });
  }
  const obligations = Object.values(obligationByPatron).sort((a, b) => b.total - a.total);

  return {
    connected,
    role: myRole,
    wsUrl: WS_URL,
    room: ROOM_CODE,
    botName: BOT_NAME,
    driverName: driver ? (driver.constructor?.meta?.name || driver.constructor?.name) : null,
    driverModel: driver ? driver.model : null,
    tokenUsage: driver && typeof driver.getUsage === 'function' ? driver.getUsage() : null,
    adventure: adv ? {
      title: adv.title,
      status: adv.status,
      act: adv.currentAct?.title || null,
      scene: adv.currentScene?.title || orchestrator?.currentScene?.title || null,
    } : (orchestrator?.currentScene ? { title: null, status: 'active', act: null, scene: orchestrator.currentScene.title } : null),
    region: orchestrator?.currentScene?.region || orchestrator?.options?.defaultRegion || null,
    party,
    // GM Session Panel
    sbBank,
    facts,
    recentMemory,
    memorySummary,
    obligations,
    // Assistant GM mode: pending narrative suggestions awaiting the human
    // GM/Co-GM's approve/reject (see modules/assistant-suggestions.js and
    // commands.js's isAssistant branches in processSpecialTags()). Empty
    // whenever this bot isn't holding the assistant-gm role, since nothing
    // gets queued in that case.
    isAssistantGm: myRole === 'assistant-gm',
    pendingSuggestions: assistantSuggestions.list(),
  };
}

// -------------------------------------------------------------------
// 12. Main
// -------------------------------------------------------------------
async function main() {
  console.log('🚀 AI GM Bot starting…');
  console.log(`   WS: ${WS_URL}   Room: ${ROOM_CODE}   Name: ${BOT_NAME}`);

  if (process.env.STATUS_SERVER !== 'false') {
    statusServer.start({ getState: buildStatusSnapshot });
  }

  await initGame();

  if (driver && typeof driver.initialize === 'function') {
    // CHANGED: this used to log the error and keep going regardless --
    // meaning a bot whose LLM backend never actually connected (bad key,
    // unreachable Ollama server, HEADLESS mode with no usable model) would
    // still connect to chat and silently fail every single message
    // instead of anything noticing it was broken. In a headless
    // deployment (systemd/Docker/etc.) the right behavior is to exit
    // non-zero so the process supervisor restarts it (and its restart
    // backoff/alerting kicks in) rather than run indefinitely in a
    // useless state. Non-headless (interactive dev) failures already got
    // a chance at recovery inside driver.initialize() itself (see
    // ollama-driver.js's _recoverModel()) before reaching here, so
    // exiting at this point is the right call either way.
    try {
      await driver.initialize();
    } catch (e) {
      console.error('❌ Driver init failed:', e.message);
      console.error('   The bot cannot reach its configured AI backend. Exiting so a process supervisor can restart it.');
      process.exit(1);
    }
  }

  connect();
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…');
  stopAggressiveSync();
  statusServer.stop();
  if (orchestrator) {
    await orchestrator.campaign.save();
  }
  if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'Shutdown');
  setTimeout(() => process.exit(0), 1000);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
