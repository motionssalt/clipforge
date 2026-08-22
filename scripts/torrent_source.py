#!/usr/bin/env python3
"""Safely inspect a .torrent manifest and choose its largest video payload.

This utility never contacts trackers, peers, or DHT. It only parses bencoded
manifest metadata already supplied by the user, and later selects a downloaded
video file from a local directory for Stage A's normal ingest path.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any


MAX_TORRENT_BYTES = 1 * 1024 * 1024
MAX_VIDEO_BYTES = 12 * 1024 * 1024 * 1024
VIDEO_EXTENSIONS = {
    ".mkv", ".mp4", ".m4v", ".mov", ".webm", ".avi", ".ts", ".m2ts",
}


class BencodeError(ValueError):
    """Raised when a torrent manifest is malformed or exceeds safe limits."""


def _decode_bencode(data: bytes) -> Any:
    """Decode the small bencoded metadata grammar used by torrent manifests."""
    index = 0

    def parse() -> Any:
        nonlocal index
        if index >= len(data):
            raise BencodeError("unexpected end of bencoded data")
        token = data[index:index + 1]
        if token == b"i":
            index += 1
            end = data.find(b"e", index)
            if end < 0:
                raise BencodeError("unterminated integer")
            raw = data[index:end]
            if not raw or raw in (b"-0",) or (raw.startswith(b"0") and len(raw) > 1):
                raise BencodeError("invalid integer")
            try:
                value = int(raw)
            except ValueError as exc:
                raise BencodeError("invalid integer") from exc
            index = end + 1
            return value
        if token == b"l":
            index += 1
            values = []
            while index < len(data) and data[index:index + 1] != b"e":
                values.append(parse())
            if index >= len(data):
                raise BencodeError("unterminated list")
            index += 1
            return values
        if token == b"d":
            index += 1
            values: dict[bytes, Any] = {}
            while index < len(data) and data[index:index + 1] != b"e":
                key = parse()
                if not isinstance(key, bytes):
                    raise BencodeError("dictionary key is not a byte string")
                values[key] = parse()
            if index >= len(data):
                raise BencodeError("unterminated dictionary")
            index += 1
            return values
        if token.isdigit():
            colon = data.find(b":", index)
            if colon < 0:
                raise BencodeError("missing byte-string separator")
            try:
                length = int(data[index:colon])
            except ValueError as exc:
                raise BencodeError("invalid byte-string length") from exc
            if length < 0:
                raise BencodeError("negative byte-string length")
            index = colon + 1
            end = index + length
            if end > len(data):
                raise BencodeError("truncated byte string")
            value = data[index:end]
            index = end
            return value
        raise BencodeError("unknown bencode token")

    value = parse()
    if index != len(data):
        raise BencodeError("trailing bencoded data")
    return value


def _text(value: Any, field: str) -> str:
    if not isinstance(value, bytes):
        raise BencodeError(f"{field} is missing or invalid")
    return value.decode("utf-8", errors="replace")


def _safe_path_part(value: str, field: str) -> str:
    if (not value or value in {".", ".."} or "\x00" in value or
            "/" in value or "\\" in value):
        raise BencodeError(f"{field} contains an unsafe path component")
    return value


def inspect_torrent(torrent_path: Path) -> dict[str, Any]:
    """Return safe display metadata for a single- or multi-file torrent."""
    raw = torrent_path.read_bytes()
    if not raw:
        raise BencodeError("torrent file is empty")
    if len(raw) > MAX_TORRENT_BYTES:
        raise BencodeError(f"torrent file exceeds {MAX_TORRENT_BYTES} byte limit")
    root = _decode_bencode(raw)
    if not isinstance(root, dict):
        raise BencodeError("torrent root must be a dictionary")
    info = root.get(b"info")
    if not isinstance(info, dict):
        raise BencodeError("torrent has no info dictionary")

    name = _safe_path_part(_text(info.get(b"name"), "info.name"), "info.name")
    files: list[dict[str, Any]] = []
    if b"files" in info:
        raw_files = info[b"files"]
        if not isinstance(raw_files, list) or not raw_files:
            raise BencodeError("info.files is invalid")
        for entry in raw_files:
            if not isinstance(entry, dict) or not isinstance(entry.get(b"length"), int):
                raise BencodeError("torrent contains an invalid file entry")
            parts = entry.get(b"path")
            if not isinstance(parts, list) or not parts:
                raise BencodeError("torrent file entry has no path")
            clean_parts = [
                _safe_path_part(_text(part, "file path"), "file path")
                for part in parts
            ]
            files.append({
                "index": len(files) + 1,
                "path": "/".join(clean_parts),
                "length": entry[b"length"],
            })
    else:
        length = info.get(b"length")
        if not isinstance(length, int):
            raise BencodeError("single-file torrent has no valid length")
        files.append({"index": 1, "path": name, "length": length})

    metadata = {
        "name": name,
        "file_count": len(files),
        "total_bytes": sum(max(0, item["length"]) for item in files),
        "files": files,
    }
    selected = select_torrent_video(metadata)
    metadata["selected_video"] = selected
    return metadata


def select_torrent_video(metadata: dict[str, Any]) -> dict[str, Any]:
    """Return the largest supported video manifest entry with safe size bounds."""
    candidates = [
        item for item in metadata["files"]
        if Path(item["path"]).suffix.lower() in VIDEO_EXTENSIONS and item["length"] > 0
    ]
    if not candidates:
        wanted = ", ".join(sorted(VIDEO_EXTENSIONS))
        raise BencodeError(f"torrent has no supported video file ({wanted})")
    selected = max(candidates, key=lambda item: (item["length"], item["path"]))
    if selected["length"] > MAX_VIDEO_BYTES:
        raise BencodeError(
            f"selected video exceeds {MAX_VIDEO_BYTES} byte Stage A safety limit"
        )
    return selected


def select_video(root: Path) -> Path:
    """Choose the largest regular video file under a completed download root."""
    candidates = []
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in VIDEO_EXTENSIONS:
            continue
        candidates.append((path.stat().st_size, path))
    if not candidates:
        wanted = ", ".join(sorted(VIDEO_EXTENSIONS))
        raise FileNotFoundError(f"torrent completed without a supported video file ({wanted})")
    candidates.sort(key=lambda item: (item[0], str(item[1])), reverse=True)
    return candidates[0][1]


def main() -> None:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    inspect_parser = sub.add_parser("inspect", help="print safe torrent metadata as JSON")
    inspect_parser.add_argument("torrent", type=Path)
    select_parser = sub.add_parser("select-video", help="print the largest downloaded video path")
    select_parser.add_argument("directory", type=Path)
    index_parser = sub.add_parser("select-index", help="print selected manifest file index")
    index_parser.add_argument("torrent", type=Path)
    args = parser.parse_args()

    try:
        if args.command == "inspect":
            print(json.dumps(inspect_torrent(args.torrent), ensure_ascii=False, indent=2))
        elif args.command == "select-index":
            metadata = inspect_torrent(args.torrent)
            print(metadata["selected_video"]["index"])
        else:
            print(select_video(args.directory))
    except (BencodeError, FileNotFoundError, OSError) as exc:
        print(f"torrent source error: {exc}", file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    main()
