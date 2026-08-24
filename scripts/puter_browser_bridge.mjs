#!/usr/bin/env node
/*
 * Persistent headless-Chromium bridge for ClipForge Automatic Mode.
 *
 * This bridge deliberately does not call Puter's REST/OpenAI endpoint. Each
 * catalog/chat operation is evaluated inside a Chromium page that loaded the
 * real https://js.puter.com/v2/ client. Python communicates over JSONL and
 * never logs a token or raw browser error object.
 */

import readline from 'node:readline';
import process from 'node:process';
import { chromium } from 'playwright';

const PAGE_URL = process.env.PUTER_BROWSER_PAGE_URL || 'https://puter.com/';
const SENSITIVE_KEY = /(?:token|authorization|secret|password|api[_-]?key|cookie|session)/i;
const PAGE_SETUP_TIMEOUT_MS = Number(process.env.PUTER_BROWSER_PAGE_SETUP_TIMEOUT_MS || 20000);
const CALL_TIMEOUT_MS = Number(process.env.PUTER_BROWSER_CALL_TIMEOUT_MS || 110000);
let browser;
let page;
let activeToken;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : safeValue(item);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
      .replace(/([?&;](?:token|authorization|secret|password|api[_-]?key|cookie|session)=)[^&\s"'}]+/gi, '$1[REDACTED]');
  }
  return value;
}

function withTimeout(promise, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Puter.js ${label} timed out.`)), CALL_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function errorShape(error) {
  const object = error && typeof error === 'object' ? error : {};
  const response = object.response && typeof object.response === 'object' ? object.response : {};
  const status = Number(object.status || object.statusCode || response.status || 0) || null;
  return safeValue({
    status,
    code: object.code || object.error?.code || null,
    message: object.message || object.error?.message || String(error || 'Puter.js browser call failed.'),
    error: object.error || null,
  });
}

async function ensurePage() {
  if (page) return;
  browser = await chromium.launch({ headless: true, timeout: PAGE_SETUP_TIMEOUT_MS });
  const context = await withTimeout(browser.newContext(), 'context initialization');
  page = await withTimeout(context.newPage(), 'page initialization');
  page.setDefaultTimeout(PAGE_SETUP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(PAGE_SETUP_TIMEOUT_MS);
  try {
    await withTimeout(page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' }), 'landing-page load');
  } catch {
    // The official browser client is loaded directly below; a transient Puter
    // landing-page failure must not consume the full analysis time budget.
  }
  const available = await page.evaluate(() => typeof globalThis.puter !== 'undefined');
  if (!available) {
    await withTimeout(page.addScriptTag({ url: 'https://js.puter.com/v2/' }), 'client-script load');
  }
  await withTimeout(page.waitForFunction(() => typeof globalThis.puter !== 'undefined'), 'client availability');
  const setter = await withTimeout(page.evaluate(() => typeof globalThis.puter?.setAuthToken === 'function'), 'client capability check');
  if (!setter) throw new Error('The real Puter.js browser client did not expose setAuthToken().');
}

async function setToken(token) {
  await ensurePage();
  if (token === activeToken) return;
  const applied = await withTimeout(page.evaluate((authToken) => {
    globalThis.puter.setAuthToken(authToken);
    return Boolean(globalThis.puter.authToken);
  }, token), 'authentication initialization');
  if (!applied) throw new Error('Puter.js browser token initialization did not produce an authenticated client state.');
  activeToken = token;
}

function messageShape(message) {
  const result = message && typeof message === 'object' ? message : {};
  return safeValue({
    content: result.content ?? '',
    tool_calls: Array.isArray(result.tool_calls) ? result.tool_calls : undefined,
    role: result.role || 'assistant',
  });
}

async function listModels(token) {
  try {
    await setToken(token);
    const models = await withTimeout(page.evaluate(async () => {
      const result = await globalThis.puter.ai.listModels();
      return JSON.parse(JSON.stringify(result));
    }), 'model discovery');
    return { ok: true, models: safeValue(models) };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
}

async function chat(token, payload) {
  try {
    await setToken(token);
    const result = await withTimeout(page.evaluate(async (request) => {
      const options = {
        model: request.model,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
      };
      // Puter.js documents tools, but not OpenAI's tool_choice flag. Omitting
      // tools is the browser-client equivalent of the correction turn's
      // no-tools constraint.
      if (request.tool_choice !== 'none' && Array.isArray(request.tools)) options.tools = request.tools;
      const response = await globalThis.puter.ai.chat(request.messages, options);
      const message = response?.message ?? response;
      return JSON.parse(JSON.stringify({
        content: message?.content ?? '',
        tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : undefined,
        role: message?.role || 'assistant',
      }));
    }, payload), 'chat request');
    return { ok: true, message: messageShape(result) };
  } catch (error) {
    return { ok: false, error: errorShape(error) };
  }
}

async function handle(request) {
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') {
    throw new Error('Bridge request must be an object with a string id.');
  }
  if (typeof request.token !== 'string' || !request.token) {
    throw new Error('Bridge request is missing its in-memory token.');
  }
  if (request.op === 'list_models') return { id: request.id, ...(await listModels(request.token)) };
  if (request.op === 'chat') return { id: request.id, ...(await chat(request.token, request.payload || {})) };
  throw new Error('Unsupported bridge operation.');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let requestChain = Promise.resolve();

async function processLine(line) {
  let id = null;
  try {
    const request = JSON.parse(line);
    id = typeof request?.id === 'string' ? request.id : null;
    emit(await handle(request));
  } catch (error) {
    emit({ id, ok: false, error: errorShape(error) });
  }
}

rl.on('line', (line) => {
  // Python deliberately sends one request at a time, while this queue also
  // makes stream-close behavior deterministic for standalone diagnostics.
  requestChain = requestChain.then(() => processLine(line));
});
rl.on('close', async () => {
  try { await requestChain; } catch { /* processLine always emits failures */ }
  try { await browser?.close(); } catch { /* best-effort shutdown */ }
});
