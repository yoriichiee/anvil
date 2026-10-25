# anvil.config.json for Acme Notes, value by value

The key names follow `src/config.mjs` in the Anvil repo (`normalizeConfig` accepts this file as it is).
`{root}` is the repo root Anvil runs against. For this example, that is **this folder** (`examples/acme-notes`, or
the folder itself if you copy it into its own repo). `{build}`, `{filter}`, `{flag}` and `{tmp}` are filled in by
Anvil.

## Top level
| Key | Value | In plain words |
|---|---|---|
| `name` | `Acme Notes` | What Anvil calls the app in messages ("Acme Notes not running at ..."). |
| `data_dir` | `.qa` | Where Anvil keeps its per-PR folders (`.qa/pr-7/plan.json`, results, screenshots). |
| `github.repo` | `null` | No real GitHub repo. CI checks and posting are skipped (or Anvil runs in dry-run mode). |
| `github.testing_label` | `needs-testing` | The label that marks PRs waiting for a tester. |
| `server.port` | `8795` | The port of Anvil's own app (not the demo's). |

## app: how to reach and drive the demo
| Key | Value | In plain words |
|---|---|---|
| `origin` | `http://127.0.0.1:4400` | Where the demo runs. |
| `origin_env` | `ACME_ORIGIN` | If this environment variable is set, it overrides `origin` (for example when you run on another port). |
| `start_command` | `node server.mjs` | What Anvil tells you to run when the app is down. |
| `health_path` | `/dev/` | A page that answers 200 when the app is up. It also lists the roles. |
| `api_context_path` | `/dev/` | The same-origin page Anvil opens before it sends role-check `fetch()` calls. It works signed out too, so `anon` checks work. |
| `login_path` | `/dev/login/{role}?next={page}` | Demo sign-in. It sets an HttpOnly cookie and redirects to the page. Without a page, Anvil drops `?next=` and the app opens the role's home page. |
| `reset_path` | `/dev/reset` | Re-seeds the demo data. Tools get JSON `{"ok":true}`. Flags are not touched. |
| `page_path` | `/app/{page}` | How a page name (`member/notes.html`) becomes a URL. |
| `page_pattern` | `^(admin\|member\|guest)/...html(?query)?$` | Which page names a plan may use. A query string such as `?id=n2` is allowed. |
| `page_example` | `member/notes.html` | Shown as a hint in Anvil's page picker. |
| `api_base` | `/api/` | Prefix for `access[].path` and `flags[].path` in the plan (`settings` means `/api/settings`). |
| `api_match` | `/api/` | Any request whose URL contains this counts as an API call. A 4xx or 5xx answer fails the page. |
| `sample_names` | `Lorem ipsum\|John Doe\|...\|undefined\|NaN` | Text that must never appear on a page: placeholder names and broken rendering. |

## roles
| Key | Value | In plain words |
|---|---|---|
| `list` | `admin, member, guest` | The demo roles. Each has a sign-in link. `anon` (signed out) is built in. |
| `default` | `member` | Role used for a page whose folder is not a role. It never happens here, but it is a sensible default. |
| `folder_map` | `admin->admin, member->member, guest->guest` | The first folder of a page is the role that may open it. Other roles are redirected to their own home page. |

## build: Anvil's A5 check
| Key | Value | In plain words |
|---|---|---|
| `name` | `Build (copy public/ + manifest.json)` | Label of the check. |
| `command` | `node {root}/build.mjs --out={build}` | Copies `public/` into Anvil's own build folder (`.qa/pr-<n>/build`) and writes `manifest.json`. It never touches `public/`. It takes well under a second. |
| `manifest` / `manifest_key` | `manifest.json` / `pages` | Anvil reads `manifest.json` → `pages` to confirm every plan page is in the build. |
| `app_dir` / `app_dir_env` | `dist` / `ACME_APP_DIR` | Where a normal build lives (`node build.mjs` writes `dist/`), and the variable the server reads to serve a build folder instead of `public/`. |
| `timeout_minutes` | `2` | Give up after 2 minutes. |

## tests: Anvil's A1/A2 checks
| Key | Value | In plain words |
|---|---|---|
| `command` | `node {root}/run-tests.mjs` | Runs every `tests/*.test.mjs` file on its own and ends with one summary line. |
| `filter_args` | `{filter}` | To re-run one failed file, Anvil appends its name (`node run-tests.mjs flaky.test.mjs`). |
| `summary_regex` | `^RESULT: (?<total>N) tests, (?<failed>N) failed, (?<secs>N) s( (<files>))?$` | Parses `RESULT: 13 tests, 1 failed, 1.4 s (flaky.test.mjs)`. The names in brackets are the failed files. |
| `files_separator` | `", "` | Separates several failed files inside the brackets. |
| `files_dir` | `tests` | Where test files live. Used to tell whether a failing file is new. |
| `file_section_end_regex` / `fail_name_regex` | `\n(?=\S)` / `^\s+FAIL (.+)$` | The output has one section per file (the file name on its own line, then `  ok ...` / `  FAIL ...` lines). These pick out the names of failed tests. |
| `rerun_failed` | `true` | Re-run each failed file once. If it passes, the result is `flake` (that is what `tests/flaky.test.mjs` demonstrates). |
| `compare_on_main` | `false` | Skips the "does it also fail on main" step: the demo has no main branch to compare with. |
| `timeout_minutes` | `5` | Give up after 5 minutes. |

## flags: Anvil's F check
| Key | Value | In plain words |
|---|---|---|
| `command` | `node {root}/flags.mjs` | The flag tool. With no arguments it prints the state. |
| `on_args` / `off_args` | `--on={flag}` / `--off={flag}` | Turn a flag on or off. The change takes effect on the next request, with no restart. |
| `list_args` / `list_regex` / `none_text` | `[]` / `^flags on: (.*)$` / `(none)` | How Anvil reads which flags are on, so it can restore the state afterwards. The first output line is `flags on: ff_tags` or `flags on: (none)`. |
| `flag_pattern` | `^ff_[a-z0-9_]{1,40}$` | Which flag names a plan may use. |
| `off_expect` | `404` + `not_enabled` | With the flag off, the route must answer 404 `{"error":"not_enabled"}`. With it on, it must answer 2xx. |
| `env.ACME_DATA_DIR` | `{tmp}/acme-notes-data` | The tool must write to the same data folder the server reads. This is the server's default. If you start the server with another `ACME_DATA_DIR`, change it here too. |

## review: how the report is posted
| Key | Value | In plain words |
|---|---|---|
| `lanes` | `app, ui` | One report comment per lane. |
| `ui_lane` / `default_lane` | `ui` / `app` | Phone and laptop (layout and accessibility) issues go to `ui`, everything else goes to `app`. |
| `pass_command` / `fix_command` | `/pass {lane}` / `/fix {lane}` | The first line of each comment. |
| `chat_name`, `help_text`, `signature`, `recheck_command` | defaults | Wording in the report and the UI. |
