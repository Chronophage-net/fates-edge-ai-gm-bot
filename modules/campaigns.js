const fs = require('fs');
const path = require('path');
const CAMPAIGNS_DIR = path.resolve(process.cwd(), 'campaigns');

function getFilePath(roomCode) {
  return path.join(CAMPAIGNS_DIR, `${roomCode.toUpperCase()}.json`);
}

function load(roomCode) {
  const file = getFilePath(roomCode);
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  } catch (e) {
    console.error(`❌ Failed to load campaign ${roomCode}:`, e.message);
  }
  return null;
}

function save(roomCode, state) {
  const file = getFilePath(roomCode);
  try {
    if (!fs.existsSync(CAMPAIGNS_DIR)) {
      fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error(`❌ Failed to save campaign ${roomCode}:`, e.message);
  }
}

function factsToText(facts) {
  if (!facts || Object.keys(facts).length === 0) return '';
  return Object.entries(facts)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
}

async function summarise(state, driver, summariseEvery) {
  if (!driver) return null;
  const existing = state.summary ? `Previous summary:\n${state.summary}\n\n` : '';
  const recent = (state.conversation || [])
    .slice(-summariseEvery)
    .map(m => `${m.role}: ${m.content}`)
    .join('\n');
  const prompt = existing + recent + '\n\nWrite a concise campaign summary (max 200 words) including key characters, locations, and unresolved plot threads.';
  try {
    const fresh = await driver.generateResponse({
      systemPrompt: 'You are a summariser. Output only the summary text.',
      messages: [{ role: 'user', content: prompt }]
    });
    return fresh.trim();
  } catch (e) {
    console.error('Summarisation failed:', e.message);
    return null;
  }
}

// New: get scene state
function getScene(state) {
  if (!state.scene) {
    state.scene = {
      location: '',
      npcs: [],
      timers: [],
      activeComplications: [],
      position: 'Controlled',
      effect: 'Standard',
      defaultDV: 3
    };
  }
  return state.scene;
}

module.exports = { load, save, factsToText, summarise, getScene };
