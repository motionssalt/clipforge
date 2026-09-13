/** Completed view — the done list is the shared task-list renderer filtered
 * to state == 'complete' (task-04). */
import { renderListCompleted } from './tasks.js';

export async function renderDone(app) {
  return renderListCompleted(app);
}
