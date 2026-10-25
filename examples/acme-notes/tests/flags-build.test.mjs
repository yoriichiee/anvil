// Feature flag ff_tags and the build manifest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from './helpers.mjs';
import { build } from '../build.mjs';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.close(); });

test('ff_tags off: /api/tags answers 404 not_enabled and notes carry no tags', async () => {
  app.setFlag('ff_tags', false);
  const s = await app.signIn('member');
  const r = await app.call(s.cookie, 'tags');
  assert.equal(r.status, 404);
  assert.equal(r.data.error, 'not_enabled');
  assert.equal((await app.call(s.cookie, 'notes')).data.notes[0].tags, undefined);
});

test('ff_tags on: /api/tags lists tags with counts', async () => {
  app.setFlag('ff_tags', true);
  const s = await app.signIn('member');
  const r = await app.call(s.cookie, 'tags');
  assert.equal(r.status, 200);
  assert.ok(r.data.tags.some(t => t.tag === 'planning' && t.count === 2));
  assert.deepEqual((await app.call(s.cookie, 'flags')).data, { ff_tags: true });
});

test('build copies public/ and writes a manifest of every page', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acme-notes-build-'));
  try {
    const r = build(out);
    const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(Object.keys(m.pages).sort(), ['admin/dashboard.html', 'admin/settings.html', 'admin/team.html', 'guest/shared.html', 'member/note.html', 'member/notes.html']);
    assert.equal(m.pages['member/notes.html'].role, 'member');
    assert.equal(r.pages, 6);
    assert.ok(fs.existsSync(path.join(out, 'assets/css/app.css')));
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
