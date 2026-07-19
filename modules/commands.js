const diceModule = require('./dice');
const timersModule = require('./timers');
const charactersModule = require('./characters');

function parseArgs(text) {
  const parts = text.split(/\s+/);
  const cmd = parts[1]?.toLowerCase();
  const args = parts.slice(2);
  return { cmd, args };
}

// Helper to ensure character exists on server
async function ensureCharacterOnServer(name, context) {
  try {
    const data = await context.apiRequest('GET', ['characters', encodeURIComponent(name)]);
    if (data && typeof data === 'object' && data.harm !== undefined) {
      return true;
    }
  } catch (e) {
    if (!e.message.includes('404')) {
      console.warn(`Failed to check character ${name} on server: ${e.message}`);
      return false;
    }
  }
  try {
    const updates = {
      harm: 0,
      fatigue: 0,
      obligation: 0,
      boons: 0,
      leash: 0,
      corruption: 0
    };
    await context.apiRequest('POST', ['characters', 'update'], { updates: { [name]: updates } });
    console.log(`✅ Created character ${name} on server.`);
    return true;
  } catch (e) {
    console.warn(`Failed to create character ${name} on server: ${e.message}`);
    return false;
  }
}

async function handleBotCommand(sender, text, context) {
  const { cmd, args } = parseArgs(text);

  if (cmd === 'help') {
    return `Available commands: 
!gm help - this list
!gm create <name> - create a new character (default stats)
!gm status [name] - show character stats (list all if no name)
!gm dice XdY - roll generic dice
!gm roll "Name" Attribute+Skill DV Position - roll Fate's Edge pool
!gm harm/fatigue/boons/obligation/corruption/leash <name> <amount> [armorStep] - change resource
!gm setattr <name> <attribute> <value> - set attribute (local only)
!gm setskill <name> <skill> <value> - set skill (local only)
!gm addtalent <name> <talent> - add a talent
!gm bond <name> <target> "<description>" - add a bond
!gm complication <name> "<description>" - add a complication
!gm asset <name> add/remove <asset name> - manage assets
!gm follower <name> add/remove <follower name> [cap] - manage followers
!gm timer add/tick/remove <name> [segments] [onFill] - manage timers
!gm fact <key> <value> - update a fact
!gm sync - sync existing characters from server
!gm discover - discover and sync all characters from server
!gm export-characters - show global character roster (all rooms)
!gm sync-all - sync characters from all rooms into local campaign
!gm room-state - show current room state (scene, timers, etc.)
!gm upload - upload campaign
!gm load <code> - load campaign
!gm sb - show Story Beats
!gm position set <Dominant|Controlled|Desperate> - set scene position
!gm dv set <number> - set default DV`;
  }

  // Create command
  if (cmd === 'create') {
    const name = args[0];
    if (!name) return 'Usage: !gm create <name>';
    const existing = charactersModule.get(name);
    if (existing && Object.keys(existing.attributes).some(k => existing.attributes[k] !== undefined)) {
      return `Character "${name}" already exists locally. Use !gm status ${name} to see stats.`;
    }
    const char = charactersModule.get(name);
    char.attributes = { Body: 2, Wits: 2, Spirit: 2, Presence: 2 };
    char.skills = {
      Melee: 0, Ranged: 0, Unarmed: 0,
      Athletics: 0, Stealth: 0, Endurance: 0, Craft: 0,
      Sway: 0, Deception: 0, Subterfuge: 0, Performance: 0, Insight: 0,
      Lore: 0, Investigation: 0, Medicine: 0,
      Arcana: 0
    };
    char.talents = [];
    char.bonds = [];
    char.complications = [];
    char.harm = 0;
    char.fatigue = 0;
    char.boons = 0;
    char.obligation = 0;
    char.corruption = 0;
    char.leash = 0;
    char.assets = [];
    char.followers = [];
    char.tier = 1;
    char.xp = 0;
    context.saveCampaign();
    await ensureCharacterOnServer(name, context);
    return `Created character "${name}" with default stats. Use !gm setattr to customize.`;
  }

  // Status
  if (cmd === 'status') {
    const allChars = charactersModule.getAll();
    const names = Object.keys(allChars);
    if (names.length === 0) {
      return 'No characters found. Use !gm create <name> to create one.';
    }
    if (args.length === 0) {
      const lines = names.map(name => {
        const char = allChars[name];
        return `**${name}** (Tier ${char.tier || 1}) – Harm: ${char.harm}, Fatigue: ${char.fatigue}, Boons: ${char.boons}, Obligation: ${char.obligation}`;
      });
      return 'Characters:\n' + lines.join('\n');
    } else {
      const name = args.join(' ');
      const char = charactersModule.get(name);
      return `${name} → Harm: ${char.harm}, Fatigue: ${char.fatigue}, Boons: ${char.boons}, Obligation: ${char.obligation}, Corruption: ${char.corruption}, Leash: ${char.leash}` +
        `\nAttributes: ${JSON.stringify(char.attributes)}` +
        `\nSkills: ${JSON.stringify(char.skills)}` +
        `\nTalents: ${char.talents.join(', ') || 'None'}` +
        `\nBonds: ${char.bonds.map(b => `${b.target} (${b.description})`).join(', ') || 'None'}` +
        `\nComplications: ${char.complications.join(', ') || 'None'}` +
        `\nAssets: ${char.assets.join(', ') || 'None'}` +
        `\nFollowers: ${char.followers.map(f => `${f.name} (Cap ${f.cap}, Loyalty: ${f.loyalty}, Fitness: ${f.fitness})`).join(', ') || 'None'}`;
    }
  }

  // Dice rolling
  if (cmd === 'dice' && args.length > 0) {
    const formula = args[0];
    const match = formula.match(/^(\d+)d(\d+)$/i);
    if (match) {
      const count = parseInt(match[1]), sides = parseInt(match[2]);
      if (sides !== 10) {
        const rolls = [];
        let total = 0;
        for (let i = 0; i < count; i++) {
          const r = Math.floor(Math.random() * sides) + 1;
          rolls.push(r);
          total += r;
        }
        return `${sender} requested a roll: ${formula} → [${rolls.join(', ')}] = ${total}`;
      } else {
        const result = diceModule.rollDice(count);
        const outcome = diceModule.determineOutcome(result.successes, 3, result.sb);
        return `🎲 ${sender} rolled ${count}d10 → [${result.results.join(', ')}] → ${result.successes} successes, ${result.sb} SB. ${outcome.outcome}`;
      }
    }
    return 'Usage: !gm dice 2d6  (or 3d10 for Fate\'s Edge pool)';
  }

  // Roll with Position and DV
  if (cmd === 'roll' && args.length >= 4) {
    const name = args[0];
    const poolExpr = args[1];
    const dv = parseInt(args[2]);
    const position = args[3];
    const diceCount = charactersModule.getPool(name, poolExpr);
    if (diceCount === 0) return `Could not resolve dice pool for ${name} with expression ${poolExpr}.`;
    let result = diceModule.rollDice(diceCount);
    result = diceModule.applyPosition(result, position);
    const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position);
    const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
    if (outcome.boonGain > 0) {
      charactersModule.applyDelta(name, 'boons', outcome.boonGain, context.saveCampaign);
      try {
        await context.apiRequest('POST', ['characters', encodeURIComponent(name), 'boons'], { delta: outcome.boonGain });
      } catch (e) { /* ignore */ }
    }
    context.campaignState.sb = (context.campaignState.sb || 0) + result.sb;
    context.saveCampaign();
    return formatted;
  }

  // Resource commands (GM only)
  if (context.myRole !== 'gm') {
    return 'Only the Game Master can run resource commands.';
  }

  // harm/fatigue/boons/obligation/corruption/leash
  if (['harm', 'fatigue', 'boons', 'obligation', 'corruption', 'leash'].includes(cmd)) {
    const name = args[0];
    const amount = parseInt(args[1]);
    if (!name || isNaN(amount)) return `Usage: !gm ${cmd} <name> <amount> [armorStep for harm]`;
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    let result = '';
    if (cmd === 'harm') {
      const armorStep = args[2] ? parseInt(args[2]) : 1;
      diceModule.applyHarmAndFatigue(char, amount, armorStep, context.saveCampaign);
      result = `${name} took ${amount} Harm (armor step ${armorStep}). New Harm: ${char.harm}, Fatigue: ${char.fatigue}`;
      try {
        await context.apiRequest('POST', ['characters', encodeURIComponent(name), 'harm'], { delta: amount });
      } catch (e) { /* ignore */ }
    } else {
      charactersModule.applyDelta(name, cmd, amount, context.saveCampaign);
      result = `${name}'s ${cmd} changed by ${amount >= 0 ? '+' : ''}${amount} → now ${char[cmd]}`;
      if (['fatigue', 'boons', 'obligation'].includes(cmd)) {
        try {
          await context.apiRequest('POST', ['characters', encodeURIComponent(name), cmd], { delta: amount });
        } catch (e) { /* ignore */ }
      }
    }
    return result;
  }

  // Discover command
  if (cmd === 'discover') {
    if (context.myRole !== 'gm') return 'Only the GM can discover characters.';
    try {
      const listData = await context.apiRequest('GET', ['characters']);
      if (!listData || !listData.characters) {
        return 'No character data from server.';
      }
      const serverChars = listData.characters;
      const names = Object.keys(serverChars);
      if (names.length === 0) return 'No characters on server.';
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
      context.saveCampaign();
      return `Discovered and synced ${synced} characters from server.`;
    } catch (e) {
      return `Discovery failed: ${e.message}`;
    }
  }

  // Sync command (existing)
  if (cmd === 'sync') {
    const names = Object.keys(charactersModule.getAll());
    if (names.length === 0) return 'No characters to sync.';
    let synced = 0;
    for (const name of names) {
      try {
        const data = await context.apiRequest('GET', ['characters', encodeURIComponent(name)]);
        if (data && typeof data === 'object') {
          const char = charactersModule.get(name);
          if (data.harm !== undefined) char.harm = data.harm;
          if (data.fatigue !== undefined) char.fatigue = data.fatigue;
          if (data.obligation !== undefined) char.obligation = data.obligation;
          if (data.boons !== undefined) char.boons = data.boons;
          if (data.leash !== undefined) char.leash = data.leash;
          if (data.corruption !== undefined) char.corruption = data.corruption;
          synced++;
        }
      } catch (e) {
        console.warn(`Failed to sync ${name}: ${e.message}`);
      }
    }
    context.saveCampaign();
    return `Synced ${synced} characters from server.`;
  }

  // NEW: Export global characters
  if (cmd === 'export-characters') {
    if (context.myRole !== 'gm') return 'Only the GM can export characters.';
    try {
      const data = await context.apiRequest('GET', ['/api/characters/export']);
      if (!data || !data.characters) return 'No character data found.';
      let result = '🌍 **Global Character Roster:**\n';
      for (const [room, chars] of Object.entries(data.characters)) {
        const count = Object.keys(chars).length;
        result += `\n📁 **${room}**: ${count} character${count > 1 ? 's' : ''}`;
        const top = Object.entries(chars).slice(0, 5);
        for (const [name, stats] of top) {
          result += `\n  - **${name}**: H${stats.harm || 0} F${stats.fatigue || 0} B${stats.boons || 0}`;
        }
        if (count > 5) result += `\n  - ... and ${count - 5} more`;
      }
      return result;
    } catch (e) {
      return `Export failed: ${e.message}`;
    }
  }

  // NEW: Sync all characters from all rooms
  if (cmd === 'sync-all') {
    if (context.myRole !== 'gm') return 'Only the GM can sync all rooms.';
    try {
      const data = await context.apiRequest('GET', ['/api/characters/export']);
      if (!data || !data.characters) return 'No character data found.';
      let total = 0;
      for (const [room, chars] of Object.entries(data.characters)) {
        for (const [name, stats] of Object.entries(chars)) {
          const char = charactersModule.get(name);
          if (stats.harm !== undefined) char.harm = stats.harm;
          if (stats.fatigue !== undefined) char.fatigue = stats.fatigue;
          if (stats.obligation !== undefined) char.obligation = stats.obligation;
          if (stats.boons !== undefined) char.boons = stats.boons;
          if (stats.leash !== undefined) char.leash = stats.leash;
          if (stats.corruption !== undefined) char.corruption = stats.corruption;
          total++;
        }
      }
      context.saveCampaign();
      return `Synced ${total} characters from all rooms.`;
    } catch (e) {
      return `Sync-all failed: ${e.message}`;
    }
  }

  // NEW: Room state
  if (cmd === 'room-state') {
    if (context.myRole !== 'gm') return 'Only the GM can view room state.';
    try {
      const data = await context.apiRequest('GET', ['state']);
      if (!data) return 'No room state data.';
      let result = '🏠 **Room State:**\n';
      result += `Location: ${data.location || 'unknown'}\n`;
      result += `Position: ${data.position || 'Controlled'}\n`;
      result += `Effect: ${data.effect || 'Standard'}\n`;
      result += `Default DV: ${data.defaultDV || 3}\n`;
      if (data.timers && data.timers.length > 0) {
        result += `Timers:\n`;
        for (const timer of data.timers) {
          result += `  - ${timer.name}: ${timer.current}/${timer.max}\n`;
        }
      } else {
        result += 'Timers: None\n';
      }
      if (data.npcs && data.npcs.length > 0) {
        result += `NPCs: ${data.npcs.join(', ')}\n`;
      }
      return result;
    } catch (e) {
      return `Room state failed: ${e.message}`;
    }
  }

  // setattr
  if (cmd === 'setattr') {
    const name = args[0];
    const attr = args[1];
    const value = parseInt(args[2]);
    if (!name || !attr || isNaN(value)) return 'Usage: !gm setattr <name> <attribute> <value>';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    char.attributes[attr] = value;
    context.saveCampaign();
    return `${name}'s ${attr} set to ${value}`;
  }

  // setskill
  if (cmd === 'setskill') {
    const name = args[0];
    const skill = args[1];
    const value = parseInt(args[2]);
    if (!name || !skill || isNaN(value)) return 'Usage: !gm setskill <name> <skill> <value>';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    char.skills[skill] = value;
    context.saveCampaign();
    return `${name}'s ${skill} set to ${value}`;
  }

  // addtalent, bond, complication, asset, follower, timer, fact, sb, position, dv, upload, load
  // ... (keep the rest of the commands unchanged from the previous version)
  // For brevity, I'll include them here as they were, but you can copy from the earlier full version.
  // The rest of the commands (addtalent, bond, complication, asset, follower, timer, fact, sb, position, dv, upload, load)
  // remain the same. I'll include them below.

  // addtalent
  if (cmd === 'addtalent') {
    const name = args[0];
    const talent = args.slice(1).join(' ');
    if (!name || !talent) return 'Usage: !gm addtalent <name> <talent name>';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    char.talents.push(talent);
    context.saveCampaign();
    return `Added talent "${talent}" to ${name}`;
  }

  // bond
  if (cmd === 'bond') {
    const name = args[0];
    const target = args[1];
    const desc = args.slice(2).join(' ');
    if (!name || !target || !desc) return 'Usage: !gm bond <name> <target> "<description>"';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    char.bonds.push({ target, description: desc });
    context.saveCampaign();
    return `Added bond: ${name} → ${target} (${desc})`;
  }

  // complication
  if (cmd === 'complication') {
    const name = args[0];
    const desc = args.slice(1).join(' ');
    if (!name || !desc) return 'Usage: !gm complication <name> "<description>"';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    char.complications.push(desc);
    context.saveCampaign();
    return `Added complication to ${name}: ${desc}`;
  }

  // asset
  if (cmd === 'asset') {
    const name = args[0];
    const action = args[1];
    const assetName = args.slice(2).join(' ');
    if (!name || !action || !assetName) return 'Usage: !gm asset <name> add/remove <asset name>';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    if (action === 'add') {
      char.assets.push(assetName);
      context.saveCampaign();
      return `Added asset "${assetName}" to ${name}`;
    } else if (action === 'remove') {
      char.assets = char.assets.filter(a => a !== assetName);
      context.saveCampaign();
      return `Removed asset "${assetName}" from ${name}`;
    } else {
      return 'Invalid action. Use add or remove.';
    }
  }

  // follower
  if (cmd === 'follower') {
    const name = args[0];
    const action = args[1];
    const followerName = args[2];
    const cap = parseInt(args[3]) || 1;
    if (!name || !action || !followerName) return 'Usage: !gm follower <name> add/remove <follower name> [cap]';
    await ensureCharacterOnServer(name, context);
    const char = charactersModule.get(name);
    if (action === 'add') {
      char.followers.push({ name: followerName, cap, loyalty: 'Faithful', fitness: 'Ready' });
      context.saveCampaign();
      return `Added follower "${followerName}" (Cap ${cap}) to ${name}`;
    } else if (action === 'remove') {
      char.followers = char.followers.filter(f => f.name !== followerName);
      context.saveCampaign();
      return `Removed follower "${followerName}" from ${name}`;
    } else {
      return 'Invalid action. Use add or remove.';
    }
  }

  // Timer management
  if (cmd === 'timer') {
    const sub = args[0];
    if (sub === 'add') {
      const name = args[1];
      const max = parseInt(args[2]);
      const onFill = args.slice(3).join(' ') || 'Timer fills.';
      if (!name || isNaN(max)) return 'Usage: !gm timer add <name> <segments> [onFill]';
      timersModule.addTimer(context.campaignState, name, max, onFill);
      context.saveCampaign();
      return `Timer "${name}" added with ${max} segments.`;
    } else if (sub === 'tick') {
      const name = args[1];
      const ticks = parseInt(args[2]) || 1;
      if (!name) return 'Usage: !gm timer tick <name> [ticks]';
      const filled = timersModule.tickTimer(context.campaignState, name, ticks);
      if (filled) {
        const event = timersModule.resolveTimer(context.campaignState, name);
        context.saveCampaign();
        return `Timer "${name}" filled! ${event}`;
      } else {
        const timer = context.campaignState.scene.timers.find(t => t.name === name);
        context.saveCampaign();
        return `Timer "${name}" advanced to ${timer.current}/${timer.max}`;
      }
    } else if (sub === 'remove') {
      const name = args[1];
      if (!name) return 'Usage: !gm timer remove <name>';
      const idx = context.campaignState.scene.timers.findIndex(t => t.name === name);
      if (idx !== -1) {
        context.campaignState.scene.timers.splice(idx, 1);
        context.saveCampaign();
        return `Timer "${name}" removed.`;
      } else {
        return `Timer "${name}" not found.`;
      }
    } else {
      return 'Usage: !gm timer add/tick/remove <name> [segments] [onFill]';
    }
  }

  // Fact
  if (cmd === 'fact') {
    const key = args[0];
    const value = args.slice(1).join(' ');
    if (!key || !value) return 'Usage: !gm fact <key> <value>';
    context.campaignState.facts[key] = value;
    context.saveCampaign();
    return `Fact updated: ${key} = ${value}`;
  }

  // SB
  if (cmd === 'sb') {
    return `Current Story Beat pool: ${context.campaignState.sb || 0}`;
  }

  // Position
  if (cmd === 'position' && args[0] === 'set') {
    const pos = args[1];
    if (!['Dominant', 'Controlled', 'Desperate'].includes(pos)) return 'Invalid position. Use Dominant, Controlled, or Desperate.';
    context.campaignState.scene.position = pos;
    context.saveCampaign();
    return `Scene Position set to ${pos}.`;
  }

  // DV
  if (cmd === 'dv' && args[0] === 'set') {
    const dv = parseInt(args[1]);
    if (isNaN(dv)) return 'Usage: !gm dv set <number>';
    context.campaignState.scene.defaultDV = dv;
    context.saveCampaign();
    return `Default DV set to ${dv}.`;
  }

  // Upload and Load
  if (cmd === 'upload') {
    if (context.apiRequest) {
      try {
        const data = await context.apiRequest('POST', ['campaigns'], context.campaignState);
        return `Campaign uploaded! Share code: ${data.code}`;
      } catch (e) {
        return `Upload failed: ${e.message}`;
      }
    } else {
      return 'Upload not supported.';
    }
  }
  if (cmd === 'load') {
    const code = args[0];
    if (!code) return 'Usage: !gm load <code>';
    if (context.apiRequest) {
      try {
        const data = await context.apiRequest('GET', ['campaigns', code]);
        Object.assign(context.campaignState, data);
        context.saveCampaign();
        return `Campaign ${code} loaded!`;
      } catch (e) {
        return `Load failed: ${e.message}`;
      }
    } else {
      return 'Load not supported.';
    }
  }

  return 'Unknown command. Try !gm help';
}

