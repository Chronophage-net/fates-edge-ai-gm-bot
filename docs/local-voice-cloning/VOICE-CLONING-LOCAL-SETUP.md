# Testing Voice Cloning Locally (Chatterbox + RVC) for the AI GM Bot

This walks through getting a cloned GM voice running on your laptop and wired into
`fates-edge-ai-gm-bot`'s existing `TTS_*`/`RVC_*` env vars (see the bot's README "Voice
Narration"/"Voice Cloning" sections and `DESIGN.md` §6.1–6.2 for the contract these expect).

**A quick note before you clone anyone's voice:** only clone your own voice, a voice you have
explicit permission to clone, or a synthetic/character voice — not a real person's voice without
their consent, even for a private game. Chatterbox and RVC don't check this for you.

## Fastest path: one command, via the demo stack

If you're already using `fates-edge-apps`'s demo stack (`npm run demo`), skip everything
below and just run, from the `fates-edge-apps` repo root:

```bash
npm run demo -- --voice          # Chatterbox only, zero-shot clone
npm run demo -- --voice-rvc      # + RVC layer on top (needs your own trained model)
```

This brings up Docker containers for Chatterbox, a small translation sidecar
(`voice-adapter`), and optionally RVC — all pre-wired to this bot's `TTS_URL`/`RVC_URL` —
via `docker-compose.voice.yml`. Drop a reference clip in `voice-tts-reference/` and (for
RVC) a trained model in `voice-rvc-models/` first; see those folders' READMEs and that
compose file's header comment. **Everything below this point is the manual, outside-Docker
walkthrough** — useful if you're not running the demo stack, want to deploy these services
elsewhere, or just want to understand what the sidecar above is actually doing.

## Two paths, pick one to start

Chatterbox by itself already does **zero-shot voice cloning** — you give it ~10–30 seconds of
reference audio and it speaks in that voice directly. RVC is a *second*, separate layer that
re-voices existing audio through a model *trained* on a voice (more setup, needs training data,
but can sound more consistent/higher-fidelity for one specific voice used a lot).

| | Chatterbox alone (Option A) | Chatterbox + RVC (Option B) |
|---|---|---|
| Setup effort | Low — one server, one reference clip | Higher — two servers, a trained model |
| Voice source | A short reference clip, no training | A trained `.pth`/`.index` model (hours of audio + training time, or a model someone already trained) |
| Good for | "I want the GM to sound like *this* fairly quickly" | "I want one very consistent, polished voice used across a whole campaign" |

Start with **Option A**. Only move to Option B if Chatterbox's cloned voice isn't consistent or
polished enough for you — it's meant to layer *on top of* A, not replace it (per the bot's own
`RVC_ENABLED` requiring `TTS_ENABLED` to already be working).

## Hardware reality check

Both run fine on CPU on a modern laptop — just slower (several seconds per line rather than
near-instant). If you have an NVIDIA GPU (even a modest one), use it; it's the difference between
"usable during a live session" and "everyone waits." Apple Silicon works via CPU/MPS but expect
CPU-like speeds unless the project you pick has explicit MPS support.

---

## Option A: Chatterbox alone (zero-shot clone, no RVC)

### 1. Get a reference clip

10–30 seconds of clean speech (single speaker, minimal background noise/music) as `.wav` or
`.mp3`. A phone recording of you reading a paragraph out loud works.

### 2. Run the Chatterbox TTS server

Using [devnen/Chatterbox-TTS-Server](https://github.com/devnen/Chatterbox-TTS-Server) (has a Web
UI, an API, and Docker Compose files for CPU/NVIDIA/ROCm):

```bash
git clone https://github.com/devnen/Chatterbox-TTS-Server.git
cd Chatterbox-TTS-Server

# CPU (works anywhere, slower):
docker compose -f docker-compose.cpu.yml up -d

# NVIDIA GPU instead, if you have one:
# docker compose -f docker-compose.cu121.yml up -d
```

No Docker? Use the launcher instead: `./start.sh` (macOS/Linux) or `start.bat` (Windows) — it
sets up a Python 3.10 venv and installs the right requirements for your hardware automatically.

Once it's up, open `http://localhost:8004` (default port — check the compose file/launcher output
if it differs) and upload your reference clip through the Web UI once, so it's saved as
`reference_audio_filename` the server can reuse.

### 3. Confirm it works standalone

```bash
curl -X POST http://localhost:8004/tts \
  -H "Content-Type: application/json" \
  -d '{
        "text": "The carnival lights flicker as you step past the gate.",
        "voice_mode": "clone",
        "reference_audio_filename": "your-uploaded-file.wav",
        "language": "en",
        "stream": false
      }' \
  --output test.wav

# play it back — afplay on macOS, or just open test.wav
afplay test.wav   # macOS
```

If `test.wav` plays back in the cloned voice, the server's working.

