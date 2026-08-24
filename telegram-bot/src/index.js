import {
  COMMANDS, DEFAULT_VOICE, GEMINI_KEYS_META_PATH, MUSIC_DEFAULT_PATH, PRODUCTION_PATH, STAGE_LABELS, TARGET_DURATIONS, TTS_SETTINGS_PATH, WATERMARK_PATH,
  VOICES, WHISPER_MODELS, isTerminalStage, stageLabel
} from './constants.js';
import { maskSecret } from './crypto.js';
import {
  GitHubError, cancelWorkflowRun, createPrivateShadowClone, currentBranchSha, dispatchWorkflow, geminiFingerprint, getJsonFile,
  getReleaseTextAsset, getRepositoryFileBytes, listAudioLibrary, listJobIds, readGeminiMetadata, readStageARequest, readStatus, saveAutomaticMusicChoice,
  putBinaryFile, saveNarrator, saveProductionPlan, saveStageARequest, saveWatermark, tryGetJsonFile, updateGeminiSecret, validateConnection,
  writeGeminiMetadata
} from './github.js';
import { validateProductionPlan } from './production.js';
import {
  clearFlow, ensureTaskLabel, getCredentials, getJobIdForLabel, getState, getTaskOptions, markUpdateSeen,
  putCredentials, putState, setTaskOptions, taskLabels
} from './storage.js';
import { answerCallback, buttons, deleteMessage, downloadTelegramFile, downloadTelegramFileBytes, editMessage, getTelegramFile, sendAudioBytes, sendDocumentBytes, sendMessage } from './telegram.js';

const SOURCE_RE = /^(https?:\/\/|magnet:\?)/i;
const SAFE_JOB_RE = /^[A-Za-z0-9._-]+$/;
const MAX_TASKS = 12;
const MAX_TORRENT_BYTES = 1024 * 1024;
const TORRENT_CANDIDATES_PER_PAGE = 8;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function normalizedButtonText(value, fallback = 'Unnamed track') {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() || fallback;
}

function telegramButtonText(value, maximumBytes = 60) {
  const text = normalizedButtonText(value);
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maximumBytes) return text;
  const suffix = '…';
  let output = '';
  for (const character of text) {
    if (encoder.encode(output + character + suffix).length > maximumBytes) break;
    output += character;
  }
  return `${output || 'Track'}${suffix}`;
}

