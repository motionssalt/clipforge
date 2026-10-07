/**
 * Onboarding — one-time PAT prompt + connect or create clone.
 * Modernized hero onboarding with visual guides and instant validation.
 */
import { setCredentials, escapeHtml, toast, getCloneJob } from '../state.js';
import { validateConnection } from '../github.js';
import { renderCloneCreation } from './clone.js';

export async function renderOnboarding(app) {
  const pendingClone = getCloneJob();

  app.innerHTML = `
    <div class="card card-elevated onboarding-card">
      <div class="onboarding-badge">
        <span class="pulse-dot"></span> Cloud-Native Automated Video Production
      </div>

      <h1 class="onboarding-title">Welcome to ClipForge</h1>
      <p class="onboarding-sub">
        Transform long videos, YouTube links, and media archives into viral short-form clips with automated AI transcriptions, smart scene cuts, Edge TTS narration, and background soundtracks.
      </p>

      ${pendingClone ? `
        <div class="resume-clone-banner">
          <div style="flex:1;">
            <b>Shadow Clone setup in progress:</b> <span class="mono">${escapeHtml(pendingClone.repo || '')}</span>
          </div>
          <button type="button" class="btn btn-primary btn-small" id="btn-resume-clone">Resume Setup →</button>
        </div>
      ` : ''}

      <div class="onboarding-box">
        <div class="form-group">
          <label class="field" for="pat-input">
            GitHub Personal Access Token
            <span class="hint">Stored strictly inside your browser's localStorage. Never sent to any intermediary server.</span>
          </label>
          <input type="password" id="pat-input" class="input-modern" autocomplete="off" placeholder="ghp_… or github_pat_…">
        </div>

        <div class="form-group" style="margin-top:16px;">
          <label class="field" for="repo-input">
            Repository Slug
            <span class="hint">E.g. <span class="mono">username/clipforge</span>. For original upstream: <span class="mono">motionssalt/clipforge</span>.</span>
          </label>
          <input type="text" id="repo-input" class="input-modern" autocomplete="off" placeholder="owner/repository">
        </div>

        <div class="btn-row" style="margin-top: 24px;">
          <button type="button" class="btn btn-primary" id="connect-btn" style="flex:1;">
            <span>⚡</span> Connect Repository
          </button>
          <button type="button" class="btn btn-secondary" id="create-btn" style="flex:1;">
            <span>✨</span> Create New Shadow Clone
          </button>
        </div>
      </div>

      <div class="onboarding-feature-grid">
        <div class="feature-item">
          <div class="feature-icon">🔒</div>
          <div class="feature-title">Pure GitHub Client</div>
          <div class="feature-desc">Runs 100% in your browser talking directly to GitHub REST API. No 3rd-party servers or bots required.</div>
        </div>
        <div class="feature-item">
          <div class="feature-icon">⚡</div>
          <div class="feature-title">Free Runners</div>
          <div class="feature-desc">Video ingestion, Whisper speech recognition, scene detection, and rendering run on GitHub Actions for free.</div>
        </div>
        <div class="feature-item">
          <div class="feature-icon">📺</div>
          <div class="feature-title">YouTube & Series</div>
          <div class="feature-desc">Ingest single YouTube videos, torrents, or direct media files with multi-part episode scheduling.</div>
        </div>
      </div>
    </div>
  `;

  if (pendingClone) {
    document.getElementById('btn-resume-clone')?.addEventListener('click', () => {
      location.hash = '#/clone';
      renderCloneCreation(app);
    });
  }

  document.getElementById('connect-btn').addEventListener('click', async () => {
    const pat = document.getElementById('pat-input').value.trim();
    const repo = document.getElementById('repo-input').value.trim();
    if (!pat || !repo) {
      toast('Please enter both your GitHub token and repository slug.', 'err');
      return;
    }
    const btn = document.getElementById('connect-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:14px;height:14px;"></span> Connecting…';
    try {
      const result = await validateConnection(pat, repo);
      setCredentials({ githubPat: pat, repo: result.repo });
      toast(`Connected to ${result.repo}${result.private ? ' (private)' : ''}.`, 'ok');
      location.hash = '#/home';
      location.reload();
    } catch (error) {
      toast(escapeHtml(error.message || 'Connection failed'), 'err');
      btn.disabled = false;
      btn.innerHTML = '<span>⚡</span> Connect Repository';
    }
  });

  document.getElementById('create-btn').addEventListener('click', async () => {
    const pat = document.getElementById('pat-input').value.trim();
    location.hash = '#/clone';
    renderCloneCreation(app, pat);
  });
}
