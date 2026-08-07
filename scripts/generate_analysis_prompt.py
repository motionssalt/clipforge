#!/usr/bin/env python3
"""
Generate the 00_READ_THIS_FIRST.txt file that Stage A ships alongside the
transcript + screenshots + local vision-assist indexes. This file
instructs the downstream AI agent how to select cuts and what cuts.json
shape to return.

The duration, frame filename convention, and window size are substituted
from the actual Stage A run.

Usage:
    python generate_analysis_prompt.py <duration_seconds> <total_frames>
                                       <output_txt_path>
                                       [--target-duration 120]
                                       [--job-id JOB_ID]
                                       [--window-seconds 6]
                                       [--shot-count 0]
                                       [--key-moment-count 0]
                                       [--event-frame-count 0]
"""
import argparse
import os


TEMPLATE = """\
================================================================================
  READ THIS FIRST — Source-video cut-selection instructions for the AI agent
================================================================================

You have been given SIX artifacts from a Stage A run of the ClipForge
pipeline:

  1. transcript.json          — timestamped transcript of the video's audio.
  2. scene_index.json         — locally-computed list of every shot
                                boundary in the video (via ffmpeg
                                scene-change scores). Deterministic,
                                zero-guesswork. See "USING THE INDEXES"
                                below.
  3. key_moments.json         — a locally-ranked SHORTLIST of the
                                high-signal moments in the video (shot
                                cuts, emotionally loaded dialogue).
                                Each moment carries a `why` field. Use
                                this shortlist to decide which stretches
                                to open screenshots for, BEFORE opening
                                any.
  4. screenshots.zip          — a zip archive containing composite JPEG
                                images of the (compressed) source video.
                                Two kinds of image live inside:
                                   • frame_NNNNNN.jpg   (baseline)
                                   • event_NNNNNNNNN.jpg (dense event)
                                See "ABOUT THE SCREENSHOTS ARCHIVE" below.
  5. (the original video)     — attached to the same Release. You do not
                                need to open it; Stage B uses it later.
  6. This file                — your instructions.

Your job: choose the most engaging moments from this video and output a
`cuts.json` file (schema at the bottom of this document) that ClipForge's
Stage B will use to slice the ORIGINAL full-quality video and stitch a
short-form commentary base.

The narration ClipForge produces from your `raw_narration` field is meant
to explain the video to someone who cannot see it. That means your
`raw_narration` has to describe what is VISUALLY happening on screen —
actions, reactions, expressions, visual gags, scene changes — not just
paraphrase the dialogue. The transcript alone is almost never enough for
this; the indexes plus the screenshots are how you actually see the video.

CHARACTER IDENTIFICATION IS YOUR JOB.
The pipeline no longer runs a local face-clustering step. That step was
misidentifying people (splitting the same character into two labels, or
merging distinct characters together, or missing brief appearances) and
its errors were poisoning downstream selection and narration. You are
the vision model — you can see the screenshots and read the transcript,
so you identify who is who directly from those two sources. Do it the
way any careful viewer would: infer names from dialogue (people
addressing each other, self-introductions, third-person references,
on-screen text), pick a consistent descriptor when no name is spoken,
and use the SAME label for the same character across every cut.

--------------------------------------------------------------------------------
CRITICAL WORKING ORDER (read this before doing anything else)
--------------------------------------------------------------------------------

The order below is the single most important thing in this document.

  STEP 1: Read `transcript.json` end-to-end. Do not open any composite
     screenshots yet. Reconstruct the story from the dialogue. Write
     down (mentally or in a scratch buffer) what the video appears to
     be about, who the recurring speakers seem to be, and where the
     beats and turning points sit on the timeline. Note every proper
     name that appears — someone being addressed by name, someone
     introducing themselves, a third-person reference — and keep those
     names next to the timestamp where they were said, so you can bind
     each name to a visible character when you open the screenshots
     later.

  STEP 2: Open `scene_index.json` and `key_moments.json`.
     - `scene_index.json` gives you EXACT shot boundaries — where the
       camera cuts. You no longer have to infer cuts by comparing
       panels; the boundaries are enumerated.
     - `key_moments.json` gives you a locally-ranked shortlist of the
       most promising cut candidates, each annotated with
       `transcript_excerpt`, `signals` (emotional_score,
       dialogue_density, priority), and a `why` field. Read the whole
       `moments` array. This is your candidate pool. Cross-check it
       against your Step 1 story map and pick the moments that
       genuinely serve the throughline of the video, not just the
       highest-priority ones in isolation.

  STEP 3: For each candidate moment/cut range from Step 2, OPEN
     screenshots to fill in what the transcript and indexes still can't
     tell you — including WHO is on screen. See "ABOUT THE SCREENSHOTS
     ARCHIVE" and "HOW TO SELECT CUTS" below for the viewing rules —
     chronological order, adjacent windows, dense event composites for
     boundary-crossing beats. As you view screenshots for the first
     few cuts, lock in a consistent label for each recurring
     character (their real name if the transcript names them, or a
     short descriptive tag if it doesn't) and reuse that same label
     for the rest of the run.

  STEP 4: Assemble cuts.json using the raw_narration contract
     described near the bottom of this file.

--------------------------------------------------------------------------------
VIDEO METADATA (substituted by Stage A)
--------------------------------------------------------------------------------

  Job ID:                  {job_id}
  Full video duration:     {duration_seconds} seconds ({duration_hms})
  Baseline cadence:        one composite JPEG per {window_seconds}-second
                           window of source video. Each composite is a
                           3x2 grid of 6 panels, and each panel is one
                           frame from one of the 6 seconds inside that
                           window (panel 1 = second 1 of the window,
                           panel 6 = second 6 of the window).
  Baseline screenshots:    frame_000000.jpg .. frame_{last_window_start:06d}.jpg
                           ({total_frames} files total). The number in
                           each filename is the WINDOW START SECOND,
                           zero-padded to 6 digits. Consecutive
                           filenames step by {window_seconds}. File
                           frame_SSSSSS.jpg covers source seconds
                           [SSSSSS, SSSSSS+{window_seconds}).
  Dense event composites:  {event_frame_count} additional images named
                           event_NNNNNNNNN.jpg (9-digit MILLISECOND
                           timestamp of the CENTER of the event window,
                           zero-padded). Each event composite is also a
                           3x2 grid, but sampled ~1.5 fps across a
                           tighter 4-second window centered on a
                           high-signal moment (a shot boundary or a
                           high-priority beat). Use these to see fast
                           beats the 6-second baseline may only
                           partially capture.
  Local scene index:       {shot_count} shot(s) enumerated in
                           scene_index.json.
  Local key-moments list:  {key_moment_count} moment(s) in
                           key_moments.json.
  Target output length:    ~{target_duration} seconds of cuts combined
                           (user-selected in the Stage A form; approximate
                           — favor engagement over hitting the number
                           exactly).

--------------------------------------------------------------------------------
USING THE INDEXES
--------------------------------------------------------------------------------

The two JSON indexes are the cheap-vision layer. They were produced
locally on the runner using ffmpeg — no LLM vision was spent building
them. That means you can lean on them heavily WITHOUT paying vision
tokens for the coverage they provide.

  scene_index.json
    - The definitive list of shot boundaries. Every entry is `{{shot_id,
      start_seconds, end_seconds, keyframe_seconds, cause}}`.
    - When you write raw_narration for a cut that spans multiple
      shot_ids, you already know exactly where the camera cut inside
      it — describe those transitions accurately ("the shot cuts to a
      wide of the arena", "we cut back to the boy") instead of
      guessing.
    - `keyframe_seconds` is the midpoint of a shot — the single most
      representative timestamp. If you want a single frame from a
      shot, that's the one to look at.

  key_moments.json
    - Your candidate shortlist. Every moment has:
        * `start_seconds` — the shot's start (a real shot boundary).
        * `shot_end_seconds` — the raw shot boundary, i.e. the frame
          BEFORE the camera cuts away from this shot.
        * `end_seconds` — `shot_end_seconds` PLUS a small
          `visual_tail_seconds` extension into the next shot, so the
          moment's window actually contains the beat's on-screen
          resolution (reaction shot, cutaway, aftermath), not just its
          last spoken word. Prefer `end_seconds` over
          `shot_end_seconds` when you use this moment as a cut-end
          anchor.
        * `visual_tail_seconds` — how much tail was added past the
          raw shot boundary. See `visual_tail_policy` at the top of
          the file.
        * `transcript_excerpt` — the dialogue during the window.
        * `signals` — is_shot_boundary, emotional_score,
          dialogue_density, priority.
        * `why` — human-readable list of the exact reasons this
          moment was flagged (and, when the tail was extended, why).
    - Priority is a HINT, not a mandate. A high priority means
      "worth a look", not "must be a cut". The best cut list is the
      one that tells one connected story, not the one that greedily
      picks the top-N priorities.
    - Moments are already sorted chronologically in the file.

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
    piping the entire folder into your vision context in one shot. Do
    NOT do that.

  • After extraction you will have a `screenshots/` directory containing:
      - `frame_NNNNNN.jpg` — baseline 6-second-window composites.
      - `event_NNNNNNNNN.jpg` — dense 4-second-window composites, one
        per high-signal moment. Sampled at ~1.5 fps so beats that fell
        between baseline panels are resolvable here.

  • Do NOT rely on the transcript alone. In a lot of shorts the visuals
    carry information that the transcript literally cannot: physical
    actions, facial reactions, sight gags, on-screen text, cutaways,
    and scene changes. View enough windows to reconstruct the visual
    sequence of events for each cut you plan to keep.

  • Each frame_SSSSSS.jpg is a 3x2 grid composite that represents a
    {window_seconds}-SECOND WINDOW of the source video, starting at the
    second `SSSSSS` in the filename. The 6 panels are sampled ONE PER
    SECOND across those {window_seconds} seconds. Reading order is
    English reading order (left-to-right, then top-to-bottom):

        [ s+0s   s+1s   s+2s ]   <- one frame each from seconds 1, 2, 3 of the window
        [ s+3s   s+4s   s+5s ]   <- one frame each from seconds 4, 5, 6 of the window

    where `s` is the window's start second (the number in the filename).

  • Each event_NNNNNNNNN.jpg is a 3x2 grid composite of a 4-SECOND
    window CENTERED on the millisecond timestamp encoded in the
    filename (divide by 1000 to get the center in seconds). Panels are
    sampled at ~1.5 fps, so consecutive panels are ~0.66s apart.
    Reading order is the same left-to-right, top-to-bottom. Prefer
    event composites for beats you know are on a shot boundary (i.e.
    anything on the key_moments.json shortlist with
    `is_shot_boundary=true`) — they resolve fast beats that the
    baseline can miss.

  • When you need finer-grained temporal information than one baseline
    file can give you, open the ADJACENT baseline files
    (frame_<S>.jpg, frame_<S+{window_seconds}>.jpg,
    frame_<S+{two_windows}>.jpg, ...). Each successive file continues
    the sequence into the next {window_seconds}-second window.

In short:
    Extract archive         → ALWAYS do this. Cheap. Expected.
    Load a baseline
      composite             → Deliberately, as needed to understand a
                              specific candidate cut.
    Load an event composite → Prefer over the baseline for any beat
                              flagged in key_moments.json — same 1-image
                              cost, ~4x the temporal resolution at the
                              important spot.
    Load every image
      in bulk               → DON'T. Be intentional, not exhaustive.

--------------------------------------------------------------------------------
HOW TO SELECT CUTS AND DESCRIBE THEM
--------------------------------------------------------------------------------

STEP 1 (indexes-first). You have already read transcript.json,
        scene_index.json, and key_moments.json (Steps 1-2 above). Your
        candidate cut pool is the `moments` array of key_moments.json,
        filtered against your story map from transcript.json.

        Prioritize keeping moments that:
          - Sit on strong emotional dialogue (`emotional_score` >= 0.4).
          - Advance the story (a new confrontation, a reveal, a
            reaction beat).
          - Are the payoff of a setup earlier in the video (check the
            transcript, not just the individual moment).

        Skip moments that:
          - Are shot boundaries with no dialogue signal (usually
            establishing shots or filler).
          - Repeat information a previous cut already delivered.
          - Land in intro / outro / recap / preview sections.

STEP 2 (open screenshots — in chronological order — to fill visuals).

        Frame filename convention (baseline):

            frame_<window_start_seconds>.jpg    (zero-padded to 6 digits)

        Each such file covers the half-open interval
        [window_start, window_start + {window_seconds}) seconds. To
        find the baseline file that covers a specific moment T (in
        seconds), floor T to the nearest multiple of {window_seconds}:

            window_start = (T // {window_seconds}) * {window_seconds}

        e.g. for a moment around 4 minutes 32 seconds in (T = 272s):
        272 // {window_seconds} = {example_div}, so the covering file is
        `screenshots/frame_{example_window:06d}.jpg`, which covers
        seconds [{example_window}, {example_window_end}).

        Event filename convention (dense, for high-signal beats):

            event_<center_milliseconds>.jpg    (zero-padded to 9 digits)

        The number is the CENTER of the 4-second event window in
        milliseconds. To find an event composite near a moment M
        seconds, look for a file whose center is within ~2 seconds of
        M (i.e. abs(center_ms/1000 - M) <= 2.0). If one exists, prefer
        it over the baseline for that beat.

        Every high-signal moment in key_moments.json emits TWO event
        composites: one centered on its `start_seconds` (the onset of
        the beat) AND one centered on its `end_seconds` (the beat's
        on-screen resolution — already pre-padded past the raw shot
        boundary by `visual_tail_seconds`). This is deliberate: the
        tail composite is what lets you verify that the described
        action has actually finished on screen before you commit an
        `end_seconds` value. ALWAYS open the tail composite before
        finalizing `end_seconds` for a cut that anchors on this
        moment — see "PICKING end_seconds" in STEP 3 below.

        VIEWING ORDER — this is a hard rule, not a suggestion:

          - Within a single candidate range, open composites in
            ASCENDING timestamp order (canonical / chronological).
            Never jump around inside the range out of order.
          - Across candidates, work through them in the order they
            occur in the video (earliest start_seconds first).
          - Do NOT interleave windows from unrelated parts of the
            video. Out-of-order viewing is a major cause of
            inaccurate raw_narration.
          - If you realize mid-way that you need a window from an
            EARLIER candidate you already left, go back and view it
            in ascending order before returning.

        How many windows to open per candidate:
          - Aim for enough coverage that you could confidently write a
            plain-prose description of what a viewer sees during the
            cut, including any visual beat that isn't spoken.
          - For most beats: ONE event composite (if available) OR one
            baseline composite is enough for the specific moment,
            plus the adjacent baseline composite on either side for
            surrounding context.
          - Sample MORE composites when the shot is action-heavy or
            has visual gags the transcript won't capture.
          - Sample FEWER when the shot is a static talking head and
            the transcript already describes the content well.
          - If after your first pass you still don't understand what
            is happening, open MORE composites for the SAME candidate
            (still in ascending order). Do not wander off.

STEP 3 (assemble cuts).

        - Order cuts chronologically by `start_seconds`.
        - Each cut should be self-contained enough that a viewer landing
          on it makes sense — favor cutting at natural sentence / beat
          boundaries from the transcript, not mid-word.
        - Target the sum of (end - start) across all cuts at roughly
          {target_duration} seconds. It does NOT need to be exact.
        - `start_seconds` and `end_seconds` are still expressed in
          SOURCE-VIDEO seconds (integers, second-precision). They do
          NOT need to align with window boundaries.

        --------------------------------------------------------------
        PICKING end_seconds — read this before writing any cut
        --------------------------------------------------------------

        This is the single most common failure mode of cuts.json:
        `end_seconds` chosen at the point where the NARRATION or
        DIALOGUE ends, one or two seconds BEFORE the described
        on-screen action actually finishes happening. The result is a
        scene_XX.mp4 that references an event ("his eye flashes red",
        "the storm crashes down", "she hooks her pinky around his",
        "he stalks toward the door") and then cuts off right before
        the viewer can see that event on screen. Do not do this.

        The rule is simple and non-negotiable:

          If your raw_narration for this cut describes an action, a
          reaction, a cutaway, or a visible result, then `end_seconds`
          MUST sit AFTER that action / reaction / result is visibly
          complete on screen. Not at the last spoken word. Not at the
          shot boundary just before the payoff. AFTER the payoff.

        Concretely:

          (a) Ignore "where the transcript segment ends" as an anchor
              for `end_seconds`. Whisper's segment ends are aligned to
              the last SPOKEN WORD (± a small pad) — the visual beat
              a viewer would describe as "the moment" almost always
              lands AFTER the last word, in the next 1–4 seconds of
              screen time.

          (b) Do NOT anchor `end_seconds` to the shot's
              `shot_end_seconds` from scene_index.json / key_moments.json.
              Short-form narrative beats routinely resolve ACROSS the
              cut: the reaction shot, the cutaway to what was just
              referenced, the aftermath of the punch, the flash of
              someone's eye as they close it — those live in the NEXT
              shot, not the current one. If the described beat's
              payoff clearly lives in the next shot, extend
              `end_seconds` into that next shot until the payoff is
              on screen.

          (c) The `end_seconds` value in each key_moments.json entry
              is already pre-padded past `shot_end_seconds` by a
              small `visual_tail_seconds` for exactly this reason.
              Use that as your MINIMUM. Only shrink it back below
              that value if you have specifically verified from the
              screenshots that the described action truly completed
              earlier; and even then, keep at least ~1s of visual
              tail after the last described beat.

          (d) Verify visually. Open the event composite centered on
              your candidate `end_seconds` (there is one for every
              key_moments.json moment — same event_<ms>.jpg naming as
              the start-of-moment composite) and confirm the described
              action's resolution is visible in one of its panels. If
              the payoff is still in progress at the last panel, push
              `end_seconds` forward by another 1–2 seconds and check
              again. If it already completed by the first panel, you
              may pull `end_seconds` back — but keep at least ~1s of
              tail after the described beat.

          (e) Tail budget. A visual tail of roughly 1–4 seconds past
              the on-screen end of the described beat is the right
              range for essentially every cut. Less than 1s reads as
              a cut-off; more than 4s starts dragging.

          (f) Self-check before finalizing each cut: re-read your
              raw_narration and, for every distinct beat it mentions,
              confirm you have visual evidence (from the screenshots
              you opened) that the beat is INSIDE
              [`start_seconds`, `end_seconds`]. If any described beat
              lands at or past `end_seconds`, extend `end_seconds`.
              This check is more important than hitting the target
              total duration exactly.

        - For each cut, write a `raw_narration` field: a plain,
          matter-of-fact description of WHAT HAPPENS in that segment,
          the way a viewer who can see the screen would describe it to
          someone who cannot. Cover the visual sequence of events
          (actions, reactions, expressions, scene changes, on-screen
          text, visual gags) as well as any essential dialogue, in
          chronological order.

        CHARACTER LABELS IN raw_narration:
        - Identify each recurring character yourself from the
          screenshots and transcript, and refer to them by the SAME
          label in every cut. Label priority:
            (a) REAL NAME — if the transcript makes a name clear
                (someone addressed by name, a self-introduction, a
                third-person reference that lines up with who is on
                screen at that timestamp), use the real name (e.g.
                "Killua", "Gon"). On first use you may pair the name
                with one short descriptor to anchor the visual
                ("Killua, the white-haired boy, …"), then use the
                name alone (or a pronoun clearly referring back to
                him) from then on.
            (b) DESCRIPTIVE TAG — if no name evidence exists, pick a
                short natural descriptor and keep it CONSISTENT
                across every cut (e.g. always "the silver-haired
                boy").
        - Once a real name is established, use it for the rest of the
          output. Do NOT acknowledge the name once and then fall back
          to "the white-haired boy" in later cuts — a resolved name
          stays resolved. Never switch labels for the same character
          between cuts — that reads as a highlight reel of strangers.
        - When unsure whether two on-screen faces are the same person,
          look at the screenshots — hair, outfit, and context are
          usually enough to decide. If you truly cannot tell, keep the
          descriptions generic ("a boy in a white shirt") rather than
          committing to a wrong identity.

        NARRATE THE CUTS AS ONE CONNECTED STORY:

        The raw_narration fields, in the order the cuts appear in
        cuts.json, will be concatenated end-to-end and handed to the
        commentary-writing agent as if they were a single set of
        notes on ONE video. If each raw_narration reads like a
        standalone description of a good moment, the final commentary
        ends up as a disconnected highlight reel — no throughline,
        no cause and effect. Viewers stay engaged when they can
        follow a story from setup to payoff, not when they are shown
        a list of separately interesting clips.

        Treat the sequence of cuts as ONE story you are narrating in
        order, and write each raw_narration with awareness of what
        came before it in the source video:

          - Before writing raw_narration for the first cut, briefly
            note what the overall story of the source video is (from
            your Step 1 story map) and what arc the cuts you have
            chosen trace through it — who the subject is, what they
            want or are up against, and how the chosen beats
            progress from beginning to end.

          - Between one cut and the next in the source there is
            usually a gap of footage you deliberately did NOT select.
            Sometimes the two cuts still follow naturally (same
            scene continuing, same subject, obvious next beat) and
            need no bridge. But often there IS a gap the viewer will
            feel — a change of location, a time skip, a new subject
            appearing, an unexplained new state, or a payoff whose
            setup lives in the un-selected footage in between. When
            that gap exists, OPEN the next cut's raw_narration with
            the SHORTEST possible connective phrase or sentence that
            carries the viewer across it. Keep it terse — the point
            is linkage, not exposition.

          - The connective lead-in must only summarize / frame what
            the source material actually implies (from the
            transcript, indexes, and screenshots you viewed). Do
            NOT invent new events, new dialogue, new characters, or
            new motivations to bridge the gap.

          - When two adjacent cuts are linked as setup → payoff, or
            cause → effect, make that relationship legible in the
            wording of the second cut's raw_narration ("Because of
            that, …", "This is what he was warned about at the
            start: …", "The device she rigged earlier now …").

          - Refer to recurring people/entities the SAME way across
            every cut. Whichever label you chose for a character in
            their first cut stays fixed through the entire
            cuts.json. Don't reset labels between cuts.

          - Each individual cut's raw_narration is still primarily
            a plain, matter-of-fact description of what happens
            visually inside THAT cut. The connective tissue is a
            lead-in of at most one short sentence or clause, not a
            paragraph of recap.

          - The first cut's raw_narration opens the story. It does
            not need a connective lead-in, but it SHOULD orient the
            viewer on who / what / where in its first sentence.

          - The last cut's raw_narration ends the story. Land on the
            final beat from the source; do not add a wrap-up.

--------------------------------------------------------------------------------
OUTPUT SCHEMA — cuts.json  (return EXACTLY this shape, no extra keys)
--------------------------------------------------------------------------------

{{
  "video_duration_seconds": {duration_seconds},
  "cuts": [
    {{
      "start_seconds": 142,
      "end_seconds": 170,
      "raw_narration": "plain, matter-of-fact description of the visual sequence of events in this segment (actions, reactions, scene changes, essential dialogue), in chronological order, the way a viewer would describe it to someone who cannot see the screen. Written as one scene of a continuous story: when there is a real gap between this cut and the previous one, open with a short connective phrase (e.g. 'Later, …', 'After the fight, …') so the moment lands as part of the same throughline, not as a fresh unrelated clip. Do not invent events to bridge the gap. Refer to recurring characters with the SAME descriptor or name you used in earlier cuts."
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
  - `end_seconds` must sit AFTER the visual resolution of every event
    the cut's `raw_narration` describes. It is NOT the last spoken
    word, and it is NOT the raw shot boundary at the end of the
    current shot — both routinely land BEFORE the described action's
    on-screen payoff. See the "PICKING end_seconds" block in STEP 3
    for the full rule and self-check. When in doubt, err on the side
    of 1–2 extra seconds of tail; a slightly long cut is fine, a cut
    that ends before its described beat is on screen is broken.
  - `raw_narration` is plain prose. No markdown, no timestamps inside it,
    no name guessing when unsure — but when the transcript provides
    clear name evidence for a character, using that name is NOT a
    guess: use the real name, consistently, in every cut. Use the SAME
    label (real name, or a descriptor only when no name evidence
    exists) across every cut for the same character. Describe what is
    visually happening, not just what is said.
  - Across cuts, `raw_narration` fields must read as consecutive scenes
    of ONE continuous story, not as independent highlight descriptions.
    Where there is a real gap between adjacent cuts (location change,
    time skip, unexplained new state, setup→payoff), open the later
    cut's `raw_narration` with a short connective lead-in that carries
    the viewer across the gap. Never invent events to fill a gap.
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
    ap.add_argument(
        "--window-seconds",
        type=int,
        default=6,
        help="Seconds of source video covered by each baseline composite "
             "JPEG (must match the ffmpeg extraction step in stage-a.yml).",
    )
    ap.add_argument("--shot-count", type=int, default=0)
    ap.add_argument("--key-moment-count", type=int, default=0)
    ap.add_argument("--event-frame-count", type=int, default=0)
    args = ap.parse_args()

    window_seconds = max(int(args.window_seconds), 1)
    total_frames = max(int(args.total_frames), 0)
    last_window_start = max(total_frames - 1, 0) * window_seconds

    example_t = 272
    example_div = example_t // window_seconds
    example_window = example_div * window_seconds
    example_window_end = example_window + window_seconds

    content = TEMPLATE.format(
        job_id=args.job_id,
        duration_seconds=args.duration_seconds,
        duration_hms=hms(args.duration_seconds),
        total_frames=total_frames,
        window_seconds=window_seconds,
        two_windows=window_seconds * 2,
        three_windows=window_seconds * 3,
        last_window_start=last_window_start,
        target_duration=args.target_duration,
        example_div=example_div,
        example_window=example_window,
        example_window_end=example_window_end,
        shot_count=args.shot_count,
        key_moment_count=args.key_moment_count,
        event_frame_count=args.event_frame_count,
    )

    os.makedirs(os.path.dirname(os.path.abspath(args.output_txt)) or ".", exist_ok=True)
    with open(args.output_txt, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Wrote analysis prompt to {args.output_txt} ({len(content)} bytes)")


if __name__ == "__main__":
    main()
