/**
 * /tasks — list active (non-terminal) tasks with their per-chat labels (§6.3,
 * §8.2). Each row opens the task status screen.
 *
 * Bug 1 fix: a task whose status document cannot be read is no longer folded
 * into the active list as a plain "queued" row (indistinguishable from a
 * task that is genuinely still working). An unreadable status now surfaces
 * explicitly as a distinct "status unavailable" row.
 */

import { readStatus } from '../github.js';
import { taskLabels } from '../storage.js';
import { isTerminal } from '../jobs.js';
import { buttons } from '../telegram.js';
import { escapeHtml, describeTaskState } from '../constants.js';
import { requireCredentials } from '../runtime.js';
import { renderInteractiveView } from '../views.js';

const MAX_LISTED = 15;

/** Load statuses for the chat's labels; returns [{ label, jobId, status }]. */
export async function loadTaskList(env, chatId) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return { credentials: null, entries: [] };
  const labels = (await taskLabels(env, chatId)).slice(0, MAX_LISTED);
  const entries = await Promise.all(labels.map(async ({ label, jobId }) => {
    const status = await readStatus(credentials, credentials.repo, jobId).catch(() => null);
    return { label, jobId, status };
  }));
  return { credentials, entries };
}

export async function showTasks(env, chatId, messageId = null) {
  const { credentials, entries } = await loadTaskList(env, chatId);
  if (!credentials) return;
  // A task is "active" unless we can positively read a terminal state. An
  // unreadable status is NOT silently treated as "queued" (pre-fix behavior):
  // it is listed with an explicit unavailable marker so a job that died
  // before persisting its error status is visible to the operator.
  const active = entries.filter((entry) => !entry.status || !isTerminal(entry.status.state));
  const lines = ['<b>Active tasks</b>'];
  const rows = [];
  if (!active.length) {
    lines.push('No active tasks. Start one with 🎬 New video.');
  } else {
    for (const entry of active) {
      const unreadable = !entry.status;
      const stateText = describeTaskState(entry.status, { unreadable });
      lines.push(`<b>${escapeHtml(entry.label)}</b> — ${escapeHtml(stateText)}`);
      rows.push([{ text: `Open ${entry.label} · ${stateText}`, callback_data: `task:open:${entry.label}` }]);
    }
  }
  rows.push([{ text: '← Menu', callback_data: 'menu:home' }]);
  return renderInteractiveView(env, chatId, lines.join('\n'), { replyMarkup: buttons(rows) }, messageId);
}

export const handleTasks = showTasks;
