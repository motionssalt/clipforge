// bug-73 (feature-01): the super_series flag produced by wizardToRequest()
// MUST survive buildStageARequest/saveStageARequest onto the PERSISTED
// jobs/<id>/stage-a-request.json. handlePlanUploadMessage routes the uploaded
// plan on the persisted request's series.super_series, and bundle.py branches
// on the same field — so a builder that strips it silently disables Super
// Series even with the setting toggled on. This is exactly the operator's
// reported "Super Series never activates in production" symptom that the
// prior sweep's handler-only tests failed to catch: every layer was correct
// in isolation, but the flag was dropped at the single disk boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { newWizard, wizardToRequest } from '../src/wizard.js';
import { buildStageARequest } from '../src/github.js';

const GITHUB = await readFile(new URL('../src/github.js', import.meta.url), 'utf8');

function makeSuperWizard() {
  const wizard = newWizard();
  wizard.step = 'confirm';
  wizard.series = true;
  wizard.superSeries = true;
  wizard.source = { kind: 'url', value: 'https://example.com/source-video' };
  wizard.duration = 30;
  wizard.music = { ref: '', source: 'none' };
  return wizard;
}

test('wizardToRequest emits series.super_series=true when both toggles are on', () => {
  const request = wizardToRequest(makeSuperWizard(), 'series-1');
  assert.equal(request.series.super_series, true);
});

test('buildStageARequest persists series.super_series=true (bug-73 regression)', () => {
  const request = wizardToRequest(makeSuperWizard(), 'series-1');
  const doc = buildStageARequest('manual-1234567890', request);
  assert.equal(doc.series.enabled, true);
  assert.equal(doc.series.super_series, true, 'persisted request must carry super_series for the upload router and bundle.py');
  assert.equal(doc.series.series_id, 'series-1');
  assert.equal(doc.series.part, 1);
});

test('buildStageARequest omits super_series entirely for ordinary series jobs', () => {
  const wizard = makeSuperWizard();
  wizard.superSeries = false;
  const doc = buildStageARequest('manual-1234567890', wizardToRequest(wizard, 'series-2'));
  assert.equal(doc.series.enabled, true);
  assert.equal('super_series' in doc.series, false, 'ordinary series jobs must not grow the key — the router checks === true');
});

test('buildStageARequest force-drops super_series when series mode is off', () => {
  const wizard = makeSuperWizard();
  wizard.series = false;
  // superSeries:true on a non-series wizard simulates a stale token; the
  // wizardToRequest guard already zeroes it, and the builder must not resurrect it.
  wizard.superSeries = true;
  const doc = buildStageARequest('manual-1234567890', wizardToRequest(wizard, ''));
  assert.equal(doc.series.enabled, false);
  assert.equal('super_series' in doc.series, false);
});

test('buildStageARequest survives an injected request without a series block', () => {
  const doc = buildStageARequest('manual-1234567890', {
    source: { kind: 'url', value: 'https://example.com/x' },
    options: {}, mode: 'manual', music: { ref: '', source: 'none' }
  });
  assert.equal(doc.series.enabled, false);
  assert.equal('super_series' in doc.series, false);
});

test('jsonSchema source contains the super_series regression comment (documents the boundary)', () => {
  assert.match(GITHUB, /super_series === true \? \{ super_series: true \}/);
  assert.match(GITHUB, /handlePlanUploadMessage routes on the PERSISTED request/);
});
