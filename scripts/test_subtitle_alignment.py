#!/usr/bin/env python3
"""Regression checks for authoritative-script subtitle timing alignment."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import subtitle_common as common  # noqa: E402


def timed(token: str, start: float) -> dict:
    return {"word": token, "start": start, "end": start + 0.1}


# Each four-word script cut contains one transcription-only insertion. The
# timing windows must receive one insertion each; assigning both to the final
# cut would pull the second cut earlier and create visible caption drift.
timed_words = [
    timed("one", 0.0), timed("two", 0.2), timed("extra", 0.4),
    timed("three", 0.6), timed("four", 0.8),
    timed("five", 1.0), timed("six", 1.2), timed("noise", 1.4),
    timed("seven", 1.6), timed("eight", 1.8),
]
events = common.align_words_to_script(
    timed_words,
    ["one two three four", "five six seven eight"],
)

assert [event["word"] for event in events] == [
    "one", "two", "three", "four", "five", "six", "seven", "eight",
]
assert events[0]["start"] == 0.0
assert events[2]["start"] == 0.6
assert events[4]["start"] == 1.0
assert events[6]["start"] == 1.6
assert events[4]["start"] >= events[3]["end"]
# Alignment enforces the shared minimum visible duration for a final word.
assert abs(events[-1]["end"] - 1.92) < 1e-9

print("PASS: inserted transcription timings are allocated across script cuts without late-caption drift")
