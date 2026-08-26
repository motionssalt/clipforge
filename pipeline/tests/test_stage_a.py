"""Offline unit tests for the Stage A ingest + analyze modules.

No network, no ffmpeg, no faster-whisper — everything here exercises the pure
validators, parsers, scorers, and bundle/manifest assembly with temp files.
"""
from __future__ import annotations

import json
import sys
import time
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline.stage_a import ingest, scenes, bundle  # noqa: E402


# --------------------------------------------------------------------------- #
# Host / URL classification                                                     #
# --------------------------------------------------------------------------- #

def test_telegram_public_post_url_accepts_channel_post():
    assert ingest.telegram_public_post_url("https://t.me/somechannel/123") == "https://t.me/somechannel/123"
    assert ingest.telegram_public_post_url("https://t.me/s/somechannel/7") == "https://t.me/somechannel/7"


def test_telegram_public_post_url_rejects_non_posts():
    assert ingest.telegram_public_post_url("https://t.me/somechannel") is None
    assert ingest.telegram_public_post_url("https://t.me/+abcdef") is None
    assert ingest.telegram_public_post_url("https://t.me/c/123/456") is None
    assert ingest.telegram_public_post_url("https://example.com/somechannel/1") is None


def test_disabled_social_hosts():
    assert ingest.disabled_social_host("https://youtu.be/abc") == "youtu.be"
    assert ingest.disabled_social_host("https://www.tiktok.com/@x/video/1") == "tiktok.com"
    assert ingest.disabled_social_host("https://cdn.example.com/v.mp4") is None


def test_extract_file_id():
    assert ingest.extract_file_id("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrSt/view") == "1AbCdEfGhIjKlMnOpQrSt"
    assert ingest.extract_file_id("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrSt") == "1AbCdEfGhIjKlMnOpQrSt"
    assert ingest.extract_file_id("1AbCdEfGhIjKlMnOpQrSt12") == "1AbCdEfGhIjKlMnOpQrSt12"
    with pytest.raises(ingest.IngestError):
        ingest.extract_file_id("https://example.com/no-id-here")


# --------------------------------------------------------------------------- #
# Magnet validation                                                             #
# --------------------------------------------------------------------------- #

def test_magnet_hex_and_base32_infohash():
    hex40 = "0123456789abcdef0123456789abcdef01234567"
    info = ingest.inspect_magnet(f"magnet:?xt=urn:btih:{hex40}&dn=test")
    assert info["infohash_v1"] == hex40.upper()
    assert info["display_name"] == "test"
    # base32 form of the same 20 bytes decodes to the same hex
    import base64
    b32 = base64.b32encode(bytes.fromhex(hex40)).decode()
    info2 = ingest.inspect_magnet(f"magnet:?xt=urn:btih:{b32}")
    assert info2["infohash_v1"] == hex40.upper()


def test_magnet_rejects_bad_input():
    with pytest.raises(ingest.MagnetError):
        ingest.inspect_magnet("magnet:?dn=nothing")  # no xt
    with pytest.raises(ingest.MagnetError):
        ingest.inspect_magnet("magnet:?xt=urn:btih:aaa&xt=urn:btih:bbb")  # two xt
    with pytest.raises(ingest.MagnetError):
        ingest.inspect_magnet("https://example.com/?xt=urn:btih:" + "a" * 40)  # not magnet:
    with pytest.raises(ingest.MagnetError):
        ingest.inspect_magnet("magnet:?xt=urn:btih:" + "a" * 40 + "&tr=http://user:pw@t.example/announce")
    with pytest.raises(ingest.MagnetError):
        ingest.inspect_magnet("magnet:?xt=urn:btih:" + "a" * 39)  # wrong length


# --------------------------------------------------------------------------- #
# Torrent manifest parsing                                                      #
# --------------------------------------------------------------------------- #

def _make_torrent(tmp_path: Path, files: list[tuple[str, int]]) -> Path:
    info = {b"name": b"pack", b"piece length": 16384, b"pieces": b"x" * 20,
            b"files": [{b"length": n, b"path": [p.encode()]} for p, n in files]}
    raw = ingest._encode_bencode({b"info": info})
    path = tmp_path / "pack.torrent"
    path.write_bytes(raw)
    return path


def test_inspect_torrent_and_candidates(tmp_path):
    path = _make_torrent(tmp_path, [("movie.mp4", 1000), ("notes.txt", 10), ("extra.mkv", 500)])
    meta = ingest.inspect_torrent(path)
    assert meta["name"] == "pack"
    assert meta["file_count"] == 3
    assert [c["path"] for c in meta["video_candidates"]] == ["movie.mp4", "extra.mkv"]
    chosen = ingest.select_torrent_video(meta, 1)
    assert chosen["path"] == "movie.mp4"
    with pytest.raises(ingest.BencodeError):
        ingest.select_torrent_video(meta, 2)  # notes.txt is not a video
    assert len(ingest.torrent_infohash_v1(path)) == 40


