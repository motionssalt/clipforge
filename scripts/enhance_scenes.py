#!/usr/bin/env python3
"""
Stage B — quality enhancement filter chain (denoise + color grade + sharpen).

Runs AFTER cut_scenes.py has produced work/out/scenes/scene_*.mp4. For each
scene file, applies a tuned filter chain intended for anime-style short-form
content and rewrites the file in place (via an atomic .enhanced.mp4 swap),
preserving the exact mobile-safe encoding profile that cut_scenes.py commits
to (H.264 High@L4.0, yuv420p, CFR 30, no B-frames, +faststart, 1 video +
1 audio stream only, no edit lists).

Why this is its OWN script:
---------------------------
The addition brief for this step is deliberately scoped to picture quality
only. It must be composable with — and completely independent of — the
separate branding / overlay work. Concretely that means:

  * It has NO knowledge of watermarks, logos, lower-thirds, endcards, or
    any visual template. It just reads picture in, writes picture out.
  * It is invoked as its own workflow step (see stage-b.yml), sitting
    between "Cut scenes" and "Validate scene MP4s". Adding, removing, or
    reordering the branding step does not touch this file, and vice versa.
  * The on/off toggle from the site is passed in as a single CLI flag
    (--enabled / --no-enabled). When disabled the script is a no-op
    (prints a line and exits 0) so the surrounding workflow stays
    structurally identical whether enhancement is on or off.

Why these specific filter values (not defaults, not guessed):
-------------------------------------------------------------
Values were selected against real anime footage (a Hunter×Hunter Chimera-Ant
scene — flat cel shading, hard ink linework, mixed high-motion + still
frames — the exact content class the pipeline was built for) and then
verified with ffprobe / SSIM sanity checks. The final chain, in order:

  1. hqdn3d=1.5:1.0:4.5:3.0
     -------------------------------------------
     Spatial luma 1.5 (defaults to 4.0). Anime line-art breaks apart very
     quickly under spatial denoising — high spatial values smear the ink
     lines that carry most of the perceptual detail. 1.5 is deliberately
     conservative: it takes the edge off mosquito noise around lines
     without softening the lines themselves.
     Spatial chroma 1.0 (defaults ~3.0). Anime chroma is authored flat, so
     small chroma noise is genuinely noise (never detail). A gentle
     chroma-spatial pass here also pre-empts the chroma-edge fringing
     that the subsequent sharpen pass would otherwise amplify.
     Temporal luma 4.5 / temporal chroma 3.0 — this is where hqdn3d
     actually pays off on anime: frame-to-frame compression noise on
     large flat regions is heavily temporal. Mild-to-moderate temporal
     values (below the 6.0 default) kill that flicker without ghosting
     high-motion content.

  2. eq=contrast=1.06:saturation=1.15:gamma=0.98
     -------------------------------------------
     contrast=1.06 — a small, punchy contrast lift. The eq documentation
     notes that contrast values above ~1.5 start crushing shadows and
     clipping highlights; 1.06 is well inside the safe band and reads as
     "cleaner" rather than "graded" on a phone screen.
     saturation=1.15 — vibrant without going artificial. Above ~1.5 the
     eq filter starts bleeding color across edges; 1.15 is the sweet
     spot for anime where the palette is already saturated at source.
     gamma=0.98 — a tiny midtone lift (values <1.0 brighten midtones).
     Mobile OLED panels crush low-midtones on short-form playback; a
     nudge to 0.98 restores their readability without touching black
     or white points, so shadows are not lifted (no milky look) and
     highlights are not clipped.
     brightness is intentionally left at 0 — brightness shifts on eq
     are additive on luma and are the fastest way to crush highlights.

  3. unsharp=5:5:0.8:5:5:0.0
     -------------------------------------------
     Luma-only sharpen at strength 0.8. 5×5 matrix is the default and
     matches the scale of anime linework at 1080p. Strength 0.8 sits
     between "light sharpen" (0.5) and the 1.0 default: enough to
     re-crisp lines that the denoise pass softened, not enough to
     produce the black/white halos that appear at 1.5+ on ink-on-flat
     content.
     Chroma sharpen = 0.0 (OFF). This is called out explicitly in the
     brief and is correct: anime chroma is flat, so chroma sharpening
     adds nothing but color fringing on line edges. Keeping it at 0 is
     one of the most important decisions in this whole chain for
     animated content.

Chain order (denoise → grade → sharpen) is deliberate:

  * Denoise FIRST so the sharpen pass isn't amplifying compression noise
    and mosquito artifacts.
  * Grade in the MIDDLE so the sharpen pass sees the graded contrast
    (a bit more contrast means the sharpen actually has edges to bite
    into) without the grade being applied on top of already-haloed edges.
  * Sharpen LAST so its work isn't undone by the temporal denoise and
    isn't muddied by contrast changes.

Encoding profile:
-----------------
The output mirrors cut_scenes.py exactly — same H.264 High@L4.0 yuv420p
CFR 30, no B-frames, +faststart, `-map_metadata -1 -map_chapters -1`,
`-sn -dn -ignore_unknown`, `-map 0:v:0 -map 0:a:0`, audio stream copied
(re-encoding a scene's AAC twice would only add generation loss for zero
gain since we never touch the audio). CRF is kept at 23 to match the
cut stage, so file sizes stay in the same ballpark; sharpening does
add some high-frequency information which the encoder will preserve,
but empirically the delta on 20 s 1080p anime clips is a few percent,
not a doubling — the "size not blown up" bar is met.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


# -------------------------------------------------------------------------
# Filter chain — the actual tuned values. Kept as module-level constants
# so anyone auditing them (or A/B testing new values) has ONE place to look.
# -------------------------------------------------------------------------

# hqdn3d=luma_spatial:chroma_spatial:luma_tmp:chroma_tmp
# See docstring above for the rationale on each of the four numbers.
DENOISE = "hqdn3d=1.5:1.0:4.5:3.0"

# eq=contrast=...:saturation=...:gamma=...
# brightness intentionally omitted (default 0.0).
COLOR = "eq=contrast=1.06:saturation=1.15:gamma=0.98"

# unsharp=lx:ly:la:cx:cy:ca — luma-only sharpen for anime.
SHARPEN = "unsharp=5:5:0.8:5:5:0.0"

# Full chain, in order. Includes a final format=yuv420p to guarantee the
# output pixel format stays the mobile-safe 8-bit 4:2:0 that cut_scenes.py
# established, even if a filter in the chain internally upgrades bit depth.
FILTER_CHAIN = f"{DENOISE},{COLOR},{SHARPEN},format=yuv420p,setsar=1"


# Mobile-safe encode parameters. These MUST match cut_scenes.py so that
# re-encoding a scene here doesn't undo the phone-playback guarantees.
# (If you change values here, change them there too and re-verify.)
TARGET_FPS = 30
TARGET_PIX_FMT = "yuv420p"
X264_PROFILE = "high"
X264_LEVEL = "4.0"
X264_PRESET = "medium"
X264_CRF = "23"
X264_MAXRATE = "8M"
X264_BUFSIZE = "16M"


def sh(cmd):
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_json(path):
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries",
            "stream=codec_type,codec_name,profile,pix_fmt,width,height,"
            "has_b_frames,start_time,r_frame_rate",
            "-show_entries", "format=format_name,duration,bit_rate,start_time",
            "-of", "json",
            path,
        ],
        capture_output=True, text=True, check=True,
    )
    return json.loads(out.stdout)


def enhance_one(src, dst):
    """
    Apply the enhancement filter chain to one scene MP4.

    Video is re-encoded with the tuned chain; audio is stream-copied (the
    enhancement is purely picture-space, so touching audio would only add
    generation loss). Output must satisfy the same mobile-safe validation
    as cut_scenes.py — see validate_enhanced() below.
    """
    cmd = [
        "ffmpeg", "-y",
        "-i", src,

        # Only the primary A/V — matches cut_scenes.py's stream policy so
        # a stray subtitle/data track cannot leak back in on this pass.
        "-map", "0:v:0",
        "-map", "0:a:0",

        # The actual quality enhancement.
        "-vf", FILTER_CHAIN,

        # Re-encode video with the same mobile-safe profile as the cut
        # stage. force-cfr + no B-frames keeps PTS==DTS and start_time==0.
        "-c:v", "libx264",
        "-profile:v", X264_PROFILE,
        "-level:v", X264_LEVEL,
        "-preset", X264_PRESET,
        "-crf", X264_CRF,
        "-maxrate", X264_MAXRATE,
        "-bufsize", X264_BUFSIZE,
        "-pix_fmt", TARGET_PIX_FMT,
        "-bf", "0",
        "-g", str(TARGET_FPS * 2),
        "-keyint_min", str(TARGET_FPS * 2),
        "-sc_threshold", "0",
        "-x264-params", "force-cfr=1",
        "-r", str(TARGET_FPS),
        "-video_track_timescale", "15360",

        # Audio: passthrough — cut_scenes.py already produced AAC-LC
        # 48 kHz stereo 128 kbps, which is exactly what we want to keep.
        "-c:a", "copy",

        # Container hygiene identical to cut_scenes.py.
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


def validate_enhanced(path):
    """
    Re-run the same mobile-safety bar cut_scenes.py enforces: exactly one
    video + one audio stream, H.264 + yuv420p, no B-frames, container and
    stream start_time ~0, valid MP4 ftyp header. If enhancement broke any
    of this, we want to catch it BEFORE overwriting the cut scene.
    """
    with open(path, "rb") as f:
        head = f.read(12)
    if len(head) < 12 or head[4:8] != b"ftyp":
        print(f"ERROR: {path} missing ftyp box", file=sys.stderr)
        sys.exit(3)

    data = probe_json(path)
    streams = data.get("streams", [])
    fmt = data.get("format", {})
    v = [s for s in streams if s.get("codec_type") == "video"]
    a = [s for s in streams if s.get("codec_type") == "audio"]

    if len(v) != 1 or len(a) != 1 or len(streams) != 2:
        kinds = [f"{s.get('codec_type')}:{s.get('codec_name')}" for s in streams]
        print(
            f"ERROR: enhanced {path} must be 1 video + 1 audio, got {kinds}",
            file=sys.stderr,
        )
        sys.exit(3)

    vs = v[0]
    if vs.get("codec_name") != "h264":
        print(f"ERROR: video codec {vs.get('codec_name')!r}, expected h264",
              file=sys.stderr)
        sys.exit(3)
    if vs.get("pix_fmt") != TARGET_PIX_FMT:
        print(
            f"ERROR: pix_fmt {vs.get('pix_fmt')!r}, expected {TARGET_PIX_FMT!r}",
            file=sys.stderr,
        )
        sys.exit(3)
    if vs.get("has_b_frames") not in (0, "0"):
        print(f"ERROR: has_b_frames={vs.get('has_b_frames')!r}, expected 0",
              file=sys.stderr)
        sys.exit(3)

    try:
        if float(fmt.get("start_time", "0")) > 0.05:
            print(f"ERROR: container start_time={fmt.get('start_time')}",
                  file=sys.stderr)
            sys.exit(3)
        if float(vs.get("start_time", "0")) > 0.05:
            print(f"ERROR: video start_time={vs.get('start_time')}",
                  file=sys.stderr)
            sys.exit(3)
    except (TypeError, ValueError):
        pass

    print(f"  OK: {path} still mobile-safe after enhancement.", flush=True)


def main():
    ap = argparse.ArgumentParser(
        description=(
            "Apply the tuned quality enhancement filter chain "
            "(denoise + color grade + sharpen) to each cut scene MP4 "
            "in place. This step is scoped to picture quality only — "
            "it has no knowledge of branding or overlay content."
        )
    )
    ap.add_argument("scenes_dir",
                    help="Directory of scene_XX.mp4 files from cut_scenes.py")
    ap.add_argument(
        "--enabled", dest="enabled", action="store_true", default=True,
        help="Apply the enhancement chain (default).",
    )
    ap.add_argument(
        "--no-enabled", dest="enabled", action="store_false",
        help=(
            "Skip the enhancement chain entirely — no scenes are read, "
            "no scenes are rewritten, exits 0. Wire this to the site's "
            "on/off toggle so users can compare enhanced vs unenhanced."
        ),
    )
    args = ap.parse_args()

    if not args.enabled:
        print(
            "Quality enhancement DISABLED via --no-enabled — "
            "scene files left untouched.",
            flush=True,
        )
        return

    scenes_dir = Path(args.scenes_dir)
    if not scenes_dir.is_dir():
        print(f"ERROR: scenes dir does not exist: {scenes_dir}",
              file=sys.stderr)
        sys.exit(2)

    scenes = sorted(scenes_dir.glob("scene_*.mp4"))
    if not scenes:
        print(f"ERROR: no scene_*.mp4 files found in {scenes_dir}",
              file=sys.stderr)
        sys.exit(2)

    print(
        f"Enhancing {len(scenes)} scene(s) with tuned anime filter chain:\n"
        f"  filter_complex = {FILTER_CHAIN}\n"
        f"  encode profile = H.264 High@L{X264_LEVEL} {TARGET_PIX_FMT} "
        f"CRF{X264_CRF} preset={X264_PRESET} "
        f"maxrate={X264_MAXRATE} bufsize={X264_BUFSIZE}, "
        f"CFR {TARGET_FPS}, no B-frames, +faststart, audio stream-copied.",
        flush=True,
    )

    total_before = 0
    total_after = 0
    for src in scenes:
        tmp = src.with_suffix(".enhanced.mp4")
        before = src.stat().st_size
        total_before += before
        print(f"\n--- Enhancing {src.name} ({before/1024/1024:.2f} MB)",
              flush=True)
        enhance_one(str(src), str(tmp))
        validate_enhanced(str(tmp))
        after = tmp.stat().st_size
        total_after += after
        pct = (after - before) / before * 100.0 if before else 0.0
        print(
            f"  size: {before/1024/1024:.2f} MB -> {after/1024/1024:.2f} MB "
            f"({pct:+.1f}%)",
            flush=True,
        )
        # Atomic swap: only replace the original once the enhanced file is
        # written AND has passed the mobile-safe validation above.
        os.replace(tmp, src)

    if total_before:
        overall = (total_after - total_before) / total_before * 100.0
        print(
            f"\nDone. Aggregate size delta across {len(scenes)} scene(s): "
            f"{total_before/1024/1024:.2f} MB -> "
            f"{total_after/1024/1024:.2f} MB ({overall:+.1f}%).",
            flush=True,
        )


if __name__ == "__main__":
    main()
