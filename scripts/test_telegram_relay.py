#!/usr/bin/env python3
"""Offline contract tests for scripts/telegram_relay.py."""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parent))
from telegram_relay import decrypt_payload, ensure_payload, release_tag  # noqa: E402


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def sealed(job_id: str, key: bytes, payload: dict) -> str:
    nonce = bytes(range(12))
    ciphertext = AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), f'clipforge-telegram-relay:v1:{job_id}'.encode())
    return json.dumps({'v': 1, 'iv': b64(nonce), 'ciphertext': b64(ciphertext)})


def main() -> None:
    job_id = 'manual-relay-test'
    key = bytes(range(32))
    payload = {
        'version': 1, 'job_id': job_id, 'target_repo': 'owner/clone', 'target_github_pat': 'test-only-pat',
        'stage_a_inputs': {'job_id': job_id, 'source_type': 'telegram_bot_forward'},
        'telegram': {'group_chat_id': -100123, 'group_message_id': 44, 'declared_size': 4096}
    }
    encrypted = sealed(job_id, key, payload)
    assert decrypt_payload(job_id, encrypted, b64(key)) == payload
    try:
        decrypt_payload('other-job', encrypted, b64(key))
    except RuntimeError:
        pass
    else:
        raise AssertionError('AAD/job binding must reject a replay to another job')
    repo, token, inputs, telegram = ensure_payload(payload)
    assert repo == 'owner/clone' and token == 'test-only-pat'
    assert inputs['source_type'] == 'telegram_bot_forward'
    assert telegram['group_message_id'] == 44
    assert release_tag(job_id) == 'clipforge-relay-input-manual-relay-test'
    print('telegram_relay offline contracts passed')


if __name__ == '__main__':
    main()
