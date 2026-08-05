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
  2. screenshots.zip      — a zip archive containing one JPEG per second
                            of the (compressed) source video. Each JPEG is
                            NOT a single still frame — it is a composite
                            of 6 sub-frames sampled evenly across that
                            same second, tiled into one image as a 3x2
                            grid (3 columns wide, 2 rows tall). Reading
                            order inside each composite is English reading
                            order — left-to-right, then top-to-bottom:

                                [ 0  1  2 ]   <- earliest 3 sub-frames
                                [ 3  4  5 ]   <- latest 3 sub-frames

                            So the top-left panel is the earliest moment
                            in that second and the bottom-right panel is
                            the latest. Files inside are named
                            frame_00000.jpg .. frame_{last_frame:05d}.jpg
                            (zero-padded 5-digit index of seconds-since-
                            start). Read each image as a short visual
                            sequence within that one second, not as a
                            single static pose.
  3. This file            — your instructions

Your job: choose the most engaging moments from this video and output a
`cuts.json` file (schema at the bottom of this document) that ClipForge's
Stage B will use to slice the ORIGINAL full-quality video and stitch a
short-form commentary base.

The narration ClipForge produces from your `raw_narration` field is meant
to explain the video to someone who cannot see it. That means your
`raw_narration` has to describe what is VISUALLY happening on screen —
actions, reactions, expressions, visual gags, scene changes — not just
paraphrase the dialogue. The transcript alone is almost never enough for
this; the screenshots are how you actually see the video.

CRITICAL WORKING ORDER (read this before doing anything else):

  1. FIRST, read transcript.json end-to-end and reconstruct the story
     from the dialogue alone. Do not open any screenshots yet. Write
     down (mentally or in a scratch buffer) what the video appears to
     be about, who the recurring speakers/entities seem to be (using
     descriptive tags like "the narrator", "the woman", "the enemy"
     since the transcript has no speaker labels), and where the beats
     and turning points sit on the timeline.

  2. THEN, using that story map, pick the candidate cut ranges you
     think will make the final short. At this point you already know
     roughly what each candidate is about from the transcript.

  3. ONLY THEN start opening screenshots — and only for the candidate
     ranges you actually plan to keep, plus any transcript stretch
     that is genuinely ambiguous or visually-driven (silent action,
     unclear referent, on-screen text, a beat that must exist visually
     but the transcript is silent on). Do not preemptively sample
     frames across the whole video "just to see". The images exist to
     fill in what the transcript cannot tell you, not to replace
     reading it.

  4. When you DO open screenshots, open them in CHRONOLOGICAL (canonical)
     order — ascending by frame index. Never jump around out of order
     (e.g. frame_00042 → frame_00891 → frame_00312). Within a single
     candidate range, view its frames from earliest second to latest
     second, in order. Across the whole video, work through your
     candidates in the order they occur, not in the order they
     occurred to you. Chronological viewing is how the visual story
     actually unfolds — viewing frames out of order fragments
     comprehension and is the main reason cuts come out inaccurate.

  5. If, after viewing a candidate's frames, you still don't understand
     what is happening, it is fine to fetch MORE frames for that same
     range — still in chronological order — until you do. But do not
     fetch frames from unrelated parts of the video just because they
     are there. Every frame you open should have a specific reason
     tied to a specific candidate cut.

--------------------------------------------------------------------------------
VIDEO METADATA (substituted by Stage A)
--------------------------------------------------------------------------------

  Job ID:                  {job_id}
  Full video duration:     {duration_seconds} seconds ({duration_hms})
  Screenshots available:   frame_00000.jpg .. frame_{last_frame:05d}.jpg
                           (one file per second, zero-padded 5-digit index
                            of seconds-since-start, packaged inside
                            screenshots.zip). Each file is a 3x2 grid
                            composite of 6 sub-frames sampled evenly within
                            that second — read in English reading order
                            (left-to-right, then top-to-bottom): the
                            top-left panel is the earliest moment in that
                            second, the bottom-right panel is the latest.
  Target output length:    ~{target_duration} seconds of cuts combined
                           (user-selected in the Stage A form; approximate
                           — favor engagement over hitting the number
                           exactly)

--------------------------------------------------------------------------------
ABOUT THE SCREENSHOTS ARCHIVE — read this carefully
--------------------------------------------------------------------------------

