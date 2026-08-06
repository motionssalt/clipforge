#!/usr/bin/env python3
"""
Stage B core: read cuts.json, cut the ORIGINAL full-quality video at each
range, and write EACH cut segment as its OWN separate MP4 file — one
scene_01.mp4, scene_02.mp4, ... per cut. Also produces output.txt =
MASTER_PROMPT.md + separator + raw_narration fields concatenated in order.

THERE IS NO CONCATENATION / MERGE STEP. The pipeline deliberately stopped
merging the cut segments into a single final video: each scene is an
independent deliverable so the user can post / re-arrange / discard scenes
individually. Nothing in this file joins the segments — no concat filter,
no concat demuxer, no post-pass merge. If you find yourself adding one,
you are reverting this decision.

Uses ffmpeg (available on GitHub ubuntu-latest runners by default).

---------------------------------------------------------------------------
Mobile-compatibility policy (why each scene is encoded the way it is)
---------------------------------------------------------------------------
Earlier versions tried to be clever: stream-copy when the source codecs
"looked" MP4-compatible, re-encode otherwise. In practice that produced
files that opened on desktop players but refused to play natively on
phones (iOS Photos, Android Gallery, WhatsApp) — the user was forced to
re-convert on-device before they'd play.

The specific problems that path introduced:

  1. Stream-copying with `-ss` before `-i` snaps to the nearest prior
     keyframe and writes `edts`/`elst` (edit list) atoms into each
     segment to hide the pre-roll. Mobile hardware decoders and
     WhatsApp routinely ignore edit lists, which desyncs A/V or shows
     black frames at the head of every cut.

  2. Even when the source is labelled H.264 + AAC, the actual sub-flavor
     (High 10 / 10-bit / 4:2:2, Main 10, level 5.1+, 48 kHz surround
     AAC, unusual SAR / anamorphic, negative CTS offsets) is regularly
     rejected by phone hardware decoders while still parsing fine in
     ffprobe and VLC.

  3. (The residual bug this version fixes.) Even AFTER the re-encode was
     in place, outputs still refused to play on phones AND on PC. Forensic
     analysis of a real output (an x265/HEVC 10-bit MKV source with an
     embedded subtitle) showed two defects the encode profile alone did
     not prevent:
       a. ffmpeg's DEFAULT stream mapping copied the source's embedded
          subtitle into the MP4 as a third `bin_data`/`text`
          "SubtitleHandler" stream. Strict players reject / choke on that.
       b. B-frames were left enabled, so the first video packet carried
          PTS 0.0667 vs DTS 0 -> `start_time=0.066667`, `has_b_frames=2`,
          an A/V offset at the head of every cut.
     Also, `nal-hrd=cbr` was set without any VBV rate control, which
     writes an inconsistent HRD timing model into the bitstream.

The fix: every scene is cut with ONE self-contained ffmpeg invocation
that re-encodes that segment to a universally decodable profile:

  - Seeks with `-ss <start> -to <end>` before `-i` (fast, input-side),
    then RE-ENCODES with fresh, contiguous, zero-based timestamps — no
    edit lists, no container quirks inherited from the source.
  - Video: H.264 High@L4.0, yuv420p 8-bit, fixed 30 fps CFR, SAR=1 —
    the exact profile every phone / WhatsApp / Instagram / TikTok
    hardware decoder is guaranteed to accept.
  - Audio: AAC-LC, 48 kHz, stereo, 192 kbps — the safe audio flavor for
    all mobile players.
  - Container: MP4 with `+faststart` (moov at the front, for instant
    playback while streaming) and mp42 brand.
  - CRF 18 keeps the result visually indistinguishable from the source
    while still guaranteeing a phone-playable file.

Yes, this always re-encodes. That is the point: universal playback
matters more than avoiding encode passes, and CRF 18 preserves quality
that no user will be able to distinguish from the original by eye. The
previous "stream-copy when compatible" optimization is what was breaking
phone playback in the first place.

---------------------------------------------------------------------------
Usage:
    python cut_scenes.py <original_video> <cuts_json> <master_prompt_md>
                         <out_scenes_dir> <out_text_path>

Outputs:
    <out_scenes_dir>/scene_01.mp4, scene_02.mp4, ...   (one per cut)
    <out_text_path>                                     (prompt + narrations)

Exit codes:
    0  success
    2  bad inputs (missing files, empty/invalid cuts.json)
    3  an ffmpeg/ffprobe/validation step failed
"""
import argparse
import json
import os
import subprocess
import sys


