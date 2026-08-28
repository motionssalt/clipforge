/**
 * /start and /help — the §8.3 home screen (same as tapping "Menu").
 * Also owns the settings snapshot loader shared with commands/settings.js.
 */

import { getCredentials, getAnnouncedNews, setAnnouncedNews } from '../storage.js';
import {
  getRepositoryVisibility, readSeriesSettings, readZernioSettings, tryGetJsonFile
} from '../github.js';
import { MUSIC_DEFAULT_PATH, TTS_SETTINGS_PATH, WATERMARK_PATH } from '../constants.js';
import { sendMessage } from '../telegram.js';
import { escapeHtml } from '../constants.js';

// bug-46: news broadcasts are published by the main account into the SOURCE
// repo at this path; every clone announces a new publication once per chat.
const NEWS_PATH = 'docs/news.json';
const NEWS_SOURCE_REPO = 'motionssalt/clipforge';

/** Announce the latest main-account news broadcast once per publication. */
async function announceNews(env, chatId, credentials) {
  try {
    const result = await tryGetJsonFile(credentials, NEWS_SOURCE_REPO, NEWS_PATH).catch(() => null);
    const doc = result && result.document && typeof result.document === 'object' ? result.document : null;
    const message = doc && String(doc.message || '').trim();
    const marker = doc && String(doc.published_at || '');
    if (!message || !marker) return;
    const announced = await getAnnouncedNews(env, chatId);
    if (announced === marker) return;
    await setAnnouncedNews(env, chatId, marker);
    await sendMessage(env, chatId, `\ud83d\udcf0 <b>News from ClipForge</b>\n\n${escapeHtml(message)}`);
  } catch { /* news is best-effort — never block the home screen */ }
}
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
    repo: '', narratorVoice: '', seriesEnabled: false,
    watermarkName: '', musicDefaultPath: '', zernioEnabled: false, repoPrivate: null
  };
  if (!credentials || !credentials.repo) return empty;
  // bug-49: repo visibility rides the same batched read so settingsText() can
  // show public/private; a failed read leaves repoPrivate null and the line
  // simply omits the visibility suffix.
  const [narrator, watermark, musicDefault, series, zernio, visibility] = await Promise.all([
    safeDoc(credentials, TTS_SETTINGS_PATH),
    safeDoc(credentials, WATERMARK_PATH),
    safeDoc(credentials, MUSIC_DEFAULT_PATH),
    readSeriesSettings(credentials, credentials.repo).catch(() => null),
    readZernioSettings(credentials, credentials.repo).catch(() => null),
    getRepositoryVisibility(credentials, credentials.repo).catch(() => null)
  ]);
  return {
    repo: credentials.repo,
    narratorVoice: narrator && narrator.voice ? String(narrator.voice) : '',
    seriesEnabled: Boolean(series && (series.enabled === true || (series.document && series.document.enabled === true))),
    watermarkName: watermark && watermark.creator_name ? String(watermark.creator_name) : '',
    musicDefaultPath: musicDefault && musicDefault.library_track_path ? String(musicDefault.library_track_path) : '',
    zernioEnabled: Boolean(zernio && (zernio.enabled === true || (zernio.document && zernio.document.enabled === true))),
    repoPrivate: visibility && typeof visibility.private === 'boolean' ? visibility.private : null
  };
}

export async function showHome(env, chatId, messageId = null) {
  const credentials = await getCredentials(env, chatId);
  if (!credentials || !credentials.githubPat || !credentials.repo) {
    return renderInteractiveView(env, chatId, ONBOARDING_TEXT, { replyMarkup: onboardingKeyboard() }, messageId);
  }
  const snapshot = await loadSnapshot(credentials);
  const view = await renderInteractiveView(env, chatId, homeText(snapshot), { replyMarkup: homeKeyboard() }, messageId);
  await announceNews(env, chatId, credentials);
  return view;
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
  const { HELP_TEXT, helpKeyboard, renderInteractiveView } = await import('../views.js');
  // bug-23: the in-app command reference now carries a link to the full
  // Telegraph user guide.
  return renderInteractiveView(env, chatId, HELP_TEXT, { replyMarkup: helpKeyboard() }, null);
}
