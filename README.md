# Anvil

**A local QA co-pilot for pull requests of any web app.** Anvil runs the checks a machine can answer reliably (tests,
build, CI, every changed page on phone and laptop, role access, feature flags, accessibility basics), then guides a
human tester through the checks only a person can do - with the app running *inside* Anvil - and posts one clear
report on the pull request.

It is built for teams where testers are not necessarily developers: a tester types **start anvil** in
[Claude Code](https://claude.com/claude-code), and everything else happens in one browser tab.

- **Facts, not guesses.** Automatic checks report only what tests, the server and the browser say. Anything that needs
  judgement becomes a manual check with steps, a sign-in link and "what good looks like".
- **Test inside the app.** Anvil reverse-proxies the app under test, so it opens in Anvil's Test view with a role
  switcher, phone / tablet / laptop frames, exact screenshots and a live error counter (console errors, failed API
  calls) that becomes evidence in the report.
- **One button to report.** A score per area, a rating, and one PR comment per review lane (`/pass ui`, `/fix app ...`
  or your own commands), with a machine-readable "fix brief" the developer's Claude can act on.
- **Any project.** Everything project-specific lives in one `anvil.config.json`. Missing sections just turn the
  matching checks into a clear "skip".
- **Local and private.** Binds to 127.0.0.1, stores everything in a git-ignored folder, never commits or pushes.

## Screenshots

> Screenshots will be added here: Overview, Auto checks (live run), Test view, Complete.

## How it works

```
 tester ──► Claude Code ("start anvil") ──► writes plan.json, starts the app and Anvil
                                                     │
                     ┌───────────────────────────────▼───────────────────────────────┐
 browser ◄──────────►│ Anvil server  127.0.0.1:8795                                   │
   /anvil/  dashboard│   ├─ runs the automatic checks (anvil-run) ─► results + shots  │
   /*  your app ─────┼──►├─ reverse proxy to your app (same origin, logged API calls) │
                     │   └─ report: score, comment per lane, `gh pr comment`          │
                     └────────────────────────────────────────────────────────────────┘
```

1. **Plan** - the `anvil` skill reads the PR (diff, issue, your focus notes) and writes `plan.json`: changed pages and
   the roles that may open them, API routes that must refuse some roles, feature flags, and 4-10 manual checks.
2. **Automatic checks** - `A1` tests (failed files re-run once, then tried on `main` to separate flaky and
   pre-existing failures), `A4` CI, `A5` build, `P` pages load cleanly as each role, `L` no sideways scroll on a
   phone, `X` axe-core names and labels, `R` role access, `F` feature flags. Live log, Stop and "Check it myself".
3. **Manual checks** - in the Test view, one at a time: steps, Works / Broken / Not sure, notes and screenshots.
4. **Complete** - score and decision, editable report preview, then one confirmed `gh pr comment` per lane and a short
   chat note for your team chat.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Try it in one minute (bundled demo app)

The repo ships a small demo app, **Acme Notes** (`examples/acme-notes/`, zero dependencies, roles admin / member /
guest, with a few deliberate bugs for Anvil to find).

```bash
git clone https://github.com/yoriichiee/anvil && cd anvil
npm ci                                     # playwright-core + axe-core only; uses your installed Chrome or Edge
node examples/acme-notes/server.mjs        # terminal 1: the demo app on http://127.0.0.1:4400
```

In a second terminal (macOS / Linux shown; in PowerShell use `$env:ANVIL_DRY_RUN = "1"` and `Copy-Item`):

```bash
mkdir -p examples/acme-notes/.qa/pr-1
cp examples/acme-notes/.anvil/plan.example.json examples/acme-notes/.qa/pr-1/plan.json
ANVIL_DRY_RUN=1 node src/server.mjs --pr 1 --config examples/acme-notes/anvil.config.json
```

Open http://127.0.0.1:8795/anvil/ and press **Run all again**. Dry-run mode never posts anything to GitHub.
No app at hand? `http://127.0.0.1:8795/anvil/?mock=1` shows the dashboard with sample data.

## Quick start for testers

Requirements: Node 20+, Git, the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`), Chrome or Edge,
and Claude Code.

1. **One-time install** of the skill (a plain file copy, no code runs):
   ```powershell
   New-Item -ItemType Directory -Force "$HOME\.claude\skills\anvil" | Out-Null; Invoke-WebRequest -UseBasicParsing "https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md" -OutFile "$HOME\.claude\skills\anvil\SKILL.md"
   ```
   ```bash
   mkdir -p ~/.claude/skills/anvil && curl -fsSL https://raw.githubusercontent.com/yoriichiee/anvil/main/skill/anvil/SKILL.md -o ~/.claude/skills/anvil/SKILL.md
   ```
2. In Claude Code say **download anvil** (clones this repo into `~/.anvil` and runs `npm ci` there).
3. Open your project's folder (it must have an `anvil.config.json`) and say **start anvil** - or
   **start anvil 42** for a specific PR. Claude lists the open PRs assigned to you with the testing label, prepares
   everything and opens Anvil. Say **stop anvil** when you are done.

## Quick start for project maintainers

1. Copy [`examples/anvil.config.example.json`](examples/anvil.config.example.json) to the root of your repo as
   `anvil.config.json` and adapt it. The minimum is `name`, `app` and `roles`:
   ```json
   {
     "name": "My App",
     "app": { "origin": "http://127.0.0.1:3000", "start_command": "npm run dev",
              "page_path": "/{page}", "login_path": "/dev/login/{role}?next={page}" },
     "roles": { "list": ["admin", "user"] }
   }
   ```
2. Give your app a **development-only sign-in route** for each role (`app.login_path`) that sets a session cookie
   for seeded test users. Optional but recommended: a reset route (`app.reset_path`) and a health route.
3. Add `.qa/` (or your `data_dir`) to `.gitignore`.
4. Optional: `build`, `tests` (with `summary_regex` to get flaky / pre-existing detection), `flags`, and a focus notes
   file (`focus_doc`) that tells the skill what is worth checking by hand per module.
5. Create a label for PRs that wait for testing (default `needs-testing`) and assign testers to PRs.
6. Developers can install `skill/fix-pr/SKILL.md` too: "/fix-pr 42" reads the fix brief and fixes the PR.

## Config reference

Full schema with descriptions: [`schemas/anvil.config.schema.json`](schemas/anvil.config.schema.json).

| Key | Default | What it does |
|---|---|---|
| `name` | `"the app"` | Product name shown in Anvil and messages |
| `data_dir` | `.qa` | Per-PR data folder (git-ignore it) |
| `focus_doc` | - | Markdown with module focus notes for the skill |
| `github.repo` | from `git remote origin` | `owner/name`; without it CI, PR list and posting are skipped |
| `github.testing_label` | `needs-testing` | Label of PRs waiting for a tester |
| `server.port` | `8795` | Anvil's port (`ANVIL_PORT` overrides) |
| `app.origin` / `app.origin_env` | `http://127.0.0.1:3000` | Where the app runs / env var that overrides it |
| `app.start_command`, `app.start_env` | - | How to start the app (shown to testers, used by the skill) |
| `app.health_path` | `/` | Answers < 500 when the app is up |
| `app.page_path` | `/{page}` | Page URL; plan pages are the `{page}` part |
| `app.page_pattern`, `app.page_example` | any safe path | Regex plan pages must match; example for hints |
| `app.login_path` | - | Dev sign-in, `{role}` and optional `{page}`; without it every role browses signed out |
| `app.reset_path` | - | Resets the test data; hides the Reset tool when absent |
| `app.api_base`, `app.api_match` | `/api/` | Base of API routes in the plan; substring that marks API calls |
| `app.api_context_path` | `health_path` | Page opened before an API GET is sent |
| `app.sample_names` | - | Regex of leftover placeholder names (page warning) |
| `roles.list`, `roles.default`, `roles.folder_map` | - | Roles; default role per page folder |
| `build.*` | absent: A5 skipped | `command` (builds into `{build}`), `manifest` + `manifest_key` (page list), `app_dir_env`, `app_dir`, `detail_replace` |
| `tests.*` | absent: A1 skipped | `command`, `filter_args`, `summary_regex`, `files_separator`, `fail_name_regex`, `file_section_end_regex`, `files_dir`, `ok_line_regex`, `fail_line_regex`, `log_line_regex`, `compare_ref`, `timeout_minutes` |
| `flags.*` | absent: F skipped | `command`, `on_args`, `off_args`, `list_args`, `list_regex`, `none_text`, `requires`, `flag_pattern`, `off_expect`, `env` |
| `review.*` | see schema | `lanes`, `ui_lane`, `default_lane`, `pass_command`, `fix_command`, `owner`, `chat_name`, `help_text`, `signature`, `recheck_command`, `process_doc` |

**Templates** usable in commands and paths: `{origin} {role} {page} {lane} {tester} {pr} {root} {build} {qa}
{filter} {flag} {tmp} {env:NAME} {env:NAME|default}`. In list commands, items that become empty are dropped
(`["{filter}"]` disappears when there is no filter); a string command runs through the shell.

**Environment variables**: `ANVIL_CONFIG`, `ANVIL_PORT`, `ANVIL_DRY_RUN=1`, `ANVIL_NO_CLAUDE=1`,
`ANVIL_CLAUDE_BIN`, `ANVIL_CHROME`.

## CLI

```bash
anvil-server --pr <n> [--config <file>] [--root <repo>]           # the app; open http://127.0.0.1:8795/anvil/
anvil-run    --pr <n> [--config <file>] [--root <repo>] [--only=P-,R-r1] [--skip-tests] [--test-filter=<f>]
node src/report.mjs <data_dir>/pr-<n> [--config <file>] [--no-claude]   # print the score and draft report
```

## Safety and privacy

- Binds to `127.0.0.1` only and rejects other Host / Origin headers (DNS rebinding).
- Never commits, pushes, merges or deploys. The only outward action is `gh pr comment`, after the tester confirms the
  preview. `ANVIL_DRY_RUN=1` posts nothing.
- Only `GET` requests are sent automatically; other methods become manual checks.
- The proxy logs API calls as method, path, status and time only - never bodies, query strings, headers or cookies.
  Session data stays in your git-ignored data folder and is used only for the report.
- `plan.copilot.security` notes are never sent to Claude and never appear in public text. Keep security details out
  of PR comments.
- Use seeded test data only. Never point Anvil at production or at real people's data.
- The report draft uses `claude -p` when the Claude CLI is installed; facts are validated against the results and
  the plain template is used otherwise (`ANVIL_NO_CLAUDE=1`).

## Contributing

Issues and pull requests are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md). Security issues: [SECURITY.md](SECURITY.md).

## Built with Claude Code

Anvil was designed and built with [Claude Code](https://claude.com/claude-code), and it is meant to be used with it:
the skills in `skill/` turn "start anvil" into a ready test session and "/fix-pr 42" into a fix.

## License

[Apache-2.0](LICENSE). Copyright 2026 yoriichiee and Anvil contributors.
