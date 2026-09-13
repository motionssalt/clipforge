/**
 * Tasks / Completed / Task-detail views — task-04.
 *
 * Port of bot commands/tasks.js + runtime.js showTask/taskKeyboard, with the
 * real-GitHub-Actions-logs rework specified in the migration contract:
 *  - GET /actions/runs/{run_id}/jobs  -> one collapsible section per REAL step
 *  - GET /actions/jobs/{job_id}/logs  -> FULL raw log text, grouped into steps
 *    by their started_at/completed_at timestamp ranges (raw log lines are
 *    ISO-timestamped; a line belongs to the step whose window contains it)
 *  - the active step auto-expands; when it finishes it auto-collapses and the
 *    next active step expands; manual toggle always works
 *  - localStorage cache: reopening a task renders instantly from cache; polls
 *    only re-fetch jobs that are not yet terminal; completed-job log text is
 *    final and never re-fetched; DOM updates are append/refresh of the active
 *    step only, never a full re-render per poll
 *  - polling stops once the run reaches a terminal state
 *
 * Actions (bot parity): Get agent prompt (sendAgentPrompt), Upload
 * production.json (ingestProductionPlan), Restart Stage A / B (bug-15 gate),
 * Cancel Stage B (confirm + active-run vs queued two-branch), torrent file
 * selection (awaiting_torrent_selection), Delete (terminal/unreadable only).
 * Zernio per-task publish CTA on complete lands in task-08.
 */

import {
  getCredentials, escapeHtml, toast, confirmDialog, ensureTaskLabel,
  getLogCache, setLogCache, removeTask, formatEpoch, formatBytes
} from '../state.js';
import {
  listJobIds, readStatus, readStageARequest, readProductionPlan,
  tryGetJsonFile, saveStageARequest, putTextFile, deleteClipforgeJob,
  currentBranchSha, dispatchWorkflow, cancelWorkflowRun,
  getRunInfo, listRunJobs, getJobLogs, resolveMusicRef,
  STATUS_PATH, STAGE_A_WORKFLOW, STAGE_B_WORKFLOW, PUBLISH_WORKFLOW,
  mergeStatus, isTerminal, zernioPublishingSummary, readZernioSettingsSafe,
  readZernioAccounts, actionsSecretExists, zernioTargets, zernioPostId,
  zernioRequestId, validZernioDateTime, ZERNIO_SECRET_NAME, ZERNIO_PLATFORM_LABELS,
  POST_ID_PATTERN
} from '../github.js';
import { ingestProductionPlan, readPlanFile, MAX_PLAN_BYTES } from '../planupload.js';
import { submitSuperPlan, describeSuperQueue, superQueueTick } from '../supertick.js';

const POLL_LIST_MS = 8000;
const POLL_DETAIL_MS = 5000;
const POLL_LOGS_MS = 6000;
const TORRENT_CANDIDATES_PER_PAGE = 6;

const STATE_ORDER = ['queued', 'stage_a_running', 'awaiting_torrent_selection', 'awaiting_plan', 'stage_b_queued', 'stage_b_running', 'complete'];

function describeState(status, unreadable) {
  if (unreadable) return 'status unavailable';
  const state = status && status.state ? String(status.state) : 'queued';
  if (state === 'awaiting_torrent_selection') return 'waiting for your file selection';
  return state;
}

function stateProgress(status) {
  const state = String(status && status.state || 'queued');
  if (state === 'error' || state === 'cancelled') return null;
  const idx = STATE_ORDER.indexOf(state);
  if (idx < 0) return null;
  return Math.round(((idx + 1) / STATE_ORDER.length) * 100);
}

