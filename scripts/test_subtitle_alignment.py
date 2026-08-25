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

import generate_subtitles_cinematic as cinematic  # noqa: E402

# When Whisper omits a long run of authoritative words between two matched
# anchors, those words must be interpolated through the timed interval. Giving
# them all the preceding timestamp used to make later caption cards jump to the
# next anchor and left the renderer with a multi-second blank gap.
omitted_anchor_events = common.align_words_to_script(
    [timed("alpha", 0.0), timed("omega", 12.0)],
    [
        "alpha first second third fourth fifth sixth seventh eighth ninth "
        "tenth eleventh twelfth omega",
    ],
)
assert [event["word"] for event in omitted_anchor_events] == [
    "alpha", "first", "second", "third", "fourth", "fifth", "sixth",
    "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "omega",
]
assert omitted_anchor_events[1]["start"] > omitted_anchor_events[0]["end"] - 1e-9
assert omitted_anchor_events[-2]["end"] <= omitted_anchor_events[-1]["start"] + 1e-9
omitted_anchor_cards = cinematic.split_sentences(omitted_anchor_events)
cinematic.validate_caption_timeline(omitted_anchor_cards, video_duration=12.1)
print("PASS: omitted transcription spans are interpolated without caption-card gaps")

edge_cards = [
    {"start": 5.02, "speak_end": 6.0},
    {"start": 6.0, "speak_end": 8.0},
]
cinematic.normalize_caption_edge_coverage(edge_cards, narration_start=5.02, narration_end=8.0)
assert edge_cards[0]["start"] == 0.0
cinematic.validate_caption_timeline(edge_cards, video_duration=8.0)

bad_gap_cards = [
    {"start": 0.0, "speak_end": 1.0},
    {"start": 5.0, "speak_end": 8.0},
]
try:
    cinematic.validate_caption_timeline(bad_gap_cards, video_duration=8.0)
except ValueError as error:
    assert "internal blank gap" in str(error)
else:
    raise AssertionError("A real internal caption gap must remain a hard failure")

# The authoritative script is continuous even when transcription timing skips a
# phrase. Normalization keeps the preceding card visible until the next timed
# anchor, avoiding the renderer's deliberate long-gap fade.
cinematic.normalize_caption_internal_coverage(bad_gap_cards)
assert bad_gap_cards[0]["speak_end"] == 5.0
cinematic.validate_caption_timeline(bad_gap_cards, video_duration=8.0)

print("PASS: VAD-trimmed edge silence and transcription-only internal gaps preserve subtitle coverage")
