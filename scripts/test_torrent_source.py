#!/usr/bin/env python3
"""Offline regression coverage for Stage A uploaded-torrent ingestion."""

from __future__ import annotations

import importlib.util
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = ROOT / "scripts" / "torrent_source.py"
spec = importlib.util.spec_from_file_location("torrent_source", HELPER_PATH)
assert spec and spec.loader
source = importlib.util.module_from_spec(spec)
spec.loader.exec_module(source)

UPLOADS = Path("/home/ubuntu/upload")
kimetsu = UPLOADS / "[DKB]KimetsunoYaibaMugenjou-hen-AkazaSairai-[1080p][BD][HEVCx26510bit][Multi-Audio][Multi-Subs][2540E267].mkv.torrent"
rick = UPLOADS / "Rick.and.Morty.S01E01.Pilot.with.Audio.Description.1080p.AMZN.WEB-DL.DDP5.1.H.264-Kitsune[ext.to].torrent"

for torrent in (kimetsu, rick):
    metadata = source.inspect_torrent(torrent)
    candidates = metadata["video_candidates"]
    assert candidates
    assert all(item["path"].lower().endswith((".mkv", ".mp4", ".webm"))
               for item in candidates), candidates
    assert all(item["length"] > 0 for item in candidates)

rick_metadata = source.inspect_torrent(rick)
assert rick_metadata["file_count"] == 3
assert [item["index"] for item in rick_metadata["video_candidates"]] == [1]
assert source.select_torrent_video(rick_metadata, 1)["path"].endswith(".mkv")
kimetsu_metadata = source.inspect_torrent(kimetsu)
assert kimetsu_metadata["file_count"] == 1
assert [item["index"] for item in kimetsu_metadata["video_candidates"]] == [1]
assert source.select_torrent_video(kimetsu_metadata, 1)["path"].endswith(".mkv")

multi_video_metadata = {
    "files": [
        {"index": 1, "path": "episodes/episode-01.mkv", "length": 2_000},
        {"index": 2, "path": "episodes/episode-02.mkv", "length": 1_900},
        {"index": 3, "path": "extras/trailer.mp4", "length": 100},
        {"index": 4, "path": "notes/readme.txt", "length": 10},
    ]
}
assert [item["index"] for item in source.torrent_video_candidates(multi_video_metadata)] == [1, 2, 3]
assert source.select_torrent_video(multi_video_metadata, 2)["path"] == "episodes/episode-02.mkv"
try:
    source.select_torrent_video(multi_video_metadata, 4)
    raise AssertionError("non-video torrent selection was accepted")
except source.BencodeError:
    pass

with tempfile.TemporaryDirectory(prefix="clipforge_torrent_download_") as temp_dir:
    root = Path(temp_dir)
    (root / "readme.txt").write_text("not video", encoding="utf-8")
    selected = root / "episodes" / "episode-02.mkv"
    decoy = root / "episodes" / "episode-01.mkv"
    selected.parent.mkdir()
    decoy.write_bytes(b"0" * 32)
    selected.write_bytes(b"1" * 128)
    assert source.select_video(root, "episodes/episode-02.mkv") == selected
    try:
        source.select_video(root, "extras/trailer.mp4")
        raise AssertionError("missing selected payload was accepted")
    except FileNotFoundError:
        pass

workflow = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
html = (ROOT / "index.html").read_text(encoding="utf-8")
assert "source.torrent" in workflow and "aria2c" in workflow
assert "--select-file=\"$selected_index\"" in workflow
assert "--seed-time=0" in workflow
assert "torrent_file_index" in workflow and "select-path" in workflow
assert "expected_path=\"jobs/${{ steps.jid.outputs.job_id }}/source.torrent\"" in workflow
assert "torrent-file-input" in app and "inputs.video_url = 'path:' + torrentPath" in app
assert "!state.torrentVideoIndex" in app and "torrentVideoCandidates" in app
assert "torrent-video-select" in html and 'accept=".torrent,application/x-bittorrent"' in html

print("PASS: explicit multi-video torrent selection routes only the chosen safe payload through Stage A")
