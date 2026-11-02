// Run manager for the Anvil MCP server.
// The MCP server never imports the engine. It spawns the CLI (see CLI-CONTRACT.md) and reads
// <anvil-dir>/runs/<runId>/report.json. Everything coming back from a scanned app is untrusted data.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const RUN_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
export const ITEM_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,99}$/;
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];

export const CLI_PATH = process.env.ANVIL_CLI ? path.resolve(process.env.ANVIL_CLI) : path.resolve(HERE, '..', 'cli.mjs');
const SCAN_TIMEOUT_MS = Number(process.env.ANVIL_SCAN_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_CONCURRENT = Number(process.env.ANVIL_MAX_SCANS) || 2;
const OUT_CAP = 512 * 1024;
const REPORT_CAP = 20 * 1024 * 1024;

/** runId -> live run record (this process only). */
const live = new Map();
/** .anvil folders seen in this session, searched when a runId is not live. */
const knownAnvilDirs = new Set();

// ---------- redaction (defense in depth; the engine redacts first) ----------
let extRedact = null;
try {
  const m = await import('../redact.mjs');
  extRedact = typeof m.redact === 'function' ? m.redact : typeof m.default === 'function' ? m.default : null;
} catch { /* W1's redact.mjs not present yet: built-in patterns only */ }

const PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{8,}/g, '$1[REDACTED]'],
  [/\b(whsec_)[A-Za-z0-9]{8,}/g, '$1[REDACTED]'],
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1[REDACTED]'],
  [/\b(github_pat_)[A-Za-z0-9_]{20,}/g, '$1[REDACTED]'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1[REDACTED]'],
  [/\b(AIza)[0-9A-Za-z_-]{35}\b/g, '$1[REDACTED]'],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, '$1[REDACTED]'],
  [/\b(sk-(?:ant-|proj-)?)[A-Za-z0-9_-]{20,}/g, '$1[REDACTED]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED JWT]'],
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/([^:\s/]+):[^@\s]+@/gi, '$1://$2:[REDACTED]@'],
  [/((?:password|passwd|secret|token|api[_-]?key|service[_-]?role)["']?\s*[:=]\s*["']?)([^\s"',;]{6,})/gi, '$1[REDACTED]'],
];

export function redact(input) {
  let s = String(input ?? '');
  if (extRedact) {
    try {
      const r = extRedact(s);
      if (typeof r === 'string') s = r;
      else if (r && typeof r.text === 'string') s = r.text;
    } catch {
      return '[withheld: redaction failed]';
    }
  }
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  return s;
}

// ---------- helpers ----------
export function defaultAnvilDir() {
  const base = process.env.ANVIL_WORKSPACE ? path.resolve(process.env.ANVIL_WORKSPACE) : process.cwd();
  return path.join(base, '.anvil');
}

export function validRunId(id) {
  return typeof id === 'string' && RUN_ID_RE.test(id) && !/^\.+$/.test(id);
}

function newRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-'); // 2026-11-02T10-15-00-123Z
  return `${ts}-${crypto.randomBytes(2).toString('hex')}`;
}

function capPush(buf, chunk) {
  const next = buf + chunk;
  return next.length > OUT_CAP ? next.slice(next.length - OUT_CAP) : next;
}

export function lastJsonLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].startsWith('{')) continue;
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

function tail(text, n = 1500) {
  const t = String(text || '').trim();
  return redact(t.length > n ? '...' + t.slice(t.length - n) : t);
}

/** Run the CLI once, wait for it. Never uses a shell. */
export function runCli(args, { cwd = process.cwd(), timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    if (!fs.existsSync(CLI_PATH)) {
      resolve({ code: -1, stdout: '', stderr: `anvil CLI not found at ${CLI_PATH}`, spawnError: true });
      return;
    }
    let stdout = '', stderr = '', done = false;
    let child;
    try {
      child = spawn(process.execPath, [CLI_PATH, ...args], {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...process.env, ANVIL_MCP: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message || e), spawnError: true });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => { stdout = capPush(stdout, d.toString('utf8')); });
    child.stderr.on('data', (d) => { stderr = capPush(stderr, d.toString('utf8')); });
    child.on('error', (e) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(e?.message || e), spawnError: true }); });
    child.on('close', (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr, json: lastJsonLine(stdout) }); });
  });
}

