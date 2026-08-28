"""Stage B — optional, mobile-safe enhancement pass on the merged final MP4.

The picture chain is, in order:

    light hqdn3d shimmer denoise → supplied 3D color-cube grade → 2x
    lanczos upscale → sharpen on the upsampled frame → rescale BACK to the
    source's own 9:10 frame → gradfun debanding → yuv420p

Rationale (hard-won, do not relitigate):

* ``hqdn3d`` is used lightly and only to remove H.264 compression shimmer
  BEFORE it can be amplified by later sharpening. Do NOT swap back to
  ``nlmeans`` — it is orders of magnitude slower and produced the exact
  "plastered / over-smooth" look this pass exists to avoid.
* The bundled 64³ color cube (``assets/vibrant_glow_color_cube_l8.png``,
  FFmpeg Hald level-8) is bug-59's "vibrant multi-hue glow" grade,
  synthesised by ``pipeline/stage_b/build_glow_lut.py`` from the user's
  960x540 gradient-tile reference image (a mood reference, NOT a valid HALD
  CLUT identity — never feed that image to ``haldclut`` directly). It is the
  only color transform in this stage and runs BEFORE the sharpeners.
* ``cas`` restores texture/edge definition in a locally content-aware way.
* ``unsharp`` sharpens line ink specifically (luma threshold keeps it off flat
  regions; zeroed chroma matrix avoids chromatic fringing).
* ``gradfun`` cleans 8-bit banding; ``setsar=1`` guarantees square pixels.

When disabled, the input is left completely untouched. The output is validated
against the same mobile-safe contract before it replaces the input (atomic
swap; no partial file is ever left in place).

Ported from ``_legacy/scripts/enhance_scenes.py``.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

from pipeline.stage_b import common

DENOISE = "hqdn3d=0.8:0.6:3.0:2.0"
LUT_FILTER = "haldclut=shortest=1"

LUT_GRID_SOURCE = common.LUT_GRID_SOURCE
LUT_ASSET = common.LUT_HALD_ASSET

# bug-11: detail-preserving 2x lanczos upscale to pseudo-4K (capped at
# 2160x3840) inserted between the color grade and the sharpeners, so cas/
# unsharp work on the upsampled frame — the AE-style "scale up, then
# sharpen" pass. CPU-only (lanczos/cas/unsharp are all CPU filters), safe
# for GitHub Actions runners; no GPU dependency introduced.
UPSCALE = "scale=w='min(2160,2*iw)':h='min(3840,2*ih)':flags=lanczos"
# bug-25: the 2x upscale must NOT be left in the delivered file. It used to
# stop the pipeline here, so final.mp4 came out at 2x the source resolution.
# The captions/reframe stage then ran
# ``scale=1080:1200:force_original_aspect_ratio=increase,crop=1080:1200`` on
# that 2x frame — force_original_aspect_ratio=increase scales the source's
# aspect onto the TARGET box and crops the overflow, so a frame that was
# already the target shape gets its aspect re-interpreted and force-cropped
# to 9:10. That is the vertical-stretch regression. And because the final
# crop happened AFTER the sharpeners, the sharpening was partially cropped /
# rescaled away (the missing-sharpening complaint). Fix: upscale only to give
# the sharpeners a bigger canvas, then rescale back to the SOURCE'S OWN
# frame so enhance is resolution-neutral and the sharpened detail survives
# all the way to delivery.`` setsar=1`` keeps pixels square; the source's
# own SAR is restored below, never hardcoded 1080x1200 here.
RESCALE_BACK = (
    "scale=w='trunc(iw/2/2)*2':h='trunc(ih/2/2)*2':flags=lanczos,setsar=1"
)
EDGE_SHARPEN = "cas=strength=0.75"
LINE_SHARPEN = "unsharp=7:7:0.85:5:5:0.35"
DEBAND = "gradfun=1.2:16"

FILTER_CHAIN = (
    f"{DENOISE},{LUT_FILTER},{UPSCALE},{EDGE_SHARPEN},{LINE_SHARPEN},"
    f"{RESCALE_BACK},{DEBAND},format=yuv420p,setsar=1"
)

# Mobile-safe encoding parameters (same contract as render.py).
TARGET_FPS = 30
TARGET_PIX_FMT = "yuv420p"
X264_PROFILE = "high"
X264_LEVEL = "4.0"
X264_PRESET = "medium"
X264_TUNE = "animation"
X264_CRF = "24"
X264_MAXRATE = "8M"
X264_BUFSIZE = "16M"


def _level_and_vbv(src: str) -> tuple[str, str, str]:
    """Return (level, maxrate, bufsize) sized for the upscaled output.

    bug-11: 2160x3840 needs H.264 Level 5.1 (Level 4.0 tops out below it);
    anything smaller keeps the original Level 4.0 contract.
    """
    try:
        data = common.probe_json(src)
        width = height = 0
        for stream in data.get("streams", []):
            if stream.get("codec_type") == "video":
                width = int(stream.get("width") or 0)
                height = int(stream.get("height") or 0)
                break
        out_w, out_h = min(2160, 2 * width), min(3840, 2 * height)
        if max(out_w, out_h) > 2048 or (out_w * out_h) > (2048 * 2048):
            return "5.1", "20M", "40M"
    except Exception:
        pass
    return X264_LEVEL, X264_MAXRATE, X264_BUFSIZE


def enhance_one(src: str, dst: str) -> None:
    """Denoise, upscale, apply the supplied color cube, and sharpen one video."""
    level, maxrate, bufsize = _level_and_vbv(src)
    graph = (
        f"[0:v]{DENOISE}[denoised];"
        f"[denoised][1:v]{LUT_FILTER},{UPSCALE},{EDGE_SHARPEN},"
        f"{LINE_SHARPEN},{RESCALE_BACK},{DEBAND},format=yuv420p,setsar=1[enhanced]"
    )
    cmd = [
        "ffmpeg", "-y",
        "-i", src,
        # The color cube is a looping second video input; ``shortest=1`` makes
        # output duration follow the scene, not this infinite image stream.
        "-loop", "1", "-framerate", str(TARGET_FPS), "-i", str(LUT_ASSET),
        "-filter_complex", graph,
        "-map", "[enhanced]", "-map", "0:a:0",
        "-c:v", "libx264",
        "-profile:v", X264_PROFILE,
        "-level:v", level,
        "-preset", X264_PRESET,
        "-tune", X264_TUNE,
        "-crf", X264_CRF,
        "-maxrate", maxrate,
        "-bufsize", bufsize,
        "-pix_fmt", TARGET_PIX_FMT,
        "-bf", "0",
        "-g", str(TARGET_FPS * 2),
        "-keyint_min", str(TARGET_FPS * 2),
        "-sc_threshold", "0",
        "-x264-params", "force-cfr=1",
        "-r", str(TARGET_FPS),
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
        "-f", "mp4", dst,
    ]
    common.sh(cmd)


def validate_enhanced(path: str) -> None:
    """Fail before swapping unless the enhanced MP4 is mobile-safe."""
    with open(path, "rb") as handle:
        head = handle.read(12)
    if len(head) < 12 or head[4:8] != b"ftyp":
        raise common.StageBError(f"{path} is missing an MP4 ftyp box")

    data = common.probe_json(path)
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    video = [s for s in streams if s.get("codec_type") == "video"]
    audio = [s for s in streams if s.get("codec_type") == "audio"]
    if len(video) != 1 or len(audio) != 1 or len(streams) != 2:
        kinds = [f"{s.get('codec_type')}:{s.get('codec_name')}" for s in streams]
        raise common.StageBError(
            f"{path} must contain exactly one video and one audio stream; got {kinds}"
        )

    stream = video[0]
    if stream.get("codec_name") != "h264":
        raise common.StageBError(f"video codec {stream.get('codec_name')!r}, expected h264")
    if stream.get("profile") not in ("High", "High 10"):
        raise common.StageBError(f"video profile {stream.get('profile')!r}, expected High")
    if stream.get("pix_fmt") != TARGET_PIX_FMT:
        raise common.StageBError(f"pixel format {stream.get('pix_fmt')!r}, expected {TARGET_PIX_FMT!r}")
    if stream.get("has_b_frames") not in (0, "0"):
        raise common.StageBError(f"has_b_frames={stream.get('has_b_frames')!r}, expected 0")
    if stream.get("r_frame_rate") != f"{TARGET_FPS}/1":
        raise common.StageBError(f"frame rate {stream.get('r_frame_rate')!r}, expected {TARGET_FPS}/1")

    for label, value in (("container", fmt.get("start_time", "0")),
                         ("video", stream.get("start_time", "0"))):
        try:
            if abs(float(value)) > 0.05:
                raise common.StageBError(f"{label} start_time={value}, expected ~0")
        except (TypeError, ValueError):
            # ffprobe may omit an optional start_time; the muxer settings above
            # still guarantee a zero-origin output and avoid edit lists.
            pass
    print(f"  OK: {path} still mobile-safe after enhancement.", flush=True)


def enhance_video(target: Path, *, enabled: bool = True) -> bool:
    """Enhance one MP4 in place (atomic swap after validation).

    Returns True when enhancement was applied, False when disabled/no-op.
    """
    if not enabled:
        print("Quality enhancement DISABLED — video left untouched.", flush=True)
        return False
    if not LUT_GRID_SOURCE.is_file():
        raise common.StageBError(f"graded .cube source missing: {LUT_GRID_SOURCE}")
    if not LUT_ASSET.is_file():
        raise common.StageBError(f"bundled color-cube asset missing: {LUT_ASSET}")
    if not target.is_file():
        raise common.StageBError(f"video to enhance does not exist: {target}")

    before = target.stat().st_size
    tmp = target.with_suffix(".enhanced.mp4")
    print(
        f"Enhancing {target.name} ({before / 1024 / 1024:.2f} MB) with supplied "
        f"color-cube chain:\n  {FILTER_CHAIN} (LUT: {LUT_ASSET.name})\n"
        f"  H.264 High@L{X264_LEVEL}, {TARGET_PIX_FMT}, CRF {X264_CRF}, "
        f"preset={X264_PRESET}, tune={X264_TUNE}, CFR {TARGET_FPS}, no B-frames.",
        flush=True,
    )
    try:
        enhance_one(str(target), str(tmp))
        validate_enhanced(str(tmp))
        after = tmp.stat().st_size
        print(
            f"  size: {before / 1024 / 1024:.2f} MB -> {after / 1024 / 1024:.2f} MB "
            f"({(after - before) / before * 100 if before else 0:+.1f}%)",
            flush=True,
        )
        os.replace(tmp, target)
    finally:
        # No incomplete .enhanced.mp4 is left behind if ffmpeg/validation fails.
        if tmp.exists():
            tmp.unlink()
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Apply the anime Hald-LUT enhancement chain to an MP4 in place."
    )
    parser.add_argument("video", help="the merged MP4 to enhance in place")
    parser.add_argument("--enabled", dest="enabled", action="store_true", default=True,
                        help="Apply enhancement (default).")
    parser.add_argument("--no-enabled", dest="enabled", action="store_false",
                        help="No-op: leave the file completely untouched.")
    args = parser.parse_args(argv)
    enhance_video(Path(args.video), enabled=args.enabled)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except common.StageBError as exc:
        import sys

        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        raise SystemExit(3)
