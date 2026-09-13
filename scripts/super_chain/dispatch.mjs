/**
 * ClipForge — the ONE shared Stage B dispatch module.
 *
 * EXACT equivalent of site/js/github.js's dispatchWorkflow() plus the
 * request plumbing it relies on (githubRequest / parseRepo / currentBranchSha
 * / resolveMusicRef / file put-get helpers), so GitHub Actions-side callers
 * (the super-chain follow-up below) use the SAME code path the browser
 * Dashboard uses for ordinary Stage B — not a reimplemented copy that can
 * drift (that drift, in the removed super-sweep.mjs, was the bug).
 *
 * Ordinary Stage B dispatch = dispatchWorkflow(creds, repo, 'stage-b.yml',
 * { job_id, production_ref, music_ref, code_ref }) — one direct call, made
 * at the moment it is needed. Super Series part N+1's dispatch is now that
 * same call, triggered by part N's stage-b.yml completion event.
 */
const API = 'https://api.github.com';
export const DEFAULT_BRANCH = 'main';
export const STAGE_B_WORKFLOW = 'stage-b.yml';
export const STATUS_PATH = (jobId) => `jobs/${jobId}/status.json`;
export const STAGE_A_REQUEST_PATH = (jobId) => `jobs/${jobId}/stage-a-request.json`;
export const PRODUCTION_PATH = (jobId) => `jobs/${jobId}/production.json`;
export const SUPER_PLAN_PATH = (jobId) => `jobs/${jobId}/super-plan.json`;

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s).replace(/\n/g, ''), 'base64').toString('utf8');

export function parseRepo(repo) {
  const [owner, name] = String(repo || '').split('/');
  if (!owner || !name) throw new Error(`Bad repo slug: ${repo}`);
  return { owner, name };
}

export async function githubRequest(credentials, path, options = {}) {
  const { owner, name } = parseRepo(credentials.repo);
  const url = `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${path}`;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Authorization': `Bearer ${credentials.token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'clipforge-shared-dispatch',
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  if (response.status === 204) return null;
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} ${path}: ${String(text).slice(0, 300)}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

/** THE shared dispatch — same call ordinary Stage B makes in site/js/github.js. */
export async function dispatchWorkflow(credentials, repo, workflow, inputs) {
  const { owner, name } = parseRepo(repo);
  return githubRequest({ token: credentials.token, repo },
    `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: 'POST',
      body: { ref: DEFAULT_BRANCH, inputs: inputs || {} },
    });
}

export async function currentBranchSha(credentials, repo) {
  const ref = await githubRequest({ token: credentials.token, repo },
    `/git/ref/heads/${encodeURIComponent(DEFAULT_BRANCH)}`);
  return ref && ref.object && ref.object.sha;
}

export async function getFile(credentials, repo, path) {
  try {
    const file = await githubRequest({ token: credentials.token, repo },
      `/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${DEFAULT_BRANCH}`);
    return { sha: file.sha, text: unb64(file.content) };
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

export async function getJson(credentials, repo, path) {
  const file = await getFile(credentials, repo, path);
  if (!file) return null;
  try { return JSON.parse(file.text); } catch { return null; }
}

export async function putJson(credentials, repo, path, obj, message) {
  const current = await getFile(credentials, repo, path);
  await githubRequest({ token: credentials.token, repo },
    `/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`, {
      method: 'PUT',
      body: {
        message,
        content: b64(JSON.stringify(obj, null, 2) + '\n'),
        branch: DEFAULT_BRANCH,
        ...(current ? { sha: current.sha } : {}),
      },
    });
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

export function newStatus(o) {
  return {
    version: 1, job_id: String(o.jobId), mode: o.mode || 'manual',
    state: o.state || 'queued', message: String(o.message || ''),
    updated_at_epoch: nowEpoch(), ...(o.series ? { series: o.series } : {}),
  };
}

/** Same default-music resolution as site/js/github.js resolveMusicRef. */
export async function resolveMusicRef(credentials, repo, request) {
  const music = (request && request.music) || {};
  const source = String(music.source || 'none');
  if (source === 'none') return '';
  if (source === 'explicit_library' || source === 'job_upload') return music.ref ? `path:${music.ref}` : '';
  if (source === 'default') {
    const def = await getJson(credentials, repo, 'branding/music_default.json');
    const p = def && def.library_track_path;
    return p ? `path:${p}` : '';
  }
  return '';
}
