/**
 * Bot A KV storage layer (ARCHITECTURE.md §8: one persistent menu state,
 * per-chat encrypted credentials, task labels, relay staging records).
 *
 * Ported essentially verbatim from _legacy/telegram-bot/src/storage.js. The
 * KV write-avoidance optimization in putState (skip unchanged writes) is
 * load-bearing for the daily KV write quota — preserve it.
 */

import { decryptCredentials, encryptCredentials } from './crypto.js';

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const UPDATE_TTL_SECONDS = 24 * 60 * 60;
const RELAY_TTL_SECONDS = 12 * 60 * 60;

function key(chatId, suffix) {
  return `user:${String(chatId)}:${suffix}`;
}

export async function getState(env, chatId) {
  const raw = await env.CLIPFORGE_BOT_KV.get(key(chatId, 'state'));
  if (!raw) return { version: 1, flow: null, pending: {}, currentTask: null, activeViewId: null };
  try {
    const state = JSON.parse(raw);
    if (!state || state.version !== 1 || typeof state !== 'object') throw new Error('bad state');
    return {
      version: 1,
      flow: typeof state.flow === 'string' ? state.flow : null,
      pending: state.pending && typeof state.pending === 'object' ? state.pending : {},
      currentTask: typeof state.currentTask === 'string' ? state.currentTask : null,
      activeViewId: Number.isInteger(Number(state.activeViewId)) && Number(state.activeViewId) > 0 ? Number(state.activeViewId) : null
    };
  } catch {
    return { version: 1, flow: null, pending: {}, currentTask: null, activeViewId: null };
  }
}

export async function putState(env, chatId, state) {
  const stateKey = key(chatId, 'state');
  const serialized = JSON.stringify({
    version: 1,
    flow: state.flow || null,
    pending: state.pending || {},
    currentTask: state.currentTask || null,
    activeViewId: Number.isInteger(Number(state.activeViewId)) && Number(state.activeViewId) > 0 ? Number(state.activeViewId) : null
  });
  // View refreshes can revisit the exact same state. A read is far cheaper
  // than consuming a daily KV write quota, so persist only a real change.
  if (await env.CLIPFORGE_BOT_KV.get(stateKey) === serialized) return false;
  await env.CLIPFORGE_BOT_KV.put(stateKey, serialized, { expirationTtl: STATE_TTL_SECONDS });
  return true;
}

export async function clearFlow(env, chatId) {
  const state = await getState(env, chatId);
  state.flow = null;
  state.pending = {};
  await putState(env, chatId, state);
  return state;
}

export async function getCredentials(env, chatId) {
  const raw = await env.CLIPFORGE_BOT_KV.get(key(chatId, 'credentials'));
  return decryptCredentials(raw, chatId, env.KV_ENCRYPTION_KEY);
}

export async function putCredentials(env, chatId, credentials) {
  // bug-30: geminiKeys/pendingGeminiKey dropped — the Gemini mode is removed.
  const safe = {
    version: 1,
    githubPat: String(credentials.githubPat || ''),
    repo: String(credentials.repo || ''),
    pendingGithubPat: String(credentials.pendingGithubPat || '')
  };
  const encrypted = await encryptCredentials(safe, chatId, env.KV_ENCRYPTION_KEY);
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'credentials'), encrypted);
}

export async function deleteCredentials(env, chatId) {
  await env.CLIPFORGE_BOT_KV.delete(key(chatId, 'credentials'));
}

export async function putRelayJob(env, chatId, jobId, record) {
  const keyName = `relay:${String(chatId)}:${String(jobId)}`;
  const payload = { version: 1, job_id: String(jobId), chat_id: Number(chatId), ...(record || {}) };
  await env.CLIPFORGE_BOT_KV.put(keyName, JSON.stringify(payload), { expirationTtl: RELAY_TTL_SECONDS });
  return payload;
}