function torrentCandidateButtonText(value, maximumBytes = 48) {
  const text = normalizedButtonText(value, 'Unnamed video');
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maximumBytes) return text;
  const suffix = '…';
  const contentBudget = maximumBytes - encoder.encode(suffix).length;
  const prefixBudget = Math.floor(contentBudget / 2);
  const suffixBudget = contentBudget - prefixBudget;
  let prefix = '';
  for (const character of text) {
    if (encoder.encode(prefix + character).length > prefixBudget) break;
    prefix += character;
  }
  let ending = '';
  for (const character of Array.from(text).reverse()) {
    if (encoder.encode(character + ending).length > suffixBudget) break;
    ending = character + ending;
  }
  return `${prefix || 'Video'}${suffix}${ending}`;
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function redact(value) {
  return String(value || '')
    .replace(/(?:ghp|github_pat)_[A-Za-z0-9_]{12,}/g, '[redacted]')
    .replace(/AIza[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/AQ\.[A-Za-z0-9._-]{12,}/g, '[redacted]');
}

function userError(error) {
  const raw = error && error.message ? error.message : 'The request could not be completed.';
  if (error instanceof GitHubError && error.status === 401) return 'GitHub rejected the stored token. Reconnect it from /settings.';
  if (error instanceof GitHubError && error.status === 403) return 'GitHub denied this operation. Confirm the token has repository contents, Actions, and workflow permissions.';
  if (error instanceof GitHubError && error.status === 404) return 'GitHub could not find that repository, task, or workflow.';
  return redact(raw).slice(0, 900);
}

function mainMenu() {
  return buttons([
    [{ text: 'Automatic', callback_data: 'menu:auto' }, { text: 'Manual', callback_data: 'menu:manual' }],
    [{ text: 'Tasks', callback_data: 'menu:tasks' }, { text: 'Status', callback_data: 'menu:status' }],
    [{ text: 'Completed', callback_data: 'menu:done' }, { text: 'Settings', callback_data: 'menu:settings' }]
  ]);
}

function hasResumablePendingTask(state) {
  const pending = state && state.pending;
  return Boolean(pending && pending.mode && pending.source && pending.jobId && [
    'manual_focus', 'automatic_focus', 'manual_duration', 'automatic_duration', 'manual_music', 'automatic_music'
  ].includes(state.flow));
}

function homeMenu(state) {
  const rows = [...mainMenu().inline_keyboard];
  if (hasResumablePendingTask(state)) rows.push([{ text: `Resume pending ${state.pending.mode} task`, callback_data: 'resume:task' }]);
  return buttons(rows);
}

function settingsMenu() {
  return buttons([
    [{ text: 'GitHub clone', callback_data: 'set:github' }, { text: 'Gemini API key', callback_data: 'set:gemini' }],
    [{ text: 'Narrator', callback_data: 'set:voice' }, { text: 'Music default', callback_data: 'set:music_default' }],
    [{ text: 'Watermark', callback_data: 'set:watermark' }],
    [{ text: 'Back to menu', callback_data: 'menu:home' }]
  ]);
}

function cloneOnboardingMenu() {
  return buttons([
    [{ text: 'Create private Shadow Clone', callback_data: 'clone:new' }],
    [{ text: 'Connect existing clone', callback_data: 'clone:connect' }],
    [{ text: 'Cancel', callback_data: 'flow:cancel' }]
  ]);
}

function musicMenu() {
  return buttons([
    [{ text: 'No music', callback_data: 'music:none' }, { text: 'Use saved default', callback_data: 'music:default' }],
    [{ text: 'Choose library track', callback_data: 'music:library' }],
    [{ text: 'Cancel', callback_data: 'flow:cancel' }]
  ]);
}

function durationMenu() {
  return buttons([
    TARGET_DURATIONS.slice(0, 3).map((seconds) => ({ text: seconds === 60 ? '1 min' : `${seconds}s`, callback_data: `dur:${seconds}` })),
    TARGET_DURATIONS.slice(3).map((seconds) => ({ text: seconds === 180 ? '3 min' : '5 min', callback_data: `dur:${seconds}` })),
    [{ text: 'Cancel', callback_data: 'flow:cancel' }]
  ]);
}

function commandOf(text) {
  const first = String(text || '').trim().split(/\s+/)[0].toLowerCase().replace(/@[^\s]+$/, '');
  return COMMANDS.has(first) ? first : null;
}

async function requireCredentials(env, chatId) {
  const credentials = await getCredentials(env, chatId);
  if (!credentials || !credentials.githubPat || !credentials.repo) {
    await sendMessage(env, chatId, 'Set up your private GitHub clone first. Send <b>/start</b> and choose <b>Create private Shadow Clone</b> or <b>Connect existing clone</b>.');
    return null;
  }
  return credentials;
}

async function showHome(env, chatId) {
  const credentials = await getCredentials(env, chatId);
  const configured = credentials && credentials.githubPat && credentials.repo;
  const existing = await readExistingSettings(credentials);
  const gemini = credentials && credentials.geminiKeys && credentials.geminiKeys.length;
  if (!configured) {
    await sendMessage(env, chatId,
      '<b>ClipForge Telegram operator</b>\n\nThis is one shared bot. Your private Telegram chat operates only the GitHub clone connected to your chat. Create your own private Shadow Clone, or connect a clone you already have.',
      { replyMarkup: cloneOnboardingMenu() });
    return;
  }
  const state = await getState(env, chatId);
  const pendingNotice = hasResumablePendingTask(state)
    ? `\n\n<b>Pending task setup:</b> the source is staged but Stage A has not been dispatched. Resume it to choose focus, duration, and music.`
    : '';
  await sendMessage(env, chatId,
    `<b>ClipForge Telegram operator</b>\n\nConnected to <code>${escapeHtml(credentials.repo)}</code>. This shared bot keeps tasks and credentials isolated to this chat.\n${existingGeminiLabel(gemini ? credentials.geminiKeys : [], existing.geminiMeta)}.${pendingNotice}`,
    { replyMarkup: homeMenu(state) });
}

async function readExistingSettings(credentials) {
  if (!credentials || !credentials.repo) return { geminiMeta: [], narrator: null, watermark: null, musicDefault: null };
  const safeJson = async (path) => {
    try { return await tryGetJsonFile(credentials, credentials.repo, path); }
    catch { return null; }
  };
  const [geminiMeta, narrator, watermark, musicDefault] = await Promise.all([
    readGeminiMetadata(credentials, credentials.repo).catch(() => []),
    safeJson(TTS_SETTINGS_PATH),
    safeJson(WATERMARK_PATH),
    safeJson(MUSIC_DEFAULT_PATH)
  ]);
  return { geminiMeta, narrator: narrator && narrator.document, watermark: watermark && watermark.document, musicDefault: musicDefault && musicDefault.document };
}

function existingGeminiLabel(localKeys, metadata) {
  if (localKeys && localKeys.length) return `Gemini keys: ${localKeys.map(maskSecret).join(', ')} stored in this bot chat`;
  if (metadata && metadata.length) return `Gemini keys: ${metadata.length} existing site key${metadata.length === 1 ? '' : 's'} already configured in GitHub Actions`;
  return 'Gemini keys: not configured';
}

async function showSettings(env, chatId) {
  const credentials = await getCredentials(env, chatId);
  const existing = await readExistingSettings(credentials);
  const lines = ['<b>Settings</b>'];
  lines.push(credentials && credentials.repo ? `GitHub clone: <code>${escapeHtml(credentials.repo)}</code>` : 'GitHub clone: not connected');
  lines.push(existingGeminiLabel(credentials && credentials.geminiKeys, existing.geminiMeta));
  const voice = existing.narrator && VOICES[existing.narrator.voice] ? existing.narrator.voice : DEFAULT_VOICE;
  lines.push(`Narrator: ${escapeHtml(VOICES[voice].label)} (Edge TTS)`);
  lines.push(`Watermark: ${existing.watermark && existing.watermark.creator_name ? escapeHtml(existing.watermark.creator_name) : 'not set'}`);
  lines.push(`Music default: ${existing.musicDefault && existing.musicDefault.library_track_path ? escapeHtml(String(existing.musicDefault.library_track_path).replace(/^audio-library\//, '')) : 'not set'}`);
  lines.push('Existing Gemini secrets remain opaque: the bot can use them but will never display or copy their raw values.');
  await sendMessage(env, chatId, lines.join('\n'), { replyMarkup: settingsMenu() });
}

function normalizeFocus(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized === '-' || normalized.toLowerCase() === 'none') return '';
  if (normalized.length > 500) throw new Error('Editorial focus must be 500 characters or fewer.');
  return normalized;
}

function validateSource(value) {
  const source = String(value || '').trim();
  if (!SOURCE_RE.test(source)) throw new Error('Send a public https:// video URL, an anyone-with-link Google Drive URL, or a magnet URI.');
  if (source.length > 4000) throw new Error('The source URL is too long.');
  return source;
}

function startTaskJobId(mode) {
  return `${mode === 'automatic' ? 'automatic' : 'manual'}-${Date.now()}`;
}

