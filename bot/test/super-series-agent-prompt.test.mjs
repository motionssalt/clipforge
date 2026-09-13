/**
 * bug-73 round 4 — the Telegram "Agent prompt" handoff message must reflect
 * Super Series. Round 2 made the persisted stage-a-request carry
 * series.super_series and round 3 verified the release's
 * 00_READ_THIS_FIRST.txt carries the SUPER_SERIES_DIRECTIVE — but
 * sendAgentPrompt, the message the operator actually sees and taps "Copy
 * prompt" on, rendered its series clause from series.enabled alone, so a
 * Super Series anchor STILL got "SERIES MODE — this is Part 1 of series ..."
 * plus a single-part production.json ask: exactly the operator's
 * "the AI agent prompt in the bot is still showing series part 1" report.
 *
 * These tests drive the REAL worker (src/index.js) through
 * handleUpdate -> handleCallback -> routeCallback -> handleTaskCallback ->
 * sendAgentPrompt with stubbed global fetch, and assert on the exact message
 * text and copy_text payload sent to Telegram for both job kinds.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { ensureTaskLabel, putCredentials } from '../src/storage.js';
import { makeD1 } from './helpers/d1.mjs';

const CHAT = 7731;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');

function makeKv() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    _map: map,
  };
}

async function makeEnv() {
  const env = {
    CLIPFORGE_BOT_KV: makeKv(),
    CLIPFORGE_BOT_D1: makeD1(),
    KV_ENCRYPTION_KEY: TEST_KEY,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  };
  await putCredentials(env, CHAT, { githubPat: 'pat-not-real', repo: 'owner/repo', geminiKeys: [] });
  return env;
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(Promise.resolve(p)), _pending: pending };
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function makeStatus(jobId) {
  return {
    job_id: jobId,
    state: 'awaiting_plan',
    mode: 'manual',
    release_url: `https://github.com/owner/repo/releases/tag/clipforge-${jobId}`,
  };
}

function makeRequest(jobId, series) {
  return {
    version: 2,
    job_id: jobId,
    source: { kind: 'url', value: 'https://example.com/source-video' },
    options: {
      whisper_model: 'base',
      language: 'auto',
      target_duration_seconds: 30,
      focus: '',
      enable_vision_assist: true,
    },
    mode: 'manual',
    series,
    music: { ref: '', source: 'none' },
    saved_at_epoch: 1,
  };
}

function installFetch({ sent = [], files = {} } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      const m = u.split('/').pop();
      let payload = {};
      try { payload = init && init.body ? JSON.parse(String(init.body)) : {}; } catch { payload = {}; }
      sent.push({ method: m, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5000 + sent.length } }), { status: 200 });
    }
    if (u.startsWith('https://api.github.com/')) {
      for (const [suffix, content] of Object.entries(files)) {
        if (u.includes(suffix)) {
          return new Response(JSON.stringify({ content: b64(content), sha: 'deadbeef' }), { status: 200 });
        }
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

async function drivePrompt(env, label) {
  const update = {
    update_id: 100,
    callback_query: {
      id: 'cbq-1',
      from: { id: 1, is_bot: false },
      message: { message_id: 42, chat: { id: CHAT, type: 'private' } },
      data: `task:prompt:${label}`,
    },
  };
  const req = new Request('https://bot.test/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
    body: JSON.stringify(update),
  });
  const ctx = makeCtx();
  await worker.fetch(req, env, ctx);
  await Promise.all(ctx._pending);
}

function promptMessage(sent) {
  const msg = sent.find((c) => c.method === 'sendMessage' && String(c.payload.text || '').includes('Agent prompt'));
  assert.ok(msg, 'the agent prompt message was sent to Telegram');
  return msg.payload;
}

function unescapePre(text) {
  const match = String(text).match(/<pre>([\s\S]*?)<\/pre>/);
  assert.ok(match, 'the prompt message carries the full prompt in a <pre> block');
  return match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

test('bug-73 r4: Super Series anchor prompt says SUPER SERIES MODE, never "Part 1"', async () => {
  const env = await makeEnv();
  const jobId = 'manual-9999000001';
  const label = await ensureTaskLabel(env, CHAT, jobId);
  const series = {
    enabled: true,
    super_series: true,
    series_id: 'series-9999',
    source_job_id: jobId,
    part: 1,
    start_seconds: 0,
    context: '',
  };
  const sent = [];
  const restore = installFetch({
    sent,
    files: {
      [`jobs/${jobId}/status.json`]: JSON.stringify(makeStatus(jobId)),
      [`jobs/${jobId}/stage-a-request.json`]: JSON.stringify(makeRequest(jobId, series)),
    },
  });
  try {
    await drivePrompt(env, label);
    const payload = promptMessage(sent);
    const body = String(payload.text);
    assert.ok(body.includes('SUPER SERIES MODE'), 'prompt header announces Super Series');
    assert.ok(body.includes('series-9999'), 'prompt pins the exact series id');
    assert.ok(!body.includes('this is Part 1'), 'no ordinary single-part Part-1 clause');
    assert.ok(!body.includes('Series part 1'), 'no ordinary Part-1 copy variant either');
    assert.ok(body.includes('WHOLE-SERIES super-plan'), 'the ask is one whole-series super-plan document');

    const pre = unescapePre(body);
    assert.ok(pre.includes('SUPER SERIES MODE'), 'the <pre> prompt itself carries the Super Series clause');
    assert.ok(!pre.includes('this is Part 1'), 'the <pre> prompt has no single-part clause');

    const keyboard = payload.reply_markup && payload.reply_markup.inline_keyboard;
    assert.ok(Array.isArray(keyboard), 'prompt keyboard present');
    const copyRow = keyboard.flat().find((b) => b.copy_text && b.copy_text.text);
    assert.ok(copyRow, 'copy_text button present');
    const copyText = copyRow.copy_text.text;
    assert.ok(copyText.length <= 256, `copy_text fits Telegram's 256-char cap (got ${copyText.length})`);
    assert.ok(copyText.includes('super-plan'), 'copy_text asks for the super-plan, not a single-part plan');
    assert.ok(copyText.includes('series-9999'), 'copy_text pins the series id');
    assert.ok(!/Series part 1/i.test(copyText), 'copy_text has no Part-1 wording');
  } finally {
    restore();
  }
});

test('bug-73 r4: ordinary series job keeps the Part-1 clause unchanged', async () => {
  const env = await makeEnv();
  const jobId = 'series-9999-p1';
  const label = await ensureTaskLabel(env, CHAT, jobId);
  const series = {
    enabled: true,
    series_id: 'series-9999',
    source_job_id: 'manual-9999000001',
    part: 1,
    start_seconds: 0,
    context: '',
  };
  const sent = [];
  const restore = installFetch({
    sent,
    files: {
      [`jobs/${jobId}/status.json`]: JSON.stringify(makeStatus(jobId)),
      [`jobs/${jobId}/stage-a-request.json`]: JSON.stringify(makeRequest(jobId, series)),
    },
  });
  try {
    await drivePrompt(env, label);
    const payload = promptMessage(sent);
    const body = String(payload.text);
    assert.ok(body.includes('this is Part 1 of series'), 'ordinary series jobs keep the Part clause');
    assert.ok(!body.includes('SUPER SERIES MODE'), 'ordinary series jobs never see the Super Series clause');
    const keyboard = payload.reply_markup && payload.reply_markup.inline_keyboard;
    const copyRow = keyboard.flat().find((b) => b.copy_text && b.copy_text.text);
    assert.ok(copyRow, 'copy_text button present');
    assert.ok(copyRow.copy_text.text.length <= 256, 'copy_text fits the Telegram cap');
    // Pre-existing behavior (bug-15 ladder, unchanged by this fix): with any
    // realistic release URL the ordinary ladder overflows 250 chars before the
    // compact series clause is appended, so the copy button carries the bare
    // prompt and the Part clause lives in the full message/pre block. This
    // test pins that the Super Series fix did NOT alter the ordinary path:
    // no Super Series wording may leak into an ordinary job's copy_text.
    assert.ok(!/SUPER SERIES|super-plan/i.test(copyRow.copy_text.text), 'ordinary copy_text has no Super Series wording');
  } finally {
    restore();
  }
});

test('bug-73 r4: series-less job renders neither clause', async () => {
  const env = await makeEnv();
  const jobId = 'manual-9999000002';
  const label = await ensureTaskLabel(env, CHAT, jobId);
  const sent = [];
  const restore = installFetch({
    sent,
    files: {
      [`jobs/${jobId}/status.json`]: JSON.stringify(makeStatus(jobId)),
      [`jobs/${jobId}/stage-a-request.json`]: JSON.stringify(makeRequest(jobId, { enabled: false })),
    },
  });
  try {
    await drivePrompt(env, label);
    const body = String(promptMessage(sent).text);
    assert.ok(!body.includes('SUPER SERIES MODE'), 'no Super Series clause without series mode');
    assert.ok(!body.includes('this is Part'), 'no Part clause without series mode');
  } finally {
    restore();
  }
});

test('bug-73 r4: super_series must be exactly true — a truthy non-true value stays ordinary', async () => {
  const env = await makeEnv();
  const jobId = 'manual-9999000003';
  const label = await ensureTaskLabel(env, CHAT, jobId);
  const series = {
    enabled: true,
    super_series: 1, // not the boolean true the router/dispatch gate on
    series_id: 'series-9999',
    source_job_id: jobId,
    part: 1,
    start_seconds: 0,
    context: '',
  };
  const sent = [];
  const restore = installFetch({
    sent,
    files: {
      [`jobs/${jobId}/status.json`]: JSON.stringify(makeStatus(jobId)),
      [`jobs/${jobId}/stage-a-request.json`]: JSON.stringify(makeRequest(jobId, series)),
    },
  });
  try {
    await drivePrompt(env, label);
    const body = String(promptMessage(sent).text);
    assert.ok(!body.includes('SUPER SERIES MODE'), 'only super_series === true switches the clause');
    assert.ok(body.includes('this is Part 1 of series'), 'non-true super_series keeps the ordinary clause');
  } finally {
    restore();
  }
});
