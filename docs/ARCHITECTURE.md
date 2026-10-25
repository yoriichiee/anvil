# Anvil architecture and file contract

Anvil is a local QA co-pilot for one pull request of a web app. A tester says **start anvil** in Claude Code (skill
`skill/anvil/SKILL.md`). Claude prepares the repo, writes `plan.json`, starts the app under test and the Anvil server.
From then on the tester works only in Anvil (`http://127.0.0.1:8795/anvil/`). Anvil runs only **reliable** automatic
checks (facts from tests, the server and the browser - never AI judgement), shows a manual checklist with the app
running inside Anvil's Test view, then a completion screen with a rating and one button that posts the report on the
PR (`gh pr comment`) and writes a short chat note.

Everything is plain Node 20 ESM (no build step, no framework). Dependencies: `playwright-core` and `axe-core` only.
The browser is the installed Chrome or Edge (never downloaded). The engine is generic; every project detail lives in
`anvil.config.json` at the root of the repo under test (schema: `schemas/anvil.config.schema.json`).

```
 tester ──► Claude Code ── skill/anvil ──► plan.json ─┐
                                                      ▼
            browser ◄──── src/server.mjs (127.0.0.1:8795) ──spawns──► src/run.mjs ──► results.json, shots/
              │  /anvil/*  dashboard + API + SSE            │                │
              │  /*        reverse proxy ─────────────────► app under test ◄─┘ (headless Chrome, API GETs,
              ▼                                                                 test/build/flag commands)
       Complete ──► src/report.mjs (score, template, optional `claude -p`) ──► gh pr comment, chat note
```

## Files

| File | Purpose |
|---|---|
| `src/config.mjs` | Loads and validates `anvil.config.json`, fills defaults, template helpers (`fill`, `fillCommand`, `loginPath`, `pagePath`), review-command helpers |
| `src/lib.mjs` | Browser helpers (`launch`, `makeLib(cfg, root)` -> `roleContext`, `watch`, `openPage`, `screenshot`, `appUp`, `manifestPages`), JSON read/write |
| `src/run.mjs` (`anvil-run`) | Runs the automatic checks, writes `results.json` + screenshots, JSON lines on stdout |
| `src/server.mjs` (`anvil-server`) | HTTP server, API, SSE, reverse proxy, spawns `run.mjs`, owns `state.json` |
| `src/report.mjs` | Scoring, report text (template + validated Claude rewrite), chat note, contact sheet |
| `dashboard/` | The Anvil UI (`index.html`, `app.css`, `app.js`, `mock.json` for `?mock=1`) |
| `schemas/` | JSON Schemas for `plan.json` and `anvil.config.json` |
| `skill/anvil/SKILL.md`, `skill/fix-pr/SKILL.md` | Claude Code skills for testers and developers |
| `fixtures/` | Sample plan/results/state for tests, `fake-run.mjs` (a slow stand-in runner for server tests) |

Per-PR data folder: `<data_dir>/pr-<n>/` (default `.qa/pr-<n>/`, git-ignore it): `plan.json` (Claude), `results.json`
(runner), `state.json` (server), `shots/*.png`, `build/` (A5 output), `run.log`, `report.md`, `chat-pr<n>.md`,
`screens.png`, `server.log`.

## Root and config discovery
- Config: `--config <file>`, else `ANVIL_CONFIG`, else `anvil.config.json` in the current folder or a parent.
- Repo root: `--root <dir>`; else the config's folder when it contains the current folder (or sits inside it); else the
  nearest folder with `.git` above the current folder (a config kept outside the repo); else the config's folder.

## Environment
- App under test: `app.origin` (or the variable named by `app.origin_env`). Page URL = `<origin>` + `app.page_path`
  with `{page}` (plan pages are the `{page}` part). Sign-in: `<origin>` + `app.login_path` with `{role}` (and `{page}`
  for a deep link; without a page the query parameter holding `{page}` is dropped). Health: `app.health_path`.
  Reset: `app.reset_path`. API routes: `app.api_base` + route; `app.api_match` marks API calls.
