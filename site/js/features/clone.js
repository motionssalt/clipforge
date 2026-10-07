/**
 * Shadow Clone creation view — Interactive guided setup with live progress.
 * Built with bulletproof resilience, clear step indicators, and safe non-destructive failure recovery.
 */
import { setCredentials, putCloneJob, getCloneJob, deleteCloneJob, getCredentials, escapeHtml, toast, confirmDialog } from '../state.js';
import { validateConnection, getRepositoryVisibility, deleteRepository } from '../github.js';
import {
  beginShadowCloneCreation, pollShadowCloneJob, finalizeShadowClone,
  cancelShadowCloneRun, cloneRepositoryName
} from '../clone.js';

const POLL_MS = 3500;

function progressCardHtml(stage, done, total, repoName, subDetail = '') {
  const steps = [
    { id: 'prepare', label: 'Initialize Repository', desc: 'Validating PAT & creating private GitHub repository' },
    { id: 'bootstrap', label: 'Bootstrap Workflows', desc: 'Setting up .clipforge-sync and one-time copy runner' },
    { id: 'copy', label: 'Copy Pipeline Files', desc: 'Running clone-copy workflow in GitHub Actions runner' },
    { id: 'finalize', label: 'Finalize Shadow Clone', desc: 'Installing Actions workflows & verifying repository tree' }
  ];

  let activeIdx = 0;
  if (stage === 'source' || stage === 'prepare') activeIdx = 0;
  else if (stage === 'bootstrap') activeIdx = 1;
  else if (stage === 'copy') activeIdx = 2;
  else if (stage === 'finalize') activeIdx = 3;

  const pct = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : (stage === 'finalize' ? 100 : 0);

  const stepsList = steps.map((s, idx) => {
    let iconSvg = '';
    let statusClass = 'muted';
    if (idx < activeIdx) {
      iconSvg = '<svg class="step-icon ok" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
      statusClass = 'ok';
    } else if (idx === activeIdx) {
      iconSvg = '<span class="spinner" style="width:16px;height:16px;"></span>';
      statusClass = 'active';
    } else {
      iconSvg = '<svg class="step-icon muted" viewBox="0 0 20 20" fill="none" stroke="currentColor"><circle cx="10" cy="10" r="8" stroke-width="2"/></svg>';
    }

    return `
      <div class="clone-step-row ${statusClass}">
        <div class="clone-step-icon">${iconSvg}</div>
        <div class="clone-step-text">
          <div class="clone-step-title ${idx === activeIdx ? 'highlight' : ''}">${escapeHtml(s.label)}</div>
          <div class="clone-step-desc muted small">${escapeHtml(s.desc)}</div>
        </div>
      </div>`;
  }).join('');

  let statusLabel = 'Setting up runner…';
  if (stage === 'copy' && total > 0) {
    statusLabel = `Copying files: <b>${done} / ${total}</b> (${pct}%)`;
  } else if (stage === 'finalize') {
    statusLabel = subDetail ? `Installing: <b>${escapeHtml(subDetail)}</b>` : 'Finalizing workflow files…';
  } else if (stage === 'prepare') {
    statusLabel = 'Resolving GitHub account & repository…';
  } else if (stage === 'bootstrap') {
    statusLabel = 'Committing bootstrap synchronization markers…';
  }

  return `
    <div class="clone-progress-box">
      <div class="clone-steps-list">${stepsList}</div>
      <div class="progress-track" style="margin-top: 24px; height: 8px;">
        <div class="progress-fill ${activeIdx === 2 && total === 0 ? 'indeterminate' : ''}" style="width: ${pct}%;"></div>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px;">
        <span class="muted small">${statusLabel}</span>
        <span class="mono small" style="color:var(--text); font-weight:600;">${pct}%</span>
      </div>
    </div>
  `;
}

