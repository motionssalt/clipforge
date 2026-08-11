#!/usr/bin/env python3
"""
Stage B subtitle step: transcribe the merged voiceover for word-level
timestamps and burn word-by-word animated subtitles INTO THE VIDEO
ITSELF, before any branded 9:16 composition happens downstream.

Runs AFTER cut_and_produce.py (and after the optional enhance pass)
but BEFORE brand_scenes.py. This ordering is deliberate and load-
bearing: subtitles are pixels of the VIDEO CONTENT, not of the
surrounding branded canvas. Burning them in at this stage — while the
video is still at its own native aspect ratio — makes them a permanent
part of the video image. When brand_scenes.py subsequently scales and
letterboxes that video into the 1080x1920 branded slot, the captions
ride inside the slot along with the rest of the picture; they cannot
escape upward into the title/header chrome or downward past the CTA,
because they are structurally part of the video pixels and are subject
to the exact same scale+pad+position math that positions the slot.

The voiceover WAV (not the video's mixed audio, which may also carry
background music) is what gets transcribed — music under speech would
only degrade the word timing.

---------------------------------------------------------------------------
AUTHORITATIVE TEXT vs. TRANSCRIPTION
---------------------------------------------------------------------------
The transcription is used for ONE thing only: per-word TIMING. The actual
words displayed on screen come from the ORIGINAL SCRIPT — the exact
`voiceover_text` lines the analysis agent wrote in production.json and
that generate_voiceover.py synthesized with the TTS (they are also stored
1:1 per cut in voiceover_manifest.json). Whisper's best-effort spelling
of what it heard is never shown to the viewer.

Concretely:

  * every cut's voiceover_text is tokenized into words;
  * the transcribed word timeline is consumed in cut order — cut 0 owns
    the first N0 timed words (N0 = word count of cut 0's script), cut 1
    the next N1, and so on. This works because the merged voiceover is
    exactly the per-cut TTS clips concatenated in order, and each clip
    speaks exactly its script;
  * inside a cut, the transcribed words and the script words are aligned
    with a monotone sequence alignment (difflib on normalized tokens),
    so a TTS contraction split, a merged compound, or a dropped/inserted
    word still maps every script word to a sensible timestamp instead of
    drifting;
  * if the global counts disagree enough that the last cut would run out
    of timed words, the remaining words get an even-share fallback inside
    their cut's window — the script is still displayed VERBATIM, only
    timing degrades gracefully.

The only transformation ever applied to the script text is the required
ALL CAPS display formatting.

---------------------------------------------------------------------------
STYLING / POSITIONING
---------------------------------------------------------------------------
Subtitles are one word on screen at a time, timed to that word's
timestamp, in the word-by-word style that dominates short-form vertical
video.

Font: Bebas Neue — a condensed/narrow all-caps display face that is the
de-facto standard for modern short-form / anime-edit captions. The TTF is
VENDORED at assets/fonts/BebasNeue-Regular.ttf (SIL Open Font License)
and passed to libass via the subtitles filter's fontsdir option, so the
render no longer depends on whatever fonts happen to be installed on the
runner. If the vendored file is ever missing, the script falls back to
Liberation Sans Narrow / Nimbus Sans Narrow / DejaVu Sans (in that
order) rather than failing.

Position: the subtitles belong to the VIDEO CONTENT. Because this step
runs BEFORE any branded composition, the frame we render into IS the
video image — no title bar, no avatar row, no CTA. Classic lower-third
placement therefore applies to the whole frame with no rectangle math:
the subtitle baseline is anchored to the middle of the frame's lower
third, with a minimum bottom clearance so text never kisses the video
edge. Any downstream brander that scales/letterboxes this video into a
slot will move the captions with the video, guaranteeing they stay
inside the video area of the branded canvas regardless of that slot's
position or size.

Rendering uses an ASS subtitle file with one timed event per word, burned
in by ffmpeg's libass `subtitles=` filter. Per-word drawtext would need
hundreds of filter chains; ASS events are exactly the tool for this.

Usage:
    python generate_subtitles.py <merged_video_mp4> <voiceover_wav>
                                 <out_video_mp4>
                                 [--script-json <production_or_manifest>]
                                 [--model base|small|tiny] [--lang auto|en|...]
                                 [--transcript-json <path>] [--keep-work]

Exit codes match the rest of the repo: 2 = bad input, 3 = validation
failure, subprocess failures propagate from sh().
"""
import argparse
import difflib
import json
import os
import re
import subprocess
import sys


