import { dispatchWorkflow } from './github.js';
import { getRelayJob, putRelayJob } from './storage.js';
import { parseRelayCaption, parseRelayReadySignal } from './relay.js';

const RELAY_UPDATE_TTL_SECONDS = 24 * 60 * 60;

function validWebhook(request, env) {
  const header = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  return Boolean(env.BOT_B_TELEGRAM_WEBHOOK_SECRET) && header === env.BOT_B_TELEGRAM_WEBHOOK_SECRET;
}

function configuredInteger(value) {
  const parsed = Number(String(value || '').trim());
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function seenRelayUpdate(env, updateId) {
  if (!Number.isInteger(updateId)) return false;
  const key = `relay:update:${updateId}`;
  if (await env.CLIPFORGE_BOT_KV.get(key)) return true;
  await env.CLIPFORGE_BOT_KV.put(key, '1', { expirationTtl: RELAY_UPDATE_TTL_SECONDS });
  return false;
}

function centralCredentials(env) {
  const githubPat = String(env.RELAY_GITHUB_TOKEN || '').trim();
  const repo = String(env.RELAY_GITHUB_REPOSITORY || 'motionssalt/clipforge').trim();
  if (!githubPat || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Bot B central relay GitHub credentials are not configured.');
  return { githubPat, repo };
}

function sealedRelayPayload(record, marker) {
  const relay = record && record.relay || {};
  const sealed = String(record && record.sealed_payload || '');
  if (record.state !== 'ready' || !relay || Number(relay.internal_group_message_id) !== marker.groupMessageId) {
    throw new Error('The relay job is not ready or does not match the copied media message.');
  }
  if (sealed.length < 64 || sealed.length > 16000) throw new Error('The relay job does not contain a valid sealed payload.');
  return sealed;
}

function relayMediaFileId(message) {
  const media = message && (message.video || message.document);
  return String(media && media.file_id || '').trim();
}

async function rememberCopiedMedia(env, message) {
  const groupId = configuredInteger(env.INTERNAL_RELAY_GROUP_CHAT_ID);
  const botAId = configuredInteger(env.BOT_A_TELEGRAM_ID);
  if (!groupId || !botAId || !message || !message.chat || Number(message.chat.id) !== groupId) return;
  if (!message.from || Number(message.from.id) !== botAId || message.from.is_bot !== true) return;
  const caption = parseRelayCaption(message.caption);
  const fileId = relayMediaFileId(message);
  if (!caption || !fileId) return;
  const record = await getRelayJob(env, caption.sourceChatId, caption.jobId);
  if (!record || !record.relay) return;
  await putRelayJob(env, caption.sourceChatId, caption.jobId, {
    ...record,
    relay: { ...record.relay, bot_b_file_id: fileId },
  });
}

async function routeReadyMarker(env, message) {
  const groupId = configuredInteger(env.INTERNAL_RELAY_GROUP_CHAT_ID);
  const botAId = configuredInteger(env.BOT_A_TELEGRAM_ID);
  if (!groupId || !botAId) throw new Error('Bot B internal-group routing is not configured.');
  if (!message || !message.chat || Number(message.chat.id) !== groupId) return;
  if (!message.from || Number(message.from.id) !== botAId || message.from.is_bot !== true) return;
  const marker = parseRelayReadySignal(message.text);
  if (!marker) return;
  const record = await getRelayJob(env, marker.sourceChatId, marker.jobId);
  if (!record) throw new Error('Bot B could not find the pending relay job. The source may have expired; send the video again.');
  const sealedPayload = sealedRelayPayload(record, marker);
  const relayFileId = String(record.relay && record.relay.bot_b_file_id || '').trim();
  if (!relayFileId) throw new Error('Bot B did not receive the copied media before the relay marker. Send the video again.');
  const central = centralCredentials(env);
  await dispatchWorkflow(central, central.repo, 'telegram-relay.yml', { job_id: marker.jobId, relay_payload: sealedPayload, relay_file_id: relayFileId });
  await putRelayJob(env, marker.sourceChatId, marker.jobId, { ...record, state: 'dispatched', dispatched_at_epoch: Math.floor(Date.now() / 1000) });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') return new Response('ok', { status: 200 });
    if (request.method !== 'POST' || url.pathname !== '/webhook') return new Response('Not found', { status: 404 });
    if (!validWebhook(request, env)) return new Response('Unauthorized', { status: 401 });
    let update;
    try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
    try {
      if (!await seenRelayUpdate(env, update.update_id)) {
        await rememberCopiedMedia(env, update.message);
        await routeReadyMarker(env, update.message);
      }
    } catch (error) {
      // Never echo routing credentials or encrypted payloads to Telegram or logs.
      console.log(`Bot B relay routing failed: ${String(error && error.message || 'unknown error').replace(/(?:ghp|github_pat)_[A-Za-z0-9_]+/g, '[redacted]')}`);
    }
    return new Response('ok', { status: 200 });
  }
};

export const __test = { configuredInteger, parseRelayCaption, parseRelayReadySignal, relayMediaFileId, sealedRelayPayload };
