# Contributing to Anvil

Thanks for helping. Anvil is small on purpose: plain Node 20 ES modules, no build step, two dependencies
(`playwright-core`, `axe-core`). Please keep it that way.

## Getting started
```bash
git clone https://github.com/<you>/anvil && cd anvil
npm ci
npm test                     # unit tests (node --test)
npm run check                # node --check on every .mjs/.js file
node examples/acme-notes/server.mjs   # the demo app, then follow "Try it in one minute" in the README
```
The dashboard also runs without a server: open `dashboard/index.html?mock=1` through the Anvil server, or
`http://127.0.0.1:8795/anvil/?mock=1`.

## Ground rules
- **Generic engine.** Nothing project-specific in `src/`, `dashboard/` or the skills. If a project needs a
  different behaviour, add a config key (with a default that keeps current behaviour) to `src/config.mjs`,
  `schemas/anvil.config.schema.json` and the README config table.
- **Facts only.** An automatic check must report what a test, the server or the browser said. Anything that needs
  judgement belongs in the manual checklist.
- **Safety.** Bind 127.0.0.1; never add a write action other than the confirmed `gh pr comment`; never log request
  bodies, headers or cookies; render data with DOM APIs (`textContent`), never `innerHTML`.
- **Fictional data only** in fixtures, mocks, docs and screenshots (Acme Notes, "Alex Doe").
- Keep `docs/ARCHITECTURE.md` in sync with file formats and API changes, and add a line to `CHANGELOG.md`.

## Pull requests
- One topic per PR, with a short description of what changed and how you tested it (fill in the template).
- Run `npm test` and `npm run check` before pushing; CI runs both on Node 20.
- By contributing you agree that your contribution is licensed under the Apache License 2.0.