# ---------- Subtitle styling ----------
# Condensed all-caps display font, vendored in-repo so the render is
# identical on every runner (see module docstring). FontSize is in output
# pixels at the ASS PlayRes we declare — we set PlayRes to the video's own
# resolution at render time, so sizes are honest pixels.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUB_FONT_DIR = os.path.join(REPO_ROOT, "assets", "fonts")
SUB_FONT_FILE = os.path.join(SUB_FONT_DIR, "BebasNeue-Regular.ttf")
SUB_FONT = "Bebas Neue"
# Fallback stack, in preference order, used only if the vendored Bebas
# Neue file is missing: condensed faces first, DejaVu as the last resort
# (it is bundled with every ubuntu runner base image).
SUB_FONT_FALLBACKS = ["Liberation Sans Narrow", "Nimbus Sans Narrow",
                      "DejaVu Sans"]
# Font size as a fraction of the video's own height. History: was 6.0%
# (too sprawling once the video was scaled into the 1080x1920 branded
# slot), then 5.2% (readable but a touch small on a phone at arm's
# length). Bumped moderately to 6.2%: noticeably more readable and
# visually prominent, while still leaving enough width margin inside the
# scaled slot that a long single word does not touch the sides. The
# condensed Bebas Neue face keeps the on-screen footprint compact even
# at this size.
SUB_FONT_FRACTION_OF_HEIGHT = 0.062
# Outline thickness scales with the frame height so the stroke stays
# proportional to the (now larger) glyphs. 0.0040 keeps the outline
# visually the same weight relative to the letterforms as 0.0035 was
# against the previous font size.
SUB_OUTLINE_FRACTION = 0.0040         # stroke thickness vs frame height

# ---------- Per-word entrance animation ----------
# The subtitles appear one word at a time. To give each word a polished
# short-form / anime-style entrance without conflicting with the
# word-by-word timing, every ASS Dialogue event is prefixed with a small
# override that:
#   * fades the word in over the first ~60ms (no fade-out — the next
#     word must snap on cleanly without ghosting into this one);
#   * pops the word in at 60% scale, overshoots to 106% by ~90ms, then
#     settles at 100% by ~150ms (subtle scale bounce, kinetic-text feel).
# Total animation length ~150ms — comfortably shorter than the 120ms
# per-word minimum display floor plus the transcription's own MIN_WORD
# margin, so even the fastest word fully resolves to its final size
# before it leaves screen. The animation is applied inline via ASS
# override tags at the start of each Dialogue text, so it is entirely
# local to each word event: it never touches timing, positioning,
# wording, or any downstream compositing step.
# The transform origin defaults to the alignment anchor (bottom-center
# via \an2 which matches the style's Alignment=2), so the scale grows
# from the baseline center of the word — the visually correct pivot for
# lower-third captions.
SUB_WORD_ANIM_TAGS = (
    "{\\an2\\fad(60,0)\\fscx60\\fscy60"
    "\\t(0,90,\\fscx106\\fscy106)"
    "\\t(90,150,\\fscx100\\fscy100)}"
)
# Vertical anchor: middle of the LOWER THIRD of the frame. Because
# subtitles are burned in BEFORE branding, the frame IS the video image
# at this stage — no title bar, no avatar row, no CTA — so classic
# lower-third placement applies to the whole frame with no rectangle
# math.
LOWER_THIRD_CENTER_FRACTION = 5.0 / 6.0
# Minimum clearance between the text block and the frame's bottom edge,
# as a fraction of frame height, so text never kisses (or crosses) the
# bottom edge of the video image.
MIN_BOTTOM_CLEARANCE_FRACTION = 0.02
# Minimum/maximum on-screen time per word so very fast or very slow words
# still read naturally; gaps longer than WORD_GAP_MERGE_S between words
# of the same phrase simply leave the screen empty.
MIN_WORD_SECONDS = 0.08
# Per-word minimum display time applied AFTER alignment (slightly longer
# than the transcription floor so very fast TTS words stay readable).
MIN_DISPLAY_SECONDS = 0.12


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

    IMPORTANT: the returned words are used for their TIMING ONLY. The
    displayed subtitle text always comes from the original script (see
    align_words_to_script).
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


