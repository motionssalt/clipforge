/**
 * ClipForge Dashboard — Super Series repo I/O driver.
 * Port of the Bot A side in bot/src/index.js (handleSuperPlanUploadMessage,
 * superQueueTick, runSuperQueueSweep) with all bot-only pieces replaced by
 * client-local equivalents:
 *
 *  - D1 task_options super_series_anchor flag     -> GONE (repo-based marker:
 *    jobs/<anchor>/super-plan.json presence/shape is the anchor test)
 *  - D1 super_halted_notified_part                -> localStorage
 *    cf.taskOptions[anchorJobId].super_halted_notified_part
 *  - sendMessage notifications                    -> in-view queue/halt display
 *  - bot cron (scheduled())                        -> the Dashboard's own
 *    per-minute sweep while any Series/Dashboard tab is open, PLUS the
 *    still-live bot cron until task-12, PLUS (task-12) a scheduled GitHub
 *    Actions workflow — all three drive the SAME pure superQueueAdvance, so
 *    the durable repo record is the only cursor and double-dispatch is
 *    impossible (spawn is marked BEFORE dispatch; existing request/status is
 *    the guard).
 */

import {
  readStatus, readStageARequest, readProductionPlan, tryGetJsonFile,
  saveStageARequest, saveProductionPlan, putTextFile, listJobIds,
  currentBranchSha, dispatchWorkflow, resolveMusicRef, newStatus, mergeStatus,
  STATUS_PATH, SUPER_PLAN_PATH, STAGE_B_WORKFLOW
} from './github.js';
import { extractPlanSeries } from './series.js';
import {
  parseAndValidateSuperPlan, buildSuperState, superQueueAdvance,
  superPartRequestBody, isSuperSeriesAnchor
} from './super.js';
import { ensureTaskLabel, setTaskOptions, getTaskOptions } from './state.js';

/**
 * Port of handleSuperPlanUploadMessage — accept a whole-series super-plan for
 * an anchor job in state awaiting_plan. Pure GitHub writes; NO bot-side step
 * (E2E-verified session-13, stage-b run 34731756595).
 *
 * Returns { ok: true, parts } | { ok: false, error: 'user-safe message' }.
 */
export async function submitSuperPlan(credentials, repo, jobId, text) {
  const { document, errors } = parseAndValidateSuperPlan(text);
  if (errors.length) {
    const listed = errors.slice(0, 12).map((line) => `• ${line}`).join('\n');
    return {
      ok: false,
      error:
        `That super-plan is not valid (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n\n` +
        `${listed}${errors.length > 12 ? '\n• …' : ''}\n\nFix it with your agent and send the whole super-plan again — no part has been queued.`
    };
  }

  const status = await readStatus(credentials, repo, jobId).catch(() => null);
  if (status && status.state !== 'awaiting_plan') {
    return {
      ok: false,
      error: `This task is in state ${status.state}, not awaiting_plan. Refresh the task screen first.`
    };
  }

  const request = await readStageARequest(credentials, repo, jobId).catch(() => null);
  const reqSeries = request && typeof request.series === 'object' && request.series ? request.series : {};
  const seriesId = String(reqSeries.series_id || '');
  if (!seriesId || String(document.series_id || '') !== seriesId) {
    return {
      ok: false,
      error:
        `The super-plan's series_id is ${String(document.series_id || '')} but this task expects ${seriesId}. ` +
        'Copy the exact id from the agent prompt and send it again.'
    };
  }

  // Durable queue record FIRST — every sweep can only ever resume from this.
  await putTextFile(credentials, repo, SUPER_PLAN_PATH(jobId),
    `${JSON.stringify(buildSuperState({ anchorJobId: jobId, seriesId, document }), null, 2)}\n`,
    `clipforge: accept super series plan (${jobId})`);
  const next = mergeStatus(
    status || newStatus({ jobId, mode: 'manual', state: 'awaiting_plan' }),
    { state: 'stage_b_queued', message: `Super Series plan accepted — ${document.parts.length} parts queued; part 1 dispatched.` }
  );
  await putTextFile(credentials, repo, STATUS_PATH(jobId),
    `${JSON.stringify(next, null, 2)}\n`, `clipforge: super plan accepted for job ${jobId}`);

  // Immediately advance the queue once (dispatches part 1). Any later sweep —
  // this tab's per-minute sweep, the bot cron until task-12, or the task-12
  // scheduled workflow — resumes from the durable record.
  const outcome = await superQueueTick(credentials, repo, jobId);
  return { ok: true, parts: document.parts.length, tick: outcome };
}

