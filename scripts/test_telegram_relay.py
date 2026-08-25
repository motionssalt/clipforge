#!/usr/bin/env python3
"""Offline contract tests for scripts/telegram_relay.py."""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, str(Path(__file__).resolve().parent))
from telegram_relay import (  # noqa: E402
    decrypt_payload,
    ensure_payload,
    known_basic_group_message_request,
    release_tag,
    verify_bot_group_access,
)


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def sealed(job_id: str, key: bytes, payload: dict) -> str:
    nonce = bytes(range(12))
    ciphertext = AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), f'clipforge-telegram-relay:v1:{job_id}'.encode())
    return json.dumps({'v': 1, 'iv': b64(nonce), 'ciphertext': b64(ciphertext)})


class FakeTelegramResponse:
    def __init__(self, ok: bool, payload: dict):
        self.ok = ok
        self._payload = payload

    def json(self) -> dict:
        return self._payload


def successful_group_requester(url: str, *, params: dict, timeout: int) -> FakeTelegramResponse:
    assert url.endswith('/getChat')
    assert params == {'chat_id': -5405387856}
    assert timeout > 0
    return FakeTelegramResponse(True, {'ok': True, 'result': {'id': -5405387856, 'type': 'group'}})


def missing_group_requester(url: str, *, params: dict, timeout: int) -> FakeTelegramResponse:
    return FakeTelegramResponse(False, {'ok': False, 'description': 'chat not found'})


class FakeInputMessageID:
    def __init__(self, message_id: int):
        self.message_id = message_id


class FakeGetMessagesRequest:
    def __init__(self, *, id: list[FakeInputMessageID]):
        self.id = id


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

    # Bot B must be a member of the configured basic group. The preflight uses
    # Bot API getChat and never exposes Telegram's response body in workflow logs.
    verify_bot_group_access('test-token', -5405387856, successful_group_requester)
    try:
        verify_bot_group_access('test-token', -5405387856, missing_group_requester)
    except RuntimeError as error:
        assert 'Add Bot B' in str(error)
    else:
        raise AssertionError('Missing Bot B membership must fail before MTProto transfer.')

    # Bot accounts cannot call messages.getDialogs. The supplied private relay
    # group is a basic group, so the exact authenticated message is requested
    # directly through messages.getMessages instead of enumerating dialogs.
    direct_request = known_basic_group_message_request(
        -5405387856,
        91,
        FakeGetMessagesRequest,
        FakeInputMessageID,
    )
    assert isinstance(direct_request, FakeGetMessagesRequest)
    assert [item.message_id for item in direct_request.id] == [91]
    for invalid_group_id in (-1004377458972, 0, 123):
        try:
            known_basic_group_message_request(
                invalid_group_id,
                91,
                FakeGetMessagesRequest,
                FakeInputMessageID,
            )
        except RuntimeError as error:
            assert 'basic Telegram group ID' in str(error)
        else:
            raise AssertionError('Supergroup, channel, and user IDs must not trigger a bot dialogs lookup.')

    print('telegram_relay offline contracts passed')


if __name__ == '__main__':
    main()
