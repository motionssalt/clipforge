/** Home view — port of bot commands/start.js showHome + loadSnapshot. */

import { getCredentials, escapeHtml } from '../state.js';
import {
  tryGetJsonFile, readSeriesSettings, readSuperSeriesSettings, readZernioSettingsSafe,
  getRepositoryVisibility, TTS_SETTINGS_PATH, WATERMARK_PATH, MUSIC_DEFAULT_PATH
} from '../github.js';
import { isOriginalRepo } from '../github.js';

async function safeDoc(credentials, repo, path) {
  const result = await tryGetJsonFile(credentials, repo, path).catch(() => null);
  return result && result.document ? result.document : null;
}

export async function loadSnapshot(credentials) {
  const repo = credentials.repo;
  const [narrator, watermark, musicDefault, series, zernio, superSeries, visibility] = await Promise.all([
    safeDoc(credentials, repo, TTS_SETTINGS_PATH),
    safeDoc(credentials, repo, WATERMARK_PATH),
    safeDoc(credentials, repo, MUSIC_DEFAULT_PATH),
    readSeriesSettings(credentials, repo).catch(() => null),
    readZernioSettingsSafe(credentials, repo),
    (await import('../github.js')).readSuperSeriesSettings(credentials, repo).catch(() => null),
    getRepositoryVisibility(credentials, repo).catch(() => null)
  ]);
  return {
    repo,
    narratorVoice: narrator && narrator.voice ? String(narrator.voice) : '',
    seriesEnabled: Boolean(series && series.enabled === true),
    superSeriesEnabled: Boolean(superSeries && superSeries.enabled === true),
    watermarkName: watermark && watermark.creator_name ? String(watermark.creator_name) : '',
    musicDefaultPath: musicDefault && musicDefault.library_track_path ? String(musicDefault.library_track_path) : '',
    zernioEnabled: Boolean(zernio && zernio.enabled === true),
    repoPrivate: visibility && typeof visibility.private === 'boolean' ? visibility.private : null,
    mainAccount: isOriginalRepo(repo)
  };
}

export async function renderHome(app) {
  const credentials = getCredentials();
  app.innerHTML = `<div class="card"><span class="spinner"></span> Loading…</div>`;
  const snapshot = await loadSnapshot(credentials);
  const vis = snapshot.repoPrivate === null ? '' : (snapshot.repoPrivate ? ' · private' : ' · public');
  app.innerHTML = `
    <div class="card">
      <h2>ClipForge</h2>
      <p>Connected to: <span class="mono">${escapeHtml(snapshot.repo)}</span>${escapeHtml(vis)}
         ${snapshot.mainAccount ? '<span class="state-pill complete">main account</span>' : '<span class="state-pill">clone</span>'}</p>
      <p class="muted">Series Mode: ${snapshot.seriesEnabled ? 'on' : 'off'} ·
         Super Series: ${snapshot.superSeriesEnabled ? 'on' : 'off'} ·
         Zernio: ${snapshot.zernioEnabled ? 'on' : 'off'}</p>
      <div class="btn-row">
        <a class="btn primary" href="#/new">New video</a>
        <a class="btn" href="#/tasks">Tasks</a>
        <a class="btn" href="#/done">Completed</a>
        <a class="btn" href="#/series">Series</a>
        <a class="btn" href="#/settings">Settings</a>
      </div>
    </div>
    <div class="card">
      <h3>How it works</h3>
      <p class="muted">This Dashboard talks <b>directly to the GitHub REST API</b> from your browser — no bot,
      no Worker, no server-side session. Jobs live as files under <span class="mono">jobs/</span> in your repo;
      GitHub Actions runs the pipeline (stage-a.yml → stage-b.yml → publish.yml).</p>
    </div>`;
}