function formatStatus(label, jobId, status) {
  if (!status) return `<b>Task ${escapeHtml(label)}</b>\n<code>${escapeHtml(jobId)}</code>\nStatus has not been written yet. The workflow may still be starting.`;
  const lines = [`<b>Task ${escapeHtml(label)} — ${escapeHtml(stageLabel(status.stage))}</b>`, `<code>${escapeHtml(jobId)}</code>`];
  if (status.message) lines.push(escapeHtml(status.message));
  if (status.expires_at_epoch) lines.push(`Expires: ${escapeHtml(new Date(Number(status.expires_at_epoch) * 1000).toLocaleString())}`);
  const runUrl = status.extra && status.extra.workflow_run_url;
  if (runUrl && /^https:\/\//.test(runUrl)) lines.push(`<a href="${escapeHtml(runUrl)}">Open GitHub workflow</a>`);
  if (status.release_url && /^https:\/\//.test(status.release_url)) lines.push(`<a href="${escapeHtml(status.release_url)}">Open release</a>`);
  return lines.join('\n');
}

function taskButtons(label, status) {
  const rows = [[{ text: 'Refresh', callback_data: `status:${label}` }]];
  if (!status) return buttons(rows);
  if (['error', 'cancelled'].includes(status.stage)) rows.push([{ text: 'Restart Stage A', callback_data: `retry:a:${label}` }]);
  if (status.stage === 'awaiting_torrent_selection') rows.push([{ text: 'Choose torrent video', callback_data: `torrent:${label}` }]);
  if (status.stage === 'awaiting_json_upload') rows.push([{ text: 'Get agent prompt', callback_data: `agent:${label}` }, { text: 'Upload production.json', callback_data: `plan:${label}` }]);
  if (['error', 'cancelled', 'complete'].includes(status.stage)) rows.push([{ text: 'Restart Stage B', callback_data: `retry:b:${label}` }]);
  if (['stage_b_queued', 'stage_b_running'].includes(status.stage)) rows.push([{ text: 'Cancel Stage B', callback_data: `cancel:${label}` }]);
  return buttons(rows);
}

async function listTasks(env, chatId, completedOnly = false) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  const ids = await listJobIds(credentials, credentials.repo);
  if (!ids.length) { await sendMessage(env, chatId, 'No ClipForge tasks exist in this clone yet.'); return; }
  const entries = [];
  for (const jobId of ids) {
    const status = await readStatus(credentials, credentials.repo);
    let dispatched = Boolean(status);
    if (!dispatched) {
      try { await readStageARequest(credentials, credentials.repo, jobId); dispatched = true; }
      catch (error) { if (!(error instanceof GitHubError && error.status === 404)) throw error; }
    }
    if (!dispatched) continue; // A source.torrent alone is staged task input, not a dispatched task.
    if (completedOnly && (!status || status.stage !== 'complete')) continue;
    const label = await ensureTaskLabel(env, chatId, jobId);
    entries.push({ label, jobId, status });
    if (entries.length >= MAX_TASKS) break;
  }
  if (!entries.length) { await sendMessage(env, chatId, completedOnly ? 'No completed tasks were found.' : 'No dispatched tasks were found.'); return; }
  const text = entries.map(({ label, jobId, status }) => `<b>${label}</b> · ${escapeHtml(stageLabel(status ? status.stage : 'starting'))}\n<code>${escapeHtml(jobId)}</code>`).join('\n\n');
  const rows = entries.map(({ label }) => [{ text: `Task ${label}`, callback_data: completedOnly ? `done:${label}` : `status:${label}` }]);
  await sendMessage(env, chatId, `<b>${completedOnly ? 'Completed tasks' : 'Tasks'}</b>\n\n${text}`, { replyMarkup: buttons(rows) });
}

async function showTaskStatus(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) { if (!jobId) await sendMessage(env, chatId, 'That task label is no longer available. Use /tasks to refresh it.'); return; }
  const status = await readStatus(credentials, credentials.repo, jobId);
  const state = await getState(env, chatId);
  state.currentTask = jobId;
  await putState(env, chatId, state);
  await sendMessage(env, chatId, formatStatus(label, jobId, status), { replyMarkup: taskButtons(label, status) });
}

async function showCompleted(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const status = await readStatus(credentials, credentials.repo, jobId);
  if (!status || status.stage !== 'complete') { await sendMessage(env, chatId, 'That task is not complete yet.'); return; }
  const assets = status.assets || {};
  const lines = [`<b>Task ${escapeHtml(label)} is complete.</b>`, `<code>${escapeHtml(jobId)}</code>`];
  if (assets.final_mp4) lines.push(`<a href="${escapeHtml(assets.final_mp4)}">Download final.mp4</a>`);
  if (assets.final_zip) lines.push(`<a href="${escapeHtml(assets.final_zip)}">Download final ZIP</a>`);
  if (!assets.final_mp4 && !assets.final_zip) lines.push('The completion status has no final asset URL. Open the release from /status.');
  await sendMessage(env, chatId, lines.join('\n'));
}

async function resumePendingTask(env, chatId) {
  const state = await getState(env, chatId);
  if (!hasResumablePendingTask(state)) { await sendMessage(env, chatId, 'There is no staged task setup to resume.'); return; }
  if (state.flow.endsWith('_focus')) return sendMessage(env, chatId, 'Resume task setup: send an optional editorial focus, or send <code>-</code> to consider the whole video.');
  if (state.flow.endsWith('_duration')) return sendMessage(env, chatId, 'Resume task setup: choose the target output length.', { replyMarkup: durationMenu() });
  return sendMessage(env, chatId, 'Resume task setup: choose optional background music.', { replyMarkup: musicMenu() });
}

async function beginTask(env, chatId, mode) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  if (mode === 'automatic' && !(credentials.geminiKeys || []).length) {
    const metadata = await readGeminiMetadata(credentials, credentials.repo).catch(() => []);
    if (!metadata.length) {
      await sendMessage(env, chatId, 'Automatic Mode needs at least one Gemini API key. Add it from /settings before starting.');
      return;
    }
  }
  const state = await getState(env, chatId);
  state.flow = `${mode}_source`;
  state.pending = { mode };
  await putState(env, chatId, state);
  await sendMessage(env, chatId, `<b>${mode === 'automatic' ? 'Automatic' : 'Manual'} task</b>\nSend a public video URL, Google Drive anyone-with-link URL, magnet URI, or upload a non-empty <code>.torrent</code> document up to 1 MB. Send /cancel to stop.`);
}

async function finishTaskLaunch(env, chatId) {
  const state = await getState(env, chatId);
  const pending = state.pending || {};
  const credentials = await requireCredentials(env, chatId);
  if (!credentials || !pending.mode || !pending.source || !TARGET_DURATIONS.includes(Number(pending.duration))) return;
  const jobId = pending.jobId || startTaskJobId(pending.mode);
  const inputs = {
    video_url: pending.source,
    torrent_file_index: '',
    job_id: jobId,
    whisper_model: 'base',
    language: 'auto',
    target_duration_seconds: String(pending.duration),
    focus: pending.focus || '',
    automatic_mode: pending.mode === 'automatic' ? 'true' : 'false'
  };
  await saveStageARequest(credentials, credentials.repo, jobId, inputs);
  if (pending.mode === 'automatic' && pending.musicSource !== 'default') {
    await saveAutomaticMusicChoice(credentials, credentials.repo, jobId, pending.musicRef || '', pending.musicSource || 'none');
  }
  await dispatchWorkflow(credentials, credentials.repo, 'stage-a.yml', inputs);
  const label = await ensureTaskLabel(env, chatId, jobId);
  await setTaskOptions(env, chatId, jobId, { musicRef: pending.musicRef || '', mode: pending.mode });
  state.flow = null;
  state.pending = {};
  state.currentTask = jobId;
  await putState(env, chatId, state);
  await sendMessage(env, chatId, `Task <b>${label}</b> was dispatched.\n<code>${escapeHtml(jobId)}</code>\nUse /status or the button below for progress.`, { replyMarkup: buttons([[{ text: `View Task ${label}`, callback_data: `status:${label}` }]]) });
}

