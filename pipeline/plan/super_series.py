"""Super Series — super-plan validation and slicing (Python side).

Paired 1:1 with ``bot/src/super_series.js`` — both modules implement the exact
same accept/reject decisions and error strings for the super-plan contract
(documented in ARCHITECTURE.md §7.5). Cross-side equivalence is enforced by
``pipeline/tests/test_super_series.py`` driving the JS side through
``pipeline/tests/run_js_validator.mjs``-style node invocation.

DESIGN (feature-01)
-------------------

A Super Series task's Stage A prompt asks the external AI to plan the ENTIRE
series in ONE document (the "super-plan"): a ``parts`` array of ordinary,
self-contained per-part production.json documents (ARCHITECTURE.md §7.3
shape), each already carrying its own correct ``series`` block, plus a shared
``series_id``. The bot validates the whole document up front (this module's
``validate_super_plan``) BEFORE slicing anything, then hands out exactly one
part at a time to the completely unmodified Stage B pipeline — from Stage B's
perspective every Super Series part is an ordinary series part.

Validation rigor deliberately matches ``schema.validate_production_plan``:
every part is run through that exact validator with a ``part_number``
override, then cross-part checks (contiguous tiling, one is_final, distinct
titles, consistent series_id) are applied on top.
"""

from __future__ import annotations

import json
from typing import Any

from pipeline.plan import schema as plan_schema

MAX_PARTS = 20


def _is_int(value: Any) -> bool:
    return plan_schema._is_int(value)


def _as_int(value: Any) -> int:
    return plan_schema._as_int(value)


def _is_nonempty_string(value: Any) -> bool:
    return plan_schema._is_nonempty_string(value)


def validate_super_plan(document: Any) -> list[str]:
    """Return a list of validation error strings for a super-plan document.

    An empty list means the document is valid and safe to slice. Errors are
    written so an external AI (or operator) can fix the document and re-send
    it; each message names the exact field and part index involved.
    """
    errors: list[str] = []

    if not isinstance(document, dict):
        return ["Top level must be a JSON object."]

    # -- Shared series id --------------------------------------------------- #
    series_id = document.get("series_id")
    if not _is_nonempty_string(series_id):
        errors.append("`series_id` must be a non-empty string shared by every part.")
        series_id = None

    # -- Required positive-integer scalars ---------------------------------- #
    video_duration = document.get("video_duration_seconds")
    if not _is_int(video_duration) or _as_int(video_duration) <= 0:
        errors.append("`video_duration_seconds` must be a positive integer.")
        video_duration = None
    target_duration = document.get("target_total_duration_seconds")
    if not _is_int(target_duration) or _as_int(target_duration) <= 0:
        errors.append("`target_total_duration_seconds` must be a positive integer.")

    # -- parts array --------------------------------------------------------- #
    parts = document.get("parts")
    if not isinstance(parts, list):
        errors.append("`parts` must be an array of per-part production plans.")
        return errors
    if len(parts) < 1:
        errors.append("`parts` is empty — at least one part is required.")
        return errors
    if len(parts) > MAX_PARTS:
        errors.append(f"`parts` must contain at most {MAX_PARTS} entries.")

    final_count = 0
    titles: set[str] = set()
    previous_end: int | None = None

    for index, part in enumerate(parts):
        at = f"parts[{index}]"
        if not isinstance(part, dict):
            errors.append(f"{at} must be an object.")
            continue

        # Every part must carry the same shared series_id.
        part_series = part.get("series") if isinstance(part.get("series"), dict) else {}
        part_sid = part_series.get("series_id")
        if series_id is not None and part_sid != series_id:
            errors.append(f"{at}.series.series_id must equal the shared top-level series_id.")

        # Each part is itself an ordinary §7.3 series production plan; run the
        # existing single-part validator against it with the part number
        # derived from its position (the super-plan's parts are positional).
        part_errors = plan_schema.validate_production_plan(part, part_number=index + 1)
        errors.extend(f"{at}: {msg}" for msg in part_errors)

        # Cross-part checks (only meaningful when the part-level fields parsed).
        part_final = part_series.get("is_final")
        if part_final is True:
            final_count += 1

        title = part.get("title")
        if _is_nonempty_string(title):
            key = title.strip().lower()
            if key in titles:
                errors.append(f"{at}.title duplicates an earlier part's title.")
            else:
                titles.add(key)

        start_val = part_series.get("start_seconds")
        end_val = part_series.get("end_seconds")
        if _is_int(start_val) and _is_int(end_val):
            start = _as_int(start_val)
            end = _as_int(end_val)
            if index == 0 and start != 0:
                errors.append(f"{at}.series.start_seconds must be 0 for the first part.")
            if previous_end is not None and start != previous_end:
                errors.append(
                    f"{at}.series.start_seconds must equal the previous part's series_end_seconds "
                    f"(parts must tile the source with no gaps or overlaps)."
                )
            previous_end = end

    if isinstance(parts, list) and parts:
        if final_count != 1:
            errors.append("Exactly one part must be marked series.is_final = true.")
        else:
            # The single final part must be the LAST one — a final marker in
            # the middle would strand every later part unqueued.
            last_series = parts[-1].get("series") if isinstance(parts[-1], dict) and isinstance(parts[-1].get("series"), dict) else {}
            if last_series.get("is_final") is not True:
                errors.append("The part marked series.is_final = true must be the last entry in `parts`.")

    return errors


def slice_part(document: dict[str, Any], part_index: int) -> dict[str, Any]:
    """Return the ordinary single-part production.json for ``part_index`` (0-based).

    Callers MUST run ``validate_super_plan`` first and only call this on a
    valid document. The returned document is a plain §7.3 production plan —
    identical in shape to what a normal Series Mode part's AI would return —
    with its ``series.part`` field re-stamped to the positional part number.
    """
    parts = document["parts"]
    part = dict(parts[part_index])
    series = dict(part.get("series") if isinstance(part.get("series"), dict) else {})
    series["part"] = part_index + 1
    part["series"] = series
    part["job_id"] = ""  # stamped by the caller for the real spawned job id
    return part


def parse_and_validate_super_plan(text: str) -> tuple[dict[str, Any] | None, list[str]]:
    """Parse JSON ``text`` and validate it as a super-plan.

    Returns ``(document_or_None, errors)``. On JSON parse failure the document
    is ``None`` and errors contains a single "Not valid JSON: …" line.
    """
    try:
        document = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, [f"Not valid JSON: {exc.msg}."]
    return document, validate_super_plan(document)


__all__ = [
    "MAX_PARTS",
    "validate_super_plan",
    "slice_part",
    "parse_and_validate_super_plan",
]
