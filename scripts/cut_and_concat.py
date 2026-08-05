#!/usr/bin/env python3
"""
Stage B core: read cuts.json, cut the ORIGINAL full-quality video at each
range, concatenate the segments, write the final MP4 preserving source
quality, and produce output.txt = MASTER_PROMPT.md + separator + raw_narration
fields concatenated in order.

Uses ffmpeg (available on GitHub ubuntu-latest runners by default).

Quality policy:
  - If the source codecs are already MP4-compatible (H.264/AVC video and
    AAC audio), we stream-copy into a proper MP4 container for zero
    quality loss and maximum speed.
  - If the source codecs are NOT MP4-compatible (e.g. VP9, HEVC in MKV,
    certain audio codecs), we re-encode with near-lossless settings
    (libx264 CRF 17, AAC 192 kbps) to preserve quality while producing
    a valid MP4.

Usage:
    python cut_and_concat.py <original_video> <cuts_json> <master_prompt_md>
                             <out_video_mp4> <out_text_path>
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile


def sh(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_duration(path: str) -> float:
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        text=True,
    ).strip()
    return float(out)


def probe_source_codecs(path: str) -> dict:
    """
    Return a dict with the source video and audio codec names, plus a flag
    indicating whether the codecs are already MP4-compatible (H.264 + AAC).
    """
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_name,codec_type",
            "-of", "json",
            path,
        ],
        text=True,
    )
    data = json.loads(out)
    streams = data.get("streams", [])
    video_codec = "unknown"
    audio_codec = "unknown"
    for s in streams:
        ct = s.get("codec_type", "")
        cn = s.get("codec_name", "unknown")
        if ct == "video" and video_codec == "unknown":
            video_codec = cn
        if ct == "audio" and audio_codec == "unknown":
            audio_codec = cn

    # MP4-compatible codecs: h264/avc1 for video, aac/mp4a for audio
    mp4_video_ok = video_codec.lower() in ("h264", "avc1")
    mp4_audio_ok = audio_codec.lower() in ("aac", "mp4a")

    return {
        "video_codec": video_codec,
        "audio_codec": audio_codec,
        "mp4_compatible": mp4_video_ok and mp4_audio_ok,
    }


def cut_segment_stream_copy(src: str, start: float, end: float, dst: str) -> None:
    """
    Cut a segment using stream copy when source codecs are MP4-compatible.
    This preserves original quality with zero re-encoding.
    """
    duration = max(end - start, 0.01)
    sh([
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", src,
        "-t", f"{duration:.3f}",
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-f", "mp4",
        dst,
    ])


def cut_segment_reencode(src: str, start: float, end: float, dst: str) -> None:
    """
    Cut a segment by re-encoding with near-lossless settings.
    Used when source codecs are not MP4-compatible.
    libx264 CRF 17 is visually indistinguishable from the source.
    AAC at 192 kbps preserves audio quality.
    """
    duration = max(end - start, 0.01)
    sh([
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", src,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
        "-c:a", "aac", "-b:a", "192k",
        "-avoid_negative_ts", "make_zero",
        "-f", "mp4",
        dst,
    ])


def concat_segments(segment_paths: list[str], dst: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in segment_paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
        list_path = f.name
    try:
        # Since every segment was produced with matching codecs/params,
        # concat demuxer + stream copy is safe here.
        sh([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            "-movflags", "+faststart",
            "-f", "mp4",
            dst,
        ])
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass


def validate_mp4(path: str) -> None:
    """
    Verify that the output file is a genuine, valid MP4 file by running
    ffprobe and checking:
      1. The format is detected as MP4/MOV (ftyp box present)
      2. There is at least one video stream
      3. There is at least one audio stream
      4. ffprobe exits successfully with no errors
    Raises SystemExit if validation fails.
    """
    print(f"\nValidating output MP4: {path}", flush=True)

    if not os.path.isfile(path):
        print(f"ERROR: Output file does not exist: {path}", file=sys.stderr)
        sys.exit(3)

    # Check file signature: MP4 files have an ftyp box near the start
    with open(path, "rb") as f:
        sig = f.read(12)
    if len(sig) < 12 or sig[4:8] != b"ftyp":
        print(
            f"ERROR: Output file is NOT a valid MP4 "
            f"(missing ftyp box at offset 4, got: {sig[4:8]!r})",
            file=sys.stderr,
        )
        sys.exit(3)

    # Run ffprobe to verify the file is parseable and has video+audio
    probe_out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "stream=codec_type,codec_name,width,height",
            "-show_entries", "format=format_name,format_long_name,duration,bit_rate",
            "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    if probe_out.returncode != 0:
        print(
            f"ERROR: ffprobe failed on output file:\n{probe_out.stderr}",
            file=sys.stderr,
        )
        sys.exit(3)

    probe_data = json.loads(probe_out.stdout)
    streams = probe_data.get("streams", [])

    has_video = any(s.get("codec_type") == "video" for s in streams)
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    fmt_info = probe_data.get("format", {})
    fmt_name = fmt_info.get("format_name", "unknown")

    print(f"  Format: {fmt_info.get('format_long_name', 'unknown')} ({fmt_name})", flush=True)
    print(f"  Duration: {fmt_info.get('duration', 'unknown')}s", flush=True)
    print(f"  Bit rate: {fmt_info.get('bit_rate', 'unknown')} bps", flush=True)

    for i, s in enumerate(streams):
        ct = s.get("codec_type", "unknown")
        cn = s.get("codec_name", "unknown")
        if ct == "video":
            w, h = s.get("width", "?"), s.get("height", "?")
            print(f"  Video stream #{i}: {cn} @ {w}x{h}", flush=True)
        elif ct == "audio":
            print(f"  Audio stream #{i}: {cn}", flush=True)

    if not has_video:
        print("ERROR: Output file has no video stream", file=sys.stderr)
        sys.exit(3)
    if not has_audio:
        print("ERROR: Output file has no audio stream", file=sys.stderr)
        sys.exit(3)

    print("  Validation PASSED: output is a valid MP4 file.\n", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("original_video")
    ap.add_argument("cuts_json")
    ap.add_argument("master_prompt_md")
    ap.add_argument("out_video_mp4")
    ap.add_argument("out_text_path")
    args = ap.parse_args()

    for req in (args.original_video, args.cuts_json, args.master_prompt_md):
        if not os.path.exists(req):
            print(f"Missing required input: {req}", file=sys.stderr)
            sys.exit(2)

    with open(args.cuts_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    cuts = payload.get("cuts") or []
    if not cuts:
        print("cuts.json contains no cuts", file=sys.stderr)
        sys.exit(2)

    # Sort defensively, validate.
    cuts = sorted(cuts, key=lambda c: float(c["start_seconds"]))
    src_duration = probe_duration(args.original_video)
    print(f"Source video duration: {src_duration:.2f}s", flush=True)

    # Detect source codecs to decide on processing strategy
    codec_info = probe_source_codecs(args.original_video)
    print(f"Source codecs: video={codec_info['video_codec']}, audio={codec_info['audio_codec']}", flush=True)
    if codec_info["mp4_compatible"]:
        print("Source codecs are MP4-compatible → using stream-copy (zero quality loss)", flush=True)
    else:
        print(
            f"Source codecs are NOT MP4-compatible → will re-encode with "
            f"libx264 CRF 17 + AAC 192k (near-lossless)",
            flush=True,
        )

    prev_end = -1.0
    for i, c in enumerate(cuts):
        s = float(c["start_seconds"])
        e = float(c["end_seconds"])
        if e <= s:
            print(f"Cut #{i}: end ({e}) <= start ({s})", file=sys.stderr)
            sys.exit(2)
        if s < 0 or e > src_duration + 0.5:
            print(f"Cut #{i}: range [{s}, {e}] outside source [0, {src_duration:.2f}]", file=sys.stderr)
            sys.exit(2)
        if s < prev_end:
            print(f"Cut #{i}: overlaps previous cut ({s} < prev end {prev_end})", file=sys.stderr)
            sys.exit(2)
        prev_end = e

    workdir = tempfile.mkdtemp(prefix="clipforge_cuts_")
    print(f"Working dir: {workdir}", flush=True)
    seg_paths: list[str] = []

    # Select the cut function based on codec compatibility
    cut_fn = cut_segment_stream_copy if codec_info["mp4_compatible"] else cut_segment_reencode

    try:
        for i, c in enumerate(cuts):
            seg_dst = os.path.join(workdir, f"seg_{i:04d}.mp4")
            cut_fn(args.original_video, float(c["start_seconds"]), float(c["end_seconds"]), seg_dst)
            seg_paths.append(seg_dst)

        os.makedirs(os.path.dirname(os.path.abspath(args.out_video_mp4)) or ".", exist_ok=True)
        concat_segments(seg_paths, args.out_video_mp4)
        print(f"Final video written: {args.out_video_mp4}", flush=True)

        # Validate the output is a genuine MP4
        validate_mp4(args.out_video_mp4)

        with open(args.master_prompt_md, "r", encoding="utf-8") as f:
            master_prompt = f.read()

        narrations = []
        for c in cuts:
            n = (c.get("raw_narration") or "").strip()
            if n:
                narrations.append(n)

        separator = "\n\n" + ("=" * 80) + "\n" + "RAW NARRATION NOTES (paste after the prompt above)\n" + ("=" * 80) + "\n\n"
        combined_narration = "\n\n".join(narrations)

        os.makedirs(os.path.dirname(os.path.abspath(args.out_text_path)) or ".", exist_ok=True)
        with open(args.out_text_path, "w", encoding="utf-8") as f:
            f.write(master_prompt.rstrip() + separator + combined_narration + "\n")
        print(f"output.txt written: {args.out_text_path}", flush=True)

    finally:
        shutil.rmtree(workdir, ignore_errors=True)


if __name__ == "__main__":
    main()