function sortEntries(entries) {
  // commands/tasks.js sortTaskEntries: newest first, label tiebreak.
  return entries.slice().sort((a, b) => {
    const aCreated = Number(a.status && a.status.created_at_epoch) || 0;
    const bCreated = Number(b.status && b.status.created_at_epoch) || 0;
    if (aCreated !== bCreated) return bCreated - aCreated;
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

/** Load every repo job with its status; labels are ensured locally. */
async function loadAllTasks(credentials) {
  const jobIds = await listJobIds(credentials, credentials.repo);
  const entries = await Promise.all(jobIds.map(async (jobId) => {
    const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
    const label = ensureTaskLabel(jobId);
    return { label, jobId, status };
  }));
  return sortEntries(entries);
}

function taskRowHtml(entry, pendingDelete) {
  const unreadable = !entry.status;
  const state = unreadable ? '' : String(entry.status.state || 'queued');
  const text = describeState(entry.status, unreadable);
  const series = entry.status && entry.status.series && entry.status.series.enabled === true
    ? ` · part ${Number(entry.status.series.part) || 1}` : '';
  if (pendingDelete === entry.jobId) {
    return `
      <div class="task-row" data-job="${escapeHtml(entry.jobId)}">
        <div class="grow"><b>⚠ ${escapeHtml(entry.label)}</b> — Confirm Delete?</div>
        <button type="button" class="danger small" data-delconfirm="${escapeHtml(entry.jobId)}">Yes, delete</button>
        <button type="button" class="ghost small" data-delcancel>Cancel</button>
      </div>`;
  }
  return `
    <div class="task-row" data-job="${escapeHtml(entry.jobId)}">
      <div class="grow">
        <b>${escapeHtml(entry.label)}</b> <span class="muted mono">${escapeHtml(entry.jobId)}</span>${escapeHtml(series)}
        <div class="muted small">${escapeHtml((entry.status && entry.status.message) || '')}</div>
      </div>
      <span class="state-pill ${escapeHtml(state)}">${escapeHtml(text)}</span>
      <button type="button" class="ghost small" data-delete="${escapeHtml(entry.jobId)}" title="Delete task">🗑</button>
    </div>`;
}

async function renderList(app, { completed }) {
  const credentials = getCredentials();
  let pendingDelete = '';
  let alive = true;
  let timer = null;

  async function draw() {
    const entries = await loadAllTasks(credentials);
    const filtered = entries.filter((e) => {
      const terminal = e.status && isTerminal(e.status.state);
      return completed ? (e.status && e.status.state === 'complete') : !terminal || !e.status;
    });
    const title = completed ? 'Completed' : 'Tasks';
    const rows = filtered.map((e) => taskRowHtml(e, pendingDelete)).join('');
    const anyActive = !completed && filtered.some((e) => e.status && !isTerminal(e.status.state));
    app.innerHTML = `
      <div class="card">
        <h2>${title}</h2>
        ${anyActive ? '<p class="muted"><i>working — open a task for its live progress</i></p>' : ''}
        ${rows || `<p class="muted">${completed ? 'Nothing completed yet.' : 'No tasks yet. Start one from New video.'}</p>`}
        ${completed ? '' : '<div class="btn-row"><a class="btn primary" href="#/new">New video</a><a class="btn ghost" href="#/done">Completed</a></div>'}
      </div>`;

    for (const row of app.querySelectorAll('.task-row')) {
      row.addEventListener('click', (event) => {
        if (event.target.closest('button')) return;
        location.hash = `#/task/${encodeURIComponent(row.dataset.job)}`;
      });
    }
    for (const btn of app.querySelectorAll('[data-delete]')) {
      btn.addEventListener('click', () => { pendingDelete = btn.dataset.delete; draw(); });
    }
    for (const btn of app.querySelectorAll('[data-delcancel]')) {
      btn.addEventListener('click', () => { pendingDelete = ''; draw(); });
    }
    for (const btn of app.querySelectorAll('[data-delconfirm]')) {
      btn.addEventListener('click', async () => {
        const jobId = btn.dataset.delconfirm;
        btn.disabled = true;
        try {
          await deleteClipforgeJob(credentials, credentials.repo, jobId);
          removeTask(null, jobId);
          toast(`Task ${jobId} deleted.`, 'ok');
          pendingDelete = '';
          draw();
        } catch (error) {
          toast(error.message || 'Delete failed.', 'err');
          btn.disabled = false;
        }
      });
    }
    return filtered.some((e) => e.status && !isTerminal(e.status.state));
  }

  const hasActive = await draw();
  if (hasActive) {
    timer = setInterval(async () => {
      if (!alive) return;
      try { if (!(await draw()) && timer) { clearInterval(timer); timer = null; } } catch { /* keep polling */ }
    }, POLL_LIST_MS);
  }
  const { onTeardown } = await import('../../app.js');
  onTeardown(() => { alive = false; if (timer) clearInterval(timer); });
}

export async function renderTasks(app) { return renderList(app, { completed: false }); }
export async function renderListCompleted(app) { return renderList(app, { completed: true }); }

// ------------------------------------------------------------- task detail //

export async function renderTaskDetail(app, jobId) {
  const credentials = getCredentials();
  jobId = String(jobId || '');
  if (!jobId) { location.hash = '#/tasks'; return; }
  const label = ensureTaskLabel(jobId);

  let alive = true;
  let statusTimer = null;
  const { onTeardown } = await import('../../app.js');
  onTeardown(() => { alive = false; if (statusTimer) clearInterval(statusTimer); logsTeardown(); });

  // ----- logs (the task-04 rework) -------------------------------------- //

  let logsTimer = null;
  let logsStopped = false;
  function logsTeardown() { logsStopped = true; if (logsTimer) { clearInterval(logsTimer); logsTimer = null; } }

  function getCache() {
    return getLogCache(jobId) || { runId: 0, runTerminal: false, jobs: {} };
  }

  /** Group a job's raw log lines into its real steps by timestamp windows. */
  function groupSteps(job, text) {
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const lines = String(text || '').split('\n');
    const groups = steps.map((s) => ({
      name: String(s.name || 'step'),
      status: String(s.status || ''),
      conclusion: s.conclusion ? String(s.conclusion) : '',
      number: Number(s.number) || 0,
      lines: []
    }));
    if (!groups.length) {
      return [{ name: job.name || 'log', status: job.status || '', conclusion: job.conclusion || '', number: 0, lines }];
    }
    // Parse "2026-09-13T10:00:00.1234567Z rest of line" timestamps.
    const tsRe = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/;
    let cursor = 0; // groups are ordered by step number/time — never go backwards
    for (const line of lines) {
      const m = tsRe.exec(line);
      const content = m ? m[2] : line;
      let placed = false;
      if (m) {
        const t = Date.parse(m[1]);
        for (let i = cursor; i < steps.length; i++) {
          const s = steps[i];
          const start = s.started_at ? Date.parse(s.started_at) : -Infinity;
          const end = s.completed_at ? Date.parse(s.completed_at) : Infinity;
          if (t >= start && t <= end) { groups[i].lines.push(content); cursor = i; placed = true; break; }
          if (t < start) { // before this step's window: attach to previous group
            const at = Math.max(cursor, 0);
            groups[at].lines.push(content); placed = true; break;
          }
        }
      }
      if (!placed) groups[groups.length - 1].lines.push(content);
    }
    return groups;
  }

  function stepGlyph(group) {
    if (group.status === 'in_progress') return '⏳';
    if (group.conclusion === 'success') return '✔';
    if (group.conclusion === 'failure' || group.conclusion === 'cancelled') return '✖';
    if (group.conclusion === 'skipped') return '—';
    if (group.status === 'completed') return '✔';
    return '·';
  }

  function renderLogGroups(container, groups, activeIndex) {
    container.innerHTML = groups.map((g, i) => `
      <details class="log-step" data-step="${i}" ${i === activeIndex ? 'open' : ''}>
        <summary>${stepGlyph(g)} ${escapeHtml(g.name)}
          <span class="muted small">${escapeHtml(g.status)}${g.conclusion ? ` · ${escapeHtml(g.conclusion)}` : ''}</span>
        </summary>
        <div class="log-body">${escapeHtml(g.lines.join('\n')).trim() || '<span class="muted">(no output captured for this step yet)</span>'}</div>
      </details>`).join('');
  }

  async function refreshLogs(container, force) {
    const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
    const runId = status && status.run && Number(status.run.workflow_run_id);
    if (!runId) {
      container.innerHTML = '<p class="muted">No workflow run recorded yet — logs appear once a stage run starts.</p>';
      return;
    }
    const cache = getCache();
    if (cache.runId !== runId) { cache.runId = runId; cache.runTerminal = false; cache.jobs = {}; }
    if (cache.runTerminal && !force) { return; } // final; nothing new can arrive

    let run, jobs;
    try {
      [run, jobs] = await Promise.all([
        getRunInfo(credentials, credentials.repo, runId),
        listRunJobs(credentials, credentials.repo, runId)
      ]);
    } catch (error) {
      if (!Object.keys(cache.jobs).length) {
        container.innerHTML = `<p class="error-text">Could not read the workflow run: ${escapeHtml(error.message)}</p>`;
      }
      return;
    }
    cache.runTerminal = String(run.status) === 'completed';

    // Fetch logs only for jobs that are new, unfinished, or not yet final.
    for (const job of jobs) {
      const key = String(job.id);
      const cached = cache.jobs[key];
      if (cached && cached.final) { job._text = cached.text; continue; }
      try {
        job._text = await getJobLogs(credentials, credentials.repo, job.id);
      } catch {
        job._text = cached ? cached.text : '';
      }
      cache.jobs[key] = { text: job._text, final: String(job.status) === 'completed' };
    }
    setLogCache(jobId, cache);

    // Find the single active step across jobs (first in_progress wins).
    const sections = [];
    let activeIndex = -1;
    for (const job of jobs) {
      const groups = groupSteps(job, job._text || '');
      for (const g of groups) {
        const index = sections.length;
        sections.push(g);
        if (activeIndex === -1 && g.status === 'in_progress') activeIndex = index;
      }
    }
    if (!sections.length) {
      container.innerHTML = '<p class="muted">The run has not produced steps yet.</p>';
    } else {
      renderLogGroups(container, sections, activeIndex);
    }
    if (cache.runTerminal) logsTeardown();
  }

  function renderLogsInto(root) {
    const container = root.querySelector('#log-steps');
    // Cache-first: instantly render everything already fetched.
    const cache = getCache();
    if (Object.keys(cache.jobs).length) {
      const sections = [];
      let activeIndex = -1;
      for (const [key, entry] of Object.entries(cache.jobs)) {
        // Steps are unknown until the jobs API is read again; render flat
        // cached text under the job name so the view never starts blank.
        sections.push({ name: `cached output (job ${key})`, status: entry.final ? 'completed' : '', conclusion: '', lines: String(entry.text || '').split('\n') });
      }
      renderLogGroups(container, sections, -1);
    } else {
      container.innerHTML = '<p class="muted">Loading workflow logs…</p>';
    }
    refreshLogs(container, true);
    logsTimer = setInterval(() => { if (!logsStopped) refreshLogs(container, false); }, POLL_LOGS_MS);
  }

  // ----- detail view ----------------------------------------------------- //

  async function draw() {
    const [status, plan, request, zernio] = await Promise.all([
      readStatus(credentials, credentials.repo, jobId).catch(() => null),
      readProductionPlan(credentials, credentials.repo, jobId).catch(() => null),
      readStageARequest(credentials, credentials.repo, jobId).catch(() => null),
      readZernioSettingsSafe(credentials, credentials.repo).catch(() => null)
    ]);
    // task-06: if this job is a Super Series anchor, advance its queue once
    // (harmless no-op when waiting/done) and compute the queue/halt display.
    let superQueue = null;
    const superRaw = await tryGetJsonFile(credentials, credentials.repo, `jobs/${jobId}/super-plan.json`).catch(() => null);
    if (superRaw && superRaw.document && Array.isArray(superRaw.document.spawned)) {
      if (status && !isTerminal(status.state)) {
        try { await superQueueTick(credentials, credentials.repo, jobId); } catch { /* sweep retries */ }
      }
      superQueue = await describeSuperQueue(credentials, credentials.repo, jobId).catch(() => null);
    }

    if (!status) {
      app.innerHTML = `
        <div class="card">
          <h2>Task ${escapeHtml(label)} · <span class="mono">${escapeHtml(jobId)}</span></h2>
          <p class="error-text"><b>Status unavailable</b> — the job record could not be read. It may have failed
          before Stage A could report in, or it may have expired. Try Refresh, or delete this task if it is stale.</p>
          <div class="btn-row">
            <button type="button" id="td-refresh">Refresh</button>
            <button type="button" class="danger" id="td-delete">Delete task</button>
            <a class="btn ghost" href="#/tasks">← Tasks</a>
          </div>
        </div>`;
      wireCommon();
      return;
    }

    const state = String(status.state || 'queued');
    const series = status.series && typeof status.series === 'object' ? status.series : {};
    const progress = stateProgress(status);
    const publishing = status.publishing && String(status.publishing.status || 'not_requested') !== 'not_requested'
      ? zernioPublishingSummary(status.publishing) : '';

    const actions = [];
    if (state === 'awaiting_torrent_selection') {
      actions.push('<button type="button" class="primary" id="td-torrent">📂 Choose video file</button>');
    }
    if (state === 'awaiting_plan') {
      actions.push('<button type="button" id="td-prompt">🤖 Get agent prompt</button>');
      actions.push('<button type="button" class="primary" id="td-upload">⬆ Upload production.json</button>');
    }
    if (state === 'stage_b_queued' || state === 'stage_b_running') {
      actions.push('<button type="button" class="danger" id="td-cancelb">⛔ Cancel Stage B</button>');
    }
    if (state === 'error' || state === 'cancelled') {
      // bug-15: only offer restarts for stages that actually RAN.
      const stageBStarted = /stage b/i.test(String(status.message || ''));
      actions.push('<button type="button" id="td-restarta">↻ Restart Stage A</button>');
      if (stageBStarted) actions.push('<button type="button" id="td-restartb">↻ Restart Stage B</button>');
    }
    if (state === 'complete') {
      actions.push('<button type="button" class="primary" id="td-download">📥 Download</button>');
      // zernioTaskPublishButton (bug-62 exact port): the CTA only appears when
      // Zernio is enabled, and reflects the §6.2 publishing state — once a task
      // is published/partial/publishing/scheduled the raw publish CTA becomes a
      // status-view affordance; not_requested/failed/cancelled stay publishable.
      if (zernio && zernio.enabled === true) {
        const pubStatus = String(status.publishing && status.publishing.status || 'not_requested').toLowerCase();
        if (pubStatus === 'published' || pubStatus === 'partial') {
          actions.push('<button type="button" id="td-publish">✅ View publish status</button>');
        } else if (pubStatus === 'publishing' || pubStatus === 'scheduled') {
          actions.push('<button type="button" id="td-publish">⏳ View publish status</button>');
        } else {
          actions.push('<button type="button" id="td-publish">📣 Publish (Zernio)</button>');
        }
      }
      if (series.enabled === true) {
        actions.push('<button type="button" id="td-prompt">📋 Copy prompt</button>');
        actions.push('<a class="btn" href="#/series">📚 Series</a>');
      }
    }
    actions.push('<button type="button" id="td-refresh">🔄 Refresh</button>');
    if (isTerminal(state)) actions.push('<button type="button" class="danger" id="td-delete">🗑 Delete task</button>');

    const links = [];
    if (status.release_url) links.push(`<a class="btn ghost small" href="${escapeHtml(status.release_url)}" target="_blank" rel="noopener">Open release</a>`);
    if (status.run && status.run.workflow_run_url) links.push(`<a class="btn ghost small" href="${escapeHtml(String(status.run.workflow_run_url).replace(/\\\//g, '/'))}" target="_blank" rel="noopener">Workflow run</a>`);

    app.innerHTML = `
      <div class="card">
        <h2>Task ${escapeHtml(label)} · <span class="mono">${escapeHtml(jobId)}</span></h2>
        <p>State: <span class="state-pill ${escapeHtml(state)}">${escapeHtml(state)}</span>
          ${series.enabled === true ? ` · Series part ${Number(series.part) || 1}${series.is_final === true ? ' (final)' : ''}` : ''}</p>
        ${state === 'awaiting_torrent_selection' ? '<p class="muted">⏳ Waiting for your file selection — pick the file to process below.</p>' : ''}
        <p class="muted">${escapeHtml(status.message || '')}</p>
        ${publishing ? `<p class="muted">${escapeHtml(publishing)}</p>` : ''}
        ${progress !== null ? `<div class="progress-track"><div class="progress-fill" style="width:${progress}%"></div></div>` : ''}
        <p class="muted small">Created ${escapeHtml(formatEpoch(status.created_at_epoch))} · updated ${escapeHtml(formatEpoch(status.updated_at_epoch))}</p>
        <div class="btn-row wrap">${actions.join('')}</div>
        <div class="btn-row">${links.join('')}<a class="btn ghost" href="#/tasks">← Tasks</a></div>
      </div>
      ${superQueueCardHtml(superQueue)}
      <div class="card">
        <h3>Workflow logs</h3>
        <div id="log-steps"></div>
      </div>
      <div id="td-panel"></div>`;

    wireCommon();
    wireActions(status, plan, request, state);
    renderLogsInto(app);
    for (const row of app.querySelectorAll('[data-open]')) {
      row.addEventListener('click', () => {
        location.hash = `#/task/${encodeURIComponent(row.dataset.open)}`;
      });
    }
  }

  /** task-06: Super Series queue/halt display for an anchor job. */
  function superQueueCardHtml(queue) {
    if (!queue) return '';
    const rows = queue.spawned.map((p) => `
      <div class="list-row" data-open="${escapeHtml(p.jobId)}">
        <span class="grow">${p.state === 'complete' ? '✔' : (p.state === 'error' || p.state === 'cancelled') ? '⚠' : '⏳'}
          <b>Part ${p.part}</b> <span class="muted mono small">${escapeHtml(p.jobId)}</span></span>
        <span class="state-pill ${escapeHtml(p.state)}">${escapeHtml(p.state)}</span>
      </div>`).join('');
    let banner = '';
    if (queue.outcome.action === 'halted') {
      banner = `<p class="error-text">⏸ ${escapeHtml(queue.outcome.message)}</p>`;
    } else if (queue.outcome.action === 'waiting') {
      banner = `<p class="muted">Part ${queue.outcome.part} of ${queue.totalParts} is still running — the next part dispatches automatically when it completes.</p>`;
    } else if (queue.outcome.action === 'done') {
      banner = `<p class="muted">✔ All ${queue.totalParts} parts complete.</p>`;
    } else if (queue.outcome.action === 'queue' || queue.outcome.action === 'dispatched') {
      banner = `<p class="muted">Part ${queue.outcome.part} of ${queue.totalParts} is being dispatched…</p>`;
    }
    return `
      <div class="card">
        <h3>⚡ Super Series — ${escapeHtml(queue.seriesId)}</h3>
        <p class="muted small">${queue.spawned.length}/${queue.totalParts} parts dispatched</p>
        ${banner}
        <div class="list">${rows || '<p class="muted">No parts spawned yet.</p>'}</div>
        <div class="btn-row"><a class="btn ghost" href="#/series">📚 Series view</a></div>
      </div>`;
  }

  // ----- Zernio per-task publish (task-08 — port of bot index.js §8.5 ---- //

  /** loadZernioConfig equivalent: settings + accounts + secret presence. */
  async function loadZernioConfig() {
    const [settings, accounts, secretConfigured] = await Promise.all([
      readZernioSettingsSafe(credentials, credentials.repo),
      readZernioAccounts(credentials, credentials.repo).catch(() => []),
      actionsSecretExists(credentials, credentials.repo, ZERNIO_SECRET_NAME).catch(() => false)
    ]);
    return { settings, accounts, secretConfigured };
  }

  function zernioPublishingOf(status) {
    return (status && status.publishing && typeof status.publishing === 'object')
      ? status.publishing : { status: 'not_requested', posts: [], idempotency_key: '' };
  }

  /** Per-task publish menu — zernioPublishText + zernioPublishKeyboard. */
  async function showZernioPublishMenu(panel, label) {
    const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
    if (!status || status.state !== 'complete') {
      panel.innerHTML = `<div class="card"><h3>Publish — Task ${escapeHtml(label)}</h3>
        <p class="muted">Task ${escapeHtml(label)} is not complete yet — Zernio publishing is available only after Stage B reports <b>complete</b>.</p>
        <div class="btn-row"><button type="button" class="ghost" id="pub-close">Close</button></div></div>`;
      document.getElementById('pub-close').addEventListener('click', () => { panel.innerHTML = ''; });
      return;
    }
    const config = await loadZernioConfig();
    const publishing = zernioPublishingOf(status);
    const targets = zernioTargets(config.settings, config.accounts);

    // zernioPublishText body.
    const lines = [];
    if (!config.secretConfigured) lines.push('Save a Zernio API key in settings before submitting a request.');
    else if (!config.settings.enabled) lines.push('Enable Zernio publishing controls in settings before submitting a request.');
    else if (!targets.length) lines.push('Select at least one active TikTok, YouTube, or Instagram target account in settings.');
    else {
      lines.push(`Targets: ${targets.map((g) => `${g.platform} (${g.account_ids.length})`).join(' · ')}`);
      lines.push(`Timezone: ${escapeHtml(config.settings.smart_schedule.timezone)}`);
    }

    // zernioPublishKeyboard rows: publish affordances + per-post actions.
    const rows = [];
    if (config.secretConfigured && config.settings.enabled && targets.length) {
      rows.push(`<div class="btn-row">
        <button type="button" class="primary" id="pub-now">Publish now</button>
        <button type="button" id="pub-smart">Smart schedule</button>
        <button type="button" id="pub-manual">Choose date and time</button>
      </div>`);
    }
    const posts = Array.isArray(publishing.posts) ? publishing.posts : [];
    for (const post of posts.slice(0, 6)) {
      const postId = zernioPostId(post);
      if (!POST_ID_PATTERN.test(postId)) continue;
      const pstate = String(post.status || post.state || '').toLowerCase();
      const platform = String(post.platform || 'post');
      const platformLabel = ZERNIO_PLATFORM_LABELS[platform] || platform;
      if (['failed', 'error', 'partial'].includes(pstate)) {
        rows.push(`<div class="btn-row"><button type="button" data-post-retry="${escapeHtml(postId)}">Retry ${escapeHtml(platformLabel)}</button></div>`);
      }
      if (['scheduled', 'requested', 'publishing', 'partial', 'failed', 'error'].includes(pstate)) {
        rows.push(`<div class="btn-row">
          <button type="button" data-post-now="${escapeHtml(postId)}">Publish ${escapeHtml(platformLabel)} now</button>
          <button type="button" data-post-resched="${escapeHtml(postId)}">Reschedule ${escapeHtml(platformLabel)}</button>
          <button type="button" class="danger" data-post-cancel="${escapeHtml(postId)}">Cancel ${escapeHtml(platformLabel)}</button>
        </div>`);
      }
    }

    panel.innerHTML = `<div class="card">
      <h3>Task ${escapeHtml(label)} — Zernio publishing</h3>
      <p class="mono small">${escapeHtml(jobId)}</p>
      <p class="muted">${escapeHtml(zernioPublishingSummary(publishing))}</p>
      ${lines.map((l) => `<p class="muted">${l}</p>`).join('')}
      ${rows.join('')}
      <div class="btn-row">
        <button type="button" class="ghost" id="pub-refresh">Refresh publish menu</button>
        <button type="button" class="ghost" id="pub-close">Close</button>
      </div>
      <div id="pub-sub"></div>
    </div>`;
    panel.scrollIntoView({ behavior: 'smooth' });

    const sub = panel.querySelector('#pub-sub');
    panel.querySelector('#pub-close').addEventListener('click', () => { panel.innerHTML = ''; });
    panel.querySelector('#pub-refresh').addEventListener('click', () => showZernioPublishMenu(panel, label));

    const nowBtn = panel.querySelector('#pub-now');
    if (nowBtn) nowBtn.addEventListener('click', () => dispatchZernioPublish(panel, label, 'publish_now', ''));
    const smartBtn = panel.querySelector('#pub-smart');
    if (smartBtn) smartBtn.addEventListener('click', () => dispatchZernioPublish(panel, label, 'smart_schedule', ''));
    const manualBtn = panel.querySelector('#pub-manual');
    if (manualBtn) manualBtn.addEventListener('click', () => {
      sub.innerHTML = `<div class="field">
        <p class="muted small">Send the local scheduled time as <span class="mono">YYYY-MM-DDTHH:MM</span>. The configured Zernio timezone (${escapeHtml(config.settings.smart_schedule.timezone)}) will be used.</p>
        <input id="pub-dt" type="datetime-local">
        <div class="btn-row">
          <button type="button" class="primary" id="pub-dt-go">Schedule</button>
          <button type="button" class="ghost" id="pub-dt-cancel">Cancel</button>
        </div></div>`;
      sub.querySelector('#pub-dt-cancel').addEventListener('click', () => { sub.innerHTML = ''; });
      sub.querySelector('#pub-dt-go').addEventListener('click', () => {
        const value = String(sub.querySelector('#pub-dt').value || '').trim();
        if (!validZernioDateTime(value)) {
          toast('Send the local scheduled time as YYYY-MM-DDTHH:MM.', 'err');
          return;
        }
        dispatchZernioPublish(panel, label, 'manual_schedule', value);
      });
    });

    for (const btn of panel.querySelectorAll('[data-post-retry]')) {
      btn.addEventListener('click', () => dispatchZernioPostAction(panel, label, btn.dataset.postRetry, 'retry', '', ''));
    }
    for (const btn of panel.querySelectorAll('[data-post-now]')) {
      btn.addEventListener('click', () => dispatchZernioPostAction(panel, label, btn.dataset.postNow, 'update', 'publish_now', ''));
    }
    for (const btn of panel.querySelectorAll('[data-post-cancel]')) {
      btn.addEventListener('click', () => dispatchZernioPostAction(panel, label, btn.dataset.postCancel, 'cancel', '', ''));
    }
    for (const btn of panel.querySelectorAll('[data-post-resched]')) {
      btn.addEventListener('click', () => {
        const postId = btn.dataset.postResched;
        sub.innerHTML = `<div class="field">
          <p class="muted small">New local scheduled time as <span class="mono">YYYY-MM-DDTHH:MM</span> (${escapeHtml(config.settings.smart_schedule.timezone)}).</p>
          <input id="pub-pdt" type="datetime-local">
          <div class="btn-row">
            <button type="button" class="primary" id="pub-pdt-go">Reschedule</button>
            <button type="button" class="ghost" id="pub-pdt-cancel">Cancel</button>
          </div></div>`;
        sub.querySelector('#pub-pdt-cancel').addEventListener('click', () => { sub.innerHTML = ''; });
        sub.querySelector('#pub-pdt-go').addEventListener('click', () => {
          const value = String(sub.querySelector('#pub-pdt').value || '').trim();
          if (!validZernioDateTime(value)) {
            toast('Send the new local scheduled time as YYYY-MM-DDTHH:MM.', 'err');
            return;
          }
          dispatchZernioPostAction(panel, label, postId, 'update', 'manual_schedule', value);
        });
      });
    }
  }

  /** dispatchZernioPublish port: publish.yml action=publish for a new attempt. */
  async function dispatchZernioPublish(panel, label, mode, scheduledFor) {
    const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
    if (!status || status.state !== 'complete') throw new Error('Zernio publishing is available after Stage B completes.');
    const config = await loadZernioConfig();
    if (!config.secretConfigured) throw new Error('Save a Zernio API key in settings before publishing.');
    if (!config.settings.enabled) throw new Error('Enable Zernio publishing controls in settings before publishing.');
    const targets = zernioTargets(config.settings, config.accounts);
    if (!targets.length) throw new Error('Select at least one active TikTok, YouTube, or Instagram account in Zernio settings.');
    if (!['publish_now', 'smart_schedule', 'manual_schedule'].includes(mode)) throw new Error('That publishing mode is unavailable.');
    if (mode === 'manual_schedule' && !validZernioDateTime(scheduledFor)) throw new Error('Send a local time in YYYY-MM-DDTHH:MM format.');
    const publishing = zernioPublishingOf(status);
    await dispatchWorkflow(credentials, credentials.repo, PUBLISH_WORKFLOW, {
      action: 'publish',
      job_id: jobId,
      mode,
      scheduled_for: scheduledFor || '',
      timezone: config.settings.smart_schedule.timezone,
      targets_json: JSON.stringify(targets),
      request_id: zernioRequestId(jobId, publishing)
    });
    const modeLabel = mode === 'publish_now' ? 'publish-now' : mode === 'smart_schedule' ? 'smart-schedule' : 'scheduled';
    toast(`Zernio ${modeLabel} request dispatched for task ${label}. Stage B stays complete while Zernio processes the request.`, 'ok', 6000);
    showZernioPublishMenu(panel, label);
  }

  /** dispatchZernioPostAction port: publish.yml retry / update / cancel. */
  async function dispatchZernioPostAction(panel, label, postId, action, mode, scheduledFor) {
    if (!POST_ID_PATTERN.test(String(postId || '')) || !['retry', 'update', 'cancel'].includes(action)) {
      throw new Error('That Zernio post action is invalid.');
    }
    if (action === 'cancel') {
      const ok = await confirmDialog(`Cancel Zernio post ${postId}?`,
        'The scheduled/pending Zernio post for this platform is cancelled.', 'Cancel post', true);
      if (!ok) return;
    }
    const config = await loadZernioConfig();
    if (!config.secretConfigured) throw new Error('Save a Zernio API key in settings before managing posts.');
    if (action === 'update' && mode === 'manual_schedule' && !validZernioDateTime(scheduledFor)) {
      throw new Error('Send a local time in YYYY-MM-DDTHH:MM format.');
    }
    await dispatchWorkflow(credentials, credentials.repo, PUBLISH_WORKFLOW, {
      action,
      job_id: jobId,
      post_id: postId,
      mode: mode || '',
      scheduled_for: scheduledFor || '',
      timezone: config.settings.smart_schedule.timezone
    });
    toast(`Zernio ${action} request dispatched for task ${label}. Refresh the publish menu after the workflow finishes.`, 'ok', 6000);
    showZernioPublishMenu(panel, label);
  }

  function wireCommon() {
    const refresh = document.getElementById('td-refresh');
    if (refresh) refresh.addEventListener('click', () => draw());
    const del = document.getElementById('td-delete');
    if (del) del.addEventListener('click', async () => {
      const ok = await confirmDialog(`Delete task ${label}?`,
        'This removes the job files and its GitHub release. It cannot be undone.', 'Yes, delete', true);
      if (!ok) return;
      try {
        await deleteClipforgeJob(credentials, credentials.repo, jobId);
        removeTask(null, jobId);
        toast(`Task ${label} deleted.`, 'ok');
        location.hash = '#/tasks';
      } catch (error) {
        toast(error.message || 'Delete failed.', 'err');
      }
    });
  }

  function wireActions(status, plan, request, state) {
    const panel = document.getElementById('td-panel');

    const restartA = document.getElementById('td-restarta');
    if (restartA) restartA.addEventListener('click', async () => {
      restartA.disabled = true;
      try {
        const codeRef = await currentBranchSha(credentials, credentials.repo); // §8.5: never stale code
        await dispatchWorkflow(credentials, credentials.repo, STAGE_A_WORKFLOW, { job_id: jobId, code_ref: codeRef });
        toast(`Restarting Stage A for ${label}…`, 'ok');
        setTimeout(draw, 1500);
      } catch (error) { toast(error.message, 'err'); restartA.disabled = false; }
    });

    const restartB = document.getElementById('td-restartb');
    if (restartB) restartB.addEventListener('click', async () => {
      restartB.disabled = true;
      try {
        const planDoc = await readProductionPlan(credentials, credentials.repo, jobId);
        if (!planDoc) {
          toast('This task has no production.json yet — upload one (or restart Stage A) before Stage B can run.', 'err');
          restartB.disabled = false;
          return;
        }
        const musicRef = await resolveMusicRef(credentials, credentials.repo, request);
        const codeRef = await currentBranchSha(credentials, credentials.repo);
        await dispatchWorkflow(credentials, credentials.repo, STAGE_B_WORKFLOW, {
          job_id: jobId,
          production_ref: `path:jobs/${jobId}/production.json`,
          music_ref: musicRef,
          code_ref: codeRef
        });
        toast(`Restarting Stage B for ${label}…`, 'ok');
        setTimeout(draw, 1500);
      } catch (error) { toast(error.message, 'err'); restartB.disabled = false; }
    });

    const cancelB = document.getElementById('td-cancelb');
    if (cancelB) cancelB.addEventListener('click', async () => {
      const ok = await confirmDialog(`Cancel Stage B for task ${label}?`,
        'The running render is stopped and the job moves to <b>cancelled</b>. You can restart it afterwards.',
        'Yes, cancel Stage B', true);
      if (!ok) return;
      cancelB.disabled = true;
      try {
        const fresh = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
        const runId = fresh && fresh.run && Number(fresh.run.workflow_run_id);
        if (runId) {
          await cancelWorkflowRun(credentials, credentials.repo, runId);
        } else if (fresh && !isTerminal(fresh.state)) {
          // Queued-but-undispatched branch: no run id yet — cancel locally.
          const next = mergeStatus(fresh, { state: 'cancelled', message: 'Cancelled before the Stage B run started.' });
          await putTextFile(credentials, credentials.repo, STATUS_PATH(jobId), `${JSON.stringify(next, null, 2)}\n`, `clipforge: cancel job ${jobId}`);
        }
        toast(`Stage B cancelled for ${label}.`, 'ok');
        setTimeout(draw, 1200);
      } catch (error) { toast(error.message, 'err'); cancelB.disabled = false; }
    });

    const promptBtn = document.getElementById('td-prompt');
    if (promptBtn) promptBtn.addEventListener('click', () => {
      panel.innerHTML = agentPromptCard(status, request);
      const copyBtn = document.getElementById('ap-copy');
      copyBtn.addEventListener('click', async () => {
        const text = document.getElementById('ap-text').textContent;
        try { await navigator.clipboard.writeText(text); toast('Prompt copied.', 'ok'); }
        catch { toast('Copy failed — select the text manually.', 'err'); }
      });
      document.getElementById('ap-close').addEventListener('click', () => { panel.innerHTML = ''; });
      panel.scrollIntoView({ behavior: 'smooth' });
    });

    const uploadBtn = document.getElementById('td-upload');
    if (uploadBtn) uploadBtn.addEventListener('click', () => {
      panel.innerHTML = `
        <div class="card">
          <h3>Upload production.json — Task ${escapeHtml(label)}</h3>
          <p class="muted">Provide the plan as a <b>file</b> (.json, .txt, .md, or any text file whose content is the
          plan JSON, ≤ ${formatBytes(MAX_PLAN_BYTES)}) or paste the JSON below. It is validated against the §7.3
          contract before Stage B is dispatched.</p>
          <div class="btn-row">
            <button type="button" id="up-file">Choose file</button>
            <input type="file" id="up-file-input" accept=".json,.txt,.md,.markdown,text/plain,application/json" class="hidden">
          </div>
          <label class="field">…or paste the production plan JSON</label>
          <textarea id="up-paste" rows="8" placeholder='{"video_duration_seconds": …}'></textarea>
          <div class="btn-row">
            <button type="button" class="primary" id="up-submit">Validate &amp; dispatch Stage B</button>
            <button type="button" class="ghost" id="up-cancel">Cancel</button>
          </div>
          <div id="up-feedback"></div>
        </div>`;
      const feedback = (html, isErr) => {
        document.getElementById('up-feedback').innerHTML =
          `<p class="${isErr ? 'error-text' : 'muted'}" style="white-space:pre-wrap">${html}</p>`;
      };
      document.getElementById('up-cancel').addEventListener('click', () => { panel.innerHTML = ''; });
      const fileInput = document.getElementById('up-file-input');
      document.getElementById('up-file').addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        try {
          const text = await readPlanFile(file);
          document.getElementById('up-paste').value = text;
          feedback(`Loaded ${escapeHtml(file.name)} (${formatBytes(file.size)}). Review and dispatch below.`, false);
        } catch (error) { feedback(escapeHtml(error.message), true); }
      });
      document.getElementById('up-submit').addEventListener('click', async () => {
        const submit = document.getElementById('up-submit');
        submit.disabled = true;
        feedback('Validating and saving…', false);
        try {
          const result = await ingestProductionPlan(credentials, credentials.repo, jobId,
            document.getElementById('up-paste').value);
          if (result.superPlan) {
            // task-06: whole-series super-plan detour
            // (handleSuperPlanUploadMessage equivalent) — validate, persist
            // the durable queue record, then immediately dispatch part 1.
            feedback('Super Series anchor — validating the whole-series super-plan…', false);
            try {
              const superResult = await submitSuperPlan(credentials, credentials.repo, jobId, result.text);
              if (!superResult.ok) { feedback(escapeHtml(superResult.error), true); submit.disabled = false; return; }
              toast(`Super Series plan accepted — ${superResult.parts} parts queued; part 1 dispatched.`, 'ok', 6000);
              panel.innerHTML = '';
              setTimeout(draw, 1500);
            } catch (error) {
              feedback(escapeHtml(error.message || String(error)), true);
              submit.disabled = false;
            }
            return;
          }
          if (!result.ok) { feedback(escapeHtml(result.error), true); submit.disabled = false; return; }
          toast('Production plan uploaded — Stage B dispatched.', 'ok');
          panel.innerHTML = '';
          setTimeout(draw, 1500);
        } catch (error) { feedback(escapeHtml(error.message || String(error)), true); submit.disabled = false; }
      });
      panel.scrollIntoView({ behavior: 'smooth' });
    });

    const torrentBtn = document.getElementById('td-torrent');
    if (torrentBtn) torrentBtn.addEventListener('click', () => showTorrentPanel(panel, 0));

    const downloadBtn = document.getElementById('td-download');
    if (downloadBtn) downloadBtn.addEventListener('click', () => {
      // Full download/preview experience (progress, File System Access API)
      // is task-09; the release assets are directly linked here as the
      // bot's showDownloads equivalent.
      const assets = status.assets && typeof status.assets === 'object' ? status.assets : {};
      const rows = Object.entries(assets)
        .filter(([name, url]) => url && typeof url === 'string' && name !== 'analysis_bundle_url')
        .map(([name, url]) => `<div class="list-row"><span class="mono">${escapeHtml(name)}</span>
          <a class="btn primary small" href="${escapeHtml(String(url).replace(/\\\//g, '/'))}" target="_blank" rel="noopener">Download</a></div>`).join('');
      panel.innerHTML = `
        <div class="card">
          <h3>Download — Task ${escapeHtml(label)}</h3>
          ${rows ? `<div class="list">${rows}</div>` : '<p class="muted">No downloadable assets yet.</p>'}
          ${status.release_url ? `<div class="btn-row"><a class="btn ghost" href="${escapeHtml(status.release_url)}" target="_blank" rel="noopener">Open release page</a></div>` : ''}
          <div class="btn-row"><button type="button" class="ghost" id="dl-close">Close</button></div>
        </div>`;
      document.getElementById('dl-close').addEventListener('click', () => { panel.innerHTML = ''; });
      panel.scrollIntoView({ behavior: 'smooth' });
    });

    const publishBtn = document.getElementById('td-publish');
    if (publishBtn) publishBtn.addEventListener('click', () => showZernioPublishMenu(panel, label).catch((error) => {
      panel.innerHTML = `<div class="card"><h3>Publish — Task ${escapeHtml(label)}</h3>
        <p class="error-text">${escapeHtml(error && error.message || String(error))}</p>
        <div class="btn-row"><button type="button" class="ghost" id="pub-close">Close</button></div></div>`;
      document.getElementById('pub-close').addEventListener('click', () => { panel.innerHTML = ''; });
    }));
  }

  async function showTorrentPanel(panel, page) {
    const selection = await tryGetJsonFile(credentials, credentials.repo, `jobs/${jobId}/torrent-selection.json`);
    const candidates = selection && selection.document && Array.isArray(selection.document.video_candidates)
      ? selection.document.video_candidates : [];
    if (!candidates.length) {
      panel.innerHTML = `<div class="card"><h3>Choose the video file</h3>
        <p class="muted">The torrent candidate list is not available (yet). Refresh the task in a moment.</p>
        <div class="btn-row"><button type="button" class="ghost" id="tor-close">Close</button></div></div>`;
      document.getElementById('tor-close').addEventListener('click', () => { panel.innerHTML = ''; });
      return;
    }
    const totalPages = Math.ceil(candidates.length / TORRENT_CANDIDATES_PER_PAGE);
    const current = Math.min(Math.max(page, 0), totalPages - 1);
    const slice = candidates.slice(current * TORRENT_CANDIDATES_PER_PAGE, (current + 1) * TORRENT_CANDIDATES_PER_PAGE);
    panel.innerHTML = `
      <div class="card">
        <h3>Choose the video file — Task ${escapeHtml(label)}</h3>
        <p class="muted">The source contains ${candidates.length} video files. Pick the one to process.</p>
        <div class="list">${slice.map((c) => `
          <div class="list-row">
            <span class="grow">${escapeHtml(String(c.path || c.name || `file #${c.index}`))}
              <span class="muted small">${formatBytes(Number(c.size ?? c.size_bytes ?? c.length))}</span></span>
            <button type="button" class="primary small" data-index="${Number(c.index)}">Select</button>
          </div>`).join('')}</div>
        <div class="btn-row">
          ${current > 0 ? '<button type="button" id="tor-prev">◀ Prev</button>' : ''}
          ${current < totalPages - 1 ? '<button type="button" id="tor-next">Next ▶</button>' : ''}
          <button type="button" class="ghost" id="tor-close">Cancel</button>
        </div>
      </div>`;
    for (const btn of panel.querySelectorAll('button[data-index]')) {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const req = await readStageARequest(credentials, credentials.repo, jobId);
          req.source.torrent_file_index = String(Number(btn.dataset.index));
          await saveStageARequest(credentials, credentials.repo, jobId, req);
          const codeRef = await currentBranchSha(credentials, credentials.repo);
          await dispatchWorkflow(credentials, credentials.repo, STAGE_A_WORKFLOW, { job_id: jobId, code_ref: codeRef });
          const fresh = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
          if (fresh && fresh.state === 'awaiting_torrent_selection') {
            const next = mergeStatus(fresh, { state: 'stage_a_running', message: `Video file #${btn.dataset.index} selected — resuming ingest.` });
            await putTextFile(credentials, credentials.repo, STATUS_PATH(jobId), `${JSON.stringify(next, null, 2)}\n`, `clipforge: torrent file selected for job ${jobId}`);
          }
          toast('File selected — Stage A resuming.', 'ok');
          panel.innerHTML = '';
          setTimeout(draw, 1200);
        } catch (error) { toast(error.message, 'err'); btn.disabled = false; }
      });
    }
    const prev = document.getElementById('tor-prev');
    if (prev) prev.addEventListener('click', () => showTorrentPanel(panel, current - 1));
    const next = document.getElementById('tor-next');
    if (next) next.addEventListener('click', () => showTorrentPanel(panel, current + 1));
    document.getElementById('tor-close').addEventListener('click', () => { panel.innerHTML = ''; });
    panel.scrollIntoView({ behavior: 'smooth' });
  }

  /** Port of bot sendAgentPrompt — full prompt text + compact copy ladder. */
  function agentPromptCard(status, request) {
    const releaseUrl = status && status.release_url
      ? String(status.release_url).replace(/\\\//g, '/')
      : `https://github.com/${credentials.repo}/releases/tag/clipforge-${jobId}`;
    const options = request && request.options ? request.options : {};
    const target = Number(options.target_duration_seconds) || 120;
    const focus = String(options.focus || '');
    const focusClause = focus ? `, focused on: ${focus}` : '';
    const reqSeries = request && typeof request.series === 'object' && request.series ? request.series : {};
    const isSuperSeries = reqSeries.super_series === true;
    const seriesClause = reqSeries.enabled === true
      ? (isSuperSeries ? [
        '',
        `SUPER SERIES MODE — plan the WHOLE series "${String(reqSeries.series_id || '')}" in ONE document.`,
        'Do NOT produce a single-part production.json. 00_READ_THIS_FIRST.txt (SUPER SERIES MODE section at the top) defines the whole-series super-plan contract: one JSON document with version 2, your series_id, and a "parts" array where every part is a complete single-part production.json whose nested series.series_id matches EXACTLY.',
        'Reply with ONLY that one super-plan document.'
      ].join('\n') : [
        '',
        `SERIES MODE — this is Part ${Number(reqSeries.part) || 1} of series "${String(reqSeries.series_id || '')}".`,
        `The production.json MUST include a nested "series" object whose series_id is EXACTLY "${String(reqSeries.series_id || '')}", part is ${Number(reqSeries.part) || 1}, start_seconds is ${Number(reqSeries.start_seconds) || 0}, plus end_seconds, is_final (boolean) and a concise summary of this part.`,
        'Copy those three values verbatim — do not invent a new series id.'
      ].join('\n'))
      : '';
    const prompt = [
      `Open this GitHub release: ${releaseUrl}`,
      'Download and read 00_READ_THIS_FIRST.txt FIRST, then inspect the evidence assets (transcript.json, scene_index.json, key_moments.json, and the screenshot composites as needed).',
      isSuperSeries
        ? `Produce exactly one WHOLE-SERIES super-plan document for this series${focusClause}.${seriesClause}`
        : `Produce exactly one production.json for a vertical clip${focusClause}.${seriesClause}`,
      `The ~${target}s figure targets total SPOKEN NARRATION length only — it is NOT the video's length and must not influence how long any cut is, how many cuts you make, or where any end_seconds falls. The final video is exactly as long as the total narration, so keep TOTAL spoken words near ${target} x 3.1 (about ${Math.round(target * 3.133)} words). Choose every cut's end_seconds at the full on-screen completion of its visual payoff (per the PICKING end_seconds rules in 00_READ_THIS_FIRST.txt), even when the footage then runs longer than the narration.`,
      'The file must match the production.json contract in 00_READ_THIS_FIRST.txt exactly.',
      'Delivery: your ENTIRE reply must be ONLY the production.json. PREFER a .json file attachment; if you cannot attach files, reply with ONE ```json code block and nothing else. The JSON must be complete and valid: double quotes, no comments, no trailing commas, no truncation. No commentary, headings, or explanation outside the file or code block.'
    ].join('\n');
    return `
      <div class="card">
        <h3>Agent prompt — Task ${escapeHtml(label)}</h3>
        <p class="muted">Copy the full prompt below into your external AI agent. When the agent replies, use
        <b>Upload production.json</b> with the returned file. If the agent replies with prose or broken JSON, tell it:
        "Resend ONLY the complete valid production.json, as a file or one code block."</p>
        <pre class="summary" id="ap-text">${escapeHtml(prompt)}</pre>
        <div class="btn-row">
          <button type="button" class="primary" id="ap-copy">📋 Copy prompt</button>
          <button type="button" class="ghost" id="ap-close">Close</button>
        </div>
      </div>`;
  }

  await draw();

  // Live status polling while the task is non-terminal.
  statusTimer = setInterval(async () => {
    if (!alive) return;
    try {
      const s = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
      if (!s || isTerminal(s.state)) { if (statusTimer) { clearInterval(statusTimer); statusTimer = null; } }
      await draw();
    } catch { /* transient — next tick retries */ }
  }, POLL_DETAIL_MS);
}
