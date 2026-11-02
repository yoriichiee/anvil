import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { buildReport, validateReport, writeOutputs, fixBriefMd, promptMd, summarize } from '../src/output.mjs';
import { normalizeFinding } from '../src/checks/index.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'report.schema.json'), 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', s => !Number.isNaN(Date.parse(s)));
const validate = ajv.compile(schema);

function sample() {
  const used = new Set();
  const findings = [
    normalizeFinding({ severity: 'low', title: 'console.error on /a', evidence: { response: 'console.error: x', file: 'a.js', line: 3 }, why: 'w', fix: 'f', confidence: 'proven' }, 'page-load', used),
    normalizeFinding({ severity: 'critical', title: 'Stripe secret key is shipped', evidence: { file: 'public/b.js', line: 4, response: 'contains sk_live_[REDACTED 24 chars]' }, why: 'Make it secure', fix: 'Roll it', confidence: 'proven' }, 'secret-scan', used),
    normalizeFinding({ severity: 'bogus', title: '', evidence: {}, why: '', fix: '' }, 'axe', used),
  ];
  return buildReport({ runId: '2026-11-02T10-00-00-000Z', version: '0.2.0', target: { kind: 'url', value: 'http://localhost:3000' }, aiMode: 'none',
    checks: { checksRun: [{ id: 'page-load', name: 'Page load', status: 'warn', durationMs: 5 }, { id: 'secret-scan', name: 'Secrets', status: 'fail', durationMs: 1 }, { id: 'axe', name: 'axe', status: 'warn', durationMs: 1 }], findings },
    humanChecks: [{ id: 'h-one', prompt: 'Is it secure to log in?', steps: ['Log in'] }], notChecked: [] });
}

test('buildReport output validates against report.schema.json and the built-in validator', () => {
  const r = sample();
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.deepEqual(validateReport(r), []);
  assert.equal(r.findings[0].severity, 'critical', 'sorted by severity');
  assert.equal(r.summary.counts.critical, 1);
  assert.ok(r.notChecked.length >= 6);
  assert.doesNotMatch(JSON.stringify(r).replace(/not make an app secure/g, ''), /\bsecure\b/i);
});

test('validateReport catches what the schema forbids', () => {
  const r = sample();
  r.notChecked = []; r.findings[0].evidence = {}; r.summary.counts.low = 9; r.extra = 1;
  const e = validateReport(r).join('\n');
  for (const m of ['notChecked must not be empty', 'evidence empty', 'summary.counts.low', 'unknown field extra']) assert.match(e, new RegExp(m));
});

test('writeOutputs writes every file and fixtures/validate-sample.mjs accepts report.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-out-'));
  const r = sample();
  const files = await writeOutputs(dir, r, { intro: 'Fix the key first.', order: [r.findings[1].id] });
  for (const f of files) assert.ok(fs.existsSync(path.join(dir, f)), f);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'fixtures', 'validate-sample.mjs'), path.join(dir, 'report.json')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  const html = fs.readFileSync(path.join(dir, 'report.html'), 'utf8');
  // dashboard look: monochrome tokens + the ANVIL_PATH mark, no accent colour, self-contained
  assert.match(html, /--ink:#0a0a0a/); assert.match(html, /M8 4\.5H22\.5V9H19L16\.5 13\.5H19/);
  assert.doesNotMatch(html, /#FF5A1F|orange/i); assert.doesNotMatch(html, /<script src=|<link rel="stylesheet"/);
  assert.match(fs.readFileSync(path.join(dir, 'fix-brief.md'), 'utf8'), /^# Fix brief/);
});

test('fix brief and prompts list the findings in polish order and carry the rescan command', () => {
  const r = sample();
  const md = fixBriefMd(r, { intro: 'x', order: [r.findings[1].id] });
  assert.ok(md.indexOf(r.findings[1].title) < md.indexOf(r.findings[0].title));
  for (const f of ['lovable', 'cursor', 'claude']) assert.match(promptMd(r, f), /Stripe secret key/);
  assert.match(promptMd(r, 'claude'), /anvil scan http:\/\/localhost:3000/);
  assert.match(promptMd(r, 'claude'), /approve/);
});

test('summary: human answers change pending/broken counts and the score', () => {
  const r = sample();
  const before = summarize(r.findings, r.humanChecks);
  r.humanChecks[0].verdict = 'broken';
  const after = summarize(r.findings, r.humanChecks);
  assert.equal(before.counts.humanPending, 1); assert.equal(after.counts.humanBroken, 1);
  assert.ok(after.score0to100 < before.score0to100);
});
