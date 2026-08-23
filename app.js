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
    // The id currently loaded into the status panel below the Tasks list.
    // Single-value on purpose: the status panel only ever shows one task at
    // a time (the one the operator is inspecting) but the Tasks list above
    // it keeps EVERY known task addressable.
    activeJob: 'clipforge_active_job_id',
    // Multi-task tracking. Persisted as a compact map of
    //   { "<job-id>": { snapshot: <last known status.json>, seen_at: <epoch> } }
    // so the Tasks list can render the moment the app boots — the repo is
    // still the source of truth and each entry is re-fetched on refresh,
    // but this cache avoids losing awareness of a task between reloads.
    jobsCache: 'clipforge_jobs_v1'
  };

  /* Persistent creator watermark. It follows the same repository-backed
   * settings pattern as job state but lives outside jobs/, so cleanup never
   * deletes the name used by future Stage B renders. */
  var WATERMARK_JSON_PATH = 'branding/creator_watermark.json';

  /* Gemini TTS keys.
   *
   * The RAW keys live only in the GitHub Actions repository secret
   * `GEMINI_API_KEYS`, written from this browser using the Actions Secrets
   * REST API (which requires a libsodium sealed_box-encrypted value).
   * GitHub never returns secret values back over the API, so a companion
   * file `branding/gemini_keys.json` stores ONLY masked fingerprints so the
   * site can list configured keys without ever committing plaintext keys.
   * Both files live outside jobs/ so the hourly cleanup never touches them. */
  var GEMINI_SECRET_NAME = 'GEMINI_API_KEYS';
  var GEMINI_KEYS_META_PATH = 'branding/gemini_keys.json';
  var GEMINI_KEY_MIN_LEN = 20;

  /* Zernio publishing. The API key is stored only as an encrypted Actions
   * secret. All non-secret preferences and provider snapshots are committed
   * outside the expiring jobs/ tree so browser refreshes are harmless. */
  var ZERNIO_SECRET_NAME = 'ZERNIO_API_KEY';
  var ZERNIO_SETTINGS_PATH = 'branding/zernio_settings.json';
  var ZERNIO_ACCOUNTS_PATH = 'branding/zernio_accounts.json';
  var ZERNIO_QUEUE_PATH = 'branding/zernio_queue.json';
  var ZERNIO_WORKFLOW = 'zernio-publish.yml';

  var POLL_FAST = 5000;        // first 10 minutes
  var POLL_SLOW = 15000;       // after 10 minutes
  var POLL_RATELIMIT = 60000;  // after hitting a rate limit
  var POLL_SLOWDOWN_AFTER = 10 * 60 * 1000;
  var RUN_DISCOVERY_TIMEOUT = 30000;

  /* Cadence for pulling live workflow step data from GitHub's Actions Jobs
   * API (/actions/runs/{id}/jobs). That endpoint returns per-step status
   * (queued / in_progress / completed) with started_at / completed_at and is
   * updated by GitHub in near-real-time while a run executes — no workflow
   * changes are required to surface it. Kept slow enough to stay well inside
   * the 5000 req/h authenticated rate limit even with several concurrent
   * background task refreshes. */
  var STEPS_POLL_FAST = 8000;
  var STEPS_POLL_SLOW = 25000;
  var STEPS_POLL_TASKS_LIST = 60000;

  /* Human-readable labels for known workflow steps. Only step names present
   * in .github/workflows/stage-a.yml and stage-b.yml are mapped here — any
   * unmapped step falls back to its raw workflow name (see
   * friendlyStepLabel below), so we never fabricate an activity label: if a
   * workflow gains a new step tomorrow the site simply shows its real name. */
  var STEP_LABEL_MAP = {
    // ---- shared setup ----
    'Checkout':                                                             'Checking out code',
    'Log the exact code revision this run is executing':                    'Logging code revision',
    'Re-attach HEAD to the dispatch branch when the checkout pinned a SHA': 'Re-attaching branch (restart)',
    'Resolve job id':                                                       'Resolving job id',
    'Resolve inputs':                                                       'Resolving inputs',
    'Set up Python':                                                        'Setting up Python',
    'Install ffmpeg':                                                       'Installing ffmpeg',
    'Verify ffmpeg installation':                                           'Verifying ffmpeg',
    'Install Python deps':                                                  'Installing Python dependencies',
    'Verify onnxruntime + faster-whisper VAD stack':                        'Verifying whisper/onnxruntime stack',
    'Restore Chatterbox model cache':                                       'Restoring TTS model cache',

    // ---- Stage A pipeline ----
    'Write initial status (stage_a_running)':                               'Publishing initial status',
    'Commit initial status':                                                'Committing initial status',
    'Download source video (Google Drive link or any direct URL)':          'Downloading source video',
    'Probe duration + build compressed analysis copy (720p, CRF 28)':       'Building compressed analysis copy',
    'Extract 6-frame composite screenshots (one file per 6s window)':       'Extracting screenshot composites',
    'Extract audio for transcription':                                      'Extracting audio',
    'Transcribe with faster-whisper (CPU)':                                 'Transcribing audio',
    'Detect shot boundaries (scene_index.json)':                            'Detecting shot boundaries',
    'Build key-moments shortlist (key_moments.json)':                       'Ranking key moments',
    'Emit dense event composites for high-signal beats':                    'Emitting event composites',
    'Vision-assist disabled — write empty stubs':                           'Vision-assist skipped',
    'Generate 00_READ_THIS_FIRST.txt (analysis prompt)':                    'Generating analysis prompt',
    'Zip screenshots (baseline + event composites)':                        'Zipping screenshots',
    'Stash ORIGINAL video for Stage B (uploaded as private release asset)': 'Stashing original video',
    'Create GitHub Release with analysis bundle':                           'Publishing analysis release',
    'Resolve release asset URLs':                                           'Resolving release asset URLs',
    'Write awaiting_json_upload status':                                    'Publishing awaiting-upload status',
    'Commit final status':                                                  'Committing final status',

    // ---- Stage B pipeline ----
    'Write stage_b_running status':                                         'Publishing Stage B start status',
    'Load release metadata (find original video asset)':                    'Loading release metadata',
    'Download original video from release':                                 'Downloading original video',
    'Resolve production.json':                                              'Resolving production.json',
    'Resolve optional background music':                                    'Resolving background music',
    'Load creator watermark (branding/creator_watermark.json)':             'Loading creator watermark',
    'Generate voiceover (Chatterbox TTS, one clip per cut)':                'Generating voiceover',
    'Cut, reconcile timing, mix voiceover (+music), merge to ONE MP4':      'Cutting, mixing, merging video',
    'Quality enhancement (denoise + color grade + sharpen)':                'Enhancing video quality',
    'Burn cinematic subtitles into the final video':                         'Burning in subtitles',
    'Burn creator watermark into final video':                              'Burning in creator watermark',
    'Validate the merged final MP4 with ffprobe':                           'Validating final MP4',
    'Write social-media metadata.txt from production.json':                 'Writing posting-package metadata',
    'Zip final artifact (finished video + metadata.txt)':                   'Zipping final artifact',
    'Upload final zip + the finished video to the SAME release':            'Uploading final artifact',
    'Resolve final asset URLs':                                             'Resolving final asset URLs',
    'Write complete status':                                                'Publishing complete status',

    // ---- failure / cancellation tail ----
    'On failure, write error status':                                       'Recording error state',
    'Ensure HEAD is on a branch':                                           'Re-attaching branch',
    'Write cancelled status':                                               'Recording cancellation'
  };

  /**
   * Return a display label for a raw workflow step name. Unknown names fall
   * back to the raw name so we never invent an activity string.
   */
  function friendlyStepLabel(rawName) {
    if (!rawName) return '';
    if (Object.prototype.hasOwnProperty.call(STEP_LABEL_MAP, rawName)) {
      return STEP_LABEL_MAP[rawName];
    }
    return rawName;
  }

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
    torrentFile: null,     // an optional Stage A .torrent manifest (File object), one-off for this job only
    torrentVideoCandidates: [], // manifest video entries available for the current torrent
    torrentVideoIndex: null, // explicitly selected 1-based torrent-file index, or null
    torrentSelection: null, // persisted record for the selected awaiting-torrent task
    torrentSelectionLoading: false,
    musicFile: null,       // an optional picked music file (File object), one-off for this job only
    audioLibrary: null,    // [{name, path, size}] fetched from audio-library/ in the repo, or null = not loaded yet
    audioLibrarySelected: null, // path (string) of the library track chosen for this job, or null
    audioLibraryBusy: false,    // true while adding/deleting/listing so double-clicks don't race
    busy: false,
    stageBDispatched: false,
    stageBRun: null,      // matched GitHub Actions Stage B run for this job
    cancellingStageB: false,
    // Multi-task registry (see LS.jobsCache): id -> { snapshot, seen_at }.
    // Independent per-task state. Never overwritten wholesale when a new
    // task starts; new tasks are inserted, existing ones only update their
    // own row.
    tasks: {},
    tasksTimer: null,      // background refresh timer for the Tasks list
    tasksRefreshing: false,
    taskDeleting: {},      // id -> true while a delete is in flight
    watermark: null,       // parsed creator_watermark.json, or null when none is saved
    watermarkSha: null,    // blob sha of creator_watermark.json (needed to update it)

    /* Gemini TTS keys. `geminiKeys` holds the plaintext keys IN MEMORY ONLY
     * for the current browser session so that adding a second key does not
     * require re-typing every prior key. It is populated by keys the user
     * types in this session, never from any GitHub response (GitHub never
     * returns secret values). Persisted state across reloads is: the
     * encrypted secret on GitHub + the masked fingerprints file. */
    geminiKeys: null,          // Array<string> | null (null = unknown this session)
    geminiKeyMeta: [],         // [{fingerprint, added_at_epoch}]
    geminiKeyMetaSha: null,    // blob sha of gemini_keys.json

    /* Zernio state contains no raw API key. `zernioSettings` is persistent
     * repo configuration; `zernioAccounts` is a server-side discovery
     * snapshot, and `zernioQueue` is the durable ClipForge schedule ledger. */
    zernioSettings: null,
    zernioSettingsSha: null,
    zernioAccounts: [],
    zernioAccountsSha: null,
    zernioQueue: { version: 1, provider: 'zernio', items: [] },
    zernioQueueSha: null,
    zernioSecretConfigured: false,
    zernioBusy: false,

    /* -------------------------------------------------------------
     * Per-task workflow-run matching.
     *
     * findWorkflowRun() and discoverJobId() are shared by Stage A and
     * Stage B starts. When two tasks are started close together, two of
     * these loops can be alive at the same time; each needs its OWN
     * matching context so Task A's run can never be adopted as Task B's.
     *
     *   watch: [ { workflowFile, dispatchedAt, jobId, slug, before,
     *              token, settled } ]
     *
     * Each entry is fully self-contained. `jobId` (when known) scopes the
     * run match by the workflow's run-name ("Stage B — <job-id>" /
     * "Stage A — <job-id>" / "Stage A — auto"), which the workflows
     * stamp deterministically from the job_id input. That is the
     * load-bearing mechanism that prevents cross-task run adoption.
     * ------------------------------------------------------------- */
    watch: [],

    /* -----------------------------------------------------------------
     * Live workflow step data, per task.
     *
     * Every entry is keyed by the CORRECT job id — the object at
     * state.workflowSteps[<job-id>] holds only that task's steps. No
     * function ever writes to a key it did not derive from that task's
     * own status.json.workflow_run_id, which is what prevents Task A's
     * steps from ever appearing under Task B.
     *
     * Shape:
     *   {
     *     runId:        <int>,
     *     jobId:        <int>,          // numeric job id inside the run
     *     jobStatus:    'queued'|'in_progress'|'completed'|...,
     *     jobConclusion:<string|null>,
     *     jobName:      <string>,
     *     jobHtmlUrl:   <string>,
     *     steps:        [ { name, status, conclusion, number,
     *                        started_at, completed_at } ],
     *     fetchedAt:    <epoch-ms>
     *   }
     * ----------------------------------------------------------------- */
    workflowSteps: {},
    stepsPollTimer: null,     // per-selection live step timer
    stepsPollStartedAt: 0,
    stepsInFlight: {}         // guard against overlapping fetches per runId
  };

  /* --------------------------------------------------------------- dom lookup */

  function $(id) { return document.getElementById(id); }

  var el = {};
  [
    'repo-indicator', 'banner-stack',
    'settings-section', 'settings-toggle', 'settings-body', 'settings-state', 'settings-form',
    'owner-input', 'repo-input', 'token-input', 'token-reveal', 'settings-save', 'settings-clear', 'settings-msg',
    'stage-a-section', 'stage-a-form', 'video-url-input', 'torrent-file-input', 'torrent-video-field', 'torrent-video-select', 'torrent-video-hint', 'job-slug-input', 'whisper-model-select',
    'torrent-selection-block', 'torrent-selection-message', 'torrent-selection-select', 'start-torrent-stage-a',
    'language-input', 'target-duration-select', 'focus-input', 'start-stage-a', 'stage-a-msg',
    'active-job-bar', 'active-job-id', 'run-link', 'resume-btn', 'start-over-btn',
    'resume-offer', 'resume-offer-id', 'resume-offer-btn', 'resume-dismiss-btn',
    'tasks-section', 'tasks-toggle', 'tasks-body', 'tasks-count', 'tasks-refresh',
    'tasks-refresh-msg', 'tasks-list', 'tasks-empty',
    'status-section', 'stage-badge', 'expiry-countdown', 'stage-line', 'stage-spinner', 'stage-text',
    'progress-block', 'progress-bar-fill', 'progress-text',
    'activity-block', 'activity-current-label', 'activity-recent-list', 'activity-run-link',
    'error-block', 'error-message', 'error-run-link', 'error-start-over',
    'handoff-block', 'release-link-callout', 'release-url-link', 'release-url-text', 'release-tag-line',
    'copy-agent-prompt',
    'cuts-path-hint', 'cuts-file-input', 'start-stage-b', 'cuts-validation', 'music-file-input', 'music-hint',
    'audio-library-list', 'audio-library-empty', 'audio-library-add-input', 'audio-library-add-hint',
    'stage-b-controls', 'stage-b-controls-text', 'restart-stage-b', 'cancel-stage-b',
    'complete-block', 'scene-list', 'scene-list-hint', 'final-zip-link', 'final-zip-hint', 'complete-ack',
    'watermark-form', 'watermark-name-input', 'watermark-save', 'watermark-msg', 'watermark-current',
    'gemini-keys-disclosure', 'gemini-key-form', 'gemini-key-input', 'gemini-key-reveal',
    'gemini-key-add', 'gemini-key-msg', 'gemini-keys-list', 'gemini-keys-empty',
    'zernio-settings-disclosure', 'zernio-settings-state', 'zernio-key-form', 'zernio-key-input', 'zernio-key-reveal', 'zernio-key-save', 'zernio-key-clear', 'zernio-key-msg',
    'zernio-settings-form', 'zernio-enabled-input', 'zernio-auto-publish-input', 'zernio-auto-mode-select', 'zernio-timezone-input', 'zernio-interval-input', 'zernio-time-input', 'zernio-queue-depth-input', 'zernio-start-mode-select', 'zernio-custom-start-field', 'zernio-custom-start-input', 'zernio-refresh-accounts', 'zernio-accounts-hint', 'zernio-accounts-list', 'zernio-accounts-msg', 'zernio-settings-save', 'zernio-settings-msg',
    'zernio-publish-panel', 'zernio-publishing-badge', 'zernio-publish-summary', 'zernio-publish-controls', 'zernio-job-mode-select', 'zernio-job-schedule-field', 'zernio-job-schedule-input', 'zernio-job-targets', 'zernio-publish-job', 'zernio-publish-msg', 'zernio-posts-list',
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
      show(el['tasks-section']);
    } else {
      text(el['settings-state'], 'not configured');
      el['settings-state'].classList.remove('ok');
      text(el['repo-indicator'], 'no repo configured');
      hide(el['stage-a-section']);
      hide(el['tasks-section']);
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
    loadWatermark();
    loadGeminiKeysMeta();
    loadZernioSettings();
    loadAudioLibrary();
    refreshTasksFromRepo({ silent: true });
    startTasksTimer();
    if (!state.jobId) offerResumeFromRepo();
  });

  el['settings-clear'].addEventListener('click', function () {
    localStorage.removeItem(LS.token);
    localStorage.removeItem(LS.owner);
    localStorage.removeItem(LS.repo);
    localStorage.removeItem(LS.activeJob);
    localStorage.removeItem(LS.jobsCache);
    location.reload();
  });

  /* -------------------------------------------------- creator watermark */

  function normalizeWatermarkName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function watermarkErrors(name) {
    var errors = [];
    if (name.length > 64) errors.push('Name must be 64 characters or fewer.');
    return errors;
  }

  function refreshWatermarkValidity() {
    if (!el['watermark-save']) return;
    var name = normalizeWatermarkName(el['watermark-name-input'].value);
    el['watermark-save'].disabled = watermarkErrors(name).length > 0;
  }

  el['watermark-name-input'].addEventListener('input', refreshWatermarkValidity);

  /** Fetch creator_watermark.json. A missing file means no watermark. */
  async function loadWatermark() {
    if (!isConfigured()) return;
    state.watermark = null;
    state.watermarkSha = null;
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + WATERMARK_JSON_PATH + '?ref=' + REF + '&_=' + Date.now());
      var parsed;
      try {
        parsed = JSON.parse(b64decodeUtf8(file.content));
      } catch (parseErr) {
        setMsg(el['watermark-msg'], 'Creator watermark settings are not valid JSON — save again to repair them.', 'bad');
        renderWatermark();
        return;
      }
      state.watermarkSha = file.sha || null;
      state.watermark = { creator_name: normalizeWatermarkName(parsed.creator_name) };
    } catch (err) {
      if (err.status === 404) {
        // Never saved: rendering no watermark is the correct default.
      } else if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
        return;
      } else {
        setMsg(el['watermark-msg'], 'Could not load creator watermark: ' + err.message, 'bad');
      }
    }
    renderWatermark();
    refreshWatermarkValidity();
  }

  function renderWatermark() {
    if (!el['watermark-form']) return;
    var name = state.watermark && state.watermark.creator_name;
    if (name) el['watermark-name-input'].value = name;
    text(el['watermark-current'], name
      ? 'Saved name: ' + name + ' — it will be burned into the next Stage B video.'
      : 'No creator watermark configured. Future Stage B videos will have no watermark.');
  }

  el['watermark-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    saveWatermark();
  });

  async function saveWatermark() {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['watermark-msg'], 'Save your GitHub settings above first.', 'bad');
      return;
    }
    var creatorName = normalizeWatermarkName(el['watermark-name-input'].value);
    var errors = watermarkErrors(creatorName);
    if (errors.length) {
      setMsg(el['watermark-msg'], errors.join(' '), 'bad');
      return;
    }

    state.busy = true;
    el['watermark-save'].disabled = true;
    setMsg(el['watermark-msg'], 'Saving to ' + WATERMARK_JSON_PATH + '…', null);
    try {
      var doc = {
        version: 1,
        creator_name: creatorName,
        updated_at_epoch: Math.floor(Date.now() / 1000)
      };
      await putRepoFile(WATERMARK_JSON_PATH,
        b64encodeUtf8(JSON.stringify(doc, null, 2) + '\n'),
        'clipforge: update creator watermark');
      state.watermark = { creator_name: creatorName };
      renderWatermark();
      setMsg(el['watermark-msg'], creatorName
        ? 'Creator watermark saved. It applies to every future Stage B video.'
        : 'Creator watermark cleared. Future Stage B videos will render no watermark.', 'ok');
    } catch (err) {
      setMsg(el['watermark-msg'], 'Save failed: ' + err.message, 'bad');
      handleGlobalError(err, 'watermark');
    }
    state.busy = false;
    refreshWatermarkValidity();
  }

  /* -------------------------------------------------------- Gemini TTS keys */

  /* SECURITY MODEL
   *   - Raw keys are transmitted only:
   *       (a) from this browser to api.github.com over TLS, as a libsodium
   *           sealed_box ciphertext (never as plaintext);
   *       (b) from the Actions runner to generativelanguage.googleapis.com
   *           in the x-goog-api-key header (see scripts/generate_voiceover.py).
   *   - Raw keys are NEVER persisted to disk in the repo, and NEVER written
   *     to any log, workflow output, artifact, or committed file.
   *   - branding/gemini_keys.json stores ONLY masked fingerprints for display.
   *   - The libsodium bundle is vendored with the site itself
   *   (assets/vendor/libsodium.js + libsodium-wrappers.js, loaded via
   *   <script> tags in index.html BEFORE app.js) so no third-party CDN
   *   is ever contacted; encryption happens
   *     entirely client-side before the ciphertext leaves the browser. */

  var _sodiumReady = null;
  function sodiumReady() {
    if (_sodiumReady) return _sodiumReady;
    _sodiumReady = new Promise(function (resolve, reject) {
      var start = Date.now();
      (function poll() {
        if (typeof window !== 'undefined' && window.sodium && window.sodium.ready) {
          window.sodium.ready.then(function () { resolve(window.sodium); }, reject);
          return;
        }
        if (Date.now() - start > 15000) {
          reject(new Error('libsodium did not initialize. The bundled files assets/vendor/libsodium.js and assets/vendor/libsodium-wrappers.js must be reachable and loaded before app.js in index.html.'));
          return;
        }
        setTimeout(poll, 100);
      })();
    });
    return _sodiumReady;
  }

  /** Log-safe fingerprint: first 4 + ellipsis + last 4. Matches the format
   *  scripts/generate_voiceover.py prints on the runner. */
  function geminiFingerprint(key) {
    var s = String(key || '');
    if (s.length <= 8) return '\u2026';
    return s.slice(0, 4) + '\u2026' + s.slice(-4);
  }

  function validateGeminiKey(key) {
    var s = String(key || '').trim();
    if (!s) return 'Enter a Gemini API key.';
    if (s.length < GEMINI_KEY_MIN_LEN) return 'That key looks too short to be a Gemini API key.';
    if (/\s/.test(s)) return 'API keys must not contain whitespace.';
    return null;
  }

  async function loadGeminiKeysMeta() {
    if (!isConfigured()) return;
    state.geminiKeyMeta = [];
    state.geminiKeyMetaSha = null;
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + GEMINI_KEYS_META_PATH + '?ref=' + REF + '&_=' + Date.now());
      var parsed;
      try {
        parsed = JSON.parse(b64decodeUtf8(file.content));
      } catch (e) {
        setMsg(el['gemini-key-msg'], GEMINI_KEYS_META_PATH + ' is not valid JSON \u2014 add a key to repair it.', 'bad');
        renderGeminiKeys();
        return;
      }
      state.geminiKeyMetaSha = file.sha || null;
      var list = Array.isArray(parsed.keys) ? parsed.keys : [];
      state.geminiKeyMeta = list.filter(function (e) { return e && e.fingerprint; })
        .map(function (e) {
          return {
            fingerprint: String(e.fingerprint),
            added_at_epoch: Number(e.added_at_epoch) || 0
          };
        });
    } catch (err) {
      if (err.status === 404) {
        // Never saved yet.
      } else if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
        return;
      } else {
        setMsg(el['gemini-key-msg'], 'Could not load key list: ' + err.message, 'bad');
      }
    }
    renderGeminiKeys();
  }

  function renderGeminiKeys() {
    var list = el['gemini-keys-list'];
    var empty = el['gemini-keys-empty'];
    if (!list || !empty) return;
    list.innerHTML = '';
    if (!state.geminiKeyMeta.length) {
      show(empty);
      return;
    }
    hide(empty);
    state.geminiKeyMeta.forEach(function (entry) {
      var li = document.createElement('li');
      li.className = 'gemini-key-row';
      var fp = document.createElement('span');
      fp.className = 'gemini-key-fp';
      fp.textContent = entry.fingerprint;
      var added = document.createElement('span');
      added.className = 'gemini-key-added';
      added.textContent = entry.added_at_epoch
        ? 'added ' + new Date(entry.added_at_epoch * 1000).toLocaleDateString()
        : '';
      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn-small';
      del.textContent = 'Delete';
      del.addEventListener('click', function () { deleteGeminiKey(entry.fingerprint); });
      li.appendChild(fp);
      li.appendChild(added);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  async function encryptForActionsSecret(rawValue, publicKeyB64) {
    var sodium = await sodiumReady();
    var binkey = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
    var binsec = sodium.from_string(rawValue);
    var enc = sodium.crypto_box_seal(binsec, binkey);
    return sodium.to_base64(enc, sodium.base64_variants.ORIGINAL);
  }

  async function persistGeminiKeys(rawKeys, metaEntries) {
    var pk = await gh('/repos/' + state.owner + '/' + state.repo +
      '/actions/secrets/public-key');
    if (!pk || !pk.key || !pk.key_id) {
      throw new Error('GitHub did not return an Actions public key for this repo.');
    }
    if (rawKeys.length === 0) {
      try {
        await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/secrets/' + encodeURIComponent(GEMINI_SECRET_NAME),
          { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    } else {
      var joined = rawKeys.join('\n');
      var encrypted = await encryptForActionsSecret(joined, pk.key);
      await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/secrets/' + encodeURIComponent(GEMINI_SECRET_NAME), {
          method: 'PUT',
          body: { encrypted_value: encrypted, key_id: pk.key_id }
        });
    }

    var doc = {
      version: 1,
      note: 'Masked fingerprints only. Raw keys live in the GEMINI_API_KEYS repo secret and are never committed.',
      keys: metaEntries,
      updated_at_epoch: Math.floor(Date.now() / 1000)
    };
    await putRepoFile(GEMINI_KEYS_META_PATH,
      b64encodeUtf8(JSON.stringify(doc, null, 2) + '\n'),
      'clipforge: update Gemini API key metadata (masked fingerprints only)');
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + GEMINI_KEYS_META_PATH + '?ref=' + REF + '&_=' + Date.now());
      state.geminiKeyMetaSha = file.sha || null;
    } catch (_) { /* best effort */ }
  }

  async function addGeminiKey() {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['gemini-key-msg'], 'Save your GitHub settings above first.', 'bad');
      return;
    }
    var raw = (el['gemini-key-input'].value || '').trim();
    var problem = validateGeminiKey(raw);
    if (problem) {
      setMsg(el['gemini-key-msg'], problem, 'bad');
      return;
    }
    var fp = geminiFingerprint(raw);
    if (state.geminiKeyMeta.some(function (e) { return e.fingerprint === fp; })) {
      setMsg(el['gemini-key-msg'], 'A key with that fingerprint is already configured.', 'bad');
      return;
    }

    state.busy = true;
    el['gemini-key-add'].disabled = true;
    setMsg(el['gemini-key-msg'], 'Encrypting and uploading\u2026', null);

    try {
      // GitHub secrets are opaque replacements, not append operations. If a
      // prior session's keys exist but this browser doesn't hold them, we
      // must warn before overwriting.
      var raws, metaEntries;
      var knownFps = (state.geminiKeys || []).map(geminiFingerprint);
      var haveAllKnown = state.geminiKeyMeta.every(function (e) {
        return knownFps.indexOf(e.fingerprint) !== -1;
      });

      if (state.geminiKeyMeta.length === 0) {
        raws = [raw];
        metaEntries = [{ fingerprint: fp, added_at_epoch: Math.floor(Date.now() / 1000) }];
      } else if (haveAllKnown && state.geminiKeys && state.geminiKeys.length) {
        raws = state.geminiKeys.slice();
        raws.push(raw);
        metaEntries = state.geminiKeyMeta.slice();
        metaEntries.push({ fingerprint: fp, added_at_epoch: Math.floor(Date.now() / 1000) });
      } else {
        var confirmed = window.confirm(
          'Adding this key from a fresh browser session will OVERWRITE the existing GEMINI_API_KEYS secret with only this new key.\n\n' +
          'GitHub never returns secret values, so the site cannot combine the new key with the previously-saved keys unless you enter them again in this session.\n\n' +
          'Existing fingerprints that will be discarded:\n  \u2022 ' +
          state.geminiKeyMeta.map(function (e) { return e.fingerprint; }).join('\n  \u2022 ') +
          '\n\nProceed?'
        );
        if (!confirmed) {
          setMsg(el['gemini-key-msg'], 'Cancelled.', null);
          state.busy = false;
          el['gemini-key-add'].disabled = false;
          return;
        }
        raws = [raw];
        metaEntries = [{ fingerprint: fp, added_at_epoch: Math.floor(Date.now() / 1000) }];
      }

      await persistGeminiKeys(raws, metaEntries);
      state.geminiKeys = raws;
      state.geminiKeyMeta = metaEntries;
      el['gemini-key-input'].value = '';
      renderGeminiKeys();
      setMsg(el['gemini-key-msg'], 'Key added. Stage B will use it on the next voiceover run.', 'ok');
    } catch (err) {
      setMsg(el['gemini-key-msg'], 'Add failed: ' + err.message, 'bad');
      handleGlobalError(err, 'gemini-key');
    }

    state.busy = false;
    el['gemini-key-add'].disabled = false;
  }

  async function deleteGeminiKey(fingerprint) {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['gemini-key-msg'], 'Save your GitHub settings above first.', 'bad');
      return;
    }

    var known = state.geminiKeys || [];
    var knownFps = known.map(geminiFingerprint);
    var isTargetKnown = knownFps.indexOf(fingerprint) !== -1;
    var otherUnknown = state.geminiKeyMeta.filter(function (e) {
      return e.fingerprint !== fingerprint && knownFps.indexOf(e.fingerprint) === -1;
    });

    if (otherUnknown.length > 0) {
      var ok = window.confirm(
        'Deleting ' + fingerprint + ' now will REBUILD the GEMINI_API_KEYS secret from the keys this session still knows. ' +
        'GitHub never returns secret values, so the following keys will also be removed from the secret unless you re-enter them first:\n  \u2022 ' +
        otherUnknown.map(function (e) { return e.fingerprint; }).join('\n  \u2022 ') +
        '\n\nProceed?'
      );
      if (!ok) return;
    }

    state.busy = true;
    setMsg(el['gemini-key-msg'], 'Deleting ' + fingerprint + '\u2026', null);

    try {
      var newRaws = known.filter(function (k) { return geminiFingerprint(k) !== fingerprint; });
      var newMeta;
      if (otherUnknown.length > 0) {
        newMeta = state.geminiKeyMeta.filter(function (e) {
          return e.fingerprint !== fingerprint && knownFps.indexOf(e.fingerprint) !== -1;
        });
      } else {
        newMeta = state.geminiKeyMeta.filter(function (e) { return e.fingerprint !== fingerprint; });
      }

      await persistGeminiKeys(newRaws, newMeta);
      state.geminiKeys = newRaws;
      state.geminiKeyMeta = newMeta;
      renderGeminiKeys();
      setMsg(el['gemini-key-msg'],
        isTargetKnown
          ? 'Deleted ' + fingerprint + '.'
          : 'Deleted ' + fingerprint + ' from the fingerprint list.',
        'ok');
    } catch (err) {
      setMsg(el['gemini-key-msg'], 'Delete failed: ' + err.message, 'bad');
      handleGlobalError(err, 'gemini-key');
    }

    state.busy = false;
  }

  if (el['gemini-key-reveal']) {
    el['gemini-key-reveal'].addEventListener('click', function () {
      var revealed = el['gemini-key-input'].type === 'text';
      el['gemini-key-input'].type = revealed ? 'password' : 'text';
      el['gemini-key-reveal'].textContent = revealed ? 'Show' : 'Hide';
      el['gemini-key-reveal'].setAttribute('aria-pressed', revealed ? 'false' : 'true');
    });
  }
  if (el['gemini-key-form']) {
    el['gemini-key-form'].addEventListener('submit', function (e) {
      e.preventDefault();
      addGeminiKey();
    });
  }

  /* ------------------------------------------------------ Zernio publishing */

  function defaultZernioSettings() {
    return {
      version: 1,
      enabled: false,
      auto_publish: false,
      automatic_mode: 'smart_schedule',
      target_accounts: { tiktok: [], youtube: [] },
      smart_schedule: {
        timezone: 'UTC', interval_days: 1, preferred_time: '19:30',
        queue_depth: 4, start_mode: 'next_available', custom_start: ''
      }
    };
  }

  function defaultZernioQueue() { return { version: 1, provider: 'zernio', items: [] }; }

  function zernioFingerprint(value) {
    var raw = String(value || '').trim();
    return raw.length > 8 ? raw.slice(0, 4) + '\u2026' + raw.slice(-4) : '\u2026';
  }

  function zernioSettingsOrDefault() {
    var base = defaultZernioSettings();
    var current = state.zernioSettings || {};
    var smart = current.smart_schedule || {};
    base.enabled = current.enabled === true;
    base.auto_publish = current.auto_publish === true;
    base.automatic_mode = current.automatic_mode === 'publish_now' ? 'publish_now' : 'smart_schedule';
    base.target_accounts = {
      tiktok: Array.isArray(current.target_accounts && current.target_accounts.tiktok) ? current.target_accounts.tiktok.map(String) : [],
      youtube: Array.isArray(current.target_accounts && current.target_accounts.youtube) ? current.target_accounts.youtube.map(String) : []
    };
    base.smart_schedule.timezone = String(smart.timezone || 'UTC');
    base.smart_schedule.interval_days = Number(smart.interval_days) || 1;
    base.smart_schedule.preferred_time = /^\d\d:\d\d$/.test(String(smart.preferred_time || '')) ? String(smart.preferred_time) : '19:30';
    base.smart_schedule.queue_depth = Number(smart.queue_depth) || 4;
    base.smart_schedule.start_mode = smart.start_mode === 'custom' ? 'custom' : 'next_available';
    base.smart_schedule.custom_start = String(smart.custom_start || '');
    return base;
  }

  async function loadRepoJson(path, missingValue) {
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo + '/contents/' + path + '?ref=' + REF + '&_=' + Date.now());
      return { value: JSON.parse(b64decodeUtf8(file.content)), sha: file.sha || null };
    } catch (err) {
      if (err.status === 404) return { value: missingValue, sha: null };
      throw err;
    }
  }

  async function probeZernioSecret() {
    if (!isConfigured()) return;
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/secrets/' + encodeURIComponent(ZERNIO_SECRET_NAME));
      state.zernioSecretConfigured = true;
    } catch (err) {
      if (err.status === 404) state.zernioSecretConfigured = false;
      else if (err.name === 'AuthError' || err.name === 'RateLimitError') handleGlobalError(err);
    }
    renderZernioSettings();
  }

  async function loadZernioSettings() {
    if (!isConfigured()) return;
    try {
      var pair = await loadRepoJson(ZERNIO_SETTINGS_PATH, defaultZernioSettings());
      state.zernioSettingsSha = pair.sha;
      state.zernioSettings = pair.value && typeof pair.value === 'object' ? pair.value : defaultZernioSettings();
      var accounts = await loadRepoJson(ZERNIO_ACCOUNTS_PATH, { accounts: [] });
      state.zernioAccountsSha = accounts.sha;
      state.zernioAccounts = Array.isArray(accounts.value && accounts.value.accounts) ? accounts.value.accounts : [];
      var queue = await loadRepoJson(ZERNIO_QUEUE_PATH, defaultZernioQueue());
      state.zernioQueueSha = queue.sha;
      state.zernioQueue = queue.value && typeof queue.value === 'object' ? queue.value : defaultZernioQueue();
      if (!Array.isArray(state.zernioQueue.items)) state.zernioQueue.items = [];
    } catch (err) {
      setMsg(el['zernio-settings-msg'], 'Could not load Zernio settings: ' + err.message, 'bad');
      if (err.name === 'AuthError' || err.name === 'RateLimitError') handleGlobalError(err, 'zernio-settings');
    }
    renderZernioSettings();
    if (state.status) renderZernioPublishing(state.status);
    probeZernioSecret();
  }

  function selectedZernioAccounts() {
    var selected = { tiktok: [], youtube: [] };
    (state.zernioAccounts || []).forEach(function (account) {
      if (!account || (account.platform !== 'tiktok' && account.platform !== 'youtube')) return;
      var id = String(account.id || account._id || '');
      var checkbox = $('zernio-account-' + id);
      if (checkbox && checkbox.checked) selected[account.platform].push(id);
    });
    return selected;
  }

  function renderZernioAccounts() {
    var list = el['zernio-accounts-list'];
    if (!list) return;
    list.innerHTML = '';
    var settings = zernioSettingsOrDefault();
    var accounts = state.zernioAccounts || [];
    if (!accounts.length) {
      text(el['zernio-accounts-hint'], state.zernioSecretConfigured
        ? 'No TikTok or YouTube accounts are in the saved snapshot. Use Refresh to discover connected accounts.'
        : 'Save a Zernio API key, then refresh accounts from the provider.');
      return;
    }
    text(el['zernio-accounts-hint'], 'Select active accounts. A disconnected or disabled account is shown but cannot be selected.');
    accounts.forEach(function (account) {
      if (!account || (account.platform !== 'tiktok' && account.platform !== 'youtube')) return;
      var id = String(account.id || account._id || '');
      if (!id) return;
      var usable = account.isActive !== false && account.enabled !== false && account.needsReconnection !== true;
      var row = document.createElement('label');
      row.className = 'zernio-account-row' + (usable ? '' : ' is-unavailable');
      var check = document.createElement('input');
      check.type = 'checkbox';
      check.id = 'zernio-account-' + id;
      check.disabled = !usable;
      check.checked = usable && settings.target_accounts[account.platform].indexOf(id) !== -1;
      var title = document.createElement('span');
      title.className = 'zernio-account-title';
      title.textContent = account.platform === 'tiktok' ? 'TikTok' : 'YouTube';
      title.textContent += ' · ' + (account.displayName || account.username || id);
      var meta = document.createElement('span');
      meta.className = 'zernio-account-meta';
      meta.textContent = usable ? 'connected' : (account.needsReconnection ? 'reconnect required' : 'unavailable');
      row.appendChild(check); row.appendChild(title); row.appendChild(meta); list.appendChild(row);
    });
  }

  function renderZernioSettings() {
    if (!el['zernio-settings-form']) return;
    var settings = zernioSettingsOrDefault();
    el['zernio-enabled-input'].checked = settings.enabled;
    el['zernio-auto-publish-input'].checked = settings.auto_publish;
    el['zernio-auto-mode-select'].value = settings.automatic_mode;
    el['zernio-timezone-input'].value = settings.smart_schedule.timezone;
    el['zernio-interval-input'].value = String(settings.smart_schedule.interval_days);
    el['zernio-time-input'].value = settings.smart_schedule.preferred_time;
    el['zernio-queue-depth-input'].value = String(settings.smart_schedule.queue_depth);
    el['zernio-start-mode-select'].value = settings.smart_schedule.start_mode;
    el['zernio-custom-start-input'].value = settings.smart_schedule.custom_start;
    toggleHidden(el['zernio-custom-start-field'], settings.smart_schedule.start_mode !== 'custom');
    text(el['zernio-settings-state'], state.zernioSecretConfigured ? 'Key secured' : 'Key required');
    renderZernioAccounts();
  }

  function zernioSettingsFromForm() {
    var timezone = el['zernio-timezone-input'].value.trim() || 'UTC';
    // Browser-side validation is deliberately conservative. The server-side
    // scheduler validates again with Python's IANA zoneinfo database.
    if (!/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$|^UTC$/.test(timezone)) {
      throw new Error('Enter an IANA timezone such as Europe/London or America/New_York.');
    }
    var interval = Number(el['zernio-interval-input'].value);
    var depth = Number(el['zernio-queue-depth-input'].value);
    var preferred = el['zernio-time-input'].value;
    if (!Number.isInteger(interval) || interval < 1 || interval > 365) throw new Error('Cadence must be a whole number from 1 to 365 days.');
    if (!Number.isInteger(depth) || depth < 1 || depth > 100) throw new Error('Queue depth must be a whole number from 1 to 100.');
    if (!/^\d\d:\d\d$/.test(preferred)) throw new Error('Choose a preferred posting time.');
    var startMode = el['zernio-start-mode-select'].value === 'custom' ? 'custom' : 'next_available';
    var customStart = el['zernio-custom-start-input'].value || '';
    if (startMode === 'custom' && !customStart) throw new Error('Choose the first local smart-schedule slot.');
    return {
      version: 1,
      enabled: !!el['zernio-enabled-input'].checked,
      auto_publish: !!el['zernio-auto-publish-input'].checked,
      automatic_mode: el['zernio-auto-mode-select'].value === 'publish_now' ? 'publish_now' : 'smart_schedule',
      target_accounts: selectedZernioAccounts(),
      smart_schedule: {
        timezone: timezone, interval_days: interval, preferred_time: preferred,
        queue_depth: depth, start_mode: startMode, custom_start: customStart
      },
      updated_at_epoch: Math.floor(Date.now() / 1000)
    };
  }

  async function putZernioSecret(rawKey) {
    var pk = await gh('/repos/' + state.owner + '/' + state.repo + '/actions/secrets/public-key');
    if (!pk || !pk.key || !pk.key_id) throw new Error('GitHub did not return the repository Actions public key.');
    var encrypted = await encryptForActionsSecret(rawKey, pk.key);
    await gh('/repos/' + state.owner + '/' + state.repo + '/actions/secrets/' + encodeURIComponent(ZERNIO_SECRET_NAME), {
      method: 'PUT', body: { encrypted_value: encrypted, key_id: pk.key_id }
    });
    state.zernioSecretConfigured = true;
  }

  async function saveZernioKey() {
    if (state.zernioBusy || !isConfigured()) { setMsg(el['zernio-key-msg'], 'Save GitHub settings first.', 'bad'); return; }
    var key = el['zernio-key-input'].value.trim();
    if (key.length < 20 || /\s/.test(key)) { setMsg(el['zernio-key-msg'], 'Enter a valid Zernio API key with no whitespace.', 'bad'); return; }
    state.zernioBusy = true; el['zernio-key-save'].disabled = true;
    setMsg(el['zernio-key-msg'], 'Encrypting and storing ' + zernioFingerprint(key) + '…', null);
    try {
      await putZernioSecret(key);
      el['zernio-key-input'].value = '';
      setMsg(el['zernio-key-msg'], 'API key secured as a repository Actions secret.', 'ok');
    } catch (err) {
      setMsg(el['zernio-key-msg'], 'Could not save key: ' + err.message, 'bad');
      handleGlobalError(err, 'zernio-key');
    }
    state.zernioBusy = false; el['zernio-key-save'].disabled = false; renderZernioSettings();
  }

  async function clearZernioKey() {
    if (state.zernioBusy || !isConfigured()) return;
    if (!window.confirm('Remove the ZERNIO_API_KEY repository secret? Existing publishing records remain, but new publishing requests will fail until a new key is saved.')) return;
    state.zernioBusy = true;
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/secrets/' + encodeURIComponent(ZERNIO_SECRET_NAME), { method: 'DELETE' });
      state.zernioSecretConfigured = false;
      setMsg(el['zernio-key-msg'], 'Stored Zernio API key removed.', 'ok');
    } catch (err) {
      if (err.status === 404) { state.zernioSecretConfigured = false; setMsg(el['zernio-key-msg'], 'No Zernio API key was stored.', 'ok'); }
      else { setMsg(el['zernio-key-msg'], 'Could not remove key: ' + err.message, 'bad'); handleGlobalError(err, 'zernio-key'); }
    }
    state.zernioBusy = false; renderZernioSettings();
  }

  async function saveZernioSettings() {
    if (state.zernioBusy || !isConfigured()) { setMsg(el['zernio-settings-msg'], 'Save GitHub settings first.', 'bad'); return; }
    var doc;
    try { doc = zernioSettingsFromForm(); }
    catch (err) { setMsg(el['zernio-settings-msg'], err.message, 'bad'); return; }
    state.zernioBusy = true; el['zernio-settings-save'].disabled = true;
    try {
      await putRepoFile(ZERNIO_SETTINGS_PATH, b64encodeUtf8(JSON.stringify(doc, null, 2) + '\n'), 'clipforge: update Zernio publishing settings');
      state.zernioSettings = doc;
      setMsg(el['zernio-settings-msg'], 'Publishing preferences saved. Stage B remains independent of publishing.', 'ok');
      renderZernioSettings();
    } catch (err) {
      setMsg(el['zernio-settings-msg'], 'Could not save publishing preferences: ' + err.message, 'bad');
      handleGlobalError(err, 'zernio-settings');
    }
    state.zernioBusy = false; el['zernio-settings-save'].disabled = false;
  }

  async function refreshZernioAccounts() {
    if (state.zernioBusy || !isConfigured()) return;
    if (!state.zernioSecretConfigured) { setMsg(el['zernio-accounts-msg'], 'Save a Zernio API key first.', 'bad'); return; }
    state.zernioBusy = true; el['zernio-refresh-accounts'].disabled = true;
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/workflows/' + ZERNIO_WORKFLOW + '/dispatches', {
        method: 'POST', body: { ref: REF, inputs: { action: 'discover' } }
      });
      setMsg(el['zernio-accounts-msg'], 'Account refresh dispatched. It will save the provider snapshot to branding/zernio_accounts.json.', 'ok');
    } catch (err) {
      setMsg(el['zernio-accounts-msg'], 'Could not refresh accounts: ' + err.message, 'bad');
      handleGlobalError(err, 'zernio-accounts');
    }
    state.zernioBusy = false; el['zernio-refresh-accounts'].disabled = false;
  }

  function zernioTargetsForJob() {
    var settings = zernioSettingsOrDefault();
    var targets = [];
    ['tiktok', 'youtube'].forEach(function (platform) {
      var ids = settings.target_accounts[platform] || [];
      if (ids.length) targets.push({ platform: platform, account_ids: ids });
    });
    return targets;
  }

  function zernioStatusMeta(status) {
    var value = String(status || 'not_requested').toLowerCase();
    if (value === 'published') return { label: 'published', cls: 'stage-done' };
    if (value === 'scheduled') return { label: 'scheduled', cls: 'stage-running' };
    if (value === 'publishing' || value === 'requested') return { label: 'publishing', cls: 'stage-running' };
    if (value === 'partial') return { label: 'partial', cls: 'stage-await' };
    if (value === 'failed' || value === 'error') return { label: 'failed', cls: 'stage-error' };
    if (value === 'cancelled') return { label: 'cancelled', cls: 'stage-cancelled' };
    return { label: 'not requested', cls: 'stage-unknown' };
  }

  function renderZernioPosts(publishing) {
    var list = el['zernio-posts-list'];
    if (!list) return;
    list.innerHTML = '';
    var posts = publishing && Array.isArray(publishing.posts) ? publishing.posts : [];
    posts.forEach(function (post) {
      var row = document.createElement('div'); row.className = 'zernio-post-row';
      var title = document.createElement('span'); title.className = 'zernio-post-title';
      title.textContent = (post.platform || 'Zernio') + ' · ' + (post.status || 'unknown');
      var meta = document.createElement('span'); meta.className = 'zernio-post-meta';
      meta.textContent = post.scheduled_for ? String(post.scheduled_for) : (post.post_id || 'no post id');
      row.appendChild(title); row.appendChild(meta);
      (post.platforms || []).forEach(function (target) {
        if (!target || !target.platformPostUrl) return;
        var link = document.createElement('a'); link.href = target.platformPostUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open live post ↗'; row.appendChild(link);
      });
      if (post.error) { var err = document.createElement('span'); err.className = 'zernio-post-meta'; err.textContent = post.error; row.appendChild(err); }
      var current = String(post.status || '').toLowerCase();
      if (post.post_id && (current === 'failed' || current === 'partial')) {
        var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-secondary btn-sm'; retry.textContent = 'Retry failed target';
        retry.addEventListener('click', function () { dispatchZernioExistingAction(post.post_id, 'retry'); }); row.appendChild(retry);
      }
      if (post.post_id && current === 'scheduled') {
        var now = document.createElement('button'); now.type = 'button'; now.className = 'btn btn-secondary btn-sm'; now.textContent = 'Publish now';
        now.addEventListener('click', function () { dispatchZernioExistingAction(post.post_id, 'update', 'publish_now', ''); }); row.appendChild(now);
        var reschedule = document.createElement('button'); reschedule.type = 'button'; reschedule.className = 'btn btn-quiet btn-sm'; reschedule.textContent = 'Reschedule';
        reschedule.addEventListener('click', function () {
          var value = window.prompt('Local scheduled time (YYYY-MM-DDTHH:MM):', post.scheduled_for || '');
          if (value) dispatchZernioExistingAction(post.post_id, 'update', 'manual_schedule', value);
        }); row.appendChild(reschedule);
        var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-danger-ghost btn-sm'; cancel.textContent = 'Cancel';
        cancel.addEventListener('click', function () { if (window.confirm('Cancel this scheduled Zernio post?')) dispatchZernioExistingAction(post.post_id, 'cancel'); }); row.appendChild(cancel);
      }
      list.appendChild(row);
    });
  }

  function aggregateZernioStatus(publishing) {
    var posts = publishing && Array.isArray(publishing.posts) ? publishing.posts : [];
    var statuses = posts.map(function (post) { return String(post && post.status || 'unknown').toLowerCase(); });
    if (!statuses.length) return String(publishing && publishing.status || 'not_requested').toLowerCase();
    if (statuses.some(function (value) { return value === 'requested' || value === 'publishing'; })) return 'publishing';
    if (statuses.some(function (value) { return value === 'scheduled'; })) return 'scheduled';
    if (statuses.every(function (value) { return value === 'published'; })) return 'published';
    if (statuses.some(function (value) { return value === 'published'; }) && statuses.some(function (value) {
      return ['failed', 'cancelled', 'error', 'not_requested'].indexOf(value) !== -1;
    })) return 'partial';
    if (statuses.every(function (value) { return ['failed', 'cancelled', 'error', 'not_requested'].indexOf(value) !== -1; })) return 'failed';
    return statuses.some(function (value) { return value === 'partial'; }) ? 'partial' : statuses[0];
  }

  function renderZernioPublishing(status) {
    var panel = el['zernio-publish-panel'];
    if (!panel) return;
    var settings = zernioSettingsOrDefault();
    if (!settings.enabled) { hide(panel); return; }
    show(panel);
    var publishing = status && status.publishing && typeof status.publishing === 'object' ? status.publishing : null;
    var aggregateStatus = aggregateZernioStatus(publishing);
    var meta = zernioStatusMeta(aggregateStatus);
    text(el['zernio-publishing-badge'], meta.label);
    el['zernio-publishing-badge'].className = 'stage-badge ' + meta.cls;
    var targets = zernioTargetsForJob();
    text(el['zernio-job-targets'], targets.length
      ? 'Targets: ' + targets.map(function (target) { return target.platform + ' (' + target.account_ids.length + ')'; }).join(', ') + '.'
      : 'No active TikTok or YouTube accounts are selected in Zernio settings.');
    var posts = publishing && Array.isArray(publishing.posts) ? publishing.posts : [];
    var active = ['publishing', 'requested'].indexOf(aggregateStatus) !== -1;
    var repeatBlocked = posts.length > 0 && ['scheduled', 'published', 'failed', 'partial', 'cancelled'].indexOf(aggregateStatus) !== -1;
    // GitHub does not return Actions-secret values and some otherwise-valid
    // fine-grained tokens cannot inspect secret metadata. Never disable a
    // legitimate publish solely because that opaque probe is unavailable.
    // The workflow remains the definitive, server-side ZERNIO_API_KEY check.
    el['zernio-publish-job'].disabled = state.zernioBusy || active || repeatBlocked || !targets.length;
    el['zernio-publish-job'].title = repeatBlocked
      ? 'This job already has a Zernio publishing attempt. Use Retry failed target for an individual failed platform.'
      : '';
    var outcome = posts.map(function (post) {
      return String(post.platform || 'platform') + ' · ' + String(post.status || 'unknown');
    }).join(', ');
    var summary = repeatBlocked
      ? 'Already processed by Zernio: ' + outcome + '. Use Retry failed target for an individual failed platform.'
      : publishing
      ? 'Provider state: ' + aggregateStatus + (publishing.scheduled_for ? ' · ' + publishing.scheduled_for : '')
      : (state.zernioSecretConfigured
        ? 'Choose a mode and submit a native Zernio publishing request.'
        : 'The Zernio key could not be confirmed from this browser. Submit to perform the secure server-side check; save the key in Repository settings if the workflow reports it missing.');
    text(el['zernio-publish-summary'], summary);
    renderZernioPosts(publishing);
    toggleHidden(el['zernio-job-schedule-field'], el['zernio-job-mode-select'].value !== 'manual_schedule');
  }

  function zernioRequestIdForCurrentJob() {
    var publishing = state.status && state.status.publishing;
    var prior = publishing && String(publishing.status || '').toLowerCase() === 'error'
      ? String(publishing.idempotency_key || '') : '';
    // Reusing the persisted key is the safe recovery path after a failed run:
    // current main code can retry the original job/artifact without creating a
    // second provider post. New publishing requests receive a new key.
    if (/^[A-Za-z0-9._:-]{8,200}$/.test(prior)) return prior;
    return 'clipforge-' + state.jobId + '-' + Date.now().toString(36);
  }

  async function dispatchZernioPublish() {
    if (!state.jobId || state.zernioBusy) return;
    var targets = zernioTargetsForJob();
    if (!targets.length) { setMsg(el['zernio-publish-msg'], 'Select at least one active TikTok or YouTube account in Zernio settings.', 'bad'); return; }
    var settings = zernioSettingsOrDefault();
    var mode = el['zernio-job-mode-select'].value;
    var scheduled = el['zernio-job-schedule-input'].value || '';
    if (mode === 'manual_schedule' && !scheduled) { setMsg(el['zernio-publish-msg'], 'Choose a local scheduled time.', 'bad'); return; }
    state.zernioBusy = true; renderZernioPublishing(state.status);
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/workflows/' + ZERNIO_WORKFLOW + '/dispatches', {
        method: 'POST', body: { ref: REF, inputs: {
          action: 'publish', job_id: state.jobId, mode: mode, scheduled_for: scheduled,
          timezone: settings.smart_schedule.timezone, targets_json: JSON.stringify(targets),
          request_id: zernioRequestIdForCurrentJob()
        }}
      });
      setMsg(el['zernio-publish-msg'], 'Publishing request dispatched. Stage B remains complete while Zernio processes it.', 'ok');
    } catch (err) {
      setMsg(el['zernio-publish-msg'], 'Could not submit publishing request: ' + err.message, 'bad'); handleGlobalError(err, 'zernio-publish');
    }
    state.zernioBusy = false; renderZernioPublishing(state.status);
  }

  async function dispatchZernioExistingAction(postId, action, mode, scheduled) {
    if (!state.jobId || state.zernioBusy) return;
    var settings = zernioSettingsOrDefault();
    state.zernioBusy = true;
    try {
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/workflows/' + ZERNIO_WORKFLOW + '/dispatches', {
        method: 'POST', body: { ref: REF, inputs: {
          action: action, job_id: state.jobId, post_id: postId, mode: mode || '', scheduled_for: scheduled || '', timezone: settings.smart_schedule.timezone
        }}
      });
      setMsg(el['zernio-publish-msg'], 'Zernio ' + action + ' request dispatched. Refresh the task status after the workflow completes.', 'ok');
    } catch (err) {
      setMsg(el['zernio-publish-msg'], 'Could not dispatch Zernio ' + action + ': ' + err.message, 'bad'); handleGlobalError(err, 'zernio-publish');
    }
    state.zernioBusy = false; renderZernioPublishing(state.status);
  }

  if (el['zernio-key-reveal']) el['zernio-key-reveal'].addEventListener('click', function () {
    var revealed = el['zernio-key-input'].type === 'text';
    el['zernio-key-input'].type = revealed ? 'password' : 'text';
    el['zernio-key-reveal'].textContent = revealed ? 'Show' : 'Hide';
    el['zernio-key-reveal'].setAttribute('aria-pressed', revealed ? 'false' : 'true');
  });
  if (el['zernio-key-form']) el['zernio-key-form'].addEventListener('submit', function (e) { e.preventDefault(); saveZernioKey(); });
  if (el['zernio-key-clear']) el['zernio-key-clear'].addEventListener('click', clearZernioKey);
  if (el['zernio-settings-form']) el['zernio-settings-form'].addEventListener('submit', function (e) { e.preventDefault(); saveZernioSettings(); });
  if (el['zernio-start-mode-select']) el['zernio-start-mode-select'].addEventListener('change', function () { toggleHidden(el['zernio-custom-start-field'], this.value !== 'custom'); });
  if (el['zernio-refresh-accounts']) el['zernio-refresh-accounts'].addEventListener('click', refreshZernioAccounts);
  if (el['zernio-job-mode-select']) el['zernio-job-mode-select'].addEventListener('change', function () { toggleHidden(el['zernio-job-schedule-field'], this.value !== 'manual_schedule'); });
  if (el['zernio-publish-job']) el['zernio-publish-job'].addEventListener('click', dispatchZernioPublish);

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

  /* ---------------------------------------------------------------- watch */

  /**
   * Push a new watch context (one per dispatch). Returns the entry so the
   * caller can read it back after matching settles. Entries are independent:
   * matching Task A never reads or mutates Task B's entry.
   */
  function pushWatch(opts) {
    var w = {
      workflowFile: opts.workflowFile,
      dispatchedAt: opts.dispatchedAt,
      jobId: opts.jobId || null,         // known slug (stage-b / slug stage-a)
      slug: opts.slug || '',             // raw slug input (stage-a only)
      before: opts.before || null,       // folder snapshot (blank-slug stage-a)
      token: Math.random().toString(36).slice(2),
      settled: false
    };
    state.watch.push(w);
    return w;
  }

  /** Remove a watch entry once its run/job has been resolved. */
  function settleWatch(w) {
    if (!w) return;
    w.settled = true;
    var i = state.watch.indexOf(w);
    if (i !== -1) state.watch.splice(i, 1);
  }

  /* ------------------------------------------------------------- stage A flow */

  el['stage-a-form'].addEventListener('submit', function (e) {
    e.preventDefault();
    el['start-stage-a'].disabled = true;
    startStageA();
  });

  var MAX_TORRENT_BYTES = 1024 * 1024;

  function torrentSizeLabel(bytes) {
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function resetTorrentChoice() {
    state.torrentFile = null;
    state.torrentVideoCandidates = [];
    state.torrentVideoIndex = null;
    if (el['torrent-video-select']) {
      el['torrent-video-select'].innerHTML = '<option value="">Choose a video from the torrent…</option>';
      el['torrent-video-select'].disabled = true;
    }
    text(el['torrent-video-hint'], '');
    hide(el['torrent-video-field']);
  }

  function renderTorrentCandidates(metadata) {
    var candidates = metadata.video_candidates || [];
    state.torrentVideoCandidates = candidates;
    state.torrentVideoIndex = candidates.length === 1 ? candidates[0].index : null;
    var select = el['torrent-video-select'];
    select.innerHTML = '<option value="">Choose a video from the torrent…</option>';
    candidates.forEach(function (candidate) {
      var option = document.createElement('option');
      option.value = String(candidate.index);
      option.textContent = candidate.path + ' — ' + torrentSizeLabel(candidate.length);
      select.appendChild(option);
    });
    select.disabled = false;
    if (state.torrentVideoIndex !== null) select.value = String(state.torrentVideoIndex);
    text(el['torrent-video-hint'], candidates.length === 1
      ? 'One supported video found; it has been selected automatically.'
      : candidates.length + ' video files found. Choose the exact episode, clip, or feature to analyze.');
    show(el['torrent-video-field']);
  }

  if (el['torrent-file-input']) {
    el['torrent-file-input'].addEventListener('change', async function () {
      var file = el['torrent-file-input'].files && el['torrent-file-input'].files[0];
      resetTorrentChoice();
      if (!file) return;
      if (!/\.torrent$/i.test(file.name) || file.size <= 0 || file.size > MAX_TORRENT_BYTES) {
        el['torrent-file-input'].value = '';
        setMsg(el['stage-a-msg'], 'Choose a non-empty .torrent file no larger than 1 MB.', 'bad');
        return;
      }
      if (!window.ClipForgeTorrent) {
        el['torrent-file-input'].value = '';
        setMsg(el['stage-a-msg'], 'Torrent metadata support did not load. Refresh and try again.', 'bad');
        return;
      }
      state.torrentFile = file;
      try {
        var metadata = window.ClipForgeTorrent.inspect(new Uint8Array(await file.arrayBuffer()));
        if (state.torrentFile !== file) return; // a newer selection won the race
        renderTorrentCandidates(metadata);
        // A torrent is an alternative source, never an attachment to a URL job.
        if (el['video-url-input']) el['video-url-input'].value = '';
        setMsg(el['stage-a-msg'], 'Torrent ready: ' + metadata.name + '.', 'ok');
      } catch (torrentErr) {
        if (state.torrentFile !== file) return;
        resetTorrentChoice();
        el['torrent-file-input'].value = '';
        setMsg(el['stage-a-msg'], torrentErr.message, 'bad');
      }
    });
  }

  if (el['torrent-video-select']) {
    el['torrent-video-select'].addEventListener('change', function () {
      var index = Number(el['torrent-video-select'].value);
      var found = state.torrentVideoCandidates.some(function (candidate) { return candidate.index === index; });
      state.torrentVideoIndex = found ? index : null;
      if (found) setMsg(el['stage-a-msg'], 'Torrent video selected. It will be the only payload retrieved.', 'ok');
    });
  }

  function torrentSelectionPaths(jobId) {
    var base = 'jobs/' + jobId + '/';
    return {
      torrent: base + 'source.torrent',
      selection: base + 'torrent-selection.json',
      status: base + 'status.json'
    };
  }

  function torrentSelectionStatus(jobId, selection) {
    var now = Math.floor(Date.now() / 1000);
    return {
      job_id: jobId,
      stage: 'awaiting_torrent_selection',
      message: 'Choose a video from this torrent to begin Stage A.',
      release_tag: 'clipforge-' + jobId,
      release_url: '',
      assets: {},
      created_at_epoch: now,
      updated_at_epoch: now,
      expires_at_epoch: now + 12 * 3600,
      extra: {
        torrent_selection_path: torrentSelectionPaths(jobId).selection,
        torrent_name: selection.torrent_name,
        torrent_candidate_count: selection.video_candidates.length
      }
    };
  }

  async function createPendingTorrentSelection(jobId, torrentFile, inputs) {
    var candidates = state.torrentVideoCandidates.slice();
    if (!candidates.length) throw new Error('This torrent has no supported video files.');
    var paths = torrentSelectionPaths(jobId);
    var selection = {
      version: 1,
      job_id: jobId,
      torrent_name: torrentFile.name,
      video_candidates: candidates,
      selected_index: state.torrentVideoCandidates.some(function (candidate) {
        return candidate.index === state.torrentVideoIndex;
      }) ? state.torrentVideoIndex : null,
      stage_a_inputs: {
        whisper_model: inputs.whisper_model,
        language: inputs.language,
        target_duration_seconds: inputs.target_duration_seconds,
        focus: inputs.focus
      }
    };
    var status = torrentSelectionStatus(jobId, selection);
    await putRepoFile(paths.torrent, await b64encodeFile(torrentFile),
      'clipforge: upload source.torrent for job ' + jobId);
    await putRepoFile(paths.selection, b64encodeUtf8(JSON.stringify(selection, null, 2) + '\n'),
      'clipforge: save torrent video candidates for job ' + jobId);
    await putRepoFile(paths.status, b64encodeUtf8(JSON.stringify(status, null, 2) + '\n'),
      'clipforge: await torrent video selection for job ' + jobId);
    return { selection: selection, status: status };
  }

  async function loadPendingTorrentSelection(status) {
    if (!status || status.stage !== 'awaiting_torrent_selection' || !state.jobId ||
        state.torrentSelectionLoading) return;
    var path = status.extra && status.extra.torrent_selection_path;
    if (!path) return;
    state.torrentSelectionLoading = true;
    try {
      var file = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + path + '?ref=' + REF + '&_=' + Date.now());
      var selection = JSON.parse(b64decodeUtf8(file.content));
      if (selection.job_id === state.jobId && Array.isArray(selection.video_candidates)) {
        state.torrentSelection = selection;
      }
    } catch (err) {
      if (err.name === 'AuthError' || err.name === 'RateLimitError') handleGlobalError(err);
      else banner('status', 'warn', 'Could not load torrent video candidates: ' + err.message);
    } finally {
      state.torrentSelectionLoading = false;
      renderStage();
    }
  }

  async function dispatchPendingTorrentSelection() {
    if (state.busy || !state.jobId || !state.torrentSelection) return;
    var select = el['torrent-selection-select'];
    var index = Number(select && select.value);
    var candidates = state.torrentSelection.video_candidates || [];
    var selected = candidates.filter(function (candidate) { return candidate.index === index; })[0];
    if (!selected) {
      text(el['torrent-selection-message'], 'Choose one listed video before starting Stage A.');
      return;
    }

    state.busy = true;
    el['start-torrent-stage-a'].disabled = true;
    text(el['torrent-selection-message'], 'Saving your selected video and starting Stage A…');
    try {
      var paths = torrentSelectionPaths(state.jobId);
      state.torrentSelection.selected_index = selected.index;
      await putRepoFile(paths.selection,
        b64encodeUtf8(JSON.stringify(state.torrentSelection, null, 2) + '\n'),
        'clipforge: select torrent video for job ' + state.jobId);

      var settings = state.torrentSelection.stage_a_inputs || {};
      var inputs = {
        video_url: 'path:' + paths.torrent,
        torrent_file_index: String(selected.index),
        job_id: state.jobId,
        whisper_model: settings.whisper_model || 'base',
        language: settings.language || 'auto',
        target_duration_seconds: String(settings.target_duration_seconds || '120'),
        focus: settings.focus || ''
      };
      var dispatchedAt = new Date();
      await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/workflows/stage-a.yml/dispatches', {
        method: 'POST', body: { ref: REF, inputs: inputs }
      });
      text(el['torrent-selection-message'], 'Stage A dispatched for “' + selected.path + '”.');
      var watch = pushWatch({
        workflowFile: 'stage-a.yml', dispatchedAt: dispatchedAt,
        jobId: state.jobId, slug: state.jobId, before: []
      });
      findWorkflowRun(watch);
      startPolling();
    } catch (err) {
      if (err.name === 'AuthError' || err.name === 'RateLimitError') handleGlobalError(err);
      else text(el['torrent-selection-message'], 'Could not start Stage A: ' + err.message);
    } finally {
      state.busy = false;
      renderStage();
    }
  }

  if (el['start-torrent-stage-a']) {
    el['start-torrent-stage-a'].addEventListener('click', function () {
      this.disabled = true;
      dispatchPendingTorrentSelection();
    });
  }

  async function startStageA() {
    if (state.busy) return;
    if (!isConfigured()) {
      setMsg(el['stage-a-msg'], 'Save your settings first.', 'bad');
      openSettings(true);
      return;
    }

    var videoUrl = el['video-url-input'].value.trim();
    var torrentFile = state.torrentFile;
    var isMagnetLink = /^magnet:\?/i.test(videoUrl);
    if (!videoUrl && !torrentFile) {
      setMsg(el['stage-a-msg'], 'Provide a video URL or choose a .torrent file.', 'bad');
      return;
    }
    if (videoUrl && torrentFile) {
      setMsg(el['stage-a-msg'], 'Use either a video URL or a torrent file, not both.', 'bad');
      return;
    }
    var slug = el['job-slug-input'].value.trim();
    if ((torrentFile || isMagnetLink) && !slug) {
      slug = (torrentFile ? 'torrent-' : 'magnet-') + Date.now();
      el['job-slug-input'].value = slug;
    }
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
      focus: focus,
      torrent_file_index: torrentFile ? String(state.torrentVideoIndex) : ''
    };

    // Torrent ingestion deliberately has a persistent selection substage.
    // Uploading the manifest creates the job but never dispatches Stage A;
    // the selected video is saved and confirmed later from the task detail
    // panel, even after a browser reload.
    if (torrentFile) {
      state.busy = true;
      el['start-stage-a'].disabled = true;
      setMsg(el['stage-a-msg'], 'Saving torrent candidates for later selection…', null);
      try {
        var pending = await createPendingTorrentSelection(slug, torrentFile, inputs);
        state.torrentSelection = pending.selection;
        state.status = pending.status;
        state.stageBDispatched = false;
        state.releaseAssets = null;
        state.releaseAssetsTag = null;
        setActiveJob(slug);
        recordTaskSnapshot(slug, pending.status);
        renderStage();
        renderTasksList();
        startPolling();
        setMsg(el['stage-a-msg'], 'Torrent saved. Confirm the video in the selected task.', 'ok');
      } catch (torrentErr) {
        if (torrentErr.name === 'AuthError' || torrentErr.name === 'RateLimitError') {
          handleGlobalError(torrentErr);
        } else {
          setMsg(el['stage-a-msg'], 'Torrent setup failed: ' + torrentErr.message, 'bad');
        }
      } finally {
        state.busy = false;
        el['start-stage-a'].disabled = false;
      }
      return;
    }

    state.busy = true;
    el['start-stage-a'].disabled = true;
    setMsg(el['stage-a-msg'], isMagnetLink
      ? 'Retrieving magnet metadata and preparing video selection…'
      : 'Dispatching stage-a.yml…', null);
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

    // Register a self-contained watch context for THIS dispatch so its
    // run matching / folder discovery stays scoped to this task even when
    // another task is started a moment later (multi-task isolation).
    var watch = pushWatch({
      workflowFile: 'stage-a.yml',
      dispatchedAt: dispatchedAt,
      jobId: slug || null,
      slug: slug,
      before: before
    });

    // If the user supplied a slug, we can start polling that path right away.
    if (slug) setActiveJob(slug);

    state.busy = false;
    el['start-stage-a'].disabled = false;

    findWorkflowRun(watch);
    if (!slug) discoverJobId(watch);
    else startPolling();
  }

  /**
   * Locate the run created by ONE specific dispatch.
   *
   * Multi-task isolation: the match is scoped by the run's display title,
   * which both workflows stamp deterministically from the job_id input
   * (`run-name: Stage B — <job-id>` / `Stage A — <job-id>` / `Stage A —
   * auto`). Two Stage B dispatches for different tasks therefore cannot
   * cross-adopt each other's runs, and a Stage A dispatch with a slug can
   * no longer grab the newest Stage A run belonging to a different task.
   * Only a blank-slug Stage A dispatch (title "Stage A — auto") falls back
   * to "newest matching title after dispatch time"; the parallel
   * discoverJobId() watches folders so the task itself is still adopted
   * correctly.
   *
   * The result is only applied to the live selection (state.runId /
   * state.stageBRun) when this watch's task is still the selected one — a
   * late-arriving match for a previously-dispatched task can never
   * overwrite the run the operator is now watching.
   */
  async function findWorkflowRun(watch) {
    var workflowFile = watch.workflowFile;
    var dispatchedAt = watch.dispatchedAt;
    var deadline = Date.now() + RUN_DISCOVERY_TIMEOUT;
    var cushion = dispatchedAt.getTime() - 60000; // clock-skew cushion

    // Expected run title for THIS task's dispatch.
    var expectedTitle = null;
    if (workflowFile === 'stage-b.yml') {
      expectedTitle = 'Stage B — ' + (watch.jobId || state.jobId || '');
    } else if (workflowFile === 'stage-a.yml') {
      expectedTitle = 'Stage A — ' + (watch.slug || 'auto');
    }

    while (Date.now() < deadline) {
      try {
        var data = await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/workflows/' + workflowFile +
          '/runs?event=workflow_dispatch&per_page=15');
        var runs = (data && data.workflow_runs) || [];
        var candidates = runs.filter(function (r) {
          return new Date(r.created_at).getTime() >= cushion;
        });
        if (expectedTitle) {
          candidates = candidates.filter(function (r) {
            return String(r.display_title || '') === expectedTitle;
          });
        }
        var match = candidates
          .sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })[0];

        if (match) {
          settleWatch(watch);
          // Only adopt the run into the live selection when this dispatch's
          // task is still what the operator is looking at.
          var stillSelected = !watch.jobId || watch.jobId === state.jobId ||
            (workflowFile === 'stage-a.yml' && !watch.slug);
          if (stillSelected) {
            state.runId = match.id;
            state.runHtmlUrl = match.html_url;
            if (workflowFile === 'stage-b.yml') state.stageBRun = match;
            el['run-link'].href = match.html_url;
            show(el['run-link']);
            watchRunForEarlyFailure(match.id, watch);
          }
          return;
        }
      } catch (err) {
        if (err.name === 'AuthError' || err.name === 'RateLimitError') {
          handleGlobalError(err);
          settleWatch(watch);
          return;
        }
      }
      await sleep(3000);
    }

    settleWatch(watch);
    banner('dispatch', 'warn',
      'Workflow may not be enabled. Check `.github/workflows/' + workflowFile +
      '` in the repo Actions tab.');
  }

  /**
   * Watch the run only to catch early workflow failures. status.json remains
   * authoritative for stage state. Scoped to the specific watch entry so a
   * task switch (which clears state.runId) cleanly detaches this watcher.
   */
  async function watchRunForEarlyFailure(runId, watch) {
    while (state.runId === runId) {
      await sleep(15000);
      if (state.runId !== runId) return;
      // If the operator switched to a different task, stop watching.
      if (watch && watch.jobId && state.jobId !== watch.jobId) return;
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

  /**
   * Poll jobs/ until a folder that was not in this dispatch's `before`
   * snapshot shows up. Scoped to its own watch entry: each blank-slug
   * Stage A dispatch carries its own pre-dispatch folder snapshot, so two
   * concurrent dispatches compare against DIFFERENT baselines and cannot
   * both adopt the same new folder.
   */
  async function discoverJobId(watch) {
    var before = (watch && watch.before) || [];
    var known = {};
    before.forEach(function (n) { known[n] = true; });
    var deadline = Date.now() + 15 * 60 * 1000;

    text(el['stage-text'], 'Dispatched. Waiting for Stage A to create the job folder…');
    show(el['stage-spinner']);

    while (Date.now() < deadline) {
      // A folder was already adopted for this dispatch (or the operator
      // switched tasks) — stop discovering.
      if (!watch || watch.settled) return;
      if (state.jobId && watch.workflowFile === 'stage-a.yml' && !watch.slug) {
        // state.jobId now points at this (or another) task; settle.
        settleWatch(watch);
        return;
      }
      await sleep(5000);
      var now;
      try {
        now = await listJobDirs();
      } catch (err) {
        handleGlobalError(err);
        if (err.name === 'AuthError') { settleWatch(watch); return; }
        continue;
      }
      var fresh = now.filter(function (n) { return !known[n]; }).sort();
      if (fresh.length) {
        settleWatch(watch);
        // Only adopt into the live selection if the operator has not
        // already selected something else meanwhile.
        if (!state.jobId) {
          setActiveJob(fresh[fresh.length - 1]);
          startPolling();
        } else {
          // Another task got selected first; still register the new folder
          // in the task list so it is tracked independently.
          ensureTaskEntry(fresh[fresh.length - 1]);
          renderTasksList();
        }
        return;
      }
    }

    settleWatch(watch);
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
    // Ensure the task registry has an entry the moment we adopt an id (even
    // before status.json has landed) so the Tasks list surfaces it.
    ensureTaskEntry(jobId);
    renderTasksList();
  }

  /**
   * Clear ONLY the currently-selected task from the detail panel. The
   * task itself is NOT touched — it stays in the Tasks list, still has its
   * own status.json / release / expiration in the repo, and can be
   * re-selected at any moment. Independent per-task lifetimes require
   * that "deselect" and "delete" be two different actions; this is the
   * former. See deleteTask() for the latter.
   */
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
    renderTasksList();
  }

  /* ------------------------------------------------------ multi-task registry */

  /** Persist the in-memory task registry to localStorage. */
  function persistTasks() {
    try {
      localStorage.setItem(LS.jobsCache, JSON.stringify(state.tasks || {}));
    } catch (e) {
      // quota exhausted or storage disabled — not fatal, the repo is the
      // source of truth on next refresh.
    }
  }

  /** Load the task registry from localStorage. Silently discards corrupt data. */
  function loadTasksFromStorage() {
    try {
      var raw = localStorage.getItem(LS.jobsCache);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        state.tasks = parsed;
      }
    } catch (e) {
      state.tasks = {};
    }
  }

  /**
   * Insert a minimal placeholder entry for a job id we have just adopted
   * (e.g. right after Stage A dispatch, before status.json exists). No-ops
   * when a fuller entry is already present.
   */
  function ensureTaskEntry(jobId) {
    if (!jobId) return;
    if (!state.tasks[jobId]) {
      state.tasks[jobId] = {
        snapshot: null,
        seen_at: Math.floor(Date.now() / 1000)
      };
      persistTasks();
    }
  }

  /** Record the latest status.json snapshot for a task. */
  function recordTaskSnapshot(jobId, snapshot) {
    if (!jobId || !snapshot) return;
    state.tasks[jobId] = {
      snapshot: snapshot,
      seen_at: Math.floor(Date.now() / 1000)
    };
    persistTasks();
  }

  /** Drop a task from the registry (does not touch the repo). */
  function forgetTask(jobId) {
    if (!jobId) return;
    if (state.tasks[jobId]) {
      delete state.tasks[jobId];
      persistTasks();
    }
  }

  /** Sorted list of task ids we currently know about, newest-first. */
  function taskIdsSorted() {
    var ids = Object.keys(state.tasks || {});
    return ids.sort(function (a, b) {
      var ea = state.tasks[a] && state.tasks[a].snapshot;
      var eb = state.tasks[b] && state.tasks[b].snapshot;
      var ca = (ea && Number(ea.created_at_epoch)) || 0;
      var cb = (eb && Number(eb.created_at_epoch)) || 0;
      if (cb !== ca) return cb - ca;
      // Fallback: ids are timestamp-prefixed — lexical descending
      // approximates newest-first when created_at is not yet known.
      return a < b ? 1 : a > b ? -1 : 0;
    });
  }

  /** True when the task is past its expiration. */
  function isTaskExpired(entry) {
    var snap = entry && entry.snapshot;
    if (!snap) return false;
    var exp = Number(snap.expires_at_epoch) || 0;
    if (!exp) return false;
    return exp <= Math.floor(Date.now() / 1000);
  }

  var TASK_STAGE_CLASS = {
    queued:                      'is-running',
    awaiting_torrent_selection:  'is-await',
    stage_a_running:             'is-running',
    awaiting_json_upload:        'is-await',
    stage_b_queued:      'is-running',
    stage_b_running:     'is-running',
    stage_b_cancelling:  'is-running',
    cancelled:           'is-cancelled',
    complete:            'is-done',
    error:               'is-error'
  };

  var TASK_STAGE_BADGE = {
    queued:                     { label: 'queued', cls: 'stage-running' },
    awaiting_torrent_selection: { label: 'choose torrent video', cls: 'stage-await' },
    stage_a_running:            { label: 'stage a', cls: 'stage-running' },
    awaiting_json_upload:       { label: 'awaiting production.json', cls: 'stage-await' },
    stage_b_queued:      { label: 'stage b queued', cls: 'stage-running' },
    stage_b_running:     { label: 'stage b', cls: 'stage-running' },
    stage_b_cancelling:  { label: 'cancelling', cls: 'stage-cancelling' },
    cancelled:           { label: 'cancelled', cls: 'stage-cancelled' },
    complete:            { label: 'complete', cls: 'stage-done' },
    error:               { label: 'error', cls: 'stage-error' }
  };

  /**
   * Render the multi-task list. Each row is fully self-contained —
   * selecting one task never mutates another row's state, and clicking
   * Delete on one card only wires up removal of that specific task.
   */
  function renderTasksList() {
    var listEl = el['tasks-list'];
    var emptyEl = el['tasks-empty'];
    var countEl = el['tasks-count'];
    if (!listEl) return;

    var ids = taskIdsSorted();

    if (countEl) {
      var n = ids.length;
      text(countEl, n + ' task' + (n === 1 ? '' : 's'));
      if (n > 0) countEl.classList.add('ok'); else countEl.classList.remove('ok');
    }

    if (isConfigured()) show(el['tasks-section']); else hide(el['tasks-section']);

    listEl.innerHTML = '';
    if (!ids.length) { show(emptyEl); return; }
    hide(emptyEl);

    // Keep live work visually separate from terminal records. This is only a
    // presentation grouping: task state, sorting, selection and actions remain
    // exactly the same as before.
    var activeIds = [];
    var historyIds = [];
    ids.forEach(function (id) {
      var entry = state.tasks[id] || {};
      var stage = entry.snapshot && entry.snapshot.stage;
      var terminal = stage === 'complete' || stage === 'error' || stage === 'cancelled';
      if (!terminal && !isTaskExpired(entry)) activeIds.push(id);
      else historyIds.push(id);
    });

    function appendGroup(label, groupIds) {
      if (!groupIds.length) return;
      var group = document.createElement('section');
      group.className = 'task-group';
      group.setAttribute('aria-label', label);

      var heading = document.createElement('div');
      heading.className = 'task-group-head';
      heading.appendChild(document.createTextNode(label));
      var count = document.createElement('span');
      count.className = 'task-group-count';
      count.textContent = String(groupIds.length);
      heading.appendChild(count);
      group.appendChild(heading);

      groupIds.forEach(function (id) { group.appendChild(buildTaskCard(id)); });
      listEl.appendChild(group);
    }

    appendGroup('Active tasks', activeIds);
    appendGroup('Task history', historyIds);
  }

  function buildTaskCard(jobId) {
    var entry = state.tasks[jobId] || {};
    var snap = entry.snapshot || null;
    var stage = snap && snap.stage;
    var stageMeta = TASK_STAGE_BADGE[stage] || { label: stage ? 'unknown' : 'pending', cls: 'stage-unknown' };
    var extraClass = TASK_STAGE_CLASS[stage] || '';
    var isSelected = state.jobId === jobId;
    var expired = isTaskExpired(entry);

    var card = document.createElement('div');
    card.className = 'task-card ' + extraClass + (isSelected ? ' is-selected' : '');
    card.setAttribute('role', 'listitem');
    card.setAttribute('data-job-id', jobId);

    // ---- main column
    var main = document.createElement('div');
    main.className = 'task-main';

    var head = document.createElement('div');
    head.className = 'task-head';

    var idEl = document.createElement('code');
    idEl.className = 'task-id';
    idEl.textContent = jobId;
    head.appendChild(idEl);

    var badge = document.createElement('span');
    badge.className = 'stage-badge ' + stageMeta.cls;
    badge.textContent = stageMeta.label;
    head.appendChild(badge);

    if (isSelected) {
      var selBadge = document.createElement('span');
      selBadge.className = 'panel-badge ok';
      selBadge.textContent = 'selected';
      head.appendChild(selBadge);
    }
    if (expired) {
      var expBadge = document.createElement('span');
      expBadge.className = 'stage-badge stage-error';
      expBadge.textContent = 'expired';
      head.appendChild(expBadge);
    }

    main.appendChild(head);

    var title = snap && snap.extra && snap.extra.title;
    if (title) {
      var titleEl = document.createElement('div');
      titleEl.className = 'task-title';
      titleEl.textContent = title;
      main.appendChild(titleEl);
    }

    // ---- live per-task progress (this task's OWN step data only).
    // state.workflowSteps[jobId] is written exclusively by
    // fetchWorkflowStepsFor(jobId, <that task's run id>) — one task's bar
    // can therefore never show another task's progress.
    var taskActive = stage === 'queued' || stage === 'stage_a_running' ||
                     stage === 'stage_b_queued' || stage === 'stage_b_running' ||
                     stage === 'stage_b_cancelling';
    var cardSteps = state.workflowSteps[jobId] || null;
    var cardProg = deriveProgress(cardSteps);
    if (taskActive || cardProg.percent !== null || stage === 'complete') {
      var tprog = document.createElement('div');
      tprog.className = 'task-progress';
      var bar = document.createElement('div');
      bar.className = 'task-progress-bar';
      var fill = document.createElement('div');
      fill.className = 'task-progress-fill';
      var capText = '';
      if (cardProg.percent !== null && cardProg.totalSteps > 0) {
        fill.style.width = cardProg.percent + '%';
        capText = cardProg.completedSteps + '/' + cardProg.totalSteps + ' steps';
        if (cardProg.currentStep) capText += ' · ' + friendlyStepLabel(cardProg.currentStep.name);
        if (cardProg.phase === 'completed') fill.classList.add('is-done');
      } else if (stage === 'complete') {
        fill.style.width = '100%';
        fill.classList.add('is-done');
        capText = 'complete';
      } else if (taskActive) {
        // Stage-ladder fallback until live step data arrives — a real
        // lifecycle position, never a fabricated precise percentage.
        var lidx = STAGE_LADDER.indexOf(stage);
        if (lidx >= 0) {
          fill.style.width = Math.round(((lidx + 1) / STAGE_LADDER.length) * 100) + '%';
          var lm = TASK_STAGE_BADGE[stage];
          capText = (lm ? lm.label : stage) + ' — waiting for live step data…';
        } else {
          fill.style.width = '100%';
          fill.classList.add('is-indeterminate');
        }
      }
      bar.appendChild(fill);
      tprog.appendChild(bar);
      var cap = document.createElement('div');
      cap.className = 'task-progress-text';
      cap.textContent = capText;
      tprog.appendChild(cap);
      main.appendChild(tprog);
    }

    var meta = document.createElement('div');
    meta.className = 'task-meta';

    function metaRow(labelStr, valueStr, extraCls) {
      var span = document.createElement('span');
      var strong = document.createElement('strong');
      strong.textContent = labelStr + ': ';
      span.appendChild(strong);
      span.appendChild(document.createTextNode(valueStr));
      if (extraCls) span.className = extraCls;
      meta.appendChild(span);
    }

    if (snap && snap.created_at_epoch) {
      metaRow('created', fmtEpoch(snap.created_at_epoch));
    } else {
      metaRow('created', fmtEpoch(entry.seen_at || 0));
    }
    if (snap && snap.updated_at_epoch) {
      metaRow('updated', fmtEpoch(snap.updated_at_epoch));
    }

    // Elapsed = updated - created for terminal states, else now - created.
    var createdEp = snap && Number(snap.created_at_epoch) || 0;
    if (createdEp) {
      var end;
      var isTerminal = stage === 'complete' || stage === 'error' || stage === 'cancelled';
      if (isTerminal && snap && Number(snap.updated_at_epoch)) {
        end = Number(snap.updated_at_epoch);
      } else {
        end = Math.floor(Date.now() / 1000);
      }
      metaRow(isTerminal ? 'elapsed' : 'running for', fmtDuration(end - createdEp));
    }

    if (snap && Number(snap.expires_at_epoch)) {
      var remaining = Number(snap.expires_at_epoch) - Math.floor(Date.now() / 1000);
      var cls = '';
      var valueStr;
      if (remaining <= 0) {
        valueStr = 'expired';
        cls = 'task-expiry-gone';
      } else if (remaining <= 3600) {
        valueStr = 'in ' + fmtDuration(remaining);
        cls = 'task-expiry-warn';
      } else {
        valueStr = 'in ' + fmtClock(remaining);
      }
      metaRow('expires', valueStr, cls);
    }

    if (snap && snap.message) {
      var msgSpan = document.createElement('span');
      var strong2 = document.createElement('strong');
      strong2.textContent = 'stage: ';
      msgSpan.appendChild(strong2);
      msgSpan.appendChild(document.createTextNode(snap.message));
      meta.appendChild(msgSpan);
    }

    var runUrl = snap && snap.extra && snap.extra.workflow_run_url;
    if (runUrl) {
      var link = document.createElement('a');
      link.href = runUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'link-out';
      link.textContent = 'View workflow run ↗';
      meta.appendChild(link);
    }
    var relUrl = snap && snap.release_url;
    if (relUrl) {
      var relLink = document.createElement('a');
      relLink.href = relUrl;
      relLink.target = '_blank';
      relLink.rel = 'noopener noreferrer';
      relLink.className = 'link-out';
      relLink.textContent = 'Open Release ↗';
      meta.appendChild(relLink);
    }

    main.appendChild(meta);
    card.appendChild(main);

    // ---- actions column
    var actions = document.createElement('div');
    actions.className = 'task-actions';

    var selectBtn = document.createElement('button');
    selectBtn.type = 'button';
    selectBtn.className = 'btn btn-small ' + (isSelected ? 'btn-ghost' : 'btn-accent');
    selectBtn.textContent = isSelected ? 'Selected' : 'Select';
    selectBtn.disabled = isSelected || !!state.taskDeleting[jobId];
    selectBtn.addEventListener('click', function () { selectTask(jobId); });
    actions.appendChild(selectBtn);

    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger-ghost btn-small';
    delBtn.textContent = state.taskDeleting[jobId] ? 'Deleting…' : 'Delete';
    delBtn.disabled = !!state.taskDeleting[jobId] || (isSelected && state.busy);
    delBtn.addEventListener('click', function () { deleteTask(jobId); });
    actions.appendChild(delBtn);

    card.appendChild(actions);
    return card;
  }

  /**
   * Load an already-known task into the detail panel below. This is the
   * multi-task equivalent of what `setActiveJob` used to do implicitly on
   * dispatch — but here it can happen against ANY task without touching
   * the others.
   */
  function selectTask(jobId) {
    if (!jobId) return;
    if (state.jobId === jobId) return;
    // Fully reset the DETAIL panel's per-selection state — do NOT touch
    // the task registry. Other tasks keep their snapshots, their
    // GitHub-side status, and their expirations.
    stopPolling();
    stopCountdown();
    state.status = null;
    state.runId = null;
    state.runHtmlUrl = null;
    state.releaseAssets = null;
    state.releaseAssetsTag = null;
    state.validatedCuts = null;
    state.stageBDispatched = false;
    state.stageBRun = null;
    state.cancellingStageB = false;
    hide(el['run-link']);
    text(el['raw-status-code'], '(nothing yet)');
    el['cuts-file-input'].value = '';
    if (el['music-file-input']) el['music-file-input'].value = '';
    state.musicFile = null;
    if (el['music-hint']) el['music-hint'].textContent = '';
    el['start-stage-b'].disabled = true;
    hide(el['cuts-validation']);
    ['run', 'discover', 'dispatch', 'status', 'generic', 'download'].forEach(dismissBanner);

    setActiveJob(jobId);

    // Seed the detail panel with the last known snapshot immediately so
    // the UI doesn't flash empty, then start live polling.
    var entry = state.tasks[jobId];
    if (entry && entry.snapshot) {
      state.status = entry.snapshot;
    }
    renderStage();
    startPolling();
    // Scroll status into view so the operator can see the switch.
    if (el['status-section']) {
      el['status-section'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  /**
   * Discover jobs from the repo and refresh every entry's snapshot.
   * Runs on Settings save, on Tasks-refresh click, and periodically in
   * the background. Each entry is fetched independently so a single
   * failure never wipes the whole list.
   */
  async function refreshTasksFromRepo(opts) {
    opts = opts || {};
    if (!isConfigured() || state.tasksRefreshing) return;
    state.tasksRefreshing = true;
    if (opts.silent !== true) setMsg(el['tasks-refresh-msg'], 'Refreshing…', null);

    var repoIds;
    try {
      repoIds = await listJobDirs();
    } catch (err) {
      state.tasksRefreshing = false;
      if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
      } else if (opts.silent !== true) {
        setMsg(el['tasks-refresh-msg'], 'Refresh failed: ' + err.message, 'bad');
      }
      return;
    }

    // Drop cached entries that no longer exist in the repo (e.g. cleanup
    // deleted them, or another operator deleted them). This only removes
    // rows; it never touches the currently-selected task's live state
    // beyond dropping it from the list — the operator can still see the
    // detail panel until they navigate away.
    var repoSet = {};
    repoIds.forEach(function (id) { repoSet[id] = true; });
    Object.keys(state.tasks).forEach(function (id) {
      if (!repoSet[id]) {
        delete state.tasks[id];
        // Drop the cached step list too — the run is gone from the repo's
        // job tree, so its live-step cache is dead weight and must not be
        // resurrected if the id is ever reused.
        delete state.workflowSteps[id];
      }
    });

    // Tracks whether this refresh changed the currently-selected task's
    // detail-panel snapshot, so we can re-render that panel once at the end.
    var selectedDetailChanged = false;

    // Fetch each id's status.json in parallel, capped at 5 concurrent.
    var queue = repoIds.slice();
    var CONC = 5;
    async function worker() {
      while (queue.length) {
        var id = queue.shift();
        try {
          var file = await gh('/repos/' + state.owner + '/' + state.repo +
            '/contents/jobs/' + encodeURIComponent(id) + '/status.json?ref=' + REF +
            '&_=' + Date.now());
          var parsed = JSON.parse(b64decodeUtf8(file.content));
          recordTaskSnapshot(id, parsed);
          // If the freshly-fetched snapshot belongs to the task whose
          // detail panel is currently open, and it differs from what that
          // panel is showing, update the panel's live state so it doesn't
          // go stale after its own polling has already stopped (e.g. the
          // job reached a terminal stage, or was changed from another
          // session). renderStage() is deferred until after all workers
          // finish, to avoid re-rendering repeatedly mid-refresh.
          if (id === state.jobId &&
              JSON.stringify(parsed) !== JSON.stringify(state.status)) {
            state.status = parsed;
            selectedDetailChanged = true;
          }
        } catch (err) {
          if (err.name === 'AuthError' || err.name === 'RateLimitError') {
            handleGlobalError(err);
            queue.length = 0;
            return;
          }
          // 404 (folder without status.json yet) — keep a placeholder.
          ensureTaskEntry(id);
        }
      }
    }
    var workers = [];
    for (var i = 0; i < CONC; i++) workers.push(worker());
    await Promise.all(workers);
    persistTasks();

    // The background refresh only updates the Tasks-list cards via
    // renderTasksList() below. If it also picked up a change to the
    // currently-open detail panel's task (state.jobId) — which can happen
    // once that task's own polling has stopped — re-render the detail
    // panel too so it doesn't stay stale until a manual page refresh.
    if (selectedDetailChanged) renderStage();

    // Pull the live workflow-step data for tasks that have a known
    // workflow_run_id. Each fetch is strictly scoped to its own job id —
    // state.workflowSteps is only ever written at key === jobId inside
    // fetchWorkflowStepsFor — so this loop cannot mix step data across
    // tasks even under concurrency. Running tasks refresh on a throttle;
    // terminal tasks are fetched once and then served from cache.
    var stepIds = Object.keys(state.tasks).filter(function (id) {
      var s = state.tasks[id] && state.tasks[id].snapshot;
      if (!s) return false;
      var runId = runIdFromSnapshot(s);
      if (!runId) return false;
      var cached = state.workflowSteps[id];
      var terminal = s.stage === 'complete' || s.stage === 'error' ||
                     s.stage === 'cancelled' || s.stage === 'awaiting_json_upload' ||
                     s.stage === 'awaiting_torrent_selection';
      if (terminal) return !cached;   // terminal: fetch once, then cache
      // active: refresh only when the cache is older than half the
      // tasks-list cadence, to stay well inside the rate limit.
      return !(cached && (Date.now() - cached.fetchedAt) < STEPS_POLL_TASKS_LIST / 2);
    });
    var stepQueue = stepIds.slice();
    var STEP_CONC = 3;
    async function stepWorker() {
      while (stepQueue.length) {
        var sid = stepQueue.shift();
        var ssnap = state.tasks[sid] && state.tasks[sid].snapshot;
        var srunId = runIdFromSnapshot(ssnap);
        if (!srunId) continue;
        // A failure of one task's step fetch must never abort the loop —
        // per-task isolation extends to error handling too.
        await fetchWorkflowStepsFor(sid, srunId);
      }
    }
    var sw = [];
    for (var sj = 0; sj < STEP_CONC; sj++) sw.push(stepWorker());
    await Promise.all(sw);

    state.tasksRefreshing = false;
    renderTasksList();
    if (opts.silent !== true) {
      var n = Object.keys(state.tasks).length;
      setMsg(el['tasks-refresh-msg'],
        'Refreshed. ' + n + ' task' + (n === 1 ? '' : 's') + ' known.', 'ok');
      setTimeout(function () { setMsg(el['tasks-refresh-msg'], '', null); }, 4000);
    }
  }

  /**
   * Delete ONE task's persistent footprint from the repo. Every artifact
   * this app writes is namespaced by <job-id>, so deletion is a
   * closed-set operation:
   *   1) the GitHub Release tagged clipforge-<id> + its underlying git tag
   *   2) any per-job branch clipforge-job/<id>
   *   3) every file under jobs/<id>/ on the default branch
   * NOTHING outside those namespaces (other tasks, branding/, workflow
   * files, other releases) is ever touched.
   */
  function confirmTaskDeletion(jobId) {
    var dialog = $('confirm-dialog');
    if (!dialog || typeof dialog.showModal !== 'function') {
      return Promise.resolve(window.confirm('Delete task "' + jobId + '" and all of its artifacts? Other tasks are not affected.'));
    }
    text($('confirm-task-id'), jobId);
    return new Promise(function (resolve) {
      function finish() {
        dialog.removeEventListener('close', finish);
        resolve(dialog.returnValue === 'confirm');
      }
      dialog.addEventListener('close', finish);
      dialog.showModal();
    });
  }

  async function deleteTask(jobId) {
    if (!jobId) return;
    if (state.taskDeleting[jobId]) return;
    if (!isConfigured()) {
      banner('delete-task', 'error', 'Save your GitHub settings first.');
      return;
    }
    var ok = await confirmTaskDeletion(jobId);
    if (!ok) return;

    state.taskDeleting[jobId] = true;
    renderTasksList();
    banner('delete-task', 'info', 'Deleting task ' + jobId + '…');

    try {
      // If the caller is deleting the currently-selected task, stop
      // polling it now so the poll loop can't recreate/read anything
      // mid-delete.
      if (state.jobId === jobId) {
        stopPolling();
        stopCountdown();
      }

      // 1) Release + tag. Look up by tag; ignore 404.
      var tag = 'clipforge-' + jobId;
      try {
        var rel = await gh('/repos/' + state.owner + '/' + state.repo +
          '/releases/tags/' + encodeURIComponent(tag));
        if (rel && rel.id) {
          await gh('/repos/' + state.owner + '/' + state.repo +
            '/releases/' + rel.id, { method: 'DELETE' });
        }
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      try {
        await gh('/repos/' + state.owner + '/' + state.repo +
          '/git/refs/tags/' + encodeURIComponent(tag), { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404 && err.status !== 422) throw err;
      }

      // 2) Optional per-job branch.
      try {
        await gh('/repos/' + state.owner + '/' + state.repo +
          '/git/refs/heads/' + encodeURIComponent('clipforge-job/' + jobId),
          { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404 && err.status !== 422) throw err;
      }

      // 3) Every file under jobs/<id>/ on the default branch. The
      //    contents API requires a per-file DELETE with its blob SHA.
      //    We list the folder and delete each entry. Nothing outside
      //    jobs/<id>/ is inspected, so unrelated task data cannot
      //    possibly be touched.
      var folderPath = 'jobs/' + jobId;
      var listing;
      try {
        listing = await gh('/repos/' + state.owner + '/' + state.repo +
          '/contents/' + folderPath + '?ref=' + REF + '&_=' + Date.now());
      } catch (err) {
        if (err.status === 404) listing = [];
        else throw err;
      }
      if (Array.isArray(listing)) {
        for (var i = 0; i < listing.length; i++) {
          var entry = listing[i];
          if (!entry || !entry.path || !entry.sha) continue;
          // Defensive: refuse to delete anything outside this task's folder.
          if (entry.path.indexOf(folderPath + '/') !== 0) continue;
          if (entry.type === 'dir') {
            // Nested folder — recurse one level (the pipeline does not
            // create sub-folders under jobs/<id>/, but be safe).
            await deleteFolderRecursive(entry.path, jobId);
            continue;
          }
          await gh('/repos/' + state.owner + '/' + state.repo +
            '/contents/' + entry.path, {
              method: 'DELETE',
              body: {
                message: 'clipforge: delete ' + entry.path + ' (manual task delete)',
                sha: entry.sha,
                branch: REF
              }
            });
        }
      }

      // Local bookkeeping: drop the registry entry AND this task's live
      // step cache so a concurrently-running background refresh cannot
      // resurrect a ghost row, and so no other task can inherit stale
      // step data through a reused id.
      forgetTask(jobId);
      delete state.workflowSteps[jobId];
      if (state.jobId === jobId) clearActiveJob();

      dismissBanner('delete-task');
      banner('delete-task', 'info', 'Deleted task ' + jobId + '.');
      setTimeout(function () { dismissBanner('delete-task'); }, 4000);
    } catch (err) {
      banner('delete-task', 'error', 'Delete failed for ' + jobId + ': ' + err.message);
      handleGlobalError(err, 'delete-task');
    } finally {
      delete state.taskDeleting[jobId];
      renderTasksList();
    }
  }

  /** Recursive helper for deleteTask() — same guard rails, one level deeper. */
  async function deleteFolderRecursive(folderPath, ownerJobId) {
    var listing;
    try {
      listing = await gh('/repos/' + state.owner + '/' + state.repo +
        '/contents/' + folderPath + '?ref=' + REF + '&_=' + Date.now());
    } catch (err) {
      if (err.status === 404) return;
      throw err;
    }
    if (!Array.isArray(listing)) return;
    for (var i = 0; i < listing.length; i++) {
      var entry = listing[i];
      if (!entry || !entry.path || !entry.sha) continue;
      // Namespace guard: never step outside this task's own tree.
      if (entry.path.indexOf('jobs/' + ownerJobId + '/') !== 0) continue;
      if (entry.type === 'dir') {
        await deleteFolderRecursive(entry.path, ownerJobId);
      } else {
        await gh('/repos/' + state.owner + '/' + state.repo +
          '/contents/' + entry.path, {
            method: 'DELETE',
            body: {
              message: 'clipforge: delete ' + entry.path + ' (manual task delete)',
              sha: entry.sha,
              branch: REF
            }
          });
      }
    }
  }

  /** Background timer: pull fresh snapshots for every known task. */
  function startTasksTimer() {
    stopTasksTimer();
    // First silent refresh, then a slow tick. The selected task has its
    // own faster polling loop, so this one only needs to keep the LIST
    // reasonably fresh.
    state.tasksTimer = setInterval(function () {
      if (document.hidden) return;
      refreshTasksFromRepo({ silent: true });
    }, 60000);
  }

  function stopTasksTimer() {
    if (state.tasksTimer) { clearInterval(state.tasksTimer); state.tasksTimer = null; }
  }

  /* --------------------------------------------------------- workflow steps */

  /**
   * Return the workflow_run_id / run URL stored inside a status snapshot.
   * Both Stage A and Stage B now embed these in status.json.extra when they
   * publish the initial-running status — the site does NOT infer or
   * fabricate a run id from anywhere else, so a snapshot without one simply
   * skips live-step tracking.
   */
  function runIdFromSnapshot(snap) {
    if (!snap) return null;
    var extra = snap.extra || {};
    var raw = extra.workflow_run_id;
    if (!raw) return null;
    var n = Number(raw);
    return isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Pull the LIVE step list for a specific task's workflow run from
   * GitHub's Actions Jobs API.
   *
   * Strictly indexed by the caller's own job id: the result is written to
   * state.workflowSteps[jobId] and NOWHERE ELSE, and every field comes from
   * the SAME response for THAT run — there is no code path where Task A's
   * response could land under Task B's key. Callers pass the run id they
   * read from THAT task's own status.json, so a stale / cross-wired id
   * physically cannot occur here.
   *
   * Returns the fetched entry (or the last cached one / null on failure).
   * Silent on transient errors so poll loops stay healthy; auth and
   * rate-limit errors bubble to handleGlobalError so the operator sees
   * them once.
   */
  async function fetchWorkflowStepsFor(jobId, runId) {
    if (!jobId || !runId) return null;
    if (!isConfigured()) return null;
    // Guard against overlapping fetches for the same runId (the selected
    // task's fast timer and the list's slow refresh could otherwise race).
    if (state.stepsInFlight[runId]) return state.workflowSteps[jobId] || null;
    state.stepsInFlight[runId] = true;
    try {
      var data = await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/runs/' + encodeURIComponent(runId) + '/jobs?per_page=30&_=' + Date.now());
      var jobs = (data && data.jobs) || [];
      // Both workflows here run a SINGLE pipeline job (named "stage a" /
      // "stage b") plus, for stage-b.yml, a separate cancellation listener
      // job. Surface the pipeline job — the one whose steps drive the
      // actual work.
      var primary = null;
      for (var i = 0; i < jobs.length; i++) {
        var nm = String(jobs[i].name || '').toLowerCase().replace(/_/g, ' ');
        if (nm === 'stage a' || nm === 'stage b') { primary = jobs[i]; break; }
      }
      if (!primary && jobs.length) primary = jobs[0];
      if (!primary) return null;

      var entry = {
        runId: Number(runId),
        jobId: primary.id || null,
        jobStatus: String(primary.status || ''),
        jobConclusion: primary.conclusion || null,
        jobName: String(primary.name || ''),
        jobHtmlUrl: String(primary.html_url || ''),
        steps: (primary.steps || []).map(function (s) {
          return {
            name: String(s.name || ''),
            status: String(s.status || ''),
            conclusion: s.conclusion || null,
            number: Number(s.number || 0),
            started_at: s.started_at || null,
            completed_at: s.completed_at || null
          };
        }),
        fetchedAt: Date.now()
      };

      // ONLY ever write to this job id's slot. This single line is what
      // guarantees multi-task isolation — no other task's cache can be
      // touched by this response.
      state.workflowSteps[jobId] = entry;
      return entry;
    } catch (err) {
      if (err.name === 'AuthError' || err.name === 'RateLimitError') {
        handleGlobalError(err);
      }
      // Everything else is transient (404 while GitHub is still
      // materialising the run, network blip, …) — keep the last known
      // snapshot; the next tick retries.
      return state.workflowSteps[jobId] || null;
    } finally {
      delete state.stepsInFlight[runId];
    }
  }

  /**
   * Fetch steps for the SELECTED task, using the run id stored on its own
   * status snapshot (falling back to the run the Stage B matcher found).
   * Never guesses a run id.
   */
  async function refreshSelectedTaskSteps() {
    if (!state.jobId) return null;
    var runId = runIdFromSnapshot(state.status) ||
                (state.stageBRun && state.stageBRun.id) ||
                state.runId;
    if (!runId) return null;
    return await fetchWorkflowStepsFor(state.jobId, runId);
  }

  /**
   * Derive UI progress from a live step list.
   *
   * Progress is (completed steps) / (total steps) where "completed" means
   * GitHub itself reports status='completed' for that step (any
   * conclusion — success, skipped, cancelled). This is an HONEST fraction
   * of the run's real step positions; it never invents a percentage from
   * wall-clock heuristics and never jumps to some number just because one
   * particular step happens to be running. For jobs whose status.json
   * gives no step data yet, callers fall back to stage-based display.
   */
  function deriveProgress(entry) {
    if (!entry || !Array.isArray(entry.steps) || !entry.steps.length) {
      return { totalSteps: 0, completedSteps: 0, currentStep: null,
               recentCompleted: [], phase: 'unknown', percent: null };
    }
    var steps = entry.steps.slice().sort(function (a, b) {
      return (a.number || 0) - (b.number || 0);
    });
    var completed = 0;
    var running = null;
    var completedSoFar = [];
    for (var i = 0; i < steps.length; i++) {
      var s = steps[i];
      if (s.status === 'completed') {
        completed++;
        completedSoFar.push(s);
      } else if (s.status === 'in_progress' && !running) {
        running = s;
      }
    }
    // If nothing is in_progress yet but the job is active, the "current"
    // step is the first step that has not completed (its queued neighbour).
    var jobActive = entry.jobStatus === 'queued' || entry.jobStatus === 'in_progress' ||
                    entry.jobStatus === 'waiting' || entry.jobStatus === 'requested' ||
                    entry.jobStatus === 'pending';
    if (!running && completed < steps.length && jobActive) {
      for (var k = 0; k < steps.length; k++) {
        if (steps[k].status !== 'completed') { running = steps[k]; break; }
      }
    }

    var phase;
    if (entry.jobStatus === 'completed') phase = 'completed';
    else if (running || jobActive) phase = 'running';
    else phase = 'not_started';

    // Percent is null unless we actually have steps — in which case it is
    // honestly the completed fraction, no scaling tricks.
    var percent = steps.length ? Math.round((completed / steps.length) * 100) : null;

    return {
      totalSteps: steps.length,
      completedSteps: completed,
      currentStep: running,
      recentCompleted: completedSoFar.slice().reverse().slice(0, 5),
      phase: phase,
      percent: percent
    };
  }

  /* Live-step timer for the SELECTED task only. The tasks list uses the
   * slower background refresh (refreshTasksFromRepo) to update its cards. */
  function startStepsPolling() {
    stopStepsPolling();
    state.stepsPollStartedAt = Date.now();
    var tick = async function () {
      if (!state.jobId) return;
      var entry = await refreshSelectedTaskSteps();
      if (entry) {
        renderStage();
        renderTasksList();
      }
      // Keep ticking while the run has not concluded. When the job is
      // completed AND the status.json stage is terminal we stop — the
      // final step list is already rendered.
      var doneRun = entry && entry.jobStatus === 'completed';
      var stage = state.status && state.status.stage;
      var doneStage = stage === 'complete' || stage === 'error' || stage === 'cancelled' ||
                      stage === 'awaiting_json_upload' || stage === 'awaiting_torrent_selection';
      if (doneRun && doneStage) return;
      var interval = (Date.now() - state.stepsPollStartedAt > POLL_SLOWDOWN_AFTER)
        ? STEPS_POLL_SLOW : STEPS_POLL_FAST;
      state.stepsPollTimer = setTimeout(tick, interval);
    };
    // First tick soon after start so the UI has data quickly.
    state.stepsPollTimer = setTimeout(tick, 500);
  }

  function stopStepsPolling() {
    if (state.stepsPollTimer) { clearTimeout(state.stepsPollTimer); state.stepsPollTimer = null; }
  }

  /* -------------------------------------------------------------- status poll */

  function startPolling() {
    if (!state.jobId) return;
    stopPolling();
    state.polling = true;
    state.pollStartedAt = Date.now();
    hide(el['resume-btn']);
    pollOnce();
    // Kick off the live-step timer for the same task. It is independent of
    // the status.json poll but shares the selected job id, so switching
    // tasks (which calls stopPolling + startPolling) also swaps which run
    // the step timer is watching.
    startStepsPolling();
  }

  function stopPolling() {
    state.polling = false;
    if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; }
    stopStepsPolling();
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
      // Feed the newest snapshot into the multi-task registry so the Tasks
      // list above stays fresh independently of whichever task is selected.
      recordTaskSnapshot(state.jobId, parsed);
      await refreshStageBRun();
      renderStage();
      renderTasksList();

      // Only stop when the STATUS is terminal (or unknown). We do NOT stop
      // merely because a workflow run object completed: during Stage A the
      // "Stage B run" slot is empty, and even for Stage B the final
      // status.json commit lands AFTER the run ends — polling must continue
      // until that terminal status is actually read, or the UI would stick
      // on `stage_b_running` forever. See refreshStageBRun() for why the
      // stageBRun slot is never populated during Stage A.
      if (parsed.stage === 'complete' || parsed.stage === 'error' ||
          parsed.stage === 'cancelled' || parsed.stage === 'awaiting_torrent_selection' ||
          !isKnownStage(parsed.stage)) {
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
    return ['queued', 'awaiting_torrent_selection', 'stage_a_running',
      'awaiting_json_upload', 'stage_b_queued', 'stage_b_running',
      'stage_b_cancelling', 'cancelled', 'complete', 'error'].indexOf(stage) !== -1;
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

  /**
   * Resolve the CURRENT Stage B run for the SELECTED task.
   *
   * Multi-task / multi-stage correctness:
   *
   *  1. The `workflow_run_id` in status.json belongs to WHICHEVER stage
   *     last published status. During Stage A it is the STAGE A run — so
   *     we must never load it into the Stage B slot. Doing so (the old
   *     behavior) made the UI render "Stage B is running" during Stage A,
   *     and made the Cancel button target the Stage A run.
   *  2. Stage A's own status.json still carries that id purely so the
   *     live-step tracker (runIdFromSnapshot / fetchWorkflowStepsFor) can
   *     show real per-step progress — that path is unchanged.
   *  3. The Stage B slot is only populated from a status.json that is in
   *     a Stage B (or later) phase, or from a title-scoped Stage B run
   *     lookup ("Stage B — <job-id>") — which can never match another
   *     task's run because the title embeds this task's job id.
   */
  async function refreshStageBRun() {
    if (!state.jobId || !isConfigured()) return;
    try {
      var stage = state.status && state.status.stage;
      var inStageBPhase = ['stage_b_queued', 'stage_b_running',
        'stage_b_cancelling', 'cancelled', 'complete', 'error'].indexOf(stage) !== -1;
      var id = state.status && state.status.extra && state.status.extra.workflow_run_id;
      var run = null;
      if (inStageBPhase && id) {
        // status.json's run id IS the Stage B run at this point.
        run = await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/runs/' + encodeURIComponent(id));
      } else if (state.stageBDispatched || stage === 'stage_b_queued' || stage === 'stage_b_running') {
        // Stage B dispatched but status.json hasn't caught up yet: match by
        // the title the workflow stamps from the job_id input. This is
        // scoped to THIS task — it cannot return another task's run.
        var data = await gh('/repos/' + state.owner + '/' + state.repo +
          '/actions/workflows/stage-b.yml/runs?event=workflow_dispatch&per_page=30');
        var expectedTitle = 'Stage B — ' + state.jobId;
        run = ((data && data.workflow_runs) || []).filter(function (candidate) {
          return candidate.display_title === expectedTitle;
        }).sort(function (a, b) { return new Date(b.created_at) - new Date(a.created_at); })[0] || null;
      }
      if (run) {
        state.stageBRun = run;
        // Surface the run link, but do NOT clobber state.runId while Stage
        // A is the active stage — state.runId may currently point at the
        // Stage A run whose failure watch is still meaningful.
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
    awaiting_torrent_selection: {
      label: 'choose torrent video', cls: 'stage-await', spin: false,
      text: 'Choose one video from the saved torrent to begin Stage A.'
    },
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

  function renderTorrentSelection(s) {
    var block = el['torrent-selection-block'];
    var select = el['torrent-selection-select'];
    var message = el['torrent-selection-message'];
    var start = el['start-torrent-stage-a'];
    if (!block || !select || !message || !start) return;
    show(block);

    var selection = state.torrentSelection;
    if (!selection || selection.job_id !== state.jobId ||
        !Array.isArray(selection.video_candidates)) {
      select.innerHTML = '<option value="">Loading video candidates…</option>';
      select.disabled = true;
      start.disabled = true;
      text(message, 'Loading the video candidates saved with this torrent…');
      loadPendingTorrentSelection(s);
      return;
    }

    var candidates = selection.video_candidates;
    select.innerHTML = '<option value="">Choose a video from the torrent…</option>';
    candidates.forEach(function (candidate) {
      var option = document.createElement('option');
      option.value = String(candidate.index);
      option.textContent = candidate.path + ' — ' + torrentSizeLabel(candidate.length);
      select.appendChild(option);
    });
    var chosen = Number(selection.selected_index) || 0;
    if (candidates.some(function (candidate) { return candidate.index === chosen; })) {
      select.value = String(chosen);
    }
    select.disabled = state.busy;
    start.disabled = state.busy || !select.value;
    text(message, candidates.length + ' supported video file' +
      (candidates.length === 1 ? '' : 's') + ' found in “' +
      selection.torrent_name + '”. Choose one to begin Stage A.');
    select.onchange = function () {
      start.disabled = state.busy || !select.value;
      if (select.value) text(message, 'Ready to start Stage A with the selected video only.');
    };
  }

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
      hide(el['torrent-selection-block']);
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

    // Durable human selection between torrent upload and Stage A.
    if (stage === 'awaiting_torrent_selection') {
      renderTorrentSelection(s);
    } else {
      hide(el['torrent-selection-block']);
    }

    // Handoff (awaiting_json_upload).
    if (stage === 'awaiting_json_upload') {
      show(el['handoff-block']);
      renderAssets(s);
    } else {
      hide(el['handoff-block']);
    }

    // Complete. Stage B stays authoritative; publishing is a sibling state.
    if (stage === 'complete') {
      show(el['complete-block']);
      renderFinalZip(s);
      renderZernioPublishing(s);
    } else {
      hide(el['complete-block']);
      hide(el['zernio-publish-panel']);
    }

    // Expiry countdown from awaiting_json_upload onwards.
    var showCountdown = ['awaiting_torrent_selection', 'awaiting_json_upload',
      'stage_b_running', 'complete'].indexOf(stage) !== -1;
    if (showCountdown && Number(s.expires_at_epoch) > 0) startCountdown(Number(s.expires_at_epoch));
    else stopCountdown();

    renderFacts(s);
    renderRaw(s);

    renderProgress(s);
    renderActivity(s);

    renderStageBControls(stage);

    // Resume button appears when polling has stopped on a terminal-ish state.
    toggleHidden(el['resume-btn'], state.polling || stage === 'complete' || stage === 'error' || stage === 'cancelled');
  }

  /**
   * Render the live progress bar + stage label for the SELECTED task.
   *
   * Data source priority:
   *   1) Live workflow steps (state.workflowSteps[jobId]) — an honest
   *      completed/total fraction of the run's REAL step positions.
   *   2) Stage-based fallback — an ordered ladder of the known status.json
   *      stages, so the bar still moves meaningfully before GitHub has
   *      materialised the run's step list (or for old jobs that predate
   *      the workflow_run_id field).
   *
   * We NEVER invent a percentage: when no step data exists we show the
   * stage position on the ladder (which is real state) and label it as a
   * stage, not a fabricated "70%".
   */
  var STAGE_LADDER = [
    'queued',
    'awaiting_torrent_selection',
    'stage_a_running',
    'awaiting_json_upload',
    'stage_b_queued',
    'stage_b_running',
    'complete'
  ];

  function renderProgress(s) {
    var block = el['progress-block'];
    if (!block) return;
    if (!s || !state.jobId) { hide(block); return; }

    var stage = s.stage;
    var stepsEntry = state.workflowSteps[state.jobId] || null;
    var prog = deriveProgress(stepsEntry);

    // Determine fill width + caption without ever fabricating a number.
    var pct = null;          // numeric percent when honestly derivable
    var caption = '';
    var fillCls = '';

    if (prog.percent !== null && prog.totalSteps > 0) {
      // Live step fraction.
      pct = prog.percent;
      caption = prog.completedSteps + ' of ' + prog.totalSteps + ' steps';
      if (prog.currentStep) caption += ' · ' + friendlyStepLabel(prog.currentStep.name);
      if (prog.phase === 'completed') fillCls = 'is-done';
    } else {
      // Stage-based fallback: position on the known lifecycle ladder.
      var idx = STAGE_LADDER.indexOf(stage);
      if (stage === 'complete') { pct = 100; caption = 'Complete'; fillCls = 'is-done'; }
      else if (stage === 'error') { pct = null; caption = 'Error'; fillCls = 'is-error'; }
      else if (stage === 'cancelled') { pct = null; caption = 'Cancelled'; fillCls = 'is-cancelled'; }
      else if (idx >= 0) {
        // Map ladder index onto a 0–100 stage scale. This is a STAGE
        // position, honestly labelled as such — not a fake precise %.
        pct = Math.round(((idx + 1) / STAGE_LADDER.length) * 100);
        caption = (known_stage_label(stage)) + ' — waiting for live step data…';
      } else {
        pct = null; caption = 'Working…';
      }
    }

    var fill = el['progress-bar-fill'];
    if (fill) {
      if (pct === null) {
        // Indeterminate / terminal-without-steps: show a pulsing bar.
        fill.style.width = '100%';
        fill.className = 'progress-bar-fill is-indeterminate ' + fillCls;
      } else {
        fill.style.width = pct + '%';
        fill.className = 'progress-bar-fill ' + fillCls;
      }
    }
    text(el['progress-text'], caption);
    show(block);

    function known_stage_label(st) {
      var m = STAGE_META[st];
      return m ? m.label : String(st);
    }
  }

  /**
   * Render current activity + recent activity for the SELECTED task.
   * Everything shown comes straight from the live step list (real step
   * names / friendly labels) or, when no steps exist yet, from the
   * status.json message — never fabricated.
   */
  function renderActivity(s) {
    var block = el['activity-block'];
    if (!block) return;
    if (!s || !state.jobId) { hide(block); return; }

    var stepsEntry = state.workflowSteps[state.jobId] || null;
    var prog = deriveProgress(stepsEntry);

    // Run link (prefer the step job's own URL, fall back to status extra).
    var runLink = el['activity-run-link'];
    var runUrl = (stepsEntry && stepsEntry.jobHtmlUrl) ||
                 (s.extra && s.extra.workflow_run_url) ||
                 state.runHtmlUrl || '';
    if (runLink) {
      if (runUrl) { runLink.href = runUrl; show(runLink); }
      else hide(runLink);
    }

    // Current activity.
    var curLabel = el['activity-current-label'];
    var currentText = '';
    if (prog.currentStep) {
      currentText = friendlyStepLabel(prog.currentStep.name);
    } else if (s.message) {
      currentText = s.message;
    } else {
      var m = STAGE_META[s.stage];
      currentText = m ? m.text : String(s.stage || '');
    }
    text(curLabel, currentText);

    // Recent activity: the last few completed steps, newest first.
    var list = el['activity-recent-list'];
    if (list) {
      list.innerHTML = '';
      if (prog.recentCompleted.length) {
        prog.recentCompleted.forEach(function (st) {
          var li = document.createElement('li');
          var label = friendlyStepLabel(st.name);
          if (st.conclusion && st.conclusion !== 'success') {
            label += ' (' + st.conclusion + ')';
          }
          li.textContent = label;
          if (st.completed_at) {
            var t = document.createElement('span');
            t.className = 'activity-time';
            t.textContent = ' · ' + fmtClock(Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(new Date(st.completed_at).getTime() / 1000))) + ' ago';
            li.appendChild(t);
          }
          list.appendChild(li);
        });
        show(list);
      } else {
        hide(list);
      }
    }

    show(block);
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
      // Posting-package echo (mirrors the title echo above): surface how many
      // hashtags / YouTube tags the analysis agent produced so an operator can
      // tell at a glance whether the uploaded production.json carries a full
      // posting package (title + hashtags + youtube_tags -> metadata.txt in
      // the Stage B ZIP has all three sections populated) or a legacy
      // title-only JSON (older files pre-dating the posting package; the ZIP
      // still ships fine, but the hashtag / YouTube-tag sections in the TXT
      // will be blank). Zero counts are noted explicitly so the operator is
      // not left guessing between "field absent" and "upload ok".
      var hashtagsCount = Array.isArray(parsed.hashtags) ? parsed.hashtags.length : 0;
      var youtubeTagsCount = Array.isArray(parsed.youtube_tags) ? parsed.youtube_tags.length : 0;
      var postingLine = '';
      if (hashtagsCount || youtubeTagsCount) {
        postingLine =
          '\nPosting package: ' +
          hashtagsCount + ' hashtag' + (hashtagsCount === 1 ? '' : 's') + ', ' +
          youtubeTagsCount + ' YouTube tag' + (youtubeTagsCount === 1 ? '' : 's') +
          ' (shipped in the final ZIP as metadata.txt).';
      } else {
        postingLine =
          '\nPosting package: none (no hashtags / youtube_tags in this production.json — ' +
          'metadata.txt will ship with only the title populated).';
      }
      showValidation([
        'Valid. ' + count + ' cut' + (count === 1 ? '' : 's') + ', ' +
        total + 's of source selected (target ' +
        parsed.target_total_duration_seconds + 's).' +
        (typeof parsed.title === 'string' && parsed.title.trim() !== ''
          ? '\nJob title: "' + parsed.title + '" (one title for every scene of this job.)'
          : '') +
        postingLine
      ], true);
      el['start-stage-b'].disabled = false;
    };
    reader.readAsText(file);
  });

  // -------------------------------------------------------------------
  // Persistent audio library (audio-library/ at repo root).
  //
  // Tracks committed here survive forever, independent of any job, so a
  // track only has to be uploaded once even across flaky connections.
  // Selecting a library track for the CURRENT job sets
  // state.audioLibrarySelected to its repo path; startStageB() passes
  // that straight through as music_ref ('path:audio-library/<name>'),
  // the exact same mechanism already used for a job-local upload — the
  // workflow (.github/workflows/stage-b.yml) treats any `path:<repo
  // path>` the same way regardless of which folder it's under, so no
  // backend/workflow change was needed for this feature.
  // -------------------------------------------------------------------

  var AUDIO_LIBRARY_DIR = 'audio-library';

  async function loadAudioLibrary() {
    if (!isConfigured()) return;
    try {
      var res = await gh(
        '/repos/' + state.owner + '/' + state.repo +
        '/contents/' + AUDIO_LIBRARY_DIR + '?ref=' + REF + '&_=' + Date.now()
      );
      var list = Array.isArray(res) ? res : [];
      state.audioLibrary = list
        .filter(function (f) { return f.type === 'file'; })
        .map(function (f) { return { name: f.name, path: f.path, size: f.size, sha: f.sha }; })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
    } catch (err) {
      // 404 just means the folder doesn't exist yet (empty library) —
      // that's a normal, not-yet-used state, not an error.
      if (err && err.status === 404) {
        state.audioLibrary = [];
      } else {
        state.audioLibrary = state.audioLibrary || [];
        if (el['audio-library-empty']) {
          el['audio-library-empty'].textContent = 'Could not load the audio library: ' + err.message;
        }
      }
    }
    renderAudioLibrary();
  }

  function formatBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function renderAudioLibrary() {
    var node = el['audio-library-list'];
    if (!node) return;
    var lib = state.audioLibrary;

    if (lib === null) {
      node.innerHTML = '';
      if (el['audio-library-empty']) el['audio-library-empty'].textContent = 'Loading library…';
      return;
    }
    if (lib.length === 0) {
      node.innerHTML = '';
      if (el['audio-library-empty']) el['audio-library-empty'].textContent = 'No tracks in the library yet — add one below.';
      return;
    }
    if (el['audio-library-empty']) el['audio-library-empty'].textContent = '';

    node.innerHTML = '';
    lib.forEach(function (track) {
      var row = document.createElement('div');
      row.className = 'audio-track-row' + (state.audioLibrarySelected === track.path ? ' is-selected' : '');

      var name = document.createElement('span');
      name.className = 'audio-track-name';
      name.textContent = track.name;
      row.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'audio-track-meta';
      meta.textContent = formatBytes(track.size);
      row.appendChild(meta);

      var selectBtn = document.createElement('button');
      selectBtn.type = 'button';
      selectBtn.className = 'btn btn-secondary';
      var isSelected = state.audioLibrarySelected === track.path;
      selectBtn.textContent = isSelected ? 'Selected ✓' : 'Use for this job';
      selectBtn.disabled = state.audioLibraryBusy;
      selectBtn.addEventListener('click', function () {
        if (isSelected) {
          state.audioLibrarySelected = null;
        } else {
          state.audioLibrarySelected = track.path;
          // A library selection and a one-off upload are mutually
          // exclusive for a given job — clear any picked file so it's
          // unambiguous which one startStageB() will use.
          state.musicFile = null;
          if (el['music-file-input']) el['music-file-input'].value = '';
          if (el['music-hint']) el['music-hint'].textContent = '';
        }
        renderAudioLibrary();
      });
      row.appendChild(selectBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'btn btn-secondary';
      deleteBtn.textContent = 'Delete';
      deleteBtn.disabled = state.audioLibraryBusy;
      deleteBtn.addEventListener('click', function () {
        deleteAudioLibraryTrack(track);
      });
      row.appendChild(deleteBtn);

      node.appendChild(row);
    });
  }

  async function addAudioLibraryTracks(files) {
    if (!files || !files.length) return;
    if (!isConfigured()) {
      if (el['audio-library-add-hint']) {
        el['audio-library-add-hint'].textContent = 'Save your repo settings first.';
      }
      return;
    }
    state.audioLibraryBusy = true;
    renderAudioLibrary();

    var okCount = 0;
    var failures = [];

    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (el['audio-library-add-hint']) {
        el['audio-library-add-hint'].textContent =
          'Adding ' + file.name + ' (' + (i + 1) + '/' + files.length + ')…';
      }
      var safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
      var path = AUDIO_LIBRARY_DIR + '/' + safeName;
      var contentsPath = '/repos/' + state.owner + '/' + state.repo +
        '/contents/' + path;

      var sha = null;
      try {
        var existing = await gh(contentsPath + '?ref=' + REF + '&_=' + Date.now());
        if (existing && existing.sha) sha = existing.sha;
      } catch (err) {
        if (err.status !== 404) { failures.push(file.name + ': ' + err.message); continue; }
      }

      try {
        var body = {
          message: 'clipforge: add ' + safeName + ' to audio library',
          content: await b64encodeFile(file),
          branch: REF
        };
        if (sha) body.sha = sha;
        await gh(contentsPath, { method: 'PUT', body: body });
        okCount++;
      } catch (err) {
        failures.push(file.name + ': ' + err.message);
      }
    }

    state.audioLibraryBusy = false;
    if (el['audio-library-add-hint']) {
      var msg = okCount ? ('Added ' + okCount + ' track' + (okCount === 1 ? '' : 's') + '.') : '';
      if (failures.length) msg += (msg ? ' ' : '') + 'Failed: ' + failures.join('; ');
      el['audio-library-add-hint'].textContent = msg;
    }
    if (el['audio-library-add-input']) el['audio-library-add-input'].value = '';
    await loadAudioLibrary();
  }

  async function deleteAudioLibraryTrack(track) {
    if (state.audioLibraryBusy) return;
    state.audioLibraryBusy = true;
    renderAudioLibrary();

    var contentsPath = '/repos/' + state.owner + '/' + state.repo +
      '/contents/' + track.path;
    try {
      await gh(contentsPath, {
        method: 'DELETE',
        body: {
          message: 'clipforge: remove ' + track.name + ' from audio library',
          sha: track.sha,
          branch: REF
        }
      });
      if (state.audioLibrarySelected === track.path) state.audioLibrarySelected = null;
    } catch (err) {
      if (el['audio-library-add-hint']) {
        el['audio-library-add-hint'].textContent = 'Delete failed: ' + err.message;
      }
    }
    state.audioLibraryBusy = false;
    await loadAudioLibrary();
  }

  if (el['audio-library-add-input']) {
    el['audio-library-add-input'].addEventListener('change', function () {
      var files = el['audio-library-add-input'].files;
      addAudioLibraryTracks(files);
    });
  }

  el['music-file-input'].addEventListener('change', function () {
    var file = el['music-file-input'].files && el['music-file-input'].files[0];
    state.musicFile = file || null;
    if (file) {
      // A one-off upload and a library selection are mutually exclusive
      // for a given job — picking a new file clears any library pick.
      state.audioLibrarySelected = null;
      renderAudioLibrary();
    }
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

    // Optional social-media metadata (generated by the same agent step that
    // produces the cuts and title; see the POSTING PACKAGE METADATA section
    // of 00_READ_THIS_FIRST.txt). Stage B writes these into the final ZIP's
    // metadata.txt alongside the finished video. Validated when present so a
    // malformed array is caught before upload; NEVER required so older
    // production.json files that pre-date the posting package still upload
    // cleanly.
    function checkStringArray(key, min, max, opts) {
      var val = doc[key];
      if (val === undefined) return;
      if (!Array.isArray(val)) {
        errors.push('`' + key + '` must be a JSON array of strings when present (or omit it entirely).');
        return;
      }
      if (val.length < min || val.length > max) {
        errors.push('`' + key + '` must contain between ' + min + ' and ' + max + ' entries when present (got ' + val.length + ').');
      }
      var seen = {};
      val.forEach(function (entry, i) {
        var at = '`' + key + '[' + i + ']`';
        if (typeof entry !== 'string' || entry.trim() === '') {
          errors.push(at + ' must be a non-empty string.');
          return;
        }
        var trimmed = entry.trim();
        if (opts && opts.requireHash && trimmed.charAt(0) !== '#') {
          errors.push(at + ' must start with `#` (got ' + JSON.stringify(entry) + ').');
        }
        if (opts && opts.requireHash && /\s/.test(trimmed)) {
          errors.push(at + ' must not contain whitespace inside a hashtag.');
        }
        if (opts && opts.forbidHash && trimmed.charAt(0) === '#') {
          errors.push(at + ' must not start with `#` (YouTube tags are plain keywords).');
        }
        if (opts && opts.forbidComma && trimmed.indexOf(',') !== -1) {
          errors.push(at + ' must not contain a comma inside a single tag.');
        }
        var lower = trimmed.toLowerCase();
        if (Object.prototype.hasOwnProperty.call(seen, lower)) {
          errors.push(at + ' duplicates an earlier entry (' + JSON.stringify(entry) + ').');
        } else {
          seen[lower] = true;
        }
      });
    }
    checkStringArray('hashtags', 5, 8, { requireHash: true });
    checkStringArray('youtube_tags', 10, 20, { forbidHash: true, forbidComma: true });

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
    this.disabled = true;
    startStageB();
  });

  async function resolveCurrentStageBCodeRef() {
    // A fresh dispatch must run the default branch as it exists NOW, not a
    // stale workflow SHA or browser-cached branch object. The workflow logs
    // this exact value and checks it out before any build dependency runs.
    var branch = await gh('/repos/' + state.owner + '/' + state.repo +
      '/branches/' + encodeURIComponent(REF) + '?_=' + Date.now());
    var codeRef = branch && branch.commit && branch.commit.sha;
    if (!codeRef) throw new Error('Could not resolve the latest commit of ' + REF + '.');
    return codeRef;
  }

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

    // Background music: a selected library track is used directly by
    // repo path (already committed permanently under audio-library/, so
    // there is nothing to upload here — this is exactly the network
    // failure this feature exists to avoid). A freshly picked one-off
    // file is committed to jobs/<jobId>/music.mp3 same as before. No
    // library pick and no file picked -> music_ref stays empty and the
    // workflow skips music entirely.
    var musicRef = '';
    if (state.audioLibrarySelected) {
      musicRef = 'path:' + state.audioLibrarySelected;
      showValidation([path + ' committed. Using library track: ' + state.audioLibrarySelected + '…'], true);
    } else if (state.musicFile) {
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
      // Pin every fresh Stage B dispatch to the current default-branch SHA.
      // This gives normal starts and recovery starts identical current-code
      // behavior and prevents a fixed pipeline from replaying stale code.
      var codeRef = await resolveCurrentStageBCodeRef();
      await gh('/repos/' + state.owner + '/' + state.repo +
        '/actions/workflows/stage-b.yml/dispatches', {
        method: 'POST',
        body: {
          ref: REF,
          inputs: {
            job_id: state.jobId,
            production_ref: 'path:jobs/' + state.jobId + '/production.json',
            music_ref: musicRef,
            code_ref: codeRef
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
    // Scoped watch: the match is restricted to runs titled
    // "Stage B — <this job id>", so a second task's Stage B dispatch can
    // never be adopted as this task's run.
    findWorkflowRun(pushWatch({
      workflowFile: 'stage-b.yml',
      dispatchedAt: dispatchedAt,
      jobId: state.jobId
    }));
    startPolling();
  }

  el['restart-stage-b'].addEventListener('click', function () {
    this.disabled = true;
    restartStageB();
  });
  el['cancel-stage-b'].addEventListener('click', function () {
    this.disabled = true;
    cancelStageB();
  });

  /**
   * Restart Stage B = a BRAND-NEW Stage B run on the LATEST code, not a
   * replay of the old run.
   *
   * The GitHub Actions "re-run" API would re-execute the ORIGINAL run's
   * pinned commit — that is exactly the stale-code behavior this button
   * exists to avoid. So instead we dispatch a new workflow run and pin
   * its checkout to the branch's CURRENT tip SHA:
   *
   *   1. Resolve REF (the default branch) to its tip SHA RIGHT NOW, at
   *      click time — after any `git push` the user just made.
   *   2. Dispatch stage-b.yml on REF (the dispatch API only accepts a
   *      branch/tag ref, not a raw SHA — verified: SHA dispatch is 422),
   *      passing the freshly-resolved SHA as the `code_ref` input.
   *   3. stage-b.yml checks out `code_ref` (the SHA) instead of the
   *      dispatch ref, so the run is GUARANTEED to execute the newest
   *      code even if the branch-named dispatch raced the push.
   *
   * All job inputs (production.json, optional music.mp3, the original
   * video release asset) are looked up by the unchanged job_id, so the
   * restart reuses existing project state and Stage A is NOT re-run.
   */
  function persistedMusicRef(status) {
    // `null` means this is an older job without persisted music metadata, so
    // callers may use the historic uploaded-file fallback. An explicit empty
    // string is meaningful: the original job intentionally had no music.
    if (!status || !status.extra ||
        !Object.prototype.hasOwnProperty.call(status.extra, 'music_ref')) {
      return null;
    }
    return typeof status.extra.music_ref === 'string'
      ? status.extra.music_ref.trim()
      : '';
  }

  async function restartStageB() {
    if (state.busy || !state.jobId || isActiveStageBRun()) return;
    state.busy = true;
    renderStage();
    try {
      var base = '/repos/' + state.owner + '/' + state.repo + '/contents/jobs/' + encodeURIComponent(state.jobId);
      await gh(base + '/production.json?ref=' + REF + '&_=' + Date.now());

      // Stage B records its original `music_ref` in status.json as soon as
      // the run begins. Prefer that exact value: it preserves an audio-library
      // selection and also preserves an explicit no-music choice. Older jobs
      // without this metadata retain the established job-local upload fallback.
      var savedMusicRef = null;
      try {
        var statusFile = await gh(base + '/status.json?ref=' + REF + '&_=' + Date.now());
        savedMusicRef = persistedMusicRef(JSON.parse(b64decodeUtf8(statusFile.content)));
      } catch (statusErr) {
        if (statusErr.status !== 404) throw statusErr;
      }

      var musicRef = savedMusicRef;
      if (musicRef === null) {
        musicRef = '';
        try {
          await gh(base + '/music.mp3?ref=' + REF + '&_=' + Date.now());
          musicRef = 'path:jobs/' + state.jobId + '/music.mp3';
        } catch (musicErr) {
          if (musicErr.status !== 404) throw musicErr;
        }
      }

      // Resolve the branch to its CURRENT tip SHA at click time. Cache-bust
      // so a proxy never hands us a stale branch object.
      var codeRef = await resolveCurrentStageBCodeRef();

      var dispatchedAt = new Date();
      await gh('/repos/' + state.owner + '/' + state.repo + '/actions/workflows/stage-b.yml/dispatches', {
        method: 'POST', body: { ref: REF, inputs: {
          job_id: state.jobId,
          production_ref: 'path:jobs/' + state.jobId + '/production.json',
          music_ref: musicRef,
          code_ref: codeRef
        }}
      });
      state.stageBDispatched = true;
      state.cancellingStageB = false;
      state.stageBRun = { status: 'queued', conclusion: null };
      // Same title-scoped matching as a normal Stage B start, so a restart
      // of THIS task only ever adopts THIS task's new run.
      findWorkflowRun(pushWatch({
        workflowFile: 'stage-b.yml',
        dispatchedAt: dispatchedAt,
        jobId: state.jobId
      }));
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
    // Never cancel a run that is not a Stage B run for THIS task. The
    // stageBRun slot is only ever populated from a Stage-B-phase status
    // or a title-scoped Stage B lookup (see refreshStageBRun), but guard
    // defensively so a stale object can never target another task's run.
    var expectedTitle = 'Stage B — ' + state.jobId;
    if (state.stageBRun.display_title &&
        String(state.stageBRun.display_title) !== expectedTitle) return;
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

  /* --------------------------------------------------- tasks panel wiring */

  if (el['tasks-toggle']) {
    el['tasks-toggle'].addEventListener('click', function () {
      var open = el['tasks-toggle'].getAttribute('aria-expanded') === 'true';
      el['tasks-toggle'].setAttribute('aria-expanded', open ? 'false' : 'true');
      toggleHidden(el['tasks-body'], open);
    });
  }
  if (el['tasks-refresh']) {
    el['tasks-refresh'].addEventListener('click', function () {
      refreshTasksFromRepo({ silent: false });
    });
  }

  /* ------------------------------------------------------- deselect / resume */

  /**
   * "Deselect" — hide the detail panel for the current task WITHOUT
   * deleting anything. The task remains in the Tasks list above with its
   * own live status, its own expiration, and its own artifacts on
   * GitHub. Use the per-row Delete button to permanently remove a task.
   */
  function startOver() {
    clearActiveJob();
    hide(el['resume-offer']);
    setMsg(el['stage-a-msg'], 'Deselected. Pick another task above or start a new Stage A run.', null);
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
    loadTasksFromStorage();
    openSettings(!isConfigured());
    openRaw(false);

    // Render the Tasks list from the localStorage cache immediately so
    // the list is populated even before the first repo refresh returns.
    renderTasksList();

    if (!isConfigured()) return;

    probeRepo();
    loadWatermark();
    loadGeminiKeysMeta();
    loadZernioSettings();
    loadAudioLibrary();

    // Populate the Tasks list from the repo (source of truth) and then
    // keep it warm in the background. Every task is refreshed
    // independently — selecting or deleting one never blocks the others.
    refreshTasksFromRepo({ silent: true });
    startTasksTimer();

    var active = localStorage.getItem(LS.activeJob);
    if (active) {
      setActiveJob(active);
      // Seed the detail panel with the cached snapshot so it renders
      // instantly; the fresh copy arrives via startPolling().
      var entry = state.tasks[active];
      if (entry && entry.snapshot) state.status = entry.snapshot;
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
    // Also refresh the Tasks list so the operator returning to the tab
    // sees current state for every task, not just the selected one.
    if (isConfigured()) refreshTasksFromRepo({ silent: true });
  });

  boot();
})();
