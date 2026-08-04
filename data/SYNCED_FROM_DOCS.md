# This directory is a sync target, not a source

Most of the JSON here (`patrons/`, `regions/`, `adventures/`, `religions/`,
`terrestrial/`, `factions/`, `talents/`, `bestiary.json`,
`talents-manifest.json`) is generated content owned by the
[`fates-edge-docs`](../../fates-edge-docs) repository, which is the source
of truth. (This bot doesn't use compiled HTML docs, so `data/docs/` here is
legacy and not part of the sync — safe to remove.)

**Edit game data in fates-edge-docs, then run:**

```bash
cd fates-edge-docs
python3 tools/sync_data_to_consumers.py
```

Hand edits made directly in this directory will be silently overwritten
the next time a sync runs.

Exceptions (not synced, safe to edit here):
- `wiki.json` — diverged from the docs repo's copy; needs manual reconciliation before it can be automated.
- `lock-reset.json` — runtime state, not canonical content.
