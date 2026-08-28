# Contributing

Thanks for considering a contribution to the Fate's Edge AI GM Bot. This is a
small, actively-used hobby-turned-open-source project — issues and PRs are
genuinely welcome, no formal process required to get started.

## Getting set up

```bash
git clone https://github.com/Chronophage-net/fates-edge-ai-gm-bot.git
cd fates-edge-ai-gm-bot
npm install
npm test
```

See [README.md](README.md) for architecture, the driver/module layout, and
how to run the bot locally. [INSTALL.md](INSTALL.md) covers connecting it to
a running Fate's Edge Socket Server if you want to test against a real game.

## Before opening a PR

- Add or update tests under `tests/` for any behavior change — `npm test`
  runs Node's built-in test runner, no extra dependency needed. See the
  "Testing" section of README.md for the current layout and a couple of
  known gaps worth reading before touching `modules/commands.js` in
  particular.
- Keep changes focused; unrelated formatting-only diffs make review harder.
- If you're adding a new AI driver, see "Driver System" in README.md — it's
  a small, well-defined interface.
- **No image-generation drivers or features.** The Bot narrates pre-written
  scenes and calls for rolls; it does not and will not generate illustrative
  art of those scenes, however easy that would be to wire up as a driver.
  This project has a hard [No AI Art Policy](https://dev.fates-edge.com/no-ai-art)
  — PRs adding AI image generation in any form will be declined regardless
  of implementation quality.

## A note on licensing (why this matters more than usual)

This project is dual-licensed: free under AGPL-3.0-or-later for the community,
with a separate commercial license available for embedding/OEM/proprietary-fork
use (see [COMMERCIAL.md](COMMERCIAL.md)). That second option only works if the
project maintainer actually holds the rights needed to offer it — which means
your contribution needs to be something you're able to license on those same
dual terms, not just AGPL.

By submitting a pull request, you're certifying that:

1. You wrote the contribution yourself, or otherwise have the right to submit
   it under this project's license, and
2. You're licensing your contribution under the same terms as the project
   (AGPL-3.0-or-later, with the maintainer able to also offer it under the
   commercial license described in COMMERCIAL.md).

This is the same lightweight model used by MongoDB, GitLab, and most other
open-core / dual-licensed projects — no CLA paperwork, just this statement
covering it. If that's not something you're comfortable certifying for a
given contribution, please say so in the PR and we can talk about it.

## Reporting bugs / requesting features

Open a GitHub issue. For anything security-related, see
[SECURITY.md](SECURITY.md) instead — please don't open a public issue for
those.

## Questions

Open an issue, or reach out to **support@fates-edge.com**.
