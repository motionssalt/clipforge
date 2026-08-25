#!/usr/bin/env python3
"""
Download a video file to a local path from one of three public sources:

  A) A public Google Drive share link / file id, e.g.:
       - https://drive.google.com/file/d/<FILE_ID>/view?usp=sharing
       - https://drive.google.com/open?id=<FILE_ID>
       - https://drive.google.com/uc?id=<FILE_ID>&export=download
       - Raw file id
       - Any URL containing id=<FILE_ID>

     Drive inputs keep the original behavior: the file id is extracted and
     downloaded via Drive's uc?export=download endpoint, including the
     "confirm token" interstitial that Drive shows for large files.

  B) A public, single-video YouTube link from an explicitly recognised host.
     It is downloaded through yt-dlp without playlists. If the clone owner has
     explicitly configured a disposable-account export as an encrypted Actions
     secret, it is used only through a temporary workflow file. Other social
     platforms are intentionally not handled in this release.

  C) ANY other direct download URL (raw GitHub file URL, a plain
     .mp4/.mkv/.webm link on any host, etc.). Non-Drive input is treated
     as a direct URL and streamed as-is — no Drive-only restriction.

Basic validation is kept for genuinely undownloadable input: HTTP errors
(404 etc.) fail loudly, and an HTML/error-page response instead of actual
file bytes is rejected (the caller separately verifies the bytes are a
video container).

Usage:
    python download_drive.py <public_drive_link_or_id_social_or_direct_url> <output_path>
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
# YouTube is the only social platform currently enabled. Direct public media
# URLs remain supported separately, while removed social hosts fail closed so a
# platform page is never mistaken for a downloadable media file.
YOUTUBE_HOSTS = ('youtube-nocookie.com', 'youtu.be', 'youtube.com')
REMOVED_SOCIAL_HOSTS = (
    'vm.tiktok.com', 'vt.tiktok.com', 'tiktok.com', 'fb.watch',
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'vimeo.com',
    'redd.it', 'reddit.com',
)
YOUTUBE_PUBLIC_CLIENTS = ('web_embedded', 'android_vr')
MAX_YOUTUBE_COOKIE_FILE_BYTES = 256 * 1024


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


def recognised_host(url: str, allowed_hosts: tuple[str, ...]) -> str | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {'http', 'https'}:
        return None
    host = (parsed.hostname or '').lower().rstrip('.')
    for allowed in allowed_hosts:
        if host == allowed or host.endswith(f'.{allowed}'):
            return allowed
    return None


def youtube_host(url: str) -> str | None:
    return recognised_host(url, YOUTUBE_HOSTS)


def removed_social_host(url: str) -> str | None:
    return recognised_host(url, REMOVED_SOCIAL_HOSTS)


def youtube_cookie_arguments() -> list[str]:
    """Return a validated, secret-backed cookie file only when provisioned.

    The workflow writes the encrypted Actions secret to a mode-0600 temporary
    file for the duration of one source download. The file path is never logged,
    committed, released, or accepted from task input.
    """
    cookie_file = os.environ.get('CLIPFORGE_YOUTUBE_COOKIES_FILE', '').strip()
    if not cookie_file:
        return []
    if not os.path.isfile(cookie_file):
        raise RuntimeError('Configured YouTube cookie file is unavailable.')
    if not 0 < os.path.getsize(cookie_file) <= MAX_YOUTUBE_COOKIE_FILE_BYTES:
        raise RuntimeError('Configured YouTube cookie file is empty or exceeds the safety limit.')
    return ['--cookies', cookie_file]


def _clear_directory(directory: str) -> None:
    for entry in os.scandir(directory):
        if entry.is_file() or entry.is_symlink():
            os.unlink(entry.path)
        elif entry.is_dir():
            shutil.rmtree(entry.path)


def download_youtube(url: str, output_path: str, host: str) -> None:
    """Download one public YouTube video with bounded public client fallback.

    A user may deliberately configure a disposable-account cookie file through
    the encrypted Actions secret. When absent, the path remains public-only.
    The cookies are passed only to yt-dlp from the workflow's mode-0600
    temporary file and are never logged, committed, or accepted from users.
    """
    output_dir = tempfile.mkdtemp(prefix='clipforge-youtube-')
    template = os.path.join(output_dir, 'source.%(ext)s')
    cookie_args = youtube_cookie_arguments()
    last_error = None
    try:
        for client in YOUTUBE_PUBLIC_CLIENTS:
            _clear_directory(output_dir)
            command = [
                sys.executable, '-m', 'yt_dlp', '--no-config', '--no-playlist',
                '--abort-on-error', '--no-warnings', '--restrict-filenames', '--no-keep-video',
                '--retries', '3', '--socket-timeout', '60', '--max-filesize', str(MAX_SOCIAL_MEDIA_BYTES),
                '--js-runtimes', 'node', '--impersonate', 'chrome-131:macos-14',
                *cookie_args, '--extractor-args', f'youtube:player_client={client}',
                '--format', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', template, '--', url,
            ]
            try:
                auth_mode = 'authorized disposable-session cookies' if cookie_args else 'no login or cookies'
                print(f'Downloading one public {host} video with yt-dlp client {client} ({auth_mode}).', flush=True)
                subprocess.run(command, check=True, timeout=45 * 60)
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError('YouTube download exceeded the 45-minute safety limit.') from exc
            except subprocess.CalledProcessError as exc:
                last_error = exc
                print(f'Public YouTube client {client} was rejected; trying the next approved client.', flush=True)
                continue
            files = [entry for entry in os.scandir(output_dir) if entry.is_file() and entry.stat().st_size > 0]
            if len(files) != 1:
                names = ', '.join(sorted(entry.name for entry in files)) or 'none'
                last_error = RuntimeError(f'Expected exactly one final downloaded media file, found {len(files)}: {names}.')
                continue
            os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
            shutil.move(files[0].path, output_path)
            print(f'Done. Wrote public {host} video to {output_path} using {client}.', flush=True)
            return
        raise RuntimeError('YouTube rejected ClipForge’s approved playback clients. Try again later or use a direct public video file or Google Drive link.') from last_error
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
        host = youtube_host(raw)
        if host:
            download_youtube(raw, out, host)
            return
        disabled_host = removed_social_host(raw)
        if disabled_host:
            raise RuntimeError(f'{disabled_host} social links are temporarily disabled. ClipForge currently accepts YouTube social links only; use a direct public video file or Google Drive link instead.')
        print("Not a Google Drive or YouTube link — treating as a direct download URL.", flush=True)
        download_direct(raw, out)
        return

    # Neither a Drive link/id nor a usable URL — this is genuinely bad input.
    print(
        f"Could not handle input: {raw}\n"
        "Provide a public Google Drive share link, a Drive file id, a public YouTube link, or a "
        "direct http(s) URL to the video file.",
        file=sys.stderr,
    )
    sys.exit(2)


if __name__ == "__main__":
    main()
