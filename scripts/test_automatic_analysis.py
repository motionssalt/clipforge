#!/usr/bin/env python3
"""Deterministic bridge-protocol coverage for ClipForge Automatic Mode.

No provider credential, browser, or external request is used. The mock drives
the same JSONL contract consumed by the headless Chromium Puter.js bridge.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from automatic_analysis import (
    AllTokensExhausted,
    EvidenceTools,
    ProviderRequestError,
    PuterBrowserGateway,
    ToolProtocolError,
    provider_error_category,
    discover_compatible_models,
    parse_tokens,
    run_analysis,
)
from production_plan_contract import validate_production_plan


RUNNER_SOURCE = Path(__file__).with_name("automatic_analysis.py").read_text(encoding="utf-8")
# A JSONL bridge request must end in a newline byte, not the two literal
# characters backslash+n, or Node's readline listener never receives it.
assert r'}) + "\n")' in RUNNER_SOURCE
assert r'}) + "\\n")' not in RUNNER_SOURCE


CATALOG = {
    "models": [
        {
            "id": "gemini-3.6-flash",
            "aliases": ["google/gemini-3.6-flash"],
            "modalities": {"input": ["text", "image"], "output": ["text"]},
            "tool_call": True,
        },
        {
            "id": "gpt-5.6-terra",
            "aliases": ["openai/gpt-5.6-terra"],
            "modalities": {"input": ["text", "image"], "output": ["text"]},
            "tool_call": True,
        },
        # A same-alias relay lacking explicit capabilities must never be selected.
        {"id": "relay:gemini", "aliases": ["google/gemini-3.6-flash"]},
    ]
}

VALID_PLAN = {
    "video_duration_seconds": 60,
    "target_total_duration_seconds": 20,
    "cuts": [
        {"start_seconds": 0, "end_seconds": 10, "voiceover_text": "The confrontation begins."},
        {"start_seconds": 10, "end_seconds": 20, "voiceover_text": "The choice changes everything."},
    ],
    "hashtags": ["#clip", "#story", "#moment", "#edit", "#video"],
    "youtube_tags": [
        "clip", "story", "moment", "edit", "video", "scene", "turning point", "character", "drama", "analysis"
    ],
}


class FakeBrowserBridge:
    """In-memory stand-in for the persistent headless Puter.js bridge."""

    def __init__(self, chat_handler):
        self.chat_handler = chat_handler
        self.calls: list[tuple[str, str, dict[str, Any]]] = []
        self.closed = False

    def request(self, operation: str, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        actual_payload = payload or {}
        self.calls.append((operation, token, actual_payload))
        if operation == "list_models":
            return {"ok": True, "models": CATALOG}
        assert operation == "chat"
        return self.chat_handler(token, actual_payload)

    def close(self) -> None:
        self.closed = True


def tool_message(call_id: str, name: str, arguments: str = "{}") -> dict[str, Any]:
    return {
        "ok": True,
        "message": {"content": "", "tool_calls": [{"id": call_id, "function": {"name": name, "arguments": arguments}}]},
    }


assert parse_tokens(" one, two\n one \n\nthree ") == ["one", "two", "three"]
assert discover_compatible_models(CATALOG, "google/gemini-3.6-flash", "openai/gpt-5.6-terra") == [
    "google/gemini-3.6-flash",
    "openai/gpt-5.6-terra",
]
assert validate_production_plan(VALID_PLAN) == []
assert validate_production_plan({**VALID_PLAN, "cuts": []}) == ["`cuts` is empty — at least one cut is required."]
assert provider_error_category(None, {"code": "upstream_failed", "message": "All AI providers failed"}) == "provider_server"


with tempfile.TemporaryDirectory(prefix="clipforge_auto_test_") as temp_dir:
    root = Path(temp_dir)
    (root / "00_READ_THIS_FIRST.txt").write_text("Read artifacts in the strict required order.", encoding="utf-8")
    (root / "transcript.json").write_text('{"segments": [{"start": 0, "text": "A choice is made."}]}', encoding="utf-8")
    (root / "scene_index.json").write_text('{"shots": [{"start": 0, "end": 20}]}', encoding="utf-8")
    (root / "key_moments.json").write_text('{"moments": [{"priority": 9, "emotional_score": 8}]}', encoding="utf-8")
    composite = root / "scene-000.png"
    composite.write_bytes(b"\x89PNG\r\n\x1a\nmock-image-data")
    with zipfile.ZipFile(root / "screenshots.zip", "w") as archive:
        archive.write(composite, "scene-000.png")
    composite.unlink()

    screenshots = root / "screenshots"
    screenshots.mkdir()
    tools = EvidenceTools(root, screenshots, {"scene-000.png": root / "scene-000.png"})
    try:
        tools.call("read_scene_index", {})
        raise AssertionError("scene index was allowed before transcript")
    except ToolProtocolError:
        pass

    primary_turn = 0

    def primary_handler(token: str, payload: dict[str, Any]) -> dict[str, Any]:
        nonlocal_primary_turn = None
        del token
        nonlocal_primary_turn
        nonlocal_index = len([call for call in primary_bridge.calls if call[0] == "chat"])
        if nonlocal_index == 1:
            return tool_message("call-1", "read_transcript")
        if nonlocal_index == 2:
            return tool_message("call-2", "read_scene_index")
        if nonlocal_index == 3:
            return tool_message("call-3", "read_key_moments")
        if nonlocal_index == 4:
            return tool_message("call-4", "open_composite", "{}")
        if nonlocal_index == 5:
            return tool_message("call-5", "open_composite", '{"filename":"scene-000.png"}')
        if nonlocal_index == 6:
            invalid = {**VALID_PLAN, "cuts": [{"start_seconds": 10, "end_seconds": 0, "voiceover_text": "Bad order"}]}
            return {"ok": True, "message": {"content": json.dumps(invalid)}}
        assert nonlocal_index == 7, "only one bounded correction request is allowed"
        return {"ok": True, "message": {"content": json.dumps(VALID_PLAN)}}

    primary_bridge = FakeBrowserBridge(primary_handler)
    plan, canonical, summary = run_analysis(
        root,
        "test-token-index-zero,test-token-index-one",
        bridge=primary_bridge,
    )
    assert plan == VALID_PLAN
    assert json.loads(canonical) == VALID_PLAN
    assert summary["model_route"] == "primary"
    assert summary["opened_composites"] == 1
    assert summary["validation_corrections"] == 1
    browser_payloads = json.dumps([payload for operation, _, payload in primary_bridge.calls if operation == "chat"])
    assert "data:image/png;base64," in browser_payloads, "image tool results must use data content, not hosted URLs"
    assert "open_composite requires one safe composite basename" in browser_payloads, "safe tool-argument errors must be returned for bounded retry"
    assert "http://" not in browser_payloads and "https://" not in browser_payloads
    assert primary_bridge.calls[0][0] == "list_models", "catalog must be read through the browser bridge first"

    def fallback_handler(token: str, payload: dict[str, Any]) -> dict[str, Any]:
        del token
        if payload["model"] == "google/gemini-3.6-flash":
            return {"ok": False, "error": {"status": 402, "code": "payment_required"}}
        fallback_index = len([call for call in fallback_bridge.calls if call[0] == "chat" and call[2].get("model") == "openai/gpt-5.6-terra"])
        if fallback_index == 1:
            return tool_message("fallback-1", "read_transcript")
        if fallback_index == 2:
            return tool_message("fallback-2", "read_scene_index")
        if fallback_index == 3:
            return tool_message("fallback-3", "read_key_moments")
        if fallback_index == 4:
            return tool_message("fallback-4", "open_composite", '{"filename":"scene-000.png"}')
        return {"ok": True, "message": {"content": json.dumps(VALID_PLAN)}}

    fallback_bridge = FakeBrowserBridge(fallback_handler)
    fallback_plan, _, fallback_summary = run_analysis(
        root,
        "test-token-index-zero,test-token-index-one",
        bridge=fallback_bridge,
    )
    assert fallback_plan == VALID_PLAN
    assert fallback_summary["model"] == "openai/gpt-5.6-terra"
    assert fallback_summary["model_route"] == "fallback"


def failure_handler(status: int, code: str):
    return lambda token, payload: {"ok": False, "error": {"status": status, "code": code}}


rate_bridge = FakeBrowserBridge(failure_handler(429, "rate_limit"))
try:
    PuterBrowserGateway(["test-token-index-zero", "test-token-index-one"], rate_bridge).chat({"model": "x"})
    raise AssertionError("all rate-limited token indexes did not fail closed")
except AllTokensExhausted:
    pass
assert [token for operation, token, _ in rate_bridge.calls if operation == "chat"] == ["test-token-index-zero", "test-token-index-one"]

payment_bridge = FakeBrowserBridge(failure_handler(402, "payment_required"))
try:
    PuterBrowserGateway(["test-token-index-zero", "test-token-index-one"], payment_bridge).chat({"model": "x"})
    raise AssertionError("all payment-limited token indexes did not return the safe model-route error")
except ProviderRequestError as exc:
    assert exc.status == 402
    assert exc.category == "payment_or_spend_limit"
assert [token for operation, token, _ in payment_bridge.calls if operation == "chat"] == ["test-token-index-zero", "test-token-index-one"]

print("PASS: Automatic Mode enforces the Chromium Puter.js bridge, tool order, safe argument retry, data-image results, bounded correction, 402 fallback, and token-index failover")