async function chooseLibrary(env, chatId) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  const tracks = (await listAudioLibrary(credentials, credentials.repo)).slice(0, 10);
  if (!tracks.length) { await sendMessage(env, chatId, 'No saved audio-library tracks exist in this clone. Choose no music or the saved default.'); return; }
  const state = await getState(env, chatId);
  state.pending.musicOptions = tracks;
  await putState(env, chatId, state);
  await sendMessage(env, chatId, 'Choose a library track for this task.', { replyMarkup: buttons(tracks.map((track, index) => [{ text: telegramButtonText(track.name), callback_data: `music:track:${index}` }])) });
}

async function selectMusic(env, chatId, choice) {
  const state = await getState(env, chatId);
  if (!state.pending || !state.pending.mode) { await sendMessage(env, chatId, 'Start a new task with /manual or /automatic first.'); return; }
  if (choice === 'none') { state.pending.musicRef = ''; state.pending.musicSource = 'none'; }
  else if (choice === 'default') {
    state.pending.musicRef = '';
    state.pending.musicSource = 'default';
    if (state.pending.mode === 'manual') {
      const credentials = await requireCredentials(env, chatId);
      if (!credentials) return;
      try {
        const { document } = await getJsonFile(credentials, credentials.repo, 'branding/music_default.json');
        const path = document && document.library_track_path;
        if (typeof path === 'string' && /^audio-library\/[^/\\\u0000-\u001f\u007f]+$/.test(path)) state.pending.musicRef = `path:${path}`;
      } catch (error) {
        if (!(error instanceof GitHubError && error.status === 404)) throw error;
      }
    }
  }
  else if (choice.startsWith('track:')) {
    const index = Number(choice.slice('track:'.length));
    const track = state.pending.musicOptions && state.pending.musicOptions[index];
    if (!track || !/^audio-library\/[^/\\\u0000-\u001f\u007f]+$/.test(track.path)) throw new Error('That library track is no longer available.');
    state.pending.musicRef = `path:${track.path}`;
    state.pending.musicSource = 'explicit_library';
  } else return;
  delete state.pending.musicOptions;
  await putState(env, chatId, state);
  await finishTaskLaunch(env, chatId);
}

async function sendManualAgentPrompt(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const status = await readStatus(credentials, credentials.repo, jobId);
  if (!status || status.stage !== 'awaiting_json_upload') {
    await sendMessage(env, chatId, 'The agent prompt is available only after a manual Stage A task reaches “Awaiting production plan”.');
    return;
  }
  const assetUrl = status.assets && status.assets['00_READ_THIS_FIRST.txt'];
  if (typeof assetUrl !== 'string' || !assetUrl.startsWith('https://')) throw new Error('The Stage A release did not publish its agent prompt asset. Open the release from this task’s status and retry after the release completes.');
  const prompt = await getReleaseTextAsset(credentials, assetUrl);
  const content = new TextEncoder().encode(prompt);
  await sendDocumentBytes(
    env,
    chatId,
    content,
    `${jobId}-agent-prompt.txt`,
    `<b>Task ${escapeHtml(label)} agent prompt</b>\nThis is the exact Stage A release prompt. Open the text file in Telegram to copy or forward the complete prompt, then upload the returned production.json.`
  );
}

async function sendVoicePreview(env, chatId, voice) {
  const meta = VOICES[voice];
  if (!meta) throw new Error('That narrator preview is unavailable.');
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  const bytes = await getRepositoryFileBytes(credentials, credentials.repo, `assets/tts-previews/${voice}.mp3`, 10 * 1024 * 1024);
  await sendAudioBytes(env, chatId, bytes, `${voice}.mp3`, `<b>${escapeHtml(meta.label)}</b> — ${escapeHtml(meta.style)}\nThis is the committed Edge TTS preview for the same narrator available in Settings.`);
}

async function startPlanFlow(env, chatId, label) {
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!jobId) { await sendMessage(env, chatId, 'Use /tasks to refresh task labels.'); return; }
  const state = await getState(env, chatId);
  state.flow = 'manual_plan';
  state.pending = { jobId, label };
  await putState(env, chatId, state);
  await sendMessage(env, chatId, `Send the production.json document for task <b>${escapeHtml(label)}</b>, or paste the complete JSON as a message. It will be validated before anything is committed.`);
}

async function submitPlan(env, chatId, jsonText) {
  const state = await getState(env, chatId);
  const { jobId, label } = state.pending || {};
  if (!SAFE_JOB_RE.test(String(jobId || ''))) throw new Error('No valid task is awaiting a production plan.');
  let document;
  try { document = JSON.parse(jsonText); } catch { throw new Error('The submitted production plan is not valid JSON.'); }
  const errors = validateProductionPlan(document);
  if (errors.length) {
    await sendMessage(env, chatId, `<b>Production plan not accepted</b>\n${errors.slice(0, 10).map(escapeHtml).join('\n')}`);
    return;
  }
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  await saveProductionPlan(credentials, credentials.repo, jobId, `${JSON.stringify(document, null, 2)}\n`);
  const options = await getTaskOptions(env, chatId, jobId);
  const codeRef = await currentBranchSha(credentials, credentials.repo);
  await dispatchWorkflow(credentials, credentials.repo, 'stage-b.yml', {
    job_id: jobId, production_ref: `path:${PRODUCTION_PATH(jobId)}`, music_ref: options.musicRef || '', code_ref: codeRef
  });
  state.flow = null;
  state.pending = {};
  await putState(env, chatId, state);
  await sendMessage(env, chatId, `Validated production.json and dispatched Stage B for task <b>${escapeHtml(label)}</b>.`);
}

