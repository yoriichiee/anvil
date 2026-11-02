// Anvil - targets: what `anvil scan <url|dir|zip>` points at, ownership proof for remote URLs, ZIP extraction
// (zip-slip and size guarded), and starting a local folder so the browser checks have a URL.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { detectFramework } from './source.mjs';

export const ANVIL_HOME = () => process.env.ANVIL_HOME || path.join(os.homedir(), '.anvil');

// -> { kind: 'url'|'dir'|'zip', value, url?, abs? }
export function parseTarget(t) {
  const s = String(t || '').trim();
  if (!s) throw new Error('usage: anvil scan <url | folder | file.zip>');
  if (/^https?:\/\//i.test(s)) {
    const u = new URL(s);
    if (u.username || u.password) throw new Error('remove the user name / password from the URL');
    return { kind: 'url', value: u.origin + u.pathname + u.search, url: u.href };
  }
  if (/^[a-z0-9.-]+:\d{2,5}(\/|$)/i.test(s) || /^localhost(\/|$)/i.test(s)) return parseTarget('http://' + s);
  const abs = path.resolve(s);
  if (!fs.existsSync(abs)) throw new Error('not found: ' + s + ' (give a URL like http://localhost:3000, a folder or a .zip)');
  if (fs.statSync(abs).isDirectory()) return { kind: 'dir', value: abs, abs };
  if (/\.zip$/i.test(abs)) return { kind: 'zip', value: abs, abs };
  throw new Error('not a folder or .zip: ' + s);
}

export function isLocalHost(hostname) {
  const h = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// ---------------------------------------------------------------- ownership (/.well-known/anvil.txt)
const ownerFile = () => path.join(ANVIL_HOME(), 'owner-tokens.json');
function readTokens() { try { return JSON.parse(fs.readFileSync(ownerFile(), 'utf8')); } catch { return {}; } }
export function ownerToken(origin, { create = true } = {}) {
  const all = readTokens();
  if (!all[origin] && create) {
    all[origin] = 'anvil-verify-' + crypto.randomBytes(16).toString('hex');
    fs.mkdirSync(path.dirname(ownerFile()), { recursive: true });
    fs.writeFileSync(ownerFile(), JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
  }
  return all[origin] || null;
}
// -> { ok, exempt?, reason, token?, wellKnown }
export async function checkOwnership(url, { fetchImpl = globalThis.fetch, token } = {}) {
  const u = new URL(url);
  const wellKnown = u.origin + '/.well-known/anvil.txt';
  if (isLocalHost(u.hostname)) return { ok: true, exempt: true, reason: 'local address', wellKnown };
  token = token || ownerToken(u.origin, { create: false });
  if (!token) return { ok: false, reason: `no ownership token for ${u.origin} yet: run "anvil verify-owner ${u.origin}"`, wellKnown };
  let r, text = '';
  try { r = await fetchImpl(wellKnown, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { Accept: 'text/plain' } }); text = (await r.text()).slice(0, 4096); }
  catch (e) { return { ok: false, reason: 'could not fetch ' + wellKnown + ': ' + (e.cause && e.cause.code || e.message), token, wellKnown }; }
  if (r.status !== 200) return { ok: false, reason: `${wellKnown} answered ${r.status} (expected 200 with your token)`, token, wellKnown };
  if (!text.split(/\r?\n/).some(l => l.trim() === token || l.trim() === 'anvil-verify=' + token)) return { ok: false, reason: `${wellKnown} does not contain this machine's token`, token, wellKnown };
  return { ok: true, reason: 'token found', token, wellKnown };
}

// ---------------------------------------------------------------- zip
export async function extractZip(zipPath, outDir, { maxBytes = 300e6, maxEntries = 30000 } = {}) {
  const yauzl = (await import('yauzl')).default;
  await fsp.mkdir(outDir, { recursive: true });
  const root = path.resolve(outDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (err, zip) => {
      if (err) return reject(err);
      let total = 0, n = 0;
      zip.on('error', reject);
      zip.on('end', () => resolve({ dir: root, entries: n, bytes: total }));
      zip.on('entry', e => {
        if (++n > maxEntries) { zip.close(); return reject(new Error('zip has too many entries')); }
        const name = e.fileName.replace(/\\/g, '/');
        const dest = path.resolve(root, name);
        if (name.includes('\0') || path.isAbsolute(name) || /^[a-z]:/i.test(name) || (dest !== root && !dest.startsWith(root + path.sep))) { zip.close(); return reject(new Error('unsafe path in zip: ' + name.slice(0, 120))); }
        const mode = (e.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) { zip.readEntry(); return; }   // symlink: skipped
        if (/\/$/.test(name)) { fs.mkdirSync(dest, { recursive: true }); zip.readEntry(); return; }
        total += e.uncompressedSize;
        if (total > maxBytes) { zip.close(); return reject(new Error('zip is larger than ' + Math.round(maxBytes / 1e6) + ' MB unpacked')); }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        zip.openReadStream(e, (er, rs) => {
          if (er) return reject(er);
          const ws = fs.createWriteStream(dest);
          rs.on('error', reject); ws.on('error', reject);
          ws.on('close', () => zip.readEntry());
          rs.pipe(ws);
        });
      });
      zip.readEntry();
    });
  });
}
// a zip with one top folder -> that folder
export function unwrapSingleDir(dir) {
  const ents = fs.readdirSync(dir).filter(n => !n.startsWith('__MACOSX'));
  return ents.length === 1 && fs.statSync(path.join(dir, ents[0])).isDirectory() ? path.join(dir, ents[0]) : dir;
}

