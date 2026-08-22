#!/usr/bin/env python3
"""Regression coverage for analysis-prompt template interpolation."""

from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "scripts" / "generate_analysis_prompt.py"
FOCUS = "When they were trapped in the cave and gon carries everyone out."
LITERAL_KEYWORD_EXAMPLE = '[{"word": "exact script word", "color": "#RRGGBB"}]'


with tempfile.TemporaryDirectory(prefix="clipforge_prompt_test_") as temp_dir:
    output = Path(temp_dir) / "00_READ_THIS_FIRST.txt"
    subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "600",
            "100",
            str(output),
            "--target-duration",
            "180",
            "--job-id",
            "20260822-051719-32553947636",
            "--focus",
            FOCUS,
        ],
        check=True,
    )
    rendered = output.read_text(encoding="utf-8")

assert LITERAL_KEYWORD_EXAMPLE in rendered, "literal JSON keyword example was not rendered"
assert FOCUS in rendered, "focus interpolation was lost"
assert '"target_total_duration_seconds": 180' in rendered, "target duration was not rendered"
print("PASS: analysis-prompt template renders literal keyword JSON without KeyError")