The screenshots ship as a single zip file (`screenshots.zip`) purely for
transport efficiency. Treat it as a normal working input:

  • EXTRACTING screenshots.zip is EXPECTED and REQUIRED. Do it up front,
    the same way you would unzip any other input archive. Extraction is
    a cheap local file operation — it does NOT consume vision tokens and
    does NOT count as "looking at" the images.

  • What is expensive is VIEWING / LOADING / FEEDING-TO-VISION every
    image inside the archive. The thing to avoid is indiscriminately
    piping the entire folder (which can be hundreds or thousands of
    near-identical frames) into your vision context in one shot. Do NOT
    do that.

  • After extraction you will have a `screenshots/` directory full of
    JPEGs sitting on disk, untouched by any vision model. That is the
    correct starting state. From there you will deliberately OPEN the
    frames you actually need in order to understand the video — which
    is more than a token handful, because the goal is genuinely
    describing what happens on screen, not just spot-checking dialogue.

  • Do NOT rely on the transcript alone. In a lot of shorts the visuals
    carry information that the transcript literally cannot: physical
    actions, facial reactions, sight gags, on-screen text, cutaways,
    and scene changes. If you only skim a couple of frames per cut you
    will miss the actual story of the video. View enough frames to
    reconstruct the visual sequence of events for each cut you plan to
    keep.

  • Each frame_NNNNN.jpg is a 3x2 grid composite — 6 sub-frames sampled
    evenly across that one second, arranged in English reading order
    (left-to-right, then top-to-bottom):

        [ 0  1  2 ]   <- earliest 3 sub-frames in that second
        [ 3  4  5 ]   <- latest 3 sub-frames in that second

    So the top-left panel is the earliest moment in that second and the
    bottom-right panel is the latest. When you read a file, read it as
    a short motion sequence, not a single still: compare the 6 panels
    in that order to see how the shot changes within that second (a
    hand moves, a facial expression shifts, the camera cuts, a prop
    enters frame). If the 6 panels are visually identical the second
    was static; if they differ, that difference IS the motion/action
    inside that second and should inform your raw_narration.

