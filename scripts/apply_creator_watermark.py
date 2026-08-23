#!/usr/bin/env python3
"""Burn a brief cinematic creator-title overlay into the final Stage B video.

The existing ``branding/creator_watermark.json`` profile remains the source of
truth for the creator name, but the rendered treatment is intentionally no
longer a persistent watermark. When a name is configured, the final video gets
one short title-card moment near the visual centre: warm off-white title text,
a soft letter-shaped shadow, and two restrained cool/warm accent rules. The
card stays inside explicit safe margins and clears before the regular caption
sequence becomes visually dense.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
FONT_PATH = ROOT / "assets" / "fonts" / "Coolvetica.ttf"

# Composition. The name is a brief title-card moment, not a static watermark.
FONT_CONDENSE_RATIO = 0.84
FONT_HEIGHT_FRACTION = 0.078
MIN_FONT_SIZE = 44
MAX_FONT_SIZE = 122
TITLE_CENTER_Y_FRACTION = 0.44
TOP_SAFE_FRACTION = 0.16
BOTTOM_SAFE_FRACTION = 0.19
TITLE_MAX_WIDTH_FRACTION = 0.78
OVERLAY_DURATION_SECONDS = 2.8
OVERLAY_FADE_IN_SECONDS = 0.22
OVERLAY_FADE_OUT_SECONDS = 0.32

# Legibility without a flat opaque word box. The shadow remains letter-shaped.
SHADOW_BLUR_RADIUS_PX = 3.2
SHADOW_OPACITY = 0.82
SHADOW_OFFSET_Y_PX = 5
TITLE_OPACITY = 0.92
TITLE_COLOR = (255, 243, 226)
ACCENT_COOL_COLOR = (89, 221, 212, 162)
ACCENT_WARM_COLOR = (255, 96, 47, 224)


def probe(path: Path) -> tuple[int, int]:
    result = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries", "stream=width,height", "-of", "json", str(path),
        ],
        check=True, capture_output=True, text=True,
    )
    stream = json.loads(result.stdout)["streams"][0]
    return int(stream["width"]), int(stream["height"])


def fit_title_mask(name: str, width: int, height: int) -> tuple[Image.Image, tuple[int, int]]:
    """Create a centered, condensed title mask within the cinematic safe area."""
    if not FONT_PATH.is_file():
        raise FileNotFoundError(f"Bundled title font is missing: {FONT_PATH}")

    font_size = max(MIN_FONT_SIZE, min(MAX_FONT_SIZE, round(height * FONT_HEIGHT_FRACTION)))
    font = ImageFont.truetype(str(FONT_PATH), size=font_size)
    scratch = Image.new("L", (1, 1))
    draw = ImageDraw.Draw(scratch)
    left, top, right, bottom = draw.textbbox((0, 0), name, font=font, stroke_width=0)
    natural_width = max(1, right - left)
    natural_height = max(1, bottom - top)

    # Reserve room for the soft shadow so neither its blur nor its offset clips
    # at a safe-area boundary.
    pad = int(SHADOW_BLUR_RADIUS_PX * 3) + SHADOW_OFFSET_Y_PX + 5
    glyph = Image.new("L", (natural_width + pad * 2, natural_height + pad * 2), 0)
    glyph_draw = ImageDraw.Draw(glyph)
    glyph_draw.text((pad - left, pad - top), name, font=font, fill=255)

    condensed_width = max(1, round(glyph.width * FONT_CONDENSE_RATIO))
    glyph = glyph.resize((condensed_width, glyph.height), Image.Resampling.LANCZOS)
    max_width = round(width * TITLE_MAX_WIDTH_FRACTION)
    if glyph.width > max_width:
        scale = max_width / glyph.width
        glyph = glyph.resize((max_width, max(1, round(glyph.height * scale))), Image.Resampling.LANCZOS)

    x = (width - glyph.width) // 2
    preferred_y = round(height * TITLE_CENTER_Y_FRACTION) - glyph.height // 2
    min_y = round(height * TOP_SAFE_FRACTION)
    max_y = height - round(height * BOTTOM_SAFE_FRACTION) - glyph.height
    y = max(min_y, min(preferred_y, max_y))
    return glyph, (x, y)


def build_layers(name: str, width: int, height: int, directory: Path) -> tuple[Path, Path, Path]:
    """Create full-frame title, shadow, and accent layers for FFmpeg compositing."""
    glyph, (x, y) = fit_title_mask(name, width, height)

    title_alpha = Image.new("L", (width, height), 0)
    title_alpha.paste(glyph, (x, y))
    title_alpha = title_alpha.point(lambda value: round(value * TITLE_OPACITY))
    title_rgba = Image.new("RGBA", (width, height), TITLE_COLOR + (0,))
    title_rgba.putalpha(title_alpha)

    shadow_source = Image.new("L", (width, height), 0)
    shadow_source.paste(glyph, (x, y + SHADOW_OFFSET_Y_PX))
    shadow_alpha = shadow_source.filter(ImageFilter.GaussianBlur(SHADOW_BLUR_RADIUS_PX))
    shadow_alpha = shadow_alpha.point(lambda value: round(value * SHADOW_OPACITY))
    shadow_rgba = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    shadow_rgba.putalpha(shadow_alpha)

    # Thin rules borrow the supplied reference's cyan-to-warm visual language
    # without becoming a broad banner behind the title.
    accent = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    accent_draw = ImageDraw.Draw(accent)
    rule_height = max(3, round(height * 0.0035))
    gap = max(9, round(height * 0.014))
    title_width = glyph.width
    cool_width = max(round(width * 0.13), round(title_width * 0.42))
    warm_width = max(round(width * 0.18), round(title_width * 0.66))
    cool_left = (width - cool_width) // 2
    warm_left = (width - warm_width) // 2
    cool_y = max(round(height * TOP_SAFE_FRACTION), y - gap - rule_height)
    warm_y = min(height - round(height * BOTTOM_SAFE_FRACTION) - rule_height, y + glyph.height + gap)
    accent_draw.rounded_rectangle(
        (cool_left, cool_y, cool_left + cool_width, cool_y + rule_height),
        radius=rule_height // 2, fill=ACCENT_COOL_COLOR,
    )
    accent_draw.rounded_rectangle(
        (warm_left, warm_y, warm_left + warm_width, warm_y + rule_height),
        radius=rule_height // 2, fill=ACCENT_WARM_COLOR,
    )

    shadow_path = directory / "creator_title_shadow.png"
    accent_path = directory / "creator_title_accent.png"
    title_path = directory / "creator_title.png"
    shadow_rgba.save(shadow_path)
    accent.save(accent_path)
    title_rgba.save(title_path)
    return shadow_path, accent_path, title_path


def apply_watermark(source: Path, destination: Path, name: str) -> None:
    """Apply the profile name as one short cinematic creator-title moment."""
    name = " ".join(name.split())
    if not name:
        shutil.copyfile(source, destination)
        print("Creator overlay empty — copied video without a title card.")
        return

    width, height = probe(source)
    with tempfile.TemporaryDirectory(prefix="clipforge_creator_title_") as tmp:
        shadow_path, accent_path, title_path = build_layers(name, width, height, Path(tmp))
        enabled = f"between(t,0,{OVERLAY_DURATION_SECONDS})"
        fade_out_start = OVERLAY_DURATION_SECONDS - OVERLAY_FADE_OUT_SECONDS
        fade = (
            f"fade=t=in:st=0:d={OVERLAY_FADE_IN_SECONDS}:alpha=1,"
            f"fade=t=out:st={fade_out_start}:d={OVERLAY_FADE_OUT_SECONDS}:alpha=1"
        )
        graph = (
            "[0:v]setpts=PTS-STARTPTS,format=rgba[base];"
            f"[1:v]setpts=PTS-STARTPTS,format=rgba,{fade}[shadow];"
            f"[base][shadow]overlay=shortest=1:format=auto:enable='{enabled}'[shadowed];"
            f"[2:v]setpts=PTS-STARTPTS,format=rgba,{fade}[accent];"
            f"[shadowed][accent]overlay=shortest=1:format=auto:enable='{enabled}'[accented];"
            f"[3:v]setpts=PTS-STARTPTS,format=rgba,{fade}[title];"
            f"[accented][title]overlay=shortest=1:format=auto:enable='{enabled}'[cinematic_overlay]"
        )
        command = [
            "ffmpeg", "-y", "-i", str(source),
            "-loop", "1", "-framerate", "30", "-i", str(shadow_path),
            "-loop", "1", "-framerate", "30", "-i", str(accent_path),
            "-loop", "1", "-framerate", "30", "-i", str(title_path),
            "-filter_complex", graph,
            "-map", "[cinematic_overlay]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-c:a", "copy",
            "-movflags", "+faststart", "-map_metadata", "-1", "-map_chapters", "-1",
            "-shortest", str(destination),
        ]
        print("Applying creator title card: warm text + soft letter shadow + restrained accent rules")
        print("$ " + " ".join(command), flush=True)
        subprocess.run(command, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--name", required=True, help="Creator title text; empty copies source unchanged")
    args = parser.parse_args()
    apply_watermark(args.source, args.destination, args.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
