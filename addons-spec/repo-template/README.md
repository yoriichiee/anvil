# anvil-addons

Community check packs for [Anvil](https://anvil.horvans.com), the launch-readiness checker for AI-built apps.

A pack is one declarative `anvil-addon.json` file: checks Anvil interprets (page, dom, axe, secret-pattern, http, rules-probe) plus guided human checks. **No pack code ever runs.**

```
anvil addon list --available
anvil addon add stripe-checkout
```

## Layout

```
packs/<id>/<version>/anvil-addon.json   one immutable version of a pack (+ optional README.md)
schema/anvil-addon.schema.json          the pack schema (copy of Anvil's frozen schema)
scripts/build-index.mjs                 validates every pack, lints regexes, writes index.json
scripts/pack-validate.mjs               zero-dependency validator + ReDoS guard (shared with Anvil)
index.json                              generated: ids, versions, sha256 of each pack file
test/                                   node --test
```

## Commands (Node 20+, no install needed)

```
node scripts/build-index.mjs            # validate + regenerate index.json
node scripts/build-index.mjs --check    # validate + fail if index.json is stale (what CI runs)
node --test test/build-index.test.mjs
```

Published at `https://anvil.horvans.com/registry/index.json`, with each pack at `registry/<path from the index>`. The Anvil CLI checks every download against the sha256 listed in the index before it installs anything.

See [CONTRIBUTING.md](CONTRIBUTING.md) to add a pack. Licensed under Apache-2.0.