// ---------- target classification ----------
export function classifyTarget(target, cwd = process.cwd()) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('target is required: a URL (http://localhost:3000), a folder, or a .zip file.');
  const t = target.trim();
  if (t.length > 2048 || /[\r\n\0]/.test(t)) throw new Error('target is too long or contains control characters.');
  if (t.startsWith('-')) throw new Error('target must not start with "-".');
  if (/^https?:\/\//i.test(t)) {
    let u;
    try { u = new URL(t); } catch { throw new Error('target URL is not valid.'); }
    if (u.username || u.password) throw new Error('Do not put credentials in the target URL.');
    return { kind: 'url', value: u.toString(), base: null };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) throw new Error('Only http(s) URLs, local folders and .zip files can be scanned.');
  const p = path.resolve(cwd, t);
  let st;
  try { st = fs.statSync(p); } catch { throw new Error(`Local target not found: ${p}`); }
  if (st.isDirectory()) return { kind: 'dir', value: p, base: p };
  if (st.isFile() && /\.zip$/i.test(p)) return { kind: 'zip', value: p, base: path.dirname(p) };
  throw new Error('A local target must be a folder or a .zip file.');
}

// ---------- scans ----------
export function startScan({ target, dir, devices, addons, aiMode = 'none' }) {
  const running = [...live.values()].filter((r) => r.state === 'running').length;
  if (running >= MAX_CONCURRENT) throw new Error(`${running} scan(s) are already running. Wait for them (anvil_status) before starting another.`);

  const cwd = process.cwd();
  const tgt = classifyTarget(target, cwd);
  let dirAbs = null;
  if (dir) {
    if (typeof dir !== 'string' || dir.startsWith('-')) throw new Error('dir must be a folder path.');
    dirAbs = path.resolve(cwd, dir);
    if (!fs.existsSync(dirAbs) || !fs.statSync(dirAbs).isDirectory()) throw new Error(`dir is not a folder: ${dirAbs}`);
  }
  const base = process.env.ANVIL_WORKSPACE ? path.resolve(process.env.ANVIL_WORKSPACE) : (dirAbs || tgt.base || cwd);
  const anvilDir = path.join(base, '.anvil');
  const runId = newRunId();
  const runDir = path.join(anvilDir, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  knownAnvilDirs.add(anvilDir);

  const args = ['scan', tgt.value, '--json', '--no-open', '--run-id', runId, '--anvil-dir', anvilDir, '--ai', aiMode];
  if (dirAbs) args.push('--dir', dirAbs);
  if (devices?.length) args.push('--devices', devices.join(','));
  if (addons?.length) args.push('--addons', addons.join(','));

  const rec = {
    runId, runDir, anvilDir, base, target: tgt, state: 'running', startedAt: Date.now(), endedAt: null,
    exitCode: null, stdout: '', stderr: '', result: null, child: null,
  };
  live.set(runId, rec);
  writeMeta(rec);

  if (!fs.existsSync(CLI_PATH)) {
    finish(rec, -1, `anvil CLI not found at ${CLI_PATH}`);
    return rec;
  }
  let child;
  try {
    child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: base, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, ANVIL_MCP: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
    });
  } catch (e) {
    finish(rec, -1, String(e?.message || e));
    return rec;
  }
  rec.child = child;
  const timer = setTimeout(() => { rec.timedOut = true; try { child.kill(); } catch {} }, SCAN_TIMEOUT_MS);
  child.stdout.on('data', (d) => { rec.stdout = capPush(rec.stdout, d.toString('utf8')); });
  child.stderr.on('data', (d) => { rec.stderr = capPush(rec.stderr, d.toString('utf8')); });
  child.on('error', (e) => { clearTimeout(timer); finish(rec, -1, String(e?.message || e)); });
  child.on('close', (code) => { clearTimeout(timer); finish(rec, code ?? -1); });
  return rec;
}

function finish(rec, code, extraErr) {
  if (rec.state !== 'running') return;
  rec.exitCode = code;
  rec.endedAt = Date.now();
  rec.child = null;
  if (extraErr) rec.stderr += `\n${extraErr}`;
  rec.result = lastJsonLine(rec.stdout);
  // The CLI may report a different report location; trust it only if it is inside our .anvil folder.
  const rp = rec.result?.reportPath || rec.result?.report;
  if (typeof rp === 'string') {
    const abs = path.resolve(rec.base, rp);
    if (abs.startsWith(rec.anvilDir + path.sep) && fs.existsSync(abs)) rec.runDir = path.dirname(abs);
  }
  const hasReport = fs.existsSync(path.join(rec.runDir, 'report.json'));
  rec.state = hasReport ? 'done' : 'failed';
  if (rec.timedOut) rec.state = 'failed';
  writeMeta(rec);
}

