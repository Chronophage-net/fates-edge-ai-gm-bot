#!/usr/bin/env node

/**
 * Build Adventure Manifest
 * 
 * Scans data/docs/adventures/*.html, extracts the title using regex,
 * and writes a manifest to data/adventures/manifest.json.
 * 
 * Usage: node scripts/build-adventure-manifest.js
 */

const fs = require('fs');
const path = require('path');

const DOCS_DIR = path.resolve(process.cwd(), 'data', 'docs', 'adventures');
const MANIFEST_PATH = path.resolve(process.cwd(), 'data', 'adventures', 'manifest.json');

// Map of adventure ID (filename without extension) to doc filename
function getAdventureIdFromDocFilename(docFilename) {
    // Remove "Fates_-_Edge_-_" prefix and ".html" suffix
    let id = docFilename
        .replace(/^Fates_-_Edge_-_/, '')
        .replace(/\.html$/, '')
        .replace(/'/g, '') // Remove apostrophes
        .replace(/-/g, '_') // Convert dashes to underscores
        .toLowerCase();

    // BUGFIX: filenames like 'Fates_-_Edge_-_-The-_-Grumbling-_-Vault.html'
    // leave a leading '-' after the prefix strip (the prefix regex above
    // doesn't consume it), and every '-_-' separator becomes three
    // underscores once dashes are converted. That produced ids like
    // '_the___grumbling___vault' instead of 'the_grumbling_vault', which
    // never matched any specialCases key below (they all use single,
    // non-leading underscores) -- so the fallback (the mangled id itself)
    // silently became the real manifest key for every adventure, and
    // getAdventureDoc()'s manifest[moduleId] lookup could never succeed.
    // Collapse runs of underscores and trim leading/trailing ones so the
    // id matches the same filename-stem convention used everywhere else
    // in this codebase (see world-manager.js's region-loading bugfix for
    // the same pattern).
    id = id.replace(/_+/g, '_').replace(/^_+|_+$/g, '');

    // Handle special cases
    const specialCases = {
        'blood_and_silk_saga': 'blood_and_silk_saga',
        'canival_of_broken_dreams': 'carnival_of_broken_dreams',
        'lantern_at_dusk': 'lantern_at_dusk',
        'the_cursed_caravan': 'cursed_caravan',
        'the_grumbling_vault': 'grumbling_vault',
        'the_hazel_root': 'hazel_root',
        'the_nameless': 'nameless',
        'the_ninth_proof': 'ninth_proof',
        'the_serpents_coil': 'serpents_coil',
        'whispers_in_the_tunnels': 'whispers_in_the_tunnels'
    };
    
    return specialCases[id] || id;
}

function extractTitleFromHtml(htmlContent) {
    // Try to find <h1> tag first (most common)
    const h1Match = htmlContent.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (h1Match) {
        return h1Match[1].trim();
    }
    
    // Try to find <title> tag
    const titleMatch = htmlContent.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (titleMatch) {
        return titleMatch[1].trim();
    }
    
    // Try to find first heading
    const headingMatch = htmlContent.match(/<h[2-6][^>]*>([^<]+)<\/h[2-6]>/i);
    if (headingMatch) {
        return headingMatch[1].trim();
    }
    
    // Fallback: use the filename
    return null;
}

function buildManifest() {
    console.log('📚 Building adventure manifest...');
    
    if (!fs.existsSync(DOCS_DIR)) {
        console.warn(`⚠️ Docs directory not found: ${DOCS_DIR}`);
        return;
    }
    
    const files = fs.readdirSync(DOCS_DIR).filter(f => f.endsWith('.html'));
    
    if (files.length === 0) {
        console.warn('⚠️ No HTML files found in docs directory.');
        return;
    }
    
    console.log(`📄 Found ${files.length} HTML files.`);
    
    const manifest = {};
    let parsedCount = 0;
    
    for (const file of files) {
        const filePath = path.join(DOCS_DIR, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const title = extractTitleFromHtml(content);
        const adventureId = getAdventureIdFromDocFilename(file);
        
        if (title) {
            manifest[adventureId] = {
                title: title,
                docFile: file,
                docPath: `/data/docs/adventures/${file}`
            };
            parsedCount++;
            console.log(`  ✅ ${adventureId} → "${title}"`);
        } else {
            console.warn(`  ⚠️ Could not extract title from ${file}`);
        }
    }
    
    // Write manifest
    const manifestDir = path.dirname(MANIFEST_PATH);
    if (!fs.existsSync(manifestDir)) {
        fs.mkdirSync(manifestDir, { recursive: true });
    }
    
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
    console.log(`✅ Manifest written to ${MANIFEST_PATH} (${parsedCount} entries)`);
}

// Run if called directly
if (require.main === module) {
    buildManifest();
}

module.exports = { buildManifest, extractTitleFromHtml, getAdventureIdFromDocFilename };