async function handleFlowText(env, chatId, text) {
  const state = await getState(env, chatId);
  if (!state.flow) return false;
  if (state.flow === 'settings_github_pat' || state.flow === 'settings_shadow_pat') {
    const token = String(text || '').trim();
    if (token.length < 20 || /\s/.test(token)) throw new Error('That does not look like a valid GitHub token. Send the token again without spaces.');
    const credentials = (await getCredentials(env, chatId)) || { githubPat: '', repo: '', geminiKeys: [] };
    credentials.pendingGithubPat = token;
    await putCredentials(env, chatId, credentials);
    const creatingClone = state.flow === 'settings_shadow_pat';
    state.flow = creatingClone ? 'settings_shadow_name' : 'settings_github_repo';
    state.pending = {};
    await putState(env, chatId, state);
    await sendMessage(env, chatId, creatingClone
      ? 'Now send a short name for your new <b>private</b> Shadow Clone, for example <code>my-clipforge</code>.'
      : 'Now send the clone repository in the exact form <code>owner/repository</code>.');
    return true;
  }
  if (state.flow === 'settings_github_repo') {
    const repo = String(text || '').trim();
    const credentials = await getCredentials(env, chatId);
    const pat = credentials && credentials.pendingGithubPat;
    if (!pat) throw new Error('The pending GitHub token expired. Start GitHub connection again from /settings.');
    const result = await validateConnection(pat, repo);
    await putCredentials(env, chatId, { githubPat: pat, repo: result.repo, geminiKeys: credentials.geminiKeys || [] });
    state.flow = null;
    state.pending = {};
    await putState(env, chatId, state);
    await sendMessage(env, chatId, `GitHub connection saved for <code>${escapeHtml(result.repo)}</code>.`);
    return true;
  }
  if (state.flow === 'settings_shadow_name') {
    const name = String(text || '').trim();
    const credentials = await getCredentials(env, chatId);
    const pat = credentials && credentials.pendingGithubPat;
    if (!pat) throw new Error('The pending GitHub token expired. Start clone setup again from /start.');
    await sendMessage(env, chatId, 'Creating your isolated private Shadow Clone. This can take a moment.');
    const result = await createPrivateShadowClone(pat, name);
    await putCredentials(env, chatId, { githubPat: pat, repo: result.repo, geminiKeys: [] });
    state.flow = null;
    state.pending = {};
    await putState(env, chatId, state);
    await sendMessage(env, chatId, `Private Shadow Clone created: <code>${escapeHtml(result.repo)}</code>\n${result.copiedFiles} shared source files copied. Your tasks, settings, Gemini keys, voice selection, and future job artifacts stay in this clone only.`, { replyMarkup: mainMenu() });
    return true;
  }
  if (state.flow === 'settings_gemini') {
    const key = String(text || '').trim();
    if (key.length < 20 || /\s/.test(key)) throw new Error('That does not look like a Gemini API key. Send it again without spaces.');
    await saveGeminiKey(env, chatId, key, Boolean(state.pending && state.pending.replaceExisting));
    return true;
  }
  if (state.flow === 'settings_watermark') {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (value.length > 64) throw new Error('Watermark text must be 64 characters or fewer.');
    const credentials = await requireCredentials(env, chatId);
    if (!credentials) return true;
    await saveWatermark(credentials, credentials.repo, value.toLowerCase() === 'clear' ? '' : value);
    await clearFlow(env, chatId);
    await sendMessage(env, chatId, value.toLowerCase() === 'clear' ? 'Creator watermark cleared.' : 'Creator watermark saved for future Stage B videos.');
    return true;
  }
  if (state.flow === 'manual_source' || state.flow === 'automatic_source') {
    state.pending.source = validateSource(text);
    state.flow = state.pending.mode === 'automatic' ? 'automatic_focus' : 'manual_focus';
    await putState(env, chatId, state);
    await sendMessage(env, chatId, 'Send an optional editorial focus. Send <code>-</code> to consider the whole video.');
    return true;
  }
  if (state.flow === 'manual_focus' || state.flow === 'automatic_focus') {
    state.pending.focus = normalizeFocus(text);
    state.flow = `${state.pending.mode}_duration`;
    await putState(env, chatId, state);
    await sendMessage(env, chatId, 'Choose the target output length.', { replyMarkup: durationMenu() });
    return true;
  }
  if (state.flow === 'manual_plan') { await submitPlan(env, chatId, text); return true; }
  return false;
}

async function saveGeminiKey(env, chatId, key, replacingLegacy) {
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  const existing = credentials.geminiKeys || [];
  const fingerprint = geminiFingerprint(key);
  if (existing.some((entry) => geminiFingerprint(entry) === fingerprint)) throw new Error('That Gemini key is already stored.');
  const metadata = await readGeminiMetadata(credentials, credentials.repo);
  if (!replacingLegacy && !existing.length && metadata.length) {
    credentials.pendingGeminiKey = key;
    await putCredentials(env, chatId, credentials);
    const state = await getState(env, chatId);
    state.flow = 'settings_gemini_replace_confirm';
    state.pending = {};
    await putState(env, chatId, state);
    await sendMessage(env, chatId, 'This clone has Gemini key fingerprints from another interface session. GitHub cannot reveal their raw values, so adding this key would replace that secret. Continue only if you want to replace it.', { replyMarkup: buttons([[{ text: 'Replace existing key set', callback_data: 'set:gemini_replace' }, { text: 'Cancel', callback_data: 'flow:cancel' }]]) });
    return;
  }
  const keys = [...existing, key];
  await updateGeminiSecret(credentials, credentials.repo, keys);
  const nextMetadata = [...metadata.filter((entry) => entry && entry.fingerprint !== fingerprint), { fingerprint, added_at_epoch: Math.floor(Date.now() / 1000) }];
  await writeGeminiMetadata(credentials, credentials.repo, nextMetadata);
  await putCredentials(env, chatId, { ...credentials, geminiKeys: keys, pendingGeminiKey: '' });
  await clearFlow(env, chatId);
  await sendMessage(env, chatId, `Gemini key ${escapeHtml(fingerprint)} was encrypted and saved to the GitHub Actions secret.`);
}

async function handleTorrentUpload(env, chatId, document, state) {
  const filename = String(document && document.file_name || '');
  if (!/\.torrent$/i.test(filename) || !document.file_size || document.file_size > MAX_TORRENT_BYTES) {
    throw new Error('Upload a non-empty .torrent file no larger than 1 MB.');
  }
  const credentials = await requireCredentials(env, chatId);
  if (!credentials) return;
  const file = await getTelegramFile(env, document.file_id);
  if (!file || !file.file_path) throw new Error('Telegram did not return the uploaded torrent.');
  const bytes = await downloadTelegramFileBytes(env, file.file_path, MAX_TORRENT_BYTES);
  if (bytes[0] !== 0x64) throw new Error('The uploaded file is not a valid bencoded torrent manifest.');
  const jobId = startTaskJobId(state.pending.mode);
  await putBinaryFile(credentials, credentials.repo, `jobs/${jobId}/source.torrent`, bytes, `clipforge: upload source.torrent for job ${jobId}`);
  state.pending.source = `path:jobs/${jobId}/source.torrent`;
  state.pending.jobId = jobId;
  state.flow = state.pending.mode === 'automatic' ? 'automatic_focus' : 'manual_focus';
  await putState(env, chatId, state);
  await sendMessage(env, chatId, `<b>Torrent source staged — setup is not complete yet.</b>\n<code>${escapeHtml(jobId)}</code>\n\nNext, send an optional editorial focus, or send <code>-</code> to consider the whole video. Then choose output length and music. Only after those choices will Stage A dispatch and ask you to choose the video file inside the torrent.`);
}

