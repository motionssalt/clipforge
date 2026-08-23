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

assert voice.TTS_PRESET_NAME == "commentary_clear_neutral"
assert voice.TTS_VOICES == ("Iapetus", "Charon")
for required_phrase in (
    "# AUDIO PROFILE",
    "same continuous recording session",
    "same neutral vocal identity, pitch range, timbre, loudness, and energy",
    "# DIRECTOR'S NOTES",
    "about 188 words per minute—about 1.2 times normal conversational speed",
    "brisk but calm, with tight forward momentum",
    "neutral General American (U.S.) accent",
    "Do not draw out syllables or leave long pauses",
    "Articulate every word distinctly",
    "tempo, pitch, loudness, and energy steady",
    "neutral, near-emotionless, matter-of-fact",
    "not dramatic, hype, suspenseful, theatrical, gravelly, or expressive",
    "Do not change the delivery to match a line's emotion or scene",
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
assert payload["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Iapetus"
# Official Gemini-TTS documentation states that temperature/top-k/top-p are
# ignored and does not document a seed control, so the payload must not imply
# that a determinism parameter is active.
assert "temperature" not in payload["generationConfig"]
assert "seed" not in payload["generationConfig"]
print("PASS: Iapetus-first clear commentary TTS preset and documented Gemini payload contract")
