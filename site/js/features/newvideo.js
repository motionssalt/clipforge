/**
 * New video view — task-03.
 * The Dashboard equivalent of the bot's /new wizard (source → focus →
 * length → music → confirm), using the exact classifySourceText logic
 * (site/js/wizard.js port) and the bot's startJob commit boundary:
 * Settings-owned series defaults, the telegram_channel main-account gate,
 * stage-a-request + queued status + stage-a.yml dispatch — all direct
 * GitHub reads/writes from the browser.
 */

import { getCredentials, escapeHtml, toast, ensureTaskLabel, setTaskOptions, formatBytes } from '../state.js';
import {
  isOriginalRepo, saveStageARequest, putTextFile, putBinaryFile, putBinaryFile as putBinary,
  currentBranchSha, dispatchWorkflow, STATUS_PATH, STAGE_A_WORKFLOW,
  readSeriesSettings, readSuperSeriesSettings, listAudioLibrary, tryGetJsonFile,
  MUSIC_DEFAULT_PATH, resolveMusicRef
} from '../github.js';
import {
  newWizard, wizardComplete, wizardToRequest, wizardSummaryLines, classifySourceText,
  describeSource, nextStep, previousStep, stepsFor, MAX_TORRENT_BYTES, TARGET_DURATIONS
} from '../wizard.js';

let wizard = null;

const LENGTH_LABELS = { 30: '30s', 60: '1 min', 120: '2 min', 180: '3 min', 300: '5 min' };

export async function renderNewVideo(app) {
  wizard = newWizard();
  const credentials = getCredentials();
  const main = isOriginalRepo(credentials.repo);

  // bug-50 / feature-01: series + super-series flags ride the Settings
  // defaults, decided at the COMMIT boundary (startJob) — but the wizard's
  // focus-step skipping depends on them, so read them up-front for display.
  const [seriesSettings, superSettings] = await Promise.all([
    readSeriesSettings(credentials, credentials.repo).catch(() => null),
    readSuperSeriesSettings(credentials, credentials.repo).catch(() => null)
  ]);
  wizard.series = Boolean(seriesSettings && seriesSettings.enabled === true);
  wizard.superSeries = wizard.series === true && Boolean(superSettings && superSettings.enabled === true);

  await renderStep(app, main);
}

async function renderStep(app, mainAccount) {
  const credentials = getCredentials();
  const steps = stepsFor(wizard);
  const index = steps.indexOf(wizard.step);
  const progress = `Step ${index + 1}/${steps.length}`;

  let body = '';
  if (wizard.step === 'source') {
    body = `
      <p class="muted">Paste a direct video link, Google Drive link, magnet URI, or a public
      <span class="mono">t.me</span> channel-post link${mainAccount ? '' : ' (main account only)'} — or upload a
      <span class="mono">.torrent</span> file (≤ 1 MB). The source type is detected automatically.</p>
      <label class="field">Source link / magnet URI</label>
      <textarea id="src-text" rows="3" placeholder="https://… · magnet:?… · https://t.me/channel/123"></textarea>
      <div class="btn-row">
        <button type="button" class="primary" id="src-accept">Use this source</button>
        <button type="button" id="src-torrent">Upload .torrent file</button>
      </div>
      <input type="file" id="src-torrent-file" accept=".torrent,application/x-bittorrent" class="hidden">
      <div id="src-feedback"></div>
      ${wizard.series ? `<p class="muted small">Series Mode is on${wizard.superSeries ? ' with Super Series' : ''} (Settings default) — this task becomes Part 1.</p>` : ''}
      ${mainAccount ? '' : '<p class="muted small">Telegram channel sources are only available on the main ClipForge repo.</p>'}`;
  } else if (wizard.step === 'focus') {
    body = `
      <p class="muted">Optionally narrow the analysis to one thread (e.g. <i>the trial cross-examination</i>),
      or leave empty for the whole video.</p>
      <label class="field">Focus (optional)</label>
      <input type="text" id="focus-input" autocomplete="off" placeholder="whole video" value="${escapeHtml(wizard.focus)}">
      <div class="btn-row"><button type="button" class="primary" id="focus-next">Next</button></div>`;
  } else if (wizard.step === 'length') {
    body = `
      <p class="muted">Pick the target spoken-narration length (pacing only — footage runs as long as each scene needs).</p>
      <div class="btn-row wrap" id="length-row">
        ${TARGET_DURATIONS.map((s) => `<button type="button" data-dur="${s}" class="${wizard.duration === s ? 'primary' : ''}">${LENGTH_LABELS[s] || `${s}s`}</button>`).join('')}
      </div>`;
  } else if (wizard.step === 'music') {
    body = `
      <p class="muted">Background music for the final render.</p>
      <div class="btn-row wrap">
        <button type="button" id="music-none" class="${wizard.music && wizard.music.source === 'none' ? 'primary' : ''}">No music</button>
        <button type="button" id="music-default" class="${wizard.music && wizard.music.source === 'default' ? 'primary' : ''}">Use saved default</button>
        <button type="button" id="music-library" class="${wizard.music && wizard.music.source === 'explicit_library' ? 'primary' : ''}">Choose library track</button>
      </div>
      <div id="music-detail" class="stack"></div>`;
  } else if (wizard.step === 'confirm') {
    body = `
      <p class="muted">Review and start. Job id: <span class="mono">${escapeHtml(wizard.jobId)}</span></p>
      <pre class="summary">${wizardSummaryLines(wizard).map(escapeHtml).join('\n')}</pre>
      <div class="btn-row"><button type="button" class="primary" id="confirm-start">▶ Start Stage A</button></div>
      <div id="confirm-progress"></div>`;
  }

  app.innerHTML = `
    <div class="card">
      <h2>New video — ${escapeHtml(wizard.step)} <span class="muted small">(${progress})</span></h2>
      ${body}
      <div class="btn-row">
        ${index > 0 ? '<button type="button" id="wz-back">Back</button>' : ''}
        <a class="btn ghost" href="#/home">Cancel</a>
      </div>
    </div>`;

  wire(app, mainAccount);
}

