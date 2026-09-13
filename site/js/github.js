/**
 * ClipForge Dashboard — GitHub REST client.
 * Direct browser -> api.github.com calls with the operator's PAT.
 * NO Worker, NO proxy: GitHub's REST API is CORS-open for authenticated
 * browser requests. Ported semantics from bot/src/github.js.
 */

export const API_VERSION = '2022-11-28';
export const DEFAULT_BRANCH = 'main';
export const SHADOW_CLONE_SOURCE = 'motionssalt/clipforge';
export const CLONE_COPY_WORKFLOW = 'clone-copy.yml';
export const CLONE_STATUS_PATH = '.clipforge-clone-status.json';

export const CLONE_COPY_POLL_MS = 4000;
export const CLONE_COPY_FIRST_WAIT_MS = 120000;
export const CLONE_COPY_START_MS = 120000;
export const CLONE_COPY_STALL_MS = 360000;
export const CLONE_COPY_DEADLINE_MS = 600000;

export class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function parseRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error(`Bad repository slug: ${repo}`);
  return { owner, name };
}

export function normalizeRepoSlug(value) {
  let v = String(value || '').trim();
  v = v.replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  return v.toLowerCase();
}

/** The one main-account gate, identical semantics to bot identity.js isOriginalRepo. */
export const ORIGINAL_REPO = 'motionssalt/clipforge';
export function isOriginalRepo(repo) {
  return normalizeRepoSlug(repo) === ORIGINAL_REPO;
}

function encodePath(path) {
  return String(path).split('/').map(encodeURIComponent).join('/');
}

export function b64encode(text) {
  const bytes = new TextEncoder().encode(String(text));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Core request helper. `credentials` is { githubPat }. */
export async function githubRequest(credentials, path, options = {}) {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const headers = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    ...(options.headers || {})
  };
  if (credentials && credentials.githubPat) {
    headers['Authorization'] = `Bearer ${credentials.githubPat}`;
  }
  const init = { method: options.method || 'GET', headers };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const response = await fetch(url, init);
  if (response.status === 204) return null;
  let data = null;
  const text = await response.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const msg = data && data.message ? data.message : `HTTP ${response.status}`;
    throw new GitHubError(response.status, msg);
  }
  return data;
}

export async function getGitHubIdentity(pat) {
  const user = await githubRequest({ githubPat: pat }, '/user');
  if (!user || !user.login) throw new Error('GitHub did not return an identity for this token.');
  return { login: String(user.login) };
}

export async function validateConnection(pat, repo) {
  const { owner, name } = parseRepo(repo);
  const data = await githubRequest({ githubPat: pat }, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  if (!data || !data.full_name) throw new Error('Repository not found or not accessible with this token.');
  return { repo: String(data.full_name), private: data.private === true };
}

// ---------------------------------------------------------------- contents //

export async function getContent(credentials, repo, path) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}`);
}

export async function getJsonFile(credentials, repo, path) {
  const file = await getContent(credentials, repo, path);
  if (!file || file.type !== 'file' || typeof file.content !== 'string') {
    throw new Error(`Not a file: ${path}`);
  }
  return { document: JSON.parse(b64decode(file.content)), sha: file.sha };
}

/** Like getJsonFile but returns null on 404/parse failure instead of throwing. */
export async function tryGetJsonFile(credentials, repo, path) {
  try {
    return await getJsonFile(credentials, repo, path);
  } catch {
    return null;
  }
}

export async function putTextFile(credentials, repo, path, text, message) {
  const { owner, name } = parseRepo(repo);
  let existingSha;
  try {
    const existing = await getContent(credentials, repo, path);
    if (existing && existing.sha) existingSha = existing.sha;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: {
        message: String(message || `clipforge: update ${path}`),
        content: b64encode(text),
        ...(existingSha ? { sha: existingSha } : {})
      }
    });
}

export async function putBinaryFile(credentials, repo, path, bytes, message) {
  const { owner, name } = parseRepo(repo);
  let existingSha;
  try {
    const existing = await getContent(credentials, repo, path);
    if (existing && existing.sha) existingSha = existing.sha;
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  let bin = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
  }
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}`, {
      method: 'PUT',
      body: {
        message: String(message || `clipforge: update ${path}`),
        content: btoa(bin),
        ...(existingSha ? { sha: existingSha } : {})
      }
    });
}