# ---------- Mobile-safe encoding parameters ----------
# Kept as module-level constants so they're easy to audit / tune in one place.
TARGET_FPS = 30            # phones/WhatsApp are happiest with CFR 30
TARGET_PIX_FMT = "yuv420p" # 8-bit 4:2:0 is the ONLY universally-decoded pixfmt
X264_PROFILE = "high"
X264_LEVEL = "4.0"         # covers up to 1080p30, accepted everywhere
X264_PRESET = "veryfast"   # good speed/quality tradeoff on GH runners
X264_CRF = "18"            # visually lossless for practical purposes
AAC_BITRATE = "192k"
AAC_SAMPLE_RATE = "48000"
AAC_CHANNELS = "2"


def sh(cmd: list[str]) -> None:
    print(f"$ {' '.join(cmd)}", flush=True)
    subprocess.run(cmd, check=True)


def probe_duration(path: str) -> float:
    out = subprocess.check_output(
        [
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
            path,
        ],
        text=True,
    ).strip()
    return float(out)


def probe_has_audio(path: str) -> bool:
    """Return True if the source has at least one audio stream."""
    out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "a:0",
            "-show_entries", "stream=codec_type",
            "-of", "csv=p=0",
            path,
        ],
        capture_output=True,
        text=True,
    )
    return "audio" in out.stdout


def cut_scene(src: str, start: float, end: float, dst: str) -> None:
    """
    Cut ONE range [start, end] from `src` into `dst` as a standalone,
    mobile-safe MP4. Each call is a fully independent encode — the output
    file does not depend on, and is never combined with, any other scene.

    `-ss`/`-to` are placed BEFORE `-i` (fast input-side seek). Because the
    segment is then fully re-encoded (not stream-copied), the pre-roll is
    decoded and discarded instead of being hidden behind an edit list, so
    every scene starts cleanly at PTS 0 with no black head frames.

    Two additional problems made earlier outputs refuse to play even after
    the re-encode fix, on phones AND on PC. Both are addressed here:

      * ROGUE SUBTITLE / DATA STREAM. Real source rips (the kind users
        feed this pipeline — e.g. an x265/HEVC MKV with an embedded text
        subtitle) carry a subtitle track. ffmpeg's default stream
        selection copied that track into the MP4 as a third
        `bin_data`/`text` "SubtitleHandler" stream. Strict players
        (phones, WhatsApp, and many PC players) reject or choke on an
        MP4 whose only media should be A/V but which contains an extra
        data track. Fix: explicitly `-map 0:v:0 -map 0:a:0` (only the
        primary A/V) and pass `-sn -dn -ignore_unknown`.

      * B-FRAME CTS OFFSET + non-zero start_time. With B-frames enabled
        the first video packet had PTS 0.0667 while DTS was 0, surfacing
        as `start_time=0.066667` and `has_b_frames=2`. That decode-vs-
        presentation offset breaks strict hardware/software decoders and
        desyncs A/V at the head of every cut. Fix: `-bf 0` (no B-frames)
        so every frame is I/P, PTS==DTS, start_time==0.

      * `nal-hrd=cbr` was also removed: it is only valid alongside real
        VBV rate control (-maxrate/-bufsize). Used with pure CRF it wrote
        an inconsistent CBR HRD timing model into the bitstream.
    """
    vf = f"fps={TARGET_FPS},format={TARGET_PIX_FMT},setsar=1"
    af = (
        f"aformat=sample_fmts=fltp:sample_rates={AAC_SAMPLE_RATE}:channel_layouts=stereo,"
        f"aresample=async=1:first_pts=0"
    )

    has_audio = probe_has_audio(src)

    cmd: list[str] = [
        "ffmpeg", "-y",
        "-ss", f"{start:.3f}",
        "-to", f"{end:.3f}",
        "-i", src,
    ]

    # If the source has no audio, synthesize a silent stereo track so the
    # output is always a valid, playable A/V MP4 (validation requires one).
    # The lavfi source is a SEPARATE input placed AFTER `-i src`, so the
    # `-ss`/`-to` above still apply only to the real video input.
    if not has_audio:
        cmd += [
            "-f", "lavfi",
            "-i", f"anullsrc=channel_layout=stereo:sample_rate={AAC_SAMPLE_RATE}",
        ]

    # Map ONLY the primary video + audio. This (with -sn/-dn below) is
    # what stops an embedded subtitle/data track from leaking into the MP4.
    cmd += ["-map", "0:v:0"]
    cmd += ["-map", "0:a:0"] if has_audio else ["-map", "1:a:0"]

    cmd += [
        "-vf", vf,
        "-af", af,

        # Video: H.264 High@L4.0, CRF 18, yuv420p — universally decodable.
        "-c:v", "libx264",
        "-profile:v", X264_PROFILE,
        "-level:v", X264_LEVEL,
        "-preset", X264_PRESET,
        "-crf", X264_CRF,
        "-pix_fmt", TARGET_PIX_FMT,
        # No B-frames -> PTS==DTS, start_time==0 (see docstring).
        "-bf", "0",
        # Force a keyframe every 2s and disable scene-cut extras.
        "-g", str(TARGET_FPS * 2),
        "-keyint_min", str(TARGET_FPS * 2),
        "-sc_threshold", "0",
        # force-cfr only; nal-hrd=cbr removed (invalid without VBV).
        "-x264-params", "force-cfr=1",
        # Pin a clean, phone-friendly video timebase.
        "-video_track_timescale", "15360",

        # Audio: AAC-LC stereo 48 kHz 192 kbps — the phone-safe combo.
        "-c:a", "aac",
        "-profile:a", "aac_low",
        "-b:a", AAC_BITRATE,
        "-ar", AAC_SAMPLE_RATE,
        "-ac", AAC_CHANNELS,

        # Container: MP4, faststart (moov at front), mp42 brand, no edit
        # lists. Strip inherited global metadata + chapters; drop subs/data.
        "-movflags", "+faststart",
        "-use_editlist", "0",
        "-brand", "mp42",
        "-map_metadata", "-1",
        "-map_chapters", "-1",
        "-sn", "-dn", "-ignore_unknown",

        # Sanity: fresh, zero-based timestamps.
        "-fflags", "+genpts",
        "-max_muxing_queue_size", "9999",
        "-f", "mp4",
    ]

    if not has_audio:
        # Stop at the end of the (finite) video, not the infinite lavfi tone.
        cmd.append("-shortest")

    cmd.append(dst)

    sh(cmd)


