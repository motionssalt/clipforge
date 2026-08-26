/**
 * /new — start the New-video wizard (§8.4). Owns the wizard step renderer,
 * which the callback router in index.js reuses for every wizard transition.
 */

import { clearFlow, getState, putState } from '../storage.js';
import { buttons } from '../telegram.js';
import { requireCredentials } from '../runtime.js';
import { renderInteractiveView } from '../views.js';
import { newWizard, stepPrompt } from '../wizard.js';

/** Render the wizard's current step into the chat's active view. */
export async function renderWizardStep(env, chatId, messageId = null, extra = '') {
  const state = await getState(env, chatId);
  const wizard = state.pending && state.pending.wizard;
  if (!wizard) {
    return renderInteractiveView(env, chatId, 'That wizard has expired. Start again with /new.', {
      replyMarkup: buttons([[{ text: '🎬 New video', callback_data: 'menu:new' }]])
    }, messageId);
  }
  const prompt = stepPrompt(wizard);
  const text = extra ? `${prompt.text}\n\n${extra}` : prompt.text;
  return renderInteractiveView(env, chatId, text, { replyMarkup: buttons(prompt.keyboard) }, messageId);
}

/** /new — always starts a fresh wizard (§8.1: one way to make a video). */
export async function handleNew(env, chatId, messageId = null) {
  const credentials = await requireCredentials(env, chatId, messageId);
  if (!credentials) return;
  await clearFlow(env, chatId);
  const state = await getState(env, chatId);
  state.flow = 'wizard';
  state.pending = { wizard: newWizard() };
  await putState(env, chatId, state);
  return renderWizardStep(env, chatId, messageId);
}
