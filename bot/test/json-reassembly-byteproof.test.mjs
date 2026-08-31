/**
 * fix-json-reassembly-definitively — byte-perfect end-to-end proof.
 *
 * Drives the REAL worker (src/index.js) via handleUpdate -> handleMessage
 * -> awaiting_input -> handleFlowReply -> handlePlanUploadMessage with
 * BARE-send Telegram updates (no reply_to_message), which is how the
 * operator's paste actually arrives (restore-bare-send-recognition).
 *
 * Instead of only asserting "the plan committed", this suite intercepts
 * the GitHub PUT for `production.json` and compares its committed bytes
 * to the ORIGINAL plan text BYTE-FOR-BYTE. This is stricter than
 * "JSON.parse succeeded" because a reassembly bug that also silently
 * mutates a string value (e.g. eats a space inside "mountain sunrise")
 * still parses — but produces the WRONG object. Any drift, we see it.
 *
 * Multiple split scenarios: exact Telegram limit (4096 UTF-16 code units),
 * a few chars before/after it, mid-string, mid-whitespace, adjacent to
 * `}`/`]`, and 3+ fragment splits. Plus an OPERATOR-SIZED plan (8 cuts,
 * multi-KB) and a DELIBERATELY LARGER plan to stress the marker-token
 * encode path (marker text rides in a Telegram message subject to the
 * same 4096-char cap; if the accumulated buffer's base64 token pushes
 * the marker past that cap, the edit/send fails and the buffer is lost).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { makePayload } from '../src/flow.js';
import { ensureTaskLabel, putCredentials, putAwaitingInput } from '../src/storage.js';
import { makeD1 } from './helpers/d1.mjs';

const CHAT = 8811;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
// Telegram documented sendMessage/editMessageText text limit: 4096
// UTF-16 code units. (https://core.telegram.org/bots/api#sendmessage —
// 'text: 1-4096 characters after entities parsing'; the client splits
// long user pastes by the same cap.)
const TELEGRAM_TEXT_LIMIT = 4096;

// ---- Plans -------------------------------------------------------------- //

// Operator's reported shape: 8 cuts, each with a keywords array of
// {word,color} objects, longer voiceover_text values, hashtags,
// youtube_tags, target_total_duration_seconds. Pretty-printed so
// whitespace-adjacent splits are realistic.
function buildOperatorPlan() {
  const cuts = [];
  for (let i = 0; i < 8; i++) {
    cuts.push({
      start_seconds: i * 7,
      end_seconds: (i + 1) * 7,
      voiceover_text:
        `Segment ${i + 1}: a deliberately long narration sentence with several spaces and punctuation, ` +
        `so that Telegram splits landing inside this string exercise the mid-string case; ` +
        `it must survive concatenation without losing a single character or shifting a single quote.`,
      keywords: [
        { word: `mountain sunrise ${i}`, color: '#ff8800' },
        { word: `calm ocean waves ${i}`, color: '#0088ff' },
        { word: `forest trail ${i}`, color: '#00aa44' },
      ],
    });
  }
  return {
    schema: 'clipforge.production_plan/v1',
    title: 'Operator-sized Ground Truth Paste',
    video_duration_seconds: 56,
    target_total_duration_seconds: 56,
    cuts,
    hashtags: ['#one', '#two', '#three', '#four', '#five'],
    youtube_tags: ['t1','t2','t3','t4','t5','t6','t7','t8','t9','t10'],
  };
}

// A larger plan to stress the marker-encode ceiling explicitly.
function buildLargerPlan() {
  const cuts = [];
  for (let i = 0; i < 16; i++) {
    cuts.push({
      start_seconds: i * 5,
      end_seconds: (i + 1) * 5,
      voiceover_text:
        `Larger segment ${i + 1}: ` +
        'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ' +
        'ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco ' +
        'laboris nisi ut aliquip ex ea commodo consequat.',
      keywords: [
        { word: `keyword A ${i}`, color: '#112233' },
        { word: `keyword B ${i}`, color: '#445566' },
        { word: `keyword C ${i}`, color: '#778899' },
        { word: `keyword D ${i}`, color: '#aabbcc' },
      ],
    });
  }
  return {
    schema: 'clipforge.production_plan/v1',
    title: 'Larger stress plan',
    video_duration_seconds: 80,
    target_total_duration_seconds: 80,
    cuts,
    hashtags: ['#a', '#b', '#c', '#d', '#e', '#f'],
    youtube_tags: ['u1','u2','u3','u4','u5','u6','u7','u8','u9','u10','u11','u12'],
  };
}

// ---- Harness ------------------------------------------------------------ //

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

/**
 * Fetch stub that mimics Telegram's real 4096-character text limit for
 * sendMessage / editMessageText. If the payload text exceeds that,
 * Telegram would reject with 'text is too long' — surface that here so
 * bugs where our accumulated marker outgrows a Telegram message are
 * visible, not silently swallowed.
 */
