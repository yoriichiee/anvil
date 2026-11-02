import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listFiles, analyze, detectFramework, browserExposure } from '../src/source.mjs';
import { runChecks } from '../src/checks/index.mjs';
import { CORPUS } from './fake-secrets.mjs';

function project(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-src-'));
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); }
  return dir;
}
const ctxFor = dir => { const { files } = listFiles(dir); return { source: { files, framework: detectFramework(dir), analysis: analyze(dir, { files }) }, origin: null, log() {}, crawl: () => Promise.reject(new Error('no browser')), opts: {} }; };

test('git-ignored folders are skipped, built bundles are scanned anyway', () => {
  const dir = project({ '.gitignore': 'secret-stuff/\n*.log\ndist/\n', 'secret-stuff/a.js': 'x', 'debug.log': 'x', 'src/app.js': 'x', 'dist/assets/index.js': 'x', 'node_modules/p/index.js': 'x' });
  const { files, ignoredDirs } = listFiles(dir);
  const rels = files.map(f => f.rel).sort();
  assert.deepEqual(rels, ['.gitignore', 'dist/assets/index.js', 'src/app.js']);
  assert.ok(ignoredDirs.includes('secret-stuff'));
  assert.equal(files.find(f => f.rel === 'dist/assets/index.js').bundle, true);
});

test('secret scan: shipped key = critical with masked evidence; server key = high; ignored .env skipped; committed .env flagged', async () => {
  const dir = project({
    '.gitignore': '.env.local\n',
    'package.json': JSON.stringify({ name: 'demo', scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }),
    'public/js/pay.js': `// pay\nconst k = '${CORPUS.stripe}';\n`,
    'server/db.js': `export const gh = "${CORPUS.github}";\n`,
    '.env.local': `OPENAI_API_KEY=${CORPUS.openai}\n`,
    '.env': `AWS_ACCESS_KEY_ID=${CORPUS.aws}\n`,
    'src/supa.js': `createClient('https://abcdefghijklmnopqrst.supabase.co', '${CORPUS.supabaseAnon}')`,
  });
  const r = await runChecks(ctxFor(dir), { only: ['secret-scan'] });
  const json = JSON.stringify(r);
  for (const v of Object.values(CORPUS)) assert.ok(!json.includes(v), 'raw secret in output');
  const by = t => r.findings.find(f => f.title.includes(t));
  const stripe = by('Stripe');
  assert.equal(stripe.severity, 'critical'); assert.equal(stripe.evidence.file, 'public/js/pay.js'); assert.equal(stripe.evidence.line, 2);
  assert.match(stripe.evidence.response, /sk_live_\[REDACTED/);
  assert.equal(by('GitHub').severity, 'high');
  assert.match(by('AWS').title, /\.env, which is not git-ignored/);
  assert.equal(r.findings.some(f => f.title.includes('OpenAI')), false, '.env.local is git-ignored');
  assert.equal(r.findings.some(f => /anon/i.test(f.title)), false, 'anon key is public by design');
  assert.equal(r.checksRun[0].status, 'fail');
});

test('analyze finds features, Supabase config and tables', () => {
  const dir = project({ 'src/a.js': `const s = createClient('https://abcdefghijklmnopqrst.supabase.co', '${CORPUS.supabaseAnon}');\nawait s.from('profiles').select('*');\nawait s.storage.from('avatars').upload(f);\n<form onSubmit={x}>`, 'src/pay.js': 'import Stripe from "stripe"; checkout()' });
  const a = analyze(dir);
  assert.deepEqual(a.features, { auth: false, payments: true, uploads: true, forms: true });
  assert.deepEqual(a.supabase.urls, ['https://abcdefghijklmnopqrst.supabase.co']);
  assert.deepEqual(a.supabase.tables.map(t => t.name), ['profiles']);
  assert.equal(a.supabase.anonKeys.length, 1);
});

test('framework detection and browser exposure', () => {
  const dir = project({ 'package.json': JSON.stringify({ scripts: { dev: 'next dev -p 4000' }, dependencies: { next: '15', react: '19' } }) });
  const fw = detectFramework(dir);
  assert.equal(fw.kind, 'next'); assert.equal(fw.port, 4000); assert.deepEqual(fw.cmd, ['npm', 'run', 'dev']);
  assert.equal(browserExposure('src/components/Pay.tsx', fw), 'likely');
  assert.equal(browserExposure('src/server/pay.ts', fw), 'no');
  assert.equal(browserExposure('dist/assets/x.js', fw), 'yes');
  assert.equal(detectFramework(project({ 'index.html': '<h1>hi</h1>' })).kind, 'static');
});