export async function deleteFile(credentials, repo, path, message) {
  const { owner, name } = parseRepo(repo);
  const existing = await getContent(credentials, repo, path);
  if (!existing || !existing.sha) throw new Error(`Nothing to delete at ${path}`);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}`, {
      method: 'DELETE',
      body: { message: String(message || `clipforge: delete ${path}`), sha: existing.sha }
    });
}

/** Raw bytes of a repo file via the Contents API (Accept: raw). */
export async function getRepositoryFileBytes(credentials, repo, path, maximumBytes = 10 * 1024 * 1024) {
  const { owner, name } = parseRepo(repo);
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(path)}`, {
      headers: {
        'Accept': 'application/vnd.github.raw',
        'Authorization': `Bearer ${credentials.githubPat}`,
        'X-GitHub-Api-Version': API_VERSION
      }
    });
  if (!response.ok) throw new GitHubError(response.status, `Could not read ${path}`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maximumBytes) throw new Error(`File too large: ${path}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > maximumBytes) throw new Error(`File too large: ${path}`);
  return bytes;
}

// -------------------------------------------------------------- pipeline //

export const PRODUCTION_PATH = (jobId) => `jobs/${jobId}/production.json`;
export const STATUS_PATH = (jobId) => `jobs/${jobId}/status.json`;
export const STAGE_A_REQUEST_PATH = (jobId) => `jobs/${jobId}/stage-a-request.json`;
export const SUPER_PLAN_PATH = (jobId) => `jobs/${jobId}/super-plan.json`;

export const STAGE_A_WORKFLOW = 'stage-a.yml';
export const STAGE_B_WORKFLOW = 'stage-b.yml';
export const PUBLISH_WORKFLOW = 'publish.yml';

export const TERMINAL_STATES = new Set(['complete', 'error', 'cancelled']);
export function isTerminal(state) { return TERMINAL_STATES.has(String(state || '')); }

export async function listJobIds(credentials, repo) {
  try {
    const entries = await getContent(credentials, repo, 'jobs');
    if (!Array.isArray(entries)) return [];
    return entries.filter((e) => e && e.type === 'dir').map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readStatus(credentials, repo, jobId) {
  const result = await tryGetJsonFile(credentials, repo, STATUS_PATH(jobId));
  return result ? result.document : null;
}

export async function readStageARequest(credentials, repo, jobId) {
  const result = await tryGetJsonFile(credentials, repo, STAGE_A_REQUEST_PATH(jobId));
  return result ? result.document : null;
}

export async function readProductionPlan(credentials, repo, jobId) {
  const result = await tryGetJsonFile(credentials, repo, PRODUCTION_PATH(jobId));
  return result ? result.document : null;
}

/** Stamp + normalize a stage-a-request body (port of buildStageARequest). */
export function buildStageARequest(jobId, request) {
  const source = request && typeof request.source === 'object' ? request.source : {};
  const options = request && typeof request.options === 'object' ? request.options : {};
  const series = request && typeof request.series === 'object' ? request.series : {};
  const music = request && typeof request.music === 'object' ? request.music : {};
  return {
    version: 1,
    job_id: String(jobId),
    saved_at_epoch: Math.floor(Date.now() / 1000),
    source: {
      kind: String(source.kind || ''),
      value: String(source.value || ''),
      ...(source.torrent_file_index !== undefined && source.torrent_file_index !== ''
        ? { torrent_file_index: String(source.torrent_file_index) } : {})
    },
    options: {
      whisper_model: options.whisper_model || 'base',
      language: options.language || 'auto',
      task: options.task || 'translate_to_english',
      target_duration_seconds: Number(options.target_duration_seconds) || 120,
      focus: String(options.focus || ''),
      enable_vision_assist: options.enable_vision_assist !== false
    },
    mode: 'manual',
    series: {
      enabled: series.enabled === true,
      super_series: series.super_series === true,
      series_id: String(series.series_id || ''),
      source_job_id: String(series.source_job_id || ''),
      part: Number(series.part) || 0,
      start_seconds: Number(series.start_seconds) || 0,
      context: String(series.context || '')
    },
    music: {
      ref: String(music.ref || ''),
      source: String(music.source || 'none')
    }
  };
}

export async function saveStageARequest(credentials, repo, jobId, request) {
  const body = buildStageARequest(jobId, request);
  return putTextFile(credentials, repo, STAGE_A_REQUEST_PATH(jobId),
    `${JSON.stringify(body, null, 2)}\n`, `clipforge: stage-a request for job ${jobId}`);
}

export async function saveProductionPlan(credentials, repo, jobId, text) {
  return putTextFile(credentials, repo, PRODUCTION_PATH(jobId),
    String(text), `clipforge: production plan for job ${jobId}`);
}

export function newStatus({ jobId, mode, state, message, series }) {
  const now = Math.floor(Date.now() / 1000);
  const doc = {
    version: 1,
    job_id: String(jobId),
    mode: String(mode || 'manual'),
    state: String(state || 'queued'),
    message: String(message || ''),
    created_at_epoch: now,
    updated_at_epoch: now,
    expires_at_epoch: now + 172800 // CLIPFORGE_JOB_TTL_SECONDS mirror (48h)
  };
  if (series && series.enabled) {
    doc.series = {
      enabled: true,
      series_id: String(series.series_id || ''),
      part: Number(series.part) || 0,
      start_seconds: Number(series.start_seconds) || 0,
      is_final: series.is_final === true
    };
  }
  return doc;
}

/** Status merge: terminal states are sticky except terminal->terminal. */
export function mergeStatus(current, patch) {
  const next = { ...(current || {}), ...(patch || {}) };
  next.updated_at_epoch = Math.floor(Date.now() / 1000);
  return next;
}

export async function deleteClipforgeJob(credentials, repo, jobId) {
  // Delete every file under jobs/<id>/ then the release.
  const files = await getContent(credentials, repo, `jobs/${encodeURIComponent(jobId)}`).catch(() => []);
  if (Array.isArray(files)) {
    for (const file of files) {
      if (file && file.path && file.sha) {
        await githubRequest(credentials,
          `/repos/${encodeURIComponent(parseRepo(repo).owner)}/${encodeURIComponent(parseRepo(repo).name)}/contents/${encodePath(file.path)}`, {
            method: 'DELETE',
            body: { message: `clipforge: delete job ${jobId}`, sha: file.sha }
          }).catch(() => {});
      }
    }
  }
  // Best-effort release removal (clipforge-<jobId>).
  try {
    const { owner, name } = parseRepo(repo);
    const release = await githubRequest(credentials,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/tags/${encodeURIComponent(`clipforge-${jobId}`)}`);
    if (release && release.id) {
      await githubRequest(credentials,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/${release.id}`,
        { method: 'DELETE' });
      if (release.tag_name) {
        await githubRequest(credentials,
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/refs/tags/${encodeURIComponent(release.tag_name)}`,
          { method: 'DELETE' }).catch(() => {});
      }
    }
  } catch { /* no release — fine */ }
}

