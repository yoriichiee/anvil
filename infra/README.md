# Anvil infra (CDK v2, TypeScript)

Hosting for **anvil.horvans.com**. It is a separate stack that shares no resources with any other site and never touches them.

| Stack | Region | Contents |
|---|---|---|
| `AnvilCert` | us-east-1 | ACM certificate for anvil.horvans.com, validated by DNS (CNAME at Hostinger). CloudFront only accepts certificates from us-east-1. |
| `Anvil` | project Region (`-c region=`, default `ap-southeast-2`) | Private versioned S3 bucket `anvil-site-<acct>` (OAC), CloudFront + CloudFront Function (index rewrite) + response-headers policy, HTTP API (10 rps / burst 20) â†’ Lambda `anvil-api` (Node 20, code from `../api`; stub if missing), DynamoDB `anvil-main` (pk/sk, TTL `ttl`, on-demand, PITR), KMS key `alias/anvil-github-tokens`, 14-day log retention. |

Every resource is tagged `Project=anvil`. The stacks use no WAF and no Lambda@Edge. The app refuses to synthesize `Anvil` in us-east-1.

## Context

| key (alias) | default | meaning |
|---|---|---|
| `anvil:region` (`region`) | ap-southeast-2 | project Region for the `Anvil` stack |
| `anvil:certificateArn` (`certArn`) | empty | us-east-1 cert ARN. When empty, the site serves only on `dXXXX.cloudfront.net` (fallback link #2). |
| `anvil:domainName` | anvil.horvans.com | alias + cert domain |
| `anvil:apiDir` (`apiDir`) | ../api | Lambda code dir (`index.mjs`, `export const handler`) |
| `anvil:lambdaRuntime` (`lambdaRuntime`) | nodejs20.x | `nodejs22.x` is also allowed. **nodejs20.x was deprecated on 2026-04-30; creating it is blocked from 2027-02-01.** |

## Verify locally (no AWS changes)

```powershell
cd infra                           # from the repo root
npm install
npx tsc --noEmit
npx cdk synth                      # both stacks -> cdk.out\
npx cdk synth -c certArn=arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333-4444-555555555555
.\scripts\preflight.ps1            # read-only: identity, plan, Region, bootstrap, cdk diff --no-change-set
.\scripts\deploy-site.ps1 -WhatIf  # dry run (needs the Anvil stack deployed for output lookup)
.\scripts\publish-dl.ps1 -WhatIf
```

## Deploy (founder only, after approving the `cdk diff` output)

1. Confirm the Region in AWS Settings > View all projects > Overview > Additional Info > Region, then run `.\scripts\preflight.ps1`.
2. **Certificate.** On 2026-11-02 the project's managed SCP **explicitly denies CloudFormation in us-east-1** (`cloudformation:DescribeStacks` on `AnvilCert`/`CDKToolkit`), so `cdk deploy AnvilCert` will fail. ACM itself works in us-east-1.
   - Working path: `.\scripts\request-cert.ps1 -WhatIf`, then `.\scripts\request-cert.ps1`. This requests the cert via the ACM CLI, or reuses an existing one, and prints the CNAME.
   - If the SCP is ever lifted: `npx cdk bootstrap aws://<acct>/us-east-1`, then `npx cdk deploy AnvilCert --profile hovarn`. While it waits, run `.\scripts\cert-cname.ps1`.
   - Either way, add the printed CNAME in Hostinger's horvans.com zone.
3. Before the cert is issued: `npx cdk deploy Anvil --profile hovarn` gives you the raw CloudFront domain.
   After it is issued: `npx cdk deploy Anvil --profile hovarn -c certArn=<arn>`, or put the ARN in `cdk.json`.
4. At Hostinger, add CNAME `anvil` â†’ the `DistributionDomainName` output.
5. Create the SSM SecureStrings yourself. IaC never holds the values.
   ```powershell
   aws ssm put-parameter --profile hovarn --name /anvil/github --type SecureString --value '<json>'
   aws ssm put-parameter --profile hovarn --name /anvil/anthropic --type SecureString --value '<key>'
   ```
6. Run `.\scripts\deploy-site.ps1`, then `.\scripts\publish-dl.ps1`.

## Scripts (`scripts\`)

| script | writes to AWS? | what |
|---|---|---|
| `preflight.ps1` | no | Runs sts identity, `freetier get-account-plan-state`, the Region check, bootstrap/stack status, and `cdk diff` for each stack with `--no-change-set`. |
| `cert-cname.ps1` | no | Prints the ACM validation CNAME for anvil.horvans.com. |
| `request-cert.ps1` | yes (1 ACM cert) | Fallback for AnvilCert (SCP). Idempotent. Supports `-WhatIf`. |
| `deploy-site.ps1` | yes | Syncs `..\site` to the Anvil bucket. Supports `-WhatIf`. Details below. |
| `publish-dl.ps1` | yes | Uploads the tarballs, `SHA256SUMS`, installers and the registry. Supports `-WhatIf`. Details below. |

`deploy-site.ps1`:
- Takes the bucket and distribution from the `Anvil` stack outputs only. It refuses any bucket matching `hovarns`/`horvans` or not named `anvil-site-<12 digits>`, and refuses a distribution that does not use that bucket as an origin.
- Before uploading, it scans for secrets and blocks the upload if it finds one. Fakes under `demo-app/` only produce a warning.
- It syncs file type by file type, setting Content-Type and Cache-Control for each:
  - html: `max-age=0, s-maxage=300`
  - css/js/images: `max-age=3600`
  - json: `max-age=300`
- It never touches `dl/*`, `registry/*`, `install.sh` or `install.ps1`.
- It then runs `/*` invalidation on the Anvil distribution only.

`publish-dl.ps1`:
- Before uploading anything, it checks every `dist\*.tgz` against `dist\SHA256SUMS`.
- A published version cannot be overwritten. If a different sha256 is already stored under the same name, the script refuses unless you pass `-Force`; bucket versioning keeps the old bytes.
- It refuses an `install.sh` with CRLF line endings.
- Destinations and cache times:
  - `/dl/anvil-<ver>.tgz`: immutable, 1 year
  - `/dl/SHA256SUMS`: 5 minutes
  - `/install.sh`, `/install.ps1`, `/registry/index.json`: 5 minutes
- It looks for the registry at `registry\`, `dist\registry\`, `addons-spec\registry\` or `site\registry\`, or at the path you pass with `-RegistryFile`.

## Notes
- CSP: `script-src 'self'`. Scripts must be vendored under `site/`; no CDN scripts are allowed. Google Fonts CSS and fonts are allowed. `frame-ancestors 'none'` applies everywhere except `/demo-app/*`, which uses `'self'` so the `/demo` replay can iframe it.
- Index rewrite: `/x` serves `/x/index.html` with no redirect, so pages should use root-absolute asset URLs (`/assets/...`).
- `/dl/*` is served uncompressed, so the downloaded bytes always match `SHA256SUMS`.
- The site bucket, table and KMS key are `RETAIN`ed when a stack is deleted. Log groups are deleted.
- Expected idle cost: about $1/month for the KMS key, plus pennies of usage.
