#!/usr/bin/env python3
"""
Stage B subtitle step — CINEMATIC MODE.

This is ClipForge's sole caption renderer. Stage B always calls this
script to produce a bare 1080x1200 (10:9) cinematic frame with sentence-
level captions, a one-time title banner, and scene-level reframing.

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
    caption transition reads as intentional layering, not a glitch.
  * TIMING — sentence timing is derived from the same word-level
    timestamps from faster-whisper transcription of the merged voiceover,
    aligned back onto the ORIGINAL script via the shared monotone alignment
    helpers in subtitle_common.py. Each
    sentence is held on screen for at least ~1.5s (a readability floor,
    not a hard lock — actual voice timing wins when the spoken span is
    longer).
  * STYLE — compact, all-caps Coolvetica text with a soft gray-black
    drop shadow immediately down and right of the glyphs, centred in the
    frame both horizontally and vertically (Alignment=5). The narrow
    condensed caption font and bottom-of-frame placement of template mode
    are deliberately NOT carried over; this mode has no outline, halo, or
    separate glow layer.
  * KEYWORD COLORING — production.json may mark noteworthy words with an
    author-selected literal hex color (see load_script_with_keywords).
    The renderer applies that exact color and does not classify tone,
    sentiment, or emotional weight itself.
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
subtitle_common.py, which isolates timing policy from caption styling.

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
import math
import os
import re
import subprocess
import sys

# Shared timing, alignment, ASS escaping, probing, and command helpers
# are styling-neutral so the sole cinematic renderer has no dependency on a
# retired subtitle mode.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import subtitle_common  # noqa: E402
import cinematic_reframe  # noqa: E402

# Pillow renders the title banner image (text composited into the white
# banner graphic before ffmpeg ever sees it). Already a pipeline
# dependency (brand_scene.py / brand_scenes.py).
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont  # noqa: E402


# ---------- Cinematic styling ----------
# Caption and banner typography share the vendored Coolvetica family.
# The explicit font file is also passed to libass through its fontsdir option
# below, so CI does not depend on a system-wide font installation.
CIN_FONT_FILE = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "assets", "fonts", "Coolvetica.ttf"))
CIN_FONT = "Coolvetica Rg"
CIN_FONT_FALLBACKS = ["DejaVu Sans", "Liberation Sans", "sans-serif"]
# Compact sentence captions: reduced from 5.2% to 4.2% of frame height
# so they occupy less of the live footage while retaining Coolvetica's strong
# all-caps readability.
CIN_FONT_FRACTION_OF_HEIGHT = 0.042
# The timing/debug ASS sidecar approximates the production drop shadow with a
# subtle, close offset. The rendered video is authored by the Pillow raster
# compositor below, which supplies the actual Gaussian-softened edge.
CIN_ASS_SHADOW_COLOR = "&H60000000"
CIN_ASS_SHADOW_OFFSET_X_FRACTION = 0.0020
CIN_ASS_SHADOW_OFFSET_Y_FRACTION = 0.0035

# Production captions are rasterized with Pillow for a compact soft drop
# shadow: dark gray-black, close to the glyphs, and lightly Gaussian softened.
# This is a shadow layer only—not an outline or a separate glow treatment.
CIN_RASTER_FPS = 24
CIN_RASTER_MAX_WIDTH_FRACTION = 0.86
CIN_RASTER_Y_FRACTION = 0.55
CIN_RASTER_SHADOW_RGB = (38, 38, 38)
CIN_RASTER_SHADOW_ALPHA = 0.72
CIN_RASTER_SHADOW_X = 3
CIN_RASTER_SHADOW_Y = 5
CIN_RASTER_SHADOW_BLUR_RADIUS = 4
# During its complete word-by-word entrance, the entire sentence grows
# smoothly from a visibly smaller scale to its normal held size. The outgoing
# letter dissolve expands from that normal size. Both envelopes use the
# requested cubic-bezier(0.20, 1.00, 1.00, 1.00) feel.
CIN_ENTRANCE_START_SCALE = 0.82
CIN_EXIT_EXPAND_SCALE = 1.18
CIN_EXPAND_BEZIER = (0.20, 1.00, 1.00, 1.00)

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
CIN_BANNER_IN_SECONDS = 0.7            # eased drop-in duration
CIN_BANNER_HOLD_SECONDS = 7.0          # fully-visible hold
CIN_BANNER_OUT_SECONDS = 0.7           # eased drop-out duration (same motion, reversed)
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

# ---------- Author-controlled keyword colors ----------
# production.json optionally carries literal #RRGGBB values chosen by its
# authoring process. This renderer only validates and applies them; it never
# maps tone or sentiment labels to color.
_HEX_COLOR_RE = re.compile(r"^#?([0-9A-Fa-f]{6})$")


def _normalise_hex_color(value: object) -> str | None:
    match = _HEX_COLOR_RE.fullmatch(str(value or "").strip())
    return f"#{match.group(1).upper()}" if match else None


def _hex_rgb(color: str | None) -> tuple[int, int, int]:
    normalized = _normalise_hex_color(color)
    if not normalized:
        return (255, 255, 255)
    return tuple(int(normalized[index:index + 2], 16) for index in (1, 3, 5))


def _hex_ass(color: str) -> str:
    red, green, blue = _hex_rgb(color)
    return f"&H{blue:02X}{green:02X}{red:02X}"

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
    plus additive, author-selected keyword-color metadata.

    Accepted keyword shapes per cut (all optional, additive only):
        "keywords": [{"word": "betrayal", "color": "#FF5C5C"}, ...]
        "keywords": {"betrayal": "#FF5C5C", ...}

    Returns (texts, keyword_map) where keyword_map maps a normalised token to
    an exact #RRGGBB literal. Tone-only legacy entries are deliberately
    ignored with a warning: there is no renderer-side tone palette.
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
            items = [
                {"word": word, "color": value.get("color") if isinstance(value, dict) else value}
                for word, value in raw_kw.items()
            ]
        elif isinstance(raw_kw, list):
            items = [k for k in raw_kw if isinstance(k, dict)]
        else:
            items = []
        for k in items:
            word = subtitle_common._norm_token(str(k.get("word") or ""))
            color = _normalise_hex_color(k.get("color"))
            if not word:
                continue
            if color:
                keyword_map[word] = color
            elif k.get("tone"):
                print(
                    f"WARNING: ignoring legacy tone-only keyword {word!r}; "
                    "production.json must provide a literal #RRGGBB color.",
                    file=sys.stderr,
                )
            elif k.get("color") is not None:
                raise ValueError(
                    f"Invalid keyword color for {word!r}: {k.get('color')!r}. "
                    "Use a #RRGGBB literal.")
    if keyword_map:
        print(f"Loaded {len(keyword_map)} author-selected keyword color(s): "
              f"{keyword_map}", flush=True)
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
        parts.append(tags + subtitle_common._ass_escape(ch))
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
    One sentence = TWO Dialogue events sharing the same timespan:
      * a close, low-opacity dark-shadow approximation for timing diagnostics;
      * crisp readable foreground TEXT.

    Consecutive sentences alternate between two-layer stacks (0-1 and 2-3)
    so an incoming sentence always composites ON TOP of the previous
    one while the previous one is still in its letter-by-letter
    fade-out — the deliberate overlap that makes the transition look
    layered rather than glitchy.

    The production compositor uses Pillow to add the true soft Gaussian
    drop-shadow edge. Both timing-sidecar events are centred in the frame
    (Alignment=5) and carry identical per-word fade-in / per-character
    fade-out inline tags so the diagnostic shadow tracks the text.
    """
    font_size = max(24, int(round(height * CIN_FONT_FRACTION_OF_HEIGHT)))
    shadow_x = max(1, int(round(width * CIN_ASS_SHADOW_OFFSET_X_FRACTION)))
    shadow_y = max(2, int(round(height * CIN_ASS_SHADOW_OFFSET_Y_FRACTION)))
    margin = int(round(width * 0.06))  # side clearance for wrapped lines

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {width}
PlayResY: {height}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CinShadow,{CIN_FONT},{font_size},{CIN_ASS_SHADOW_COLOR},{CIN_ASS_SHADOW_COLOR},{CIN_ASS_SHADOW_COLOR},{CIN_ASS_SHADOW_COLOR},0,0,0,0,100,100,0,0,1,0,0,5,{margin},{margin},0,1
Style: CinText,{CIN_FONT},{font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,5,{margin},{margin},0,1

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

        stack_layer = 2 * (i % 2)
        shadow_layer = stack_layer
        text_layer = stack_layer + 1

        shadow_parts: list[str] = []
        text_parts: list[str] = []
        offset = 0
        for w in words:
            # Source wording remains authoritative for timing and keyword
            # lookup, while the rendered display glyphs are always uppercase.
            display_word = w["word"].upper()
            color = keyword_map.get(subtitle_common._norm_token(w["word"]))
            text_tags = f"\\c{_hex_ass(color)}&" if color else ""
            s_run, offset = _char_run(
                {**w, "word": display_word}, s_start, hold_ms,
                CIN_LETTER_FADE_OUT_MS, offset, n_chars, "\\c&H000000&")
            t_run, _ = _char_run(
                {**w, "word": display_word}, s_start, hold_ms,
                CIN_LETTER_FADE_OUT_MS,
                offset - len(display_word), n_chars, text_tags)
            shadow_parts.append(s_run)
            text_parts.append(t_run)

        start_ts = subtitle_common._ass_time(s_start)
        end_ts = subtitle_common._ass_time(event_end)
        shadow_text = " ".join(shadow_parts)
        main_text = " ".join(text_parts)
        lines.append(
            f"Dialogue: {shadow_layer},{start_ts},{end_ts},CinShadow,,0,0,0,,"
            f"{{\\pos({width // 2 + shadow_x},{height // 2 + shadow_y})}}{shadow_text}\n"
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
        f"{font_size}px, crisp white foreground + compact soft-gray shadow "
        f"diagnostic offset {shadow_x}px right / {shadow_y}px down — CENTRED in "
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
                just above the frame) to its resting slot with cubic easing;
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
    # cubic ease-out: fast initial travel with a smooth settle at the
    # visible slot. Use the mirrored curve for the exit so both moves feel
    # designed rather than mechanically linear.
    in_progress = f"t/{t_in}"
    out_progress = f"(t-{t_hold})/{CIN_BANNER_OUT_SECONDS}"
    in_ease = f"(1-pow(1-({in_progress}),3))"
    out_ease = f"(1-pow(1-({out_progress}),3))"
    return (
        f"if(lt(t,{t_in}),"
        f"-H+({rest_top}+H)*{in_ease},"
        f"if(lt(t,{t_hold}),"
        f"{rest_top},"
        f"if(lt(t,{t_out}),"
        f"{rest_top}-({rest_top}+H)*{out_ease},"
        f"-H)))"
    )


def _probe_video_duration(video: str) -> float:
    """Return the input duration in seconds for frame-exact overlays."""
    raw = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", video,
    ], text=True).strip()
    duration = float(raw)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError(f"Invalid video duration reported for {video}: {raw!r}")
    return duration


