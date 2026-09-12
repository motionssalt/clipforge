/**
 * bug-73 regression coverage: the three Super Series settings callback_data
 * values (set:superseries, set:superseries:on, set:superseries:off) must each
 * be matched by a handler in the settings-callback dispatch, and the toggle
 * handlers must produce the settings read/write side effects (which the prior
 * sweep shipped without — buttons existed but nothing handled them, so the
 * setting could never be saved).
 *
 * This is a static wiring test: it asserts the dispatch logic matches all
 * three exact callback strings and that the handler performs the documented
 * saveSuperSeriesSettings(credentials, repo, true|false) calls plus a live
 * readSuperSeriesSettings re-render. It guards against the exact class of bug
 * where a button is emitted with no matched handler.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'src', 'index.js'), 'utf8');

function dispatchMatches(callbackData, source) {
  // handleSettingsCallback splits data on ':' and matches parts[1] via
  // `if (key === '<k>')` blocks inside the function body.
  const bodyStart = source.indexOf('async function handleSettingsCallback');
  assert.ok(bodyStart > 0, 'handleSettingsCallback exists');
  // take the settings dispatch body up to the next top-level function
  const bodyEnd = source.indexOf('\nasync function ', bodyStart + 10);
  const body = source.slice(bodyStart, bodyEnd);
  const parts = callbackData.split(':');
  const key = parts[1];
  const value = parts.slice(2).join(':');
  const keyRe = new RegExp(`key === '${key}'`);
  assert.ok(keyRe.test(body), `settings dispatch matches key '${key}' for ${callbackData}`);
  if (value) {
    const keyBlock = body.slice(body.indexOf(`key === '${key}'`));
    const valueRe = new RegExp(`value === '${value}'`);
    assert.ok(valueRe.test(keyBlock), `handler for key '${key}' checks value === '${value}'`);
  }
  return body;
}

test("bug-73: 'set:superseries' opens the Super Series settings screen", () => {
  const body = dispatchMatches('set:superseries', src);
  const block = body.slice(body.indexOf("key === 'superseries'"));
  assert.ok(block.includes('readSuperSeriesSettings'), 'screen renders live state via readSuperSeriesSettings');
  assert.ok(block.includes('renderInteractiveView'), 'screen is actually rendered');
});

test("bug-73: 'set:superseries:on' saves enabled:true and re-renders", () => {
  dispatchMatches('set:superseries:on', src);
  const body = src.slice(src.indexOf("key === 'superseries'"));
  assert.ok(
    /saveSuperSeriesSettings\(credentials, credentials\.repo, value === 'on'\)/.test(body),
    "toggle handler calls saveSuperSeriesSettings(credentials, credentials.repo, value === 'on')"
  );
  assert.ok(body.includes('readSuperSeriesSettings'), 'handler re-reads state after save to re-render');
});

test("bug-73: 'set:superseries:off' is handled by the same toggle block", () => {
  dispatchMatches('set:superseries:off', src);
  const body = src.slice(src.indexOf("key === 'superseries'"));
  assert.ok(/value === 'on' \|\| value === 'off'/.test(body), 'both on and off values are treated as toggles');
});

test('bug-73: Super Series entry button is emitted from the Series Mode screen', () => {
  // the entry point into the screen must exist upstream in the same dispatch
  assert.ok(src.includes("callback_data: 'set:superseries'"), 'Series Mode screen emits the set:superseries button');
  assert.ok(src.includes("callback_data: 'set:superseries:on'"), 'Super Series screen emits set:superseries:on');
  assert.ok(src.includes("callback_data: 'set:superseries:off'"), 'Super Series screen emits set:superseries:off');
});

test('bug-73: every set:superseries* callback emitted has a matched handler key', () => {
  // minimal general regression for this class: every emitted callback_data
  // beginning with set: must have its key matched in handleSettingsCallback.
  const emitted = new Set();
  for (const m of src.matchAll(/callback_data: 'set:([^']+)'/g)) {
    emitted.add(m[1].split(':')[0]);
  }
  const bodyStart = src.indexOf('async function handleSettingsCallback');
  const bodyEnd = src.indexOf('\nasync function ', bodyStart + 10);
  const body = src.slice(bodyStart, bodyEnd);
  for (const key of emitted) {
    assert.ok(
      new RegExp(`key === '${key}'`).test(body),
      `emitted settings key '${key}' has a matched handler in handleSettingsCallback`
    );
  }
});
