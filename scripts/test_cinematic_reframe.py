#!/usr/bin/env python3
"""Deterministic checks for scene-level cinematic crop planning."""
from __future__ import annotations

import importlib.util
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("reframe", ROOT / "cinematic_reframe.py")
assert spec and spec.loader
reframe = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = reframe
spec.loader.exec_module(reframe)

with tempfile.NamedTemporaryFile(suffix=".mp4") as placeholder:
    calls = []
    def fake_detect(video, threshold):
        calls.append((video, threshold))
        return [2.0, 5.0]

    plan = reframe.build_scene_crop_plan(
        placeholder.name, duration_seconds=8.0, threshold=0.35,
        detect_shots=fake_detect,
    )

assert calls == [(placeholder.name, 0.35)]
assert plan["scene_detector"] == "scene_index.detect_shots"
assert plan["scene_count"] == 3
assert [(s["start_seconds"], s["end_seconds"]) for s in plan["scenes"]] == [
    (0.0, 2.0), (2.0, 5.0), (5.0, 8.0),
]
assert all(s["crop_center_x"] == 0.5 and s["crop_center_y"] == 0.5
           and s["position_source"] == "fallback_center" for s in plan["scenes"])

filters, label = reframe.scene_crop_filter(plan)
joined = ";".join(filters)
assert label == "reframed"
assert "scale=1080:1200:force_original_aspect_ratio=increase" in joined
assert joined.count("crop=1080:1200") == 3
assert joined.count("(iw-ow)*0.500000") == 3
assert "concat=n=3:v=1:a=0[reframed]" in joined
print("PASS: existing scene boundaries build static center crop plan")
