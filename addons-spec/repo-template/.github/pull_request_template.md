## Pack

- id@version:
- New pack or new version of an existing pack:

## What it catches

<!-- One or two sentences per check: the real-world bug, and why the pattern / path / selector finds it. -->

## Checklist

- [ ] Only adds files under `packs/<id>/<version>/` (`anvil-addon.json`, optional `README.md`)
- [ ] Does not edit, rename or delete any published version
- [ ] `node scripts/build-index.mjs` passes and the regenerated `index.json` is committed
- [ ] I ran it against a real app with `anvil addon add --file packs/<id>/<version>/anvil-addon.json` and `anvil scan`
- [ ] Probes are GET/HEAD only and read nothing that is not already public to an anonymous visitor
- [ ] Titles, why and fix text describe what was checked, not that an app is "secure"
- [ ] I agree to license this pack under Apache-2.0
