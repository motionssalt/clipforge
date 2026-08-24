import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptCredentials, encryptCredentials } from '../src/crypto.js';
import { validateProductionPlan } from '../src/production.js';
import { stageLabel } from '../src/constants.js';
import { ensureTaskLabel, getJobIdForLabel, getTasks, getState, putState } from '../src/storage.js';
import worker, { __test } from '../src/index.js';
import nacl from 'tweetnacl';
import sealedbox from 'tweetnacl-sealedbox-js';
import { downloadTelegramFileBytes, sendAudioBytes, sendDocumentBytes } from '../src/telegram.js';
import { cloneRepositoryName, createPrivateShadowClone, parseJsonDocument, putBinaryFile, sourcePathAllowed } from '../src/github.js';

class MemoryKv {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key) ?? null; }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
}

const keyBytes = new Uint8Array(32);
for (let i = 0; i < keyBytes.length; i += 1) keyBytes[i] = i + 1;
const encryptionSecret = btoa(String.fromCharCode(...keyBytes));

function env() { return { CLIPFORGE_BOT_KV: new MemoryKv(), KV_ENCRYPTION_KEY: encryptionSecret }; }

test('sealed-box dependency produces a GitHub-secret compatible ciphertext envelope', () => {
  const pair = nacl.box.keyPair();
  const message = new TextEncoder().encode('gemini-key-material');
  const sealed = sealedbox.seal(message, pair.publicKey);
  assert.equal(sealed.length, message.length + sealedbox.overheadLength);
  assert.deepEqual(sealedbox.open(sealed, pair.publicKey, pair.secretKey), message);
});

test('credentials are encrypted, bound to a chat, and round-trip without plaintext KV storage', async () => {
  const value = { githubPat: 'github_pat_example_123456789', repo: 'owner/repo', geminiKeys: ['AIza-example-key-123456'] };
  const encrypted = await encryptCredentials(value, 101, encryptionSecret);
  assert.equal(encrypted.includes(value.githubPat), false);
  assert.deepEqual(await decryptCredentials(encrypted, 101, encryptionSecret), value);
  await assert.rejects(() => decryptCredentials(encrypted, 102, encryptionSecret));
});

test('task labels are stable and isolated per Telegram chat', async () => {
  const workerEnv = env();
  assert.equal(await ensureTaskLabel(workerEnv, 1, 'manual-1'), 'A');
  assert.equal(await ensureTaskLabel(workerEnv, 1, 'automatic-2'), 'B');
  assert.equal(await ensureTaskLabel(workerEnv, 1, 'manual-1'), 'A');
  assert.equal(await ensureTaskLabel(workerEnv, 2, 'other-user-job'), 'A');
  assert.equal(await getJobIdForLabel(workerEnv, 1, 'A'), 'manual-1');
  assert.equal(await getJobIdForLabel(workerEnv, 2, 'B'), null);
  assert.equal((await getTasks(workerEnv, 1)).labels.B, 'automatic-2');
});

test('conversation state never adopts another chat state', async () => {
  const workerEnv = env();
  await putState(workerEnv, 1, { flow: 'manual_source', pending: { mode: 'manual' }, currentTask: 'manual-1' });
  assert.equal((await getState(workerEnv, 1)).currentTask, 'manual-1');
  assert.equal((await getState(workerEnv, 2)).currentTask, null);
});

test('health is public but webhook updates require the configured Telegram secret', async () => {
  const workerEnv = { ...env(), TELEGRAM_WEBHOOK_SECRET: 'expected-secret', TELEGRAM_BOT_TOKEN: 'test-token' };
  const health = await worker.fetch(new Request('https://worker.example/health'), workerEnv);
  assert.equal(health.status, 200);
  const rejected = await worker.fetch(new Request('https://worker.example/webhook', { method: 'POST', body: '{}' }), workerEnv);
  assert.equal(rejected.status, 401);
});

