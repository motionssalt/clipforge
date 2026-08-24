function telegramUrl(token, method) {
  return `https://api.telegram.org/bot${token}/${method}`;
}

export async function telegram(env, method, payload) {
  const response = await fetch(telegramUrl(env.TELEGRAM_BOT_TOKEN, method), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) {
    throw new Error('Telegram could not complete that request.');
  }
  return body.result;
}

export async function sendMessage(env, chatId, text, options = {}) {
  return telegram(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode || 'HTML',
    disable_web_page_preview: options.disablePreview !== false,
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
  });
}

export async function editMessage(env, chatId, messageId, text, options = {}) {
  return telegram(env, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options.parseMode || 'HTML',
    disable_web_page_preview: options.disablePreview !== false,
    ...(options.replyMarkup ? { reply_markup: options.replyMarkup } : {})
  });
}

export async function deleteMessage(env, chatId, messageId) {
  return telegram(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

export async function answerCallback(env, callbackId, text = '') {
  return telegram(env, 'answerCallbackQuery', { callback_query_id: callbackId, ...(text ? { text } : {}) });
}

async function telegramMultipart(env, method, fields, fileField, bytes, fileName, mimeType) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.set(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  form.set(fileField, new Blob([bytes], { type: mimeType }), fileName);
  const response = await fetch(telegramUrl(env.TELEGRAM_BOT_TOKEN, method), { method: 'POST', body: form });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || body.ok !== true) throw new Error('Telegram could not deliver the requested file.');
  return body.result;
}

export async function sendAudioBytes(env, chatId, bytes, filename, caption) {
  return telegramMultipart(env, 'sendAudio', {
    chat_id: chatId,
    caption,
    parse_mode: 'HTML',
    title: filename.replace(/\.mp3$/i, ''),
  }, 'audio', bytes, filename, 'audio/mpeg');
}

export async function sendDocumentBytes(env, chatId, bytes, filename, caption, replyMarkup = null) {
  return telegramMultipart(env, 'sendDocument', {
    chat_id: chatId,
    caption,
    parse_mode: 'HTML',
    ...(replyMarkup ? { reply_markup: replyMarkup } : {})
  }, 'document', bytes, filename, 'text/plain; charset=utf-8');
}

export async function getTelegramFile(env, fileId) {
  return telegram(env, 'getFile', { file_id: fileId });
}

export async function downloadTelegramFile(env, filePath) {
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!response.ok) throw new Error('Telegram could not provide the uploaded file.');
  return response.text();
}

export async function downloadTelegramFileBytes(env, filePath, maximumBytes) {
  const response = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!response.ok) throw new Error('Telegram could not provide the uploaded file.');
  const headerLength = Number(response.headers.get('content-length') || '0');
  if (headerLength && headerLength > maximumBytes) throw new Error('The uploaded torrent exceeds the 1 MB limit.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > maximumBytes) throw new Error('The uploaded torrent must be non-empty and no larger than 1 MB.');
  return bytes;
}

export function buttons(rows) {
  return { inline_keyboard: rows };
}
