/**
 * ClipForge Dashboard — production.json ingest (shared helper).
 * Port of bot/src/index.js's handlePlanUploadMessage commit path:
 * strip code fence -> super-plan detour -> parseAndValidateProductionPlan
 * -> awaiting_plan gate -> save production.json -> resolve music ->
 * dispatch stage-b.yml -> status stage_b_queued.
 *
 * The bot is FILE-UPLOAD ONLY after remove-paste-feature; the operator's
 * migration contract for the Dashboard asks for paste-OR-upload. Both feed
 * the SAME validator here — paste is just another way to obtain the text,
 * no fragment buffering is reintroduced.
 *
 * Used by the task-detail view (task-04). The Super Series detour
 * (handleSuperPlanUploadMessage equivalent) is task-06's shared helper;
 * this module returns { superPlan: true } instead of ingesting so the
 * caller can route to it without double-parsing here.
 */

import {
  readStatus, readStageARequest, saveProductionPlan, resolveMusicRef,
  currentBranchSha, dispatchWorkflow, putTextFile, STATUS_PATH,
  mergeStatus, STAGE_B_WORKFLOW
} from './github.js';
import { parseAndValidateProductionPlan } from './plan.js';

export const MAX_PLAN_BYTES = 1024 * 1024; // bot: plan files must be ≤ 1 MB

/** bug-08: strip a wrapping ``` / ```json code fence, if present. */
export function stripCodeFence(text) {
  const trimmed = String(text).trim();
  const match = trimmed.match(/^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/);
  return match ? match[1].trim() : trimmed;
}

/**
 * Ingest a production plan for a job.
 * Returns one of:
 *   { ok: true }                        — saved + Stage B dispatched
 *   { ok: false, error: '...' }         — user-safe rejection message
 *   { superPlan: true, text }           — route to the super-plan flow (task-06)
 */
export async function ingestProductionPlan(credentials, repo, jobId, rawText) {
  const text = stripCodeFence(rawText);
  if (!text.trim()) {
    return { ok: false, error: 'The plan is empty. Provide a text file or paste containing the production plan JSON.' };
  }

  // feature-01: a Super Series anchor's upload is a WHOLE-SERIES super-plan
  // (§7.5) — never validated as a single-part production.json here.
  const uploadRequest = await readStageARequest(credentials, repo, jobId).catch(() => null);
  if (uploadRequest && uploadRequest.series && uploadRequest.series.super_series === true) {
    return { superPlan: true, text };
  }

  const { document, errors } = parseAndValidateProductionPlan(text);
  if (errors.length) {
    const listed = errors.slice(0, 12).map((line) => `• ${line}`).join('\n');
    return {
      ok: false,
      error: `That production.json is not valid (${errors.length} problem${errors.length === 1 ? '' : 's'}):\n\n${listed}${errors.length > 12 ? '\n• …' : ''}\n\nFix it with your agent and send it again.`
    };
  }

  const status = await readStatus(credentials, repo, jobId).catch(() => null);
  if (status && status.state !== 'awaiting_plan') {
    return {
      ok: false,
      error: `This task is in state ${status.state}, not awaiting_plan. Refresh the task first.`
    };
  }

  await saveProductionPlan(credentials, repo, jobId, `${JSON.stringify(document, null, 2)}\n`);
  const request = await readStageARequest(credentials, repo, jobId).catch(() => null);
  const musicRef = await resolveMusicRef(credentials, repo, request);
  const codeRef = await currentBranchSha(credentials, repo);
  await dispatchWorkflow(credentials, repo, STAGE_B_WORKFLOW, {
    job_id: jobId,
    production_ref: `path:jobs/${jobId}/production.json`,
    music_ref: musicRef,
    code_ref: codeRef
  });
  if (status) {
    const next = mergeStatus(status, { state: 'stage_b_queued', message: 'Production plan uploaded — Stage B dispatched.' });
    await putTextFile(credentials, repo, STATUS_PATH(jobId), `${JSON.stringify(next, null, 2)}\n`, `clipforge: plan uploaded for job ${jobId}`);
  }
  return { ok: true };
}

/** Read a File as strict UTF-8 text (bot's text-file gate). */
export async function readPlanFile(file) {
  const size = Number(file && file.size || 0);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_PLAN_BYTES) {
    throw new Error('The plan file must be non-empty and no larger than 1 MB.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('That file is not a text file. Use a .json, .txt, .md, or any text file containing the plan JSON.');
  }
}
