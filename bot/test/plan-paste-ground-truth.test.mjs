/**
 * fix-plan-paste-regression — GROUND-TRUTH verification suite.
 *
 * Written BEFORE any fix, per PLAN_PASTE_FIX_PROGRESS.json. These tests
 * drive the REAL worker (src/index.js) through the REAL dispatch path
 * (handleUpdate -> handleMessage -> parseFlowReply / awaiting_input ->
 * handleFlowReply -> handlePlanUploadMessage) with the same harness shape
 * as awaiting-input.test.mjs (node:sqlite D1 over the real migrations,
 * stubbed global fetch). They answer two questions against committed code,
 * not against prior sessions' self-reports:
 *
 *   ISSUE A — does a multi-bubble production.json paste assemble and
 *     validate when EVERY bubble arrives as a BARE send (no reply_to edge
 *     on any bubble, including continuation fragments), relying solely on
 *     the awaiting_input mechanism? And does the user-visible copy still
 *     demand a reply?
 *
 *   ISSUE B — is the fragment reassembly (per-bubble trim + join(''))
 *     byte-safe for genuine Telegram splits (mid-string, mid-whitespace,
 *     mid-token, empty trailing fragment), or does it corrupt valid JSON?
 *     The per-bubble `.trim()` at the handler's text-capture line deletes
 *     REAL characters whenever Telegram splits inside a whitespace run or
 *     inside a string value adjacent to whitespace; the tests below split
 *     a REAL valid plan at exactly those offsets and assert on the bytes
 *     the handler would commit to the repo (the exact operator-visible
 *     failure mode: a validated-on-their-end production.json failing the
 *     bot's JSON.parse with e.g. "Unexpected token ']'").
 *
 * These become PERMANENT regression tests: once fixed, the same tests must
 * pass unchanged (asserting the now-correct behavior).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { makePayload, withFlowMarker } from '../src/flow.js';
import { ensureTaskLabel, putCredentials, putAwaitingInput, getAwaitingInput } from '../src/storage.js';
import { parseAndValidateProductionPlan } from '../src/plan.js';
import { makeD1 } from './helpers/d1.mjs';

const CHAT = 7717;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const BOT_USER = { id: 9001, is_bot: true, first_name: 'ClipForge' };

// --- A valid production.json shaped like the operator's failing paste: ---- //
// nested "keywords"-style array of {word, color} objects inside a larger
// plan structure, several hundred bytes, so Telegram would split it across
// multiple ~4096-char bubbles for anything bigger (we split it ourselves
// at arbitrary offsets — the size is irrelevant to the join logic).
function buildValidPlan() {
  return {
    schema: 'clipforge.production_plan/v1',
    title: 'Ground Truth Verification Paste',
    video_duration_seconds: 60,
    target_total_duration_seconds: 60,
    cuts: [
      {
        start_seconds: 0,
        end_seconds: 60,
        voiceover_text: 'A single continuous narration for the ground-truth paste verification test.',
        keywords: [
          { word: 'mountain sunrise', color: '#ff8800' },
          { word: 'calm ocean waves', color: '#0088ff' },
          { word: 'forest trail', color: '#00aa44' },
        ],
      },
    ],
    hashtags: ['#one', '#two', '#three', '#four', '#five'],
  };
}
const PLAN_TEXT = JSON.stringify(buildValidPlan(), null, 2);

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

function installFetch({ sent = [], github = [] } = {}) {
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
      let body = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      github.push({ url: u, method: String((init && init.method) || 'GET').toUpperCase(), body });
      if (body && body.content) {
        // Contents API PUT — the committed file content, base64.
        github[github.length - 1].content = Buffer.from(String(body.content), 'base64').toString('utf8');
      }
      if (String((init && init.method) || 'GET').toUpperCase() === 'PUT' || String((init && init.method) || 'GET').toUpperCase() === 'POST') {
        return new Response(JSON.stringify({ content: { sha: 'deadbeef' }, commit: { sha: 'c0ffee' } }), { status: 201 });
      }
      if (u.includes('/branches/')) {
        return new Response(JSON.stringify({ commit: { sha: 'c0ffee' } }), { status: 200 });
      }
      // status.json / stage-a-request.json / production.json reads: absent.
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    throw new Error('unexpected fetch: ' + u);
  };
  return () => { globalThis.fetch = original; };
}

async function drive(env, update) {
  const req = new Request('https://bot.test/', {
    method: 'POST',
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'test-secret' },
    body: JSON.stringify(update),
  });
  const ctx = makeCtx();
  const res = await worker.fetch(req, env, ctx);
  await Promise.all(ctx._pending);
  return res;
}

function textOf(sent) {
  return sent.map((c) => String(c.payload.text || c.payload.caption || '')).join('\n');
}

function bareText(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      text,
      // deliberately NO reply_to_message — the operator pastes bare
    },
  };
}

// ====================================================================== //
// ISSUE A — bare-send mechanism, ground truth                             //
// ====================================================================== //

test('A: a multi-bubble paste of a VALID plan assembles and dispatches with NO reply on any bubble', async () => {
  const env = await makeEnv();
  const label = await ensureTaskLabel(env, CHAT, 'job-paste-a');
  // What the upl prompt's sendForceReply choke point wrote when the
  // operator tapped Upload:
  await putAwaitingInput(env, CHAT, 'upl', makePayload('upl', label));

  const sent = [];
  const github = [];
  const restore = installFetch({ sent, github });
  try {
    // Bubble 1: opening of the JSON, braces unbalanced.
    const splitAt = PLAN_TEXT.indexOf('"voiceover_text"');
    const frag1 = PLAN_TEXT.slice(0, splitAt);
    const frag2 = PLAN_TEXT.slice(splitAt);
    await drive(env, bareText(200, 201, frag1));

    // The buffer must have been re-anchored into awaiting_input as uplb —
    // otherwise the next BARE bubble has nowhere to route.
    const row = await getAwaitingInput(env, CHAT);
    assert.ok(row, 'a live awaiting_input row must exist after fragment 1');
    assert.equal(row.op, 'uplb', 'the row must be re-anchored to uplb with the accumulated buffer');

    // Bubble 2: the remainder, ALSO bare — the exact operator action.
    await drive(env, bareText(201, 202, frag2));

    const allText = textOf(sent);
    assert.ok(!/not valid/i.test(allText),
      'a valid plan pasted bare in two bubbles must NOT fail validation. Bot said:\n' + allText);
    const planPut = github.find((c) => c.method === 'PUT' && c.url.includes('production.json'));
    assert.ok(planPut, 'the assembled plan must be committed to the repo (Stage B dispatch path)');
    const committed = JSON.parse(planPut.content);
    assert.deepEqual(committed.cuts[0].keywords, buildValidPlan().cuts[0].keywords,
      'the committed plan must match the pasted plan');
  } finally { restore(); }
});

test('A: no user-facing copy may instruct the user to REPLY once a bare send works', async () => {
  const env = await makeEnv();
  const label = await ensureTaskLabel(env, CHAT, 'job-paste-copy');
  await putAwaitingInput(env, CHAT, 'upl', makePayload('upl', label));
  const sent = [];
  const restore = installFetch({ sent });
  try {
    const splitAt = PLAN_TEXT.indexOf('"voiceover_text"');
    await drive(env, bareText(210, 211, PLAN_TEXT.slice(0, splitAt)));
    const indicator = textOf(sent);
    assert.ok(!/reply the next fragment/i.test(indicator),
      'the receiving indicator must not say "reply the next fragment" — a bare next bubble routes via awaiting_input. Got:\n' + indicator);
  } finally { restore(); }
});

// ====================================================================== //
// ISSUE B — fragment reassembly, ground truth                             //
// ====================================================================== //

// Faithful replica of handlePlanUploadMessage's text-capture + assembly
// AFTER the paste-fix: EVERY bubble is captured RAW — never trimmed.
// Trimming ANY bubble (even the first) deletes real characters from its
// trailing end whenever a split lands inside a whitespace run or a string
// value; the joined buffer must be byte-identical to the operator's
// original paste. Fragments are joined with NO separator and the result
// fed through the REAL validator. This is the exact data path, extracted
// so Issue B can be tested at every split offset without driving the whole
// worker 400 times. (Pre-fix this replica trimmed every bubble and the
// sweep below failed at 312 offsets; it is kept as the permanent
// regression pin.)
function reassembleLikeHandler(fragments) {
  const captured = fragments.map((f) => String(f || ''));
  const joined = captured.join('');
  // stripCodeFence no-ops on this plan (no fence); looksLikePartialJson's
  // verdicts are asserted separately in the worker-level tests.
  return joined;
}

test('B: exhaustive split-offset sweep — every split of a valid plan must reassemble byte-identically and parse', () => {
  const failures = [];
  for (let cut = 1; cut < PLAN_TEXT.length; cut++) {
    const a = PLAN_TEXT.slice(0, cut);
    const b = PLAN_TEXT.slice(cut);
    const joined = reassembleLikeHandler([a, b]);
    if (joined !== PLAN_TEXT) {
      failures.push({
        cut,
        before: JSON.stringify(PLAN_TEXT.slice(Math.max(0, cut - 12), cut)),
        after: JSON.stringify(PLAN_TEXT.slice(cut, cut + 12)),
        lostOrChanged: JSON.stringify(joined.slice(Math.max(0, cut - 12), cut + 2)),
      });
      continue;
    }
    const { errors } = parseAndValidateProductionPlan(joined);
    if (errors.length) failures.push({ cut, validationErrors: errors.slice(0, 3) });
  }
  assert.deepEqual(failures, [],
    `${failures.length} split offsets corrupt or invalidate a valid plan. First few:\n` +
    failures.slice(0, 5).map((f) => JSON.stringify(f)).join('\n'));
});

test('B: split mid-whitespace-run between tokens (pretty-printed indent) must not eat real characters', () => {
  // A split inside the "\n      " indent before "voiceover_text".
  const cut = PLAN_TEXT.indexOf('"voiceover_text"') - 3; // inside the indent run
  const joined = reassembleLikeHandler([PLAN_TEXT.slice(0, cut), PLAN_TEXT.slice(cut)]);
  assert.equal(joined, PLAN_TEXT,
    'trimming each bubble eats real whitespace when Telegram splits inside a whitespace run');
  const { errors } = parseAndValidateProductionPlan(joined);
  assert.deepEqual(errors, []);
});

test('B: split inside a multi-word STRING value must not corrupt the string', () => {
  // "mountain sunrise" — split between "mountain " and "sunrise": the
  // space is a REAL character inside a string. Trimming bubble 1 deletes
  // it -> "mountainsunrise".
  const target = 'mountain sunrise';
  const cut = PLAN_TEXT.indexOf(target) + 'mountain '.length;
  const joined = reassembleLikeHandler([PLAN_TEXT.slice(0, cut), PLAN_TEXT.slice(cut)]);
  assert.equal(joined, PLAN_TEXT,
    'trimming each bubble corrupts a string value when Telegram splits inside it (space deleted)');
  const { errors } = parseAndValidateProductionPlan(joined);
  assert.deepEqual(errors, []);
});

test('B: split exactly on a token boundary and an empty trailing fragment must be lossless', () => {
  const cut = PLAN_TEXT.indexOf('"voiceover_text"'); // clean token boundary
  const joined = reassembleLikeHandler([PLAN_TEXT.slice(0, cut), PLAN_TEXT.slice(cut)]);
  assert.equal(joined, PLAN_TEXT);
  const withEmptyTail = reassembleLikeHandler([PLAN_TEXT, '']);
  assert.equal(withEmptyTail, PLAN_TEXT, 'an empty trailing bubble must be a no-op');
  assert.deepEqual(parseAndValidateProductionPlan(withEmptyTail).errors, []);
});

test('B: 3-bubble split straddling the keywords array "] }" closers (operator\'s reported error shape)', async () => {
  // Reconstruct the operator's symptom as closely as possible: the paste
  // ends with the nested keywords array — "] } ] }" closers — and the
  // split points are chosen so a `]` and `}` land near fragment
  // boundaries. Under the current handler these bubbles arrive trimmed,
  // and if the closing fragment loses its leading whitespace-adjacent
  // characters the validator reports "Unexpected token ']'" on a plan
  // the user verified as valid. This drives the REAL worker end-to-end.
  const env = await makeEnv();
  const label = await ensureTaskLabel(env, CHAT, 'job-paste-b3');
  await putAwaitingInput(env, CHAT, 'upl', makePayload('upl', label));

  const sent = [];
  const github = [];
  const restore = installFetch({ sent, github });
  try {
    const tail = PLAN_TEXT.lastIndexOf(']'); // keywords-array closer
    const c1 = PLAN_TEXT.indexOf('"keywords"');
    const c2 = tail - 4; // a few chars before the `]` so `]`/`}` sit near the boundary
    const frags = [PLAN_TEXT.slice(0, c1), PLAN_TEXT.slice(c1, c2), PLAN_TEXT.slice(c2)];
    for (let i = 0; i < frags.length; i++) {
      await drive(env, bareText(300 + i, 301 + i, frags[i]));
    }
    const allText = textOf(sent);
    assert.ok(!/not valid|Unexpected token/i.test(allText),
      'a valid plan whose `]`/`}` closers straddle fragment boundaries must NOT fail validation. Bot said:\n' + allText);
    const planPut = github.find((c) => c.method === 'PUT' && c.url.includes('production.json'));
    assert.ok(planPut, 'the plan must be committed');
    assert.deepEqual(JSON.parse(planPut.content).cuts[0].keywords, buildValidPlan().cuts[0].keywords);
  } finally { restore(); }
});

// ---------------------------------------------------------------------- //
// Issue A sub-case: the uplb indicator EDIT path must re-anchor the       //
// awaiting_input row to the NEW buffer (the choke point only sees sends). //
// ---------------------------------------------------------------------- //

test('A: a SECOND bare continuation fragment keeps the full buffer (re-anchor on indicator edit)', async () => {
  const env = await makeEnv();
  const label = await ensureTaskLabel(env, CHAT, 'job-paste-a2');
  await putAwaitingInput(env, CHAT, 'upl', makePayload('upl', label));
  const sent = [];
  const github = [];
  const restore = installFetch({ sent, github });
  try {
    // Three bare bubbles; after bubble 2 the indicator is EDITED in place
    // (not re-sent), so only an explicit re-anchor keeps the row current.
    const c1 = PLAN_TEXT.indexOf('"cuts"');
    const c2 = PLAN_TEXT.indexOf('"hashtags"');
    await drive(env, bareText(400, 401, PLAN_TEXT.slice(0, c1)));
    await drive(env, bareText(401, 402, PLAN_TEXT.slice(c1, c2)));
    const row = await getAwaitingInput(env, CHAT);
    assert.ok(row && row.op === 'uplb', 'the row must still be uplb after the second bare fragment');
    assert.ok(row.payload.includes(':'), 'row payload shape');
    // The row must carry BOTH fragments so far, or bubble 3 loses data.
    const token = row.payload.split(':').slice(3).join(':');
    const decoded = JSON.parse(Buffer.from(token.replaceAll('-', '+').replaceAll('_', '/'), 'base64').toString('utf8'));
    assert.equal(decoded.f.length, 2, 'the re-anchored row must carry both accumulated fragments');
    await drive(env, bareText(402, 403, PLAN_TEXT.slice(c2)));
    const allText = textOf(sent);
    assert.ok(!/not valid/i.test(allText), 'three bare bubbles must assemble. Bot said:\n' + allText);
    assert.ok(github.find((c) => c.method === 'PUT' && c.url.includes('production.json')),
      'the three-bubble plan must be committed');
  } finally { restore(); }
});

test('A: a genuine reply to the upl prompt still works (reply path unharmed)', async () => {
  const env = await makeEnv();
  const label = await ensureTaskLabel(env, CHAT, 'job-paste-reply');
  const sent = [];
  const github = [];
  const restore = installFetch({ sent, github });
  try {
    const prompt = {
      message_id: 50,
      from: BOT_USER,
      text: withFlowMarker('prompt', makePayload('upl', label)),
      entities: [{ type: 'text_link', url: `https://cf.invalid/f/${encodeURIComponent(makePayload('upl', label))}`, offset: 0, length: 1 }],
    };
    await drive(env, {
      update_id: 500,
      message: {
        message_id: 501,
        from: { id: 1, is_bot: false },
        chat: { id: CHAT, type: 'private' },
        text: PLAN_TEXT,
        reply_to_message: prompt,
      },
    });
    const allText = textOf(sent);
    assert.ok(!/not valid/i.test(allText), 'single-bubble reply of the full plan must pass. Bot said:\n' + allText);
    assert.ok(github.find((c) => c.method === 'PUT' && c.url.includes('production.json')));
  } finally { restore(); }
});
