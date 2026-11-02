# Acme Notes: demo bug 5 (leaked Stripe secret key)

Added for `anvil scan` (the target-mode engine). It is the fifth bug in DEMO-BUGS.md.

| # | Where | What Anvil reports | Check | Fix (do not apply it in the demo) |
|---|---|---|---|---|
| 5 | `public/assets/js/billing.js` line 6 | `Stripe secret key (Anvil demo key) is shipped to every browser` (critical, proven). The value is shown masked (`sk_anvildemo_[REDACTED ...]`). | `secret-scan` | Roll the key in Stripe, call Stripe from a server route that reads `STRIPE_SECRET_KEY` from the environment |

The key is fake (`sk_anvildemo_0000fake...`, see `billing.js`). It uses Anvil's own demo-key format (`sk_anvildemo_` plus
16 or more letters and digits), which Anvil's secret scanner knows and treats exactly like a live Stripe secret key
(`src/redact.mjs`, pattern `stripe-demo-secret`). Because `sk_anvildemo_` is not a Stripe prefix (`sk_live_`,
`rk_live_`, `sk_test_`, ...), GitHub push protection and other secret scanners do not mistake it for a real key, so the
repo can be pushed with the demo bug in place.

`billing.js` is not loaded by any page, so it is found by the source scan (`anvil scan examples/acme-notes`, or
`anvil scan http://127.0.0.1:4400 --dir examples/acme-notes`), and in the build output (`node build.mjs`, which
copies `public/` into `dist/`). A URL-only scan does not see it because no page downloads it.

`.anvil/scan.json` holds the roles (dev sign-in links) and the access rules for `anvil scan`, including the rule that
catches demo bug 3 (`member` must get 403 from `GET /api/settings`).
