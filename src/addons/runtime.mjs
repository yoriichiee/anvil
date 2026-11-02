// runtime.mjs - turns a validated, declarative add-on pack into engine checks.
//
// Nothing in a pack is executed as code. Each check "kind" is interpreted here:
//
//   page            GET match.path in the browser (or over HTTP when no browser). This kind is an
//                   EXPECTATION: a finding is raised when the page does NOT load as described
//                   (status outside match.status, default 200-399; match.regex missing from the
//                   HTML; match.selector absent).
//
// Feature detection (page, dom, axe): when the check's page answers 404 or 410, the feature is taken to be
// absent: status "skip", no finding, and a notChecked entry whose reason starts with "feature not detected".
// A pack sets `required: true` on a check to report a missing page as a finding instead.
//   dom             open match.path (default "/") in the browser; finding when match.selector is
//                   PRESENT (it describes the problem, e.g. a password form submitted by GET).
//   axe             run axe-core on match.path (default "/"), optionally scoped to match.selector
//                   and filtered to rule ids matching match.regex; finding when violations exist.
//   secret-pattern  scan source + built files for match.regex; one finding per file (values redacted).
//   http            match.method (GET|HEAD) match.path on the target site; finding when the response
//                   status is in match.status (default 200) AND, if given, the body matches match.regex.
//   rules-probe     same as http, but against backend endpoints found in the user's own code
//                   (ctx.rulesTargets, e.g. a Supabase project URL + anon key). Skipped when none.
//
// ctx (all optional; a check whose inputs are missing returns status "skip" + a notChecked entry):
//   baseUrl        target origin, already ownership-verified by the engine
//   page           Playwright Page
//   files          array or async iterable of { path, text } (path relative to the target root)
//   dir            folder to walk when ctx.files is not given
//   rulesTargets   [{ base: 'https://x.supabase.co', headers: {...}, name?: 'supabase' }]
//   fetch          fetch implementation (default: global fetch)
//   shot(name)     async -> screenshot path relative to the run folder
//   runAxe(page, { include }) async -> axe results (default: inject axe-core ourselves)
//   timeoutMs      per request / navigation (default 15000)
//
// run(ctx) resolves to { status: 'pass'|'fail'|'warn'|'skip', findings: [...], notChecked: [...] }
// where findings already match report.schema.json's finding shape.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { compileRegex, safeMatchAll } from './pack-validate.mjs';

const REPORT_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
const MAX_BODY = 512 * 1024;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FINDINGS_PER_CHECK = 20;
const REGEX_FILE_TIMEOUT_MS = 300;
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.html', '.htm', '.vue', '.svelte', '.astro',
  '.css', '.map', '.env', '.txt', '.md', '.yml', '.yaml', '.toml', '.php', '.py', '.rb', '.go', '.java', '.kt', '.swift', '.dart', '.xml', '.plist', '.ini', '.conf', '']);
const SKIP_DIRS = new Set(['node_modules', '.git', '.anvil', '.next/cache', '.cache', '.turbo', 'coverage']);

export function reportId(...parts) {
  const id = parts.join(':').toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
  if (REPORT_ID_RE.test(id)) return id;
  const h = crypto.createHash('sha256').update(id).digest('hex').slice(0, 10);
  return (id.slice(0, 88).replace(/^[^a-z0-9]+/, 'x') + '-' + h).slice(0, 100);
}

export function redact(value) {
  const s = String(value);
  const show = Math.min(8, Math.floor(s.length / 5));
  return `${s.slice(0, show)}[REDACTED ${s.length - show} chars]`;
}

const statusList = (s, dflt) => s == null ? dflt : Array.isArray(s) ? s : [s];
const lineOf = (text, index) => { let n = 1; for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++; return n; };

// Resolves a pack path against a base URL and refuses anything that leaves that origin.
export function sameSiteUrl(base, p) {
  const b = new URL(base);
  if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//') || p.includes('\\')) throw new Error(`path must stay on ${b.origin}`);
  // Pack paths are site-absolute: any path on the base URL is ignored.
  const out = new URL(b.origin + p);
  if (out.origin !== b.origin) throw new Error(`path must stay on ${b.origin}`);
  return out.href;
}

async function httpProbe(ctx, base, check, headers = {}) {
  const m = check.match;
  const method = m.method || 'GET';
  const url = sameSiteUrl(base, m.path);
  const f = ctx.fetch || globalThis.fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ctx.timeoutMs || 15000);
  try {
    const res = await f(url, { method, headers, redirect: 'manual', signal: ac.signal });
    let body = '';
    if (method === 'GET' && m.regex && res.body) body = await readCapped(res, MAX_BODY);
    else if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
    return { url, method, status: res.status, statusText: res.statusText || '', body, bytes: Number(res.headers?.get?.('content-length')) || body.length };
  } finally { clearTimeout(t); }
}

