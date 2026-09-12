import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_PARTS,
  buildSuperState,
  parseAndValidateSuperPlan,
  sliceSuperPart,
  superPartJobId,
  superPartRequestBody,
  superQueueAdvance,
  validateSuperPlan,
} from '../src/super_series.js';
import { validateProductionPlan } from '../src/plan.js';

function cuts(start, end) {
  return [{ start_seconds: start, end_seconds: end, voiceover_text: 'Hi.' }];
}

function partDoc({ seriesId, part, start, end, isFinal, title }) {
  return {
    version: 2,
    job_id: '',
    title,
    video_duration_seconds: 600,
    target_total_duration_seconds: 30,
    cuts: cuts(start, end),
    series: {
      series_id: seriesId,
      part,
      start_seconds: start,
      end_seconds: end,
      is_final: isFinal,
      summary: `Recap for part ${part}.`,
    },
  };
}

function makePlan({ parts = 3, seriesId = 'series-1', boundaries = [0, 200, 400, 600] } = {}) {
  return {
    version: 2,
    series_id: seriesId,
    video_duration_seconds: boundaries[boundaries.length - 1],
    target_total_duration_seconds: 30,
    parts: Array.from({ length: parts }, (_, index) => partDoc({
      seriesId,
      part: index + 1,
      start: boundaries[index],
      end: boundaries[index + 1],
      isFinal: index === parts - 1,
      title: `Part ${index + 1}`,
    })),
  };
}

test('validateSuperPlan accepts a valid three-part plan', () => {
  assert.deepEqual(validateSuperPlan(makePlan()), []);
});

test('validateSuperPlan rejects missing series_id', () => {
  const doc = makePlan();
  delete doc.series_id;
  const errs = validateSuperPlan(doc);
  assert.ok(errs.some((e) => e.includes('`series_id` must be a non-empty string')));
});

test('validateSuperPlan rejects mismatched per-part series_id', () => {
  const doc = makePlan();
  doc.parts[1].series.series_id = 'other';
  const errs = validateSuperPlan(doc);
  assert.ok(errs.some((e) => e.startsWith('parts[1].series.series_id')));
});

test('validateSuperPlan rejects gaps and overlaps between parts', () => {
  const gap = makePlan();
  gap.parts[2].series.start_seconds = 500; // previous end was 400
  assert.ok(validateSuperPlan(gap).some((e) => e.includes('tile the source with no gaps or overlaps')));

  const overlap = makePlan();
  overlap.parts[1].series.start_seconds = 100; // previous end was 200
  assert.ok(validateSuperPlan(overlap).some((e) => e.includes('tile the source with no gaps or overlaps')));
});

test('validateSuperPlan rejects first part not starting at 0', () => {
  const doc = makePlan();
  doc.parts[0].series.start_seconds = 10;
  assert.ok(validateSuperPlan(doc).some((e) => e.includes('start_seconds must be 0 for the first part')));
});

test('validateSuperPlan requires exactly one is_final and it must be last', () => {
  const zero = makePlan();
  zero.parts[zero.parts.length - 1].series.is_final = false;
  assert.ok(validateSuperPlan(zero).includes('Exactly one part must be marked series.is_final = true.'));

  const notLast = makePlan();
  notLast.parts[0].series.is_final = true;
  notLast.parts[notLast.parts.length - 1].series.is_final = false;
  const errs = validateSuperPlan(notLast);
  assert.ok(errs.some((e) => e.includes('must be the last entry')));
});

test('validateSuperPlan rejects duplicate titles and per-part errors flow through', () => {
  const dup = makePlan();
  dup.parts[1].title = dup.parts[0].title;
  assert.ok(validateSuperPlan(dup).some((e) => e.includes("duplicates an earlier part's title")));

  const bad = makePlan();
  bad.parts[0].cuts[0].end_seconds = 0;
  assert.ok(validateSuperPlan(bad).some((e) => e.includes('cuts[0].end_seconds must be greater than start_seconds')));
});

test('validateSuperPlan caps parts at MAX_PARTS', () => {
  const boundaries = Array.from({ length: MAX_PARTS + 2 }, (_, i) => i * 10);
  const doc = makePlan({ parts: MAX_PARTS + 1, boundaries });
  assert.ok(validateSuperPlan(doc).some((e) => e.includes(`at most ${MAX_PARTS} entries`)));
});

test('parseAndValidateSuperPlan handles bad JSON', () => {
  const { document, errors } = parseAndValidateSuperPlan('{not json');
  assert.equal(document, null);
  assert.ok(errors.some((e) => e.startsWith('Not valid JSON')));
});

test('sliceSuperPart produces an ordinary valid single-part plan', () => {
  const doc = makePlan();
  for (let index = 0; index < 3; index += 1) {
    const jobId = `series-1-p${index + 1}`;
    const part = sliceSuperPart(doc, index, jobId);
    assert.equal(part.series.part, index + 1);
    assert.equal(part.job_id, jobId);
    assert.deepEqual(validateProductionPlan(part, { partNumber: index + 1 }), []);
  }
});