- Anvil server: `server.port` (default 8795; `ANVIL_PORT` overrides), binds `127.0.0.1` only.
- Variables (the older `QA_*` names are accepted too): `ANVIL_CONFIG`, `ANVIL_PORT`, `ANVIL_DRY_RUN=1` (nothing is
  posted), `ANVIL_NO_CLAUDE=1` (template report), `ANVIL_CLAUDE_BIN`, `ANVIL_CHROME` (browser path), `ANVIL_RUNNER`
  (test hook: replaces `run.mjs`).

## plan.json (written by Claude in the skill)

```json
{
  "pr": 41, "title": "notebooks: sharing", "url": "https://github.com/acme/notes/pull/41",
  "module": "notebooks", "lanes": ["ui", "app"], "author": "alex-doe", "tester": "sam-tester",
  "owner": "jordan-owner", "commit": "8763b63", "branch": "notebooks/sharing",
  "issue": { "number": 17, "url": "..." }, "review_note": "docs/reviews/notebooks-sharing.md",
  "copilot": { "summary": ["3 short lines"], "extras": ["what the dev added on their own"],
               "security": ["vague notes"], "tips": ["one tip per manual step type"] },
  "focus": ["top things to look at for this module"],
  "pages": [ { "page": "member/notes.html", "roles": ["member"], "why": "Expected: notes list" } ],
  "access": [ { "id": "r1", "name": "Guest cannot list members", "as": "guest", "method": "GET",
                "path": "members", "expect": [401, 403] } ],
  "flags": [ { "id": "f1", "flag": "ff_sharing", "as": "member", "path": "shares" } ],
  "manual": [ { "id": "m1", "area": "works", "lane": "app", "title": "Autosave survives a reload",
                "why": "People lose text if it fails", "steps": ["Open a note", "Type, wait for Saved, reload"],
                "role": "member", "page": "member/editor.html", "good": "The text is still there", "needs": "any" } ]
}
```
Roles must be in `roles.list` (plus `anon` = signed out); lanes are free names (usually `review.lanes`); pages must
match `app.page_pattern`; flags must match `flags.flag_pattern`. `area` is one of `works`, `roles`, `phone`, `laptop`,
`stability`; `needs` is `phone`, `laptop` or `any`. `access[].path` and `flags[].path` are relative to `app.api_base`.

## results.json (written by the runner, rewritten after every check)

```json
{
  "pr": 41, "commit": "8763b63", "started": "ISO", "finished": "ISO or null", "running": true,
  "stopped": null, "current": { "id": "P-member-notes.html-member", "label": "...", "started": "ISO" },
  "checks": [ { "id": "A1", "group": "Tests", "name": "Test suite", "status": "pass",
                "detail": "128 tests, 0 failed", "area": "stability", "blocker": false, "shots": [], "ms": 1234 } ],
  "shots": [ { "file": "shots/member-notes-member-phone.png", "page": "member/notes.html", "role": "member",
               "device": "phone", "source": "auto", "at": "ISO" } ]
}
```
`status`: `pending`, `running`, `pass`, `fail`, `flake` (failed then passed on re-run), `preexisting` (also fails on the
compare ref), `warn`, `skip`, `stopped`. `blocker: true` only for: tests failing (not flake/preexisting), build failing,
a changed page not loading or throwing for an allowed role, an access check failing, a flag check failing.

| Id | Check | Needs config | Status rules |
|---|---|---|---|
| `A1` | test suite (`tests.command`) | `tests` | summary via `tests.summary_regex` (named groups `total`, `failed`, `secs`, `files`); without it, exit code only |
| `A2-<file>` | re-run of each failed file | `tests.filter_args` | `flake` if it passes |
| `A3-<file>` | failed file on `tests.compare_ref` in a temp `git worktree` | `tests.filter_args` | `preexisting` if it fails there too; a file missing there (`tests.files_dir`) = new and failing |
| `A4` | CI (`gh pr checks`) | `github.repo` | red = `fail` (not blocker), pending = `warn`, none/error = `skip`, PR 0 = `skip` |
| `A5` | build (`build.command` into `{build}`) | `build` | non-zero exit = `fail` + blocker |
| `P-<page>-<role>` | page loads on phone and laptop | `app` | blocker: HTTP >= 400, redirected away, navigation error, uncaught exception, page missing from `build.manifest`; `fail`: console errors, CSP blocks, API 4xx/5xx; `warn`: `app.sample_names` match |
| `L-<page>-<role>` | no sideways scroll at 390 px | `app` | `warn` when `scrollWidth > innerWidth + 1` |
| `X-<page>` | axe-core: image alt, button/link names, labels | `app` | `warn` only |
| `R-<id>` | `access` entry: same-origin GET as the role | `app.login_path` | status must be in `expect`; non-GET = `skip` (would change data) |
| `F-<id>` | flag off -> `flags.off_expect`, on -> 2xx, previous state restored | `flags` | `fail` + blocker |

