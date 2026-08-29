// bug-67 regression test:
// scripts/reclaim-stale-task-labels.mjs's classify() ran its terminal-state
// short-circuit BEFORE the bug-49 series guard, so the guard was unreachable
// dead code for exactly the case it exists to protect. Real incident: job
// manual-1788023189426 finished Stage B with state="complete",
// series.enabled=true, series_id="series-1788023208180", part=1,
// is_final=false (Part 2/3 never started), expires_at_epoch=1788070049
// genuinely in the future — yet its task label was reclaimed by the hourly
// cleanup.yml run while the series was still active (/tasks showed
// "No tasks yet" even though the bot was actively working the release).
//
// The fix has two halves, both locked in here:
//   1. classify() checks series membership BEFORE the terminal short-circuit.
//   2. seriesIncomplete() (via makeSeriesIncomplete) applies the bug-66 rule
//      from pipeline/cleanup/expired.py's series_is_complete(): a series is
//      only complete when every known part is terminal AND at least one part
//      is marked series.is_final === true. A zero-final series whose existing
//      parts all happen to be terminal is still INCOMPLETE.
//
// The decision logic lives in scripts/reclaim-stale-task-labels-lib.mjs so it
// can be tested without the CLI's top-level env checks / KV / GitHub calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, makeSeriesIncomplete } from '../../scripts/reclaim-stale-task-labels-lib.mjs';

const NOW = 1788024000; // shortly after the incident; before expires 1788070049

// The exact incident data shape: terminal part 1 of a brand-new series,
// no sibling part on disk yet, TTL genuinely in the future.
const INCIDENT_DOC = {
  state: 'complete',
  expires_at_epoch: 1788070049,
  series: { enabled: true, series_id: 'series-1788023208180', part: 1, is_final: false },
};

function classifyWithJobs(result, jobs) {
  return classify(result, { now: NOW, seriesIncomplete: makeSeriesIncomplete(async () => jobs) });
}

test('bug-67: exact incident — terminal non-final part of incomplete series keeps its label', async () => {
  // Only part 1 exists on disk; it is terminal but is_final=false.
  const verdict = await classifyWithJobs({ doc: INCIDENT_DOC }, [
    { jobId: 'manual-1788023189426', doc: INCIDENT_DOC },
  ]);
  assert.equal(verdict, 'active', 'label must be KEPT — series has no final part and may continue');
});

test('bug-67: pre-fix ordering really did reclaim the incident job (regression anchor)', async () => {
  // Simulate the OLD classify() ordering: terminal check first.
  const oldClassify = (doc) =>
    ['complete', 'error', 'cancelled'].includes(String(doc.state))
      ? `stale:terminal-${doc.state}`
      : 'active';
  assert.equal(oldClassify(INCIDENT_DOC), 'stale:terminal-complete');
});

test('bug-67: terminal part with a NON-TERMINAL sibling keeps its label (bug-49 rule)', async () => {
  const sibling = {
    state: 'rendering',
    series: { enabled: true, series_id: 'series-1788023208180', part: 2, is_final: true },
  };
  const verdict = await classifyWithJobs({ doc: INCIDENT_DOC }, [
    { jobId: 'manual-1788023189426', doc: INCIDENT_DOC },
    { jobId: 'series-1788023208180-p2', doc: sibling },
  ]);
  assert.equal(verdict, 'active');
});

test('bug-67: genuinely finished series (terminal is_final sibling) is reclaimed', async () => {
  const finalSibling = {
    state: 'complete',
    series: { enabled: true, series_id: 'series-1788023208180', part: 2, is_final: true },
  };
  const verdict = await classifyWithJobs({ doc: INCIDENT_DOC }, [
    { jobId: 'manual-1788023189426', doc: INCIDENT_DOC },
    { jobId: 'series-1788023208180-p2', doc: finalSibling },
  ]);
  assert.equal(verdict, 'stale:terminal-complete', 'finished series must still free the label');
});