### 4. Bridge it to the bot's expected contract

The bot's `TTS_URL` expects a plain `POST {text, voice, format}` → raw audio bytes. Chatterbox's
`/tts` is close but not identical (it wants `voice_mode`/`reference_audio_filename`, not a single
`voice` field). Drop this tiny adapter in front of it — see `chatterbox_adapter.py` alongside this
file. Run it with:

```bash
pip install flask requests
python chatterbox_adapter.py
```

It listens on `:8090` and forwards to your Chatterbox server on `:8004`, translating the request
shape. Point the bot at the adapter, not at Chatterbox directly.

### 5. Wire it into the bot

In `fates-edge-ai-gm-bot/.env`:

```
TTS_ENABLED=true
TTS_URL=http://localhost:8090/synthesize
TTS_VOICE=default
TTS_FORMAT=wav
```

Restart the bot. GM chat replies should now go out with a `tts-audio` event in your cloned voice —
check the web client's narration mute/volume control (`js/features/vtt/tts-narration.js`) if you
don't hear anything.

---

## Option B: Add RVC on top

Only do this once Option A is working end-to-end.

### 1. Get (or train) an RVC voice model

You need a `.pth` file (mandatory) and ideally a matching `.index` file for that voice, trained
specifically for RVC. Training one yourself needs a clean dataset of the target voice (the RVC
project's own docs cover this: [RVC-Project WebUI](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI))
— it's genuinely out of scope for a quick local test, so for testing purposes the fastest path is
training a small model on your own voice with ~10 minutes of clean audio using the RVC WebUI's
built-in trainer, or using an existing model you already have rights to use.

### 2. Run the RVC API server

Using [daswer123/rvc-python](https://github.com/daswer123/rvc-python), a lighter option than the
full Gradio WebUI when you just want an API:

```bash
pip install rvc-python
# put your model.pth (and model.index, if you have one) in a folder, e.g.:
mkdir -p rvc_models/my-voice
cp /path/to/model.pth rvc_models/my-voice/
cp /path/to/model.index rvc_models/my-voice/ 2>/dev/null

python -m rvc_python api -p 5050 -l
```

### 3. Confirm it works standalone

```bash
python3 - <<'EOF'
import base64, requests, json

with open("test.wav", "rb") as f:
    audio_b64 = base64.b64encode(f.read()).decode()

resp = requests.post("http://localhost:5050/convert", json={"audio_data": audio_b64})
with open("test_converted.wav", "wb") as f:
    f.write(resp.content)
print("wrote test_converted.wav")
EOF

afplay test_converted.wav   # macOS
```

### 4. Bridge it to the bot's expected contract

Same situation as Chatterbox: `rvc-python`'s `/convert` wants `{audio_data}` and returns raw WAV,
while the bot's `RVC_URL` POSTs `{audio, format, voice}` and accepts raw bytes or `{audio:
base64}` JSON back. Use `rvc_adapter.py` alongside this file:

```bash
pip install flask requests
python rvc_adapter.py
```

It listens on `:8091`, forwards to `rvc-python` on `:5050`, and translates both directions.

### 5. Wire it into the bot

In `fates-edge-ai-gm-bot/.env` (alongside the `TTS_*` vars from Option A):

```
RVC_ENABLED=true
RVC_URL=http://localhost:8091/convert
RVC_VOICE=my-voice
RVC_FORMAT=wav
```

Restart the bot. Narration now goes: bot text → Chatterbox (adapter :8090) → RVC (adapter :8091)
→ `tts-audio` event → web client. The bot's own LRU cache (`RVC_CACHE_SIZE`) means repeated stock
lines skip both network round-trips on replay, which matters more on CPU.

---

## Troubleshooting

* **Nothing plays in the web client** — check the per-client mute/volume in
  `tts-narration.js`'s UI first; it's opt-in per the design doc.
* **Bot logs "TTS request failed" / narration silently missing** — hit the adapter's `/synthesize`
  or `/convert` endpoint directly with `curl` (steps above) to isolate whether the problem is the
  adapter, the underlying Chatterbox/RVC server, or the bot's own `TTS_URL`/`RVC_URL` config.
* **Everything works but is slow** — this is expected on CPU, especially with RVC layered on top.
  Bump `TTS_TIMEOUT_MS`/`RVC_TIMEOUT_MS` in the bot's `.env` if requests are timing out rather than
  just being slow, and consider testing Option A only (skip RVC) for faster iteration.
* **Docker container can't reach `localhost:8090`/`:8091` on your host** — if you're running the
  bot itself in Docker too, use `host.docker.internal` instead of `localhost` in `TTS_URL`/
  `RVC_URL` (Docker Desktop on macOS/Windows supports this out of the box; on Linux add
  `--add-host=host.docker.internal:host-gateway` or point at your host's LAN IP instead).