`<page>` in ids has `/` replaced by `-`. Areas: P `works`, L `phone`, X `laptop`, R `roles`, F `works`, A* `stability`.
App down -> P/L/X/R/F are `skip` with `app.start_command` in the detail. A check whose own code crashes -> `warn`
"check could not run". A config section that is missing -> the check is `skip` with "not configured (no "x" section)".

CLI: `anvil-run --pr <n> [--config <file>] [--root <dir>] [--only=<id prefix>[,<prefix>]] [--skip-tests]
[--test-filter=<f>]`. Stdout is JSON lines: `progress` `{id,label,done,total}`, `log` `{id,text,at}` (sub-steps: test
output lines filtered by `tests.log_line_regex`, a running count every 5 s from `tests.ok_line_regex` /
`tests.fail_line_regex`, page loads, API answers, build tail), `shot` `{id,file}`, `error` `{message}` (bad plan or
config: exit 2) and a final `done` (`stopped:true` after a stop). Exit 0 even when checks fail.

**Stop**: a stop file `<data_dir>/pr-<n>/stop` (polled every 300 ms; Windows cannot signal node children) or
SIGINT/SIGTERM. A running child process (tests, build, git, gh, flag tool) is killed at once with its tree
(`taskkill /T /F` on Windows, process-group SIGKILL elsewhere) and its check becomes `stopped`; a browser step finishes
its current device. `results.json` gets `running:false`, `current:null`, `stopped` and `finished`; untouched checks
stay `pending`; the A3 worktree is removed; a flag check still restores the flag. Safety net: halt 15 s after a stop.

## state.json (written only by the server)

```json
{
  "manual": { "m1": { "answer": "works", "note": "", "shots": ["shots/manual-m1-1.png"], "at": "ISO" } },
  "overrides": { "R-r1": { "status": "pass", "note": "403 seen in the app", "at": "ISO" } },
  "include_shots": ["shots/member-notes-member-phone.png"],
  "rating": 4, "note_to_dev": "", "completed": false, "draft": null, "sent": null,
  "session": { "requests": [], "events": [] }, "tool_shots": []
}
```
`answer`: `works`, `broken`, `unsure` or null. `draft`: `{ comments:[{lane, body}], chat_md, summary, source, warning? }`.
`sent`: `{ at, decision: "final"|"fix", comments: [url], files: ["report.md", "chat-pr41.md", "screens.png"], dry_run? }`.

## Server API (JSON; 127.0.0.1 only; Host must be 127.0.0.1/localhost:<port>; `/anvil/api/*` also checks Origin)

Anvil's own paths are under `/anvil/`; `/` redirects there; **every other path is proxied to the app under test**.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/anvil/`, `/anvil/app.css`, `/anvil/app.js` | | dashboard |
| GET | `/anvil/qa/<file>` | | files from the PR data folder (no `..`) |
| GET | `/anvil/api/data` | | `{ plan, results, state, summary, env, health }` (results with overrides applied) |
| GET | `/anvil/api/events` | | SSE: `data`, `progress`, `log`, `shot`, `control` |
| GET | `/anvil/api/log?after=<n>` | | `{ lines:[{n,id,text,at,type}], next }` (run log, also in `run.log`) |
| POST | `/anvil/api/run` | `{ only? }` | `{ started }` (409 while running); clears overrides of re-run ids |
| POST | `/anvil/api/stop` | | `{ ok, wasRunning, killed? }` stop file, 10 s grace, then tree kill |
| POST | `/anvil/api/override` | `{ id, status: "pass"\|"fail"\|null, note }` | `{ ok }` - "Check it myself" |
| POST | `/anvil/api/manual` | `{ id, answer, note }` | `{ ok }` |
| POST | `/anvil/api/manual-shot` | `{ id, dataUrl }` (PNG/JPEG <= 8 MB, magic bytes checked) | `{ file }` |
| POST | `/anvil/api/shot` | `{ role, page, device }` | `{ file }` (clean capture with Playwright) |
| POST | `/anvil/api/view-shot` | `{ dataUrl, page, role, device, manualId? }` | `{ file }` (exact capture of the Test view) |
| POST | `/anvil/api/include` | `{ file, on }` | `{ ok }` |
| POST | `/anvil/api/reset-data` | | `{ ok }` (GET `app.reset_path`; 404 when not configured) |
| POST | `/anvil/api/session` | `{ events:[...] }` | `{ ok, added }` tester-session events from the Test view |
| GET | `/anvil/api/session` | | `state.session` |
| POST | `/anvil/api/control` | `{ action: navigate\|device\|role\|reload\|shot, page?, role?, device? }` | `{ ok, listeners }` - lets Claude drive the Test view |
| POST | `/anvil/api/complete` | `{ rating, note_to_dev }` | `{ summary, draft }` - 409 while running/stopping or with unanswered manual checks |
| POST | `/anvil/api/send` | `{ comments:[{lane, body}], chat_md }` | `{ urls, files, chat_md }` - posts with `gh pr comment` |
| GET | `/anvil/api/chat.md` | | the chat note as a download |
| GET | `/anvil/api/next` | | `{ prs:[{number,title,url,current}] }` open PRs with `github.testing_label` assigned to you |

