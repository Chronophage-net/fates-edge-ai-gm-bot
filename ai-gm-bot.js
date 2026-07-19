#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const https = require('https');
const http = require('http');

// -------------------------------------------------------------------
// 0. Manual .env loader (no dotenv dependency)
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
    if (commentIdx !== -1) {
      val = val.slice(0, commentIdx).trim();
    }
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

// -------------------------------------------------------------------
// 2. Load modules and drivers
// -------------------------------------------------------------------
const AI_PROVIDER = (process.env.AI_PROVIDER || 'ollama').toLowerCase();

// Drivers
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
    console.log(`🤖 Loaded DeepSeek driver (model: ${process.env.DEEPSEEK_MODEL || 'deepseek-chat'})`);
  } else {
    console.error(`❌ Unsupported AI provider: ${AI_PROVIDER}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`❌ Failed to load driver: ${e.message}`);
  process.exit(1);
}

// Modules
const campaignModule = require('./modules/campaigns');
const charactersModule = require('./modules/characters');
const diceModule = require('./modules/dice');
const timersModule = require('./modules/timers');
const deckModule = require('./modules/decks');
const worldModule = require('./modules/world');
const commandHandler = require('./modules/commands');

// -------------------------------------------------------------------
// 3. Configuration constants
// -------------------------------------------------------------------
const WS_URL = process.env.WS_URL || 'ws://localhost:10000';
const ROOM_CODE = process.env.ROOM || 'ABC123';
const BOT_NAME = process.env.BOT_NAME || 'AI_GM';
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || '20', 10);
const SUMMARISE_EVERY = parseInt(process.env.SUMMARISE_EVERY || '10', 10);
const API_KEY = process.env.API_KEY || '';

// Server API base URL
const CAMPAIGN_API_URL = process.env.CAMPAIGN_API_URL || 'http://localhost:10000/api';
const CAMPAIGN_CODE_FILE = path.resolve(process.cwd(), 'campaigns', `${ROOM_CODE.toUpperCase()}_code.txt`);

// -------------------------------------------------------------------
// 4. Build system prompt with rulebook and GM instructions
// -------------------------------------------------------------------
const rulePath = path.resolve(process.cwd(), 'data', 'rules.txt');
let rulebook = '';
try {
  if (fs.existsSync(rulePath)) {
    rulebook = fs.readFileSync(rulePath, 'utf-8').trim();
    console.log('📖 Loaded rulebook (data/rules.txt).');
  }
} catch (e) {}

const BASE_SYSTEM_PROMPT = (rulebook ? rulebook + '\n\n' : '') + (process.env.SYSTEM_PROMPT ||
  'You are the Game Master for a Fate\'s Edge session. Provide vivid, concise narration. Use game mechanics appropriately.') +
  '\n\nYou have a pool of Story Beats (SB). When you want to introduce a complication, write [SPEND SB N] to spend N beats. The bot will deduct them and you can narrate the complication. You may also create timers with [TIMER "name" segments "onFill message"], draw from the Deck of Consequences with [DRAW count region], or perform a Crown Spread with [CROWN region].\n\n' +
  'When a player’s action requires a roll, output [ROLL "CharacterName" Attribute+Skill DV Position]. The bot will resolve it and append the result.\n' +
  'You can set Position with [SET POSITION Dominant|Controlled|Desperate], set DV with [SET DV N], and apply resource changes with [APPLY HARM Name N], [APPLY FATIGUE Name N], [ADD BOON Name N], etc.\n' +
  'Tick timers with [TICK TIMER "name" N].';

// -------------------------------------------------------------------
// 5. Campaign state (loaded from disk)
// -------------------------------------------------------------------
let campaignState = {};

function loadCampaign() {
  const saved = campaignModule.load(ROOM_CODE);
  if (saved) {
    campaignState = saved;
    charactersModule.loadCharacters(campaignState.characters || {});
    console.log('📂 Loaded campaign state from disk.');
  } else {
    campaignState = {
      facts: {},
      summary: '',
      conversation: [],
      characters: {},
      scene: {
        location: '',
        npcs: [],
        timers: [],
        activeComplications: [],
        position: 'Controlled',
        effect: 'Standard',
        defaultDV: 3
      },
      sb: 0,
      messagesSinceLastSummary: 0,
      campaignCode: null
    };
    campaignModule.save(ROOM_CODE, campaignState);
    console.log('📂 Created new campaign state.');
  }
}

function saveCampaign() {
  campaignState.characters = charactersModule.getAll();
  campaignModule.save(ROOM_CODE, campaignState);
}

// -------------------------------------------------------------------
// 6. Campaign sync with server (pull on join, push on save)
// -------------------------------------------------------------------
async function loadCampaignFromServer() {
  if (!API_KEY) {
    console.warn('⚠️ API_KEY not set – skipping server campaign load.');
    return false;
  }

  let campaignCode = campaignState.campaignCode;
  if (!campaignCode && fs.existsSync(CAMPAIGN_CODE_FILE)) {
    try {
      campaignCode = fs.readFileSync(CAMPAIGN_CODE_FILE, 'utf-8').trim();
      campaignState.campaignCode = campaignCode;
    } catch (e) { /* ignore */ }
  }

  if (!campaignCode) {
    console.log('ℹ️ No campaign code found – starting fresh.');
    return false;
  }

  try {
    console.log(`🔄 Loading campaign ${campaignCode} from server...`);
    const data = await apiRequest('GET', ['campaigns', campaignCode]);
    if (data) {
      campaignState.facts = data.facts || {};
      campaignState.summary = data.summary || '';
      campaignState.conversation = data.conversation || [];
      campaignState.characters = data.characters || {};
      campaignState.scene = data.scene || campaignState.scene;
      campaignState.messagesSinceLastSummary = 0;
      campaignState.campaignCode = campaignCode;
      charactersModule.loadCharacters(campaignState.characters || {});
      console.log(`✅ Loaded campaign ${campaignCode} from server.`);
      return true;
    }
  } catch (e) {
    if (e.message.includes('404')) {
      console.log(`ℹ️ Campaign ${campaignCode} not found on server – starting fresh.`);
      campaignState.campaignCode = null;
    } else {
      console.warn(`⚠️ Failed to load campaign from server: ${e.message}`);
    }
  }
  return false;
}

// ---- Debounced save to server ----
let saveTimeout = null;
let savePending = false;
let saveInProgress = false;

async function saveCampaignToServer(force = false) {
  if (!API_KEY) return false;

  // If a save is already in progress, just mark it as pending and return
  if (saveInProgress) {
    savePending = true;
    return false;
  }

  // Debounce: if force is false, wait 5 seconds before actually saving
  if (!force) {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    return new Promise((resolve) => {
      saveTimeout = setTimeout(async () => {
        saveTimeout = null;
        await doSave();
        resolve(true);
      }, 5000);
    });
  } else {
    // Immediate save, clear any pending timeout
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }
    return await doSave();
  }
}

async function doSave() {
  if (saveInProgress) return false;
  saveInProgress = true;
  try {
    // Build minimal payload to avoid "PayloadTooLargeError"
    const payload = {
      summary: campaignState.summary || '',
      facts: campaignState.facts || {},
      characters: campaignState.characters || {},
      scene: campaignState.scene || {},
      // Only send last 10 messages to keep size small
      conversation: (campaignState.conversation || []).slice(-10),
      campaignCode: campaignState.campaignCode
    };
    const result = await apiRequest('POST', ['campaigns'], payload);
    if (result && result.code) {
      campaignState.campaignCode = result.code;
      try {
        fs.writeFileSync(CAMPAIGN_CODE_FILE, result.code);
      } catch (e) { /* ignore */ }
      console.log(`📤 Campaign saved to server (code: ${result.code})`);
      // If there is a pending save, trigger it now (but we'll let the debounce handle it)
      if (savePending) {
        savePending = false;
        // Start a new debounced save after this one finishes
        saveCampaignToServer(false);
      }
      return true;
    }
  } catch (e) {
    // If payload too large, log and try again with even smaller payload
    if (e.message.includes('PayloadTooLarge') || e.message.includes('request entity too large')) {
      console.warn('⚠️ Campaign payload too large – saving without conversation history.');
      try {
        const tinyPayload = {
          summary: campaignState.summary || '',
          facts: campaignState.facts || {},
          characters: campaignState.characters || {},
          scene: campaignState.scene || {},
          conversation: [],
          campaignCode: campaignState.campaignCode
        };
        const result = await apiRequest('POST', ['campaigns'], tinyPayload);
        if (result && result.code) {
          campaignState.campaignCode = result.code;
          try {
            fs.writeFileSync(CAMPAIGN_CODE_FILE, result.code);
          } catch (e) { /* ignore */ }
          console.log(`📤 Campaign saved to server (without history, code: ${result.code})`);
          return true;
        }
      } catch (e2) {
        console.warn(`⚠️ Failed to save campaign even without history: ${e2.message}`);
      }
    } else {
      console.warn(`⚠️ Failed to save campaign to server: ${e.message}`);
    }
  } finally {
    saveInProgress = false;
  }
  return false;
}

// -------------------------------------------------------------------
// 7. Sync characters from server API (full discovery + sync)
// -------------------------------------------------------------------
async function syncCharactersFromServer() {
  if (!API_KEY) {
    console.warn('⚠️ API_KEY not set – skipping character sync.');
    return;
  }

  try {
    console.log('🔄 Fetching character list from server...');
    const listData = await apiRequest('GET', ['characters']);
    if (!listData || !listData.characters) {
      console.log('ℹ️ No character data from server (empty response).');
      return;
    }

    const serverChars = listData.characters;
    const names = Object.keys(serverChars);
    if (names.length === 0) {
      console.log('ℹ️ No characters on server.');
      return;
    }

    console.log(`🔄 Syncing ${names.length} characters from server...`);
    let synced = 0;
    for (const name of names) {
      const char = charactersModule.get(name);
      const data = serverChars[name];
      if (data) {
        if (data.harm !== undefined) char.harm = data.harm;
        if (data.fatigue !== undefined) char.fatigue = data.fatigue;
        if (data.obligation !== undefined) char.obligation = data.obligation;
        if (data.boons !== undefined) char.boons = data.boons;
        if (data.leash !== undefined) char.leash = data.leash;
        if (data.corruption !== undefined) char.corruption = data.corruption;
        synced++;
      }
    }
    saveCampaign();
    // Save to server after sync (but debounced)
    await saveCampaignToServer(false);
    console.log(`✅ Synced ${synced} characters from server.`);
  } catch (e) {
    if (e.message.includes('401') || e.message.includes('API key')) {
      console.warn('⚠️ API key invalid or missing. Check API_KEY in .env');
    } else if (e.message.includes('ECONNREFUSED')) {
      console.warn('⚠️ Server not reachable. Make sure the server is running.');
    } else {
      console.warn(`⚠️ Failed to sync characters from server: ${e.message}`);
    }
  }
}

// -------------------------------------------------------------------
// 8. WebSocket and connection management
// -------------------------------------------------------------------
let ws = null;
let connected = false;
let myRole = 'player';
let reconnectTimer = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY = 30000;
let campaignLoaded = false;

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

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log(`⬇️  ${msg.type}`, JSON.stringify(msg).slice(0, 120));
      handleMessage(msg);
    } catch (e) { console.warn('⚠️  Non‑JSON message:', data.toString()); }
  });

  ws.on('close', (code, reason) => {
    connected = false;
    console.log(`🔌 Disconnected (code ${code})${reason ? `: ${reason}` : ''}`);
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
    ws.send(JSON.stringify({ type, ...data }));
    console.log(`⬆️  Sent: ${type}`);
  }
}

function sendChat(text) {
  const msg = typeof text === 'string' ? text : String(text);
  sendWS('chat-message', { text: msg, sender: BOT_NAME, timestamp: Date.now() });
}

// -------------------------------------------------------------------
// 9. API helpers (for character updates, etc.)
// -------------------------------------------------------------------
function apiRequest(method, pathSegments, body = null) {
  const url = `${CAMPAIGN_API_URL}/rooms/${ROOM_CODE}/${pathSegments.join('/')}`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY
  };
  const bodyStr = body ? JSON.stringify(body) : undefined;
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method,
      headers
    };

    const req = mod.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`API error ${res.statusCode}: ${json.error || data}`));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// -------------------------------------------------------------------
// 10. Summarisation (delegated to campaign module)
// -------------------------------------------------------------------
async function summariseStory() {
  if (!driver) return;
  const newSummary = await campaignModule.summarise(campaignState, driver, SUMMARISE_EVERY);
  if (newSummary) {
    campaignState.summary = newSummary;
    saveCampaign();
    // Save to server after summarisation (debounced)
    await saveCampaignToServer(false);
  }
}

// -------------------------------------------------------------------
// 11. Message handler
// -------------------------------------------------------------------
function handleMessage(msg) {
  if (msg.type === 'state-updated') return;

  if (msg.type === 'handshake_ack') {
    myRole = msg.clientRole || msg.role || 'player';
    console.log(`🤝 Handshake OK. Role: ${myRole}`);
    if (myRole !== 'gm') {
      console.log('📢 I am not the GM – will request GM role.');
      sendWS('request_gm');
    } else {
      console.log('👑 I am the Game Master!');
      sendChat('*The AI Game Master has joined.*');

      (async () => {
        const loaded = await loadCampaignFromServer();
        await syncCharactersFromServer();
        if (!campaignState.campaignCode) {
          await saveCampaignToServer(false);
        }
        campaignLoaded = true;
        console.log('📂 Campaign sync complete.');
      })();
    }
    return;
  }

  if (msg.type === 'gm_vote_request') {
    if (myRole === 'gm') { console.log(`🗳️  Approving GM request from ${msg.requesterName}`); sendWS('approve_gm', { targetId: msg.requesterId }); }
    return;
  }

  if (msg.type === 'gm_role_update') {
    myRole = msg.role; console.log(`🔁 Role changed: ${myRole} → ${myRole}`); if (myRole === 'gm') sendChat('*I am now the Game Master.*');
    return;
  }

  if (msg.type === 'presence') { console.debug(`👥 ${msg.clients?.length || 0} clients in room`); return; }

  let text = '', sender = 'Unknown';
  if (msg.type === 'chat-message' && msg.message) { text = msg.message.text || ''; sender = msg.message.sender || 'Unknown'; }
  else if (msg.type === 'chat_message' && msg.value) { text = msg.value.text || ''; sender = msg.value.sender || 'Unknown'; }
  else if (msg.type === 'chat-message') { text = msg.text || ''; sender = msg.sender || 'Unknown'; }
  if (!text && !sender) return;

  console.log(`💬 [${sender}] ${text}`);

  if (sender === BOT_NAME) return;

  if (msg.type === 'roll-result') {
    const sbGain = msg.storyBeats || 0;
    if (sbGain > 0) {
      campaignState.sb = (campaignState.sb || 0) + sbGain;
      console.log(`📈 +${sbGain} Story Beats (total: ${campaignState.sb})`);
      saveCampaign();
    }
    const rollText = `${sender} rolled ${msg.expr || 'dice'} = ${msg.total}`;
    campaignState.conversation.push({ role: 'user', content: rollText });
    if (campaignState.conversation.length > MAX_HISTORY * 2) campaignState.conversation.splice(0, campaignState.conversation.length - MAX_HISTORY);
    saveCampaign();
    // Save to server after roll-result (debounced)
    saveCampaignToServer(false);
    return;
  }

  // ---- Handle player commands (!gm ...) ----
  if (text.startsWith('!gm')) {
    (async () => {
      try {
        const response = await commandHandler.handleBotCommand(sender, text, {
          campaignState,
          characters: charactersModule,
          dice: diceModule,
          timers: timersModule,
          deck: deckModule,
          ws,
          sendChat,
          saveCampaign,
          apiRequest,
          myRole
        });
        if (response && typeof response === 'string') {
          sendChat(response);
        } else if (response) {
          sendChat(String(response));
        }
        // Command may have changed state, so save to server (debounced)
        await saveCampaignToServer(false);
      } catch (err) {
        console.error('❌ Command handler error:', err.message);
        sendChat('*Error processing command.*');
      }
    })();
    return;
  }

  // ---- Only process chat messages from players (not system messages) ----
  // But we've already filtered system messages (presence, etc.) above.
  // Also skip if the message is from the bot itself.
  if (sender === BOT_NAME) return;

  // ---- GM bot responds to player chat ----
  if (myRole !== 'gm') return;

  campaignState.conversation = campaignState.conversation || [];
  campaignState.conversation.push({ role: 'user', content: `${sender}: ${text}` });
  if (campaignState.conversation.length > MAX_HISTORY * 2) campaignState.conversation.splice(0, campaignState.conversation.length - MAX_HISTORY);
  campaignState.messagesSinceLastSummary = (campaignState.messagesSinceLastSummary || 0) + 1;

  if (campaignState.messagesSinceLastSummary >= SUMMARISE_EVERY && campaignState.conversation.length >= SUMMARISE_EVERY) {
    summariseStory().catch(() => {});
    campaignState.messagesSinceLastSummary = 0;
  }

  (async () => {
    try {
      let fullSystemPrompt = BASE_SYSTEM_PROMPT;
      if (campaignState.summary) fullSystemPrompt += '\n\nCampaign Summary:\n' + campaignState.summary;
      const factsText = campaignModule.factsToText(campaignState.facts);
      if (factsText) fullSystemPrompt += '\n\nCurrent World Facts:\n' + factsText;
      fullSystemPrompt += `\n\nStory Beats available: ${campaignState.sb || 0}.`;

      const reply = await driver.generateResponse({
        systemPrompt: fullSystemPrompt,
        messages: campaignState.conversation.slice(-MAX_HISTORY)
      });

      let clean = reply.trim();

      clean = commandHandler.processSpecialTags(clean, {
        campaignState,
        characters: charactersModule,
        dice: diceModule,
        timers: timersModule,
        deck: deckModule,
        ws,
        sendChat,
        saveCampaign,
        apiRequest,
        myRole
      });

      if (clean) {
        sendChat(clean);
        campaignState.conversation.push({ role: 'assistant', content: clean });
        if (campaignState.conversation.length > MAX_HISTORY * 2) campaignState.conversation.splice(0, campaignState.conversation.length - MAX_HISTORY);
        saveCampaign();
        // Save to server after GM response (debounced)
        await saveCampaignToServer(false);
      }
    } catch (err) {
      console.error('❌ LLM error:', err.message);
      sendChat('*The story pauses. (AI error)*');
    }
  })();
}

// -------------------------------------------------------------------
// 12. Startup
// -------------------------------------------------------------------
(async function main() {
  console.log('🚀 AI GM Bot starting…');
  console.log(`   WS: ${WS_URL}   Room: ${ROOM_CODE}   Name: ${BOT_NAME}`);

  loadCampaign();

  await worldModule.loadWorldFacts((key, value) => {
    campaignState.facts[key] = value;
  });
  saveCampaign();

  if (driver && typeof driver.initialize === 'function') {
    try { await driver.initialize(); } catch (e) { console.error('Driver init failed:', e.message); }
  }

  connect();
})();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down…');
  if (campaignState) {
    saveCampaign();
    // Force immediate save on shutdown
    (async () => {
      await saveCampaignToServer(true);
      if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'Shutdown');
      setTimeout(() => process.exit(0), 1000);
    })();
  } else {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close(1000, 'Shutdown');
    setTimeout(() => process.exit(0), 1000);
  }
});