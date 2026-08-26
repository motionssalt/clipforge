"""Offline tests for pipeline/cleanup/expired.py (background TTL cleanup).

Covers the expiry decision matrix (expires_at_epoch / created_at+ttl / release
fallback / unreadable), release tag -> job id mapping, the RFC 5988 pagination
parser, and a full mocked-API end-to-end run. No test makes real network
calls: all HTTP goes through a fake opener.
"""

from __future__ import annotations

import io
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError
from urllib.request import Request

from pipeline.cleanup.expired import (
    _next_link,
    job_id_from_release,
    job_is_expired,
    list_job_ids_from_disk,
    main,
    parse_iso8601,
    read_job_timing,
)


class _FakeResponse:
    def __init__(self, status: int = 200, payload=None, headers: dict | None = None):
        self.status = status
        self.headers = headers or {}
        self._payload = json.dumps(payload).encode("utf-8") if payload is not None else b""

    def read(self, _limit: int = -1) -> bytes:
        return self._payload

    def getcode(self) -> int:
        return self.status

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeGitHub:
    """Scriptable GitHub API double. Records every call; serves canned data."""

    def __init__(self, *, releases=None, branches=None):
        self.releases = list(releases or [])
        self.branches = list(branches or [])
        self.calls: list[tuple[str, str]] = []
        self.deleted: list[str] = []

    def opener(self, req: Request) -> _FakeResponse:
        method = req.get_method()
        url = req.full_url
        self.calls.append((method, url))
        if method == "GET" and "/releases" in url:
            return _FakeResponse(200, self.releases)
        if method == "GET" and "/branches" in url:
            return _FakeResponse(200, self.branches)
        if method == "DELETE":
            self.deleted.append(url)
            return _FakeResponse(204, None)
        raise AssertionError(f"unexpected request: {method} {url}")


class NextLink(unittest.TestCase):
    def test_parses_next(self):
        header = (
            '<https://api.github.com/repos/o/r/releases?per_page=100&page=2>; rel="next", '
            '<https://api.github.com/repos/o/r/releases?per_page=100&page=3>; rel="last"'
        )
        self.assertEqual(
            _next_link(header),
            "https://api.github.com/repos/o/r/releases?per_page=100&page=2",
        )

    def test_absent(self):
        self.assertEqual(_next_link('<https://x>; rel="last"'), "")
        self.assertEqual(_next_link(""), "")


class JobIdFromRelease(unittest.TestCase):
    def test_job_tag(self):
        self.assertEqual(job_id_from_release({"tag_name": "clipforge-manual-123"}), "manual-123")

    def test_relay_tag(self):
        self.assertEqual(job_id_from_release({"tag_name": "clipforge-relay-input-manual-9"}), "manual-9")

    def test_body_marker(self):
        rel = {"tag_name": "other", "body": "notes\nclipforge-job-id: automatic-42\nmore"}
        self.assertEqual(job_id_from_release(rel), "automatic-42")

    def test_unrelated_release(self):
        self.assertIsNone(job_id_from_release({"tag_name": "v1.0.0", "body": "release notes"}))


class JobTiming(unittest.TestCase):
    def test_reads_both_fields(self):
        with TemporaryDirectory() as td:
            job = Path(td) / "jobs" / "job-1"
            job.mkdir(parents=True)
            (job / "status.json").write_text(json.dumps({
                "state": "complete", "created_at_epoch": 100, "expires_at_epoch": 200,
            }), encoding="utf-8")
            self.assertEqual(read_job_timing(td, "job-1"),
                             {"created_at_epoch": 100, "expires_at_epoch": 200})

    def test_missing_folder(self):
        with TemporaryDirectory() as td:
            self.assertEqual(read_job_timing(td, "nope"),
                             {"created_at_epoch": None, "expires_at_epoch": None})

    def test_unreadable_json(self):
        with TemporaryDirectory() as td:
            job = Path(td) / "jobs" / "job-2"
            job.mkdir(parents=True)
            (job / "status.json").write_text("{not json", encoding="utf-8")
            self.assertEqual(read_job_timing(td, "job-2"),
                             {"created_at_epoch": None, "expires_at_epoch": None})

    def test_list_job_ids_skips_hidden(self):
        with TemporaryDirectory() as td:
            base = Path(td) / "jobs"
            (base / "a").mkdir(parents=True)
            (base / ".hidden").mkdir()
            (base / "file.txt").write_text("x", encoding="utf-8")
            self.assertEqual(sorted(list_job_ids_from_disk(td)), ["a"])


class ExpiryDecision(unittest.TestCase):
    NOW = 100_000

    def test_expires_at_epoch_wins(self):
        timing = {"created_at_epoch": 1, "expires_at_epoch": self.NOW - 1}
        expired, reason = job_is_expired(timing, now=self.NOW, ttl=86_400_000)
        self.assertTrue(expired)
        self.assertIn("expires_at", reason)

    def test_expires_at_epoch_future_keeps(self):
        timing = {"created_at_epoch": 1, "expires_at_epoch": self.NOW + 3600}
        expired, _ = job_is_expired(timing, now=self.NOW, ttl=10)
        self.assertFalse(expired)

    def test_created_plus_ttl(self):
        timing = {"created_at_epoch": self.NOW - 500, "expires_at_epoch": None}
        expired, reason = job_is_expired(timing, now=self.NOW, ttl=400)
        self.assertTrue(expired)
        self.assertIn("ttl=400", reason)
        expired, _ = job_is_expired(timing, now=self.NOW, ttl=600)
        self.assertFalse(expired)

    def test_release_fallback(self):
        timing = {"created_at_epoch": None, "expires_at_epoch": None}
        expired, reason = job_is_expired(
            timing, now=self.NOW, ttl=100, release_created_at=self.NOW - 200)
        self.assertTrue(expired)
        self.assertIn("release_created_at", reason)

    def test_nothing_readable_is_expired(self):
        timing = {"created_at_epoch": None, "expires_at_epoch": None}
        expired, reason = job_is_expired(timing, now=self.NOW, ttl=100)
        self.assertTrue(expired)
        self.assertIn("no readable timing", reason)


