// node --test src/addons/   (also runs addons-spec/repo-template/test via its own `npm test`)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import {
  validatePack, lintPack, checkPack, lintRegex, safeMatchAll, satisfiesRange, compareSemver,
} from './pack-validate.mjs';
import { packToChecks, packToHumanChecks, sameSiteUrl, redact } from './runtime.mjs';
import {
  addAddon, addLocalAddon, removeAddon, listInstalled, loadInstalledPacks, registerInstalledAddons,
  addonCommand, sha256, validateIndex,
} from './index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TEMPLATE = path.join(ROOT, 'addons-spec', 'repo-template');
const load = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const SEEDS = ['supabase-rls', 'stripe-checkout', 'auth-pages'].map(id => path.join(TEMPLATE, 'packs', id, '0.1.0', 'anvil-addon.json'));
const FAKE_LIVE = 'sk_' + 'live_' + 'A1b2C3d4'.repeat(4);   // built at runtime so the repo holds no key-shaped string

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', s => !Number.isNaN(Date.parse(s)));
const ajvPack = ajv.compile(load(path.join(ROOT, 'schemas', 'anvil-addon.schema.json')));
const ajvReport = ajv.compile(load(path.join(ROOT, 'schemas', 'report.schema.json')));

const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-addons-test-'));
const sink = () => { let s = ''; return { write: x => { s += x; }, get text() { return s; } }; };

// ---- schema mirror ------------------------------------------------------------------------------

test('validatePack agrees with the frozen JSON schema (ajv) on valid and invalid packs', () => {
  const base = load(path.join(ROOT, 'fixtures', 'sample-addon.json'));
  const mutations = [
    p => p,
    p => { p.checks[1].match.method = 'POST'; },
    p => { delete p.checks[1].match.path; },
    p => { p.checks[0].match.method = 'GET'; },
    p => { p.extra = 1; },
    p => { p.id = 'Bad_ID'; },
    p => { p.version = '1.0'; },
    p => { p.tags = Array.from({ length: 13 }, (_, i) => 't' + i); },
    p => { p.tags = ['a1', 'a1']; },
    p => { p.checks[1].match.status = 600; },
    p => { p.checks[1].match.status = []; },
    p => { p.checks[1].match = {}; },
    p => { p.checks[1].match.path = 'https://evil.example/x'; },
    p => { p.checks[0].kind = 'script'; },
    p => { p.checks[0].severity = 'urgent'; },
    p => { p.checks.push({ ...p.checks[0], id: 'dom-x', kind: 'dom', match: { path: '/' } }); },
    p => { p.humanChecks[0].steps = []; },
    p => { p.humanChecks[0].screenshot = 'yes'; },
    p => { delete p.license; },
    p => { p.anvil = 'latest'; },
    p => { p.checks = Array.from({ length: 51 }, (_, i) => ({ ...p.checks[0], id: 'c' + i })); },
    p => { p.name = 'x'.repeat(81); },
  ];
  const packs = [base, ...SEEDS.map(load)];
  for (const pk of packs) for (const [i, mut] of mutations.entries()) {
    const p = structuredClone(pk);
    if (p.checks.length < 2) p.checks.push({ id: 'zz-http', kind: 'http', severity: 'low', title: 't', match: { path: '/x' }, why: 'w', fix: 'f' });
    if (!p.humanChecks || !p.humanChecks.length) p.humanChecks = [{ id: 'h', prompt: 'p', steps: ['s'] }];
    // mutation 1/2 target checks[1] as an http-ish probe
    if (i >= 1 && i <= 3) p.checks[1] = { id: 'probe', kind: 'http', severity: 'low', title: 't', match: { path: '/x', method: 'GET' }, why: 'w', fix: 'f' };
    if (i === 3) p.checks[0] = { id: 'pg', kind: 'page', severity: 'low', title: 't', match: { path: '/' }, why: 'w', fix: 'f' };
    mut(p);
    const ours = validatePack(p).ok;
    const theirs = ajvPack(p);
    assert.equal(ours, theirs, `${pk.id} mutation #${i}: validatePack=${ours} ajv=${theirs} ${JSON.stringify(validatePack(p).errors)} ${JSON.stringify(ajvPack.errors)}`);
  }
});

