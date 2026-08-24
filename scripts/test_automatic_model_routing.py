#!/usr/bin/env python3
"""Regression checks for cost-safe Automatic Mode model routing."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
RUNNER = (ROOT / "scripts" / "automatic_analysis.py").read_text(encoding="utf-8")
WORKFLOW = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")

assert 'DEFAULT_PRIMARY_MODEL = "google/gemini-3.6-flash"' in RUNNER
assert 'DEFAULT_FALLBACK_MODEL = "openai/gpt-5.6-terra"' in RUNNER
assert "claude-opus" not in RUNNER.lower()
assert "anthropic/claude" not in RUNNER.lower()
assert "PUTER_PRIMARY_MODEL" not in WORKFLOW
assert "PUTER_FALLBACK_MODEL" not in WORKFLOW

# Dynamic catalog proof remains required; a hard-coded route alone is never
# enough to run the tool-and-image Automatic Mode loop.
for required in (
    "gateway.list_models()",
    "PuterBrowserGateway",
    "discover_compatible_models",
    "supports_tools_and_images",
    'entry.get("tool_call") is True',
    '"image" in normalized_inputs',
):
    assert required in RUNNER, f"missing capability gate: {required}"

for page in ("index.html", "new-task.html", "settings.html", "task.html", "automatic.html"):
    text = (ROOT / page).read_text(encoding="utf-8")
    assert "Claude-first" not in text
    assert "Gemini Flash" in text

assert "api.puter.com/puterai/openai/v1" not in RUNNER
assert "urlopen(" not in RUNNER
print("PASS: Automatic Mode defaults to Gemini 3.6 Flash with a non-Opus fallback, browser-side capability gating, and no direct HTTP transport")