# ---------------------------------------------------------------------------
# Original-script word alignment
# ---------------------------------------------------------------------------
_WORD_RE = re.compile(r"\S+")


def _norm_token(text: str) -> str:
    """
    Normalize a word for ALIGNMENT ONLY (never for display): lowercase and
    strip everything that isn't a letter or digit, so punctuation and
    capitalization differences between the script and the transcription
    don't break the sequence matcher.
    """
    return re.sub(r"[^0-9a-z]+", "", text.lower())


def load_script_texts(script_json: str) -> list[str]:
    """
    Load the ORIGINAL script — the authoritative subtitle wording — as one
    string per cut, in cut order.

    Accepts either file that carries the script verbatim:
      * production.json / cuts.json  -> {"cuts": [{"voiceover_text": ...}
                                        (legacy: "raw_narration"), ...]}
      * voiceover_manifest.json      -> {"cuts": [{"index", ...,
                                        "voiceover_text": ...}, ...]}
    """
    with open(script_json, "r", encoding="utf-8") as f:
        payload = json.load(f)
    cuts = payload.get("cuts") or []
    if not cuts:
        print(f"{script_json} contains no cuts", file=sys.stderr)
        sys.exit(2)

    # production.json orders by start_seconds; the manifest carries an
    # explicit index. Detect which shape we have.
    if all(isinstance(c, dict) and "index" in c for c in cuts):
        cuts = sorted(cuts, key=lambda c: int(c["index"]))
    else:
        cuts = sorted(cuts, key=lambda c: float(c.get("start_seconds", 0)))

    texts: list[str] = []
    for i, c in enumerate(cuts):
        text = (c.get("voiceover_text") or c.get("raw_narration") or "").strip()
        if not text:
            print(
                f"{script_json} cut #{i} has no voiceover_text (and no "
                f"legacy raw_narration fallback) — the original script is "
                f"the authoritative subtitle source, so a cut without "
                f"script text cannot be subtitled correctly. Fix the "
                f"production.json and re-run.",
                file=sys.stderr,
            )
            sys.exit(2)
        texts.append(text)
    print(f"Loaded original script for {len(texts)} cut(s) from "
          f"{script_json}", flush=True)
    return texts


