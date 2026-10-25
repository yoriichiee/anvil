// =====================================================================================================
//  DELIBERATE DEMO FLAKE - this test fails about 50% of the time ON PURPOSE.
//  It exists so Anvil can show how it handles a flaky test: the suite fails, Anvil re-runs this one
//  file, and when it passes the second time the result is reported as "flake" instead of a blocker.
//  Do not "fix" it. See DEMO-BUGS.md.
// =====================================================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.mjs';

test('notes list answers quickly (deliberately flaky demo test)', async () => {
  const app = await startApp();
  try {
    const s = await app.signIn('member');
    const r = await app.call(s.cookie, 'notes');
    assert.equal(r.status, 200);
    // The "timing budget" below is random on purpose: about half of the runs pretend the call was too slow.
    const pretendMs = Math.random() < 0.5 ? 40 : 400;
    assert.ok(pretendMs < 250, `notes list took ${pretendMs} ms (budget 250 ms) - deliberate demo flake, re-run it`);
  } finally { await app.close(); }
});
