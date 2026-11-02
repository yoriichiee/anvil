# Contributing a pack

Thanks for teaching Anvil a new check. Packs are reviewed by a maintainer before they are published, and every rule below is enforced by CI.

## Steps

1. Fork this repo.
2. Create `packs/<id>/<version>/anvil-addon.json`.
   - `id`: lowercase letters, digits and dashes, 2-64 characters (e.g. `firebase-rules`).
   - First version `0.1.0`. To change a published pack, add a **new** version folder.
3. Validate and try it on a real app:
   ```
   node scripts/build-index.mjs
   anvil addon add --file packs/<id>/<version>/anvil-addon.json
   anvil scan http://localhost:3000
   ```
4. Commit the pack **and** the regenerated `index.json`, then open a pull request.

## Rules

- **Declarative only.** A version folder holds `anvil-addon.json` and, optionally, `README.md`. Nothing else.
- **GET/HEAD only.** `http` and `rules-probe` checks never send anything that changes state.
- **Same site only.** `match.path` starts with a single `/`. Probes never go to a host you name; they go to the app being scanned, or the backend found in that app's own code.
- **Public credentials only.** Rules probes use what the app already ships to browsers (anon or publishable keys). Never service keys.
- **ReDoS-safe regexes.**
  - Not allowed: nested repeats like `(a+)+`, repeated alternation like `(a|ab)+`, or backreferences.
  - Limits: at most 4 unbounded quantifiers, bounds up to 1000, and patterns up to 300 characters.
  - A pattern must not match the empty string.
  - Use character classes (`[A-Za-z0-9_-]{20,}`) instead of alternation inside repeats.
- **Immutable versions.** Published `id@version` files are never edited, renamed or deleted.
- **Low noise.** Prefer patterns with a distinctive prefix (`whsec_`, `sk_live_`). If a check guesses at a URL (`/login`), say in `why` what to do when the app uses a different one.
- **Honest claims.** Describe what was checked. Never say an app is "secure" (the lint rejects it).
- **Human checks a non-coder can do.** Short steps; say exactly what counts as Broken.
- **License.** Packs are contributed under Apache-2.0.

## Review

A maintainer reads every pack for:
- false-positive risk
- whether the `why` and `fix` are correct and kind to beginners
- probe safety

PRs that change `scripts/`, `schema/` or `.github/` need extra maintainer review. CI always validates with the base branch's scripts, so a PR cannot loosen the rules it is checked by.

## Reporting a bad pack

Open an issue with the pack id, the version and what went wrong. Security problems go to the Anvil repository's SECURITY.md contact, not to a public issue.
