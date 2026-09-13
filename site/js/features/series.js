/**
 * Series view — task-05.
 * Dashboard equivalent of the bot's series surfaces (showSeriesParts,
 * startNextSeriesPart, series hold-to-delete):
 *  - dedicated view grouping every job by status.series.series_id
 *  - per-part status (✔ complete / ⚠ terminal / ⏳ active), sorted by part
 *  - "Start Next Part" from the latest completed part — bot
 *    startNextSeriesPart verbatim semantics: manualSeriesContinuation ->
 *    nextPartJobId -> duplicate-dispatch guard (existing stage-a-request or
 *    status for the derived id) -> seriesContextSummaries ->
 *    nextPartRequestBody -> saveStageARequest + queued status + dispatch
 *  - long-press (hold ~700ms) on a series header offers delete-entire-series
 *    with the app's destructive-confirmation pattern: removes every job of
 *    the series (files + releases) and reclaims their labels
 *
 * Super Series anchors also appear here (their spawned parts are ordinary
 * series jobs of the same series_id). task-06: each anchor card shows the
 * full queue/halt display (spawned/total, per-part state, halt banner with
 * the bot's exact message) via describeSuperQueue, and the view drives the
 * Chain continuation is GitHub-native (super-chain.yml, workflow_run on stage-b.yml) — the same
 * pure superQueueAdvance the bot cron and the task-12 scheduled workflow
 * share, so the durable repo record stays the only cursor.
 */

import {
  getCredentials, escapeHtml, toast, confirmDialog, ensureTaskLabel,
  setTaskOptions, removeTask, formatEpoch
} from '../state.js';
import {
  listJobIds, readStatus, readStageARequest, readProductionPlan,
  saveStageARequest, putTextFile, currentBranchSha, dispatchWorkflow,
  deleteClipforgeJob, STATUS_PATH, STAGE_A_WORKFLOW, tryGetJsonFile
} from '../github.js';
import {
  manualSeriesContinuation, nextPartJobId, nextPartRequestBody,
  extractPlanSeries, buildSeriesContext
} from '../series.js';
import { describeSuperQueue } from '../supertick.js';

const POLL_MS = 10000;
const HOLD_MS = 700;

/** Port of bot seriesContextSummaries — per-series `Prior events` context. */
async function seriesContextSummaries(credentials, seriesId) {
  const entries = [];
  for (const id of await listJobIds(credentials, credentials.repo)) {
    const request = await readStageARequest(credentials, credentials.repo, id).catch(() => null);
    const reqSeries = request && typeof request.series === 'object' && request.series ? request.series : {};
    if (!request || reqSeries.enabled !== true || String(reqSeries.series_id || '') !== seriesId) continue;
    const plan = await readProductionPlan(credentials, credentials.repo, id);
    const values = extractPlanSeries(plan || {});
    const part = Number(values.part);
    const summary = String(values.summary || '').trim();
    if (Number.isInteger(part) && summary) entries.push({ part, summary });
  }
  return buildSeriesContext(entries);
}

function partMark(state) {
  if (state === 'complete') return '✔';
  if (state === 'error' || state === 'cancelled') return '⚠';
  return '⏳';
}

