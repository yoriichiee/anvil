// node --test test/build-index.test.mjs   (zero dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, compareWithPrevious, serialize } from '../scripts/build-index.mjs';
import { lintRegex } from '../scripts/pack-validate.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempRepo(packs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-registry-test-'));
  for (const [rel, body] of Object.entries(packs)) {
    const f = path.join(dir, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body, null, 2) + '\n');
  }
  return dir;
}
const seed = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'packs', id, '0.1.0', 'anvil-addon.json'), 'utf8'));

test('every pack in packs/ is valid and index.json is up to date', () => {
  const { index, errors } = buildIndex(ROOT);
  assert.deepEqual(errors, []);
  assert.ok(index.packs.length >= 3);
  assert.equal(fs.readFileSync(path.join(ROOT, 'index.json'), 'utf8'), serialize(index), 'run: node scripts/build-index.mjs');
  for (const p of index.packs) for (const v of p.versions) {
    assert.match(v.sha256, /^[a-f0-9]{64}$/);
    assert.equal(v.path, `packs/${p.id}/${v.version}/anvil-addon.json`);
  }
});

test('folder layout, schema and lint problems fail the build', () => {
  const good = seed('auth-pages');
  const post = seed('supabase-rls');
  post.checks[2].match.method = 'POST';
  const redos = seed('stripe-checkout');
  redos.checks[0].match.regex = '(\\w+\\s?)+$';
  const dir = tempRepo({
    'packs/auth-pages/0.1.0/anvil-addon.json': good,
    'packs/auth-pages/0.1.0/run.js': 'console.log(1)',
    'packs/auth-pages/0.2.0/anvil-addon.json': good,               // version does not match folder
    'packs/supabase-rls/0.1.0/anvil-addon.json': post,
    'packs/stripe-checkout/0.1.0/anvil-addon.json': redos,
    'packs/crlf/0.1.0/anvil-addon.json': JSON.stringify({ ...good, id: 'crlf' }, null, 2).replace(/\n/g, '\r\n'),
  });
  const { errors } = buildIndex(dir);
  const all = errors.join('\n');
  assert.match(all, /run\.js: not allowed/);
  assert.match(all, /does not match folder "0\.2\.0"/);
  assert.match(all, /method: must be GET or HEAD/);
  assert.match(all, /stripe-checkout.*(nested quantifiers|backtracking)/);
  assert.match(all, /CRLF/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('published versions are immutable and cannot be removed', () => {
  const { index } = buildIndex(ROOT);
  assert.deepEqual(compareWithPrevious(index, index), []);
  const changed = structuredClone(index);
  changed.packs[0].versions[0].sha256 = '0'.repeat(64);
  assert.match(compareWithPrevious(changed, index).join(), /immutable/);
  const removed = structuredClone(index);
  removed.packs.push({ id: 'gone', versions: [{ version: '1.0.0', sha256: '1'.repeat(64) }] });
  assert.match(compareWithPrevious(removed, index).join(), /cannot be removed/);
});

test('regex lint basics', () => {
  assert.deepEqual(lintRegex('whsec_[0-9a-zA-Z]{24,}'), []);
  assert.ok(lintRegex('(a+)+').length);
  assert.ok(lintRegex('(x|xy)*z').length);
});