def align_words_to_script(timed_words: list[dict],
                          script_texts: list[str]) -> list[dict]:
    """
    Replace the transcription's words with the ORIGINAL SCRIPT's words
    while keeping the transcription's timing.

    Returns a flat list of {"start", "end", "word"} display events in
    timeline order, where `word` is the exact script word (ALL-CAPS
    applied later at ASS-write time — this function preserves the script
    verbatim).

    Strategy (see module docstring):
      1. Partition the timed words across cuts by per-cut script word
         count (cut 0 owns the first N0 words, cut 1 the next N1, ...).
      2. Inside each cut, sequence-align normalized script tokens against
         normalized transcribed tokens so count mismatches (contractions
         split/merged, dropped or hallucinated words) still give every
         script word a timestamp from the correct neighbourhood.
    """
    script_cuts = [_WORD_RE.findall(t) for t in script_texts]
    total_script = sum(len(c) for c in script_cuts)
    if total_script == 0:
        print("ERROR: the original script contains no words at all.",
              file=sys.stderr)
        sys.exit(3)

    # ---- 1. Partition timed words across cuts. ----
    timed = list(timed_words)
    n_timed = len(timed)
    if n_timed < total_script:
        # Transcription heard fewer words than the script contains (TTS
        # elision, merged compounds, whisper drops). Keep the global
        # ratios intact by scaling each cut's quota proportionally so
        # every cut still gets a contiguous slice of the timeline.
        print(
            f"NOTE: transcription produced {n_timed} timed words but the "
            f"script has {total_script}. Scaling per-cut timing quotas "
            f"proportionally — wording is unaffected (script is always "
            f"displayed verbatim).",
            flush=True,
        )
        quotas: list[int] = []
        acc = 0
        remaining_timed = n_timed
        remaining_script = total_script
        for c in script_cuts:
            q = min(len(c), int(round(remaining_timed * len(c) /
                                      max(remaining_script, 1))))
            quotas.append(q)
            acc += q
            remaining_timed -= q
            remaining_script -= len(c)
        # Give any rounding leftovers to the last cut (it owns the tail).
        if quotas:
            quotas[-1] += n_timed - acc
    else:
        quotas = [len(c) for c in script_cuts]
        leftover = n_timed - total_script
        if leftover > 0:
            # Extra transcribed words beyond the script (whisper
            # hallucination, split tokens): absorb them into the last
            # cut's window — the alignment below simply never assigns
            # them to a script word.
            print(
                f"NOTE: transcription produced {leftover} more word(s) "
                f"than the script contains; extras are ignored for "
                f"display (script is authoritative).",
                flush=True,
            )
            quotas[-1] += leftover

    display_events: list[dict] = []
    cursor = 0
    prev_end = 0.0

    for cut_i, script_words in enumerate(script_cuts):
        quota = quotas[cut_i]
        window = timed[cursor:cursor + quota]
        cursor += quota
        if not window:
            # Degenerate: no timed words left for this cut — space the
            # script words out right after the previous event so the text
            # still appears (timing-only degradation, wording intact).
            t = prev_end
            for w in script_words:
                display_events.append({
                    "start": round(t, 3),
                    "end": round(t + MIN_DISPLAY_SECONDS, 3),
                    "word": w,
                })
                t += MIN_DISPLAY_SECONDS
            prev_end = t
            continue

        win_start = window[0]["start"]
        win_end = window[-1]["end"]

        # ---- 2. Monotone alignment inside the cut window. ----
        # a = script tokens (what we DISPLAY), b = transcribed tokens
        # (what we have TIMING for).
        a = [_norm_token(w) for w in script_words]
        b = [_norm_token(w["word"]) for w in window]
        sm = difflib.SequenceMatcher(a=a, b=b, autojunk=False)

        # per-script-word (start, end) placeholders
        starts: list[float | None] = [None] * len(script_words)
        ends: list[float | None] = [None] * len(script_words)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag in ("equal", "replace"):
                # Map the aligned block proportionally: script word
                # i1+k takes the timing slice of timed word j1+k (clamped
                # into the block); if the block sizes differ, spread the
                # timed block evenly over the script block.
                span_a = i2 - i1
                span_b = j2 - j1
                for k in range(span_a):
                    # fractional position inside the script block
                    f0 = k / span_a
                    f1 = (k + 1) / span_a
                    tj0 = j1 + int(f0 * span_b)
                    tj1 = j1 + max(int(f1 * span_b), int(f0 * span_b) + 1)
                    tj1 = min(tj1, j2)
                    starts[i1 + k] = window[tj0]["start"]
                    ends[i1 + k] = window[max(tj0, tj1 - 1)]["end"]
            elif tag == "delete":
                # Script words with NO corresponding timed word: stamped
                # in the gap-fill pass below.
                pass
            elif tag == "insert":
                # Extra transcribed words: keep the timeline honest but
                # never displayed — nothing to do.
                pass

        # ---- gap fill + monotonicity pass ----
        last_t = win_start
        for k in range(len(script_words)):
            if starts[k] is None:
                starts[k] = last_t
                ends[k] = last_t + MIN_DISPLAY_SECONDS
            else:
                # Never let a word start before the previous word's start
                # (alignment clamps can produce tiny inversions).
                if starts[k] < last_t:
                    starts[k] = last_t
                ends[k] = max(ends[k] or 0.0,
                              starts[k] + MIN_DISPLAY_SECONDS)
            # Keep the word inside its cut window when possible.
            if starts[k] > win_end:
                starts[k] = win_end
                ends[k] = max(ends[k], starts[k] + MIN_DISPLAY_SECONDS)
            last_t = starts[k]

        for k, w in enumerate(script_words):
            display_events.append({
                "start": round(starts[k], 3),
                "end": round(ends[k], 3),
                "word": w,
            })
        prev_end = display_events[-1]["end"]

    assert cursor == n_timed, "timed-word partition bookkeeping drifted"
    print(
        f"Aligned {sum(len(c) for c in script_cuts)} script word(s) from "
        f"{len(script_cuts)} cut(s) onto {n_timed} transcribed timing "
        f"events. Subtitle wording = ORIGINAL SCRIPT (verbatim).",
        flush=True,
    )
    return display_events


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


