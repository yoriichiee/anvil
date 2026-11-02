import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Ajv from 'ajv';
import { RepoScanner, scanTarGz, buildReport, repoPath } from './lib/scan.mjs';
import { makeTarGz, FAKE, loadReportSchema } from './_testkit.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', (s) => !Number.isNaN(Date.parse(s)));
const validate = ajv.compile(loadReportSchema());

// Mirrors crossCheck() in fixtures/validate-sample.mjs (which exits on import).
function crossCheck(r) {
  const errs = [];
  const ids = new Set(r.checksRun.map((c) => c.id));
  for (const f of r.findings) if (!ids.has(f.check)) errs.push(`unknown check ${f.check}`);
  for (const sev of ['critical', 'high', 'medium', 'low', 'info']) {
    if (r.summary.counts[sev] !== r.findings.filter((f) => f.severity === sev).length) errs.push(`count ${sev}`);
  }
  const all = [...r.findings, ...r.humanChecks].map((x) => x.id);
  if (new Set(all).size !== all.length) errs.push('dup ids');
  if (/\bsecure\b/i.test(JSON.stringify(r).replace(/not make an app secure/gi, ''))) errs.push('says secure');
  return errs;
}

function scanFiles(files) {
  const s = new RepoScanner();
  for (const [p, c] of Object.entries(files)) s.addFile(`acme-notes-abc123/${p}`, Buffer.from(c), c.length);
  return s.finish();
}
const report = (s) => buildReport(s, { owner: 'acme', repo: 'notes', ref: 'main', scannedAt: Date.parse('2026-11-02T10:00:00Z') });

test('repoPath strips the GitHub root folder and refuses traversal', () => {
  assert.equal(repoPath('o-r-sha/src/a.js'), 'src/a.js');
  assert.equal(repoPath('o-r-sha/'), null);
  assert.equal(repoPath('o-r-sha/../x'), null);
});

test('finds provider keys, redacts them, and never leaks the raw value', () => {
  const s = scanFiles({
    'public/assets/js/billing.js': `// billing\nconst a = 1;\nconst b = 2;\nconst key = "${FAKE.stripeLive}";\n`,
    'build/assets/js/billing.js': `var k="${FAKE.stripeLive}"`,
    'scripts/deploy.sh': `export GH=${FAKE.githubPat}\nAWS=${FAKE.awsId}\n`,
    'server/admin.js': `const supa = "${FAKE.serviceRoleJwt}";\nconst anon = "${FAKE.anonJwt}";\n`,
    'lib/ai.js': `const k = '${FAKE.anthropic}'`,
  });
  const r = report(s);
  const json = JSON.stringify(r);
  for (const v of [FAKE.stripeLive, FAKE.githubPat, FAKE.serviceRoleJwt, FAKE.anthropic]) assert.ok(!json.includes(v), 'raw secret leaked');
  const stripe = r.findings.find((f) => f.id.startsWith('f-secret-stripe-live-secret'));
  assert.ok(stripe);
  assert.equal(stripe.severity, 'critical');
  assert.equal(stripe.evidence.file, 'public/assets/js/billing.js');
  assert.equal(stripe.evidence.line, 4);
  assert.match(stripe.evidence.response, /^matched sk_live_\[REDACTED \d+ chars\]$/);
  assert.match(stripe.why, /1 more time/);
  assert.ok(r.findings.some((f) => f.title.includes('GitHub token')));
  assert.ok(r.findings.some((f) => f.title.includes('AWS access key ID')));
  assert.ok(r.findings.some((f) => f.title.includes('service_role')));
  assert.ok(r.findings.some((f) => f.title.includes('Anthropic')));
  assert.equal(r.findings.filter((f) => f.title.includes('service_role')).length, 1, 'anon key must not be flagged');
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.deepEqual(crossCheck(r), []);
});

test('ignores placeholders, env references and node_modules', () => {
  const s = scanFiles({
    'src/config.js': 'const password = "changeme123456";\nconst apiKey = process.env.API_KEY;\nconst secret = "your_secret_here_123";\nconst t = "' + 'sk_' + 'live_' + 'x'.repeat(24) + '";',
    'node_modules/pkg/index.js': `const k = "${FAKE.stripeLive}"`,
    'README.md': 'password = "Zq8#kd02Lmx9Pq3r"',
  });
  const r = report(s);
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings));
  assert.equal(r.checksRun.find((c) => c.id === 'secret-scan').status, 'pass');
  assert.equal(r.checksRun.find((c) => c.id === 'rules-lint').status, 'skip');
  assert.ok(validate(r));
});

