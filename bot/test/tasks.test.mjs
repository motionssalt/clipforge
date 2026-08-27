// Unit tests for the /tasks list (bot/src/commands/tasks.js).
//
// Bug 1 fix coverage: a task whose status document cannot be read must
// surface as a distinct "status unavailable" row, not silently fold into the
// active list as a plain "queued" task.
//
// Uses node's built-in test runner with a Map-backed CLIPFORGE_BOT_KV stub
// and a stubbed global fetch standing in for the GitHub + Telegram HTTP
// calls (the same pattern as relay.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import { loadTaskList, showTasks } from '../src/commands/tasks.js';
import { describeTaskState } from '../src/constants.js';
import { ensureTaskLabel, putCredentials } from '../src/storage.js';

const CHAT = 4242;
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

function makeStatus(jobId, state, created) {
  return {
    version: 2,
    job_id: jobId,
    mode: 'manual',
    series: { enabled: false, series_id: '', part: 0, start_seconds: 0, is_final: false },
    state,
    message: '',
    created_at_epoch: created,
    updated_at_epoch: created,
    expires_at_epoch: created + 43200,
    release_tag: '',
    release_url: '',
    assets: {},
    run: { workflow_run_id: 0, workflow_run_url: '', code_ref: '' },
    publishing: { status: 'not_requested', posts: [], idempotency_key: '' },
  };
}

// Stub fetch: answers GitHub contents reads from `files` (path -> doc; absent
// key => 404), records every Telegram call's JSON payload into `sent`.
function installFetch({ files = {}, sent = [] } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) {
      const m = u.match(/\/contents\/(.+?)(?:\?|$)/);
      const path = m ? decodeURIComponent(m[1]) : '';
      if (Object.prototype.hasOwnProperty.call(files, path) && files[path] !== null) {
        return new Response(JSON.stringify({
          content: Buffer.from(JSON.stringify(files[path]), 'utf8').toString('base64'),
          sha: 'abc',
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (u.startsWith('https://api.telegram.org/')) {
      const method = u.split('/').pop();
      let payload = {};
      try { payload = init && init.body ? JSON.parse(String(init.body)) : {}; } catch { payload = {}; }
      sent.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

async function makeEnv(kv) {
  const env = { CLIPFORGE_BOT_KV: kv, KV_ENCRYPTION_KEY: TEST_KEY, TELEGRAM_BOT_TOKEN: 'test-token' };
  await putCredentials(env, CHAT, { githubPat: 'pat-not-real', repo: 'owner/repo', geminiKeys: [] });
  return env;
}

test('describeTaskState renders awaiting_torrent_selection in plain language', () => {
  assert.equal(describeTaskState(makeStatus('j-1', 'awaiting_torrent_selection', 1)),
    'waiting for your file selection');
  assert.equal(describeTaskState(makeStatus('j-1', 'stage_a_running', 1)), 'stage_a_running');
  assert.equal(describeTaskState(null), 'queued');
  assert.match(describeTaskState(null, { unreadable: true }), /status unavailable/);
});

test('loadTaskList keeps unreadable statuses as null entries (not dropped, not fabricated)', async () => {
  const kv = makeKv();
  const env = await makeEnv(kv);
  await ensureTaskLabel(env, CHAT, 'job-dead');
  await ensureTaskLabel(env, CHAT, 'job-live');
  const restore = installFetch({
    files: { 'jobs/job-live/status.json': makeStatus('job-live', 'stage_a_running', 500) },
  });
  try {
    const { credentials, entries } = await loadTaskList(env, CHAT);
    assert.ok(credentials);
    assert.equal(entries.length, 2);
    const dead = entries.find((e) => e.jobId === 'job-dead');
    const live = entries.find((e) => e.jobId === 'job-live');
    assert.equal(dead.status, null, 'unreadable status must stay null (distinct from queued)');
    assert.equal(live.status.state, 'stage_a_running');
  } finally {
    restore();
  }
});

test('showTasks renders an unreadable status as "status unavailable", not "queued"', async () => {
  const kv = makeKv();
  const env = await makeEnv(kv);
  await ensureTaskLabel(env, CHAT, 'job-dead');
  await ensureTaskLabel(env, CHAT, 'job-live');
  const sent = [];
  const restore = installFetch({
    files: { 'jobs/job-live/status.json': makeStatus('job-live', 'stage_a_running', 500) },
    sent,
  });
  try {
    await showTasks(env, CHAT);
  } finally {
    restore();
  }
  assert.equal(sent.length, 1, 'expected exactly one Telegram message');
  const text = String(sent[0].payload.text || '');
  assert.match(text, /Active tasks/);
  // The dead job (404 status) must NOT read as a plain "queued" row…
  const deadLine = text.split('\n').find((l) => l.includes('<b>A</b>'));
  assert.ok(deadLine, 'expected a row for label A');
  assert.match(deadLine, /status unavailable/);
  assert.doesNotMatch(deadLine, /queued/);
  // …while the genuinely running job keeps its real state.
  const liveLine = text.split('\n').find((l) => l.includes('<b>B</b>'));
  assert.match(liveLine, /stage_a_running/);
});
