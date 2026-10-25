---
name: anvil
description: Anvil - the tester's QA app for pull requests of any web project that has an anvil.config.json. "download anvil" installs or updates the Anvil tool in ~/.anvil; "start anvil" (or "start anvil <PR number>", /anvil) finds the PR assigned to the tester for testing, checks it out, writes the test plan and opens the Anvil app (http://127.0.0.1:8795/anvil/) where the tester does everything else - automatic checks, manual checks inside the app, screenshots, rating and sending the report. Use for "download anvil", "update anvil", "start anvil", "stop anvil", or when a tester asks to test, QA or check a PR.
---

# Anvil

Your job is to get the tester into the **Anvil app** fast, with a good plan. After that the tester works only in the
app; you stay available for questions. Talk in short, plain sentences - the tester may not be a developer.

Anvil is a generic engine (installed by "download anvil" below). Everything about the project under test - how to
start, sign in to and reset the app, how to build and test it, roles, review commands, the testing label - is in
`anvil.config.json` at the root of the project's repo. Read it first; never guess project details it does not give.

## One-time install (the tester runs it once)
Copy this file into the tester's own Claude Code so the commands work from any folder. It is a plain file copy - no
code runs. PowerShell:
```
New-Item -ItemType Directory -Force "$HOME\.claude\skills\anvil" | Out-Null; Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md" -OutFile "$HOME\.claude\skills\anvil\SKILL.md"
```
macOS / Linux:
```
mkdir -p ~/.claude/skills/anvil && curl -fsSL https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md -o ~/.claude/skills/anvil/SKILL.md
```

## Commands
- **download anvil** / **update anvil**: install or update the tool in `~/.anvil`:
  - not there: `git clone https://github.com/yoriichiee/anvil ~/.anvil`; there: `git -C ~/.anvil pull --ff-only`.
  - then `npm ci` inside `~/.anvil` (installs only `playwright-core` and `axe-core`; no browser download - Anvil uses the
    installed Chrome or Edge).
  - refresh this file: copy `~/.anvil/skill/anvil/SKILL.md` over `~/.claude/skills/anvil/SKILL.md` (and
    `~/.anvil/skill/fix-pr/SKILL.md` to `~/.claude/skills/fix-pr/SKILL.md` if the tester also develops).
  - Finish with: "Anvil is ready. Open your project folder and say **start anvil** when a PR is assigned to you."
- **start anvil** [n]: must run inside a repo that has `anvil.config.json` at its root (search the current folder and
  its parents). None: say "This folder has no anvil.config.json. Open the project's folder, or ask the maintainer to add
  one (see the Anvil README)." If `~/.anvil` is missing, do "download anvil" first.
  No number given: `gh pr list -R <github.repo> --assignee @me --label <github.testing_label> --state open --json
  number,title,url` (repo: `github.repo` in the config, else the `origin` remote; label default `needs-testing`).
  None: "Nothing is waiting for you to test right now." One: use it. Several: list them (number + title) and ask which.
  Then steps 1-3 below.
- **stop anvil**: stop the Anvil server (`server.port`, default 8795) and the app you started (`app.origin`).

## Rules
- Test data only (the app's seeded demo data). Never production, real people's data, phone numbers or keys.
- Never commit, push, merge or deploy. Never edit the developer's code. The only thing that goes out is the PR comment
  the tester sends from the Anvil app, after they confirm it.
- Automatic checks must be **reliable facts** (tests, server answers, browser errors, measured layout). Anything that
  needs judgement or a human (looks, feel, timing, camera, real phone, language quality, writes) goes in `manual`.
- How the tool works and every file format: `~/.anvil/docs/ARCHITECTURE.md`. The team's testing process:
  `review.process_doc` in the config, if set.

## 1. Get the PR ready (fix problems yourself, ask only when you must)
1. If `git status --porcelain` is not empty: stop and ask the tester (stash or keep) - never discard their changes.
2. `git fetch origin` then `gh pr checkout <n> -R <repo>`.
3. Tools, install only what is missing (ask before installing anything): `gh auth status`, Node 20+, Chrome or Edge,
   plus whatever `app.start_command`, `build.command` and `tests.command` in the config need.
4. If the config has `build`: build into the PR's own folder (never a tracked folder) by running `build.command` with
   `{build}` = `<data_dir>/pr-<n>/build` (`data_dir` default `.qa`). Then start the app in the background with
   `app.start_command`, setting the variables in `app.start_env` (fill `{build}` the same way). PowerShell example:
   `$env:NAME = "$PWD\.qa\pr-<n>\build"` before starting. Wait until `<app.origin><app.health_path>` answers.

## 2. Write the plan: `<data_dir>/pr-<n>/plan.json`
Format: `~/.anvil/schemas/plan.schema.json` (roles from `roles.list`, lanes from `review.lanes`, pages are the `{page}`
part of `app.page_path`, API paths are relative to `app.api_base`).
Read: `gh pr view <n> -R <repo> --json title,body,url,labels,headRefOid,headRefName,author,assignees,files`,
`gh pr diff <n> -R <repo>`, the linked issue (its expected results), review notes the project keeps, and the project's
focus notes (`focus_doc` in the config) - they list what is worth checking by hand per module and any project-specific
plan conventions (how labels map to lanes, which docs to read). The tester is the current `gh` user; the owner is
`review.owner` unless the focus notes say otherwise.
Fill every field:
- `copilot.summary`: what the PR does in 3 plain lines. `extras`: what the developer added beyond the issue.
  `security`: vague notes only (never describe a vulnerability). `tips`: one per kind of manual step.
- `pages`: every page the diff adds or changes (HTML directly; for JS/CSS, the pages that load that file), with the
  roles allowed to open it (`roles.folder_map` maps a page's first folder to its default role).
- `access`: for every new or changed API route in the diff, a GET as each role that must be refused, `expect`
  `[401,403]` (read the route's role check to know who is allowed - do not guess).
- `flags`: the feature flag(s) the PR uses, if the config has a `flags` section; else leave it empty.
- `manual`: every expected result that needs a human, the developer's extras, and the module focus - each with `why`,
  numbered `steps`, `role` + `page` (the app turns them into a signed-in link), `good`, `needs`, `area`, `lane`.
  Keep it to what matters: usually 4-10 items. Write steps a non-developer can follow.
- `focus`: the top 3-5 things for this module.

## 3. Start the Anvil app
From the repo root, in the background (stop an older one on the same port first):
`node "$HOME/.anvil/src/server.mjs" --pr <n>` (it finds `anvil.config.json` itself; `--config <file>` to point at another).
Open `http://127.0.0.1:<server.port>/anvil/` in Chrome; start the checks from the app if they did not start
(or run `node "$HOME/.anvil/src/run.mjs" --pr <n>` yourself). Tell the tester:
"Anvil is open for PR #<n>. It runs the automatic checks, shows your checks inside the app, and at the end you press one
button to send the report to GitHub. Ask me here if anything is unclear."

If the tester asks you something later, read `<data_dir>/pr-<n>/results.json` and `state.json` to answer. If a check
looks wrong, re-run it from the app (or `node "$HOME/.anvil/src/run.mjs" --pr <n> --only=<id>`); never edit results by hand.
You can drive the Test view for the tester: `POST http://127.0.0.1:<port>/anvil/api/control` with
`{"action":"navigate","page":"<page>","role":"<role>"}` (also `device`, `reload`, `shot`).
