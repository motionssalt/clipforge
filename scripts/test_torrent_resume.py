#!/usr/bin/env python3
"""Regression coverage for resumable Stage A torrent-video selection."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
UPLOADS = Path("/home/ubuntu/upload")
TORRENT = UPLOADS / (
    "Rick.and.Morty.S01E01.Pilot.with.Audio.Description.1080p."
    "AMZN.WEB-DL.DDP5.1.H.264-Kitsune[ext.to].torrent"
)

assert TORRENT.is_file(), f"missing regression fixture: {TORRENT}"
writer = ROOT / "scripts" / "write_torrent_selection.py"
status_writer = ROOT / "scripts" / "write_status.py"

with tempfile.TemporaryDirectory(prefix="clipforge_torrent_resume_") as tmp:
    root = Path(tmp)
    record_path = root / "jobs" / "resume-check" / "torrent-selection.json"
    subprocess.run([
        "python3", str(writer), str(TORRENT), str(record_path),
        "--job-id", "resume-check", "--whisper-model", "base",
        "--language", "auto", "--target-duration-seconds", "120",
        "--focus", "the opening scene",
    ], check=True)
    record = json.loads(record_path.read_text(encoding="utf-8"))
    assert record["job_id"] == "resume-check"
    assert record["selected_index"] is None
    assert len(record["video_candidates"]) == 1
    candidate = record["video_candidates"][0]
    assert candidate["index"] == 1
    assert candidate["path"].endswith(".mkv")
    assert candidate["length"] > 0
    assert record["stage_a_inputs"]["focus"] == "the opening scene"

    subprocess.run([
        "python3", str(status_writer), "resume-check", "awaiting_torrent_selection",
        "--out-dir", str(root / "jobs"),
        "--message", "Choose a video from this torrent to begin Stage A.",
        "--release-tag", "clipforge-resume-check",
        "--extra", "torrent_selection_path=jobs/resume-check/torrent-selection.json",
    ], check=True)
    status = json.loads((root / "jobs" / "resume-check" / "status.json").read_text(encoding="utf-8"))
    assert status["stage"] == "awaiting_torrent_selection"
    assert status["extra"]["torrent_selection_path"].endswith("torrent-selection.json")
    assert status["expires_at_epoch"] > status["created_at_epoch"]

workflow = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
html = (ROOT / "index.html").read_text(encoding="utf-8")

assert "torrent_selection:" in workflow
assert "stage_a_ready" in workflow
assert "awaiting_torrent_selection" in workflow
assert "write_torrent_selection.py" in workflow
assert "needs.torrent_selection.outputs.stage_a_ready == 'true'" in workflow
assert "selected_index=\"${{ github.event.inputs.torrent_file_index }}\"" in workflow
assert "createPendingTorrentSelection" in app
assert "dispatchPendingTorrentSelection" in app
assert "loadPendingTorrentSelection" in app
assert "awaiting_torrent_selection" in app
assert "torrent-selection.json" in app
assert "torrent-selection-block" in html
assert "start-torrent-stage-a" in html

print("PASS: Stage A torrent selection is persisted, reloadable, and blocks execution until one valid video is confirmed")
