---
name: fix-pr
description: Developer's co-pilot for a fix request on their pull request in a project that uses Anvil. Reads the tester's (or reviewer's) fix comment and its "Fix brief for Claude", fixes each issue in the developer's branch with a test where possible, re-runs the failed checks, and prepares the reply. Use when a developer types /fix-pr <PR number> or asks to fix their PR from the test report.
---

# /fix-pr <PR number>

You work for the PR's developer, in their own branch, following the project's own rules (`CLAUDE.md`, contributing
docs, and the focus notes named by `focus_doc` in `anvil.config.json`, if any). Project details - repo, review
commands, how to start the app and run the tests - are in `anvil.config.json` at the repo root.

## 1. Read the fix request
- `gh pr view <n> -R <repo> --json headRefName,headRefOid,author,comments,files` (`<repo>` = `github.repo` in the
  config, else the `origin` remote).
- Use the **latest** comment starting with the fix command (`review.fix_command`, default `/fix <lane>`) from a tester
  or reviewer. If it has a `<details><summary>Fix brief for Claude</summary>` block, parse its JSON: `issues[]` (id,
  severity, area, role, page, steps, expected, actual, evidence, files_hint) and `recheck`. Otherwise turn the
  comment's unticked lines into the same list.
- Security fix requests: details may be shared privately - ask the developer to paste what they were sent. Never write
  vulnerability details into commits, PR comments or review notes.
- Show the developer the list (severity order) in a few lines and start with blockers.

## 2. Fix
- Make sure you are on the PR branch and up to date: `git status`, `git switch <headRefName>`, `git pull`.
- For each issue: reproduce it first (start the app with `app.start_command`, sign in with `app.login_path` for the
  issue's role and page; or a failing test), then fix the cause, not the symptom. Start from `files_hint`, but follow
  the code. Add or extend a test whenever the issue can be tested (role checks, routes, API answers, calculations).
- An issue you think is not a bug or out of scope: do not change code - draft a short reply for the developer to post.
- Commit per fix with a clear message, e.g. `<area>: <what changed> (test report)`.

## 3. Check
- Run the project's tests (`tests.command` in the config); they must pass, or name failures that also fail on main.
- If the brief has `recheck` and Anvil is installed (`~/.anvil`) and `<data_dir>/pr-<n>/plan.json` exists: run it
  (the brief's `--only=` list re-runs just the failed checks). Skip it otherwise.
- Update the PR's review note, if the project keeps one ("Changes after testing").

## 4. Hand back
Show the developer the summary and the exact commands; they push (`git push`) and comment on the PR, for example:
```
Fixed from the test report:
- [x] m3 Note count wrong after delete - list now refreshes (test: notes.test: delete updates count)
- [ ] x1 Empty state wording - not a bug: <reason>
Tests: all passing on <commit>
```
Pushing and posting are the developer's actions - do them only if the developer asks you to.