function wire(app, mainAccount) {
  const credentials = getCredentials();

  const back = document.getElementById('wz-back');
  if (back) back.addEventListener('click', async () => {
    wizard.step = previousStep(wizard);
    await renderStep(app, mainAccount);
  });

  if (wizard.step === 'source') {
    const feedback = (html, kind) => {
      const el = document.getElementById('src-feedback');
      el.innerHTML = `<p class="${kind === 'err' ? 'error-text' : 'muted'}">${html}</p>`;
    };
    const accept = (result) => {
      if (result.error) { feedback(escapeHtml(result.error), 'err'); return; }
      if (result.kind === 'telegram_channel' && !mainAccount) {
        feedback('Telegram channel sources are only available on the main ClipForge repo. Pick a different source.', 'err');
        return;
      }
      wizard.source = result;
      feedback(`✔ Detected: <b>${escapeHtml(result.kind)}</b> — ${escapeHtml(describeSource(result))}`, 'ok');
      setTimeout(async () => { wizard.step = nextStep(wizard); await renderStep(app, mainAccount); }, 450);
    };
    document.getElementById('src-accept').addEventListener('click', () => {
      accept(classifySourceText(document.getElementById('src-text').value));
    });
    const fileInput = document.getElementById('src-torrent-file');
    document.getElementById('src-torrent').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size <= 0 || file.size > MAX_TORRENT_BYTES) {
        feedback('The .torrent file must be non-empty and no larger than 1 MB.', 'err');
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = `jobs/${wizard.jobId}/source.torrent`;
        feedback('Uploading source.torrent…', 'ok');
        await putBinaryFile(credentials, credentials.repo, path, bytes,
          `clipforge: torrent source for job ${wizard.jobId}`);
        wizard.source = { kind: 'torrent_file', value: `path:${path}`, fileName: String(file.name || 'source.torrent') };
        feedback(`✔ Detected: <b>torrent_file</b> — ${escapeHtml(describeSource(wizard.source))} (${formatBytes(file.size)})`, 'ok');
        setTimeout(async () => { wizard.step = nextStep(wizard); await renderStep(app, mainAccount); }, 450);
      } catch (error) {
        feedback(escapeHtml(error.message || 'Upload failed.'), 'err');
      }
    });
  }

  if (wizard.step === 'focus') {
    const next = async () => {
      wizard.focus = document.getElementById('focus-input').value.trim();
      wizard.step = nextStep(wizard);
      await renderStep(app, mainAccount);
    };
    document.getElementById('focus-next').addEventListener('click', next);
    document.getElementById('focus-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') next(); });
  }

  if (wizard.step === 'length') {
    for (const btn of document.querySelectorAll('#length-row button')) {
      btn.addEventListener('click', async () => {
        wizard.duration = Number(btn.dataset.dur);
        wizard.step = nextStep(wizard);
        await renderStep(app, mainAccount);
      });
    }
  }

  if (wizard.step === 'music') {
    const pick = async (music) => {
      wizard.music = music;
      wizard.step = nextStep(wizard);
      await renderStep(app, mainAccount);
    };
    document.getElementById('music-none').addEventListener('click', () => pick({ ref: '', source: 'none' }));
    document.getElementById('music-default').addEventListener('click', async () => {
      // Correct default-track resolution: the saved default must actually exist.
      const doc = await tryGetJsonFile(credentials, credentials.repo, MUSIC_DEFAULT_PATH).catch(() => null);
      const path = doc && doc.document && doc.document.library_track_path ? String(doc.document.library_track_path) : '';
      if (!path) {
        toast('No default track saved yet — set one in Settings → Music library.', 'err');
        return;
      }
      const tracks = await listAudioLibrary(credentials, credentials.repo);
      if (!tracks.some((t) => t.path === path)) {
        toast(`Saved default ${path} is missing from the library — pick another track or fix the default in Settings.`, 'err');
        return;
      }
      pick({ ref: path, source: 'default' });
    });
    document.getElementById('music-library').addEventListener('click', async () => {
      const detail = document.getElementById('music-detail');
      detail.innerHTML = '<p class="muted">Loading library…</p>';
      const tracks = await listAudioLibrary(credentials, credentials.repo);
      if (!tracks.length) {
        detail.innerHTML = '<p class="muted">Library is empty — add tracks in Settings → Music library.</p>';
        return;
      }
      detail.innerHTML = `<div class="list">${tracks.map((t) => `
        <div class="list-row">
          <span>${escapeHtml(t.name)} <span class="muted small">${formatBytes(t.size)}</span></span>
          <button type="button" class="primary small" data-track="${escapeHtml(t.path)}">Select</button>
        </div>`).join('')}</div>`;
      for (const btn of detail.querySelectorAll('button[data-track]')) {
        btn.addEventListener('click', () => pick({ ref: btn.dataset.track, source: 'explicit_library' }));
      }
    });
  }

  if (wizard.step === 'confirm') {
    document.getElementById('confirm-start').addEventListener('click', async () => {
      const btn = document.getElementById('confirm-start');
      const progress = document.getElementById('confirm-progress');
      btn.disabled = true;
      progress.innerHTML = '<div class="progress-track"><div class="progress-fill indeterminate"></div></div>';
      try {
        // --- bot startJob commit boundary, verbatim semantics ------------- //
        if (!wizardComplete(wizard)) throw new Error('The wizard is incomplete — walk it through again.');

        // Re-read the Settings defaults at commit time (they are the single
        // source of truth; the wizard flags were only a display preview).
        const [seriesSettings, superSettings] = await Promise.all([
          readSeriesSettings(credentials, credentials.repo).catch(() => null),
          readSuperSeriesSettings(credentials, credentials.repo).catch(() => null)
        ]);
        wizard.series = Boolean(seriesSettings && seriesSettings.enabled === true);
        wizard.superSeries = wizard.series === true && Boolean(superSettings && superSettings.enabled === true);

        // §9.1 clone gate, defensive re-check at the commit boundary.
        if (wizard.source.kind === 'telegram_channel' && !isOriginalRepo(credentials.repo)) {
          throw new Error('Telegram channel sources are only available on the original ClipForge repo.');
        }

        const jobId = wizard.jobId;
        const seriesId = wizard.series ? `series-${Date.now()}` : '';
        const request = wizardToRequest(wizard, seriesId);
        await saveStageARequest(credentials, credentials.repo, jobId, request);

        const now = Math.floor(Date.now() / 1000);
        const status = {
          version: 1,
          job_id: jobId,
          mode: 'manual',
          state: 'queued',
          message: 'Stage A dispatched — ingest will begin shortly.',
          created_at_epoch: now,
          updated_at_epoch: now,
          expires_at_epoch: now + 172800,
          release_tag: `clipforge-${jobId}`,
          release_url: `https://github.com/${credentials.repo}/releases/tag/clipforge-${jobId}`
        };
        if (request.series.enabled) {
          status.series = {
            enabled: true,
            series_id: request.series.series_id,
            part: request.series.part,
            start_seconds: request.series.start_seconds,
            is_final: false
          };
        }
        await putTextFile(credentials, credentials.repo, STATUS_PATH(jobId),
          `${JSON.stringify(status, null, 2)}\n`, `clipforge: create job ${jobId}`);

        const codeRef = await currentBranchSha(credentials, credentials.repo);
        await dispatchWorkflow(credentials, credentials.repo, STAGE_A_WORKFLOW, { job_id: jobId, code_ref: codeRef });

        const label = ensureTaskLabel(jobId);
        setTaskOptions(jobId, { mode: 'manual', source_kind: wizard.source.kind });
        toast(`Stage A dispatched for task ${label}.`, 'ok');
        location.hash = `#/task/${encodeURIComponent(jobId)}`;
      } catch (error) {
        btn.disabled = false;
        progress.innerHTML = `<p class="error-text">${escapeHtml(error.message || String(error))}</p>`;
      }
    });
  }
}