def test_inspect_torrent_rejects_traversal_and_no_video(tmp_path):
    evil = _make_torrent(tmp_path, [("../escape.mp4", 5)])
    with pytest.raises(ingest.BencodeError):
        ingest.inspect_torrent(evil)
    novideo = _make_torrent(tmp_path, [("readme.txt", 5)])
    with pytest.raises(ingest.BencodeError):
        ingest.inspect_torrent(novideo)


def test_select_video_matches_single_payload(tmp_path):
    root = tmp_path / "dl"
    (root / "sub").mkdir(parents=True)
    (root / "sub" / "movie.mp4").write_bytes(b"\0" * 4)
    assert ingest.select_video(root, "sub/movie.mp4").name == "movie.mp4"
    with pytest.raises(FileNotFoundError):
        ingest.select_video(root, "sub/other.mp4")


# --------------------------------------------------------------------------- #
# Preserved-subsystem gates fail closed                                         #
# --------------------------------------------------------------------------- #

def _write_request(jobs_root: Path, job_id: str, kind: str, value: str) -> None:
    d = jobs_root / job_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "stage-a-request.json").write_text(json.dumps({
        "version": 2, "job_id": job_id,
        "source": {"kind": kind, "value": value},
        "options": {"whisper_model": "base", "language": "auto",
                    "target_duration_seconds": 120, "focus": "", "enable_vision_assist": True},
        "mode": "manual",
        "series": {"enabled": False, "series_id": "", "source_job_id": "",
                   "part": 0, "start_seconds": 0, "context": ""},
        "music": {"ref": "", "source": "none"},
        "saved_at_epoch": int(time.time()),
    }), encoding="utf-8")


def test_gated_kinds_fail_closed(tmp_path, monkeypatch):
    monkeypatch.delenv("GITHUB_REPOSITORY", raising=False)
    for kind in ("telegram_channel", "telegram_relay"):
        _write_request(tmp_path, f"job-{kind}", kind, "whatever")
        with pytest.raises(ingest.NotBuiltGate):
            ingest.ingest(f"job-{kind}", str(tmp_path / "work"), root=tmp_path)
        status = json.loads((tmp_path / f"job-{kind}" / "status.json").read_text())
        assert status["state"] == "error"


def test_load_request_rejects_unknown_kind(tmp_path):
    _write_request(tmp_path, "job-x", "ftp", "ftp://x")
    with pytest.raises(ingest.IngestError):
        ingest.load_request("job-x", root=tmp_path)


# --------------------------------------------------------------------------- #
# Scenes: shot index + key moments (pure logic)                                 #
# --------------------------------------------------------------------------- #

def test_build_shot_index_folds_flickers():
    shots = scenes.build_shot_index([10.0, 10.1, 25.0], 40.0)
    # 10.0->10.1 is a 0.1s flicker: folded by EXTENDING the previous shot's
    # end to 10.1 (preserved legacy behavior), not by creating a new shot.
    assert len(shots) == 3
    assert shots[0]["cause"] == "video_start"
    assert shots[0]["start_seconds"] == 0.0 and shots[0]["end_seconds"] == 10.1
    assert shots[1]["start_seconds"] == 10.1 and shots[1]["end_seconds"] == 25.0
    assert shots[-1]["end_seconds"] == 40.0


def test_score_emotional():
    assert scenes.score_emotional("") == 0.0
    assert scenes.score_emotional("the weather is nice today") == 0.0
    assert scenes.score_emotional("he will kill him, i swear he will die, dead, murder, blood") == 1.0


def test_transcript_between_density():
    segs = [{"start": 0.0, "end": 5.0, "text": "hello"}, {"start": 5.0, "end": 10.0, "text": "world"}]
    text, density = scenes.transcript_between(segs, 0.0, 10.0)
    assert text == "hello world"
    assert density == 1.0
    _, density = scenes.transcript_between(segs, 0.0, 20.0)
    assert density == 0.5


def test_compute_visual_tail_bounds():
    shots = [
        {"shot_id": 1, "start_seconds": 0.0, "end_seconds": 10.0},
        {"shot_id": 2, "start_seconds": 10.0, "end_seconds": 12.0},  # 2s next shot
        {"shot_id": 3, "start_seconds": 12.0, "end_seconds": 30.0},
    ]
    # tail capped at half the next (2s) shot -> 1.0s, below min but no room
    assert scenes.compute_visual_tail(shots, 0, 30.0) == 1.0
    # last shot: capped by video end
    assert scenes.compute_visual_tail(shots, 2, 30.0) == 0.0
    # roomy middle case
    shots2 = [
        {"shot_id": 1, "start_seconds": 0.0, "end_seconds": 10.0},
        {"shot_id": 2, "start_seconds": 10.0, "end_seconds": 30.0},
    ]
    assert scenes.compute_visual_tail(shots2, 0, 30.0) == 3.5


