#!/usr/bin/env node
// Anvil - the automatic checks for one PR (docs/ARCHITECTURE.md). Facts only: tests, build, CI, and what the app under
// test + headless Chrome report. Reads <data_dir>/pr-<n>/plan.json, rewrites results.json after every check,
// screenshots to <data_dir>/pr-<n>/shots/, JSON lines on stdout (progress, log, shot, done). Never checks out, commits
// or pushes. Stops cleanly on SIGINT/SIGTERM or when <data_dir>/pr-<n>/stop appears (Windows cannot signal children).
//   anvil-run --pr <n> [--config <file>] [--root <repo>] [--only=<id prefix>[,<prefix>]] [--skip-tests] [--test-filter=<f>]
// Project details come from anvil.config.json; a check whose config section is missing is skipped with a clear detail.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { configFromArgs, resolveRoot, argValue, fillCommand, fill, pageRegex, sampleRegex, roleForPage, pagePath, repoSlug, startHint, ConfigError, CONFIG_FILE } from './config.mjs';
import { readJSON, writeJSON, launch, makeLib, DEVICES, measureWidth } from './lib.mjs';

const argv = process.argv.slice(2);
const opt = k => argValue(argv, k);
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const PR = String(opt('pr') ?? '');
if (!/^\d+$/.test(PR)) { console.error('usage: anvil-run --pr <n> [--config <file>] [--root <repo>] [--only=<id prefix>] [--skip-tests] [--test-filter=<f>]'); process.exit(2); }
let cfg;
try { cfg = configFromArgs(argv); } catch (e) { if (!(e instanceof ConfigError)) throw e; emit({ type: 'error', message: e.message }); console.error('anvil-run: ' + e.message); process.exit(2); }
const ROOT = resolveRoot({ root: typeof opt('root') === 'string' ? opt('root') : null, configFile: cfg._file });
const L = makeLib(cfg, ROOT);
const { ORIGIN, ROLES } = L;
const ONLY = typeof opt('only') === 'string' ? opt('only').split(',').map(s => s.trim()).filter(Boolean) : [];
const SKIP_TESTS = !!opt('skip-tests');
const TEST_FILTER = typeof opt('test-filter') === 'string' ? opt('test-filter') : '';
const DIR = L.QA_DIR(PR), RES = path.join(DIR, 'results.json'), SHOTS = path.join(DIR, 'shots');
const REPO = repoSlug(cfg, ROOT);
const T = cfg.tests, B = cfg.build, FL = cfg.flags;
const COMPARE = (T && T.compare_ref) || 'origin/main';
const COMPARE_NAME = COMPARE.replace(/^origin\//, '');
const now = () => new Date().toISOString();
const msg = e => String(e && e.message || e).replace(/\s+/g, ' ').slice(0, 300);
const want = id => !ONLY.length || ONLY.some(p => id.startsWith(p));
const fail = (m) => { emit({ type: 'error', message: m }); console.error('anvil-run: ' + m); process.exit(2); };
const noSection = k => `not configured (no "${k}" section in ${CONFIG_FILE})`;
const rel = p => path.relative(ROOT, p).split(path.sep).join('/') || '.';

// ---------------------------------------------------------------- plan
const plan = await readJSON(path.join(DIR, 'plan.json'));
if (!plan) fail((fs.existsSync(path.join(DIR, 'plan.json')) ? 'not valid JSON: ' : 'no ') + path.join(DIR, 'plan.json'));
const RE_PAGE = pageRegex(cfg), RE_ID = /^[A-Za-z0-9_-]{1,40}$/, RE_FLAG = new RegExp((FL && FL.flag_pattern) || '^[A-Za-z0-9_.-]{1,80}$');
const bad = [];
for (const p of plan.pages || []) { if (!RE_PAGE.test(p.page || '') || String(p.page || '').includes('..')) bad.push('pages: bad page ' + p.page); for (const r of p.roles || []) if (!ROLES.includes(r)) bad.push('pages: bad role ' + r); }
for (const a of plan.access || []) if (!RE_ID.test(a.id || '') || !(ROLES.includes(a.as) || a.as === 'anon') || typeof a.path !== 'string' || ![].concat(a.expect).every(Number.isInteger)) bad.push('access: bad entry ' + JSON.stringify(a).slice(0, 120));
for (const f of plan.flags || []) if (!RE_ID.test(f.id || '') || !RE_FLAG.test(f.flag || '') || !ROLES.includes(f.as) || typeof f.path !== 'string') bad.push('flags: bad entry ' + JSON.stringify(f).slice(0, 120));
if (bad.length) fail('plan.json: ' + bad.join('; '));

// ---------------------------------------------------------------- results + check bookkeeping
const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', windowsHide: true });
const prev = ONLY.length ? await readJSON(RES) : null;
const results = { pr: Number(PR), commit: plan.commit || (git('rev-parse', '--short', 'HEAD').stdout || '').trim() || null, started: now(), finished: null, running: true,
  stopped: null, current: null, checks: prev && Array.isArray(prev.checks) ? prev.checks : [], shots: prev && Array.isArray(prev.shots) ? prev.shots : [] };
const byId = id => results.checks.find(c => c.id === id);
let done = 0, total = 0, saving = Promise.resolve();
const save = () => (saving = saving.then(() => writeJSON(RES, results)).catch(e => console.error('anvil-run: write failed: ' + msg(e))));
const log = (id, text) => emit({ type: 'log', id, text: String(text).slice(0, 500), at: now() });
function add(id, group, name, area) {
  let c = byId(id);
  const fresh = { id, group, name, status: 'pending', detail: '', area, blocker: false, shots: [], ms: 0 };
  if (c) Object.assign(c, fresh); else results.checks.push(c = fresh);
  total++;
  return c;
}
function start(c, current = true) {
  c.status = 'running'; c.detail = ''; c.blocker = false; c._t = Date.now();
  if (current) results.current = { id: c.id, label: c.name, started: now() };
  emit({ type: 'progress', id: c.id, label: c.name, done, total });
}
async function finish(c, r) {
  Object.assign(c, r); c.ms = Date.now() - (c._t || Date.now()); delete c._t; done++;
  if (results.current && results.current.id === c.id) results.current = null;
  await save();
}
// a step whose child process was killed by a stop is `stopped`, not a result; then the run ends
async function run(c, fn) {
  start(c); await save(); let r;
  try { r = await fn(c); } catch (e) { r = { status: 'warn', detail: 'check could not run: ' + msg(e), blocker: false }; }
  if (STOP && aborted) r = { status: 'stopped', detail: 'stopped by the tester', blocker: false };
  await finish(c, r);
  if (STOP) await halt();
}
function addShot(file, page, role, device, id) {
  const r = 'shots/' + file;
  results.shots = results.shots.filter(s => s.file !== r);
  results.shots.push({ file: r, page, role, device, source: 'auto', at: now() });
  emit({ type: 'shot', id, file: r });
  return r;
}

// ---------------------------------------------------------------- stop: <data_dir>/pr-<n>/stop file (Windows cannot signal node children) or SIGINT/SIGTERM
const STOP_FILE = path.join(DIR, 'stop');
try { fs.rmSync(STOP_FILE, { force: true }); } catch {}   // a stale stop file from an earlier run must not stop this one
let STOP = false, aborted = false, halting = false, worktree = null, browser = null;
function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} }
}
function requestStop(why) {
  if (STOP) return;
  STOP = true; log(results.current ? results.current.id : '', 'stop requested (' + why + '): stopping after the current step');
  if (child) { aborted = true; killTree(child); }   // tests/build/git/gh: abort now, their children too
  setTimeout(() => halt(), 15000).unref();          // safety net if a browser step hangs
}
const stopPoll = setInterval(() => { if (fs.existsSync(STOP_FILE)) requestStop('stop file'); }, 300);
process.on('SIGINT', () => requestStop('SIGINT')); process.on('SIGTERM', () => requestStop('SIGTERM'));
// end the run now: running check -> stopped, untouched -> pending, temp worktree removed, results consistent
async function halt() {
  if (halting) return new Promise(() => {}); halting = true;
  clearInterval(stopPoll);
  if (child) killTree(child);
  for (const c of results.checks) {
    if (c.status === 'running') Object.assign(c, { status: 'stopped', detail: 'stopped by the tester', blocker: false, ms: Date.now() - (c._t || Date.now()) });
    delete c._t;
  }
  if (worktree) { spawnSync('git', ['worktree', 'remove', '--force', worktree], { cwd: ROOT, windowsHide: true }); if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true }); spawnSync('git', ['worktree', 'prune'], { cwd: ROOT, windowsHide: true }); }
  Object.assign(results, { running: false, current: null, stopped: now(), finished: now() });
  await save();
  log('', 'stopped: ' + results.checks.filter(c => c.status === 'stopped').length + ' stopped, ' + results.checks.filter(c => c.status === 'pending').length + ' not started');
  if (browser) await Promise.race([browser.close().catch(() => {}), new Promise(r => setTimeout(r, 3000))]);
  emit({ type: 'done', stopped: true });
  process.exit(0);
}