async function handleDocument(env, chatId, document) {
  const state = await getState(env, chatId);
  if (state.flow === 'manual_source' || state.flow === 'automatic_source') {
    await handleTorrentUpload(env, chatId, document, state);
    return;
  }
  if (state.flow !== 'manual_plan') { await sendMessage(env, chatId, 'This document was not expected. Start Manual or Automatic Mode first to upload a .torrent file, or choose a task awaiting production.json before uploading a production plan.'); return; }
  if (!document || document.file_size > 1024 * 1024) throw new Error('production.json must be 1 MB or smaller.');
  const file = await getTelegramFile(env, document.file_id);
  if (!file || !file.file_path) throw new Error('Telegram did not return the uploaded file.');
  const content = await downloadTelegramFile(env, file.file_path);
  await submitPlan(env, chatId, content);
}

async function showTorrentCandidates(env, chatId, label, pageValue = '0') {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const selection = await tryGetJsonFile(credentials, credentials.repo, `jobs/${jobId}/torrent-selection.json`);
  const candidates = selection && selection.document && Array.isArray(selection.document.video_candidates) ? selection.document.video_candidates : [];
  if (!candidates.length) throw new Error('The torrent video choices are not available yet. Refresh the task status in a moment.');
  const totalPages = Math.ceil(candidates.length / TORRENT_CANDIDATES_PER_PAGE);
  const requestedPage = Number(pageValue);
  const page = Number.isInteger(requestedPage) ? Math.min(Math.max(requestedPage, 0), totalPages - 1) : 0;
  const rows = candidates.slice(page * TORRENT_CANDIDATES_PER_PAGE, (page + 1) * TORRENT_CANDIDATES_PER_PAGE).map((candidate) => {
    const index = Number(candidate && candidate.index);
    if (!Number.isInteger(index) || index < 1) return null;
    const name = torrentCandidateButtonText(candidate.path || `Video ${index}`);
    return [
      { text: `${index}. ${name}`, callback_data: `torrentpick:${label}:${index}` },
      { text: 'Details', callback_data: `torrentdetail:${label}:${index}` }
    ];
  }).filter(Boolean);
  if (totalPages > 1) {
    const navigation = [];
    if (page > 0) navigation.push({ text: 'Previous', callback_data: `torrentpage:${label}:${page - 1}` });
    navigation.push({ text: `Page ${page + 1}/${totalPages}`, callback_data: `torrentpage:${label}:${page}` });
    if (page < totalPages - 1) navigation.push({ text: 'Next', callback_data: `torrentpage:${label}:${page + 1}` });
    rows.push(navigation);
  }
  await sendMessage(env, chatId, `Choose the video file inside this torrent (page ${page + 1} of ${totalPages}). This starts Stage A for the selected file only.`, { replyMarkup: buttons(rows) });
}

async function showTorrentCandidateDetails(env, chatId, label, indexValue) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  const index = Number(indexValue);
  if (!credentials || !jobId) return;
  if (!Number.isInteger(index) || index < 1) throw new Error('That torrent video choice is invalid.');
  const selection = await tryGetJsonFile(credentials, credentials.repo, `jobs/${jobId}/torrent-selection.json`);
  const candidates = selection && selection.document && Array.isArray(selection.document.video_candidates) ? selection.document.video_candidates : [];
  const candidate = candidates.find((entry) => Number(entry && entry.index) === index);
  if (!candidate) throw new Error('That torrent video is no longer available. Refresh the task status.');
  const filename = normalizedButtonText(candidate.path, 'Unnamed video');
  const details = `<b>Torrent video ${index}</b>\n\n<b>Full filename</b>\n<code>${escapeHtml(filename)}</code>\n\n<b>Size</b>\n${escapeHtml(formatBytes(candidate.length))}\n\nTap the numbered filename button when this is the video you want Stage A to process.`;
  if (details.length <= 3500) return sendMessage(env, chatId, details);
  return sendDocumentBytes(env, chatId, new TextEncoder().encode(`Torrent video ${index}\n\nFull filename:\n${filename}\n\nSize: ${formatBytes(candidate.length)}\n`), `torrent-video-${index}-details.txt`, 'Full torrent candidate details');
}

async function chooseTorrentCandidate(env, chatId, label, indexValue) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  const index = Number(indexValue);
  if (!credentials || !jobId) return;
  if (!Number.isInteger(index) || index < 1) throw new Error('That torrent video choice is invalid.');
  const selection = await tryGetJsonFile(credentials, credentials.repo, `jobs/${jobId}/torrent-selection.json`);
  const candidates = selection && selection.document && Array.isArray(selection.document.video_candidates) ? selection.document.video_candidates : [];
  if (!candidates.some((candidate) => Number(candidate && candidate.index) === index)) throw new Error('That torrent video is no longer available. Refresh the task status.');
  const inputs = await readStageARequest(credentials, credentials.repo, jobId);
  await dispatchWorkflow(credentials, credentials.repo, 'stage-a.yml', {
    video_url: String(inputs.video_url || `path:jobs/${jobId}/source.torrent`), torrent_file_index: String(index), job_id: jobId,
    whisper_model: WHISPER_MODELS.has(inputs.whisper_model) ? inputs.whisper_model : 'base', language: String(inputs.language || 'auto'),
    target_duration_seconds: String(inputs.target_duration_seconds || '120'), focus: String(inputs.focus || ''), automatic_mode: inputs.automatic_mode === 'true' ? 'true' : 'false'
  });
  await sendMessage(env, chatId, `Selected torrent video ${index}. Stage A has started for task <b>${escapeHtml(label)}</b>.`);
}

