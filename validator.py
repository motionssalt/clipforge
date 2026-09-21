#!/usr/bin/env python3
"""Pre-delivery production.json / super-plan.json validator (agent-facing).

This script exists so the AI agent that AUTHORS a production.json (or a Super
Series super-plan document) can validate it BEFORE handing it back to the
operator — catching mistakes in the same session that made them instead of
after a wasted Stage B render attempt.

DESIGN CONSTRAINT (non-negotiable): this script reimplements NOTHING. It calls
the exact same validation code Stage B already runs at its boundary in
.github/workflows/stage-b.yml ("Resolve production.json"):

  * ``pipeline.plan.schema.validate_production_plan`` — the single source of
    truth for the production.json contract (§13 invariant #5);
  * ``pipeline.stage_b.series_reconcile.reconcile_series_metadata`` — the
    bug-56 series-metadata reconciliation against the durable
    ``jobs/<job_id>/stage-a-request.json``;
  * the residual series cross-check (``pipeline.stage_b.common.normalize_plan``
    comparison) that stage-b.yml runs after reconciliation;
  * ``pipeline.plan.super_series.validate_super_plan`` — the whole-series
    super-plan contract (its per-part checks already delegate to
    ``validate_production_plan`` internally).

Because the same functions are called the same way, a document this script
accepts is accepted by Stage B by construction — the two checks cannot drift.

Usage:
    python validator.py production.json --job-id <job_id>
    python validator.py super-plan.json --job-id <job_id> --super-plan

``--job-id`` is required whenever the job is (or might be) a Series part or a
Super Series anchor — it is how the script loads the durable
``stage-a-request.json`` for the series cross-check. For a plain one-off task
it may be omitted (schema validation still runs).

Exit status: 0 when the document is valid; 1 with every error printed in
plain, actionable language (never a stack trace) when it is not.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# Import bootstrap: this file ships as a standalone release asset, so the     #
# agent may run it from any working directory. Walk upwards from the script   #
# (and from the CWD) until a directory containing the ``pipeline`` package is #
# found, and put it on sys.path. No rules are duplicated — we only locate the #
# real modules.                                                               #
# --------------------------------------------------------------------------- #
def _bootstrap_import_path() -> None:
    candidates = [Path(__file__).resolve(), Path.cwd()]
    for start in candidates:
        for directory in (start.parent, *start.parents):
            if (directory / "pipeline" / "plan" / "schema.py").is_file():
                if str(directory) not in sys.path:
                    sys.path.insert(0, str(directory))
                return


_bootstrap_import_path()

try:
    from pipeline.plan.schema import validate_production_plan
    from pipeline.plan.super_series import validate_super_plan
    from pipeline.stage_b.common import normalize_plan
    from pipeline.stage_b.series_reconcile import (
        format_log_line,
        reconcile_series_metadata,
    )
except ImportError as exc:  # pragma: no cover - environment problem, not a plan error
    sys.stderr.write(
        "validator.py could not locate the ClipForge pipeline modules "
        f"({exc}).\nRun it from the clipforge repository checkout (the folder "
        "that contains the pipeline/ directory), or keep validator.py at the "
        "repository root.\n"
    )
    raise SystemExit(2)


def _load_request(job_id: str | None, jobs_root: str) -> dict | None:
    """Load the durable Stage A request exactly like stage-b.yml does."""
    if not job_id:
        return None
    request_path = Path(jobs_root) / job_id / "stage-a-request.json"
    if not request_path.exists():
        return None
    try:
        return json.loads(request_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}


def _validate_single_part(plan: object, request: dict | None, plan_path: Path, job_id: str | None) -> list[str]:
    """Mirror stage-b.yml "Resolve production.json": reconcile, validate, cross-check."""
    if not isinstance(plan, dict):
        return ["Top level must be a JSON object."]

    # bug-56 reconciliation FIRST — the same call, the same order as Stage B.
    reconciliation = reconcile_series_metadata(plan, request)
    print(format_log_line(reconciliation))
    if reconciliation.changes:
        # Stage B writes the corrected plan back; do the same so the file the
        # agent goes on to deliver already carries the authoritative values.
        plan_path.write_text(
            json.dumps(reconciliation.plan, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(
            "The field(s) above were auto-corrected in your file to match the "
            "durable Stage A request — keep these corrections when you deliver."
        )
        plan = reconciliation.plan

    errors = validate_production_plan(plan)

    # Residual series cross-check — identical to stage-b.yml.
    if isinstance(request, dict):
        series_req = request.get("series") or {}
        if isinstance(series_req, dict) and series_req.get("enabled"):
            normalized = normalize_plan(plan)
            plan_series = normalized.get("series") or {}
            expected = {
                "series_id": series_req.get("series_id"),
                "part": int(series_req.get("part") or 0),
                "start_seconds": int(series_req.get("start_seconds") or 0),
            }
            actual = {
                "series_id": plan_series.get("series_id"),
                "part": int(plan_series.get("part") or 0),
                "start_seconds": int(plan_series.get("start_seconds") or 0),
            }
            for key, value in expected.items():
                if actual.get(key) != value:
                    errors.append(
                        f"Series metadata mismatch for {key}: expected {value!r}, got {actual.get(key)!r} "
                        f"(check jobs/{job_id}/stage-a-request.json for the authoritative value)."
                    )
    return errors


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Validate a production.json (or super-plan.json) with the exact logic Stage B runs."
    )
    ap.add_argument("plan_path", help="Path to the production.json / super-plan.json file to validate.")
    ap.add_argument(
        "--job-id",
        default=None,
        help="Job id (loads jobs/<job_id>/stage-a-request.json for the series cross-check).",
    )
    ap.add_argument(
        "--super-plan",
        action="store_true",
        help="Validate the file as a Super Series whole-series super-plan document instead of a single part.",
    )
    ap.add_argument("--jobs-root", default="jobs", help="Jobs directory root (default: jobs).")
    args = ap.parse_args()

    plan_path = Path(args.plan_path)
    if not plan_path.is_file():
        sys.stderr.write(f"File not found: {plan_path}\n")
        raise SystemExit(2)

    try:
        text = plan_path.read_text(encoding="utf-8")
    except OSError as exc:
        sys.stderr.write(f"Could not read {plan_path}: {exc}\n")
        raise SystemExit(2)

    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        sys.stderr.write(
            "Not valid JSON: "
            f"{exc.msg} (line {exc.lineno}, column {exc.colno}).\n"
            "Fix the JSON syntax first — double quotes, no comments, no trailing "
            "commas, no truncation — then re-run this validator.\n"
        )
        raise SystemExit(1)

    kind = "super-plan document" if args.super_plan else "production.json"
    request = _load_request(args.job_id, args.jobs_root)
    if args.job_id and request is None:
        print(
            f"Note: no durable stage-a-request.json found for job '{args.job_id}' "
            f"under {args.jobs_root}/ — running schema validation only (no series cross-check)."
        )

    if args.super_plan:
        errors = validate_super_plan(document)
    else:
        errors = _validate_single_part(document, request, plan_path, args.job_id)

    if errors:
        sys.stderr.write(f"\nINVALID {kind} — {len(errors)} error(s) found:\n")
        for error in errors:
            sys.stderr.write(f"  - {error}\n")
        sys.stderr.write(
            "\nFix every error above and re-run this validator. Do NOT deliver "
            "the file until it passes cleanly — Stage B runs this exact same "
            "validation and will reject the file for the same reasons.\n"
        )
        raise SystemExit(1)

    print(f"OK: {plan_path} is a valid {kind}. It passes the same validation Stage B runs.")
    raise SystemExit(0)


if __name__ == "__main__":
    main()
