#!/usr/bin/env python3
"""Deterministic checks for the active Gemini commentary narration preset."""
from __future__ import annotations

import base64
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("voice", ROOT / "generate_voiceover.py")
assert spec and spec.loader
voice = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = voice
spec.loader.exec_module(voice)

assert voice.TTS_PRESET_NAME == "commentary_rapid_neutral"
assert voice.TTS_VOICES[0] == "Charon"
for required_phrase in (
    "rapid, brisk pace",
    "articulate every word distinctly",
    "tempo, pitch, loudness, and energy steady",
    "neutral, near-emotionless, matter-of-fact",
    "not dramatic, hype, suspenseful, theatrical, gravelly, or expressive",
    "fully intelligible",
):
    assert required_phrase in voice.STYLE_PROMPT, required_phrase

captured = {}
def fake_post(url, raw_key, payload):
    captured["url"] = url
    captured["raw_key"] = raw_key
    captured["payload"] = payload
    return {
        "candidates": [{
            "content": {
                "parts": [{
                    "inlineData": {"data": base64.b64encode(b"\x00\x00\x01\x00").decode("ascii")}
                }]
            }
        }]
    }

voice._post_json = fake_post
pcm = voice._synthesize_once(
    "The facts move quickly, but every word stays clear.",
    voice.ApiKey(raw="test-key", fingerprint="test...key"),
    voice._FLASH_MODEL,
    voice.TTS_VOICES[0],
)
assert pcm == b"\x00\x00\x01\x00"
payload = captured["payload"]
text = payload["contents"][0]["parts"][0]["text"]
assert text == voice.STYLE_PROMPT + "The facts move quickly, but every word stays clear."
assert payload["generationConfig"]["responseModalities"] == ["AUDIO"]
assert payload["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Charon"
print("PASS: rapid-neutral commentary TTS preset and Gemini payload")
