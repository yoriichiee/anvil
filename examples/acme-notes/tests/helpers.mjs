// Test helpers: each test file starts its own Acme Notes server on a free port with a fresh temp data folder,
// so the tests never touch a running demo or its data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { writeFlags } from '../lib/store.mjs';

export async function startApp() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-notes-test-'));
  const server = createApp({ dataDir, log: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (cookie, route, { method = 'GET', body, csrf } = {}) => {
    const headers = { Accept: 'application/json' };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + '/api/' + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null; try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
  // GET /dev/login/<role> -> the session cookie, then GET /api/me -> the CSRF token (like the real pages do)
  const signIn = async role => {
    const r = await fetch(base + '/dev/login/' + role, { redirect: 'manual' });
    const cookie = String(r.headers.get('set-cookie') || '').split(';')[0];
    const me = await call(cookie, 'me');
    return { cookie, csrf: me.data && me.data.csrf, me: me.data };
  };
  const setFlag = (name, on) => writeFlags(dataDir, { [name]: on });
  const close = () => new Promise(r => server.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); r(); }));
  return { base, call, signIn, setFlag, close, server };
}
