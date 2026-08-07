#!/usr/bin/env python3
"""
event_frames.py — Emit DENSE composite screenshots for only the moments
that key_moments.json flagged as high-signal.

Why this exists
---------------
The baseline screenshot cadence (one 3x2 composite per 6 seconds of
source, one panel per second) is fine for slow / talking-head footage
but too coarse for fast beats — a character reveal, a cut, or a punch
lands in a single frame that the baseline may or may not sample. The
downstream vision agent then either misses the beat entirely or has to
guess from a single ambiguous panel.

Rather than doubling the baseline (which would double vision-token
cost across the whole video), we spend the extra frame budget ONLY on
the moments we already know are important — the ones on the
`key_moments.json` shortlist that have `is_shot_boundary=true` OR
`introduces_person=true`.

For each such moment we emit ONE extra 3x2 composite covering ±2s
around the moment's start (a 4-second window sampled at 2 frames per
second = 8 samples fit into a 3x3 grid — we use 3x2 = 6 for
consistency with the baseline layout the agent already understands,
sampling at 0.66s intervals so we cover the full 4s span).

Total extra frames are ~= (# high-signal moments) which for a typical
video is <10% of the baseline frame count. Cost stays flat, resolution
at the important moments jumps ~4x.

Output filenames are:

    event_<start_ms>.jpg     # zero-padded to 9 digits: event_000042500.jpg

placed alongside the baseline `frame_NNNNNN.jpg` files in the same
screenshots directory. The agent is told about them in
00_READ_THIS_FIRST.txt.

Usage
-----
    python event_frames.py <compressed_video> <key_moments_json>
                           <screenshots_out_dir>
                           [--window-seconds 4]
                           [--samples 6]
                           [--panel-width 640]
                           [--max-events 30]
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys


def emit_event_composite(
    video_path: str,
    center_seconds: float,
    dst_path: str,
    window_seconds: float,
    samples: int,
    panel_width: int,
) -> bool:
    """
    Extract `samples` frames evenly spaced across a `window_seconds`
    window centered on `center_seconds`, tile them into a 3x2 composite,
    and write to `dst_path`. Returns True on success.
    """
    half = window_seconds / 2.0
    start = max(0.0, center_seconds - half)
    # samples evenly spaced across the window
    fps = samples / window_seconds

    # 3x2 tile requires exactly 6 input frames per tile. If the user
    # requests a non-multiple-of-6 sample count we still tile 3x2 and
    # drop the excess — this keeps layout consistent with the baseline.
    tile_layout = "3x2"

    vf = (
        f"fps={fps:.6f},"
        f"scale='min({panel_width},iw)':'-2',"
        f"tile={tile_layout}:padding=2:margin=2:color=black"
    )
    cmd = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-t", f"{window_seconds:.3f}",
        "-i", video_path,
        "-vf", vf,
        "-frames:v", "1",
        "-qscale:v", "5",
        dst_path,
    ]
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        return os.path.isfile(dst_path) and os.path.getsize(dst_path) > 0
    except subprocess.CalledProcessError as e:
        print(
            f"  event-composite ffmpeg failed @ {center_seconds:.2f}s: "
            f"{e.stderr.decode(errors='replace')[-400:]}",
            file=sys.stderr,
        )
        return False


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("compressed_video")
    ap.add_argument("key_moments_json")
    ap.add_argument("screenshots_out_dir")
    ap.add_argument("--window-seconds", type=float, default=4.0)
    ap.add_argument("--samples", type=int, default=6)
    ap.add_argument("--panel-width", type=int, default=640)
    ap.add_argument(
        "--max-events",
        type=int,
        default=30,
        help="Hard cap on the number of dense event composites emitted, "
             "so a video with many cuts can't balloon the frame count.",
    )
    ap.add_argument(
        "--min-priority",
        type=float,
        default=0.35,
        help="Only moments with priority >= this get a dense composite.",
    )
    args = ap.parse_args()

    if not os.path.exists(args.compressed_video):
        print(f"Input video not found: {args.compressed_video}", file=sys.stderr)
        sys.exit(2)
    if not os.path.exists(args.key_moments_json):
        # No key moments file -> nothing to do, but this is not an error.
        print(
            f"No key_moments file at {args.key_moments_json}; "
            f"no event composites will be emitted.",
            flush=True,
        )
        return

    with open(args.key_moments_json, "r", encoding="utf-8") as f:
        km = json.load(f)

    moments = km.get("moments", [])
    if not moments:
        print("key_moments has no moments; nothing to do.", flush=True)
        return

    # Select high-signal moments. Priority-ranked, then chronological.
    high = [
        m for m in moments
        if m.get("signals", {}).get("is_shot_boundary")
        or m.get("signals", {}).get("introduces_person")
        or m.get("signals", {}).get("priority", 0.0) >= args.min_priority
    ]
    high.sort(key=lambda m: m["signals"].get("priority", 0.0), reverse=True)
    high = high[: args.max_events]
    high.sort(key=lambda m: m["start_seconds"])

    os.makedirs(args.screenshots_out_dir, exist_ok=True)
    written = 0
    for m in high:
        center = float(m["start_seconds"])
        # Filename encodes the CENTER of the event window in milliseconds,
        # zero-padded to 9 digits so files sort by time and never collide
        # with the baseline `frame_NNNNNN.jpg` naming.
        fname = f"event_{int(round(center * 1000)):09d}.jpg"
        dst = os.path.join(args.screenshots_out_dir, fname)
        ok = emit_event_composite(
            args.compressed_video,
            center,
            dst,
            args.window_seconds,
            args.samples,
            args.panel_width,
        )
        if ok:
            written += 1
            print(f"  event composite @ {center:.2f}s -> {fname}", flush=True)

    print(f"Wrote {written} event composite(s) to {args.screenshots_out_dir}", flush=True)


if __name__ == "__main__":
    main()
