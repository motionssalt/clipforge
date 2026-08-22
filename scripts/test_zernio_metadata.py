#!/usr/bin/env python3
"""Offline regression tests for production.json -> Zernio metadata mapping."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

from zernio_publish import (
    build_platform_payload,
    load_production,
    normalize_hashtags,
    normalize_tags,
    production_metadata,
    write_publishing_state,
)

ROOT = Path(__file__).resolve().parents[1]
EXAMPLE = ROOT / "jobs" / "magnet-1787407050747" / "production.json"


def test_actual_production_example() -> None:
    doc = load_production(EXAMPLE)
    meta = production_metadata(doc)
    assert meta["title"] == "Morty Enters the Fear Hole Alone and It Knows Why"
    assert meta["caption"] == meta["title"]  # no caption field exists in the actual schema
    assert meta["hashtags"] == doc["hashtags"]
    assert meta["tags"] == doc["youtube_tags"]
    assert all(tag.startswith("#") and not tag.startswith("##") for tag in meta["hashtags"])
    assert all(not tag.startswith("#") and "," not in tag for tag in meta["tags"])


def test_normalization_does_not_duplicate_hashes_or_tags() -> None:
    assert normalize_hashtags(["#One", "##one", "Two", " #THREE "]) == ["#One", "#Two", "#THREE"]
    assert normalize_tags(["#one", "one", "two, words", "x" * 101]) == ["one", "two words"]


def test_platform_payloads_are_separate() -> None:
    doc = load_production(EXAMPLE)
    tiktok = build_platform_payload(doc, "tiktok", ["tt-1"], "https://media.example/final.mp4")
    youtube = build_platform_payload(doc, "youtube", ["yt-1"], "https://media.example/final.mp4")
    assert tiktok["content"] == doc["title"]
    assert tiktok["hashtags"] == doc["hashtags"]
    assert "title" not in tiktok
    assert "tags" not in tiktok
    assert youtube["title"] == doc["title"]
    assert youtube["tags"] == doc["youtube_tags"]
    assert youtube["hashtags"] == doc["hashtags"]
    assert youtube["content"] == doc["title"]
    assert all(entry["platform"] == "tiktok" for entry in tiktok["platforms"])
    assert all(entry["platform"] == "youtube" for entry in youtube["platforms"])


def test_optional_caption_and_tags_aliases_are_only_used_when_present() -> None:
    doc = {
        "title": "A title",
        "caption": "The generated caption.",
        "description": "A different description.",
        "hashtags": ["#one", "##two"],
        "tags": ["#keyword", "keyword", "plain"],
        "video_duration_seconds": 10,
        "target_total_duration_seconds": 5,
        "cuts": [{"start_seconds": 0, "end_seconds": 5, "voiceover_text": "Hello."}],
    }
    meta = production_metadata(doc)
    assert meta["caption"] == "The generated caption."
    assert meta["tags"] == ["keyword", "plain"]
    assert meta["metadata_source"]["caption"] == "production.json.caption"
    assert meta["metadata_source"]["tags"] == "production.json.tags"


def test_metadata_survives_publishing_state_merge() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        status = Path(tmp) / "status.json"
        status.write_text(json.dumps({"stage": "complete", "extra": {"title": "unchanged"}}))
        state = {"provider": "zernio", "status": "scheduled", "metadata": {"title": "A", "hashtags": ["#a"], "tags": ["tag"]}}
        write_publishing_state(status, state)
        saved = json.loads(status.read_text())
        assert saved["stage"] == "complete"
        assert saved["extra"]["title"] == "unchanged"
        assert saved["publishing"]["metadata"]["hashtags"] == ["#a"]
        assert saved["publishing"]["metadata"]["tags"] == ["tag"]


def test_cli_uses_the_actual_production_file() -> None:
    output = subprocess.check_output(["python3", str(ROOT / "scripts" / "zernio_publish.py"), "metadata", str(EXAMPLE)], text=True)
    meta = json.loads(output)
    assert meta["metadata_source"]["hashtags"] == "production.json.hashtags"
    assert meta["metadata_source"]["tags"] == "production.json.youtube_tags"


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"zernio metadata tests passed ({len(tests)} tests)")
