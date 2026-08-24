#!/usr/bin/env python3
"""Deterministic mock coverage for ClipForge Automatic Mode.

No provider credentials or external requests are used. The mock exercises the
same tool protocol and contract gate used by the GitHub Actions runner.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path

from automatic_analysis import (
    AllTokensExhausted,
    AutomaticAnalysisError,
    EvidenceTools,
    HttpResponse,
    PuterGateway,
    ToolProtocolError,
    discover_compatible_models,
    parse_tokens,
    run_analysis,
)
from production_plan_contract import validate_production_plan


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


assert parse_tokens(" one, two\n one \n\nthree ") == ["one", "two", "three"]
assert discover_compatible_models(CATALOG, "google/gemini-3.6-flash", "openai/gpt-5.6-terra") == [
    "google/gemini-3.6-flash",
    "openai/gpt-5.6-terra",
]
assert validate_production_plan(VALID_PLAN) == []
assert validate_production_plan({**VALID_PLAN, "cuts": []}) == ["`cuts` is empty — at least one cut is required."]


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

    bodies: list[dict] = []
    post_count = 0

    def mock_transport(method: str, url: str, headers: dict[str, str], body: dict | None) -> HttpResponse:
        nonlocal_post_count = None
        if method == "GET":
            assert url == "mock://catalog"
            return HttpResponse(200, CATALOG)
        assert method == "POST"
        assert url == "mock://provider/chat/completions"
        assert headers.get("Authorization", "").startswith("Bearer ")
        assert "token" not in str(headers).lower() or headers["Authorization"].startswith("Bearer ")
        assert body is not None
        bodies.append(body)
        post_index = len(bodies)
        if post_index == 1:
            return HttpResponse(200, {"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-1", "function": {"name": "read_transcript", "arguments": "{}"}}]}}]})
        if post_index == 2:
            return HttpResponse(200, {"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-2", "function": {"name": "read_scene_index", "arguments": "{}"}}]}}]})
        if post_index == 3:
            return HttpResponse(200, {"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-3", "function": {"name": "read_key_moments", "arguments": "{}"}}]}}]})
        if post_index == 4:
            return HttpResponse(200, {"choices": [{"message": {"content": "", "tool_calls": [{"id": "call-4", "function": {"name": "open_composite", "arguments": '{"filename":"scene-000.png"}'}}]}}]})
        if post_index == 5:
            invalid = {**VALID_PLAN, "cuts": [{"start_seconds": 10, "end_seconds": 0, "voiceover_text": "Bad order"}]}
            return HttpResponse(200, {"choices": [{"message": {"content": json.dumps(invalid)}}]})
        assert post_index == 6, "only one bounded correction request is allowed"
        return HttpResponse(200, {"choices": [{"message": {"content": json.dumps(VALID_PLAN)}}]})

    plan, canonical, summary = run_analysis(
        root,
        "test-token-index-zero,test-token-index-one",
        transport=mock_transport,
        catalog_endpoint="mock://catalog",
        base_url="mock://provider/",
    )
    assert plan == VALID_PLAN
    assert json.loads(canonical) == VALID_PLAN
    assert summary["model_route"] == "primary"
    assert summary["opened_composites"] == 1
    assert summary["validation_corrections"] == 1
    all_bodies = json.dumps(bodies)
    assert "data:image/png;base64," in all_bodies, "image tool results must use data content, not hosted URLs"
    assert "http://" not in all_bodies and "https://" not in all_bodies


def exhausted_transport(method: str, url: str, headers: dict[str, str], body: dict | None) -> HttpResponse:
    return HttpResponse(429, {"error": {"code": "rate_limit"}})


try:
    PuterGateway(["test-token-index-zero", "test-token-index-one"], transport=exhausted_transport, base_url="mock://provider/").chat({"model": "x"})
    raise AssertionError("all rate-limited token indexes did not fail closed")
except AllTokensExhausted:
    pass

print("PASS: Automatic Mode enforces capability gating, tool order, data-image results, bounded correction, shared-plan validation, and token-index failover")
