#!/usr/bin/env python3
"""
Stage B subtitle step — CINEMATIC MODE.

This is the new cinematic caption renderer that runs ALONGSIDE the
existing word-by-word template mode (generate_subtitles.py). The old
mode is untouched; this script is selected via the Stage B workflow's
`subtitle_mode` input (`word` = legacy template mode, `cinematic` =
this renderer). A later batch retires the old mode entirely.

Placement in the pipeline is IDENTICAL to the legacy renderer: it runs
AFTER cut_and_produce.py (and after the optional enhance pass) but
BEFORE brand_scenes.py, burning the captions into the still-native-
aspect merged final.mp4 so the captions are pixels of the VIDEO
CONTENT and ride with the video into any downstream branded slot.

---------------------------------------------------------------------------
HOW IT DIFFERS FROM TEMPLATE MODE
---------------------------------------------------------------------------
Template mode: one word on screen at a time, condensed Bebas Neue,
lower-third anchor, pop-in animation.

Cinematic mode (this file):

  * GRANULARITY — text is grouped and timed PER SENTENCE, not per
    word. The whole sentence is on screen while it is narrated.
  * FADE-IN — each sentence fades in WORD BY WORD: every word carries
    its own staggered alpha animation keyed to that word's voiceover
    timestamp, so the sentence materialises in reading order as it is
    spoken.
  * FADE-OUT — each sentence fades out LETTER BY LETTER: after a short
    hold, every character gets its own staggered alpha animation, left
    to right, so the sentence dissolves character by character.
  * OVERLAP — the incoming sentence does NOT wait for the previous one
    to finish fading out. Its event starts at its own first-word
    timestamp even while the previous sentence's letter-by-letter
    dissolve is still running. Alternating ASS layer pairs keep the
    incoming sentence composited on top of the outgoing one, so the
    glow/shadow treatment reads as intentional layering, not a glitch.
  * TIMING — sentence timing is derived from the same word-level
    timestamps the legacy renderer uses (faster-whisper transcription
    of the merged voiceover, aligned back onto the ORIGINAL script via
    the shared monotone alignment in generate_subtitles.py). Each
    sentence is held on screen for at least ~1.5s (a readability floor,
    not a hard lock — actual voice timing wins when the spoken span is
    longer).
  * STYLE — glowing text with a drop shadow, centred in the frame both
    horizontally and vertically (Alignment=5). The narrow condensed
    caption font and bottom-of-frame placement of template mode are
    deliberately NOT carried over: this mode uses a bold full-width
    face (DejaVu Sans Bold, present on every runner) with a soft gold
    glow layer composited underneath the main text layer.
  * KEYWORD COLORING — production.json may mark emotionally charged
    keywords with a tone (see load_script_with_keywords); matching
    words are rendered in a tone color (tense/negative -> hot red,
    warm/positive -> warm amber) instead of the default white, in both
    the main text and the glow layer.

---------------------------------------------------------------------------
AUTHORITATIVE TEXT vs. TRANSCRIPTION
---------------------------------------------------------------------------
Same contract as template mode: the transcription supplies per-word
TIMING ONLY; the words displayed on screen come from the ORIGINAL
script (`voiceover_text` per cut, verbatim). Word timing comes from
the shared transcribe_words()/align_words_to_script() functions in
generate_subtitles.py so the two modes can never drift apart on
timing/wording policy.

Usage:
    python generate_subtitles_cinematic.py <merged_video_mp4> <voiceover_wav>
                                 <out_video_mp4>
                                 [--script-json <production_or_manifest>]
                                 [--model base|small|tiny] [--lang auto|en|...]
                                 [--work-dir <path>]

Exit codes match the rest of the repo: 2 = bad input, 3 = validation
failure, subprocess failures propagate from sh().
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

# Reuse the legacy renderer's transcription, script alignment, ASS
# escaping and probing helpers verbatim so timing/wording policy is
# shared between the two modes by construction.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import generate_subtitles as legacy  # noqa: E402


# ---------- Cinematic styling ----------
# Full-width bold face — deliberately NOT the condensed Bebas Neue of
# template mode. DejaVu Sans is bundled with every ubuntu runner base
# image, so fontconfig always resolves it without a vendored file.
CIN_FONT = "DejaVu Sans"
CIN_FONT_FALLBACKS = ["Liberation Sans", "Nimbus Sans", "sans-serif"]
# Font size as a fraction of frame height. Slightly smaller than
# template mode's per-word size because whole SENTENCES (which wrap to
# 2-3 lines) must fit: keeps a comfortable side margin at PlayRes.
CIN_FONT_FRACTION_OF_HEIGHT = 0.052
# Dark outline under the glyphs + offset drop shadow for the cinematic
# treatment. Both scale with frame height like the legacy constants.
CIN_OUTLINE_FRACTION = 0.0030
CIN_SHADOW_FRACTION = 0.0045
# Glow layer: a blurred, generously-outlined copy of the same text
# composited UNDER the main text. Outline colour is a soft gold with
# ~40% transparency; the blur blooms it past the glyph edges.
CIN_GLOW_OUTLINE_FRACTION = 0.0085
CIN_GLOW_COLOR = "&H64" + "00BFFF"   # AABBGGRR: alpha 0x64, gold #FFBF00
CIN_GLOW_BLUR = 7

# ---------- Animation timing ----------
# Word-by-word fade-in: each word's alpha animates over this window
# starting at the word's own voiceover timestamp (relative to the
# sentence event start).
CIN_WORD_FADE_IN_MS = 170
# Letter-by-letter fade-out: after the hold (see below), characters
# dissolve left-to-right across this total window.
CIN_LETTER_FADE_OUT_MS = 500
# Readability floor: a sentence stays fully on screen at least this
# long even if it was spoken faster. Not a hard lock — when the spoken
# span is longer, voice timing wins and the hold simply ends later.
CIN_SENTENCE_MIN_SECONDS = 1.5

# ---------- Keyword sentiment palette ----------
# production.json cuts may carry an optional "keywords" list marking
# emotionally charged words with a tone. Tones map to colour families:
#   tense/negative -> hot red, warm/positive -> warm amber.
# Matching is on the normalised token (lowercase, alphanumeric only) —
# the same normalisation the aligner uses — and colours are applied via
# inline \c (fill) / \3c (glow outline) overrides, so wording and
# timing are never touched.
KEYWORD_COLORS = {
    "tense":    {"fill": "&H5C5CFF", "glow": "&H640000D0"},  # #FF5C5C
    "negative": {"fill": "&H5C5CFF", "glow": "&H640000D0"},
    "warm":     {"fill": "&H5AC8FF", "glow": "&H6400A0E0"},  # #FFC85A
    "positive": {"fill": "&H5AC8FF", "glow": "&H6400A0E0"},
}
DEFAULT_TONE = "tense"

_SENT_END_RE = re.compile(r'[.!?…]["\'”’)\]]*$')


def split_sentences(events: list[dict]) -> list[dict]:
    """
    Group the flat per-word display events (script wording + aligned
    timing, in timeline order) into sentences.

    A sentence boundary is taken wherever a script word ends in
    sentence-final punctuation (. ! ? … with optional trailing quote /
    bracket). Fragments of fewer than two words are merged into the
    previous sentence so a stray "No." never flashes alone. Returns a
    list of {"words": [...], "start": float, "speak_end": float} in
    order; speak_end is the aligned end of the sentence's last word
    (before the readability floor is applied).
    """
    sentences: list[dict] = []
    current: list[dict] = []
    for ev in events:
        current.append(ev)
        if _SENT_END_RE.search(ev["word"]):
            sentences.append(current)
            current = []
    if current:
        if sentences and len(current) < 2:
            sentences[-1].extend(current)
        else:
            sentences.append(current)

    merged: list[dict] = []
    for words in sentences:
        if merged and len(words) < 2:
            merged[-1]["words"].extend(words)
            merged[-1]["speak_end"] = words[-1]["end"]
            continue
        merged.append({
            "words": words,
            "start": words[0]["start"],
            "speak_end": words[-1]["end"],
        })
    print(f"Grouped {len(events)} words into {len(merged)} sentence(s).",
          flush=True)
    return merged


def load_script_with_keywords(script_json: str) -> tuple[list[str], dict]:
    """
    Load the ORIGINAL script (one voiceover_text per cut, in cut order)
    plus the additive keyword-sentiment metadata.

    Accepted keyword shapes per cut (all optional, additive only):
        "keywords": [{"word": "betrayal", "tone": "tense"}, ...]
        "keywords": {"betrayal": "tense", ...}

    Returns (texts, keyword_map) where keyword_map maps the normalised
    keyword token -> tone string ("tense"/"warm"/...). Unknown tones
    fall back to DEFAULT_TONE at colour-lookup time, so a typo never
    breaks the render.
    """
    with open(script_json, "r", encoding="utf-8") as f:
        payload = json.load(f)
    cuts = payload.get("cuts") or []
    if not cuts:
        print(f"{script_json} contains no cuts", file=sys.stderr)
        sys.exit(2)
    if all(isinstance(c, dict) and "index" in c for c in cuts):
        cuts = sorted(cuts, key=lambda c: int(c["index"]))
    else:
        cuts = sorted(cuts, key=lambda c: float(c.get("start_seconds", 0)))

    texts: list[str] = []
    keyword_map: dict[str, str] = {}
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

        raw_kw = c.get("keywords")
        if isinstance(raw_kw, dict):
            items = [{"word": w, "tone": t} for w, t in raw_kw.items()]
        elif isinstance(raw_kw, list):
            items = [k for k in raw_kw if isinstance(k, dict)]
        else:
            items = []
        for k in items:
            word = legacy._norm_token(str(k.get("word") or ""))
            tone = str(k.get("tone") or DEFAULT_TONE).strip().lower()
            if word:
                keyword_map[word] = tone
    if keyword_map:
        print(f"Loaded {len(keyword_map)} sentiment keyword(s): "
              f"{sorted(keyword_map)}", flush=True)
    return texts, keyword_map


def _char_run(word: str, s_start: float, hold_ms: int,
              fade_out_ms: int, char_offset: int, n_chars: int,
              color_tags: str) -> tuple[str, int]:
    """
    Build the ASS text for ONE word with per-character animation tags:

      * the word fades IN as a unit starting at the word's voiceover
        timestamp (the word-by-word entrance);
      * each character additionally fades OUT on its own staggered
        schedule (the letter-by-letter dissolve).

    `char_offset`/`n_chars` are this word's span inside the sentence's
    overall character sequence so the letter dissolve sweeps the whole
    sentence left-to-right regardless of word boundaries. Returns
    (ass_text, next_char_offset).
    """
    t_in = max(0, int(round((word["start"] - s_start) * 1000)))
    step = fade_out_ms / max(n_chars, 1)
    parts: list[str] = []
    for j, ch in enumerate(word["word"]):
        idx = char_offset + j
        g0 = hold_ms + int(round(idx * step))
        g1 = g0 + max(1, int(round(step * 1.2)))
        tags = (
            f"{{\\alpha&HFF&{color_tags}"
            f"\\t({t_in},{t_in + CIN_WORD_FADE_IN_MS},\\alpha&H00&)"
            f"\\t({g0},{g1},\\alpha&HFF&)}}"
        )
        parts.append(tags + legacy._ass_escape(ch))
    return "".join(parts), char_offset + len(word["word"])


def write_cinematic_ass(sentences: list[dict], keyword_map: dict,
                        width: int, height: int, out_ass: str) -> None:
    """
    One sentence = TWO Dialogue events sharing the same timespan:
      * a GLOW event (even layer) — blurred gold outline copy, and
      * a TEXT event (odd layer)  — the readable fill + drop shadow.

    Consecutive sentences alternate between layer pairs (0/1 and 2/3)
    so an incoming sentence always composites ON TOP of the previous
    one while the previous one is still in its letter-by-letter
    fade-out — the deliberate overlap that makes the transition look
    layered rather than glitchy.

    Both events are centred in the frame (Alignment=5) and carry
    identical per-word fade-in / per-character fade-out inline tags so
    the glow blooms and dissolves in lockstep with the text.
    """
    font_size = max(24, int(round(height * CIN_FONT_FRACTION_OF_HEIGHT)))
    outline = max(1, int(round(height * CIN_OUTLINE_FRACTION)))
    shadow = max(1, int(round(height * CIN_SHADOW_FRACTION)))
    glow_outline = max(2, int(round(height * CIN_GLOW_OUTLINE_FRACTION)))
    margin = int(round(width * 0.06))  # side clearance for wrapped lines

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CinGlow,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,{CIN_GLOW_COLOR},{CIN_GLOW_COLOR},1,0,0,0,100,100,0,0,1,{glow_outline},0,5,{margin},{margin},0,1
Style: CinText,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,1,0,0,0,100,100,0,0,1,{outline},{shadow},5,{margin},{margin},0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = [header]
    for i, sent in enumerate(sentences):
        words = sent["words"]
        s_start = sent["start"]
        # Hold: voice timing wins when longer; the 1.5s floor only pads
        # fast-spoken sentences. The letter dissolve begins at hold_end.
        hold_end = max(sent["speak_end"], s_start + CIN_SENTENCE_MIN_SECONDS)
        hold_ms = int(round((hold_end - s_start) * 1000))
        n_chars = sum(len(w["word"]) for w in words)
        event_end = hold_end + CIN_LETTER_FADE_OUT_MS / 1000.0 + 0.10

        glow_layer = 2 * (i % 2)
        text_layer = glow_layer + 1

        glow_parts: list[str] = []
        text_parts: list[str] = []
        offset = 0
        for w in words:
            tone = keyword_map.get(legacy._norm_token(w["word"]))
            colors = KEYWORD_COLORS.get(tone) if tone else None
            text_tags = f"\\c{colors['fill']}&" if colors else ""
            glow_tags = f"\\3c{colors['glow']}&" if colors else ""
            g_run, offset = _char_run(w, s_start, hold_ms,
                                      CIN_LETTER_FADE_OUT_MS, offset,
                                      n_chars, glow_tags)
            t_run, _ = _char_run(w, s_start, hold_ms,
                                 CIN_LETTER_FADE_OUT_MS,
                                 offset - len(w["word"]), n_chars, text_tags)
            glow_parts.append(g_run)
            text_parts.append(t_run)

        start_ts = legacy._ass_time(s_start)
        end_ts = legacy._ass_time(event_end)
        glow_text = f"{{\\blur{CIN_GLOW_BLUR}}}" + " ".join(glow_parts)
        main_text = " ".join(text_parts)
        lines.append(
            f"Dialogue: {glow_layer},{start_ts},{end_ts},CinGlow,,0,0,0,,"
            f"{glow_text}\n"
        )
        lines.append(
            f"Dialogue: {text_layer},{start_ts},{end_ts},CinText,,0,0,0,,"
            f"{main_text}\n"
        )

    with open(out_ass, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(
        f"ASS cinematic subtitle file written: {out_ass} "
        f"({len(sentences)} sentence event pair(s), font {CIN_FONT} Bold "
        f"{font_size}px, outline {outline}px, shadow {shadow}px, glow "
        f"outline {glow_outline}px + blur {CIN_GLOW_BLUR} — CENTRED in "
        f"the {width}x{height} video frame; word-by-word fade-in "
        f"{CIN_WORD_FADE_IN_MS}ms/word, letter-by-letter fade-out "
        f"{CIN_LETTER_FADE_OUT_MS}ms/sentence, >= "
        f"{CIN_SENTENCE_MIN_SECONDS}s hold, overlapping layered "
        f"transitions; burned in BEFORE branding so captions ride with "
        f"the video into any downstream branded slot)",
        flush=True,
    )


def burn_subtitles(video: str, ass_path: str, dst: str) -> None:
    """
    Burn the cinematic ASS in with libass and re-encode video with the
    SAME mobile-safe profile as cut_and_produce.py /
    generate_subtitles.py. Audio is stream-copied untouched. The
    cinematic face is a system font (DejaVu Sans Bold) resolved by
    fontconfig, so no fontsdir is needed.
    """
    def _fescape(p: str) -> str:
        return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    cmd = [
        "ffmpeg", "-y",
        "-i", video,
        "-vf", f"subtitles='{_fescape(ass_path)}'",
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
    legacy.sh(cmd)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("merged_video_mp4")
    ap.add_argument("voiceover_wav")
    ap.add_argument("out_video_mp4")
    ap.add_argument("--script-json", default=None,
                    help="production.json / cuts.json / "
                         "voiceover_manifest.json carrying the ORIGINAL "
                         "script (voiceover_text per cut) plus optional "
                         "sentiment keywords. Strongly recommended: "
                         "without it the transcription's wording is used "
                         "as a legacy fallback.")
    ap.add_argument("--model", default="base", choices=["tiny", "base", "small"])
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--work-dir", default=None,
                    help="scratch dir for transcript + ASS (default: "
                         "<out dir>/subtitle_work_cinematic)")
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
    work_dir = args.work_dir or os.path.join(out_dir, "subtitle_work_cinematic")
    os.makedirs(work_dir, exist_ok=True)

    # Transcription = TIMING SOURCE ONLY (shared with template mode).
    timed_words = legacy.transcribe_words(args.voiceover_wav, args.model,
                                          args.lang, work_dir)

    keyword_map: dict[str, str] = {}
    if args.script_json:
        # Original script = AUTHORITATIVE WORDING; keywords = additive
        # sentiment colouring metadata.
        script_texts, keyword_map = load_script_with_keywords(args.script_json)
        words = legacy.align_words_to_script(timed_words, script_texts)
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

    sentences = split_sentences(words)

    width, height = legacy.probe_video_size(args.merged_video_mp4)
    print(
        f"Video resolution: {width}x{height}; cinematic subtitles will be "
        f"CENTRED in this frame (the frame IS the video image at this "
        f"stage — branding runs downstream).",
        flush=True,
    )

    ass_path = os.path.join(work_dir, "subtitles_cinematic.ass")
    write_cinematic_ass(sentences, keyword_map, width, height, ass_path)

    print(f"Burning cinematic subtitles into {args.out_video_mp4} ...",
          flush=True)
    burn_subtitles(args.merged_video_mp4, ass_path, args.out_video_mp4)
    print(f"Final cinematically-subtitled video written: "
          f"{args.out_video_mp4}", flush=True)


if __name__ == "__main__":
    main()
