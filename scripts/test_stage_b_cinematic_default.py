#!/usr/bin/env python3
"""Static routing checks for the Stage B cinematic default."""
from pathlib import Path

workflow = (Path(__file__).resolve().parents[1] / ".github" / "workflows" / "stage-b.yml").read_text(encoding="utf-8")

assert 'default: "cinematic"' in workflow
assert "SUBTITLE_MODE: ${{ github.event.inputs.subtitle_mode || 'cinematic' }}" in workflow
assert 'case "$SUBTITLE_MODE" in' in workflow
assert 'cinematic) SUB_SCRIPT=scripts/generate_subtitles_cinematic.py ;;' in workflow
assert 'word)      SUB_SCRIPT=scripts/generate_subtitles.py ;;' in workflow
assert "FATAL: unsupported subtitle_mode '$SUBTITLE_MODE'" in workflow
assert "${SUBTITLE_MODE:-word}" not in workflow
assert "${{ (github.event.inputs.subtitle_mode || 'cinematic') != 'cinematic' }}" in workflow
print("PASS: Stage B defaults omitted subtitle_mode to cinematic and rejects invalid legacy fallbacks")