def _caption_font(size: int) -> ImageFont.FreeTypeFont:
    if not os.path.isfile(CIN_FONT_FILE):
        raise FileNotFoundError(f"Missing cinematic font: {CIN_FONT_FILE}")
    return ImageFont.truetype(CIN_FONT_FILE, size)


def _caption_color(color: str | None) -> tuple[int, int, int]:
    """Return the literal author-selected RGB value, or white when absent."""
    return _hex_rgb(color)


def _caption_layout(sentence: dict, font, width: int, height: int) -> list[dict]:
    """Lay out a sentence as centred, word-addressable glyph runs."""
    max_width = int(round(width * CIN_RASTER_MAX_WIDTH_FRACTION))
    lines: list[list[dict]] = []
    current: list[dict] = []
    for word in sentence["words"]:
        item = {"source": word, "display": word["word"].upper()}
        trial = current + [item]
        trial_text = " ".join(x["display"] for x in trial)
        if current and ImageDraw.Draw(Image.new("L", (1, 1))).textlength(
                trial_text, font=font) > max_width:
            lines.append(current)
            current = [item]
        else:
            current = trial
    if current:
        lines.append(current)

    metrics = ImageDraw.Draw(Image.new("L", (1, 1)))
    line_height = int(round(font.size * 1.12))
    top = int(round(height * CIN_RASTER_Y_FRACTION - line_height * len(lines) / 2))
    runs: list[dict] = []
    for line_index, line in enumerate(lines):
        line_text = " ".join(item["display"] for item in line)
        line_width = metrics.textlength(line_text, font=font)
        x = (width - line_width) / 2.0
        y = top + line_index * line_height
        for item in line:
            item["x"] = x
            item["y"] = y
            runs.append(item)
            x += metrics.textlength(item["display"] + " ", font=font)
    return runs