function installFetch({ sent = [], github = [], enforceTgTextLimit = true } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      const m = u.split('/').pop();
      let payload = {};
      try { payload = init && init.body ? JSON.parse(String(init.body)) : {}; } catch { payload = {}; }
      sent.push({ method: m, payload });
      if (enforceTgTextLimit && (m === 'sendMessage' || m === 'editMessageText')) {
        const text = String(payload.text || '');
        if (text.length > TELEGRAM_TEXT_LIMIT) {
          return new Response(JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is too long'
          }), { status: 400 });
        }
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 5000 + sent.length } }), { status: 200 });
    }
    if (u.startsWith('https://api.github.com/')) {
      let body = null;
      try { body = init && init.body ? JSON.parse(String(init.body)) : null; } catch { body = null; }
      const method = String((init && init.method) || 'GET').toUpperCase();
      const entry = { url: u, method, body };
      if (body && body.content) {
        entry.content = Buffer.from(String(body.content), 'base64').toString('utf8');
      }
      github.push(entry);
      if (method === 'PUT' || method === 'POST') {
        return new Response(JSON.stringify({ content: { sha: 'deadbeef' }, commit: { sha: 'c0ffee' } }), { status: 201 });
      }
      if (u.includes('/branches/')) return new Response(JSON.stringify({ commit: { sha: 'c0ffee' } }), { status: 200 });
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
function bareText(updateId, messageId, text) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      text,
    },
  };
}
function textOf(sent) {
  return sent.map((c) => String(c.payload.text || c.payload.caption || '')).join('\n');
}

/**
 * Split ORIGINAL text into `pieces` fragments where each is <= chunkSize
 * UTF-16 code units (Telegram's own splitting rule for long user pastes).
 */
function splitByLimit(text, chunkSize) {
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) out.push(text.slice(i, i + chunkSize));
  return out;
}

async function driveBareFragments(env, fragments, baseId = 200) {
  for (let i = 0; i < fragments.length; i++) {
    await drive(env, bareText(baseId + i, baseId + 100 + i, fragments[i]));
  }
}

/**
 * Assert: the plan committed to the repo is byte-for-byte the original
 * plan text (i.e. reassembly was lossless AND validation passed AND the
 * Stage B dispatch ran).
 */
function assertCommittedIdentical(github, sent, originalText, scenarioLabel) {
  const allText = textOf(sent);
  const putPlan = github.find((c) => c.method === 'PUT' && c.url.includes('production.json'));
  if (!putPlan) {
    // A missing PUT means the plan never validated — surface the bot's
    // user-visible messages so failures show exactly WHAT the bot said.
    assert.fail(
      `[${scenarioLabel}] plan was NOT committed. Bot said:\n${allText}\n\n` +
      `github calls (${github.length}):\n` +
      github.slice(0, 8).map((c) => `${c.method} ${c.url}`).join('\n')
    );
  }
  // parseAndValidateProductionPlan re-serializes with `JSON.stringify(document, null, 2)\n`.
  // Compare committed against the same normalization of the ORIGINAL parsed value.
  const committedText = putPlan.content;
  const originalObject = JSON.parse(originalText);
  const expected = JSON.stringify(originalObject, null, 2) + '\n';
  if (committedText !== expected) {
    // Show first diverging char to make the defect obvious.
    let idx = 0;
    while (idx < Math.min(committedText.length, expected.length) &&
           committedText[idx] === expected[idx]) idx++;
    assert.fail(
      `[${scenarioLabel}] committed plan bytes DIFFER from the operator's original.\n` +
      `first divergence at index ${idx}\n` +
      `expected …${JSON.stringify(expected.slice(Math.max(0, idx - 20), idx + 20))}\n` +
      `got      …${JSON.stringify(committedText.slice(Math.max(0, idx - 20), idx + 20))}\n` +
      `expected length ${expected.length}, got ${committedText.length}\n` +
      `bot said:\n${allText.slice(0, 800)}`
    );
  }
  assert.ok(!/not valid|Unexpected token/i.test(allText),
    `[${scenarioLabel}] bot must not report validation errors. Bot said:\n${allText}`);
}

