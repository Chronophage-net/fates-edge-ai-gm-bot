# Versioning

This repo follows strict [Semantic Versioning](https://semver.org/) —
`MAJOR.MINOR.PATCH` — starting at **4.4.0**, matching the rest of the
Fate's Edge ecosystem (`fates-edge-apps`). The old `4.3a`-style scheme is
retired — see `fates-edge-apps/VERSIONING.md` for the full rationale.

- **MAJOR** — breaking changes (driver interface changes, tag-syntax
  changes in `modules/commands.js`, config/env var renames).
- **MINOR** — new features, new drivers/modules, non-breaking behavior
  changes.
- **PATCH** — bug fixes, test/doc/refactor-only changes.

## Bumping the version

```bash
node tools/bump-version.mjs [major|minor|patch|auto] ["release summary"]
```

Same tool and mechanics as the rest of the ecosystem — see
`fates-edge-apps/VERSIONING.md`'s "Bumping the version" section and
`tools/bump-version.mjs`'s own header comment for the full behavior
(auto-detection from Conventional Commits, `--dry-run`, `--no-commit`,
CHANGELOG.md generation, graceful fallback to manual git commands if
`git commit`/`tag` can't run).

This is a separate git repo from `fates-edge-apps` with its own tag
history — bump it independently when this repo's code changes, not in
lockstep with the others, even though the version *numbers* happen to
currently be aligned.
