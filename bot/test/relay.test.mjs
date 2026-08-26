import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RELAY_VIDEO_BYTES, RELAY_SOURCE_TYPE, parseRelayCaption, parseRelayReadyMarker,
  parseRelayReadySignal, relayCaption, relayReadyMarker, relayVideoMetadata
} from '../src/relay.js';
import { getRelayJob, putRelayJob } from '../src/storage.js';
import { __test as relayWorker } from '../src/relay-worker.js';

test('relay caption round-trips job id and chat id', () => {
  const caption = relayCaption('manual-1787692652625', 123456789);
  assert.equal(caption, 'CFRELAY1:manual-1787692652625:123456789');
  assert.deepEqual(parseRelayCaption(caption), { jobId: 'manual-1787692652625', sourceChatId: 123456789 });
});

test('relay caption rejects unsafe identifiers', () => {
  assert.throws(() => relayCaption('bad job!', 1));
  assert.throws(() => relayCaption('manual-1', 'not-a-chat'));
  assert.equal(parseRelayCaption('CFRELAY1:'), null);
  assert.equal(parseRelayCaption('something else entirely'), null);
});

test('ready marker round-trips and parses from the /relay@bot command form', () => {
  const marker = relayReadyMarker('manual-9', 555, 777);
  assert.equal(marker, 'CFRELAY_READY1:manual-9:555:777');
  assert.deepEqual(parseRelayReadyMarker(marker), { jobId: 'manual-9', sourceChatId: 555, groupMessageId: 777 });
  const viaCommand = parseRelayReadySignal(`/relay@Clipforgedl_bot ${marker}`);
  assert.deepEqual(viaCommand, { jobId: 'manual-9', sourceChatId: 555, groupMessageId: 777 });
  assert.equal(parseRelayReadySignal('/relay@Clipforgedl_bot nonsense'), null);
  assert.throws(() => relayReadyMarker('manual-9', 555, 0));
});

test('relay video metadata accepts videos and video documents, rejects the rest', () => {
  const video = relayVideoMetadata({ message_id: 5, video: { file_id: 'f', file_unique_id: 'u', file_size: 1024, mime_type: 'video/mp4' } });
  assert.equal(video.media_kind, 'video');
  assert.equal(video.file_size, 1024);
  const doc = relayVideoMetadata({ message_id: 6, document: { file_id: 'f', file_unique_id: 'u', file_size: 2048, mime_type: 'video/quicktime', file_name: 'clip.MOV' } });
  assert.equal(doc.media_kind, 'document_video');
  assert.equal(doc.file_name, 'clip.MOV');
  assert.equal(relayVideoMetadata({ message_id: 7, document: { file_id: 'f', file_unique_id: 'u', file_size: 10, mime_type: 'application/pdf', file_name: 'x.pdf' } }), null);
  assert.equal(relayVideoMetadata({ message_id: 8, text: 'hello' }), null);
});

test('relay video metadata enforces the 1800 MiB safety cap', () => {
  assert.equal(MAX_RELAY_VIDEO_BYTES, 1800 * 1024 * 1024);
  assert.throws(() => relayVideoMetadata({ message_id: 1, video: { file_id: 'f', file_unique_id: 'u', file_size: MAX_RELAY_VIDEO_BYTES + 1 } }), /safety limit/);
  assert.throws(() => relayVideoMetadata({ message_id: 1, video: { file_id: 'f', file_unique_id: 'u', file_size: 0 } }));
});

test('Bot B relevance gate: right group + Bot A + relay shape, before any KV access', () => {
  const env = { INTERNAL_RELAY_GROUP_CHAT_ID: '-5405387856', BOT_A_TELEGRAM_ID: '8670100252' };
  const base = { chat: { id: -5405387856 }, from: { id: 8670100252, is_bot: true } };
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, caption: 'CFRELAY1:manual-1:123', video: { file_id: 'x' } }), true);
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, text: '/relay@Clipforgedl_bot CFRELAY_READY1:manual-1:123:9' }), true);
  // wrong group
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, chat: { id: -1 }, caption: 'CFRELAY1:manual-1:123', video: { file_id: 'x' } }), false);
  // not from Bot A
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, from: { id: 42, is_bot: true }, caption: 'CFRELAY1:manual-1:123', video: { file_id: 'x' } }), false);
  // not a bot at all
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, from: { id: 8670100252, is_bot: false }, caption: 'CFRELAY1:manual-1:123', video: { file_id: 'x' } }), false);
  // relay-shaped text from Bot A but neither media caption nor ready signal
  assert.equal(relayWorker.isRelevantRelayUpdate(env, { ...base, text: 'hello group' }), false);
  // missing config fails closed
  assert.equal(relayWorker.isRelevantRelayUpdate({}, { ...base, caption: 'CFRELAY1:manual-1:123', video: { file_id: 'x' } }), false);
});

