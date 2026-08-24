#!/usr/bin/env python3
"""Deterministic native-Gemini coverage for ClipForge Automatic Mode.

No provider credential, browser, or external request is used. The fake gateway
uses the same native function-call boundary as the official Google Gen AI SDK,
including the multimodal ``open_composite`` response path.
"""

from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from automatic_analysis import (
    AllKeysExhausted,
    EvidenceTools,
    NativeToolCall,
    NativeTurn,
    ProviderRequestError,
    ToolProtocolError,
    ToolResult,
    key_failure_should_rotate,
    model_candidates,
    narration_duration_errors,
    parse_api_keys,
    provider_error_category,
    run_analysis,
    safe_provider_error_summary,
)
from google.genai import types
from production_plan_contract import validate_production_plan


RUNNER_SOURCE = Path(__file__).with_name("automatic_analysis.py").read_text(encoding="utf-8")
assert "from google import genai" in RUNNER_SOURCE, "Automatic Mode must use the official Google Gen AI SDK"
assert "FunctionResponseBlob" in RUNNER_SOURCE
assert "visual_evidence" in RUNNER_SOURCE
assert "Puter" not in RUNNER_SOURCE
assert "puter_browser_bridge" not in RUNNER_SOURCE

COVERED_LINE_ONE = (
    "The frightened traveler reaches the broken gate, studies the warning marks, "
    "and keeps moving because the path behind him has already vanished into darkness, leaving only a cold wind, distant bells, and one final warning to follow."
)
COVERED_LINE_TWO = (
    "Inside the ruined hall, the same traveler sees the hidden answer, chooses "
    "the narrow bridge, and finally understands why the silent guardian waited through the storm, guarding the answer until someone brave enough could listen."
)

PRODUCTION_PLAN = {
    "video_duration_seconds": 60,
    "target_total_duration_seconds": 20,
    "cuts": [
        {"start_seconds": 0, "end_seconds": 10, "voiceover_text": COVERED_LINE_ONE},
        {"start_seconds": 10, "end_seconds": 20, "voiceover_text": COVERED_LINE_TWO},
    ],
    "hashtags": ["#clip", "#story", "#moment", "#edit", "#video"],
    "youtube_tags": [
        "clip", "story", "moment", "edit", "video", "scene", "turning point", "character", "drama", "analysis"
    ],
}

GROUNDED_PLAN = {
    **PRODUCTION_PLAN,
    "cuts": [
        {
            **PRODUCTION_PLAN["cuts"][0],
            "visual_evidence": ["frame_000000.jpg", "event_000010000.jpg"],
        },
        {
            **PRODUCTION_PLAN["cuts"][1],
            "visual_evidence": ["event_000010000.jpg", "event_000020000.jpg"],
        },
    ],
}


class ScriptedGateway:
    """In-memory native function-call gateway used to exercise the orchestrator."""

    def __init__(self, scripted: dict[str, list[NativeTurn | Exception]], *, key_rotations: int = 0):
        self.scripted = {model: list(turns) for model, turns in scripted.items()}
        self.calls: list[tuple[str, bool]] = []
        self.tool_results: list[list[tuple[NativeToolCall, ToolResult]]] = []
        self.key_rotations = key_rotations

    def new_history(self, prompt: str) -> list[Any]:
        assert "read_transcript first" in prompt
        assert "visual_evidence" in prompt
        return [("user", prompt)]

    def append_user_text(self, history: list[Any], text: str) -> None:
        history.append(("user", text))

    def generate(self, model: str, history: list[Any], *, tools_enabled: bool) -> NativeTurn:
        del history
        self.calls.append((model, tools_enabled))
        item = self.scripted[model].pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def append_tool_results(self, history: list[Any], turn: NativeTurn, results: list[tuple[NativeToolCall, ToolResult]]) -> None:
        history.append(("model", turn.model_content))
        history.append(("tool", results))
        self.tool_results.append(results)


def native_call(call_id: str, name: str, **args: Any) -> NativeTurn:
    return NativeTurn(
        calls=[NativeToolCall(id=call_id, name=name, args=args)],
        text="",
        model_content={"role": "model", "call": name},
    )


