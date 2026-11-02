import test from 'node:test';
import assert from 'node:assert/strict';
import { registerChecks, unregisterCheck, listChecks, runChecks, skip } from '../src/checks/index.mjs';
import { backendProbe } from '../src/checks/backend.mjs';
import { jwt } from './fake-secrets.mjs';

const ctx = (extra = {}) => ({ log() {}, crawl: () => Promise.reject(skip('no browser')), locate: () => null, opts: {}, ...extra });

test('built-in checks are listed; add-on checks register, run, and can be removed', async () => {
  const ids = listChecks().map(c => c.id);
  for (const id of ['page-load', 'overflow', 'axe', 'role-access', 'secret-scan', 'supabase-firebase']) assert.ok(ids.includes(id), id);
  registerChecks([{ id: 'addon.demo:has-title', name: 'Demo add-on', run: async () => [{ severity: 'low', title: 'No <title>', evidence: { selector: 'head' }, why: 'w', fix: 'f', confidence: 'proven' }] }]);
  assert.throws(() => registerChecks({ id: 'axe', name: 'x', run() {} }), /built-in/);
  assert.throws(() => registerChecks({ id: 'Bad Id', name: 'x', run() {} }), /lower-case/);
  const r = await runChecks(ctx(), { only: ['addon.demo:has-title'] });
  assert.equal(r.checksRun[0].status, 'warn');
  assert.equal(r.findings[0].check, 'addon.demo:has-title');
  assert.match(r.findings[0].id, /^f-addon\.demo:has-title-/);
  unregisterCheck('addon.demo:has-title');
  assert.ok(!listChecks().some(c => c.id === 'addon.demo:has-title'));
});

test('a skipped check lands in notChecked; a crashing check becomes warn, never fails the run', async () => {
  registerChecks([{ id: 't-skip', name: 'Skipper', run: async () => { throw skip('nothing to do'); } }, { id: 't-crash', name: 'Crasher', run: async () => { throw new Error('kaboom'); } }]);
  const r = await runChecks(ctx(), { only: ['t-skip', 't-crash'] });
  assert.deepEqual(r.checksRun.map(c => c.status), ['skip', 'warn']);
  assert.deepEqual(r.notChecked.map(n => n.what), ['Skipper', 'Crasher']);
  assert.match(r.notChecked[1].why, /kaboom/);
  unregisterCheck('t-skip'); unregisterCheck('t-crash');
});

test('browser checks skip cleanly without a URL', async () => {
  const r = await runChecks(ctx(), { only: ['page-load', 'overflow', 'axe', 'role-access'] });
  assert.deepEqual(r.checksRun.map(c => c.status), ['skip', 'skip', 'skip', 'skip']);
});

test('Supabase probe: rows with the anon key = proven open-table finding; service_role never used; only GETs', async () => {
  const anon = jwt({ iss: 'supabase', role: 'anon' }), service = jwt({ iss: 'supabase', role: 'service' + '_role' });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/rest/v1/profiles')) return new Response(JSON.stringify([{ id: 1, email: 'x@y.z' }]), { status: 200 });
    if (url.includes('/rest/v1/notes')) return new Response('[]', { status: 200 });
    return new Response('{}', { status: 401 });
  };
  const source = { analysis: { supabase: { urls: ['https://abcdefghijklmnopqrst.supabase.co'], anonKeys: [service, anon], tables: [{ name: 'profiles', file: 'src/a.js', line: 3 }, { name: 'notes', file: 'src/b.js', line: 9 }] }, firebase: { projectIds: [], databaseURLs: [], apiKeys: [], collections: [] } } };
  const r = await backendProbe.run(ctx({ source, fetch: fetchImpl }));
  assert.equal(r.findings.length, 1);
  const f = r.findings[0];
  assert.equal(f.severity, 'high'); assert.equal(f.confidence, 'proven'); assert.equal(f.evidence.file, 'src/a.js');
  assert.doesNotMatch(JSON.stringify(r), /x@y\.z/, 'row values never stored');
  assert.ok(calls.every(c => c.init.method === 'GET'));
  assert.ok(calls.every(c => c.init.headers.apikey === anon), 'only the anon key is used');
  assert.ok(r.notChecked.some(n => /0 rows/.test(n.why)));
});

test('Supabase probe skips when no config is in the code', async () => {
  const source = { analysis: { supabase: { urls: [], anonKeys: [], tables: [] }, firebase: { projectIds: [], databaseURLs: [], apiKeys: [], collections: [] } } };
  const r = await runChecks(ctx({ source }), { only: ['supabase-firebase'] });
  assert.equal(r.checksRun[0].status, 'skip');
  assert.match(r.notChecked[0].why, /No Supabase or Firebase config/);
});
