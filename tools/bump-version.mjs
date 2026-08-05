#!/usr/bin/env node
/**
 * bump-version.mjs — semantic version bump + changelog + git tag automation.
 *
 * This is the canonical copy (fates-edge-apps/tools/bump-version.mjs). The
 * identical file is also copied into fates-edge-ai-gm-bot/tools/ and
 * fates-edge-docs/tools/ (three separate git repos, three separate version
 * histories/tags) — it needs no repo-specific configuration, so keeping a
 * single generic script and copying it is simpler than maintaining a
 * shared npm package across repos that don't otherwise depend on each
 * other. If you change the logic, copy the new file to the other two
 * repos' tools/ directories too.
 *
 * USAGE
 *   node tools/bump-version.mjs [major|minor|patch|auto] ["release summary"]
 *   node tools/bump-version.mjs --dry-run [major|minor|patch|auto]
 *   node tools/bump-version.mjs --no-commit [major|minor|patch|auto]
 *
 *   Bump level defaults to "auto" if omitted.
 *
 * VERSIONING SCHEME (see VERSIONING.md at the repo root for the full writeup)
 *   Strict semver: MAJOR.MINOR.PATCH — no more "4.3a"-style letter suffixes.
 *   Tags are "vMAJOR.MINOR.PATCH". "auto" mode picks the bump level from
 *   Conventional Commits (https://www.conventionalcommits.org/) prefixes on
 *   every commit since the last vX.Y.Z tag:
 *     - a "!" after the type/scope (e.g. "feat!:") or a "BREAKING CHANGE:"
 *       footer anywhere in a commit body -> MAJOR
 *     - "feat:" / "feat(scope):"                                -> MINOR
 *     - anything else ("fix:", "chore:", "docs:", "test:",
 *       "refactor:", "perf:", "style:", "ci:", "build:", or no
 *       recognized prefix at all)                                -> PATCH
 *   If there are no commits since the last tag (or no tag exists yet and
 *   HEAD has no conventional-commit history to read), "auto" falls back to
 *   PATCH rather than guessing MAJOR/MINOR.
 *
 * WHAT IT DOES
 *   1. Finds the "source of truth" version:
 *        - every package.json in the repo (excluding node_modules/dist/
 *          build/.git/coverage) if any exist — reads the repo-root one
 *          (or, if there isn't one, the first found) as current, and
 *          writes the bumped version to ALL of them (keeps a multi-package
 *          repo like fates-edge-apps in sync — this folds in what
 *          tools/sync-package-json.py already did manually);
 *        - otherwise a plain VERSION file at the repo root (created with
 *          "0.1.0" if this is the first time), for repos with no
 *          package.json at all (e.g. fates-edge-docs, a LaTeX repo).
 *      Legacy non-semver versions like "4.3a" are parsed leniently
 *      (leading MAJOR.MINOR taken, trailing letter/garbage dropped, PATCH
 *      assumed 0) so the very first run on this ecosystem migrates
 *      cleanly to real semver without manual editing first.
 *   2. Prepends a dated entry to CHANGELOG.md (created if missing) in
 *      "Keep a Changelog" style, auto-populated from commit subjects since
 *      the last vX.Y.Z tag, grouped under Added/Fixed/Changed/Docs/Tests/
 *      Chore/Other by Conventional Commits prefix. Pass a quoted string as
 *      the second CLI argument to prepend it as a one-line summary above
 *      the auto-generated groups.
 *   3. Stages everything, commits as "chore(release): vX.Y.Z", and creates
 *      an annotated git tag "vX.Y.Z" — unless --no-commit/--dry-run is
 *      passed, or the git commands themselves fail (e.g. a stale
 *      .git/index.lock), in which case it prints the exact commands to
 *      run by hand instead of crashing or leaving a half-done commit.
 *
 * Zero npm dependencies — only Node builtins (fs, path, child_process) —
 * so it works the moment Node is available, matching this ecosystem's
 * existing "minimal dependencies" convention (see fates-edge-ai-gm-bot's
 * README, which recommends node:test over adding Jest/Vitest for the same
 * reason).
 */

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const noCommit = args.includes('--no-commit') || dryRun;
const positional = args.filter(a => !a.startsWith('--'));
const requestedLevel = positional[0] || 'auto';
const summary = positional[1] || null;

const EXCLUDE_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

// ────────────────────────────────────────────────────────────────────
// git helpers
// ────────────────────────────────────────────────────────────────────

