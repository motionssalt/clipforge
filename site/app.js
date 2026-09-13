/**
 * ClipForge Dashboard — app shell: hash router + auth gate.
 * Feature views live in js/features/*.js (one module per feature area,
 * mirroring the bot feature catalog in site/BUILD_STATE.json).
 */

import { getCredentials, disconnect, setCredentials, escapeHtml, toast } from './js/state.js';
import { validateConnection, getGitHubIdentity, isOriginalRepo } from './js/github.js';
import { renderHome } from './js/features/home.js';
import { renderOnboarding } from './js/features/onboarding.js';
import { renderNewVideo } from './js/features/newvideo.js';
import { renderTasks, renderTaskDetail } from './js/features/tasks.js';
import { renderDone } from './js/features/done.js';
import { renderSeries } from './js/features/series.js';
import { renderSettings } from './js/features/settings.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const repoBadge = document.getElementById('repo-badge');
const disconnectBtn = document.getElementById('disconnect-btn');

// Active view teardown (polling loops register here).
let teardown = null;
export function onTeardown(fn) { teardown = fn; }
function runTeardown() {
  if (teardown) { try { teardown(); } catch { /* ignore */ } teardown = null; }
}

function setChrome(connected) {
  nav.classList.toggle('hidden', !connected);
  disconnectBtn.classList.toggle('hidden', !connected);
  if (connected) {
    const c = getCredentials();
    repoBadge.classList.remove('hidden');
    repoBadge.textContent = c.repo + (isOriginalRepo(c.repo) ? ' · main' : ' · clone');
  } else {
    repoBadge.classList.add('hidden');
  }
}

disconnectBtn.addEventListener('click', () => {
  runTeardown();
  disconnect();
  toast('Disconnected. The stored token was removed from this browser.', 'ok');
  location.hash = '#/home';
  route();
});

function setActiveNav(name) {
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.nav === name);
  }
}

export function navigate(hash) { location.hash = hash; }

const routes = {
  'home': renderHome,
  'new': renderNewVideo,
  'tasks': renderTasks,
  'task': renderTaskDetail,   // #/task/<jobId>
  'done': renderDone,
  'series': renderSeries,
  'settings': renderSettings
};

async function route() {
  runTeardown();
  const credentials = getCredentials();
  setChrome(Boolean(credentials));
  const hash = (location.hash || '#/home').replace(/^#\//, '');
  const [viewName, ...rest] = hash.split('/');

  if (!credentials) {
    setActiveNav('');
    return renderOnboarding(app);
  }
  const view = routes[viewName] || renderHome;
  setActiveNav(viewName === 'task' ? 'tasks' : (routes[viewName] ? viewName : 'home'));
  app.innerHTML = '';
  try {
    await view(app, ...rest);
  } catch (error) {
    app.innerHTML = `<div class="card"><h2>Something went wrong</h2>
      <p class="muted">${escapeHtml(error && error.message || String(error))}</p>
      <div class="btn-row"><a class="btn" href="#/home">Back to home</a></div></div>`;
  }
}

window.addEventListener('hashchange', route);
route();
