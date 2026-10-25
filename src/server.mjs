#!/usr/bin/env node
// Anvil - the local QA server (docs/ARCHITECTURE.md). Plain node:http on 127.0.0.1. Anvil itself lives under /anvil/
// (dashboard, /anvil/api/* JSON + SSE, /anvil/qa/* PR files); EVERY other path is reverse-proxied to the app under
// test so it runs same-origin inside Anvil's Test view (frame-blocking headers stripped, API calls logged to
// state.session.requests - method/path/status/ms only). Runs run.mjs, owns <data_dir>/pr-<n>/state.json.
// Its ONLY outward action is `gh pr comment` on an explicit POST /anvil/api/send (ANVIL_DRY_RUN=1: nothing is posted,
// fake comment URLs). Never commits, pushes or checks out.
//   anvil-server --pr <n> [--config <file>] [--root <repo>]     then open http://127.0.0.1:<port>/anvil/
//   env: ANVIL_PORT, ANVIL_DRY_RUN=1, ANVIL_NO_CLAUDE=1, ANVIL_CLAUDE_BIN, ANVIL_CHROME (QA_* names also accepted)
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import * as report from './report.mjs';
import { configFromArgs, resolveRoot, argValue, origin as originOf, loginPath, repoSlug, dataDir, uiConfig, startHint, commandRegex, passLine, fixLine, isFixBody, envOf, SAFE_PAGE_QS, ConfigError } from './config.mjs';
import { browserPath } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const prArg = argValue(argv, 'pr');
const PR = /^\d{1,6}$/.test(String(prArg || '')) ? +prArg : null;
if (!PR && PR !== 0 || prArg === true) { console.error('usage: anvil-server --pr <n> [--config <file>] [--root <repo>]'); process.exit(2); }
let cfg;
try { cfg = configFromArgs(argv); } catch (e) { if (!(e instanceof ConfigError)) throw e; console.error('anvil-server: ' + e.message); process.exit(2); }
const ROOT = resolveRoot({ root: typeof argValue(argv, 'root') === 'string' ? argValue(argv, 'root') : null, configFile: cfg._file });
const REPO = repoSlug(cfg, ROOT);
const PORT = +(envOf('PORT') || cfg.server.port);
const ORIGIN = originOf(cfg);
const DRY = envOf('DRY_RUN') === '1';
const SELF = `http://127.0.0.1:${PORT}`;
const QA = dataDir(cfg, ROOT, PR);
const DASH = path.resolve(HERE, '..', 'dashboard');
const F = { plan: path.join(QA, 'plan.json'), results: path.join(QA, 'results.json'), state: path.join(QA, 'state.json') };
const ROLES = cfg.roles.list;
const DEVICES = ['phone', 'tablet', 'laptop'];
const API_MATCH = cfg.app.api_match || '/api/';
const CHAT_FILE = `chat-pr${PR}.md`;
const htmlEsc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
fs.mkdirSync(path.join(QA, 'shots'), { recursive: true });

// ---- small helpers ----------------------------------------------------------------------------------------------
const logFile = path.join(QA, 'server.log');
function log(...a) { const s = `${new Date().toISOString()} ${a.join(' ')}`; console.log(s); fs.appendFile(logFile, s + '\n', () => {}); }
// strips a UTF-8 BOM: Windows PowerShell writes one, and plan.json may come from there
async function readJSON(file, fb) { try { return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^ï»¿/, '')); } catch { return fb; } }
let wq = Promise.resolve();                                   // serialise state writes (atomic: tmp + rename)
function writeJSON(file, obj) {
  return (wq = wq.then(async () => {
    const tmp = file + '.' + process.pid + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 1));
    for (let i = 0; ; i++) { try { await fsp.rename(tmp, file); return; } catch (e) { if (i > 5) throw e; await new Promise(r => setTimeout(r, 50)); } }   // Windows: target briefly locked by a reader
  }));
}
const EMPTY_STATE = { manual: {}, include_shots: [], rating: null, note_to_dev: '', completed: false, draft: null, sent: null };
const loadState = async () => {
  const s = await readJSON(F.state, null);
  if (!s && fs.existsSync(F.state)) {                         // unreadable: keep a copy instead of silently starting over
    const keep = F.state + '.bad-' + Date.now(); fs.renameSync(F.state, keep); log('state.json was unreadable, moved to', path.basename(keep));
  }
  return { ...EMPTY_STATE, ...(s || {}) };
};
let sq = Promise.resolve();                                   // read-modify-write of state.json, one at a time
function mutateState(fn) { const p = sq.then(async () => { const s = await loadState(); const r = await fn(s); await writeJSON(F.state, s); return r; }); sq = p.catch(() => {}); return p; }
function run(cmd, args, { timeout = 30000, input } = {}) {
  return new Promise(resolve => {
    const ch = execFile(cmd, args, { cwd: ROOT, timeout, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && err.message }));
    if (input != null) ch.stdin.end(input);
  });
}
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
let libP = null;
async function lib() {
  libP ||= import(pathToFileURL(path.join(HERE, 'lib.mjs')).href).then(m => ({ ...m, ...m.makeLib(cfg, ROOT) }));
  try { return await libP; } catch (e) { libP = null; log('lib.mjs not available:', e.message); return null; }
}

