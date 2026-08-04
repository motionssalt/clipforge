#!/usr/bin/env python3
"""
Transcribe an audio (or video) file to a timestamped transcript.json using
faster-whisper running locally on CPU. No external APIs, no API keys.

The transcription is behind a small `Transcriber` protocol so a different
backend (e.g. a hosted API) could be dropped in later, but the default and
only shipped implementation is local faster-whisper.

Usage:
    python transcribe.py <input_audio_or_video> <output_json>
                         [--model base|small|tiny] [--lang auto|en|ja|...]
"""
import argparse
import json
import os
import sys
import time
from typing import Iterable, Protocol


class Segment(dict):
    """Just a typed dict-ish shape: {id, start, end, text}."""


class Transcriber(Protocol):
    def transcribe(self, path: str) -> Iterable[Segment]: ...


class FasterWhisperTranscriber:
    """
    Default (and currently only) transcriber.

    Uses the CTranslate2-based faster-whisper reimplementation of OpenAI
    Whisper. Runs CPU-only in the Actions runner. Model size is
    intentionally capped at 'small' — 'large' is too slow on CPU.
    """

    ALLOWED_SIZES = {"tiny", "base", "small"}

    def __init__(self, model_size: str = "base", language: str = "auto"):
        if model_size not in self.ALLOWED_SIZES:
            raise ValueError(
                f"model_size must be one of {sorted(self.ALLOWED_SIZES)} (CPU perf cap), got {model_size!r}"
            )
        # Import lazily so the module is importable without the dep for tests.
        from faster_whisper import WhisperModel  # type: ignore

        print(f"Loading faster-whisper model: {model_size} (CPU, int8)", flush=True)
        t0 = time.time()
        self.model = WhisperModel(model_size, device="cpu", compute_type="int8")
        print(f"Model loaded in {time.time() - t0:.1f}s", flush=True)
        self.language = None if language == "auto" else language

    def transcribe(self, path: str) -> Iterable[Segment]:
        print(f"Transcribing {path} (language={self.language or 'auto-detect'})", flush=True)
        segments, info = self.model.transcribe(
            path,
            language=self.language,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        print(
            f"Detected language: {info.language} (prob={info.language_probability:.2f}), "
            f"duration={info.duration:.1f}s",
            flush=True,
        )
        for i, seg in enumerate(segments):
            yield Segment(
                id=i,
                start=round(float(seg.start), 3),
                end=round(float(seg.end), 3),
                text=(seg.text or "").strip(),
            )


def build_default_transcriber(model_size: str, language: str) -> Transcriber:
    """Single choke point for choosing the backend. Swap here if ever needed."""
    return FasterWhisperTranscriber(model_size=model_size, language=language)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_path")
    ap.add_argument("output_json")
    ap.add_argument("--model", default="base", choices=sorted(FasterWhisperTranscriber.ALLOWED_SIZES))
    ap.add_argument("--lang", default="auto")
    args = ap.parse_args()

    if not os.path.exists(args.input_path):
        print(f"Input not found: {args.input_path}", file=sys.stderr)
        sys.exit(2)

    tx = build_default_transcriber(args.model, args.lang)
    segs: list[Segment] = []
    t0 = time.time()
    for seg in tx.transcribe(args.input_path):
        segs.append(seg)
        if seg["id"] % 25 == 0:
            print(f"  [{seg['start']:8.2f}s] {seg['text'][:80]}", flush=True)
    elapsed = time.time() - t0

    duration = segs[-1]["end"] if segs else 0.0
    payload = {
        "backend": "faster-whisper",
        "model": args.model,
        "language_hint": args.lang,
        "audio_duration_seconds": duration,
        "generated_at_epoch": int(time.time()),
        "segments": segs,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)) or ".", exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(
        f"Wrote {len(segs)} segments spanning {duration:.1f}s to {args.output_json} "
        f"in {elapsed:.1f}s",
        flush=True,
    )


if __name__ == "__main__":
    main()
