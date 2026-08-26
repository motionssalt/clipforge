"""Offline unit tests for pipeline/plan/automatic.py (Automatic Mode).

No provider credential, browser, or external request is used. The fake
gateway implements the same native function-call boundary as the official
Google Gen AI SDK, including the multimodal ``open_composite`` response
path, so the whole orchestration contract is exercised deterministically.

Ported from _legacy/scripts/test_automatic_analysis.py; the google-genai
SDK construction probe is omitted here (the dependency is not installed in
the unit-test environment) and covered by the workflow's dependency check.
"""
from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from pipeline.plan import automatic as automatic_analysis  # noqa: E402
from pipeline.plan.automatic import (  # noqa: E402
    AllKeysExhausted,
    ApiKey,
    EvidenceTools,
    GeminiGateway,
    NativeToolCall,
    NativeTurn,
    ProviderRequestError,
    ModelResponseError,
    ToolProtocolError,
    ToolResult,
    key_failure_should_rotate,
    model_candidates,
    narration_duration_errors,
    parse_api_keys,
    provider_error_category,
    provider_error_should_retry,
    run_analysis,
    transient_provider_retry_delay,
    safe_provider_error_summary,
)
from pipeline.plan.schema import validate_production_plan  # noqa: E402


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

COMPOSITE_NAMES = ["frame_000000.jpg", "event_000010000.jpg", "event_000020000.jpg"]


class ScriptedGateway:
    """In-memory native function-call gateway used to exercise the orchestrator."""

    def __init__(self, scripted: dict[str, list], *, key_rotations: int = 0):
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


@pytest.fixture()
def artifact_dir(tmp_path: Path) -> Path:
    root = tmp_path
    (root / "00_READ_THIS_FIRST.txt").write_text("Read artifacts in the strict required order.", encoding="utf-8")
    (root / "transcript.json").write_text('{"segments": [{"start": 0, "text": "A choice is made."}]}', encoding="utf-8")
    (root / "scene_index.json").write_text('{"shots": [{"start": 0, "end": 20}]}', encoding="utf-8")
    (root / "key_moments.json").write_text('{"moments": [{"priority": 9, "emotional_score": 8}]}', encoding="utf-8")
    for name in COMPOSITE_NAMES:
        (root / name).write_bytes(b"\x89PNG\r\n\x1a\nmock-image-data")
    with zipfile.ZipFile(root / "screenshots.zip", "w") as archive:
        for name in COMPOSITE_NAMES:
            archive.write(root / name, name)
            (root / name).unlink()
    return root


# --------------------------------------------------------------------------- #
# Pure helpers                                                                 #
# --------------------------------------------------------------------------- #

def test_parse_api_keys_dedupes_and_strips():
    assert [key.raw for key in parse_api_keys(" one, two\n one \n\nthree ")] == ["one", "two", "three"]
    assert parse_api_keys(None) == []
    assert parse_api_keys("") == []


def test_model_candidates_dedupes_preserving_order():
    assert model_candidates("gemini-3.7-flash", ["gemini-3.6-flash", "gemini-3.7-flash", "gemini-2.5-flash"]) == [
        "gemini-3.7-flash", "gemini-3.6-flash", "gemini-2.5-flash"
    ]


def test_shared_contract_accepts_fixture_plan():
    assert validate_production_plan(PRODUCTION_PLAN) == []
    assert validate_production_plan({**PRODUCTION_PLAN, "cuts": []}) == ["`cuts` is empty — at least one cut is required."]


def test_narration_duration_coverage():
    assert narration_duration_errors(PRODUCTION_PLAN) == []
    short_but_schema_valid = {**PRODUCTION_PLAN, "cuts": [
        {"start_seconds": 0, "end_seconds": 10, "voiceover_text": "Too short."},
        {"start_seconds": 10, "end_seconds": 20, "voiceover_text": "Still too short."},
    ]}
    short_errors = narration_duration_errors(short_but_schema_valid)
    assert len(short_errors) == 2 and "90%" in short_errors[0]


