/**
 * Super Series — super-plan validation, slicing, and the sequential queue
 * controller (Bot A side). Paired 1:1 with ``pipeline/plan/super_series.py``:
 * the validators on both sides must return the same accept/reject decisions
 * and the same error strings for the same input (pinned by
 * pipeline/tests/test_super_series.py).
 *
 * DESIGN (feature-01)
 * -------------------
 * The operator pastes ONE super-plan document (see ARCHITECTURE.md §7.5):
 * a ``parts`` array of ordinary, self-contained per-part production.json
 * documents plus a shared ``series_id``. This module:
 *
 *   1. validates the WHOLE document up front (validateSuperPlan) — malformed
 *      documents, non-tiling parts, or anything other than exactly one
 *      is_final reject the entire plan before any render is queued;
 *   2. slices out exactly one part at a time (sliceSuperPart) into an
 *      ordinary §7.3 single-part production.json and a §7.1 stage-a-request
 *      body synthesized with the EXISTING series continuation helpers
 *      (bot/src/series.js nextPartRequestBody / nextPartJobId) — the spawned
 *      job is indistinguishable from a normal series part;
 *   3. decides the queue's next move from durable repo state alone
 *      (superQueueAdvance): the controller is a pure decision function called
 *      from the bot's existing per-minute cron sweep, so it survives worker
 *      restarts and never double-dispatches.
 *
 * HALT-AND-RESUME (operator requirement): when a part's Stage B run reaches
 * state "error", the queue HALTS — nothing further is queued and the operator
 * is told to fix/restart that part through the existing task:restartb flow.
 * When that part later reaches "complete", the same decision function simply
 * returns the next part to queue — resumption needs no separate trigger.
 */

import { isValidJobId } from './jobs.js';
import { validateProductionPlan } from './plan.js';
import { buildSeriesContext, nextPartJobId, nextPartRequestBody } from './series.js';

export const MAX_PARTS = 20;
export const SUPER_STATE_PREFIX = 'super-state:';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && Math.floor(value) === value;
}

function isNonemptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// --------------------------------------------------------------------------- //
// Validation                                                                   //
// --------------------------------------------------------------------------- //

/**
 * Validate a super-plan document. Returns an array of error strings; empty
 * means valid and safe to slice. Mirrors pipeline/plan/super_series.py's
 * validate_super_plan exactly.
 */