test('flags random-looking generic assignments and committed .env files', () => {
  const s = scanFiles({
    'src/db.js': 'const client_secret = "q8Zr2LmP0xV7nK4tB9wE";',
    '.env': '# local\nDATABASE_URL=postgres://u:p@h/db\n',
    '.env.example': 'DATABASE_URL=\n',
  });
  const r = report(s);
  const g = r.findings.find((f) => f.id.includes('generic-secret'));
  assert.ok(g);
  assert.equal(g.confidence, 'unconfirmed');
  assert.ok(!JSON.stringify(r).includes('q8Zr2LmP0xV7nK4tB9wE'));
  const env = r.findings.filter((f) => f.id.includes('env-file'));
  assert.equal(env.length, 1);
  assert.equal(env[0].evidence.file, '.env');
  assert.equal(env[0].evidence.line, 2);
});

test('lints Firestore, Realtime Database and Supabase rules files', () => {
  const s = scanFiles({
    'firestore.rules': "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if true;\n    }\n  }\n}\n",
    'storage.rules': "service firebase.storage {\n match /b/{bucket}/o {\n  match /{allPaths=**} {\n   allow read, write: if request.time < timestamp.date(2026, 12, 1);\n  }\n }\n}\n",
    'database.rules.json': '{\n  "rules": {\n    ".read": true,\n    ".write": "auth != null"\n  }\n}\n',
    'supabase/migrations/001_init.sql': 'create table public.notes (id uuid primary key);\ncreate table profiles (id uuid);\nalter table profiles enable row level security;\ncreate policy "all" on public.notes for all using (true);\n',
  });
  const r = report(s);
  const titles = r.findings.map((f) => `${f.severity}:${f.title}`);
  assert.ok(titles.some((t) => t.startsWith('critical:Firestore rules let anyone read and change')), titles.join('\n'));
  assert.equal(r.findings.find((f) => f.title.startsWith('Firestore')).evidence.line, 5);
  assert.ok(titles.some((t) => t.startsWith('high:Storage rules are still in test mode')));
  assert.ok(titles.some((t) => t.startsWith('high:Realtime Database rules let anyone read')));
  assert.ok(titles.some((t) => t.startsWith('medium:Realtime Database lets any signed-in user write')));
  assert.ok(titles.some((t) => t.includes('public.notes is created without row level security')));
  assert.ok(!titles.some((t) => t.includes('public.profiles is created without')));
  assert.ok(titles.some((t) => t.startsWith('high:Policy all on public.notes allows every row')));
  assert.equal(r.checksRun.find((c) => c.id === 'rules-lint').status, 'fail');
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.deepEqual(crossCheck(r), []);
});

test('scanTarGz streams a real .tar.gz, records skipped large files and the commit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-scan-'));
  try {
    const file = join(dir, 'r.tgz');
    writeFileSync(file, makeTarGz([
      { path: 'acme-notes-abc/public/billing.js', content: `const k="${FAKE.stripeLive}";` },
      { path: 'acme-notes-abc/big.js', content: Buffer.alloc(2 * 1024 * 1024, 97) },
      { path: 'acme-notes-abc/logo.png', content: Buffer.from([0, 1, 2]) },
    ], { globalComment: 'f'.repeat(40) }));
    const s = await scanTarGz(file);
    const r = report(s);
    assert.equal(r.findings.length, 1);
    assert.equal(r.target.value, `acme/notes@main (${'f'.repeat(12)})`);
    assert.ok(r.notChecked.some((n) => n.what.includes('over 1024 KB') && n.why.includes('big.js')));
    assert.ok(validate(r), JSON.stringify(validate.errors));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stops at the unpacked-size cap and says so in notChecked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-scan-'));
  try {
    const file = join(dir, 'r.tgz');
    writeFileSync(file, makeTarGz([{ path: 'r-x/a.txt', content: Buffer.alloc(400 * 1024, 98) }, { path: 'r-x/b.txt', content: 'b' }]));
    const s = await scanTarGz(file, { limits: { ...(await import('./lib/scan.mjs')).LIMITS, maxUnpackedBytes: 100 * 1024 } });
    const r = report(s);
    assert.ok(r.notChecked.some((n) => n.what === 'Part of the repository'));
    assert.ok(validate(r));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
