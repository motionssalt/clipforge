/**
 * /tasks — list active (non-terminal) tasks with their per-chat labels (§6.3,
 * §8.2). Each row opens the task status screen.
 *
 * Bug 1 fix: a task whose status document cannot be read is no longer folded
 * into the active list as a plain "queued" row (indistinguishable from a
 * task that is genuinely still working). An unreadable status now surfaces
 * explicitly as a distinct "status unavailable" row.
 *
 * Bug 2 fix: the list is sorted by actual creation time (most recent first)
 * instead of label order — label order stopped correlating with recency the
 * moment labels became reusable — and every row carries a delete button that
 * routes through the existing confirm-delete flow, so any stale or stuck
 * task can be cleared (and its letter reclaimed) by the operator.
 *
 * bug-02 (fix-sweep): tapping the delete button no longer switches to a
 * separate confirmation view. Instead it edits the row's own label to
 * "Confirm Delete?" in place, in the same list. Tapping the confirm button
 * again on that row actually deletes.
 */

import { readStatus } from '../github.js';
import { taskLabels, getTaskOptions } from '../storage.js';
import { buttons } from '../telegram.js';
import { escapeHtml, describeTaskState } from '../constants.js';
import { requireCredentials } from '../runtime.js';
import { renderInteractiveView } from '../views.js';

const MAX_LISTED = 15;

/** Sort a loaded task list by creation time, most recent first. */
export function sortTaskEntries(entries) {
  return entries.slice().sort((a, b) => {
    const aCreated = Number(a.status && a.status.created_at_epoch) || 0;
    const bCreated = Number(b.status && b.status.created_at_epoch) || 0;
    if (aCreated !== bCreated) return bCreated - aCreated; // newest first
    return a.label < b.label ? -1 : a.label > b.label ? 1 : 0;
  });
}

/** Load statuses for the chat's labels; returns sorted [{ label, jobId, status }]. */
export async function loadTaskList(env, chatId) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return { credentials: null, entries: [] };
  const labels = (await taskLabels(env, chatId)).slice(0, MAX_LISTED);
  const entries = await Promise.all(labels.map(async ({ label, jobId }) => {
    const [status, options] = await Promise.all([
      readStatus(credentials, credentials.repo, jobId).catch(() => null),
      getTaskOptions(env, chatId, jobId).catch(() => ({})),
    ]);
    // Feature 4: unseen is the default — only an explicit seen:true clears it.
    return { label, jobId, status, seen: Boolean(options && options.seen === true) };
  }));
  return { credentials, entries: sortTaskEntries(entries) };
}

/**
 * Render the active-task list. `pendingDeleteLabel` marks a single row as
 * awaiting delete confirmation: its label reads "Confirm Delete?" and its
 * trash button becomes the executing confirm button (bug-02).
 */
export async function showTasks(env, chatId, messageId = null, pendingDeleteLabel = '') {
  const { credentials, entries } = await loadTaskList(env, chatId);
  if (!credentials) return;
  // A task is "active" unless we can positively read a terminal state. An
  // unreadable status is NOT silently treated as "queued" (pre-fix behavior):
  // it is listed with an explicit unavailable marker so a job that died
  // before persisting its error status is visible to the operator.
  // bug-07 fix: terminal tasks (complete / error / cancelled) stay visible
  // in the task list with their terminal status instead of vanishing.
  // Pre-fix this filter dropped them from /tasks entirely, so a task that
  // finished or errored disappeared from the operator's main list and was
  // only reachable via /done.
  const active = entries;
  const lines = ['<b>Tasks</b>'];
  const rows = [];
  if (!active.length) {
    lines.push('No tasks yet. Start one with 🎬 New video.');
  } else {
    for (const entry of active) {
      const unreadable = !entry.status;
      const stateText = describeTaskState(entry.status, { unreadable });
      const termState = entry.status ? String(entry.status.state) : '';
      const terminalMark = termState === 'complete' ? '✅ ' : termState === 'error' ? '⚠️ ' : termState === 'cancelled' ? '⛔ ' : '';
      const marker = (entry.seen ? '' : '🆕 ') + terminalMark;
      const isPendingDelete = pendingDeleteLabel && entry.label === pendingDeleteLabel;
      if (isPendingDelete) {
        lines.push(`<b>${marker}${escapeHtml(entry.label)}</b> — <b>Confirm Delete?</b>`);
        rows.push([
          { text: `⚠️ ${entry.label} — Confirm Delete?`, callback_data: `task:delconfirm:${entry.label}` },
          { text: `✖ Cancel`, callback_data: `menu:tasks` }
        ]);
      } else {
        lines.push(`<b>${marker}${escapeHtml(entry.label)}</b> — ${escapeHtml(stateText)}`);
        rows.push([
          { text: `${marker}Open ${entry.label} · ${stateText}`, callback_data: `task:open:${entry.label}` },
          { text: `🗑 ${entry.label}`, callback_data: `task:del:${entry.label}` }
        ]);
      }
    }
  }
  rows.push([{ text: '← Menu', callback_data: 'menu:home' }]);
  return renderInteractiveView(env, chatId, lines.join('\n'), { replyMarkup: buttons(rows) }, messageId);
}

export const handleTasks = showTasks;
