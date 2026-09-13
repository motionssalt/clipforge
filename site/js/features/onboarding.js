/**
 * Onboarding — one-time PAT prompt + connect/create clone.
 * Full clone creation flow lands in task-02 (js/features/clone.js).
 */

import { setCredentials, escapeHtml, toast } from '../state.js';
import { validateConnection } from '../github.js';

export async function renderOnboarding(app) {
  app.innerHTML = `
    <div class="card">
      <h2>Connect ClipForge</h2>
      <p class="muted">This Dashboard talks directly to GitHub from your browser. Enter a GitHub personal
      access token once — it is stored only in this browser's localStorage and never sent anywhere except
      <span class="mono">api.github.com</span>. You are only asked again after an explicit Disconnect.</p>
      <label class="field">GitHub personal access token
        <span class="hint">Classic PAT: <b>repo</b> + <b>workflow</b> scopes. Fine-grained: Contents, Actions, Workflows (and Administration for clone creation).</span>
      </label>
      <input type="password" id="pat-input" autocomplete="off" placeholder="github_pat_…">
      <label class="field">Repository
        <span class="hint"><span class="mono">owner/repo</span> of your ClipForge clone — e.g. <span class="mono">you/clipforge</span>. Main account: <span class="mono">motionssalt/clipforge</span>.</span>
      </label>
      <input type="text" id="repo-input" autocomplete="off" placeholder="owner/repository">
      <div class="btn-row">
        <button type="button" class="primary" id="connect-btn">Connect</button>
        <button type="button" id="create-btn">Create a new Shadow Clone</button>
      </div>
    </div>`;

  document.getElementById('connect-btn').addEventListener('click', async () => {
    const pat = document.getElementById('pat-input').value.trim();
    const repo = document.getElementById('repo-input').value.trim();
    if (!pat || !repo) { toast('Enter both the token and the repository.', 'err'); return; }
    const btn = document.getElementById('connect-btn');
    btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const result = await validateConnection(pat, repo);
      setCredentials({ githubPat: pat, repo: result.repo });
      toast(`Connected to ${result.repo}${result.private ? ' (private)' : ''}.`, 'ok');
      location.hash = '#/home';
      location.reload();
    } catch (error) {
      toast(escapeHtml(error.message || 'Connection failed'), 'err');
      btn.disabled = false; btn.textContent = 'Connect';
    }
  });

  document.getElementById('create-btn').addEventListener('click', async () => {
    const { renderCloneCreation } = await import('./clone.js');
    renderCloneCreation(app);
  });
}