export function validateSuperPlan(document) {
  const errors = [];

  if (!isPlainObject(document)) {
    return ['Top level must be a JSON object.'];
  }

  // -- Shared series id ---------------------------------------------------- //
  let seriesId = document.series_id;
  if (!isNonemptyString(seriesId)) {
    errors.push('`series_id` must be a non-empty string shared by every part.');
    seriesId = null;
  }

  // -- Required positive-integer scalars ----------------------------------- //
  const videoDuration = document.video_duration_seconds;
  if (!isInteger(videoDuration) || videoDuration <= 0) {
    errors.push('`video_duration_seconds` must be a positive integer.');
  }
  const targetDuration = document.target_total_duration_seconds;
  if (!isInteger(targetDuration) || targetDuration <= 0) {
    errors.push('`target_total_duration_seconds` must be a positive integer.');
  }

  // -- parts array ---------------------------------------------------------- //
  const parts = document.parts;
  if (!Array.isArray(parts)) {
    errors.push('`parts` must be an array of per-part production plans.');
    return errors;
  }
  if (parts.length < 1) {
    errors.push('`parts` is empty — at least one part is required.');
    return errors;
  }
  if (parts.length > MAX_PARTS) {
    errors.push(`\`parts\` must contain at most ${MAX_PARTS} entries.`);
  }

  let finalCount = 0;
  const titles = new Set();
  let previousEnd = null;

  for (let index = 0; index < parts.length; index += 1) {
    const at = `parts[${index}]`;
    const part = parts[index];
    if (!isPlainObject(part)) {
      errors.push(`${at} must be an object.`);
      continue;
    }

    // Every part must carry the same shared series_id.
    const partSeries = isPlainObject(part.series) ? part.series : {};
    if (seriesId !== null && partSeries.series_id !== seriesId) {
      errors.push(`${at}.series.series_id must equal the shared top-level series_id.`);
    }

    // Each part is itself an ordinary §7.3 series production plan; run the
    // existing single-part validator with the positional part number.
    const partErrors = validateProductionPlan(part, { partNumber: index + 1 });
    for (const message of partErrors) errors.push(`${at}: ${message}`);

    if (partSeries.is_final === true) finalCount += 1;

    if (isNonemptyString(part.title)) {
      const key = part.title.trim().toLowerCase();
      if (titles.has(key)) {
        errors.push(`${at}.title duplicates an earlier part's title.`);
      } else {
        titles.add(key);
      }
    }

    const startVal = partSeries.start_seconds;
    const endVal = partSeries.end_seconds;
    if (isInteger(startVal) && isInteger(endVal)) {
      if (index === 0 && startVal !== 0) {
        errors.push(`${at}.series.start_seconds must be 0 for the first part.`);
      }
      if (previousEnd !== null && startVal !== previousEnd) {
        errors.push(
          `${at}.series.start_seconds must equal the previous part's series_end_seconds ` +
          '(parts must tile the source with no gaps or overlaps).'
        );
      }
      previousEnd = endVal;
    }
  }

  if (finalCount !== 1) {
    errors.push('Exactly one part must be marked series.is_final = true.');
  } else {
    const last = parts[parts.length - 1];
    const lastSeries = isPlainObject(last) && isPlainObject(last.series) ? last.series : {};
    if (lastSeries.is_final !== true) {
      errors.push('The part marked series.is_final = true must be the last entry in `parts`.');
    }
  }

  return errors;
}

/**
 * Parse JSON text and validate it as a super-plan. Mirrors
 * pipeline/plan/super_series.py's parse_and_validate_super_plan.
 */
export function parseAndValidateSuperPlan(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return { document: null, errors: [`Not valid JSON: ${error && error.message ? error.message : 'parse error'}.`] };
  }
  return { document, errors: validateSuperPlan(document) };
}

// --------------------------------------------------------------------------- //
// Slicing                                                                      //
// --------------------------------------------------------------------------- //

/**
 * Return the ordinary single-part production.json for ``partIndex`` (0-based)
 * of a VALID super-plan: the part's own document, with ``series.part``
 * re-stamped to its positional number. ``jobId`` is the real spawned job id.
 */
export function sliceSuperPart(document, partIndex, jobId) {
  const source = document.parts[partIndex];
  const part = JSON.parse(JSON.stringify(source));
  const series = isPlainObject(part.series) ? part.series : {};
  series.part = partIndex + 1;
  part.series = series;
  part.job_id = String(jobId || '');
  return part;
}

// --------------------------------------------------------------------------- //
// Durable queue state (stored at jobs/<anchor>/super-plan.json)              //
// --------------------------------------------------------------------------- //

/**
 * The durable record the queue controller re-reads on every sweep tick. It
 * lives in the anchor job's directory (the Super Series Stage A job) so the
 * existing cleanup/TTL machinery expires it together with the job, and so a
 * worker restart loses nothing.
 */
export function buildSuperState({ anchorJobId, seriesId, document, spawned = [] }) {
  return {
    version: 1,
    anchor_job_id: String(anchorJobId),
    series_id: String(seriesId),
    total_parts: document.parts.length,
    video_duration_seconds: Number(document.video_duration_seconds),
    // The whole validated super-plan travels with the record — every later
    // slice needs it, and re-reading one small JSON per tick is cheap.
    plan: document,
    // [{ part, job_id }] in spawn order; the controller derives "where am I"
    // from this plus each spawned job's status.json — no separate cursor.
    spawned: spawned.map((entry) => ({ part: Number(entry.part), job_id: String(entry.job_id) })),
  };
}

