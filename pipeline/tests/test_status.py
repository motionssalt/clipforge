"""Unit tests for pipeline.status (jobs/<id>/status.json writer + state machine)."""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from pipeline import status  # noqa: E402


class JobIdTests(unittest.TestCase):
    def test_accepts_valid(self) -> None:
        for jid in ["manual-1", "series-abc-p2", "a", "A_B.c-1"]:
            self.assertTrue(status.is_valid_job_id(jid), jid)

    def test_rejects_invalid(self) -> None:
        for jid in ["", "has space", "slash/inside", 123, None, "x" * 121]:
            self.assertFalse(status.is_valid_job_id(jid), repr(jid))


class NewStatusTests(unittest.TestCase):
    def test_shape(self) -> None:
        rec = status.new_status(job_id="manual-1", mode="manual", now_epoch=1000)
        self.assertEqual(rec["version"], 2)
        self.assertEqual(rec["state"], "queued")
        self.assertEqual(rec["created_at_epoch"], 1000)
        self.assertEqual(rec["expires_at_epoch"], 1000 + status.DEFAULT_TTL_SECONDS)
        self.assertEqual(rec["publishing"]["status"], "not_requested")
        self.assertEqual(rec["series"]["enabled"], False)

    def test_rejects_bad_mode(self) -> None:
        with self.assertRaises(ValueError):
            status.new_status(job_id="j-1", mode="nope")

    def test_rejects_bad_state(self) -> None:
        with self.assertRaises(ValueError):
            status.new_status(job_id="j-1", mode="manual", state="bogus")

    def test_series_normalization(self) -> None:
        rec = status.new_status(
            job_id="j-1",
            mode="manual",
            series={"enabled": True, "series_id": "abc", "part": 2, "start_seconds": 30, "is_final": False},
        )
        self.assertEqual(rec["series"]["series_id"], "abc")
        self.assertEqual(rec["series"]["part"], 2)


class WriteStatusTests(unittest.TestCase):
    def setUp(self) -> None:
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_first_write_creates_file(self) -> None:
        rec = status.write_status(
            "manual-1",
            state="queued",
            mode="manual",
            message="starting",
            root=self.root,
            now_epoch=2000,
        )
        path = self.root / "manual-1" / "status.json"
        self.assertTrue(path.exists())
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(stored, rec)
        self.assertEqual(rec["state"], "queued")
        self.assertEqual(rec["created_at_epoch"], 2000)

    def test_merge_preserves_prior_fields(self) -> None:
        status.write_status(
            "manual-1",
            state="queued",
            mode="manual",
            release_tag="clipforge-manual-1",
            release_url="https://example/release",
            root=self.root,
            now_epoch=2000,
        )
        rec = status.write_status(
            "manual-1",
            state="stage_a_running",
            message="ingesting",
            root=self.root,
            now_epoch=2100,
        )
        self.assertEqual(rec["release_tag"], "clipforge-manual-1")
        self.assertEqual(rec["release_url"], "https://example/release")
        self.assertEqual(rec["state"], "stage_a_running")
        self.assertEqual(rec["created_at_epoch"], 2000)
        self.assertEqual(rec["updated_at_epoch"], 2100)

    def test_assets_merge_not_replace(self) -> None:
        status.write_status(
            "manual-1", state="queued", mode="manual",
            assets={"analysis_bundle_url": "u1"}, root=self.root, now_epoch=2000,
        )
        rec = status.write_status(
            "manual-1", state="stage_a_running",
            assets={"final_mp4": "u2"}, root=self.root, now_epoch=2100,
        )
        self.assertEqual(rec["assets"], {"analysis_bundle_url": "u1", "final_mp4": "u2"})

    def test_refuses_to_leave_terminal_state(self) -> None:
        status.write_status("manual-1", state="queued", mode="manual", root=self.root, now_epoch=2000)
        status.write_status("manual-1", state="complete", root=self.root, now_epoch=2100)
        with self.assertRaises(ValueError):
            status.write_status("manual-1", state="stage_b_running", root=self.root, now_epoch=2200)

    def test_terminal_to_terminal_idempotent(self) -> None:
        status.write_status("manual-1", state="queued", mode="manual", root=self.root, now_epoch=2000)
        status.write_status("manual-1", state="complete", root=self.root, now_epoch=2100)
        # complete -> complete is idempotent; error / cancelled are also permitted as
        # a terminal-to-terminal transition (used by cleanup jobs).
        status.write_status("manual-1", state="complete", root=self.root, now_epoch=2150)
        status.write_status("manual-1", state="cancelled", root=self.root, now_epoch=2200)

    def test_atomic_write_leaves_no_temp(self) -> None:
        status.write_status("j-1", state="queued", mode="manual", root=self.root, now_epoch=2000)
        job_dir = self.root / "j-1"
        # No temp files should be lingering after a successful write.
        for entry in job_dir.iterdir():
            self.assertFalse(entry.name.endswith(".tmp"))


class SchemaConformanceTests(unittest.TestCase):
    """The record produced by new_status must conform to the JSON schema."""

    def test_new_status_conforms_to_json_schema(self) -> None:
        try:
            import jsonschema  # type: ignore
        except ImportError:
            self.skipTest("jsonschema not installed")
        schema = json.loads((ROOT / "schemas" / "job_status.schema.json").read_text(encoding="utf-8"))
        rec = status.new_status(job_id="j-1", mode="manual")
        jsonschema.validate(rec, schema)


if __name__ == "__main__":
    unittest.main()
