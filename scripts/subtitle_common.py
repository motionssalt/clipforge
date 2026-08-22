#!/usr/bin/env python3
"""Shared word-timing, script-alignment, and media helpers for cinematic captions.

This module deliberately contains no caption renderer or template styling. It
provides only the common transcription-timing and authoritative-script alignment
contract used by the sole remaining cinematic renderer.
"""
from __future__ import annotations

import difflib
import json
import os
import re
import subprocess
import sys

# Minimum durations keep timing stable when faster-whisper produces an
# unusually short word or the script has no direct transcription counterpart.
MIN_WORD_SECONDS = 0.08
MIN_DISPLAY_SECONDS = 0.12
_WORD_RE = re.compile(r"\S+")


def sh(cmd: list[str]) -> None:
    """Run a command while streaming its output for workflow diagnostics."""
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_video_size(path: str) -> tuple[int, int]:
    """Return the width and height of the input video stream."""
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height",
            "-of", "json",
            path,
        ],
        text=True,
    )
    streams = json.loads(out).get("streams", [])
    if not streams:
        print(f"ERROR: no video stream in {path}", file=sys.stderr)
        sys.exit(3)
    return int(streams[0]["width"]), int(streams[0]["height"])


def transcribe_words(voiceover_wav: str, model: str, lang: str,
                     work_dir: str) -> list[dict]:
    """Transcribe the merged voiceover into word-level timing events only."""
    from faster_whisper import WhisperModel  # delayed optional dependency

    print(f"Transcribing merged voiceover for word timings: {voiceover_wav}",
          flush=True)
    wm = WhisperModel(model, device="cpu", compute_type="int8")
    vad_parameters = {
        "threshold": 0.5,
        "min_speech_duration_ms": 250,
        "min_silence_duration_ms": 1000,
        "speech_pad_ms": 200,
        "max_speech_duration_s": 30.0,
    }
    segments, info = wm.transcribe(
        voiceover_wav,
        language=None if lang == "auto" else lang,
        beam_size=5,
        vad_filter=True,
        vad_parameters=vad_parameters,
        word_timestamps=True,
        condition_on_previous_text=False,
    )
    print(
        f"Detected language: {info.language} "
        f"(prob={info.language_probability:.2f})",
        flush=True,
    )

    words: list[dict] = []
    for seg in segments:
        for word in (getattr(seg, "words", None) or []):
            text = (word.word or "").strip()
            if not text:
                continue
            start = float(word.start)
            end = max(float(word.end), start + MIN_WORD_SECONDS)
            words.append({"start": round(start, 3), "end": round(end, 3),
                          "word": text})
    if not words:
        print(
            "ERROR: transcription produced zero words. The merged voiceover "
            "WAV is either silent or unreadable — check upstream steps.",
            file=sys.stderr,
        )
        sys.exit(3)
    print(f"Transcribed {len(words)} words "
          f"({words[0]['start']:.2f}s .. {words[-1]['end']:.2f}s)",
          flush=True)

    transcript_path = os.path.join(work_dir, "voiceover_words.json")
    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump({"backend": "faster-whisper", "model": model,
                   "language": info.language, "words": words},
                  f, ensure_ascii=False, indent=2)
    print(f"Word transcript written: {transcript_path}", flush=True)
    return words


def _norm_token(text: str) -> str:
    """Normalise a token for alignment and metadata lookup, never display."""
    return re.sub(r"[^0-9a-z]+", "", text.lower())