def plain_turn(payload: dict[str, Any]) -> NativeTurn:
    return NativeTurn(calls=[], text=json.dumps(payload), model_content={"role": "model", "text": "plan"})


assert [key.raw for key in parse_api_keys(" one, two\n one \n\nthree ")] == ["one", "two", "three"]
assert model_candidates("gemini-3.7-flash", ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-2.5-flash"]) == [
    "gemini-3.7-flash", "gemini-3.6-flash", "gemini-2.5-flash"
]
assert validate_production_plan(PRODUCTION_PLAN) == []
assert validate_production_plan({**PRODUCTION_PLAN, "cuts": []}) == ["`cuts` is empty — at least one cut is required."]
assert narration_duration_errors(PRODUCTION_PLAN) == []
short_but_schema_valid = {**PRODUCTION_PLAN, "cuts": [
    {"start_seconds": 0, "end_seconds": 10, "voiceover_text": "Too short."},
    {"start_seconds": 10, "end_seconds": 20, "voiceover_text": "Still too short."},
]}
short_errors = narration_duration_errors(short_but_schema_valid)
assert len(short_errors) == 2 and "90%" in short_errors[0]
assert provider_error_category(429) == "rate_or_quota"
assert provider_error_category(503) == "provider_server"
assert provider_error_category(401) == "authentication"
assert key_failure_should_rotate(429, "rate_or_quota") is True
assert key_failure_should_rotate(503, "provider_server") is False
redacted = safe_provider_error_summary(RuntimeError("AIzaLiveSensitiveKey bearer secret-value"), None, "provider_request")
assert "AIza[REDACTED]" in redacted and "secret-value" not in redacted
sdk_probe_part = types.Part.from_function_response(
    name="open_composite",
    response={"result": {"filename": "probe.png"}},
    parts=[types.FunctionResponsePart(inline_data=types.FunctionResponseBlob(
        mime_type="image/png", display_name="probe.png", data=b"png-bytes"
    ))],
)
assert sdk_probe_part.function_response is not None, "official SDK must construct a multimodal function response"

