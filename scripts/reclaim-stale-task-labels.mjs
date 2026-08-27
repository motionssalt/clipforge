#!/usr/bin/env node
/**
 * Reclaim stale Bot A task labels (Bug 2 — automatic reclamation + the
 * one-time legacy cleanup).
 *
 * Bot A keeps per-chat task labels in the CLIPFORGE_BOT_KV namespace
 * (``user:<chatId>:tasks`` documents). pipeline/cleanup/expired.py deletes
 * the GitHub-side job artifacts but has no access to this KV store, so
 * labels of expired jobs were never freed. This script is the KV half of the
 * cleanup: for every chat's tasks document it checks each labelled job
 * against the repository using the SAME expiry rule as
 * pipeline.cleanup.expired (status.expires_at_epoch in the past, terminal
 * state, or no readable status at all — all treated as expired/dead there)
 * and frees the label when the job is confirmed stale. Freed letters are
 * reused by new tasks via storage.js's lowest-free-label allocation.
 *
 * Runs hourly as the task-label-reclamation job of cleanup.yml, and can be
 * run manually for a one-off cleanup:
 *   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... GITHUB_TOKEN=... \
 *   REPO=owner/repo node scripts/reclaim-stale-task-labels.mjs --apply
 * Omit --apply for a dry run. Credentials come from the environment only and
 * are never printed.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ARGS = process.argv.slice(2);
const APPLY = ARGS.includes('--apply');
const reportIdx = ARGS.indexOf('--report');
const REPORT_PATH = reportIdx >= 0 ? ARGS[reportIdx + 1] : null;
const NOW = Math.floor(Date.now() / 1000);
const REPO = String(process.env.REPO || process.env.GITHUB_REPOSITORY || '').trim();
const GH_TOKEN = String(process.env.GITHUB_TOKEN || '').trim();
if (!REPO) { console.error('REPO (owner/name) is required.'); process.exit(2); }

function kvNamespaceId() {
  const raw = readFileSync(new URL('../bot/wrangler.bot-a.jsonc', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '');
  const binding = (JSON.parse(raw).kv_namespaces || []).find((b) => b.binding === 'CLIPFORGE_BOT_KV');
  if (!binding || !binding.id) throw new Error('CLIPFORGE_BOT_KV namespace id not found in bot/wrangler.bot-a.jsonc');
  return binding.id;
}

function wrangler(args, { json = false } = {}) {
  const out = execFileSync('npx', ['--yes', 'wrangler@4', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
  });
  return json ? JSON.parse(out) : out;
}

async function readJobStatus(jobId) {
  if (!GH_TOKEN) return { error: 'no-token' };
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/contents/jobs/${encodeURIComponent(jobId)}/status.json`,
    { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${GH_TOKEN}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'clipforge-task-label-reclamation/1.0' } },
  );
  if (res.status === 404) return { missing: true };
  if (!res.ok) return { error: `http-${res.status}` };
  try {
    return { doc: JSON.parse(Buffer.from(String((await res.json()).content || ''), 'base64').toString('utf8')) };
  } catch { return { error: 'unparseable' }; }
}

function classify(result) {
  // Mirrors pipeline.cleanup.expired: no readable status => expired.
  if (result.missing || result.error === 'unparseable') return 'stale:no-readable-status';
  if (result.error) return `unknown:${result.error}`;
  const doc = result.doc || {};
  if (['complete', 'error', 'cancelled'].includes(String(doc.state))) return `stale:terminal-${doc.state}`;
  const expires = Number(doc.expires_at_epoch);
  if (Number.isFinite(expires) && expires > 0 && expires < NOW) return 'stale:ttl-expired';
  return 'active';
}

const report = { ran_at_epoch: NOW, repo: REPO, mode: APPLY ? 'apply' : 'dry-run', chats: [] };
const nsId = kvNamespaceId();
const keys = wrangler(['kv', 'key', 'list', '--namespace-id', nsId, '--remote'], { json: true });
const taskKeys = (Array.isArray(keys) ? keys : []).map((k) => String(k.name || '')).filter((n) => /^user:.+:tasks$/.test(n));
console.log(`Scanning ${taskKeys.length} task-label document(s) in CLIPFORGE_BOT_KV against ${REPO}…`);

for (const kvKey of taskKeys) {
  const chatId = kvKey.split(':')[1];
  const chatReport = { chat: chatId, reclaimed: [], kept: [], skipped: [] };
  let doc;
  try { doc = JSON.parse(wrangler(['kv', 'key', 'get', kvKey, '--namespace-id', nsId, '--remote'])); }
  catch (error) { chatReport.skipped.push({ reason: `unreadable tasks document: ${error.message}` }); report.chats.push(chatReport); continue; }
  const labels = doc && typeof doc.labels === 'object' && doc.labels ? doc.labels : {};
  const options = doc && typeof doc.options === 'object' && doc.options ? doc.options : {};
  let changed = false;
  for (const [label, jobId] of Object.entries(labels)) {
    const verdict = classify(await readJobStatus(String(jobId)));
    if (verdict.startsWith('stale:')) {
      chatReport.reclaimed.push({ label, jobId: String(jobId), reason: verdict });
      delete labels[label]; delete options[String(jobId)]; changed = true;
    } else if (verdict === 'active') {
      chatReport.kept.push({ label, jobId: String(jobId) });
    } else {
      chatReport.skipped.push({ label, jobId: String(jobId), reason: verdict });
    }
  }
  if (changed && APPLY) {
    doc.labels = labels; doc.options = options;
    const tmp = join(tmpdir(), `clipforge-tasks-${chatId}-${NOW}.json`);
    writeFileSync(tmp, JSON.stringify(doc));
    wrangler(['kv', 'key', 'put', kvKey, '--namespace-id', nsId, '--remote', '--path', tmp]);
  }
  report.chats.push(chatReport);
}

const reclaimed = report.chats.reduce((n, c) => n + c.reclaimed.length, 0);
const kept = report.chats.reduce((n, c) => n + c.kept.length, 0);
console.log(`\nReclamation ${APPLY ? 'applied' : 'DRY RUN'}: ${reclaimed} label(s) reclaimed, ${kept} kept.`);
for (const chat of report.chats) {
  for (const r of chat.reclaimed) console.log(`  freed ${r.label} (job ${r.jobId}) — ${r.reason}`);
  for (const s of chat.skipped) console.log(`  skipped ${s.label || '?'} (job ${s.jobId || '?'}) — ${s.reason}`);
}
if (REPORT_PATH) { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n'); console.log(`Report written to ${REPORT_PATH}`); }