def _cubic_bezier_ease(progress: float) -> float:
    """Evaluate CSS-style cubic-bezier(0.20, 1.00, 1.00, 1.00) at x=progress."""
    progress = max(0.0, min(1.0, progress))
    x1, y1, x2, y2 = CIN_EXPAND_BEZIER
    lo, hi = 0.0, 1.0
    for _ in range(18):
        t = (lo + hi) / 2.0
        x = (3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t ** 2 * x2 + t ** 3)
        if x < progress:
            lo = t
        else:
            hi = t
    t = (lo + hi) / 2.0
    return 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t ** 2 * y2 + t ** 3


def _sentence_transition_scale(sentence: dict, time_s: float) -> float:
    """Return the sentence-scale envelope tied to the existing fade timings."""
    start = float(sentence["start"])
    hold_end = max(float(sentence["speak_end"]), start + CIN_SENTENCE_MIN_SECONDS)
    fade_in_end = min(
        hold_end,
        max(float(word["start"]) for word in sentence["words"]) +
        CIN_WORD_FADE_IN_MS / 1000.0,
    )
    event_end = hold_end + CIN_LETTER_FADE_OUT_MS / 1000.0 + 0.10
    if time_s < fade_in_end:
        # From the instant the first word begins to fade in, the complete
        # sentence grows from small to its normal held scale. This remains
        # active through the final word's fade-in window, not just at the
        # first few frames of the caption.
        progress = (time_s - start) / max(fade_in_end - start, 0.001)
        return CIN_ENTRANCE_START_SCALE + (1.0 - CIN_ENTRANCE_START_SCALE) * \
            _cubic_bezier_ease(progress)
    if time_s > hold_end:
        # Letter fade-out expands from the settled scale using the same
        # cubic-bezier feel and ends at the requested exit scale.
        progress = (time_s - hold_end) / max(event_end - hold_end, 0.001)
        return 1.0 + (CIN_EXIT_EXPAND_SCALE - 1.0) * _cubic_bezier_ease(progress)
    return 1.0


