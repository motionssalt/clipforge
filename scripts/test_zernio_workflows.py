#!/usr/bin/env python3
"""Structural checks for ClipForge’s GitHub Actions Zernio integration."""
from __future__ import annotations

from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PUBLISH = ROOT / ".github" / "workflows" / "zernio-publish.yml"
STAGE_B = ROOT / ".github" / "workflows" / "stage-b.yml"


def load(path: Path):
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    assert isinstance(doc, dict), f"{path.name} must parse as a YAML mapping"
    return doc


def test_publish_workflow_contract() -> None:
    doc = load(PUBLISH)
    dispatch = doc[True]["workflow_dispatch"]
    inputs = dispatch["inputs"]
    assert {"discover", "publish", "retry", "update", "cancel"} <= set(inputs["action"]["options"])
    assert {"publish_now", "manual_schedule", "smart_schedule"} <= set(inputs["mode"]["options"])
    assert "request_id" in inputs
    assert doc["permissions"]["contents"] == "write"
    assert doc["concurrency"]["group"] == "clipforge-zernio-publishing"
    rendered = PUBLISH.read_text(encoding="utf-8")
    assert "zernio_schedule.py" in rendered
    assert "external_scheduled.json" in rendered
    assert "stage') != 'complete'" in rendered
    assert "status['publishing']" in rendered
    assert "branding/zernio_queue.json" in rendered


def test_stage_b_dispatch_is_best_effort_after_completion() -> None:
    doc = load(STAGE_B)
    assert doc["permissions"]["contents"] == "write"
    assert doc["permissions"]["actions"] == "write"
    rendered = STAGE_B.read_text(encoding="utf-8")
    complete_at = rendered.index("Write complete status")
    auto_at = rendered.index("Optionally dispatch automatic Zernio publishing")
    failure_at = rendered.index("On failure, write error status")
    assert complete_at < auto_at < failure_at
    auto_section = rendered[auto_at:failure_at]
    assert "if: success()" in auto_section
    assert "|| echo \"WARN: automatic Zernio dispatch failed" in auto_section


if __name__ == "__main__":
    tests = [value for name, value in globals().items() if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    print(f"zernio workflow tests passed ({len(tests)} tests)")
