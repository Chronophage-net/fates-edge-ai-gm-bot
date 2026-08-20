#!/usr/bin/env python3
"""
Tiny adapter: translates the fates-edge-ai-gm-bot RVC contract
    POST {audio: base64, format, voice} -> raw audio bytes OR {audio: base64}
into rvc-python's actual /convert contract ({audio_data: base64} -> raw wav bytes).

Point the bot's RVC_URL at this adapter (default http://localhost:8091/convert),
not at rvc-python directly.

Usage:
    pip install flask requests
    python rvc_adapter.py

Env vars (all optional):
    RVC_PYTHON_URL   default http://localhost:5050
    ADAPTER_PORT     default 8091

Note: rvc-python's API server is typically started with one active model at a
time (python -m rvc_python api -l), so the 'voice'/RVC_VOICE field is not
forwarded per-request here -- make sure the model loaded in rvc-python matches
what you set RVC_VOICE to, for your own bookkeeping.
"""
import base64
import os
import requests
from flask import Flask, request, Response

app = Flask(__name__)

RVC_PYTHON_URL = os.environ.get("RVC_PYTHON_URL", "http://localhost:5050")
ADAPTER_PORT = int(os.environ.get("ADAPTER_PORT", "8091"))


@app.route("/convert", methods=["POST"])
def convert():
    body = request.get_json(force=True, silent=True) or {}
    audio_b64 = body.get("audio")
    fmt = body.get("format", "wav")

    if not audio_b64:
        return {"error": "missing 'audio'"}, 400

    try:
        resp = requests.post(
            f"{RVC_PYTHON_URL}/convert",
            json={"audio_data": audio_b64},
            timeout=60,
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        return {"error": f"rvc-python request failed: {e}"}, 502

    return Response(resp.content, mimetype=f"audio/{fmt}")


if __name__ == "__main__":
    print(f"RVC adapter listening on :{ADAPTER_PORT}, forwarding to {RVC_PYTHON_URL}")
    app.run(host="0.0.0.0", port=ADAPTER_PORT)
