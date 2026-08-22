#!/usr/bin/env python3
"""
Local smoke test for the cinematic subtitle renderer — no Whisper, no
TTS. Builds synthetic aligned word events + a synthetic production.json
with sentiment keywords, generates the cinematic ASS, burns it into a
generated test video with ffmpeg, then executes the actual cinematic CLI
production path with synthetic transcription timing and extracts frames at key moments
(fade-in overlap window, mid-hold, letter fade-out), and validates the
output MP4 with ffprobe.

Run from the repo root:  python3 test_cinematic.py
"""
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "scripts"))
import generate_subtitles_cinematic as cin  # noqa: E402

WORK = "/tmp/cin_test"
os.makedirs(WORK, exist_ok=True)

# --- Synthetic production.json: two cuts, literal author-selected colors in
# both accepted shapes. The renderer receives colors; it does not choose them.
prod = {
    "title": "The Son-In-Law Nobody Liked",
    "cuts": [
        {
            "start_seconds": 10.0,
            "end_seconds": 20.0,
            "voiceover_text": "She is right there. No she is gone forever.",
            "keywords": [{"word": "gone", "color": "#FF5C5C"},
                         {"word": "forever", "color": "#8A5CFF"}],
        },
        {
            "start_seconds": 30.0,
            "end_seconds": 40.0,
            "voiceover_text": "The son-in-law nobody liked became the shield. He saved them all.",
            "keywords": {"shield": "#FFC85A", "saved": "#28C76F"},
        },
    ],
}
prod_path = os.path.join(WORK, "production.json")
with open(prod_path, "w", encoding="utf-8") as f:
    json.dump(prod, f, indent=2)

# --- Exercise the script loader (texts + keyword map)
texts, kw = cin.load_script_with_keywords(prod_path)
assert len(texts) == 2, texts
assert kw.get("gone") == "#FF5C5C" and kw.get("shield") == "#FFC85A", kw
assert kw.get("forever") == "#8A5CFF" and kw.get("saved") == "#28C76F", kw
assert "KEYWORD_COLORS" not in open(cin.__file__, encoding="utf-8").read()
print("PASS: keyword loader (list + dict shapes, author-selected literal colors)")

# --- Synthetic timed words. Timing stands in for aligned transcription.
def mk(words, t0, per=0.22):
    out, t = [], t0
    for w in words:
        out.append({"start": round(t, 3), "end": round(t + per, 3), "word": w})
        t += per + 0.04
    return out

events = []
for cut_text, t0 in zip(texts, (1.0, 5.0)):
    events += mk(cut_text.split(), t0)

sentences = cin.split_sentences(events)
assert len(sentences) == 5, [s["words"][0]["word"] for s in sentences]
assert [s["words"][0]["word"] for s in sentences] == ["She", "No", "The", "the", "He"]
assert all(len(card["words"]) <= cin.MAX_CAPTION_WORDS for card in sentences)
long_cards = sentences[2:4]
assert [len(card["words"]) for card in long_cards] == [5, 2]
assert long_cards[0]["speak_end"] <= long_cards[1]["start"]
# --- Static card timing: each complete sentence is present from its first
# aligned word through its final aligned word, with no readability padding or
# animation envelope of any kind.
s1 = sentences[0]
assert s1["speak_end"] > s1["start"]
assert not hasattr(cin, "CIN_WORD_FADE_IN_MS")
assert not hasattr(cin, "CIN_LETTER_FADE_OUT_MS")
assert not hasattr(cin, "_sentence_tracking")
assert not hasattr(cin, "_tracked_text_width")
static_font = cin._caption_font(max(
    24, int(round(cin.CIN_FRAME_HEIGHT * cin.CIN_FONT_FRACTION_OF_HEIGHT))))
static_runs = cin._caption_layout(
    s1, static_font, cin.CIN_FRAME_WIDTH, cin.CIN_FRAME_HEIGHT)
assert static_runs and all("x" in run and "y" in run for run in static_runs)
print("PASS: static <=6-word caption cards use direct voice-aligned timing")

# --- Cinematic 10:9 output + title banner
# The source deliberately differs from the output geometry: the renderer must
# centre-crop it to the fixed cinematic canvas before captions or banner.
SRC_W, SRC_H = 720, 1280
W, H = cin.CIN_FRAME_WIDTH, cin.CIN_FRAME_HEIGHT
assert (W, H) == (1080, 1200)
assert cin.load_banner_title(prod_path) == prod["title"]
banner_png = os.path.join(WORK, "title_banner.png")
bh = cin.build_banner_png(prod["title"], W, H, banner_png)
assert os.path.isfile(banner_png)
assert bh == max(48, int(round(H * cin.CIN_BANNER_HEIGHT_FRACTION)))
assert bh < int(round(H * 0.16)), "banner height was not reduced"
from PIL import Image as _Img
_bw, _bh = _Img.open(banner_png).size
assert (_bw, _bh) == (W, bh), (_bw, _bh)
# The byte-identical render proves the source title is uppercased inside the
# production renderer, rather than trusting the caller to provide all caps.
upper_banner_png = os.path.join(WORK, "title_banner_upper.png")
cin.build_banner_png(prod["title"].upper(), W, H, upper_banner_png)
assert open(banner_png, "rb").read() == open(upper_banner_png, "rb").read()
print(f"PASS: 10:9 cinematic canvas + compact all-caps title banner ({_bw}x{_bh})")