function git(cmd, opts = {}) {
    return execSync(`git ${cmd}`, { cwd: repoRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

function tryGit(cmd) {
    try {
        return { ok: true, out: git(cmd) };
    } catch (err) {
        return { ok: false, out: (err.stdout || '') + (err.stderr || err.message || '') };
    }
}

function lastTag() {
    const res = tryGit('describe --tags --abbrev=0 --match "v*"');
    return res.ok ? res.out : null;
}

function commitsSince(tag) {
    const range = tag ? `${tag}..HEAD` : '';
    const res = tryGit(`log ${range} --pretty=format:%s%n%b%x1e`);
    if (!res.ok || !res.out) return [];
    // %x1e (record separator) delimits subject+body per commit so a
    // multi-line body's "BREAKING CHANGE:" footer is still attributable
    // to the right commit.
    return res.out.split('\x1e').map(s => s.trim()).filter(Boolean);
}

// ────────────────────────────────────────────────────────────────────
// semver helpers
// ────────────────────────────────────────────────────────────────────

function parseVersionLenient(v) {
    // Accepts real semver ("4.3.0") and this ecosystem's legacy
    // "4.3a"/"4.3-a" style (letter suffix, missing patch) — takes the
    // leading MAJOR.MINOR[.PATCH] and ignores anything after.
    const m = /^(\d+)\.(\d+)(?:[.\-](\d+))?/.exec(String(v).trim());
    if (!m) throw new Error(`Cannot parse version string: "${v}"`);
    return { major: +m[1], minor: +m[2], patch: +(m[3] || 0) };
}

function formatVersion({ major, minor, patch }) {
    return `${major}.${minor}.${patch}`;
}

function bump(version, level) {
    const v = { ...version };
    if (level === 'major') { v.major += 1; v.minor = 0; v.patch = 0; }
    else if (level === 'minor') { v.minor += 1; v.patch = 0; }
    else { v.patch += 1; }
    return v;
}

function detectLevel(commits) {
    if (commits.length === 0) return 'patch';
    let sawFeat = false;
    for (const c of commits) {
        const firstLine = c.split('\n')[0];
        const conventional = /^(\w+)(\([^)]*\))?(!)?:/.exec(firstLine);
        const isBreaking = (conventional && conventional[3] === '!') || /BREAKING[ -]CHANGE:/.test(c);
        if (isBreaking) return 'major';
        if (conventional && conventional[1] === 'feat') sawFeat = true;
    }
    return sawFeat ? 'minor' : 'patch';
}

// ────────────────────────────────────────────────────────────────────
// package.json discovery / VERSION-file fallback
// ────────────────────────────────────────────────────────────────────

function findPackageJsons(dir, out = []) {
    let entries;
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return out;
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (EXCLUDE_DIR_NAMES.has(entry.name)) continue;
            findPackageJsons(path.join(dir, entry.name), out);
        } else if (entry.isFile() && entry.name === 'package.json') {
            out.push(path.join(dir, entry.name));
        }
    }
    return out;
}

function readJson(p) {
    return JSON.parse(readFileSync(p, 'utf8'));
}

function writeJson(p, data) {
    writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// ────────────────────────────────────────────────────────────────────
// CHANGELOG.md
// ────────────────────────────────────────────────────────────────────

const GROUP_ORDER = ['Added', 'Fixed', 'Changed', 'Docs', 'Tests', 'Chore', 'Other'];
const PREFIX_TO_GROUP = {
    feat: 'Added',
    fix: 'Fixed',
    refactor: 'Changed',
    perf: 'Changed',
    style: 'Changed',
    docs: 'Docs',
    test: 'Tests',
    chore: 'Chore',
    build: 'Chore',
    ci: 'Chore',
};

function groupCommits(commits) {
    const groups = {};
    for (const g of GROUP_ORDER) groups[g] = [];
    for (const c of commits) {
        const firstLine = c.split('\n')[0].trim();
        if (!firstLine || /^chore\(release\):/.test(firstLine)) continue; // skip prior release commits
        const m = /^(\w+)(\([^)]*\))?!?:\s*(.*)$/.exec(firstLine);
        const group = (m && PREFIX_TO_GROUP[m[1]]) || 'Other';
        const text = m ? m[3] : firstLine;
        groups[group].push(text);
    }
    return groups;
}

function buildChangelogEntry(version, commits, summaryLine) {
    const date = new Date().toISOString().slice(0, 10);
    const groups = groupCommits(commits);
    let entry = `## [${formatVersion(version)}] - ${date}\n\n`;
    if (summaryLine) entry += `${summaryLine}\n\n`;
    let anyGroup = false;
    for (const g of GROUP_ORDER) {
        if (groups[g].length === 0) continue;
        anyGroup = true;
        entry += `### ${g}\n`;
        for (const line of groups[g]) entry += `- ${line}\n`;
        entry += '\n';
    }
    if (!anyGroup) entry += '_No commits since the last tag — manual version bump._\n\n';
    return entry;
}