export async function getRelayJob(env, chatId, jobId) {
  const raw = await env.CLIPFORGE_BOT_KV.get(`relay:${String(chatId)}:${String(jobId)}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 && parsed.job_id === String(jobId) && Number(parsed.chat_id) === Number(chatId) ? parsed : null;
  } catch {
    return null;
  }
}

export async function getTasks(env, chatId) {
  const raw = await env.CLIPFORGE_BOT_KV.get(key(chatId, 'tasks'));
  if (!raw) return { version: 1, next: 0, labels: {}, options: {} };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== 1 || !parsed.labels || typeof parsed.labels !== 'object') throw new Error('bad tasks');
    return { version: 1, next: Number(parsed.next) || 0, labels: parsed.labels, options: parsed.options && typeof parsed.options === 'object' ? parsed.options : {} };
  } catch {
    return { version: 1, next: 0, labels: {}, options: {} };
  }
}

function nextLabel(index) {
  let n = index;
  let out = '';
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

// Bug 2 fix: labels are no longer allocated from a monotonically increasing
// counter that never shrinks. The lowest currently-unused label is chosen, so
// a letter freed by a manual delete (or reclamation) is reused by the next new
// task instead of labels only ever growing forward. tasks.next is kept as a
// high-water hint, but correctness no longer depends on it.
function lowestFreeLabelIndex(labels) {
  const used = new Set(Object.keys(labels || {}));
  let index = 0;
  while (used.has(nextLabel(index))) index += 1;
  return index;
}

export async function ensureTaskLabel(env, chatId, jobId) {
  const tasks = await getTasks(env, chatId);
  for (const [label, knownJobId] of Object.entries(tasks.labels)) {
    if (knownJobId === jobId) return label;
  }
  const index = lowestFreeLabelIndex(tasks.labels);
  const label = nextLabel(index);
  tasks.next = Math.max(Number(tasks.next) || 0, index + 1);
  tasks.labels[label] = jobId;
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'tasks'), JSON.stringify(tasks));
  return label;
}

export async function setTaskOptions(env, chatId, jobId, options) {
  const tasks = await getTasks(env, chatId);
  tasks.options[jobId] = { ...(tasks.options[jobId] || {}), ...options };
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'tasks'), JSON.stringify(tasks));
}

export async function getTaskOptions(env, chatId, jobId) {
  const tasks = await getTasks(env, chatId);
  return tasks.options[jobId] || {};
}

export async function getJobIdForLabel(env, chatId, label) {
  const tasks = await getTasks(env, chatId);
  return tasks.labels[String(label || '').toUpperCase()] || null;
}

export async function removeTask(env, chatId, label, jobId) {
  const tasks = await getTasks(env, chatId);
  const normalizedLabel = String(label || '').toUpperCase();
  if (!normalizedLabel || tasks.labels[normalizedLabel] !== jobId) return false;
  delete tasks.labels[normalizedLabel];
  delete tasks.options[jobId];
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'tasks'), JSON.stringify(tasks));
  return true;
}

// Feature 4 (unseen-task marker): the flag lives in tasks.options[jobId] —
// keyed by JOB id, not by label — so a freed-and-reused letter never
// inherits the previous occupant's seen state. New tasks default to unseen
// (absence of seen:true); the marker clears on the operator's first open.
export async function markTaskSeen(env, chatId, jobId) {
  const tasks = await getTasks(env, chatId);
  const record = tasks.options[jobId];
  if (record && record.seen === true) return false;
  tasks.options[jobId] = { ...(record || {}), seen: true };
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'tasks'), JSON.stringify(tasks));
  return true;
}

export async function isTaskSeen(env, chatId, jobId) {
  const tasks = await getTasks(env, chatId);
  const record = tasks.options[jobId];
  return Boolean(record && record.seen === true);
}

export async function taskLabels(env, chatId) {
  const tasks = await getTasks(env, chatId);
  return Object.entries(tasks.labels).map(([label, jobId]) => ({ label, jobId }));
}

// bug-31: the last announced clone-update marker (docs/update_notice.json's
// published_at). Stored per chat so a pushed update is announced exactly once.
export async function getAnnouncedUpdate(env, chatId) {
  return env.CLIPFORGE_BOT_KV.get(key(chatId, 'update_notice'));
}

export async function setAnnouncedUpdate(env, chatId, marker) {
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'update_notice'), String(marker || ''));
}

// bug-68: the last deploy-failure marker announced to this chat. The marker
// is the failed Deploy Bots run's id, so a new failed run is announced even
// if it lands on the same commit as a previously announced one (rerun after
// fixing the cause must re-notify if it fails again).
export async function getAnnouncedDeployFailure(env, chatId) {
  return env.CLIPFORGE_BOT_KV.get(key(chatId, 'deploy_failure'));
}

export async function setAnnouncedDeployFailure(env, chatId, marker) {
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'deploy_failure'), String(marker || ''));
}

// bug-46: the last announced news marker (docs/news.json's published_at) from
// the main account. Stored per chat so a pushed news message is announced
// exactly once per publication.
export async function getAnnouncedNews(env, chatId) {
  return env.CLIPFORGE_BOT_KV.get(key(chatId, 'news_notice'));
}

export async function setAnnouncedNews(env, chatId, marker) {
  await env.CLIPFORGE_BOT_KV.put(key(chatId, 'news_notice'), String(marker || ''));
}

export async function markUpdateSeen(env, updateId) {
  if (!Number.isInteger(updateId)) return false;
  const updateKey = `telegram:update:${updateId}`;
  const exists = await env.CLIPFORGE_BOT_KV.get(updateKey);
  if (exists) return true;
  await env.CLIPFORGE_BOT_KV.put(updateKey, '1', { expirationTtl: UPDATE_TTL_SECONDS });
  return false;
}
