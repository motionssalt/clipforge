// Unit tests for the bug-51 Shadow Clone job lifecycle (bot/src/storage.js
// clone-job records + bot/src/github.js pollShadowCloneJob state machine).
//
// Bug-51 coverage: Shadow Clone creation previously stalled forever at
// "Preparing repository…" because the webhook request awaited a multi-minute
// GitHub Actions copy run and Cloudflare killed the invocation mid-wait — no
// success message, no error message (a kill is not a rejection, so no catch
// could run). The fix stages the in-flight creation in KV and resumes it
// from the cron trigger. These tests pin the two halves of that guarantee:
//   1. A staged job survives process death (KV round-trip, PAT re-encrypted
//      under the chat's credential AAD, scan-set index maintained).
//   2. pollShadowCloneJob maps every copy-status outcome — running, complete,
//      reported-failed, never-started, stalled, deadline — to exactly one
//      decision, so the cron tick can always drive a job to a terminal
//      user-facing message.
//
// Uses node's built-in test runner with a Map-backed CLIPFORGE_BOT_KV stub
// and a stubbed global fetch standing in for the GitHub HTTP calls (the same
// pattern as tasks.test.mjs / relay.test.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLONE_COPY_DEADLINE_MS, CLONE_COPY_START_MS, CLONE_COPY_STALL_MS, pollShadowCloneJob
} from '../src/github.js';
import { getCloneJob, putCloneJob, deleteCloneJob, listCloneJobChatIds } from '../src/storage.js';

const CHAT = 4242;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const NOW = Date.now();

function makeKv() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    _map: map,
  };
}

function makeJob(overrides = {}) {
  return {
    chatId: CHAT,
    githubPat: 'pat-not-real',
    repo: 'owner/clipforge-clone-test',
    login: 'owner',
    name: 'clipforge-clone-test',
    branch: 'main',
    sourceSha: 'a'.repeat(40),
    bootstrapCommitSha: 'b'.repeat(40),
    totalFiles: 100,
    startedAt: NOW,
    lastAdvanceAt: NOW,
    lastStatusKey: '',
    runId: null,
    finalizeFailedAt: 0,
    ...overrides,
  };
}

