#!/usr/bin/env python3
"""Unattended ClipForge analysis agent for the Automatic Mode handoff.

The runner receives Stage A release assets locally, seeds a Puter OpenAI-
compatible tool conversation with ``00_READ_THIS_FIRST.txt``, and permits the
model to inspect evidence only in the required order:

1. transcript; 2. scene index and key moments; 3. selectively chosen screenshot
composites. It never sends the entire screenshot archive as one giant prompt.

Security properties:
- Puter tokens are read only from the ``PUTER_AUTH_TOKENS`` Actions secret.
- Tokens are never printed, committed, included in exceptions, or placed in
  result artifacts. Runner logs may identify only a zero-based token index.
- Screenshot zip paths, entry count, decompressed bytes, image bytes, number
  of opens, and total data-url bytes are bounded before any image is supplied
  to the provider.
- production.json is written only after the same portable contract consumed by
  the browser's manual-import flow accepts it.
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from production_plan_contract import parse_and_validate_production_plan


MODEL_CATALOG_ENDPOINT = "https://api.puter.com/puterai/chat/models/details"
OPENAI_BASE_URL = "https://api.puter.com/puterai/openai/v1/"
DEFAULT_PRIMARY_MODEL = "anthropic/claude-opus-4-7"
DEFAULT_FALLBACK_MODEL = "openai/gpt-5.6-terra"
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
    """The model tried an unsupported or out-of-order evidence operation."""


class AllTokensExhausted(AutomaticAnalysisError):
    """Every configured token failed on an auth/rate/quota category response."""


class ProviderRequestError(AutomaticAnalysisError):
    """Safe provider error metadata, intentionally without response body text."""

    def __init__(self, status: int | None, category: str):
        self.status = status
        self.category = category
        status_text = str(status) if status is not None else "network"
        super().__init__(f"Puter provider request failed ({status_text}; {category}).")


@dataclass(frozen=True)
class HttpResponse:
    status: int
    payload: dict[str, Any]


Transport = Callable[[str, str, dict[str, str], dict[str, Any] | None], HttpResponse]


def safe_json_payload(raw: bytes) -> dict[str, Any]:
    """Parse JSON only when it is object-shaped; do not return raw provider text."""
    try:
        value = json.loads(raw.decode("utf-8", errors="replace"))
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def default_transport(method: str, url: str, headers: dict[str, str], body: dict[str, Any] | None) -> HttpResponse:
    """Make a JSON request without ever including headers/body in raised errors."""
    encoded = None if body is None else json.dumps(body).encode("utf-8")
    request = Request(url, data=encoded, headers=headers, method=method)
    try:
        with urlopen(request, timeout=90) as response:  # nosec B310: user-configurable trusted provider endpoint
            return HttpResponse(int(response.status), safe_json_payload(response.read()))
    except HTTPError as exc:
        return HttpResponse(int(exc.code), safe_json_payload(exc.read()))
    except URLError as exc:
        raise ProviderRequestError(None, "network") from exc


def provider_error_category(status: int | None, payload: dict[str, Any]) -> str:
    """Classify failures from status and generic error labels, never log payload."""
    error_value = payload.get("error", "")
    if isinstance(error_value, dict):
        error_value = " ".join(str(error_value.get(key, "")) for key in ("code", "type", "message"))
    haystack = str(error_value).lower()
    if status in (401, 403) or "auth" in haystack or "invalid token" in haystack or "unauthor" in haystack:
        return "authentication"
    if status == 429 or "rate" in haystack or "quota" in haystack or "credit" in haystack or "limit" in haystack:
        return "rate_or_quota"
    if status in (400, 404, 422) or "model" in haystack:
        return "model_or_request"
    if status is not None and status >= 500:
        return "provider_server"
    return "provider_request"


def token_failure_should_rotate(status: int | None, category: str) -> bool:
    return status in (401, 403, 429) or category in {"authentication", "rate_or_quota"}


def parse_tokens(raw: str | None) -> list[str]:
    """Accept newline/comma separated secrets, preserving order and removing duplicates."""
    pieces = re.split(r"[\r\n,]+", raw or "")
    tokens: list[str] = []
    seen: set[str] = set()
    for piece in pieces:
        token = piece.strip()
        if token and token not in seen:
            tokens.append(token)
            seen.add(token)
    return tokens


def safe_log(message: str) -> None:
    """Emit only static/safe telemetry. Callers must never pass provider bodies or tokens."""
    print(message, flush=True)


def model_values(entry: dict[str, Any]) -> set[str]:
    values = {str(entry.get("id", "")).strip(), str(entry.get("puterId", "")).strip()}
    aliases = entry.get("aliases")
    if isinstance(aliases, list):
        values.update(str(alias).strip() for alias in aliases)
    return {value for value in values if value}


def supports_tools_and_images(entry: dict[str, Any]) -> bool:
    modalities = entry.get("modalities")
    inputs = modalities.get("input", []) if isinstance(modalities, dict) else []
    normalized_inputs = {str(item).lower() for item in inputs} if isinstance(inputs, list) else set()
    return entry.get("tool_call") is True and "image" in normalized_inputs


def discover_compatible_models(
    catalog: dict[str, Any],
    primary: str,
    fallback: str,
) -> list[str]:
    """Return ordered configured candidates proven by live catalog metadata."""
    entries = catalog.get("models")
    if not isinstance(entries, list):
        raise AutomaticAnalysisError("Puter model catalog did not return a models list.")
    compatible: list[str] = []
    for candidate in (primary, fallback):
        matched = [entry for entry in entries if isinstance(entry, dict) and candidate in model_values(entry)]
        if any(supports_tools_and_images(entry) for entry in matched):
            compatible.append(candidate)
        else:
            safe_log("Puter model candidate unavailable or missing required image/tool capability: " + candidate)
    if not compatible:
        raise AutomaticAnalysisError(
            "No configured Puter model is currently available with both image input and function calling."
        )
    return compatible


def fetch_model_catalog(transport: Transport, endpoint: str) -> dict[str, Any]:
    response = transport("GET", endpoint, {"Accept": "application/json"}, None)
    if response.status < 200 or response.status >= 300:
        raise AutomaticAnalysisError(f"Could not load Puter model capabilities (HTTP {response.status}).")
    return response.payload


def strict_artifact_path(root: Path, filename: str, maximum: int) -> Path:
    """Resolve a named Stage A JSON file without traversal or oversized reads."""
    target = (root / filename).resolve()
    if target.parent != root.resolve() or not target.is_file():
        raise AutomaticAnalysisError(f"Required Stage A artifact is unavailable: {filename}.")
    if target.stat().st_size > maximum:
        raise AutomaticAnalysisError(f"Stage A artifact exceeds the safe size limit: {filename}.")
    return target


def read_text_artifact(root: Path, filename: str, maximum: int) -> str:
    return strict_artifact_path(root, filename, maximum).read_text(encoding="utf-8")


def safe_extract_screenshots(zip_path: Path, destination: Path) -> dict[str, Path]:
    """Extract bounded image-only screenshot composites with traversal protection."""
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
            suffix = member.suffix.lower()
            if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
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


def tool_specs() -> list[dict[str, Any]]:
    """OpenAI-compatible function definitions exposed to the analysis model."""
    no_args = {"type": "object", "properties": {}, "additionalProperties": False}
    return [
        {"type": "function", "function": {"name": "read_transcript", "description": "Read the timestamped transcript.json artifact first.", "parameters": no_args}},
        {"type": "function", "function": {"name": "read_scene_index", "description": "Read scene_index.json only after transcript.json.", "parameters": no_args}},
        {"type": "function", "function": {"name": "read_key_moments", "description": "Read key_moments.json only after transcript.json.", "parameters": no_args}},
        {
            "type": "function",
            "function": {
                "name": "open_composite",
                "description": "Open one selected local screenshot composite only after transcript, scene index, and key moments have been read.",
                "parameters": {
                    "type": "object",
                    "properties": {"filename": {"type": "string", "description": "Exact basename of a selected composite image."}},
                    "required": ["filename"],
                    "additionalProperties": False,
                },
            },
        },
    ]


class EvidenceTools:
    """Strict, stateful implementation of the four allowed evidence tools."""

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

    def call(self, name: str, arguments: dict[str, Any]) -> str:
        self._assert_order(name)
        if name == "read_transcript":
            self.transcript_read = True
            return read_text_artifact(self.artifact_dir, "transcript.json", MAX_JSON_ARTIFACT_BYTES)
        if name == "read_scene_index":
            self.scene_index_read = True
            return read_text_artifact(self.artifact_dir, "scene_index.json", MAX_JSON_ARTIFACT_BYTES)
        if name == "read_key_moments":
            self.key_moments_read = True
            return read_text_artifact(self.artifact_dir, "key_moments.json", MAX_JSON_ARTIFACT_BYTES)
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
        media_type = mimetypes.guess_type(filename)[0] or "image/png"
        data_url = "data:" + media_type + ";base64," + base64.b64encode(raw).decode("ascii")
        # The content is a tool result (not a hosted URL); the data URL carries
        # the exact image bytes so a vision-capable model can inspect it.
        return json.dumps({"filename": filename, "mime_type": media_type, "image_data_url": data_url})


def parse_tool_arguments(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        raise ToolProtocolError("Automatic Mode tool arguments were not JSON.")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ToolProtocolError("Automatic Mode tool arguments were not valid JSON.") from exc
    if not isinstance(parsed, dict):
        raise ToolProtocolError("Automatic Mode tool arguments must be an object.")
    return parsed


def normalize_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    calls = message.get("tool_calls")
    if not calls:
        return []
    if not isinstance(calls, list):
        raise ToolProtocolError("Provider returned malformed tool_calls.")
    normalized: list[dict[str, Any]] = []
    for call in calls:
        if not isinstance(call, dict):
            raise ToolProtocolError("Provider returned malformed tool call.")
        function = call.get("function")
        if not isinstance(function, dict) or not isinstance(function.get("name"), str):
            raise ToolProtocolError("Provider returned a tool call without a function name.")
        call_id = call.get("id")
        if not isinstance(call_id, str) or not call_id:
            raise ToolProtocolError("Provider returned a tool call without an id.")
        normalized.append(call)
    return normalized


def extract_json_object(content: Any) -> tuple[dict[str, Any] | None, str]:
    """Extract the first valid object from plain or fenced model text."""
    if isinstance(content, list):
        content = "".join(str(part.get("text", "")) if isinstance(part, dict) else str(part) for part in content)
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


class PuterGateway:
    """Puter OpenAI-compatible gateway with bounded token-index rotation."""

    def __init__(self, tokens: list[str], transport: Transport = default_transport, base_url: str = OPENAI_BASE_URL):
        if not tokens:
            raise AutomaticAnalysisError("No Puter auth tokens are configured. Add one in Settings first.")
        self.tokens = tokens
        self.transport = transport
        self.base_url = base_url.rstrip("/") + "/"
        self.current_token_index = 0

    def chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        last_error: ProviderRequestError | None = None
        attempted_indices: set[int] = set()
        while len(attempted_indices) < len(self.tokens):
            index = self.current_token_index
            attempted_indices.add(index)
            headers = {
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": "Bearer " + self.tokens[index],
            }
            response = self.transport("POST", self.base_url + "chat/completions", headers, payload)
            if 200 <= response.status < 300:
                choices = response.payload.get("choices")
                if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
                    raise ProviderRequestError(response.status, "malformed_response")
                message = choices[0].get("message")
                if not isinstance(message, dict):
                    raise ProviderRequestError(response.status, "malformed_response")
                return message
            category = provider_error_category(response.status, response.payload)
            error = ProviderRequestError(response.status, category)
            if not token_failure_should_rotate(response.status, category):
                raise error
            last_error = error
            safe_log("Puter token index " + str(index) + " hit " + category + "; rotating token index.")
            self.current_token_index = (index + 1) % len(self.tokens)
        raise AllTokensExhausted(
            "All configured Puter tokens failed with authentication, rate-limit, or quota errors."
        ) from last_error


def agent_seed(seed: str, composite_names: Iterable[str]) -> str:
    # Listing filenames is text-only catalog data. No image is attached until the
    # model selectively calls open_composite after it has read both indexes.
    names = sorted(composite_names)
    listing = "\n".join("- " + name for name in names[:MAX_ZIP_ENTRIES])
    return (
        "You are ClipForge Automatic Mode. The text below is the complete Stage A "
        "instruction seed. Follow its editorial rules exactly. You must use tools in "
        "this non-negotiable order: read_transcript first; then read_scene_index and "
        "read_key_moments; only then selectively call open_composite. Never request "
        "all composites. Once evidence is sufficient, return a valid production.json "
        "object and no unsupported claims.\n\n"
        "===== 00_READ_THIS_FIRST.txt =====\n" + seed +
        "\n===== Released composite basenames (text catalog only) =====\n" + listing
    )


def run_tool_agent(gateway: PuterGateway, model: str, tools: EvidenceTools, seed: str) -> tuple[dict[str, Any], str, int, int]:
    """Run one model with strict tool protocol and at most one validation correction."""
    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": "You are a careful video editor. Use only supplied tool evidence; do not invent facts. "
            "You must return a JSON production plan after the allowed tool sequence.",
        },
        {"role": "user", "content": agent_seed(seed, tools.composites.keys())},
    ]
    for turn in range(1, MAX_TOOL_TURNS + 1):
        message = gateway.chat({
            "model": model,
            "messages": messages,
            "tools": tool_specs(),
            "tool_choice": "auto",
            "temperature": 0.2,
            "max_tokens": 6000,
        })
        calls = normalize_tool_calls(message)
        messages.append({
            "role": "assistant",
            "content": message.get("content") or "",
            "tool_calls": calls,
        })
        if not calls:
            if not (tools.transcript_read and tools.scene_index_read and tools.key_moments_read):
                raise AutomaticAnalysisError(
                    "Automatic analysis attempted to return a plan before reading transcript, scene index, and key moments."
                )
            if not tools.opened:
                raise AutomaticAnalysisError(
                    "Automatic analysis attempted to return a plan without selectively opening any screenshot composite."
                )
            document, canonical = extract_json_object(message.get("content"))
            if document is None:
                raise AutomaticAnalysisError("Automatic analysis did not return a JSON production plan.")
            errors = parse_and_validate_production_plan(canonical)[1]
            if not errors:
                return document, canonical, turn, 0
            correction_prompt = (
                "Your proposed production.json failed the shared ClipForge validation contract. "
                "Return one corrected JSON object only. Do not call tools, do not broaden the story, and do not add commentary. "
                "Validation errors:\n- " + "\n- ".join(errors)
            )
            messages.append({"role": "user", "content": correction_prompt})
            corrected = gateway.chat({
                "model": model,
                "messages": messages,
                "tool_choice": "none",
                "temperature": 0,
                "max_tokens": 6000,
            })
            if normalize_tool_calls(corrected):
                raise AutomaticAnalysisError("Automatic analysis ignored the bounded correction rule by requesting more tools.")
            corrected_document, corrected_canonical = extract_json_object(corrected.get("content"))
            if corrected_document is None:
                raise AutomaticAnalysisError("Automatic analysis correction did not return JSON.")
            correction_errors = parse_and_validate_production_plan(corrected_canonical)[1]
            if correction_errors:
                raise AutomaticAnalysisError(
                    "Automatic analysis returned an invalid production plan after its one correction retry: " +
                    "; ".join(correction_errors[:3])
                )
            return corrected_document, corrected_canonical, turn, MAX_CORRECTION_RETRIES

        # The sequence must be genuinely multi-turn: a model cannot bundle
        # transcript + indexes or indexes + image opens into one response and
        # pretend it had already considered the prior tool result.
        call_names = [call["function"]["name"] for call in calls]
        if not tools.transcript_read and (len(call_names) != 1 or call_names[0] != "read_transcript"):
            raise ToolProtocolError("The first agent turn must call only read_transcript.")
        if "open_composite" in call_names and not (tools.scene_index_read and tools.key_moments_read):
            raise ToolProtocolError("open_composite must occur in a later turn after both index tools return.")

        for call in calls:
            function = call["function"]
            name = function["name"]
            result = tools.call(name, parse_tool_arguments(function.get("arguments", "{}")))
            messages.append({
                "role": "tool",
                "tool_call_id": call["id"],
                "name": name,
                "content": result,
            })
    raise AutomaticAnalysisError("Automatic analysis exceeded its bounded tool-turn limit.")


def run_analysis(
    artifact_dir: Path,
    token_secret: str | None,
    *,
    transport: Transport = default_transport,
    catalog_endpoint: str = MODEL_CATALOG_ENDPOINT,
    base_url: str = OPENAI_BASE_URL,
    primary_model: str = DEFAULT_PRIMARY_MODEL,
    fallback_model: str = DEFAULT_FALLBACK_MODEL,
) -> tuple[dict[str, Any], str, dict[str, Any]]:
    """Run Automatic Mode from local release assets and return plan, text, safe summary."""
    artifact_dir = artifact_dir.resolve()
    seed = read_text_artifact(artifact_dir, "00_READ_THIS_FIRST.txt", MAX_SEED_BYTES)
    tokens = parse_tokens(token_secret)
    catalog = fetch_model_catalog(transport, catalog_endpoint)
    models = discover_compatible_models(catalog, primary_model, fallback_model)
    gateway = PuterGateway(tokens, transport=transport, base_url=base_url)

    with tempfile.TemporaryDirectory(prefix="clipforge_auto_screenshots_") as temp_dir:
        screenshot_dir = Path(temp_dir).resolve()
        zip_path = strict_artifact_path(artifact_dir, "screenshots.zip", MAX_ZIP_TOTAL_BYTES)
        composites = safe_extract_screenshots(zip_path, screenshot_dir)
        last_model_error: Exception | None = None
        for model_index, model in enumerate(models):
            tools = EvidenceTools(artifact_dir, screenshot_dir, composites)
            try:
                document, text, turns, corrections = run_tool_agent(gateway, model, tools, seed)
                return document, text, {
                    "version": 1,
                    "model": model,
                    "model_route": "primary" if model_index == 0 else "fallback",
                    "tool_turns": turns,
                    "opened_composites": len(tools.opened),
                    "validation_corrections": corrections,
                }
            except AllTokensExhausted:
                raise
            except ProviderRequestError as exc:
                last_model_error = exc
                if model_index + 1 < len(models) and exc.category in {"model_or_request", "provider_server", "network"}:
                    safe_log("Puter model route failed safely; trying configured fallback model.")
                    continue
                raise
        raise AutomaticAnalysisError("All compatible Puter model routes failed.") from last_model_error


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ClipForge Automatic Mode analysis from a Stage A release bundle.")
    parser.add_argument("--artifacts-dir", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Validated production.json output path")
    parser.add_argument("--result-path", required=True, type=Path, help="Non-secret run summary JSON output path")
    parser.add_argument("--token-env", default="PUTER_AUTH_TOKENS")
    parser.add_argument("--catalog-endpoint", default=os.environ.get("PUTER_MODELS_ENDPOINT", MODEL_CATALOG_ENDPOINT))
    parser.add_argument("--base-url", default=os.environ.get("PUTER_OPENAI_BASE_URL", OPENAI_BASE_URL))
    parser.add_argument("--primary-model", default=os.environ.get("PUTER_PRIMARY_MODEL", DEFAULT_PRIMARY_MODEL))
    parser.add_argument("--fallback-model", default=os.environ.get("PUTER_FALLBACK_MODEL", DEFAULT_FALLBACK_MODEL))
    args = parser.parse_args()

    try:
        document, canonical, summary = run_analysis(
            args.artifacts_dir,
            os.environ.get(args.token_env),
            catalog_endpoint=args.catalog_endpoint,
            base_url=args.base_url,
            primary_model=args.primary_model,
            fallback_model=args.fallback_model,
        )
        # Canonical text has been validated immediately before this write; the
        # parsed object is retained only to make accidental format drift obvious.
        if document != json.loads(canonical):
            raise AutomaticAnalysisError("Validated production-plan serialization changed unexpectedly.")
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(canonical, encoding="utf-8")
        args.result_path.parent.mkdir(parents=True, exist_ok=True)
        args.result_path.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        safe_log("Automatic analysis completed with " + summary["model_route"] + " model route after " + str(summary["tool_turns"]) + " tool turns.")
        return 0
    except AutomaticAnalysisError as exc:
        print("Automatic analysis failed: " + str(exc), file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
