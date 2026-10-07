
// Theme Management (Light & Dark with auto-preference + toggle)
function initTheme() {
  const saved = localStorage.getItem('clipforge_theme');
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = saved || (prefersDark ? 'dark' : 'light');
  document.documentElement.setAttribute('data-theme', initialTheme);

  const toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.textContent = initialTheme === 'dark' ? '☀️' : '🌙';
    toggle.setAttribute('aria-label', initialTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    toggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('clipforge_theme', next);
      toggle.textContent = next === 'dark' ? '☀️' : '🌙';
      toggle.setAttribute('aria-label', next === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    });
  }
}
initTheme();
/**
 * ClipForge Dashboard — app shell: hash router + auth gate.
 * Modern responsive app shell with live routing, clone resume, and notification region.
 */
import { getCredentials, disconnect, setCredentials, escapeHtml, toast, getCloneJob } from './js/state.js';
import { validateConnection, getGitHubIdentity, isOriginalRepo } from './js/github.js';
import { renderHome } from './js/features/home.js';
import { renderOnboarding } from './js/features/onboarding.js';
import { renderNewVideo } from './js/features/newvideo.js';
import { renderTasks, renderTaskDetail } from './js/features/tasks.js';
import { renderDone } from './js/features/done.js';
import { renderSeries } from './js/features/series.js';
import { renderSettings } from './js/features/settings.js';
import { renderCloneCreation } from './js/features/clone.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const mobileNav = document.getElementById('mobile-nav');
const repoBadge = document.getElementById('repo-badge');
const repoBadgeWrap = document.getElementById('repo-badge-wrap');
const disconnectBtn = document.getElementById('disconnect-btn');

// Active view teardown (polling loops register here).
let teardown = null;
export function onTeardown(fn) { teardown = fn; }
function runTeardown() {
  if (teardown) { try { teardown(); } catch { /* ignore */ } teardown = null; }
}

function setChrome(connected) {
  nav.classList.toggle('hidden', !connected);
  if (mobileNav) mobileNav.classList.toggle('hidden', !connected);
  disconnectBtn.classList.toggle('hidden', !connected);
  if (connected) {
    const c = getCredentials();
    if (repoBadgeWrap) repoBadgeWrap.classList.remove('hidden');
    repoBadge.classList.remove('hidden');
    const isOrig = isOriginalRepo(c.repo);
    repoBadge.innerHTML = `<span class="repo-slug">${escapeHtml(c.repo)}</span> <span class="repo-type-tag ${isOrig ? 'orig' : 'clone'}">${isOrig ? 'Main' : 'Clone'}</span>`;
  } else {
    if (repoBadgeWrap) repoBadgeWrap.classList.add('hidden');
    repoBadge.classList.add('hidden');
  }
}

disconnectBtn.addEventListener('click', () => {
  runTeardown();
  disconnect();
  toast('Disconnected. Your token was removed from browser storage.', 'ok');
  location.hash = '#/home';
  route();
});

function setActiveNav(name) {
  for (const a of nav.querySelectorAll('a')) {
    a.classList.toggle('active', a.dataset.nav === name);
  }
  if (mobileNav) {
    for (const a of mobileNav.querySelectorAll('a')) {
      a.classList.toggle('active', a.dataset.nav === name);
    }
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
  'settings': renderSettings,
  'clone': renderCloneCreation
};

async function route() {
  runTeardown();
  const credentials = getCredentials();
  const pendingClone = getCloneJob();

  setChrome(Boolean(credentials));
  const hash = (location.hash || '#/home').replace(/^#\//, '');
  const [viewName, ...rest] = hash.split('/');

  // If a clone is actively building or route is explicitly #/clone
  if (viewName === 'clone' || (pendingClone && pendingClone.repo && !credentials)) {
    setActiveNav('settings');
    app.innerHTML = '';
    return renderCloneCreation(app);
  }

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
    app.innerHTML = `
      <div class="card card-elevated" style="max-width: 600px; margin: 40px auto; text-align:center;">
        <h2>Something went wrong</h2>
        <div class="error-callout" style="margin: 16px 0;">
          ${escapeHtml(error && error.message || String(error))}
        </div>
        <div class="btn-row" style="justify-content:center;">
          <a class="btn btn-primary" href="#/home">Back to Home</a>
          <button type="button" class="btn btn-ghost" onclick="location.reload()">Reload</button>
        </div>
      </div>`;
  }
}

window.addEventListener('hashchange', route);
route();
