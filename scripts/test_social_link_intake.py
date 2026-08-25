#!/usr/bin/env python3
import importlib.util
import tempfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('download_drive', ROOT / 'scripts' / 'download_drive.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def test_recognised_hosts():
    examples = {
        'https://www.youtube.com/watch?v=abc': 'youtube.com',
        'https://youtu.be/abc': 'youtu.be',
        'https://www.tiktok.com/@creator/video/123': 'tiktok.com',
        'https://vm.tiktok.com/abc': 'vm.tiktok.com',
        'https://www.instagram.com/reel/abc/': 'instagram.com',
        'https://www.facebook.com/reel/123': 'facebook.com',
        'https://x.com/creator/status/123': 'x.com',
        'https://vimeo.com/123': 'vimeo.com',
        'https://www.reddit.com/r/example/comments/abc/video/': 'reddit.com',
    }
    for url, expected in examples.items():
        assert module.social_host(url) == expected, url
    for url in ['https://notyoutube.com/watch?v=abc', 'ftp://youtube.com/a', 'https://instagram.com.evil.example/reel/a']:
        assert module.social_host(url) is None, url


def test_social_command_is_public_single_video_only():
    with tempfile.TemporaryDirectory() as temp:
        output = Path(temp) / 'final.mp4'
        captured = []
        def fake_run(command, check, timeout):
            captured.extend(command)
            template = command[command.index('-o') + 1]
            Path(template.replace('%(ext)s', 'mp4')).write_bytes(b'video')
        with patch.object(module.subprocess, 'run', fake_run):
            module.download_social('https://www.youtube.com/watch?v=abc', str(output), 'youtube.com')
        assert output.read_bytes() == b'video'
        assert '--no-config' in captured and '--no-playlist' in captured
        assert '--max-filesize' in captured and '--' in captured
        assert captured[-1] == 'https://www.youtube.com/watch?v=abc'


def main():
    test_recognised_hosts()
    test_social_command_is_public_single_video_only()
    print('social link intake tests passed')

if __name__ == '__main__':
    main()