def _scale_mask_about_center(mask: Image.Image, scale: float,
                             reference_bbox: tuple[int, int, int, int] | None = None) -> Image.Image:
    """Scale a mask above or below normal around a shared sentence centre."""
    bbox = reference_bbox or mask.getbbox()
    if abs(scale - 1.0) <= 0.0001 or not bbox:
        return mask
    left, top, right, bottom = bbox
    crop = mask.crop((left, top, right, bottom))
    new_w = max(1, int(round(crop.width * scale)))
    new_h = max(1, int(round(crop.height * scale)))
    enlarged = crop.resize((new_w, new_h), Image.Resampling.LANCZOS)
    out = Image.new("L", mask.size, 0)
    center_x = (left + right) / 2.0
    center_y = (top + bottom) / 2.0
    out.paste(enlarged, (int(round(center_x - new_w / 2.0)),
                         int(round(center_y - new_h / 2.0))))
    return out


def _apply_mask(canvas: Image.Image, mask: Image.Image,
                rgb: tuple[int, int, int], opacity: float = 1.0,
                offset: tuple[int, int] = (0, 0)) -> None:
    """Composite an L-mask onto an RGBA canvas using a precise alpha scale."""
    if offset != (0, 0):
        shifted = Image.new("L", mask.size, 0)
        shifted.paste(mask, offset)
        mask = shifted
    if opacity != 1.0:
        mask = mask.point(lambda value: int(round(value * opacity)))
    if not mask.getbbox():
        return
    layer = Image.new("RGBA", canvas.size, (*rgb, 0))
    layer.putalpha(mask)
    canvas.alpha_composite(layer)


