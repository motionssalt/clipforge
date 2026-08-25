#!/usr/bin/env python3
"""Deterministic contract checks for Telegram-only social source intake."""
from __future__ import annotations

import importlib.util
import os
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('download_drive', ROOT / 'scripts' / 'download_drive.py')
module = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(module)


def test_public_telegram_post_policy() -> None:
    assert module.telegram_public_post_url('https://t.me/europa_press/613') == 'https://t.me/europa_press/613'
    assert module.telegram_public_post_url('https://telegram.me/europa_press/613?single') == 'https://t.me/europa_press/613'
    assert module.telegram_public_post_url('https://t.me/s/europa_press/613') == 'https://t.me/europa_press/613'
    invalid = [
        'https://t.me/c/123456/613',
        'https://t.me/+privateInvite',
        'https://t.me/joinchat/privateInvite',
        'https://t.me/europa_press',
        'https://t.me/europa_press/not-a-message',
        'https://t.me.evil.example/europa_press/613',
        'ftp://t.me/europa_press/613',
    ]
    for url in invalid:
        assert module.telegram_public_post_url(url) is None, url


def test_other_social_hosts_are_explicitly_disabled() -> None:
    cases = {
        'https://www.youtube.com/watch?v=abc': 'youtube.com',
        'https://www.tiktok.com/@creator/video/123': 'tiktok.com',
        'https://www.instagram.com/reel/abc/': 'instagram.com',
        'https://www.facebook.com/reel/123': 'facebook.com',
        'https://x.com/creator/status/123': 'x.com',
        'https://vimeo.com/123': 'vimeo.com',
        'https://www.reddit.com/r/example/comments/abc/video/': 'reddit.com',
    }
    for url, expected in cases.items():
        assert module.disabled_social_host(url) == expected, url
    assert module.disabled_social_host('https://instagram.com.evil.example/reel/a') is None


def test_stage_a_uses_no_social_session_or_youtube_runtime() -> None:
    requirements = (ROOT / 'scripts' / 'requirements.txt').read_text(encoding='utf-8')
    workflow = (ROOT / '.github' / 'workflows' / 'stage-a.yml').read_text(encoding='utf-8')
    assert 'yt-dlp[default]>=2026.1,<2027' in requirements
    assert 'curl-cffi' not in requirements
    assert 'CLIPFORGE_YOUTUBE_COOKIES' not in workflow
    assert 'clipforge-youtube-cookies' not in workflow
    assert 'actions/setup-node@v4' not in workflow
    assert 'Telegram public post' in workflow


def test_telegram_command_uses_best_streams_without_cookie_or_login() -> None:
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'final.mp4'
        calls: list[list[str]] = []

        def fake_run(command: list[str], check: bool, timeout: int) -> None:
            calls.append(command)
            template = command[command.index('-o') + 1]
            Path(template.replace('%(ext)s', 'mp4')).write_bytes(b'video')

        with patch.dict(os.environ, {'CLIPFORGE_YOUTUBE_COOKIES_FILE': '/not/used'}, clear=False):
            with patch.object(module.subprocess, 'run', fake_run):
                module.download_telegram_public_post('https://t.me/europa_press/613', str(output))
        command = calls[0]
        assert output.read_bytes() == b'video'
        assert '--no-config' in command and '--no-playlist' in command and '--no-keep-video' in command
        assert '--cookies' not in command
        assert '--impersonate' not in command
        assert '--extractor-args' not in command
        assert command[command.index('--format') + 1] == 'bv*+ba/b'
        assert command[-1] == 'https://t.me/europa_press/613'


def main() -> None:
    test_public_telegram_post_policy()
    test_other_social_hosts_are_explicitly_disabled()
    test_stage_a_uses_no_social_session_or_youtube_runtime()
    test_telegram_command_uses_best_streams_without_cookie_or_login()
    print('Telegram-only social intake tests passed')


if __name__ == '__main__':
    main()