# --------------------------------------------------------------------------- #
# Bundle assembly                                                               #
# --------------------------------------------------------------------------- #

def _stage_work(tmp_path: Path, with_events: bool = True) -> Path:
    work = tmp_path / "work"
    (work / "analysis").mkdir(parents=True)
    (work / "screenshots").mkdir()
    (work / "original.mp4").write_bytes(b"\0" * 32)
    (work / "analysis" / "analysis_720p.mp4").write_bytes(b"\0" * 16)
    (work / "transcript.json").write_text(json.dumps({
        "audio_duration_seconds": 42.0, "segments": []}), encoding="utf-8")
    (work / "scene_index.json").write_text(json.dumps({
        "video_duration_seconds": 42.0, "shot_count": 1,
        "shots": [{"shot_id": 1, "start_seconds": 0.0, "end_seconds": 42.0,
                   "keyframe_seconds": 21.0, "cause": "video_start"}]}), encoding="utf-8")
    (work / "key_moments.json").write_text(json.dumps({
        "video_duration_seconds": 42.0, "moment_count": 0, "moments": []}), encoding="utf-8")
    (work / "screenshots" / "frame_000000.jpg").write_bytes(b"\xff\xd8\xff")  # jpeg magic
    (work / "screenshots" / "frame_000006.jpg").write_bytes(b"\xff\xd8\xff")
    if with_events:
        (work / "screenshots" / "event_000021000.jpg").write_bytes(b"\xff\xd8\xff")
    return work


def test_run_bundle_produces_contract_assets(tmp_path, monkeypatch):
    jobs_root = tmp_path / "jobs"
    _write_request(jobs_root, "job-bundle", "url", "https://example.com/v.mp4")
    work = _stage_work(tmp_path)
    monkeypatch.chdir(tmp_path.parents[0] if False else Path.cwd())  # keep cwd; prompt runs via -m

    manifest = bundle.run_bundle("job-bundle", str(work), "clipforge-job-bundle",
                                 jobs_root=str(jobs_root))
    bdir = work / "bundle"
    names = {a["name"] for a in manifest["assets"]}
    assert {"source_input.bin", "analysis_720p.mp4", "transcript.json",
            "screenshots.zip", "event_composites.zip", "scene_index.json",
            "key_moments.json", "00_READ_THIS_FIRST.txt", "manifest.json"} <= names
    assert manifest["release_tag"] == "clipforge-job-bundle"
    # schema-required fields on hashed assets
    src = next(a for a in manifest["assets"] if a["name"] == "source_input.bin")
    assert src["purpose"] == "source_full_quality"
    assert src["size_bytes"] == 32 and len(src["sha256"]) == 64
    # prompt generated and mentions the job
    prompt_text = (bdir / "00_READ_THIS_FIRST.txt").read_text(encoding="utf-8")
    assert "job-bundle" in prompt_text and "production.json" in prompt_text
    # screenshots.zip holds both kinds; event_composites.zip only events
    with zipfile.ZipFile(bdir / "screenshots.zip") as zf:
        zipped = set(zf.namelist())
    assert {"frame_000000.jpg", "frame_000006.jpg", "event_000021000.jpg"} <= zipped
    with zipfile.ZipFile(bdir / "event_composites.zip") as zf:
        assert set(zf.namelist()) == {"event_000021000.jpg"}


def test_run_bundle_omits_event_zip_when_no_events(tmp_path):
    jobs_root = tmp_path / "jobs"
    _write_request(jobs_root, "job-noev", "url", "https://example.com/v.mp4")
    work = _stage_work(tmp_path, with_events=False)
    manifest = bundle.run_bundle("job-noev", str(work), "clipforge-job-noev",
                                 jobs_root=str(jobs_root))
    names = {a["name"] for a in manifest["assets"]}
    assert "event_composites.zip" not in names
    with zipfile.ZipFile(work / "bundle" / "screenshots.zip") as zf:
        assert set(zf.namelist()) == {"frame_000000.jpg", "frame_000006.jpg"}


def test_run_bundle_requires_core_inputs(tmp_path):
    jobs_root = tmp_path / "jobs"
    _write_request(jobs_root, "job-missing", "url", "https://example.com/v.mp4")
    work = _stage_work(tmp_path)
    (work / "transcript.json").unlink()
    with pytest.raises(bundle.BundleError):
        bundle.run_bundle("job-missing", str(work), "clipforge-job-missing",
                          jobs_root=str(jobs_root))
