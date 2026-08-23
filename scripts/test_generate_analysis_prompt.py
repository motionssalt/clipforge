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
for required_phrase in (
    "WRITE IT TO BE EMOTION-FIRST, NOT JUST EVENT-ACCURATE.",
    "The emotional throughline is the story spine.",
    "LEAD WITH THE EMOTIONAL TURN.",
    "NAME CLEAR EMOTIONS DIRECTLY.",
    "STAY EVIDENCE-GROUNDED, NOT MIND-READING.",
    '"She is shocked." "He is terrified."',
    "COMMENTARY RHYTHM — emotion-first narration still moves with crisp, declarative momentum.",
    "present-tense immediacy",
    "Build short cause-and-effect chains in which the effect is often an\n    emotional consequence",
    "Before a twist or reveal, withhold the explanation for one beat",
    "EMOTION-FIRST EXAMPLE.",
    "He is stunned — and\n    triumphant.",
    "same supported\n    events are organized around the viewer's emotional experience",
    "emotion-first account of WHAT HAPPENS in that segment",
    '"she is terrified," "he is humiliated," "they\n          are relieved"',
    "WORD CHOICE & PERSONALITY — change the phrasing, NOT the voice delivery",
    "casual turns of phrase, playful understatement, teasing, blunt reactions",
    "Mild profanity is allowed very occasionally",
    "Tease a visible choice, plan, or consequence",
    "LANGUAGE-ONLY instruction",
    "Do not change narration pace, delivery, or audio direction",
):
    assert required_phrase in rendered, f"missing narration-style guidance: {required_phrase}"

# The prompt's explicit shock/reversal/triumph example is the concrete
# acceptance sample: emotions lead, while visible events prove them.
sample = 'write: "For a second,\n    it looks like he has lost. Then the result changes. He is stunned — and\n    triumphant."'
assert sample in rendered
assert "He misses,\n    looks at the result, and lifts the trophy" in rendered
print("PASS: analysis prompt renders emotion-first, evidence-grounded narration guidance with a verified emotional-beat sample")