export async function renderSeries(app) {
  const credentials = getCredentials();
  let alive = true;
  let timer = null;
  const { onTeardown } = await import('../../app.js');
  onTeardown(() => { alive = false; if (timer) clearInterval(timer); });

  async function loadSeries() {
    const jobIds = await listJobIds(credentials, credentials.repo);
    const loaded = await Promise.all(jobIds.map(async (jobId) => {
      const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
      return { jobId, status };
    }));
    const groups = new Map(); // series_id -> { parts: [{jobId,status,part,label}], anchor: bool, superState }
    for (const { jobId, status } of loaded) {
      const series = status && typeof status.series === 'object' && status.series ? status.series : {};
      if (!status || series.enabled !== true || !series.series_id) continue;
      const id = String(series.series_id);
      if (!groups.has(id)) groups.set(id, { id, parts: [], anchor: null });
      groups.get(id).parts.push({
        jobId, status,
        part: Number(series.part) || 0,
        label: ensureTaskLabel(jobId)
      });
    }
    // Detect Super Series anchors (repo-based marker, task-06 reads these fully).
    for (const group of groups.values()) {
      group.parts.sort((a, b) => a.part - b.part);
      const superPlan = await tryGetJsonFile(credentials, credentials.repo,
        `jobs/${group.parts[0].jobId}/super-plan.json`).catch(() => null);
      if (superPlan && superPlan.document && Array.isArray(superPlan.document.spawned)) {
        group.anchor = superPlan.document;
      }
      // An anchor job itself may carry no series block in status; also probe
      // jobs referenced by any super-plan in the repo.
    }
    // Second pass: anchors whose own status has no series block but whose
    // super-plan.json points at this series id.
    for (const { jobId, status } of loaded) {
      const superPlan = await tryGetJsonFile(credentials, credentials.repo,
        `jobs/${jobId}/super-plan.json`).catch(() => null);
      if (!superPlan || !superPlan.document) continue;
      const sid = String(superPlan.document.series_id || '');
      if (!sid) continue;
      if (!groups.has(sid)) groups.set(sid, { id: sid, parts: [], anchor: null });
      const group = groups.get(sid);
      group.anchor = superPlan.document;
      if (!group.parts.some((p) => p.jobId === jobId)) {
        group.parts.unshift({ jobId, status, part: 0, label: ensureTaskLabel(jobId), anchorJob: true });
      }
    }
    return [...groups.values()].sort((a, b) => {
      const newest = (g) => Math.max(0, ...g.parts.map((p) => Number(p.status && p.status.created_at_epoch) || 0));
      return newest(b) - newest(a);
    });
  }

  function groupHtml(group) {
    const rows = group.parts.map((p) => {
      const state = p.status ? String(p.status.state || 'queued') : 'status unavailable';
      return `
        <div class="list-row" data-open="${escapeHtml(p.jobId)}">
          <span class="grow">${partMark(String(p.status && p.status.state || ''))}
            <b>${p.anchorJob ? 'Anchor' : `Part ${p.part || '?'}`}</b> · task ${escapeHtml(p.label)}
            <span class="muted mono small">${escapeHtml(p.jobId)}</span></span>
          <span class="state-pill ${escapeHtml(String(p.status && p.status.state || ''))}">${escapeHtml(state)}</span>
        </div>`;
    }).join('');

    const latestComplete = [...group.parts]
      .filter((p) => p.status && p.status.state === 'complete' && !p.anchorJob)
      .sort((a, b) => b.part - a.part)[0];

    let superLine = '';
    if (group.anchor) {
      const total = Number(group.anchor.total_parts) || (group.anchor.plan && group.anchor.plan.parts ? group.anchor.plan.parts.length : 0);
      const spawned = Array.isArray(group.anchor.spawned) ? group.anchor.spawned.length : 0;
      superLine = `<p class="muted small">⚡ Super Series — ${spawned}/${total} parts dispatched</p>`;
      if (group.superQueue && group.superQueue.outcome) {
        const o = group.superQueue.outcome;
        if (o.action === 'halted') {
          superLine += `<p class="error-text">⏸ ${escapeHtml(o.message)}</p>`;
        } else if (o.action === 'waiting') {
          superLine += `<p class="muted small">⏳ Part ${o.part} of ${group.superQueue.totalParts} running — the next part dispatches automatically when it completes.</p>`;
        } else if (o.action === 'done') {
          superLine += `<p class="muted small">✔ All ${group.superQueue.totalParts} parts complete.</p>`;
        }
      }
    }

    return `
      <div class="card series-card" data-series="${escapeHtml(group.id)}">
        <h2 class="series-head" data-hold="${escapeHtml(group.id)}" title="Hold to delete this series">
          📚 <span class="mono">${escapeHtml(group.id)}</span></h2>
        <p class="muted small">Hold the title to delete the entire series.</p>
        ${superLine}
        <div class="list">${rows}</div>
        <div class="btn-row">
          ${latestComplete ? `<button type="button" class="primary" data-next="${escapeHtml(latestComplete.jobId)}">▶ Start next part (after Part ${latestComplete.part})</button>` : ''}
        </div>
      </div>`;
  }

  async function draw() {
    // NO client-side dispatch here. Chain continuation is GitHub-native:
    // stage-b.yml's completion fires super-chain.yml (workflow_run), which
    // dispatches the next part with zero client involvement. This view only
    // READS queue/halt state for display.
    const groups = await loadSeries();
    for (const group of groups) {
      if (group.anchor) {
        const anchorJobId = String(group.anchor.anchor_job_id || (group.parts[0] && group.parts[0].jobId) || '');
        if (anchorJobId) {
          group.superQueue = await describeSuperQueue(credentials, credentials.repo, anchorJobId).catch(() => null);
        }
      }
    }
    app.innerHTML = groups.length
      ? groups.map(groupHtml).join('')
      : `<div class="card"><h2>Series</h2><p class="muted">No series yet. Enable Series Mode in Settings, then start a task from New video.</p></div>`;

    for (const row of app.querySelectorAll('[data-open]')) {
      row.addEventListener('click', () => {
        location.hash = `#/task/${encodeURIComponent(row.dataset.open)}`;
      });
    }

    // Long-press (hold) on the series title -> destructive confirmation.
    for (const head of app.querySelectorAll('[data-hold]')) {
      let holdTimer = null;
      let fired = false;
      const seriesId = head.dataset.hold;
      const start = (event) => {
        fired = false;
        holdTimer = setTimeout(async () => {
          fired = true;
          await deleteWholeSeries(seriesId);
        }, HOLD_MS);
        if (event && event.preventDefault && event.type === 'touchstart') event.preventDefault();
      };
      const cancel = () => { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; } };
      head.addEventListener('pointerdown', start);
      head.addEventListener('pointerup', cancel);
      head.addEventListener('pointerleave', cancel);
      head.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    for (const btn of app.querySelectorAll('[data-next]')) {
      btn.addEventListener('click', () => startNextPart(btn.dataset.next, btn));
    }
    return groups.some((g) => g.parts.some((p) => p.status && !['complete', 'error', 'cancelled'].includes(String(p.status.state))));
  }

  async function deleteWholeSeries(seriesId) {
    const groups = await loadSeries();
    const group = groups.find((g) => g.id === seriesId);
    if (!group) return;
    const count = group.parts.length;
    const ok = await confirmDialog(`Delete the entire series?`,
      `This deletes <b>${count}</b> job(s) of <span class="mono">${escapeHtml(seriesId)}</span> — all job files and GitHub releases. It cannot be undone.`,
      'Yes, delete the series', true);
    if (!ok) return;
    try {
      for (const part of group.parts) {
        await deleteClipforgeJob(credentials, credentials.repo, part.jobId).catch(() => {});
        removeTask(null, part.jobId);
      }
      toast(`Series ${seriesId} deleted (${count} job(s)).`, 'ok');
      draw();
    } catch (error) {
      toast(error.message || 'Series delete failed.', 'err');
    }
  }

  /** bot startNextSeriesPart, verbatim semantics. */
  async function startNextPart(jobId, btn) {
    btn.disabled = true;
    try {
      const [status, request, plan] = await Promise.all([
        readStatus(credentials, credentials.repo, jobId).catch(() => null),
        readStageARequest(credentials, credentials.repo, jobId).catch(() => null),
        readProductionPlan(credentials, credentials.repo, jobId).catch(() => null)
      ]);
      const continuation = manualSeriesContinuation(status, request, plan);
      if (!continuation) {
        toast('That completed task has no next Series Mode part to start (not a manual series part, or it was the final part).', 'err');
        btn.disabled = false;
        return;
      }
      const nextId = nextPartJobId(continuation);
      // Duplicate-dispatch guard, mirroring the stage-b.yml continuation step.
      const [existingRequest, existingStatus] = await Promise.all([
        readStageARequest(credentials, credentials.repo, nextId).catch(() => null),
        readStatus(credentials, credentials.repo, nextId).catch(() => null)
      ]);
      if (existingRequest || existingStatus) {
        const existingLabel = ensureTaskLabel(nextId);
        toast(`Part ${continuation.part} of this series already exists as task ${existingLabel}.`, 'err');
        btn.disabled = false;
        return;
      }

      const context = await seriesContextSummaries(credentials, continuation.seriesId);
      await saveStageARequest(credentials, credentials.repo, nextId,
        nextPartRequestBody(request, continuation, context, jobId));

      const now = Math.floor(Date.now() / 1000);
      const nextStatus = {
        version: 1,
        job_id: nextId,
        mode: 'manual',
        state: 'queued',
        message: `Series part ${continuation.part} queued — Stage A dispatched.`,
        created_at_epoch: now,
        updated_at_epoch: now,
        expires_at_epoch: now + 172800,
        release_tag: `clipforge-${nextId}`,
        release_url: `https://github.com/${credentials.repo}/releases/tag/clipforge-${nextId}`,
        series: {
          enabled: true,
          series_id: continuation.seriesId,
          part: continuation.part,
          start_seconds: continuation.startSeconds,
          is_final: false
        }
      };
      await putTextFile(credentials, credentials.repo, STATUS_PATH(nextId),
        `${JSON.stringify(nextStatus, null, 2)}\n`, `clipforge: queue series part ${continuation.part} (${nextId})`);

      const codeRef = await currentBranchSha(credentials, credentials.repo);
      await dispatchWorkflow(credentials, credentials.repo, STAGE_A_WORKFLOW, { job_id: nextId, code_ref: codeRef });

      const nextLabel = ensureTaskLabel(nextId);
      setTaskOptions(nextId, { mode: 'manual', source_kind: String(request.source && request.source.kind || '') });
      toast(`Series Part ${continuation.part} dispatched as task ${nextLabel} — it continues from ${continuation.startSeconds}s of the original source.`, 'ok', 6000);
      location.hash = `#/task/${encodeURIComponent(nextId)}`;
    } catch (error) {
      toast(error.message || String(error), 'err');
      btn.disabled = false;
    }
  }

  const anyActive = await draw();
  if (anyActive) {
    timer = setInterval(async () => {
      if (!alive) return;
      try { if (!(await draw()) && timer) { clearInterval(timer); timer = null; } } catch { /* retry next tick */ }
    }, POLL_MS);
  }
}