def test_provider_error_classification():
    assert provider_error_category(429) == "rate_or_quota"
    assert provider_error_category(503) == "provider_server"
    assert provider_error_category(401) == "authentication"
    assert key_failure_should_rotate(429, "rate_or_quota") is True
    assert key_failure_should_rotate(503, "provider_server") is False
    assert provider_error_should_retry("provider_server") is True
    assert provider_error_should_retry("provider_malformed") is True
    assert provider_error_should_retry("rate_or_quota") is False
    assert transient_provider_retry_delay(1) == 2.0
    assert transient_provider_retry_delay(2) == 4.0
    assert transient_provider_retry_delay(4) == 8.0


def test_safe_provider_error_summary_redacts_secrets():
    redacted = safe_provider_error_summary(RuntimeError("AIzaLiveSensitiveKey bearer secret-value"), None, "provider_request")
    assert "AIza[REDACTED]" in redacted and "secret-value" not in redacted


# --------------------------------------------------------------------------- #
# GeminiGateway retry/rotation behavior (retry-probe fakes)                    #
# --------------------------------------------------------------------------- #

class RetryProbeTypes:
    class FunctionDeclaration:
        def __init__(self, **kwargs: Any):
            self.kwargs = kwargs

    class Tool:
        def __init__(self, **kwargs: Any):
            self.kwargs = kwargs

    class AutomaticFunctionCallingConfig:
        def __init__(self, **kwargs: Any):
            self.kwargs = kwargs

    class GenerateContentConfig:
        def __init__(self, **kwargs: Any):
            self.kwargs = kwargs


class RetryProbeClient:
    def __init__(self, outcomes: list[Any]):
        self.outcomes = outcomes
        self.models = self

    def generate_content(self, **kwargs: Any) -> Any:
        del kwargs
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class TemporaryGeminiFailure(Exception):
    status_code = 503


class QuotaGeminiFailure(Exception):
    status_code = 429


def usable_response() -> Any:
    return SimpleNamespace(
        candidates=[SimpleNamespace(content={"role": "model"})],
        function_calls=[],
        usage_metadata=None,
        text="{}",
    )


def test_gateway_retries_transient_503_once(monkeypatch):
    sleep_delays: list[float] = []
    monkeypatch.setattr(automatic_analysis.time, "sleep", sleep_delays.append)
    outcomes: list[Any] = [TemporaryGeminiFailure("UNAVAILABLE"), usable_response()]
    gateway = GeminiGateway(
        [ApiKey(raw="test-key")],
        client_factory=lambda key: RetryProbeClient(outcomes),
        types_module=RetryProbeTypes,
    )
    assert gateway.generate("gemini-test", [], tools_enabled=True).text == "{}"
    assert sleep_delays == [2.0], "a 503 must retry once after a bounded delay"


def test_gateway_retries_incomplete_provider_response(monkeypatch):
    sleep_delays: list[float] = []
    monkeypatch.setattr(automatic_analysis.time, "sleep", sleep_delays.append)
    outcomes: list[Any] = [
        SimpleNamespace(candidates=[], function_calls=[], usage_metadata=None, text=""),
        usable_response(),
    ]
    gateway = GeminiGateway(
        [ApiKey(raw="test-key")],
        client_factory=lambda key: RetryProbeClient(outcomes),
        types_module=RetryProbeTypes,
    )
    assert gateway.generate("gemini-test", [], tools_enabled=True).text == "{}"
    assert sleep_delays == [2.0], "an incomplete temporary provider response must retry once"


def test_gateway_quota_error_never_retried(monkeypatch):
    sleep_delays: list[float] = []
    monkeypatch.setattr(automatic_analysis.time, "sleep", sleep_delays.append)
    outcomes: list[Any] = [QuotaGeminiFailure("RESOURCE_EXHAUSTED")]
    gateway = GeminiGateway(
        [ApiKey(raw="test-key")],
        client_factory=lambda key: RetryProbeClient(outcomes),
        types_module=RetryProbeTypes,
    )
    with pytest.raises(AllKeysExhausted) as excinfo:
        gateway.generate("gemini-test", [], tools_enabled=True)
    assert excinfo.value.category == "rate_or_quota"
    assert sleep_delays == [], "a 429 must not use transient provider retries"


