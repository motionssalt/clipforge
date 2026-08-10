#!/usr/bin/env python3
"""
Stage B step 3 of 3: transcribe the merged voiceover for word-level
timestamps and burn word-by-word animated subtitles into the final video.

Runs AFTER cut_and_produce.py, which produces the merged video and a
standalone merged voiceover WAV. The voiceover WAV (not the video's
mixed audio, which may also carry background music) is what gets
transcribed — music under speech would only degrade the word timing.

Subtitles are one word on screen at a time, timed to that word's
transcribed timestamp, in the word-by-word style that dominates
short-form vertical video. Styling is deliberately oversized — bold,
white fill, thick black outline, bottom-third, horizontally centered —
because the output is watched on phones, where too-small caption styling
is the single most common readability failure.

Transcription reuses scripts/transcribe.py's faster-whisper backend with
word_timestamps already enabled; this script drives it through its CLI
(rather than reimplementing the model call) and then re-reads the word
timings out of the audio with a second, word-focused pass — see below.

Rendering uses an ASS subtitle file with one timed event per word, burned
in by ffmpeg's libass `subtitles=` filter. Per-word drawtext would need
hundreds of filter chains; ASS events are exactly the tool for this.

Usage:
    python generate_subtitles.py <merged_video_mp4> <voiceover_wav>
                                 <out_video_mp4>
                                 [--model base|small|tiny] [--lang auto|en|...]
                                 [--transcript-json <path>] [--keep-work]

Exit codes match the rest of the repo: 2 = bad input, 3 = validation
failure, subprocess failures propagate from sh().
"""
import argparse
import json
import os
import subprocess
import sys


# ---------- Subtitle styling ----------
# Bottom-third, centered, big enough to read on a phone held at arm's
# length. ASS coordinates below assume the video's real resolution (the
# filter is given the video size via the original file, so FontSize is in
# output pixels at the ASS PlayRes we declare — we set PlayRes to the
# video's own resolution at render time, so sizes are honest pixels).
SUB_FONT = "DejaVu Sans"
SUB_FONT_FRACTION_OF_HEIGHT = 0.055   # ~5.5% of frame height — phone-first
SUB_OUTLINE_FRACTION = 0.0035         # stroke thickness vs frame height
SUB_MARGIN_V_FRACTION = 0.22          # bottom-third placement
# Minimum/maximum on-screen time per word so very fast or very slow words
# still read naturally; gaps longer than WORD_GAP_MERGE_S between words
# of the same phrase simply leave the screen empty.
MIN_WORD_SECONDS = 0.08