with tempfile.TemporaryDirectory(prefix="clipforge_auto_test_") as temp_dir:
    root = Path(temp_dir)
    (root / "00_READ_THIS_FIRST.txt").write_text("Read artifacts in the strict required order.", encoding="utf-8")
    (root / "transcript.json").write_text('{"segments": [{"start": 0, "text": "A choice is made."}]}', encoding="utf-8")
    (root / "scene_index.json").write_text('{"shots": [{"start": 0, "end": 20}]}', encoding="utf-8")
    (root / "key_moments.json").write_text('{"moments": [{"priority": 9, "emotional_score": 8}]}', encoding="utf-8")
    composite_names = ["frame_000000.jpg", "event_000010000.jpg", "event_000020000.jpg"]
    for name in composite_names:
        (root / name).write_bytes(b"\x89PNG\r\n\x1a\nmock-image-data")
    with zipfile.ZipFile(root / "screenshots.zip", "w") as archive:
        for name in composite_names:
            archive.write(root / name, name)
            (root / name).unlink()

    screenshots = root / "screenshots"
    screenshots.mkdir()
    tools = EvidenceTools(root, screenshots, {name: root / name for name in composite_names})
    try:
        tools.call("read_scene_index", {})
        raise AssertionError("scene index was allowed before transcript")
    except ToolProtocolError:
        pass

    primary_gateway = ScriptedGateway({
        "gemini-3.7-flash": [
            native_call("call-1", "read_transcript"),
            native_call("call-2", "read_scene_index"),
            native_call("call-3", "read_key_moments"),
            native_call("call-4", "open_composite"),  # safe argument error, model must retry
            native_call("call-5", "open_composite", filename="frame_000000.jpg"),
            native_call("call-6", "open_composite", filename="event_000010000.jpg"),
            native_call("call-7", "open_composite", filename="event_000020000.jpg"),
            plain_turn(PRODUCTION_PLAN),  # schema-valid but ungrounded; must be corrected
            plain_turn(GROUNDED_PLAN),
        ]
    }, key_rotations=1)
    plan, canonical, summary = run_analysis(root, "unused-by-fake", gateway=primary_gateway)
    assert plan == PRODUCTION_PLAN
    assert json.loads(canonical) == PRODUCTION_PLAN
    assert summary["provider"] == "gemini-developer-api"
    assert summary["model"] == "gemini-3.7-flash"
    assert summary["model_route"] == "primary"
    assert summary["opened_composites"] == 3
    assert [item["filename"] for item in summary["opened_composite_evidence"]] == composite_names
    assert summary["opened_composite_evidence"][0]["coverage_start_seconds"] == 0.0
    assert summary["validation_corrections"] == 1
    assert summary["key_rotations"] == 1
    assert primary_gateway.calls[-1] == ("gemini-3.7-flash", False), "only the bounded plan correction must disable tools"
    tool_payloads = [result.response for batch in primary_gateway.tool_results for _, result in batch]
    assert any("open_composite requires one safe composite basename" in str(payload) for payload in tool_payloads)
    opened = [result for batch in primary_gateway.tool_results for call, result in batch if call.name == "open_composite" and result.image_bytes]
    assert [result.display_name for result in opened] == composite_names
    assert opened[0].response["coverage_start_seconds"] == 0.0
    assert opened[1].response["coverage_start_seconds"] == 8.0
    assert opened[2].response["coverage_end_seconds"] == 22.0

    correction_exhausted_gateway = ScriptedGateway({
        "gemini-3.7-flash": [
            native_call("quota-1", "read_transcript"),
            native_call("quota-2", "read_scene_index"),
            native_call("quota-3", "read_key_moments"),
            native_call("quota-4", "open_composite", filename="frame_000000.jpg"),
            native_call("quota-5", "open_composite", filename="event_000010000.jpg"),
            native_call("quota-6", "open_composite", filename="event_000020000.jpg"),
            plain_turn(PRODUCTION_PLAN),
            AllKeysExhausted("all configured keys exhausted during correction"),
        ]
    })
    try:
        run_analysis(root, "unused-by-fake", gateway=correction_exhausted_gateway, fallback_models=[])
        raise AssertionError("correction-time key exhaustion was not propagated")
    except AllKeysExhausted as error:
        assert "during correction" in str(error)
    assert correction_exhausted_gateway.calls[-1] == ("gemini-3.7-flash", False), (
        "correction-time provider exhaustion must propagate before plan validation"
    )

    fallback_gateway = ScriptedGateway({
        "gemini-3.7-flash": [ProviderRequestError(503, "provider_server")],
        "gemini-3.6-flash": [
            native_call("fallback-1", "read_transcript"),
            native_call("fallback-2", "read_scene_index"),
            native_call("fallback-3", "read_key_moments"),
            native_call("fallback-4", "open_composite", filename="frame_000000.jpg"),
            native_call("fallback-5", "open_composite", filename="event_000010000.jpg"),
            native_call("fallback-6", "open_composite", filename="event_000020000.jpg"),
            plain_turn(GROUNDED_PLAN),
        ],
    })
    fallback_plan, _, fallback_summary = run_analysis(root, "unused-by-fake", gateway=fallback_gateway)
    assert fallback_plan == PRODUCTION_PLAN
    assert fallback_summary["model"] == "gemini-3.6-flash"
    assert fallback_summary["model_route"] == "fallback"

    exhausted_gateway = ScriptedGateway({"gemini-3.7-flash": [AllKeysExhausted("all configured keys exhausted")]})
    try:
        run_analysis(root, "unused-by-fake", gateway=exhausted_gateway, fallback_models=[])
        raise AssertionError("an exhausted direct-Gemini key pool did not fail closed")
    except AllKeysExhausted:
        pass

print("PASS: Automatic Mode enforces chronological native evidence retrieval, per-cut visual grounding, correction-time provider-failure propagation, bounded fallback, and secure key-failover semantics")
