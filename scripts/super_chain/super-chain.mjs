/**
 * Super Series — completion-chained Stage B dispatch (the fix).
 * Triggered ONLY by stage-b.yml's own `workflow_run: completed` event
 * (super-chain.yml). GitHub reacts natively to the specific run finishing —
 * no cron, no schedule, no client open/polling/checking in.
 * 1. Genuine success only (conclusion success + status.json state complete);
 *    failure/cancel halts the chain until the operator restarts that part —
 *    the restart's own completion re-fires this event and resumes the chain.
 * 2. Find the anchor whose spawned list contains this job.
 * 3. Run the SAME pure queue decision (superQueueAdvance) the Dashboard uses.
 * 4. Dispatch the next part via the ONE shared dispatch function
 *    (dispatch.mjs — exact equivalent of site/js/github.js dispatchWorkflow).
 */
import {
  dispatchWorkflow, currentBranchSha, resolveMusicRef, getJson, putJson,
  newStatus, githubRequest,
  STAGE_B_WORKFLOW, STATUS_PATH, STAGE_A_REQUEST_PATH, PRODUCTION_PATH, SUPER_PLAN_PATH,
} from './dispatch.mjs';
import { superQueueAdvance, superPartRequestBody } from './super.js';

const jobId = String(process.env.CHAIN_JOB_ID || '').trim();
const conclusion = String(process.env.CHAIN_CONCLUSION || '').trim();
const runId = String(process.env.CHAIN_RUN_ID || '').trim();
const credentials = { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPOSITORY };

if (!jobId) { console.log('[chain] no job_id on the finished run — not a chained dispatch. Exit.'); process.exit(0); }
console.log(`[chain] stage-b.yml run ${runId} for job ${jobId} completed with conclusion=${conclusion}`);

if (conclusion !== 'success') {
  console.log(`[chain] conclusion=${conclusion} — chain HALTS until the operator restarts this part and it completes.`);
  process.exit(0);
}
const status = await getJson(credentials, credentials.repo, STATUS_PATH(jobId));
if (!status || String(status.state) !== 'complete') {
  console.log(`[chain] job ${jobId} status.json state=${status && status.state} (not complete) — no chain action.`);
  process.exit(0);
}

const list = await githubRequest(credentials, '/contents/jobs').catch(() => []);
const dirs = (Array.isArray(list) ? list : []).filter((e) => e && e.type === 'dir').map((e) => e.name);
let anchorId = null, state = null;
for (const dir of dirs) {
  const doc = await getJson(credentials, credentials.repo, SUPER_PLAN_PATH(dir)).catch(() => null);
  if (!doc || !doc.plan || !Array.isArray(doc.plan.parts)) continue;
  const spawned = Array.isArray(doc.spawned) ? doc.spawned : [];
  if (spawned.some((e) => String(e.job_id) === jobId)) { anchorId = dir; state = doc; break; }
}
if (!anchorId) { console.log(`[chain] job ${jobId} belongs to no Super Series anchor — ordinary Stage B, nothing to chain.`); process.exit(0); }
console.log(`[chain] job ${jobId} is a spawned part of anchor ${anchorId} (series ${state.series_id}).`);

const spawned = Array.isArray(state.spawned) ? state.spawned : [];
const statuses = {};
for (const entry of spawned) statuses[entry.job_id] = await getJson(credentials, credentials.repo, STATUS_PATH(entry.job_id)).catch(() => null);
const outcome = superQueueAdvance(state, (j) => statuses[j]);
console.log(`[chain] superQueueAdvance -> ${JSON.stringify({ ...outcome, plan: undefined })}`);
if (outcome.action === 'done') { console.log('[chain] all parts complete — Super Series finished.'); process.exit(0); }
if (outcome.action !== 'queue') { console.log(`[chain] action=${outcome.action} — nothing to dispatch.`); process.exit(0); }

if ((await getJson(credentials, credentials.repo, STATUS_PATH(outcome.jobId))) ||
    (await getJson(credentials, credentials.repo, STAGE_A_REQUEST_PATH(outcome.jobId)))) {
  console.log(`[chain] part ${outcome.part} (${outcome.jobId}) already exists — not double-dispatching.`);
  process.exit(0);
}
const anchorRequest = await getJson(credentials, credentials.repo, STAGE_A_REQUEST_PATH(anchorId));
if (!anchorRequest) { console.error(`[chain] anchor ${anchorId} has no stage-a-request.json.`); process.exit(1); }

const summaries = [];
for (const entry of spawned) {
  if (String(statuses[entry.job_id] && statuses[entry.job_id].state) !== 'complete') continue;
  const plan = await getJson(credentials, credentials.repo, PRODUCTION_PATH(entry.job_id)).catch(() => null);
  const s = (plan && plan.series) || {};
  const partNo = Number(s.part), summary = String(s.summary || '').trim();
  if (Number.isInteger(partNo) && summary) summaries.push({ part: partNo, summary });
}

const requestBody = superPartRequestBody(anchorRequest, state, outcome.part, summaries);
const now = () => Math.floor(Date.now() / 1000);
await putJson(credentials, credentials.repo, STAGE_A_REQUEST_PATH(outcome.jobId),
  { version: 1, job_id: outcome.jobId, saved_at_epoch: now(), ...requestBody },
  `clipforge: stage-a request for super part ${outcome.part} (${outcome.jobId})`);
await putJson(credentials, credentials.repo, PRODUCTION_PATH(outcome.jobId), outcome.plan,
  `clipforge: production plan for super part ${outcome.part} (${outcome.jobId})`);
const ns = newStatus({
  jobId: outcome.jobId, mode: 'manual', state: 'stage_b_queued',
  message: `Super Series part ${outcome.part} of ${state.total_parts} — Stage B dispatched (chained from part ${outcome.part - 1}'s completion).`,
  series: {
    enabled: true, series_id: state.series_id, part: outcome.part,
    start_seconds: Number((outcome.plan.series && outcome.plan.series.start_seconds) || 0),
    is_final: Boolean(outcome.plan.series && outcome.plan.series.is_final === true),
  },
});
ns.release_tag = `clipforge-${outcome.jobId}`;
ns.release_url = `https://github.com/${credentials.repo}/releases/tag/clipforge-${outcome.jobId}`;
await putJson(credentials, credentials.repo, STATUS_PATH(outcome.jobId), ns,
  `clipforge: queue super series part ${outcome.part} (${outcome.jobId})`);
state.spawned = [...spawned, { part: Number(outcome.part), job_id: String(outcome.jobId) }];
await putJson(credentials, credentials.repo, SUPER_PLAN_PATH(anchorId), state,
  `clipforge: super series part ${outcome.part} spawned (${outcome.jobId})`);

const musicRef = await resolveMusicRef(credentials, credentials.repo, requestBody);
const codeRef = await currentBranchSha(credentials, credentials.repo);
await dispatchWorkflow(credentials, credentials.repo, STAGE_B_WORKFLOW, {
  job_id: outcome.jobId,
  production_ref: `path:jobs/${outcome.jobId}/production.json`,
  music_ref: musicRef,
  code_ref: codeRef,
});
console.log(`[chain] DISPATCHED stage-b.yml for part ${outcome.part} (${outcome.jobId}) — chained directly from run ${runId} (${jobId}) completion.`);
