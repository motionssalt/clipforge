import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_TORRENT_BYTES, TELEGRAM_PUBLIC_POST_RE, classifySourceText, describeMusic,
  describeSource, libraryKeyboard, nextStep, newWizard, previousStep, stepsFor,
  wizardComplete, wizardSummaryLines, wizardToRequest
} from '../src/wizard.js';
import { taskKeyboard } from '../src/runtime.js';
import { homeText, settingsText } from '../src/views.js';

test('classifySourceText accepts every §5 source kind', () => {
  assert.deepEqual(classifySourceText('https://example.com/v.mp4'), { kind: 'url', value: 'https://example.com/v.mp4' });
  assert.equal(classifySourceText('https://drive.google.com/file/d/abc/view').kind, 'drive');
  assert.equal(classifySourceText('magnet:?xt=urn:btih:abc').kind, 'magnet');
  assert.equal(classifySourceText('https://t.me/somechannel/123').kind, 'telegram_channel');
});

test('classifySourceText rejects disabled social hosts with guidance', () => {
  for (const url of ['https://youtube.com/watch?v=x', 'https://youtu.be/x', 'https://www.tiktok.com/@a/video/1', 'https://x.com/a/status/1', 'https://instagram.com/reel/x']) {
    const result = classifySourceText(url);
    assert.ok(result.error, url);
    assert.match(result.error, /Telegram channel|not supported/);
  }
});

test('classifySourceText rejects junk input', () => {
  assert.ok(classifySourceText('').error);
  assert.ok(classifySourceText('hello world').error);
  assert.ok(classifySourceText('ftp://example.com/v.mp4').error);
});

test('public post regex matches channels, rejects profiles and groups', () => {
  assert.ok(TELEGRAM_PUBLIC_POST_RE.test('https://t.me/channelname/42'));
  assert.ok(TELEGRAM_PUBLIC_POST_RE.test('https://telegram.me/s/channelname/42'));
  assert.ok(!TELEGRAM_PUBLIC_POST_RE.test('https://t.me/channelname'));
  assert.ok(!TELEGRAM_PUBLIC_POST_RE.test('https://t.me/+joinhash'));
});

test('focus step is skipped when the series toggle is on (§8.4)', () => {
  const wizard = newWizard();
  assert.deepEqual(stepsFor(wizard), ['mode', 'source', 'focus', 'length', 'music', 'confirm']);
  wizard.series = true;
  assert.deepEqual(stepsFor(wizard), ['mode', 'source', 'length', 'music', 'confirm']);
});

test('wizard step navigation walks forward and back', () => {
  const wizard = newWizard();
  wizard.step = 'source';
  assert.equal(nextStep(wizard), 'focus');
  wizard.series = true;
  assert.equal(nextStep(wizard), 'length');
  wizard.step = nextStep(wizard);
  assert.equal(previousStep(wizard), 'source');
  wizard.step = 'mode';
  assert.equal(previousStep(wizard), 'mode');
});

test('wizardToRequest projects the §7.1 shape', () => {
  const wizard = newWizard();
  wizard.jobId = 'manual-123';
  wizard.mode = 'manual';
  wizard.source = { kind: 'url', value: 'https://example.com/v.mp4' };
  wizard.focus = 'the verdict';
  wizard.duration = 60;
  wizard.music = { ref: 'audio-library/a.mp3', source: 'explicit_library' };
  const request = wizardToRequest(wizard, '');
  assert.equal(request.source.kind, 'url');
  assert.equal(request.options.target_duration_seconds, 60);
  assert.equal(request.options.focus, 'the verdict');
  assert.equal(request.mode, 'manual');
  assert.equal(request.series.enabled, false);
  assert.deepEqual(request.music, { ref: 'audio-library/a.mp3', source: 'explicit_library' });
  assert.ok(wizardComplete(wizard));
});

test('wizardToRequest blanks focus for series and stamps part 1', () => {
  const wizard = newWizard();
  wizard.jobId = 'automatic-9';
  wizard.mode = 'automatic';
  wizard.series = true;
  wizard.source = { kind: 'magnet', value: 'magnet:?xt=urn:btih:x' };
  wizard.focus = 'should be dropped';
  wizard.duration = 120;
  wizard.music = { ref: '', source: 'none' };
  const request = wizardToRequest(wizard, 'series-42');
  assert.equal(request.series.enabled, true);
  assert.equal(request.series.series_id, 'series-42');
  assert.equal(request.series.part, 1);
  assert.equal(request.options.focus, '');
  assert.deepEqual(request.music, { ref: '', source: 'none' });
  const lines = wizardSummaryLines(wizard);
  assert.ok(!lines.some((line) => line.startsWith('Focus:')));
});

