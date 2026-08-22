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

# --- Synthetic production.json: two cuts, keywords in BOTH accepted shapes
prod = {
    "title": "The Son-In-Law Nobody Liked",
    "cuts": [
        {
            "start_seconds": 10.0,
            "end_seconds": 20.0,
            "voiceover_text": "She is right there. No she is gone forever.",
            "keywords": [{"word": "gone", "tone": "tense"},
                         {"word": "forever", "tone": "negative"}],
        },
        {
            "start_seconds": 30.0,
            "end_seconds": 40.0,
            "voiceover_text": "The son-in-law nobody liked became the shield. He saved them all.",
            "keywords": {"shield": "warm", "saved": "positive"},
        },
    ],
}
prod_path = os.path.join(WORK, "production.json")
with open(prod_path, "w", encoding="utf-8") as f:
    json.dump(prod, f, indent=2)

# --- Exercise the script loader (texts + keyword map)
texts, kw = cin.load_script_with_keywords(prod_path)
assert len(texts) == 2, texts
assert kw.get("gone") == "tense" and kw.get("shield") == "warm", kw
assert kw.get("forever") == "negative" and kw.get("saved") == "positive", kw
print("PASS: keyword loader (list + dict shapes, tones)")

# --- Synthetic timed words: sentence 1 spoken fast (<1.5s) to exercise the
#     1.5s floor; sentence 2 normal. Timing stands in for whisper output.
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
assert len(sentences) == 4, [s["words"][0]["word"] for s in sentences]
assert [s["words"][0]["word"] for s in sentences] == ["She", "No", "The", "He"]
# 1.5s floor: fast sentence 1's hold must extend past its spoken span
s1 = sentences[0]
assert s1["speak_end"] - s1["start"] < 1.5
assert max(s1["speak_end"], s1["start"] + cin.CIN_SENTENCE_MIN_SECONDS) \
    == s1["start"] + 1.5
print("PASS: sentence split on punctuation + 1.5s readability floor")

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

# --- Banner motion expression: drop-in 0.6s -> 7s hold -> drop-out 0.6s
rest_top = int(round(H * cin.CIN_BANNER_TOP_FRACTION))
assert rest_top == 0, "banner must rest flush at the frame top"
y_expr = cin._banner_y_expr(rest_top)
in_s = cin.CIN_BANNER_IN_SECONDS
hold_s = in_s + cin.CIN_BANNER_HOLD_SECONDS
out_s = hold_s + cin.CIN_BANNER_OUT_SECONDS
assert y_expr == (
    f"if(lt(t,{in_s}),-H+({rest_top}+H)*t/{in_s},"
    f"if(lt(t,{hold_s}),{rest_top},"
    f"if(lt(t,{out_s}),{rest_top}-({rest_top}+H)*(t-{hold_s})/"
    f"{cin.CIN_BANNER_OUT_SECONDS},-H)))"
), y_expr
# Continuity at every boundary, evaluated with the real banner height:
def _y(t, bh=bh):
    if t < in_s:    return -bh + (rest_top + bh) * t / in_s
    if t < hold_s:  return float(rest_top)
    if t < out_s:   return rest_top - (rest_top + bh) * (t - hold_s) / cin.CIN_BANNER_OUT_SECONDS
    return float(-bh)
assert _y(0) == -bh, "t=0 not fully off-screen top"
assert abs(_y(in_s - 1e-9) - rest_top) < 1e-6 and _y(in_s) == rest_top
assert _y(hold_s) == rest_top
assert abs(_y(out_s - 1e-9) - -bh) < 1e-6 and _y(out_s) == -bh
assert _y(out_s + 1) == -bh, "banner not gone after drop-out"
print(f"PASS: banner y-expression (off-screen -{bh} -> {rest_top} over "
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
assert caption_visible and caption_visible == caption_visible.upper(), caption_visible
assert "SHE" in caption_visible and "She" not in caption_visible
assert "Alignment" in ass and ",5," in ass, "centred Alignment=5 missing"
assert all(style in ass for style in ("CinShadow", "CinText"))
assert f"\\pos({W // 2 + int(round(W * cin.CIN_SHADOW_OFFSET_X_FRACTION))},{H // 2 + int(round(H * cin.CIN_SHADOW_OFFSET_Y_FRACTION))})" in ass, "hard down-right shadow position missing"
assert "\\alpha&HFF&" in ass, "fade tags missing"
assert "\\c&H5C5CFF&" in ass, "tense keyword fill colour missing"
assert "\\c&H5AC8FF&" in ass, "warm keyword fill colour missing"
# Letter-by-letter: a mid-sentence char must carry its own fade-out \t
assert ass.count("\\t(") > sum(len(s["words"]) for s in sentences), \
    "per-character fade-out tags missing"
# Overlap: sentence 1's event must end AFTER sentence 2's event starts
evs = _re.findall(r"Dialogue: (\d+),(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),(Cin\w+)", ass)
def ts(t):
    h, m, rest = t.split(":"); return int(h)*3600 + int(m)*60 + float(rest)
events_by_style = {
    style: [(l, ts(s), ts(e)) for l, s, e, got_style in evs if got_style == style]
    for style in ("CinShadow", "CinText")
}
assert all(len(style_events) == len(sentences) for style_events in events_by_style.values())
text_evs = events_by_style["CinText"]
assert text_evs[0][2] > text_evs[1][1], "no overlap between sentences 1 and 2"
assert text_evs[0][0] != text_evs[1][0], "two-layer stacks not alternating"
for shadow_ev, text_ev in zip(events_by_style["CinShadow"], text_evs):
    assert (shadow_ev[1], shadow_ev[2]) == (text_ev[1], text_ev[2])
print(f"PASS: ASS structure (crisp text + hard 3D shadow, no glow/blur, "
      f"centred, alpha anim, keyword colours, letter fade-out, overlap "
      f"{text_evs[0][2]-text_evs[1][1]:.2f}s)")



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
print("PASS: single RGBA flat-3D-shadow caption stream is valid")

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

# --- Extract frames: early fade-in of sentence 2 overlapping sentence 1's
#     dissolve (~5.1s), sentence 2 fully on (~6.2s), letter fade-out of the
#     last sentence (~8.6s).
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
orig_transcribe = cin.legacy.transcribe_words
orig_align = cin.legacy.align_words_to_script
orig_argv = sys.argv[:]
try:
    cin.legacy.transcribe_words = lambda *_args, **_kwargs: events
    cin.legacy.align_words_to_script = lambda *_args, **_kwargs: events
    sys.argv = ["generate_subtitles_cinematic.py", src, voice_wav, cli_out,
                "--script-json", prod_path, "--work-dir", cli_work]
    cin.main()
finally:
    cin.legacy.transcribe_words = orig_transcribe
    cin.legacy.align_words_to_script = orig_align
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
