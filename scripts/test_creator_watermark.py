#!/usr/bin/env python3
"""Regression checks for ClipForge's cinematic creator-title overlay."""
from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "apply_creator_watermark.py"
COMPOSITOR = MODULE_PATH.read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "stage-b.yml").read_text(encoding="utf-8")
APP = (ROOT / "app.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")

spec = importlib.util.spec_from_file_location("apply_creator_watermark", MODULE_PATH)
assert spec and spec.loader
watermark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watermark)


def test_title_layers_are_centered_safe_and_not_banner_like() -> None:
    with tempfile.TemporaryDirectory(prefix="creator_title_") as directory:
        shadow_path, accent_path, title_path = watermark.build_layers("Fubara", 1080, 1200, Path(directory))
        shadow = Image.open(shadow_path).convert("RGBA")
        accent = Image.open(accent_path).convert("RGBA")
        title = Image.open(title_path).convert("RGBA")
        shadow_alpha = shadow.getchannel("A")
        accent_alpha = accent.getchannel("A")
        title_alpha = title.getchannel("A")
        shadow_box = shadow_alpha.getbbox()
        accent_box = accent_alpha.getbbox()
        title_box = title_alpha.getbbox()
        assert shadow_box and accent_box and title_box
        assert 0 < shadow_alpha.getextrema()[1] < 255, "shadow must be visible but never opaque"
        assert 0 < title_alpha.getextrema()[1] < 255, "title must retain composited texture"
        assert 120 < title_box[2] - title_box[0] < 700, "title should be prominent but never full-width"
        center = (title_box[0] + title_box[2]) / 2
        assert abs(center - 540) <= 2, "title should remain centred"
        assert title_box[1] >= round(1200 * watermark.TOP_SAFE_FRACTION)
        assert title_box[3] <= 1200 - round(1200 * watermark.BOTTOM_SAFE_FRACTION) + 2
        assert accent_box[1] >= round(1200 * watermark.TOP_SAFE_FRACTION)
        assert accent_box[3] <= 1200 - round(1200 * watermark.BOTTOM_SAFE_FRACTION) + 2
        assert accent_box[3] - accent_box[1] < round(1200 * 0.35), "accent composition must not become a large title banner"


def test_overlay_is_brief_cinematic_treatment_with_letter_shaped_shadow() -> None:
    assert "ImageFilter.GaussianBlur" in COMPOSITOR
    assert "ImageFilter.MaxFilter" not in COMPOSITOR
    assert "OVERLAY_DURATION_SECONDS = 2.8" in COMPOSITOR
    assert "OVERLAY_FADE_IN_SECONDS = 0.22" in COMPOSITOR
    assert "OVERLAY_FADE_OUT_SECONDS = 0.32" in COMPOSITOR
    assert "fade=t=in:st=0:d={OVERLAY_FADE_IN_SECONDS}:alpha=1" in COMPOSITOR
    assert "fade=t=out:st={fade_out_start}:d={OVERLAY_FADE_OUT_SECONDS}:alpha=1" in COMPOSITOR
    assert "between(t,0,{OVERLAY_DURATION_SECONDS})" in COMPOSITOR
    assert "warm text + soft letter shadow + restrained accent rules" in COMPOSITOR
    assert "blend=all_mode=screen" not in COMPOSITOR


def test_empty_name_is_an_explicit_no_overlay_copy() -> None:
    with tempfile.TemporaryDirectory(prefix="creator_title_") as directory:
        source = Path(directory) / "source.bin"
        destination = Path(directory) / "destination.bin"
        source.write_bytes(b"unchanged-video-bytes")
        watermark.apply_watermark(source, destination, "   \n")
        assert destination.read_bytes() == source.read_bytes()


def test_stage_b_applies_creator_profile_after_captions_and_before_delivery_compression() -> None:
    captions = WORKFLOW.index("- name: Burn cinematic subtitles into the final video")
    watermark_step = WORKFLOW.index("- name: Burn cinematic creator title overlay into final video")
    compress = WORKFLOW.index("- name: Compress final video for delivery")
    assert captions < watermark_step < compress
    assert "scripts/apply_creator_watermark.py" in WORKFLOW
    assert "CREATOR_WATERMARK_APPLIED" in WORKFLOW
    assert "creator_watermark.json" in WORKFLOW
    assert "inputs.brand" not in WORKFLOW
    assert "brand_scenes.py work/out" not in WORKFLOW
    assert "BRANDING_" not in WORKFLOW


def test_profile_ui_retains_creator_name_controls() -> None:
    assert "creator_watermark.json" in APP
    assert "watermark-name-input" in APP and "watermark-name-input" in HTML
    assert "branding-username-input" not in APP and "branding-username-input" not in HTML
    assert "branding-avatar-input" not in APP and "branding-avatar-input" not in HTML
    assert "loadWatermark" in APP and "saveWatermark" in APP
    assert "watermarkSha" in APP and "putRepoFile(WATERMARK_JSON_PATH" in APP


def test_frontend_has_a_safe_repository_file_writer() -> None:
    assert "async function putRepoFile(repoPath, content, message)" in APP
    assert "current = await gh(endpoint + '?ref=' + encodeURIComponent(REF))" in APP
    assert "if (current && current.sha) body.sha = current.sha" in APP
    assert "return gh(endpoint, { method: 'PUT', body: body })" in APP
    assert "Invalid repository file path." in APP
    assert 'src="app.js?v=' in HTML


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"Creator title overlay tests passed ({len(tests)} tests)")