def _resolve_font() -> tuple[str, str | None]:
    """
    Pick the subtitle font. Returns (font_name, fontsdir_or_None).

    Preferred: the vendored Bebas Neue TTF (assets/fonts/) — libass is
    pointed at that directory via the subtitles filter's fontsdir option,
    so the exact condensed face renders regardless of what the runner has
    installed. If the file is missing we fall back to condensed system
    fonts and finally DejaVu Sans, and let fontconfig resolve the name
    (fontsdir=None).
    """
    if os.path.isfile(SUB_FONT_FILE):
        return SUB_FONT, SUB_FONT_DIR
    print(
        f"WARNING: vendored subtitle font missing at {SUB_FONT_FILE} — "
        f"falling back to condensed system fonts {SUB_FONT_FALLBACKS}.",
        file=sys.stderr,
        flush=True,
    )
    return SUB_FONT_FALLBACKS[0], None


def write_ass(words: list[dict], width: int, height: int,
              out_ass: str) -> None:
    """
    One ASS Dialogue event per word — the word pops on at its start time
    and off at its end time, so exactly one word is ever on screen.

    Because this step runs BEFORE any branded composition, the frame we
    render into IS the video image — there is no title bar, no header
    chrome, no CTA area on this canvas. Classic lower-third placement
    therefore applies to the whole frame: the subtitle baseline is
    anchored to the middle of the frame's lower third, and a minimum
    bottom clearance keeps text from kissing the frame edge. Any
    downstream brander that letterboxes this video into a slot moves the
    subtitles with the video by construction, so they stay inside the
    video area of the branded canvas regardless of slot geometry.

    Text is displayed in ALL CAPS (the only transformation ever applied
    to the original script wording).
    """
    font_name, _fontsdir = _resolve_font()

    font_size = max(24, int(round(height * SUB_FONT_FRACTION_OF_HEIGHT)))
    outline = max(2, int(round(height * SUB_OUTLINE_FRACTION)))

    # Desired vertical center of the text line = midpoint of the frame's
    # lower third. ASS positions Alignment=2 (bottom-center) text by its
    # BASELINE at frame_height - MarginV; we want the text block
    # (ascent+descent ~ font_size tall) centered on the anchor.
    anchor_y = height * LOWER_THIRD_CENTER_FRACTION
    baseline_y = anchor_y + font_size / 2.0
    # Keep the whole text block inside the frame: baseline must not push
    # the block's bottom past (frame bottom - clearance).
    min_clearance = height * MIN_BOTTOM_CLEARANCE_FRACTION
    max_baseline = height - min_clearance
    if baseline_y > max_baseline:
        baseline_y = max_baseline
    margin_v = int(round(height - baseline_y))
    margin_v = max(0, min(margin_v, height - 1))

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,{font_name},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,{outline},0,2,40,40,{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for w in words:
        # ALL CAPS is the ONLY transformation applied to the original
        # script wording before display. The per-word entrance animation
        # is a purely visual override prepended to the Dialogue text —
        # it does not modify the wording, the start/end timestamps, or
        # the position; it only controls how the word scales and fades
        # in during the first ~150ms of its own timespan.
        text = SUB_WORD_ANIM_TAGS + _ass_escape(w["word"].upper())
        lines.append(
            f"Dialogue: 0,{_ass_time(w['start'])},{_ass_time(w['end'])},"
            f"Word,,0,0,0,,{text}\n"
        )
    with open(out_ass, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(
        f"ASS subtitle file written: {out_ass} "
        f"({len(words)} word events, font {font_name} {font_size}px, "
        f"outline {outline}px, MarginV {margin_v}px — anchored to the "
        f"middle of the lower third of the {width}x{height} video frame; "
        f"burned in BEFORE branding so captions ride with the video into "
        f"any downstream branded slot; each word carries a ~150ms "
        f"scale-pop + fade-in entrance animation)",
        flush=True,
    )


def burn_subtitles(video: str, ass_path: str, dst: str) -> None:
    """
    Burn the ASS file in with libass and re-encode video with the SAME
    mobile-safe profile as cut_and_produce.py (the burn-in pass is a
    re-encode regardless, so we keep the exact phone-safe parameters
    rather than inheriting whatever ffmpeg would default to). Audio is
    stream-copied — it was already encoded to AAC-LC 48kHz stereo by
    cut_and_produce.py and must not be touched.

    When the vendored font directory exists it is handed to libass via
    the subtitles filter's `fontsdir` option so the condensed caption
    font renders identically on every runner.
    """
    # Escape the ASS path for the filter (colons on Windows, quotes
    # everywhere); on the Linux runner a simple quoting suffices.
    def _fescape(p: str) -> str:
        return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    subtitle_filter = f"subtitles='{_fescape(ass_path)}'"
    _font, fontsdir = _resolve_font()
    if fontsdir:
        subtitle_filter += f":fontsdir='{_fescape(fontsdir)}'"
    cmd = [
        "ffmpeg", "-y",
        "-i", video,
        "-vf", subtitle_filter,
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
    ap.add_argument("--script-json", default=None,
                    help="production.json / cuts.json / "
                         "voiceover_manifest.json carrying the ORIGINAL "
                         "script (voiceover_text per cut). When given, the "
                         "script — not the transcription — is what gets "
                         "displayed; the transcription supplies timing "
                         "only. Strongly recommended: without it the "
                         "transcription's wording is used as a legacy "
                         "fallback.")
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
    if args.script_json and not os.path.exists(args.script_json):
        print(f"Missing required input: {args.script_json}", file=sys.stderr)
        sys.exit(2)

    out_dir = os.path.dirname(os.path.abspath(args.out_video_mp4)) or "."
    os.makedirs(out_dir, exist_ok=True)
    work_dir = args.work_dir or os.path.join(out_dir, "subtitle_work")
    os.makedirs(work_dir, exist_ok=True)

    # Transcription = TIMING SOURCE ONLY.
    timed_words = transcribe_words(args.voiceover_wav, args.model, args.lang,
                                   work_dir)

    if args.script_json:
        # Original script = AUTHORITATIVE WORDING.
        script_texts = load_script_texts(args.script_json)
        words = align_words_to_script(timed_words, script_texts)
    else:
        print(
            "WARNING: no --script-json given — falling back to the "
            "transcription's own words for display. The original script is "
            "the intended authoritative subtitle source; pass "
            "production.json (or the voiceover manifest) via --script-json.",
            file=sys.stderr,
            flush=True,
        )
        words = timed_words

    width, height = probe_video_size(args.merged_video_mp4)
    print(
        f"Video resolution: {width}x{height}; subtitles will be anchored "
        f"to the middle of the lower third of this frame (the frame IS "
        f"the video image at this stage — branding runs downstream).",
        flush=True,
    )

    ass_path = os.path.join(work_dir, "subtitles.ass")
    write_ass(words, width, height, ass_path)

    print(f"Burning subtitles into {args.out_video_mp4} ...", flush=True)
    burn_subtitles(args.merged_video_mp4, ass_path, args.out_video_mp4)
    print(f"Final subtitled video written: {args.out_video_mp4}", flush=True)


if __name__ == "__main__":
    main()