def validate_mp4(path: str) -> None:
    """
    Verify that a scene file is a genuine, valid MP4 AND that it uses the
    mobile-safe codec profile we asked for. If any check fails, something
    has gone wrong upstream and shipping the file would risk the
    "won't play on phone" bug returning.
    """
    print(f"\nValidating scene MP4: {path}", flush=True)

    if not os.path.isfile(path):
        print(f"ERROR: Output file does not exist: {path}", file=sys.stderr)
        sys.exit(3)

    # File signature: MP4 files have an ftyp box near the start.
    with open(path, "rb") as f:
        head = f.read(32)
    if len(head) < 12 or head[4:8] != b"ftyp":
        print(
            f"ERROR: Output file is NOT a valid MP4 "
            f"(missing ftyp box at offset 4, got: {head[4:8]!r})",
            file=sys.stderr,
        )
        sys.exit(3)

    major_brand = head[8:12].decode("ascii", errors="replace")
    print(f"  Major brand: {major_brand}", flush=True)

    probe_out = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-show_entries",
            "stream=codec_type,codec_name,profile,level,pix_fmt,width,height,"
            "sample_rate,channels,r_frame_rate,has_b_frames,start_time",
            "-show_entries", "format=format_name,format_long_name,duration,bit_rate,start_time",
            "-of", "json",
            path,
        ],
        capture_output=True,
        text=True,
    )
    if probe_out.returncode != 0:
        print(
            f"ERROR: ffprobe failed on scene file:\n{probe_out.stderr}",
            file=sys.stderr,
        )
        sys.exit(3)

    probe_data = json.loads(probe_out.stdout)
    streams = probe_data.get("streams", [])
    fmt_info = probe_data.get("format", {})
    fmt_name = fmt_info.get("format_name", "unknown")

    print(f"  Format: {fmt_info.get('format_long_name', 'unknown')} ({fmt_name})", flush=True)
    print(f"  Duration: {fmt_info.get('duration', 'unknown')}s", flush=True)
    print(f"  Bit rate: {fmt_info.get('bit_rate', 'unknown')} bps", flush=True)
    print(f"  Start time: {fmt_info.get('start_time', 'unknown')}", flush=True)

    v_streams = [s for s in streams if s.get("codec_type") == "video"]
    a_streams = [s for s in streams if s.get("codec_type") == "audio"]

    if not v_streams:
        print("ERROR: Scene file has no video stream", file=sys.stderr)
        sys.exit(3)
    if not a_streams:
        print("ERROR: Scene file has no audio stream", file=sys.stderr)
        sys.exit(3)

    # A scene MP4 must contain EXACTLY one video + one audio stream. Any
    # extra stream (an embedded subtitle leaked in as bin_data/text, an
    # attached-pic video track, a second audio track, ...) is what made
    # phones AND PC players reject the file even though the A/V streams
    # themselves were fine. Fail loudly instead of shipping it.
    if len(v_streams) != 1 or len(a_streams) != 1 or len(streams) != 2:
        kinds = [f"{s.get('codec_type')}:{s.get('codec_name')}" for s in streams]
        print(
            f"ERROR: Scene file must contain exactly 1 video + 1 audio "
            f"stream, found {len(streams)} stream(s): {kinds}. An embedded "
            f"subtitle/data/extra track likely leaked into the MP4.",
            file=sys.stderr,
        )
        sys.exit(3)

    v = v_streams[0]
    a = a_streams[0]
    print(
        f"  Video: {v.get('codec_name')} "
        f"profile={v.get('profile')} "
        f"level={v.get('level')} "
        f"pix_fmt={v.get('pix_fmt')} "
        f"{v.get('width')}x{v.get('height')} "
        f"fps={v.get('r_frame_rate')}",
        flush=True,
    )
    print(
        f"  Audio: {a.get('codec_name')} "
        f"sr={a.get('sample_rate')} "
        f"ch={a.get('channels')}",
        flush=True,
    )

    # Hard checks: the codec profile MUST match what we asked for. If
    # ffmpeg silently downgraded (missing encoder, filter error, etc.)
    # we want to fail loudly rather than ship a file that won't play
    # on the user's phone.
    if v.get("codec_name") != "h264":
        print(
            f"ERROR: video codec is {v.get('codec_name')!r}, expected h264",
            file=sys.stderr,
        )
        sys.exit(3)
    if v.get("pix_fmt") != TARGET_PIX_FMT:
        print(
            f"ERROR: video pix_fmt is {v.get('pix_fmt')!r}, expected {TARGET_PIX_FMT!r} "
            f"(non-yuv420p pixel formats are the #1 cause of "
            f"'won't play on phone' bugs)",
            file=sys.stderr,
        )
        sys.exit(3)
    if a.get("codec_name") != "aac":
        print(
            f"ERROR: audio codec is {a.get('codec_name')!r}, expected aac",
            file=sys.stderr,
        )
        sys.exit(3)

    # B-frames force a decode-vs-presentation (CTS) offset that surfaces as
    # a non-zero start_time and desyncs A/V on strict players. We encode
    # with -bf 0, so a scene must have no B-frames.
    if v.get("has_b_frames") not in (0, "0"):
        print(
            f"ERROR: video has_b_frames={v.get('has_b_frames')!r}, expected 0. "
            f"B-frames introduce a CTS offset that breaks strict players.",
            file=sys.stderr,
        )
        sys.exit(3)

    # Both the container start_time AND the video stream start_time must be
    # ~0. A non-zero video start (the B-frame offset above, or a leaked
    # pre-roll) breaks WhatsApp / iOS / many PC players.
    try:
        if float(fmt_info.get("start_time", "0")) > 0.05:
            print(
                f"ERROR: container start_time is {fmt_info.get('start_time')}s, expected ~0.0.",
                file=sys.stderr,
            )
            sys.exit(3)
        if float(v.get("start_time", "0")) > 0.05:
            print(
                f"ERROR: video start_time is {v.get('start_time')}s, expected ~0.0. "
                f"Non-zero start times break WhatsApp / iOS / PC playback.",
                file=sys.stderr,
            )
            sys.exit(3)
    except (TypeError, ValueError):
        pass

    print("  Validation PASSED: scene is a mobile-safe MP4.\n", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("original_video")
    ap.add_argument("cuts_json")
    ap.add_argument("master_prompt_md")
    ap.add_argument("out_scenes_dir")
    ap.add_argument("out_text_path")
    args = ap.parse_args()

    for req in (args.original_video, args.cuts_json, args.master_prompt_md):
        if not os.path.exists(req):
            print(f"Missing required input: {req}", file=sys.stderr)
            sys.exit(2)

    with open(args.cuts_json, "r", encoding="utf-8") as f:
        payload = json.load(f)

    cuts = payload.get("cuts") or []
    if not cuts:
        print("cuts.json contains no cuts", file=sys.stderr)
        sys.exit(2)

    # Sort defensively, validate.
    cuts = sorted(cuts, key=lambda c: float(c["start_seconds"]))
    src_duration = probe_duration(args.original_video)
    print(f"Source video duration: {src_duration:.2f}s", flush=True)

    prev_end = -1.0
    for i, c in enumerate(cuts):
        s = float(c["start_seconds"])
        e = float(c["end_seconds"])
        if e <= s:
            print(f"Cut #{i}: end ({e}) <= start ({s})", file=sys.stderr)
            sys.exit(2)
        if s < 0 or e > src_duration + 0.5:
            print(f"Cut #{i}: range [{s}, {e}] outside source [0, {src_duration:.2f}]", file=sys.stderr)
            sys.exit(2)
        if s < prev_end:
            print(f"Cut #{i}: overlaps previous cut ({s} < prev end {prev_end})", file=sys.stderr)
            sys.exit(2)
        prev_end = e

    print(
        f"Cutting {len(cuts)} range(s) into SEPARATE scene files "
        f"(NO concatenation / NO merge step — each cut becomes its own "
        f"scene_XX.mp4) with mobile-safe encoding "
        f"(H.264 High@L{X264_LEVEL} {TARGET_PIX_FMT} CRF{X264_CRF}, "
        f"AAC-LC {AAC_SAMPLE_RATE}Hz stereo {AAC_BITRATE}, "
        f"+faststart, no edit lists).",
        flush=True,
    )

    scenes_dir = os.path.abspath(args.out_scenes_dir)
    os.makedirs(scenes_dir, exist_ok=True)

    # One independent ffmpeg invocation per cut -> one scene file per cut.
    # The width of the index suffix is fixed at 2 digits so scene files
    # sort lexically (scene_01, scene_02, ..., scene_10, ...).
    scene_paths = []
    for i, c in enumerate(cuts):
        s = float(c["start_seconds"])
        e = float(c["end_seconds"])
        dst = os.path.join(scenes_dir, f"scene_{i + 1:02d}.mp4")
        print(
            f"\n--- Scene {i + 1}/{len(cuts)}: [{s:.3f} -> {e:.3f}] "
            f"({e - s:.2f}s) -> {dst}",
            flush=True,
        )
        cut_scene(args.original_video, s, e, dst)
        # Validate EVERY scene — a single broken scene should fail the
        # job, not ride along unnoticed inside the zip.
        validate_mp4(dst)
        scene_paths.append(dst)

    print(f"\nAll {len(scene_paths)} scene file(s) written to {scenes_dir}:", flush=True)
    for p in scene_paths:
        print(f"  {p}", flush=True)
    print(
        "NOTE: segments were intentionally NOT merged — each scene is a "
        "separate deliverable.",
        flush=True,
    )

    # ---- output.txt: MASTER_PROMPT.md + raw narrations (unchanged) ----
    with open(args.master_prompt_md, "r", encoding="utf-8") as f:
        master_prompt = f.read()

    narrations = []
    for c in cuts:
        n = (c.get("raw_narration") or "").strip()
        if n:
            narrations.append(n)

    separator = "\n\n" + ("=" * 80) + "\n" + "RAW NARRATION NOTES (paste after the prompt above)\n" + ("=" * 80) + "\n\n"
    combined_narration = "\n\n".join(narrations)

    os.makedirs(os.path.dirname(os.path.abspath(args.out_text_path)) or ".", exist_ok=True)
    with open(args.out_text_path, "w", encoding="utf-8") as f:
        f.write(master_prompt.rstrip() + separator + combined_narration + "\n")
    print(f"output.txt written: {args.out_text_path}", flush=True)


if __name__ == "__main__":
    main()
