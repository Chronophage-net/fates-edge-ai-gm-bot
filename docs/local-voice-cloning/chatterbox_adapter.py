#!/usr/bin/env python3
"""
Tiny adapter: translates the fates-edge-ai-gm-bot TTS contract
    POST {text, voice, format} -> raw audio bytes
into Chatterbox-TTS-Server's actual /tts contract.

Point the bot's TTS_URL at this adapter (default http://localhost:8090/synthesize),
not at Chatterbox directly.

Usage:
    pip install flask requests
    python chatterbox_adapter.py

Env vars (all optional):
    CHATTERBOX_URL           default http://localhost:8004
    CHATTERBOX_REFERENCE_FILE  default "reference.wav" -- must match a filename
                                already uploaded to Chatterbox's Web UI
    ADAPTER_PORT              default 8090
"""
import os
import requests
from flask import Flask, request, Response

app = Flask(__name__)

CHATTERBOX_URL = os.environ.get("CHATTERBOX_URL", "http://localhost:8004")
REFERENCE_FILE = os.environ.get("CHATTERBOX_REFERENCE_FILE", "reference.wav")
ADAPTER_PORT = int(os.environ.get("ADAPTER_PORT", "8090"))


@app.route("/synthesize", methods=["POST"])
def synthesize():
    body = request.get_json(force=True, silent=True) or {}
    text = body.get("text", "")
    fmt = body.get("format", "wav")

    if not text:
        return {"error": "missing 'text'"}, 400

    payload = {
        "text": text,
        "voice_mode": "clone",
        "reference_audio_filename": REFERENCE_FILE,
        "language": "en",
        "stream": False,
    }

    try:
        resp = requests.post(f"{CHATTERBOX_URL}/tts", json=payload, timeout=60)
        resp.raise_for_status()
    except requests.RequestException as e:
        return {"error": f"chatterbox request failed: {e}"}, 502

    return Response(resp.content, mimetype=f"audio/{fmt}")


if __name__ == "__main__":
    print(f"Chatterbox adapter listening on :{ADAPTER_PORT}, forwarding to {CHATTERBOX_URL}")
    print(f"Using reference file: {REFERENCE_FILE} (must already be uploaded in Chatterbox's Web UI)")
    app.run(host="0.0.0.0", port=ADAPTER_PORT)
