"""ClipForge Stage A — transcription (faster-whisper, CPU-only).

Ported verbatim (semantics unchanged) from ``_legacy/scripts/transcribe.py``
into the new ``pipeline/stage_a/`` layout. Transcribes an audio (or video)
file to a timestamped ``transcript.json`` using faster-whisper running
locally on CPU. No external APIs, no API keys.

The transcription is behind a small ``Transcriber`` protocol so a different
backend could be dropped in later, but the default and only shipped
implementation is local faster-whisper.

The VAD/segment-end correction logic (clipping swallowed silence gaps out of
segment ``end`` timestamps) is hard-won and preserved exactly — see the
tuning block below.

Usage:
    python -m pipeline.stage_a.transcribe <input> <output_json>
        [--model base|small|tiny] [--lang en|auto|ja|...] (default: en)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Iterable, Protocol


class Segment(dict):
    """Typed dict-ish shape: {id, start, end, text}."""


class Transcriber(Protocol):
    def transcribe(self, path: str) -> Iterable[Segment]: ...


# ---------------------------------------------------------------------------
# Segment-boundary tuning (preserved — see legacy header comment)
#
# faster-whisper's VAD splits the audio into speech chunks, but Whisper's
# decoder still assigns segment "end" timestamps on the ORIGINAL timeline.
# When a segment lands next to a long non-speech gap, the decoder's
# end-timestamp can drift far past when speech actually stopped. To keep
# segment ends honest we (1) tighten Silero VAD, (2) request word
# timestamps, and (3) post-process every segment end.
# ---------------------------------------------------------------------------

MAX_TRAILING_SILENCE_S = 0.75
MAX_SEGMENT_DURATION_S = 30.0
FALLBACK_CHARS_PER_SEC = 15.0
FALLBACK_MIN_DURATION_S = 1.5


def _clip_segment_end(start: float, end: float, text: str, words) -> float:
    """Return a corrected segment end reflecting when speech actually stopped."""
    corrected = end

    if words:
        last_word_end = None
        for w in words:
            we = getattr(w, "end", None)
            if we is None and isinstance(w, dict):
                we = w.get("end")
            if we is not None:
                last_word_end = float(we)
        if last_word_end is not None:
            padded = last_word_end + MAX_TRAILING_SILENCE_S
            if corrected > padded:
                corrected = padded
            if corrected < last_word_end:
                corrected = last_word_end
    else:
        est = max(
            FALLBACK_MIN_DURATION_S,
            len((text or "").strip()) / FALLBACK_CHARS_PER_SEC,
        )
        est_end = start + est + MAX_TRAILING_SILENCE_S
        if corrected > est_end:
            corrected = est_end

    if corrected - start > MAX_SEGMENT_DURATION_S:
        corrected = start + MAX_SEGMENT_DURATION_S

    if corrected <= start:
        corrected = start + FALLBACK_MIN_DURATION_S

    return corrected


def _verify_onnxruntime_importable() -> None:
    """Eagerly import onnxruntime and surface the REAL failure if it can't load.

    faster-whisper's VAD path re-raises a misleading "requires the onnxruntime
    package" when the true cause is an ABI/manylinux mismatch. Importing here
    first keeps the original traceback in the run log.
    """
    try:
        import onnxruntime  # noqa: F401
    except Exception as e:  # noqa: BLE001 — we want to see EVERY failure mode
        raise RuntimeError(
            "onnxruntime failed to import at transcription time. faster-whisper's "
            "VAD filter will hit this same failure and hide it behind a "
            "'requires the onnxruntime package' message. The underlying error "
            f"is: {type(e).__name__}: {e}. Check pipeline/requirements.txt — "
            "this almost always means an ABI mismatch between the installed "
            "onnxruntime wheel and the resolved NumPy version."
        ) from e


class FasterWhisperTranscriber:
    """Default (and currently only) transcriber — CPU-only faster-whisper.

    Model size is intentionally capped at 'small' — 'large' is too slow on
    the Actions runner CPU.
    """

    ALLOWED_SIZES = {"tiny", "base", "small"}

    def __init__(self, model_size: str = "base", language: str = "en"):
        if model_size not in self.ALLOWED_SIZES:
            raise ValueError(
                f"model_size must be one of {sorted(self.ALLOWED_SIZES)} (CPU perf cap), got {model_size!r}"
            )
        # Import lazily so the module is importable without the dep for tests.
        from faster_whisper import WhisperModel  # type: ignore

        _verify_onnxruntime_importable()

        print(f"Loading faster-whisper model: {model_size} (CPU, int8)", flush=True)
        t0 = time.time()
        self.model = WhisperModel(model_size, device="cpu", compute_type="int8")
        print(f"Model loaded in {time.time() - t0:.1f}s", flush=True)
        self.language = None if language == "auto" else language

    def transcribe(self, path: str) -> Iterable[Segment]:
        print(f"Transcribing {path} (language={self.language or 'auto-detect'})", flush=True)

        vad_parameters = {
            "threshold": 0.5,
            "min_speech_duration_ms": 250,
            "min_silence_duration_ms": 1000,
            "speech_pad_ms": 200,
            "max_speech_duration_s": 30.0,
        }

        segments, info = self.model.transcribe(
            path,
            language=self.language,
            beam_size=5,
            vad_filter=True,
            vad_parameters=vad_parameters,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        print(
            f"Detected language: {info.language} (prob={info.language_probability:.2f}), "
            f"duration={info.duration:.1f}s",
            flush=True,
        )

        i = 0
        for seg in segments:
            raw_start = float(seg.start)
            raw_end = float(seg.end)
            text = (seg.text or "").strip()
            words = getattr(seg, "words", None)

            corrected_end = _clip_segment_end(raw_start, raw_end, text, words)

            if corrected_end < raw_end - 0.01:
                print(
                    f"  [vad-fix] seg {i}: end {raw_end:.2f}s -> {corrected_end:.2f}s "
                    f"(text={text[:40]!r})",
                    flush=True,
                )

            yield Segment(
                id=i,
                start=round(raw_start, 3),
                end=round(corrected_end, 3),
                text=text,
            )
            i += 1


def build_default_transcriber(model_size: str, language: str) -> Transcriber:
    """Single choke point for choosing the backend. Swap here if ever needed."""
    return FasterWhisperTranscriber(model_size=model_size, language=language)


def transcribe_to_json(
    input_path: str,
    output_json: str,
    *,
    model: str = "base",
    language: str = "en",
) -> dict:
    """Transcribe ``input_path`` and write the transcript payload to disk.

    Returns the payload dict. This is the library entry point used by the
    Stage A orchestrator; the CLI wraps it.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"input not found: {input_path}")

    tx = build_default_transcriber(model, language)
    segs: list[Segment] = []
    t0 = time.time()
    for seg in tx.transcribe(input_path):
        segs.append(seg)
        if seg["id"] % 25 == 0:
            print(f"  [{seg['start']:8.2f}s] {seg['text'][:80]}", flush=True)
    elapsed = time.time() - t0

    duration = segs[-1]["end"] if segs else 0.0
    payload = {
        "backend": "faster-whisper",
        "model": model,
        "language_hint": language,
        "audio_duration_seconds": duration,
        "generated_at_epoch": int(time.time()),
        "segments": segs,
    }

    os.makedirs(os.path.dirname(os.path.abspath(output_json)) or ".", exist_ok=True)
    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    print(
        f"Wrote {len(segs)} segments spanning {duration:.1f}s to {output_json} "
        f"in {elapsed:.1f}s",
        flush=True,
    )
    return payload


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("input_path")
    ap.add_argument("output_json")
    ap.add_argument("--model", default="base", choices=sorted(FasterWhisperTranscriber.ALLOWED_SIZES))
    ap.add_argument("--lang", default="en")
    args = ap.parse_args()

    if not os.path.exists(args.input_path):
        print(f"Input not found: {args.input_path}", file=sys.stderr)
        sys.exit(2)

    transcribe_to_json(args.input_path, args.output_json, model=args.model, language=args.lang)


if __name__ == "__main__":
    main()


__all__ = [
    "Segment",
    "Transcriber",
    "FasterWhisperTranscriber",
    "build_default_transcriber",
    "transcribe_to_json",
]
