#!/usr/bin/env python3
"""Integration checks for the conservative Gemini voiceover clarity pass."""
from __future__ import annotations

import importlib.util
import math
import sys
import tempfile
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("voice", ROOT / "generate_voiceover.py")
assert spec and spec.loader
voice = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = voice
spec.loader.exec_module(voice)

cut_spec = importlib.util.spec_from_file_location("cut", ROOT / "cut_and_produce.py")
assert cut_spec and cut_spec.loader
cut = importlib.util.module_from_spec(cut_spec)
sys.modules[cut_spec.name] = cut
cut_spec.loader.exec_module(cut)

# A changing-amplitude speech-like tone is sufficient to exercise every ffmpeg
# filter without requiring a network call or committing generated audio.
frames = []
for index in range(voice.SAMPLE_RATE_HZ * 2):
    t = index / voice.SAMPLE_RATE_HZ
    amplitude = 0.12 if t < 0.7 else (0.42 if t < 1.35 else 0.2)
    value = int(amplitude * 32767 * math.sin(2 * math.pi * 220 * t))
    frames.append(value.to_bytes(2, byteorder="little", signed=True))
pcm = b"".join(frames)

with tempfile.TemporaryDirectory(prefix="clipforge_clarity_test_") as temp_dir:
    raw_path = Path(temp_dir) / "raw.wav"
    processed_path = Path(temp_dir) / "processed.wav"
    raw_duration = voice.write_wav(raw_path, pcm)
    metadata = voice.post_process_voiceover_wav(raw_path, processed_path)
    processed_duration = voice.wav_duration_seconds(processed_path)
    assert processed_path.is_file() and processed_path.stat().st_size > 44
    assert abs(processed_duration - raw_duration) < 0.03
    assert metadata["preset"] == "speech_clarity_v1"
    assert metadata["target_integrated_lufs"] == -16.0
    assert "two-pass EBU R128 loudnorm" in metadata["filters"]
    with wave.open(str(processed_path), "rb") as wav:
        assert wav.getnchannels() == 1
        assert wav.getsampwidth() == 2
        assert wav.getframerate() == voice.SAMPLE_RATE_HZ

    # 24,011 samples are 1.000458…s. A millisecond manifest rounds that
    # down to 1.000s, which historically let atrim remove eleven input
    # samples; Stage B must instead retain its exact post-resample tail.
    tail_path = Path(temp_dir) / "sub_millisecond_tail.wav"
    tail_frames = voice.SAMPLE_RATE_HZ + 11
    voice.write_wav(tail_path, b"\0\0" * tail_frames)
    tail_duration, output_frames = cut.final_wav_timing(str(tail_path))
    assert output_frames == tail_frames * 2
    assert tail_duration == output_frames / int(cut.AAC_SAMPLE_RATE)
    assert tail_duration > round(tail_frames / voice.SAMPLE_RATE_HZ, 3)

print("PASS: voiceover clarity pass and Stage B preserve exact final-WAV timing")
