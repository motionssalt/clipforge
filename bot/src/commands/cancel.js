/**
 * /cancel — abort the current wizard/input flow (§8.2). Never touches task
 * state; it only clears the chat's pending interaction.
 */

import { clearFlow } from '../storage.js';
import { showHome } from './start.js';
import { sendMessage } from '../telegram.js';

export async function handleCancel(env, chatId, messageId = null) {
  await clearFlow(env, chatId);
  await sendMessage(env, chatId, 'Cancelled. Nothing was started.');
  return showHome(env, chatId, messageId);
}