# --------------------------------------------------------------------------- #
# Evidence tool ordering                                                        #
# --------------------------------------------------------------------------- #

def test_scene_index_rejected_before_transcript(artifact_dir: Path):
    screenshots = artifact_dir / "screenshots"
    screenshots.mkdir()
    tools = EvidenceTools(artifact_dir, screenshots, {name: artifact_dir / name for name in COMPOSITE_NAMES})
    with pytest.raises(ToolProtocolError):
        tools.call("read_scene_index", {})


# --------------------------------------------------------------------------- #
# Full orchestration through run_analysis with the scripted gateway            #
# --------------------------------------------------------------------------- #

def test_grounded_run_with_one_correction(artifact_dir: Path):
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
    plan, canonical, summary = run_analysis(artifact_dir, "unused-by-fake", gateway=primary_gateway)
    assert plan == PRODUCTION_PLAN
    assert json.loads(canonical) == PRODUCTION_PLAN
    assert summary["provider"] == "gemini-developer-api"
    assert summary["model"] == "gemini-3.7-flash"
    assert summary["model_route"] == "primary"
    assert summary["opened_composites"] == 3
    assert [item["filename"] for item in summary["opened_composite_evidence"]] == COMPOSITE_NAMES
    assert summary["opened_composite_evidence"][0]["coverage_start_seconds"] == 0.0
    assert summary["validation_corrections"] == 1
    assert summary["key_rotations"] == 1
    assert primary_gateway.calls[-1] == ("gemini-3.7-flash", False), "only the bounded plan correction must disable tools"
    tool_payloads = [result.response for batch in primary_gateway.tool_results for _, result in batch]
    assert any("open_composite requires one safe composite basename" in str(payload) for payload in tool_payloads)
    opened = [result for batch in primary_gateway.tool_results for call, result in batch if call.name == "open_composite" and result.image_bytes]
    assert [result.display_name for result in opened] == COMPOSITE_NAMES
    assert opened[0].response["coverage_start_seconds"] == 0.0
    assert opened[1].response["coverage_start_seconds"] == 8.0
    assert opened[2].response["coverage_end_seconds"] == 22.0


def test_non_json_terminal_response_gets_one_correction(artifact_dir: Path):
    gateway = ScriptedGateway({
        "gemini-3.7-flash": [
            native_call("non-json-1", "read_transcript"),
            native_call("non-json-2", "read_scene_index"),
            native_call("non-json-3", "read_key_moments"),
            native_call("non-json-4", "open_composite", filename="frame_000000.jpg"),
            native_call("non-json-5", "open_composite", filename="event_000010000.jpg"),
            native_call("non-json-6", "open_composite", filename="event_000020000.jpg"),
            NativeTurn(calls=[], text="I need more time to prepare the plan.", model_content={"role": "model", "text": "non-json"}),
            plain_turn(GROUNDED_PLAN),
        ]
    })
    plan, _, summary = run_analysis(artifact_dir, "unused-by-fake", gateway=gateway)
    assert plan == PRODUCTION_PLAN
    assert summary["validation_corrections"] == 1
    assert gateway.calls[-1] == ("gemini-3.7-flash", False), (
        "a non-JSON terminal response must receive exactly one no-tool correction retry"
    )