async function runScenario(label, planText, fragments) {
  const env = await makeEnv();
  const jobLabel = await ensureTaskLabel(env, CHAT, `job-${label.replace(/[^a-z0-9]/gi, '').slice(0, 24)}`);
  await putAwaitingInput(env, CHAT, 'upl', makePayload('upl', jobLabel));
  const sent = [];
  const github = [];
  const restore = installFetch({ sent, github });
  try {
    await driveBareFragments(env, fragments);
    assertCommittedIdentical(github, sent, planText, label);
  } finally { restore(); }
}

// ---- Tests -------------------------------------------------------------- //

const OPERATOR_PLAN_TEXT = JSON.stringify(buildOperatorPlan(), null, 2);
const LARGER_PLAN_TEXT = JSON.stringify(buildLargerPlan(), null, 2);

test('byteproof: operator-sized plan split by Telegram 4096-limit reassembles byte-for-byte (bare sends)', async () => {
  // This is exactly what Telegram does to a long user paste: length-split
  // by TELEGRAM_TEXT_LIMIT UTF-16 code units. No reply edge on any bubble.
  const frags = splitByLimit(OPERATOR_PLAN_TEXT, TELEGRAM_TEXT_LIMIT);
  assert.ok(frags.length >= 2, `operator plan must be multi-bubble; got ${frags.length} @ ${OPERATOR_PLAN_TEXT.length} chars`);
  await runScenario('op-4096-split', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: operator-sized plan split a FEW chars before the 4096 limit', async () => {
  const frags = splitByLimit(OPERATOR_PLAN_TEXT, TELEGRAM_TEXT_LIMIT - 7);
  await runScenario('op-4089-split', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: operator-sized plan split mid-string-value (space-adjacent) reassembles byte-for-byte', async () => {
  const target = 'mountain sunrise 3';
  const at = OPERATOR_PLAN_TEXT.indexOf(target) + 'mountain '.length;
  const frags = [OPERATOR_PLAN_TEXT.slice(0, at), OPERATOR_PLAN_TEXT.slice(at)];
  await runScenario('op-midstring', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: operator-sized plan split mid-whitespace-run reassembles byte-for-byte', async () => {
  const at = OPERATOR_PLAN_TEXT.indexOf('"voiceover_text"') - 3;
  const frags = [OPERATOR_PLAN_TEXT.slice(0, at), OPERATOR_PLAN_TEXT.slice(at)];
  await runScenario('op-midws', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: operator-sized plan 3-fragment split straddling `]` and `}` closers reassembles byte-for-byte', async () => {
  const tail = OPERATOR_PLAN_TEXT.lastIndexOf(']');
  const c1 = OPERATOR_PLAN_TEXT.indexOf('"cuts"');
  const c2 = tail - 4;
  const frags = [
    OPERATOR_PLAN_TEXT.slice(0, c1),
    OPERATOR_PLAN_TEXT.slice(c1, c2),
    OPERATOR_PLAN_TEXT.slice(c2),
  ];
  await runScenario('op-3frag-closers', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: operator-sized plan with an empty trailing bubble is a no-op and commits identical bytes', async () => {
  const frags = splitByLimit(OPERATOR_PLAN_TEXT, TELEGRAM_TEXT_LIMIT).concat(['']);
  await runScenario('op-empty-tail', OPERATOR_PLAN_TEXT, frags);
});

test('byteproof: LARGER plan (marker-token ceiling stress) split by 4096 reassembles byte-for-byte', async () => {
  // This one is the sharpest test of the marker-size hypothesis: a plan
  // large enough that the accumulated b64 fragment token embedded in the
  // ⏳ indicator's cf:uplb marker grows past Telegram's 4096-char text
  // cap for the WHOLE indicator message. If the fix does not move the
  // buffer out of the marker, this test fails with 'plan was NOT
  // committed' because either the sendMessage/editMessageText for the
  // indicator was rejected by our TG stub (mirroring real Telegram) or
  // the choke-point putAwaitingInput write encoded a token whose next
  // reply cannot decode it correctly.
  const frags = splitByLimit(LARGER_PLAN_TEXT, TELEGRAM_TEXT_LIMIT);
  assert.ok(frags.length >= 2, `larger plan must be multi-bubble; got ${frags.length} @ ${LARGER_PLAN_TEXT.length} chars`);
  await runScenario('larger-4096-split', LARGER_PLAN_TEXT, frags);
});

test('byteproof: LARGER plan split into MANY (5+) fragments still reassembles byte-for-byte', async () => {
  const chunk = Math.max(200, Math.ceil(LARGER_PLAN_TEXT.length / 6));
  const frags = splitByLimit(LARGER_PLAN_TEXT, chunk);
  assert.ok(frags.length >= 5, `expected 5+ fragments; got ${frags.length}`);
  await runScenario('larger-many-frag', LARGER_PLAN_TEXT, frags);
});