def _raster_caption_layers(sentences: list[dict], keyword_map: dict,
                           width: int, height: int, time_s: float,
                           font) -> Image.Image:
    """Return compact caption glyphs over a soft gray-black drop shadow."""
    foreground = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for sentence in sentences:
        start = sentence["start"]
        hold_end = max(sentence["speak_end"], start + CIN_SENTENCE_MIN_SECONDS)
        event_end = hold_end + CIN_LETTER_FADE_OUT_MS / 1000.0 + 0.10
        if time_s < start or time_s > event_end:
            continue
        masks: dict[tuple[int, int, int], Image.Image] = {}
        union = Image.new("L", (width, height), 0)
        draw_by_color: dict[tuple[int, int, int], ImageDraw.ImageDraw] = {}
        char_count = sum(len(word["word"].upper()) for word in sentence["words"])
        char_index = 0
        measure = ImageDraw.Draw(Image.new("L", (1, 1)))
        for run in _caption_layout(sentence, font, width, height):
            word = run["source"]
            display = run["display"]
            color = _caption_color(keyword_map.get(subtitle_common._norm_token(word["word"])))
            if color not in masks:
                masks[color] = Image.new("L", (width, height), 0)
                draw_by_color[color] = ImageDraw.Draw(masks[color])
            prefix = ""
            for char in display:
                fade_in = max(0.0, min(1.0, (time_s - word["start"]) /
                                      (CIN_WORD_FADE_IN_MS / 1000.0)))
                fade_start = hold_end + (char_index / max(char_count, 1)) * \
                    (CIN_LETTER_FADE_OUT_MS / 1000.0)
                fade_end = fade_start + max(0.025, (CIN_LETTER_FADE_OUT_MS / 1000.0) /
                                             max(char_count, 1) * 1.2)
                fade_out = 1.0 if time_s <= fade_start else max(
                    0.0, min(1.0, 1.0 - (time_s - fade_start) /
                    max(fade_end - fade_start, 0.001)))
                alpha = int(round(255 * fade_in * fade_out))
                if alpha:
                    x = run["x"] + measure.textlength(prefix, font=font)
                    draw_by_color[color].text((x, run["y"]), char,
                                              font=font, fill=alpha)
                prefix += char
                char_index += 1
        for mask in masks.values():
            union = ImageChops.lighter(union, mask)
        sentence_bbox = union.getbbox()
        if not sentence_bbox:
            continue
        scale = _sentence_transition_scale(sentence, time_s)
        if scale > 1.0001:
            masks = {
                color: _scale_mask_about_center(mask, scale, sentence_bbox)
                for color, mask in masks.items()
            }
            union = _scale_mask_about_center(union, scale, sentence_bbox)
        soft_shadow = union.filter(
            ImageFilter.GaussianBlur(radius=CIN_RASTER_SHADOW_BLUR_RADIUS))
        _apply_mask(foreground, soft_shadow, CIN_RASTER_SHADOW_RGB,
                    CIN_RASTER_SHADOW_ALPHA,
                    (CIN_RASTER_SHADOW_X, CIN_RASTER_SHADOW_Y))
        for color, mask in masks.items():
            _apply_mask(foreground, mask, color)
    return foreground


