#!/usr/bin/env python3
"""
Download a video file to a local path from either:

  A) A public Google Drive share link / file id, e.g.:
       - https://drive.google.com/file/d/<FILE_ID>/view?usp=sharing
       - https://drive.google.com/open?id=<FILE_ID>
       - https://drive.google.com/uc?id=<FILE_ID>&export=download
       - Raw file id
       - Any URL containing id=<FILE_ID>

     Drive inputs keep the original behavior: the file id is extracted and
     downloaded via Drive's uc?export=download endpoint, including the
     "confirm token" interstitial that Drive shows for large files.

  B) ANY other direct download URL (raw GitHub file URL, a plain
     .mp4/.mkv/.webm link on any host, etc.). Non-Drive input is treated
     as a direct URL and streamed as-is — no Drive-only restriction.

Basic validation is kept for genuinely undownloadable input: HTTP errors
(404 etc.) fail loudly, and an HTML/error-page response instead of actual
file bytes is rejected (the caller separately verifies the bytes are a
video container).

Usage:
    python download_drive.py <drive_link_or_id_or_direct_url> <output_path>
"""
import os
import re
import sys
import time
import shutil
import subprocess
import tempfile
import urllib.parse

import requests


CHUNK_SIZE = 1024 * 1024  # 1 MiB
REQUEST_TIMEOUT = (30, 60)  # (connect, read) seconds
MAX_SOCIAL_MEDIA_BYTES = 5 * 1024 * 1024 * 1024
SOCIAL_HOSTS = {
    'youtube.com', 'youtu.be', 'youtube-nocookie.com',
    'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
    'instagram.com', 'facebook.com', 'fb.watch',
    'x.com', 'twitter.com', 'vimeo.com', 'reddit.com', 'redd.it',
}


def extract_file_id(link: str) -> str:
    """Return the Drive file id if `link` is a recognizable Drive link / id,
    else raise ValueError."""
    link = link.strip()
    if not link:
        raise ValueError("Empty drive link")

    # Bare id (no slashes / no url)
    if "/" not in link and "?" not in link and " " not in link and len(link) >= 20:
        return link

    # /file/d/<ID>/
    m = re.search(r"/file/d/([a-zA-Z0-9_-]+)", link)
    if m:
        return m.group(1)

    # id=<ID>
    m = re.search(r"[?&]id=([a-zA-Z0-9_-]+)", link)
    if m:
        return m.group(1)

    # /d/<ID>
    m = re.search(r"/d/([a-zA-Z0-9_-]+)", link)
    if m:
        return m.group(1)

    raise ValueError(f"Could not extract Google Drive file id from: {link}")


def _stream_to_file(resp, output_path: str, label: str) -> None:
    """Stream an open requests response to disk with progress logging."""
    total = int(resp.headers.get("Content-Length", 0))
    ct = resp.headers.get("Content-Type", "")
    print(f"Downloading {label} content-type={ct} size={total} bytes", flush=True)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or ".", exist_ok=True)
    written = 0
    last_report = time.time()
    with open(output_path, "wb") as f:
        for chunk in resp.iter_content(CHUNK_SIZE):
            if not chunk:
                continue
            f.write(chunk)
            written += len(chunk)
            now = time.time()
            if now - last_report >= 5:
                if total:
                    pct = written * 100.0 / total
                    print(f"  ...{written / 1e6:.1f} MB / {total / 1e6:.1f} MB ({pct:.1f}%)", flush=True)
                else:
                    print(f"  ...{written / 1e6:.1f} MB", flush=True)
                last_report = now

    if written == 0:
        raise RuntimeError("Downloaded 0 bytes — download failed.")

    print(f"Done. Wrote {written} bytes to {output_path}", flush=True)


def download(file_id: str, output_path: str) -> None:
    """Google Drive download flow (file id + confirm-token handling)."""
    base_url = "https://docs.google.com/uc?export=download"
    session = requests.Session()

    # First request — may return the file directly OR a "confirm token" page.
    resp = session.get(base_url, params={"id": file_id}, stream=True, allow_redirects=True)
    resp.raise_for_status()

    token = None
    for k, v in resp.cookies.items():
        if k.startswith("download_warning"):
            token = v
            break

    # Some newer responses embed a confirm token in the HTML body instead of a cookie.
    if token is None:
        ct = resp.headers.get("Content-Type", "")
        if "text/html" in ct:
            body = resp.text
            m = re.search(r'name="confirm"\s+value="([^"]+)"', body)
            if m:
                token = m.group(1)
            else:
                m = re.search(r"confirm=([0-9A-Za-z_-]+)", body)
                if m:
                    token = m.group(1)

    if token:
        params = {"id": file_id, "confirm": token, "export": "download"}
        resp = session.get(base_url, params=params, stream=True, allow_redirects=True)
        resp.raise_for_status()

    ct = resp.headers.get("Content-Type", "")
    if "text/html" in ct:
        # Still HTML — try the alternate host used for very large files.
        alt_url = "https://drive.usercontent.google.com/download"
        params = {"id": file_id, "export": "download", "confirm": token or "t"}
        resp = session.get(alt_url, params=params, stream=True, allow_redirects=True)
        resp.raise_for_status()
        ct = resp.headers.get("Content-Type", "")
        if "text/html" in ct:
            raise RuntimeError(
                "Google Drive returned HTML instead of a file — the link may not be "
                "publicly shared, may require sign-in, or the file is too large / rate limited."
            )

    _stream_to_file(resp, output_path, f"file id={file_id}")