// -------------------------------------------------------------- actions //

export async function dispatchWorkflow(credentials, repo, workflow, inputs) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      body: { ref: DEFAULT_BRANCH, inputs: inputs || {} }
    });
}

export async function cancelWorkflowRun(credentials, repo, runId) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' });
}

export async function listWorkflowRuns(credentials, repo, workflowFile, perPage = 10) {
  const { owner, name } = parseRepo(repo);
  const body = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=${perPage}`);
  return (body && Array.isArray(body.workflow_runs) ? body.workflow_runs : []).map((run) => ({
    id: run.id, status: run.status, conclusion: run.conclusion,
    headSha: run.head_sha, htmlUrl: run.html_url, createdAt: run.created_at
  }));
}

/** Real per-step data for a workflow run (Dashboard log rework, task-04). */
export async function listRunJobs(credentials, repo, runId) {
  const { owner, name } = parseRepo(repo);
  const body = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(runId)}/jobs?per_page=100`);
  return body && Array.isArray(body.jobs) ? body.jobs : [];
}

export async function getRunInfo(credentials, repo, runId) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runs/${encodeURIComponent(runId)}`);
}

/**
 * Raw log text for one job. GitHub responds 302 -> signed download URL;
 * fetch follows the redirect automatically. Returns '' when the run has
 * not produced logs yet (GitHub 404s until the job starts).
 */
export async function getJobLogs(credentials, repo, jobId) {
  const { owner, name } = parseRepo(repo);
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/jobs/${encodeURIComponent(jobId)}/logs`, {
      headers: {
        'Authorization': `Bearer ${credentials.githubPat}`,
        'X-GitHub-Api-Version': API_VERSION
      }
    });
  if (response.status === 404) return '';
  if (!response.ok) throw new GitHubError(response.status, 'Could not fetch job logs.');
  return response.text();
}

