# site/ (anvil.horvans.com)

Plain static HTML, CSS and JS. No build step. Deployed as-is by `scripts/deploy-site.ps1` (W4).

| Path | What |
|---|---|
| `index.html` | Landing page (`assets/landing/`: `landing.css`, `landing.js`, dashboard screenshots, vendored GSAP + Lenis) |
| `install/` | Install guide with copy buttons |
| `demo/` | Replay of a recorded run. Data: `demo/run.json` (a report.json, schema v1) + `demo/shots/*.png` |
| `demo-app/` | Static, labelled snapshot of `examples/acme-notes` (the real app needs its Node server). The snapshot pages keep Acme's own CSS byte-for-byte; only the strip on top is Anvil's |
| `addons/` | Renders `registry/index.json` |
| `registry/index.json` | Copy of `addons-spec/repo-template/index.json` (built by `addons-spec/repo-template/scripts/build-index.mjs`) |
| `404.html` | Root-absolute links: it is served for any missing path |

All links between pages are relative, so the site also works under `yoriichiee.github.io/anvil/` (except `404.html`).

## Look

Same UI and logo as the Anvil dashboard (`dashboard/app.css`, `dashboard/app.js` `brandMark()`):

- Tokens: the dashboard's `:root` (copied into `assets/landing/landing.css`). Monochrome only, no accent colour.
- Logo: the `ANVIL_PATH` mark, `assets/landing/anvil-mark.svg` (inline as the `#i-anvil` sprite symbol in each page; favicon `assets/landing/favicon.svg`).
- Status is never shown by colour alone: glyph + label + weight/border (`.st`, `.sg` in the CSS).
- Commands and logs use the dark log console (`.cmd-box`, `.win-dark`).
- Every page has the landing page's nav and footer. "by Horvans" appears only as the footer credit.
- Inner pages load `assets/landing/landing.css` + `assets/css/pages.css` and `assets/js/pages.js` (menu, copy buttons).

## Replace the recorded run

1. Copy the run's `report.json` to `demo/run.json`.
2. Copy the PNGs its `evidence.shot` fields name into `demo/shots/` (paths must look like `shots/<name>.png`).
3. The page label ("Recorded run, <date>") comes from `scannedAt`. Nothing else to change.

## Preview

```
npx http-server site -p 4390
```

or `python -m http.server 4390 -d site`, then open http://localhost:4390/.

## Rules

- No inline `<script>` or `style=""` attributes: the CSP is `script-src 'self'` (`assets/landing/early.js` is the
  head script that would otherwise be inline).
- Vendored: GSAP + ScrollTrigger 3.12.5 and Lenis (`assets/landing/vendor`). No web fonts: the Inter stack falls back
  to the system UI font, same as the dashboard.
- Data from `run.json` and the registry is rendered with `textContent` only.
- Never call the scanned app "secure".