async function readCapped(res, cap) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader(); const chunks = []; let n = 0;
  while (n < cap) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
  reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map(c => Buffer.from(c))).subarray(0, cap).toString('utf8');
}

function bodyMatches(check, body) {
  if (!check.match.regex) return { ok: true };
  const { source, flags } = compileRegex(check.match.regex);
  const r = safeMatchAll(source, flags, body, { timeoutMs: REGEX_FILE_TIMEOUT_MS, max: 1 });
  return r.timedOut ? { timedOut: true } : { ok: r.matches.length > 0 };
}

async function* iterFiles(ctx) {
  if (ctx.files) { for await (const f of ctx.files) yield f; return; }
  if (!ctx.dir) return;
  const root = path.resolve(ctx.dir);
  const stack = [root];
  let count = 0;
  while (stack.length && count < 20000) {
    const d = stack.pop();
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_DIRS.has(rel)) stack.push(full); continue; }
      if (!e.isFile()) continue;
      const ext = path.extname(e.name).toLowerCase();
      if (!TEXT_EXT.has(ext) && !e.name.startsWith('.env')) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      count++;
      let text; try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      yield { path: rel, text };
    }
  }
}

const skip = (check, what, why) => ({ status: 'skip', findings: [], notChecked: [{ what: `${check.name}: ${what}`, why }] });

// A page / dom / axe check targets one page of a feature (a login page, a checkout success page...). When that page is
// not there at all, the app most likely does not have the feature (or keeps it at another URL): that is not a finding.
// The check is skipped and listed under notChecked, unless the pack marks it `required: true`.
export const FEATURE_NOT_DETECTED = 'feature not detected';
const NOT_FOUND = new Set([404, 410]);
const featureMissing = (check, status) => NOT_FOUND.has(status) && check.def.required !== true;
const featureSkip = (check, p, status) => ({
  status: 'skip', findings: [],
  notChecked: [{ what: `${check.source ? check.source.pack + ' / ' : ''}${check.def.id} (${p})`.slice(0, 500), why: `${FEATURE_NOT_DETECTED}: GET ${p} returned ${status}, so this add-on check did not run. If your app has this feature at another URL, check it by hand.` }],
});

function finding(check, n, evidence, extra = {}) {
  return {
    id: reportId('f', check.id.replace(/^addon:/, 'addon-'), String(n)),
    check: check.id,
    severity: check.severity,
    title: extra.title || check.name,
    evidence,
    why: check.def.why,
    fix: check.def.fix,
    confidence: extra.confidence || 'likely',
  };
}

