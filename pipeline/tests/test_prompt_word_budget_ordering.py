"""Regression guard for the planner scene-cutoff fix.

The planning AI was choosing ``end_seconds`` too early (cutting scenes short)
because the word-budget formula ``(end_seconds - start_seconds) * (188 / 60)``
was stated as a "hard delivery requirement" with no explicit causal direction,
letting a linear-reading model shorten the cut to make the budget easy to hit.

The fix reframes the budget as a CONSEQUENCE of an already-chosen duration and
adds an explicit "never the reverse" statement adjacent to the formula. These
tests verify the generated prompt text keeps that framing, so the fix cannot be
silently reverted or diluted later.
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROMPT_PY = ROOT / "pipeline" / "plan" / "prompt.py"

FORMULA = "(188 / 60)"
ORDER_HEADER = "ORDER OF OPERATIONS"
REVERSE_FORBIDDEN = "WORD COUNT flexes"
WHOLE_CUT_MECHANISM = "include or exclude as whole cuts"
PICKING_BLOCK = "PICKING end_seconds"

# The reverse-forbidden correction must sit immediately next to the word-budget
# formula, not scattered elsewhere in the document.
ADJACENCY_CHARS = 1500


class TestWordBudgetOrdering(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        out = Path(cls._tmp.name) / "prompt.txt"
        subprocess.run(
            [
                sys.executable,
                str(PROMPT_PY),
                "300",
                "50",
                str(out),
                "--target-duration",
                "120",
            ],
            check=True,
            cwd=str(ROOT),
        )
        cls.text = out.read_text(encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_formula_still_present(self) -> None:
        self.assertIn(FORMULA, self.text)

    def test_order_of_operations_present(self) -> None:
        self.assertIn(ORDER_HEADER, self.text)

    def test_reverse_forbidden_present(self) -> None:
        self.assertIn(REVERSE_FORBIDDEN, self.text)

    def test_correction_adjacent_to_formula(self) -> None:
        formula_idx = self.text.index(FORMULA)
        correction_idx = self.text.index(REVERSE_FORBIDDEN)
        self.assertLess(
            abs(correction_idx - formula_idx),
            ADJACENCY_CHARS,
            "the never-truncate-for-word-count correction drifted away from "
            "the word-budget formula; it must stay adjacent so a linear "
            "reader encounters the correct framing immediately",
        )

    def test_correction_also_adjacent_to_constraints_formula(self) -> None:
        # The CONSTRAINTS voiceover_text bullet restates the formula; its own
        # inline directionality correction must sit right next to it.
        m = re.search(
            r"target `\(end_seconds - start_seconds\) \* \(188 / 60\)` spoken words and never\s*"
            r"\n\s*return fewer than 90% of that target\. This formula sizes your WRITING",
            self.text,
        )
        self.assertIsNotNone(
            m,
            "CONSTRAINTS bullet lost its inline 'formula sizes WRITING, never duration' correction",
        )


    def test_picking_end_seconds_block_intact(self) -> None:
        self.assertIn(PICKING_BLOCK, self.text)
        self.assertIn("read this before writing any cut", self.text)

    def test_total_duration_hit_via_whole_cut_selection(self) -> None:
        self.assertIn(WHOLE_CUT_MECHANISM, self.text)


if __name__ == "__main__":
    unittest.main()
