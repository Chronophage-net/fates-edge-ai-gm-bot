#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const WebSocket = require('ws');
const characters = require('./modules/characters');

const commandHandler = require('./modules/commands');
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
    console.log(`🤖 Loaded DeepSeek driver (model: ${process.env.DEEPSEEK_MODEL || 'deepseek-chat'})`);
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

const API_BASE = getApiBaseUrl(WS_URL);
console.log(`🌐 API base: ${API_BASE}`);

let orchestrator = null;
let worldManager = null;

// -------------------------------------------------------------------
// 4. Base system prompt (rules will be prepended later)
// -------------------------------------------------------------------
const BASE_SYSTEM_PROMPT = (process.env.SYSTEM_PROMPT ||
  'You are the Game Master for a Fate\'s Edge session. Provide vivid, concise narration. Use game mechanics appropriately.') +
  '\n\nYou have a pool of Story Beats (SB). When you want to introduce a complication, write [SPEND SB N] to spend N beats. The bot will deduct them and you can narrate the complication. You may also create timers with [TIMER "name" segments "onFill message"], draw from the Deck of Consequences with [DRAW count region], or perform a Crown Spread with [CROWN region].\n\n' +
  'When a player’s action requires a roll, output [ROLL "CharacterName" Attribute+Skill DV Position]. The bot will resolve it and append the result.\n' +
  'You can set Position with [SET POSITION Dominant|Controlled|Desperate], set DV with [SET DV N], and apply resource changes with [APPLY HARM Name N], [APPLY FATIGUE Name N], [ADD BOON Name N], etc.\n' +
  'Tick timers with [TICK TIMER "name" N].' +
  '\n\nWhen you want an NPC to cast a spell, use the tag:\n' +
  '[NPC CAST "Spell Name" TargetName]\n' +
  'The bot will deduct Story Beats (SB) from the GM\'s pool and resolve the effect.\n' +
  'Spell names must match entries in the spellbook (e.g., "Ember Dart", "Hush").\n' +
  'Target can be a player character name or a generic target like "the guard".\n\n';

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
  const data = await response.json();
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
// 9. Message handler
// -------------------------------------------------------------------
async function handleMessage(msg) {
  if (msg.type === 'state-updated') return;

  if (msg.type === 'crown-spread') {
    processCrownSpread(msg);
    return;
  }

  if (msg.type === 'presence') {
    const clients = msg.clients || [];
    playerCount = clients.length;
    console.debug(`👥 ${playerCount} clients in room`);
    if (!startupMessageSent && connected && myRole === 'gm' && orchestrator) {
      scheduleStartupMessage();
    }
    return;
  }

  if (msg.type === 'handshake_ack') {
    myRole = msg.clientRole || msg.role || 'player';
    console.log(`🤝 Handshake OK. Role: ${myRole}`);
    if (myRole !== 'gm') {
      console.log('📢 I am not the GM – will request GM role.');
      sendWS('request_gm');
    } else {
      console.log('👑 I am the Game Master!');
      if (!orchestrator) await initGame();
      await orchestrator.campaign.save();
      console.log('📂 Campaign sync complete.');
      scheduleStartupMessage();
      setTimeout(() => {
        if (!campaignSeeded && orchestrator) {
          seedCampaign();
        }
      }, 5000);
    }
    return;
  }

  if (msg.type === 'gm_vote_request') {
    if (myRole === 'gm') { console.log(`🗳️  Approving GM request from ${msg.requesterName}`); sendWS('approve_gm', { targetId: msg.requesterId }); }
    return;
  }

  if (msg.type === 'gm_role_update') {
    myRole = msg.role; console.log(`🔁 Role changed: ${myRole}`); if (myRole === 'gm') sendChat('*I am now the Game Master.*');
    return;
  }

  if (msg.type === 'player-joined') {
    const newPlayerName = msg.clientName || 'Player';
    sendChat(`*Welcome, ${newPlayerName}! I am the Game Master. Type !gm help to see commands, or !gm etiquette for game etiquette. Let's begin.*`);
    return;
  }

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

  if (text.startsWith('!gm')) {
    try {
      const response = await commandHandler.handleBotCommand(sender, text, {
          orchestrator,
          charactersModule: characters,
          sendChat,
          ws,
          apiRequest,
          myRole,
          seedCampaign: () => seedCampaign()
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

  // Add facts
  const factsText = orchestrator.campaign.state.facts ? Object.entries(orchestrator.campaign.state.facts).map(([k,v]) => `- ${k}: ${v}`).join('\n') : '';
  if (factsText) fullSystemPrompt += '\n\nCurrent World Facts:\n' + factsText;

  // ADD: Character sheets
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

  try {
    const reply = await driver.generateResponse({
      systemPrompt: fullSystemPrompt,
      messages: conv.slice(-MAX_HISTORY)
    });

    let clean = reply.trim();

    clean = commandHandler.processSpecialTags(clean, {
        orchestrator,
        charactersModule: characters,
        sendChat,
        ws,
        apiRequest,
        myRole
    });

    if (clean) {
      sendChat(clean);
      conv.push({ role: 'assistant', content: clean });
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
// 10. Summarisation
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
// 11. Startup Message Scheduler
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