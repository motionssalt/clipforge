#!/usr/bin/env python3
"""Render identical Gemini TTS audition samples for a list of named voices.

This helper is intentionally separate from the production render. It calls the
same model ladder, key loader, style prompt, synthesis function, and WAV writer
as generate_voiceover.py, while constraining each pass to one requested voice.
It is useful when selecting or re-evaluating the production voice preset.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import generate_voiceover as voiceover

DEFAULT_TEXT = (
    "The door locks behind Nia. The alarm is already counting down. "
    "She finds one maintenance cable and climbs into the rafters. "
    "The floor gives way. She reaches the platform first."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", required=True, help="Directory for audition WAVs")
    parser.add_argument(
        "--voices",
        default="Charon,Iapetus,Orus",
        help="Comma-separated Gemini prebuilt voice names",
    )
    parser.add_argument(
        "--text",
        default=DEFAULT_TEXT,
        help="The exact line all candidates must read",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    candidates = [item.strip() for item in args.voices.split(",") if item.strip()]
    if len(candidates) < 2:
        raise SystemExit("Provide at least two comma-separated voice candidates.")
    if len(set(candidates)) != len(candidates):
        raise SystemExit("Voice candidates must be unique.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    keys = voiceover.load_keys()
    key_cursor = 0
    original_voices = voiceover.TTS_VOICES
    manifest = {
        "engine": "gemini-tts",
        "sample_rate_hz": voiceover.SAMPLE_RATE_HZ,
        "text": args.text,
        "style_prompt": voiceover.STYLE_PROMPT,
        "candidates": [],
    }

    try:
        for index, candidate in enumerate(candidates, start=1):
            # Reuse the production failover mechanism while allowing only this
            # audition candidate. This guarantees every WAV is generated with
            # the same directorial prompt and text.
            voiceover.TTS_VOICES = (candidate,)
            pcm, used_key, used_model, used_voice, key_cursor = (
                voiceover.synthesize_with_failover(
                    args.text,
                    keys,
                    f"audition {index:02d}/{len(candidates):02d}",
                    start_index=key_cursor,
                )
            )
            wav_path = out_dir / f"{candidate.lower()}.wav"
            duration = voiceover.write_wav(wav_path, pcm)
            manifest["candidates"].append(
                {
                    "voice": used_voice,
                    "model": used_model,
                    "duration_seconds": round(duration, 3),
                    "wav": wav_path.name,
                    "key_fingerprint": used_key.redacted(),
                }
            )
            print(
                f"Rendered {candidate}: {wav_path.name} ({duration:.2f}s via {used_model})",
                flush=True,
            )
    finally:
        voiceover.TTS_VOICES = original_voices

    (out_dir / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Wrote {out_dir / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
