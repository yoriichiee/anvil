# anvil-api (GitHub mode)

One Node 20 Lambda (`index.mjs`, export `handler`) behind an API Gateway **HTTP API** (payload format 2.0), reached through CloudFront at `https://anvil.horvans.com/api/*`. It has no npm dependencies: it uses global `fetch`, `node:crypto` and `node:zlib`, plus the AWS SDK v3 clients that ship in the Lambda runtime (`@aws-sdk/client-dynamodb`, `client-kms`, `client-ssm`, loaded lazily).

The hosted side **never runs repo code and never browses user URLs**. A repo scan downloads the GitHub tarball into `/tmp` and runs only two checks: a regex and entropy secret scan with redaction, and a static lint of Supabase and Firebase rules files.

## Routes

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/health` | none | `{ok, version, githubMode, demoScan}` |
| GET | `/api/auth/github/start` | none | Creates state and a PKCE verifier, then sends a 302 to GitHub. Sets the `__Host-anvil_oauth` cookie (10 min). |
| GET | `/api/auth/github/callback` | oauth cookie | The state must match the cookie and is single-use. Exchanges the code with `code_verifier`, encrypts the tokens with KMS, creates a session, sets the `__Host-anvil_session` cookie (7 days) and sends a 302 to `/app/`. On failure it sends a 302 to `/app/?error=denied\|state\|expired\|github\|bad_request`. |
| GET | `/api/me` | cookie | `{signedIn:false, signInUrl}` or `{signedIn:true, user, credits:{used,limit,remaining,resetsAt}, installUrl}` |
| POST | `/api/logout` | cookie + Origin | Deletes the session, revokes the GitHub token (best effort) and clears the cookie. |
| GET | `/api/repos` | cookie | `{repos:[{owner,name,fullName,private,defaultBranch,installationId,updatedAt}], installations, truncated, installUrl}` |
| POST | `/api/scan-repo` | cookie + Origin | Body `{owner, repo, ref?}`. Returns a report.json (schemaVersion "1", `target.kind: "github"`). |
| POST | `/api/ai` | cookie + Origin | Body `{task:"explain"\|"fix", finding:{title, why?, fix?, severity?, file?, line?}, context?}`. Returns `{text, model, truncated, credits}`. |
| POST | `/api/demo/scan` | Origin only | Body `{repoUrl:"https://github.com/owner/repo[/tree/ref]"}`. Public repos only. Returns a report.json. |

Errors are always JSON in the form `{error, message}`. `message` is safe to show to the user. A 429 response also carries `retryAfterSeconds` or `resetsAt` and, when it applies, a `Retry-After` header.

**Feature flag.** `GITHUB_MODE` defaults to `off`. While it is off:
- `/api/me`, `/api/repos`, `/api/scan-repo` and `/api/ai` return **503** `{error:"github_mode_off", message}`.
- `start` and `callback` return a small 503 HTML page.

`/api/health` always works. `/api/demo/scan` has its own flag, `DEMO_SCAN`, which defaults to `on`.

## Environment variables

| Name | Default | Purpose |
|---|---|---|
| `GITHUB_MODE` | `off` | `on` enables sign-in, repos, scan-repo and ai |
| `DEMO_SCAN` | `on` | `off` disables `/api/demo/scan` |
| `TABLE_NAME` | (required) | DynamoDB table `anvil-main` (pk/sk strings, TTL attribute **`ttl`**) |
| `KMS_KEY_ID` | (required) | KMS key ID, ARN or alias used to encrypt GitHub user tokens |
| `SSM_GITHUB_PARAM` | `/anvil/github` | SecureString JSON `{"appId","clientId","clientSecret","appSlug"}` |
| `SSM_ANTHROPIC_PARAM` | `/anvil/anthropic` | SecureString: either the raw API key or `{"apiKey":"..."}` |
| `SITE_ORIGIN` | `https://anvil.horvans.com` | Used for the OAuth callback URL, the `/app/` redirect, and the CORS and Origin allow-list |
| `EXTRA_ORIGINS` | (empty) | Comma-separated extra allowed origins, e.g. the raw `https://dXXXX.cloudfront.net` |
| `GLOBAL_AI_DAILY_CAP` | `200` | AI calls per UTC day, across all users |
| `USER_AI_MONTHLY_CAP` | `3` | AI calls per GitHub user per UTC month |
| `DEMO_IP_DAILY_CAP` | `5` | Demo scans per viewer IP per day (the IP is stored only as a hash) |
| `DEMO_GLOBAL_DAILY_CAP` | `200` | Demo scans per day, across all viewers |
| `SCAN_USER_DAILY_CAP` | `20` | Signed-in repo scans per user per day |
| `SCAN_GLOBAL_DAILY_CAP` | `500` | Signed-in repo scans per day, across all users |
| `MAX_TARBALL_MB` | `50` | Compressed archive cap; above it the API returns 413 |
| `ANTHROPIC_MODEL` | `claude-haiku-5-5` | Model used for `/api/ai` |
| `ORIGIN_VERIFY_SECRET` | (empty) | If set, every request must carry `x-anvil-origin-verify` with this value. CloudFront adds it as an origin custom header, so direct `execute-api` calls are refused. |
| `ANVIL_VERSION` | `0.2.0` | Reported by health and in reports |

