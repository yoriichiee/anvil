# Acme Notes: a demo app for Anvil

Acme Notes is a tiny team notes app for the fictional company **Acme Inc**. The people in it (Alex Doe, Sam Lee,
Priya Rao, Jordan Kim) and all the data are made up. It exists so you can preview Anvil and try it against a
small, real app. It has three roles, a JSON API with role checks, a feature flag, a build step, a test suite, and
**four deliberate bugs** for Anvil to find ([DEMO-BUGS.md](DEMO-BUGS.md)).

Zero dependencies: Node 20 or newer, nothing to install.

## Run it

```sh
cd examples/acme-notes
node server.mjs                 # http://127.0.0.1:4400/dev/   (PORT=5000 node server.mjs to change the port)
```

It binds to 127.0.0.1 only. The data lives in `<os temp>/acme-notes-data` (set `ACME_DATA_DIR` to change it). The
data is re-seeded every time the server starts.

### Sign in (demo links, no passwords)

| Role | Who | Link |
|---|---|---|
| admin | Alex Doe | http://127.0.0.1:4400/dev/login/admin?next=admin/dashboard.html |
| member | Sam Lee | http://127.0.0.1:4400/dev/login/member?next=member/notes.html |
| guest | Jordan Kim | http://127.0.0.1:4400/dev/login/guest?next=guest/shared.html |

- `GET /dev/` lists the roles. It is also the health check.
- `GET /dev/reset` puts the data back to the seed. A browser is sent back to `/dev/`; tools get `{"ok":true}`.
- `GET /dev/logout` signs you out. Signed-out visitors who open an app page are sent to `/dev/`.

### Pages (`/app/<folder>/<page>.html`; the folder is the role allowed to open it)

| Page | Role | What it shows | API it calls |
|---|---|---|---|
| `admin/dashboard.html` | admin | numbers, recent notes, team | me, flags, notes, team (+ tags when on) |
| `admin/team.html` | admin | team list with search | me, flags, team |
| `admin/settings.html` | admin | workspace settings form | me, flags, settings (PATCH on save) |
| `member/notes.html` | member | notes table (+ tags when on) | me, flags, notes (+ tags when on) |
| `member/note.html` | member | editor: new note, or `?id=n2` to edit | me, flags, notes/:id, POST/PATCH notes |
| `guest/shared.html` | guest | read-only cards of shared notes | me, flags, notes |

If your role does not match the folder, you are redirected to your role's home page. Every response sends a
strict CSP (`default-src 'self'`, `frame-ancestors 'none'`) and `X-Frame-Options: DENY`. The pages use external
CSS and JS files only: no inline scripts or styles.

### API (`/api/`, JSON, signed-in cookie required, otherwise 401 `signed_out`)

| Route | admin | member | guest |
|---|---|---|---|
| `GET me` (includes the `csrf` token) | 200 | 200 | 200 |
| `GET notes`, `GET notes/:id` | 200 | 200 | 200, shared notes only (others 404) |
| `POST notes`, `PATCH notes/:id` (header `X-CSRF-Token`) | 201/200 | 201/200 | 403 |
| `GET team` | 200 | 200 | 403 |
| `GET settings` | 200 | **200: DEMO BUG 3, should be 403** | 403 |
| `PATCH settings` | 200 | 403 | 403 |
| `GET flags` | 200 | 200 | 200 |
| `GET tags` | 200 if `ff_tags` is on, otherwise 404 `{"error":"not_enabled"}` | same | same |

### Feature flag, build, tests

```sh
node flags.mjs                    # flags on: (none)
node flags.mjs --on=ff_tags       # tags on notes: Tags column, tag bar, editor field, /api/tags
node flags.mjs --off=ff_tags
node build.mjs --out=dist         # copies public/ and writes dist/manifest.json (every page with its role)
ACME_APP_DIR=dist node server.mjs # serve the build instead of public/
node run-tests.mjs                # 13 tests; prints "RESULT: 13 tests, 0 failed, 1.3 s"
node --test                       # same tests with Node's own runner (on Node 20, `node --test tests/` works too)
```

Flags take effect on the next request (no restart needed). They are kept across restarts and resets.
`tests/flaky.test.mjs` fails about half the time **on purpose** (see DEMO-BUGS.md).

## The deliberate bugs

1. `member/notes.html` scrolls sideways on a 390 px phone (a wide table that does not wrap).
2. `guest/shared.html` has an image without alt text.
3. A member can read `GET /api/settings` (200 instead of 403).
4. `admin/settings.html` logs a `console.error` when a field is empty ("Reply-to email" is empty in the seed data).

Details, the matching Anvil checks, and the fixes are in [DEMO-BUGS.md](DEMO-BUGS.md). Everything else is meant to
be clean.

## Use it with Anvil

1. Start the app: `node server.mjs` (from this folder).
2. Point Anvil at this folder's config, with this folder as the repo root:
   `anvil.config.json` describes the origin, sign-in, reset, pages, API, roles, build, tests and flags. Each value is
   explained in [CONFIG-NOTES.md](CONFIG-NOTES.md).
3. Use [`.anvil/plan.example.json`](.anvil/plan.example.json) as the plan. It is a realistic plan for a fictional
   PR "#7 notes: add tags behind ff_tags". Copy it to `.qa/pr-7/plan.json` (Anvil's per-PR data folder).
4. Run the checks. You should see:
   - `A1` tests pass, or fail on `flaky.test.mjs` and then turn into `flake` after the re-run
   - `A5` build passes (`build ok: 6 pages, ... manifest.json written`)
   - `P-admin-settings.html-admin` fails (console error, bug 4); every other `P-` check passes
   - `L-member-notes.html-member` is a warn (sideways scroll, bug 1); the other `L-` checks pass
   - `X-guest-shared.html` is a warn (`image-alt`, bug 2); the other `X-` checks pass
   - `R-r2` fails as a blocker (member got 200 from settings, bug 3); `R-r1`, `r3`, `r4` and `r5` pass; `R-r6` is
     skipped (POST)
   - `F-f1` passes (`off -> 404 not_enabled, on -> 200`)
5. Reset between runs with `/dev/reset` (Anvil's "Reset demo data" button calls it).
