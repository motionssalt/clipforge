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
  READ THIS FIRST — Source-video cut-selection instructions for the AI agent
================================================================================

You have been given three artifacts from a Stage A run of the ClipForge
pipeline:

  1. transcript.json      — timestamped transcript of the video's audio
  2. screenshots.zip      — a zip archive containing one JPEG screenshot
                            per second of the (compressed) source video.
                            Files inside are named frame_00000.jpg ..
                            frame_{last_frame:05d}.jpg (zero-padded 5-digit
                            index of seconds-since-start).
  3. This file            — your instructions

Your job: choose the most engaging moments from this video and output a
`cuts.json` file (schema at the bottom of this document) that ClipForge's
Stage B will use to slice the ORIGINAL full-quality video and stitch a
short-form commentary base.

--------------------------------------------------------------------------------
VIDEO METADATA (substituted by Stage A)
--------------------------------------------------------------------------------

  Job ID:                  {job_id}
  Full video duration:     {duration_seconds} seconds ({duration_hms})
  Screenshots available:   frame_00000.jpg .. frame_{last_frame:05d}.jpg
                           (one frame per second, zero-padded 5-digit index
                            of seconds-since-start, packaged inside
                            screenshots.zip)
  Target output length:    ~{target_duration} seconds of cuts combined
                           (approximate — favor engagement over hitting the
                           number exactly)

--------------------------------------------------------------------------------
ABOUT THE SCREENSHOTS ARCHIVE — read this carefully
--------------------------------------------------------------------------------

The screenshots ship as a single zip file (`screenshots.zip`) purely for
transport efficiency. Treat it as a normal working input:

  • EXTRACTING screenshots.zip is EXPECTED and REQUIRED. Do it up front,
    the same way you would unzip any other input archive. Extraction is
    a cheap local file operation — it does NOT consume vision tokens and
    does NOT count as "looking at" the images.

  • What is expensive and what you should avoid is VIEWING / LOADING /
    FEEDING-TO-VISION every image inside the archive. Bulk-viewing all
    frames is what wastes tokens, not extracting them.

  • After extraction you will have a `screenshots/` directory full of
    JPEGs sitting on disk, untouched by any vision model. That is the
    correct state. You will then OPEN (view) only a small handful of
    specific frames whose filenames match timestamps you have already
    identified as interesting from the transcript.

  • Do NOT skip the screenshots entirely and rely on the transcript
    alone. Selective visual confirmation of a few candidate moments is
    part of the job — the transcript alone is not enough to catch
    visual beats (reactions, on-screen text, action, framing changes).

In short:
    Extract archive        →  ALWAYS do this. Cheap. Expected.
    List/scan the folder   →  fine (it's just filenames on disk).
    Load an image into
      your vision context  →  do this SPARINGLY, only for specific
                              timestamps you already care about.
    Load every image       →  DON'T. This is the only thing to avoid.

--------------------------------------------------------------------------------
HOW TO SELECT CUTS (follow this order to keep vision-token usage low)
--------------------------------------------------------------------------------

STEP 1. Extract screenshots.zip into a local `screenshots/` directory.
        This is a plain unzip — no images are viewed yet, no vision
        tokens are spent. You now have random-access to individual
        frames by filename for the rest of the workflow.

STEP 2. Read transcript.json.
        Look at the `segments` array. Each segment has `start`, `end`,
        and `text`. Everything you need to identify interesting moments
        is in the DIALOGUE, NARRATION, and TONAL SHIFTS in the transcript.

STEP 3. Identify candidate ranges purely from the transcript text.
        Prioritize:
          - Emotional peaks (shouting, whispered reveals, laughter,
            silence between heavy lines)
          - Key beats (someone learning something, a reveal, a
            confrontation, a decision, a turning point)
          - Defining lines (memorable quotes, callbacks, strong claims)
          - Action beats where dialogue or sound signals impact
          - Cliffhanger-style openings or endings
        Skip:
          - Long silent expositional stretches
          - Recap/preview sections
          - Intro/outro songs or credit sequences if the transcript
            makes them obvious

STEP 4. For each candidate range, VIEW ONLY the specific screenshot(s)
        whose filename matches the timestamp(s) you want to visually
        confirm — never open the whole folder into vision. Filename
        convention:

            frame_<seconds-since-start>.jpg    (zero-padded to 5 digits)

        e.g. for a moment around 4 minutes 32 seconds in, that is
        second 272, so view `screenshots/frame_00272.jpg`. To sanity-
        check the middle of a candidate cut from 142s to 168s, sample
        e.g. frame_00142.jpg, frame_00155.jpg, frame_00168.jpg — a
        few frames, not the full folder.

        Rule of thumb: a handful of frames per candidate cut, not
        dozens. If you're tempted to view more than ~5 frames for one
        candidate, you're over-sampling.

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
    start of the video. `end_seconds > start_seconds`. Both must lie
    within [0, {duration_seconds}].
  - Cuts MUST NOT overlap.
  - Cuts MUST be sorted ascending by `start_seconds`.
  - `raw_narration` is plain prose. No markdown, no timestamps inside it,
    no name guessing when unsure — use clear descriptive tags like
    "the researcher" or "the host" if unclear.
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
