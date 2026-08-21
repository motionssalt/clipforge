#!/usr/bin/env python3
"""
Local smoke test for the cinematic subtitle renderer — no Whisper, no
TTS. Builds synthetic aligned word events + a synthetic production.json
with sentiment keywords, generates the cinematic ASS, burns it into a
generated test video with ffmpeg, extracts frames at key moments
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

# --- Generate the ASS
W, H = 720, 1280
ass_path = os.path.join(WORK, "cinematic.ass")
cin.write_cinematic_ass(sentences, kw, W, H, ass_path)
ass = open(ass_path, encoding="utf-8").read()
assert "Alignment" in ass and ",5," in ass, "centred Alignment=5 missing"
assert "CinGlow" in ass and "CinText" in ass
assert "\\blur" in ass, "glow blur missing"
assert "\\alpha&HFF&" in ass, "fade tags missing"
assert "\\c&H5C5CFF&" in ass, "tense keyword fill colour missing"
assert "\\c&H5AC8FF&" in ass, "warm keyword fill colour missing"
assert "\\3c&H6400A0E0&" in ass, "warm keyword glow colour missing"
# Letter-by-letter: a mid-sentence char must carry its own fade-out \t
assert ass.count("\\t(") > sum(len(s["words"]) for s in sentences), \
    "per-character fade-out tags missing"
# Overlap: sentence 1's event must end AFTER sentence 2's event starts
import re as _re
evs = _re.findall(r"Dialogue: (\d+),(\d+:\d+:\d+\.\d+),(\d+:\d+:\d+\.\d+),(Cin\w+)", ass)
def ts(t):
    h, m, rest = t.split(":"); return int(h)*3600 + int(m)*60 + float(rest)
text_evs = [(l, ts(s), ts(e)) for l, s, e, sty in evs if sty == "CinText"]
assert text_evs[0][2] > text_evs[1][1], "no overlap between sentences 1 and 2"
assert text_evs[0][0] != text_evs[1][0], "layer pairs not alternating"
print(f"PASS: ASS structure (glow+text layers, centred, blur, alpha anim, "
      f"keyword colours, letter fade-out, overlap "
      f"{text_evs[0][2]-text_evs[1][1]:.2f}s)")

# --- Burn into a generated test video and validate the MP4
src = os.path.join(WORK, "src.mp4")
subprocess.run(["ffmpeg", "-y", "-loglevel", "error",
                "-f", "lavfi", "-i", f"testsrc2=size={W}x{H}:rate=24:duration=9",
                "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "aac", src], check=True)
out = os.path.join(WORK, "out.mp4")
cin.burn_subtitles(src, ass_path, out)

probe = subprocess.check_output(
    ["ffprobe", "-v", "error", "-show_entries",
     "stream=codec_type,codec_name,width,height", "-of", "json", out],
    text=True)
streams = json.loads(probe)["streams"]
assert len(streams) == 2 and {s["codec_type"] for s in streams} == {"video", "audio"}, streams
print("PASS: burned MP4 valid (1 video + 1 audio stream)")

# --- Extract frames: early fade-in of sentence 2 overlapping sentence 1's
#     dissolve (~5.1s), sentence 2 fully on (~6.2s), letter fade-out of the
#     last sentence (~8.6s).
for t in (1.2, 5.05, 6.2, 8.6):
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(t),
                    "-i", out, "-frames:v", "1",
                    os.path.join(WORK, f"frame_{t}.png")], check=True)
print("PASS: frames extracted ->", WORK)
print("ALL CINEMATIC TESTS PASSED")