const runners = {
  async 'secret-pattern'(check, ctx) {
    if (!ctx.files && !ctx.dir) return skip(check, 'secret pattern not scanned', 'No source or build files were available for this target.');
    const { source, flags } = compileRegex(check.def.match.regex);
    const findings = [], timedOut = [];
    let n = 0, scanned = 0;
    for await (const f of iterFiles(ctx)) {
      if (!f || typeof f.text !== 'string') continue;
      scanned++;
      const r = safeMatchAll(source, flags, f.text, { timeoutMs: REGEX_FILE_TIMEOUT_MS, max: 5 });
      if (r.timedOut) { timedOut.push(f.path); continue; }
      if (!r.matches.length) continue;
      const [idx, len] = r.matches[0];
      const val = f.text.substr(idx, len);
      findings.push(finding(check, ++n, {
        file: String(f.path).slice(0, 1024),
        line: lineOf(f.text, idx),
        response: `pattern matched ${r.matches.length >= 5 ? '5+' : r.matches.length} time(s); first value ${redact(val)}`,
      }, { confidence: 'likely' }));
      if (findings.length >= MAX_FINDINGS_PER_CHECK) break;
    }
    const notChecked = timedOut.length ? [{ what: `${check.name}: ${timedOut.length} file(s) not fully scanned (${timedOut.slice(0, 3).join(', ')}${timedOut.length > 3 ? ', ...' : ''})`, why: 'The add-on pattern hit the regex time limit on these files.' }] : [];
    if (!scanned) return skip(check, 'secret pattern not scanned', 'No readable text files were found.');
    return { status: findings.length ? 'fail' : timedOut.length ? 'warn' : 'pass', findings, notChecked };
  },

  async http(check, ctx) {
    if (!ctx.baseUrl) return skip(check, 'HTTP probe not run', 'The target is not a URL, so there is nothing to probe.');
    return probeResult(check, await httpProbe(ctx, ctx.baseUrl, check.def));
  },

  async 'rules-probe'(check, ctx) {
    const targets = (ctx.rulesTargets || []).filter(t => t && typeof t.base === 'string' && /^https?:\/\//.test(t.base));
    if (!targets.length) return skip(check, 'backend rules probe not run', 'No backend endpoint (e.g. a Supabase or Firebase URL) was found in the project code.');
    const findings = [], notChecked = [];
    let warn = false;
    for (const t of targets.slice(0, 5)) {
      let r;
      try { r = await httpProbe(ctx, t.base, check.def, t.headers || {}); }
      catch (e) { notChecked.push({ what: `${check.name} on ${new URL(t.base).host}`, why: `Request failed: ${String(e.message || e).slice(0, 200)}` }); warn = true; continue; }
      const res = probeResult(check, r, findings.length + 1);
      findings.push(...res.findings); notChecked.push(...res.notChecked);
      if (res.status === 'warn') warn = true;
    }
    return { status: findings.length ? 'fail' : warn ? 'warn' : 'pass', findings, notChecked };
  },

  async page(check, ctx) {
    const m = check.def.match;
    const ok = statusList(m.status, null);
    const statusOk = s => ok ? ok.includes(s) : s >= 200 && s < 400;
    if (ctx.page && ctx.baseUrl) {
      const url = sameSiteUrl(ctx.baseUrl, m.path);
      let resp, err;
      try { resp = await ctx.page.goto(url, { waitUntil: 'load', timeout: ctx.timeoutMs || 15000 }); } catch (e) { err = e; }
      const status = resp ? resp.status() : 0;
      if (!err && featureMissing(check, status)) return featureSkip(check, m.path, status);
      const problems = [];
      if (err) problems.push(`navigation failed: ${String(err.message || err).split('\n')[0].slice(0, 200)}`);
      else if (!statusOk(status)) problems.push(`status ${status}`);
      if (!err && m.selector && !(await ctx.page.$(m.selector).catch(() => null))) problems.push(`no element matches ${m.selector}`);
      if (!err && m.regex) {
        const html = await ctx.page.content().catch(() => '');
        const b = bodyMatches(check.def, html);
        if (b.timedOut) return { status: 'warn', findings: [], notChecked: [{ what: `${check.name}: content pattern`, why: 'The add-on pattern hit the regex time limit.' }] };
        if (!b.ok) problems.push('expected content not found');
      }
      if (!problems.length) return { status: 'pass', findings: [], notChecked: [] };
      const evidence = { request: `GET ${m.path}`, response: problems.join('; ') };
      if (m.selector) evidence.selector = m.selector;
      if (ctx.shot) { try { const s = await ctx.shot(check.id.replace(/[^a-z0-9-]/g, '-')); if (s) evidence.shot = s; } catch { /* no shot */ } }
      return { status: 'fail', findings: [finding(check, 1, evidence, { confidence: 'proven' })], notChecked: [] };
    }
    if (!ctx.baseUrl) return skip(check, 'page not loaded', 'The target is not a URL.');
    // No browser: plain GET, status + content only.
    const r = await httpProbe(ctx, ctx.baseUrl, { match: { path: m.path, regex: m.regex } });
    if (featureMissing(check, r.status)) return featureSkip(check, m.path, r.status);
    const problems = [];
    if (!statusOk(r.status)) problems.push(`status ${r.status}`);
    if (m.regex && statusOk(r.status)) { const b = bodyMatches(check.def, r.body); if (b.timedOut) problems.push('content pattern timed out'); else if (!b.ok) problems.push('expected content not found'); }
    const notChecked = m.selector ? [{ what: `${check.name}: element ${m.selector}`, why: 'No browser was available, so only the raw HTML was checked.' }] : [];
    if (!problems.length) return { status: 'pass', findings: [], notChecked };
    return { status: 'fail', findings: [finding(check, 1, { request: `GET ${m.path}`, response: problems.join('; ') }, { confidence: 'likely' })], notChecked };
  },

  async dom(check, ctx) {
    if (!ctx.page || !ctx.baseUrl) return skip(check, 'DOM check not run', 'No browser session was available for this target.');
    const m = check.def.match;
    const p = m.path || '/';
    let resp;
    try { resp = await ctx.page.goto(sameSiteUrl(ctx.baseUrl, p), { waitUntil: 'load', timeout: ctx.timeoutMs || 15000 }); }
    catch (e) { return skip(check, `DOM check on ${p}`, `The page did not load: ${String(e.message || e).split('\n')[0].slice(0, 200)}`); }
    if (resp && featureMissing(check, resp.status())) return featureSkip(check, p, resp.status());
    const count = await ctx.page.$$eval(m.selector, els => els.length).catch(() => -1);
    if (count < 0) return skip(check, `DOM check on ${p}`, `The selector could not be evaluated: ${m.selector.slice(0, 200)}`);
    if (!count) return { status: 'pass', findings: [], notChecked: [] };
    const evidence = { selector: m.selector, request: `GET ${p}`, response: `${count} matching element(s)` };
    if (ctx.shot) { try { const s = await ctx.shot(check.id.replace(/[^a-z0-9-]/g, '-')); if (s) evidence.shot = s; } catch { /* no shot */ } }
    return { status: 'fail', findings: [finding(check, 1, evidence, { confidence: 'proven' })], notChecked: [] };
  },

  async axe(check, ctx) {
    if (!ctx.page || !ctx.baseUrl) return skip(check, 'accessibility rules not run', 'No browser session was available for this target.');
    const m = check.def.match;
    const p = m.path || '/';
    let resp;
    try { resp = await ctx.page.goto(sameSiteUrl(ctx.baseUrl, p), { waitUntil: 'load', timeout: ctx.timeoutMs || 15000 }); }
    catch (e) { return skip(check, `axe on ${p}`,`The page did not load: ${String(e.message || e).split('\n')[0].slice(0, 200)}`); }
    if (resp && featureMissing(check, resp.status())) return featureSkip(check, p, resp.status());
    let results;
    try { results = ctx.runAxe ? await ctx.runAxe(ctx.page, { include: m.selector }) : await injectAxe(ctx.page, m.selector); }
    catch (e) { return skip(check, `axe on ${p}`, `axe-core failed: ${String(e.message || e).slice(0, 200)}`); }
    let violations = (results && results.violations) || [];
    if (m.regex) {
      const { source, flags } = compileRegex(m.regex);
      violations = violations.filter(v => safeMatchAll(source, flags, String(v.id), { timeoutMs: 50, max: 1 }).matches.length);
    }
    if (!violations.length) return { status: 'pass', findings: [], notChecked: [] };
    const findings = violations.slice(0, MAX_FINDINGS_PER_CHECK).map((v, i) => finding(check, i + 1, {
      selector: String(((v.nodes || [])[0]?.target || []).join(' ') || m.selector || 'html').slice(0, 1000),
      request: `GET ${p}`,
      response: `axe ${v.id}: ${(v.nodes || []).length} node(s)`.slice(0, 4000),
    }, { title: `${check.name} (${v.id})`.slice(0, 300), confidence: 'likely' }));
    return { status: 'fail', findings, notChecked: [] };
  },
};

async function injectAxe(page, include) {
  const require = createRequire(import.meta.url);
  await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
  return page.evaluate(async inc => window.axe.run(inc ? { include: [inc] } : document, { resultTypes: ['violations'] }), include || null);
}

function probeResult(check, r, n = 1) {
  const m = check.def.match;
  const bad = statusList(m.status, [200]);
  if (!bad.includes(r.status)) return { status: 'pass', findings: [], notChecked: [] };
  const b = bodyMatches(check.def, r.body);
  if (b.timedOut) return { status: 'warn', findings: [], notChecked: [{ what: `${check.name}: response pattern`, why: 'The add-on pattern hit the regex time limit.' }] };
  if (!b.ok) return { status: 'pass', findings: [], notChecked: [] };
  const host = new URL(r.url).host;
  return {
    status: 'fail',
    findings: [finding(check, n, {
      request: `${r.method} ${host}${m.path}`.slice(0, 4000),
      response: `${r.status} ${r.statusText}`.trim() + (m.regex ? ', body matched the pack pattern' : '') + ' (body not stored)',
    }, { confidence: 'proven' })],
    notChecked: [],
  };
}

const NEEDS = { page: ['browser|http'], dom: ['browser'], axe: ['browser'], 'secret-pattern': ['files'], http: ['http'], 'rules-probe': ['rules'] };

// Pure conversion: pack -> engine checks. The pack must already have passed checkPack().
export function packToChecks(pack) {
  return (pack.checks || []).map(def => {
    const check = {
      id: reportId('addon', pack.id, def.id),
      name: def.title,
      kind: def.kind,
      severity: def.severity,
      needs: NEEDS[def.kind],
      source: { type: 'addon', pack: pack.id, version: pack.version },
      def,
    };
    check.run = async (ctx = {}) => {
      try { return await runners[def.kind](check, ctx); }
      catch (e) { return skip(check, 'add-on check errored', String(e && e.message || e).slice(0, 300)); }
    };
    return check;
  });
}

// Pack human checks -> report.json humanChecks entries (no verdict yet).
export function packToHumanChecks(pack) {
  return (pack.humanChecks || []).map(h => ({ id: reportId('addon', pack.id, h.id), prompt: h.prompt, steps: [...h.steps] }));
}
