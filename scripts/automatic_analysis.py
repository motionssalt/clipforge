#!/usr/bin/env python3
"""Unattended ClipForge Automatic Mode analysis using the Gemini Developer API.

The runner receives Stage A release assets, uses Gemini's native function calling
for bounded evidence retrieval, and writes ``production.json`` only after the
same shared contract accepted by the manual-import flow validates it.

Security properties:
- API keys are read only from the ``GEMINI_API_KEYS`` Actions secret.
- Raw keys are never printed, committed, written to result artifacts, or placed
  in exceptions. Logs identify only a zero-based attempted key index.
- Screenshot archives and each image response are bounded before bytes are
  supplied to Gemini as a multimodal function response.
- The model can use only four local, order-enforced evidence functions.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Protocol

from production_plan_contract import parse_and_validate_production_plan


DEFAULT_PRIMARY_MODEL = "gemini-3.7-flash"
DEFAULT_FALLBACK_MODELS = ("gemini-3.6-flash", "gemini-2.5-flash")
MAX_TOOL_TURNS = 12
MAX_CORRECTION_RETRIES = 1
MAX_SEED_BYTES = 1024 * 1024
MAX_JSON_ARTIFACT_BYTES = 5 * 1024 * 1024
MAX_ZIP_ENTRIES = 800
MAX_ZIP_MEMBER_BYTES = 6 * 1024 * 1024
MAX_ZIP_TOTAL_BYTES = 160 * 1024 * 1024
MAX_OPEN_COMPOSITES = 12
MAX_COMPOSITE_IMAGE_BYTES = 5 * 1024 * 1024
MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024


class AutomaticAnalysisError(RuntimeError):
    """Base class for safe-to-display Automatic Mode failures."""


class ToolProtocolError(AutomaticAnalysisError):
    """The model tried an unsupported or out-of-order local evidence operation."""


class AllKeysExhausted(AutomaticAnalysisError):
    """Every configured API key reached an authentication or quota failure."""


class ProviderRequestError(AutomaticAnalysisError):
    """Safe Gemini error metadata without any raw request or response body."""

    def __init__(self, status: int | None, category: str):
        self.status = status
        self.category = category
        status_text = str(status) if status is not None else "network"
        super().__init__(f"Gemini provider request failed ({status_text}; {category}).")


@dataclass(frozen=True)
class ApiKey:
    raw: str


@dataclass(frozen=True)
class NativeToolCall:
    id: str
    name: str
    args: dict[str, Any]


@dataclass(frozen=True)
class NativeTurn:
    calls: list[NativeToolCall]
    text: str
    model_content: Any


@dataclass(frozen=True)
class ToolResult:
    response: dict[str, Any]
    image_bytes: bytes | None = None
    mime_type: str | None = None
    display_name: str | None = None


def safe_log(message: str) -> None:
    """Emit only static, secret-free telemetry."""
    print(message, flush=True)


def parse_api_keys(raw: str | None) -> list[ApiKey]:
    """Parse a comma/newline-delimited secret without logging any key values."""
    seen: set[str] = set()
    keys: list[ApiKey] = []
    for value in re.split(r"[\r\n,]+", raw or ""):
        key = value.strip()
        if key and key not in seen:
            seen.add(key)
            keys.append(ApiKey(raw=key))
    return keys


def provider_error_status(error: Exception) -> int | None:
    value = getattr(error, "code", None) or getattr(error, "status_code", None)
    return value if isinstance(value, int) else None


def provider_error_category(status: int | None, error: Exception | None = None) -> str:
    message = str(error or "").lower()
    if status in (401, 403) or "api_key_invalid" in message or "unauth" in message:
        return "authentication"
    if status == 429 or "resource_exhausted" in message or "quota" in message or "rate" in message:
        return "rate_or_quota"
    if status in (400, 404, 422) or "not found" in message or "invalid argument" in message:
        return "model_or_request"
    if status is not None and status >= 500:
        return "provider_server"
    if "timeout" in message or "connection" in message or "network" in message:
        return "network"
    return "provider_request"


def key_failure_should_rotate(status: int | None, category: str) -> bool:
    return status in (401, 403, 429) or category in {"authentication", "rate_or_quota"}


def safe_provider_error_summary(error: Exception, status: int | None, category: str) -> str:
    """Bound provider diagnostics to safe metadata, never request content or credentials."""
    message = str(error)[:360]
    message = re.sub(r"(?i)(AIza)[A-Za-z0-9_-]+", r"\1[REDACTED]", message)
    message = re.sub(r"(?i)bearer\s+[^\s\"',}]+", "Bearer [REDACTED]", message)
    message = re.sub(
        r"(?i)((?:api[_-]?key|authorization|token|secret|cookie|session)\s*[=:]\s*)[^,\s}]+",
        r"\1[REDACTED]",
        message,
    )
    return (
        "Gemini key request failure: status=" + str(status if status is not None else "none")
        + " category=" + category + " type=" + type(error).__name__
        + " message=" + (message or "[none]")
    )


def strict_artifact_path(root: Path, filename: str, maximum: int) -> Path:
    target = (root / filename).resolve()
    if target.parent != root.resolve() or not target.is_file():
        raise AutomaticAnalysisError(f"Required Stage A artifact is unavailable: {filename}.")
    if target.stat().st_size > maximum:
        raise AutomaticAnalysisError(f"Stage A artifact exceeds the safe size limit: {filename}.")
    return target


def read_text_artifact(root: Path, filename: str, maximum: int) -> str:
    return strict_artifact_path(root, filename, maximum).read_text(encoding="utf-8")


def safe_extract_screenshots(zip_path: Path, destination: Path) -> dict[str, Path]:
    if not zip_path.is_file():
        raise AutomaticAnalysisError("Stage A screenshots.zip is unavailable.")
    extracted: dict[str, Path] = {}
    total = 0
    try:
        archive = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as exc:
        raise AutomaticAnalysisError("Stage A screenshots.zip is invalid.") from exc
    with archive:
        infos = [info for info in archive.infolist() if not info.is_dir()]
        if len(infos) > MAX_ZIP_ENTRIES:
            raise AutomaticAnalysisError("Stage A screenshot archive has too many entries for Automatic Mode.")
        for info in infos:
            member = Path(info.filename)
            if member.is_absolute() or ".." in member.parts or not member.name:
                raise AutomaticAnalysisError("Stage A screenshot archive contains an unsafe path.")
            if member.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"}:
                continue
            if info.file_size > MAX_ZIP_MEMBER_BYTES:
                raise AutomaticAnalysisError("A Stage A screenshot composite exceeds the safe image size limit.")
            total += info.file_size
            if total > MAX_ZIP_TOTAL_BYTES:
                raise AutomaticAnalysisError("Stage A screenshot archive exceeds the safe decompressed size limit.")
            target = (destination / member.name).resolve()
            if target.parent != destination.resolve() or target.name in extracted:
                raise AutomaticAnalysisError("Stage A screenshot archive contains duplicate or unsafe composite names.")
            with archive.open(info) as source, target.open("wb") as output:
                output.write(source.read(MAX_ZIP_MEMBER_BYTES + 1))
            if target.stat().st_size > MAX_ZIP_MEMBER_BYTES:
                raise AutomaticAnalysisError("A Stage A screenshot composite exceeded the safe image size limit.")
            extracted[target.name] = target
    if not extracted:
        raise AutomaticAnalysisError("Stage A screenshot archive contains no supported composite images.")
    return extracted


def function_schemas() -> list[dict[str, Any]]:
    no_args = {"type": "object", "properties": {}, "additionalProperties": False}
    return [
        {"name": "read_transcript", "description": "Read the timestamped transcript.json artifact first.", "parameters_json_schema": no_args},
        {"name": "read_scene_index", "description": "Read scene_index.json only after transcript.json.", "parameters_json_schema": no_args},
        {"name": "read_key_moments", "description": "Read key_moments.json only after transcript.json.", "parameters_json_schema": no_args},
        {
            "name": "open_composite",
            "description": "Open exactly one selected screenshot composite only after transcript, scene index, and key moments are read.",
            "parameters_json_schema": {
                "type": "object",
                "properties": {"filename": {"type": "string", "description": "Exact released composite basename."}},
                "required": ["filename"],
                "additionalProperties": False,
            },
        },
    ]


class EvidenceTools:
    """Strict, stateful implementation of the four permitted evidence functions."""

    def __init__(self, artifact_dir: Path, screenshot_dir: Path, composites: dict[str, Path]):
        self.artifact_dir = artifact_dir
        self.screenshot_dir = screenshot_dir.resolve()
        self.composites = composites
        self.transcript_read = False
        self.scene_index_read = False
        self.key_moments_read = False
        self.opened: set[str] = set()
        self.total_image_bytes = 0

    def _assert_order(self, name: str) -> None:
        if name == "read_transcript":
            if self.transcript_read:
                raise ToolProtocolError("read_transcript may be called only once.")
            return
        if not self.transcript_read:
            raise ToolProtocolError("The first tool call must be read_transcript.")
        if name in {"read_scene_index", "read_key_moments"}:
            if name == "read_scene_index" and self.scene_index_read:
                raise ToolProtocolError("read_scene_index may be called only once.")
            if name == "read_key_moments" and self.key_moments_read:
                raise ToolProtocolError("read_key_moments may be called only once.")
            return
        if name == "open_composite":
            if not (self.scene_index_read and self.key_moments_read):
                raise ToolProtocolError("open_composite requires both read_scene_index and read_key_moments first.")
            return
        raise ToolProtocolError("Unsupported Automatic Mode tool: " + name + ".")

    def call(self, name: str, arguments: dict[str, Any]) -> ToolResult:
        self._assert_order(name)
        if name == "read_transcript":
            self.transcript_read = True
            return ToolResult({"artifact": "transcript.json", "content": read_text_artifact(self.artifact_dir, "transcript.json", MAX_JSON_ARTIFACT_BYTES)})
        if name == "read_scene_index":
            self.scene_index_read = True
            return ToolResult({"artifact": "scene_index.json", "content": read_text_artifact(self.artifact_dir, "scene_index.json", MAX_JSON_ARTIFACT_BYTES)})
        if name == "read_key_moments":
            self.key_moments_read = True
            return ToolResult({"artifact": "key_moments.json", "content": read_text_artifact(self.artifact_dir, "key_moments.json", MAX_JSON_ARTIFACT_BYTES)})
        if name != "open_composite":
            raise ToolProtocolError("Unsupported Automatic Mode tool: " + name + ".")
        filename = arguments.get("filename")
        if not isinstance(filename, str) or not filename or Path(filename).name != filename:
            raise ToolProtocolError("open_composite requires one safe composite basename.")
        path = self.composites.get(filename)
        if path is None or path.resolve().parent != self.screenshot_dir:
            raise ToolProtocolError("open_composite may reference only a released screenshot composite basename.")
        if filename in self.opened:
            raise ToolProtocolError("The same screenshot composite may not be opened twice.")
        if len(self.opened) >= MAX_OPEN_COMPOSITES:
            raise ToolProtocolError("Automatic Mode reached its maximum selected composite count.")
        raw = path.read_bytes()
        if len(raw) > MAX_COMPOSITE_IMAGE_BYTES:
            raise ToolProtocolError("The selected composite exceeds the safe image byte limit.")
        if self.total_image_bytes + len(raw) > MAX_TOTAL_IMAGE_BYTES:
            raise ToolProtocolError("Automatic Mode reached its total image byte limit.")
        self.opened.add(filename)
        self.total_image_bytes += len(raw)
        mime_type = mimetypes.guess_type(filename)[0] or "image/png"
        return ToolResult(
            {"filename": filename, "mime_type": mime_type, "instruction": "Inspect the attached released screenshot composite."},
            image_bytes=raw,
            mime_type=mime_type,
            display_name=filename,
        )


class NativeGateway(Protocol):
    key_rotations: int

    def new_history(self, prompt: str) -> list[Any]: ...
    def append_user_text(self, history: list[Any], text: str) -> None: ...
    def generate(self, model: str, history: list[Any], *, tools_enabled: bool) -> NativeTurn: ...
    def append_tool_results(self, history: list[Any], turn: NativeTurn, results: list[tuple[NativeToolCall, ToolResult]]) -> None: ...


class GeminiGateway:
    """Official Google Gen AI SDK gateway with bounded secret-safe key rotation."""

    def __init__(self, keys: list[ApiKey], *, client_factory: Any | None = None, types_module: Any | None = None):
        if not keys:
            raise AutomaticAnalysisError("No Gemini API keys are configured. Add one in Repository settings first.")
        if types_module is None or client_factory is None:
            try:
                from google import genai
                from google.genai import types
            except ImportError as exc:
                raise AutomaticAnalysisError("The official google-genai package is unavailable on this runner.") from exc
            types_module = types_module or types
            client_factory = client_factory or (lambda key: genai.Client(api_key=key))
        self.types = types_module
        self.client_factory = client_factory
        self.keys = keys
        self.current_key_index = 0
        self.key_rotations = 0

    def _config(self, tools_enabled: bool) -> Any:
        if not tools_enabled:
            return self.types.GenerateContentConfig(max_output_tokens=6000, temperature=0.2)
        declarations = [self.types.FunctionDeclaration(**schema) for schema in function_schemas()]
        return self.types.GenerateContentConfig(
            tools=[self.types.Tool(function_declarations=declarations)],
            automatic_function_calling=self.types.AutomaticFunctionCallingConfig(disable=True),
            max_output_tokens=6000,
            temperature=0.2,
        )

    def new_history(self, prompt: str) -> list[Any]:
        return [self.types.Content(role="user", parts=[self.types.Part.from_text(text=prompt)])]

    def append_user_text(self, history: list[Any], text: str) -> None:
        history.append(self.types.Content(role="user", parts=[self.types.Part.from_text(text=text)]))

    def _native_turn(self, response: Any) -> NativeTurn:
        candidates = getattr(response, "candidates", None) or []
        if not candidates or not getattr(candidates[0], "content", None):
            raise ProviderRequestError(None, "malformed_response")
        calls: list[NativeToolCall] = []
        for call in getattr(response, "function_calls", None) or []:
            name = getattr(call, "name", None)
            call_id = getattr(call, "id", None)
            args = getattr(call, "args", None)
            if not isinstance(name, str) or not name or not isinstance(call_id, str) or not call_id or not isinstance(args, dict):
                raise ProviderRequestError(None, "malformed_function_call")
            calls.append(NativeToolCall(id=call_id, name=name, args=dict(args)))
        return NativeTurn(calls=calls, text=str(getattr(response, "text", "") or ""), model_content=candidates[0].content)

    def generate(self, model: str, history: list[Any], *, tools_enabled: bool) -> NativeTurn:
        attempted: set[int] = set()
        last_error: ProviderRequestError | None = None
        while len(attempted) < len(self.keys):
            index = self.current_key_index
            attempted.add(index)
            client = self.client_factory(self.keys[index].raw)
            try:
                # Keep a strong client reference until the SDK completes the request.
                # Chaining ``Client(...).models.generate_content(...)`` permits the
                # temporary client to be finalized and closed before its models proxy
                # actually sends the request.
                response = client.models.generate_content(
                    model=model, contents=history, config=self._config(tools_enabled)
                )
                return self._native_turn(response)
            except ProviderRequestError:
                raise
            except Exception as error:
                status = provider_error_status(error)
                category = provider_error_category(status, error)
                safe_log("Gemini key index " + str(index) + " failed with " + category + " (status=" + str(status or "none") + ").")
                safe_log(safe_provider_error_summary(error, status, category))
                last_error = ProviderRequestError(status, category)
                if not key_failure_should_rotate(status, category):
                    raise last_error from error
                self.current_key_index = (index + 1) % len(self.keys)
                self.key_rotations += 1
        raise AllKeysExhausted("All configured Gemini API keys failed with authentication or quota errors.") from last_error

    def append_tool_results(self, history: list[Any], turn: NativeTurn, results: list[tuple[NativeToolCall, ToolResult]]) -> None:
        history.append(turn.model_content)
        parts: list[Any] = []
        for call, result in results:
            multimodal_parts: list[Any] = []
            if result.image_bytes is not None:
                multimodal_parts.append(self.types.FunctionResponsePart(
                    inline_data=self.types.FunctionResponseBlob(
                        mime_type=result.mime_type,
                        display_name=result.display_name,
                        data=result.image_bytes,
                    )
                ))
            parts.append(self.types.Part.from_function_response(
                name=call.name,
                response={"result": result.response},
                parts=multimodal_parts or None,
            ))
        history.append(self.types.Content(role="user", parts=parts))


def extract_json_object(content: Any) -> tuple[dict[str, Any] | None, str]:
    text = str(content or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```\s*$", "", text)
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            parsed, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed, json.dumps(parsed, ensure_ascii=False, indent=2) + "\n"
    return None, ""


def agent_seed(seed: str, composite_names: Iterable[str]) -> str:
    listing = "\n".join("- " + name for name in sorted(composite_names)[:MAX_ZIP_ENTRIES])
    return (
        "You are ClipForge Automatic Mode. The text below is the complete Stage A instruction seed. "
        "Follow its editorial rules exactly. Use only the supplied native functions in this non-negotiable order: "
        "read_transcript first; then read_scene_index and read_key_moments; only then selectively call open_composite. "
        "Never request all composites. After sufficient evidence, return one valid production.json object as plain JSON. "
        "Do not invent facts or use unsupported evidence.\n\n"
        "===== 00_READ_THIS_FIRST.txt =====\n" + seed +
        "\n===== Released composite basenames (text catalog only) =====\n" + listing
    )


def run_tool_agent(gateway: NativeGateway, model: str, tools: EvidenceTools, seed: str) -> tuple[dict[str, Any], str, int, int]:
    history = gateway.new_history(agent_seed(seed, tools.composites.keys()))
    for turn_number in range(1, MAX_TOOL_TURNS + 1):
        turn = gateway.generate(model, history, tools_enabled=True)
        if not turn.calls:
            if not (tools.transcript_read and tools.scene_index_read and tools.key_moments_read):
                raise AutomaticAnalysisError("Automatic analysis attempted a plan before reading transcript, scene index, and key moments.")
            if not tools.opened:
                raise AutomaticAnalysisError("Automatic analysis attempted a plan without selectively opening a screenshot composite.")
            document, canonical = extract_json_object(turn.text)
            if document is None:
                raise AutomaticAnalysisError("Automatic analysis did not return a JSON production plan.")
            errors = parse_and_validate_production_plan(canonical)[1]
            if not errors:
                return document, canonical, turn_number, 0
            gateway.append_tool_results(history, turn, [])
            gateway.append_user_text(
                history,
                "Your proposed production.json failed the shared ClipForge validation contract. Return one corrected JSON object only. "
                "Do not call tools, do not add commentary, and do not broaden the story. Validation errors:\n- " + "\n- ".join(errors),
            )
            corrected = gateway.generate(model, history, tools_enabled=False)
            if corrected.calls:
                raise AutomaticAnalysisError("Automatic analysis ignored the bounded correction rule by requesting more tools.")
            corrected_document, corrected_canonical = extract_json_object(corrected.text)
            if corrected_document is None:
                raise AutomaticAnalysisError("Automatic analysis correction did not return JSON.")
            correction_errors = parse_and_validate_production_plan(corrected_canonical)[1]
            if correction_errors:
                raise AutomaticAnalysisError("Automatic analysis returned an invalid production plan after its one correction retry: " + "; ".join(correction_errors[:3]))
            return corrected_document, corrected_canonical, turn_number, MAX_CORRECTION_RETRIES

        names = [call.name for call in turn.calls]
        if not tools.transcript_read and (len(names) != 1 or names[0] != "read_transcript"):
            raise ToolProtocolError("The first agent turn must call only read_transcript.")
        if "open_composite" in names and not (tools.scene_index_read and tools.key_moments_read):
            raise ToolProtocolError("open_composite must occur only after both index tools returned in an earlier turn.")
        results: list[tuple[NativeToolCall, ToolResult]] = []
        for call in turn.calls:
            try:
                result = tools.call(call.name, call.args)
            except ToolProtocolError as error:
                result = ToolResult({"error": str(error), "retry_within_remaining_tool_turns": True})
            results.append((call, result))
        gateway.append_tool_results(history, turn, results)
    raise AutomaticAnalysisError("Automatic analysis exceeded its bounded tool-turn limit.")


def model_candidates(primary: str, fallbacks: Iterable[str]) -> list[str]:
    values = [primary, *fallbacks]
    return list(dict.fromkeys(value.strip() for value in values if value and value.strip()))


def run_analysis(
    artifact_dir: Path,
    key_secret: str | None,
    *,
    gateway: NativeGateway | None = None,
    primary_model: str = DEFAULT_PRIMARY_MODEL,
    fallback_models: Iterable[str] = DEFAULT_FALLBACK_MODELS,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    """Run direct Gemini API Automatic Mode with native functions and images only."""
    artifact_dir = artifact_dir.resolve()
    seed = read_text_artifact(artifact_dir, "00_READ_THIS_FIRST.txt", MAX_SEED_BYTES)
    active_gateway = gateway or GeminiGateway(parse_api_keys(key_secret))
    with tempfile.TemporaryDirectory(prefix="clipforge_auto_screenshots_") as temp_dir:
        screenshot_dir = Path(temp_dir).resolve()
        composites = safe_extract_screenshots(
            strict_artifact_path(artifact_dir, "screenshots.zip", MAX_ZIP_TOTAL_BYTES), screenshot_dir
        )
        last_error: Exception | None = None
        candidates = model_candidates(primary_model, fallback_models)
        for model_index, model in enumerate(candidates):
            tools = EvidenceTools(artifact_dir, screenshot_dir, composites)
            try:
                document, text, turns, corrections = run_tool_agent(active_gateway, model, tools, seed)
                return document, text, {
                    "version": 2,
                    "provider": "gemini-developer-api",
                    "model": model,
                    "model_route": "primary" if model_index == 0 else "fallback",
                    "tool_turns": turns,
                    "opened_composites": len(tools.opened),
                    "validation_corrections": corrections,
                    "key_rotations": int(getattr(active_gateway, "key_rotations", 0)),
                }
            except (ProviderRequestError, AllKeysExhausted) as error:
                last_error = error
                if model_index + 1 < len(candidates) and getattr(error, "category", "") in {
                    "model_or_request", "provider_server", "network", "rate_or_quota"
                }:
                    safe_log("Gemini model route failed safely; trying configured fallback model.")
                    continue
                raise
        raise AutomaticAnalysisError("All configured Gemini model routes failed.") from last_error


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ClipForge Automatic Mode analysis from a Stage A release bundle.")
    parser.add_argument("--artifacts-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Validated production.json output path")
    parser.add_argument("--result-path", required=True, type=Path, help="Non-secret run summary JSON output path")
    parser.add_argument("--key-env", default="GEMINI_API_KEYS")
    parser.add_argument("--primary-model", default=os.environ.get("GEMINI_ANALYSIS_PRIMARY_MODEL", DEFAULT_PRIMARY_MODEL))
    parser.add_argument("--fallback-models", default=os.environ.get("GEMINI_ANALYSIS_FALLBACK_MODELS", ",".join(DEFAULT_FALLBACK_MODELS)))
    args = parser.parse_args()
    try:
        document, canonical, summary = run_analysis(
            args.artifacts_dir,
            os.environ.get(args.key_env),
            primary_model=args.primary_model,
            fallback_models=args.fallback_models.split(","),
        )
        if document != json.loads(canonical):
            raise AutomaticAnalysisError("Validated production-plan serialization changed unexpectedly.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(canonical, encoding="utf-8")
        args.result_path.parent.mkdir(parents=True, exist_ok=True)
        args.result_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        safe_log("Automatic analysis completed with " + summary["model_route"] + " model route after " + str(summary["tool_turns"]) + " tool turns.")
        return 0
    except AutomaticAnalysisError as error:
        print("Automatic analysis failed: " + str(error), file=os.sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
