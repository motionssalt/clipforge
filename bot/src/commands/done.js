/**
 * /done — completed tasks with download links (§8.2). Terminal-but-failed
 * tasks stay reachable from the task screen itself; this list is for the
 * successful ones.
 */

import { isTerminal } from '../jobs.js';
import { buttons } from '../telegram.js';
import { escapeHtml } from '../constants.js';
import { requireCredentials } from '../runtime.js';
import { renderInteractiveView } from '../views.js';
import { loadTaskList } from './tasks.js';

export async function showDone(env, chatId, messageId = null) {
  const { credentials, entries } = await loadTaskList(env, chatId);
  if (!credentials) return;
  const done = entries.filter((entry) => entry.status && isTerminal(entry.status.state));
  const lines = ['<b>Completed tasks</b>'];
  const rows = [];
  if (!done.length) {
    lines.push('Nothing has finished yet.');
  } else {
    for (const entry of done) {
      const state = String(entry.status.state);
      const mark = state === 'complete' ? '✅' : state === 'cancelled' ? '⛔' : '⚠️';
      lines.push(`${mark} <b>${escapeHtml(entry.label)}</b> — ${escapeHtml(state)}`);
      const row = [{ text: `${mark} Open ${entry.label}`, callback_data: `task:open:${entry.label}` }];
      if (state === 'complete' && entry.status.release_url) row.push({ text: 'Release', url: entry.status.release_url });
      rows.push(row);
    }
  }
  rows.push([{ text: '← Menu', callback_data: 'menu:home' }]);
  return renderInteractiveView(env, chatId, lines.join('\n'), { replyMarkup: buttons(rows) }, messageId);
}

export const handleDone = showDone;
