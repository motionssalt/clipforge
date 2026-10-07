/**
 * New video view — Multi-step Video Creation Studio.
 * Features live YouTube oEmbed previews, duration chips, focus prompts,
 * audio library previews, and one-click GitHub Actions dispatch.
 */
import { getCredentials, escapeHtml, toast, ensureTaskLabel, setTaskOptions, formatBytes } from '../state.js';
import {
  isOriginalRepo, saveStageARequest, putTextFile, putBinaryFile,
  currentBranchSha, dispatchWorkflow, STATUS_PATH, STAGE_A_WORKFLOW,
  readSeriesSettings, readSuperSeriesSettings, listAudioLibrary, tryGetJsonFile,
  MUSIC_DEFAULT_PATH, resolveMusicRef
} from '../github.js';
import {
  newWizard, wizardComplete, wizardToRequest, wizardSummaryLines, classifySourceText,
  describeSource, nextStep, previousStep, stepsFor, MAX_TORRENT_BYTES, TARGET_DURATIONS
} from '../wizard.js';

let wizard = null;

const LENGTH_DETAILS = {
  30: { label: '30s', badge: 'Hook / Teaser', desc: 'High-energy 30-second teaser clip' },
  60: { label: '1 min', badge: 'Shorts / TikTok', desc: 'Optimized 60-second recap for TikTok & Reels' },
  120: { label: '2 min', badge: 'Standard Narrative', desc: 'Standard story narrative recap (Recommended)' },
  180: { label: '3 min', badge: 'Extended Coverage', desc: 'Detailed narrative breakdown with key twists' },
  300: { label: '5 min', badge: 'Deep Dive', desc: 'Complete comprehensive episode coverage' }
};

const PROMPT_SUGGESTIONS = [
  'Focus on dramatic plot twists and high-stakes moments.',
  'Fast-paced action recap emphasizing key conflicts.',
  'Cinematic breakdown highlighting character motivations.',
  'Build suspense toward the final revelation and climax.',
  'Analyze critical story arcs and unexpected decisions.'
];

export async function renderNewVideo(app) {
  wizard = newWizard();
  const credentials = getCredentials();
  const main = isOriginalRepo(credentials.repo);

  const [seriesSettings, superSettings] = await Promise.all([
    readSeriesSettings(credentials, credentials.repo).catch(() => null),
    readSuperSeriesSettings(credentials, credentials.repo).catch(() => null)
  ]);
  wizard.series = Boolean(seriesSettings && seriesSettings.enabled === true);
  wizard.superSeries = wizard.series === true && Boolean(superSettings && superSettings.enabled === true);

  await renderStep(app, main);
}

