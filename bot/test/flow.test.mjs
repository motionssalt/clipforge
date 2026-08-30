/**
 * flow.js — the stateless flow wire format (kv-minimization phase 5).
 * These tests pin the marker grammar, the base64url token codec, and the
 * reply_to/force_reply gate that replaces stored chat state.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeToken, decodeToken, makePayload, parsePayload,
  flowMarkerHtml, withFlowMarker, extractFlowPayload, parseFlowMessage, parseFlowReply
} from '../src/flow.js';

// --- helpers ------------------------------------------------------------- //

function botMessageWithPayload(payload, messageId = 900) {
  const marker = flowMarkerHtml(payload);
  return {
    message_id: messageId,
    from: { is_bot: true, id: 111, first_name: 'ClipForge' },
    text: `Prompt text\n${marker.replace(/<[^>]+>/g, '​')}`,
    entities: [
      { type: 'bold', offset: 0, length: 6 },
      { type: 'text_link', offset: 12, length: 1, url: `https://cf.invalid/f/${encodeURIComponent(payload)}` }
    ]
  };
}

// --- token codec --------------------------------------------------------- //

test('encodeToken/decodeToken round-trips objects with unicode + separators', () => {
  const wizard = {
    v: 1, step: 'music', jobId: 'manual-1788089510438', mode: 'manual', series: true,
    source: { kind: 'url', value: 'https://example.com/a:b:c?v=1&x=2' },
    focus: 'the trial — "cross-examination" ❤️', duration: 60,
    music: { ref: 'audio-library/track one.m4a', source: 'explicit_library' }
  };
  const token = encodeToken(wizard);
  assert.ok(!token.includes(':'), 'token must never contain the payload separator');
  assert.ok(!/[=+/]/.test(token), 'token must be base64url, unpadded');
  assert.deepEqual(decodeToken(token), wizard);
});

test('decodeToken returns null on garbage instead of throwing', () => {
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken('!!!not-base64!!!'), null);
  assert.equal(decodeToken('aGVsbG8'), null); // valid b64, not an object
  assert.equal(decodeToken(null), null);
});

// --- payload grammar ----------------------------------------------------- //

test('makePayload builds and parsePayload round-trips op + args', () => {
  const payload = makePayload('tppm', 'AB', 'post_1788');
  assert.equal(payload, 'cf:tppm:AB:post_1788');
  assert.deepEqual(parsePayload(payload), { op: 'tppm', args: ['AB', 'post_1788'] });
});

test('makePayload enforces the grammar', () => {
  assert.throws(() => makePayload('')); // no opcode
  assert.throws(() => makePayload('A')); // must start lowercase
  assert.throws(() => makePayload('toolongopcode12')); // > 12 chars
  assert.throws(() => makePayload('wz', 'has:colon')); // arg separator
  assert.throws(() => makePayload('wz', 'has space'));
});

test('parsePayload rejects foreign or malformed payloads', () => {
  assert.equal(parsePayload(''), null);
  assert.equal(parsePayload('xx:wz:1'), null);
  assert.equal(parsePayload('cf:'), null);
  assert.equal(parsePayload('cf:OK'), null);
  assert.equal(parsePayload('cf:wz:bad arg'), null);
  assert.deepEqual(parsePayload('cf:clname'), { op: 'clname', args: [] });
});

// --- message embedding / extraction -------------------------------------- //

test('withFlowMarker appends an invisible text_link anchor carrying the payload', () => {
  const payload = makePayload('patnew', encodeToken('my-clone'));
  const text = withFlowMarker('<b>Send the token</b>', payload);
  const message = {
    text: text.replace(/<[^>]+>/g, '​'),
    entities: [{ type: 'text_link', offset: 20, length: 1, url: `https://cf.invalid/f/${encodeURIComponent(payload)}` }]
  };
  assert.equal(extractFlowPayload(message), payload);
  assert.ok(!text.replace(/<[^>]+>/g, '').includes('cf:'), 'payload never appears in visible text');
});

test('extractFlowPayload ignores non-flow links and missing entities', () => {
  assert.equal(extractFlowPayload(null), null);
  assert.equal(extractFlowPayload({}), null);
  assert.equal(extractFlowPayload({ entities: [{ type: 'text_link', url: 'https://example.com/f/cf:wz:1' }] }), null);
  assert.equal(extractFlowPayload({ entities: [{ type: 'url', offset: 0, length: 5 }] }), null);
});

test('parseFlowMessage reports the prompt message id alongside op/args', () => {
  const message = botMessageWithPayload('cf:wz:abc123', 4242);
  assert.deepEqual(parseFlowMessage(message), { op: 'wz', args: ['abc123'], messageId: 4242 });
});

// --- the reply_to / force_reply gate ------------------------------------- //

test('parseFlowReply accepts a reply to the bot\'s own marker prompt', () => {
  const prompt = botMessageWithPayload('cf:zsch:timezone', 777);
  const reply = { message_id: 778, text: 'Europe/London', reply_to_message: prompt };
  assert.deepEqual(parseFlowReply(reply), { op: 'zsch', args: ['timezone'], messageId: 777 });
});

test('parseFlowReply rejects everything that is not a reply to the bot\'s own prompt', () => {
  const prompt = botMessageWithPayload('cf:zsch:timezone', 777);
  // no reply at all
  assert.equal(parseFlowReply({ message_id: 1, text: 'UTC' }), null);
  // reply to a human's message (even one quoting a marker-looking link)
  const humanMessage = { ...prompt, from: { is_bot: false, id: 5 } };
  assert.equal(parseFlowReply({ message_id: 2, reply_to_message: humanMessage }), null);
  // reply to a bot message WITHOUT a marker (e.g. the home menu)
  const plain = { message_id: 3, from: { is_bot: true }, text: 'menu', entities: [] };
  assert.equal(parseFlowReply({ message_id: 4, reply_to_message: plain }), null);
  // reply to a bot message with a MALFORMED payload
  const bad = botMessageWithPayload('cf:BAD OP', 9);
  assert.equal(parseFlowReply({ message_id: 5, reply_to_message: bad }), null);
});

// --- production.json upload payloads (kv-minimization phase 5 step 5.3) --- //

test('upl payload carries just the task label and round-trips through parseFlowReply', () => {
  const label = 'AB';
  const payload = makePayload('upl', label);
  assert.equal(payload, 'cf:upl:AB');
  const prompt = botMessageWithPayload(payload, 501);
  const reply = { message_id: 502, text: '{"parts":[]}', reply_to_message: prompt };
  assert.deepEqual(parseFlowReply(reply), { op: 'upl', args: [label], messageId: 501 });
});

test('uplb payload carries label + base64url buffer token; buffer round-trips', () => {
  const label = 'C';
  const buffer = { f: ['{"foo":', '"bar', '"}'], b: [10, 11, 12] };
  const token = encodeToken(buffer);
  assert.ok(!token.includes(':'), 'buffer token must never break the payload grammar');
  const payload = makePayload('uplb', label, token);
  assert.match(payload, /^cf:uplb:C:[A-Za-z0-9._~-]+$/);
  const prompt = botMessageWithPayload(payload, 601);
  const reply = { message_id: 602, text: 'next fragment', reply_to_message: prompt };
  const parsed = parseFlowReply(reply);
  assert.equal(parsed.op, 'uplb');
  assert.equal(parsed.args[0], label);
  assert.deepEqual(decodeToken(parsed.args[1]), buffer);
  assert.equal(parsed.messageId, 601, 'indicator message id survives so it can be edited/deleted');
});

test('uplb rejects garbage buffer tokens without corrupting the flow', () => {
  const payload = makePayload('uplb', 'AB', 'not-a-real-token');
  assert.deepEqual(parsePayload(payload), { op: 'uplb', args: ['AB', 'not-a-real-token'] });
  assert.equal(decodeToken('not-a-real-token'), null); // handler defaults to an empty buffer
});

test('every ARG_RE-legal task label survives makePayload without escaping', () => {
  // ensureTaskLabel emits A..Z, AA.., AB.., etc. (nextLabel base-26).
  // Every character is ARG_RE-safe: no marker escaping ever needed.
  for (const label of ['A', 'B', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']) {
    assert.doesNotThrow(() => makePayload('upl', label));
    assert.doesNotThrow(() => makePayload('uplb', label, encodeToken({ f: [], b: [] })));
    assert.doesNotThrow(() => makePayload('upldone', label, encodeToken({ f: ['{}'], b: [1] })));
  }
});
