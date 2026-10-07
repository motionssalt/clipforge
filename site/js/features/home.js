/**
 * Home view — Premium Dashboard Overview with live metrics, quick actions,
 * and real-time recent pipeline activity.
 */
import { getCredentials, escapeHtml, getCloneJob } from '../state.js';
import {
  tryGetJsonFile, readSeriesSettings, readSuperSeriesSettings, readZernioSettingsSafe,
  getRepositoryVisibility, TTS_SETTINGS_PATH, WATERMARK_PATH, MUSIC_DEFAULT_PATH,
  listJobIds, readStatus, isTerminal, isOriginalRepo
} from '../github.js';

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
    readSuperSeriesSettings(credentials, repo).catch(() => null),
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
  const pendingClone = getCloneJob();

  app.innerHTML = `
    <div class="card card-elevated" style="text-align:center; padding: 56px 24px;">
      <div class="spinner" style="width:36px; height:36px; margin: 0 auto;"></div>
      <p class="muted" style="margin-top: 18px; font-weight: 500;">Connecting to GitHub repository…</p>
    </div>`;

  try {
    const [snapshot, allJobIds] = await Promise.all([
      loadSnapshot(credentials),
      listJobIds(credentials, credentials.repo).catch(() => [])
    ]);

    // Read statuses of up to 6 recent jobs
    const recentJobIds = allJobIds.slice(0, 6);
    const recentJobs = await Promise.all(
      recentJobIds.map(async (jid) => {
        const st = await readStatus(credentials, credentials.repo, jid).catch(() => null);
        return { jobId: jid, status: st };
      })
    );

    const activeCount = recentJobs.filter(j => j.status && !isTerminal(j.status.state)).length;
    const completedCount = recentJobs.filter(j => j.status && j.status.state === 'complete').length;
    const visText = snapshot.repoPrivate === null ? '' : (snapshot.repoPrivate ? 'Private' : 'Public');

    const recentHtml = recentJobs.length === 0
      ? `<div class="empty-state-box">
          <div class="empty-icon">🎬</div>
          <div class="empty-title">No pipeline tasks yet</div>
          <p class="muted small" style="margin: 6px 0 16px;">Create your first video job to watch the automated pipeline in action.</p>
          <a class="btn btn-primary btn-small" href="#/new">✨ Create First Video</a>
        </div>`
      : recentJobs.slice(0, 5).map(j => {
          const state = j.status ? (j.status.state || 'queued') : 'unknown';
          const msg = j.status ? (j.status.message || '') : 'Status file unavailable';
          const isAct = !isTerminal(state);
          return `
            <div class="task-card-row" onclick="location.hash='#/task/${encodeURIComponent(j.jobId)}'">
              <div class="task-row-status-dot ${isAct ? 'active' : ''}"></div>
              <div class="task-row-info">
                <div class="task-row-id mono">${escapeHtml(j.jobId)}</div>
                <div class="task-row-sub muted small">${escapeHtml(msg)}</div>
              </div>
              <div class="task-row-meta">
                <span class="state-pill pill-${escapeHtml(state)}">
                  ${isAct ? '<span class="pulse-dot"></span>' : ''} ${escapeHtml(state)}
                </span>
                <span class="chevron-arrow">›</span>
              </div>
            </div>`;
        }).join('');

    app.innerHTML = `
      ${pendingClone ? `
        <div class="card card-elevated resume-clone-banner" style="margin-bottom: 20px;">
          <div>
            <div style="font-weight:650; color:var(--text); font-size:15px;">⚡ Shadow Clone Building in Background</div>
            <div class="muted small" style="margin-top:2px;">Target: <span class="mono">${escapeHtml(pendingClone.repo || '')}</span></div>
          </div>
          <a class="btn btn-primary btn-small" href="#/clone">View Live Progress →</a>
        </div>
      ` : ''}

      <div class="card card-elevated hero-card">
        <div class="card-header-row">
          <div>
            <div class="hero-eyebrow">
              <span class="pulse-dot"></span> Pipeline Dashboard
            </div>
            <h1 class="hero-title">${escapeHtml(credentials.repo)}</h1>
            <p class="muted small" style="margin-top: 4px;">
              ${snapshot.repoPrivate !== null ? (snapshot.repoPrivate ? '🔒 Private repository' : '🌐 Public repository') : ''}
              · Direct browser GitHub client
            </p>
          </div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${snapshot.mainAccount
              ? '<span class="badge badge-accent">★ Main Upstream</span>'
              : '<span class="badge badge-clone">⚡ Shadow Clone</span>'}
            ${snapshot.mainAccount ? '<a class="btn btn-secondary btn-small" href="#/clone">Create Clone</a>' : ''}
          </div>
        </div>

        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-icon">📊</div>
            <div class="stat-label">Pipeline Jobs</div>
            <div class="stat-value">${allJobIds.length}</div>
            <div class="stat-sub muted small">
              <span class="${activeCount > 0 ? 'text-accent' : ''}">${activeCount} active</span> · ${completedCount} completed
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-icon">📺</div>
            <div class="stat-label">Series Engine</div>
            <div class="stat-value ${snapshot.seriesEnabled ? 'text-ok' : 'text-dim'}">
              ${snapshot.seriesEnabled ? 'Active' : 'Off'}
            </div>
            <div class="stat-sub muted small">
              ${snapshot.superSeriesEnabled ? 'Super Series auto-chain' : 'Standard episodic series'}
            </div>
          </div>

          <div class="stat-card">
            <div class="stat-icon">🎙️</div>
            <div class="stat-label">Narration Voice</div>
            <div class="stat-value mono" style="font-size:17px; margin-top:8px;">
              ${escapeHtml(snapshot.narratorVoice ? snapshot.narratorVoice.split('-').slice(-1)[0].replace('Neural', '') : 'Default')}
            </div>
            <div class="stat-sub muted small">Edge TTS neural speech</div>
          </div>

          <div class="stat-card">
            <div class="stat-icon">📡</div>
            <div class="stat-label">Auto-Publisher</div>
            <div class="stat-value ${snapshot.zernioEnabled ? 'text-ok' : 'text-dim'}">
              ${snapshot.zernioEnabled ? 'Active' : 'Off'}
            </div>
            <div class="stat-sub muted small">Zernio multi-platform</div>
          </div>
        </div>

        <div class="quick-actions-bar">
          <a class="btn btn-primary" href="#/new" style="padding: 10px 24px; font-weight:600;">
            <span>✨</span> New Video
          </a>
          <a class="btn btn-secondary" href="#/tasks">
            <span>📋</span> Tasks (${allJobIds.length})
          </a>
          <a class="btn btn-secondary" href="#/done">
            <span>🎬</span> Completed (${completedCount})
          </a>
          <a class="btn btn-secondary" href="#/series">
            <span>📺</span> Series Manager
          </a>
          <a class="btn btn-ghost" href="#/settings">
            <span>⚙️</span> Settings
          </a>
        </div>
      </div>

      <div class="card card-elevated" style="margin-top: 24px;">
        <div class="card-header-row" style="margin-bottom: 16px;">
          <div>
            <h3>Recent Pipeline Activity</h3>
            <p class="muted small" style="margin:2px 0 0;">Latest tasks dispatched through GitHub Actions</p>
          </div>
          <a class="btn btn-ghost btn-small" href="#/tasks">View all tasks →</a>
        </div>
        <div class="recent-tasks-list">
          ${recentHtml}
        </div>
      </div>

      <div class="card card-elevated" style="margin-top: 24px;">
        <div class="card-header-row">
          <div>
            <h3>Architecture & Security</h3>
            <p class="muted small" style="margin-top:2px;">Zero server proxies · Zero tracking · 100% Client-Side</p>
          </div>
          <span class="badge badge-accent">Direct API</span>
        </div>
        <p class="muted small" style="line-height:1.6; margin-top:12px;">
          This Dashboard makes direct calls to GitHub's REST API from your browser using your Personal Access Token.
          Workflows (<span class="mono">stage-a.yml</span> for video ingestion, Whisper transcription, scene cuts; <span class="mono">stage-b.yml</span> for FFmpeg assembly, narration overlay, subtitle rendering)
          run securely inside isolated GitHub Actions virtual runners with no subscription fees.
        </p>
      </div>
    `;
  } catch (err) {
    app.innerHTML = `
      <div class="card card-elevated" style="max-width: 600px; margin: 40px auto;">
        <h2>Connection Error</h2>
        <div class="error-callout" style="margin: 16px 0;">
          ${escapeHtml(err.message || String(err))}
        </div>
        <p class="muted small">Could not retrieve information from GitHub. Check your network or token permissions.</p>
        <div class="btn-row" style="margin-top: 20px;">
          <button type="button" class="btn btn-primary" onclick="location.reload()">Retry</button>
          <a class="btn btn-ghost" href="#/settings">Configure Settings</a>
        </div>
      </div>`;
  }
}
