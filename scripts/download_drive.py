#!/usr/bin/env python3
"""Download a source video from a supported public ClipForge input.

Supported inputs are:

  A) A public Google Drive share link or file id. Drive inputs retain the
     original confirm-token download behavior for large public files.

  B) A public Telegram channel post containing a video, in the form
     https://t.me/<public_channel>/<message_id>. The downloader intentionally
     accepts only public channel-post links; private invites, private channels,
     groups, bots, and arbitrary Telegram pages fail closed.

  C) A direct public video-file URL. Magnet URIs and uploaded torrent manifests
     are handled by the surrounding Stage A workflow rather than this script.

YouTube, TikTok, Instagram, Facebook, X/Twitter, Vimeo, and Reddit page links
are deliberately disabled. To process a video from one of those services,
forward or upload it to a public Telegram channel, then use that public post
link. For large Telegram media that public web pages do not expose, the script may
use a dedicated user-authorized MTProto session supplied only through encrypted
GitHub Actions environment secrets. No credential values are committed, logged,
or persisted by the downloader.

Usage:
    python download_drive.py <drive_link_or_telegram_post_or_direct_url> <output_path>
"""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse

import requests


CHUNK_SIZE = 1024 * 1024  # 1 MiB
REQUEST_TIMEOUT = (30, 60)  # (connect, read) seconds
MAX_TELEGRAM_MEDIA_BYTES = 5 * 1024 * 1024 * 1024
TELEGRAM_PUBLIC_HOSTS = ('t.me', 'telegram.me')
DISABLED_SOCIAL_HOSTS = (
    'youtube-nocookie.com', 'youtu.be', 'youtube.com',
    'vm.tiktok.com', 'vt.tiktok.com', 'tiktok.com',
    'fb.watch', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
    'vimeo.com', 'redd.it', 'reddit.com',
)
PUBLIC_CHANNEL_RE = re.compile(r'^[A-Za-z0-9_]{5,64}$')


def extract_file_id(link: str) -> str:
    """Return a Drive file id for a recognizable Drive link or id."""
    link = link.strip()
    if not link:
        raise ValueError('Empty drive link')
    if '/' not in link and '?' not in link and ' ' not in link and len(link) >= 20:
        return link
    for pattern in (r'/file/d/([a-zA-Z0-9_-]+)', r'[?&]id=([a-zA-Z0-9_-]+)', r'/d/([a-zA-Z0-9_-]+)'):
        match = re.search(pattern, link)
        if match:
            return match.group(1)
    raise ValueError(f'Could not extract Google Drive file id from: {link}')


def _stream_to_file(resp: requests.Response, output_path: str, label: str) -> None:
    """Stream an open response to disk with bounded progress logging."""
    total = int(resp.headers.get('Content-Length', 0))
    content_type = resp.headers.get('Content-Type', '')
    print(f'Downloading {label} content-type={content_type} size={total} bytes', flush=True)
    os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
    written = 0
    last_report = time.time()
    with open(output_path, 'wb') as handle:
        for chunk in resp.iter_content(CHUNK_SIZE):
            if not chunk:
                continue
            handle.write(chunk)
            written += len(chunk)
            now = time.time()
            if now - last_report >= 5:
                if total:
                    print(f'  ...{written / 1e6:.1f} MB / {total / 1e6:.1f} MB ({written * 100.0 / total:.1f}%)', flush=True)
                else:
                    print(f'  ...{written / 1e6:.1f} MB', flush=True)
                last_report = now
    if written == 0:
        raise RuntimeError('Downloaded 0 bytes — download failed.')
    print(f'Done. Wrote {written} bytes to {output_path}', flush=True)