function prependChangelog(entry) {
    const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
    let existing = '';
    let header = '# Changelog\nAll notable changes to this project will be documented here.\n\nFormat loosely follows [Keep a Changelog](https://keepachangelog.com/), versions follow [Semantic Versioning](https://semver.org/).\n\n';
    if (existsSync(changelogPath)) {
        existing = readFileSync(changelogPath, 'utf8');
        const firstEntryIdx = existing.indexOf('\n## [');
        if (firstEntryIdx !== -1) {
            header = existing.slice(0, existing.indexOf('\n## [') + 1);
            existing = existing.slice(existing.indexOf('\n## [') + 1);
        } else {
            existing = '';
        }
    }
    const newContent = header + entry + existing;
    return { changelogPath, newContent };
}

// ────────────────────────────────────────────────────────────────────
// main
// ────────────────────────────────────────────────────────────────────

function main() {
    const inGitRepo = tryGit('rev-parse --is-inside-work-tree').ok;

    const pkgPaths = findPackageJsons(repoRoot);
    const versionFilePath = path.join(repoRoot, 'VERSION');
    const usingPackageJson = pkgPaths.length > 0;

    let currentVersionStr;
    if (usingPackageJson) {
        const rootPkgPath = path.join(repoRoot, 'package.json');
        const sourcePath = pkgPaths.includes(rootPkgPath) ? rootPkgPath : pkgPaths[0];
        currentVersionStr = readJson(sourcePath).version || '0.1.0';
    } else {
        currentVersionStr = existsSync(versionFilePath) ? readFileSync(versionFilePath, 'utf8').trim() : '0.1.0';
    }

    const currentVersion = parseVersionLenient(currentVersionStr);

    const tag = inGitRepo ? lastTag() : null;
    const commits = inGitRepo ? commitsSince(tag) : [];
    const level = requestedLevel === 'auto' ? detectLevel(commits) : requestedLevel;
    if (!['major', 'minor', 'patch'].includes(level)) {
        console.error(`Unknown bump level "${level}". Use major, minor, patch, or auto.`);
        process.exit(1);
    }

    const newVersion = bump(currentVersion, level);
    const newVersionStr = formatVersion(newVersion);
    const newTag = `v${newVersionStr}`;

    console.log(`Current version: ${formatVersion(currentVersion)} (parsed from "${currentVersionStr}")`);
    console.log(`Bump level:      ${level}${requestedLevel === 'auto' ? ' (auto-detected from commits)' : ''}`);
    console.log(`New version:     ${newVersionStr}`);
    console.log(`Commits since ${tag || '(no previous tag)'}: ${commits.length}`);

    if (dryRun) {
        console.log('\n--dry-run: no files written, no git commands run.');
        console.log('\n--- CHANGELOG entry preview ---\n');
        console.log(buildChangelogEntry(newVersion, commits, summary));
        return;
    }

    // 1. Bump version(s)
    const touchedFiles = [];
    if (usingPackageJson) {
        for (const p of pkgPaths) {
            const data = readJson(p);
            data.version = newVersionStr;
            writeJson(p, data);
            touchedFiles.push(p);
            console.log(`Updated ${path.relative(repoRoot, p)}`);
        }
    } else {
        writeFileSync(versionFilePath, newVersionStr + '\n', 'utf8');
        touchedFiles.push(versionFilePath);
        console.log(`Updated ${path.relative(repoRoot, versionFilePath)}`);
    }

    // 2. CHANGELOG.md
    const entry = buildChangelogEntry(newVersion, commits, summary);
    const { changelogPath, newContent } = prependChangelog(entry);
    writeFileSync(changelogPath, newContent, 'utf8');
    touchedFiles.push(changelogPath);
    console.log(`Updated ${path.relative(repoRoot, changelogPath)}`);

    // 3. git commit + tag
    if (noCommit) {
        console.log('\n--no-commit: files updated, but no git commit/tag was created.');
        return;
    }
    if (!inGitRepo) {
        console.log('\nNot inside a git repository — skipping commit/tag.');
        return;
    }

    const addRes = tryGit('add -A');
    const commitRes = addRes.ok ? tryGit(`commit -m "chore(release): ${newTag}"`) : addRes;
    const tagRes = commitRes.ok ? tryGit(`tag -a ${newTag} -m "${newTag}"`) : commitRes;

    if (addRes.ok && commitRes.ok && tagRes.ok) {
        console.log(`\nCommitted and tagged ${newTag}.`);
        console.log(`Push with: git push && git push origin ${newTag}`);
        return;
    }

    console.log('\ngit commit/tag failed (files were still updated above) — run these manually:');
    console.log(`  git add -A`);
    console.log(`  git commit -m "chore(release): ${newTag}"`);
    console.log(`  git tag -a ${newTag} -m "${newTag}"`);
    console.log(`  git push && git push origin ${newTag}`);
    console.log('\ngit error output:');
    console.log((!addRes.ok ? addRes.out : !commitRes.ok ? commitRes.out : tagRes.out).trim());
}

main();