export async function currentBranchSha(credentials, repo) {
  const { owner, name } = parseRepo(repo);
  const ref = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/ref/heads/${encodeURIComponent(DEFAULT_BRANCH)}`);
  return ref && ref.object && ref.object.sha ? String(ref.object.sha) : '';
}

// --------------------------------------------------------------- repo mgmt //

export async function getRepositoryVisibility(credentials, repo) {
  const { owner, name } = parseRepo(repo);
  const data = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`);
  return { private: data.private === true, fullName: String(data.full_name || repo) };
}

export async function setRepositoryVisibility(credentials, repo, makePrivate) {
  const { owner, name } = parseRepo(repo);
  const data = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: { private: makePrivate === true }
    });
  return { private: data.private === true, fullName: String(data.full_name || repo) };
}

export async function deleteRepository(credentials, repo) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, { method: 'DELETE' });
}

// --------------------------------------------------------------- secrets //

export async function getActionsPublicKey(credentials, repo) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/public-key`);
}

/**
 * Seal + store an Actions secret. GitHub requires libsodium
 * (X25519 + XSalsa20-Poly1305) sealed-box encryption; we load the
 * official libsodium.js build from CDN (static asset, not a Worker).
 */
let _sodiumPromise = null;
async function sodium() {
  if (!_sodiumPromise) {
    _sodiumPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/libsodium-wrappers@0.7.13/dist/sodium.min.js';
      script.onload = () => resolve(window.sodium);
      script.onerror = () => reject(new Error('Could not load the encryption library (libsodium).'));
      document.head.appendChild(script);
    }).then(async (s) => { await s.ready; return s; });
  }
  return _sodiumPromise;
}

export async function updateActionsSecret(credentials, repo, secretName, value) {
  const s = await sodium();
  const key = await getActionsPublicKey(credentials, repo);
  const messageBytes = new TextEncoder().encode(String(value));
  const keyBytes = s.from_base64(key.key, s.base64_variants.ORIGINAL);
  const sealed = s.crypto_box_seal(messageBytes, keyBytes);
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`, {
      method: 'PUT',
      body: { encrypted_value: s.to_base64(sealed, s.base64_variants.ORIGINAL), key_id: key.key_id }
    });
}

