#!/usr/bin/env python3
"""
Generate the 00_READ_THIS_FIRST.txt file that Stage A ships alongside the
transcript + screenshots. This file instructs the downstream AI agent how
to select cuts and what cuts.json shape to return.

The duration and frame filename convention are substituted from the actual
Stage A run.

Usage:
    python generate_analysis_prompt.py <duration_seconds> <total_frames>
                                       <output_txt_path>
                                       [--target-duration 120]
                                       [--job-id JOB_ID]
"""
import argparse
import os
import textwrap


TEMPLATE = """\
================================================================================
  READ THIS FIRST — Anime episode cut-selection instructions for the AI agent
================================================================================

You have been given three artifacts from a Stage A run of the ClipForge
pipeline:

  1. transcript.json      — timestamped transcript of the episode's audio
  2. screenshots/*.jpg    — one screenshot per second of the (compressed)
                            episode video
  3. This file            — your instructions

Your job: choose the most engaging moments from this episode and output a
`cuts.json` file (schema at the bottom of this document) that ClipForge's
Stage B will use to slice the ORIGINAL full-quality video and stitch a
short-form commentary base.

--------------------------------------------------------------------------------
EPISODE METADATA (substituted by Stage A)
--------------------------------------------------------------------------------

  Job ID:                  {job_id}
  Full episode duration:   {duration_seconds} seconds ({duration_hms})
  Screenshots available:   frame_00000.jpg .. frame_{last_frame:05d}.jpg
                           (one frame per second, zero-padded 5-digit index
                            of seconds-since-start)
  Target output length:    ~{target_duration} seconds of cuts combined
                           (approximate — favor engagement over hitting the
                           number exactly)

--------------------------------------------------------------------------------
HOW TO SELECT CUTS (important — follow this order to keep vision tokens low)
--------------------------------------------------------------------------------

STEP 1. Read transcript.json FIRST.
        Look at the `segments` array. Each segment has `start`, `end`, and
        `text`. Everything you need to identify interesting moments is in
        the DIALOGUE, NARRATION, and TONAL SHIFTS in the transcript.

STEP 2. Identify candidate ranges purely from the transcript text.
        Prioritize:
          - Emotional peaks (shouting, whispered reveals, laughter, silence
            between heavy lines)
          - Plot beats (a character learning something, a betrayal, a
            confrontation, a decision)
          - Character-defining lines (memorable quotes, callbacks, threats)
          - Fight/action beats where dialogue signals impact
          - Cliffhanger-style openings or endings
        Skip:
          - Long silent expositional stretches
          - Recap/preview sections
          - OP/ED songs if the transcript makes them obvious

STEP 3. DO NOT browse the screenshots folder wholesale. Do not list-dir
        or scan-all it. Vision tokens are expensive.

STEP 4. Once you have a shortlist of candidate ranges, and ONLY THEN,
        fetch the specific screenshot(s) whose filename matches the
        timestamp(s) you want to visually confirm. Filename convention:

            frame_<seconds-since-start>.jpg    (zero-padded to 5 digits)

        e.g. for a moment around 4 minutes 32 seconds in, that is second
        272, so open `frame_00272.jpg`. To sanity-check the middle of a
        candidate cut from 142s to 168s, sample e.g. frame_00142.jpg,
        frame_00155.jpg, frame_00168.jpg — not the full folder.

STEP 5. Assemble cuts.

        - Order them chronologically by `start_seconds`.
        - Each cut should be self-contained enough that a viewer landing
          on it makes sense — favor cutting at natural sentence / beat
          boundaries from the transcript, not mid-word.
        - Target the sum of (end - start) across all cuts at roughly
          {target_duration} seconds. It does NOT need to be exact — prefer
          slightly longer or shorter if the engagement is better.
        - For each cut, write a `raw_narration` field: a plain description
          of what happens in that segment, written the way a viewer would
          describe it while watching. Not a script, not stylized — just
          the raw beats. This is what ClipForge feeds into the master
          conversion prompt to produce the final commentary.

--------------------------------------------------------------------------------
OUTPUT SCHEMA — cuts.json  (return EXACTLY this shape, no extra keys)
--------------------------------------------------------------------------------

{{
  "video_duration_seconds": {duration_seconds},
  "cuts": [
    {{
      "start_seconds": 142,
      "end_seconds": 168,
      "raw_narration": "plain description of what happens in this segment, written the way a viewer would describe it while watching"
    }}
    // ... more cuts, ordered chronologically ...
  ],
  "target_total_duration_seconds": {target_duration}
}}

CONSTRAINTS
  - `start_seconds` and `end_seconds` are integers, in seconds since the
    start of the episode. `end_seconds > start_seconds`. Both must lie
    within [0, {duration_seconds}].
  - Cuts MUST NOT overlap.
  - Cuts MUST be sorted ascending by `start_seconds`.
  - `raw_narration` is plain prose. No markdown, no timestamps inside it,
    no character-name guessing when unsure — use descriptive tags like
    "the researcher" if unclear.
  - Return ONLY the JSON, no surrounding prose, no code fences. It will
    be uploaded verbatim to ClipForge Stage B.

================================================================================
"""


def hms(sec: int) -> str:
    h, r = divmod(sec, 3600)
    m, s = divmod(r, 60)
    if h:
        return f"{h:d}h{m:02d}m{s:02d}s"
    return f"{m:d}m{s:02d}s"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("duration_seconds", type=int)
    ap.add_argument("total_frames", type=int)
    ap.add_argument("output_txt")
    ap.add_argument("--target-duration", type=int, default=120)
    ap.add_argument("--job-id", default="(unknown)")
    args = ap.parse_args()

    last_frame = max(args.total_frames - 1, 0)
    content = TEMPLATE.format(
        job_id=args.job_id,
        duration_seconds=args.duration_seconds,
        duration_hms=hms(args.duration_seconds),
        last_frame=last_frame,
        target_duration=args.target_duration,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output_txt)) or ".", exist_ok=True)
    with open(args.output_txt, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Wrote analysis prompt to {args.output_txt} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
