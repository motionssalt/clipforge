"""Unit tests for public YouTube source ingestion, normalization, error mapping, and schema validation."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch
import pytest

from pipeline.stage_a import ingest
from pipeline.stage_a.ingest import (
    IngestError,
    extract_youtube_video_id,
    normalize_youtube_url,
    _map_ytdlp_error,
    DISABLED_SOCIAL_HOSTS,
    YOUTUBE_HOSTS,
)


# --- 1. Video ID Extraction & Normalization -----------------------------------

@pytest.mark.parametrize(
    "url,expected_id",
    [
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLrAXtmErZgOdP_8GztsuKi9upL79of42", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/watch?v=dQw4w9WgXcQ&index=3&start_radio=1", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
        ("https://www.youtube.com/v/dQw4w9WgXcQ", "dQw4w9WgXcQ"),
    ],
)
def test_extract_youtube_video_id_valid(url, expected_id):
    assert extract_youtube_video_id(url) == expected_id
    canonical = normalize_youtube_url(url)
    assert canonical == f"https://www.youtube.com/watch?v={expected_id}"
    assert "list=" not in canonical
    assert "index=" not in canonical
    assert "start_radio=" not in canonical


@pytest.mark.parametrize(
    "url",
    [
        "https://www.youtube.com/",
        "https://www.youtube.com/watch",
        "https://www.youtube.com/playlist?list=PLrAXtmErZgOdP_8GztsuKi9upL79of42",
        "https://youtu.be/",
        "https://example.com/watch?v=dQw4w9WgXcQ",
        "not-a-url",
        "",
        None,
    ],
)
def test_extract_youtube_video_id_invalid(url):
    assert extract_youtube_video_id(url) is None
    with pytest.raises(IngestError):
        normalize_youtube_url(url)


# --- 2. Disabled Social Hosts Unchanged Except YouTube ------------------------

def test_disabled_social_hosts_unblocks_youtube():
    assert "youtube.com" not in DISABLED_SOCIAL_HOSTS
    assert "youtu.be" not in DISABLED_SOCIAL_HOSTS
    assert "youtube-nocookie.com" not in DISABLED_SOCIAL_HOSTS

    # Other social platforms remain disabled
    assert any("tiktok.com" in h for h in DISABLED_SOCIAL_HOSTS)
    assert any("instagram.com" in h for h in DISABLED_SOCIAL_HOSTS)
    assert any("facebook.com" in h for h in DISABLED_SOCIAL_HOSTS)
    assert any("twitter.com" in h or "x.com" in h for h in DISABLED_SOCIAL_HOSTS)
    assert any("vimeo.com" in h for h in DISABLED_SOCIAL_HOSTS)
    assert any("reddit.com" in h for h in DISABLED_SOCIAL_HOSTS)


# --- 3. Error Mapping ---------------------------------------------------------

def test_map_ytdlp_error_bot_check_without_cookies():
    err_text = "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. This helps protect our community."
    err = _map_ytdlp_error(err_text, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", has_cookies=False)
    assert isinstance(err, IngestError)
    assert "YOUTUBE_COOKIES" in str(err)
    assert "throwaway Google account" in str(err)


def test_map_ytdlp_error_bot_check_with_cookies():
    err_text = "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot."
    err = _map_ytdlp_error(err_text, "https://www.youtube.com/watch?v=dQw4w9WgXcQ", has_cookies=True)
    assert isinstance(err, IngestError)
    assert "expired or flagged" in str(err)
    assert "refresh" in str(err)


def test_map_ytdlp_error_private_or_removed():
    private_err = _map_ytdlp_error("ERROR: This video is private", "url", False)
    assert "private" in str(private_err).lower()

    removed_err = _map_ytdlp_error("ERROR: This video has been removed by the uploader", "url", False)
    assert "removed" in str(removed_err).lower() or "unavailable" in str(removed_err).lower()

    members_err = _map_ytdlp_error("ERROR: Join this channel to view members-only video", "url", False)
    assert "members-only" in str(members_err).lower()

    livestream_err = _map_ytdlp_error("ERROR: This live stream has not started yet", "url", False)
    assert "live stream" in str(livestream_err).lower()


# --- 4. Schema Validation for YouTube source.kind -----------------------------

def test_stage_a_request_schema_accepts_youtube():
    schema_path = Path(__file__).resolve().parents[2] / "schemas" / "stage_a_request.schema.json"
    with open(schema_path, "r", encoding="utf-8") as f:
        schema = json.load(f)

    # Verify enum in schema
    source_props = schema.get("properties", {}).get("source", {}).get("properties", {})
    kind_enum = source_props.get("kind", {}).get("enum", [])
    assert "youtube" in kind_enum

    # Validate full synthetic request payload against schema
    sample_request = {
        "version": 2,
        "job_id": "manual-1700000000000",
        "mode": "manual",
        "saved_at_epoch": 1700000000,
        "source": {
            "kind": "youtube",
            "value": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        },
        "options": {
            "whisper_model": "base",
            "language": "auto",
            "task": "translate_to_english",
            "target_duration_seconds": 60,
            "focus": "test focus",
            "enable_vision_assist": True
        },
        "series": {
            "enabled": False,
            "super_series": False,
            "series_id": "",
            "source_job_id": "manual-1700000000000",
            "part": 0,
            "start_seconds": 0,
            "context": ""
        },
        "music": {
            "ref": "",
            "source": "none"
        }
    }

    import jsonschema
    jsonschema.validate(instance=sample_request, schema=schema)


# --- 5. Download YouTube Orchestration & Fallback ----------------------------

def test_download_youtube_success_mocked(tmp_path, monkeypatch):
    dest = str(tmp_path / "original.mp4")

    def fake_run(cmd, capture_output=True, text=True):
        out_idx = cmd.index("-o") + 1
        template = cmd[out_idx]
        actual_file = template.replace("%(ext)s", "mp4")
        Path(actual_file).write_bytes(b"x" * 1024)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "OK"
        mock_proc.stderr = ""
        return mock_proc

    monkeypatch.setattr(ingest.subprocess, "run", fake_run)
    monkeypatch.setattr(ingest, "MAX_VIDEO_BYTES", 5000)

    size = ingest.download_youtube("https://youtu.be/dQw4w9WgXcQ", dest)
    assert size == 1024
    assert os.path.exists(dest)


def test_download_youtube_size_limit_exceeded(tmp_path, monkeypatch):
    dest = str(tmp_path / "original.mp4")

    def fake_run(cmd, capture_output=True, text=True):
        out_idx = cmd.index("-o") + 1
        template = cmd[out_idx]
        actual_file = template.replace("%(ext)s", "mp4")
        Path(actual_file).write_bytes(b"x" * 2000)
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = "OK"
        mock_proc.stderr = ""
        return mock_proc

    monkeypatch.setattr(ingest.subprocess, "run", fake_run)
    monkeypatch.setattr(ingest, "MAX_VIDEO_BYTES", 1000)

    with pytest.raises(IngestError) as exc_info:
        ingest.download_youtube("https://youtu.be/dQw4w9WgXcQ", dest)
    assert "exceeds the 12 GiB maximum limit" in str(exc_info.value)
