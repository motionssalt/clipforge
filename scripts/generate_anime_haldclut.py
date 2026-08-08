#!/usr/bin/env python3
"""Generate the deterministic level-8 Hald CLUT used by enhance_scenes.py.

The LUT is intentionally created in-repository instead of fetched from a
third-party grade pack.  It applies a restrained anime/cel-animation grade:

* a filmic luma S-curve with a protected near-black toe;
* 1.28x HSV saturation away from warm hues;
* 1.10x saturation inside a broad 5°–55° warm protection band so skin,
  amber eyes, and red-orange highlights do not turn neon;
* subtle warm shadows and cool highlights.

A Hald level of 8 has a 64×64×64 colour cube laid out in a 512×512 PNG.
This file is reproducible byte-for-byte under a fixed Pillow/Python encoder
configuration and can be regenerated with:

    python scripts/generate_anime_haldclut.py
"""
from __future__ import annotations

import argparse
import colorsys
from pathlib import Path

from PIL import Image

HALD_LEVEL = 8
CUBE_SIDE = HALD_LEVEL * HALD_LEVEL  # 64 samples per RGB component
IMAGE_SIDE = HALD_LEVEL ** 3         # 512 pixels per image dimension
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "assets" / "anime_grade_haldclut_l8.png"


def clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def warm_hue_weight(hue_degrees: float) -> float:
    """Return 0..1 for the 5°–55° protected warm-hue band.

    The 5° ramps at both ends keep a colour close to the band from visibly
    changing saturation as it crosses a hue boundary.  The central 15°–45°
    region is fully protected, covering muted orange/amber as well as skin.
    """
    if hue_degrees < 5.0 or hue_degrees > 55.0:
        return 0.0
    if hue_degrees < 15.0:
        return (hue_degrees - 5.0) / 10.0
    if hue_degrees > 45.0:
        return (55.0 - hue_degrees) / 10.0
    return 1.0


def filmic_luma(luma: float) -> float:
    """A mild S-curve with an immutable deep-black toe and soft shoulder."""
    if luma <= 0.035:
        return luma
    # Contrast grows away from middle grey while vanishing at the endpoints.
    x = (luma - 0.035) / 0.965
    curved = x + 0.115 * (x - 0.5) * 4.0 * x * (1.0 - x)
    # Compress only the final highlight region so the curve rolls into white.
    if curved > 0.82:
        curved = 0.82 + (curved - 0.82) * 0.78
    return clamp(0.035 + 0.965 * curved)


def grade_rgb(red: int, green: int, blue: int) -> tuple[int, int, int]:
    """Map one 8-bit RGB triplet through the anime grade."""
    r, g, b = red / 255.0, green / 255.0, blue / 255.0
    luma = 0.2126 * r + 0.7152 * g + 0.0722 * b

    # Preserve true/deep blacks exactly so drawn ink remains ink-black.
    if luma <= 0.035:
        return red, green, blue

    # Apply luma curve by scaling RGB, retaining hue before HSV saturation.
    target_luma = filmic_luma(luma)
    scale = target_luma / luma
    r, g, b = clamp(r * scale), clamp(g * scale), clamp(b * scale)

    hue, saturation, value = colorsys.rgb_to_hsv(r, g, b)
    warm_weight = warm_hue_weight(hue * 360.0)
    saturation_multiplier = 1.28 * (1.0 - warm_weight) + 1.10 * warm_weight
    r, g, b = colorsys.hsv_to_rgb(hue, clamp(saturation * saturation_multiplier), value)

    # Gentle split tone: warm (slightly red) shadow values; cool (slightly
    # blue) highlights.  Both fade in smoothly and stay deliberately subtle.
    shadow_weight = clamp((0.45 - target_luma) / 0.415)
    highlight_weight = clamp((target_luma - 0.55) / 0.40)
    r = clamp(r + 0.010 * shadow_weight - 0.004 * highlight_weight)
    g = clamp(g - 0.002 * shadow_weight + 0.001 * highlight_weight)
    b = clamp(b - 0.004 * shadow_weight + 0.010 * highlight_weight)

    return tuple(int(round(channel * 255.0)) for channel in (r, g, b))


def build_hald(level: int = HALD_LEVEL) -> Image.Image:
    if level != HALD_LEVEL:
        raise ValueError("This generator is tuned and tested only for Hald level 8")
    pixels: list[tuple[int, int, int]] = []
    # ffmpeg's haldclutsrc level-8 ordering is R-fastest, then G, then B.
    for blue in range(CUBE_SIDE):
        for green in range(CUBE_SIDE):
            for red in range(CUBE_SIDE):
                source = tuple(round(component * 255 / (CUBE_SIDE - 1))
                               for component in (red, green, blue))
                pixels.append(grade_rgb(*source))
    image = Image.new("RGB", (IMAGE_SIDE, IMAGE_SIDE))
    image.putdata(pixels)
    return image


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate ClipForge anime Hald CLUT PNG")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT,
                        help="Output PNG path (default: assets/anime_grade_haldclut_l8.png)")
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    build_hald().save(args.output, format="PNG", optimize=False, compress_level=9)
    print(f"Wrote {args.output} ({IMAGE_SIDE}x{IMAGE_SIDE}, Hald level {HALD_LEVEL})")


if __name__ == "__main__":
    main()