def test_correction_time_key_exhaustion_propagates(artifact_dir: Path):
    gateway = ScriptedGateway({
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
    with pytest.raises(AllKeysExhausted) as excinfo:
        run_analysis(artifact_dir, "unused-by-fake", gateway=gateway, fallback_models=[])
    assert "during correction" in str(excinfo.value)
    assert gateway.calls[-1] == ("gemini-3.7-flash", False), (
        "correction-time provider exhaustion must propagate before plan validation"
    )


def _grounded_script(prefix: str) -> list:
    return [
        native_call(f"{prefix}-1", "read_transcript"),
        native_call(f"{prefix}-2", "read_scene_index"),
        native_call(f"{prefix}-3", "read_key_moments"),
        native_call(f"{prefix}-4", "open_composite", filename="frame_000000.jpg"),
        native_call(f"{prefix}-5", "open_composite", filename="event_000010000.jpg"),
        native_call(f"{prefix}-6", "open_composite", filename="event_000020000.jpg"),
        plain_turn(GROUNDED_PLAN),
    ]


def test_malformed_final_plan_routes_to_fallback_model(artifact_dir: Path):
    gateway = ScriptedGateway({
        "gemini-3.7-flash": [
            native_call("malformed-final-1", "read_transcript"),
            native_call("malformed-final-2", "read_scene_index"),
            native_call("malformed-final-3", "read_key_moments"),
            native_call("malformed-final-4", "open_composite", filename="frame_000000.jpg"),
            native_call("malformed-final-5", "open_composite", filename="event_000010000.jpg"),
            native_call("malformed-final-6", "open_composite", filename="event_000020000.jpg"),
            NativeTurn(calls=[], text="temporary malformed final", model_content={"role": "model"}),
            NativeTurn(calls=[], text="still not JSON", model_content={"role": "model"}),
        ],
        "gemini-3.6-flash": _grounded_script("malformed-final-fallback"),
    })
    plan, _, summary = run_analysis(artifact_dir, "unused-by-fake", gateway=gateway)
    assert plan == PRODUCTION_PLAN
    assert summary["model"] == "gemini-3.6-flash"
    assert summary["model_route"] == "fallback"


def test_malformed_provider_response_routes_to_fallback(artifact_dir: Path):
    gateway = ScriptedGateway({
        "gemini-3.7-flash": [ProviderRequestError(None, "provider_malformed")],
        "gemini-3.6-flash": _grounded_script("malformed-fallback"),
    })
    plan, _, summary = run_analysis(artifact_dir, "unused-by-fake", gateway=gateway)
    assert plan == PRODUCTION_PLAN
    assert summary["model"] == "gemini-3.6-flash"
    assert summary["model_route"] == "fallback"


def test_provider_503_routes_to_fallback(artifact_dir: Path):
    gateway = ScriptedGateway({
        "gemini-3.7-flash": [ProviderRequestError(503, "provider_server")],
        "gemini-3.6-flash": _grounded_script("fallback"),
    })
    plan, _, summary = run_analysis(artifact_dir, "unused-by-fake", gateway=gateway)
    assert plan == PRODUCTION_PLAN
    assert summary["model"] == "gemini-3.6-flash"
    assert summary["model_route"] == "fallback"


def test_exhausted_key_pool_fails_closed(artifact_dir: Path):
    gateway = ScriptedGateway({"gemini-3.7-flash": [AllKeysExhausted("all configured keys exhausted")]})
    with pytest.raises(AllKeysExhausted):
        run_analysis(artifact_dir, "unused-by-fake", gateway=gateway, fallback_models=[])


# --------------------------------------------------------------------------- #
# Zip extraction safety                                                         #
# --------------------------------------------------------------------------- #

def test_screenshots_zip_rejects_traversal(artifact_dir: Path):
    evil = artifact_dir / "evil.zip"
    with zipfile.ZipFile(evil, "w") as archive:
        archive.writestr("../escape.png", b"png")
    from pipeline.plan.automatic import safe_extract_screenshots
    with pytest.raises(automatic_analysis.AutomaticAnalysisError):
        safe_extract_screenshots(evil, artifact_dir / "out")


def test_screenshots_zip_rejects_empty(artifact_dir: Path):
    empty = artifact_dir / "empty.zip"
    with zipfile.ZipFile(empty, "w") as archive:
        archive.writestr("notes.txt", "no images here")
    from pipeline.plan.automatic import safe_extract_screenshots
    with pytest.raises(automatic_analysis.AutomaticAnalysisError):
        safe_extract_screenshots(empty, artifact_dir / "out2")