test('sliceSuperPart re-stamps the AI-written part number with the positional value', () => {
  const doc = makePlan();
  doc.parts[2].series.part = 99;
  const part = sliceSuperPart(doc, 2, 'series-1-p3');
  assert.equal(part.series.part, 3);
});

test('superPartJobId enforces §6.3 identity', () => {
  assert.equal(superPartJobId('series-1', 2), 'series-1-p2');
  assert.throws(() => superPartJobId('bad!', 2), /unsafe/);
});

test('superQueueAdvance queues the next part when everything so far is complete', () => {
  const state = buildSuperState({ anchorJobId: 'manual-1', seriesId: 'series-1', document: makePlan(), spawned: [
    { part: 1, job_id: 'series-1-p1' },
  ] });
  const statusFor = (jobId) => (jobId === 'series-1-p1' ? { state: 'complete' } : null);
  const outcome = superQueueAdvance(state, statusFor);
  assert.equal(outcome.action, 'queue');
  assert.equal(outcome.part, 2);
  assert.equal(outcome.jobId, 'series-1-p2');
  assert.equal(outcome.plan.series.part, 2);
});

test('superQueueAdvance waits when a spawned part is still running', () => {
  const state = buildSuperState({ anchorJobId: 'manual-1', seriesId: 'series-1', document: makePlan(), spawned: [
    { part: 1, job_id: 'series-1-p1' },
  ] });
  const outcome = superQueueAdvance(state, () => ({ state: 'stage_b_running' }));
  assert.equal(outcome.action, 'waiting');
  assert.equal(outcome.part, 1);
});

test('superQueueAdvance HALTS on error and RESUMES after a manual restart to complete', () => {
  const doc = makePlan({ parts: 4, boundaries: [0, 100, 200, 300, 400] });
  const state = buildSuperState({ anchorJobId: 'manual-1', seriesId: 'series-1', document: doc, spawned: [
    { part: 1, job_id: 'series-1-p1' },
    { part: 2, job_id: 'series-1-p2' },
  ] });
  // Simulated failure of part 2 → halt.
  let statuses = { 'series-1-p1': { state: 'complete' }, 'series-1-p2': { state: 'error' } };
  let outcome = superQueueAdvance(state, (id) => statuses[id]);
  assert.equal(outcome.action, 'halted');
  assert.equal(outcome.part, 2);
  assert.ok(outcome.message.includes('failed'));
  assert.ok(outcome.message.includes('resumes automatically'));

  // Operator restarts part 2 → after it completes, the SAME state auto-resumes.
  statuses = { 'series-1-p1': { state: 'complete' }, 'series-1-p2': { state: 'complete' } };
  outcome = superQueueAdvance(state, (id) => statuses[id]);
  assert.equal(outcome.action, 'queue');
  assert.equal(outcome.part, 3);
  assert.equal(outcome.jobId, 'series-1-p3');
});

test('superQueueAdvance halts on cancellation, done when every part is complete', () => {
  const state = buildSuperState({ anchorJobId: 'manual-1', seriesId: 'series-1', document: makePlan(), spawned: [
    { part: 1, job_id: 'series-1-p1' },
  ] });
  assert.equal(superQueueAdvance(state, () => ({ state: 'cancelled' })).action, 'halted');

  const done = buildSuperState({ anchorJobId: 'manual-1', seriesId: 'series-1', document: makePlan(), spawned: [
    { part: 1, job_id: 'series-1-p1' },
    { part: 2, job_id: 'series-1-p2' },
    { part: 3, job_id: 'series-1-p3' },
  ] });
  assert.equal(
    superQueueAdvance(done, () => ({ state: 'complete' })).action,
    'done',
  );
});

test('superPartRequestBody synthesizes an ordinary series continuation request', () => {
  const doc = makePlan();
  const state = buildSuperState({ anchorJobId: 'manual-anchor', seriesId: 'series-1', document: doc });
  const anchorRequest = {
    version: 2,
    job_id: 'manual-anchor',
    source: { kind: 'url', value: 'https://example.com/v' },
    options: { whisper_model: 'base', language: 'auto', target_duration_seconds: 30, focus: '', enable_vision_assist: true },
    mode: 'manual',
    series: { enabled: true, super_series: true, series_id: 'series-1', source_job_id: 'manual-anchor', part: 1, start_seconds: 0, context: '' },
    music: { ref: '', source: 'none' },
  };
  const body = superPartRequestBody(anchorRequest, state, 2, [{ part: 1, summary: 'Setup.' }]);
  assert.equal(body.mode, 'manual');
  assert.equal(body.series.enabled, true);
  assert.equal(body.series.series_id, 'series-1');
  assert.equal(body.series.part, 2);
  assert.equal(body.series.start_seconds, 200);
  assert.ok(body.series.context.includes('Prior events (Part 1): Setup.'));
});
