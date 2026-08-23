#!/usr/bin/env python3
"""Regression checks for browser-side Puter Automatic Mode credential handling.

This test intentionally uses no real or synthetic credential value. It verifies
that raw values have only the encrypted GitHub Actions secret path while the
repository metadata and rendered UI remain fingerprint-only.
"""

from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
APP = (ROOT / "app.js").read_text(encoding="utf-8")
META = json.loads((ROOT / "branding" / "puter_keys.json").read_text(encoding="utf-8"))


assert "var PUTER_SECRET_NAME = 'PUTER_AUTH_TOKENS';" in APP
assert "var PUTER_KEYS_META_PATH = 'branding/puter_keys.json';" in APP
assert "function puterFingerprint(token)" in APP
assert "function validatePuterToken(token)" in APP
assert "async function loadPuterKeysMeta()" in APP
assert "async function persistPuterTokens(rawTokens, metaEntries)" in APP
assert "async function addPuterToken()" in APP
assert "async function deletePuterToken(fingerprint)" in APP
assert "rawTokens.join('\\n')" in APP
assert "encryptForActionsSecret(joined, pk.key)" in APP
assert "PUTER_AUTH_TOKENS secret with only this new token" in APP
assert "GitHub never returns secret values" in APP
assert "note: 'Masked fingerprints only. Raw Puter auth tokens live in the PUTER_AUTH_TOKENS repo secret and are never committed.'" in APP
assert "loadPuterKeysMeta();" in APP

assert META["version"] == 1
assert isinstance(META["keys"], list)
assert "Masked fingerprints only" in META["note"]
assert "PUTER_AUTH_TOKENS" in META["note"]
for entry in META["keys"]:
    assert set(entry).issubset({"fingerprint", "added_at_epoch"})
    assert isinstance(entry.get("fingerprint"), str) and "…" in entry["fingerprint"]
    assert isinstance(entry.get("added_at_epoch"), int)

for page in ("index.html", "new-task.html", "settings.html", "task.html"):
    html = (ROOT / page).read_text(encoding="utf-8")
    for required in (
        'id="puter-keys-disclosure"',
        'id="puter-key-form"',
        'id="puter-key-input"',
        'type="password"',
        'id="puter-key-reveal"',
        'id="puter-key-add"',
        'id="puter-keys-list"',
        'id="puter-keys-empty"',
        "PUTER_AUTH_TOKENS",
    ):
        assert required in html, f"{page} missing Puter control: {required}"

print("PASS: Puter tokens use encrypted Actions-secret storage with fingerprint-only repository metadata")
