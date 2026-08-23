#!/usr/bin/env python3
"""Static contract checks for the opt-in Automatic Mode Stage A workflow branch."""

from __future__ import annotations

from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = (ROOT / ".github" / "workflows" / "stage-a.yml").read_text(encoding="utf-8")
WORKFLOW_DATA = yaml.safe_load(WORKFLOW)
STAGE_A_STEPS = WORKFLOW_DATA["jobs"]["stage_a"]["steps"]
STEP_NAMES = [step.get("name") for step in STAGE_A_STEPS if isinstance(step, dict) and step.get("name")]
assert len(STEP_NAMES) == len(set(STEP_NAMES)), "Stage A workflow contains duplicate step names"
RUNNER = (ROOT / "scripts" / "automatic_analysis.py").read_text(encoding="utf-8")
STATUS_WRITER = (ROOT / "scripts" / "write_status.py").read_text(encoding="utf-8")


assert "automatic_mode:" in WORKFLOW
assert 'default: "false"' in WORKFLOW
assert "if: ${{ github.event.inputs.automatic_mode != 'true' }}" in WORKFLOW
assert "if: ${{ github.event.inputs.automatic_mode == 'true' }}" in WORKFLOW
assert "PUTER_AUTH_TOKENS: ${{ secrets.PUTER_AUTH_TOKENS }}" in WORKFLOW
assert "Download released analysis assets for Automatic Mode" in WORKFLOW
assert "Run bounded Puter Automatic Mode analysis" in WORKFLOW
assert "--output \"jobs/${{ steps.jid.outputs.job_id }}/production.json\"" in WORKFLOW
assert "--result-path \"jobs/${{ steps.jid.outputs.job_id }}/automatic_analysis.json\"" in WORKFLOW
assert "Write automatic_analysis_running status" in WORKFLOW
assert '"automatic_analysis_running"' in WORKFLOW
assert "Write automatic Stage B queued status" in WORKFLOW
assert '"stage_b_queued"' in WORKFLOW
assert "Commit automatic production plan and status" in WORKFLOW
assert "Dispatch existing Stage B from validated automatic plan" in WORKFLOW
assert "gh workflow run stage-b.yml" in WORKFLOW
assert "actions: write" in WORKFLOW
assert "Automatic Mode failed after Stage A" in WORKFLOW
assert WORKFLOW.index("Commit automatic production plan and status") < WORKFLOW.index("Dispatch existing Stage B from validated automatic plan")

# The existing manual-stage handoff remains exactly present and guarded.
assert "Stage A complete. Open the Release, hand it to your agent, then upload production.json to start Stage B." in WORKFLOW
assert "Write awaiting_json_upload status" in WORKFLOW
assert WORKFLOW.count("- name: Write awaiting_json_upload status") == 1

# Provider safety requirements are implementation-level, not just workflow copy.
for required in (
    "MAX_TOOL_TURNS = 12",
    "MAX_CORRECTION_RETRIES = 1",
    "MAX_OPEN_COMPOSITES = 12",
    "MAX_TOTAL_IMAGE_BYTES",
    "safe_extract_screenshots",
    "read_transcript",
    "read_scene_index",
    "read_key_moments",
    "open_composite",
    "data:",
    "All configured Puter tokens failed",
    "discover_compatible_models",
    "tool_call",
    "modalities",
    "production_plan_contract",
):
    assert required in RUNNER, f"runner missing required safety/protocol element: {required}"

assert "automatic_analysis_running" in STATUS_WRITER
print("PASS: Automatic Mode is opt-in, validated, bounded, status-visible, and dispatches only the existing Stage B path")
