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
    selected = metadata["selected_video"]
    assert selected["path"].lower().endswith((".mkv", ".mp4", ".webm")), selected
    assert selected["length"] > 0
    assert 1 <= selected["index"] <= metadata["file_count"]

rick_metadata = source.inspect_torrent(rick)
assert rick_metadata["file_count"] == 3
assert rick_metadata["selected_video"]["index"] == 1
assert rick_metadata["selected_video"]["path"].endswith(".mkv")
kimetsu_metadata = source.inspect_torrent(kimetsu)
assert kimetsu_metadata["file_count"] == 1
assert kimetsu_metadata["selected_video"]["index"] == 1

with tempfile.TemporaryDirectory(prefix="clipforge_torrent_download_") as temp_dir:
    root = Path(temp_dir)
    (root / "readme.txt").write_text("not video", encoding="utf-8")
    small = root / "small.mp4"
    large = root / "nested" / "feature.mkv"
    large.parent.mkdir()
    small.write_bytes(b"0" * 32)
    large.write_bytes(b"1" * 128)
    assert source.select_video(root) == large

workflow = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")
app = (ROOT / "app.js").read_text(encoding="utf-8")
html = (ROOT / "index.html").read_text(encoding="utf-8")
assert "source.torrent" in workflow and "aria2c" in workflow
assert "--select-file=\"$selected_index\"" in workflow
assert "--seed-time=0" in workflow
assert "expected_path=\"jobs/${{ steps.jid.outputs.job_id }}/source.torrent\"" in workflow
assert "torrent-file-input" in app and "inputs.video_url = 'path:' + torrentPath" in app
assert "torrent-file-input" in html and 'accept=".torrent,application/x-bittorrent"' in html

print("PASS: uploaded torrent metadata selects only a safe video payload and routes through Stage A")
