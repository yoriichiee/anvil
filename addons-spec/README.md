# Anvil add-ons: spec and registry

An add-on ("check pack") teaches Anvil a few more launch-readiness checks for one stack, such as Supabase, Stripe or your auth pages. Each pack is a single `anvil-addon.json` file. **It is data, not code**: Anvil interprets the six check kinds below and never runs anything from the pack.

```
anvil addon list --available      # what the registry offers
anvil addon add supabase-rls      # install (sha256-verified), runs on the next `anvil scan`
anvil addon list                  # installed packs
anvil addon remove supabase-rls
anvil addon validate my-pack.json # the same schema + ReDoS lint the registry CI runs
anvil addon add --file my-pack.json   # try a local pack before you publish it
```

From an agent over MCP, use `anvil_addons{action: "list" | "add", id?}`.

## Where things live

| What | Where |
|---|---|
| Schema (frozen, `schemaVersion` 1) | [`schemas/anvil-addon.schema.json`](../schemas/anvil-addon.schema.json), copied to `repo-template/schema/` |
| Registry repo | `github.com/yoriichiee/anvil-addons`, created from [`repo-template/`](repo-template/) |
| Published index | `https://anvil.horvans.com/registry/index.json` (override with `ANVIL_REGISTRY_URL`) |
| Published packs | `https://anvil.horvans.com/registry/packs/<id>/<version>/anvil-addon.json` |
| Installed packs | `~/.anvil/addons/<id>@<version>/` (override the root with `ANVIL_HOME`) |
| Engine code | [`src/addons/`](../src/addons/) |

## The pack format

```json
{
  "id": "stripe-checkout",
  "name": "Stripe Checkout",
  "version": "0.1.0",
  "author": "You",
  "license": "Apache-2.0",
  "anvil": "^0.2",
  "description": "What it checks, in one or two sentences.",
  "tags": ["stripe", "payments"],
  "checks": [
    { "id": "live-secret-key", "kind": "secret-pattern", "severity": "critical",
      "title": "Live Stripe secret key in the code",
      "match": { "regex": "(?:sk|rk)_live_[0-9a-zA-Z]{20,}" },
      "why": "Why this matters, in plain words.", "fix": "What to do about it." }
  ],
  "humanChecks": [
    { "id": "test-card-success", "prompt": "Does a 4242 test payment unlock what was bought?",
      "steps": ["...", "..."], "screenshot": true }
  ]
}
```

Limits: 50 checks and 30 human checks per pack, `match.path` is a site-absolute path (`/login`), and regexes are capped at 300 characters by the lint.

### Check kinds

`match` describes **the problem** for every kind except `page`, which describes **what should work**.

| kind | Needs | Runs | Finding when |
|---|---|---|---|
| `page` | URL target (browser if available) | GET `match.path` | the page does **not** load as described: status outside `match.status` (default 200-399), `match.selector` missing, or `match.regex` not found in the HTML |
| `dom` | browser | open `match.path` (default `/`) | `match.selector` is present, for example a password form without `method="post"` |
| `axe` | browser | axe-core on `match.path` (default `/`), scoped to `match.selector` | there are violations; `match.regex` filters axe rule ids |
| `secret-pattern` | source or build files | `match.regex` over every text file (node_modules skipped) | the pattern matches. One finding per file, value redacted |
| `http` | URL target | `match.method` (GET or HEAD) `match.path` on the target | status is in `match.status` (default 200) and, if given, the body matches `match.regex` |
| `rules-probe` | a backend found in the user's own code | like `http`, but against that backend (for example a Supabase URL plus its public anon key) | as for `http`. Skipped when no backend is found |

When a check cannot run (no browser, a folder target with no URL, no backend found), it is reported as `skip` with an entry in the report's "not checked" list. It is never silently reported as passing.

**Feature detection.** A `page`, `dom` or `axe` check is about one feature of the app (a login page, a checkout success page). When its `match.path` answers **404 or 410**, Anvil takes the feature to be absent: the check is `skip`, raises no finding, and is listed under "not checked" with the reason `feature not detected`. Other errors (500, a missing field on a page that exists) are still findings. Set `"required": true` on a check when the page must exist for every app that installs the pack; a 404 is then reported as a finding.

Regex syntax is JavaScript's. Start the pattern with `(?i)` to make it case-insensitive; no other flags exist.

### Human checks

`humanChecks` become Works / Broken / Not sure items in the report's checklist. Write them as steps a non-coder can follow in five minutes. Say what counts as Broken.

## Rules for every pack