/**
 * Port of superQueueTick — advance ONE anchor's queue by at most one part.
 * The decision itself is the pure superQueueAdvance; this wrapper performs
 * the repo I/O (status reads, request+plan+status writes, Stage B dispatch)
 * exactly like the bot. Returns the outcome action for the UI to display.
 */
export async function superQueueTick(credentials, repo, anchorJobId) {
  const raw = await tryGetJsonFile(credentials, repo, SUPER_PLAN_PATH(anchorJobId)).catch(() => null);
  const state = raw && raw.document;
  if (!state || !state.plan || !Array.isArray(state.plan.parts)) {
    return { action: 'none' }; // not (or no longer) a valid anchor in the repo
  }
  const spawned = Array.isArray(state.spawned) ? state.spawned : [];
  const statuses = {};
  for (const entry of spawned) {
    statuses[entry.job_id] = await readStatus(credentials, repo, entry.job_id).catch(() => null);
  }
  const outcome = superQueueAdvance(state, (jobId) => statuses[jobId]);
  const options = getTaskOptions(anchorJobId);

  if (outcome.action === 'done') {
    // Queue finished — the anchor simply stops matching the repo scan.
    return outcome;
  }
  if (outcome.action === 'waiting') return outcome;
  if (outcome.action === 'halted') {
    if (Number(options.super_halted_notified_part) === Number(outcome.part)) return outcome; // notify once per part
    setTaskOptions(anchorJobId, { super_halted_notified_part: Number(outcome.part) });
    return outcome;
  }
  if (outcome.action !== 'queue') return outcome;

  // Duplicate-dispatch guard, mirroring startNextSeriesPart.
  const existing = await readStatus(credentials, repo, outcome.jobId).catch(() => null);
  const existingReq = await readStageARequest(credentials, repo, outcome.jobId).catch(() => null);
  if (existing || existingReq) return { action: 'exists', jobId: outcome.jobId, part: outcome.part };

  const anchorRequest = await readStageARequest(credentials, repo, anchorJobId).catch(() => null);
  if (!anchorRequest) return { action: 'none' };

  // Continuity summaries from already-complete spawned parts — the SAME
  // `Prior events (Part N):` context a normal series part would carry.
  const summaries = [];
  for (const entry of spawned) {
    if (String(statuses[entry.job_id] && statuses[entry.job_id].state) !== 'complete') continue;
    const plan = await readProductionPlan(credentials, repo, entry.job_id).catch(() => null);
    const values = extractPlanSeries(plan || {});
    const partNo = Number(values.part);
    const summary = String(values.summary || '').trim();
    if (Number.isInteger(partNo) && summary) summaries.push({ part: partNo, summary });
  }

  // Synthesize the ordinary single-part request via the EXISTING series
  // continuation helpers — the spawned job is indistinguishable from a normal
  // series part.
  const requestBody = superPartRequestBody(anchorRequest, state, outcome.part, summaries);
  await saveStageARequest(credentials, repo, outcome.jobId, requestBody);
  await saveProductionPlan(credentials, repo, outcome.jobId, `${JSON.stringify(outcome.plan, null, 2)}\n`);
  const nextStatus = newStatus({
    jobId: outcome.jobId,
    mode: 'manual',
    state: 'stage_b_queued',
    message: `Super Series part ${outcome.part} of ${state.total_parts} — Stage B dispatched.`,
    series: {
      enabled: true,
      series_id: state.series_id,
      part: outcome.part,
      start_seconds: Number(outcome.plan.series && outcome.plan.series.start_seconds || 0),
      is_final: Boolean(outcome.plan.series && outcome.plan.series.is_final === true)
    }
  });
  nextStatus.release_tag = `clipforge-${outcome.jobId}`;
  nextStatus.release_url = `https://github.com/${repo}/releases/tag/clipforge-${outcome.jobId}`;
  await putTextFile(credentials, repo, STATUS_PATH(outcome.jobId),
    `${JSON.stringify(nextStatus, null, 2)}\n`, `clipforge: queue super series part ${outcome.part} (${outcome.jobId})`);

  // Mark the part spawned BEFORE dispatching — the durable record is the only
  // cursor, so a crashed tick can never double-dispatch this part.
  state.spawned = [...spawned, { part: Number(outcome.part), job_id: String(outcome.jobId) }];
  await putTextFile(credentials, repo, SUPER_PLAN_PATH(anchorJobId),
    `${JSON.stringify(state, null, 2)}\n`, `clipforge: super series part ${outcome.part} spawned (${outcome.jobId})`);

  const musicRef = await resolveMusicRef(credentials, repo, requestBody);
  const codeRef = await currentBranchSha(credentials, repo);
  await dispatchWorkflow(credentials, repo, STAGE_B_WORKFLOW, {
    job_id: outcome.jobId,
    production_ref: `path:jobs/${outcome.jobId}/production.json`,
    music_ref: musicRef,
    code_ref: codeRef
  });
  ensureTaskLabel(outcome.jobId);
  setTaskOptions(outcome.jobId, { mode: 'manual', source_kind: String(anchorRequest.source && anchorRequest.source.kind || '') });
  setTaskOptions(anchorJobId, { super_halted_notified_part: 0 });
  return { action: 'dispatched', jobId: outcome.jobId, part: outcome.part, totalParts: state.total_parts };
}