export async function renderCloneCreation(app, initialPat = '') {
  const pending = getCloneJob();
  if (pending && pending.repo) {
    return renderCloneProgress(app, pending);
  }

  const existingCreds = getCredentials();
  const prefillPat = initialPat || (existingCreds && existingCreds.githubPat ? existingCreds.githubPat : '');

  app.innerHTML = `
    <div class="card card-elevated" style="max-width: 680px; margin: 0 auto;">
      <div class="card-header-row">
        <div>
          <h2>Create Private Shadow Clone</h2>
          <p class="muted" style="margin-top:4px;">A Shadow Clone is your own private GitHub repository that runs the ClipForge video pipeline entirely for free using GitHub Actions.</p>
        </div>
        <span class="badge badge-accent">100% Free & Private</span>
      </div>

      <div class="info-callout">
        <div class="callout-title">🔑 Required GitHub Token Permissions</div>
        <ul class="callout-list">
          <li><b>Classic Personal Access Token (recommended):</b> Select <code>repo</code> (Full control) and <code>workflow</code> (Update GitHub Actions workflows).</li>
          <li><b>Fine-Grained Token:</b> Permissions: <code>Administration: Read and write</code>, <code>Contents: Read and write</code>, and <code>Workflows: Read and write</code>.</li>
        </ul>
      </div>

      <div class="form-group">
        <label class="field" for="clone-name">
          Repository Name (optional)
          <span class="hint">Letters, numbers, hyphens. Leave blank to generate automatically (e.g. <code>clipforge-clone-xyz</code>).</span>
        </label>
        <input type="text" id="clone-name" class="input-modern" autocomplete="off" placeholder="clipforge-clone">
      </div>

      <div class="form-group">
        <label class="field" for="clone-pat">
          GitHub Personal Access Token
          <span class="hint">Stored only in your local browser storage. Never shared or sent to any third-party server.</span>
        </label>
        <input type="password" id="clone-pat" class="input-modern" autocomplete="off" placeholder="ghp_… or github_pat_…" value="${escapeHtml(prefillPat)}">
      </div>

      <div class="btn-row" style="margin-top: 28px;">
        <button type="button" class="btn btn-primary" id="clone-start">
          <span>🚀</span> Create Shadow Clone
        </button>
        <button type="button" class="btn btn-ghost" id="clone-back">Cancel</button>
      </div>
    </div>
  `;

  document.getElementById('clone-back').addEventListener('click', () => {
    if (getCredentials()) {
      location.hash = '#/home';
    } else {
      location.hash = '#/home';
      location.reload();
    }
  });

  document.getElementById('clone-start').addEventListener('click', async () => {
    const name = document.getElementById('clone-name').value.trim();
    const pat = document.getElementById('clone-pat').value.trim();

    if (!pat) {
      toast('Please enter your GitHub personal access token.', 'err');
      return;
    }

    if (name) {
      try {
        cloneRepositoryName(name);
      } catch (err) {
        toast(err.message, 'err');
        return;
      }
    }

    const card = document.querySelector('.card');
    card.innerHTML = `
      <div class="card-header-row">
        <div>
          <h2>Initializing Shadow Clone</h2>
          <p class="muted">Starting repository creation and workflow bootstrapping on GitHub…</p>
        </div>
        <span class="badge badge-accent">Please wait</span>
      </div>
      <div id="clone-progress-area">${progressCardHtml('prepare', 0, 0, name || 'new clone')}</div>
      <p class="muted small" style="margin-top:16px;">This takes 2–3 minutes while GitHub Actions initializes runner environments and copies pipeline files. Keep this tab open.</p>
    `;

    try {
      const job = await beginShadowCloneCreation(pat, name, {
        onProgress: ({ stage, done, total }) => {
          const el = document.getElementById('clone-progress-area');
          if (el) el.innerHTML = progressCardHtml(stage, done, total, name);
        }
      });
      putCloneJob(job);
      renderCloneProgress(app, job);
    } catch (error) {
      const raw = String(error && error.message || error);
      const permIssue = /token|scope|permission|administration|forbid|unauthori[sz]ed|could not create a repository/i.test(raw);

      card.innerHTML = `
        <div class="card-header-row">
          <h2>Shadow Clone Creation Failed</h2>
          <span class="badge badge-err">Error</span>
        </div>
        <div class="error-callout" style="margin: 16px 0;">
          ${escapeHtml(raw)}
        </div>
        ${permIssue ? `
          <div class="info-callout" style="margin-bottom:16px;">
            <div class="callout-title">Token permission checklist:</div>
            <ul class="callout-list">
              <li>Classic Token: Must check <code>repo</code> and <code>workflow</code> scopes.</li>
              <li>Fine-Grained Token: Must allow <code>Administration (Read/Write)</code>, <code>Contents (Read/Write)</code>, <code>Workflows (Read/Write)</code>.</li>
            </ul>
          </div>
        ` : ''}
        <div class="btn-row">
          <button type="button" class="btn btn-primary" id="clone-retry">Try Again</button>
          <button type="button" class="btn btn-ghost" id="clone-home">Return to Dashboard</button>
        </div>
      `;

      document.getElementById('clone-retry').addEventListener('click', () => renderCloneCreation(app, pat));
      document.getElementById('clone-home').addEventListener('click', () => {
        location.hash = '#/home';
        location.reload();
      });
    }
  });
}

