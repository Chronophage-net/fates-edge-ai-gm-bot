# Copy to .env.lite and fill in the values below, then:
#   docker compose -f docker-compose.lite.yml --env-file .env.lite up -d --build
#
# This is the minimal-footprint config for a small/underpowered
# machine — see docker-compose.lite.yml's own header comment and
# "Running on small/underpowered machines" in RUNNING-THE-AI-GM-BOT.md
# for what it trades away. If you outgrow it later, switch to the
# main .env + docker-compose.yml (or bring your own OpenAI/DeepSeek key)
# without changing anything about your socket server setup.

# ─── Your socket server (required) ───────────────────────────────
# The Fate's Edge socket server this bot connects to — same address
# and room your players use in the web client. Not something this
# file brings up itself; it must already be running somewhere.
WS_URL=ws://localhost:10000
ROOM=AC12

# The socket server's own admin API key (not an AI provider key) —
# needed so the bot can save/load campaign progress. Leave blank if
# you don't need auto-save; the bot still runs and narrates fine
# without it, just without persistence across restarts.
API_KEY=

BOT_NAME=AI_GM

# ─── The tiny local model ─────────────────────────────────────────
# llama3.2:1b (~1.3GB) is the default and the whole point of "lite" —
# it's the fastest to pull and the least demanding to run, at a real
# cost to narrative quality and tag-following reliability (see the
# caveats doc). If your machine can spare a bit more:
#   llama3.2:3b  (~2.0GB) — meaningfully better at following the
#                [ROLL ...]/[CALL FOR ROLL ...] tag protocol, still
#                modest.
# Bump LITE_OLLAMA_CONTEXT_WINDOW to match whatever you pick — check
# with `docker compose -f docker-compose.lite.yml exec ollama ollama show <model>`
# once it's pulled.
LITE_OLLAMA_MODEL=llama3.2:1b
LITE_OLLAMA_CONTEXT_WINDOW=4096

# CPU-only inference on modest hardware can genuinely take a couple of
# minutes for a long reply. Raise this further if you still see
# "(AI error)" in chat with timeouts in the logs.
LITE_OLLAMA_TIMEOUT_MS=300000

# Dashboard port and on/off switch (STATUS_SERVER=false to disable).
STATUS_PORT=4141
STATUS_SERVER=true
