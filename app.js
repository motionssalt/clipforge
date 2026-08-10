/* ============================================================================
 * ClipForge — MOTIONSALT
 * Static single-page console for the ClipForge GitHub Actions pipeline.
 *
 * No server, no build step, no third-party requests. The only network target
 * is https://api.github.com (plus release-asset redirects when downloading).
 * The repo is the database: jobs/<job-id>/status.json is the source of truth.
 * ==========================================================================*/

(function () {
  'use strict';

  /* ------------------------------------------------------------------ config */

  var API = 'https://api.github.com';
  var API_VERSION = '2022-11-28';
  var REF = 'main';

  var LS = {
    token: 'clipforge_token',
    owner: 'clipforge_owner',
    repo: 'clipforge_repo',
    activeJob: 'clipforge_active_job_id'
  };

  /* Persistent channel branding. Follows the same "repo is the database"
   * pattern as job state (status.json / production.json) but lives OUTSIDE jobs/ —
   * the hourly cleanup only touches jobs/<id>/ folders and clipforge-*
   * releases, so branding/branding.json + branding/profile_picture.<ext>
   * on the default branch survive forever and apply to every future job. */
  var BRANDING_JSON_PATH = 'branding/branding.json';
  var BRANDING_AVATAR_STEM = 'branding/profile_picture.';   // + png|jpg|webp
  var BRANDING_AVATAR_MAX_BYTES = 5 * 1024 * 1024;

  var POLL_FAST = 5000;        // first 10 minutes
  var POLL_SLOW = 15000;       // after 10 minutes
  var POLL_RATELIMIT = 60000;  // after hitting a rate limit
  var POLL_SLOWDOWN_AFTER = 10 * 60 * 1000;
  var RUN_DISCOVERY_TIMEOUT = 30000;

  /* ------------------------------------------------------------------- state */

  var state = {
    token: '',
    owner: '',
    repo: '',
    jobId: null,
    runId: null,
    runHtmlUrl: null,
    status: null,          // parsed status.json
    pollTimer: null,
    pollStartedAt: 0,
    polling: false,
    rateLimited: false,
    repoPrivate: null,     // null = unknown
    releaseAssets: null,   // [{name, id, browser_download_url}] cached per job
    releaseAssetsTag: null,
    countdownTimer: null,
    validatedCuts: null,   // string contents of a validated production.json
    musicFile: null,       // an optional picked music file (File object)
    busy: false,
    stageBDispatched: false,
    stageBRun: null,      // matched GitHub Actions Stage B run for this job
    cancellingStageB: false,
    branding: null,        // parsed branding.json, or null when none is saved
    brandingSha: null,     // blob sha of branding.json (needed to update it)
    brandingAvatarUrl: '', // raw.githubusercontent.com URL of the saved picture
    brandingAvatarExt: '', // ext of the saved picture ('' = none saved)
    avatarFile: null,      // a newly picked picture, not yet committed
    removeAvatar: false    // true when the user asked to delete the picture
  };

  /* --------------------------------------------------------------- dom lookup */

  function $(id) { return document.getElementById(id); }

  var el = {};
  [
    'repo-indicator', 'banner-stack',
    'settings-section', 'settings-toggle', 'settings-body', 'settings-state', 'settings-form',
    'owner-input', 'repo-input', 'token-input', 'token-reveal', 'settings-save', 'settings-clear', 'settings-msg',
    'stage-a-section', 'stage-a-form', 'video-url-input', 'job-slug-input', 'whisper-model-select',
    'language-input', 'target-duration-select', 'focus-input', 'start-stage-a', 'stage-a-msg',
    'active-job-bar', 'active-job-id', 'run-link', 'resume-btn', 'start-over-btn',
    'resume-offer', 'resume-offer-id', 'resume-offer-btn', 'resume-dismiss-btn',
    'status-section', 'stage-badge', 'expiry-countdown', 'stage-line', 'stage-spinner', 'stage-text',
    'error-block', 'error-message', 'error-run-link', 'error-start-over',
    'handoff-block', 'release-link-callout', 'release-url-link', 'release-url-text', 'release-tag-line',
    'copy-agent-prompt',
    'cuts-path-hint', 'cuts-file-input', 'start-stage-b', 'cuts-validation', 'music-file-input', 'music-hint',
    'stage-b-controls', 'stage-b-controls-text', 'restart-stage-b', 'cancel-stage-b',
    'complete-block', 'scene-list', 'scene-list-hint', 'final-zip-link', 'final-zip-hint', 'complete-ack',
    'branding-form', 'branding-username-input', 'branding-display-name-input', 'branding-avatar-input',
    'branding-save', 'branding-clear-avatar', 'branding-msg', 'branding-preview', 'branding-current',
    'job-facts', 'raw-toggle', 'raw-status', 'raw-status-code'
  ].forEach(function (id) {
    el[id] = $(id);
  });

  /* ------------------------------------------------------------------ helpers */

  function show(node) { if (node) node.classList.remove('is-hidden'); }
  function hide(node) { if (node) node.classList.add('is-hidden'); }
  function toggleHidden(node, hidden) { if (hidden) hide(node); else show(node); }

  function text(node, value) { if (node) node.textContent = value; }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  /** Base64-encode a UTF-8 string (btoa is latin1-only). */
  function b64encodeUtf8(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  /**
   * Base64-encode a binary File (music upload) for the contents API.
   * Reads the file as an ArrayBuffer and btoa()s it in chunks — the
   * one-shot String.fromCharCode(...bytes) trick overflows the argument
   * stack on multi-MB files.
   */
  function b64encodeFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read ' + file.name)); };
      reader.onload = function () {
        var bytes = new Uint8Array(reader.result);
        var bin = '';
        var CHUNK = 0x8000;
        for (var i = 0; i < bytes.length; i += CHUNK) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        resolve(btoa(bin));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  /** Decode a base64 (possibly newline-wrapped) contents-API payload as UTF-8. */
  function b64decodeUtf8(b64) {
    var bin = atob(String(b64).replace(/\n/g, ''));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function fmtDuration(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function fmtEpoch(epoch) {
    var n = Number(epoch);
    if (!isFinite(n) || n <= 0) return '—';
    return new Date(n * 1000).toLocaleString();
  }

  function fmtClock(totalSeconds) {
    var s = Math.max(0, Math.floor(totalSeconds));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    return h + 'h ' + String(m).padStart(2, '0') + 'm';
  }

  /* ------------------------------------------------------------------ banners */

  var banners = {}; // key -> node

  function banner(key, kind, message) {
    dismissBanner(key);
    var node = document.createElement('div');
    node.className = 'banner banner-' + kind;
    var p = document.createElement('p');
    p.textContent = message;
    node.appendChild(p);
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'banner-close';
    close.setAttribute('aria-label', 'Dismiss message');
    close.textContent = '✕';
    close.addEventListener('click', function () { dismissBanner(key); });
    node.appendChild(close);
    el['banner-stack'].appendChild(node);
    banners[key] = node;
  }

  function dismissBanner(key) {
    var node = banners[key];
    if (node && node.parentNode) node.parentNode.removeChild(node);
    delete banners[key];
  }

  /* -------------------------------------------------------------- github fetch */

  function AuthError(msg) { this.name = 'AuthError'; this.message = msg; }
  AuthError.prototype = Object.create(Error.prototype);

  function RateLimitError(msg) { this.name = 'RateLimitError'; this.message = msg; }
  RateLimitError.prototype = Object.create(Error.prototype);

  function HttpError(status, msg, body) {
    this.name = 'HttpError';
    this.status = status;
    this.message = msg;
    this.body = body;
  }
  HttpError.prototype = Object.create(Error.prototype);

  /**
   * Single GitHub API request with 3 attempts / 2s backoff on network failures.
   * Never logs, never returns the token; token only ever travels in the header.
   */
  async function gh(path, options) {
    options = options || {};
    var url = path.indexOf('http') === 0 ? path : API + path;

    var headers = {
      'Accept': options.accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION
    };
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.headers) {
      Object.keys(options.headers).forEach(function (k) { headers[k] = options.headers[k]; });
    }

    var init = {
      method: options.method || 'GET',
      headers: headers,
      cache: 'no-store'
    };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);

    var attempt = 0;
    var lastNetworkError = null;

    while (attempt < 3) {
      attempt++;
      var res;
      try {
        res = await fetch(url, init);
      } catch (netErr) {
        lastNetworkError = netErr;
        if (attempt < 3) { await sleep(2000); continue; }
        throw new Error('Network error contacting api.github.com after 3 attempts.');
      }

      // Rate limiting: 403 (or 429) with no remaining quota.
      var remaining = res.headers.get('X-RateLimit-Remaining');
      if ((res.status === 403 || res.status === 429) && remaining === '0') {
        var reset = Number(res.headers.get('X-RateLimit-Reset') || 0);
        var waitTxt = reset ? ' Resets at ' + new Date(reset * 1000).toLocaleTimeString() + '.' : '';
        throw new RateLimitError('GitHub API rate limit reached.' + waitTxt);
      }

      if (res.status === 401 || res.status === 403) {
        throw new AuthError('Your token is invalid or lacks required scopes (`repo`, `workflow`).');
      }

      if (res.status === 404) {
        throw new HttpError(404, 'Not found: ' + path.split('?')[0], null);
      }

      if (res.status === 204 || res.status === 205) return null;

      var payload = null;
      var raw = '';
      try {
        raw = await res.text();
        payload = raw ? JSON.parse(raw) : null;
      } catch (e) {
        payload = null;
      }

      if (!res.ok) {
        var msg = (payload && payload.message) ? payload.message : ('GitHub API error ' + res.status);
        throw new HttpError(res.status, msg, payload || raw);
      }

      // A successful call means we are not currently throttled.
      if (state.rateLimited) {
        state.rateLimited = false;
        dismissBanner('ratelimit');
      }
      return payload;
    }

    throw lastNetworkError || new Error('Unknown network failure.');
  }

  function handleGlobalError(err, contextKey) {
    if (err instanceof AuthError || err.name === 'AuthError') {
      banner('auth', 'error', err.message + ' Re-enter it in Settings.');
      openSettings(true);
      stopPolling();
      return;
    }
    if (err instanceof RateLimitError || err.name === 'RateLimitError') {
      state.rateLimited = true;
      banner('ratelimit', 'warn', err.message + ' Polling backed off to 60s.');
      return;
    }
    banner(contextKey || 'generic', 'error', err.message || String(err));
  }

  /* ---------------------------------------------------------------- settings */

  function loadSettings() {
    state.token = localStorage.getItem(LS.token) || '';
    state.owner = localStorage.getItem(LS.owner) || '';
    state.repo = localStorage.getItem(LS.repo) || '';
    el['owner-input'].value = state.owner;
    el['repo-input'].value = state.repo;
    el['token-input'].value = state.token;
    reflectSettings();
  }

  function isConfigured() {
    return !!(state.token && state.owner && state.repo);
  }

  function reflectSettings() {
    if (isConfigured()) {
      text(el['settings-state'], 'configured');
      el['settings-state'].classList.add('ok');
      text(el['repo-indicator'], state.owner + '/' + state.repo);
      show(el['stage-a-section']);
    } else {
      text(el['settings-state'], 'not configured');
      el['settings-state'].classList.remove('ok');
      text(el['repo-indicator'], 'no repo configured');
      hide(el['stage-a-section']);
      hide(el['status-section']);
    }
  }

  function openSettings(open) {
    el['settings-toggle'].setAttribute('aria-expanded', open ? 'true' : 'false');
    toggleHidden(el['settings-body'], !open);
  }

  el['settings-toggle'].addEventListener('click', function () {
    var open = el['settings-toggle'].getAttribute('aria-expanded') === 'true';
    openSettings(!open);
  });

  el['token-reveal'].addEventListener('click', function () {
    var revealed = el['token-input'].type === 'text';
    el['token-input'].type = revealed ? 'password' : 'text';
    el['token-reveal'].textContent = revealed ? 'Show' : 'Hide';
    el['token-reveal'].setAttribute('aria-pressed', revealed ? 'false' : 'true');
  });

  el['settings-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    var owner = el['owner-input'].value.trim();
    var repo = el['repo-input'].value.trim();
    var token = el['token-input'].value.trim();

    if (!owner || !repo || !token) {
      setMsg(el['settings-msg'], 'All three fields are required.', 'bad');
      return;
    }

    localStorage.setItem(LS.owner, owner);
    localStorage.setItem(LS.repo, repo);
    localStorage.setItem(LS.token, token);
    state.owner = owner;
    state.repo = repo;
    state.token = token;
    state.repoPrivate = null;

    dismissBanner('auth');
    reflectSettings();
    setMsg(el['settings-msg'], 'Saved to localStorage.', 'ok');
    openSettings(false);
    probeRepo();
    loadBranding();
    if (!state.jobId) offerResumeFromRepo();
  });

  el['settings-clear'].addEventListener('click', function () {
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.owner);
    localStorage.removeItem(LS.repo);
    localStorage.removeItem(LS.activeJob);
    location.reload();
  });

  /* ---------------------------------------------------- channel branding */

  // Branding is validated live on every keystroke / file pick (same pattern
  // as the production.json validator below) and committed to branding/ on the
  // default branch via the contents API — the exact flow startStageB() uses
  // for production.json.

  function brandingErrors(username, displayName) {
    var errors = [];
    if (!username) {
      errors.push('Username is required.');
    } else if (!/^[a-z0-9_-]{1,64}$/.test(username)) {
      errors.push('Username must be 1–64 chars of a–z, 0–9, _ or - (no @).');
    }
    if (displayName.length > 64) errors.push('Display name must be 64 characters or fewer.');
    if (state.avatarFile) {
      var okType = ['image/png', 'image/jpeg', 'image/webp'].indexOf(state.avatarFile.type) !== -1;
      if (!okType) errors.push('Profile picture must be a PNG, JPEG, or WebP.');
      else if (state.avatarFile.size > BRANDING_AVATAR_MAX_BYTES) {
        errors.push('Profile picture must be 5 MB or smaller (got ' + fmtBytes(state.avatarFile.size) + ').');
      }
    }
    return errors;
  }

  function refreshBrandingValidity() {
    if (!el['branding-save']) return;
    var username = el['branding-username-input'].value.trim().toLowerCase();
    var displayName = el['branding-display-name-input'].value.trim();
    el['branding-save'].disabled = brandingErrors(username, displayName).length > 0;
  }

  el['branding-username-input'].addEventListener('input', refreshBrandingValidity);
  el['branding-display-name-input'].addEventListener('input', refreshBrandingValidity);

  el['branding-avatar-input'].addEventListener('change', function () {
    var file = el['branding-avatar-input'].files && el['branding-avatar-input'].files[0];
    state.avatarFile = file || null;
    state.removeAvatar = false;
    if (file) {
      var okType = ['image/png', 'image/jpeg', 'image/webp'].indexOf(file.type) !== -1;
      if (okType && file.size <= BRANDING_AVATAR_MAX_BYTES) {
        el['branding-preview'].src = URL.createObjectURL(file);
        show(el['branding-preview']);
        setMsg(el['branding-msg'], 'New picture selected — not saved yet.', null);
      }
    }
    refreshBrandingValidity();
  });

  el['branding-clear-avatar'].addEventListener('click', function () {
    state.avatarFile = null;
    el['branding-avatar-input'].value = '';
    state.removeAvatar = true;
    setMsg(el['branding-msg'], 'Saved picture will be removed on Save.', null);
    renderBranding();
    refreshBrandingValidity();
  });

  function readFileAsBytes(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('Could not read the selected file.')); };
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.readAsArrayBuffer(file);
    });
  }

  function bytesToB64(bytes) {
    var bin = '';
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function avatarExtForType(mime) {
    return mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  }

  /** Fetch (or re-fetch) branding.json from the repo. Missing file = never saved. */
  async function loadBranding() {
    if (!isConfigured()) return;
    state.branding = null;
    state.brandingSha = null;
    state.brandingAvatarUrl = '';
    state.brandingAvatarExt = '';
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + BRANDING_JSON_PATH + '?ref=' + REF + '&_=' + Date.now());
      var parsed;
      try {
        parsed = JSON.parse(b64decodeUtf8(file.content));
      } catch (parseErr) {
        setMsg(el['branding-msg'], 'branding/branding.json is not valid JSON — save again to repair it.', 'bad');
        renderBranding();
        refreshBrandingValidity();
        return;
      }
      state.brandingSha = file.sha || null;
      state.branding = {
        username: String(parsed.username || ''),
        display_name: String(parsed.display_name || ''),
        profile_picture: String(parsed.profile_picture || '')
      };
      var pic = state.branding.profile_picture;
      var m = /^branding\/profile_picture\.(png|jpg|jpeg|webp)$/.exec(pic);
      if (m) {
        state.brandingAvatarExt = m[1] === 'jpeg' ? 'jpg' : m[1];
        state.brandingAvatarUrl =
          'https://raw.githubusercontent.com/' + state.owner + '/' + state.repo +
          '/' + REF + '/' + pic;
      }
    } catch (err) {
      if (err.status === 404) {
        // Never saved yet — the empty form is the correct state.
      } else if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
        return;
      } else {
        setMsg(el['branding-msg'], 'Could not load branding: ' + err.message, 'bad');
      }
    }
    renderBranding();
    refreshBrandingValidity();
  }

  function renderBranding() {
    if (!el['branding-form']) return;
    var b = state.branding;

    if (!state.avatarFile && b && b.username) el['branding-username-input'].value = b.username;
    if (!state.avatarFile && b) el['branding-display-name-input'].value = b.display_name;

    if (!state.avatarFile && !state.removeAvatar && state.brandingAvatarUrl) {
      el['branding-preview'].src = state.brandingAvatarUrl;
      show(el['branding-preview']);
    } else if (!state.avatarFile) {
      el['branding-preview'].removeAttribute('src');
      hide(el['branding-preview']);
    }

    var bits = [];
    if (b && b.username) {
      bits.push('Saved: @' + b.username +
        (b.display_name ? ' — ' + b.display_name : ''));
      if (state.brandingAvatarUrl && !state.removeAvatar) bits.push('with profile picture');
    }
    if (state.removeAvatar) bits.push('saved picture will be removed');
    text(el['branding-current'], bits.length ? bits.join(' ') : 'No branding saved yet.');

    var hasSavedPic = !!(b && b.profile_picture);
    toggleHidden(el['branding-clear-avatar'],
      !(hasSavedPic && !state.removeAvatar && !state.avatarFile));
  }

  /** Create/update a file on the default branch via the contents API. */
  async function putRepoFile(path, contentB64, message) {
    var contentsPath = '/repos/' + state.owner + '/' + state.repo + '/contents/' + path;
    var sha = null;
    try {
      var existing = await gh(contentsPath + '?ref=' + REF + '&_=' + Date.now());
      if (existing && existing.sha) sha = existing.sha;
    } catch (err) {
      if (err.status !== 404) throw err;
    }
    var body = { message: message, content: contentB64, branch: REF };
    if (sha) body.sha = sha;
    await gh(contentsPath, { method: 'PUT', body: body });
  }

  /** Delete a file from the default branch (no-op when it does not exist). */
  async function deleteRepoFile(path, message) {
    var contentsPath = '/repos/' + state.owner + '/' + state.repo + '/contents/' + path;
    var existing;
    try {
      existing = await gh(contentsPath + '?ref=' + REF + '&_=' + Date.now());
    } catch (err) {
      if (err.status === 404) return;
      throw err;
    }
    if (!existing || !existing.sha) return;
    await gh(contentsPath, { method: 'DELETE', body: { message: message, sha: existing.sha, branch: REF } });
  }

  el['branding-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    saveBranding();
  });

  async function saveBranding() {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['branding-msg'], 'Save your GitHub settings above first.', 'bad');
      return;
    }

    var username = el['branding-username-input'].value.trim().toLowerCase();
    var displayName = el['branding-display-name-input'].value.trim();
    var errors = brandingErrors(username, displayName);
    if (errors.length) {
      setMsg(el['branding-msg'], errors.join(' '), 'bad');
      return;
    }

    state.busy = true;
    el['branding-save'].disabled = true;
    setMsg(el['branding-msg'], 'Saving to ' + BRANDING_JSON_PATH + '…', null);

    try {
      // 1) New picture picked -> commit it as branding/profile_picture.<ext>.
      var picPath = (state.branding && state.branding.profile_picture) || '';
      if (state.avatarFile) {
        var ext = avatarExtForType(state.avatarFile.type);
        var newPath = BRANDING_AVATAR_STEM + ext;
        var bytes = await readFileAsBytes(state.avatarFile);
        await putRepoFile(newPath, bytesToB64(bytes),
          'clipforge: update channel branding profile picture');
        // If the ext changed (e.g. png -> webp), remove the stale file.
        if (picPath && picPath !== newPath) {
          await deleteRepoFile(picPath, 'clipforge: remove superseded branding profile picture');
        }
        picPath = newPath;
      } else if (state.removeAvatar) {
        if (picPath) {
          await deleteRepoFile(picPath, 'clipforge: remove channel branding profile picture');
        }
        picPath = '';
      }

      // 2) Commit branding.json itself.
      var doc = {
        version: 1,
        username: username,
        display_name: displayName,
        profile_picture: picPath,
        updated_at_epoch: Math.floor(Date.now() / 1000)
      };
      await putRepoFile(BRANDING_JSON_PATH,
        b64encodeUtf8(JSON.stringify(doc, null, 2) + '\n'),
        'clipforge: update channel branding');

      // 3) Reflect locally.
      state.branding = { username: username, display_name: displayName, profile_picture: picPath };
      state.brandingAvatarExt = picPath ? picPath.split('.').pop() : '';
      state.brandingAvatarUrl = picPath
        ? 'https://raw.githubusercontent.com/' + state.owner + '/' + state.repo + '/' + REF + '/' + picPath
        : '';
      state.removeAvatar = false;
      if (state.avatarFile) {
        el['branding-avatar-input'].value = '';
        state.avatarFile = null;
      }
      renderBranding();
      setMsg(el['branding-msg'], 'Branding saved. It now applies to every future job.', 'ok');
    } catch (err) {
      setMsg(el['branding-msg'], 'Save failed: ' + err.message, 'bad');
      handleGlobalError(err, 'branding');
    }

    state.busy = false;
    refreshBrandingValidity();
  }

  function setMsg(node, message, kind) {
    if (!node) return;
    node.textContent = message || '';
    node.classList.remove('ok', 'bad');
    if (kind) node.classList.add(kind);
  }

  /** Learn whether the repo is private (decides how assets must be downloaded). */
  async function probeRepo() {
    if (!isConfigured()) return;
    try {
      var repo = await gh('/repos/' + state.owner + '/' + state.repo);
      state.repoPrivate = !!repo.private;
    } catch (err) {
      if (err.name === 'AuthError') handleGlobalError(err);
      // Non-fatal otherwise; assume private-safe download path.
    }
  }

  /* ------------------------------------------------------------- stage A flow */

  el['stage-a-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    startStageA();
  });

  async function startStageA() {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['stage-a-msg'], 'Save your settings first.', 'bad');
      openSettings(true);
      return;
    }

    var videoUrl = el['video-url-input'].value.trim();
    if (!videoUrl) {
      setMsg(el['stage-a-msg'], 'A video URL is required.', 'bad');
      return;
    }

    var slug = el['job-slug-input'].value.trim();
    var targetDurRaw = (el['target-duration-select'] && el['target-duration-select'].value) || '120';
    var targetDurInt = parseInt(targetDurRaw, 10);
    if (!isFinite(targetDurInt) || targetDurInt <= 0) targetDurInt = 120;

    // Optional narrow-focus directive. Free-form user text; trimmed to
    // strip incidental whitespace, and left as "" when the field is
    // empty so stage-a.yml's default (whole-video behavior) applies.
    var focusRaw = (el['focus-input'] && el['focus-input'].value) || '';
    var focus = focusRaw.replace(/^\s+|\s+$/g, '');

    var inputs = {
      video_url: videoUrl,
      job_id: slug,
      whisper_model: el['whisper-model-select'].value,
      language: el['language-input'].value.trim() || 'auto',
      target_duration_seconds: String(targetDurInt),
      focus: focus
    };

    state.busy = true;
    el['start-stage-a'].disabled = true;
    setMsg(el['stage-a-msg'], 'Dispatching stage-a.yml…', null);
    dismissBanner('dispatch');
    dismissBanner('generic');

    // Snapshot existing job folders so we can diff for the new one.
    var before = [];
    try {
      before = await listJobDirs();
    } catch (err) {
      if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
        state.busy = false;
        el['start-stage-a'].disabled = false;
        return;
      }
    }

    var dispatchedAt = new Date();

    try {
      await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/workflows/stage-a.yml/dispatches', {
        method: 'POST',
        body: { ref: REF, inputs: inputs }
      });
    } catch (err) {
      state.busy = false;
      el['start-stage-a'].disabled = false;
      if (err.status === 404) {
        banner('dispatch', 'error',
          'Workflow may not be enabled. Check `.github/workflows/stage-a.yml` in the repo Actions tab.');
        setMsg(el['stage-a-msg'], 'Dispatch failed.', 'bad');
        return;
      }
      handleGlobalError(err, 'dispatch');
      setMsg(el['stage-a-msg'], 'Dispatch failed.', 'bad');
      return;
    }

    setMsg(el['stage-a-msg'], 'Dispatched (HTTP 204). Locating the workflow run…', 'ok');

    // Reveal status section immediately; stage state arrives via status.json.
    state.status = null;
    state.stageBDispatched = false;
    state.releaseAssets = null;
    state.releaseAssetsTag = null;
    show(el['status-section']);
    show(el['active-job-bar']);
    hide(el['resume-offer']);
    renderStage();

    // If the user supplied a slug, we can start polling that path right away.
    if (slug) setActiveJob(slug);

    state.busy = false;
    el['start-stage-a'].disabled = false;

    findWorkflowRun('stage-a.yml', dispatchedAt);
    if (!slug) discoverJobId(before);
    else startPolling();
  }

  /** Locate the run created by our dispatch; surface a hint if none appears. */
  async function findWorkflowRun(workflowFile, dispatchedAt) {
    var deadline = Date.now() + RUN_DISCOVERY_TIMEOUT;
    var cushion = dispatchedAt.getTime() - 60000; // clock-skew cushion

    while (Date.now() < deadline) {
      try {
        var data = await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/workflows/' + workflowFile +
          '/runs?event=workflow_dispatch&per_page=10');
        var runs = (data && data.workflow_runs) || [];
        var match = runs
          .filter(function (r) {
            return new Date(r.created_at).getTime() >= cushion &&
              (r.status === 'queued' || r.status === 'in_progress' || r.status === 'waiting' ||
                r.status === 'requested' || r.status === 'pending');
          })
          .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })[0];

        if (match) {
          state.runId = match.id;
          state.runHtmlUrl = match.html_url;
          if (workflowFile === 'stage-b.yml') state.stageBRun = match;
          el['run-link'].href = match.html_url;
          show(el['run-link']);
          watchRunForEarlyFailure(match.id);
          return;
        }
      } catch (err) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError') {
          handleGlobalError(err);
          return;
        }
      }
      await sleep(3000);
    }

    banner('dispatch', 'warn',
      'Workflow may not be enabled. Check `.github/workflows/' + workflowFile +
      '` in the repo Actions tab.');
  }

  /**
   * Watch the run only to catch early workflow failures. status.json remains
   * authoritative for stage state.
   */
  async function watchRunForEarlyFailure(runId) {
    while (state.runId === runId) {
      await sleep(15000);
      if (state.runId !== runId) return;
      var stage = state.status && state.status.stage;
      if (stage === 'complete' || stage === 'error') return;

      var run;
      try {
        run = await gh('/repos/' + state.owner + '/' + state.repo + '/actions/runs/' + runId);
      } catch (err) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError') return;
        continue;
      }
      if (run && run.status === 'completed') {
        stage = state.status && state.status.stage;
        if (run.conclusion !== 'success' && stage !== 'complete' &&
            stage !== 'awaiting_json_upload' && stage !== 'error') {
          banner('run', 'error',
            'The workflow run finished with conclusion "' + run.conclusion +
            '" before status.json reported completion. Check the run logs.');
        }
        return;
      }
    }
  }

  /* ----------------------------------------------------------- job discovery */

  async function listJobDirs() {
    try {
      var data = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/jobs?ref=' + REF + '&_=' + Date.now());
      if (!Array.isArray(data)) return [];
      return data
        .filter(function (entry) { return entry.type === 'dir' && entry.name !== '.gitkeep'; })
        .map(function (entry) { return entry.name; });
    } catch (err) {
      if (err.status === 404) return [];   // jobs/ folder not created yet
      throw err;
    }
  }

  /** Poll jobs/ until a folder that was not in `before` shows up. */
  async function discoverJobId(before) {
    var known = {};
    (before || []).forEach(function (n) { known[n] = true; });
    var deadline = Date.now() + 15 * 60 * 1000;

    text(el['stage-text'], 'Dispatched. Waiting for Stage A to create the job folder…');
    show(el['stage-spinner']);

    while (Date.now() < deadline && !state.jobId) {
      await sleep(5000);
      var now;
      try {
        now = await listJobDirs();
      } catch (err) {
        handleGlobalError(err);
        if (err.name === 'AuthError') return;
        continue;
      }
      var fresh = now.filter(function (n) { return !known[n]; }).sort();
      if (fresh.length) {
        setActiveJob(fresh[fresh.length - 1]);
        startPolling();
        return;
      }
    }

    if (!state.jobId) {
      banner('discover', 'warn',
        'No new job folder appeared under jobs/ yet. The run may still be downloading, ' +
        'or it may have failed early — check the workflow run.');
    }
  }

  function setActiveJob(jobId) {
    state.jobId = jobId;
    localStorage.setItem(LS.activeJob, jobId);
    text(el['active-job-id'], jobId);
    text(el['cuts-path-hint'], 'jobs/' + jobId + '/production.json');
    show(el['active-job-bar']);
    show(el['status-section']);
    dismissBanner('discover');
  }

  function clearActiveJob() {
    stopPolling();
    stopCountdown();
    state.jobId = null;
    state.runId = null;
    state.runHtmlUrl = null;
    state.status = null;
    state.releaseAssets = null;
    state.releaseAssetsTag = null;
    state.validatedCuts = null;
    state.stageBDispatched = false;
    state.stageBRun = null;
    state.cancellingStageB = false;
    localStorage.removeItem(LS.activeJob);
    hide(el['status-section']);
    hide(el['active-job-bar']);
    hide(el['run-link']);
    text(el['active-job-id'], '—');
    text(el['raw-status-code'], '(nothing yet)');
    setMsg(el['stage-a-msg'], '', null);
    ['run', 'discover', 'dispatch', 'status', 'generic', 'download'].forEach(dismissBanner);
    el['cuts-file-input'].value = '';
    if (el['music-file-input']) el['music-file-input'].value = '';
    state.musicFile = null;
    if (el['music-hint']) { el['music-hint'].textContent = ''; }
    el['start-stage-b'].disabled = true;
    hide(el['cuts-validation']);
  }

  /* -------------------------------------------------------------- status poll */

  function startPolling() {
    if (!state.jobId) return;
    stopPolling();
    state.polling = true;
    state.pollStartedAt = Date.now();
    hide(el['resume-btn']);
    pollOnce();
  }

  function stopPolling() {
    state.polling = false;
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
  }

  function currentInterval() {
    if (state.rateLimited) return POLL_RATELIMIT;
    if (Date.now() - state.pollStartedAt > POLL_SLOWDOWN_AFTER) return POLL_SLOW;
    return POLL_FAST;
  }

  function scheduleNextPoll() {
    if (!state.polling) return;
    state.pollTimer = setTimeout(pollOnce, currentInterval());
  }

  async function pollOnce() {
    if (!state.polling || !state.jobId) return;

    var path = '/repos/' + state.owner + '/' + state.repo +
      '/contents/jobs/' + encodeURIComponent(state.jobId) + '/status.json?ref=' + REF +
      '&_=' + Date.now();

    try {
      var file = await gh(path);
      var json = b64decodeUtf8(file.content);
      var parsed;
      try {
        parsed = JSON.parse(json);
      } catch (parseErr) {
        state.status = { stage: 'error', message: 'status.json is not valid JSON.', _raw: json };
        renderStage();
        stopPolling();
        return;
      }
      dismissBanner('status');
        state.status = parsed;
      await refreshStageBRun();
      renderStage();

      if (isTerminalStageBRun() || (!stageFromRun() &&
          (parsed.stage === 'complete' || parsed.stage === 'error' || parsed.stage === 'cancelled' || !isKnownStage(parsed.stage)))) {
        stopPolling();
        return;
      }
    } catch (err) {
      if (err.status === 404) {
        // Stage A has not written the folder/file yet — keep waiting.
        if (!state.status) renderStage();
      } else if (err.name === 'AuthError') {
        handleGlobalError(err);
        return;
      } else if (err.name === 'RateLimitError') {
        handleGlobalError(err);
      } else {
        banner('status', 'warn', 'Could not read status.json: ' + err.message + ' Retrying…');
      }
    }

    scheduleNextPoll();
  }

  function isKnownStage(stage) {
    return ['queued', 'stage_a_running', 'awaiting_json_upload', 'stage_b_queued',
      'stage_b_running', 'stage_b_cancelling', 'cancelled', 'complete', 'error'].indexOf(stage) !== -1;
  }

  function isActiveStageBRun() {
    return !!(state.stageBRun && ['queued', 'in_progress', 'waiting', 'requested', 'pending'].indexOf(state.stageBRun.status) !== -1);
  }

  function isTerminalStageBRun() {
    return !!(state.stageBRun && state.stageBRun.status === 'completed');
  }

  function stageFromRun() {
    if (!state.stageBRun) return '';
    if (state.cancellingStageB || state.stageBRun.status === 'cancelling') return 'stage_b_cancelling';
    if (isActiveStageBRun()) return state.stageBRun.status === 'queued' ? 'stage_b_queued' : 'stage_b_running';
    if (state.stageBRun.status === 'completed' && state.stageBRun.conclusion === 'cancelled') return 'cancelled';
    return '';
  }

  async function refreshStageBRun() {
    if (!state.jobId || !isConfigured()) return;
    try {
      var id = state.status && state.status.extra && state.status.extra.workflow_run_id;
      var run;
      if (id) run = await gh('/repos/' + state.owner + '/' + state.repo + '/actions/runs/' + encodeURIComponent(id));
      else {
        var data = await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/workflows/stage-b.yml/runs?event=workflow_dispatch&per_page=30');
        var expectedTitle = 'Stage B — ' + state.jobId;
        run = ((data && data.workflow_runs) || []).filter(function (candidate) {
          return candidate.display_title === expectedTitle;
        }).sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })[0];
      }
      if (run) {
        state.stageBRun = run;
        state.runId = run.id;
        state.runHtmlUrl = run.html_url;
        el['run-link'].href = run.html_url;
        show(el['run-link']);
        if (run.status === 'completed') state.cancellingStageB = false;
      }
    } catch (err) {
      if (err.name === 'AuthError' || err.name === 'RateLimitError') handleGlobalError(err);
    }
  }

  /* ------------------------------------------------------------------ render */

  var STAGE_META = {
    queued: { label: 'queued', cls: 'stage-running', spin: true, text: 'Queued.' },
    stage_a_running: {
      label: 'stage a', cls: 'stage-running', spin: true,
      text: 'Stage A running — downloading, transcribing, extracting frames'
    },
    awaiting_json_upload: {
      label: 'awaiting production.json', cls: 'stage-await', spin: false,
      text: 'Stage A complete. Download the artifacts, produce production.json, upload it below.'
    },
    stage_b_queued: { label: 'stage b queued', cls: 'stage-running', spin: true, text: 'Stage B is queued.' },
    stage_b_running: {
      label: 'stage b', cls: 'stage-running', spin: true,
      text: 'Stage B running — producing the final video'
    },
    stage_b_cancelling: { label: 'cancelling', cls: 'stage-cancelling', spin: true, text: 'Cancelling Stage B…' },
    cancelled: { label: 'cancelled', cls: 'stage-cancelled', spin: false, text: 'Stage B was cancelled.' },
    complete: { label: 'complete', cls: 'stage-done', spin: false, text: 'Job complete.' },
    error: { label: 'error', cls: 'stage-error', spin: false, text: 'The job reported an error.' }
  };

  function renderStage() {
    var s = state.status;
    var actionStage = stageFromRun();
    if (actionStage) {
      s = Object.assign({}, s || {}, {
        stage: actionStage,
        message: actionStage === 'stage_b_cancelling' ? 'Cancelling Stage B…' :
          actionStage === 'cancelled' ? 'Stage B was cancelled.' :
          actionStage === 'stage_b_queued' ? 'Stage B is queued.' : 'Stage B is running.'
      });
    }

    // Nothing on GitHub yet.
    if (!s) {
      setBadge('waiting', 'stage-unknown');
      show(el['stage-spinner']);
      text(el['stage-text'], 'Waiting for Stage A to start…');
      hide(el['error-block']);
      hide(el['handoff-block']);
      hide(el['complete-block']);
      hide(el['job-facts']);
      hide(el['expiry-countdown']);
      renderRaw(null);
      return;
    }

    var stage = s.stage;
    var known = isKnownStage(stage);
    var meta = known ? STAGE_META[stage] : STAGE_META.error;

    setBadge(known ? meta.label : 'unknown: ' + String(stage), meta.cls);
    toggleHidden(el['stage-spinner'], !meta.spin);
    text(el['stage-text'], (known && stage !== 'error' && s.message) ? s.message : meta.text);

    // Error (including unknown stages, which render as error + raw dump).
    var isError = stage === 'error' || !known;
    if (isError) {
      show(el['error-block']);
      var msg = known
        ? (s.message || 'The workflow reported an error with no message.')
        : 'Unknown stage "' + String(stage) + '". Raw status document is shown below.';
      text(el['error-message'], msg);
      if (state.runHtmlUrl) {
        el['error-run-link'].href = state.runHtmlUrl;
        show(el['error-run-link']);
      } else {
        hide(el['error-run-link']);
      }
      if (!known) openRaw(true);
    } else {
      hide(el['error-block']);
    }

    // Handoff (awaiting_json_upload).
    if (stage === 'awaiting_json_upload') {
      show(el['handoff-block']);
      renderAssets(s);
    } else {
      hide(el['handoff-block']);
    }

    // Complete.
    if (stage === 'complete') {
      show(el['complete-block']);
      renderFinalZip(s);
    } else {
      hide(el['complete-block']);
    }

    // Expiry countdown from awaiting_json_upload onwards.
    var showCountdown = ['awaiting_json_upload', 'stage_b_running', 'complete'].indexOf(stage) !== -1;
    if (showCountdown && Number(s.expires_at_epoch) > 0) startCountdown(Number(s.expires_at_epoch));
    else stopCountdown();

    renderFacts(s);
    renderRaw(s);

    renderStageBControls(stage);

    // Resume button appears when polling has stopped on a terminal-ish state.
    toggleHidden(el['resume-btn'], state.polling || stage === 'complete' || stage === 'error' || stage === 'cancelled');
  }

  function renderStageBControls(stage) {
    var active = isActiveStageBRun();
    var terminal = ['complete', 'cancelled', 'error'].indexOf(stage) !== -1 && !active;
    if (!active && !terminal) { hide(el['stage-b-controls']); return; }
    show(el['stage-b-controls']);
    el['restart-stage-b'].disabled = state.busy || !terminal;
    el['cancel-stage-b'].disabled = state.busy || !active || state.cancellingStageB;
    toggleHidden(el['restart-stage-b'], !terminal);
    toggleHidden(el['cancel-stage-b'], !active);
    text(el['stage-b-controls-text'], active
      ? (state.cancellingStageB ? 'Cancellation requested. Waiting for GitHub Actions to stop the run.' : 'Stage B is active. Cancelling stops the GitHub Actions run.')
      : 'Stage B can be run again using this job\'s committed production settings.');
  }

  function setBadge(label, cls) {
    el['stage-badge'].textContent = label;
    el['stage-badge'].className = 'stage-badge ' + cls;
  }

  function renderFacts(s) {
    var rows = [];
    if (s.job_id) rows.push(['job_id', s.job_id]);
    if (s.release_tag) rows.push(['release_tag', s.release_tag]);
    if (s.release_url) rows.push(['release_url', s.release_url]);
    if (s.created_at_epoch) rows.push(['created', fmtEpoch(s.created_at_epoch)]);
    if (s.updated_at_epoch) rows.push(['updated', fmtEpoch(s.updated_at_epoch)]);
    if (s.expires_at_epoch) rows.push(['expires', fmtEpoch(s.expires_at_epoch)]);
    if (s.extra && typeof s.extra === 'object') {
      Object.keys(s.extra).forEach(function (k) {
        var v = s.extra[k];
        if (k === 'title') {
          // The one-per-job title is long free text — pin it to the end of
          // the facts list so it never squeezes the technical fields.
          return;
        }
        if (k === 'duration_seconds' && isFinite(Number(v))) {
          rows.push([k, v + ' (' + fmtDuration(Number(v)) + ')']);
        } else {
          rows.push([k, String(v)]);
        }
      });
      if (s.extra.title) rows.push(['title', String(s.extra.title)]);
    }

    el['job-facts'].innerHTML = '';
    if (!rows.length) { hide(el['job-facts']); return; }
    rows.forEach(function (pair) {
      var dt = document.createElement('dt');
      dt.textContent = pair[0];
      var dd = document.createElement('dd');
      dd.textContent = pair[1];
      el['job-facts'].appendChild(dt);
      el['job-facts'].appendChild(dd);
    });
    show(el['job-facts']);
  }

  function renderRaw(s) {
    text(el['raw-status-code'], s ? JSON.stringify(s, null, 2) : '(no status.json yet)');
  }

  /* ------------------------------------------------------------------ assets */

  /** The single Release page URL the UI surfaces after Stage A. */
  function releasePageUrl(s) {
    if (s && typeof s.release_url === 'string' && /^https?:\/\//.test(s.release_url)) {
      return s.release_url;
    }
    if (s && s.release_tag) {
      return 'https://github.com/' + state.owner + '/' + state.repo +
        '/releases/tag/' + s.release_tag;
    }
    return '';
  }

  function renderAssets(s) {
    var url = releasePageUrl(s);

    if (url) {
      el['release-url-link'].href = url;
      text(el['release-url-text'], url);
    } else {
      el['release-url-link'].removeAttribute('href');
      text(el['release-url-text'],
        'Release URL not yet available — check the Releases page of the repo.');
    }

    text(el['release-tag-line'], s.release_tag ? 'Release tag: ' + s.release_tag : '');

    // Prime the "Copy for AI agent" button: it stashes the ready-to-paste
    // hand-off block on a data attribute and disables itself until a URL is
    // actually available for the current job.
    var copyBtn = el['copy-agent-prompt'];
    if (copyBtn) {
      if (url) {
        copyBtn.dataset.pasteText = buildAgentPasteText(url);
        copyBtn.disabled = false;
        copyBtn.classList.remove('is-copied');
        copyBtn.textContent = 'Copy for AI agent';
      } else {
        copyBtn.dataset.pasteText = '';
        copyBtn.disabled = true;
        copyBtn.classList.remove('is-copied');
        copyBtn.textContent = 'Copy for AI agent';
      }
    }

    // Warm the release-asset id cache so private-repo downloads work.
    if (s.release_tag) loadReleaseAssets(s.release_tag, false);
  }

  /**
   * Build the single, ready-to-paste text block the user hands to their AI
   * agent. It carries the Release URL together with a brief instruction that
   * tells the agent to open 00_READ_THIS_FIRST first and return production.json.
   */
  function buildAgentPasteText(url) {
    return (
      'Go to this link: ' + url + ' — it contains a GitHub Release with a ' +
      'transcript, screenshots, and an analysis prompt file (its name starts ' +
      'with 00_READ_THIS_FIRST). Open/read that file first, then follow its ' +
      'instructions to analyze the transcript and screenshots and produce the ' +
      'requested production.json output.'
    );
  }

  /** Copy `text` to the clipboard. Uses the async API when available, falls
   *  back to a hidden <textarea> + execCommand so it still works on non-secure
   *  contexts and older browsers. Returns a Promise<boolean>. */
  function copyToClipboard(str) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(str).then(function () { return true; },
        function () { return fallbackCopy(str); });
    }
    return Promise.resolve(fallbackCopy(str));
  }

  function fallbackCopy(str) {
    try {
      var ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, str.length);
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      return false;
    }
  }

  if (el['copy-agent-prompt']) {
    el['copy-agent-prompt'].addEventListener('click', function () {
      var btn = el['copy-agent-prompt'];
      var paste = btn.dataset.pasteText || '';
      if (!paste) return;
      copyToClipboard(paste).then(function (ok) {
        if (ok) {
          btn.classList.add('is-copied');
          btn.textContent = 'Copied — paste into your AI agent';
          setTimeout(function () {
            btn.classList.remove('is-copied');
            btn.textContent = 'Copy for AI agent';
          }, 2500);
        } else {
          btn.textContent = 'Copy failed — select the URL below manually';
          setTimeout(function () { btn.textContent = 'Copy for AI agent'; }, 3000);
        }
      });
    });
  }

  /** Release-asset lookup — gives us asset ids for private-repo downloads
   *  and the scene-file names/URLs for the complete-state scene list. When
   *  `renderInto` is true, the complete-state scene list is re-rendered once
   *  the fresh asset data arrives. */
  async function loadReleaseAssets(tag, renderInto) {
    if (state.releaseAssetsTag === tag && state.releaseAssets) {
      if (renderInto && state.status && state.status.stage === 'complete') {
        renderSceneList(state.status);
      }
      return;
    }
    try {
      var rel = await gh('/repos/' + state.owner + '/' + state.repo +
        '/releases/tags/' + encodeURIComponent(tag));
      state.releaseAssets = (rel.assets || []).map(function (a) {
        return { name: a.name, id: a.id, url: a.browser_download_url, size: a.size };
      });
      state.releaseAssetsTag = tag;
      if (renderInto && state.status && state.status.stage === 'complete') {
        renderSceneList(state.status);
      }
    } catch (err) {
      if (err.name === 'AuthError') handleGlobalError(err);
      // Otherwise silent: the Release page link is the primary path.
    }
  }

  function findAssetId(name) {
    if (!state.releaseAssets) return null;
    var hit = state.releaseAssets.filter(function (a) { return a.name === name; })[0];
    return hit ? hit.id : null;
  }

  /**
   * Public repos: let the browser follow browser_download_url directly.
   * Private repos: pull bytes through the asset-id endpoint with the token.
   */
  function makeDownloadHandler(name, url) {
    return function (event) {
      if (state.repoPrivate !== true) return; // default anchor behaviour
      var assetId = findAssetId(name === 'final_zip' ? fileNameFromUrl(url) : name);
      if (!assetId) return;                   // fall back to the plain link
      event.preventDefault();
      downloadPrivateAsset(assetId, fileNameFromUrl(url) || name, url);
    };
  }

  function fileNameFromUrl(url) {
    try {
      var parts = String(url).split('?')[0].split('/');
      return decodeURIComponent(parts[parts.length - 1] || '');
    } catch (e) { return ''; }
  }

  async function downloadPrivateAsset(assetId, filename, fallbackUrl) {
    banner('download', 'info', 'Downloading ' + filename + ' through the API…');
    try {
      var res = await fetch(API + '/repos/' + state.owner + '/' + state.repo +
        '/releases/assets/' + assetId, {
        headers: {
          'Authorization': 'Bearer ' + state.token,
          'Accept': 'application/octet-stream',
          'X-GitHub-Api-Version': API_VERSION
        },
        cache: 'no-store'
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var blob = await res.blob();
      var objUrl = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = objUrl;
      a.download = filename || 'clipforge-asset';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(objUrl); }, 30000);
      dismissBanner('download');
    } catch (err) {
      banner('download', 'warn',
        'Authenticated download failed (' + err.message + '). Opening the direct release URL instead.');
      window.open(fallbackUrl, '_blank', 'noopener');
    }
  }

  /* ------------------------------------------------- production.json validate */

  el['cuts-file-input'].addEventListener('change', function () {
    state.validatedCuts = null;
    el['start-stage-b'].disabled = true;
    var file = el['cuts-file-input'].files && el['cuts-file-input'].files[0];
    if (!file) { hide(el['cuts-validation']); return; }

    var reader = new FileReader();
    reader.onerror = function () {
      showValidation(['Could not read the selected file.'], false);
    };
    reader.onload = function () {
      var raw = String(reader.result);
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        showValidation(['Not valid JSON: ' + e.message], false);
        return;
      }
      var errors = validateCuts(parsed);
      if (errors.length) {
        showValidation(errors, false);
        return;
      }
      state.validatedCuts = raw;
      var count = parsed.cuts.length;
      var total = parsed.cuts.reduce(function (sum, c) {
        return sum + (c.end_seconds - c.start_seconds);
      }, 0);
      showValidation([
        'Valid. ' + count + ' cut' + (count === 1 ? '' : 's') + ', ' +
        total + 's of source selected (target ' +
        parsed.target_total_duration_seconds + 's).' +
        (typeof parsed.title === 'string' && parsed.title.trim() !== ''
          ? '\nJob title: "' + parsed.title + '" (one title for every scene of this job.)'
          : '')
      ], true);
      el['start-stage-b'].disabled = false;
    };
    reader.readAsText(file);
  });

  el['music-file-input'].addEventListener('change', function () {
    var file = el['music-file-input'].files && el['music-file-input'].files[0];
    state.musicFile = file || null;
    if (el['music-hint']) {
      el['music-hint'].textContent = file
        ? 'Music: ' + file.name + ' — will be mixed under the voiceover at ~30% volume.'
        : '';
    }
  });

  function showValidation(messages, ok) {
    var node = el['cuts-validation'];
    node.className = 'validation ' + (ok ? 'ok' : 'bad');
    node.textContent = messages.join('\n');
    show(node);
  }

  function isInt(v) { return typeof v === 'number' && isFinite(v) && Math.floor(v) === v; }

  /** Full client-side contract check from §6.5. */
  function validateCuts(doc) {
    var errors = [];

    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return ['Top level must be a JSON object.'];
    }

    // Optional one-per-job title (generated by the same agent step that
    // produces the cuts; see 00_READ_THIS_FIRST.txt). Validated when
    // present so a malformed title is caught before upload, never required
    // so older production.json files keep working.
    if (doc.title !== undefined &&
        (typeof doc.title !== 'string' || doc.title.trim() === '')) {
      errors.push('`title` must be a non-empty string when present (or omit it entirely).');
    }

    if (!isInt(doc.video_duration_seconds) || doc.video_duration_seconds <= 0) {
      errors.push('`video_duration_seconds` must be a positive integer.');
    }
    if (!isInt(doc.target_total_duration_seconds) || doc.target_total_duration_seconds <= 0) {
      errors.push('`target_total_duration_seconds` must be a positive integer.');
    }
    if (!Array.isArray(doc.cuts)) {
      errors.push('`cuts` must be an array.');
      return errors;
    }
    if (doc.cuts.length === 0) {
      errors.push('`cuts` is empty — at least one cut is required.');
      return errors;
    }

    var duration = isInt(doc.video_duration_seconds) ? doc.video_duration_seconds : null;
    var prevEnd = null;

    doc.cuts.forEach(function (cut, i) {
      var at = 'cuts[' + i + ']';
      if (!cut || typeof cut !== 'object' || Array.isArray(cut)) {
        errors.push(at + ' must be an object.');
        return;
      }
      if (!isInt(cut.start_seconds)) errors.push(at + '.start_seconds must be an integer.');
      if (!isInt(cut.end_seconds)) errors.push(at + '.end_seconds must be an integer.');
      // voiceover_text is the final, ready-to-speak line for this cut. The
      // legacy raw_narration field is accepted as a fallback so in-flight
      // pre-rename cuts.json files still validate and run.
      var vo = (typeof cut.voiceover_text === 'string' && cut.voiceover_text.trim() !== '')
        ? cut.voiceover_text
        : cut.raw_narration;
      if (typeof vo !== 'string' || vo.trim() === '') {
        errors.push(at + '.voiceover_text must be a non-empty string (legacy raw_narration accepted).');
      }
      if (!isInt(cut.start_seconds) || !isInt(cut.end_seconds)) return;

      if (cut.end_seconds <= cut.start_seconds) {
        errors.push(at + ': end_seconds (' + cut.end_seconds +
          ') must be greater than start_seconds (' + cut.start_seconds + ').');
      }
      if (cut.start_seconds < 0) {
        errors.push(at + ': start_seconds (' + cut.start_seconds + ') is below 0.');
      }
      if (duration !== null && cut.end_seconds > duration) {
        errors.push(at + ': end_seconds (' + cut.end_seconds +
          ') exceeds video_duration_seconds (' + duration + ').');
      }
      if (prevEnd !== null && cut.start_seconds < prevEnd) {
        errors.push(at + ': starts at ' + cut.start_seconds +
          ' which overlaps or precedes the previous cut ending at ' + prevEnd +
          ' — cuts must not overlap and must be sorted ascending.');
      }
      prevEnd = cut.end_seconds;
    });

    return errors;
  }

  /* ------------------------------------------------------- upload + stage B */

  el['start-stage-b'].addEventListener('click', function () {
    startStageB();
  });

  async function startStageB() {
    if (state.busy) return;
    if (!state.jobId) {
      showValidation(['No active job id — cannot upload.'], false);
      return;
    }
    if (!state.validatedCuts) {
      showValidation(['Select a valid production.json first.'], false);
      return;
    }

    state.busy = true;
    el['start-stage-b'].disabled = true;
    var path = 'jobs/' + state.jobId + '/production.json';
    showValidation(['Committing ' + path + '…'], true);

    var contentsPath = '/repos/' + state.owner + '/' + state.repo +
      '/contents/jobs/' + encodeURIComponent(state.jobId) + '/production.json';

    // Existing file? Need its blob sha to update.
    var sha = null;
    try {
      var existing = await gh(contentsPath + '?ref=' + REF + '&_=' + Date.now());
      if (existing && existing.sha) sha = existing.sha;
    } catch (err) {
      if (err.status !== 404) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError') {
          handleGlobalError(err);
          state.busy = false;
          el['start-stage-b'].disabled = false;
          return;
        }
      }
    }

    var body = {
      message: 'clipforge: upload production.json for job ' + state.jobId,
      content: b64encodeUtf8(state.validatedCuts),
      branch: REF
    };
    if (sha) body.sha = sha;

    try {
      await gh(contentsPath, { method: 'PUT', body: body });
    } catch (err) {
      state.busy = false;
      el['start-stage-b'].disabled = false;
      showValidation(['Commit failed: ' + err.message], false);
      handleGlobalError(err, 'upload');
      return;
    }

    // Optional background music: when the user picked a file it is
    // committed to jobs/<jobId>/music.mp3 (base64 via the contents API,
    // same pattern as production.json) and passed to Stage B as
    // music_ref. No file picked -> music_ref stays empty and the workflow
    // skips music entirely.
    var musicRef = '';
    if (state.musicFile) {
      var musicPath = 'jobs/' + state.jobId + '/music.mp3';
      showValidation([path + ' committed. Committing ' + musicPath + '…'], true);
      var musicContentsPath = '/repos/' + state.owner + '/' + state.repo +
        '/contents/jobs/' + encodeURIComponent(state.jobId) + '/music.mp3';
      var musicSha = null;
      try {
        var existingMusic = await gh(musicContentsPath + '?ref=' + REF + '&_=' + Date.now());
        if (existingMusic && existingMusic.sha) musicSha = existingMusic.sha;
      } catch (err) {
        if (err.status !== 404 &&
            (err.name === 'AuthError' || err.name === 'RateLimitError')) {
          handleGlobalError(err);
          state.busy = false;
          el['start-stage-b'].disabled = false;
          return;
        }
      }
      var musicBody = {
        message: 'clipforge: upload music.mp3 for job ' + state.jobId,
        content: await b64encodeFile(state.musicFile),
        branch: REF
      };
      if (musicSha) musicBody.sha = musicSha;
      try {
        await gh(musicContentsPath, { method: 'PUT', body: musicBody });
      } catch (err) {
        state.busy = false;
        el['start-stage-b'].disabled = false;
        showValidation(['Music commit failed: ' + err.message], false);
        handleGlobalError(err, 'upload');
        return;
      }
      musicRef = 'path:' + musicPath;
    }

    showValidation([
      path + ' committed' + (musicRef ? ' (+ music)' : '') +
      '. Dispatching stage-b.yml… (voiceover + subtitles, one merged final.mp4)'
    ], true);

    var dispatchedAt = new Date();
    try {
      await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/workflows/stage-b.yml/dispatches', {
        method: 'POST',
        body: {
          ref: REF,
          inputs: {
            job_id: state.jobId,
            production_ref: 'path:jobs/' + state.jobId + '/production.json',
            music_ref: musicRef
          }
        }
      });
    } catch (err) {
      state.busy = false;
      el['start-stage-b'].disabled = false;
      if (err.status === 404) {
        banner('dispatch', 'error',
          'Workflow may not be enabled. Check `.github/workflows/stage-b.yml` in the repo Actions tab.');
      } else {
        handleGlobalError(err, 'dispatch');
      }
      showValidation(['Stage B dispatch failed: ' + err.message], false);
      return;
    }

    state.busy = false;
    state.stageBDispatched = true;
    state.cancellingStageB = false;
    state.stageBRun = { status: 'queued', conclusion: null };
    showValidation(['Stage B dispatched. Waiting for the GitHub Actions run to start…'], true);
    hide(el['handoff-block']);
    show(el['stage-spinner']);
    text(el['stage-text'], 'Stage B dispatched — waiting for the runner to pick it up…');
    setBadge('stage b', 'stage-running');

    state.runId = null;
    state.runHtmlUrl = null;
    hide(el['run-link']);
    findWorkflowRun('stage-b.yml', dispatchedAt);
    startPolling();
  }

  el['restart-stage-b'].addEventListener('click', function () { restartStageB(); });
  el['cancel-stage-b'].addEventListener('click', function () { cancelStageB(); });

  async function restartStageB() {
    if (state.busy || !state.jobId || isActiveStageBRun()) return;
    state.busy = true;
    renderStage();
    try {
      var base = '/repos/' + state.owner + '/' + state.repo + '/contents/jobs/' + encodeURIComponent(state.jobId);
      await gh(base + '/production.json?ref=' + REF + '&_=' + Date.now());
      var musicRef = '';
      try {
        await gh(base + '/music.mp3?ref=' + REF + '&_=' + Date.now());
        musicRef = 'path:jobs/' + state.jobId + '/music.mp3';
      } catch (musicErr) {
        if (musicErr.status !== 404) throw musicErr;
      }
      var dispatchedAt = new Date();
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/workflows/stage-b.yml/dispatches', {
        method: 'POST', body: { ref: REF, inputs: {
          job_id: state.jobId,
          production_ref: 'path:jobs/' + state.jobId + '/production.json',
          music_ref: musicRef
        }}
      });
      state.stageBDispatched = true;
      state.cancellingStageB = false;
      state.stageBRun = { status: 'queued', conclusion: null };
      findWorkflowRun('stage-b.yml', dispatchedAt);
      startPolling();
      renderStage();
    } catch (err) {
      banner('restart-stage-b', 'error', 'Could not restart Stage B: ' + err.message);
      handleGlobalError(err, 'restart-stage-b');
    } finally {
      state.busy = false;
      renderStage();
    }
  }

  async function cancelStageB() {
    if (state.busy || !isActiveStageBRun() || !state.stageBRun.id) return;
    state.busy = true;
    state.cancellingStageB = true;
    renderStage();
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/runs/' +
        encodeURIComponent(state.stageBRun.id) + '/cancel', { method: 'POST' });
      startPolling();
    } catch (err) {
      state.cancellingStageB = false;
      banner('cancel-stage-b', 'error', 'Could not cancel Stage B: ' + err.message);
      handleGlobalError(err, 'cancel-stage-b');
    } finally {
      state.busy = false;
      renderStage();
    }
  }

  /* ----------------------------------------------- complete: scene downloads */

  /**
   * Stage B ships ONE merged, finished video (final.mp4 — voiceover mixed
   * in, subtitles burned in, optional music ducked underneath) both as a
   * direct Release asset and inside the final zip. The complete UI
   * surfaces the direct final.mp4 download plus the zip.
   */
  function renderFinalZip(s) {
    var assets = (s && s.assets) || {};
    var url = assets.final_zip;

    if (!url) {
      el['final-zip-link'].removeAttribute('href');
      el['final-zip-link'].classList.add('is-hidden');
      text(el['final-zip-hint'],
        'status.json reports complete but no `assets.final_zip` URL is present. ' +
        'Check the Release ' + (s.release_tag || '') + ' directly.');
    } else {
      el['final-zip-link'].classList.remove('is-hidden');
      el['final-zip-link'].href = url;
      el['final-zip-link'].onclick = makeDownloadHandler('final_zip', url);
      text(el['final-zip-hint'], fileNameFromUrl(url) || url);
    }

    renderSceneList(s);

    if (s.release_tag) loadReleaseAssets(s.release_tag, true);
  }

  /**
   * Render the direct final.mp4 download row when the Release asset list
   * has been fetched. Stage B ships ONE merged video (voiceover +
   * subtitles + optional music), not per-scene files, so this is a
   * single row — the zip below stays as the fallback/alternative.
   * Re-renders when loadReleaseAssets() refreshes the asset cache.
   */
  function renderSceneList(s) {
    var list = el['scene-list'];
    if (!list) return;
    list.innerHTML = '';

    var finals = [];
    if (state.releaseAssets && s.release_tag && state.releaseAssetsTag === s.release_tag) {
      finals = state.releaseAssets
        .filter(function (a) { return a.name === 'final.mp4'; });
    }

    if (!finals.length) {
      text(el['scene-list-hint'],
        'The direct final.mp4 asset is not listed on the Release (or has not been ' +
        'fetched yet) — the zip below contains the same finished video.');
      show(el['scene-list-hint']);
      return;
    }

    hide(el['scene-list-hint']);
    finals.forEach(function (a) {
      var row = document.createElement('div');
      row.className = 'scene-row';

      var link = document.createElement('a');
      link.className = 'btn btn-ghost btn-small scene-link';
      link.href = a.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Download ' + a.name + ' directly';
      link.onclick = makeDownloadHandler(a.name, a.url);

      var size = document.createElement('span');
      size.className = 'hint scene-size';
      size.textContent = a.size ? fmtBytes(a.size) : '';

      row.appendChild(link);
      row.appendChild(size);
      list.appendChild(row);
    });
  }

  function fmtBytes(n) {
    var bytes = Number(n);
    if (!isFinite(bytes) || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  /* -------------------------------------------------------------- countdown */

  function startCountdown(expiresAtEpoch) {
    stopCountdown();
    show(el['expiry-countdown']);
    var tick = function () {
      var remaining = expiresAtEpoch - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        text(el['expiry-countdown'], 'expired — cleanup may have deleted this job');
        stopCountdown();
        return;
      }
      text(el['expiry-countdown'], 'expires in ' + fmtClock(remaining));
    };
    tick();
    state.countdownTimer = setInterval(tick, 30000);
  }

  function stopCountdown() {
    if (state.countdownTimer) { clearInterval(state.countdownTimer); state.countdownTimer = null; }
    hide(el['expiry-countdown']);
  }

  /* ----------------------------------------------------------------- raw view */

  function openRaw(open) {
    el['raw-toggle'].setAttribute('aria-expanded', open ? 'true' : 'false');
    el['raw-toggle'].textContent = open ? 'Hide raw status.json' : 'Show raw status.json';
    toggleHidden(el['raw-status'], !open);
  }

  el['raw-toggle'].addEventListener('click', function () {
    openRaw(el['raw-toggle'].getAttribute('aria-expanded') !== 'true');
  });

  /* ------------------------------------------------------- start over / resume */

  function startOver() {
    clearActiveJob();
    hide(el['resume-offer']);
    setMsg(el['stage-a-msg'], 'Cleared. Start a new Stage A run above.', null);
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  el['start-over-btn'].addEventListener('click', startOver);
  el['error-start-over'].addEventListener('click', startOver);
  el['complete-ack'].addEventListener('click', startOver);

  el['resume-btn'].addEventListener('click', function () {
    if (state.jobId) startPolling();
  });

  el['resume-offer-btn'].addEventListener('click', function () {
    var id = el['resume-offer-id'].textContent;
    if (!id || id === '—') return;
    hide(el['resume-offer']);
    setActiveJob(id);
    startPolling();
  });

  el['resume-dismiss-btn'].addEventListener('click', function () {
    hide(el['resume-offer']);
  });

  /** Look for the newest non-expired job on GitHub and offer to resume it. */
  async function offerResumeFromRepo() {
    if (!isConfigured() || state.jobId) return;
    var dirs;
    try {
      dirs = await listJobDirs();
    } catch (err) {
      if (err.name === 'AuthError') handleGlobalError(err);
      return;
    }
    if (!dirs.length) return;

    // Job ids are timestamp-prefixed, so lexical descending ≈ newest first.
    var candidates = dirs.sort().reverse().slice(0, 5);
    var nowEpoch = Math.floor(Date.now() / 1000);

    for (var i = 0; i < candidates.length; i++) {
      var id = candidates[i];
      try {
        var file = await gh('/repos/' + state.owner + '/' + state.repo +
          '/contents/jobs/' + encodeURIComponent(id) + '/status.json?ref=' + REF +
          '&_=' + Date.now());
        var doc = JSON.parse(b64decodeUtf8(file.content));
        var expires = Number(doc.expires_at_epoch) || 0;
        if (expires && expires <= nowEpoch) continue; // expired
        text(el['resume-offer-id'], id);
        show(el['resume-offer']);
        return;
      } catch (err) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError') return;
        // no status.json for that folder — try the next one
      }
    }
  }

  /* ------------------------------------------------------------------- boot */

  function boot() {
    loadSettings();
    openSettings(!isConfigured());
    openRaw(false);

    if (!isConfigured()) return;

    probeRepo();
    loadBranding();

    var active = localStorage.getItem(LS.activeJob);
    if (active) {
      setActiveJob(active);
      show(el['status-section']);
      renderStage();
      startPolling();
    } else {
      offerResumeFromRepo();
    }
  }

  // Pause polling while the tab is hidden; resume promptly when it returns.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (state.jobId && state.polling && !state.pollTimer) pollOnce();
  });

  boot();
})();
