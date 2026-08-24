#!/usr/bin/env python3
"""Static and pure-function coverage for the redacted Puter 402 diagnostic."""

from pathlib import Path

from puter_402_diagnostic import parse_tokens, redact_body, redact_value


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = (ROOT / "scripts" / "puter_402_diagnostic.py").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "puter-diagnostic.yml").read_text(encoding="utf-8")

assert parse_tokens(" one, two\none\n") == ["one", "two"]
secret = "very-private-token"
redacted = redact_body(
    b'{"error":{"message":"Bearer very-private-token denied","api_key":"very-private-token","detail":"keep this reason"}}',
    [secret],
)
assert redacted["error"]["message"] == "Bearer [REDACTED] denied"
assert redacted["error"]["api_key"] == "[REDACTED]"
assert redacted["error"]["detail"] == "keep this reason"
assert secret not in str(redacted)
assert redact_value({"session": "x", "reason": "model tier disabled"}, []) == {
    "session": "[REDACTED]", "reason": "model tier disabled"
}

for required in (
    "token_index",
    "requested_model_matches",
    "response_body_redacted",
    '"Reply with exactly OK."',
    "max_tokens\": 1",
    "All token, authorization, cookie, password, secret, session, and API-key values are redacted.",
):
    assert required in SCRIPT, f"missing diagnostic safeguard: {required}"

for required in (
    "workflow_dispatch:",
    "PUTER_AUTH_TOKENS: ${{ secrets.PUTER_AUTH_TOKENS }}",
    "scripts/puter_402_diagnostic.py",
    "puter-diagnostic-redacted",
    "retention-days: 1",
):
    assert required in WORKFLOW, f"missing workflow safeguard: {required}"

print("PASS: Puter 402 diagnostic probes exact models and redacts provider-body credentials")
