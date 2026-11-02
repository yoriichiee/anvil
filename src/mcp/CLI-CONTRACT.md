# CLI contract used by the MCP server (W2 -> W1)

`anvil-mcp` (src/mcp/server.mjs) never imports the engine. It runs `node <repo>/src/cli.mjs <command> ...`
with no shell, `cwd` = the workspace, env `ANVIL_MCP=1`, `NO_COLOR=1`. Override the CLI path with `ANVIL_CLI`.

General rules for every command below when `--json` is given:
- stdout's **last non-empty line** is one JSON object. Anything before it is ignored. Logs go to stderr.
- exit code 0 = success. On failure print `{"ok":false,"error":"..."}` as the last line and exit non-zero.
- Never print secret values (stdout or stderr). No interactive prompts, no browser windows opened.

## anvil scan (required)
```
anvil scan <target> --json --no-open --run-id <id> --anvil-dir <abs path to .anvil> --ai <none|claude-code|codex|byok|credits>
           [--dir <abs source folder>] [--devices phone,laptop,tablet] [--addons id1,id2]
```
- `<target>`: http(s) URL, absolute folder path, or absolute .zip path.
- `--run-id`: use exactly this folder name: `<anvil-dir>/runs/<id>/`. The folder already exists (the MCP server
  creates it and writes `mcp-run.json` into it); the CLI must accept that and not delete `mcp-run.json`.
- `--anvil-dir`: where `.anvil` lives (default for the CLI on its own: `<cwd>/.anvil`).
- `--ai`: value for `report.mode.ai` (the MCP server maps the client name: claude-code / codex / none).
- `--no-open`: never open report.html in a browser.
- Writes `report.json` (schemas/report.schema.json) when done. Optional while running:
  `progress.json` = `{"phase":"browser","done":3,"total":6,"current":"axe"}` (the MCP server shows it in anvil_status).
- Last stdout line: `{"ok":true,"runId":"<id>","runDir":"<abs>","reportPath":"<abs>/report.json"}`.
  The server accepts a different `reportPath` only if it is inside `--anvil-dir`.
- Remote (non-localhost) URL without ownership proof: exit non-zero, `{"ok":false,"error":"ownership not verified ..."}`.

## anvil checks --json (optional, has a built-in fallback)
Last line: `{"checks":[{"id":"page-load","name":"...","kind":"builtin|addon","source":"..."}]}`.

## anvil fix-brief (optional, has a built-in fallback)
```
anvil fix-brief --run-id <id> --anvil-dir <dir> --format <md|lovable|cursor|claude> --json
```
(Re)writes `fix-brief.md` (md) or `prompts/<format>.md` from the current report.json (human verdicts included).
Last line: `{"ok":true,"path":"<abs or run-relative path>"}`. The path must be inside the run folder.
If this command is missing or fails, the MCP server writes the same files from its built-in template (src/mcp/brief.mjs).

## anvil render (optional, best effort)
```
anvil render --run-id <id> --anvil-dir <dir> --json
```
Called after `anvil_record_human` updates report.json, to regenerate report.html. Errors are ignored.

## Human verdicts (no CLI command needed)
`anvil_record_human` edits `<runDir>/report.json` directly: sets `humanChecks[i].verdict|note|shot`
(screenshots are copied to `shots/human-<itemId>.<ext>`) and recomputes `summary.counts.humanPending` and
`summary.counts.humanBroken` when `summary.counts` exists. It writes atomically (tmp + rename). It does not change
`score0to100`; if the engine wants human answers in the score, recompute it in `render`.

## anvil addon list|add (W5)
```
anvil addon list --json        -> {"addons":[{"id","name","version","installed":bool,"description"}]}
anvil addon add <id> --json    -> {"ok":true,"id","version","path"}
```

## anvil verify-owner (required for remote URLs)
```
anvil verify-owner <url> --json
```
Last line: `{"url","verified":bool,"token":"<public token>","wellKnownUrl":"https://host/.well-known/anvil.txt","instructions":"..."}`.
Exit code may be non-zero when not verified; the server still returns the JSON. The token is public by design and is
not redacted by the server.