# --- Banner motion expression: cubic-eased 0.7s drop-in -> 7s hold ->
# cubic-eased 0.7s drop-out.
rest_top = int(round(H * cin.CIN_BANNER_TOP_FRACTION))
assert rest_top == 0, "banner must rest flush at the frame top"
y_expr = cin._banner_y_expr(rest_top)
in_s = cin.CIN_BANNER_IN_SECONDS
hold_s = in_s + cin.CIN_BANNER_HOLD_SECONDS
out_s = hold_s + cin.CIN_BANNER_OUT_SECONDS
assert in_s == cin.CIN_BANNER_OUT_SECONDS == 0.7
assert "pow" in y_expr and f"t/{in_s}" in y_expr and \
    f"(t-{hold_s})/{cin.CIN_BANNER_OUT_SECONDS}" in y_expr, y_expr
# Continuity at every boundary, evaluated with the real banner height:
def _ease_out_cubic(progress):
    progress = max(0.0, min(1.0, progress))
    return 1.0 - (1.0 - progress) ** 3

def _y(t, bh=bh):
    if t < in_s:    return -bh + (rest_top + bh) * _ease_out_cubic(t / in_s)
    if t < hold_s:  return float(rest_top)
    if t < out_s:   return rest_top - (rest_top + bh) * _ease_out_cubic(
        (t - hold_s) / cin.CIN_BANNER_OUT_SECONDS)
    return float(-bh)
assert _y(0) == -bh, "t=0 not fully off-screen top"
assert abs(_y(in_s - 1e-9) - rest_top) < 1e-6 and _y(in_s) == rest_top
assert _y(hold_s) == rest_top
assert abs(_y(out_s - 1e-9) - -bh) < 1e-6 and _y(out_s) == -bh
assert _y(out_s + 1) == -bh, "banner not gone after drop-out"
print(f"PASS: cubic-eased banner motion (off-screen -{bh} -> {rest_top} over "
      f"{in_s}s, hold to {hold_s}s, back to -{bh} by {out_s}s, gone after)")

# --- Generate the ASS
ass_path = os.path.join(WORK, "cinematic.ass")
cin.write_cinematic_ass(sentences, kw, W, H, ass_path)
ass = open(ass_path, encoding="utf-8").read()
assert cin.CIN_FONT == "Coolvetica Rg" and os.path.isfile(cin.CIN_FONT_FILE)
assert all(f"Style: {style},{cin.CIN_FONT}," in ass for style in (
    "CinShadow", "CinText"))
assert "CinGlow" not in ass and "\\blur" not in ass, ass
import re as _re
caption_payloads = _re.findall(
    r"Dialogue: [^\n]*,CinText,,0,0,0,,([^\n]*)", ass)
caption_visible = "".join(_re.sub(r"\{[^}]*\}", "", text)
                          for text in caption_payloads)
assert caption_visible and "She" in caption_visible, caption_visible
assert "SHE" not in caption_visible, caption_visible
assert "The son-in-law nobody liked became" in caption_visible, caption_visible
assert "Alignment" in ass and ",5," in ass, "centred Alignment=5 missing"
assert all(style in ass for style in ("CinShadow", "CinText"))
assert f"\\pos({W // 2 + int(round(W * cin.CIN_ASS_SHADOW_OFFSET_X_FRACTION))},{H // 2 + int(round(H * cin.CIN_ASS_SHADOW_OFFSET_Y_FRACTION))})" in ass, "compact diagnostic shadow position missing"
assert cin.CIN_FONT_FRACTION_OF_HEIGHT == 0.032
assert cin.CIN_RASTER_SHADOW_RGB == (38, 38, 38)
assert cin.CIN_RASTER_SHADOW_ALPHA == 0.72
assert (cin.CIN_RASTER_SHADOW_X, cin.CIN_RASTER_SHADOW_Y,
        cin.CIN_RASTER_SHADOW_BLUR_RADIUS) == (3, 5, 4)
assert "\\alpha" not in ass and "\\t(" not in ass, "caption animation tags remain"
assert "\\c&H5C5CFF&" in ass, "tense keyword fill colour missing"
assert "\\c&H5AC8FF&" in ass, "author-selected #FFC85A fill color missing"
evs = _re.findall(r"Dialogue: (\d+),(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),(Cin\w+)", ass)
def ts(t):
    h, m, rest = t.split(":"); return int(h)*3600 + int(m)*60 + float(rest)
events_by_style = {
    style: [(l, ts(s), ts(e)) for l, s, e, got_style in evs if got_style == style]
    for style in ("CinShadow", "CinText")
}
assert all(len(style_events) == len(sentences) for style_events in events_by_style.values())
text_evs = events_by_style["CinText"]
assert text_evs[0][2] <= text_evs[1][1], "static caption cards overlap"
assert all(event[0] == "1" for event in text_evs), "animated layer stacks remain"
for shadow_ev, text_ev in zip(events_by_style["CinShadow"], text_evs):
    assert (shadow_ev[1], shadow_ev[2]) == (text_ev[1], text_ev[2])
