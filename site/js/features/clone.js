/**
 * Shadow Clone creation UI — the Dashboard equivalent of the bot's
 * clone:new / clone:newauto / clone:connect flows + the cron clone-job sweep.
 * The browser tab polls pollShadowCloneJob every few seconds (no Worker
 * wall-clock limit exists here), finalizes on completion, and logs in
 * automatically (setCredentials) — the bot's finishCloneJob equivalent.
 */

import { setCredentials, putCloneJob, getCloneJob, deleteCloneJob, escapeHtml, toast, formatBytes } from '../state.js';
import { validateConnection, getRepositoryVisibility } from '../github.js';
import {
  beginShadowCloneCreation, pollShadowCloneJob, finalizeShadowClone,
  cancelShadowCloneRun, cloneRepositoryName
} from '../clone.js';

const POLL_MS = 5000;

function progressHtml(stage, done, total) {
  if (stage === 'copy' && total > 0) {
    const pct = Math.min(100, Math.floor((done / total) * 100));
    return `<div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
      <p class="muted">Copying files… <b>${pct}%</b> (${done}/${total})</p>`;
  }
  if (stage === 'finalize') {
    return `<div class="progress-track"><div class="progress-fill" style="width:100%"></div></div>
      <p class="muted">Finalizing on GitHub…</p>`;
  }
  return `<div class="progress-track"><div class="progress-fill indeterminate"></div></div>
    <p class="muted">Preparing repository…</p>`;
}

export async function renderCloneCreation(app) {
  // Resume an in-flight creation if the tab was closed mid-copy (the staged
  // job record in localStorage replaces the bot's D1 clone_jobs table).
  const pending = getCloneJob();
  if (pending && pending.repo) {
    return renderCloneProgress(app, pending);
  }

  app.innerHTML = `
    <div class="card">
      <h2>Create private Shadow Clone</h2>
      <p class="muted">The Dashboard creates the repository itself via the GitHub API from your token —
      you never pre-create anything. Leave the name blank to pick one automatically.</p>
      <label class="field">Repository name
        <span class="hint">Letters, numbers, dots, hyphens, underscores. Blank = choose for me.</span>
      </label>
      <input type="text" id="clone-name" autocomplete="off" placeholder="my-clipforge">
      <label class="field">GitHub personal access token
        <span class="hint">Must be able to create repositories — classic PAT: <b>repo</b> + <b>workflow</b>;
        fine-grained: <b>Administration</b> (write). Stored only in this browser.</span>
      </label>
      <input type="password" id="clone-pat" autocomplete="off" placeholder="github_pat_…">
      <div class="btn-row">
        <button type="button" class="primary" id="clone-start">Create clone</button>
        <button type="button" id="clone-back">Back</button>
      </div>
    </div>`;

  document.getElementById('clone-back').addEventListener('click', () => {
    location.hash = '#/home'; location.reload();
  });

  document.getElementById('clone-start').addEventListener('click', async () => {
    const name = document.getElementById('clone-name').value.trim();
    const pat = document.getElementById('clone-pat').value.trim();
    if (!pat) { toast('Enter your GitHub token.', 'err'); return; }
    if (name) {
      try { cloneRepositoryName(name); } catch (error) { toast(error.message, 'err'); return; }
    }
    const btn = document.getElementById('clone-start');
    btn.disabled = true;
    const card = btn.closest('.card');
    card.innerHTML = `<h2>Creating your Shadow Clone</h2><div id="clone-progress">${progressHtml('prepare', 0, 0)}</div>
      <p class="muted small">This can take a few minutes — the copy runs as a GitHub Actions workflow inside
      the new repository. Keep this tab open.</p>`;
    try {
      const job = await beginShadowCloneCreation(pat, name, {
        onProgress: ({ stage, done, total }) => {
          const el = document.getElementById('clone-progress');
          if (el) el.innerHTML = progressHtml(stage, done, total);
        }
      });
      putCloneJob(job);
      renderCloneProgress(app, job);
    } catch (error) {
      const raw = String(error && error.message || error);
      const permissionRelated = /token|scope|permission|administration|forbid|unauthori[sz]ed|could not create a repository/i.test(raw);
      card.innerHTML = `
        <h2>Shadow Clone creation failed</h2>
        <p class="muted">${escapeHtml(raw)}</p>
        ${permissionRelated ? '<p class="muted">Make sure the token can create repositories (classic PAT: <b>repo</b> scope; fine-grained: <b>Administration</b> write). Then try again.</p>' : ''}
        <div class="btn-row">
          <button type="button" class="primary" id="clone-retry">Try again</button>
          <button type="button" id="clone-home">Menu</button>
        </div>`;
      document.getElementById('clone-retry').addEventListener('click', () => renderCloneCreation(app));
      document.getElementById('clone-home').addEventListener('click', () => { location.hash = '#/home'; location.reload(); });
    }
  });
}

