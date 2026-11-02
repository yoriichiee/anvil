// End to end: scan the bundled Acme Notes demo with a real browser. Slow (~40 s) and needs Chrome/Edge, so it runs
// only with ANVIL_E2E=1:   $env:ANVIL_E2E=1; node --test test/e2e-acme.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACME = path.join(ROOT, 'examples', 'acme-notes');

test('anvil scan finds the five Acme Notes demo bugs and nothing else', { skip: process.env.ANVIL_E2E !== '1' && 'set ANVIL_E2E=1 to run', timeout: 240000 }, async () => {
  process.env.ANVIL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-home-'));
  const { createApp } = await import(pathToUrl(path.join(ACME, 'server.mjs')));
  const { scan } = await import('../src/scan.mjs');
  const app = createApp({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'acme-data-')) });
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.address().port + '/';
  try {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-e2e-'));
    const { report, runDir } = await scan({ target: url, dir: ACME, out, ai: 'none' });
    const ids = report.findings.map(f => f.check + ':' + f.severity).sort();
    assert.deepEqual(ids, ['axe:low', 'overflow:medium', 'page-load:low', 'role-access:high', 'secret-scan:critical'], JSON.stringify(report.findings.map(f => f.title)));
    const leak = report.findings.find(f => f.check === 'secret-scan');
    assert.equal(leak.evidence.file, 'public/assets/js/billing.js');
    assert.match(leak.title, /^Stripe secret key \(Anvil demo key\) is shipped/);
    assert.match(leak.evidence.response, /sk_anvildemo_\[REDACTED \d+ chars\]/);
    assert.ok(report.findings.find(f => f.check === 'role-access').evidence.request.includes('/api/settings'));
    for (const f of ['report.json', 'report.html', 'fix-brief.md', 'prompts/claude.md', 'shots/app-member-notes-member-phone.png']) assert.ok(fs.existsSync(path.join(runDir, f)), f);
    assert.doesNotMatch(fs.readFileSync(path.join(runDir, 'report.json'), 'utf8'), /NOTaREALkey/);
  } finally { app.close(); }
});

function pathToUrl(p) { return 'file:///' + p.replace(/\\/g, '/').replace(/^\/+/, ''); }