test('voice previews and full agent prompts are delivered as safe multipart Telegram files', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init.body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: calls.length } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    const workerEnv = { TELEGRAM_BOT_TOKEN: 'test-token' };
    await sendAudioBytes(workerEnv, 9, new Uint8Array([1, 2, 3]), 'en-US-AvaNeural.mp3', 'Preview');
    await sendDocumentBytes(workerEnv, 9, new TextEncoder().encode('full agent prompt'), 'manual-1-agent-prompt.txt', 'Prompt');
    assert.equal(calls[0].url.endsWith('/sendAudio'), true);
    assert.equal(calls[0].body.get('audio').name, 'en-US-AvaNeural.mp3');
    assert.equal(calls[1].url.endsWith('/sendDocument'), true);
    assert.equal(calls[1].body.get('document').name, 'manual-1-agent-prompt.txt');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('shared-bot onboarding offers private Shadow Clone creation or existing-clone connection', () => {
  const callbacks = __test.cloneOnboardingMenu().inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes('clone:new'));
  assert.ok(callbacks.includes('clone:connect'));
  assert.equal(cloneRepositoryName('my-clipforge_2026'), 'my-clipforge_2026');
  assert.throws(() => cloneRepositoryName('../unsafe'), /Shadow Clone repository name/);
  assert.equal(sourcePathAllowed('scripts/generate_voiceover.py'), true);
  assert.equal(sourcePathAllowed('jobs/other-user/status.json'), false);
  assert.equal(sourcePathAllowed('branding/gemini_keys.json'), false);
  assert.equal(sourcePathAllowed('audio-library/private-track.mp3'), false);
});