print("PASS: static ASS cards + compact soft-gray raster shadow (no caption animation)")



# --- Burn into a generated test video and validate the MP4
src = os.path.join(WORK, "src.mp4")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"testsrc2=size={SRC_W}x{SRC_H}:rate=24:duration=9",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", src], check=True)
foreground_mov = os.path.join(WORK, "cinematic_caption_flat_shadow.mov")
cin.render_cinematic_overlays(sentences, kw, W, H, 9.0, foreground_mov)
assert os.path.isfile(foreground_mov)
def probe_overlay(path):
    return json.loads(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries",
         "stream=codec_name,width,height,pix_fmt", "-of", "json", path],
        text=True))["streams"]
foreground_probe = probe_overlay(foreground_mov)
assert len(foreground_probe) == 1 and foreground_probe[0]["codec_name"] == "qtrle", foreground_probe
assert (foreground_probe[0]["width"], foreground_probe[0]["height"]) == (W, H)
assert foreground_probe[0]["pix_fmt"] == "argb", foreground_probe
print("PASS: single RGBA soft-drop-shadow caption stream is valid")

out = os.path.join(WORK, "out.mp4")
cin.burn_subtitles(src, foreground_mov, out,
                   banner={"png": banner_png, "height": bh})

probe = subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries",
     "stream=codec_type,codec_name,width,height", "-of", "json", out],
    text=True)
streams = json.loads(probe)["streams"]
assert len(streams) == 2 and {s["codec_type"] for s in streams} == {"video", "audio"}, streams
video_stream = next(s for s in streams if s["codec_type"] == "video")
assert (video_stream["width"], video_stream["height"]) == (W, H), video_stream
print("PASS: burned MP4 valid (1 video + 1 audio stream, bare 1080x1200 frame)")

# --- Extract representative static-card and banner frames.
for t in (0.3, 1.2, 3.0, 6.2, 7.9, 8.95):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t),
                    "-i", out, "-frames:v", "1",
                    os.path.join(WORK, f"frame_{t}.png")], check=True)
# At 1.2s the banner is fully dropped in. Its white strip must touch y=0 —
# any source-video gap above it would fail this direct pixel check.
full_banner = _Img.open(os.path.join(WORK, "frame_1.2.png")).convert("RGB")
r, g, b = full_banner.getpixel((8, 0))
assert min(r, g, b) >= 235, (r, g, b)
print("PASS: rendered frame has compact banner flush at y=0 ->", WORK)

# --- Execute the ACTUAL cinematic CLI production path. The only substituted
# component is Whisper timing; Stage B's real renderer, title banner, scene
# crop planner, and final compositor all run against the realistic ffmpeg
# source. This validates the route that Stage B selects for subtitle_mode.
voice_wav = os.path.join(WORK, "voiceover.wav")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
                "-i", "anullsrc=r=24000:cl=mono", "-t", "9", "-c:a",
                "pcm_s16le", voice_wav], check=True)
cli_out = os.path.join(WORK, "cli_cinematic.mp4")
cli_work = os.path.join(WORK, "cli_work")
orig_transcribe = cin.subtitle_common.transcribe_words
orig_align = cin.subtitle_common.align_words_to_script
orig_argv = sys.argv[:]
try:
    cin.subtitle_common.transcribe_words = lambda *_args, **_kwargs: events
    cin.subtitle_common.align_words_to_script = lambda *_args, **_kwargs: events
    sys.argv = ["generate_subtitles_cinematic.py", src, voice_wav, cli_out,
                "--script-json", prod_path, "--work-dir", cli_work]
    cin.main()
finally:
    cin.subtitle_common.transcribe_words = orig_transcribe
    cin.subtitle_common.align_words_to_script = orig_align
    sys.argv = orig_argv
assert os.path.isfile(cli_out)
cli_probe = json.loads(subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,width,height",
     "-of", "json", cli_out], text=True))["streams"]
cli_video = next(s for s in cli_probe if s["codec_type"] == "video")
assert (cli_video["width"], cli_video["height"]) == (W, H), cli_video
crop_plan = json.load(open(os.path.join(cli_work, "cinematic_crop_plan.json"), encoding="utf-8"))
assert crop_plan["scene_detector"] == "scene_index.detect_shots", crop_plan
assert crop_plan["scene_count"] >= 1, crop_plan
assert len(crop_plan["scenes"]) == crop_plan["scene_count"], crop_plan
cli_frame = os.path.join(WORK, "cli_frame_1.2.png")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", "1.2", "-i", cli_out,
                "-frames:v", "1", cli_frame], check=True)
cli_banner = _Img.open(cli_frame).convert("RGB")
assert min(cli_banner.getpixel((8, 0))) >= 235
print("PASS: actual cinematic CLI path renders captioned 1080x1200 frame, title banner, and scene crop plan ->", cli_frame)
print("ALL CINEMATIC TESTS PASSED")
