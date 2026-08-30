/**
 * Phase-5 flow regression sweep — pins the defect class "a force_reply/
 * marker prompt whose copy invites an input shape Telegram will not attach
 * as reply_to_message (forward / plain direct send), so parseFlowReply
 * silently misses it".
 *
 * These tests drive the real webhook entry (default export's fetch) with a
 * synthetic update object matching the EXACT failure shapes, and assert the
 * routing/outcome. Harness mirrors stateless-cancel.test.mjs / tasks.test.mjs:
 * Map-backed KV stub, node:sqlite D1 harness, stubbed global fetch (GitHub
 * reads 404, Telegram calls recorded).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';
import { makePayload, withFlowMarker } from '../src/flow.js';
import { newWizard, encodeWizardToken, stepPrompt } from '../src/wizard.js';
import { makeD1 } from './helpers/d1.mjs';

const CHAT = 5150;
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const BOT_USER = { id: 9001, is_bot: true, first_name: 'ClipForge' };

function makeKv() {
  const map = new Map();
  return {
    get: async (k) => (map.has(k) ? map.get(k) : null),
    put: async (k, v) => { map.set(k, String(v)); },
    delete: async (k) => { map.delete(k); },
    _map: map,
  };
}

function makeEnv(kv) {
  return {
    CLIPFORGE_BOT_KV: kv,
    CLIPFORGE_BOT_D1: makeD1(),
    KV_ENCRYPTION_KEY: TEST_KEY,
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
  };
}

function makeCtx() {
  const pending = [];
  return { waitUntil: (p) => pending.push(Promise.resolve(p)), _pending: pending };
}

function installFetch({ sent = [] } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    if (u.startsWith('https://api.telegram.org/')) {
      const method = u.split('/').pop();
      let payload = {};
      try { payload = init && init.body ? JSON.parse(String(init.body)) : {}; } catch { payload = {}; }
      sent.push({ method, payload });
      return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length, message_id_seq: sent.length } }), { status: 200 });
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

/** A genuine reply to the bot's own wzs source-step prompt. */
function wizardPromptReply(userMessage, wizard) {
  const wizardPrompt = {
    message_id: 50,
    from: BOT_USER,
    text: withFlowMarker('prompt', makePayload('wzs', encodeWizardToken(wizard))),
    entities: [], // entities are populated from the text_link in real Telegram; see below
  };
  // Telegram encodes the marker as a text_link entity; reconstruct it so
  // extractFlowPayload can read the payload out of the replied-to message.
  const payload = makePayload('wzs', encodeWizardToken(wizard));
  const url = `https://cf.invalid/f/${encodeURIComponent(payload)}`;
  wizardPrompt.entities = [{ type: 'text_link', url, offset: 0, length: 1 }];
  return { ...userMessage, reply_to_message: wizardPrompt };
}

test('source-step prompt copy explicitly instructs REPLYING (no bare send/forward promise)', () => {
  const text = stepPrompt(newWizard()).text;
  assert.match(text, /Reply to this message/i, 'must ask for a reply');
  assert.doesNotMatch(text, /^\s*Send the video\b/i, 'must not open with a bare "Send the video"');
  assert.match(text, /forward/i, 'must warn that forwards are not matched');
});

test('a .torrent REPLY to the wzs source-step prompt routes to the wizard (not the reject branch)', async () => {
  const env = makeEnv(makeKv());
  const sent = [];
  const restore = installFetch({ sent });
  try {
    const wizard = newWizard();
    const reply = wizardPromptReply({
      message_id: 51,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      document: { file_name: 'source.torrent', file_id: 'f1', file_unique_id: 'u1', file_size: 2048 },
    }, wizard);
    const res = await drive(env, { update_id: 1, message: reply });
    assert.equal(res.status, 200);
    const allText = sent.map((c) => String(c.payload.text || c.payload.caption || '')).join('\n');
    assert.ok(!/not expected/i.test(allText), 'must NOT hit the reject branch');
    // The wizard advances past source: either the next step or the focus/length prompt.
    assert.ok(/step 2\/5|step 3\/5|focus|length|New video/i.test(allText), 'wizard should advance past the source step');
  } finally { restore(); }
});

test('a forwarded .torrent (NO reply_to_message) gets explicit reply guidance, not silence and not the old misleading copy', async () => {
  const env = makeEnv(makeKv());
  const sent = [];
  const restore = installFetch({ sent });
  try {
    const forwarded = {
      message_id: 60,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      forward_from_chat: { id: -100, type: 'channel' },
      document: { file_name: 'movie.torrent', file_id: 'f2', file_unique_id: 'u2', file_size: 4096 },
      // NOTE: no reply_to_message — this is the exact failure shape.
    };
    const res = await drive(env, { update_id: 2, message: forwarded });
    assert.equal(res.status, 200);
    const allText = sent.map((c) => String(c.payload.text || '')).join('\n');
    assert.ok(/reply/i.test(allText), 'must tell the user to reply');
    assert.ok(/step-1|step 1|step-1 prompt/i.test(allText), 'must point at the step-1 prompt');
    assert.ok(!/send or forward the video/i.test(allText), 'old misleading copy must be gone');
  } finally { restore(); }
});

test('a bare forwarded video (NO reply_to_message) gets the explicit reply guidance too', async () => {
  const env = makeEnv(makeKv());
  const sent = [];
  const restore = installFetch({ sent });
  try {
    const forwarded = {
      message_id: 61,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      video: { file_id: 'v1', file_unique_id: 'vu1', file_size: 100000, mime_type: 'video/mp4', duration: 12 },
    };
    await drive(env, { update_id: 3, message: forwarded });
    const allText = sent.map((c) => String(c.payload.text || '')).join('\n');
    assert.ok(/reply to the step-1 prompt/i.test(allText));
  } finally { restore(); }
});

test('reply-only contract for TEXT flows is preserved: bare non-reply text still falls through to home', async () => {
  const env = makeEnv(makeKv());
  const sent = [];
  const restore = installFetch({ sent });
  try {
    const bareText = {
      message_id: 70,
      from: { id: 1, is_bot: false },
      chat: { id: CHAT, type: 'private' },
      text: 'https://example.com/video.mp4', // looks like a wizard answer but is NOT a reply
    };
    await drive(env, { update_id: 4, message: bareText });
    // No wzs routing may happen for a non-reply text — the home menu renders.
    const allText = sent.map((c) => String(c.payload.text || '')).join('\n');
    assert.ok(!/step 2\/5|focus/i.test(allText), 'bare text must NOT advance the wizard');
  } finally { restore(); }
});