test('Bot B sealed-payload gate requires ready state and matching media message', () => {
  const sealed = 'x'.repeat(100);
  const record = { state: 'ready', relay: { internal_group_message_id: 777 }, sealed_payload: sealed };
  assert.equal(relayWorker.sealedRelayPayload(record, { groupMessageId: 777 }), sealed);
  assert.throws(() => relayWorker.sealedRelayPayload({ ...record, state: 'staged' }, { groupMessageId: 777 }));
  assert.throws(() => relayWorker.sealedRelayPayload(record, { groupMessageId: 778 }));
  assert.throws(() => relayWorker.sealedRelayPayload({ ...record, sealed_payload: 'short' }, { groupMessageId: 777 }));
});

test('relay source type constant matches the sealed-payload semantics', () => {
  assert.equal(RELAY_SOURCE_TYPE, 'telegram_bot_forward');
});

// Map-backed CLIPFORGE_BOT_KV stub plus the Bot B routing config Bot B's
// gates require. Only the storage surface relay code touches is implemented.
function mockRelayEnv() {
  const kv = new Map();
  return {
    INTERNAL_RELAY_GROUP_CHAT_ID: '-5405387856',
    BOT_A_TELEGRAM_ID: '8670100252',
    CLIPFORGE_BOT_KV: {
      async get(name) { return kv.has(name) ? kv.get(name) : null; },
      async put(name, value) { kv.set(name, String(value)); },
      async delete(name) { kv.delete(name); }
    }
  };
}

function copiedMediaMessage(caption, fileId) {
  return {
    chat: { id: -5405387856 },
    from: { id: 8670100252, is_bot: true },
    caption,
    video: { file_id: fileId }
  };
}

test('race closed: staging-time record lets Bot B attach copied media before any confirm-time fields exist', async () => {
  const env = mockRelayEnv();
  const chatId = 123456789;
  const jobId = 'manual-1787692652625';
  // Exactly what handleWizardRelayVideo now writes at staging time: media
  // coordinates and the group chat id, but no internal_group_message_id yet
  // and none of the confirm-time fields (state 'ready', sealed_payload).
  await putRelayJob(env, chatId, jobId, {
    state: 'staged',
    repo: 'owner/clone',
    mode: 'automatic',
    relay: {
      source_type: 'telegram_bot_forward', media_kind: 'video', file_id: 'f', file_unique_id: 'u',
      file_size: 1024, mime_type: 'video/mp4', file_name: 'telegram-video.mp4', source_message_id: 5,
      internal_group_chat_id: -5405387856
    }
  });
  // Bot B observes the group copy in the window between staging and confirm.
  await relayWorker.rememberCopiedMedia(env, copiedMediaMessage(relayCaption(jobId, chatId), 'botb-file-id'));
  const record = await getRelayJob(env, chatId, jobId);
  assert.equal(record.relay.bot_b_file_id, 'botb-file-id');
  assert.equal(record.state, 'staged'); // confirm-time upgrade has not run yet
  assert.equal(record.sealed_payload, undefined);
});

test('pre-fix behavior documented: with no staging record the copied-media update is silently dropped', async () => {
  const env = mockRelayEnv();
  await relayWorker.rememberCopiedMedia(env, copiedMediaMessage(relayCaption('manual-1', 555), 'botb-file-id'));
  assert.equal(await getRelayJob(env, 555, 'manual-1'), null);
});

test('rememberCopiedMedia still refuses malformed or out-of-scope updates', async () => {
  const env = mockRelayEnv();
  await putRelayJob(env, 555, 'manual-1', { state: 'staged', relay: { internal_group_chat_id: -5405387856 } });
  // wrong group
  await relayWorker.rememberCopiedMedia(env, { ...copiedMediaMessage(relayCaption('manual-1', 555), 'x'), chat: { id: -1 } });
  // not from Bot A
  await relayWorker.rememberCopiedMedia(env, { ...copiedMediaMessage(relayCaption('manual-1', 555), 'x'), from: { id: 42, is_bot: true } });
  // no relay caption
  await relayWorker.rememberCopiedMedia(env, copiedMediaMessage('hello group', 'x'));
  const record = await getRelayJob(env, 555, 'manual-1');
  assert.equal(record.relay.bot_b_file_id, undefined);
});
