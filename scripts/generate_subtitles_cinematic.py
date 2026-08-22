#!/usr/bin/env python3
"""
Stage B subtitle step — CINEMATIC MODE.

This is the new cinematic caption renderer that runs ALONGSIDE the
existing word-by-word template mode (generate_subtitles.py). The old
mode is untouched; this script is selected via the Stage B workflow's
`subtitle_mode` input (`word` = legacy template mode, `cinematic` =
this renderer). A later batch retires the old mode entirely.

Placement in the pipeline is intentionally distinct from the legacy
renderer: it runs AFTER cut_and_produce.py (and after the optional
enhance pass), normalises the source into the bare 1080x1200 (10:9)
cinematic frame, and burns captions plus the one-time title banner into
that frame. The Stage B workflow never runs brand_scenes.py for this
mode, so cinematic output cannot acquire legacy channel chrome.

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
  * TITLE BANNER — a one-time intro element: a white full-width banner
    carrying the video's title drops in from off-screen top at t=0,
    holds 7 seconds, then drops back out the same way (up, off the top
    of the frame) and is gone for the rest of the video. Banner graphic
    and title text move as ONE unit: the title is rendered INTO the
    banner image (Pillow) and libass animates the whole image with a
    single \\move, so text and banner can never drift apart. The title
    typeface is Coolvetica, vendored at assets/fonts/Coolvetica.ttf —
    it replaces the narrow title font of old template mode INSIDE
    cinematic mode only; template mode itself is untouched here.

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

# Pillow renders the title banner image (text composited into the white
# banner graphic before ffmpeg ever sees it). Already a pipeline
# dependency (brand_scene.py / brand_scenes.py).
from PIL import Image, ImageDraw, ImageFont  # noqa: E402


# ---------- Cinematic styling ----------
# Caption and banner typography share the vendored Coolvetica family.
# The explicit font file is also passed to libass through its fontsdir option
# below, so CI does not depend on a system-wide font installation.
CIN_FONT_FILE = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "assets", "fonts", "Coolvetica.ttf"))
CIN_FONT = "Coolvetica Rg"
CIN_FONT_FALLBACKS = ["DejaVu Sans", "Liberation Sans", "sans-serif"]
# Font size as a fraction of frame height. Slightly smaller than
# template mode's per-word size because whole SENTENCES (which wrap to
# 2-3 lines) must fit: keeps a comfortable side margin at PlayRes.
CIN_FONT_FRACTION_OF_HEIGHT = 0.052
# Dark outline under the glyphs + offset drop shadow for the cinematic
# treatment. Both scale with frame height like the legacy constants.
CIN_OUTLINE_FRACTION = 0.0030
CIN_SHADOW_FRACTION = 0.0045
# Deep cinematic glow: three independent layers sit beneath the readable
# text. A wide, low-opacity bloom creates the soft outer halo; a denser
# mid-radius bloom gives it depth; a dark offset shadow anchors the type over
# active footage. This deliberately avoids the thin single-outline look.
CIN_GLOW_FAR_OUTLINE_FRACTION = 0.022
CIN_GLOW_FAR_COLOR = "&HB0" + "FFFFFF"    # broad neutral-white outer halo
CIN_GLOW_FAR_BLUR = 18
CIN_GLOW_NEAR_OUTLINE_FRACTION = 0.014
CIN_GLOW_NEAR_COLOR = "&H48" + "FFFFFF"   # dense neutral-white inner halo
CIN_GLOW_NEAR_BLUR = 9
CIN_SHADOW_OUTLINE_FRACTION = 0.008
CIN_SHADOW_COLOR = "&H90" + "000000"      # diffuse shadow under glow
CIN_SHADOW_BLUR = 7
CIN_SHADOW_OFFSET_X_FRACTION = 0.003
CIN_SHADOW_OFFSET_Y_FRACTION = 0.008

# ---------- Cinematic output frame ----------
# Cinematic output is always a bare 10:9 frame. Source material fills the
# canvas with a centred crop; no template, header, lower title block, or CTA
# is ever part of this renderer's filter graph.
CIN_FRAME_WIDTH = 1080
CIN_FRAME_HEIGHT = 1200

# ---------- Title banner (Batch 2) ----------
# One-time intro element: a white full-width banner drops in from the
# top of the frame at t=0, holds, then drops back out the same way and
# never returns. The banner graphic and its title text move as ONE unit
# — the text is rendered into the banner PNG and libass moves the whole
# image (DrawingModePictures dialogue), not a separate text event.
#
# Title face: Coolvetica, vendored next to the Batch 1 subtitle font.
# It replaces the narrow title font of old template mode WITHIN the
# cinematic banner only; template mode is untouched (its removal is a
# later batch). If the vendored file is ever missing we fall back to
# DejaVu Sans Bold with a warning rather than failing the render.
CIN_BANNER_FONT_FILE = CIN_FONT_FILE
CIN_BANNER_FONT_FALLBACK = "DejaVuSans-Bold.ttf"  # system fontconfig name
CIN_BANNER_HEIGHT_FRACTION = 0.11      # compact banner height vs frame height
CIN_BANNER_TOP_FRACTION = 0.0          # resting top edge: flush with y=0
CIN_BANNER_TEXT_WIDTH_FRACTION = 0.90  # max title width vs frame width
CIN_BANNER_IN_SECONDS = 0.6            # drop-in duration
CIN_BANNER_HOLD_SECONDS = 7.0          # fully-visible hold
CIN_BANNER_OUT_SECONDS = 0.6           # drop-out duration (same motion, reversed)
CIN_BANNER_LAYER = 8                   # above the caption stacks (0-7)
CIN_BANNER_MIN_FONT_PX = 20            # autofit floor for long titles

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


def load_banner_title(script_json: str) -> str:
    """Read the video title (production.json's top-level "title").

    Additive and forgiving: a missing/empty title yields "" and the
    caller renders without a banner instead of failing — the banner is
    decoration, the captions are the contract. The script file itself
    was already validated by load_script_with_keywords().
    """
    try:
        with open(script_json, "r", encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, json.JSONDecodeError):
        return ""
    return str(payload.get("title") or "").strip()


_banner_font_warned = False


def _load_banner_font(size: int):
    """Coolvetica (vendored) if present, else DejaVu Sans Bold."""
    global _banner_font_warned
    if os.path.isfile(CIN_BANNER_FONT_FILE):
        return ImageFont.truetype(CIN_BANNER_FONT_FILE, size)
    if not _banner_font_warned:
        _banner_font_warned = True
        print(
            f"WARNING: vendored banner font missing at "
            f"{CIN_BANNER_FONT_FILE} — falling back to "
            f"{CIN_BANNER_FONT_FALLBACK}.",
            file=sys.stderr, flush=True,
        )
    try:
        return ImageFont.truetype(CIN_BANNER_FONT_FALLBACK, size)
    except OSError:
        return ImageFont.load_default()


def build_banner_png(title: str, width: int, height: int,
                     out_png: str) -> int:
    """
    Render the title banner as a single PNG: a full-width white strip
    with the title centred on it in Coolvetica. Returning the banner
    height lets the caller place the ASS \\move anchors precisely.

    Because the title is composited INTO the image here, the ffmpeg
    side only ever animates one opaque rectangle — banner and text are
    one unit by construction (they can never be animated separately).

    The title auto-fits: it starts large (about half the banner height)
    and shrinks until it sits inside CIN_BANNER_TEXT_WIDTH_FRACTION of
    the frame width, with a floor at CIN_BANNER_MIN_FONT_PX. Long
    titles are never truncated — they just set smaller.
    """
    banner_h = max(48, int(round(height * CIN_BANNER_HEIGHT_FRACTION)))
    # The banner is the final rendering boundary for its text, so enforce
    # uppercase here rather than relying on the source title or a caller.
    banner_title = title.upper()
    img = Image.new("RGB", (width, banner_h), (255, 255, 255))
    draw = ImageDraw.Draw(img)

    max_text_w = int(round(width * CIN_BANNER_TEXT_WIDTH_FRACTION))
    size = max(CIN_BANNER_MIN_FONT_PX, int(round(banner_h * 0.52)))
    font = _load_banner_font(size)
    while size > CIN_BANNER_MIN_FONT_PX and \
            draw.textlength(banner_title, font=font) > max_text_w:
        size -= 2
        font = _load_banner_font(size)

    bbox = draw.textbbox((0, 0), banner_title, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    # Centre optically: shift by the bbox origin so ascender/descender
    # metrics don't push the glyphs off-centre.
    x = (width - text_w) // 2 - bbox[0]
    y = (banner_h - text_h) // 2 - bbox[1]
    draw.text((x, y), banner_title, font=font, fill=(18, 18, 18))

    img.save(out_png)
    print(
        f"Title banner rendered: {out_png} ({width}x{banner_h}, "
        f"{os.path.basename(CIN_BANNER_FONT_FILE)} {size}px, "
        f"title={banner_title!r})",
        flush=True,
    )
    return banner_h


def write_cinematic_ass(sentences: list[dict], keyword_map: dict,
                        width: int, height: int, out_ass: str) -> None:
    """
    One sentence = FOUR Dialogue events sharing the same timespan:
      * a soft, offset SHADOW pass;
      * a wide, low-opacity FAR GLOW;
      * a denser NEAR GLOW; and
      * readable foreground TEXT.

    Consecutive sentences alternate between four-layer stacks (0-3 and 4-7)
    so an incoming sentence always composites ON TOP of the previous
    one while the previous one is still in its letter-by-letter
    fade-out — the deliberate overlap that makes the transition look
    layered rather than glitchy.

    All four events are centred in the frame (Alignment=5) and carry
    identical per-word fade-in / per-character fade-out inline tags so
    the glow blooms and dissolves in lockstep with the text.
    """
    font_size = max(24, int(round(height * CIN_FONT_FRACTION_OF_HEIGHT)))
    outline = max(1, int(round(height * CIN_OUTLINE_FRACTION)))
    shadow = max(1, int(round(height * CIN_SHADOW_FRACTION)))
    far_glow_outline = max(4, int(round(height * CIN_GLOW_FAR_OUTLINE_FRACTION)))
    near_glow_outline = max(3, int(round(height * CIN_GLOW_NEAR_OUTLINE_FRACTION)))
    shadow_outline = max(2, int(round(height * CIN_SHADOW_OUTLINE_FRACTION)))
    shadow_x = max(1, int(round(width * CIN_SHADOW_OFFSET_X_FRACTION)))
    shadow_y = max(2, int(round(height * CIN_SHADOW_OFFSET_Y_FRACTION)))
    margin = int(round(width * 0.06))  # side clearance for wrapped lines

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CinShadow,{CIN_FONT},{font_size},&HFFFFFFFF,&HFFFFFFFF,{CIN_SHADOW_COLOR},{CIN_SHADOW_COLOR},0,0,0,0,100,100,0,0,1,{shadow_outline},0,5,{margin},{margin},0,1
Style: CinGlowFar,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,{CIN_GLOW_FAR_COLOR},{CIN_GLOW_FAR_COLOR},0,0,0,0,100,100,0,0,1,{far_glow_outline},0,5,{margin},{margin},0,1
Style: CinGlowNear,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,{CIN_GLOW_NEAR_COLOR},{CIN_GLOW_NEAR_COLOR},0,0,0,0,100,100,0,0,1,{near_glow_outline},0,5,{margin},{margin},0,1
Style: CinText,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H8C000000,0,0,0,0,100,100,0,0,1,{outline},{shadow},5,{margin},{margin},0,1

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
        n_chars = sum(len(w["word"].upper()) for w in words)
        event_end = hold_end + CIN_LETTER_FADE_OUT_MS / 1000.0 + 0.10

        stack_layer = 4 * (i % 2)
        shadow_layer = stack_layer
        far_glow_layer = stack_layer + 1
        near_glow_layer = stack_layer + 2
        text_layer = stack_layer + 3

        glow_parts: list[str] = []
        text_parts: list[str] = []
        offset = 0
        for w in words:
            # Source wording remains authoritative for timing and keyword
            # lookup, while the rendered display glyphs are always uppercase.
            display_word = w["word"].upper()
            tone = keyword_map.get(legacy._norm_token(w["word"]))
            colors = KEYWORD_COLORS.get(tone) if tone else None
            text_tags = f"\\c{colors['fill']}&" if colors else ""
            glow_tags = f"\\3c{colors['glow']}&" if colors else ""
            g_run, offset = _char_run(
                {**w, "word": display_word}, s_start, hold_ms,
                CIN_LETTER_FADE_OUT_MS, offset, n_chars, glow_tags)
            t_run, _ = _char_run(
                {**w, "word": display_word}, s_start, hold_ms,
                CIN_LETTER_FADE_OUT_MS,
                offset - len(display_word), n_chars, text_tags)
            glow_parts.append(g_run)
            text_parts.append(t_run)

        start_ts = legacy._ass_time(s_start)
        end_ts = legacy._ass_time(event_end)
        glow_text = " ".join(glow_parts)
        main_text = " ".join(text_parts)
        lines.append(
            f"Dialogue: {shadow_layer},{start_ts},{end_ts},CinShadow,,0,0,0,,"
            f"{{\\blur{CIN_SHADOW_BLUR}\\pos({width // 2 + shadow_x},{height // 2 + shadow_y})}}{glow_text}\n"
        )
        lines.append(
            f"Dialogue: {far_glow_layer},{start_ts},{end_ts},CinGlowFar,,0,0,0,,"
            f"{{\\blur{CIN_GLOW_FAR_BLUR}}}{glow_text}\n"
        )
        lines.append(
            f"Dialogue: {near_glow_layer},{start_ts},{end_ts},CinGlowNear,,0,0,0,,"
            f"{{\\blur{CIN_GLOW_NEAR_BLUR}}}{glow_text}\n"
        )
        lines.append(
            f"Dialogue: {text_layer},{start_ts},{end_ts},CinText,,0,0,0,,"
            f"{main_text}\n"
        )

    with open(out_ass, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(
        f"ASS cinematic subtitle file written: {out_ass} "
        f"({len(sentences)} sentence event stack(s), font {CIN_FONT} Regular "
        f"{font_size}px, outline {outline}px, foreground shadow {shadow}px, "
        f"deep glow far {far_glow_outline}px/blur {CIN_GLOW_FAR_BLUR} + "
        f"near {near_glow_outline}px/blur {CIN_GLOW_NEAR_BLUR} + "
        f"offset shadow {shadow_outline}px/blur {CIN_SHADOW_BLUR} — CENTRED in "
        f"the {width}x{height} video frame; word-by-word fade-in "
        f"{CIN_WORD_FADE_IN_MS}ms/word, letter-by-letter fade-out "
        f"{CIN_LETTER_FADE_OUT_MS}ms/sentence, >= "
        f"{CIN_SENTENCE_MIN_SECONDS}s hold, overlapping layered "
        f"transitions; rendered into the bare 1080x1200 cinematic frame "
        f"with no downstream branded compositor)",
        flush=True,
    )


def _banner_y_expr(rest_top: int) -> str:
    """
    Y position of the banner's TOP edge at time t — the drop-in / hold /
    drop-out schedule in one piecewise expression (ffmpeg if()).

      drop-in : t in [0, in)          — the whole banner slides DOWN
                from fully off-screen top (top edge -H, i.e. the banner
                just above the frame) to its resting slot, LINEARLY;
      hold    : t in [in, in+hold)    — parked at rest_top;
      drop-out: t in [in+hold, out)   — the SAME move reversed (slides
                back UP, top edge from rest_top to -H);
      after   : top edge pinned at -H, so even a pathological filter
                graph evaluation past out_end stays off-screen (the
                enable= gate already stops overlay at out_end, this is
                belt-and-braces).

    'H' is the banner image's own height in the overlay filter — no
    duplicated constant, so a future banner-height change can't
    desynchronise the two.
    """
    t_in = CIN_BANNER_IN_SECONDS
    t_hold = t_in + CIN_BANNER_HOLD_SECONDS
    t_out = t_hold + CIN_BANNER_OUT_SECONDS
    return (
        f"if(lt(t,{t_in}),"
        f"-H+({rest_top}+H)*t/{t_in},"
        f"if(lt(t,{t_hold}),"
        f"{rest_top},"
        f"if(lt(t,{t_out}),"
        f"{rest_top}-({rest_top}+H)*(t-{t_hold})/{CIN_BANNER_OUT_SECONDS},"
        f"-H)))"
    )


def burn_subtitles(video: str, ass_path: str, dst: str,
                   banner: dict | None = None) -> None:
    """
    Burn the cinematic ASS in with libass, overlay the title banner (if
    given) on top, and re-encode video with the same mobile-safe profile as
    cut_and_produce.py / generate_subtitles.py. Audio is stream-copied
    untouched. The cinematic face is the vendored Coolvetica font, supplied to
    libass through the renderer's fontsdir option for deterministic output.



    The banner is the pre-rendered PNG from build_banner_png() — white
    strip with the title text already composited in, so graphic and
    text move as ONE unit by construction. ffmpeg's overlay filter
    animates that single image with the piecewise y expression from
    _banner_y_expr(): drop-in from off-screen top, 7s hold, drop-out
    the same way, then enable= switches the overlay off and the banner
    is gone for the rest of the video (one-time intro element).
    """
    def _fescape(p: str) -> str:
        return p.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")

    inputs = ["-i", video]
    # This is the only cinematic canvas construction. It centre-crops the
    # source to 10:9 before either captions or the title banner are added.
    # No legacy branding asset is an input to this graph.
    filters = [
        f"[0:v]scale={CIN_FRAME_WIDTH}:{CIN_FRAME_HEIGHT}:"
        f"force_original_aspect_ratio=increase,"
        f"crop={CIN_FRAME_WIDTH}:{CIN_FRAME_HEIGHT},setsar=1[base]",
        f"[base]subtitles='{_fescape(ass_path)}':"
        f"fontsdir='{_fescape(os.path.dirname(CIN_FONT_FILE))}'[v0]",
    ]
    out_label = "v0"
    if banner is not None:
        rest_top = int(round(CIN_FRAME_HEIGHT * CIN_BANNER_TOP_FRACTION))
        out_end = (CIN_BANNER_IN_SECONDS + CIN_BANNER_HOLD_SECONDS
                   + CIN_BANNER_OUT_SECONDS)
        # -loop 1 makes the single PNG a (theoretically infinite) video
        # stream; trim it to the banner's on-screen span so the filter
        # graph still terminates when the MAIN video ends instead of
        # looping forever. enable= already gates visibility to out_end.
        inputs += ["-loop", "1", "-i", banner["png"]]
        y_expr = _banner_y_expr(rest_top)
        filters.append(
            f"[1:v]trim=duration={out_end},setpts=PTS-STARTPTS[bimg]"
        )
        filters.append(
            f"[v0][bimg]overlay=x=0:y='{y_expr}'"
            f":enable='lt(t,{out_end})':eof_action=pass[v1]"
        )
        out_label = "v1"

    filter_graph = ";".join(filters)
    cmd = [
        "ffmpeg", "-y",
        *inputs,
        "-filter_complex", filter_graph,
        "-map", f"[{out_label}]", "-map", "0:a:0",
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
    ap.add_argument("--title", default=None,
                    help="video title for the cinematic intro banner. "
                         "Default: production.json's top-level 'title' "
                         "(--script-json). If neither is available the "
                         "banner is skipped with a warning (captions "
                         "still render).")
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

    source_width, source_height = legacy.probe_video_size(args.merged_video_mp4)
    width, height = CIN_FRAME_WIDTH, CIN_FRAME_HEIGHT
    print(
        f"Source video resolution: {source_width}x{source_height}; "
        f"cinematic output is centre-cropped to the bare {width}x{height} "
        f"(10:9) frame, with captions centred in that full frame.",
        flush=True,
    )

    # ---- Title banner (Batch 2): white drop-in intro banner ----
    banner = None
    title = (args.title or "").strip()
    if not title and args.script_json:
        title = load_banner_title(args.script_json)
    if title:
        banner_png = os.path.join(work_dir, "title_banner.png")
        banner_h = build_banner_png(title, width, height, banner_png)
        banner = {"png": banner_png, "height": banner_h}
    else:
        print(
            "WARNING: no video title available (production.json['title'] "
            "empty and no --title given) — rendering WITHOUT the title "
            "banner; captions are unaffected.",
            file=sys.stderr, flush=True,
        )

    ass_path = os.path.join(work_dir, "subtitles_cinematic.ass")
    write_cinematic_ass(sentences, keyword_map, width, height, ass_path)

    print(f"Burning cinematic subtitles"
          f"{' + title banner' if banner else ''} into "
          f"{args.out_video_mp4} ...", flush=True)
    burn_subtitles(args.merged_video_mp4, ass_path, args.out_video_mp4,
                   banner=banner)
    print(f"Final cinematically-subtitled video written: "
          f"{args.out_video_mp4}", flush=True)


if __name__ == "__main__":
    main()
