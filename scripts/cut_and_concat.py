#!/usr/bin/env python3
"""
Stage B core: read cuts.json, cut the ORIGINAL full-quality video at each
range, concatenate the segments, write the final MP4 preserving source
quality, and produce output.txt = MASTER_PROMPT.md + separator + raw_narration
fields concatenated in order.

Uses ffmpeg (available on GitHub ubuntu-latest runners by default).

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


def cut_segment(src: str, start: float, end: float, dst: str) -> None:
    """
    Cut a single segment losslessly-where-possible.

    We re-encode video/audio with high-quality settings for this segment so
    that concatenation is safe across arbitrary keyframe positions. Using
    stream-copy across arbitrary cut points can leave black frames or A/V
    drift at segment boundaries, so we take the small re-encode cost per
    segment in exchange for reliable concat.
    """
    duration = max(end - start, 0.01)
    sh([
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-i", src,
        "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "17",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        "-avoid_negative_ts", "make_zero",
        dst,
    ])


def concat_segments(segment_paths: list[str], dst: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
        for p in segment_paths:
            f.write(f"file '{os.path.abspath(p)}'\n")
        list_path = f.name
    try:
        # Since every segment was re-encoded above with matching codecs/params,
        # concat demuxer + stream copy is safe here.
        sh([
            "ffmpeg", "-y",
            "-f", "concat", "-safe", "0",
            "-i", list_path,
            "-c", "copy",
            "-movflags", "+faststart",
            dst,
        ])
    finally:
        try:
            os.unlink(list_path)
        except OSError:
            pass


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
    try:
        for i, c in enumerate(cuts):
            seg_dst = os.path.join(workdir, f"seg_{i:04d}.mp4")
            cut_segment(args.original_video, float(c["start_seconds"]), float(c["end_seconds"]), seg_dst)
            seg_paths.append(seg_dst)

        os.makedirs(os.path.dirname(os.path.abspath(args.out_video_mp4)) or ".", exist_ok=True)
        concat_segments(seg_paths, args.out_video_mp4)
        print(f"Final video written: {args.out_video_mp4}", flush=True)

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