Every counter is updated with a single DynamoDB `TransactWriteItems` call that holds conditional `ADD`s. Either all counters move or none do. When the AI provider fails, the credit is refunded.

## What the infra (W4) must provide

- **Lambda.** Runtime `nodejs20.x` (or later), handler `index.handler`, code = this `api/` folder.
  - Exclude `*.test.mjs`, `_testkit.mjs` and `app.html`.
  - Memory 1024 MB, timeout **29 s** (the HTTP API integration limit is 30 s). The default 512 MB of ephemeral `/tmp` is enough.
- **IAM permissions:**
  - `dynamodb:GetItem`, `PutItem`, `UpdateItem` and `DeleteItem` on the table.
  - `dynamodb:ConditionCheckItem` is not needed. `TransactWriteItems` is authorized through the per-item `UpdateItem` permission.
  - `kms:Encrypt` and `kms:Decrypt` on the key.
  - `ssm:GetParameter` on `/anvil/github` and `/anvil/anthropic`.
  - `kms:Decrypt` for the SSM key, if it is a customer-managed key.
- **DynamoDB.** On-demand table with `pk` (S) and `sk` (S), and TTL enabled on the attribute `ttl`.
- **HTTP API.**
  - Route `ANY /api/{proxy+}` (or `$default`) goes to the Lambda.
  - **Do not configure CORS on the HTTP API.** The Lambda answers `OPTIONS` itself and allows only `SITE_ORIGIN`.
  - Throttling: 10 rps, burst 20.
  - Optional: disable the default `execute-api` endpoint, or use `ORIGIN_VERIFY_SECRET`.
- **CloudFront `/api/*` behaviour:**
  - Caching disabled.
  - Allowed methods GET, HEAD, OPTIONS, PUT, POST, PATCH, DELETE.
  - The origin request policy forwards all query strings and cookies, plus the headers `Origin`, `Content-Type`, `Sec-Fetch-Site`, and **`CloudFront-Viewer-Address`**. The demo's per-IP limit depends on that last header; without it every viewer shares the edge IP.
  - Do not forward `Host`.
- **Logs.** CloudWatch Logs in the project Region. The Lambda logs only the route, status, duration, request ID and error class: never bodies, cookies, tokens or IPs.

## GitHub App the founder must create

github.com → Settings → Developer settings → GitHub Apps → **New GitHub App**:

- **Name:** `Anvil by Horvans`. The URL slug it gets (for example `anvil-by-horvans`) goes into `appSlug`.
- **Homepage URL:** `https://anvil.horvans.com`
- **Callback URL:** `https://anvil.horvans.com/api/auth/github/callback`
  - Add the raw CloudFront URL as a second callback only if you also set `SITE_ORIGIN` to it.
