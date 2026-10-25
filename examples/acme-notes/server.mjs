// Acme Notes - a tiny team notes app used as the demo target for Anvil. Zero dependencies (Node 20+).
//   node server.mjs            -> http://127.0.0.1:4400 (PORT to change; always binds 127.0.0.1)
// Env: PORT, ACME_DATA_DIR (data folder, default <os temp>/acme-notes-data), ACME_APP_DIR (static files, default ./public;
// point it at a `node build.mjs --out=<dir>` folder to serve a fresh build), ACME_LOG=1 (one line per request).
// It contains FOUR deliberate demo bugs, each marked "DEMO BUG" in the code and listed in DEMO-BUGS.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store, dataDirDefault, FLAGS } from './lib/store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROLES = ['admin', 'member', 'guest'];
export const HOME = { admin: 'admin/dashboard.html', member: 'member/notes.html', guest: 'guest/shared.html' };
const AS_USER = { admin: 'u1', member: 'u2', guest: 'u4' };
const COOKIE = 'acme_session';
const SAFE_PAGE = /^(?!.*\.\.)[a-z0-9_-]+\/[a-z0-9_-]+\.html$/i;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
  "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function createApp({ dataDir = dataDirDefault(), appDir = process.env.ACME_APP_DIR || path.join(HERE, 'public'), log = process.env.ACME_LOG === '1' } = {}) {
  const store = new Store(dataDir).seed();
  const sessions = new Map();   // token -> { role, user, csrf }
  appDir = path.resolve(appDir);

  const headers = (type, extra = {}) => ({
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, ...extra,
  });
  const send = (res, status, type, body, extra) => { res.writeHead(status, headers(type, extra)); res.end(body); };
  const json = (res, status, obj, extra) => send(res, status, TYPES['.json'], JSON.stringify(obj), extra);
  const redirect = (res, to, extra = {}) => { res.writeHead(302, headers('text/plain; charset=utf-8', { Location: to, ...extra })); res.end('Redirecting to ' + to); };

  function session(req) {
    const m = /(?:^|;\s*)acme_session=([A-Za-z0-9_-]{20,})/.exec(req.headers.cookie || '');
    return m ? sessions.get(m[1]) || null : null;
  }
  function signIn(role) {
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { role, user: AS_USER[role], csrf: crypto.randomBytes(18).toString('base64url') });
    return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  }

  function serveFile(res, file, status = 200) {
    const rel = path.relative(appDir, file);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return notFound(res);
    fs.readFile(file, (err, buf) => {
      if (err) return notFound(res);
      send(res, status, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', buf);
    });
  }

  function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, minimum-scale=1">
<title>${esc(title)} · Acme Notes</title><link rel="icon" href="/assets/img/favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="/assets/css/app.css"></head>
<body class="dev"><main class="wrap narrow">${body}</main></body></html>`;
  }
  function notFound(res) {
    send(res, 404, TYPES['.html'], page('Not found', `<div class="empty card"><h1>Page not found</h1><p class="muted">That page does not exist in Acme Notes.</p><p><a class="btn" href="/dev/">Back to sign-in</a></p></div>`));
  }

  const devHome = (msg = '') => page('Demo sign-in', `
<header class="dev-head"><span class="brand-mark" aria-hidden="true"></span><div><h1>Acme Notes</h1><p class="muted">Demo workspace for <strong>${esc(store.data.workspace)}</strong> · fictional data only</p></div></header>
${msg ? `<p class="notice" role="status">${esc(msg)}</p>` : ''}
<section class="card"><h2>Sign in as</h2><ul class="role-list">
${ROLES.map(r => { const u = store.user(AS_USER[r]); return `<li><div><strong>${esc(u.name)}</strong> <span class="pill pill-${r}">${r}</span><div class="muted small">${esc(u.title)} · opens ${esc(HOME[r])}</div></div><a class="btn" href="/dev/login/${r}">Sign in as ${r}</a></li>`; }).join('\n')}
</ul></section>
<section class="card"><h2>Demo tools</h2><ul class="tool-list">
<li><a href="/dev/reset">Reset demo data</a> <span class="muted small">puts notes, team and settings back to the seed (flags are kept)</span></li>
<li><span>Feature flags</span> <span class="muted small">ff_tags is ${store.flags().ff_tags ? '<strong>on</strong>' : 'off'} · change with <code>node flags.mjs --on=ff_tags</code></span></li>
</ul></section>`);

  // ------------------------------------------------------------------ API
  async function readBody(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 65536) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    if (!n) return {};
    try { const j = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (j && typeof j === 'object' && !Array.isArray(j)) return j; } catch {}
    throw Object.assign(new Error('bad json'), { status: 400 });
  }
  const noteOut = (n, flags) => {
    const o = { id: n.id, title: n.title, body: n.body, owner: n.owner, owner_name: (store.user(n.owner) || {}).name || 'Unknown', shared: n.shared,
      updated: n.updated, words: n.body.trim() ? n.body.trim().split(/\s+/).length : 0 };
    if (flags.ff_tags) o.tags = n.tags || [];
    return o;
  };
  function noteInput(b, flags, partial) {
    const out = {};
    if (!partial || 'title' in b) { if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 120) return { error: 'title must be 1-120 characters' }; out.title = b.title.trim(); }
    if (!partial || 'body' in b) { if (typeof (b.body ?? '') !== 'string' || (b.body || '').length > 20000) return { error: 'body must be text up to 20000 characters' }; out.body = b.body || ''; }
    if (!partial || 'shared' in b) { if (b.shared != null && typeof b.shared !== 'boolean') return { error: 'shared must be true or false' }; out.shared = !!b.shared; }
    if (flags.ff_tags && 'tags' in b) {
      if (!Array.isArray(b.tags) || b.tags.length > 8 || !b.tags.every(t => typeof t === 'string' && TAG_RE.test(t))) return { error: 'tags must be up to 8 lower-case words (a-z, 0-9, -)' };
      out.tags = [...new Set(b.tags)];
    }
    return { value: out };
  }

  async function api(req, res, route) {
    const s = session(req);
    if (!s) return json(res, 401, { error: 'signed_out' });
    const flags = store.flags();
    const seg = route.split('/').filter(Boolean);
    const m = req.method;
    const write = m === 'POST' || m === 'PATCH';
    if (write && req.headers['x-csrf-token'] !== s.csrf) return json(res, 403, { error: 'csrf' });
    const D = store.data;

    if (seg[0] === 'me' && seg.length === 1) {
      if (m !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      const u = store.user(s.user);
      return json(res, 200, { user: { id: u.id, name: u.name, email: u.email, role: s.role, title: u.title }, workspace: D.workspace, csrf: s.csrf, home: HOME[s.role] });
    }
    if (seg[0] === 'flags' && seg.length === 1) {
      if (m !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      return json(res, 200, Object.fromEntries(Object.keys(FLAGS).map(k => [k, flags[k]])));
    }
    if (seg[0] === 'notes' && seg.length === 1) {
      if (m === 'GET') {
        const list = D.notes.filter(n => s.role !== 'guest' || n.shared).sort((a, b) => b.updated.localeCompare(a.updated));
        return json(res, 200, { notes: list.map(n => noteOut(n, flags)) });
      }
      if (m === 'POST') {
        if (s.role === 'guest') return json(res, 403, { error: 'forbidden' });
        const v = noteInput(await readBody(req), flags, false);
        if (v.error) return json(res, 400, { error: 'invalid', message: v.error });
        const id = 'n' + (D.notes.reduce((a, n) => Math.max(a, Number(n.id.slice(1)) || 0), 0) + 1);
        const note = { id, tags: [], ...v.value, owner: s.user, updated: new Date().toISOString() };
        D.notes.push(note); store.save();
        return json(res, 201, { note: noteOut(note, flags) });
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (seg[0] === 'notes' && seg.length === 2) {
      const note = D.notes.find(n => n.id === seg[1]);
      if (!note || (s.role === 'guest' && !note.shared)) return json(res, 404, { error: 'not_found' });
      if (m === 'GET') return json(res, 200, { note: noteOut(note, flags) });
      if (m === 'PATCH') {
        if (s.role === 'guest') return json(res, 403, { error: 'forbidden' });
        const v = noteInput(await readBody(req), flags, true);
        if (v.error) return json(res, 400, { error: 'invalid', message: v.error });
        Object.assign(note, v.value, { updated: new Date().toISOString() }); store.save();
        return json(res, 200, { note: noteOut(note, flags) });
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (seg[0] === 'team' && seg.length === 1) {
      if (m !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      if (s.role === 'guest') return json(res, 403, { error: 'forbidden' });
      return json(res, 200, { team: D.team });
    }
    if (seg[0] === 'settings' && seg.length === 1) {
      // DEMO BUG 3 (intentional, see DEMO-BUGS.md): settings are admin-only, but only guests are refused here,
      // so a member gets 200 instead of 403. The correct check is `if (s.role !== 'admin')`.
      if (s.role === 'guest') return json(res, 403, { error: 'forbidden' });
      if (m === 'GET') return json(res, 200, { settings: D.settings });
      if (m === 'PATCH') {
        if (s.role !== 'admin') return json(res, 403, { error: 'forbidden' });
        const b = await readBody(req), st = { ...D.settings };
        if ('workspace' in b) { if (typeof b.workspace !== 'string' || !b.workspace.trim() || b.workspace.length > 60) return json(res, 400, { error: 'invalid', message: 'Workspace name must be 1-60 characters' }); st.workspace = b.workspace.trim(); }
        if ('reply_to' in b) { if (typeof b.reply_to !== 'string' || (b.reply_to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.reply_to))) return json(res, 400, { error: 'invalid', message: 'Reply-to must be an email address' }); st.reply_to = b.reply_to.trim(); }
        if ('default_visibility' in b) { if (!['team', 'guests'].includes(b.default_visibility)) return json(res, 400, { error: 'invalid', message: 'Unknown visibility' }); st.default_visibility = b.default_visibility; }
        if ('retention_days' in b) { if (![30, 90, 365].includes(b.retention_days)) return json(res, 400, { error: 'invalid', message: 'Retention must be 30, 90 or 365 days' }); st.retention_days = b.retention_days; }
        if ('weekly_digest' in b) { if (typeof b.weekly_digest !== 'boolean') return json(res, 400, { error: 'invalid', message: 'Weekly digest must be on or off' }); st.weekly_digest = b.weekly_digest; }
        D.settings = st; D.workspace = st.workspace; store.save();
        return json(res, 200, { settings: st });
      }
      return json(res, 405, { error: 'method_not_allowed' });
    }
    if (seg[0] === 'tags' && seg.length === 1) {
      if (!flags.ff_tags) return json(res, 404, { error: 'not_enabled' });
      if (m !== 'GET') return json(res, 405, { error: 'method_not_allowed' });
      const counts = {};
      for (const n of D.notes) if (s.role !== 'guest' || n.shared) for (const t of n.tags || []) counts[t] = (counts[t] || 0) + 1;
      return json(res, 200, { tags: Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })) });
    }
    return json(res, 404, { error: 'not_found' });
  }

  // ------------------------------------------------------------------ router
  async function handle(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD' && !p.startsWith('/api/')) return json(res, 405, { error: 'method_not_allowed' });

    if (p === '/') { const s = session(req); return redirect(res, s ? '/app/' + HOME[s.role] : '/dev/'); }
    if (p === '/favicon.ico') return serveFile(res, path.join(appDir, 'assets/img/favicon.svg'));
    if (p === '/dev' || p === '/app' || p === '/app/') return redirect(res, p === '/dev' ? '/dev/' : '/');
    if (p === '/dev/') return send(res, 200, TYPES['.html'], devHome(url.searchParams.get('reset') ? 'Demo data was reset.' : ''));
    const login = /^\/dev\/login\/([a-z]+)$/.exec(p);
    if (login) {
      const role = login[1];
      if (!ROLES.includes(role)) return json(res, 404, { error: 'unknown_role', roles: ROLES });
      let next = String(url.searchParams.get('next') || '').replace(/^\/+/, '').replace(/^app\//, '');
      const [nextPage, nextQs] = next.split('?');
      const qs = nextQs && /^[A-Za-z0-9=&_%.-]*$/.test(nextQs) ? '?' + nextQs : '';
      const to = nextPage && SAFE_PAGE.test(nextPage) ? '/app/' + nextPage + qs : '/app/' + HOME[role];
      return redirect(res, to, { 'Set-Cookie': signIn(role) });
    }
    if (p === '/dev/logout') return redirect(res, '/dev/', { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
    if (p === '/dev/reset') {
      store.seed();
      if (/application\/json/.test(req.headers.accept || '') || !/text\/html/.test(req.headers.accept || '')) return json(res, 200, { ok: true, reset: new Date().toISOString() });
      return redirect(res, '/dev/?reset=1');
    }
    if (p.startsWith('/api/')) return api(req, res, p.slice(5));
    if (p.startsWith('/assets/')) return serveFile(res, path.join(appDir, decodeURIComponent(p)));
    const app = /^\/app\/(.+)$/.exec(p);
    if (app) {
      const rel = app[1];
      if (!SAFE_PAGE.test(rel)) return notFound(res);
      const s = session(req);
      if (!s) return redirect(res, '/dev/');
      if (rel.split('/')[0] !== s.role) return redirect(res, '/app/' + HOME[s.role]);   // folder = the role allowed to open it
      return serveFile(res, path.join(appDir, 'app', rel));
    }
    return notFound(res);
  }

  const server = http.createServer((req, res) => {
    const t = Date.now();
    if (log) res.on('finish', () => console.log(`${req.method} ${req.url.split('?')[0]} ${res.statusCode} ${Date.now() - t}ms`));
    handle(req, res).catch(e => { if (!res.headersSent) json(res, e.status || 500, { error: e.status ? 'bad_request' : 'server_error' }); else res.end(); });
  });
  server.store = store;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT) || 4400;
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Acme Notes running at http://127.0.0.1:${port}/dev/  (data: ${server.store.dir})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