def sh(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_video_size(path: str) -> tuple[int, int]:
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
    """
    Get word-level timestamps for the merged voiceover.

    transcribe.py's CLI writes segment-level JSON only (it clips segment
    ends USING the word timings but doesn't serialize them), so the word
    pass runs here through the same faster-whisper backend and the same
    VAD/decoder settings as transcribe.py — same model, same CPU/int8
    config, word_timestamps=True — keeping the two from drifting apart.
    """
    from faster_whisper import WhisperModel  # noqa: delayed import

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
        for w in (getattr(seg, "words", None) or []):
            text = (w.word or "").strip()
            if not text:
                continue
            start = float(w.start)
            end = max(float(w.end), start + MIN_WORD_SECONDS)
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

    # Persist for debugging/re-runs.
    transcript_path = os.path.join(work_dir, "voiceover_words.json")
    with open(transcript_path, "w", encoding="utf-8") as f:
        json.dump({"backend": "faster-whisper", "model": model,
                   "language": info.language, "words": words},
                  f, ensure_ascii=False, indent=2)
    print(f"Word transcript written: {transcript_path}", flush=True)
    return words


def _ass_time(seconds: float) -> str:
    """ASS timestamp: H:MM:SS.cc (centiseconds)."""
    if seconds < 0:
        seconds = 0.0
    cs = int(round(seconds * 100))
    h, r = divmod(cs, 360000)
    m, r = divmod(r, 6000)
    s, c = divmod(r, 100)
    return f"{h:d}:{m:02d}:{s:02d}.{c:02d}"


def _ass_escape(text: str) -> str:
    # ASS special chars in dialogue: braces and backslash.
    return text.replace("\\", "\\\\").replace("{", "\\{").replace("}", "\\}")


def write_ass(words: list[dict], width: int, height: int, out_ass: str) -> None:
    """
    One ASS Dialogue event per word — the word pops on at its start time
    and off at its end time, so exactly one word is ever on screen.
    """
    font_size = max(24, int(round(height * SUB_FONT_FRACTION_OF_HEIGHT)))
    outline = max(2, int(round(height * SUB_OUTLINE_FRACTION)))
    margin_v = int(round(height * SUB_MARGIN_V_FRACTION))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,{SUB_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,{outline},0,2,40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for w in words:
        lines.append(
            f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},"
            f"Word,,0,0,0,,{_ass_escape(w['word'])}\n"
        )
    with open(out_ass, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"ASS subtitle file written: {out_ass} "
          f"({len(words)} word events, font {font_size}px, "
          f"outline {outline}px)", flush=True)


def burn_subtitles(video: str, ass_path: str, dst: str) -> None:
    """
    Burn the ASS file in with libass and re-encode video with the SAME
    mobile-safe profile as cut_and_produce.py (the burn-in pass is a
    re-encode regardless, so we keep the exact phone-safe parameters
    rather than inheriting whatever ffmpeg would default to). Audio is
    stream-copied — it was already encoded to AAC-LC 48kHz stereo by
    cut_and_produce.py and must not be touched.
    """
    # Escape the ASS path for the filter (colons on Windows, quotes
    # everywhere); on the Linux runner a simple quoting suffices.
    ass_filter = ass_path.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    cmd = [
        "ffmpeg", "-y",
        "-i", video,
        "-vf", f"subtitles='{ass_filter}'",
        "-map", "0:v:0", "-map", "0:a:0",
        "-c:v", "libx264",
        "-profile:v", "high",
        "-level:v", "4.0",
        "-preset", "veryfast",
        "-crf", "18",
        "-pix_fmt", "yuv420p",
        "-bf", "0",
        "-g", "60", "-keyint_min", "60", "-sc_threshold", "0",
        "-x264-params", "force-cfr=1",
        "-video_track_timescale", "15360",
        "-c:a", "copy",
        "-movflags", "+faststart",
        "-use_editlist", "0",
        "-brand", "mp42",
        "-map_metadata", "-1",
        "-map_chapters", "-1",
        "-sn", "-dn", "-ignore_unknown",
        "-fflags", "+genpts",
        "-max_muxing_queue_size", "9999",
        "-f", "mp4",
        dst,
    ]
    sh(cmd)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("merged_video_mp4")
    ap.add_argument("voiceover_wav")
    ap.add_argument("out_video_mp4")
    ap.add_argument("--model", default="base", choices=["tiny", "base", "small"])
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--work-dir", default=None,
                    help="scratch dir for transcript + ASS (default: "
                         "<out dir>/subtitle_work)")
    args = ap.parse_args()

    for req in (args.merged_video_mp4, args.voiceover_wav):
        if not os.path.exists(req):
            print(f"Missing required input: {req}", file=sys.stderr)
            sys.exit(2)

    out_dir = os.path.dirname(os.path.abspath(args.out_video_mp4)) or "."
    os.makedirs(out_dir, exist_ok=True)
    work_dir = args.work_dir or os.path.join(out_dir, "subtitle_work")
    os.makedirs(work_dir, exist_ok=True)

    words = transcribe_words(args.voiceover_wav, args.model, args.lang,
                             work_dir)

    width, height = probe_video_size(args.merged_video_mp4)
    print(f"Video resolution: {width}x{height}", flush=True)

    ass_path = os.path.join(work_dir, "subtitles.ass")
    write_ass(words, width, height, ass_path)

    print(f"Burning subtitles into {args.out_video_mp4} ...", flush=True)
    burn_subtitles(args.merged_video_mp4, ass_path, args.out_video_mp4)
    print(f"Final subtitled video written: {args.out_video_mp4}", flush=True)


if __name__ == "__main__":
    main()