// ---- runner -----------------------------------------------------------------------------------------------------
let child = null, spawnedOnce = false;
async function isRunning() {
  if (child) return true;
  if (spawnedOnce) return false;                              // our runner exited: ignore a stale "running" flag
  const r = await readJSON(F.results, null);                  // a run started outside this server (e.g. by the skill)
  if (!r?.running) return false;
  try { return Date.now() - (await fsp.stat(F.results)).mtimeMs < 15 * 60e3; } catch { return false; }
}
// run log: every runner line as {n, id, text, at, type}; last 2000 in memory, all in <data_dir>/pr-<n>/run.log (JSON lines)
const RUNNER = envOf('RUNNER') ? path.resolve(envOf('RUNNER')) : path.join(HERE, 'run.mjs');   // ANVIL_RUNNER: tests only
const RUNLOG = path.join(QA, 'run.log'), STOPF = path.join(QA, 'stop');
let runLog = [], runN = 0;
try {
  runLog = fs.readFileSync(RUNLOG, 'utf8').split('\n').slice(-2001).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  runN = runLog.length ? runLog[runLog.length - 1].n : 0;
} catch {}
function addLog(type, id, text, extra = {}) {
  const l = { n: ++runN, id: id || null, text: str(String(text ?? ''), 2000), at: new Date().toISOString(), type, ...extra };
  runLog.push(l); if (runLog.length > 2000) runLog = runLog.slice(-2000);
  fs.appendFile(RUNLOG, JSON.stringify(l) + '\n', () => {});
  return l;
}
function onRunnerLine(line) {
  let j; try { j = JSON.parse(line); } catch { j = null; }
  if (!j || typeof j !== 'object') return broadcast('log', addLog('raw', null, line));
  if (j.type === 'log') return broadcast('log', addLog('log', j.id, j.text));
  if (j.type === 'shot') { addLog('shot', j.id, j.file, { file: j.file }); return broadcast('shot', { id: j.id || null, file: j.file, at: j.at || new Date().toISOString() }); }
  if (j.type === 'progress') addLog('progress', j.id, `${j.label || j.id} (${j.done}/${j.total})`);
  else if (j.type === 'error' || j.type === 'done') addLog(j.type, null, j.message || 'done');
  broadcast('progress', j);
}
function startRun(only) {
  fs.rmSync(STOPF, { force: true });                          // a leftover stop file would stop the new run at once
  const args = [RUNNER, '--pr', String(PR), '--config', cfg._file, '--root', ROOT];
  if (only) args.push('--only=' + only);
  // POSIX: own process group so Stop can kill the whole tree; Windows uses taskkill /T instead
  child = spawn(process.execPath, args, { cwd: ROOT, windowsHide: true, env: process.env, detached: process.platform !== 'win32' });
  spawnedOnce = true;
  log('run started', only || '(all)');
  broadcast('log', addLog('run', null, 'Run started' + (only ? ` (only ${only})` : ' (all checks)')));
  const lines = (stream, fn) => { let buf = ''; stream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) fn(l); } }); };
  lines(child.stdout, onRunnerLine);
  lines(child.stderr, l => { fs.appendFile(logFile, 'runner! ' + l + '\n', () => {}); broadcast('log', addLog('stderr', null, l)); });
  const me = child;
  const end = (code) => {
    if (child !== me) return; child = null;
    log('run finished, exit', code); broadcast('log', addLog('run', null, `Run finished (exit ${code})`));
    broadcast('progress', { type: 'exit', code }); pushData();
  };
  child.on('error', e => { log('runner spawn failed:', e.message); end(-1); });
  child.on('exit', end);
}
// Stop: stop file -> wait up to 10 s -> kill the runner tree -> make results.json consistent (no check left "running")
let stopping = null;
async function stopRun() {
  const proc = child, ext = !proc && await isRunning();       // ext: a run started outside the server (pid unknown)
  if (!proc && !ext) return { ok: true, wasRunning: false };
  await fsp.writeFile(STOPF, new Date().toISOString());
  broadcast('log', addLog('run', null, 'Stop requested - finishing the current step'));
  const t0 = Date.now();
  while (Date.now() - t0 < 10e3 && (proc ? child === proc : await isRunning())) await new Promise(r => setTimeout(r, 250));
  let killed = false;
  if (proc && child === proc) {
    killed = true;
    if (process.platform === 'win32') await run('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { timeout: 15000 });
    else { try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} } }
    for (let i = 0; i < 40 && child === proc; i++) await new Promise(r => setTimeout(r, 100));
    if (child === proc) { child = null; pushData(); }          // exit event never came: do not stay "running" forever
  }
  const r = await readJSON(F.results, null);
  if (r && (r.running || (r.checks || []).some(c => c.status === 'running') || r.current)) {
    for (const c of r.checks || []) if (c.status === 'running') { c.status = 'stopped'; c.detail = c.detail || 'stopped by the tester'; }
    r.running = false; r.stopped = r.stopped || new Date().toISOString(); r.current = null;
    if (!r.finished) r.finished = r.stopped;
    await writeJSON(F.results, r);
  }
  fs.rmSync(STOPF, { force: true });
  broadcast('log', addLog('run', null, killed ? 'Stopped (runner did not stop within 10 s and was killed)' : 'Stopped'));
  log('run stopped', killed ? '(killed)' : '(clean)');
  pushData();
  return { ok: true, wasRunning: true, killed };
}