class ParseIso(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(parse_iso8601("1970-01-01T00:01:00Z"), 60)

    def test_invalid(self):
        self.assertEqual(parse_iso8601("not-a-date"), 0)
        self.assertEqual(parse_iso8601(""), 0)


class EndToEnd(unittest.TestCase):
    NOW = 1_800_000_000

    def _env(self) -> dict[str, str]:
        return {
            "GITHUB_TOKEN": "test-token",  # fake; never leaves the process
            "GITHUB_REPOSITORY": "owner/repo",
            "CLIPFORGE_TTL_SECONDS": "43200",
        }

    def test_requires_credentials(self):
        self.assertEqual(main(env={}, root=".", opener=_FakeGitHub().opener, log=lambda *a, **k: None), 2)

    def test_rejects_bad_ttl(self):
        env = self._env()
        env["CLIPFORGE_TTL_SECONDS"] = "abc"
        self.assertEqual(main(env=env, root=".", opener=_FakeGitHub().opener, log=lambda *a, **k: None), 2)
        env["CLIPFORGE_TTL_SECONDS"] = "0"
        self.assertEqual(main(env=env, root=".", opener=_FakeGitHub().opener, log=lambda *a, **k: None), 2)

    def test_full_cleanup_run(self):
        import time as time_mod

        with TemporaryDirectory() as td:
            # Expired job (created long ago, no expires_at -> ttl applies).
            old = Path(td) / "jobs" / "manual-old"
            old.mkdir(parents=True)
            (old / "status.json").write_text(json.dumps({
                "state": "complete", "created_at_epoch": self.NOW - 90000,
            }), encoding="utf-8")
            # Live job (recent).
            live = Path(td) / "jobs" / "manual-live"
            live.mkdir(parents=True)
            (live / "status.json").write_text(json.dumps({
                "state": "stage_b_running", "created_at_epoch": self.NOW - 60,
            }), encoding="utf-8")
            # Folder with no status.json -> expired per legacy rule.
            orphan = Path(td) / "jobs" / "manual-orphan"
            orphan.mkdir(parents=True)

            fake = _FakeGitHub(
                releases=[
                    {"id": 11, "tag_name": "clipforge-manual-old",
                     "created_at": "2027-01-01T00:00:00Z", "body": ""},
                    {"id": 12, "tag_name": "clipforge-manual-live",
                     "created_at": "2027-01-01T00:00:00Z", "body": ""},
                    {"id": 13, "tag_name": "unrelated", "created_at": "", "body": ""},
                ],
                branches=[
                    {"name": "main"},
                    {"name": "clipforge-job/manual-old"},
                    {"name": "clipforge-job/manual-live"},
                    {"name": "clipforge-job/manual-ghost"},
                ],
            )

            real_time = time_mod.time
            time_mod.time = lambda: self.NOW
            try:
                rc = main(env=self._env(), root=td, opener=fake.opener,
                          log=lambda *a, **k: None)
            finally:
                time_mod.time = real_time

            self.assertEqual(rc, 0)
            deleted = "\n".join(fake.deleted)
            # Expired release + its tag deleted; live release untouched.
            self.assertIn("/releases/11", deleted)
            self.assertIn("/git/refs/tags/clipforge-manual-old", deleted)
            self.assertNotIn("/releases/12", deleted)
            # Expired + ghost branches deleted; live branch and main kept.
            self.assertIn("clipforge-job%2Fmanual-old", deleted.replace("/", "%2F"))
            self.assertIn("manual-ghost", deleted)
            self.assertNotIn("manual-live", deleted)
            self.assertNotIn("/main", deleted)
            # Expired folders removed from disk; live folder remains.
            self.assertFalse(old.exists())
            self.assertFalse(orphan.exists())
            self.assertTrue(live.exists())

    def test_expires_at_epoch_drives_expiry(self):
        import time as time_mod

        with TemporaryDirectory() as td:
            job = Path(td) / "jobs" / "manual-exp"
            job.mkdir(parents=True)
            # Recently created but explicitly expired (short operator TTL).
            (job / "status.json").write_text(json.dumps({
                "state": "complete",
                "created_at_epoch": self.NOW - 60,
                "expires_at_epoch": self.NOW - 1,
            }), encoding="utf-8")
            fake = _FakeGitHub(
                releases=[{"id": 21, "tag_name": "clipforge-manual-exp",
                           "created_at": "", "body": ""}],
                branches=[],
            )
            real_time = time_mod.time
            time_mod.time = lambda: self.NOW
            try:
                rc = main(env=self._env(), root=td, opener=fake.opener,
                          log=lambda *a, **k: None)
            finally:
                time_mod.time = real_time
            self.assertEqual(rc, 0)
            self.assertIn("/releases/21", "\n".join(fake.deleted))
            self.assertFalse(job.exists())


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