async function restartStageA(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const inputs = await readStageARequest(credentials, credentials.repo, jobId);
  if (inputs.automatic_mode === 'true' && !(credentials.geminiKeys || []).length) {
    const metadata = await readGeminiMetadata(credentials, credentials.repo).catch(() => []);
    if (!metadata.length) throw new Error('Automatic Mode needs a stored Gemini API key before Stage A can restart.');
  }
  await dispatchWorkflow(credentials, credentials.repo, 'stage-a.yml', {
    video_url: String(inputs.video_url || ''), torrent_file_index: String(inputs.torrent_file_index || ''), job_id: jobId,
    whisper_model: WHISPER_MODELS.has(inputs.whisper_model) ? inputs.whisper_model : 'base', language: String(inputs.language || 'auto'),
    target_duration_seconds: String(inputs.target_duration_seconds || '120'), focus: String(inputs.focus || ''), automatic_mode: inputs.automatic_mode === 'true' ? 'true' : 'false'
  });
  await sendMessage(env, chatId, `Restarted Stage A for task <b>${escapeHtml(label)}</b>.`);
}

async function restartStageB(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const codeRef = await currentBranchSha(credentials, credentials.repo);
  const options = await getTaskOptions(env, chatId, jobId);
  await dispatchWorkflow(credentials, credentials.repo, 'stage-b.yml', { job_id: jobId, production_ref: `path:${PRODUCTION_PATH(jobId)}`, music_ref: options.musicRef || '', code_ref: codeRef });
  await sendMessage(env, chatId, `Restarted Stage B for task <b>${escapeHtml(label)}</b> using the current default-branch code.`);
}

async function cancelStageBPrompt(env, chatId, label) {
  await sendMessage(env, chatId, `Cancel Stage B for task <b>${escapeHtml(label)}</b>? The current GitHub Actions run will be cancelled.`, { replyMarkup: buttons([[{ text: 'Cancel Stage B', callback_data: `cancel:confirm:${label}` }, { text: 'Keep running', callback_data: 'cancel:abort' }]]) });
}

async function cancelStageB(env, chatId, label) {
  const credentials = await requireCredentials(env, chatId);
  const jobId = await getJobIdForLabel(env, chatId, label);
  if (!credentials || !jobId) return;
  const status = await readStatus(credentials, credentials.repo, jobId);
  const runId = status && status.extra && Number(status.extra.workflow_run_id);
  if (!['stage_b_queued', 'stage_b_running'].includes(status && status.stage) || !Number.isFinite(runId) || runId <= 0) throw new Error('This task does not currently expose an active Stage B run to cancel.');
  await cancelWorkflowRun(credentials, credentials.repo, runId);
  await sendMessage(env, chatId, `Cancellation requested for Stage B task <b>${escapeHtml(label)}</b>.`);
}

async function handleCommand(env, chatId, command) {
  if (command === '/start' || command === '/help') return showHome(env, chatId);
  if (command === '/settings') return showSettings(env, chatId);
  if (command === '/tasks') return listTasks(env, chatId, false);
  if (command === '/status') return listTasks(env, chatId, false);
  if (command === '/done') return listTasks(env, chatId, true);
  if (command === '/manual') return beginTask(env, chatId, 'manual');
  if (command === '/automatic') return beginTask(env, chatId, 'automatic');
  if (command === '/cancel') { await clearFlow(env, chatId); return sendMessage(env, chatId, 'Current setup or task-input flow cancelled.', { replyMarkup: mainMenu() }); }
}