// ---- health / env -------------------------------------------------------------------------------------------------
let health = [], healthAt = 0, healthP = null;
function checkHealth(force) {
  if (!force && Date.now() - healthAt < 30e3) return Promise.resolve(health);
  if (healthP) return healthP;
  return (healthP = (async () => {
    const app = (async () => {
      try {
        const r = await fetch(ORIGIN + (cfg.app.health_path || '/'), { signal: AbortSignal.timeout(3000), redirect: 'manual' });
        return { id: 'app', ok: r.status < 500, message: `${cfg.name} answered ${r.status} at ${ORIGIN}`, fix: r.status < 500 ? '' : `${cfg.name} has an error. Stop it and start it again (see below).` };
      } catch {
        return { id: 'app', ok: false, message: `${cfg.name} is not running at ${ORIGIN}`,
          fix: cfg.app.start_command ? `Open a terminal in the repo folder and run: \`${cfg.app.start_command}\` (or ask Claude to start it).` : `Start ${cfg.name} (or ask Claude to start it), then press Check again.` };
      }
    })();
    const gh = run('gh', ['auth', 'status'], { timeout: 10000 }).then(r => r.code === 0
      ? { id: 'gh', ok: true, message: 'GitHub CLI is signed in', fix: '' }
      : { id: 'gh', ok: false, message: r.error && /ENOENT/.test(r.error) ? 'GitHub CLI (gh) is not installed' : 'GitHub CLI is not signed in',
          fix: r.error && /ENOENT/.test(r.error) ? 'Install the GitHub CLI from https://cli.github.com and restart Anvil.' : 'Run `gh auth login` in a terminal, pick GitHub.com and sign in with your browser.' });
    const exe = browserPath();
    let pw = true; try { createRequire(path.join(HERE, 'x.js')).resolve('playwright-core'); } catch { pw = false; }
    const chrome = { id: 'chrome', ok: !!exe && pw, message: !exe ? 'Chrome or Edge was not found' : pw ? 'Chrome found: ' + exe : 'Chrome found, but the browser helper (playwright-core) is not installed',
      fix: !exe ? 'Install Google Chrome (or set ANVIL_CHROME), then restart Anvil.' : pw ? '' : 'In the Anvil folder run: `npm ci`' };
    const cl = run(envOf('CLAUDE_BIN') || 'claude', ['--version'], { timeout: 15000 }).then(r => r.code === 0
      ? { id: 'claude', ok: true, message: 'Claude CLI ' + r.stdout.trim().split('\n')[0], fix: '' }
      : { id: 'claude', ok: false, message: 'Claude CLI not found - the report will use the plain template', fix: 'Optional: install Claude Code (claude) and sign in; the report still works without it.' });
    health = await Promise.all([app, gh, chrome, cl]); healthAt = Date.now(); healthP = null;
    return health;
  })());
}
function env(plan) {
  const prUrl = plan?.url || (REPO ? `https://github.com/${REPO}/pull/${PR}` : null);
  // role links go through Anvil's proxy (same origin as the test view); add the page for a deep link
  return { origin: ORIGIN, anvilOrigin: SELF, appBase: SELF + uiConfig(cfg, { repo: REPO, pr: PR }).pagePrefix, port: PORT,
    roleLinks: Object.fromEntries(ROLES.map(r => [r, SELF + (loginPath(cfg, r, '') || uiConfig(cfg, { repo: REPO, pr: PR }).pagePrefix)])), prUrl, ciUrl: prUrl ? prUrl + '/checks' : null,
    issueUrl: plan?.issue?.url || null,
    reviewNoteUrl: plan?.review_note && REPO ? `https://github.com/${REPO}/blob/${encodeURIComponent(plan.branch || 'main').replace(/%2F/g, '/')}/${plan.review_note}` : null,
    qaDir: QA, dryRun: DRY, project: uiConfig(cfg, { repo: REPO, pr: PR }) };
}

// ---- data + SSE -------------------------------------------------------------------------------------------------
async function getData() {
  const [plan, results, state] = await Promise.all([readJSON(F.plan, null), readJSON(F.results, null), loadState()]);
  const res = results ? { ...results } : null;
  if (res && state.tool_shots?.length) {                      // shots taken with /api/shot while the runner owned the file
    const have = new Set((res.shots || []).map(s => s.file));
    res.shots = [...(res.shots || []), ...state.tool_shots.filter(s => !have.has(s.file))];
  }
  if (res && child) res.running = true;
  const shown = res ? report.applyOverrides(res, state) : null;     // status = hand-check result, auto_status = runner's
  return { plan, results: shown, state, summary: plan ? report.score(plan, shown, state) : null, env: env(plan), health };
}
const clients = new Set();
function broadcast(event, obj) { const msg = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.write(msg); }
let pushT = null;
function pushData() { clearTimeout(pushT); pushT = setTimeout(async () => { if (clients.size) broadcast('data', await getData()); }, 150); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20e3).unref();
try { fs.watch(QA, (ev, name) => { if (name && /^(results|plan|state)\.json$/.test(String(name))) pushData(); }); } catch (e) { log('watch failed:', e.message); }