function processSpecialTags(text, context) {
  let output = text;

  // [ROLL ...]
  const rollRegex = /\[ROLL "([^"]+)" ([A-Za-z\+]+) DV(\d+) ([A-Za-z]+)\]/gi;
  let match;
  while ((match = rollRegex.exec(text)) !== null) {
    const name = match[1];
    const poolExpr = match[2];
    const dv = parseInt(match[3]);
    const position = match[4];
    const diceCount = charactersModule.getPool(name, poolExpr);
    if (diceCount === 0) {
      output = output.replace(match[0], `*(Could not resolve dice pool for ${name}.)*`);
      continue;
    }
    let result = diceModule.rollDice(diceCount);
    result = diceModule.applyPosition(result, position);
    const formatted = diceModule.formatRollResult(name, poolExpr, diceCount, result, dv, position);
    const outcome = diceModule.determineOutcome(result.successes, dv, result.sb);
    if (outcome.boonGain > 0) {
      charactersModule.applyDelta(name, 'boons', outcome.boonGain, context.saveCampaign);
    }
    context.campaignState.sb = (context.campaignState.sb || 0) + result.sb;
    context.saveCampaign();
    output = output.replace(match[0], formatted);
  }

  // [SET POSITION ...]
  const posRegex = /\[SET POSITION ([A-Za-z]+)\]/gi;
  while ((match = posRegex.exec(text)) !== null) {
    const pos = match[1];
    context.campaignState.scene.position = pos;
    context.saveCampaign();
    output = output.replace(match[0], `*(Position set to ${pos})*`);
  }

  // [SET DV ...]
  const dvRegex = /\[SET DV (\d+)\]/gi;
  while ((match = dvRegex.exec(text)) !== null) {
    const dv = parseInt(match[1]);
    context.campaignState.scene.defaultDV = dv;
    context.saveCampaign();
    output = output.replace(match[0], `*(Default DV set to ${dv})*`);
  }

  // [APPLY ...]
  const applyRegex = /\[APPLY (HARM|FATIGUE|BOON|OBLIGATION|CORRUPTION|LEASH) ([A-Za-z0-9_]+) (\d+)(?:\s+(\d+))?\]/gi;
  while ((match = applyRegex.exec(text)) !== null) {
    const type = match[1].toLowerCase();
    const name = match[2];
    const amount = parseInt(match[3]);
    const extra = match[4] ? parseInt(match[4]) : null;
    if (type === 'harm') {
      const armorStep = extra || 1;
      const char = charactersModule.get(name);
      diceModule.applyHarmAndFatigue(char, amount, armorStep, context.saveCampaign);
      output = output.replace(match[0], `*(${name} took ${amount} Harm, armor step ${armorStep})*`);
    } else {
      charactersModule.applyDelta(name, type, amount, context.saveCampaign);
      output = output.replace(match[0], `*(${name} ${type} ${amount >= 0 ? '+' : ''}${amount})*`);
    }
  }

  // [TICK TIMER ...]
  const tickRegex = /\[TICK TIMER "([^"]+)" (\d+)\]/gi;
  while ((match = tickRegex.exec(text)) !== null) {
    const name = match[1];
    const ticks = parseInt(match[2]);
    const filled = timersModule.tickTimer(context.campaignState, name, ticks);
    if (filled) {
      const event = timersModule.resolveTimer(context.campaignState, name);
      output = output.replace(match[0], `*(Timer "${name}" fills! ${event})*`);
    } else {
      const timer = context.campaignState.scene.timers.find(t => t.name === name);
      if (timer) {
        output = output.replace(match[0], `*(Timer "${name}" advanced to ${timer.current}/${timer.max})*`);
      } else {
        output = output.replace(match[0], `*(Timer "${name}" not found)*`);
      }
    }
    context.saveCampaign();
  }

  // [TIMER ...]
  const createRegex = /\[TIMER "([^"]+)" (\d+) "([^"]*)"\]/gi;
  while ((match = createRegex.exec(text)) !== null) {
    const name = match[1];
    const max = parseInt(match[2]);
    const onFill = match[3] || 'Timer fills.';
    timersModule.addTimer(context.campaignState, name, max, onFill);
    context.saveCampaign();
    output = output.replace(match[0], `*(Timer "${name}" created with ${max} segments)*`);
  }

  // [DRAW ...]
  const drawRegex = /\[DRAW (\d+) (\w+)\]/gi;
  while ((match = drawRegex.exec(text)) !== null) {
    const count = parseInt(match[1]);
    const region = match[2];
    const cards = context.deck.drawCards(count, region);
    const cardStr = cards.map(c => `${c.rank} of ${c.suit}`).join(', ');
    output = output.replace(match[0], `*(Drew ${count} card${count > 1 ? 's' : ''} from ${region}: ${cardStr})*`);
    if (context.ws && context.ws.readyState === WebSocket.OPEN) {
      context.ws.send(JSON.stringify({ type: 'deck-draw', count, region, cards }));
    }
  }

  // [CROWN ...]
  const crownRegex = /\[CROWN (\w+)\]/gi;
  while ((match = crownRegex.exec(text)) !== null) {
    const region = match[1];
    const spread = context.deck.crownSpread(region);
    const formatted = `Crown Spread for ${region}:\n` +
      `Root: ${spread.root ? `${spread.root.rank} of ${spread.root.suit}` : '—'}\n` +
      `Crest: ${spread.crest ? `${spread.crest.rank} of ${spread.crest.suit}` : '—'}\n` +
      `Crown: ${spread.crown ? `${spread.crown.rank} of ${spread.crown.suit}` : '—'}\n` +
      `Left Hand: ${spread.leftHand ? `${spread.leftHand.rank} of ${spread.leftHand.suit}` : '—'}\n` +
      `Right Hand: ${spread.rightHand ? `${spread.rightHand.rank} of ${spread.rightHand.suit}` : '—'}`;
    output = output.replace(match[0], `*(Crown Spread for ${region}:\n${formatted})*`);
    if (context.ws && context.ws.readyState === WebSocket.OPEN) {
      context.ws.send(JSON.stringify({ type: 'crown-spread', region, spread }));
    }
  }

  // [SPEND SB ...]
  const sbRegex = /\[SPEND SB (\d+)\]/gi;
  while ((match = sbRegex.exec(text)) !== null) {
    const cost = parseInt(match[1]);
    if (context.campaignState.sb >= cost) {
      context.campaignState.sb -= cost;
      context.saveCampaign();
      output = output.replace(match[0], `*(Spent ${cost} Story Beat${cost > 1 ? 's' : ''})*`);
    } else {
      output = output.replace(match[0], '*(Not enough SB)*');
    }
  }

  // [FACT ...]
  const factRegex = /\[FACT (.+?) (.+?)\]/gi;
  while ((match = factRegex.exec(text)) !== null) {
    const key = match[1].trim();
    const value = match[2].trim();
    context.campaignState.facts[key] = value;
    context.saveCampaign();
    output = output.replace(match[0], '');
  }

  return output;
}

module.exports = { handleBotCommand, processSpecialTags };