async function handleCallback(env, callback) {
  const chatId = callback.message && callback.message.chat && callback.message.chat.id;
  if (!chatId || !callback.data || callback.message.chat.type !== 'private') return;
  await answerCallback(env, callback.id);
  const [kind, ...rest] = callback.data.split(':');
  const value = rest.join(':');
  if (kind === 'resume' && value === 'task') return resumePendingTask(env, chatId);
  if (kind === 'menu') {
    if (value === 'home') return showHome(env, chatId);
    if (value === 'settings') return showSettings(env, chatId);
    if (value === 'tasks' || value === 'status') return listTasks(env, chatId, false);
    if (value === 'done') return listTasks(env, chatId, true);
    if (value === 'manual' || value === 'auto') return beginTask(env, chatId, value === 'auto' ? 'automatic' : 'manual');
  }
  if (kind === 'set') {
    if (value === 'github') {
      return sendMessage(env, chatId, 'This shared bot can operate an existing ClipForge clone or create a separate private Shadow Clone for this chat. Choose one option.', { replyMarkup: cloneOnboardingMenu() });
    }
    if (value === 'gemini') {
      const credentials = await requireCredentials(env, chatId);
      if (!credentials) return;
      const metadata = await readGeminiMetadata(credentials, credentials.repo).catch(() => []);
      if (!(credentials.geminiKeys || []).length && metadata.length) {
        return sendMessage(env, chatId, `This clone already has ${metadata.length} Gemini key${metadata.length === 1 ? '' : 's'} configured by the ClipForge site. Automatic Mode will use that existing GitHub Actions secret. You do not need to add the key again.`, { replyMarkup: buttons([[{ text: 'Replace existing key set', callback_data: 'set:gemini_replace_start' }], [{ text: 'Keep existing settings', callback_data: 'flow:cancel' }]]) });
      }
      const state = await getState(env, chatId); state.flow = 'settings_gemini'; state.pending = {}; await putState(env, chatId, state);
      return sendMessage(env, chatId, 'Send one Gemini API key. It will be encrypted, stored in GitHub Actions as <code>GEMINI_API_KEYS</code>, and never committed to the repository.');
    }
    if (value === 'gemini_replace_start') {
      const credentials = await requireCredentials(env, chatId);
      if (!credentials) return;
      const state = await getState(env, chatId); state.flow = 'settings_gemini'; state.pending = { replaceExisting: true }; await putState(env, chatId, state);
      return sendMessage(env, chatId, 'You are about to replace the existing site-managed Gemini key set. Send the replacement Gemini API key. This cannot recover or merge the opaque existing key set.');
    }
    if (value === 'gemini_replace') {
      const credentials = await requireCredentials(env, chatId);
      if (!credentials || !credentials.pendingGeminiKey) throw new Error('No pending Gemini key was found. Start the Gemini setup flow again.');
      return saveGeminiKey(env, chatId, credentials.pendingGeminiKey, true);
    }
    if (value === 'voice') {
      const rows = Object.entries(VOICES).map(([id, meta]) => [
        { text: `Use ${meta.label} — ${meta.gender}`, callback_data: `voice:${id}` },
        { text: `Preview ${meta.label}`, callback_data: `preview:${id}` }
      ]);
      return sendMessage(env, chatId, 'Choose the Edge TTS default narrator for future Stage B jobs, or preview any of the ten committed voice samples first.', { replyMarkup: buttons(rows) });
    }
    if (value === 'music_default') {
      const credentials = await requireCredentials(env, chatId);
      if (!credentials) return;
      const existing = await readExistingSettings(credentials);
      const track = existing.musicDefault && existing.musicDefault.library_track_path;
      return sendMessage(env, chatId, track
        ? `The ClipForge site default is <code>${escapeHtml(String(track).replace(/^audio-library\//, ''))}</code>. Automatic Mode uses it when you choose <b>Use saved default</b> during task setup.`
        : 'No persistent music default is saved in this clone. You can choose no music, use a library track, or set a default from the ClipForge site.');
    }
    if (value === 'watermark') {
      if (!await requireCredentials(env, chatId)) return;
      const state = await getState(env, chatId); state.flow = 'settings_watermark'; state.pending = {}; await putState(env, chatId, state);
      return sendMessage(env, chatId, 'Send the creator watermark text (up to 64 characters), or send <code>clear</code> to remove it.');
    }
  }
  if (kind === 'clone') {
    const state = await getState(env, chatId);
    state.flow = value === 'new' ? 'settings_shadow_pat' : 'settings_github_pat';
    state.pending = {};
    await putState(env, chatId, state);
    return sendMessage(env, chatId, value === 'new'
      ? 'Send a GitHub PAT for your account. The bot will use it once to create and connect a new <b>private</b> Shadow Clone. It needs repository contents, Actions secrets, workflow-dispatch, and repository-creation permission. The token is encrypted before storage.'
      : 'Send a GitHub PAT for the existing clone. It needs repository contents, Actions secrets, and workflow-dispatch permission. The token will be encrypted before storage.');
  }
  if (kind === 'preview') return sendVoicePreview(env, chatId, value);
  if (kind === 'voice') {
    const voice = value;
    const meta = VOICES[voice];
    if (!meta) throw new Error('That narrator choice is unavailable.');
    const credentials = await requireCredentials(env, chatId); if (!credentials) return;
    await saveNarrator(credentials, credentials.repo, voice, meta.label);
    return sendMessage(env, chatId, `${escapeHtml(meta.label)} is now the default Edge TTS narrator.`);
  }
  if (kind === 'dur') {
    const duration = Number(value); if (!TARGET_DURATIONS.includes(duration)) throw new Error('That output length is unavailable.');
    const state = await getState(env, chatId); if (!state.flow || !state.flow.endsWith('_duration')) throw new Error('Start a new task first.');
    state.pending.duration = duration; state.flow = `${state.pending.mode}_music`; await putState(env, chatId, state);
    return sendMessage(env, chatId, 'Choose optional background music.', { replyMarkup: musicMenu() });
  }
  if (kind === 'music') {
    if (value === 'library') return chooseLibrary(env, chatId);
    return selectMusic(env, chatId, value);
  }
  if (kind === 'status') return showTaskStatus(env, chatId, value);
  if (kind === 'done') return showCompleted(env, chatId, value);
  if (kind === 'torrent') return showTorrentCandidates(env, chatId, value);
  if (kind === 'torrentpage') { const [label, page] = value.split(':'); return showTorrentCandidates(env, chatId, label, page); }
  if (kind === 'torrentdetail') { const [label, index] = value.split(':'); return showTorrentCandidateDetails(env, chatId, label, index); }
  if (kind === 'torrentpick') { const [label, index] = value.split(':'); return chooseTorrentCandidate(env, chatId, label, index); }
  if (kind === 'agent') return sendManualAgentPrompt(env, chatId, value);
  if (kind === 'plan') return startPlanFlow(env, chatId, value);
  if (kind === 'retry') { const [stage, label] = value.split(':'); return stage === 'a' ? restartStageA(env, chatId, label) : restartStageB(env, chatId, label); }
  if (kind === 'cancel') { if (value === 'abort') return sendMessage(env, chatId, 'Stage B will continue.'); if (value.startsWith('confirm:')) return cancelStageB(env, chatId, value.slice('confirm:'.length)); return cancelStageBPrompt(env, chatId, value); }
  if (kind === 'flow' && value === 'cancel') { await clearFlow(env, chatId); return sendMessage(env, chatId, 'Current flow cancelled.', { replyMarkup: mainMenu() }); }
}

async function handleUpdate(env, update) {
  if (!update || typeof update !== 'object') return;
  if (await markUpdateSeen(env, update.update_id)) return;
  if (update.callback_query) return handleCallback(env, update.callback_query);
  const message = update.message;
  const chatId = message && message.chat && message.chat.id;
  if (!chatId || message.chat.type !== 'private') return;
  const command = commandOf(message.text);
  if (command) return handleCommand(env, chatId, command);
  if (message.document) return handleDocument(env, chatId, message.document);
  const priorState = await getState(env, chatId);
  if (message.text && await handleFlowText(env, chatId, message.text)) {
    if (['settings_github_pat', 'settings_shadow_pat', 'settings_gemini'].includes(priorState.flow)) {
      await deleteMessage(env, chatId, message.message_id).catch(() => undefined);
    }
    return;
  }
  await sendMessage(env, chatId, 'Use /start to open the ClipForge menu, or /cancel to leave the current flow.');
}

function validWebhook(request, env) {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  return Boolean(env.TELEGRAM_WEBHOOK_SECRET) && header === env.TELEGRAM_WEBHOOK_SECRET;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return new Response('ok', { status: 200 });
    if (request.method !== 'POST' || url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
    if (!validWebhook(request, env)) return new Response('Unauthorized', { status: 401 });
    let update;
    try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
    try { await handleUpdate(env, update); }
    catch (error) {
      const chatId = update && ((update.message && update.message.chat && update.message.chat.id) || (update.callback_query && update.callback_query.message && update.callback_query.message.chat && update.callback_query.message.chat.id));
      if (chatId) await sendMessage(env, chatId, `<b>ClipForge could not complete that step.</b>\n${escapeHtml(userError(error))}`).catch(() => undefined);
    }
    return new Response('ok', { status: 200 });
  }
};

export const __test = { cloneOnboardingMenu, commandOf, existingGeminiLabel, formatBytes, formatStatus, hasResumablePendingTask, homeMenu, telegramButtonText, torrentCandidateButtonText, validateSource, normalizeFocus, mainMenu, durationMenu, taskButtons, userError };
