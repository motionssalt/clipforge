#!/usr/bin/env python3
"""Regression checks for importing a production.json plan into ClipForge."""
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "app.js").read_text(encoding="utf-8")
HTML = (ROOT / "index.html").read_text(encoding="utf-8")


# Production plans are parsed from text, so their extension must not limit an
# otherwise-valid JSON document selected through the browser's file picker.
assert 'id="cuts-file-input"' in HTML
assert 'accept="application/json,.json,text/plain,.txt"' in HTML
assert "reader.readAsText(file)" in APP
assert "parsed = JSON.parse(raw)" in APP
assert "var errors = validateCuts(parsed)" in APP
assert "state.validatedCuts = raw" in APP
assert "el['start-stage-b'].disabled = false" in APP

print("PASS: .json and .txt production-plan files share the existing text validation path")
