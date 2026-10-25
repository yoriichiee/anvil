import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, draft, facts, validateDraft, templateDraft, finalChat, REPORT_URL } from '../src/report.mjs';
import { loadConfig } from '../src/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fx = f => JSON.parse(fs.readFileSync(path.join(ROOT, 'fixtures', f), 'utf8').replace(/^﻿/, ''));
const cfg = loadConfig(path.join(ROOT, 'examples', 'anvil.config.example.json'));
const plan = fx('plan.json');

test('score: all passing, rating 5 -> final 5.0', () => {
  const s = score(plan, fx('results-pass.json'), fx('state-allworks.json'));
  assert.equal(s.decision, 'final');
  assert.equal(s.overall, 5);
  assert.deepEqual(s.blockers, []);
  assert.deepEqual(s.manual, { works: 3, broken: 0, unsure: 0, open: 0 });
  assert.equal(s.auto.pass, 8);
});

test('score: blocker + broken manual -> fix, formula applied', () => {
  const s = score(plan, fx('results-blocker.json'), fx('state-unsure.json'));
  assert.equal(s.decision, 'fix');
  assert.deepEqual(s.blockers.map(b => b.id), ['R-r1']);
  // stability: flake 0.75 + pass 1 (preexisting left out) -> 4.4; works: pass 1 + unsure 0.5 -> 3.8; roles: fail 0 + works 1 -> 2.5;
  // phone: warn 0.5 + broken 0 -> 1.3; laptop: nothing -> 5
  assert.equal(s.areas.stability.score, 4.4);
  assert.equal(s.areas.works.score, 3.8);
  assert.equal(s.areas.roles.score, 2.5);
  assert.equal(s.areas.phone.score, 1.3);
  assert.equal(s.areas.laptop.score, 5);
  const mean = (4.375 + 3.75 + 2.5 + 1.25 + 5) / 5;
  assert.equal(s.overall, Math.round((0.7 * mean + 0.3 * 3) * 10) / 10);
});

test('score: open manual checks are counted as open and left out', () => {
  const s = score(plan, fx('results-pass.json'), {});
  assert.equal(s.manual.open, 3);
  assert.equal(s.overall, 5);
});

test('template draft: one comment per lane with the configured commands and a fix brief', async () => {
  const d = await draft(plan, fx('results-blocker.json'), fx('state-unsure.json'), null, { cfg, claude: false });
  assert.equal(d.source, 'template');
  assert.deepEqual(d.comments.map(c => c.lane), ['ui', 'app']);
  for (const c of d.comments) {
    assert.match(c.body, /^\/(pass|fix) (ui|app)/);
    assert.ok(c.body.includes('Tested with Anvil · Claude for @testerlogin'));
    assert.ok(!c.body.includes('SECRET DETAIL'));
  }
  const app = d.comments.find(c => c.lane === 'app').body;
  assert.match(app, /^\/fix app /);
  assert.ok(app.includes('Fix brief for Claude'));
  assert.ok(app.includes('anvil-run --pr 999 --only=R-r1'));
  assert.ok(d.chat_md.includes(REPORT_URL));
});

test('auto-check issues map back to the plan page and role', () => {
  const f = facts(plan, fx('results-blocker.json'), fx('state-unsure.json'), null, ['src/notes/list.js', 'README.md'], cfg);
  const lay = f.per.ui.issues.find(i => i.id === 'L-member-notes.html-member');
  assert.equal(lay.page, 'member/notes.html');
  assert.equal(lay.role, 'member');
  assert.deepEqual(lay.files_hint, ['src/notes/list.js']);
});

test('custom review commands and validation of a Claude draft', async () => {
  const c2 = { ...cfg, review: { ...cfg.review, pass_command: 'LGTM {lane}', fix_command: 'CHANGES {lane}' } };
  const f = facts(plan, fx('results-pass.json'), fx('state-allworks.json'), null, [], c2);
  const base = templateDraft(f);
  assert.ok(base.comments.every(c => c.body.startsWith('LGTM ')));
  assert.equal(validateDraft(base, f, base), null);
  const changed = { ...base, comments: base.comments.map(c => ({ ...c, body: c.body.replace(/^LGTM/, 'CHANGES') })) };
  assert.match(validateDraft(changed, f, base), /first line changed/);
  assert.equal(finalChat('see ' + REPORT_URL, ['https://example.test/1']), 'see https://example.test/1\n');
});