// ---- screenshots (lazy lib.mjs) -----------------------------------------------------------------------------------
let browserP = null, browserIdle = null, shotQ = Promise.resolve();
function takeShot(role, page, device) {
  const p = shotQ.then(async () => {
    const L = await lib();
    if (!L) bad('Screenshots need playwright-core (run npm ci in the Anvil folder)', 503);
    clearTimeout(browserIdle);
    browserP = browserP || L.launch();
    const browser = await browserP;
    const file = `shots/tool-${page.replace(/[\/.?=&%]/g, '-')}-${role}-${device}-${Date.now()}.png`;
    const r = await L.screenshot({ browser, role, page, device, out: path.join(QA, file) });
    browserIdle = setTimeout(() => { const b = browserP; browserP = null; b?.then(x => x.close()).catch(() => {}); }, 60e3);
    if (r && r.ok === false) bad('Screenshot failed: ' + (r.error || 'unknown'), 502);
    return file;
  });
  shotQ = p.catch(() => {});
  return p;
}

// ---- PR changed files (read-only gh, for the fix brief's files_hint) ---------------------------------------------
let changed = null;
async function changedFiles() {
  if (changed) return changed;
  if (!REPO) return [];
  const r = await run('gh', ['pr', 'view', String(PR), '-R', REPO, '--json', 'files'], { timeout: 20000 });
  try { changed = JSON.parse(r.stdout).files.map(f => f.path); } catch { return []; }
  return changed;
}

// ---- request handling ---------------------------------------------------------------------------------------------
const LIMIT = { '/api/manual-shot': 12 << 20, '/api/view-shot': 12 << 20, '/api/send': 1 << 20, '/api/session': 1 << 20 };
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SESSION_TYPES = ['navigate', 'console-error', 'page-error', 'api-error', 'device', 'role', 'shot', 'note'];
const sessionOf = s => (s.session = { requests: [], events: [], ...(s.session || {}) });
const okPage = (v, qs = false) => (qs ? SAFE_PAGE_QS : /^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_.\/-]*$/).test(String(v || '')) && String(v).length <= 300;
// tool/view shots: kept in state.tool_shots (the runner rewrites results.json while it runs) + results.json when idle
async function addShot(entry, manualId) {
  await mutateState(s => {
    s.tool_shots = [...(s.tool_shots || []), entry];
    if (manualId) { const cur = s.manual[manualId] || { answer: null, note: '', shots: [] }; s.manual[manualId] = { ...cur, shots: [...(cur.shots || []), entry.file] }; }
  });
  if (!(await isRunning())) {
    const r = await readJSON(F.results, null);
    if (r) { r.shots = [...(r.shots || []), entry]; await writeJSON(F.results, r); }
  }
  pushData();
}

