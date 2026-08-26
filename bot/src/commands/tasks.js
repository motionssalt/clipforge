/**
 * /tasks — list active (non-terminal) tasks with their per-chat labels (§6.3,
 * §8.2). Each row opens the task status screen.
 */

import { readStatus } from '../github.js';
import { taskLabels } from '../storage.js';
import { isTerminal } from '../jobs.js';
import { buttons } from '../telegram.js';
import { escapeHtml } from '../constants.js';
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
  const active = entries.filter((entry) => !entry.status || !isTerminal(entry.status.state));
  const lines = ['<b>Active tasks</b>'];
  const rows = [];
  if (!active.length) {
    lines.push('No active tasks. Start one with 🎬 New video.');
  } else {
    for (const entry of active) {
      const state = entry.status ? String(entry.status.state) : 'queued';
      lines.push(`<b>${escapeHtml(entry.label)}</b> — ${escapeHtml(state)}`);
      rows.push([{ text: `Open ${entry.label} · ${state}`, callback_data: `task:open:${entry.label}` }]);
    }
  }
  rows.push([{ text: '← Menu', callback_data: 'menu:home' }]);
  return renderInteractiveView(env, chatId, lines.join('\n'), { replyMarkup: buttons(rows) }, messageId);
}

export const handleTasks = showTasks;