def render_cinematic_overlays(sentences: list[dict], keyword_map: dict,
                              width: int, height: int, duration: float,
                              out_foreground_mov: str) -> None:
    """Encode the single soft-drop-shadow caption overlay stream."""
    font_size = max(24, int(round(height * CIN_FONT_FRACTION_OF_HEIGHT)))
    font = _caption_font(font_size)
    frame_count = max(1, int(math.ceil(duration * CIN_RASTER_FPS)))
    cmd = [
        "ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{width}x{height}", "-r", str(CIN_RASTER_FPS), "-i", "-",
        "-an", "-c:v", "qtrle", "-pix_fmt", "argb", out_foreground_mov,
    ]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    print(f"Rendering {frame_count} soft-drop-shadow caption frame(s) at "
          f"{CIN_RASTER_FPS}fps -> {out_foreground_mov}", flush=True)
    try:
        for frame_index in range(frame_count):
            foreground = _raster_caption_layers(
                sentences, keyword_map, width, height,
                frame_index / CIN_RASTER_FPS, font)
            assert proc.stdin is not None
            proc.stdin.write(foreground.tobytes())
    finally:
        if proc.stdin is not None:
            proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg failed while encoding flat-shadow caption stream")


def burn_subtitles(video: str, caption_foreground_mov: str, dst: str,
                   banner: dict | None = None,
                   crop_plan: dict | None = None) -> None:
    """Apply scene-static crops, then composite flat 3D-shadow captions and banner."""
    inputs = ["-i", video, "-i", caption_foreground_mov]
    if crop_plan is None:
        # Defensive default for direct callers: a single centre crop preserves
        # pre-Batch-D behavior while the normal CLI always supplies a plan.
        crop_plan = {
            "target_width": CIN_FRAME_WIDTH,
            "target_height": CIN_FRAME_HEIGHT,
            "scenes": [{"start_seconds": 0.0, "end_seconds": _probe_video_duration(video),
                        "crop_center_x": 0.5, "crop_center_y": 0.5}],
        }
    crop_filters, crop_label = cinematic_reframe.scene_crop_filter(crop_plan, "0:v")
    filters = [
        *crop_filters,
        f"[{crop_label}]format=gbrp[base]",
        "[1:v]setpts=PTS-STARTPTS,format=rgba[foreground]",
        "[base][foreground]overlay=eof_action=pass:repeatlast=0[v0]",
    ]
    out_label = "v0"
    if banner is not None:
        rest_top = int(round(CIN_FRAME_HEIGHT * CIN_BANNER_TOP_FRACTION))
        out_end = (CIN_BANNER_IN_SECONDS + CIN_BANNER_HOLD_SECONDS
                   + CIN_BANNER_OUT_SECONDS)
        inputs += ["-loop", "1", "-i", banner["png"]]
        y_expr = _banner_y_expr(rest_top)
        filters.append(f"[2:v]trim=duration={out_end},setpts=PTS-STARTPTS[bimg]")
        filters.append(
            f"[v0][bimg]overlay=x=0:y='{y_expr}'"
            f":enable='lt(t,{out_end})':eof_action=pass[v1]")
        out_label = "v1"
    cmd = [
        "ffmpeg", "-y", *inputs, "-filter_complex", ";".join(filters),
        "-map", f"[{out_label}]", "-map", "0:a:0", "-c:v", "libx264",
        "-profile:v", "high", "-level:v", "4.0", "-preset", "veryfast",
        "-crf", "18", "-pix_fmt", "yuv420p", "-bf", "0", "-g", "60",
        "-keyint_min", "60", "-sc_threshold", "0",
        "-x264-params", "force-cfr=1", "-video_track_timescale", "15360",
        "-c:a", "copy", "-movflags", "+faststart", "-use_editlist", "0",
        "-brand", "mp42", "-map_metadata", "-1", "-map_chapters", "-1",
        "-sn", "-dn", "-ignore_unknown", "-fflags", "+genpts",
        "-max_muxing_queue_size", "9999", "-f", "mp4", dst,
    ]
    subtitle_common.sh(cmd)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("merged_video_mp4")
    ap.add_argument("voiceover_wav")
    ap.add_argument("out_video_mp4")
    ap.add_argument("--script-json", default=None,
                    help="production.json / cuts.json / "
                         "voiceover_manifest.json carrying the ORIGINAL "
                         "script (voiceover_text per cut) plus optional "
                         "literal keyword colors. Strongly recommended: "
                         "without it the transcription's wording is used "
                         "as a legacy fallback.")
    ap.add_argument("--model", default="base", choices=["tiny", "base", "small"])
    ap.add_argument("--lang", default="auto")
    ap.add_argument("--work-dir", default=None,
                    help="scratch dir for transcript, ASS debug data, and raster caption overlay (default: "
                         "<out dir>/subtitle_work_cinematic)")
    ap.add_argument("--scene-threshold", type=float,
                    default=cinematic_reframe.DEFAULT_SCENE_THRESHOLD,
                    help="ffmpeg scene-score threshold used for static cinematic crop planning (default: 0.35)")
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
    timed_words = subtitle_common.transcribe_words(args.voiceover_wav, args.model,
                                          args.lang, work_dir)

    keyword_map: dict[str, str] = {}
    if args.script_json:
        # Original script = AUTHORITATIVE WORDING; keywords = additive
        # literal author-selected keyword-color metadata.
        script_texts, keyword_map = load_script_with_keywords(args.script_json)
        words = subtitle_common.align_words_to_script(timed_words, script_texts)
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

    source_width, source_height = subtitle_common.probe_video_size(args.merged_video_mp4)
    width, height = CIN_FRAME_WIDTH, CIN_FRAME_HEIGHT
    crop_plan = cinematic_reframe.build_scene_crop_plan(
        args.merged_video_mp4, threshold=args.scene_threshold)
    crop_plan_path = os.path.join(work_dir, "cinematic_crop_plan.json")
    cinematic_reframe.write_crop_plan(crop_plan, crop_plan_path)
    print(
        f"Source video resolution: {source_width}x{source_height}; "
        f"cinematic output uses {crop_plan['scene_count']} static scene crop(s) "
        f"in the bare {width}x{height} (10:9) frame. Initial positions are "
        f"safe centre fallbacks; character centres are selected in the next stage.",
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

    # Retain the ASS as a human-readable timing/debug artefact, while the
    # production image uses the Pillow-rendered compact soft-drop-shadow treatment.
    ass_path = os.path.join(work_dir, "subtitles_cinematic.ass")
    write_cinematic_ass(sentences, keyword_map, width, height, ass_path)
    foreground_mov = os.path.join(work_dir, "cinematic_caption_flat_shadow.mov")
    render_cinematic_overlays(
        sentences, keyword_map, width, height,
        _probe_video_duration(args.merged_video_mp4), foreground_mov)

    print(f"Compositing flat-3D-shadow cinematic captions"
          f"{' + title banner' if banner else ''} into "
          f"{args.out_video_mp4} ...", flush=True)
    burn_subtitles(args.merged_video_mp4, foreground_mov,
                   args.out_video_mp4, banner=banner, crop_plan=crop_plan)
    print(f"Final cinematically-subtitled video written: "
          f"{args.out_video_mp4}", flush=True)


if __name__ == "__main__":
    main()