async function renderCloneProgress(app, job) {
  app.innerHTML = `
    <div class="card">
      <h2>Creating your Shadow Clone</h2>
      <p><span class="mono">${escapeHtml(job.repo)}</span></p>
      <div id="clone-progress">${progressHtml('copy', 0, job.totalFiles || 0)}</div>
      <p class="muted small">The copy is running on GitHub — this usually takes a few minutes.
      Keep this tab open; it watches the run and finishes the setup automatically.</p>
      <div class="btn-row"><button type="button" class="danger" id="clone-abandon">Abandon creation</button></div>
    </div>`;

  let alive = true;
  document.getElementById('clone-abandon').addEventListener('click', async () => {
    alive = false;
    await cancelShadowCloneRun(job);
    deleteCloneJob();
    toast('Clone creation abandoned. Delete the incomplete repository from GitHub before retrying.', 'err');
    location.hash = '#/home'; location.reload();
  });

  const fail = async (reason) => {
    alive = false;
    await cancelShadowCloneRun(job);
    let repoDeleted = false;
    try {
      const { deleteRepository } = await import('../github.js');
      await deleteRepository({ githubPat: job.githubPat }, job.repo);
      repoDeleted = true;
    } catch { /* best-effort */ }
    deleteCloneJob();
    app.innerHTML = `
      <div class="card">
        <h2>Shadow Clone creation failed</h2>
        <p class="muted">${escapeHtml(String(reason || 'The copy workflow did not finish.'))}</p>
        <p class="muted">${repoDeleted
          ? 'The incomplete repository was removed.'
          : `The incomplete repository <span class="mono">${escapeHtml(String(job.repo || ''))}</span> was left in place — delete it in your GitHub settings before retrying.`}</p>
        <div class="btn-row">
          <button type="button" class="primary" id="clone-retry">Try again</button>
          <button type="button" id="clone-home">Menu</button>
        </div>
      </div>`;
    document.getElementById('clone-retry').addEventListener('click', () => renderCloneCreation(app));
    document.getElementById('clone-home').addEventListener('click', () => { location.hash = '#/home'; location.reload(); });
  };

  while (alive) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    if (!alive) return;
    let outcome;
    try {
      outcome = await pollShadowCloneJob(job);
    } catch (error) {
      // A transient read failure is not terminal — keep polling.
      continue;
    }
    if (outcome.job) { job = { ...job, ...outcome.job }; putCloneJob(job); }
    if (outcome.progress) {
      const el = document.getElementById('clone-progress');
      if (el) el.innerHTML = progressHtml('copy', outcome.progress.done, outcome.progress.total);
    }
    if (outcome.status === 'failed') {
      return fail(outcome.error && outcome.error.message || 'The copy workflow did not finish.');
    }
    if (outcome.status === 'complete') {
      const el = document.getElementById('clone-progress');
      if (el) el.innerHTML = progressHtml('finalize', 1, 1);
      try {
        const result = await finalizeShadowClone({ ...job, onProgress: null });
        deleteCloneJob();
        // Auto-login — the bot's finishCloneJob equivalent.
        setCredentials({ githubPat: job.githubPat, repo: result.repo });
        toast(`Shadow Clone ${result.repo} created (${result.copiedFiles} files copied).`, 'ok', 6000);
        location.hash = '#/home';
        location.reload();
        return;
      } catch (error) {
        // Finalize is transient until the deadline — the next poll retries it.
        continue;
      }
    }
  }
}
