# Changelog

All notable changes to Anvil are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-10-25

First public release.

### Added
- Generic engine configured per project with `anvil.config.json` (schema in `schemas/`), with templates
  (`{role}`, `{page}`, `{build}`, `{filter}`, `{flag}`, `{pr}`, `{env:NAME|default}`, ...) and sensible defaults;
  missing sections turn their checks into a clear `skip`.
- Automatic checks: tests with flaky / pre-existing detection (re-run, then compare on `main` in a temp worktree),
  CI, build, page loads per role on phone and laptop, phone-width layout, axe-core names and labels, role access,
  feature flags.
- Live run panel with streaming log, Stop (stop file + process-tree kill), "Run remaining", and "Check it myself"
  overrides that the report labels clearly.
- Test view: the app under test runs inside Anvil through a same-origin reverse proxy, with role switcher, device
  frames, exact screenshots, error counter and a session log used as evidence.
- Report: score per area, one PR comment per review lane with configurable pass/fix commands, a fix brief for the
  developer's Claude, a short chat note, a contact sheet of screenshots; optional rewrite with `claude -p`, validated
  against the facts.
- Claude Code skills: `anvil` (download / start / stop) and `fix-pr`.
- Acme Notes demo app and example config, unit tests and CI.
