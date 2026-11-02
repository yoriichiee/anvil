import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.ANVIL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-home-'));
const { parseTarget, isLocalHost, checkOwnership, ownerToken, extractZip, startPlan, serveStatic } = await import('../src/target.mjs');
const { scan } = await import('../src/scan.mjs');

test('parseTarget: url, host:port, folder, zip, errors', () => {
  assert.equal(parseTarget('http://localhost:3000/app').kind, 'url');
  assert.equal(parseTarget('localhost:5173').url, 'http://localhost:5173/');
  assert.equal(parseTarget(os.tmpdir()).kind, 'dir');
  assert.throws(() => parseTarget('https://user:pw@example.com'), /user name/);
  assert.throws(() => parseTarget(path.join(os.tmpdir(), 'nope-' + Date.now())), /not found/);
});

test('local addresses are exempt from ownership proof', () => {
  for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]', 'app.localhost']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['example.com', '10.0.0.5', '192.168.1.2']) assert.equal(isLocalHost(h), false, h);
});

test('remote URL needs /.well-known/anvil.txt with this machine\'s token', async () => {
  const origin = 'https://shop.example.com';
  assert.match((await checkOwnership(origin, { fetchImpl: async () => { throw new Error('should not fetch'); } })).reason, /verify-owner/);
  const token = ownerToken(origin);
  const fake = body => async url => { assert.equal(url, origin + '/.well-known/anvil.txt'); return new Response(body, { status: 200 }); };
  assert.equal((await checkOwnership(origin, { fetchImpl: fake('nothing here') })).ok, false);
  assert.equal((await checkOwnership(origin, { fetchImpl: fake('# anvil\n' + token + '\n') })).ok, true);
  assert.equal((await checkOwnership(origin, { fetchImpl: async () => new Response('x', { status: 404 }) })).ok, false);
});

test('scan refuses an unverified remote URL before touching it', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-runs-'));
  let fetched = [];
  await assert.rejects(scan({ target: 'https://not-mine.example.org', out, noBrowser: true, fetchImpl: async u => { fetched.push(u); return new Response('', { status: 404 }); } }), e => e.code === 'OWNERSHIP');
  assert.ok(fetched.every(u => u.endsWith('/.well-known/anvil.txt')));
});

// minimal stored-zip writer for tests
function crc32(buf) { let c, crc = 0xFFFFFFFF; for (const b of buf) { c = (crc ^ b) & 0xFF; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
function makeZip(entries) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, text] of entries) {
    const data = Buffer.from(text), n = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, n, data); centrals.push(ch, n); off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('zip: extracts normal entries, refuses zip-slip paths', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-zip-'));
  fs.writeFileSync(path.join(d, 'ok.zip'), makeZip([['site/index.html', '<h1>hi</h1>'], ['site/js/a.js', 'x']]));
  const r = await extractZip(path.join(d, 'ok.zip'), path.join(d, 'out'));
  assert.equal(fs.readFileSync(path.join(d, 'out', 'site', 'index.html'), 'utf8'), '<h1>hi</h1>');
  assert.equal(r.entries, 2);
  fs.writeFileSync(path.join(d, 'evil.zip'), makeZip([['../evil.txt', 'pwned']]));
  await assert.rejects(extractZip(path.join(d, 'evil.zip'), path.join(d, 'out2')), /unsafe path|invalid relative path/);
  assert.equal(fs.existsSync(path.join(d, 'evil.txt')), false);
});

test('startPlan: static folder, npm project, zip code never run without --allow-scripts', () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-st-')); fs.writeFileSync(path.join(s, 'index.html'), 'hi');
  assert.equal(startPlan(s).how, 'static');
  const n = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-np-'));
  fs.writeFileSync(path.join(n, 'package.json'), JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '5' } }));
  const p = startPlan(n);
  assert.equal(p.how, 'command'); assert.equal(p.framework, 'vite'); assert.equal(p.needsInstall, true);
  assert.equal(startPlan(n, { untrusted: true }).how, 'none');
  assert.equal(startPlan(n, { untrusted: true, allowScripts: true }).how, 'command');
});

test('static server serves files read-only and blocks traversal', async () => {
  const s = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-ss-')); fs.writeFileSync(path.join(s, 'index.html'), '<p>home</p>');
  const srv = await serveStatic(s);
  try {
    assert.match(await (await fetch(srv.url)).text(), /home/);
    assert.equal((await fetch(srv.url, { method: 'POST' })).status, 405);
    assert.notEqual((await fetch(srv.url + '..%2f..%2fwindows%2fwin.ini')).status, 200);
  } finally { await srv.stop(); }
});

void zlib;
