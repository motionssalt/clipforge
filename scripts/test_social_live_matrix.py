#!/usr/bin/env python3
"""Manual live verification for ClipForge's public social-video intake.

This is intentionally not part of the offline unit suite. It calls the exact
Stage A downloader once per supported platform using maintained public
extractor fixtures, applies a strict per-platform timeout, validates the
result with ffprobe, records no credentials, and removes all downloaded media.
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADER = ROOT / 'scripts' / 'download_drive.py'
RESULT_PATH = ROOT / 'work' / 'social_live_matrix_results.json'
PER_PLATFORM_TIMEOUT_SECONDS = 180

# Public single-video candidates from current yt-dlp extractor fixtures. They
# are verification probes only; each service can change public availability.
PLATFORMS = {
    'youtube': 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
    'tiktok': 'https://www.tiktok.com/@patroxofficial/video/6742501081818877190?langCountry=en',
    'instagram': 'https://www.instagram.com/reel/Chunk8-jurw/',
    'facebook': 'https://www.facebook.com/reel/1195289147628387',
    'x': 'https://x.com/MesoMax919/status/1575560063510810624',
    'vimeo': 'https://vimeo.com/76979871',
    'reddit': 'https://www.reddit.com/r/Unexpected/comments/1cl9h0u/the_insurance_claim_will_be_interesting/',
}


def ffprobe(path: Path) -> bool:
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', str(path)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=30,
    )
    try:
        return result.returncode == 0 and float(result.stdout.strip()) > 0
    except ValueError:
        return False


def main() -> None:
    results = []
    with tempfile.TemporaryDirectory(prefix='clipforge-social-live-') as temp:
        root = Path(temp)
        for platform, url in PLATFORMS.items():
            output = root / f'{platform}.media'
            started = time.monotonic()
            try:
                run = subprocess.run(
                    [sys.executable, str(DOWNLOADER), url, str(output)],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    timeout=PER_PLATFORM_TIMEOUT_SECONDS,
                )
                exists = output.is_file() and output.stat().st_size > 0
                playable = exists and ffprobe(output)
                result = {
                    'platform': platform,
                    'url': url,
                    'status': 'passed' if run.returncode == 0 and playable else 'failed',
                    'returncode': run.returncode,
                    'bytes': output.stat().st_size if exists else 0,
                    'playable': playable,
                    'seconds': round(time.monotonic() - started, 1),
                    'output_tail': run.stdout[-1200:],
                }
            except subprocess.TimeoutExpired as error:
                result = {
                    'platform': platform,
                    'url': url,
                    'status': 'timed_out',
                    'returncode': None,
                    'bytes': output.stat().st_size if output.is_file() else 0,
                    'playable': False,
                    'seconds': round(time.monotonic() - started, 1),
                    'output_tail': str(error.stdout or '')[-1200:],
                }
            print(f"{platform}: {result['status']} ({result['seconds']}s)", flush=True)
            results.append(result)
    RESULT_PATH.parent.mkdir(parents=True, exist_ok=True)
    RESULT_PATH.write_text(json.dumps(results, indent=2), encoding='utf-8')
    print(f'Results written to {RESULT_PATH}')
    if any(row['status'] != 'passed' for row in results):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