// ---------------------------------------------------------------- start a folder
export const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.unref(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

export async function waitForUrl(url, ms = 60000, isAlive = () => true) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive()) return false;
    try { const r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); if (r.status < 500) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
// tiny read-only static server (127.0.0.1) for exported sites; SPA fallback to index.html
export function serveStatic(dir) {
  const root = path.resolve(dir);
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      let p; try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
      let file = path.resolve(root, '.' + p);
      if (file !== root && !file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file)) { if (path.extname(p)) { res.writeHead(404); return res.end('not found'); } file = path.join(root, 'index.html'); }
      fs.readFile(file, (e, buf) => { if (e) { res.writeHead(404); return res.end('not found'); } res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : buf); });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port + '/', stop: () => new Promise(r => srv.close(() => r())) }));
  });
}

function killTree(p) {
  if (!p || p.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true });
  else try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch {} }
}

// how a folder would be started -> { how: 'static'|'command'|'none', cmd?, args?, port?, env?, reason, needsInstall? }
export function startPlan(dir, { legacy, allowScripts = false, untrusted = false } = {}) {
  const fw = detectFramework(dir);
  if (legacy && legacy.app && legacy.app.start_command) {
    const origin = String(legacy.app.origin || '').replace(/\/+$/, '');
    const port = Number((/:(\d+)$/.exec(origin) || [])[1]) || null;
    if (untrusted && !allowScripts) return { how: 'none', reason: 'anvil.config.json has a start command, but code from a zip is only run with --allow-scripts' };
    return { how: 'command', shell: legacy.app.start_command, port, origin, reason: 'app.start_command from anvil.config.json' };
  }
  if (!fw) return { how: 'none', reason: 'no package.json or index.html found; pass --url of the running app' };
  if (fw.kind === 'static') return { how: 'static', dir: path.join(dir, fw.staticDir), reason: 'static site (' + fw.staticDir + '/index.html)' };
  for (const d of ['dist', 'build', 'out']) if (fs.existsSync(path.join(dir, d, 'index.html')) && (untrusted || !fw.cmd) && !allowScripts) return { how: 'static', dir: path.join(dir, d), reason: `built site in ${d}/ (served as static files)` };
  if (!fw.cmd) return { how: 'none', reason: 'package.json has no dev/start/preview script; pass --url' };
  if (untrusted && !allowScripts) return { how: 'none', reason: 'code from a zip is only run with --allow-scripts; pass --url or add --allow-scripts' };
  const needsInstall = fw.hasDeps && !fs.existsSync(path.join(dir, 'node_modules'));
  return { how: 'command', cmd: 'npm', args: ['run', fw.script], port: fw.port, framework: fw.kind, needsInstall, reason: `${fw.kind}: npm run ${fw.script}` };
}

// start it; -> { url, stop(), log() } or throws with a readable reason
export async function startApp(dir, plan, { allowScripts = false, log = () => {} } = {}) {
  if (plan.how === 'static') { const s = await serveStatic(plan.dir); log('serving ' + plan.dir + ' at ' + s.url); return { url: s.url, stop: s.stop, how: 'static' }; }
  if (plan.how !== 'command') throw new Error(plan.reason);
  if (plan.needsInstall) {
    if (!allowScripts) throw new Error('node_modules is missing. Install dependencies yourself (npm install), or re-run with --allow-scripts to let Anvil run "npm install" (it runs the packages\' install scripts), or pass --url of the running app.');
    log('npm install (--allow-scripts)');
    const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'ignore', shell: process.platform === 'win32', timeout: 600000, windowsHide: true });
    if (r.status !== 0) throw new Error('npm install failed (exit ' + r.status + ')');
  }
  const port = plan.port && !plan.shell ? await freePort() : plan.port;
  const env = { ...process.env, PORT: String(port || ''), BROWSER: 'none', CI: '1' };
  let p, out = '';
  if (plan.shell) p = spawn(plan.shell, { cwd: dir, env, shell: true, windowsHide: true, detached: process.platform !== 'win32' });
  else {
    const extra = ['vite', 'astro', 'sveltekit', 'remix'].includes(plan.framework) ? ['--', '--port', String(port), '--strictPort', '--host', '127.0.0.1'] : plan.framework === 'next' ? ['--', '-p', String(port), '-H', '127.0.0.1'] : [];
    p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', [...plan.args, ...extra], { cwd: dir, env, shell: process.platform === 'win32', windowsHide: true, detached: process.platform !== 'win32' });
  }
  p.stdout.on('data', d => { out = (out + d).slice(-8000); }); p.stderr.on('data', d => { out = (out + d).slice(-8000); });
  const url = plan.origin ? plan.origin + '/' : 'http://127.0.0.1:' + port + '/';
  log('started: ' + (plan.shell || 'npm ' + plan.args.join(' ')) + ' -> ' + url);
  const up = await waitForUrl(url, 90000, () => p.exitCode === null);
  if (!up) { killTree(p); throw new Error('the app did not answer at ' + url + ' within 90 s. Last output: ' + out.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 400)); }
  return { url, how: 'command', stop: async () => killTree(p), output: () => out };
}