test('wizardComplete requires all choices', () => {
  const wizard = newWizard();
  assert.equal(wizardComplete(wizard), false);
});

test('libraryKeyboard paginates and always offers back/cancel', () => {
  const tracks = Array.from({ length: 14 }, (_, i) => ({ name: `t${i}.mp3`, path: `audio-library/t${i}.mp3` }));
  const first = libraryKeyboard(tracks, 0);
  assert.equal(first.page, 0);
  assert.ok(first.rows.flat().some((b) => b.callback_data === 'wz:lib:0'));
  assert.ok(first.rows.flat().some((b) => b.callback_data === 'wz:libpage:1'));
  const last = libraryKeyboard(tracks, 99);
  assert.equal(last.page, 2);
  assert.ok(last.rows.flat().some((b) => b.callback_data === 'wz:cancel'));
});

test('describeSource / describeMusic render confirm lines', () => {
  assert.match(describeSource({ kind: 'url', value: 'https://x/v.mp4' }), /Direct link/);
  assert.match(describeSource({ kind: 'torrent_file', fileName: 'a.torrent' }), /a\.torrent/);
  assert.equal(describeMusic({ source: 'none' }), 'No music');
  assert.match(describeMusic({ source: 'explicit_library', ref: 'audio-library/x.mp3' }), /x\.mp3/);
});

test('taskKeyboard exposes only state-valid actions (§8.5)', () => {
  const flat = (status, label = 'A') => taskKeyboard(status, label).inline_keyboard.flat().map((b) => b.callback_data || b.text);
  assert.ok(flat({ state: 'awaiting_torrent_selection' }).some((d) => d === 'task:tsel:A:0'));
  const awaiting = flat({ state: 'awaiting_plan' });
  assert.ok(awaiting.includes('task:prompt:A') && awaiting.includes('task:upload:A'));
  assert.ok(flat({ state: 'stage_b_running' }).includes('task:cancelb:A'));
  // bug-15: a task that died inside Stage A (Stage B never began) must NOT
  // offer a Stage B restart; a Stage B failure offers both.
  const errA = flat({ state: 'error', message: 'Stage A failed. See workflow run for logs.' });
  assert.ok(errA.includes('task:restarta:A') && !errA.includes('task:restartb:A') && errA.includes('task:delfrom:A'));
  const errB = flat({ state: 'error', message: 'Stage B failed. See workflow run for logs.' });
  assert.ok(errB.includes('task:restarta:A') && errB.includes('task:restartb:A') && errB.includes('task:delfrom:A'));
  const done = flat({ state: 'complete', mode: 'manual', series: { enabled: true, part: 1, is_final: false } });
  assert.ok(done.includes('task:dl:A') && done.includes('task:pub:A') && done.includes('task:next:A'));
  const doneFinal = flat({ state: 'complete', mode: 'manual', series: { enabled: true, part: 3, is_final: true } });
  assert.ok(!doneFinal.includes('task:next:A'));
  assert.ok(flat({ state: 'queued' }).includes('task:open:A')); // refresh always present
});

test('home and settings screens render the §8.3/§8.6 summary', () => {
  const home = homeText({ repo: 'me/clone', narratorVoice: 'en-US-AvaNeural', seriesEnabled: true, geminiCount: 2, zernioEnabled: false });
  assert.match(home, /me\/clone/);
  assert.match(home, /Narrator: Ava/);
  assert.match(home, /Series: on/);
  assert.match(home, /2 keys configured/);
  const settings = settingsText({ repo: '', narratorVoice: 'unknown', seriesEnabled: false, geminiCount: 0, watermarkName: '', musicDefaultPath: '', zernioEnabled: false });
  assert.match(settings, /not connected/);
  assert.match(settings, /Narrator: Andrew/); // DEFAULT_VOICE fallback
});

test('torrent cap is 1 MB per §5', () => {
  assert.equal(MAX_TORRENT_BYTES, 1024 * 1024);
});
