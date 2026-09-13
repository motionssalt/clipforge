/**
 * ClipForge Dashboard — New-video wizard logic.
 * EXACT port of bot/src/wizard.js's classification + request projection
 * (classifySourceText, wizardToRequest, describe*) — the Dashboard owns
 * this logic itself; nothing calls into bot code. The Telegram-specific
 * stateless-token machinery (encodeWizardToken/decodeWizardToken) is NOT
 * ported: the Dashboard keeps the wizard in plain client state.
 *
 * Source kinds: url, drive, magnet, torrent_file, telegram_channel
 * (main-account only, gated at the commit boundary and in the UI).
 * telegram_relay is intentionally ABSENT — the relay path is removed.
 */

export const STEPS = ['source', 'focus', 'length', 'music', 'confirm'];

export const TARGET_DURATIONS = [30, 60, 120, 180, 300];

// §5 "Deliberately disabled" hosts — rejected at intake with a helpful
// message (ported verbatim).
export const DISABLED_SOCIAL_HOSTS = [
  'youtube-nocookie.com', 'youtu.be', 'youtube.com',
  'vm.tiktok.com', 'vt.tiktok.com', 'tiktok.com',
  'fb.watch', 'facebook.com', 'instagram.com',
  'twitter.com', 'x.com', 'vimeo.com', 'redd.it', 'reddit.com'
];

export const TELEGRAM_PUBLIC_POST_RE = /^https?:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?[A-Za-z0-9_]{5,64}\/[1-9][0-9]*(?:[/?#]|$)/i;
const DRIVE_RE = /^https?:\/\/(?:drive|docs)\.google\.com\//i;
const URL_RE = /^https?:\/\//i;
const MAGNET_RE = /^magnet:\?/i;

export const MAX_TORRENT_BYTES = 1024 * 1024; // §5: .torrent uploads ≤ 1 MB

export function newWizard() {
  return {
    step: 'source',
    jobId: `manual-${Date.now()}`, // assigned up-front (needed for torrent upload paths)
    mode: 'manual',
    series: false,      // bug-50: applied from Settings default at commit time
    superSeries: false, // feature-01: idem, and only meaningful when series on
    source: null,       // { kind, value } | { kind: 'torrent_file', value, fileName }
    focus: '',
    duration: null,
    music: null         // { ref, source } — source: none | default | explicit_library
  };
}

export function stepsFor(wizard) {
  return STEPS.filter((step) => !(step === 'focus' && wizard && wizard.series === true));
}

export function nextStep(wizard) {
  const order = stepsFor(wizard);
  const index = order.indexOf(wizard.step);
  return order[Math.min(index + 1, order.length - 1)];
}

export function previousStep(wizard) {
  const order = stepsFor(wizard);
  const index = order.indexOf(wizard.step);
  return order[Math.max(index - 1, 0)];
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * Classify a text message sent at the source step into a §5 source kind.
 * Returns { kind, value } or { error }. Ported verbatim.
 */
export function classifySourceText(text) {
  const value = String(text || '').trim();
  if (!value) return { error: 'Paste a direct link, a magnet URI, or upload a .torrent file.' };
  if (MAGNET_RE.test(value)) return { kind: 'magnet', value };
  if (TELEGRAM_PUBLIC_POST_RE.test(value)) return { kind: 'telegram_channel', value };
  if (URL_RE.test(value)) {
    const host = hostOf(value);
    const blocked = DISABLED_SOCIAL_HOSTS.find((entry) => host === entry || host.endsWith(`.${entry}`));
    if (blocked) {
      return {
        error: `Links from ${blocked} are not supported. Put the video on a public Telegram channel and paste the t.me link (main account only), or use a direct file link.`
      };
    }
    if (DRIVE_RE.test(value)) return { kind: 'drive', value };
    return { kind: 'url', value };
  }
  return {
    error: 'That does not look like a supported source. Paste a direct video URL (https://…), a Google Drive link, a magnet URI, a public t.me channel-post link, or upload a .torrent file.'
  };
}

/** Human-readable one-liner for the confirm screen. */
export function describeSource(source) {
  if (!source) return '—';
  switch (source.kind) {
    case 'url': return `Direct link: ${source.value}`;
    case 'drive': return `Google Drive: ${source.value}`;
    case 'magnet': return 'Magnet URI';
    case 'torrent_file': return `.torrent file: ${source.fileName || 'source.torrent'}`;
    case 'telegram_channel': return `Telegram channel post: ${source.value}`;
    default: return String(source.kind || '—');
  }
}

export function describeMusic(music) {
  if (!music || music.source === 'none') return 'No music';
  if (music.source === 'default') return 'Saved default track';
  if (music.source === 'explicit_library') return `Library track: ${String(music.ref || '').replace(/^audio-library\//, '')}`;
  return '—';
}

export function describeMode(wizard) {
  const base = 'Manual (your external AI writes the plan)';
  if (!wizard.series) return base;
  return wizard.superSeries === true ? `${base} · Series on · Super Series on` : `${base} · Series on`;
}

/** True when every wizard choice has been made and Start may run. */
export function wizardComplete(wizard) {
  return Boolean(
    wizard &&
    wizard.mode &&
    wizard.source &&
    wizard.duration &&
    wizard.music &&
    wizard.jobId
  );
}

/** Summary lines for the confirm screen (§8.4 step 6). */
export function wizardSummaryLines(wizard) {
  const lines = [
    `Mode: ${describeMode(wizard)}`,
    `Source: ${describeSource(wizard.source)}`
  ];
  if (!wizard.series) lines.push(`Focus: ${wizard.focus ? wizard.focus : 'whole video'}`);
  lines.push(`Length: ${wizard.duration}s`);
  lines.push(`Music: ${describeMusic(wizard.music)}`);
  return lines;
}

/**
 * Project the wizard into the spec consumed by github.buildStageARequest()
 * (which emits the §7.1 nested stage-a-request.json shape). Ported verbatim.
 */
export function wizardToRequest(wizard, seriesId) {
  const series = wizard.series === true;
  const superSeries = series && wizard.superSeries === true;
  return {
    source: {
      kind: wizard.source.kind,
      value: wizard.source.value,
      ...(wizard.source.torrentFileIndex !== undefined && wizard.source.torrentFileIndex !== ''
        ? { torrent_file_index: String(wizard.source.torrentFileIndex) }
        : {})
    },
    options: {
      target_duration_seconds: wizard.duration,
      focus: series ? '' : String(wizard.focus || '')
    },
    mode: 'manual',
    series: {
      enabled: series,
      super_series: superSeries,
      series_id: series ? String(seriesId || '') : '',
      // bug-64: source_job_id is the Part-1 JOB id, never the series id.
      source_job_id: series ? String(wizard.jobId || '') : '',
      part: series ? 1 : 0,
      start_seconds: 0,
      context: ''
    },
    music: wizard.music && wizard.music.source !== 'none'
      ? { ref: String(wizard.music.ref || ''), source: wizard.music.source }
      : { ref: '', source: 'none' }
  };
}