function writeMeta(rec) {
  try {
    fs.writeFileSync(path.join(rec.runDir, 'mcp-run.json'), JSON.stringify({
      runId: rec.runId, target: rec.target.value, state: rec.state, startedAt: new Date(rec.startedAt).toISOString(),
      endedAt: rec.endedAt ? new Date(rec.endedAt).toISOString() : null, exitCode: rec.exitCode,
    }, null, 2));
  } catch { /* best effort */ }
}

export function killAll() {
  for (const r of live.values()) if (r.child) { try { r.child.kill(); } catch {} }
}

/** Find a run folder by id (or "latest"). Returns { runId, runDir, rec? } or null. */
export function findRun(runId) {
  if (runId === 'latest') {
    let best = null;
    for (const d of new Set([...knownAnvilDirs, defaultAnvilDir()])) {
      const runsDir = path.join(d, 'runs');
      let names = [];
      try { names = fs.readdirSync(runsDir); } catch { continue; }
      for (const n of names) {
        if (!validRunId(n)) continue;
        const rd = path.join(runsDir, n);
        let m; try { m = fs.statSync(rd); } catch { continue; }
        if (m.isDirectory() && (!best || m.mtimeMs > best.mtime)) best = { runId: n, runDir: rd, mtime: m.mtimeMs };
      }
    }
    if (!best) return null;
    return { runId: best.runId, runDir: live.get(best.runId)?.runDir || best.runDir, rec: live.get(best.runId) };
  }
  if (!validRunId(runId)) throw new Error('runId is not valid.');
  const rec = live.get(runId);
  if (rec) return { runId, runDir: rec.runDir, rec };
  for (const d of new Set([...knownAnvilDirs, defaultAnvilDir()])) {
    const rd = path.join(d, 'runs', runId);
    if (fs.existsSync(rd)) return { runId, runDir: rd };
  }
  return null;
}

export function readJsonSafe(file, cap = REPORT_CAP) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

export function readReport(runDir) {
  return readJsonSafe(path.join(runDir, 'report.json'));
}

export function writeReportAtomic(runDir, report) {
  const file = path.join(runDir, 'report.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function status(runId) {
  const found = findRun(runId);
  if (!found) return { runId, state: 'unknown', message: 'No run with this id in this workspace.' };
  const { rec, runDir } = found;
  const out = { runId: found.runId, state: rec ? rec.state : 'unknown', runDir };
  if (rec) {
    out.target = rec.target.value;
    out.elapsedSec = Math.round(((rec.endedAt || Date.now()) - rec.startedAt) / 1000);
  }
  const progress = readJsonSafe(path.join(runDir, 'progress.json'), 256 * 1024);
  if (progress && typeof progress === 'object') {
    out.progress = {};
    for (const k of ['phase', 'done', 'total', 'current']) if (progress[k] !== undefined) out.progress[k] = typeof progress[k] === 'string' ? redact(progress[k]).slice(0, 200) : progress[k];
  }
  const report = readReport(runDir);
  if (report) {
    if (!rec || rec.state === 'done') out.state = 'done';
    out.summary = report.summary;
    out.findings = Array.isArray(report.findings) ? report.findings.length : 0;
    out.humanChecks = Array.isArray(report.humanChecks) ? report.humanChecks.length : 0;
  } else if (!rec) {
    const meta = readJsonSafe(path.join(runDir, 'mcp-run.json'), 64 * 1024);
    out.state = meta?.state === 'running' ? 'interrupted' : 'failed';
    out.message = 'No report.json in this run folder (the scan did not finish, or was started by an earlier server process that stopped).';
  }
  if (rec && rec.state === 'failed') {
    out.exitCode = rec.exitCode;
    if (rec.timedOut) out.message = `Scan stopped after ${Math.round(SCAN_TIMEOUT_MS / 60000)} minutes.`;
    out.error = tail(rec.result?.error || rec.stderr || rec.stdout);
  }
  return out;
}
