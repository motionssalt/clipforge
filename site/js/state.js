/**
 * ClipForge Dashboard — client state.
 * Auth model (operator spec): one-time GitHub PAT prompt, stored in
 * localStorage, never re-prompted except on explicit Disconnect.
 * NO server-side session, NO Worker — the browser IS the client.
 *
 * Replaces the bot's per-chat D1/KV state with client-local equivalents:
 *  - credentials KV row      -> localStorage 'cf.credentials' { githubPat, repo }
 *  - task_labels D1 table    -> localStorage 'cf.labels' { jobId: label }
 *  - task_options D1 table   -> localStorage 'cf.taskOptions' { jobId: {...} }
 *  - clone job resume record -> localStorage 'cf.cloneJob' (the Dashboard tab
 *                               polls, replacing the bot cron for cloning)
 *  - log cache               -> localStorage 'cf.logs.<jobId>' (task-04)
 */

const LS = window.localStorage;
const K = {
  credentials: 'cf.credentials',
  labels: 'cf.labels',
  taskOptions: 'cf.taskOptions',
  cloneJob: 'cf.cloneJob',
  logPrefix: 'cf.logs.',
  downloaded: 'cf.downloaded'
};

function readJson(key, fallback) {
  try {
    const raw = LS.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  LS.setItem(key, JSON.stringify(value));
}

// ------------------------------------------------------------ credentials //

export function getCredentials() {
  const c = readJson(K.credentials, null);
  return c && c.githubPat && c.repo ? c : null;
}
export function setCredentials(credentials) {
  writeJson(K.credentials, {
    githubPat: String(credentials.githubPat),
    repo: String(credentials.repo)
  });
}
/** Explicit disconnect — the ONLY time the PAT is re-prompted afterwards. */
export function disconnect() {
  LS.removeItem(K.credentials);
}

// --------------------------------------------------------------- labels //
// Per-job human labels (A, B, C…) — the bot kept these in D1 task_labels;
// the Dashboard is a single-operator client so they live locally.

const LABEL_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function taskLabels() {
  const map = readJson(K.labels, {});
  return Object.entries(map).map(([jobId, label]) => ({ jobId, label }));
}

export function getJobIdForLabel(label) {
  const map = readJson(K.labels, {});
  for (const [jobId, l] of Object.entries(map)) {
    if (l === label) return jobId;
  }
  return null;
}

/** Assign (or return the existing) short label for a job id. */
export function ensureTaskLabel(jobId) {
  const map = readJson(K.labels, {});
  if (map[jobId]) return map[jobId];
  const used = new Set(Object.values(map));
  let label = null;
  for (const letter of LABEL_LETTERS) {
    if (!used.has(letter)) { label = letter; break; }
  }
  if (!label) {
    // All 26 taken: double letters, matching the bot's reusable-label growth.
    for (const a of LABEL_LETTERS) {
      for (const b of LABEL_LETTERS) {
        const candidate = a + b;
        if (!used.has(candidate)) { label = candidate; break; }
      }
      if (label) break;
    }
  }
  if (!label) label = `J${Object.keys(map).length + 1}`;
  map[jobId] = label;
  writeJson(K.labels, map);
  return label;
}

export function removeTask(label, jobId) {
  const map = readJson(K.labels, {});
  if (jobId && map[jobId] === label) delete map[jobId];
  else {
    for (const [id, l] of Object.entries(map)) if (l === label) delete map[id];
  }
  writeJson(K.labels, map);
  const options = readJson(K.taskOptions, {});
  if (jobId && options[jobId]) { delete options[jobId]; writeJson(K.taskOptions, options); }
}

// ---------------------------------------------------------- task options //

export function getTaskOptions(jobId) {
  return readJson(K.taskOptions, {})[jobId] || {};
}
export function setTaskOptions(jobId, patch) {
  const all = readJson(K.taskOptions, {});
  all[jobId] = { ...(all[jobId] || {}), ...(patch || {}) };
  writeJson(K.taskOptions, all);
}

// ------------------------------------------------------------- clone job //

export function getCloneJob() { return readJson(K.cloneJob, null); }
export function putCloneJob(job) { writeJson(K.cloneJob, job); }
export function deleteCloneJob() { LS.removeItem(K.cloneJob); }

// ------------------------------------------------------------- log cache //

export function getLogCache(jobId) {
  return readJson(K.logPrefix + jobId, null);
}
export function setLogCache(jobId, cache) {
  try { writeJson(K.logPrefix + jobId, cache); } catch { /* quota: drop */ }
}

// ---------------------------------------------------- downloaded markers //

export function isDownloaded(jobId, assetName) {
  const map = readJson(K.downloaded, {});
  return Boolean(map[`${jobId}:${assetName}`]);
}
export function markDownloaded(jobId, assetName) {
  const map = readJson(K.downloaded, {});
  map[`${jobId}:${assetName}`] = Date.now();
  writeJson(K.downloaded, map);
}

// ------------------------------------------------------------------ misc //

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function toast(message, kind = 'info', ms = 4200) {
  const region = document.getElementById('toast-region');
  if (!region) return;
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

/** Promise-based modal confirmation. */
export function confirmDialog(title, bodyHtml, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal">
        <h3>${escapeHtml(title)}</h3>
        <div class="muted">${bodyHtml}</div>
        <div class="btn-row">
          <button type="button" class="${danger ? 'danger' : 'primary'}" data-x="ok">${escapeHtml(confirmLabel)}</button>
          <button type="button" data-x="cancel">Cancel</button>
        </div>
      </div>`;
    backdrop.addEventListener('click', (event) => {
      const x = event.target && event.target.dataset && event.target.dataset.x;
      if (x === 'ok') { backdrop.remove(); resolve(true); }
      else if (x === 'cancel' || event.target === backdrop) { backdrop.remove(); resolve(false); }
    });
    document.body.appendChild(backdrop);
  });
}

export function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 * 1024 * 1024) return `${(b / (1024 ** 3)).toFixed(2)} GiB`;
  if (b >= 1024 * 1024) return `${(b / (1024 ** 2)).toFixed(1)} MiB`;
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KiB`;
  return `${b} B`;
}

export function formatEpoch(epochSeconds) {
  const n = Number(epochSeconds);
  if (!Number.isFinite(n) || n <= 0) return '';
  return new Date(n * 1000).toLocaleString();
}
