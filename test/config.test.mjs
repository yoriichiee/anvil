import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeConfig, findConfig, resolveRoot, fill, fillCommand, loginPath, pagePath, pagePrefix, roleForPage,
  passLine, fixLine, commandRegex, isFixBody, laneForArea, signature, uiConfig, ConfigError } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAMPLE = path.join(ROOT, 'examples', 'anvil.config.example.json');

test('the example config loads and keeps its values', () => {
  const c = loadConfig(EXAMPLE);
  assert.equal(c.name, 'Acme Notes');
  assert.deepEqual(c.roles.list, ['admin', 'member', 'guest']);
  assert.equal(c.app.origin, 'http://127.0.0.1:4400');
  assert.equal(c.review.pass_command, '/pass {lane}');
  assert.equal(c._file, path.resolve(EXAMPLE));
});

test('defaults fill missing sections; optional checks stay off', () => {
  const c = normalizeConfig({ name: 'X', app: { origin: 'http://127.0.0.1:5000/' }, roles: { list: ['user'] } });
  assert.equal(c.app.origin, 'http://127.0.0.1:5000');
  assert.equal(c.data_dir, '.qa');
  assert.equal(c.server.port, 8795);
  assert.equal(c.build, null);
  assert.equal(c.tests, null);
  assert.equal(c.flags, null);
  assert.equal(c.review.default_lane, 'app');
  assert.equal(c.github.testing_label, 'needs-testing');
});

test('bad configs are rejected with a clear message', () => {
  const bad = [
    [{ roles: { list: [] } }, /roles.list/],
    [{ roles: { list: ['anon'] } }, /reserved/],
    [{ app: { page_path: '/app/' } }, /\{page\}/],
    [{ app: { login_path: '/login' } }, /\{role\}/],
    [{ app: { origin: 'localhost' } }, /app.origin/],
    [{ github: { repo: 'nope' } }, /owner\/name/],
    [{ tests: { command: ['x'], summary_regex: '(' } }, /not a valid regex/],
    [{ tests: {} }, /tests.command/],
    [{ review: { pass_command: '/ok' } }, /\{lane\}/],
    [{ review: { signature: 'by me' } }, /\{tester\}/],
    [{ data_dir: '../x' }, /data_dir/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalizeConfig(raw), e => e instanceof ConfigError && re.test(e.message), JSON.stringify(raw));
});

test('loadConfig reports unreadable and invalid JSON files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-cfg-'));
  try {
    assert.throws(() => loadConfig(path.join(dir, 'missing.json')), ConfigError);
    fs.writeFileSync(path.join(dir, 'anvil.config.json'), '﻿{ "name": "Y", "roles": { "list": ["a"] } }');
    assert.equal(loadConfig(path.join(dir, 'anvil.config.json')).name, 'Y');   // BOM tolerated
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ nope');
    assert.throws(() => loadConfig(path.join(dir, 'bad.json')), /not valid JSON/);
    fs.mkdirSync(path.join(dir, 'sub', 'deeper'), { recursive: true });
    assert.equal(findConfig(path.join(dir, 'sub', 'deeper')), path.join(dir, 'anvil.config.json'));
    assert.equal(resolveRoot({ start: path.join(dir, 'sub'), configFile: path.join(dir, 'anvil.config.json') }), dir);
    assert.equal(resolveRoot({ root: path.join(dir, 'sub') }), path.join(dir, 'sub'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('templates', () => {
  assert.equal(fill('a {x} {y} {missing}', { x: 1, y: 'b' }), 'a 1 b {missing}');
  assert.equal(fill('{env:ANVIL_T1}', {}, { ANVIL_T1: 'v' }), 'v');
  assert.equal(fill('{env:ANVIL_T2|dflt}', {}, {}), 'dflt');
  assert.equal(fill('{tmp}'), os.tmpdir());
  assert.equal(fill('{env:NOPE|{tmp}/d}', {}, {}), os.tmpdir() + '/d');
  const c = fillCommand(['php', '{root}/t.php', '{filter}'], { root: '/r', filter: '' });
  assert.deepEqual(c, { shell: false, cmd: 'php', args: ['/r/t.php'] });
  const s = fillCommand('npm test -- {filter}', { filter: 'a b' });
  assert.equal(s.shell, true); assert.equal(s.cmd, 'npm test -- "a b"');
});

test('sign-in, page paths and roles', () => {
  const c = loadConfig(EXAMPLE);
  assert.equal(loginPath(c, 'member', ''), '/dev/login/member');
  assert.equal(loginPath(c, 'member', 'member/notes.html'), '/dev/login/member?next=member%2Fnotes.html');
  const c2 = normalizeConfig({ app: { login_path: '/login?next={page}&as={role}' }, roles: { list: ['a'] } });
  assert.equal(loginPath(c2, 'a', ''), '/login?as=a');
  assert.equal(loginPath(normalizeConfig({ roles: { list: ['a'] } }), 'a', 'x'), null);
  assert.equal(pagePath(c, 'member/notes.html'), '/app/member/notes.html');
  assert.equal(pagePrefix(c), '/app/');
  assert.equal(roleForPage(c, 'guest/shared.html'), 'guest');
  assert.equal(roleForPage(c, 'settings/x.html'), 'admin');
  assert.equal(roleForPage(c, 'other/x.html'), 'member');
  assert.deepEqual(uiConfig(c).roles, ['admin', 'member', 'guest']);
});

test('review commands', () => {
  const c = normalizeConfig({ roles: { list: ['a'] }, review: { lanes: ['web'], pass_command: 'LGTM {lane}', fix_command: 'CHANGES {lane}' } });
  assert.equal(passLine(c, 'web'), 'LGTM web');
  assert.equal(fixLine(c, 'web'), 'CHANGES web');
  assert.ok(commandRegex(c, 'web').test('CHANGES web 2 issues'));
  assert.ok(commandRegex(c, 'web').test('LGTM web'));
  assert.ok(!commandRegex(c, 'web').test('LGTM webx'));
  assert.ok(isFixBody(c, 'web', '  CHANGES web: x'));
  assert.equal(laneForArea(c, 'phone'), 'ui');
  assert.equal(laneForArea(c, 'roles'), 'app');
  assert.equal(signature(c, 'sam'), 'Tested with Anvil · Claude for @sam');
});