test('private Shadow Clone creation copies shared source while excluding all user state', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const path = `${parsed.pathname}${parsed.search}`;
    calls.push({ path, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const reply = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (path === '/user') return reply({ login: 'alice' });
    if (path === '/repos/motionssalt/clipforge/git/ref/heads/main') return reply({ object: { sha: 'source-commit' } });
    if (path === '/repos/motionssalt/clipforge/git/commits/source-commit') return reply({ tree: { sha: 'source-tree' } });
    if (path === '/repos/motionssalt/clipforge/git/trees/source-tree?recursive=1') return reply({ truncated: false, tree: [
      { type: 'blob', path: 'README.md', sha: 'readme-blob', mode: '100644' },
      { type: 'blob', path: 'jobs/another-user/status.json', sha: 'job-blob', mode: '100644' },
      { type: 'blob', path: 'branding/tts_settings.json', sha: 'brand-blob', mode: '100644' }
    ] });
    if (path === '/user/repos' && init.method === 'POST') return reply({ full_name: 'alice/my-clipforge' });
    if (path === '/repos/motionssalt/clipforge/git/blobs/readme-blob') return reply({ encoding: 'base64', content: 'cmVhZG1l' });
    if (path === '/repos/alice/my-clipforge/git/blobs' && init.method === 'POST') return reply({ sha: calls.filter((call) => call.path === path && call.method === 'POST').length === 1 ? 'copied-readme' : 'sync-blob' });
    if (path === '/repos/alice/my-clipforge/git/trees' && init.method === 'POST') return reply({ sha: 'target-tree' });
    if (path === '/repos/alice/my-clipforge/git/commits' && init.method === 'POST') return reply({ sha: 'target-commit' });
    if (path === '/repos/alice/my-clipforge/git/refs' && init.method === 'POST') return reply({ ref: 'refs/heads/main' });
    throw new Error(`Unexpected GitHub request: ${init.method || 'GET'} ${path}`);
  };
  try {
    const result = await createPrivateShadowClone('token-value', 'my-clipforge');
    assert.deepEqual(result.repo, 'alice/my-clipforge');
    assert.equal(result.copiedFiles, 1);
    const treeRequest = calls.find((call) => call.path === '/repos/alice/my-clipforge/git/trees');
    assert.deepEqual(treeRequest.body.tree.map((entry) => entry.path).sort(), ['.clipforge-sync.json', 'README.md']);
    assert.equal(calls.some((call) => call.path.includes('job-blob')), false);
    assert.equal(calls.some((call) => call.path.includes('brand-blob')), false);
    assert.equal(calls.every((call) => call.headers['User-Agent'] === 'ClipForge-Telegram-Bot/1.0'), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('source and command helpers retain the intended operator contract', () => {
  assert.equal(__test.commandOf('/automatic'), '/automatic');
  assert.equal(__test.commandOf('/automatic@ClipForgeBot'), '/automatic');
  assert.equal(__test.commandOf('/unknown'), null);
  assert.equal(__test.validateSource('https://example.com/video.mp4'), 'https://example.com/video.mp4');
  assert.equal(__test.validateSource('magnet:?xt=urn:btih:abcdef'), 'magnet:?xt=urn:btih:abcdef');
  assert.throws(() => __test.validateSource('file:///etc/passwd'));
  assert.equal(__test.normalizeFocus('  the  opening scene  '), 'the opening scene');
  assert.equal(__test.normalizeFocus('-'), '');
});

test('music and torrent inline-button labels are bounded by UTF-8 bytes', () => {
  const label = __test.telegramButtonText('𝐒𝐀𝐃 𝐅𝐔𝐍𝐊 (𝐒𝐔𝐏𝐄𝐑 𝐒𝐋𝐎𝐖𝐄𝐃) 𝐗 𝐘𝐔𝐓𝐀 𝐎𝐊𝐊𝐎𝐓𝐒𝐔.m4a');
  assert.ok(new TextEncoder().encode(label).length <= 60);
  assert.match(label, /…$/);
  assert.equal(__test.telegramButtonText('CRY_FOR_ME_FUNK.m4a'), 'CRY_FOR_ME_FUNK.m4a');
  const video = __test.torrentCandidateButtonText('[Anime Time] Tokyo Ghoul/[Anime Time] Tokyo Ghoul Episode 12 END 1080p.mkv');
  assert.ok(new TextEncoder().encode(video).length <= 48);
  assert.match(video, /1080p\.mkv$/);
  assert.equal(__test.formatBytes(2_097_152), '2.0 MiB');
});

test('status JSON with workflow merge markers is recovered for display without changing non-status JSON rules', () => {
  const conflicted = '{\n  "job_id": "automatic-example",\n  "stage": "stage_a_running",\n<<<<<<< Updated upstream\n  "updated_at_epoch": 10,\n=======\n  "updated_at_epoch": 20,\n>>>>>>> Stashed changes\n}\n';
  const parsed = parseJsonDocument(conflicted, 'jobs/automatic-example/status.json');
  assert.equal(parsed.job_id, 'automatic-example');
  assert.equal(parsed.stage, 'stage_a_running');
  assert.equal(parsed.updated_at_epoch, 20);
  assert.throws(() => parseJsonDocument(conflicted, 'jobs/automatic-example/production.json'), /not valid JSON/);
});

test('a staged torrent task remains resumable after returning to the home menu and is not presented as dispatched', () => {
  const staged = { flow: 'manual_focus', pending: { mode: 'manual', source: 'path:jobs/manual-example/source.torrent', jobId: 'manual-example' } };
  assert.equal(__test.hasResumablePendingTask(staged), true);
  assert.equal(__test.hasResumablePendingTask({ flow: 'manual_focus', pending: { mode: 'manual', source: 'path:jobs/manual-example/source.torrent' } }), false);
  const callbacks = __test.homeMenu(staged).inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes('resume:task'));
  assert.equal(stageLabel('starting'), 'Starting');
});

test('existing masked Gemini metadata is recognised without materialising an opaque site secret', () => {
  assert.equal(__test.existingGeminiLabel([], [{ fingerprint: 'masked-one' }, { fingerprint: 'masked-two' }]), 'Gemini keys: 2 existing site keys already configured in GitHub Actions');
  assert.match(__test.existingGeminiLabel(['AIza-local-secret'], [{ fingerprint: 'masked-one' }]), /stored in this bot chat/);
  assert.equal(__test.existingGeminiLabel([], []), 'Gemini keys: not configured');
});

test('the copied agent handoff contains the exact release URL', () => {
  const releaseUrl = 'https://github.com/motionssalt/clipforge/releases/tag/clipforge-manual-test';
  const prompt = __test.buildAgentHandoffPrompt(releaseUrl);
  assert.ok(prompt.includes(releaseUrl));
  assert.ok(prompt.includes('00_READ_THIS_FIRST.txt'));
  assert.ok(new TextEncoder().encode(prompt).length <= 256);
});

test('Zernio settings preserve the site schema and only target active selected accounts', () => {
  const defaults = __test.defaultZernioSettings();
  assert.equal(defaults.automatic_mode, 'smart_schedule');
  assert.equal(defaults.smart_schedule.timezone, 'UTC');
  assert.equal(__test.validZernioTimezone('America/New_York'), true);
  assert.equal(__test.validZernioTimezone('bad timezone'), false);
  assert.equal(__test.validZernioTime('19:30'), true);
  assert.equal(__test.validZernioTime('25:99'), false);
  assert.equal(__test.validZernioDateTime('2026-08-25T19:30'), true);
  assert.equal(__test.validZernioDateTime('2026/08/25 19:30'), false);
  const accounts = [
    { id: 'tik-active', platform: 'tiktok', displayName: 'TikTok active', isActive: true, enabled: true },
    { id: 'yt-active', platform: 'youtube', username: 'youtube-active', isActive: true, enabled: true },
    { id: 'tik-reconnect', platform: 'tiktok', needsReconnection: true }
  ];
  const settings = __test.zernioSettingsOrDefault({ enabled: true, auto_publish: true, automatic_mode: 'publish_now', target_accounts: { tiktok: ['tik-active', 'tik-reconnect'], youtube: ['yt-active'] }, smart_schedule: { timezone: 'Europe/London', interval_days: 3, preferred_time: '08:15', queue_depth: 7 } });
  assert.deepEqual(__test.activeZernioAccounts(accounts).tiktok.map((account) => account.id), ['tik-active']);
  assert.deepEqual(__test.zernioTargets(settings, accounts), [{ platform: 'tiktok', account_ids: ['tik-active'] }, { platform: 'youtube', account_ids: ['yt-active'] }]);
  const callbacks = __test.zernioSettingsMenu({ settings, secretConfigured: true }).inline_keyboard.flat().map((button) => button.callback_data);
  for (const callback of ['set:zernio_key', 'zernio:refresh', 'zernio:targets', 'zernio:schedule', 'zernio:clear_prompt']) assert.ok(callbacks.includes(callback));
});

test('manual Stage A status exposes the agent-prompt control before production upload', () => {
  const markup = __test.taskButtons('A', { stage: 'awaiting_json_upload' });
  const callbacks = markup.inline_keyboard.flat().map((button) => button.callback_data);
  assert.ok(callbacks.includes('agent:A'));
  assert.ok(callbacks.includes('plan:A'));
  assert.equal(__test.taskButtons('A', { stage: 'stage_a_running' }).inline_keyboard.flat().some((button) => button.callback_data === 'agent:A'), false);
  assert.ok(__test.taskButtons('B', { stage: 'awaiting_torrent_selection' }).inline_keyboard.flat().some((button) => button.callback_data === 'torrent:B'));
});

test('torrent manifest downloads are bounded and retained as raw bytes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0x64, 0x33, 0x3a, 0x66, 0x6f, 0x6f]), { headers: { 'content-length': '6' } });
  try {
    const bytes = await downloadTelegramFileBytes({ TELEGRAM_BOT_TOKEN: 'test-token' }, 'documents/example.torrent', 6);
    assert.deepEqual([...bytes], [0x64, 0x33, 0x3a, 0x66, 0x6f, 0x6f]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('torrent manifest uploads use only the selected job source.torrent path and base64 bytes', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ path: `${parsed.pathname}${parsed.search}`, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if ((init.method || 'GET') === 'GET') return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ content: { path: 'jobs/manual-safe/source.torrent' } }), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await putBinaryFile({ githubPat: 'test-token' }, 'owner/repo', 'jobs/manual-safe/source.torrent', new Uint8Array([0x64, 0x33, 0x3a]), 'upload manifest');
    const put = calls.find((call) => call.method === 'PUT');
    assert.equal(put.path, '/repos/owner/repo/contents/jobs/manual-safe/source.torrent');
    assert.equal(calls[0].path, '/repos/owner/repo/contents/jobs/manual-safe/source.torrent?ref=main');
    assert.equal(put.body.content, 'ZDM6');
    assert.equal(put.body.branch, 'main');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('manual production-plan validation preserves ClipForge’s timing and narration contract', () => {
  const valid = {
    video_duration_seconds: 90,
    target_total_duration_seconds: 30,
    cuts: [{ start_seconds: 0, end_seconds: 30, voiceover_text: 'A supported narration.' }]
  };
  assert.deepEqual(validateProductionPlan(valid), []);
  const invalid = {
    video_duration_seconds: 10,
    target_total_duration_seconds: 30,
    cuts: [{ start_seconds: 8, end_seconds: 7, raw_narration: '' }]
  };
  assert.ok(validateProductionPlan(invalid).length >= 2);
});