// child processes (tests/build/git/gh/flag tool), output captured, never inherited (stdout is the progress channel); onLine streams it
let child = null;
function sh(cmd, args, { cwd = ROOT, timeout = 600000, env, onLine, force, shell = false } = {}) {
  if (STOP && !force) return Promise.resolve({ code: -1, out: 'stopped', killed: true });
  return new Promise(resolve => {
    let out = '', killed = false, buf = '';
    let p;
    try { p = child = spawn(cmd, args, { cwd, env: env || process.env, windowsHide: true, shell, detached: process.platform !== 'win32' }); }
    catch (e) { child = null; return resolve({ code: -1, out: msg(e), killed }); }
    const t = setTimeout(() => { killed = true; killTree(p); }, timeout);
    const take = d => { out += d; if (!onLine) return; buf += d; const ls = buf.split(/\r?\n/); buf = ls.pop(); for (const l of ls) if (l.trim()) onLine(l); };
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', e => { clearTimeout(t); child = null; resolve({ code: -1, out: out + '\n' + msg(e), killed }); });
    p.on('close', code => { clearTimeout(t); child = null; if (onLine && buf.trim()) onLine(buf); resolve({ code, out: out.replace(/\r/g, ''), killed }); });
  });
}
const shCmd = (command, vars, o) => { const c = fillCommand(command, vars); return sh(c.cmd, c.args, { ...o, shell: c.shell }); };
const cmdText = (command, vars) => { const c = fillCommand(command, vars); return [c.cmd, ...c.args].join(' ').split(ROOT).join('.'); };
const lastLine = s => (s.trim().split('\n').filter(l => l.trim()).pop() || '').trim().slice(0, 200);
const cmdEnv = (sec, vars) => {
  const env = { ...process.env };
  for (const [k, v] of Object.entries((sec && sec.env) || {})) { const s = fill(v, vars); env[k] = /\{(tmp|root|build|qa)\}/.test(v) ? path.normalize(s) : s; }
  for (const k of (sec && sec.unset_env) || []) delete env[k];
  return env;
};