In short:
    Extract archive        →  ALWAYS do this. Cheap. Expected.
    List/scan the folder   →  fine (it's just filenames on disk).
    Load an image into
      your vision context  →  do this DELIBERATELY, as often as needed
                              to actually understand what is happening
                              visually in the segments you care about.
                              Sample multiple frames per beat/scene, not
                              just one, so you can see how the shot
                              evolves.
    Load every single
      image in bulk        →  DON'T. Indiscriminately viewing every
                              frame of a long video is the one thing to
                              avoid. Be intentional, not exhaustive.

--------------------------------------------------------------------------------
HOW TO SELECT CUTS AND DESCRIBE THEM
--------------------------------------------------------------------------------

STEP 1. Extract screenshots.zip into a local `screenshots/` directory.
        This is a plain unzip — no images are viewed yet, no vision
        tokens are spent. You now have random-access to individual
        frames by filename for the rest of the workflow.

STEP 2. Read transcript.json in full and understand the story from the
        transcript alone, BEFORE opening any images.
        Look at the `segments` array — each segment has `start`, `end`,
        and `text`. Read them in order, top to bottom, and build a
        mental model of the video:
          - What is the video roughly about?
          - Who are the recurring speakers/entities? (The transcript
            has no speaker labels — you cannot know who is talking
            just from the text. That is expected and fine at this
            stage; use descriptive tags like "the narrator", "the
            woman", "the enemy", "the researcher" and move on. Do
            not open screenshots yet trying to attach names.)
          - Where are the beats, turns, reveals, and the ending?
          - Which stretches sound like the good parts, and which
            stretches sound like filler / recap / intro / outro?

        The output of this step is your story map. You do NOT need
        images for this step. Opening screenshots here is premature
        and wasteful — do not do it.

STEP 3. Using the story map from Step 2, pick candidate cut ranges
        from the transcript alone.
        Prioritize:
          - Emotional peaks (shouting, whispered reveals, laughter,
            silence between heavy lines, visible strong reactions)
          - Key beats (someone learning something, a reveal, a
            confrontation, a decision, a turning point)
          - Defining lines (memorable quotes, callbacks, strong claims)
          - Cliffhanger-style openings or endings
          - Transcript stretches that clearly reference visual events
            you cannot infer from the words alone ("look at that",
            "he grabs it", a sudden change of subject, an unresolved
            "…") — these are the ones the images will need to
            disambiguate in Step 4.
        Skip:
          - Long silent expositional stretches with no clear payoff
          - Recap/preview sections
          - Intro/outro songs or credit sequences

        Do NOT do a coarse pre-scan of frames across the whole video
        looking for visual-only beats. That approach spends vision on
        parts of the video you have already decided are filler and
        misses the point of Step 2. If the transcript does not point
        at a candidate, do not go hunting for one in the frames.

        (Exception: if the entire video has essentially no useful
        transcript — e.g. a mostly-silent action video — say so
        explicitly to yourself and then, and only then, fall back to a
        deliberate chronological sweep of frames as your primary
        source. This should be rare.)

STEP 4. For each candidate range from Step 3, open its screenshots
        IN CHRONOLOGICAL ORDER to fill in what the transcript cannot
        tell you.

        Frame filename convention:

            frame_<seconds-since-start>.jpg    (zero-padded to 5 digits)

        e.g. for a moment around 4 minutes 32 seconds in, that is
        second 272, so view `screenshots/frame_00272.jpg`. Remember
        each file is a 3x2 grid (6 panels, read left-to-right then
        top-to-bottom) covering that one second, so opening a single
        file already gives you 6 sample points within that second.

        VIEWING ORDER — this is a hard rule, not a suggestion:

          - Within a single candidate range, open frames in ASCENDING
            frame-index order (canonical / chronological). For a
            candidate from 142s to 168s, view frame_00142.jpg, then
            some frames in the middle in ascending order (e.g.
            frame_00150, frame_00158), then frame_00168.jpg. Never
            jump around inside the range out of order.
          - Across candidates, work through them in the order they
            occur in the video (earliest start_seconds first), not in
            the order they occurred to you. Finish looking at one
            candidate before moving to the next.
          - Do NOT interleave frames from unrelated parts of the
            video (e.g. frame_00042 → frame_00891 → frame_00312).
            Out-of-order frame viewing is the single biggest cause
            of inaccurate raw_narration — the visual story stops
            making sense when you hop around.
          - If you realize mid-way that you need a frame from an
            EARLIER candidate you already left, you may go back, but
            still view that earlier candidate's remaining frames in
            ascending order before returning to where you were.

        How many frames to open per candidate:
          - Aim for enough coverage that you could confidently write a
            plain-prose description of what a viewer sees during the
            cut, including any visual beat that isn't spoken. The
            goal is understanding, not thoroughness for its own sake.
          - Sample MORE frames when the shot is action-heavy, changes
            location, has visual gags / reactions the transcript
            won't capture, or when the transcript for that stretch is
            ambiguous ("…", pronouns without antecedents, sudden
            topic jumps).
          - Sample FEWER frames when the shot is a static talking
            head and the transcript already describes the content
            well. In that case one or two composite frames may be
            enough to confirm the setting.
          - If after your first pass over a candidate you still don't
            understand what is happening, open MORE frames for the
            SAME candidate (still in ascending order) rather than
            wandering off into other parts of the video. It is fine
            and expected to re-visit a candidate until the story of
            that specific segment is clear.
          - Do NOT open frames outside your candidate ranges to
            "see what's there". Every frame you open must be tied to
            a specific candidate you are actively evaluating.

STEP 5. Assemble cuts.

        - Order them chronologically by `start_seconds`.
        - Each cut should be self-contained enough that a viewer landing
          on it makes sense — favor cutting at natural sentence / beat
          boundaries from the transcript, not mid-word.
        - Target the sum of (end - start) across all cuts at roughly
          {target_duration} seconds. It does NOT need to be exact — prefer
          slightly longer or shorter if the engagement is better.
        - For each cut, write a `raw_narration` field: a plain,
          matter-of-fact description of WHAT HAPPENS in that segment,
          the way a viewer who can see the screen would describe it to
          someone who cannot. Cover the visual sequence of events
          (actions, reactions, expressions, scene changes, on-screen
          text, visual gags) as well as any essential dialogue, in
          chronological order. Not a script, not stylized, not
          dramatized — just the raw beats, in order. This is what
          ClipForge feeds into the master conversion prompt to produce
          the final commentary.

--------------------------------------------------------------------------------
OUTPUT SCHEMA — cuts.json  (return EXACTLY this shape, no extra keys)
--------------------------------------------------------------------------------

{{
  "video_duration_seconds": {duration_seconds},
  "cuts": [
    {{
      "start_seconds": 142,
      "end_seconds": 168,
      "raw_narration": "plain, matter-of-fact description of the visual sequence of events in this segment (actions, reactions, scene changes, essential dialogue), in chronological order, the way a viewer would describe it to someone who cannot see the screen"
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
    "the researcher" or "the host" if unclear. Describe what is
    visually happening, not just what is said.
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
