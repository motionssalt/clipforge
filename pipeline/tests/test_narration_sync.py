"""Automated regression check for narration-to-picture visual anchor synchronization.

Enforces:
1. Every cut binds to a visual anchor (visual_anchor_seconds).
2. The renderer derives on-screen/audio start from that anchor mapped onto the edited timeline.
3. Narration begins at or slightly before the visual moment, never after it.
4. Measured TTS durations are used without cumulative drift.
5. Pre-render validator catches un-synced cuts beyond 0.3s tolerance and fails fast.
"""
from __future__ import annotations

import unittest
from pipeline.plan.schema import validate_production_plan
from pipeline.stage_b.render import (
    NARRATION_SYNC_TOLERANCE_S,
    reconcile_cuts,
    validate_narration_anchors,
)


class NarrationSyncTests(unittest.TestCase):
    def test_legacy_plan_without_anchor_defaults_safely(self):
        plan = {
            "video_duration_seconds": 60,
            "target_total_duration_seconds": 30,
            "cuts": [
                {
                    "start_seconds": 10,
                    "end_seconds": 25,
                    "voiceover_text": "A legacy cut with no anchor declared.",
                }
            ],
        }
        errors = validate_production_plan(plan)
        self.assertEqual(errors, [])
        # Anchor is defaulted to start_seconds
        self.assertEqual(plan["cuts"][0].get("visual_anchor_seconds"), 10.0)

    def test_anchor_outside_cut_range_fails_validation(self):
        plan = {
            "video_duration_seconds": 60,
            "target_total_duration_seconds": 30,
            "cuts": [
                {
                    "start_seconds": 10,
                    "end_seconds": 25,
                    "visual_anchor_seconds": 5.0,  # outside cut range!
                    "voiceover_text": "This narration anchor is way before the cut starts.",
                }
            ],
        }
        errors = validate_production_plan(plan)
        self.assertEqual(len(errors), 1)
        self.assertIn("visual_anchor_seconds (5.00s) is outside cut range [10.0s, 25.0s]", errors[0])

    def test_anchor_alignment_tightens_lead_in(self):
        # AI selected a 20-second cut [100, 120], but anchor is at 108s.
        # Without anchoring, anchor is 8s into cut, creating massive visual delay.
        # Reconcile must tighten start_seconds so visual moment lands <= 0.3s from speech start.
        cuts = [
            {
                "start_seconds": 100,
                "end_seconds": 120,
                "visual_anchor_seconds": 105.0,
                "voiceover_text": "Action happens here.",
            }
        ]
        vo_durations = [8.0]
        src_duration = 300.0

        reconciled = reconcile_cuts(cuts, vo_durations, src_duration)
        self.assertEqual(len(reconciled), 1)

        sync_errors = validate_narration_anchors(reconciled, vo_durations, tolerance_seconds=NARRATION_SYNC_TOLERANCE_S)
        self.assertEqual(sync_errors, [])

        item = reconciled[0]
        # Visual anchor appears at: (anchor - start) * stretch
        lead_in = (item["visual_anchor_seconds"] - item["start_seconds"]) * item["stretch"]
        self.assertLessEqual(lead_in, NARRATION_SYNC_TOLERANCE_S)
        self.assertGreaterEqual(lead_in, 0.0)

    def test_deterministic_window_expansion_when_vo_exceeds_footage(self):
        # Voiceover takes 10s, but raw footage is only 4s (stretch would be 2.5x).
        # Reconcile extends footage window so stretch stays in safe bounds.
        cuts = [
            {
                "start_seconds": 50,
                "end_seconds": 54,
                "visual_anchor_seconds": 50.5,
                "voiceover_text": "A rich commentary line describing this scene.",
            }
        ]
        vo_durations = [10.0]
        src_duration = 200.0

        reconciled = reconcile_cuts(cuts, vo_durations, src_duration)
        item = reconciled[0]
        # End seconds extended
        self.assertGreater(item["end_seconds"], 54.0)
        # Stretch clamped within safe limits
        self.assertLessEqual(item["stretch"], 1.40)
        self.assertEqual(item["video_seconds"], 10.0)

    def test_no_cumulative_drift_across_multi_cut_sequence(self):
        # 5 consecutive cuts with different durations
        cuts = [
            {"start_seconds": 10, "end_seconds": 20, "visual_anchor_seconds": 10.2, "voiceover_text": "Cut 1"},
            {"start_seconds": 25, "end_seconds": 35, "visual_anchor_seconds": 25.1, "voiceover_text": "Cut 2"},
            {"start_seconds": 40, "end_seconds": 52, "visual_anchor_seconds": 40.3, "voiceover_text": "Cut 3"},
            {"start_seconds": 60, "end_seconds": 75, "visual_anchor_seconds": 60.2, "voiceover_text": "Cut 4"},
            {"start_seconds": 80, "end_seconds": 95, "visual_anchor_seconds": 80.2, "voiceover_text": "Cut 5"},
        ]
        vo_durations = [4.5, 6.2, 5.8, 7.1, 6.0]
        src_duration = 200.0

        reconciled = reconcile_cuts(cuts, vo_durations, src_duration)
        sync_errors = validate_narration_anchors(reconciled, vo_durations, tolerance_seconds=NARRATION_SYNC_TOLERANCE_S)
        self.assertEqual(sync_errors, [])

        total_video = sum(c["video_seconds"] for c in reconciled)
        total_vo = sum(vo_durations)
        self.assertAlmostEqual(total_video, total_vo, delta=0.001)

    def test_validator_fails_on_intentionally_lagging_cut(self):
        # Intentionally construct a cut where visual anchor is 5s after speech starts
        reconciled = [
            {
                "start_seconds": 10.0,
                "end_seconds": 30.0,
                "visual_anchor_seconds": 20.0,  # 10s into cut!
                "stretch": 1.0,
                "video_seconds": 10.0,
            }
        ]
        vo_durations = [10.0]
        sync_errors = validate_narration_anchors(reconciled, vo_durations, tolerance_seconds=0.3)
        self.assertEqual(len(sync_errors), 1)
        self.assertIn("appears 10.00s after speech begins", sync_errors[0])


if __name__ == "__main__":
    unittest.main()
