# Acme Notes: the deliberate demo bugs

Acme Notes ships with **exactly four bugs on purpose**, so Anvil has something real to find. Each one is marked
`DEMO BUG <n>` in the code. Everything else should be clean: no other console errors, CSP blocks, failed API calls,
sideways scrolling or missing labels. If Anvil reports anything that is not in this list, that is a real bug in the demo.
Please open an issue for it.

There is also **one deliberately flaky test** (see the end of this file).

| # | Where | What Anvil reports | Check | Fix (do not apply it in the demo) |
|---|---|---|---|---|
| 1 | `member/notes.html` (CSS `.notes-table` in `public/assets/css/app.css`) | Phone 390: page is ~853 px wide and scrolls sideways (~869 px with `ff_tags` on) | `L-member-notes.html-member` → `warn` | Wrap the table in `overflow-x: auto`, or switch to cards below 640 px |
| 2 | `guest/shared.html`: the hero `<img>` | axe `image-alt: 1` | `X-guest-shared.html` → `warn` | Add `alt=""` (the image is decorative) |
| 3 | `GET /api/settings` in `server.mjs` | A member gets **200** instead of 403 | `R-r2` in `.anvil/plan.example.json` → `fail`, blocker | `if (s.role !== 'admin') return 403` |
| 4 | `admin/settings.html` (`public/assets/js/settings.js`) | `console.error: settings: field "reply_to" is empty` on every load | `P-admin-settings.html-admin` → `fail` (not a blocker) | Show a hint, or nothing (the field is optional) |

Notes:
- Bug 4 only shows while "Reply-to email" is empty, which is how the seed data starts. If you save an address, the
  error goes away until you reset the demo (`/dev/reset`).
- Bug 3 slipped through because `tests/api-roles.test.mjs` has no "member cannot read settings" test. That gap is
  part of the story.
- Bug 1 shows up with both values of `ff_tags` (turning the flag on adds a Tags column, which makes the table wider).
- On a 1440 px laptop, `member/notes.html` fits. Bug 1 only shows on the phone.

## The flaky test

`tests/flaky.test.mjs` fails about 50% of the time **on purpose**. The comment at the top of the file says so. When
it fails, `node run-tests.mjs` prints `RESULT: 13 tests, 1 failed, ... (flaky.test.mjs)`. Anvil then re-runs that
one file (`node run-tests.mjs flaky.test.mjs`). If the re-run passes, Anvil reports the test as `flake` instead of
a blocker. If the re-run also fails (about 1 run in 4), Anvil reports it as a failing test, which is also a fair
demo.