/**
 * Port of runSuperQueueSweep — scan every repo job for ACTIVE Super Series
 * anchors (repo-based marker, no D1) and advance each queue by at most one
 * part. Runs on the Dashboard's per-minute timer while a relevant view is
 * open; errors on one anchor never block the others.
 */
export async function runSuperQueueSweep(credentials, repo) {
  const results = [];
  for (const jobId of await listJobIds(credentials, repo).catch(() => [])) {
    const raw = await tryGetJsonFile(credentials, repo, SUPER_PLAN_PATH(jobId)).catch(() => null);
    if (!isSuperSeriesAnchor(raw && raw.document)) continue;
    try {
      results.push({ jobId, outcome: await superQueueTick(credentials, repo, jobId) });
    } catch (error) {
      results.push({ jobId, outcome: { action: 'error', message: String(error && error.message || error) } });
    }
  }
  return results;
}

/**
 * Queue/halt display state for one anchor (pure repo reads): the durable
 * state + each spawned part's status + the pure advance decision, without
 * dispatching anything.
 */
export async function describeSuperQueue(credentials, repo, anchorJobId) {
  const raw = await tryGetJsonFile(credentials, repo, SUPER_PLAN_PATH(anchorJobId)).catch(() => null);
  const state = raw && raw.document;
  if (!state || !state.plan) return null;
  const spawned = Array.isArray(state.spawned) ? state.spawned : [];
  const parts = [];
  const statuses = {};
  for (const entry of spawned) {
    const s = await readStatus(credentials, repo, entry.job_id).catch(() => null);
    statuses[entry.job_id] = s;
    parts.push({ part: Number(entry.part), jobId: entry.job_id, state: String(s && s.state || 'queued') });
  }
  const outcome = superQueueAdvance(state, (jobId) => statuses[jobId]);
  return {
    anchorJobId,
    seriesId: String(state.series_id || ''),
    totalParts: Number(state.total_parts) || (state.plan.parts ? state.plan.parts.length : 0),
    spawned: parts,
    outcome
  };
}