test('seed packs pass the schema, policy lint and ReDoS lint', () => {
  for (const f of SEEDS) {
    const p = load(f);
    assert.ok(ajvPack(p), `${f}: ${JSON.stringify(ajvPack.errors)}`);
    assert.deepEqual(checkPack(p).errors, [], f);
  }
});

test('lintPack refuses off-site paths, duplicate ids and "secure" claims', () => {
  const p = load(SEEDS[1]);
  p.checks[3].match.path = '//evil.example/success';
  assert.match(lintPack(p).errors.join('\n'), /stay on the target site/);
  const q = load(SEEDS[1]);
  q.checks[1].id = q.checks[0].id;
  assert.match(lintPack(q).errors.join('\n'), /duplicate id/);
  const r = load(SEEDS[1]);
  r.checks[0].fix = 'Do this and your app is secure.';
  assert.match(lintPack(r).errors.join('\n'), /must not claim/);
});

// ---- regex guard --------------------------------------------------------------------------------

test('lintRegex rejects ReDoS shapes and accepts plain secret patterns', () => {
  const bad = ['(a+)+$', '(a*)*b', '(?:\\w+\\s?)+$', '(a|ab)*c', '((ab)+)+', '(a{1,8})+x', '(\\w)\\1', 'a{1,5000}', '.*', '', 'x*', '(', 'a'.repeat(301)];
  for (const r of bad) assert.ok(lintRegex(r).length > 0, `should reject ${JSON.stringify(r)}`);
  const good = ['(?:sk|rk)_live_[0-9a-zA-Z]{20,}', 'whsec_[0-9a-zA-Z]{24,}', '^\\s*\\[\\s*\\{', 'AKIA[0-9A-Z]{16}', '(?i)password=[^&\\s]{4,}', 'ghp_[A-Za-z0-9]{36}'];
  for (const r of good) assert.deepEqual(lintRegex(r), [], r);
});

test('adversarial run catches polynomial blow-ups the static pass allows', () => {
  // four stacked unbounded quantifiers over the same class: allowed statically, O(n^4) at runtime
  const errs = lintRegex('\\w*\\w*\\w*\\w*!');
  assert.ok(errs.length && /backtracking/.test(errs[0]), JSON.stringify(errs));
});

test('safeMatchAll enforces a hard timeout on catastrophic regexes', () => {
  const t = Date.now();
  const r = safeMatchAll('^(a+)+$', '', 'a'.repeat(40) + '!', { timeoutMs: 100 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t < 2000);
  assert.deepEqual(safeMatchAll('b+', '', 'abbcb').matches, [[1, 2], [4, 1]]);
});

test('semver helpers', () => {
  assert.ok(satisfiesRange('0.2.0', '^0.2'));
  assert.ok(satisfiesRange('0.2.9', '^0.2.1'));
  assert.ok(!satisfiesRange('0.3.0', '^0.2'));
  assert.ok(!satisfiesRange('1.0.0', '^0.2'));
  assert.ok(satisfiesRange('1.4.0', '^1.2'));
  assert.ok(satisfiesRange('0.2.5', '~0.2'));
  assert.ok(satisfiesRange('2.0.0', '>=0.2'));
  assert.ok(!satisfiesRange('0.1.0', '>=0.2'));
  assert.ok(compareSemver('0.2.0', '0.2.0-beta') > 0);
  assert.ok(compareSemver('0.10.0', '0.9.0') > 0);
});

// ---- runtime ------------------------------------------------------------------------------------

function reportWith(checks, findings, notChecked = [{ what: 'x', why: 'y' }]) {
  return {
    schemaVersion: '1', scannedAt: new Date().toISOString(), target: { kind: 'dir', value: '.' }, mode: { ai: 'none' },
    checksRun: checks.map(c => ({ id: c.id, name: c.name, status: 'fail', durationMs: 1 })),
    findings, humanChecks: [], notChecked: notChecked.length ? notChecked : [{ what: 'x', why: 'y' }],
    summary: { score0to100: 50, counts: { critical: 0, high: 0, medium: 0, low: 0, info: 0 } },
  };
}

test('secret-pattern check finds a fake key, redacts it, and emits report-valid findings', async () => {
  const pack = load(SEEDS[1]);
  const checks = packToChecks(pack);
  const live = checks.find(c => c.def.id === 'live-secret-key');
  assert.equal(live.id, 'addon:stripe-checkout:live-secret-key');
  const files = [
    { path: 'public/assets/js/billing.js', text: `// billing\nconst a = 1;\n\nconst key = "${FAKE_LIVE}";\n` },
    { path: 'src/ok.js', text: 'const pk = "pk_live_abc";' },
  ];
  const r = await live.run({ files });
  assert.equal(r.status, 'fail');
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].evidence.file, 'public/assets/js/billing.js');
  assert.equal(r.findings[0].evidence.line, 4);
  assert.ok(!JSON.stringify(r).includes(FAKE_LIVE), 'secret must not appear in output');
  assert.ok(!JSON.stringify(r).includes(FAKE_LIVE.slice(8, 20)), 'secret body must not appear in output');
  assert.ok(ajvReport(reportWith([live], r.findings, r.notChecked)), JSON.stringify(ajvReport.errors));
  const none = await live.run({ files: [{ path: 'a.js', text: 'nothing here' }] });
  assert.equal(none.status, 'pass');
  const skipped = await live.run({});
  assert.equal(skipped.status, 'skip');
  assert.equal(skipped.notChecked.length, 1);
});

