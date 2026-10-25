// Role checks of the API. Note: there is deliberately NO test for "member cannot read settings" -
// that gap is how DEMO BUG 3 slipped through (see DEMO-BUGS.md); Anvil's access check catches it instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('signed out gets 401 from the API', async () => {
  for (const route of ['me', 'notes', 'team', 'settings']) {
    const r = await app.call(null, route);
    assert.equal(r.status, 401, route);
    assert.equal(r.data.error, 'signed_out');
  }
});

test('each role signs in and /api/me reports it with a CSRF token', async () => {
  for (const role of ['admin', 'member', 'guest']) {
    const s = await app.signIn(role);
    assert.ok(s.cookie.startsWith('acme_session='), role);
    assert.equal(s.me.user.role, role);
    assert.ok(s.csrf && s.csrf.length >= 16);
  }
});

test('guest cannot list the team, member and admin can', async () => {
  assert.equal((await app.call((await app.signIn('guest')).cookie, 'team')).status, 403);
  assert.equal((await app.call((await app.signIn('member')).cookie, 'team')).status, 200);
  const admin = await app.call((await app.signIn('admin')).cookie, 'team');
  assert.equal(admin.status, 200);
  assert.equal(admin.data.team.length, 4);
});

test('admin reads settings, guest is refused', async () => {
  assert.equal((await app.call((await app.signIn('admin')).cookie, 'settings')).status, 200);
  assert.equal((await app.call((await app.signIn('guest')).cookie, 'settings')).status, 403);
});

test('guest only sees shared notes', async () => {
  const r = await app.call((await app.signIn('guest')).cookie, 'notes');
  assert.equal(r.status, 200);
  assert.ok(r.data.notes.length > 0);
  assert.ok(r.data.notes.every(n => n.shared));
  assert.equal((await app.call((await app.signIn('guest')).cookie, 'notes/n1')).status, 404);   // n1 is not shared
});