- **Expire user authorization tokens:** **on**. That gives 8 h access tokens plus refresh tokens, and the API refreshes them automatically.
- **Request user authorization (OAuth) during installation:** on (recommended), so a user who installs is signed in straight away.
- **Enable Device Flow:** off.
- **Webhook:** **Active = off**. No webhook URL or secret is needed.
- **Repository permissions:** **Contents: Read-only** and **Metadata: Read-only**. Nothing else; no organization or account permissions.
- **Where can this GitHub App be installed:** Any account.
- After creating it:
  1. Note the **App ID** and **Client ID**.
  2. **Generate a new client secret.**
  3. No private key is needed: the API uses only user-to-server tokens.
  4. Store everything:

```powershell
aws ssm put-parameter --profile hovarn --name /anvil/github --type SecureString --value '{"appId":"123456","clientId":"Iv23li...","clientSecret":"<secret>","appSlug":"anvil-by-horvans"}'
aws ssm put-parameter --profile hovarn --name /anvil/anthropic --type SecureString --value '<anthropic api key>'
```

Run both commands in the project's selected Region (ap-southeast-2 per the plan; confirm it in AWS Settings first). Then set a $10 monthly cap in the Anthropic console.

How it works for users: a GitHub App user token can see only the repos where the app is installed. `/api/me` and `/api/repos` therefore return `installUrl` (`https://github.com/apps/<appSlug>/installations/new`), and the UI should show it whenever the repo list is empty.

## Security notes

- **CSRF protection:**
  - OAuth uses a 256-bit `state` that is stored hashed in DynamoDB, bound to a `__Host-` HttpOnly cookie and usable once, together with PKCE S256.
  - Every POST requires `Origin` to be one of the allowed origins, rejects a cross-site `Sec-Fetch-Site`, and requires `Content-Type: application/json`.
  - Cookies are `HttpOnly; Secure; SameSite=Lax`.
- **Sessions.** The session ID (256 bits) is stored only as a SHA-256 hash. GitHub access and refresh tokens are KMS-encrypted with encryption context `{app, purpose, uid}`.
- **Download safety.** The tarball is fetched with `redirect: manual`. The redirect must point to `https://codeload.github.com`, and the token is never sent there.
- **Scan limits.**
  - 50 MB compressed and 300 MB unpacked.
  - 25,000 entries; files over 1 MB are skipped and listed.
  - A 20 s deadline.
  - Symlinks are never followed and nothing is written to disk except the archive, which is deleted afterwards.
- **Secret handling.** Secrets in findings are redacted, e.g. `sk_live_[REDACTED 26 chars]`. Raw values never leave `lib/scan.mjs`.
- **AI input.** It is redacted deny-by-default (`lib/redact.mjs`); if redaction fails the API returns a 422 and makes no call. The text is fenced in `<untrusted>` tags, and the user's credit is charged only after redaction succeeds.
- **Honest output.** Reports never claim "secure", and `notChecked` always lists the browser checks, human checks, git history, the live deployed rules and "Overall security".

## Files

- `index.mjs`: router, guards, all routes, `createApp(deps)` for tests.
- `lib/http.mjs`: response, cookie, CORS and IP helpers.
- `lib/store.mjs`: `DynamoStore` (prod) and `MemoryStore` (tests).
- `lib/aws.mjs`: lazy SDK `send`, `KmsCrypto`, `SecretsLoader`.
- `lib/github.mjs`: OAuth, user, installations and repos, tarball download.
- `lib/tar.mjs`: minimal streaming tar reader (ustar, pax, GNU long names).
- `lib/secrets.mjs`: secret patterns, shared by the scan and redaction.
- `lib/scan.mjs`: the scanner and the report builder.
- `lib/redact.mjs`: redaction for model input.
- `lib/ai.mjs`: the Haiku call over raw `fetch`.
- `app.html`: sample `/app/` page. W3 owns the real one.

## Test

```powershell
node --test api/*.test.mjs
```

The tests mock AWS (`MemoryStore`, a fake KMS and SSM), GitHub and Anthropic (a fake `fetch`). They need no network, and they validate every report against `schemas/report.schema.json`. The fake keys in `_testkit.mjs` are assembled at runtime, so the repo contains no literal that GitHub push protection would flag.
