/**
 * /start and /help — the §8.3 home screen (same as tapping "Menu").
 * Also owns the settings snapshot loader shared with commands/settings.js.
 */

import { getCredentials } from '../storage.js';
import {
  readGeminiMetadata, readSeriesSettings, readZernioSettings, tryGetJsonFile
} from '../github.js';
import { MUSIC_DEFAULT_PATH, TTS_SETTINGS_PATH, WATERMARK_PATH } from '../constants.js';
import {
  ONBOARDING_TEXT, homeKeyboard, homeText, onboardingKeyboard, renderInteractiveView
} from '../views.js';

async function safeDoc(credentials, path) {
  try {
    const result = await tryGetJsonFile(credentials, credentials.repo, path);
    return result && result.document ? result.document : null;
  } catch {
    return null;
  }
}

/** One batched read of the small branding/ JSONs behind the home + settings screens. */
export async function loadSnapshot(credentials) {
  const empty = {
    repo: '', narratorVoice: '', seriesEnabled: false, geminiCount: 0,
    watermarkName: '', musicDefaultPath: '', zernioEnabled: false
  };
  if (!credentials || !credentials.repo) return empty;
  const [geminiMeta, narrator, watermark, musicDefault, series, zernio] = await Promise.all([
    readGeminiMetadata(credentials, credentials.repo).catch(() => []),
    safeDoc(credentials, TTS_SETTINGS_PATH),
    safeDoc(credentials, WATERMARK_PATH),
    safeDoc(credentials, MUSIC_DEFAULT_PATH),
    readSeriesSettings(credentials, credentials.repo).catch(() => null),
    readZernioSettings(credentials, credentials.repo).catch(() => null)
  ]);
  const localKeys = Array.isArray(credentials.geminiKeys) ? credentials.geminiKeys.length : 0;
  const metaCount = Array.isArray(geminiMeta) ? geminiMeta.length : 0;
  return {
    repo: credentials.repo,
    narratorVoice: narrator && narrator.voice ? String(narrator.voice) : '',
    seriesEnabled: Boolean(series && (series.enabled === true || (series.document && series.document.enabled === true))),
    geminiCount: localKeys || metaCount,
    watermarkName: watermark && watermark.creator_name ? String(watermark.creator_name) : '',
    musicDefaultPath: musicDefault && musicDefault.library_track_path ? String(musicDefault.library_track_path) : '',
    zernioEnabled: Boolean(zernio && (zernio.enabled === true || (zernio.document && zernio.document.enabled === true)))
  };
}

export async function showHome(env, chatId, messageId = null) {
  const credentials = await getCredentials(env, chatId);
  if (!credentials || !credentials.githubPat || !credentials.repo) {
    return renderInteractiveView(env, chatId, ONBOARDING_TEXT, { replyMarkup: onboardingKeyboard() }, messageId);
  }
  const snapshot = await loadSnapshot(credentials);
  return renderInteractiveView(env, chatId, homeText(snapshot), { replyMarkup: homeKeyboard() }, messageId);
}

/** /start is the home screen. */
export async function handleStart(env, chatId, messageId = null) {
  return showHome(env, chatId, messageId);
}

/**
 * /help — the in-app command reference (bug-06). The command surface had
 * drifted from the legacy bot with no current reference anywhere; /help now
 * answers with the actual current command list instead of the home screen.
 * It is intentionally a fresh message, never an edit of a prior view.
 */
export async function handleHelp(env, chatId) {
  const { HELP_TEXT, renderInteractiveView } = await import('../views.js');
  return renderInteractiveView(env, chatId, HELP_TEXT, {}, null);
}
