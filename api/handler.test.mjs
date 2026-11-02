import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import Ajv from 'ajv';
import { createApp, SESSION_COOKIE, OAUTH_COOKIE } from './index.mjs';
import { MemoryStore } from './lib/store.mjs';
import { makeTarGz, fakeFetch, jsonRes, fakeCrypto, fakeSecrets, event, FAKE, loadReportSchema } from './_testkit.mjs';

const SITE = 'https://anvil.horvans.com';
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('date-time', (s) => !Number.isNaN(Date.parse(s)));
const validate = ajv.compile(loadReportSchema());

const TGZ = makeTarGz([
  { path: 'acme-notes-abc/public/assets/js/billing.js', content: `// billing\n\n\nconst key = "${FAKE.stripeLive}";\n` },
  { path: 'acme-notes-abc/firestore.rules', content: 'service cloud.firestore {\n match /{document=**} {\n  allow read, write: if true;\n }\n}\n' },
]);

function githubRoutes(extra = []) {
  return [
    ...extra,
    { match: (u, i) => u === 'https://github.com/login/oauth/access_token' && i.method === 'POST',
      respond: (u, i) => {
        const p = new URLSearchParams(i.body);
        if (p.get('grant_type') === 'refresh_token') return jsonRes({ access_token: 'user-token-2', expires_in: 28800, refresh_token: 'refresh-2', refresh_token_expires_in: 15897600 });
        return jsonRes({ access_token: 'user-token-1', expires_in: 28800, refresh_token: 'refresh-1', refresh_token_expires_in: 15897600 });
      } },
    { match: (u) => u === 'https://api.github.com/user', respond: () => jsonRes({ id: 42, login: 'aarav', name: 'Aarav', avatar_url: 'https://avatars.githubusercontent.com/u/42' }) },
    { match: (u) => u.startsWith('https://api.github.com/user/installations?'), respond: () => jsonRes({ installations: [{ id: 7 }] }) },
    { match: (u) => u.startsWith('https://api.github.com/user/installations/7/repositories'), respond: () => jsonRes({ repositories: [{ owner: { login: 'acme' }, name: 'notes', full_name: 'acme/notes', private: true, default_branch: 'main' }] }) },
    { match: (u) => u === 'https://api.github.com/repos/acme/notes', respond: () => jsonRes({ private: true, default_branch: 'main', size: 10, full_name: 'acme/notes' }) },
    { match: (u) => u === 'https://api.github.com/repos/pub/site', respond: () => jsonRes({ private: false, default_branch: 'trunk', size: 10, full_name: 'pub/site' }) },
    { match: (u) => /^https:\/\/api\.github\.com\/repos\/(acme\/notes|pub\/site)\/tarball\//.test(u),
      respond: (u) => new Response(null, { status: 302, headers: { location: `https://codeload.github.com/x/legacy.tar.gz/${u.split('/tarball/')[1]}` } }) },
    { match: (u) => u.startsWith('https://codeload.github.com/'), respond: () => new Response(TGZ, { status: 200, headers: { 'content-length': String(TGZ.length) } }) },
    { match: (u) => u.startsWith('https://api.github.com/repos/'), respond: () => jsonRes({ message: 'Not Found' }, 404) },
    { match: (u) => u === 'https://api.anthropic.com/v1/messages', respond: () => jsonRes({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Roll the key, then move it server-side.' }] }) },
  ];
}

function setup({ env = {}, now = () => Date.parse('2026-11-02T10:00:00Z'), routes } = {}) {
  const store = new MemoryStore({ now });
  const crypto = fakeCrypto();
  const fetch = fakeFetch(routes || githubRoutes());
  const logs = [];
  const app = createApp({
    env: { GITHUB_MODE: 'on', TABLE_NAME: 'anvil-main', KMS_KEY_ID: 'k', SITE_ORIGIN: SITE, ...env },
    now, store, crypto, fetch, secrets: fakeSecrets(), log: (o) => logs.push(o),
  });
  return { app, store, crypto, fetch, logs };
}

const cookieVal = (res, name) => {
  const c = (res.cookies || []).find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};
const post = (path, body, extra = {}) => event({ method: 'POST', path, body, headers: { origin: SITE, 'content-type': 'application/json', ...(extra.headers || {}) }, cookies: extra.cookies, ip: extra.ip });

async function signIn(ctx) {
  const start = await ctx.app(event({ path: '/api/auth/github/start' }));
  const state = new URL(start.headers.location).searchParams.get('state');
  const cb = await ctx.app(event({ path: '/api/auth/github/callback', query: { code: 'abc123', state }, cookies: [`${OAUTH_COOKIE}=${state}`] }));
  const sid = cookieVal(cb, SESSION_COOKIE);
  return { start, cb, sid, cookies: [`${SESSION_COOKIE}=${sid}`] };
}

test('health works without any AWS config and reports flags', async () => {
  const app = createApp({ env: {}, log: () => {} });
  const r = await app(event({ path: '/api/health' }));
  assert.equal(r.statusCode, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true, service: 'anvil-api', version: '0.2.0', githubMode: false, demoScan: true });
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('GITHUB_MODE off: auth/repo routes answer 503 with a friendly message', async () => {
  const { app } = setup({ env: { GITHUB_MODE: 'off' } });
  const me = await app(event({ path: '/api/me' }));
  assert.equal(me.statusCode, 503);
  assert.match(JSON.parse(me.body).message, /Local mode works today/);
  const start = await app(event({ path: '/api/auth/github/start' }));
  assert.equal(start.statusCode, 503);
  assert.match(start.headers['content-type'], /text\/html/);
  for (const p of ['/api/scan-repo', '/api/ai']) {
    const r = await app(post(p, { owner: 'acme', repo: 'notes' }));
    assert.equal(r.statusCode, 503, p);
  }
  assert.equal((await app(event({ path: '/api/repos' }))).statusCode, 503);
});

test('OAuth start -> callback: state + PKCE, encrypted token, HttpOnly session cookie, redirect to /app/', async () => {
  const ctx = setup();
  const { start, cb, sid } = await signIn(ctx);
  assert.equal(start.statusCode, 302);
  const loc = new URL(start.headers.location);
  assert.equal(loc.origin + loc.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(loc.searchParams.get('client_id'), 'Iv1.testclient');
  assert.equal(loc.searchParams.get('redirect_uri'), `${SITE}/api/auth/github/callback`);
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const oauthCookie = start.cookies.find((c) => c.startsWith(OAUTH_COOKIE));
  assert.match(oauthCookie, /HttpOnly; Secure; SameSite=Lax; Max-Age=600/);

  const tokenCall = ctx.fetch.calls.find((c) => c.url === 'https://github.com/login/oauth/access_token');
  const sent = new URLSearchParams(tokenCall.init.body);
  const verifier = sent.get('code_verifier');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), loc.searchParams.get('code_challenge'));
  assert.equal(sent.get('code'), 'abc123');

  assert.equal(cb.statusCode, 302);
  assert.equal(cb.headers.location, `${SITE}/app/`);
  assert.match(sid, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(cb.cookies.some((c) => c.startsWith(`${OAUTH_COOKIE}=;`) && c.includes('Max-Age=0')));
  assert.match(cb.cookies.find((c) => c.startsWith(SESSION_COOKIE)), /Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800/);
  assert.deepEqual(ctx.crypto.calls[0], { op: 'encrypt', ctx: { app: 'anvil', purpose: 'github-user-token', uid: '42' } });
  // Raw session id and raw tokens are never stored in plain form.
  const dump = JSON.stringify([...ctx.store.items]);
  assert.ok(!dump.includes(sid));
  assert.ok(!dump.includes('"user-token-1"'));
  assert.ok(!JSON.stringify(ctx.logs).includes('user-token-1'));
});

test('callback refuses a state that does not match the cookie, and a replayed state', async () => {
  const ctx = setup();
  const start = await ctx.app(event({ path: '/api/auth/github/start' }));
  const state = new URL(start.headers.location).searchParams.get('state');
  const other = 'A'.repeat(43);
  const bad = await ctx.app(event({ path: '/api/auth/github/callback', query: { code: 'c', state }, cookies: [`${OAUTH_COOKIE}=${other}`] }));
  assert.equal(bad.headers.location, `${SITE}/app/?error=state`);
  const ok = await ctx.app(event({ path: '/api/auth/github/callback', query: { code: 'c', state }, cookies: [`${OAUTH_COOKIE}=${state}`] }));
  assert.equal(ok.headers.location, `${SITE}/app/`);
  const replay = await ctx.app(event({ path: '/api/auth/github/callback', query: { code: 'c', state }, cookies: [`${OAUTH_COOKIE}=${state}`] }));
  assert.equal(replay.headers.location, `${SITE}/app/?error=expired`);
  const denied = await ctx.app(event({ path: '/api/auth/github/callback', query: { error: 'access_denied' } }));
  assert.equal(denied.headers.location, `${SITE}/app/?error=denied`);
});

test('/api/me, /api/repos and logout', async () => {
  const ctx = setup();
  const out = await ctx.app(event({ path: '/api/me' }));
  assert.deepEqual(JSON.parse(out.body), { signedIn: false, signInUrl: '/api/auth/github/start' });
  const { cookies } = await signIn(ctx);
  const me = JSON.parse((await ctx.app(event({ path: '/api/me', cookies }))).body);
  assert.equal(me.user.login, 'aarav');
  assert.deepEqual(me.credits, { used: 0, limit: 3, remaining: 3, resetsAt: '2026-12-01T00:00:00.000Z' });
  assert.equal(me.installUrl, 'https://github.com/apps/anvil-by-horvans/installations/new');

  const repos = JSON.parse((await ctx.app(event({ path: '/api/repos', cookies }))).body);
  assert.equal(repos.repos[0].fullName, 'acme/notes');
  const ghCall = ctx.fetch.calls.find((c) => c.url.startsWith('https://api.github.com/user/installations?'));
  assert.equal(ghCall.init.headers.authorization, 'Bearer user-token-1');

  assert.equal((await ctx.app(event({ method: 'POST', path: '/api/logout', cookies }))).statusCode, 403, 'logout needs Origin');
  const lo = await ctx.app(post('/api/logout', {}, { cookies }));
  assert.equal(lo.statusCode, 200);
  assert.ok(lo.cookies[0].includes('Max-Age=0'));
  assert.equal(JSON.parse((await ctx.app(event({ path: '/api/me', cookies }))).body).signedIn, false);
  assert.equal((await ctx.app(event({ path: '/api/repos', cookies }))).statusCode, 401);
});

test('expired access token is refreshed and re-encrypted', async () => {
  let t = Date.parse('2026-11-02T10:00:00Z');
  const ctx = setup({ now: () => t });
  const { cookies } = await signIn(ctx);
  t += 9 * 3600 * 1000;
  const r = await ctx.app(event({ path: '/api/repos', cookies }));
  assert.equal(r.statusCode, 200);
  const last = ctx.fetch.calls.filter((c) => c.url.startsWith('https://api.github.com/user/installations')).at(-1);
  assert.equal(last.init.headers.authorization, 'Bearer user-token-2');
});

test('scan-repo: Origin + JSON required, validates input, returns a schema-valid redacted report', async () => {
  const ctx = setup();
  const { cookies } = await signIn(ctx);
  const noOrigin = await ctx.app(event({ method: 'POST', path: '/api/scan-repo', body: { owner: 'acme', repo: 'notes' }, headers: { 'content-type': 'application/json' }, cookies }));
  assert.equal(noOrigin.statusCode, 403);
  const evil = await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes' }, { cookies, headers: { origin: 'https://evil.example' } }));
  assert.equal(evil.statusCode, 403);
  const form = await ctx.app(event({ method: 'POST', path: '/api/scan-repo', body: 'owner=acme', headers: { origin: SITE, 'content-type': 'application/x-www-form-urlencoded' }, cookies }));
  assert.equal(form.statusCode, 415);
  assert.equal((await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: '../x' }, { cookies }))).statusCode, 400);
  assert.equal((await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes', ref: 'a/../b' }, { cookies }))).statusCode, 400);
  assert.equal((await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes' }))).statusCode, 401);

  const r = await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes' }, { cookies }));
  assert.equal(r.statusCode, 200, r.body);
  const report = JSON.parse(r.body);
  assert.ok(validate(report), JSON.stringify(validate.errors));
  assert.equal(report.target.kind, 'github');
  assert.equal(report.target.value, 'acme/notes@main');
  assert.ok(!r.body.includes(FAKE.stripeLive));
  assert.equal(report.summary.counts.critical, 2);
  const cl = ctx.fetch.calls.find((c) => c.url.startsWith('https://codeload.github.com/'));
  assert.equal(cl.init.headers.authorization, undefined, 'token must not go to codeload');
  const notFound = await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'secret-repo' }, { cookies }));
  assert.equal(notFound.statusCode, 404);
});

test('scan-repo is capped per user per day', async () => {
  const ctx = setup({ env: { SCAN_USER_DAILY_CAP: '1' } });
  const { cookies } = await signIn(ctx);
  assert.equal((await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes' }, { cookies }))).statusCode, 200);
  const r = await ctx.app(post('/api/scan-repo', { owner: 'acme', repo: 'notes' }, { cookies }));
  assert.equal(r.statusCode, 429);
  assert.equal(JSON.parse(r.body).error, 'scan_limit');
  assert.ok(Number(r.headers['retry-after']) > 0);
});

test('/api/ai: redacts before sending, 3 per user per month, then 429', async () => {
  const ctx = setup();
  const { cookies } = await signIn(ctx);
  const body = { task: 'explain', finding: { title: 'Live Stripe key', why: `value ${FAKE.stripeLive}`, file: 'billing.js', line: 4 } };
  for (let i = 1; i <= 3; i++) {
    const r = await ctx.app(post('/api/ai', body, { cookies }));
    assert.equal(r.statusCode, 200, r.body);
    const j = JSON.parse(r.body);
    assert.equal(j.text, 'Roll the key, then move it server-side.');
    assert.equal(j.credits.used, i);
  }
  const capped = await ctx.app(post('/api/ai', body, { cookies }));
  assert.equal(capped.statusCode, 429);
  assert.equal(JSON.parse(capped.body).error, 'credits_used');
  const calls = ctx.fetch.calls.filter((c) => c.url === 'https://api.anthropic.com/v1/messages');
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.ok(!c.init.body.includes(FAKE.stripeLive));
    const sent = JSON.parse(c.init.body);
    assert.equal(sent.model, 'claude-haiku-5-5');
    assert.match(sent.messages[0].content, /<untrusted>/);
    assert.equal(c.init.headers['x-api-key'], FAKE.anthropic);
  }
  assert.ok(!JSON.stringify(ctx.logs).includes(FAKE.anthropic));
});

test('/api/ai: global daily cap returns 429 for everyone; upstream failure refunds the credit', async () => {
  const ctx = setup({ env: { GLOBAL_AI_DAILY_CAP: '1' } });
  const { cookies } = await signIn(ctx);
  const body = { finding: { title: 'x' } };
  assert.equal((await ctx.app(post('/api/ai', body, { cookies }))).statusCode, 200);
  const r = await ctx.app(post('/api/ai', body, { cookies }));
  assert.equal(r.statusCode, 429);
  assert.equal(JSON.parse(r.body).error, 'credits_paused');

  const failing = setup({ routes: githubRoutes([{ match: (u) => u === 'https://api.anthropic.com/v1/messages', respond: () => jsonRes({ error: {} }, 529) }]) });
  const s2 = await signIn(failing);
  const f = await failing.app(post('/api/ai', body, { cookies: s2.cookies }));
  assert.equal(f.statusCode, 502);
  const me = JSON.parse((await failing.app(event({ path: '/api/me', cookies: s2.cookies }))).body);
  assert.equal(me.credits.used, 0);
});

test('/api/demo/scan: public repos only, 5 per IP per day, global cap', async () => {
  const ctx = setup({ env: { GITHUB_MODE: 'off' } });
  assert.equal((await ctx.app(post('/api/demo/scan', { repoUrl: 'http://github.com/pub/site' }))).statusCode, 400);
  assert.equal((await ctx.app(post('/api/demo/scan', { repoUrl: 'https://gitlab.com/pub/site' }))).statusCode, 400);
  const priv = await ctx.app(post('/api/demo/scan', { repoUrl: 'https://github.com/acme/notes' }, { ip: '198.51.100.1' }));
  assert.equal(priv.statusCode, 404);
  assert.equal(JSON.parse(priv.body).error, 'public_repos_only');

  for (let i = 0; i < 5; i++) {
    const r = await ctx.app(post('/api/demo/scan', { repoUrl: 'https://github.com/pub/site' }));
    assert.equal(r.statusCode, 200, r.body);
    const rep = JSON.parse(r.body);
    assert.ok(validate(rep));
    assert.equal(rep.target.value, 'pub/site@trunk');
  }
  const limited = await ctx.app(post('/api/demo/scan', { repoUrl: 'https://github.com/pub/site' }));
  assert.equal(limited.statusCode, 429);
  assert.equal(JSON.parse(limited.body).error, 'demo_limit');
  // A different viewer (CloudFront-Viewer-Address) still gets through.
  const other = await ctx.app(post('/api/demo/scan', { repoUrl: 'https://github.com/pub/site/tree/main' }, { headers: { 'cloudfront-viewer-address': '192.0.2.44:51234' } }));
  assert.equal(other.statusCode, 200);
  assert.equal(JSON.parse(other.body).target.value, 'pub/site@main');
  const anon = ctx.fetch.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
  assert.ok(anon.every((c) => !c.init.headers.authorization), 'demo never sends a token');

  const g = setup({ env: { DEMO_GLOBAL_DAILY_CAP: '1' } });
  assert.equal((await g.app(post('/api/demo/scan', { repoUrl: 'https://github.com/pub/site' }, { ip: '198.51.100.7' }))).statusCode, 200);
  const busy = await g.app(post('/api/demo/scan', { repoUrl: 'https://github.com/pub/site' }, { ip: '198.51.100.8' }));
  assert.equal(JSON.parse(busy.body).error, 'busy');
});

test('CORS is strict to SITE_ORIGIN; unknown routes 404; wrong method 405; origin-verify header', async () => {
  const { app } = setup();
  const pre = await app(event({ method: 'OPTIONS', path: '/api/ai', headers: { origin: SITE } }));
  assert.equal(pre.statusCode, 204);
  assert.equal(pre.headers['access-control-allow-origin'], SITE);
  assert.equal(pre.headers['access-control-allow-credentials'], 'true');
  const bad = await app(event({ method: 'OPTIONS', path: '/api/ai', headers: { origin: 'https://evil.example' } }));
  assert.equal(bad.statusCode, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const h = await app(event({ path: '/api/health', headers: { origin: 'https://evil.example' } }));
  assert.equal(h.headers['access-control-allow-origin'], undefined);
  assert.equal((await app(event({ path: '/api/nope' }))).statusCode, 404);
  assert.equal((await app(event({ method: 'POST', path: '/api/health', headers: { origin: SITE } }))).statusCode, 405);

  const locked = setup({ env: { ORIGIN_VERIFY_SECRET: 'cf-shared-secret' } });
  assert.equal((await locked.app(event({ path: '/api/health' }))).statusCode, 403);
  assert.equal((await locked.app(event({ path: '/api/health', headers: { 'x-anvil-origin-verify': 'cf-shared-secret' } }))).statusCode, 200);
});

test('unexpected errors become a generic 500 and logs carry no secrets', async () => {
  const store = new MemoryStore();
  store.getSession = async () => { throw new Error(`boom ${FAKE.githubPat}`); };
  const logs = [];
  const app = createApp({ env: { GITHUB_MODE: 'on' }, store, crypto: fakeCrypto(), secrets: fakeSecrets(), fetch: fakeFetch([]), log: (o) => logs.push(o) });
  const r = await app(event({ path: '/api/me', cookies: [`${SESSION_COOKIE}=${'B'.repeat(43)}`] }));
  assert.equal(r.statusCode, 500);
  assert.equal(JSON.parse(r.body).error, 'internal');
  assert.ok(!JSON.stringify(logs).includes(FAKE.githubPat));
});