1. **Declarative only.** One `anvil-addon.json`, plus an optional `README.md`, in `packs/<id>/<version>/`. No scripts, no binaries, no remote includes.
2. **GET and HEAD only.** Probes never change state. `match.method` accepts only `GET` and `HEAD`, and only on `http` and `rules-probe`.
3. **Same site only.** Paths are site-absolute (`/x`). `//host` and backslashes are rejected, so a probe never leaves the target, or the backend found in the user's own code.
4. **Read only what is already public.** Rules probes use the public (anon or publishable) credentials the app already ships to every browser. Never ask for or use service keys.
5. **ReDoS-safe regexes.** The lint rejects:
   - nested repetition like `(a+)+` or `(a{1,8})*`
   - repeated alternation like `(a|ab)+`; use a character class instead
   - backreferences
   - bounds over 1000
   - more than 4 unbounded quantifiers
   - patterns over 300 characters
   - patterns that match the empty string

   It then runs each pattern on adversarial input under a 250 ms limit. At scan time each regex runs in a sandboxed `vm` with a hard timeout per file.
6. **Immutable versions.** A published `id@version` never changes and is never deleted. Fix a mistake by publishing a new version. CI compares against the previous `index.json`, and `anvil addon add` refuses a version whose bytes differ from an earlier install.
7. **Honest claims.** Titles, `why`, `fix` and prompts describe what was checked. The lint rejects "secure", "unhackable", "bulletproof" and "guaranteed".
8. **Review.** Every PR needs a maintainer (CODEOWNERS) approval. CI runs the validator from the **base** branch, so a PR cannot weaken the rules it is judged by.

## How to publish a pack

1. Fork `yoriichiee/anvil-addons`.
2. Add `packs/<id>/<version>/anvil-addon.json`. For a new pack start at `0.1.0`. For an update, add a new version folder and leave the old ones alone.
3. Try it locally against a real app:
   ```
   anvil addon validate packs/<id>/<version>/anvil-addon.json
   anvil addon add --file packs/<id>/<version>/anvil-addon.json
   anvil scan http://localhost:3000
   ```
4. Regenerate the index with `node scripts/build-index.mjs` and commit `index.json`. It records the sha256 of your file's exact bytes, so keep LF line endings.
5. Open a PR. CI checks:
   - the schema
   - GET/HEAD only
   - same-site paths
   - the ReDoS lint
   - folder layout
   - immutability
   - that `index.json` is up to date

   A maintainer reviews what the pack claims and how noisy it is likely to be.
6. After merge, the maintainer publishes `index.json` and `packs/` to `https://anvil.horvans.com/registry/` (`scripts/publish-dl.ps1` in the Anvil repo). From then on, `anvil addon add <id>` installs it.

## Index format (`index.json`)

```json
{
  "schemaVersion": "1",
  "registry": "https://github.com/yoriichiee/anvil-addons",
  "packs": [
    {
      "id": "stripe-checkout", "name": "Stripe Checkout", "description": "...",
      "author": "...", "license": "Apache-2.0", "tags": ["stripe"], "latest": "0.1.0",
      "versions": [
        { "version": "0.1.0", "anvil": "^0.2",
          "path": "packs/stripe-checkout/0.1.0/anvil-addon.json",
          "sha256": "<hex of the exact file bytes>", "size": 4321,
          "kinds": ["page", "secret-pattern"], "checks": 5, "humanChecks": 4 }
      ]
    }
  ]
}
```

- `packs` is sorted by `id`, and `versions` from newest to oldest.
- `latest` is the newest stable version.
- `path` is resolved relative to the index URL and must stay on the same origin.
- The output is deterministic (it has no timestamp), so CI can check that the committed file is current.

## Seed packs

| id | What it covers |
|---|---|
| `supabase-rls` | `service_role` and `sb_secret_` keys in code; anon reads of the schema and the `profiles`, `users`, `orders` and `messages` tables; human checks for RLS on every table, cross-user rows and private storage |
| `stripe-checkout` | live and test secret keys and webhook secrets in code; `/success` and `/cancel` pages load; human checks for the 4242 test card, a declined card, a closed tab (webhook-driven fulfilment) and a success URL opened without paying |
| `auth-pages` | `/login`, `/signup` and `/forgot-password` load with the right fields; password forms without `method="post"` (password could land in the URL); missing autocomplete hints; human checks for login rate limits, single-use reset links, account enumeration and logout |

## Not covered (be honest in your pack too)

- Packs cannot sign in. Checks run as an anonymous visitor, unless the engine's role-access run provides a session.
- Fixed paths (`/login`, `/success`) are guesses about the app. When an app uses other URLs, the finding's `why` says to ignore it. The human checks cover the real flow.
- Index signing is not in place yet. Integrity comes from the sha256 values in an index served over HTTPS from anvil.horvans.com.
