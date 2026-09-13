/**
 * task-09 — shared media helpers: cached audio tap-to-play and real
 * browser downloads with progress + size, File System Access API first.
 *
 * The bot delivered audio/video straight into the Telegram chat
 * (deliverVideoToChat, music preview as an audio message). The Dashboard
 * equivalent is a real browser-side experience:
 *  - audio: tap-to-play via a cached object URL (bytes fetched once per
 *    path, replayed instantly from memory/localStorage-agnostic cache)
 *  - video/file download: a streaming download with a real progress bar and
 *    byte count, saved via the File System Access API (showSaveFilePicker)
 *    where the browser supports it, falling back to an <a download> blob
 */

import { getRepositoryFileBytes, downloadReleaseAsset } from './github.js';
import { formatBytes } from './state.js';

// In-memory audio byte cache — keyed by repo path so a second tap on the
// same track (or the same track in another section) plays instantly without
// a second network fetch. Not persisted to localStorage (binary + quota).
const audioCache = new Map();

/**
 * Fetch (once) and cache audio bytes for a repo path, returning a Blob.
 * tap-to-play callers keep a single <audio> element and swap .src.
 */
export async function cachedAudioBlob(credentials, repo, path, maxBytes) {
  if (audioCache.has(path)) return audioCache.get(path);
  const bytes = await getRepositoryFileBytes(credentials, repo, path, maxBytes);
  const blob = new Blob([bytes]);
  audioCache.set(path, blob);
  return blob;
}

/**
 * Wire a single <audio> element + a set of [data-play] buttons for
 * tap-to-play with caching. Used by the Narrator voice previews and the
 * Music library. `resolve(btn)` must return { path, maxBytes }.
 */
export function wireAudioTapToPlay({ host, player, note, buttons, credentials, repo, resolve }) {
  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { path, maxBytes } = resolve(btn);
      btn.disabled = true;
      if (note) note.textContent = audioCache.has(path) ? 'Playing from cache…' : 'Fetching…';
      try {
        const blob = await cachedAudioBlob(credentials, repo, path, maxBytes);
        if (player.dataset.blobUrl) URL.revokeObjectURL(player.dataset.blobUrl);
        const url = URL.createObjectURL(blob);
        player.dataset.blobUrl = url;
        player.src = url;
        player.classList.remove('hidden');
        if (note) note.textContent = path.replace(/^.*\//, '');
        player.play().catch(() => { if (note) note.textContent = 'Preview ready — press play.'; });
      } catch (error) {
        if (note) note.textContent = `Preview failed: ${error.message}`;
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/** True when the File System Access API save picker is available. */
export function canUseFileSystemAccess() {
  return typeof window.showSaveFilePicker === 'function';
}

/**
 * Save bytes to disk, preferring the File System Access API (a real
 * user-picked destination, the closest browser equivalent of Android's
 * permission-scoped save) and falling back to an <a download> blob.
 * Returns 'picked' | 'download' | 'cancelled'.
 */
export async function saveBytes(bytes, suggestedName) {
  if (canUseFileSystemAccess()) {
    let handle;
    try {
      handle = await window.showSaveFilePicker({ suggestedName });
    } catch (error) {
      if (error && error.name === 'AbortError') return 'cancelled';
      // Fall through to the blob download on any other picker failure.
    }
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(bytes);
      await writable.close();
      return 'picked';
    }
  }
  const blob = new Blob([bytes]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return 'download';
}

/**
 * Render a download card row for a single release asset into `container`,
 * wiring a real progress bar + size readout and the File System Access
 * save. `onDone(method)` is called after a successful save (used to mark
 * the asset downloaded). Returns nothing; the row is fully self-contained.
 */
export function buildDownloadRow({ credentials, asset, container, onDone }) {
  const row = document.createElement('div');
  row.className = 'dl-row';
  row.innerHTML = `
    <div class="grow">
      <span class="mono">${asset.name}</span>
      <span class="muted small"> · ${formatBytes(asset.size)}</span>
      <div class="progress-track hidden" data-x="track"><div class="progress-fill" data-x="fill" style="width:0%"></div></div>
      <div class="muted small" data-x="status"></div>
    </div>
    <button type="button" class="primary small" data-x="go">Download</button>`;
  container.appendChild(row);

  const track = row.querySelector('[data-x="track"]');
  const fill = row.querySelector('[data-x="fill"]');
  const statusEl = row.querySelector('[data-x="status"]');
  const go = row.querySelector('[data-x="go"]');

  go.addEventListener('click', async () => {
    go.disabled = true;
    track.classList.remove('hidden');
    try {
      const bytes = await downloadReleaseAsset(credentials, asset, (received, total) => {
        const t = total || asset.size || 0;
        const pct = t ? Math.min(100, Math.round((received / t) * 100)) : 0;
        fill.style.width = pct + '%';
        statusEl.textContent = t
          ? `${formatBytes(received)} / ${formatBytes(t)} (${pct}%)`
          : `${formatBytes(received)}…`;
      });
      statusEl.textContent = `Saving ${formatBytes(bytes.length)}…`;
      const method = await saveBytes(bytes, asset.name);
      if (method === 'cancelled') {
        statusEl.textContent = 'Save cancelled.';
        go.disabled = false;
        return;
      }
      statusEl.textContent = method === 'picked'
        ? `Saved (${formatBytes(bytes.length)}) to your chosen folder.`
        : `Downloaded (${formatBytes(bytes.length)}) — check your browser downloads.`;
      if (onDone) onDone(method);
    } catch (error) {
      statusEl.textContent = `Download failed: ${error.message}`;
      go.disabled = false;
    }
  });
}
