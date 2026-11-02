// anvil-api: one Lambda behind API Gateway HTTP API (payload v2), routed from CloudFront /api/*.
// GitHub mode (sign-in, repo list, repo scan, AI credits) sits behind GITHUB_MODE=on.
// The hosted side never executes repo code and never browses user URLs.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlink } from 'node:fs/promises';
import {
  HttpError, json, html, redirect, errorResponse, header, parseCookies, setCookie, clearCookie,
  method as methodOf, path as pathOf, query, readJson, safeEqual, randomToken, sha256hex, sha256b64url,
  clientIp, corsHeaders,
} from './lib/http.mjs';
import { DynamoStore } from './lib/store.mjs';
import { createAwsSend, KmsCrypto, SecretsLoader } from './lib/aws.mjs';
import { GitHub, validRepoInput, parseRepoUrl } from './lib/github.mjs';
import { scanTarGz, buildReport } from './lib/scan.mjs';
import { parseAiRequest, buildPrompt, callClaude, DEFAULT_MODEL } from './lib/ai.mjs';

export const SESSION_COOKIE = '__Host-anvil_session';
export const OAUTH_COOKIE = '__Host-anvil_oauth';
const SESSION_TTL = 7 * 24 * 3600;
const OAUTH_TTL = 600;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };

export function readConfig(env = process.env) {
  const siteOrigin = (env.SITE_ORIGIN || 'https://anvil.horvans.com').replace(/\/+$/, '');
  const extra = String(env.EXTRA_ORIGINS || '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return {
    githubMode: String(env.GITHUB_MODE || 'off').toLowerCase() === 'on',
    demoScan: String(env.DEMO_SCAN || 'on').toLowerCase() !== 'off',
    table: env.TABLE_NAME,
    kmsKeyId: env.KMS_KEY_ID,
    ssmGithub: env.SSM_GITHUB_PARAM || '/anvil/github',
    ssmAnthropic: env.SSM_ANTHROPIC_PARAM || '/anvil/anthropic',
    siteOrigin,
    allowedOrigins: [siteOrigin, ...extra],
    originVerifySecret: env.ORIGIN_VERIFY_SECRET || '',
    aiUserMonthlyCap: int(env.USER_AI_MONTHLY_CAP, 3),
    aiGlobalDailyCap: int(env.GLOBAL_AI_DAILY_CAP, 200),
    demoIpDailyCap: int(env.DEMO_IP_DAILY_CAP, 5),
    demoGlobalDailyCap: int(env.DEMO_GLOBAL_DAILY_CAP, 200),
    scanUserDailyCap: int(env.SCAN_USER_DAILY_CAP, 20),
    scanGlobalDailyCap: int(env.SCAN_GLOBAL_DAILY_CAP, 500),
    maxTarballBytes: int(env.MAX_TARBALL_MB, 50) * 1024 * 1024,
    anthropicModel: env.ANTHROPIC_MODEL || DEFAULT_MODEL,
    version: env.ANVIL_VERSION || '0.2.0',
  };
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const month = (ms) => new Date(ms).toISOString().slice(0, 7);
const secsToMidnight = (ms) => { const d = new Date(ms); d.setUTCHours(24, 0, 0, 0); return Math.max(1, Math.ceil((d - ms) / 1000)); };
const nextMonth = (ms) => { const d = new Date(ms); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };

const OFF_MESSAGE = "GitHub mode isn't switched on yet. Local mode works today: https://anvil.horvans.com/install";

function offPage(cfg) {
  return html(503, `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Anvil</title>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 16px;background:#fff;color:#111">
<h1 style="font-size:1.4rem">GitHub mode is not switched on yet</h1>
<p>Anvil's local mode works today: install it and run <code>anvil scan</code> on your app.</p>
<p><a href="${cfg.siteOrigin}/install" style="color:#c2410c">Install Anvil</a> &middot; <a href="${cfg.siteOrigin}/demo" style="color:#c2410c">See the demo</a></p></body>`);
}

/**
 * @param {object} [deps]
 * @param {object} [deps.env]
 * @param {Function} [deps.fetch]
 * @param {()=>number} [deps.now]
 * @param {object} [deps.store]   DynamoStore-compatible
 * @param {object} [deps.crypto]  {encrypt(text, ctx), decrypt(b64, ctx)}
 * @param {object} [deps.secrets] {github(name), anthropicKey(name)}
 * @param {Function} [deps.log]
 * @param {Function} [deps.scan]  (filePath) => scanner, defaults to scanTarGz
 */
export function createApp(deps = {}) {
  const cfg = readConfig(deps.env || process.env);
  const now = deps.now || Date.now;
  const fetchFn = deps.fetch || ((...a) => globalThis.fetch(...a));
  const log = deps.log || ((o) => console.log(JSON.stringify(o)));
  const gh = new GitHub({ fetch: fetchFn });
  let awsSend = null;
  const aws = () => (awsSend ||= deps.awsSend || createAwsSend());
  let store = deps.store; let crypto = deps.crypto; let secrets = deps.secrets;
  const getStore = () => (store ||= new DynamoStore({ send: aws(), table: cfg.table, now }));
  const getCrypto = () => (crypto ||= new KmsCrypto({ send: aws(), keyId: cfg.kmsKeyId }));
  const getSecrets = () => (secrets ||= new SecretsLoader({ send: aws(), now }));
  const scanFile = deps.scan || ((p) => scanTarGz(p, { now }));
  const callbackUrl = `${cfg.siteOrigin}/api/auth/github/callback`;
  const appUrl = (q = '') => `${cfg.siteOrigin}/app/${q}`;

  // ---------- guards ----------
  function requirePostOrigin(event) {
    const origin = header(event, 'origin');
    if (!origin || !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'bad_origin', 'Requests must come from the Anvil site.');
    const site = header(event, 'sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'same-site') throw new HttpError(403, 'bad_origin', 'Cross-site requests are not allowed.');
  }
  function requireGithubMode() {
    if (!cfg.githubMode) throw new HttpError(503, 'github_mode_off', OFF_MESSAGE);
  }

  async function loadSession(event) {
    const id = parseCookies(event)[SESSION_COOKIE];
    if (!id || !TOKEN_RE.test(id)) return null;
    const hash = sha256hex(id);
    const s = await getStore().getSession(hash);
    return s ? { hash, data: s.data } : null;
  }
  async function requireSession(event) {
    const s = await loadSession(event);
    if (!s) throw new HttpError(401, 'signed_out', 'Sign in with GitHub first.');
    return s;
  }
  const tokenCtx = (uid) => ({ app: 'anvil', purpose: 'github-user-token', uid: String(uid) });

  async function userToken(sess) {
    let tok;
    try { tok = JSON.parse(await getCrypto().decrypt(sess.data.tok, tokenCtx(sess.data.uid))); } catch {
      await getStore().deleteSession(sess.hash);
      throw new HttpError(401, 'github_reauth', 'Your session could not be read. Sign in again.');
    }
    const t = now();
    if (!tok.ae || tok.ae - 120000 > t) return tok.a;
    if (!tok.r || (tok.re && tok.re <= t)) {
      await getStore().deleteSession(sess.hash);
      throw new HttpError(401, 'github_reauth', 'Your GitHub sign-in expired. Sign in again.');
    }
    const g = await getSecrets().github(cfg.ssmGithub);
    let fresh;
    try {
      fresh = await gh.refresh({ clientId: g.clientId, clientSecret: g.clientSecret, refreshToken: tok.r, now: t });
    } catch {
      await getStore().deleteSession(sess.hash);
      throw new HttpError(401, 'github_reauth', 'Your GitHub sign-in expired. Sign in again.');
    }
    const enc = await getCrypto().encrypt(JSON.stringify({ a: fresh.access, r: fresh.refresh, ae: fresh.accessExp, re: fresh.refreshExp }), tokenCtx(sess.data.uid));
    sess.data = { ...sess.data, tok: enc };
    await getStore().updateSession(sess.hash, sess.data);
    return fresh.access;
  }

  async function consumeOr429(counters, messages) {
    const r = await getStore().consume(counters);
    if (!r.ok) throw new HttpError(429, messages[r.index].code, messages[r.index].message, messages[r.index].extra);
  }

  async function runScan({ token, owner, repo, ref }) {
    const file = join(tmpdir(), `anvil-${randomToken(12)}.tgz`);
    const started = now();
    try {
      await gh.downloadTarball(token, owner, repo, ref, file, cfg.maxTarballBytes);
      const scanner = await scanFile(file);
      return buildReport(scanner, { owner, repo, ref, scannedAt: started, anvilVersion: cfg.version });
    } finally {
      await unlink(file).catch(() => {});
    }
  }

  // ---------- routes ----------
  const routes = {
    'GET /api/health': async () => json(200, { ok: true, service: 'anvil-api', version: cfg.version, githubMode: cfg.githubMode, demoScan: cfg.demoScan }),

    'GET /api/auth/github/start': async () => {
      if (!cfg.githubMode) return offPage(cfg);
      const g = await getSecrets().github(cfg.ssmGithub);
      const state = randomToken(32);
      const verifier = randomToken(32);
      await getStore().putOAuthState(sha256hex(state), { verifier, at: now() }, OAUTH_TTL);
      const url = gh.authorizeUrl({ clientId: g.clientId, redirectUri: callbackUrl, state, codeChallenge: sha256b64url(verifier) });
      return redirect(url, { cookies: [setCookie(OAUTH_COOKIE, state, OAUTH_TTL)] });
    },

    'GET /api/auth/github/callback': async (event) => {
      if (!cfg.githubMode) return offPage(cfg);
      const q = query(event);
      const clear = [clearCookie(OAUTH_COOKIE)];
      const fail = (why) => redirect(appUrl(`?error=${why}`), { cookies: clear });
      if (q.error) return fail(q.error === 'access_denied' ? 'denied' : 'github');
      const state = String(q.state || '');
      const code = String(q.code || '');
      if (!TOKEN_RE.test(state) || !/^[A-Za-z0-9_.-]{1,256}$/.test(code)) return fail('bad_request');
      const cookieState = parseCookies(event)[OAUTH_COOKIE];
      if (!safeEqual(cookieState, state)) return fail('state');
      const saved = await getStore().takeOAuthState(sha256hex(state));
      if (!saved || !saved.verifier) return fail('expired');

      const g = await getSecrets().github(cfg.ssmGithub);
      let tokens; let user;
      try {
        tokens = await gh.exchangeCode({ clientId: g.clientId, clientSecret: g.clientSecret, code, redirectUri: callbackUrl, codeVerifier: saved.verifier, now: now() });
        user = await gh.user(tokens.access);
      } catch (e) {
        log({ level: 'warn', msg: 'oauth_exchange_failed', code: e.code || e.name });
        return fail('github');
      }
      const tok = await getCrypto().encrypt(JSON.stringify({ a: tokens.access, r: tokens.refresh, ae: tokens.accessExp, re: tokens.refreshExp }), tokenCtx(user.id));
      const sid = randomToken(32);
      await getStore().putSession(sha256hex(sid), { uid: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl, tok, at: now() }, SESSION_TTL);
      return redirect(appUrl(), { cookies: [...clear, setCookie(SESSION_COOKIE, sid, SESSION_TTL)] });
    },

    'GET /api/me': async (event) => {
      requireGithubMode();
      const s = await loadSession(event);
      if (!s) return json(200, { signedIn: false, signInUrl: '/api/auth/github/start' });
      const g = await getSecrets().github(cfg.ssmGithub);
      const used = await getStore().getCount(`cnt#ai#user#${s.data.uid}`, `m#${month(now())}`);
      return json(200, {
        signedIn: true,
        user: { id: s.data.uid, login: s.data.login, name: s.data.name, avatarUrl: s.data.avatarUrl },
        credits: { used, limit: cfg.aiUserMonthlyCap, remaining: Math.max(0, cfg.aiUserMonthlyCap - used), resetsAt: nextMonth(now()) },
        installUrl: `https://github.com/apps/${encodeURIComponent(g.appSlug)}/installations/new`,
      });
    },

    'POST /api/logout': async (event) => {
      requirePostOrigin(event);
      const cookies = [clearCookie(SESSION_COOKIE)];
      if (!cfg.githubMode) return json(200, { ok: true }, { cookies });
      const s = await loadSession(event);
      if (s) {
        await getStore().deleteSession(s.hash);
        try {
          const tok = JSON.parse(await getCrypto().decrypt(s.data.tok, tokenCtx(s.data.uid)));
          const g = await getSecrets().github(cfg.ssmGithub);
          await gh.revoke({ clientId: g.clientId, clientSecret: g.clientSecret, token: tok.a });
        } catch { /* best effort */ }
      }
      return json(200, { ok: true }, { cookies });
    },

    'GET /api/repos': async (event) => {
      requireGithubMode();
      const s = await requireSession(event);
      const token = await userToken(s);
      const g = await getSecrets().github(cfg.ssmGithub);
      const r = await gh.repos(token);
      return json(200, { ...r, installUrl: `https://github.com/apps/${encodeURIComponent(g.appSlug)}/installations/new` });
    },

    'POST /api/scan-repo': async (event) => {
      requirePostOrigin(event);
      requireGithubMode();
      const body = readJson(event);
      const s = await requireSession(event);
      const ref0 = body.ref === undefined || body.ref === null || body.ref === '' ? undefined : body.ref;
      const bad = validRepoInput(body.owner, body.repo, ref0);
      if (bad) throw new HttpError(400, `bad_${bad}`, `That ${bad} name is not valid.`);
      const t = now();
      await consumeOr429([
        { pk: `cnt#scan#user#${s.data.uid}`, sk: `d#${day(t)}`, cap: cfg.scanUserDailyCap, ttlSeconds: 2 * 86400 },
        { pk: 'cnt#scan#global', sk: `d#${day(t)}`, cap: cfg.scanGlobalDailyCap, ttlSeconds: 2 * 86400 },
      ], [
        { code: 'scan_limit', message: `You can run ${cfg.scanUserDailyCap} GitHub scans a day. Local mode has no limit.`, extra: { retryAfterSeconds: secsToMidnight(t) } },
        { code: 'busy', message: 'Anvil has hit its daily scan limit. Try again tomorrow, or use local mode.', extra: { retryAfterSeconds: secsToMidnight(t) } },
      ]);
      const token = await userToken(s);
      const meta = await gh.repo(token, body.owner, body.repo);
      if (!meta) throw new HttpError(404, 'repo_not_found', 'Repo not found, or the Anvil GitHub App is not installed on it.');
      const report = await runScan({ token, owner: body.owner, repo: body.repo, ref: ref0 || meta.defaultBranch });
      return json(200, report);
    },

    'POST /api/ai': async (event) => {
      requirePostOrigin(event);
      requireGithubMode();
      const body = readJson(event, 24 * 1024);
      const s = await requireSession(event);
      const req = parseAiRequest(body);
      const userText = buildPrompt(req); // redaction failure -> 422 before any credit or call
      const t = now();
      const counters = [
        { pk: `cnt#ai#user#${s.data.uid}`, sk: `m#${month(t)}`, cap: cfg.aiUserMonthlyCap, ttlSeconds: 40 * 86400 },
        { pk: 'cnt#ai#global', sk: `d#${day(t)}`, cap: cfg.aiGlobalDailyCap, ttlSeconds: 2 * 86400 },
      ];
      await consumeOr429(counters, [
        { code: 'credits_used', message: `You have used your ${cfg.aiUserMonthlyCap} free AI answers this month. Use Claude Code or Codex over MCP, or your own key, for unlimited use.`, extra: { resetsAt: nextMonth(t) } },
        { code: 'credits_paused', message: 'Free AI answers are paused for today (daily limit reached). Try tomorrow, or use your own key.', extra: { retryAfterSeconds: secsToMidnight(t) } },
      ]);
      let out;
      try {
        const apiKey = await getSecrets().anthropicKey(cfg.ssmAnthropic);
        out = await callClaude({ fetch: fetchFn, apiKey, model: cfg.anthropicModel, userText });
      } catch (e) {
        await getStore().refund(counters).catch(() => {});
        if (e instanceof HttpError) throw e;
        throw new HttpError(502, 'ai_upstream', 'The AI service did not answer. Your credit was not used.');
      }
      const used = await getStore().getCount(counters[0].pk, counters[0].sk);
      return json(200, { text: out.text, model: out.model, truncated: out.truncated, credits: { used, limit: cfg.aiUserMonthlyCap, remaining: Math.max(0, cfg.aiUserMonthlyCap - used) } });
    },

    'POST /api/demo/scan': async (event) => {
      requirePostOrigin(event);
      if (!cfg.demoScan) throw new HttpError(503, 'demo_off', 'The public repo demo scan is switched off right now.');
      const body = readJson(event);
      const parsed = parseRepoUrl(body.repoUrl);
      if (!parsed) throw new HttpError(400, 'bad_repo_url', 'Paste a public repo link like https://github.com/owner/repo');
      const t = now();
      const ipKey = sha256hex(`${cfg.table || 'anvil'}:${clientIp(event)}`);
      await consumeOr429([
        { pk: `cnt#demo#ip#${ipKey}`, sk: `d#${day(t)}`, cap: cfg.demoIpDailyCap, ttlSeconds: 2 * 86400 },
        { pk: 'cnt#demo#global', sk: `d#${day(t)}`, cap: cfg.demoGlobalDailyCap, ttlSeconds: 2 * 86400 },
      ], [
        { code: 'demo_limit', message: `The demo allows ${cfg.demoIpDailyCap} scans a day. Install Anvil to scan as much as you like.`, extra: { retryAfterSeconds: secsToMidnight(t) } },
        { code: 'busy', message: 'The demo has hit its daily limit. Try again tomorrow, or install Anvil.', extra: { retryAfterSeconds: secsToMidnight(t) } },
      ]);
      const meta = await gh.repo(null, parsed.owner, parsed.repo);
      if (!meta || meta.private) throw new HttpError(404, 'public_repos_only', 'Repo not found. The demo only scans public repos; sign in with GitHub for private ones.');
      if (meta.sizeKb > (cfg.maxTarballBytes / 1024) * 4) throw new HttpError(413, 'repo_too_large', 'That repo is too big for the demo. Use local mode (anvil scan).');
      const report = await runScan({ token: null, owner: parsed.owner, repo: parsed.repo, ref: parsed.ref || meta.defaultBranch });
      return json(200, report);
    },
  };

  const knownPaths = new Set(Object.keys(routes).map((k) => k.split(' ')[1]));

  return async function handler(event) {
    const started = now();
    const m = methodOf(event);
    const p = pathOf(event);
    const reqId = event.requestContext?.requestId;
    const cors = corsHeaders(event, cfg.allowedOrigins);
    let res;
    try {
      if (cfg.originVerifySecret && !safeEqual(header(event, 'x-anvil-origin-verify'), cfg.originVerifySecret)) {
        throw new HttpError(403, 'forbidden', 'Forbidden.');
      }
      if (m === 'OPTIONS') {
        const origin = header(event, 'origin');
        if (!origin || !cfg.allowedOrigins.includes(origin)) throw new HttpError(403, 'bad_origin', 'Origin not allowed.');
        res = { statusCode: 204, headers: { 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '600' }, body: '' };
      } else {
        const fn = routes[`${m} ${p}`];
        if (fn) res = await fn(event);
        else if (knownPaths.has(p)) throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        else throw new HttpError(404, 'not_found', 'Not found.');
      }
    } catch (err) {
      if (err instanceof HttpError) res = errorResponse(err);
      else {
        log({ level: 'error', reqId, route: `${m} ${p}`, err: String(err && err.name || 'Error'), msg: String(err && err.message || '').slice(0, 200).replace(/[A-Za-z0-9_-]{30,}/g, '[id]') });
        res = json(500, { error: 'internal', message: 'Something went wrong on our side. Try again in a minute.' });
      }
    }
    res.headers = { ...cors, ...(res.headers || {}) };
    log({ level: 'info', reqId, route: `${m} ${p}`, status: res.statusCode, ms: now() - started });
    return res;
  };
}

let defaultHandler;
export const handler = (event, context) => (defaultHandler ||= createApp())(event, context);