test('secret-pattern check walks a folder when no file list is given', async () => {
  const dir = tmpHome();
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'i.js'), FAKE_LIVE);
  fs.mkdirSync(path.join(dir, 'build'));
  fs.writeFileSync(path.join(dir, 'build', 'app.js'), 'x=' + JSON.stringify(FAKE_LIVE));
  const live = packToChecks(load(SEEDS[1])).find(c => c.def.id === 'live-secret-key');
  const r = await live.run({ dir });
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].evidence.file, 'build/app.js');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('redact keeps at most a short prefix', () => {
  const s = redact(FAKE_LIVE);
  assert.ok(s.startsWith('sk_live_[REDACTED'));
  assert.ok(!s.includes('A1b2C3d4'));
});

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { return await fn(base); } finally { await new Promise(r => srv.close(r)); }
}

test('http, rules-probe and page (no browser) checks probe GET-only, same-site', async () => {
  const seen = [];
  await withServer((req, res) => {
    seen.push({ method: req.method, url: req.url, apikey: req.headers.apikey });
    if (req.url.startsWith('/rest/v1/profiles')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[{"id":1,"email":"a@example.com"}]'); return; }
    if (req.url.startsWith('/rest/v1/users')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return; }
    if (req.url === '/success') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<h1>Thanks</h1>'); return; }
    res.writeHead(404); res.end('nope');
  }, async base => {
    const supa = packToChecks(load(SEEDS[0]));
    const byId = id => supa.find(c => c.def.id === id);
    const ctx = { rulesTargets: [{ base, headers: { apikey: 'anon-test' } }] };
    const p = await byId('anon-read-profiles').run(ctx);
    assert.equal(p.status, 'fail');
    assert.equal(p.findings[0].confidence, 'proven');
    assert.ok(!JSON.stringify(p).includes('a@example.com'), 'response bodies are never stored');
    assert.ok(!JSON.stringify(p).includes('anon-test'), 'headers are never stored');
    assert.ok(ajvReport(reportWith([byId('anon-read-profiles')], p.findings)), JSON.stringify(ajvReport.errors));
    assert.equal((await byId('anon-read-users').run(ctx)).status, 'pass');      // [] is not a leak
    assert.equal((await byId('anon-read-orders').run(ctx)).status, 'pass');     // 404
    assert.equal((await byId('anon-read-orders').run({})).status, 'skip');      // no backend found
    assert.ok(seen.every(s => s.method === 'GET'));
    assert.ok(seen.every(s => s.apikey === 'anon-test'));

    const stripe = packToChecks(load(SEEDS[1]));
    const ok = await stripe.find(c => c.def.id === 'success-page').run({ baseUrl: base + '/some/app/' });
    assert.equal(ok.status, 'pass');
    // /cancel answers 404: the feature is not there, so the check is skipped, not failed
    const missing = await stripe.find(c => c.def.id === 'cancel-page').run({ baseUrl: base });
    assert.equal(missing.status, 'skip');
    assert.equal(missing.findings.length, 0);
    assert.match(missing.notChecked[0].why, /^feature not detected: GET \/cancel returned 404/);
    // ...unless the pack marks the check required
    const req = packToChecks({ ...load(SEEDS[1]), checks: load(SEEDS[1]).checks.map(c => c.id === 'cancel-page' ? { ...c, required: true } : c) });
    const reqMissing = await req.find(c => c.def.id === 'cancel-page').run({ baseUrl: base });
    assert.equal(reqMissing.status, 'fail');
    assert.match(reqMissing.findings[0].evidence.response, /status 404/);

    const dom = await packToChecks(load(SEEDS[2])).find(c => c.kind === 'dom').run({ baseUrl: base });
    assert.equal(dom.status, 'skip');   // needs a browser
  });
});

test('sameSiteUrl never leaves the base origin', () => {
  assert.equal(sameSiteUrl('http://localhost:3000/app/', '/login?x=1'), 'http://localhost:3000/login?x=1');
  assert.throws(() => sameSiteUrl('http://localhost:3000', '//evil.example/x'));
  assert.throws(() => sameSiteUrl('http://localhost:3000', '/\\evil.example'));
  assert.throws(() => sameSiteUrl('http://localhost:3000', 'https://evil.example/'));
  assert.equal(new URL(sameSiteUrl('http://localhost:3000', '/@evil.example')).host, 'localhost:3000');
});

test('page and dom checks drive a Playwright-like page', async () => {
  const fakePage = present => ({
    goto: async () => ({ status: () => 200 }),
    $: async () => (present ? {} : null),
    $$eval: async () => (present ? 1 : 0),
    content: async () => '<html></html>',
  });
  const auth = packToChecks(load(SEEDS[2]));
  const login = auth.find(c => c.def.id === 'login-page');
  assert.equal((await login.run({ baseUrl: 'http://localhost:1', page: fakePage(true) })).status, 'pass');
  const noField = await login.run({ baseUrl: 'http://localhost:1', page: fakePage(false), shot: async n => `shots/${n}.png` });
  assert.equal(noField.status, 'fail');
  assert.match(noField.findings[0].evidence.shot, /^shots\//);
  const getForm = auth.find(c => c.def.id === 'login-password-in-url');
  const r = await getForm.run({ baseUrl: 'http://localhost:1', page: fakePage(true) });
  assert.equal(r.status, 'fail');
  assert.ok(ajvReport(reportWith([getForm], r.findings)), JSON.stringify(ajvReport.errors));
});

test('page, dom and axe checks skip with "feature not detected" when their page is 404 / 410', async () => {
  const gone = status => ({
    goto: async () => ({ status: () => status }),
    $: async () => null,
    $$eval: async () => 1,
    content: async () => '<h1>Not found</h1>',
  });
  const auth = packToChecks(load(SEEDS[2]));
  for (const c of auth.filter(x => ['page', 'dom'].includes(x.kind))) {
    for (const st of [404, 410]) {
      const res = await c.run({ baseUrl: 'http://localhost:1', page: gone(st), runAxe: async () => ({ violations: [{ id: 'x', nodes: [] }] }) });
      assert.equal(res.status, 'skip', c.id + ' ' + st);
      assert.equal(res.findings.length, 0);
      assert.equal(res.notChecked.length, 1);
      assert.match(res.notChecked[0].what, /^auth-pages \/ /);
      assert.match(res.notChecked[0].why, /^feature not detected/);
    }
  }
  const axeCheck = packToChecks({ ...load(SEEDS[2]), checks: [{ id: 'ax', kind: 'axe', severity: 'low', title: 'Login a11y', match: { path: '/login' }, why: 'w', fix: 'f' }] })[0];
  assert.equal((await axeCheck.run({ baseUrl: 'http://localhost:1', page: gone(404), runAxe: async () => ({ violations: [{ id: 'x', nodes: [] }] }) })).status, 'skip');
  // a 500 is a real problem, not a missing feature
  const login = auth.find(c => c.def.id === 'login-page');
  assert.equal((await login.run({ baseUrl: 'http://localhost:1', page: gone(500) })).status, 'fail');
  // required: true reports the missing page
  const reqLogin = packToChecks({ ...load(SEEDS[2]), checks: [{ ...load(SEEDS[2]).checks[0], required: true }] })[0];
  assert.equal((await reqLogin.run({ baseUrl: 'http://localhost:1', page: gone(404) })).status, 'fail');
  assert.deepEqual(validatePack({ ...load(SEEDS[2]), checks: [{ ...load(SEEDS[2]).checks[0], required: 'yes' }] }).ok, false);
});

test('human checks convert to report humanChecks entries', () => {
  const hc = packToHumanChecks(load(SEEDS[2]));
  assert.equal(hc.length, 4);
  assert.equal(hc[0].id, 'addon:auth-pages:login-rate-limit');
  const rep = reportWith([], []);
  rep.humanChecks = hc;
  assert.ok(ajvReport(rep), JSON.stringify(ajvReport.errors));
});

// ---- registry + install -------------------------------------------------------------------------

async function withRegistry(fn, { tamper } = {}) {
  const { buildIndex, serialize } = await import(new URL('file:///' + path.join(TEMPLATE, 'scripts', 'build-index.mjs').replace(/\\/g, '/')).href);
  const { index } = buildIndex(TEMPLATE);
  return withServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (u === '/registry/index.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(serialize(index)); return; }
    if (u.startsWith('/registry/packs/')) {
      const f = path.join(TEMPLATE, u.slice('/registry/'.length));
      if (!f.startsWith(path.join(TEMPLATE, 'packs')) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      let body = fs.readFileSync(f);
      if (tamper) body = Buffer.from(body.toString('utf8').replace('"severity": "critical"', '"severity": "info"'));
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); return;
    }
    res.writeHead(404); res.end();
  }, base => fn({ ANVIL_HOME: tmpHome(), ANVIL_REGISTRY_URL: base + '/registry/index.json' }, index));
}

test('add / list / load / remove from a registry, sha256-verified', async () => {
  await withRegistry(async env => {
    const r = await addAddon('stripe-checkout', { env });
    assert.equal(r.status, 'installed');
    assert.ok(fs.existsSync(path.join(env.ANVIL_HOME, 'addons', 'stripe-checkout@0.1.0', 'anvil-addon.json')));
    assert.equal((await addAddon('stripe-checkout@0.1.0', { env })).status, 'already-installed');
    await addAddon('auth-pages', { env });
    const items = listInstalled({ env });
    assert.deepEqual(items.map(i => `${i.id}@${i.version}:${i.ok}`), ['auth-pages@0.1.0:true', 'stripe-checkout@0.1.0:true']);

    const { packs, problems } = loadInstalledPacks({ env, only: ['auth-pages', 'supabase-rls'] });
    assert.deepEqual(packs.map(p => p.id), ['auth-pages']);
    assert.match(problems[0].why, /Not installed/);

    let got = null;
    const reg = await registerInstalledAddons({ env, registerChecks: c => { got = c; } });
    assert.equal(reg.registered, true);
    assert.equal(got.length, 11);
    assert.equal(reg.humanChecks.length, 8);

    // tampering with an installed file is noticed
    const f = path.join(env.ANVIL_HOME, 'addons', 'auth-pages@0.1.0', 'anvil-addon.json');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"severity": "medium"', '"severity": "info"'));
    assert.match(listInstalled({ env }).find(i => i.id === 'auth-pages').errors.join(), /sha256 mismatch/);
    assert.deepEqual(loadInstalledPacks({ env }).packs.map(p => p.id), ['stripe-checkout']);

    assert.deepEqual(removeAddon('auth-pages', { env }), ['auth-pages@0.1.0']);
    assert.deepEqual(removeAddon('auth-pages', { env }), []);
    await assert.rejects(addAddon('nope-pack', { env }), /no add-on/);
    await assert.rejects(addAddon('../etc', { env }), /not an add-on id/);
    fs.rmSync(env.ANVIL_HOME, { recursive: true, force: true });
  });
});

test('a download that does not match the index sha256 is refused', async () => {
  await withRegistry(async env => {
    await assert.rejects(addAddon('supabase-rls', { env }), /sha256 mismatch/);
    assert.equal(listInstalled({ env }).length, 0);
    fs.rmSync(env.ANVIL_HOME, { recursive: true, force: true });
  }, { tamper: true });
});

test('registry must be https (localhost http allowed for development)', async () => {
  await assert.rejects(addAddon('auth-pages', { env: { ANVIL_HOME: tmpHome(), ANVIL_REGISTRY_URL: 'http://registry.example/index.json' } }), /https/);
});

test('validateIndex rejects paths that escape the registry', () => {
  const idx = { schemaVersion: '1', packs: [{ id: 'abc', versions: [{ version: '1.0.0', sha256: 'a'.repeat(64), path: '../x.json' }] }] };
  assert.match(validateIndex(idx).join(), /bad path/);
  idx.packs[0].versions[0].path = 'https://evil.example/x.json';
  assert.match(validateIndex(idx).join(), /bad path/);
});

test('addonCommand: list / add --file / validate / remove / help', async () => {
  const env = { ANVIL_HOME: tmpHome(), ANVIL_REGISTRY_URL: 'http://127.0.0.1:9/never' };
  const run = async (...argv) => { const o = sink(), e = sink(); const code = await addonCommand(argv, { stdout: o, stderr: e, env }); return { code, out: o.text, err: e.text }; };
  assert.match((await run('list')).out, /No add-ons installed/);
  const add = await run('add', '--file', SEEDS[0]);
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /Installed supabase-rls@0\.1\.0/);
  assert.match((await run('list')).out, /supabase-rls@0\.1\.0.*7 checks, 3 human checks/);
  const json = JSON.parse((await run('list', '--json')).out);
  assert.equal(json[0].id, 'supabase-rls');
  assert.equal((await run('validate', ...SEEDS)).code, 0);
  const badFile = path.join(env.ANVIL_HOME, 'bad.json');
  fs.writeFileSync(badFile, JSON.stringify({ ...load(SEEDS[0]), checks: [{ ...load(SEEDS[0]).checks[0], match: { regex: '(a+)+' } }] }));
  const v = await run('validate', badFile);
  assert.equal(v.code, 1);
  assert.match(v.out, /nested quantifiers/);
  assert.equal((await run('remove', 'supabase-rls')).code, 0);
  assert.equal((await run('remove', 'supabase-rls')).code, 1);
  assert.match((await run('help')).out, /anvil addon add/);
  assert.equal((await run('frobnicate')).code, 2);
  fs.rmSync(env.ANVIL_HOME, { recursive: true, force: true });
});

test('local add re-validates and installs a pack', () => {
  const env = { ANVIL_HOME: tmpHome() };
  const r = addLocalAddon(SEEDS[2], { env });
  assert.equal(r.status, 'installed');
  assert.equal(listInstalled({ env })[0].sha256, sha256(fs.readFileSync(SEEDS[2])));
  fs.rmSync(env.ANVIL_HOME, { recursive: true, force: true });
});

// ---- registry template stays in sync ------------------------------------------------------------

test('repo-template copies of the validator and schema match the originals', () => {
  assert.equal(fs.readFileSync(path.join(TEMPLATE, 'scripts', 'pack-validate.mjs'), 'utf8'), fs.readFileSync(path.join(HERE, 'pack-validate.mjs'), 'utf8'),
    'copy src/addons/pack-validate.mjs to addons-spec/repo-template/scripts/');
  assert.equal(fs.readFileSync(path.join(TEMPLATE, 'schema', 'anvil-addon.schema.json'), 'utf8'), fs.readFileSync(path.join(ROOT, 'schemas', 'anvil-addon.schema.json'), 'utf8'),
    'copy schemas/anvil-addon.schema.json to addons-spec/repo-template/schema/');
});