// Stub fetch: answers the clone-status contents read from `status` (null =>
// 404, i.e. the status file does not exist yet) and the Actions run-list
// reads from `runIds`. Records every call URL into `calls`.
function installFetch({ status = null, runIds = [], calls = [] } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/contents/.clipforge-clone-status.json')) {
      if (status === null) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify({
        content: Buffer.from(JSON.stringify(status), 'utf8').toString('base64'),
        sha: 'abc',
      }), { status: 200 });
    }
    if (u.includes('/actions/runs') || u.includes('/actions/workflows/')) {
      return new Response(JSON.stringify({
        workflow_runs: runIds.map((id) => ({ id, event: 'workflow_dispatch' })),
      }), { status: 200 });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

test('clone job KV round-trip preserves the job and re-encrypts the PAT', async () => {
  const kv = makeKv();
  const env = { CLIPFORGE_BOT_KV: kv, KV_ENCRYPTION_KEY: TEST_KEY };
  await putCloneJob(env, CHAT, makeJob());
  const stored = kv._map.get(`user:${CHAT}:clonejob`);
  assert.ok(stored, 'job record stored');
  assert.ok(!stored.includes('pat-not-real'), 'raw PAT never appears in the KV value');
  const job = await getCloneJob(env, CHAT);
  assert.equal(job.githubPat, 'pat-not-real', 'PAT decrypts back');
  assert.equal(job.repo, 'owner/clipforge-clone-test');
  assert.equal(job.totalFiles, 100);
  assert.equal(job.startedAt, NOW);
  assert.deepEqual(await listCloneJobChatIds(env), [CHAT], 'chat id indexed for the cron sweep');
});

test('clone job delete removes the record and prunes the scan-set index', async () => {
  const kv = makeKv();
  const env = { CLIPFORGE_BOT_KV: kv, KV_ENCRYPTION_KEY: TEST_KEY };
  await putCloneJob(env, CHAT, makeJob());
  await putCloneJob(env, 9999, makeJob({ chatId: 9999 }));
  assert.deepEqual((await listCloneJobChatIds(env)).sort(), [CHAT, 9999].sort());
  await deleteCloneJob(env, CHAT);
  assert.equal(await getCloneJob(env, CHAT), null);
  assert.deepEqual(await listCloneJobChatIds(env), [9999]);
});

test('getCloneJob returns null for a record whose PAT envelope cannot be decrypted', async () => {
  const kv = makeKv();
  const env = { CLIPFORGE_BOT_KV: kv, KV_ENCRYPTION_KEY: TEST_KEY };
  kv._map.set(`user:${CHAT}:clonejob`, JSON.stringify({ version: 1, chatId: CHAT, patEnvelope: 'not-json' }));
  assert.equal(await getCloneJob(env, CHAT), null);
});

test('pollShadowCloneJob: copying status stays running and advances the stall clock', async () => {
  const restore = installFetch({ status: { state: 'copying', done: 40, total: 100 } });
  try {
    const outcome = await pollShadowCloneJob(makeJob({ startedAt: NOW - 60000, lastAdvanceAt: NOW - 60000 }));
    assert.equal(outcome.status, 'running');
    assert.equal(outcome.job.lastStatusKey, 'copying:40:100');
    assert.ok(outcome.job.lastAdvanceAt > NOW - 60000, 'lastAdvanceAt advanced');
  } finally { restore(); }
});

test('pollShadowCloneJob: complete resolves the run id for finalization', async () => {
  const restore = installFetch({ status: { state: 'complete', done: 100, total: 100 }, runIds: [555] });
  try {
    const outcome = await pollShadowCloneJob(makeJob());
    assert.equal(outcome.status, 'complete');
    assert.equal(outcome.job.runId, 555);
  } finally { restore(); }
});

test('pollShadowCloneJob: workflow-reported failure is terminal with the workflow error text', async () => {
  const restore = installFetch({ status: { state: 'failed', done: 40, total: 100, error: 'push rejected' }, runIds: [777] });
  try {
    const outcome = await pollShadowCloneJob(makeJob());
    assert.equal(outcome.status, 'failed');
    assert.match(String(outcome.error.message), /copy workflow failed: push rejected/);
    assert.equal(outcome.job.runId, 777, 'run id resolved so the dead run can be cancelled');
  } finally { restore(); }
});

test('pollShadowCloneJob: no status file past the start budget means the run never started', async () => {
  const restore = installFetch({ status: null, runIds: [] });
  try {
    const running = await pollShadowCloneJob(makeJob({ startedAt: NOW - (CLONE_COPY_START_MS - 1000) }));
    assert.equal(running.status, 'running', 'still within the start budget');
    const failed = await pollShadowCloneJob(makeJob({ startedAt: NOW - CLONE_COPY_START_MS - 1000 }));
    assert.equal(failed.status, 'failed');
    assert.match(String(failed.error.message), /never started/);
  } finally { restore(); }
});

test('pollShadowCloneJob: an unchanging status past the stall budget is a dead run', async () => {
  const restore = installFetch({ status: { state: 'copying', done: 40, total: 100 }, runIds: [42] });
  try {
    const outcome = await pollShadowCloneJob(makeJob({
      startedAt: NOW - CLONE_COPY_STALL_MS - 60000,
      lastAdvanceAt: NOW - CLONE_COPY_STALL_MS - 1000,
      lastStatusKey: 'copying:40:100',
    }));
    assert.equal(outcome.status, 'failed');
    assert.match(String(outcome.error.message), /stopped reporting progress/);
    assert.equal(outcome.job.runId, 42);
  } finally { restore(); }
});

test('pollShadowCloneJob: the absolute deadline terminates even a freshly advancing run', async () => {
  const restore = installFetch({ status: { state: 'copying', done: 99, total: 100 }, runIds: [] });
  try {
    const outcome = await pollShadowCloneJob(makeJob({ startedAt: NOW - CLONE_COPY_DEADLINE_MS - 1000 }));
    assert.equal(outcome.status, 'failed');
    assert.match(String(outcome.error.message), /took too long/);
  } finally { restore(); }
});