def social_host(url: str) -> str | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {'http', 'https'}:
        return None
    host = (parsed.hostname or '').lower().rstrip('.')
    for allowed in SOCIAL_HOSTS:
        if host == allowed or host.endswith(f'.{allowed}'):
            return allowed
    return None


def download_social(url: str, output_path: str, host: str) -> None:
    """Download one public social video without cookies, playlists, or shell parsing."""
    output_dir = tempfile.mkdtemp(prefix='clipforge-social-')
    template = os.path.join(output_dir, 'source.%(ext)s')
    command = [
        sys.executable, '-m', 'yt_dlp', '--no-config', '--no-playlist',
        '--abort-on-error', '--no-warnings', '--restrict-filenames',
        '--retries', '3', '--socket-timeout', '60', '--max-filesize', str(MAX_SOCIAL_MEDIA_BYTES),
        '--format', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', template, '--', url,
    ]
    try:
        print(f'Downloading one public {host} video with yt-dlp (no login or cookies).', flush=True)
        subprocess.run(command, check=True, timeout=45 * 60)
        files = [entry for entry in os.scandir(output_dir) if entry.is_file() and entry.stat().st_size > 0]
        if len(files) != 1:
            raise RuntimeError(f'Expected exactly one downloaded media file, found {len(files)}.')
        os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
        shutil.move(files[0].path, output_path)
        print(f'Done. Wrote public {host} video to {output_path}', flush=True)
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError('Social-video download exceeded the 45-minute safety limit.') from exc
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f'Could not download this public {host} video. It may be private, unavailable, region-restricted, or currently unsupported by the source platform.') from exc
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


def download_direct(url: str, output_path: str) -> None:
    """Plain direct-URL download for any non-Drive link."""
    session = requests.Session()
    headers = {
        # Some hosts reject the default python-requests UA.
        "User-Agent": "Mozilla/5.0 (compatible; clipforge-downloader/1.0)",
        "Accept": "*/*",
    }
    resp = session.get(url, headers=headers, stream=True, allow_redirects=True,
                       timeout=REQUEST_TIMEOUT)
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        raise RuntimeError(
            f"Direct download failed: {url} returned HTTP "
            f"{e.response.status_code if e.response is not None else 'error'} "
            f"— check that the URL is correct and publicly accessible."
        )

    ct = resp.headers.get("Content-Type", "").lower()
    # Reject obvious HTML/error pages — the URL did not resolve to a file.
    # (Content type alone doesn't prove it's a video; the caller sniffs the
    # actual bytes afterwards, so octet-stream / missing types are fine.)
    if "text/html" in ct or ct.startswith("text/"):
        raise RuntimeError(
            f"The URL returned {ct or 'a text response'} instead of a file — "
            "this does not look like a direct video download link."
        )

    _stream_to_file(resp, output_path, f"url={url}")


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: download_drive.py <drive_link_or_id_or_direct_url> <output_path>",
              file=sys.stderr)
        sys.exit(2)

    raw = sys.argv[1]
    out = sys.argv[2]

    # Support percent-encoded input from workflow_dispatch.
    if "%" in raw and "http" in raw:
        raw = urllib.parse.unquote(raw)

    # Drive link / file id? Keep the original Drive behavior. Otherwise treat
    # the input as a plain direct download URL.
    file_id = None
    try:
        file_id = extract_file_id(raw)
    except ValueError:
        file_id = None

    if file_id:
        print(f"Detected Google Drive input. Extracted file id: {file_id}", flush=True)
        download(file_id, out)
        return

    if raw.lower().startswith(("http://", "https://")):
        host = social_host(raw)
        if host:
            download_social(raw, out, host)
            return
        print("Not a Google Drive or recognised social link — treating as a direct download URL.", flush=True)
        download_direct(raw, out)
        return

    # Neither a Drive link/id nor a usable URL — this is genuinely bad input.
    print(
        f"Could not handle input: {raw}\n"
        "Provide a public Google Drive share link, a Drive file id, or a "
        "direct http(s) URL to the video file.",
        file=sys.stderr,
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