export async function actionsSecretExists(credentials, repo, secretName) {
  try {
    const { owner, name } = parseRepo(repo);
    await githubRequest(credentials,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`);
    return true;
  } catch {
    return false;
  }
}

export async function deleteActionsSecret(credentials, repo, secretName) {
  const { owner, name } = parseRepo(repo);
  return githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`,
    { method: 'DELETE' });
}

export const ZERNIO_SECRET_NAME = 'ZERNIO_API_KEY';
export const GEMINI_SECRET_NAME = 'GEMINI_API_KEYS';
export function zernioFingerprint(value) {
  const v = String(value || '');
  return v.length <= 8 ? '********' : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

// ------------------------------------------------------------- branding IO //

export const WATERMARK_PATH = 'branding/creator_watermark.json';
export const TTS_SETTINGS_PATH = 'branding/tts_settings.json';
export const MUSIC_DEFAULT_PATH = 'branding/music_default.json';
export const SERIES_SETTINGS_PATH = 'branding/series_settings.json';
export const SUPER_SERIES_SETTINGS_PATH = 'branding/super_series_settings.json';
export const ZERNIO_SETTINGS_PATH = 'branding/zernio_settings.json';
export const ZERNIO_ACCOUNTS_PATH = 'branding/zernio_accounts.json';
export const NEWS_PATH = 'docs/news.json';
export const UPDATE_NOTICE_PATH = 'docs/update_notice.json';

export async function readSeriesSettings(credentials, repo) {
  const result = await tryGetJsonFile(credentials, repo, SERIES_SETTINGS_PATH);
  return result ? result.document : null;
}
export async function saveSeriesSettings(credentials, repo, enabled) {
  return putTextFile(credentials, repo, SERIES_SETTINGS_PATH,
    `${JSON.stringify({ version: 1, enabled: enabled === true, updated_at_epoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
    'clipforge: update Series Mode setting');
}
export async function readSuperSeriesSettings(credentials, repo) {
  const result = await tryGetJsonFile(credentials, repo, SUPER_SERIES_SETTINGS_PATH);
  return result ? result.document : null;
}
export async function saveSuperSeriesSettings(credentials, repo, enabled) {
  return putTextFile(credentials, repo, SUPER_SERIES_SETTINGS_PATH,
    `${JSON.stringify({ version: 1, enabled: enabled === true, updated_at_epoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
    'clipforge: update Super Series setting');
}
// Exact bot shape (bot/src/github.js saveNarrator): the pipeline reads
// voice + engine; rate/volume/pitch defaults are written on every save.
export async function saveNarrator(credentials, repo, voice, label) {
  return putTextFile(credentials, repo, TTS_SETTINGS_PATH,
    `${JSON.stringify({ version: 1, engine: 'edge-tts', voice: String(voice), voice_label: String(label || voice), rate: '+20%', volume: '+0%', pitch: '+0Hz', updated_at_epoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
    'clipforge: save Edge TTS narrator');
}
export async function saveWatermark(credentials, repo, creatorName) {
  return putTextFile(credentials, repo, WATERMARK_PATH,
    `${JSON.stringify({ version: 1, creator_name: String(creatorName || ''), updated_at_epoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
    'clipforge: update watermark');
}
export async function saveMusicDefault(credentials, repo, trackPath) {
  return putTextFile(credentials, repo, MUSIC_DEFAULT_PATH,
    `${JSON.stringify({ version: 1, library_track_path: String(trackPath || ''), updated_at_epoch: Math.floor(Date.now() / 1000) }, null, 2)}\n`,
    'clipforge: set default music track');
}

export async function listAudioLibrary(credentials, repo) {
  try {
    const entries = await getContent(credentials, repo, 'audio-library');
    if (!Array.isArray(entries)) return [];
    return entries
      .filter((e) => e && e.type === 'file')
      .map((e) => ({ name: e.name, path: e.path, sha: e.sha, size: e.size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function deleteAudioLibraryTrack(credentials, repo, trackPath) {
  return deleteFile(credentials, repo, trackPath, `clipforge: delete audio library track ${trackPath}`);
}

export async function clearMusicDefaultIfTrack(credentials, repo, trackPath) {
  const current = await tryGetJsonFile(credentials, repo, MUSIC_DEFAULT_PATH);
  if (current && current.document && String(current.document.library_track_path || '') === String(trackPath)) {
    await saveMusicDefault(credentials, repo, '');
  }
}

// -------------------------------------------------------------- releases //

export async function findReleaseAsset(credentials, repo, tag, assetName) {
  const { owner, name } = parseRepo(repo);
  const release = await githubRequest(credentials,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/releases/tags/${encodeURIComponent(tag)}`);
  const asset = release && Array.isArray(release.assets)
    ? release.assets.find((a) => a && a.name === assetName) : null;
  if (!asset) return null;
  return {
    id: asset.id, name: asset.name, size: Number(asset.size) || 0,
    url: asset.url, // API URL (octet-stream)
    browserUrl: asset.browser_download_url,
    releaseUrl: release.html_url
  };
}

/** Authenticated release-asset download with progress callback. */
export async function downloadReleaseAsset(credentials, asset, onProgress) {
  const response = await fetch(String(asset.url || asset.browserUrl), {
    headers: {
      'Accept': 'application/octet-stream',
      'Authorization': `Bearer ${credentials.githubPat}`
    }
  });
  if (!response.ok) throw new GitHubError(response.status, 'Could not download the release asset.');
  const total = Number(response.headers.get('content-length') || asset.size || 0);
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (onProgress) onProgress(buf.length, total || buf.length);
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received, total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

// ---------------------------------------------------------------- zernio //

export const ZERNIO_PLATFORMS = ['tiktok', 'youtube', 'instagram'];
export const ZERNIO_PLATFORM_LABELS = { tiktok: 'TikTok', youtube: 'YouTube', instagram: 'Instagram' };
export const ZERNIO_MODES = ['publish_now', 'manual_schedule', 'smart_schedule'];
export const POST_ID_PATTERN = /^[A-Za-z0-9._-]{3,200}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

/** Legacy carry-over: interval_days: 2 means 48 hours, not 2. */
export function zernioIntervalHours(smart) {
  const explicit = Number(smart && smart.interval_hours);
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 8760) return explicit;
  const legacyDays = Number(smart && smart.interval_days);
  if (Number.isInteger(legacyDays) && legacyDays >= 1 && legacyDays <= 365) return legacyDays * 24;
  return 24;
}

export function defaultZernioSettings() {
  return {
    version: 1,
    enabled: false,
    auto_publish: false,
    automatic_mode: 'smart_schedule',
    target_accounts: { tiktok: [], youtube: [], instagram: [] },
    smart_schedule: {
      timezone: 'UTC',
      interval_hours: 24,
      preferred_time: '19:30',
      queue_depth: 4,
      start_mode: 'next_available',
      custom_start: ''
    }
  };
}

/** Coerce any stored/missing/corrupt value into the canonical settings doc. */
export function zernioSettingsOrDefault(value) {
  const current = value && typeof value === 'object' ? value : {};
  const smart = current.smart_schedule && typeof current.smart_schedule === 'object' ? current.smart_schedule : {};
  return {
    version: 1,
    enabled: current.enabled === true,
    auto_publish: current.auto_publish === true,
    automatic_mode: current.automatic_mode === 'publish_now' ? 'publish_now' : 'smart_schedule',
    target_accounts: {
      tiktok: Array.isArray(current.target_accounts && current.target_accounts.tiktok) ? current.target_accounts.tiktok.map(String) : [],
      youtube: Array.isArray(current.target_accounts && current.target_accounts.youtube) ? current.target_accounts.youtube.map(String) : [],
      instagram: Array.isArray(current.target_accounts && current.target_accounts.instagram) ? current.target_accounts.instagram.map(String) : []
    },
    smart_schedule: {
      timezone: String(smart.timezone || 'UTC'),
      interval_hours: zernioIntervalHours(smart),
      preferred_time: /^\d\d:\d\d$/.test(String(smart.preferred_time || '')) ? String(smart.preferred_time) : '19:30',
      queue_depth: Number.isInteger(Number(smart.queue_depth)) ? Number(smart.queue_depth) : 4,
      start_mode: smart.start_mode === 'custom' ? 'custom' : 'next_available',
      custom_start: String(smart.custom_start || '')
    }
  };
}

export async function readZernioSettings(credentials, repo) {
  const result = await tryGetJsonFile(credentials, repo, ZERNIO_SETTINGS_PATH);
  return result ? result.document : null;
}
/** Normalized read — always returns a canonical settings doc. */
export async function readZernioSettingsSafe(credentials, repo) {
  const raw = await readZernioSettings(credentials, repo).catch(() => null);
  return zernioSettingsOrDefault(raw);
}
export async function saveZernioSettings(credentials, repo, document) {
  return putTextFile(credentials, repo, ZERNIO_SETTINGS_PATH,
    `${JSON.stringify(document, null, 2)}\n`, 'clipforge: update Zernio settings');
}
export async function readZernioAccounts(credentials, repo) {
  const result = await tryGetJsonFile(credentials, repo, ZERNIO_ACCOUNTS_PATH);
  const doc = result ? result.document : null;
  if (Array.isArray(doc)) return doc;
  if (doc && Array.isArray(doc.accounts)) return doc.accounts;
  return [];
}

/** Active, selectable accounts from the committed snapshot, per platform. */
export function activeZernioAccounts(accounts) {
  const out = { tiktok: [], youtube: [], instagram: [] };
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const platform = String(account && account.platform || '').toLowerCase();
    const id = String(account && (account.id || account._id) || '').trim();
    if (!out[platform] || !id) continue;
    if (account.isActive === false || account.enabled === false || account.needsReconnection === true) continue;
    out[platform].push({
      id, platform,
      username: String(account.username || ''),
      displayName: String(account.displayName || '')
    });
  }
  return out;
}

/** publish.yml targets_json shape: [{ platform, account_ids: [...] }]. */
export function zernioTargets(settings, accounts) {
  const active = activeZernioAccounts(accounts);
  return ZERNIO_PLATFORMS.flatMap((platform) => {
    const selected = new Set(settings.target_accounts[platform] || []);
    const accountIds = active[platform].filter((a) => selected.has(a.id)).map((a) => a.id);
    return accountIds.length ? [{ platform, account_ids: accountIds }] : [];
  });
}

/** Toggle one account selection; refuses unavailable accounts. */
export function toggleZernioTarget(settings, accounts, platform, accountId) {
  if (!ZERNIO_PLATFORMS.includes(platform)) throw new Error('That Zernio account selection is invalid.');
  if (!POST_ID_PATTERN.test(String(accountId || ''))) throw new Error('That Zernio account selection is invalid.');
  const active = activeZernioAccounts(accounts)[platform];
  if (!active.some((a) => a.id === accountId)) {
    throw new Error('That Zernio account is unavailable or requires reconnection.');
  }
  const selected = new Set(settings.target_accounts[platform] || []);
  if (selected.has(accountId)) selected.delete(accountId); else selected.add(accountId);
  settings.target_accounts[platform] = [...selected];
  return settings;
}

export function validZernioTimezone(value) {
  return /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z_+\-]+)+)$/.test(String(value || '').trim());
}
export function validZernioTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || '').trim());
}
export function validZernioDateTime(value) {
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(value || '').trim());
}

/** Apply one smart-schedule field edit. Throws user-safe Error on invalid. */
export function applySmartScheduleField(settings, field, rawValue) {
  const value = String(rawValue || '').trim();
  const smart = settings.smart_schedule;
  if (field === 'timezone') {
    if (!validZernioTimezone(value)) throw new Error('Enter a safe IANA timezone such as Europe/London, America/New_York, or UTC.');
    smart.timezone = value;
  } else if (field === 'interval') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 8760) throw new Error('Cadence must be a whole number from 1 to 8760 hours.');
    smart.interval_hours = number;
    delete smart.interval_days;
  } else if (field === 'time') {
    if (!validZernioTime(value)) throw new Error('Preferred time must use HH:MM in 24-hour format.');
    smart.preferred_time = value;
  } else if (field === 'depth') {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 100) throw new Error('Queue depth must be a whole number from 1 to 100.');
    smart.queue_depth = number;
  } else if (field === 'custom_start') {
    if (!validZernioDateTime(value)) throw new Error('Send the first local slot as YYYY-MM-DDTHH:MM.');
    smart.start_mode = 'custom';
    smart.custom_start = value;
  } else {
    throw new Error('Unknown smart-schedule field.');
  }
  return settings;
}

export function zernioPostId(post) {
  return String(post && (post.id || post.post_id || post._id) || '').trim();
}

/** One human line summarizing the status.publishing block. */
export function zernioPublishingSummary(publishing) {
  const status = String(publishing && publishing.status || 'not_requested').toLowerCase();
  const label = status === 'published' ? 'published'
    : status === 'scheduled' ? 'scheduled'
    : status === 'publishing' ? 'publishing'
    : status === 'partial' ? 'partially published'
    : status === 'failed' ? 'failed'
    : status === 'cancelled' ? 'cancelled'
    : 'not requested';
  const posts = Array.isArray(publishing && publishing.posts) ? publishing.posts : [];
  return `Zernio: ${label}${posts.length ? ` · ${posts.length} post record(s)` : ''}`;
}

/** Idempotency key: reuse the prior key when the last attempt failed. */
export function zernioRequestId(jobId, publishing) {
  const prior = String(publishing && publishing.status || '').toLowerCase() === 'failed'
    ? String(publishing.idempotency_key || '') : '';
  if (REQUEST_ID_PATTERN.test(prior)) return prior;
  return `clipforge-${jobId}-${Date.now().toString(36)}`;
}

/** Mirror bot resolveMusicRef: request.music -> 'path:<ref>' or ''. */
export async function resolveMusicRef(credentials, repo, request) {
  const music = request && request.music ? request.music : {};
  const source = String(music.source || 'none');
  if (source === 'none') return '';
  if (source === 'explicit_library' || source === 'job_upload') {
    return music.ref ? `path:${music.ref}` : '';
  }
  if (source === 'default') {
    const doc = await tryGetJsonFile(credentials, repo, MUSIC_DEFAULT_PATH);
    const path = doc && doc.document && doc.document.library_track_path;
    return path ? `path:${path}` : '';
  }
  return '';
}
