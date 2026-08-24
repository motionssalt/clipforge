#!/usr/bin/env python3
"""Validate and expose a pre-dispatch Automatic Mode music choice.

The browser writes jobs/<job>/automatic_music.json before dispatching Stage A.
This script is deliberately narrow: it permits only an empty music reference,
a permanent audio-library path, or that same job's one-off music.mp3 path.
It prints GitHub Actions output only; it never logs file content or secrets.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path


LIBRARY_REF = re.compile(r"^path:audio-library/[A-Za-z0-9._-]+$")


def valid_music_ref(value: object, job_id: str) -> str:
    if value in (None, ""):
        return ""
    if not isinstance(value, str):
        raise ValueError("automatic music_ref must be a string")
    if LIBRARY_REF.fullmatch(value):
        return value
    if value == f"path:jobs/{job_id}/music.mp3":
        return value
    raise ValueError("automatic music_ref is not an allowed library or same-job one-off path")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("job_id")
    parser.add_argument("selection_path", type=Path)
    args = parser.parse_args()

    music_ref = ""
    source = "none"
    if args.selection_path.exists():
        data = json.loads(args.selection_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("version") != 1:
            raise ValueError("automatic music selection has an unsupported format")
        music_ref = valid_music_ref(data.get("music_ref"), args.job_id)
        raw_source = data.get("source")
        if isinstance(raw_source, str) and raw_source in {
            "explicit_library", "saved_library_default", "one_off_upload", "none"
        }:
            source = raw_source

    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write("music_ref=" + music_ref + "\n")
            handle.write("music_source=" + source + "\n")
    else:
        print(music_ref)


if __name__ == "__main__":
    main()
