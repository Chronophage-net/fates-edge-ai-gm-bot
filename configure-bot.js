#!/usr/bin/env node

/**
 * Configuration Wizard for Fate's Edge AI GM Bot.
 *
 * Scans /drivers, lets you pick a driver, prompts for its required
 * environment variables, and writes a .env file so you can start the bot.
 *
 * Usage: node configure-bot.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

const DRIVERS_DIR = path.join(__dirname, 'drivers');

// Expand a leading "~" (or "~/...") to the user's home directory before
// resolving, since the shell isn't the one expanding it for us here.
function expandHome(filePath) {
    if (!filePath) return filePath;
    if (filePath === '~') return os.homedir();
    if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
        return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
}

// ================================
// Utility: prompt for user input
// ================================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

// ================================
// Scan drivers directory
// ================================
async function scanDrivers() {
    const files = fs.readdirSync(DRIVERS_DIR);
    const drivers = [];

    for (const file of files) {
        if (!file.endsWith('.js')) continue;
        if (file === 'ai-driver.js') continue; // abstract base class, not a selectable backend
        const filePath = path.join(DRIVERS_DIR, file);
        try {
            const driver = require(filePath);
            // Only list drivers that actually declare their own meta —
            // a driver with no meta.name has nothing configurable to prompt
            // for and is almost certainly not meant to be user-selectable
            // (e.g. a shared base class picked up by the directory scan).
            if (!driver.meta || !driver.meta.name) continue;
            drivers.push({ file, meta: driver.meta, filePath });
        } catch (e) {
            // Skip files that can't be loaded
            continue;
        }
    }

    if (drivers.length === 0) {
        console.error('No valid drivers found in /drivers.');
        process.exit(1);
    }

    return drivers;
}

// ================================
// Select a driver
// ================================
async function selectDriver(drivers) {
    console.log('\n📡 Available AI Drivers:\n');
    drivers.forEach((d, i) => {
        console.log(`  ${i + 1}) ${d.meta.name} - ${d.meta.description}`);
    });

    const choice = await question('\nSelect a driver (number): ');
    const index = parseInt(choice) - 1;
    if (isNaN(index) || index < 0 || index >= drivers.length) {
        console.error('Invalid choice.');
        process.exit(1);
    }
    return drivers[index];
}

// ================================
// Prompt for required environment variables
// ================================
async function promptForEnv(driver) {
    const envVars = {};
    const required = driver.meta.requiredEnv || [];

    console.log(`\n🔧 Configuring ${driver.meta.name}:\n`);

    for (const varName of required) {
        const askFile = await question(`  Use a file for ${varName}? (y/n, default: n): `);
        if (askFile.toLowerCase() === 'y') {
            const filePath = await question(`  Path to file containing ${varName}: `);
            try {
                const content = fs.readFileSync(path.resolve(expandHome(filePath.trim())), 'utf8').trim();
                envVars[varName] = content;
            } catch (e) {
                console.error(`  Could not read file: ${e.message}`);
                process.exit(1);
            }
        } else {
            const value = await question(`  Enter value for ${varName}: `);
            envVars[varName] = value.trim();
        }
    }

    return envVars;
}

// ================================
// Write .env file
// ================================
async function writeEnvFile(driver, envVars) {
    const envPath = path.join(__dirname, '.env');
    let existing = '';
    try {
        existing = fs.readFileSync(envPath, 'utf8');
        const overwrite = await question(`\n.env already exists. Append to it? (y/n): `);
        if (overwrite.toLowerCase() !== 'y') {
            console.log('Aborted.');
            process.exit(0);
        }
    } catch (e) { /* no .env yet */ }

    // ai-gm-bot.js picks its driver by AI_PROVIDER (ollama/openai/deepseek),
    // not by driver filename -- derive it from the driver file so the two
    // stay in sync (e.g. "deepseek-driver.js" -> "deepseek").
    const provider = driver.file.replace(/-driver\.js$/, '').toLowerCase();

    const lines = [];
    lines.push(`# Fate's Edge AI GM Bot configuration`);
    lines.push(`# Driver: ${driver.meta.name} (${driver.file})`);
    lines.push(`AI_PROVIDER=${provider}`);
    lines.push(`AI_DRIVER=./drivers/${driver.file}`);
    for (const [key, value] of Object.entries(envVars)) {
        lines.push(`${key}=${value}`);
    }

    // Add WebSocket / room settings (optional)
    const wsUrl = await question('WS_URL (WebSocket server, default ws://localhost:10000): ');
    lines.push(`WS_URL=${wsUrl || 'ws://localhost:10000'}`);
    const room = await question('ROOM (Room code, default ABC123): ');
    lines.push(`ROOM=${room || 'ABC123'}`);

    // The socket server's campaign save/load endpoints (auto-save included)
    // always require a non-empty x-api-key header -- without this, the bot
    // can chat fine but every "Failed to auto-save campaign: HTTP 401: API
    // key required" on save/load. Ask for it here so the wizard actually
    // produces a working config instead of silently leaving it out.
    console.log(`\n🔑 The socket server requires an API key to save/load campaigns.`);
    console.log(`   This must match the API_KEY the socket server itself is running with.`);
    const hasApiKey = await question('  Does your socket server require an API key? (y/n, default: y): ');
    if (hasApiKey.trim().toLowerCase() !== 'n') {
        const useFile = await question('  Use a file for API_KEY? (y/n, default: n): ');
        if (useFile.trim().toLowerCase() === 'y') {
            const filePath = await question('  Path to file containing API_KEY: ');
            try {
                const content = fs.readFileSync(path.resolve(expandHome(filePath.trim())), 'utf8').trim();
                lines.push(`API_KEY=${content}`);
            } catch (e) {
                console.error(`  Could not read file: ${e.message}`);
                process.exit(1);
            }
        } else {
            const apiKey = await question('  API_KEY (must match the socket server\'s own API_KEY): ');
            lines.push(`API_KEY=${apiKey.trim()}`);
        }
    } else {
        console.log('  Skipping API_KEY -- campaign auto-save/load will fail with 401 until one is set in .env.');
    }

    lines.push(''); // trailing newline

    fs.writeFileSync(envPath, existing + lines.join('\n') + '\n');
    console.log(`\n✅ Configuration written to ${envPath}`);
}

// ================================
// Main
// ================================
async function main() {
    console.log('⚔️  Fate\'s Edge AI GM Bot – Configuration Wizard\n');

    const drivers = await scanDrivers();
    const selected = await selectDriver(drivers);
    const envVars = await promptForEnv(selected);
    await writeEnvFile(selected, envVars);

    const startNow = await question('\nStart the bot now? (y/n): ');
    if (startNow.toLowerCase() === 'y') {
        console.log('\n🚀 Starting the bot…\n');
        // Use the same process – spawn npm start
        const { spawn } = require('child_process');
        const child = spawn('npm', ['start'], { stdio: 'inherit' });
        child.on('exit', () => {
            console.log('Bot stopped.');
            process.exit();
        });
    } else {
        console.log(`\nTo start later, run: npm start\n`);
    }

    rl.close();
}

main().catch(console.error);
