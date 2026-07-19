const fs = require('fs');
const path = require('path');
const DATA_DIR = path.resolve(process.cwd(), 'data');

function loadJSON(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (e) {
    console.error(`❌ Failed to load ${filePath}:`, e.message);
  }
  return null;
}

async function loadWorldFacts(factUpdater) {
  // Load all JSON files in data/
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const data = loadJSON(path.join(DATA_DIR, file));
    if (data) {
      const key = path.basename(file, '.json');
      // If data is an object, store as JSON string; if array, store as array string.
      factUpdater(`file_${key}`, JSON.stringify(data));
    }
  }

  // Optionally, try to fetch from server API (if available)
  // This is a placeholder; the main bot may provide an API base URL.
  // We'll skip for now.
}

module.exports = { loadWorldFacts };
