# AI GM and bot supervisor review — 2026-09-27

## Fixed

- Campaign, character and manifest values could become executable dashboard markup. Dynamic values are escaped, inline event handlers removed, and scripts restricted by nonce.
- Cross-site requests could approve suggestions or restart bots. Dashboard mutations now require a custom same-origin request header; local Host validation also blocks DNS rebinding. Remote bindings require configured dashboard credentials.
- Restarts could overlap the previous process and let its exit handler overwrite the new process state. Restarts now await exit and coalesce concurrent requests.
- SSE connections and logger subscriptions leaked across status-server restarts. Stop now ends streams, clears timers and removes its listener; slow readers are disconnected.
- Player roll messages could invoke unrelated campaign directives. The roll-only path validates the whole input before making changes.
- Whispers could fall through into public GM narration. Private chat is excluded; dedicated private seat and delegation handlers remain available.
- Malformed JSON values could throw outside the message-handler catch. Incoming frames are shape-checked without logging their contents. Room URL construction preserves query parameters, password joins work, and disconnect cancels pending requests.

## Verification

- 279 tests passed, including actual dashboard HTTP requests, Host/origin/authentication checks, script execution against hostile values, restart coalescing, private chat isolation and roll injection regressions.
- Recovery smoke check passed: killed-server recovery, SQLite persistence, stable identity after rotation, continued advancement and a fresh start after total loss.
- Dependency audit: zero reported vulnerabilities.
- Browser checked the supervisor overview and embedded status/log view with synthetic data.
- No live AI provider calls were made. Remote TLS deployment, paid providers and external Elasticsearch need deployment-specific checks.
