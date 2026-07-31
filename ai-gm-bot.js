#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const characters = require('./modules/characters');
const commandHandler = require('./modules/commands');
const adventureDirector = require('./modules/adventure-director');
const adventureContext = require('./modules/adventure-context');
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
const ROOM_CODE = process.env.ROOM || 'ABC123';
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
  'I. CRITICAL RULE: ALWAYS CALL FOR ROLLS\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'You MUST include a [ROLL "CharacterName" Attribute+Skill DV Position] tag in EVERY response to a player action that has risk or uncertainty.\n\n' +

  'When a player types a number (1, 2, 3, etc.) in response to a menu of options:\n' +
  '1. IMMEDIATELY describe the action briefly (1-2 sentences).\n' +
  '2. IMMEDIATELY call for a roll using [ROLL "CharacterName" Attribute+Skill DV Position].\n' +
  '3. THEN (after the roll is processed) narrate the full outcome.\n\n' +

  'NEVER narrate a player\'s action without a roll unless it is trivial (walking through a door, picking up an object, speaking a sentence).\n\n' +

  'Example of CORRECT format:\n' +
  '"You step forward, [ROLL "Asadef" Presence+Sway DV 3 Controlled] to see if you can calm the situation."\n\n' +

  'Example of INCORRECT format (DO NOT DO THIS):\n' +
  '"You step forward and try to calm the situation. The figure nods." (No roll called!)\n\n' +

  'Embed the [ROLL ...] tag naturally within a sentence, not as a separate statement. The roll should feel like part of the narration.\n' +
  'Example: "You edge toward the opening, [ROLL "Asadef" Wits+Stealth DV 3 Controlled] to see if you remain hidden."\n' +
  'Example: "You try to climb the wall, [ROLL "Asadef" Body+Athletics DV 3 Controlled] to reach the ledge."\n' +
  'Do NOT put the roll tag on its own line or as a separate paragraph. Keep it embedded in the narrative.\n\n' +

  'ROLL RESULTS MUST APPEAR BEFORE YOUR NARRATIVE DESCRIPTION. Structure your response as:\n' +
  '1. The [ROLL ...] tag embedded in a sentence (the bot replaces it with formatted results)\n' +
  '2. THEN your narrative description of what happens\n\n' +

  'CRITICAL: NEVER write out a roll result yourself, IN ANY FORM -- no dice emoji, no "Successes:" count, no outcome label (Clean Success/Partial/Miss/etc.), no HTML, and no bracketed shorthand summary either (e.g. never write something like "[Name rolled X vs DV Y: N successes -> Outcome]" -- that exact shape is reserved for the game engine\'s own internal bookkeeping, never something you produce yourself). ' +
  'That entire display is generated automatically the moment you use a [ROLL ...] tag. If you find yourself typing anything that looks like a finished dice result in ANY format, stop -- ' +
  'use the [ROLL ...] tag instead and let the game engine produce the real result.\n\n' +

  'Example of something you must NEVER write yourself, in ANY form resembling this, even as plain markdown with no HTML tags at all:\n' +
  '"**Asadef** rolls **Wits+Insight** (2d10) vs DV 3 (Controlled): 🎲 5 4  ✅ Successes: 0 | 💀 Story Beats: 0  **Miss**  Current: Harm 0, Fatigue 0, Boons 0"\n' +
  'This is ALWAYS forbidden, whether written as HTML, as a bracketed summary, or as plain bold/emoji text like the example above. If you do not have a real result to report, use [ROLL ...] and wait for the actual outcome instead of inventing one.\n\n' +

  'Example of correct format:\n' +
  'You edge toward the opening, [ROLL "Asadef" Wits+Stealth DV 3 Controlled] to slip through unnoticed. You press yourself flat against the rock and move slowly, one silent step at a time.\n\n' +

  'Example of INCORRECT format (DO NOT DO THIS):\n' +
  'You press yourself flat against the rock. [ROLL "Asadef" Wits+Stealth DV 3 Controlled] The wind tugs at your cloak.\n\n' +

  'If the player has no character selected, respond with: "⚠️ Please select a character in the VTT or create one with !gm create <name>."\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'II. CORE MECHANICS\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'You have a pool of Story Beats (SB). When you want to introduce a complication, write [SPEND SB N] to spend N beats. The bot will deduct them and you can narrate the complication.\n\n' +

  'Create timers with [TIMER "name" segments "onFill message"] and tick them with [TICK TIMER "name" N].\n\n' +

  'Draw from the Deck of Consequences with [DRAW count region] or perform a Crown Spread with [CROWN region].\n\n' +

  'Set scene Position with [SET POSITION Dominant|Controlled|Desperate] and set DV with [SET DV N].\n\n' +

  'Apply resource changes with [APPLY HARM Name N], [APPLY FATIGUE Name N], [APPLY BOON Name N], etc. ("ADD" also works in place of "APPLY".)\n\n' +

  'When an NPC casts a spell, use [NPC CAST "Spell Name" TargetName]. The bot will deduct Story Beats (SB) from the GM\'s pool and resolve the effect. Spell names must match entries in the spellbook (e.g., "Ember Dart", "Hush"). Target can be a player character name or a generic target like "the guard".\n\n' +

  'When an encounter is complete, resolve it with [ENCOUNTER RESOLVE outcome "notes"] where outcome is clean, partial, or miss.\n\n' +

  'When a scene\'s dramatic question has been resolved and the story is ready to move forward, use [SCENE COMPLETE "brief note on how it ended"] to advance to the next scene. ' +
  'Use this naturally at real scene breaks -- not every exchange, only when this beat of the story has actually concluded.\n\n' +

  'Whenever you introduce a new named character who isn\'t already established, use [NPC CREATE "Name" "Role" "Motivation"] once, inline, the first time they appear (e.g. right after describing them). ' +
  'This registers them so they can be referenced consistently later. This tag produces no visible output -- keep narrating normally around it.\n\n' +

  'Use timers to build pressure; when a timer fills, advance the scene or introduce a complication.\n\n' +

  'On a Partial or Miss, the scene timer will auto-tick. You can also manually tick timers with [TICK TIMER "name" N].\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'III. OUTCOME MATRIX\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'Clean Success: S ≥ DV, SB = 0 → Success without complication.\n' +
  'Success with SB: S ≥ DV, SB > 0 → Success; GM may spend SB for complication.\n' +
  'Partial: 0 < S < DV → Progress with complication; player gains 1 Boon; auto-tick timer.\n' +
  'Miss: S = 0 → No progress; GM escalates; player gains 2 Boons; auto-tick timer.\n\n' +

  '═══════════════════════════════════════════════════════════════\n' +
  'IV. PACING & NARRATION\n' +
  '═══════════════════════════════════════════════════════════════\n\n' +

  'Keep narration vivid but concise. Frame the situation, call for rolls, then narrate outcomes.\n' +
  'Let the dice tell the story. Embrace failure — it generates Story Beats that make the story interesting.\n' +
  'When in doubt, default to DV 3, Controlled Position.\n\n' +

  'NEVER narrate your own interpretation of what the player is doing (e.g. "I understand — you\'re letting me know you\'re ready for the next beat" or "I understand you want to move on"). ' +
  'If a player message is terse, ambiguous, or just a number, respond by continuing the STORY directly -- describe what happens next in-world -- rather than describing or explaining your read of their intent. Stay in the fiction at all times.';

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
            console.log('👑 No GM present – requesting GM role.');
            sendWS('request_gm');
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
    if (!orchestrator || myRole !== 'gm') {
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
            console.log(`🔄 Aggressive sync: merged ${synced} character(s) from server.`);
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
    if (myRole === 'gm') {
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
        console.log(`⬇️  ${msg.type}`, JSON.stringify(msg).slice(0, 120));
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
      const { loadCharacters } = require('./modules/characters');
      loadCharacters(charObj);
      console.log(`📥 Auto‑synced ${charList.length} characters from state-updated.`);
    } else {
      console.log('ℹ️  state-updated received with no character data.');
    }
    return;
  }

  // ─── IGNORE PRESENCE AND CHARACTER-SELECT EVENTS ────────────────
  if (msg.type === 'presence' || msg.type === 'character-select') {
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
      myRole = myClient.role;
      console.log(`🔁 Role updated from presence: ${myRole}`);
      if (myRole === 'gm') {
        startAggressiveSync();
      } else {
        stopAggressiveSync();
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
    if (myRole !== 'gm') {
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
      const processed = await commandHandler.processSpecialTags(text, {
        orchestrator,
        charactersModule: characters,
        sendChat,
        ws,
        apiRequest,
        myRole,
        driver, // NEW: [SCENE COMPLETE] may need to generate new content
      }, sender);
      if (processed !== text) {
        sendChat(processed);
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
      }
      await orchestrator.campaign.save();
    } catch (err) {
      console.error('❌ Command handler error:', err.message);
      sendChat('*Error processing command.*');
    }
    return;
  }

  // ─── AI RESPONSE (only if GM) ────────────────────────────────────
  if (myRole !== 'gm') return;

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
  let fullSystemPrompt = BASE_SYSTEM_PROMPT;
  if (orchestrator && orchestrator.world && orchestrator.world.rules) {
    fullSystemPrompt = orchestrator.world.rules + '\n\n' + fullSystemPrompt;
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
  const allChars = characters.getAll();
  const charNames = Object.keys(allChars);
  if (charNames.length > 0) {
    fullSystemPrompt += '\n\n**Player Characters (current stats):**\n';
    for (const name of charNames) {
      const c = allChars[name];
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

  // ─── Helper: Force roll if AI forgot ──────────────────────────────
  function forceRollIfMissing(response, context) {
    // Check if the response contains numbered options (e.g., "1. Do something")
    const hasOptions = /\d\.[^\n]+\n/.test(response);
    const hasRoll = /\[ROLL\s*"[^"]+"/.test(response);

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
        const rollTag = `[ROLL "${defaultChar}" ${attr}+${skill} DV 3 Controlled]`;
        const matchIndex = response.indexOf(firstOption[0]);
        if (matchIndex !== -1) {
          return response.slice(0, matchIndex) + rollTag + '\n' + response.slice(matchIndex);
        }
      }
    }
    return response;
  }

  // ─── Generate AI Response ────────────────────────────────────────
  try {
    const reply = await driver.generateResponse({
      systemPrompt: fullSystemPrompt,
      messages: conv.slice(-MAX_HISTORY)
    });

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

    clean = await commandHandler.processSpecialTags(clean, {
      orchestrator,
      charactersModule: characters,
      sendChat,
      ws,
      apiRequest,
      myRole,
      driver, // NEW: [SCENE COMPLETE] may need to generate new content
    }, sender); // NEW: pass sender through so "me" resolves consistently here too

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
    const regionName = orchestrator.world?.getRegion(region)?.name || region;

    const msg = generateStartupMessage(regionName, playerCount, hasCharacters, 'GM');
    sendChat(msg);
    startupMessageSent = true;
    console.log('📨 Startup message sent.');
  }, 2000);
}

// -------------------------------------------------------------------
// 12. Main
// -------------------------------------------------------------------
async function main() {
  console.log('🚀 AI GM Bot starting…');
  console.log(`   WS: ${WS_URL}   Room: ${ROOM_CODE}   Name: ${BOT_NAME}`);

  await initGame();

  if (driver && typeof driver.initialize === 'function') {
    try { await driver.initialize(); } catch (e) { console.error('Driver init failed:', e.message); }
  }

  connect();
}

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down…');
  stopAggressiveSync();
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