/**
 * Pure queue-decision function. Given the durable super state and a lookup
 * for spawned jobs' current status.json state, decide the next action.
 *
 * Returns one of:
 *   { action: 'queue',  part, jobId, plan }   — slice + dispatch this part now
 *   { action: 'halted', part, jobId, message } — a spawned part is in error;
 *                                                operator must restart it
 *   { action: 'waiting', part, jobId }         — a spawned part is still running
 *   { action: 'done' }                          — every part completed
 *
 * HALT-AND-RESUME is expressed entirely by the ordering below: the FIRST
 * spawned part that is not yet "complete" decides everything. Error → halt.
 * Anything else non-terminal → wait. Complete → look at the next part, and if
 * none remain, done. A manually-restarted part that reaches "complete"
 * therefore resumes the queue automatically on the next sweep tick.
 */
export function superQueueAdvance(state, statusFor) {
  const plan = state && state.plan;
  const totalParts = Number(state && state.total_parts) || 0;
  if (!isPlainObject(plan) || !Array.isArray(plan.parts) || totalParts < 1) {
    return { action: 'done' };
  }
  const spawned = Array.isArray(state.spawned) ? state.spawned : [];

  // 1. Walk spawned parts in order; the first not-complete part decides.
  for (const entry of spawned) {
    const jobState = String((statusFor(entry.job_id) || {}).state || '');
    if (jobState === 'complete') continue;
    if (jobState === 'error') {
      return {
        action: 'halted',
        part: Number(entry.part),
        jobId: entry.job_id,
        message:
          `Super Series part ${entry.part} of ${totalParts} failed (task ${entry.job_id} is in state error). ` +
          'The queue is PAUSED — no further parts will be queued. Open that task and use Restart Stage B; ' +
          'the moment it reaches complete, the queue resumes automatically.',
      };
    }
    if (jobState === 'cancelled') {
      return {
        action: 'halted',
        part: Number(entry.part),
        jobId: entry.job_id,
        message:
          `Super Series part ${entry.part} of ${totalParts} was cancelled (task ${entry.job_id}). ` +
          'The queue is PAUSED — no further parts will be queued. Open that task and use Restart Stage B; ' +
          'the moment it reaches complete, the queue resumes automatically.',
      };
    }
    // queued / stage_b_queued / stage_b_running / anything else non-terminal:
    // the pipeline is working on it — the queue waits for it.
    return { action: 'waiting', part: Number(entry.part), jobId: entry.job_id };
  }

  // 2. Everything spawned so far is complete.
  if (spawned.length >= totalParts) return { action: 'done' };

  // 3. Slice and queue the next part.
  const partNumber = spawned.length + 1;
  const jobId = superPartJobId(state.series_id, partNumber);
  return {
    action: 'queue',
    part: partNumber,
    jobId,
    plan: sliceSuperPart(plan, partNumber - 1, jobId),
  };
}

/** §6.3-safe job id for a spawned Super Series part (same rule as series.js). */
export function superPartJobId(seriesId, partNumber) {
  return nextPartJobId({ seriesId, part: partNumber });
}

/**
 * Synthesize the ordinary §7.1 stage-a-request body for a spawned Super
 * Series part, reusing the EXISTING series continuation helper
 * (series.js nextPartRequestBody) so the result is byte-for-byte what a
 * normal manual continuation would have written. ``anchorRequest`` is the
 * Super Series Stage A job's own request; ``summaries`` is the array of
 * { part, summary } entries from already-completed spawned parts (the same
 * continuity context a normal series part would carry).
 */
export function superPartRequestBody(anchorRequest, state, partNumber, summaries) {
  const context = buildSeriesContext(summaries);
  return nextPartRequestBody(
    anchorRequest,
    { seriesId: state.series_id, part: partNumber, startSeconds: Number(planStartSeconds(state, partNumber)) },
    context,
    String(anchorRequest && anchorRequest.job_id || ''),
  );
}

function planStartSeconds(state, partNumber) {
  const part = state && state.plan && state.plan.parts ? state.plan.parts[partNumber - 1] : null;
  const series = isPlainObject(part) && isPlainObject(part.series) ? part.series : {};
  return isInteger(series.start_seconds) ? series.start_seconds : 0;
}

export { isValidJobId };
