/**
 * /cancel — abort the current wizard/input flow (§8.2). Never touches task
 * state. kv-minimization phase 5 step 5.8: there is no stored flow to clear
 * (menus/flows are stateless, ARCHITECTURE.md §8.9) — cancelling is purely
 * conversational: acknowledge, then show home. No storage write happens.
 */

import { showHome } from './start.js';
import { sendMessage } from '../telegram.js';

export async function handleCancel(env, chatId, messageId = null) {
  await sendMessage(env, chatId, 'Cancelled. Nothing was started.');
  return showHome(env, chatId, messageId);
}
