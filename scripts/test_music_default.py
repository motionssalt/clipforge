#!/usr/bin/env python3
"""Regression coverage for ClipForge's persisted library-music default."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from read_automatic_music import is_safe_library_ref, valid_music_ref


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "app.js").read_text(encoding="utf-8")
AUTO = (ROOT / "automatic.html").read_text(encoding="utf-8")
TASK = (ROOT / "task.html").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")
DEFAULT = json.loads((ROOT / "branding" / "music_default.json").read_text(encoding="utf-8"))


assert DEFAULT["version"] == 1
stored_default = DEFAULT["library_track_path"]
assert stored_default is None or is_safe_library_ref("path:" + stored_default)
assert "One-off job uploads" in DEFAULT["note"]

# The only persistent path allowed is an audio-library basename. Traversal,
# external refs, and a different job's music file all fail closed.
assert valid_music_ref("path:audio-library/steady-bed.mp3", "job-1") == "path:audio-library/steady-bed.mp3"
unicode_track = "path:audio-library/𝐒𝐀𝐃 𝐅𝐔𝐍𝐊 (𝐒𝐔𝐏𝐄𝐑 𝐒𝐋𝐎𝐖𝐄𝐃) 𝐗 𝐘𝐔𝐓𝐀 𝐎𝐊𝐊𝐎𝐓𝐒𝐔.m4a"
assert is_safe_library_ref(unicode_track)
assert valid_music_ref(unicode_track, "job-1") == unicode_track
assert valid_music_ref("path:jobs/job-1/music.mp3", "job-1") == "path:jobs/job-1/music.mp3"
for bad in (
    "path:audio-library/../secret.mp3",
    "path:audio-library/nested/track.mp3",
    "path:audio-library/..\\secret.mp3",
    "path:audio-library/track\x00.mp3",
    "https://example.invalid/track.mp3",
    "path:jobs/other-job/music.mp3",
):
    try:
        valid_music_ref(bad, "job-1")
        raise AssertionError("unsafe music ref accepted: " + bad)
    except ValueError:
        pass

for required in (
    "var MUSIC_DEFAULT_PATH = 'branding/music_default.json';",
    "async function loadMusicDefault()",
    "async function saveMusicDefault(trackPath)",
    "function resolvedLibraryMusicRef()",
    "async function prepareAutomaticMusicChoice(jobId)",
    "saved_library_default",
    "one_off_upload",
    "if (!state.musicDefaultLoaded) await loadMusicDefault();",
    "musicRef = resolvedLibraryMusicRef();",
    "basename.indexOf('/') === -1",
    "basename.indexOf('\\\\') === -1",
):
    assert required in APP, f"missing music-default controller behavior: {required}"

assert "[A-Za-z0-9._-]+" not in APP, "frontend library validation must not reject Unicode track filenames"
# Manual and automatic UI each show the current default. Automatic Mode has
# one (and only one) forward picker in its launch form, not a later handoff.
assert AUTO.count('id="audio-library-list"') == 1
assert AUTO.count('id="music-file-input"') == 1
assert 'id="audio-library-default"' in AUTO
assert "shared last-selected default" in AUTO
assert 'id="audio-library-default"' in TASK
assert "saved library default is used" in TASK

for required in (
    "Resolve Automatic Mode music selection",
    "python scripts/read_automatic_music.py",
    '"jobs/${{ steps.jid.outputs.job_id }}/automatic_music.json"',
    '--extra "music_ref=${{ steps.automatic_music.outputs.music_ref }}"',
    '-f "music_ref=${{ steps.automatic_music.outputs.music_ref }}"',
):
    assert required in WORKFLOW, f"Automatic Mode workflow does not forward music: {required}"

print("PASS: manual and Automatic Mode use visible persisted library defaults while one-off uploads remain job-scoped")
