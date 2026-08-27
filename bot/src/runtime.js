/**
 * Shared UI runtime for Bot A — helpers used by both the command modules
 * (bot/src/commands/*) and the callback router (bot/src/index.js):
 * error mapping, the credentials gate, and the §8.5 task status screen.
 */

import { GitHubError, readStatus } from './github.js';
import { getCredentials, getJobIdForLabel } from './storage.js';
import { isTerminal } from './jobs.js';
import { buttons } from './telegram.js';
import { escapeHtml, redact } from './constants.js';
import { ONBOARDING_TEXT, onboardingKeyboard, renderInteractiveView } from './views.js';

/** Map internal errors to short, secret-free user text (§13 invariant #1). */
export function userError(error) {
  const raw = error && error.message ? error.message : 'The request could not be completed.';
  if (error instanceof GitHubError && error.status === 401) return 'GitHub rejected the stored token. Reconnect it in Settings → GitHub clone.';
  if (error instanceof GitHubError && error.status === 403) return 'GitHub denied this operation. Confirm the token has repository contents, Actions, and workflow permissions.';
  if (error instanceof GitHubError && error.status === 404) return 'GitHub could not find that repository, task, or workflow.';
  return redact(raw).slice(0, 900);
}

/**
 * Credentials gate. Renders the onboarding screen and returns null when the
 * chat is not yet bound to a clone.
 */
export async function requireCredentials(env, chatId, messageId = null) {
  const credentials = await getCredentials(env, chatId);
  if (!credentials || !credentials.githubPat || !credentials.repo) {
    await renderInteractiveView(env, chatId, `${ONBOARDING_TEXT}\n\n<b>Set up your GitHub clone first</b> — it takes about a minute.`, { replyMarkup: onboardingKeyboard() }, messageId);
    return null;
  }
  return credentials;
}

/** §8.5 — contextual buttons: only actions valid in the job's current state. */
export function taskKeyboard(status, label) {
  const state = status && status.state ? String(status.state) : 'queued';
  const rows = [];
  if (state === 'awaiting_torrent_selection') {
    rows.push([{ text: '📂 Choose video file', callback_data: `task:tsel:${label}:0` }]);
  }
  if (state === 'awaiting_plan') {
    rows.push([
      { text: '🤖 Get agent prompt', callback_data: `task:prompt:${label}` },
      { text: '⬆️ Upload production.json', callback_data: `task:upload:${label}` }
    ]);
  }
  if (state === 'stage_b_queued' || state === 'stage_b_running') {
    rows.push([{ text: '⛔ Cancel Stage B', callback_data: `task:cancelb:${label}` }]);
  }
  if (state === 'error' || state === 'cancelled') {
    rows.push([
      { text: '↻ Restart Stage A', callback_data: `task:restarta:${label}` },
      { text: '↻ Restart Stage B', callback_data: `task:restartb:${label}` }
    ]);
  }
  if (state === 'complete') {
    rows.push([
      { text: '📥 Download', callback_data: `task:dl:${label}` },
      { text: '📣 Publish (Zernio)', callback_data: `task:pub:${label}` }
    ]);
    const series = status.series && typeof status.series === 'object' ? status.series : {};
    if (status.mode === 'manual' && series.enabled === true && series.is_final !== true) {
      rows.push([{ text: '▶ Start next part', callback_data: `task:next:${label}` }]);
    }
  }
  rows.push([{ text: '🔄 Refresh', callback_data: `task:open:${label}` }]);
  // Bug 2 fix: deletion is offered for terminal tasks AND for tasks whose
  // status is unreadable (status == null) — a stuck task must be clearable
  // so its letter is reclaimed.
  if (isTerminal(state) || !status) rows.push([{ text: '🗑 Delete task', callback_data: `task:del:${label}` }]);
  rows.push([{ text: '← Tasks', callback_data: 'menu:tasks' }]);
  return buttons(rows);
}

/** §8.5 task status screen: state, message, links, contextual actions. */
export async function showTask(env, chatId, label, messageId = null) {
  const credentials = await requireCredentials(env, chatId, messageId);
  if (!credentials) return;
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!jobId) {
    return renderInteractiveView(env, chatId, `Unknown task <b>${escapeHtml(label)}</b>.`, { replyMarkup: buttons([[{ text: '← Tasks', callback_data: 'menu:tasks' }]]) }, messageId);
  }
  const status = await readStatus(credentials, credentials.repo, jobId);
  if (!status) {
    return renderInteractiveView(env, chatId,
      `<b>Task ${escapeHtml(label)}</b> · <code>${escapeHtml(jobId)}</code>\n\n<b>Status unavailable</b> — the job record could not be read. It may have failed before Stage A could report in, or it may have expired. Try Refresh, or delete this task if it is stale.`,
      { replyMarkup: buttons([[{ text: '🔄 Refresh', callback_data: `task:open:${label}` }], [{ text: '🗑 Delete task', callback_data: `task:del:${label}` }], [{ text: '← Tasks', callback_data: 'menu:tasks' }]]) },
      messageId);
  }
  const lines = [
    `<b>Task ${escapeHtml(label)}</b> · <code>${escapeHtml(jobId)}</code>`,
    `State: <b>${escapeHtml(status.state || 'queued')}</b>`,
    escapeHtml(status.message || '')
  ];
  const series = status.series && typeof status.series === 'object' ? status.series : {};
  if (series.enabled === true) lines.push(`Series: part ${Number(series.part) || 1}${series.is_final === true ? ' (final)' : ''}`);
  const linkRows = [];
  const links = [];
  if (status.release_url) links.push({ text: 'Open release', url: status.release_url });
  if (status.run && status.run.workflow_run_url) links.push({ text: 'Workflow run', url: status.run.workflow_run_url });
  if (links.length) linkRows.push(links);
  const keyboard = taskKeyboard(status, label);
  keyboard.inline_keyboard = [...linkRows, ...keyboard.inline_keyboard];
  return renderInteractiveView(env, chatId, lines.filter(Boolean).join('\n'), { replyMarkup: keyboard }, messageId);
}