async function renderCloneProgress(app, job) {
  app.innerHTML = `
    <div class="card card-elevated" style="max-width: 680px; margin: 0 auto;">
      <div class="card-header-row">
        <div>
          <h2>Building Shadow Clone</h2>
          <p class="muted" style="margin-top:4px;">Target repository: <span class="mono" style="color:var(--text); font-weight:600;">${escapeHtml(job.repo)}</span></p>
        </div>
        <span class="badge badge-accent"><span class="pulse-dot"></span> In Progress</span>
      </div>

      <div id="clone-progress-area">${progressCardHtml('copy', 0, job.totalFiles || 0, job.repo)}</div>

      <p class="muted small" style="margin-top:16px;">The file copy workflow is executing inside your private GitHub Actions runner. Once complete, this Dashboard will configure your clone and log you in automatically.</p>

      <div class="btn-row" style="margin-top: 24px;">
        <button type="button" class="btn btn-ghost btn-small" id="clone-abandon">Cancel / Stop Setup</button>
      </div>
    </div>
  `;

  let alive = true;

  document.getElementById('clone-abandon').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Stop Clone Setup?',
      'The file copy workflow on GitHub Actions will be cancelled. You can keep or delete the partially created repository on GitHub.',
      'Stop Setup',
      true
    );
    if (!ok) return;

    alive = false;
    await cancelShadowCloneRun(job);
    deleteCloneJob();
    toast('Clone creation cancelled.', 'warn');
    location.hash = '#/home';
    location.reload();
  });

  const fail = async (reason) => {
    alive = false;
    await cancelShadowCloneRun(job);
    deleteCloneJob();

    app.innerHTML = `
      <div class="card card-elevated" style="max-width: 680px; margin: 0 auto;">
        <div class="card-header-row">
          <h2>Shadow Clone Setup Needs Attention</h2>
          <span class="badge badge-warn">Paused</span>
        </div>
        <div class="error-callout" style="margin: 16px 0;">
          ${escapeHtml(String(reason || 'The copy workflow did not complete.'))}
        </div>
        <p class="muted small">
          Your repository <span class="mono" style="color:var(--text); font-weight:600;">${escapeHtml(String(job.repo || ''))}</span> was preserved on GitHub.
          You can retry the setup, connect directly to finish syncing from source, or remove the repository.
        </p>
        <div class="btn-row" style="margin-top:20px;">
          <button type="button" class="btn btn-primary" id="clone-retry">Retry Setup</button>
          <button type="button" class="btn btn-secondary" id="clone-connect-anyway">Connect Repository Anyway</button>
          <button type="button" class="btn btn-danger-ghost btn-small" id="clone-delete-repo">Delete Repository</button>
          <button type="button" class="btn btn-ghost" id="clone-home">Dashboard</button>
        </div>
      </div>
    `;

    document.getElementById('clone-retry').addEventListener('click', () => renderCloneCreation(app, job.githubPat));
    document.getElementById('clone-connect-anyway').addEventListener('click', () => {
      setCredentials({ githubPat: job.githubPat, repo: job.repo });
      toast(`Connected to ${job.repo}. Visit Settings → Sync from source to finish synchronizing.`, 'ok', 6000);
      location.hash = '#/settings';
      location.reload();
    });
    document.getElementById('clone-delete-repo').addEventListener('click', async () => {
      const ok = await confirmDialog(
        `Delete ${job.repo}?`,
        'This will permanently delete the repository from your GitHub account.',
        'Delete Repository',
        true
      );
      if (!ok) return;
      try {
        await deleteRepository({ githubPat: job.githubPat }, job.repo);
        toast(`Repository ${job.repo} was deleted from GitHub.`, 'ok');
      } catch (e) {
        toast(`Could not delete repository: ${e.message}`, 'err');
      }
      location.hash = '#/home';
      location.reload();
    });
    document.getElementById('clone-home').addEventListener('click', () => {
      location.hash = '#/home';
      location.reload();
    });
  };

  let finalizeTries = 0;

  while (alive) {
    await new Promise((res) => setTimeout(res, POLL_MS));
    if (!alive) return;

    let outcome;
    try {
      outcome = await pollShadowCloneJob(job);
    } catch (err) {
      // Transient network hiccup — continue polling
      continue;
    }

    if (outcome.job) {
      job = { ...job, ...outcome.job };
      putCloneJob(job);
    }

    if (outcome.progress) {
      const el = document.getElementById('clone-progress-area');
      if (el) el.innerHTML = progressCardHtml('copy', outcome.progress.done, outcome.progress.total, job.repo);
    }

    if (outcome.status === 'failed') {
      return fail(outcome.error && outcome.error.message || 'The copy workflow failed.');
    }

    if (outcome.status === 'complete') {
      const el = document.getElementById('clone-progress-area');
      if (el) el.innerHTML = progressCardHtml('finalize', job.totalFiles || 1, job.totalFiles || 1, job.repo);

      try {
        const result = await finalizeShadowClone({
          ...job,
          onProgress: (p) => {
            const area = document.getElementById('clone-progress-area');
            if (area) area.innerHTML = progressCardHtml('finalize', p.done || 1, p.total || 1, job.repo, p.file || '');
          }
        });
        deleteCloneJob();
        // Auto-login to new clone
        setCredentials({ githubPat: job.githubPat, repo: result.repo });
        toast(`🎉 Shadow Clone ${result.repo} created successfully!`, 'ok', 6000);
        location.hash = '#/home';
        location.reload();
        return;
      } catch (err) {
        finalizeTries += 1;
        if (finalizeTries >= 8) {
          return fail(`Finalizing workflow files failed: ${err.message || String(err)}. You can connect to your repository and complete setup using Sync from Source.`);
        }
        continue;
      }
    }
  }
}