// ---- reverse proxy to the app under test (everything outside /anvil/) ---------------------------------------------
// Host is passed through unchanged, so the app sees Anvil's origin: its same-origin/CSRF checks (Origin vs Host) and
// any absolute URL it builds stay correct. Bodies are streamed, never read or logged.
const APP = new URL(ORIGIN);
const HOP = ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate'];
const stripFrameAncestors = v => [].concat(v).map(pol => pol.split(',').map(p => p.split(';').filter(d => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim()).filter(Boolean).join(', ')).filter(Boolean);
let reqBuf = [], reqT = null;
function logRequest(r) {
  reqBuf.push(r);
  if (reqBuf.length > 500) reqBuf = reqBuf.slice(-500);
  clearTimeout(reqT);
  reqT = setTimeout(() => { const b = reqBuf; reqBuf = []; mutateState(s => { const ses = sessionOf(s); ses.requests = [...ses.requests, ...b].slice(-500); }).catch(e => log('session log failed:', e.message)); }, 1000);
}
function proxy(req, res, u) {
  const t0 = Date.now();
  const headers = { ...req.headers };
  for (const h of HOP) delete headers[h];
  const preq = http.request({ hostname: APP.hostname, port: APP.port || 80, method: req.method, path: req.url, headers }, pres => {
    const h = { ...pres.headers };
    for (const x of HOP) delete h[x];
    delete h['x-frame-options'];
    if (h['content-security-policy']) { const v = stripFrameAncestors(h['content-security-policy']); if (v.length) h['content-security-policy'] = v; else delete h['content-security-policy']; }
    if (h.location && h.location.startsWith(ORIGIN)) h.location = 'http://' + req.headers.host + h.location.slice(ORIGIN.length);
    if (h['set-cookie']) h['set-cookie'] = [].concat(h['set-cookie']).map(c => c.replace(/;\s*domain=[^;]*/ig, ''));
    res.writeHead(pres.statusCode, h);
    pres.pipe(res);
    if (u.pathname.includes(API_MATCH)) res.on('finish', () => logRequest({ method: req.method, path: u.pathname.slice(0, 300), status: pres.statusCode, ms: Date.now() - t0, at: new Date().toISOString() }));
  });
  let aborted = false;
  preq.on('error', e => {
    if (aborted) return;                                    // the browser went away first: not an app error, do not log
    if (u.pathname.includes(API_MATCH)) logRequest({ method: req.method, path: u.pathname.slice(0, 300), status: 502, ms: Date.now() - t0, at: new Date().toISOString() });
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>${htmlEsc(cfg.name)} is not running</title><body style="font:16px system-ui;padding:24px">
<h1>${htmlEsc(cfg.name)} is not running</h1><p>Anvil could not reach it at ${htmlEsc(ORIGIN)} (${htmlEsc(e.code || e.message)}).</p>
<p>Start it from the repo folder:<br><code>${htmlEsc(startHint(cfg))}</code><br>then reload this page.</p>`);
  });
  res.on('close', () => { if (!res.writableFinished) { aborted = true; preq.destroy(); } });   // tester navigated away: stop the upstream request
  req.pipe(preq);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const parts = [];
    let over = false;                                         // too big: keep draining (no buffering) so the 413 reaches the client
    req.on('data', d => { size += d.length; if (over) return; if (size > limit) { over = true; parts.length = 0; reject(new HttpError(413, 'Request too large')); } else parts.push(d); });
    req.on('end', () => {
      if (over) return;
      const s = Buffer.concat(parts).toString('utf8');
      if (!s.trim()) return resolve({});
      let j; try { j = JSON.parse(s); } catch { return reject(new HttpError(400, 'Body is not valid JSON')); }
      j && typeof j === 'object' && !Array.isArray(j) ? resolve(j) : reject(new HttpError(400, 'Body must be a JSON object'));
    });
    req.on('error', reject);
  });
}
function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
async function serveFile(res, base, rel) {
  let dec; try { dec = decodeURIComponent(rel); } catch { bad('Bad path'); }
  if (dec.includes('\0') || dec.split(/[\\/]/).includes('..')) bad('Bad path', 403);
  const abs = path.resolve(base, '.' + path.sep + dec);
  if (abs !== base && !abs.startsWith(base + path.sep)) bad('Bad path', 403);
  let st; try { st = await fsp.stat(abs); } catch { bad('Not found', 404); }
  if (!st.isFile()) bad('Not found', 404);
  const csp = base === DASH ? { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'" } : {};
  send(res, 200, await fsp.readFile(abs), { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', ...csp });
}
const okHost = h => h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}`;
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';

const routes = {
  'GET /api/data': async () => { checkHealth(); return getData(); },
  // every open PR with the testing label assigned to the signed-in gh user (read-only); this PR is flagged current:true
  'GET /api/next': async () => {
    const plan = await readJSON(F.plan, {});
    if (!REPO) return { prs: [{ number: PR, title: plan.title || '', url: plan.url || '', current: true }] };
    const r = await run('gh', ['pr', 'list', '-R', REPO, '--assignee', '@me', '--label', cfg.github.testing_label, '--state', 'open', '--json', 'number,title,url', '--limit', '100'], { timeout: 20000 });
    if (r.code !== 0) bad('Could not ask GitHub for your PRs: ' + (r.stderr.trim().split('\n')[0] || r.error), 502);
    const prs = JSON.parse(r.stdout || '[]').map(p => ({ number: p.number, title: p.title, url: p.url, current: p.number === PR }));
    if (!prs.some(p => p.current)) prs.unshift({ number: PR, title: plan.title || '', url: plan.url || `https://github.com/${REPO}/pull/${PR}`, current: true });
    return { prs };
  },
  'POST /api/run': async b => {
    const only = b.only == null || b.only === '' ? '' : String(b.only);
    if (only && !/^[A-Za-z0-9_.\/,-]{1,400}$/.test(only)) bad('Bad "only" value');
    if (await isRunning() || stopping) bad('Checks are already running', 409);
    // re-run ids lose their hand-check override (a full run re-runs every id, so all overrides go)
    const pre = only ? only.split(',').filter(Boolean) : null;
    await mutateState(s => {
      if (!s.overrides) return;
      for (const id of Object.keys(s.overrides)) if (!pre || pre.some(p => id.startsWith(p))) delete s.overrides[id];
      s.completed = false;
    });
    startRun(only); pushData();
    return { started: true };
  },
  'POST /api/stop': async () => {
    if (stopping) return stopping;
    try { return await (stopping = stopRun()); } finally { stopping = null; }
  },
  // the tester checked an automatic check by hand: state.overrides[id] = {status, note, at}; status null removes it
  'POST /api/override': async b => {
    const id = String(b.id || '');
    if (![null, 'pass', 'fail'].includes(b.status ?? null)) bad('status must be pass, fail or null');
    const r = await readJSON(F.results, null);
    if (b.status != null && !(r?.checks || []).some(c => c.id === id)) bad('Unknown check id');
    await mutateState(s => {
      s.overrides = s.overrides || {};
      if (b.status == null) delete s.overrides[id];
      else s.overrides[id] = { status: b.status, note: str(b.note, 1000), at: new Date().toISOString() };
      s.completed = false;
    });
    pushData(); return { ok: true };
  },
  'GET /api/log': async (_b, u) => {
    const after = Math.max(0, parseInt(u.searchParams.get('after') || '0', 10) || 0);
    const lines = runLog.filter(l => l.n > after);
    return { lines, next: lines.length ? lines[lines.length - 1].n : Math.max(after, runN) };
  },
  'POST /api/manual': async b => {
    const plan = await readJSON(F.plan, {});
    if (!(plan.manual || []).some(m => m.id === b.id)) bad('Unknown manual check id');
    const answer = b.answer ?? null;
    if (![null, 'works', 'broken', 'unsure'].includes(answer)) bad('answer must be works, broken, unsure or null');
    await mutateState(s => { const m = s.manual[b.id] || { shots: [] }; s.manual[b.id] = { ...m, answer, note: str(b.note, 4000), at: new Date().toISOString() }; s.completed = false; });
    pushData(); return { ok: true };
  },
  'POST /api/manual-shot': async b => {
    const plan = await readJSON(F.plan, {});
    if (!(plan.manual || []).some(m => m.id === b.id)) bad('Unknown manual check id');
    const m = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.dataUrl || ''));
    if (!m) bad('dataUrl must be a base64 PNG or JPEG');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 << 20) bad('Image is larger than 8 MB', 413);
    const isPng = buf.slice(0, 8).equals(PNG_MAGIC), isJpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (!(m[1] === 'png' ? isPng : isJpg)) bad('The file is not a real ' + m[1].toUpperCase());
    const file = await mutateState(async s => {
      const cur = s.manual[b.id] || { answer: null, note: '', shots: [] };
      const k = (cur.shots || []).length + 1;
      let file = `shots/manual-${b.id}-${k}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      for (let j = k; fs.existsSync(path.join(QA, file)); j++) file = `shots/manual-${b.id}-${j + 1}.${m[1] === 'png' ? 'png' : 'jpg'}`;
      await fsp.writeFile(path.join(QA, file), buf);
      s.manual[b.id] = { ...cur, shots: [...(cur.shots || []), file], at: new Date().toISOString() };
      return file;
    });
    pushData(); return { file };
  },
  'POST /api/shot': async b => {
    if (!ROLES.includes(b.role) && b.role !== 'anon') bad('Unknown role');
    if (!DEVICES.includes(b.device)) bad('Unknown device');
    if (!okPage(b.page, true)) bad('page must be a path inside the app, like ' + (cfg.app.page_example || 'section/page.html'));
    const file = await takeShot(b.role, b.page, b.device);
    await addShot({ file, page: b.page, role: b.role, device: b.device, source: 'tool', at: new Date().toISOString() });
    return { file };
  },
  // exact capture of the test view made by the UI (getDisplayMedia, cropped) -> shots/view-*.png, source "view"
  'POST /api/view-shot': async b => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(b.dataUrl || ''));
    if (!m) bad('dataUrl must be a base64 PNG');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 8 << 20) bad('Image is larger than 8 MB', 413);
    if (!buf.slice(0, 8).equals(PNG_MAGIC)) bad('The file is not a real PNG');
    const page = okPage(b.page, true) ? b.page : null;
    const role = ROLES.includes(b.role) || b.role === 'anon' ? b.role : null, device = [...DEVICES, 'fit'].includes(b.device) ? b.device : null;
    let manualId = null;
    if (b.manualId != null && b.manualId !== '') {
      const plan = await readJSON(F.plan, {});
      if (!(plan.manual || []).some(x => x.id === b.manualId)) bad('Unknown manual check id');
      manualId = b.manualId;
    }
    const file = `shots/view-${(page || 'page').replace(/\.html?$/, '').replace(/[^a-z0-9-]+/gi, '-').slice(0, 80)}-${role || 'anon'}-${device || 'any'}-${Date.now()}.png`;
    await fsp.writeFile(path.join(QA, file), buf);
    await addShot({ file, page, role, device, source: 'view', at: new Date().toISOString(), ...(manualId ? { manual: manualId } : {}) }, manualId);
    return { file };
  },
  // tester-session events from the test view (batched by the UI) -> state.session.events (last 1000)
  'POST /api/session': async b => {
    if (!Array.isArray(b.events)) bad('events must be a list');
    const evs = b.events.slice(0, 300).filter(e => e && SESSION_TYPES.includes(e.type)).map(e => {
      const o = { type: e.type, at: typeof e.at === 'string' && e.at.length <= 40 ? e.at : new Date().toISOString() };
      if (e.url != null) o.url = str(String(e.url), 500);
      if (ROLES.includes(e.role) || e.role === 'anon') o.role = e.role;
      if ([...DEVICES, 'fit'].includes(e.device)) o.device = e.device;
      if (e.text != null) o.text = str(String(e.text), 300);
      if (Number.isInteger(e.status)) o.status = e.status;
      if (e.path != null) o.path = str(String(e.path), 300);
      if (e.method != null && /^[A-Z]{3,7}$/.test(e.method)) o.method = e.method;
      return o;
    });
    if (evs.length) await mutateState(s => { const ses = sessionOf(s); ses.events = [...ses.events, ...evs].slice(-1000); });
    return { ok: true, added: evs.length };
  },
  'GET /api/session': async () => sessionOf(await loadState()),
  // lets Claude (curl from Claude Code) drive the test view; forwarded to the UI as SSE event "control"
  'POST /api/control': async b => {
    const c = { action: b.action, at: new Date().toISOString() };
    if (!['navigate', 'device', 'role', 'reload', 'shot'].includes(b.action)) bad('action must be navigate, device, role, reload or shot');
    if (b.page != null) { if (!okPage(b.page, true)) bad('page must be a path inside the app, like ' + (cfg.app.page_example || 'section/page.html')); c.page = b.page; }
    if (b.role != null) { if (!ROLES.includes(b.role)) bad('Unknown role'); c.role = b.role; }
    if (b.device != null) { if (![...DEVICES, 'fit'].includes(b.device)) bad('Unknown device'); c.device = b.device; }
    if (b.action === 'navigate' && !c.page) bad('navigate needs a page');
    if (b.action === 'role' && !c.role) bad('role needs a role');
    if (b.action === 'device' && !c.device) bad('device needs a device');
    broadcast('control', c);
    return { ok: true, listeners: clients.size };
  },
  'POST /api/include': async b => {
    const file = String(b.file || '');
    if (!/^shots\/[A-Za-z0-9_.-]+\.(png|jpe?g)$/.test(file) || !fs.existsSync(path.join(QA, file))) bad('Unknown screenshot');
    await mutateState(s => { const set = new Set(s.include_shots || []); b.on ? set.add(file) : set.delete(file); s.include_shots = [...set]; });
    pushData(); return { ok: true };
  },
  'POST /api/reset-data': async () => {
    if (!cfg.app.reset_path) bad('No reset_path in anvil.config.json: this project has no test-data reset', 404);
    try { const r = await fetch(ORIGIN + cfg.app.reset_path, { redirect: 'manual', signal: AbortSignal.timeout(30000) }); if (r.status >= 400) bad(`${cfg.name} answered ${r.status}`, 502); }
    catch (e) { if (e instanceof HttpError) throw e; bad(`${cfg.name} is not reachable at ${ORIGIN}`, 502); }
    return { ok: true };
  },
  'POST /api/complete': async b => {
    if (await isRunning() || stopping) bad('Wait until the automatic checks have finished (or stop them)', 409);
    const plan = await readJSON(F.plan, null);
    if (!plan) bad('plan.json is missing', 409);
    const rating = b.rating == null || b.rating === '' ? null : +b.rating;
    if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) bad('rating must be 1 to 5');
    const st0 = await loadState();
    const open = (plan.manual || []).filter(m => !['works', 'broken', 'unsure'].includes(st0.manual?.[m.id]?.answer));
    if (open.length) bad(`Answer every manual check first (${open.map(m => m.id).join(', ')} still open)`, 409);
    if (st0.sent) bad('This report was already sent', 409);
    const results = await readJSON(F.results, null);
    const state = { ...st0, rating, note_to_dev: str(b.note_to_dev, 4000) };
    const summary = report.score(plan, results, state);
    const d = await report.draft(plan, results, state, summary, { cfg, changedFiles: await changedFiles() });
    log('draft from', d.source, d.warning || '');
    await mutateState(s => { s.rating = rating; s.note_to_dev = state.note_to_dev; s.completed = true; s.draft = d; });
    report.contactSheet(QA, plan, results, await loadState()).then(f => log('contact sheet', f)).catch(e => log('contact sheet skipped:', e.message));
    pushData(); return { summary, draft: d };
  },
  'POST /api/send': async b => {
    if (sending) bad('Already sending', 409);
    sending = true;
    try { return await doSend(b); } finally { sending = false; }
  },
};
routes['POST /api/reset-demo'] = routes['POST /api/reset-data'];   // older dashboards
let sending = false;

async function doSend(b) {
  const plan = await readJSON(F.plan, null), state = await loadState();
  if (!plan) bad('plan.json is missing', 409);
  if (!state.completed || !state.draft) bad('Finish the test first (complete)', 409);
  if (state.sent) bad('This report was already sent', 409);
  if (!REPO && !DRY) bad('No GitHub repo: set github.repo in anvil.config.json', 409);
  const lanes = plan.lanes?.length ? plan.lanes : [cfg.review.default_lane];
  const comments = Array.isArray(b.comments) ? b.comments : bad('comments must be a list');
  if (comments.length !== lanes.length || !lanes.every(l => comments.filter(c => c && c.lane === l).length === 1)) bad('Need exactly one comment per lane: ' + lanes.join(', '));
  for (const c of comments) {
    if (typeof c.body !== 'string' || !c.body.trim() || c.body.length > 60000) bad(`Comment for ${c.lane} is empty or too long`);
    if (!commandRegex(cfg, c.lane).test(c.body.trimStart())) bad(`Comment for ${c.lane} must start with ${passLine(cfg, c.lane)} or ${fixLine(cfg, c.lane)} ...`);
  }
  const chatIn = typeof b.chat_md === 'string' ? b.chat_md : b.discord_md;
  const chat = typeof chatIn === 'string' && chatIn.trim() ? chatIn.slice(0, 2000) : (state.draft.chat_md ?? state.draft.discord_md);
  const posted = { ...(state.posted || {}) };                 // lanes already posted by an earlier, partly failed send
  for (const c of comments) {
    if (posted[c.lane]) continue;
    const tmp = path.join(QA, `.comment-${c.lane}.md`);
    await fsp.writeFile(tmp, c.body.trimStart());
    let url;
    if (DRY) url = `https://github.com/${REPO || 'owner/repo'}/pull/${PR}#issuecomment-dryrun-${c.lane}-${Date.now()}`;
    else {
      const r = await run('gh', ['pr', 'comment', String(PR), '-R', REPO, '--body-file', tmp], { timeout: 60000 });
      if (r.code !== 0) { await mutateState(s => { s.posted = posted; }); bad(`GitHub did not accept the ${c.lane} comment: ${(r.stderr.trim().split('\n')[0] || r.error)}` + (Object.keys(posted).length ? ' (other lanes were posted; press send again to retry the rest)' : ''), 502); }
      url = (r.stdout.match(/https:\/\/github\.com\/\S+/) || [r.stdout.trim()])[0];
    }
    await fsp.rm(tmp, { force: true });
    posted[c.lane] = url;
    log(DRY ? 'DRY RUN, not posted:' : 'posted', c.lane, url);
  }
  const urls = lanes.map(l => posted[l]);
  const files = [];
  const md = `# QA report - PR #${PR} ${plan.title || ''}\n\n` + comments.map(c => `## Lane ${c.lane}\n\nPosted: ${posted[c.lane]}\n\n${c.body.trim()}\n`).join('\n');
  await fsp.writeFile(path.join(QA, 'report.md'), md); files.push('report.md');
  const fixFirst = [...comments].sort((a, b) => (isFixBody(cfg, b.lane, b.body) ? 1 : 0) - (isFixBody(cfg, a.lane, a.body) ? 1 : 0));
  const finalNote = report.finalChat(chat, fixFirst.map(c => posted[c.lane]));
  await fsp.writeFile(path.join(QA, CHAT_FILE), finalNote); files.push(CHAT_FILE);
  try { await report.contactSheet(QA, plan, await readJSON(F.results, null), state); files.push('screens.png'); }
  catch (e) { log('contact sheet skipped:', e.message); if (fs.existsSync(path.join(QA, 'screens.png'))) files.push('screens.png'); }
  const decision = comments.some(c => isFixBody(cfg, c.lane, c.body)) ? 'fix' : 'final';
  await mutateState(s => { s.sent = { at: new Date().toISOString(), decision, comments: urls, files, dry_run: DRY || undefined }; delete s.posted; });
  pushData();
  return { urls, files, chat_md: finalNote };
}

const server = http.createServer(async (req, res) => {
  try {
    if (!okHost(req.headers.host || '')) return send(res, 403, { error: 'Wrong host' });   // also for the proxy (DNS rebinding)
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/' || u.pathname === '/anvil') { res.writeHead(302, { Location: '/anvil/', 'Cache-Control': 'no-store' }); return res.end(); }
    if (!u.pathname.startsWith('/anvil/')) return proxy(req, res, u);      // the app under test: untouched except frame headers
    const p = u.pathname.slice(6);                                          // '/anvil/api/data' -> '/api/data'
    const origin = req.headers.origin;
    if (p.startsWith('/api/') && origin && origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return send(res, 403, { error: 'Wrong origin' });
    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 2000\n\n');
      clients.add(res); req.on('close', () => clients.delete(res));
      res.write(`event: data\ndata: ${JSON.stringify(await getData())}\n\n`);
      return;
    }
    if (req.method === 'GET' && p === '/api/chat.md') {
      const f = path.join(QA, CHAT_FILE);
      if (!fs.existsSync(f)) return send(res, 404, { error: 'The chat note is written after the report is sent' });
      return send(res, 200, await fsp.readFile(f), { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': `attachment; filename="${CHAT_FILE}"` });
    }
    const h = routes[`${req.method} ${p}`];
    if (h) {
      const body = req.method === 'POST' ? await readBody(req, LIMIT[p] || (64 << 10)) : {};
      return send(res, 200, await h(body, u));
    }
    if (p.startsWith('/api/')) return Object.keys(routes).some(k => k.endsWith(' ' + p)) ? send(res, 405, { error: 'Wrong method for ' + p }) : send(res, 404, { error: 'No such API route' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
    if (p.startsWith('/qa/')) return await serveFile(res, QA, p.slice(4));
    return await serveFile(res, DASH, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) log('error', req.method, req.url, e.stack || e.message);
    if (!res.headersSent) send(res, status, { error: status === 500 ? 'Server error: ' + e.message : e.message });
    else res.end();
  }
});
server.listen(PORT, '127.0.0.1', () => {
  log(`Anvil running at http://127.0.0.1:${PORT} for PR #${PR}  (open ${SELF}/anvil/ - ${cfg.name} proxied from ${ORIGIN} - data ${QA})${DRY ? '  DRY RUN: nothing is posted' : ''}`);
  checkHealth(true).then(() => pushData());
});
server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is busy - is Anvil already running? (set ANVIL_PORT to use another)` : e.message); process.exit(1); });
