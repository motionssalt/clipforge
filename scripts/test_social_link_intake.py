#!/usr/bin/env python3
"""Deterministic contract checks for YouTube-only source intake."""
from __future__ import annotations

import importlib.util
import os
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('download_drive', ROOT / 'scripts' / 'download_drive.py')
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


def test_youtube_only_host_policy() -> None:
    assert module.youtube_host('https://www.youtube.com/watch?v=abc') == 'youtube.com'
    assert module.youtube_host('https://youtu.be/abc') == 'youtu.be'
    assert module.youtube_host('https://notyoutube.com/watch?v=abc') is None
    assert module.youtube_host('ftp://youtube.com/a') is None
    disabled = {
        'https://www.tiktok.com/@creator/video/123': 'tiktok.com',
        'https://www.instagram.com/reel/abc/': 'instagram.com',
        'https://www.facebook.com/reel/123': 'facebook.com',
        'https://x.com/creator/status/123': 'x.com',
        'https://vimeo.com/123': 'vimeo.com',
        'https://www.reddit.com/r/example/comments/abc/video/': 'reddit.com',
    }
    for url, expected in disabled.items():
        assert module.removed_social_host(url) == expected, url
    assert module.removed_social_host('https://instagram.com.evil.example/reel/a') is None


def test_stage_a_installs_authenticated_youtube_runtime() -> None:
    requirements = (ROOT / 'scripts' / 'requirements.txt').read_text(encoding='utf-8')
    workflow = (ROOT / '.github' / 'workflows' / 'stage-a.yml').read_text(encoding='utf-8')
    assert 'yt-dlp[default,curl-cffi]' in requirements
    assert 'bgutil-ytdlp-pot-provider' not in requirements
    assert 'actions/setup-node@v4' in workflow
    assert 'node-version: "22"' in workflow
    assert 'CLIPFORGE_YOUTUBE_COOKIES: ${{ secrets.CLIPFORGE_YOUTUBE_COOKIES }}' in workflow
    assert 'mktemp "$RUNNER_TEMP/clipforge-youtube-cookies.XXXXXX"' in workflow
    assert 'rm -f "$cookie_file"' in workflow
    assert 'Build local YouTube public-token provider' not in workflow


def test_cookie_file_is_opt_in_and_bounded() -> None:
    with patch.dict(os.environ, {}, clear=True):
        assert module.youtube_cookie_arguments() == []
    with tempfile.NamedTemporaryFile() as handle:
        handle.write(b'# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate\n')
        handle.flush()
        with patch.dict(os.environ, {'CLIPFORGE_YOUTUBE_COOKIES_FILE': handle.name}, clear=True):
            assert module.youtube_cookie_arguments() == ['--cookies', handle.name]
    with tempfile.NamedTemporaryFile() as handle:
        handle.write(b'x' * (module.MAX_YOUTUBE_COOKIE_FILE_BYTES + 1))
        handle.flush()
        with patch.dict(os.environ, {'CLIPFORGE_YOUTUBE_COOKIES_FILE': handle.name}, clear=True):
            try:
                module.youtube_cookie_arguments()
            except RuntimeError as error:
                assert 'safety limit' in str(error)
            else:
                raise AssertionError('oversized cookie file must fail closed')


def test_youtube_command_uses_cookie_and_best_streams() -> None:
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'final.mp4'
        cookie = Path(temp) / 'cookies.txt'
        cookie.write_text('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tprivate\n', encoding='utf-8')
        calls: list[list[str]] = []

        def fake_run(command: list[str], check: bool, timeout: int) -> None:
            calls.append(command)
            template = command[command.index('-o') + 1]
            Path(template.replace('%(ext)s', 'mp4')).write_bytes(b'video')

        with patch.dict(os.environ, {'CLIPFORGE_YOUTUBE_COOKIES_FILE': str(cookie)}, clear=False):
            with patch.object(module.subprocess, 'run', fake_run):
                module.download_youtube('https://www.youtube.com/watch?v=abc', str(output), 'youtube.com')
        command = calls[0]
        assert output.read_bytes() == b'video'
        assert '--no-config' in command and '--no-playlist' in command and '--no-keep-video' in command
        assert command[command.index('--cookies') + 1] == str(cookie)
        assert command[command.index('--extractor-args') + 1] == 'youtube:player_client=web_embedded'
        assert command[command.index('--format') + 1] == 'bv*+ba/b'
        assert command[-1] == 'https://www.youtube.com/watch?v=abc'


def test_youtube_falls_back_to_second_public_client() -> None:
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'final.mp4'
        clients: list[str] = []

        def fake_run(command: list[str], check: bool, timeout: int) -> None:
            client = command[command.index('--extractor-args') + 1]
            clients.append(client)
            if client.endswith('web_embedded'):
                raise subprocess.CalledProcessError(1, command)
            template = command[command.index('-o') + 1]
            Path(template.replace('%(ext)s', 'mp4')).write_bytes(b'video')

        with patch.dict(os.environ, {}, clear=True):
            with patch.object(module.subprocess, 'run', fake_run):
                module.download_youtube('https://youtu.be/abc', str(output), 'youtu.be')
        assert output.read_bytes() == b'video'
        assert clients == ['youtube:player_client=web_embedded', 'youtube:player_client=android_vr']


def main() -> None:
    test_youtube_only_host_policy()
    test_stage_a_installs_authenticated_youtube_runtime()
    test_cookie_file_is_opt_in_and_bounded()
    test_youtube_command_uses_cookie_and_best_streams()
    test_youtube_falls_back_to_second_public_client()
    print('YouTube-only intake tests passed')


if __name__ == '__main__':
    main()
