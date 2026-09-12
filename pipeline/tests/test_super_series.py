"""Offline tests for feature-01 (Super Series) validation + slicing."""

from __future__ import annotations

import copy
import unittest

from pipeline.plan.super_series import (
    MAX_PARTS,
    parse_and_validate_super_plan,
    slice_part,
    validate_super_plan,
)
from pipeline.plan.schema import validate_production_plan


def _cuts(start: int, end: int) -> list[dict]:
    """Cuts tiling [start, end) with a single cut, valid narration."""
    return [{"start_seconds": start, "end_seconds": end, "voiceover_text": "Hi."}]


def _part(*, series_id: str, part: int, start: int, end: int, is_final: bool, title: str) -> dict:
    return {
        "version": 2,
        "job_id": "",
        "title": title,
        "video_duration_seconds": 600,
        "target_total_duration_seconds": 30,
        "cuts": _cuts(start, end),
        "series": {
            "series_id": series_id,
            "part": part,
            "start_seconds": start,
            "end_seconds": end,
            "is_final": is_final,
            "summary": f"Recap for part {part}.",
        },
    }


def _plan(*, parts: int = 3, series_id: str = "series-1", boundaries: list[int] | None = None) -> dict:
    boundaries = boundaries or [0, 200, 400, 600]
    assert len(boundaries) == parts + 1
    return {
        "version": 2,
        "series_id": series_id,
        "video_duration_seconds": boundaries[-1],
        "target_total_duration_seconds": 30,
        "parts": [
            _part(
                series_id=series_id,
                part=index + 1,
                start=boundaries[index],
                end=boundaries[index + 1],
                is_final=(index == parts - 1),
                title=f"Part {index + 1}",
            )
            for index in range(parts)
        ],
    }


class SuperPlanValidatorTests(unittest.TestCase):
    def test_valid_three_part_plan(self):
        self.assertEqual(validate_super_plan(_plan()), [])

    def test_rejects_missing_series_id(self):
        doc = _plan()
        del doc["series_id"]
        self.assertIn("`series_id` must be a non-empty string shared by every part.", validate_super_plan(doc))

    def test_rejects_mismatched_series_id(self):
        doc = _plan()
        doc["parts"][1]["series"]["series_id"] = "other"
        errs = validate_super_plan(doc)
        self.assertTrue(any("parts[1].series.series_id" in e for e in errs))

    def test_rejects_gap_between_parts(self):
        doc = _plan(boundaries=[0, 200, 300, 600])  # gap 300..? no, part2 200..300, part3 300..600 fine
        # Introduce a real gap: part2 ends at 300 but part3 starts at 400.
        doc["parts"][2]["series"]["start_seconds"] = 400
        errs = validate_super_plan(doc)
        self.assertTrue(any("tile the source with no gaps or overlaps" in e for e in errs))

    def test_rejects_overlap(self):
        doc = _plan()
        doc["parts"][1]["series"]["start_seconds"] = 100  # part1 ends at 200; overlap
        errs = validate_super_plan(doc)
        self.assertTrue(any("tile the source with no gaps or overlaps" in e for e in errs))

    def test_rejects_first_part_not_starting_at_zero(self):
        doc = _plan()
        doc["parts"][0]["series"]["start_seconds"] = 10
        # bug also causes tiling to break so multiple errors are fine.
        errs = validate_super_plan(doc)
        self.assertTrue(any("start_seconds must be 0 for the first part" in e for e in errs))

    def test_requires_exactly_one_is_final(self):
        doc = _plan()
        doc["parts"][-1]["series"]["is_final"] = False
        errs = validate_super_plan(doc)
        self.assertIn("Exactly one part must be marked series.is_final = true.", errs)

    def test_final_must_be_last(self):
        doc = _plan()
        doc["parts"][0]["series"]["is_final"] = True
        doc["parts"][-1]["series"]["is_final"] = False
        errs = validate_super_plan(doc)
        self.assertTrue(any("must be the last entry" in e for e in errs))

    def test_rejects_duplicate_titles(self):
        doc = _plan()
        doc["parts"][1]["title"] = doc["parts"][0]["title"]
        errs = validate_super_plan(doc)
        self.assertTrue(any("duplicates an earlier part's title" in e for e in errs))

    def test_per_part_validation_flows_through(self):
        doc = _plan()
        doc["parts"][0]["cuts"][0]["end_seconds"] = 0  # cuts[0].end <= start
        errs = validate_super_plan(doc)
        self.assertTrue(any("cuts[0].end_seconds must be greater than start_seconds" in e for e in errs))

    def test_max_parts(self):
        # Building MAX_PARTS+1 tiny parts is cheap; just check the cap fires.
        boundaries = list(range(0, (MAX_PARTS + 1) * 10 + 1, 10))
        doc = _plan(parts=MAX_PARTS + 1, boundaries=boundaries)
        errs = validate_super_plan(doc)
        self.assertTrue(any(f"at most {MAX_PARTS} entries" in e for e in errs))

    def test_parse_json(self):
        import json
        text = json.dumps(_plan())
        doc, errs = parse_and_validate_super_plan(text)
        self.assertEqual(errs, [])
        self.assertIsNotNone(doc)
        doc2, errs2 = parse_and_validate_super_plan("{not json")
        self.assertIsNone(doc2)
        self.assertTrue(any("Not valid JSON" in e for e in errs2))


class SuperPlanSlicingTests(unittest.TestCase):
    def test_slice_produces_ordinary_valid_plan(self):
        doc = _plan()
        for index in range(3):
            part = slice_part(doc, index)
            # Positional part number is re-stamped even if the source had a different value.
            self.assertEqual(part["series"]["part"], index + 1)
            # Ordinary single-part validator with the SAME part_number override accepts it.
            errs = validate_production_plan(part, part_number=index + 1)
            self.assertEqual(errs, [], msg=f"Part {index + 1} unexpectedly failed: {errs}")

    def test_slice_restamp_wins_over_ai_written_part(self):
        doc = _plan()
        doc["parts"][2]["series"]["part"] = 99  # AI put wrong number
        part = slice_part(doc, 2)
        self.assertEqual(part["series"]["part"], 3)  # positional wins


class PerPartOverrideTests(unittest.TestCase):
    def test_validate_production_plan_uses_positional_part(self):
        # A plan whose stored series.part is wrong still validates when the
        # positional override matches the rest of the plan's boundaries.
        part = _part(series_id="series-1", part=99, start=0, end=200, is_final=False, title="P")
        # Without override the wrong part number is validated as-is; that's ok (validator only
        # requires part > 0), but with override it must be re-stamped so downstream code sees 1.
        self.assertEqual(validate_production_plan(part, part_number=1), [])
        # Legacy behavior preserved: no override, no re-stamp, no errors.
        self.assertEqual(validate_production_plan(part), [])


if __name__ == "__main__":
    unittest.main()