function renderStepper(currentStep, allSteps) {
  const currentIdx = allSteps.indexOf(currentStep);
  const stepLabels = {
    source: 'Media Source',
    focus: 'Narrative Focus',
    length: 'Video Length',
    music: 'Soundtrack',
    confirm: 'Review & Launch'
  };

  return `
    <div class="stepper-bar">
      <div class="stepper-track-line"></div>
      ${allSteps.map((s, idx) => {
        const isDone = idx < currentIdx;
        const isActive = idx === currentIdx;
        const statusClass = isDone ? 'completed' : (isActive ? 'active' : 'pending');
        const glyph = isDone ? '✓' : String(idx + 1);
        return `
          <div class="stepper-step ${statusClass}">
            <div class="stepper-bullet">${glyph}</div>
            <div class="stepper-label">${stepLabels[s] || s}</div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

async function fetchYoutubeOembed(url) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function renderStep(app, mainAccount) {
  const credentials = getCredentials();
  const steps = stepsFor(wizard);
  const index = steps.indexOf(wizard.step);

  let body = '';

  if (wizard.step === 'source') {
    body = `
      <div class="wizard-pane">
        <p class="muted" style="margin-bottom: 20px;">
          Choose your input media source. ClipForge accepts <b>public YouTube video links</b>, direct video URLs (MP4/MKV), Google Drive links, torrent magnets, or <span class="mono">.torrent</span> files.
        </p>

        <div class="form-group">
          <label class="field" for="src-text">
            Video Link or Magnet URI
            <span class="hint">Paste a link to any public YouTube video, Google Drive file, or direct video</span>
          </label>
          <textarea id="src-text" class="input-modern" rows="3" placeholder="https://www.youtube.com/watch?v=… · https://youtu.be/… · https://…/video.mp4 · magnet:?…">${escapeHtml(wizard.source && wizard.source.value ? wizard.source.value : '')}</textarea>
        </div>

        <div id="src-preview-card" style="margin-top: 14px;"></div>
        <div id="src-live-badge" style="margin-top: 10px;"></div>

        <div class="source-kinds-guide">
          <div class="source-guide-card">
            <span class="guide-icon">🔴</span>
            <div>
              <b>YouTube Videos</b>
              <div class="muted small">Public videos & Shorts (e.g. <code>youtube.com/watch?v=…</code>). Playlists and radio mix parameters stripped automatically.</div>
            </div>
          </div>
          <div class="source-guide-card">
            <span class="guide-icon">📁</span>
            <div>
              <b>Direct Video & Drive</b>
              <div class="muted small">Direct HTTPS links to MP4/MKV files, or public Google Drive share links.</div>
            </div>
          </div>
          <div class="source-guide-card">
            <span class="guide-icon">🧲</span>
            <div>
              <b>Torrent & Magnet</b>
              <div class="muted small">Magnet URIs or upload a <span class="mono">.torrent</span> file directly below.</div>
            </div>
          </div>
        </div>

        <div class="btn-row" style="margin-top: 24px;">
          <button type="button" class="btn btn-primary" id="src-accept">
            <span>Continue with URL</span> →
          </button>
          <label class="btn btn-secondary" id="src-torrent-label" style="cursor:pointer; margin:0;">
            <span>📁 Upload .torrent File</span>
            <input type="file" id="src-torrent-file" accept=".torrent" style="display:none;">
          </label>
        </div>
      </div>
    `;
  }

  if (wizard.step === 'focus') {
    body = `
      <div class="wizard-pane">
        <p class="muted">
          Tell ClipForge what story or scenes to emphasize during Whisper transcription analysis and AI video cut generation.
        </p>

        <div class="form-group" style="margin: 18px 0;">
          <label class="field" for="focus-input">
            Narrative Focus & Editorial Guidance
            <span class="hint">Optional — leave blank for natural balanced story progression</span>
          </label>
          <textarea id="focus-input" class="input-modern" rows="4" placeholder="e.g. Focus on the final battle, high-stakes revelations, and character reactions…">${escapeHtml(wizard.focus || '')}</textarea>
        </div>

        <div style="margin: 16px 0;">
          <div class="muted small" style="font-weight:600; margin-bottom:8px;">💡 Quick Prompt Suggestions (click to add):</div>
          <div class="suggestion-chips">
            ${PROMPT_SUGGESTIONS.map(p => `
              <button type="button" class="chip" data-prompt="${escapeHtml(p)}">${escapeHtml(p)}</button>
            `).join('')}
          </div>
        </div>

        <div class="btn-row" style="margin-top: 28px;">
          <button type="button" class="btn btn-primary" id="focus-next">Next: Video Length →</button>
          <button type="button" class="btn btn-ghost" id="step-back">Back</button>
        </div>
      </div>
    `;
  }

  if (wizard.step === 'length') {
    body = `
      <div class="wizard-pane">
        <p class="muted">Select the target video duration for this clip.</p>
        <div class="length-grid" id="length-grid" style="margin-top: 20px;">
          ${TARGET_DURATIONS.map((dur) => {
            const meta = LENGTH_DETAILS[dur] || { label: `${dur}s`, badge: 'Custom', desc: '' };
            const isSelected = wizard.duration === dur;
            return `
              <div class="length-card ${isSelected ? 'selected' : ''}" data-dur="${dur}">
                <div class="length-header">
                  <div class="length-val">${meta.label}</div>
                  <span class="badge ${isSelected ? 'badge-accent' : 'badge-subtle'}">${meta.badge}</span>
                </div>
                <div class="length-desc muted small">${meta.desc}</div>
              </div>`;
          }).join('')}
        </div>

        <div class="btn-row" style="margin-top: 28px;">
          <button type="button" class="btn btn-ghost" id="step-back">Back</button>
        </div>
      </div>
    `;
  }

  if (wizard.step === 'music') {
    body = `
      <div class="wizard-pane">
        <p class="muted">Configure background music and soundtrack mix for the final video render.</p>

        <div class="music-options-grid" style="margin-top: 20px;">
          <div class="music-choice-card" id="music-none">
            <div class="music-icon">🔇</div>
            <div class="music-choice-title">Voice Only (No Music)</div>
            <div class="muted small">Only the original audio and Edge-TTS narration will play.</div>
          </div>

          <div class="music-choice-card" id="music-default">
            <div class="music-icon">⭐</div>
            <div class="music-choice-title">Use Saved Default</div>
            <div class="muted small">Applies the soundtrack configured in Settings → Music Library.</div>
          </div>

          <div class="music-choice-card" id="music-library">
            <div class="music-icon">🎵</div>
            <div class="music-choice-title">Choose from Audio Library</div>
            <div class="muted small">Pick a specific uploaded track from your repository.</div>
          </div>
        </div>

        <div id="music-detail" style="margin-top: 20px;"></div>

        <div class="btn-row" style="margin-top: 28px;">
          <button type="button" class="btn btn-ghost" id="step-back">Back</button>
        </div>
      </div>
    `;
  }

  if (wizard.step === 'confirm') {
    const durMeta = LENGTH_DETAILS[wizard.duration] || { label: `${wizard.duration}s` };

    body = `
      <div class="wizard-pane">
        <p class="muted">Review your configuration before launching Stage A on GitHub Actions.</p>

        <div class="review-box" style="margin-top: 20px;">
          <div class="review-item">
            <div class="review-label">Job Identifier</div>
            <div class="review-val mono" style="color:var(--accent); font-weight:700;">${escapeHtml(wizard.jobId)}</div>
          </div>

          <div class="review-item">
            <div class="review-label">Media Source</div>
            <div class="review-val">
              <span class="badge badge-accent">${escapeHtml(wizard.source ? wizard.source.kind : '')}</span>
              <div class="muted small" style="margin-top:4px; word-break:break-all;">${escapeHtml(wizard.source ? wizard.source.value : '')}</div>
            </div>
          </div>

          <div class="review-item">
            <div class="review-label">Target Length</div>
            <div class="review-val">${durMeta.label} (${durMeta.badge || 'Recap'})</div>
          </div>

          <div class="review-item">
            <div class="review-label">Editorial Focus</div>
            <div class="review-val">${escapeHtml(wizard.focus || '(Natural balanced story progression)')}</div>
          </div>

          <div class="review-item">
            <div class="review-label">Soundtrack</div>
            <div class="review-val">
              ${wizard.music.source === 'none' ? '🔇 Voice only (no music)' : (wizard.music.source === 'default' ? '⭐ Saved default soundtrack' : `🎵 ${escapeHtml(wizard.music.ref || 'Custom track')}`)}
            </div>
          </div>

          <div class="review-item">
            <div class="review-label">Pipeline Execution</div>
            <div class="review-val">
              ${wizard.series ? (wizard.superSeries ? '⚡ Super Series (automated multi-part chain)' : '📺 Series Mode (Part 1)') : 'Single Video'}
            </div>
          </div>
        </div>

        <div id="confirm-progress" style="margin-top: 20px;"></div>

        <div class="btn-row" style="margin-top: 24px;">
          <button type="button" class="btn btn-primary" id="confirm-start" style="padding: 12px 32px; font-size:15px;">
            <span>🚀</span> Launch Video Pipeline
          </button>
          <button type="button" class="btn btn-ghost" id="step-back">Back</button>
        </div>
      </div>
    `;
  }

  app.innerHTML = `
    <div class="card card-elevated" style="max-width: 820px; margin: 0 auto;">
      <div class="card-header-row" style="margin-bottom: 24px;">
        <div>
          <h2>Create New Video</h2>
          <p class="muted small" style="margin-top:2px;">Job ID: <span class="mono">${escapeHtml(wizard.jobId)}</span></p>
        </div>
        <a class="btn btn-ghost btn-small" href="#/home">✕ Cancel</a>
      </div>

      ${renderStepper(wizard.step, steps)}
      ${body}
    </div>
  `;

  // Attach navigation events
  const backBtn = document.getElementById('step-back');
  if (backBtn) {
    backBtn.addEventListener('click', async () => {
      wizard.step = previousStep(wizard);
      await renderStep(app, mainAccount);
    });
  }

  // --- Step 1: Source ---
  if (wizard.step === 'source') {
    const srcInput = document.getElementById('src-text');
    const badge = document.getElementById('src-live-badge');
    const previewArea = document.getElementById('src-preview-card');

    let debounceTimer = null;

    const checkInput = async () => {
      const text = srcInput.value.trim();
      if (!text) {
        badge.innerHTML = '';
        previewArea.innerHTML = '';
        return;
      }

      const res = classifySourceText(text);
      if (res.kind === 'unknown') {
        badge.innerHTML = `<span class="badge badge-warn">⚠ ${escapeHtml(res.error || 'Unrecognized source link')}</span>`;
        previewArea.innerHTML = '';
      } else {
        badge.innerHTML = `<span class="badge badge-ok">✔ Detected ${escapeHtml(res.kind)} source</span>`;

        if (res.kind === 'youtube') {
          // Fetch YouTube oEmbed for live preview card!
          previewArea.innerHTML = `<div class="muted small"><span class="spinner" style="width:12px;height:12px;"></span> Loading YouTube preview…</div>`;
          const meta = await fetchYoutubeOembed(res.value);
          if (meta && meta.title) {
            previewArea.innerHTML = `
              <div class="youtube-preview-card">
                <img class="yt-thumb" src="${escapeHtml(meta.thumbnail_url)}" alt="Thumbnail">
                <div class="yt-info">
                  <div class="yt-title">${escapeHtml(meta.title)}</div>
                  <div class="yt-author muted small">${escapeHtml(meta.author_name || '')} · YouTube</div>
                  <span class="badge badge-ok" style="margin-top:6px;">Ready to ingest</span>
                </div>
              </div>
            `;
          } else {
            previewArea.innerHTML = '';
          }
        } else {
          previewArea.innerHTML = '';
        }
      }
    };

    srcInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(checkInput, 400);
    });

    if (srcInput.value.trim()) {
      checkInput();
    }

    const accept = (result) => {
      if (result.kind === 'unknown') {
        toast(result.error || 'Unrecognized source link.', 'err');
        return;
      }
      if (result.kind === 'telegram_channel' && !mainAccount) {
        toast('Telegram channel sources are only available on the main ClipForge repo.', 'err');
        return;
      }
      wizard.source = result;
      toast(`Source ready: ${result.kind}`, 'ok');
      wizard.step = nextStep(wizard);
      renderStep(app, mainAccount);
    };

    document.getElementById('src-accept').addEventListener('click', () => {
      accept(classifySourceText(srcInput.value));
    });

    const fileInput = document.getElementById('src-torrent-file');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size <= 0 || file.size > MAX_TORRENT_BYTES) {
        toast('The .torrent file must be non-empty and no larger than 1 MB.', 'err');
        return;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const path = `jobs/${wizard.jobId}/source.torrent`;
        toast('Uploading source.torrent to GitHub…', 'ok');
        await putBinaryFile(credentials, credentials.repo, path, bytes,
          `clipforge: torrent source for job ${wizard.jobId}`);
        wizard.source = { kind: 'torrent_file', value: `path:${path}`, fileName: String(file.name || 'source.torrent') };
        wizard.step = nextStep(wizard);
        await renderStep(app, mainAccount);
      } catch (error) {
        toast(error.message || 'Upload failed.', 'err');
      }
    });
  }

  // --- Step 2: Focus ---
  if (wizard.step === 'focus') {
    const focusInput = document.getElementById('focus-input');

    for (const chip of app.querySelectorAll('[data-prompt]')) {
      chip.addEventListener('click', () => {
        const p = chip.dataset.prompt;
        const current = focusInput.value.trim();
        focusInput.value = current ? `${current} ${p}` : p;
      });
    }

    document.getElementById('focus-next').addEventListener('click', async () => {
      wizard.focus = focusInput.value.trim();
      wizard.step = nextStep(wizard);
      await renderStep(app, mainAccount);
    });
  }

  // --- Step 3: Length ---
  if (wizard.step === 'length') {
    for (const card of app.querySelectorAll('#length-grid [data-dur]')) {
      card.addEventListener('click', async () => {
        wizard.duration = Number(card.dataset.dur);
        wizard.step = nextStep(wizard);
        await renderStep(app, mainAccount);
      });
    }
  }

  // --- Step 4: Music ---
  if (wizard.step === 'music') {
    const detail = document.getElementById('music-detail');

    document.getElementById('music-none').addEventListener('click', async () => {
      wizard.music = { source: 'none', ref: '' };
      wizard.step = nextStep(wizard);
      await renderStep(app, mainAccount);
    });

    document.getElementById('music-default').addEventListener('click', async () => {
      const def = await tryGetJsonFile(credentials, credentials.repo, MUSIC_DEFAULT_PATH).catch(() => null);
      const track = def && def.document && def.document.library_track_path ? def.document.library_track_path : '';
      wizard.music = { source: 'default', ref: track };
      wizard.step = nextStep(wizard);
      await renderStep(app, mainAccount);
    });

    document.getElementById('music-library').addEventListener('click', async () => {
      detail.innerHTML = `<div class="card card-subtle" style="padding:16px;"><span class="spinner"></span> Loading audio library…</div>`;
      const tracks = await listAudioLibrary(credentials, credentials.repo).catch(() => []);
      if (!tracks.length) {
        detail.innerHTML = `<div class="info-callout">No soundtrack tracks in your library yet. Upload tracks in <b>Settings → Music Library</b>, or choose "No music" / "Use saved default".</div>`;
        return;
      }
      detail.innerHTML = `
        <div class="card card-subtle" style="padding:16px;">
          <label class="field">Select Library Track</label>
          <select id="music-select" class="input-modern">
            ${tracks.map((t) => `<option value="${escapeHtml(t.path)}">${escapeHtml(t.name)} (${formatBytes(t.size)})</option>`).join('')}
          </select>
          <div class="btn-row" style="margin-top:14px;">
            <button type="button" class="btn btn-primary btn-small" id="music-pick">Select Track & Continue →</button>
          </div>
        </div>`;

      document.getElementById('music-pick').addEventListener('click', async () => {
        const sel = document.getElementById('music-select').value;
        wizard.music = { source: 'explicit_library', ref: sel };
        wizard.step = nextStep(wizard);
        await renderStep(app, mainAccount);
      });
    });
  }

  // --- Step 5: Confirm & Launch ---
  if (wizard.step === 'confirm') {
    document.getElementById('confirm-start').addEventListener('click', async () => {
      const btn = document.getElementById('confirm-start');
      const progress = document.getElementById('confirm-progress');
      btn.disabled = true;
      progress.innerHTML = '<div class="progress-track"><div class="progress-fill indeterminate"></div></div><p class="muted small" style="margin-top:8px;">Dispatching Stage A pipeline on GitHub Actions…</p>';

      try {
        if (!wizardComplete(wizard)) throw new Error('The wizard is incomplete — please walk through all steps.');

        const [seriesSettings, superSettings] = await Promise.all([
          readSeriesSettings(credentials, credentials.repo).catch(() => null),
          readSuperSeriesSettings(credentials, credentials.repo).catch(() => null)
        ]);
        wizard.series = Boolean(seriesSettings && seriesSettings.enabled === true);
        wizard.superSeries = wizard.series === true && Boolean(superSettings && superSettings.enabled === true);

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

        if (request.series && request.series.enabled) {
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

        ensureTaskLabel(jobId);
        setTaskOptions(jobId, {
          mode: 'manual',
          source_kind: wizard.source.kind,
          series_enabled: wizard.series,
          super_series: wizard.superSeries
        });

        const sha = await currentBranchSha(credentials, credentials.repo);
        await dispatchWorkflow(credentials, credentials.repo, STAGE_A_WORKFLOW, { job_id: jobId, code_ref: sha });

        toast(`🚀 Job ${jobId} dispatched to GitHub Actions!`, 'ok');
        location.hash = `#/task/${encodeURIComponent(jobId)}`;
      } catch (error) {
        btn.disabled = false;
        progress.innerHTML = `<div class="error-callout">${escapeHtml(error.message || String(error))}</div>`;
      }
    });
  }
}
