#!/usr/bin/env python3
"""
Download a public Google Drive file to a local path.

Handles the standard public-share URL shapes:
  - https://drive.google.com/file/d/<FILE_ID>/view?usp=sharing
  - https://drive.google.com/open?id=<FILE_ID>
  - https://drive.google.com/uc?id=<FILE_ID>&export=download
  - Raw file id
  - Any URL containing id=<FILE_ID>

Handles the "confirm token" interstitial that Drive shows for large files
by re-issuing the request with the confirmation cookie/token.

Usage:
    python download_drive.py <drive_link_or_id> <output_path>
"""
import os
import re
import sys
import time
import urllib.parse

import requests


CHUNK_SIZE = 1024 * 1024  # 1 MiB


def extract_file_id(link: str) -> str:
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


def download(file_id: str, output_path: str) -> None:
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

    total = int(resp.headers.get("Content-Length", 0))
    print(f"Downloading file id={file_id} content-type={ct} size={total} bytes", flush=True)

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


def main() -> None:
    if len(sys.argv) != 3:
        print("Usage: download_drive.py <drive_link_or_id> <output_path>", file=sys.stderr)
        sys.exit(2)

    raw = sys.argv[1]
    out = sys.argv[2]

    # Support percent-encoded input from workflow_dispatch.
    if "%" in raw and "http" in raw:
        raw = urllib.parse.unquote(raw)

    file_id = extract_file_id(raw)
    print(f"Extracted file id: {file_id}", flush=True)
    download(file_id, out)


if __name__ == "__main__":
    main()
