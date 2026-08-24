#!/usr/bin/env python3
"""Capture safe diagnostic evidence for a Puter model-call rejection.

This tool makes at most one minimal, one-token response request per configured
model. It writes only a redacted report: configured tokens, authorization
headers, credentials, cookies, and any sensitive JSON field values are removed
before the report ever reaches workflow logs or artifacts.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


CATALOG_ENDPOINT = "https://api.puter.com/puterai/chat/models/details"
OPENAI_BASE_URL = "https://api.puter.com/puterai/openai/v1/"
SENSITIVE_KEY = re.compile(r"(?:token|authorization|secret|password|api[_-]?key|cookie|session)", re.I)
BEARER_VALUE = re.compile(r"(?i)(bearer\s+)[^\s\",}]+")


def parse_tokens(raw: str | None) -> list[str]:
    values = re.split(r"[\r\n,]+", raw or "")
    output: list[str] = []
    seen: set[str] = set()
    for value in values:
        token = value.strip()
        if token and token not in seen:
            output.append(token)
            seen.add(token)
    return output


def redact_value(value: Any, secrets: list[str]) -> Any:
    if isinstance(value, dict):
        return {
            str(key): "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redact_value(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item, secrets) for item in value]
    if not isinstance(value, str):
        return value
    result = value
    for secret in secrets:
        if secret:
            result = result.replace(secret, "[REDACTED]")
    return BEARER_VALUE.sub(r"\1[REDACTED]", result)


def redact_body(raw: bytes, secrets: list[str]) -> Any:
    text = raw.decode("utf-8", errors="replace")
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[REDACTED]")
    try:
        return redact_value(json.loads(text), secrets)
    except json.JSONDecodeError:
        return BEARER_VALUE.sub(r"\1[REDACTED]", text)


def request(method: str, url: str, headers: dict[str, str], body: dict[str, Any] | None) -> tuple[int, bytes]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=60) as response:  # nosec B310: fixed Puter endpoints only
            return int(response.status), response.read()
    except HTTPError as exc:
        return int(exc.code), exc.read()
    except URLError as exc:
        return 0, str(exc).encode("utf-8", errors="replace")


def model_values(entry: dict[str, Any]) -> set[str]:
    values = {str(entry.get("id", "")).strip(), str(entry.get("puterId", "")).strip()}
    aliases = entry.get("aliases")
    if isinstance(aliases, list):
        values.update(str(alias).strip() for alias in aliases)
    return {value for value in values if value}


def safe_catalog_match(entry: dict[str, Any]) -> dict[str, Any]:
    return {
        key: entry.get(key)
        for key in ("id", "puterId", "name", "provider", "aliases", "modalities", "tool_call", "context", "max_tokens", "responses_api_only")
        if key in entry
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a redacted, bounded Puter 402 diagnostic.")
    parser.add_argument("--token-env", default="PUTER_AUTH_TOKENS")
    parser.add_argument("--catalog-endpoint", default=CATALOG_ENDPOINT)
    parser.add_argument("--base-url", default=OPENAI_BASE_URL)
    parser.add_argument("--model", action="append", required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    tokens = parse_tokens(os.environ.get(args.token_env))
    if not tokens:
        raise SystemExit("No Puter token is configured; no diagnostic request was sent.")

    catalog_status, catalog_raw = request("GET", args.catalog_endpoint, {"Accept": "application/json"}, None)
    try:
        catalog = json.loads(catalog_raw.decode("utf-8"))
    except json.JSONDecodeError:
        catalog = {}
    entries = catalog.get("models", []) if isinstance(catalog, dict) else []
    entries = entries if isinstance(entries, list) else []

    report: dict[str, Any] = {
        "version": 1,
        "token_count": len(tokens),
        "catalog": {
            "http_status": catalog_status,
            "model_count": len(entries),
            "requested_model_matches": {},
        },
        "requests": [],
        "redaction": "All token, authorization, cookie, password, secret, session, and API-key values are redacted.",
    }
    for model in args.model:
        report["catalog"]["requested_model_matches"][model] = [
            safe_catalog_match(entry)
            for entry in entries
            if isinstance(entry, dict) and model in model_values(entry)
        ]

    endpoint = args.base_url.rstrip("/") + "/chat/completions"
    for index, token in enumerate(tokens):
        for model in args.model:
            status, raw = request(
                "POST",
                endpoint,
                {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + token,
                },
                {
                    "model": model,
                    "messages": [{"role": "user", "content": "Reply with exactly OK."}],
                    "max_tokens": 1,
                    "temperature": 0,
                },
            )
            report["requests"].append({
                "token_index": index,
                "model": model,
                "http_status": status,
                "response_body_redacted": redact_body(raw, tokens),
            })

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