def download_drive(file_id: str, output_path: str) -> None:
    """Download a public Drive item with Google confirm-token handling."""
    base_url = 'https://docs.google.com/uc?export=download'
    session = requests.Session()
    response = session.get(base_url, params={'id': file_id}, stream=True, allow_redirects=True, timeout=REQUEST_TIMEOUT)
    response.raise_for_status()
    token = next((value for name, value in response.cookies.items() if name.startswith('download_warning')), None)
    if token is None and 'text/html' in response.headers.get('Content-Type', ''):
        body = response.text
        match = re.search(r'name="confirm"\s+value="([^"]+)"', body) or re.search(r'confirm=([0-9A-Za-z_-]+)', body)
        if match:
            token = match.group(1)
    if token:
        response = session.get(base_url, params={'id': file_id, 'confirm': token, 'export': 'download'}, stream=True, allow_redirects=True, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
    if 'text/html' in response.headers.get('Content-Type', ''):
        response = session.get('https://drive.usercontent.google.com/download', params={'id': file_id, 'export': 'download', 'confirm': token or 't'}, stream=True, allow_redirects=True, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        if 'text/html' in response.headers.get('Content-Type', ''):
            raise RuntimeError('Google Drive returned HTML instead of a file — the link may not be publicly shared, may require sign-in, or may be rate limited.')
    _stream_to_file(response, output_path, f'Drive file id={file_id}')


def recognised_host(url: str, allowed_hosts: tuple[str, ...]) -> str | None:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in {'http', 'https'}:
        return None
    host = (parsed.hostname or '').lower().rstrip('.')
    for allowed in allowed_hosts:
        if host == allowed or host.endswith(f'.{allowed}'):
            return allowed
    return None


def telegram_public_post_url(url: str) -> str | None:
    """Return canonical public Telegram channel post URL or None.

    Supported copied links are t.me/<channel>/<id> and t.me/s/<channel>/<id>.
    Private links (/c/, +invite, joinchat) and non-post links are rejected rather
    than accidentally treating a web page as a media file.
    """
    if not recognised_host(url, TELEGRAM_PUBLIC_HOSTS):
        return None
    parsed = urllib.parse.urlparse(url)
    parts = [part for part in parsed.path.split('/') if part]
    if parts[:1] == ['s']:
        parts = parts[1:]
    if len(parts) != 2:
        return None
    channel, message_id = parts
    if not PUBLIC_CHANNEL_RE.fullmatch(channel) or not message_id.isdecimal() or int(message_id) < 1:
        return None
    return f'https://t.me/{channel}/{int(message_id)}'


def disabled_social_host(url: str) -> str | None:
    return recognised_host(url, DISABLED_SOCIAL_HOSTS)


def _clear_directory(directory: str) -> None:
    for entry in os.scandir(directory):
        if entry.is_file() or entry.is_symlink():
            os.unlink(entry.path)
        elif entry.is_dir():
            shutil.rmtree(entry.path)


def mtproto_credentials_available() -> bool:
    return all(os.environ.get(name, '').strip() for name in (
        'CLIPFORGE_TELEGRAM_API_ID', 'CLIPFORGE_TELEGRAM_API_HASH', 'CLIPFORGE_TELEGRAM_SESSION',
    ))


async def _download_telegram_mtproto(url: str, output_path: str) -> None:
    """Download a public channel post via the dedicated authenticated session."""
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession
    except ImportError as error:
        raise RuntimeError('Telegram MTProto support is unavailable on this runner.') from error
    canonical = telegram_public_post_url(url)
    if not canonical:
        raise RuntimeError('Telegram MTProto intake requires a public channel post link.')
    _, channel, message_id = urllib.parse.urlparse(canonical).path.split('/')
    api_id = int(os.environ['CLIPFORGE_TELEGRAM_API_ID'])
    api_hash = os.environ['CLIPFORGE_TELEGRAM_API_HASH']
    session = os.environ['CLIPFORGE_TELEGRAM_SESSION']
    client = TelegramClient(
        StringSession(session), api_id, api_hash,
        connection_retries=3, request_retries=3, retry_delay=1,
    )
    try:
        await client.connect()
        if not await client.is_user_authorized():
            raise RuntimeError('The dedicated Telegram media session is no longer authorized. Re-authorize it in ClipForge settings.')
        entity = await client.get_entity(channel)
        if not getattr(entity, 'broadcast', False) or getattr(entity, 'megagroup', False):
            raise RuntimeError('This is a public Telegram group link. ClipForge downloads social video only from a public Telegram channel post. Create a public channel—not a group—forward or upload the video there, then send that channel post link.')
        message = await client.get_messages(entity, ids=int(message_id))
        if not message or not message.media:
            raise RuntimeError('This public Telegram channel post has no media attachment.')
        mime_type = str(getattr(getattr(message, 'file', None), 'mime_type', '') or '').lower()
        if not getattr(message, 'video', None) and not mime_type.startswith('video/'):
            raise RuntimeError('This public Telegram channel post does not contain a video attachment.')
        media_size = int(getattr(getattr(message, 'file', None), 'size', 0) or 0)
        if media_size and media_size > MAX_TELEGRAM_MEDIA_BYTES:
            raise RuntimeError(f'Telegram media exceeds the {MAX_TELEGRAM_MEDIA_BYTES // (1024 ** 3)} GiB Stage A safety limit.')
        print('Downloading one public Telegram channel-post video through the dedicated authenticated media session.', flush=True)
        os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
        written_path = await asyncio.wait_for(client.download_media(message, file=output_path), timeout=45 * 60)
        if not written_path or not os.path.isfile(output_path) or os.path.getsize(output_path) <= 0:
            raise RuntimeError('Telegram authenticated media retrieval completed without a video file.')
        if os.path.getsize(output_path) > MAX_TELEGRAM_MEDIA_BYTES:
            os.unlink(output_path)
            raise RuntimeError(f'Telegram media exceeds the {MAX_TELEGRAM_MEDIA_BYTES // (1024 ** 3)} GiB Stage A safety limit.')
        print(f'Done. Wrote authenticated public Telegram post video to {output_path}.', flush=True)
    except asyncio.TimeoutError as error:
        if os.path.exists(output_path):
            os.unlink(output_path)
        raise RuntimeError('Telegram authenticated media download exceeded the 45-minute safety limit.') from error
    finally:
        await client.disconnect()


def download_telegram_mtproto(url: str, output_path: str) -> None:
    try:
        asyncio.run(_download_telegram_mtproto(url, output_path))
    except ValueError as error:
        raise RuntimeError('The configured Telegram API ID is invalid.') from error


def telegram_no_media_error(url: str) -> str:
    """Explain the common public-group case without relying on account access."""
    try:
        response = requests.get(url, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; clipforge-downloader/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
        }, timeout=REQUEST_TIMEOUT)
        page = response.text.lower() if response.ok else ''
    except requests.RequestException:
        page = ''
    if 'view in group' in page:
        return ('This is a public Telegram group post, not a public channel post. '
                'Telegram does not expose a downloadable media file for this group link. '
                'Create a public channel (not a group), forward or upload the video there, '
                'then send its exact https://t.me/<channel>/<message_id> post link.')
    return ('Telegram did not expose one downloadable video for this public post. '
            'Use a public channel (not a group), make sure the post visibly contains one video, '
            'and send that exact post link.')


def download_telegram_public_post(url: str, output_path: str) -> None:
    """Download one public Telegram post video without any account session."""
    output_dir = tempfile.mkdtemp(prefix='clipforge-telegram-post-')
    template = os.path.join(output_dir, 'source.%(ext)s')
    command = [
        sys.executable, '-m', 'yt_dlp', '--no-config', '--no-playlist',
        '--abort-on-error', '--no-warnings', '--restrict-filenames', '--no-keep-video',
        '--retries', '3', '--socket-timeout', '60', '--max-filesize', str(MAX_TELEGRAM_MEDIA_BYTES),
        '--format', 'bv*+ba/b', '--merge-output-format', 'mp4', '-o', template, '--', url,
    ]
    try:
        print('Downloading one public Telegram channel-post video with yt-dlp (no account login or cookies).', flush=True)
        try:
            subprocess.run(command, check=True, timeout=45 * 60)
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError('Telegram public-post download exceeded the 45-minute safety limit.') from exc
        except subprocess.CalledProcessError as exc:
            raise RuntimeError('Telegram could not provide a downloadable public video from this post. Confirm the channel and post are public and that the post contains a video, then try again.') from exc
        files = [entry for entry in os.scandir(output_dir) if entry.is_file() and entry.stat().st_size > 0]
        if len(files) != 1:
            if not files:
                raise RuntimeError(telegram_no_media_error(url))
            names = ', '.join(sorted(entry.name for entry in files))
            raise RuntimeError(f'Telegram post produced multiple final media files ({names}); send a post containing exactly one video.')
        os.makedirs(os.path.dirname(os.path.abspath(output_path)) or '.', exist_ok=True)
        shutil.move(files[0].path, output_path)
        print(f'Done. Wrote public Telegram post video to {output_path}.', flush=True)
    finally:
        shutil.rmtree(output_dir, ignore_errors=True)


def download_direct(url: str, output_path: str) -> None:
    """Download an ordinary direct public file URL."""
    response = requests.get(url, headers={
        'User-Agent': 'Mozilla/5.0 (compatible; clipforge-downloader/1.0)',
        'Accept': '*/*',
    }, stream=True, allow_redirects=True, timeout=REQUEST_TIMEOUT)
    try:
        response.raise_for_status()
    except requests.HTTPError as error:
        raise RuntimeError(f'Direct download failed: {url} returned HTTP {error.response.status_code if error.response is not None else "error"} — check that the URL is correct and publicly accessible.')
    content_type = response.headers.get('Content-Type', '').lower()
    if 'text/html' in content_type or content_type.startswith('text/'):
        raise RuntimeError(f'The URL returned {content_type or "a text response"} instead of a file — this does not look like a direct video download link.')
    _stream_to_file(response, output_path, f'URL={url}')


def main() -> None:
    if len(sys.argv) != 3:
        print('Usage: download_drive.py <drive_link_or_telegram_post_or_direct_url> <output_path>', file=sys.stderr)
        sys.exit(2)
    raw = sys.argv[1]
    output_path = sys.argv[2]
    if '%' in raw and 'http' in raw:
        raw = urllib.parse.unquote(raw)
    try:
        file_id = extract_file_id(raw)
    except ValueError:
        file_id = None
    if file_id:
        print(f'Detected Google Drive input. Extracted file id: {file_id}', flush=True)
        download_drive(file_id, output_path)
        return
    if raw.lower().startswith(('http://', 'https://')):
            telegram_post = telegram_public_post_url(raw)
    if telegram_post:
        if mtproto_credentials_available():
            download_telegram_mtproto(telegram_post, output_path)
        else:
            download_telegram_public_post(telegram_post, output_path)
        return

        disabled = disabled_social_host(raw)
        if disabled:
            raise RuntimeError(f'{disabled} social links are disabled. Forward or upload the video to a public Telegram channel, then use its public post link instead.')
        if recognised_host(raw, TELEGRAM_PUBLIC_HOSTS):
            raise RuntimeError('Use a public Telegram channel post link in the form https://t.me/<channel>/<message_id>. Private and non-post Telegram links are not supported.')
        print('Not a Google Drive or public Telegram post link — treating as a direct download URL.', flush=True)
        download_direct(raw, output_path)
        return
    print('Provide a public Google Drive share link, a Drive file id, a public Telegram channel-post link, or a direct http(s) URL to a video file.', file=sys.stderr)
    sys.exit(2)


if __name__ == '__main__':
    main()