def align_words_to_script(timed_words: list[dict],
                          script_texts: list[str]) -> list[dict]:
    """Map authoritative script wording onto the transcription timing line.

    Timed words are partitioned by script-cut word counts, then matched within
    each cut with a monotone sequence alignment. This preserves original script
    wording while gracefully handling contractions, insertions, and omissions
    in transcription output.
    """
    script_cuts = [_WORD_RE.findall(text) for text in script_texts]
    total_script = sum(len(cut) for cut in script_cuts)
    if total_script == 0:
        print("ERROR: the original script contains no words at all.",
              file=sys.stderr)
        sys.exit(3)

    timed = list(timed_words)
    n_timed = len(timed)
    if n_timed < total_script:
        print(
            f"NOTE: transcription produced {n_timed} timed words but the "
            f"script has {total_script}. Scaling per-cut timing quotas "
            "proportionally — wording is unaffected (script is always "
            "displayed verbatim).",
            flush=True,
        )
        quotas: list[int] = []
        assigned = 0
        remaining_timed = n_timed
        remaining_script = total_script
        for cut in script_cuts:
            quota = min(len(cut), int(round(
                remaining_timed * len(cut) / max(remaining_script, 1))))
            quotas.append(quota)
            assigned += quota
            remaining_timed -= quota
            remaining_script -= len(cut)
        if quotas:
            quotas[-1] += n_timed - assigned
    else:
        quotas = [len(cut) for cut in script_cuts]
        leftover = n_timed - total_script
        if leftover > 0:
            print(
                f"NOTE: transcription produced {leftover} more word(s) "
                "than the script contains; extras are ignored for display "
                "(script is authoritative).",
                flush=True,
            )
            quotas[-1] += leftover

    display_events: list[dict] = []
    cursor = 0
    previous_end = 0.0
    for cut_i, script_words in enumerate(script_cuts):
        quota = quotas[cut_i]
        window = timed[cursor:cursor + quota]
        cursor += quota
        if not window:
            current = previous_end
            for word in script_words:
                display_events.append({
                    "start": round(current, 3),
                    "end": round(current + MIN_DISPLAY_SECONDS, 3),
                    "word": word,
                })
                current += MIN_DISPLAY_SECONDS
            previous_end = current
            continue

        window_start = window[0]["start"]
        window_end = window[-1]["end"]
        script_tokens = [_norm_token(word) for word in script_words]
        timed_tokens = [_norm_token(word["word"]) for word in window]
        matcher = difflib.SequenceMatcher(
            a=script_tokens, b=timed_tokens, autojunk=False)

        starts: list[float | None] = [None] * len(script_words)
        ends: list[float | None] = [None] * len(script_words)
        for tag, i1, i2, j1, j2 in matcher.get_opcodes():
            if tag not in ("equal", "replace"):
                continue
            script_span = i2 - i1
            timed_span = j2 - j1
            for k in range(script_span):
                fraction_start = k / script_span
                fraction_end = (k + 1) / script_span
                timed_start = j1 + int(fraction_start * timed_span)
                timed_end = j1 + max(
                    int(fraction_end * timed_span),
                    int(fraction_start * timed_span) + 1,
                )
                timed_end = min(timed_end, j2)
                starts[i1 + k] = window[timed_start]["start"]
                ends[i1 + k] = window[max(timed_start, timed_end - 1)]["end"]

        last_time = window_start
        for index in range(len(script_words)):
            if starts[index] is None:
                starts[index] = last_time
                ends[index] = last_time + MIN_DISPLAY_SECONDS
            else:
                if starts[index] < last_time:
                    starts[index] = last_time
                ends[index] = max(ends[index] or 0.0,
                                  starts[index] + MIN_DISPLAY_SECONDS)
            if starts[index] > window_end:
                starts[index] = window_end
                ends[index] = max(ends[index] or 0.0,
                                  starts[index] + MIN_DISPLAY_SECONDS)
            last_time = starts[index]

        for index, word in enumerate(script_words):
            display_events.append({
                "start": round(starts[index], 3),
                "end": round(ends[index], 3),
                "word": word,
            })
        previous_end = display_events[-1]["end"]

    assert cursor == n_timed, "timed-word partition bookkeeping drifted"
    print(
        f"Aligned {sum(len(cut) for cut in script_cuts)} script word(s) from "
        f"{len(script_cuts)} cut(s) onto {n_timed} transcribed timing "
        "events. Subtitle wording = ORIGINAL SCRIPT (verbatim).",
        flush=True,
    )
    return display_events


def _ass_time(seconds: float) -> str:
    """Format an ASS timestamp as H:MM:SS.cc."""
    if seconds < 0:
        seconds = 0.0
    centiseconds = int(round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    seconds_part, fraction = divmod(remainder, 100)
    return f"{hours:d}:{minutes:02d}:{seconds_part:02d}.{fraction:02d}"


def _ass_escape(text: str) -> str:
    """Escape ASS dialogue control characters."""
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")
