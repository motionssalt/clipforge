#!/usr/bin/env python3
"""
build_key_moments.py — Fuse scene_index.json + character_index.json +
transcript.json into a compact `key_moments.json` that tells the
downstream vision agent *which* moments are worth investigating and
*who* is on screen at each of them.

Why this exists
---------------
The agent currently has to reconstruct the story of the video from
scratch every time. It sees:
  - A dialogue-only transcript with no speaker labels.
  - A wall of 6-second composite screenshots with no "important vs
    filler" signal.
So it wastes vision-token budget on filler footage and still misses the
turning points because none of them are marked.

`key_moments.json` is the shortlist. It flags:
  - Shot boundaries (from scene_index).
  - Every first-time appearance of a stable identity (from
    character_index) — these are the "who is this new character?" beats.
  - Every scene where the on-screen cast changes (someone enters or
    leaves).
  - Transcript stretches with a high density of emotional/decision
    language, cross-referenced against which identities are on screen.
Each moment carries a small `signals` block explaining WHY it was
flagged, so the agent can decide at a glance whether to keep it as a
cut candidate before it opens any screenshots.

Zero AI-vision-token cost. This is pure JSON stitching.

Output shape (`key_moments.json`)
---------------------------------
{
  "video_duration_seconds": 1416,
  "moment_count": 42,
  "cast_summary": [
     { "person_id": "person_A", "screen_time_seconds": 184.3, "appearance_count": 27 },
     ...
  ],
  "moments": [
    {
      "moment_id": 1,
      "start_seconds": 42.5,
      "end_seconds": 61.2,
      "shot_ids": [3, 4],
      "on_screen": ["person_A", "person_B"],
      "new_on_screen": ["person_B"],
      "transcript_excerpt": "...",
      "signals": {
        "is_shot_boundary": true,
        "introduces_person": true,
        "cast_change": true,
        "emotional_score": 0.42,
        "dialogue_density": 0.71,
        "priority": 0.86
      },
      "why": [
        "person_B first appears on screen here",
        "shot boundary at 42.5s (cut)",
        "high emotional-word density in dialogue"
      ]
    },
    ...
  ]
}

Usage
-----
    python build_key_moments.py <scene_index_json> <character_index_json>
                                <transcript_json> <output_json>
                                [--max-moments 60]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys


# Words that tend to sit on top of a real narrative beat in short-form
# commentary content. Kept small and language-neutral-ish (matches on
# lowercased ASCII stems); it's a HINT for the agent, not a hard filter,
# so a few missed matches on non-English content don't hurt.
EMOTIONAL_STEMS = [
    "kill", "die", "dead", "death", "murder", "blood",
    "love", "hate", "fear", "angry", "furious", "scared", "terrified",
    "friend", "enemy", "betray", "trust", "lie", "truth", "secret",
    "save", "protect", "escape", "trapped", "alone", "help",
    "cry", "scream", "shout", "whisper", "silent",
    "reveal", "confess", "admit", "promise",
    "win", "lose", "defeat", "surrender", "beg",
    "please", "sorry", "never", "always", "forever",
    "why", "how could", "what if",
]

TOKEN_RE = re.compile(r"[A-Za-z']+")


def score_emotional(text: str) -> float:
    """
    Very cheap heuristic emotional-word density in [0, 1]. Counts hits
    against EMOTIONAL_STEMS and normalizes by token count. It's not
    trying to be a sentiment model — just a "does this stretch of
    dialogue sound like a beat, or like exposition?" hint.
    """
    if not text:
        return 0.0
    text_l = text.lower()
    tokens = TOKEN_RE.findall(text_l)
    if not tokens:
        return 0.0
    hits = 0
    for stem in EMOTIONAL_STEMS:
        if stem in text_l:
            hits += 1
    # Squash: ~5 stem hits = strong beat.
    return min(1.0, hits / 5.0)


def overlap_seconds(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def transcript_between(segments: list[dict], t_start: float, t_end: float) -> tuple[str, float]:
    """
    Return (concatenated_text, dialogue_density). Dialogue density is
    the fraction of [t_start, t_end] covered by transcript segments.
    """
    if t_end <= t_start:
        return "", 0.0
    pieces: list[str] = []
    covered = 0.0
    for seg in segments:
        s = float(seg.get("start", 0.0))
        e = float(seg.get("end", 0.0))
        ov = overlap_seconds(t_start, t_end, s, e)
        if ov > 0:
            txt = (seg.get("text") or "").strip()
            if txt:
                pieces.append(txt)
            covered += ov
    dur = t_end - t_start
    return " ".join(pieces), min(1.0, covered / dur) if dur > 0 else 0.0


def cast_at_shot(shot_id: int, appearances_by_shot: dict[int, set[str]]) -> set[str]:
    return set(appearances_by_shot.get(shot_id, set()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scene_index_json")
    ap.add_argument("character_index_json")
    ap.add_argument("transcript_json")
    ap.add_argument("output_json")
    ap.add_argument(
        "--max-moments",
        type=int,
        default=60,
        help="Hard cap on the number of moments emitted. The agent should "
             "still open its own screenshots; this is a shortlist, not a "
             "final cut list.",
    )
    args = ap.parse_args()

    for p in (args.scene_index_json, args.character_index_json, args.transcript_json):
        if not os.path.exists(p):
            print(f"Input not found: {p}", file=sys.stderr)
            sys.exit(2)

    with open(args.scene_index_json, "r", encoding="utf-8") as f:
        scene_data = json.load(f)
    with open(args.character_index_json, "r", encoding="utf-8") as f:
        char_data = json.load(f)
    with open(args.transcript_json, "r", encoding="utf-8") as f:
        tx_data = json.load(f)

    duration = float(scene_data.get("video_duration_seconds", 0.0))
    shots = scene_data.get("shots", [])
    identities = char_data.get("identities", [])
    tx_segments = tx_data.get("segments", [])

    # Build per-shot cast index.
    appearances_by_shot: dict[int, set[str]] = {}
    first_shot_for_person: dict[str, int] = {}
    for ident in identities:
        pid = ident["person_id"]
        first_shot = None
        for app in ident.get("appearances", []):
            sid = int(app["shot_id"])
            appearances_by_shot.setdefault(sid, set()).add(pid)
            if first_shot is None or sid < first_shot:
                first_shot = sid
        if first_shot is not None:
            first_shot_for_person[pid] = first_shot

    # Cast summary for the top of the output.
    cast_summary = [
        {
            "person_id": ident["person_id"],
            "screen_time_seconds": ident.get("screen_time_seconds", 0.0),
            "appearance_count": ident.get("appearance_count", 0),
        }
        for ident in identities
    ]

    # Score every shot as a candidate moment.
    prev_cast: set[str] = set()
    candidates: list[dict] = []
    for shot in shots:
        sid = shot["shot_id"]
        s = float(shot["start_seconds"])
        e = float(shot["end_seconds"])
        cur_cast = cast_at_shot(sid, appearances_by_shot)
        new_on = {p for p in cur_cast if first_shot_for_person.get(p) == sid}
        cast_change = cur_cast != prev_cast

        transcript_excerpt, dialogue_density = transcript_between(tx_segments, s, e)
        emotional = score_emotional(transcript_excerpt)

        # Composite priority. Weights tuned so:
        #   - a shot that introduces a NEW character is almost always kept,
        #   - a shot whose dialogue is emotionally loaded is kept,
        #   - a shot with neither is dropped even if the camera cut.
        priority = 0.0
        why: list[str] = []
        if new_on:
            priority += 0.55
            for p in sorted(new_on):
                why.append(f"{p} first appears on screen here")
        if cast_change and not new_on:
            priority += 0.15
            entered = cur_cast - prev_cast
            left = prev_cast - cur_cast
            if entered:
                why.append(f"cast change: {', '.join(sorted(entered))} enters")
            if left:
                why.append(f"cast change: {', '.join(sorted(left))} leaves")
        priority += 0.35 * emotional
        if emotional >= 0.4:
            why.append("high emotional-word density in dialogue")
        priority += 0.15 * dialogue_density
        # Shot cuts alone are cheap — the boundary itself is always noted,
        # but on its own it barely nudges priority.
        why.append(f"shot boundary at {s:.1f}s ({shot.get('cause', 'cut')})")

        candidates.append(
            {
                "start_seconds": s,
                "end_seconds": e,
                "shot_ids": [sid],
                "on_screen": sorted(cur_cast),
                "new_on_screen": sorted(new_on),
                "transcript_excerpt": transcript_excerpt[:500],
                "signals": {
                    "is_shot_boundary": True,
                    "introduces_person": bool(new_on),
                    "cast_change": bool(cast_change),
                    "emotional_score": round(emotional, 3),
                    "dialogue_density": round(dialogue_density, 3),
                    "priority": round(min(1.0, priority), 3),
                },
                "why": why,
            }
        )
        prev_cast = cur_cast

    # Rank by priority and keep the top N. Then re-sort chronologically
    # so the agent reads them in playback order.
    candidates.sort(key=lambda m: m["signals"]["priority"], reverse=True)
    top = candidates[: args.max_moments]
    top.sort(key=lambda m: m["start_seconds"])
    for i, m in enumerate(top, start=1):
        m["moment_id"] = i

    payload = {
        "video_duration_seconds": duration,
        "moment_count": len(top),
        "cast_summary": cast_summary,
        "notes": (
            "This file is a SHORTLIST of high-signal moments produced "
            "locally at zero AI-vision cost. It is a hint, not a mandate: "
            "the agent should still verify each moment by opening the "
            "corresponding screenshots. Every moment carries a `why` "
            "field explaining what triggered its inclusion."
        ),
        "moments": top,
    }

    os.makedirs(os.path.dirname(os.path.abspath(args.output_json)) or ".", exist_ok=True)
    with open(args.output_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(
        f"Wrote key_moments index: {len(top)} moment(s) from "
        f"{len(candidates)} shot(s) -> {args.output_json}",
        flush=True,
    )


if __name__ == "__main__":
    main()