// ---------------------------------------------------------------- the checks this run will do
const pages = (plan.pages || []).flatMap(p => (p.roles && p.roles.length ? p.roles : [roleForPage(cfg, p.page)]).map(role => ({ rel: p.page, role })));
const key = r => r.replace(/\//g, '-');
const label = (role, r) => role[0].toUpperCase() + role.slice(1) + ' · ' + r.split('/').pop();
const C = { visits: [], access: [], flags: [], tests: [] };
if (want('A5')) C.a5 = add('A5', 'Build', (B && B.name) || 'Build', 'stability');
const xDone = new Set();
for (const v of pages) {
  const ids = { P: 'P-' + key(v.rel) + '-' + v.role, L: 'L-' + key(v.rel) + '-' + v.role, X: 'X-' + key(v.rel) };
  const vis = { ...v };
  if (want(ids.P)) vis.P = add(ids.P, 'Pages', label(v.role, v.rel), 'works');
  if (want(ids.L)) vis.L = add(ids.L, 'Layout', label(v.role, v.rel) + ' · phone width', 'phone');
  if (!xDone.has(v.rel) && want(ids.X)) { xDone.add(v.rel); vis.X = add(ids.X, 'Accessibility', v.rel.split('/').pop() + ' · names and labels', 'laptop'); }
  if (vis.P || vis.L || vis.X) C.visits.push(vis);
}
for (const a of plan.access || []) if (want('R-' + a.id)) C.access.push([a, add('R-' + a.id, 'Roles', a.name || (a.as + ' ' + (a.method || 'GET') + ' ' + a.path), 'roles')]);
for (const f of plan.flags || []) if (want('F-' + f.id)) C.flags.push([f, add('F-' + f.id, 'Flags', (f.flag + ' off/on · ' + f.as + ' GET ' + f.path), 'works')]);
if (want('A4')) C.a4 = add('A4', 'CI', 'CI checks', 'stability');
if (want('A1')) C.a1 = add('A1', 'Tests', 'Test suite', 'stability');
// A2/A3 on their own (re-run one file): only when --only names them and the earlier run created them
const reruns = ONLY.length && !C.a1 ? results.checks.filter(c => /^A[23]-/.test(c.id) && want(c.id)) : [];
for (const c of reruns) add(c.id, c.group, c.name, c.area);
if (!total) { emit({ type: 'error', message: 'no check matches --only=' + ONLY.join(',') }); results.running = false; results.finished = now(); await save(); emit({ type: 'done' }); process.exit(0); }
await save();

// ---------------------------------------------------------------- A5 build (into <data_dir>/pr-<n>/build: tracked output folders are never rewritten)
const BUILD_DIR = path.join(DIR, 'build');
if (C.a5) await run(C.a5, async () => {
  if (!B) return { status: 'skip', detail: 'build ' + noSection('build') };
  const vars = { root: ROOT, build: BUILD_DIR, qa: DIR, pr: PR };
  log('A5', cmdText(B.command, vars));
  const r = await shCmd(B.command, vars, { timeout: (B.timeout_minutes || 10) * 60000, env: cmdEnv(B, vars) });
  for (const l of r.out.trim().split('\n').filter(l => l.trim()).slice(-5)) log('A5', l.trim());
  let line = lastLine(r.out);
  if (B.detail_replace && B.detail_replace.pattern) line = line.replace(new RegExp(B.detail_replace.pattern), B.detail_replace.with ?? '');
  return r.code === 0 ? { status: 'pass', detail: line || 'build finished' } : { status: 'fail', blocker: true, detail: 'build failed (exit ' + r.code + '): ' + lastLine(r.out) };
});

// ---------------------------------------------------------------- browser checks
const browserNeeded = C.visits.length || C.access.length || C.flags.length;
const up = browserNeeded ? await L.appUp() : { ok: true };
const downMsg = `${cfg.name} not running at ${ORIGIN} (${up.message}): ${startHint(cfg)}`;
const ctxs = new Map();
async function ctxFor(role, device) {
  const k = role + '/' + device;
  if (!ctxs.has(k)) ctxs.set(k, L.roleContext(browser, role, device));
  return ctxs.get(k);
}
// GET <api_base><route> from a same-origin page of a context signed in as <role> (so the session cookie applies)
const API_STRIP = new RegExp('^' + String(cfg.app.api_base).replace(/^\/+/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
async function apiGet(role, route) {
  route = String(route).replace(/^\/+/, '').replace(API_STRIP, '');
  if (route.includes('..') || /^[a-z]+:/i.test(route)) throw new Error('bad path ' + route);
  const ctx = await ctxFor(role, 'laptop');
  const p = await ctx.newPage();
  try {
    await p.goto(ORIGIN + L.CONTEXT_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
    return await p.evaluate(async url => {
      const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
      let code = ''; try { const j = await r.json(); code = (j && j.error) || ''; } catch {}
      return { status: r.status, code: typeof code === 'string' ? code : '' };
    }, L.API_BASE + route);
  } finally { await p.close().catch(() => {}); }
}
const req = createRequire(import.meta.url);
const AXE_RULES = ['image-alt', 'input-image-alt', 'button-name', 'link-name', 'label', 'select-name'];
const SAMPLE = sampleRegex(cfg);

if (browserNeeded && !up.ok) {
  for (const v of C.visits) for (const c of [v.P, v.L, v.X].filter(Boolean)) { start(c); await finish(c, { status: 'skip', detail: downMsg }); }
  for (const [, c] of [...C.access, ...C.flags]) { start(c); await finish(c, { status: 'skip', detail: downMsg }); }
} else if (browserNeeded) {
  browser = await launch();
  const fresh = B && B.manifest && !(B.app_dir_env && process.env[B.app_dir_env]) ? await readJSON(path.join(BUILD_DIR, B.manifest)) : null;   // A5's fresh build first
  const built = (fresh && (B.manifest_key ? fresh[B.manifest_key] : fresh)) || L.manifestPages();
  const axeSrc = C.visits.some(v => v.X) ? fs.readFileSync(req.resolve('axe-core/axe.min.js'), 'utf8') : '';
  for (const v of C.visits) {
    if (STOP) await halt();
    const own = [v.P, v.L, v.X].filter(Boolean), vid = own[0].id;
    own.forEach((c, i) => start(c, i === 0)); await save();
    if (built && !built[v.rel]) {
      if (v.P) await finish(v.P, { status: 'fail', blocker: true, detail: v.rel + ' is not in the build (' + B.manifest + ')' });
      for (const c of [v.L, v.X].filter(Boolean)) await finish(c, { status: 'skip', detail: 'page is not in the build' });
      continue;
    }
    const wantPath = pagePath(cfg, v.rel).split(/[?#]/)[0];
    const seen = {};
    for (const device of ['phone', 'laptop']) {
      if (STOP) await halt();
      const s = seen[device] = { problems: [], hard: [], warn: [] };
      const what = `${v.rel} as ${v.role} on ${device}`, t0 = Date.now();
      log(vid, what + ': loading');
      let page;
      try {
        const ctx = await ctxFor(v.role, device);
        page = await ctx.newPage();
        const w = L.watch(page);
        const { response, final } = await L.openPage(page, v.rel);
        if (response && response.status() >= 400) s.hard.push('HTTP ' + response.status());
        if (!final.split(/[?#]/)[0].endsWith(wantPath)) s.hard.push('redirected to ' + final);
        const text = await page.evaluate(() => document.body ? document.body.innerText : '');
        const sample = SAMPLE ? (text.match(SAMPLE) || [])[0] : null;
        const file = L.shotName(v.rel, v.role, device);
        fs.mkdirSync(SHOTS, { recursive: true });
        await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
        s.shot = addShot(file, v.rel, v.role, device, vid);
        if (device === 'phone' && v.L) s.scroll = await measureWidth(page, DEVICES.phone.width);
        if (device === 'laptop' && v.X) {
          await page.evaluate(axeSrc);   // evaluate is not subject to the page's CSP (an injected <script> would be)
          s.axe = await page.evaluate(rules => window.axe.run(document, { runOnly: { type: 'rule', values: rules }, resultTypes: ['violations'] })
            .then(r => r.violations.map(x => ({ id: x.id, n: x.nodes.length, first: (x.nodes[0] && x.nodes[0].target || []).join(' ') }))), AXE_RULES);
        }
        s.hard.push(...w.uncaught.map(e => 'uncaught: ' + e));
        s.problems.push(...w.errors.map(e => 'console: ' + e), ...w.csp.map(e => 'CSP: ' + e), ...[...new Set(w.api)].map(e => 'API ' + e));
        if (sample) s.warn.push('sample name still shown: ' + sample);
      } catch (e) { s.hard.push('load: ' + msg(e)); s.failed = true; }
      finally { if (page) await page.close().catch(() => {}); }
      const n = s.hard.length + s.problems.length;
      log(vid, `${what}: ${s.failed ? 'did not load' : 'loaded'} in ${((Date.now() - t0) / 1000).toFixed(1)} s, ${n} error${n === 1 ? '' : 's'}` + (n ? ' (' + [...s.hard, ...s.problems][0].slice(0, 160) + ')' : '') + (s.warn.length ? ', ' + s.warn[0] : ''));
    }
    if (STOP) await halt();
    const shots = ['phone', 'laptop'].map(d => seen[d].shot).filter(Boolean);
    if (v.P) {
      const tag = (d, l) => l.map(x => d + ': ' + x);
      const hard = [...tag('phone', seen.phone.hard), ...tag('laptop', seen.laptop.hard)];
      const soft = [...new Set([...seen.phone.problems, ...seen.laptop.problems])];
      const warn = [...new Set([...seen.phone.warn, ...seen.laptop.warn])];
      await finish(v.P, hard.length ? { status: 'fail', blocker: true, detail: [...hard, ...soft].join(' | ').slice(0, 900), shots }
        : soft.length ? { status: 'fail', blocker: false, detail: soft.join(' | ').slice(0, 900), shots }
        : warn.length ? { status: 'warn', detail: warn.join(' | '), shots }
        : { status: 'pass', detail: 'loads on phone and laptop: no uncaught errors, console errors, CSP blocks or failed API calls', shots });
    }
    if (v.L) {
      const sc = seen.phone.hard.length ? null : seen.phone.scroll;
      await finish(v.L, !sc ? { status: 'skip', detail: 'page did not load on the phone' + (seen.phone.hard[0] ? ' (' + seen.phone.hard[0] + ')' : ''), shots: seen.phone.shot ? [seen.phone.shot] : [] }
        : sc.sw > sc.iw + 1 ? { status: 'warn', detail: `page is ${sc.sw} px wide on a ${sc.iw} px phone (scrolls sideways)` + (sc.outer.length ? '; wider than the screen: ' + sc.outer.join(', ') : ''), shots: [seen.phone.shot] }
        : { status: 'pass', detail: `fits ${sc.iw} px, no sideways scroll`, shots: [seen.phone.shot] });
    }
    if (v.X) {
      const ax = seen.laptop.hard.length ? null : seen.laptop.axe;
      await finish(v.X, !ax ? { status: 'skip', detail: 'page did not load on the laptop' + (seen.laptop.hard[0] ? ' (' + seen.laptop.hard[0] + ')' : '') }
        : ax.length ? { status: 'warn', detail: ax.map(x => `${x.id}: ${x.n}` + (x.first ? ` (first: ${x.first.slice(0, 80)})` : '')).join(' | '), shots: seen.laptop.shot ? [seen.laptop.shot] : [] }
        : { status: 'pass', detail: 'axe: no ' + AXE_RULES.join(', ') + ' violations', shots: seen.laptop.shot ? [seen.laptop.shot] : [] });
      log(vid, 'axe on laptop: ' + v.X.status + (v.X.status === 'warn' ? ' (' + v.X.detail.slice(0, 160) + ')' : ''));
    }
    results.current = null;
  }

  // R-<id>: role/access
  for (const [a, c] of C.access) await run(c, async () => {
    const method = String(a.method || 'GET').toUpperCase();
    if (method !== 'GET') return { status: 'skip', detail: method + ' is not sent automatically (it would change test data): check it by hand' };
    const expect = [].concat(a.expect);
    log(c.id, `${a.as} GET ${L.API_BASE}${a.path}`);
    const r = await apiGet(a.as, a.path);
    const got = r.status + (r.code ? ' ' + r.code : '');
    log(c.id, `-> ${got} (expected ${expect.join(' or ')})`);
    return expect.includes(r.status) ? { status: 'pass', detail: `${a.as} GET ${a.path}: got ${got} (expected ${expect.join(' or ')})` }
      : { status: 'fail', blocker: true, detail: `${a.as} GET ${a.path}: got ${got}, expected ${expect.join(' or ')}` };
  });

  // F-<id>: flag off -> the route answers flags.off_expect (default 404); flag on -> 2xx. The previous flag state is put back.
  const fvars = { root: ROOT, qa: DIR, pr: PR };
  const flagEnv = cmdEnv(FL, fvars);
  const listRe = FL && FL.list_regex ? new RegExp(FL.list_regex, 'm') : null;
  const onArgs = (FL && FL.on_args) || ['--on={flag}'], offArgs = (FL && FL.off_args) || ['--off={flag}'];
  // force: the restore runs even after a stop
  const flagTool = async (id, args, flag, force = false) => {
    const base = fillCommand(FL.command, fvars);
    const extra = (args || []).map(a => fill(a, { ...fvars, flag })).filter(Boolean);
    log(id, [base.cmd, ...base.args, ...extra].join(' ').split(ROOT).join('.'));
    const r = base.shell ? await sh([base.cmd, ...extra].join(' '), [], { env: flagEnv, timeout: 60000, shell: true, force }) : await sh(base.cmd, [...base.args, ...extra], { env: flagEnv, timeout: 60000, force });
    if (r.out.trim()) log(id, lastLine(r.out));
    if (r.code !== 0) throw new Error('flag tool: ' + lastLine(r.out));
    if (!listRe) return [];
    const m = r.out.match(listRe);
    return m ? (FL.none_text && m[1].trim() === FL.none_text ? [] : m[1].trim().split(/\s+/).filter(Boolean)) : [];
  };
  const offExp = (FL && FL.off_expect) || { status: 404 };
  for (const [f, c] of C.flags) await run(c, async () => {
    if (!FL) return { status: 'skip', detail: 'flag check ' + noSection('flags') };
    if (FL.requires && !fs.existsSync(path.resolve(ROOT, FL.requires))) return { status: 'skip', detail: FL.missing_detail || `flag tool not available (${FL.requires} is missing)` };
    const before = listRe ? await flagTool(c.id, FL.list_args || []) : null;
    try {
      await flagTool(c.id, offArgs, f.flag);
      const off = await apiGet(f.as, f.path);
      log(c.id, `flag off: ${f.as} GET ${f.path} -> ${off.status} ${off.code}`);
      await flagTool(c.id, onArgs, f.flag);
      const on = await apiGet(f.as, f.path);
      log(c.id, `flag on: ${f.as} GET ${f.path} -> ${on.status} ${on.code}`);
      const ok = off.status === offExp.status && (!offExp.code || off.code === offExp.code) && on.status >= 200 && on.status < 300;
      const d = `${f.as} GET ${f.path}: off -> ${off.status}${off.code ? ' ' + off.code : ''}, on -> ${on.status}${on.code ? ' ' + on.code : ''}`;
      return ok ? { status: 'pass', detail: d } : { status: 'fail', blocker: true, detail: d + ` (expected off ${offExp.status}${offExp.code ? ' ' + offExp.code : ''}, on 2xx)` };
    } finally { if (before) await flagTool(c.id, before.includes(f.flag) ? onArgs : offArgs, f.flag, true).catch(() => {}); }
  });
}
if (browser) await browser.close().catch(() => {});

// ---------------------------------------------------------------- A4 CI (read-only)
if (C.a4) await run(C.a4, async () => {
  if (!Number(PR)) return { status: 'skip', detail: 'no PR number (pr 0 is a local dry run)' };
  if (!REPO) return { status: 'skip', detail: `no GitHub repo (set github.repo in ${CONFIG_FILE})` };
  const r = await sh('gh', ['pr', 'checks', PR, '-R', REPO, '--json', 'name,bucket,state,link'], { timeout: 60000 });
  let list; try { list = JSON.parse(r.out.slice(r.out.indexOf('['))); } catch { return { status: 'skip', detail: 'gh pr checks: ' + (lastLine(r.out) || 'exit ' + r.code) }; }
  if (!list.length) return { status: 'skip', detail: 'no CI checks reported for this PR' };
  const red = list.filter(x => x.bucket === 'fail' || x.bucket === 'cancel'), wait = list.filter(x => x.bucket === 'pending');
  return red.length ? { status: 'fail', blocker: false, detail: `${red.length} of ${list.length} red: ` + red.map(x => x.name).join(', ') }
    : wait.length ? { status: 'warn', detail: `${wait.length} of ${list.length} still running: ` + wait.map(x => x.name).join(', ') }
    : { status: 'pass', detail: `${list.length} checks green` };
});

// ---------------------------------------------------------------- A1 tests, A2 re-run of failed files, A3 the same files on the compare ref
const canFilter = !!(T && Array.isArray(T.filter_args) && T.filter_args.length);
const OK_LINE = T && T.ok_line_regex ? new RegExp(T.ok_line_regex) : null;
const FAIL_LINE = T && T.fail_line_regex ? new RegExp(T.fail_line_regex) : null;
const LOG_LINE = T && T.log_line_regex ? new RegExp(T.log_line_regex) : null;
// the test command; its output lines streamed as `log` (filtered by tests.log_line_regex), plus a running count every ~5 s
async function testCmd(cwd, filter, id) {
  const extra = filter && canFilter ? T.filter_args : [];
  const command = typeof T.command === 'string' ? [T.command, ...extra].join(' ') : [...T.command, ...extra];
  const vars = { root: cwd, filter, qa: DIR, pr: PR };
  let ok = 0, bad = 0;
  const t0 = Date.now();
  log(id, cmdText(command, vars).split(cwd).join('.') + (cwd !== ROOT ? `  (in a temp worktree of ${COMPARE})` : ''));
  const counting = OK_LINE || FAIL_LINE;
  const tick = setInterval(() => log(id, counting ? `${ok + bad} tests so far, ${bad} failed (${Math.round((Date.now() - t0) / 1000)} s)` : `still running (${Math.round((Date.now() - t0) / 1000)} s)`), 5000);
  try {
    return await shCmd(command, vars, { cwd, timeout: (T.timeout_minutes || 40) * 60000, env: cmdEnv(T, vars), onLine: l => {
      if (OK_LINE && OK_LINE.test(l)) ok++; else if (FAIL_LINE && FAIL_LINE.test(l)) bad++;
      if (!LOG_LINE || LOG_LINE.test(l)) log(id, l.replace(/\s+$/, ''));
    } });
  } finally { clearInterval(tick); }
}
const SUMMARY = T && T.summary_regex ? new RegExp(T.summary_regex, 'm') : null;
// -> { total, failed, secs, files } from the summary line, or null; without summary_regex: from the exit code only
function parseTests(r) {
  if (!SUMMARY) return { total: null, failed: r.code === 0 ? 0 : null, secs: null, files: [], exitOnly: true };
  const m = r.out.match(SUMMARY);
  if (!m) return null;
  const g = m.groups || {};
  const files = g.files ? g.files.split(T.files_separator || ', ').map(s => s.trim()).filter(Boolean) : [];
  return { total: g.total != null ? +g.total : null, failed: g.failed != null ? +g.failed : (r.code === 0 ? 0 : null), secs: g.secs != null ? +g.secs : null, files };
}
const SECTION_END = T && T.file_section_end_regex ? new RegExp(T.file_section_end_regex) : null;
const FAIL_NAME = T && T.fail_name_regex ? T.fail_name_regex : null;
const failNames = (out, file) => {
  if (!FAIL_NAME) return [];
  const i = out.indexOf('\n' + file + '\n');
  const seg = i < 0 ? out : SECTION_END ? out.slice(i + file.length + 2).split(SECTION_END)[0] : out.slice(i + file.length + 2);
  return [...seg.matchAll(new RegExp(FAIL_NAME, 'gm'))].map(x => x[1] || x[0]);
};
async function rerun(file) {   // -> A2 result
  const r = await testCmd(ROOT, file, 'A2-' + file), t = parseTests(r);
  return r.code === 0 && t && (t.failed === 0 || t.exitOnly) ? { status: 'flake', detail: `${file} passed on the re-run` + (t.total != null ? ` (${t.total} tests)` : '') }
    : { status: 'fail', blocker: true, detail: `${file} failed again` + (failNames(r.out, file).length ? ': ' + failNames(r.out, file).join(', ') : t ? '' : ': ' + lastLine(r.out)) };
}
async function onMain(files, checks) {   // A3: temp worktree of the compare ref, removed afterwards; the working tree is not touched
  const sha = (git('rev-parse', '--short', COMPARE).stdout || '').trim();
  if (!sha) { for (const c of checks) await finish(c, { status: 'fail', blocker: true, detail: `${COMPARE} not found locally, could not compare` }); return; }
  if (STOP) await halt();
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-main-pr' + PR + '-'));
  // the config may live in a sub-folder of the git repo: run the tests in the same sub-folder of the worktree
  const top = (git('rev-parse', '--show-toplevel').stdout || '').trim();
  const sub = top ? path.relative(path.resolve(top), ROOT) : '';
  const wroot = sub && !sub.startsWith('..') ? path.join(worktree, sub) : worktree;
  try {
    log(checks[0].id, `git worktree add --detach <temp> ${COMPARE} (${sha})`);
    const add = await sh('git', ['worktree', 'add', '--detach', worktree, COMPARE], { timeout: 300000 });
    if (STOP) await halt();
    if (add.code !== 0) throw new Error('git worktree add: ' + lastLine(add.out));
    for (let i = 0; i < files.length; i++) {
      const c = checks[i], file = files[i];
      if (STOP) await halt();
      start(c); await save();
      if (T.files_dir && !fs.existsSync(path.join(wroot, T.files_dir, file))) { await finish(c, { status: 'fail', blocker: true, detail: `${file} is new in this PR (not on ${COMPARE_NAME} ${sha}) and fails` }); continue; }
      const r = await testCmd(wroot, file, c.id), t = parseTests(r);
      if (STOP && aborted) await halt();   // halt marks this check stopped and removes the worktree
      await finish(c, r.code !== 0 ? { status: 'preexisting', detail: `${file} also fails on ${COMPARE_NAME} ${sha}` + (failNames(r.out, file).length ? ': ' + failNames(r.out, file).join(', ') : '') }
        : { status: 'fail', blocker: true, detail: `${file} passes on ${COMPARE_NAME} ${sha} (${t && t.total != null ? t.total : '?'} tests) but fails on this PR` });
    }
  } catch (e) {
    for (const c of checks) if (c.status === 'pending' || c.status === 'running') await finish(c, { status: 'fail', blocker: true, detail: `could not compare with ${COMPARE_NAME}: ` + msg(e) });
  } finally {
    await sh('git', ['worktree', 'remove', '--force', worktree], { timeout: 120000, force: true });
    if (fs.existsSync(worktree)) fs.rmSync(worktree, { recursive: true, force: true });
    await sh('git', ['worktree', 'prune'], { timeout: 60000, force: true });
    log(checks[0].id, 'temp worktree removed');
    worktree = null;
  }
}
// A1's final status once its failures are explained: still failing -> fail+blocker; only flakes/preexisting -> that status
function settleA1() {
  const a1 = byId('A1');
  if (!a1 || !Array.isArray(a1.files) || !a1.files.length || !a1.base) return;
  const st = a1.files.map(f => { const a2 = byId('A2-' + f), a3 = byId('A3-' + f); return a2 && a2.status === 'flake' ? 'flake' : a3 && a3.status === 'preexisting' ? 'preexisting' : a3 && a3.status === 'fail' ? 'fail' : a2 && a2.status === 'fail' && !a3 ? 'fail' : 'open'; });
  const n = k => st.filter(s => s === k).length;
  Object.assign(a1, st.includes('fail') || st.includes('open') ? { status: 'fail', blocker: true } : { status: n('preexisting') ? 'preexisting' : 'flake', blocker: false });
  a1.detail = a1.base + ` · ${n('flake')} flake, ${n('preexisting')} preexisting, ${n('fail') + n('open')} failing`;
}
if (C.a1) {
  if (SKIP_TESTS) { start(C.a1); await finish(C.a1, { status: 'skip', detail: 'skipped (--skip-tests)' }); }
  else if (!T) { start(C.a1); await finish(C.a1, { status: 'skip', detail: 'test suite ' + noSection('tests') }); }
  else {
    for (const c of results.checks.filter(c => /^A[23]-/.test(c.id))) results.checks.splice(results.checks.indexOf(c), 1);
    let fails = [];
    await run(C.a1, async () => {
      const r = await testCmd(ROOT, TEST_FILTER, 'A1'), t = parseTests(r);
      const where = TEST_FILTER ? ` (filter: ${TEST_FILTER})` : '';
      if (!t) return { status: 'fail', blocker: true, detail: `no summary line (exit ${r.code}${r.killed ? ', timed out' : ''}): ${lastLine(r.out)}` + where };
      if (t.exitOnly) return r.code === 0 ? { status: 'pass', detail: `test command passed (exit 0)${where}: ${lastLine(r.out)}`.slice(0, 300), files: [], base: '' }
        : { status: 'fail', blocker: true, detail: `test command failed (exit ${r.code}${r.killed ? ', timed out' : ''})${where}: ${lastLine(r.out)}`, files: [], base: '' };
      const base = `${t.total ?? '?'} tests, ${t.failed ?? '?'} failed` + (t.secs != null ? `, ${Math.round(t.secs)} s` : '') + (t.files.length ? ' (' + t.files.join(', ') + ')' : '') + where;
      fails = t.files;
      return r.code === 0 && !t.failed && !t.files.length ? { status: 'pass', detail: base, files: [], base }
        : { status: 'fail', blocker: true, detail: base, files: t.files, base };
    });
    if (fails.length && canFilter && T.rerun_failed !== false) {
      const a2 = fails.map(f => add('A2-' + f, 'Tests', 'Re-run ' + f, 'stability'));
      const still = [];
      for (let i = 0; i < fails.length; i++) { await run(a2[i], () => rerun(fails[i])); if (a2[i].status !== 'flake') still.push(fails[i]); }
      if (still.length && T.compare_on_main !== false) await onMain(still, still.map(f => add('A3-' + f, 'Tests', f + ' on ' + COMPARE_NAME, 'stability')));
      settleA1(); await save();
    }
  }
}
for (const c of reruns) {
  const file = c.id.slice(3);
  if (!T || !canFilter) { start(c); await finish(c, { status: 'skip', detail: 'test re-runs need tests.filter_args in ' + CONFIG_FILE }); continue; }
  if (c.id.startsWith('A2-')) await run(c, () => rerun(file));
  else await onMain([file], [c]);
  settleA1(); await save();
}

if (STOP) await halt();
clearInterval(stopPoll);
results.running = false; results.finished = now(); results.current = null;
await save();
emit({ type: 'done' });
process.exit(0);