`env`: `{ origin, anvilOrigin, appBase, port, roleLinks, prUrl, ciUrl, issueUrl, reviewNoteUrl, qaDir, dryRun, project }`
where `project` is the UI part of the config (app name, roles, page/login paths, review commands, chat name, commands).
`health`: `[ { id: "app"|"gh"|"chrome"|"claude", ok, message, fix } ]`, cached 30 s.

**Proxy**: method, headers, body and cookies are streamed; the Host header is passed through so the app sees Anvil's
origin (its CSRF/Origin checks keep working); absolute `Location`s on the app origin are rewritten; `Set-Cookie` loses
`Domain=`; `X-Frame-Options` and the CSP `frame-ancestors` directive are stripped (nothing else). Every proxied path
containing `app.api_match` is logged to `state.session.requests` as `{method, path, status, ms, at}` - pathname only,
never bodies, query strings, headers or cookies (last 500).

## summary (`report.score(plan, results, state)`)
Per area: auto pass = 1, flake = 0.75, warn = 0.5, fail = 0; manual works = 1, unsure = 0.5, broken = 0;
`preexisting`, `skip`, `stopped` and `pending` are left out; area score = 5 x points / counted (5 if nothing counted).
`overall` = mean of the 5 areas, then with a tester rating: 0.7 x mean + 0.3 x rating; one decimal.
`decision` = `fix` if any blocker or any manual `broken` in area `works` or `roles`, else `final`.
Overrides ("Check it myself") replace the status (`auto_status` keeps the runner's); a `fail` override is a blocker
only for ids `A1`, `A5`, `P-*`, `R-*`, `F-*`.

## Report rules
- One PR comment per lane in `plan.lanes`. First line exactly `review.pass_command` or starts with
  `review.fix_command` (with `{lane}` filled). Body: Expected / Extras / Other / Tested on / Rating, "Screenshots:
  drag `screens.png` here", and the `review.signature` line.
- Lanes: manual items go to their own lane; auto checks in areas `phone`/`laptop` go to `review.ui_lane`, all others
  to `review.default_lane`; a lane not in the plan -> every lane.
- Claude writes it with `claude -p` (stdin = facts + template baseline, 90 s timeout); the result is validated (first
  lines, required lines, ticks, hand-check markers, not-checked line, chat note) or the template is used. Never
  invents results. `plan.copilot.security` is never sent to Claude.
- `/fix` comments end with a **Fix brief for Claude** (JSON: issues with severity, steps, expected, actual, evidence,
  `files_hint` from the PR's changed files, and a `recheck` command from `review.recheck_command`).
- The chat note is at most ~5 lines with the stars, decision, mentions and one link to the report.
- Anvil never runs `git push`/commit. Its only outward action is `gh pr comment`, after the tester confirms the preview.

## Safety
Test data only. Never commit, push, merge or deploy. Bind 127.0.0.1. Escape everything rendered in the UI (DOM APIs,
no `innerHTML` with data). No secrets in files or logs. Only the app inside Anvil's Test view is observed.