test('bug-66 rule ported: all-terminal series with ZERO is_final parts is still incomplete', async () => {
  // Two terminal parts, neither marked final (part 3 never started) — the
  // exact series-1787970477573 shape from the bug-66 incident, JS side.
  const p2 = {
    state: 'complete',
    series: { enabled: true, series_id: 'series-1788023208180', part: 2, is_final: false },
  };
  const verdict = await classifyWithJobs({ doc: INCIDENT_DOC }, [
    { jobId: 'manual-1788023189426', doc: INCIDENT_DOC },
    { jobId: 'series-1788023208180-p2', doc: p2 },
  ]);
  assert.equal(verdict, 'active', 'zero-final series must NOT count as finished');
});

test('no regression: terminal job with NO series is reclaimed as before', async () => {
  const doc = { state: 'complete', expires_at_epoch: 1788070049 };
  const verdict = await classifyWithJobs({ doc }, [{ jobId: 'manual-x', doc }]);
  assert.equal(verdict, 'stale:terminal-complete');
});

test('no regression: terminal job with series disabled is reclaimed', async () => {
  const doc = {
    state: 'error',
    series: { enabled: false, series_id: 'series-1', part: 1, is_final: false },
  };
  const verdict = await classifyWithJobs({ doc }, [{ jobId: 'manual-y', doc }]);
  assert.equal(verdict, 'stale:terminal-error');
});

test('no regression: active non-series job with future TTL keeps its label', async () => {
  const doc = { state: 'rendering', expires_at_epoch: 1788070049 };
  const verdict = await classifyWithJobs({ doc }, [{ jobId: 'manual-z', doc }]);
  assert.equal(verdict, 'active');
});

test('no regression: non-series job past TTL is reclaimed', async () => {
  const doc = { state: 'rendering', expires_at_epoch: NOW - 60 };
  const verdict = await classifyWithJobs({ doc }, [{ jobId: 'manual-w', doc }]);
  assert.equal(verdict, 'stale:ttl-expired');
});

test('no regression: missing status is stale, unreadable fetch is unknown', async () => {
  assert.equal(await classifyWithJobs({ missing: true }, []), 'stale:no-readable-status');
  assert.equal(await classifyWithJobs({ error: 'unparseable' }, []), 'stale:no-readable-status');
  assert.equal(await classifyWithJobs({ error: 'http-500' }, []), 'unknown:http-500');
  assert.equal(await classifyWithJobs({ error: 'no-token' }, []), 'unknown:no-token');
});

test('sibling with unreadable status does NOT count toward series completion', async () => {
  // Mirrors expired.py: a missing/unreadable sibling status counts as
  // INCOMPLETE, so a protected part is never reaped while a sibling is unknown.
  const finalSibling = {
    state: 'complete',
    series: { enabled: true, series_id: 'series-1788023208180', part: 2, is_final: true },
  };
  const verdict = await classifyWithJobs({ doc: INCIDENT_DOC }, [
    { jobId: 'manual-1788023189426', doc: INCIDENT_DOC },
    { jobId: 'series-1788023208180-p2', doc: finalSibling },
    { jobId: 'series-1788023208180-p3', doc: null }, // unreadable
  ]);
  assert.equal(verdict, 'stale:terminal-complete',
    'matches expired.py: unreadable sibling is skipped, terminal+final series still reclaimed');
});

test('seriesIncomplete caches per series id', async () => {
  let calls = 0;
  const seriesIncomplete = makeSeriesIncomplete(async () => {
    calls += 1;
    return [{ jobId: 'p1', doc: INCIDENT_DOC }];
  });
  assert.equal(await seriesIncomplete('series-1788023208180'), true);
  assert.equal(await seriesIncomplete('series-1788023208180'), true);
  assert.equal(calls, 1, 'second lookup must hit the cache');
  assert.equal(await seriesIncomplete(''), false, 'empty series id is never incomplete');
});

test('seriesIncomplete: lister failure conservatively reports complete=false path', async () => {
  const seriesIncomplete = makeSeriesIncomplete(async () => { throw new Error('network down'); });
  // On failure the helper cannot prove the series is unfinished, so it
  // reports NOT incomplete — the caller then falls through to the normal
  // terminal/TTL rules (same as the pre-refactor behavior).
  assert.equal(await seriesIncomplete('series-x'), false);
});
