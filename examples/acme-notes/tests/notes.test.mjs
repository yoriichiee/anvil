// Notes CRUD through the API, including the CSRF header the pages send.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

let app, member;
before(async () => { app = await startApp(); member = await app.signIn('member'); });
after(async () => { await app.close(); });

test('a write without the CSRF header is refused', async () => {
  const r = await app.call(member.cookie, 'notes', { method: 'POST', body: { title: 'No token' } });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, 'csrf');
});

test('member creates, reads and edits a note', async () => {
  const created = await app.call(member.cookie, 'notes', { method: 'POST', csrf: member.csrf, body: { title: 'Standup notes', body: 'Ship the editor fix today.', shared: false } });
  assert.equal(created.status, 201);
  const id = created.data.note.id;
  assert.equal(created.data.note.owner_name, 'Sam Lee');
  assert.equal(created.data.note.words, 5);

  const read = await app.call(member.cookie, 'notes/' + id);
  assert.equal(read.status, 200);
  assert.equal(read.data.note.title, 'Standup notes');

  const edited = await app.call(member.cookie, 'notes/' + id, { method: 'PATCH', csrf: member.csrf, body: { title: 'Standup notes (Mon)', shared: true } });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.note.title, 'Standup notes (Mon)');
  assert.equal(edited.data.note.shared, true);
  assert.equal(edited.data.note.body, 'Ship the editor fix today.');

  const list = await app.call(member.cookie, 'notes');
  assert.equal(list.data.notes[0].id, id, 'newest note first');
});

test('invalid input is refused with a message', async () => {
  const r = await app.call(member.cookie, 'notes', { method: 'POST', csrf: member.csrf, body: { title: '   ' } });
  assert.equal(r.status, 400);
  assert.match(r.data.message, /title/);
});

test('guest cannot create notes', async () => {
  const guest = await app.signIn('guest');
  const r = await app.call(guest.cookie, 'notes', { method: 'POST', csrf: guest.csrf, body: { title: 'Hello' } });
  assert.equal(r.status, 403);
});
