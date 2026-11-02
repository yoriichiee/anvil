<#
.SYNOPSIS
  Sync anvil\site to the Anvil bucket with correct Content-Type + Cache-Control, then invalidate the Anvil distribution.

.DESCRIPTION
  - Bucket and distribution come ONLY from stack "Anvil" outputs; any bucket name containing 'hovarns' is refused,
    and the distribution must use that bucket as its origin.
  - /dl/*, /registry/*, /install.sh, /install.ps1 are owned by publish-dl.ps1 and are never touched or deleted here.
  - Real-looking secrets block the upload (fake demo keys under demo-app/ only warn).
  - -WhatIf: dry run (aws s3 sync --dryrun, no invalidation).

.EXAMPLE
  .\deploy-site.ps1 -WhatIf
  .\deploy-site.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AwsProfile = 'hovarn',
  [string]$Region = 'ap-southeast-2',
  [string]$SiteDir = ''
)

. "$PSScriptRoot\_anvil-common.ps1"

$dry = [bool]$WhatIfPreference
$WhatIfPreference = $false   # we implement dry-run ourselves via --dryrun

if (-not $SiteDir) { $SiteDir = Join-Path $script:AnvilRepoRoot 'site' }
if (-not (Test-Path (Join-Path $SiteDir 'index.html'))) { throw "No index.html in $SiteDir (W3 builds the site)." }
$SiteDir = (Resolve-Path $SiteDir).Path

# 1. Secret pre-scan
$hits = @(Find-SecretLikeFiles -Dir $SiteDir)
$blocking = @($hits | Where-Object { $_.File -notlike 'demo-app/*' })
foreach ($h in $hits) { Write-Warning "secret-like pattern '$($h.Pattern)' in $($h.File)" }
if ($blocking.Count -gt 0) { throw "REFUSING to upload: secret-like content outside demo-app/ (see warnings). Remove it first." }

# 2. Targets (stack output lookup + safety checks)
$t = Get-AnvilTargets -AwsProfile $AwsProfile -Region $Region
Write-Host "Target bucket: $($t.Bucket)   distribution: $($t.DistributionId)   url: $($t.SiteUrl)"
if ($dry) { Write-Host '[dry-run] no objects will change' }

# Never upload or delete these from the site sync.
$globalExcludes = @(
  'dl/*', 'registry/*', 'install.sh', 'install.ps1',
  '.env', '.env.*', '*/.env', '*/.env.*', '*.pem', '*.key',
  '.git/*', '*/.git/*', 'node_modules/*', '*/node_modules/*', '.DS_Store', '*/.DS_Store', 'Thumbs.db', '*/Thumbs.db'
)

$htmlCache = 'public, max-age=0, s-maxage=300, must-revalidate'
$assetCache = 'public, max-age=3600, s-maxage=86400'
$groups = @(
  @{ Patterns = @('*.html');              Type = 'text/html; charset=utf-8';                 Cache = $htmlCache },
  @{ Patterns = @('*.css');               Type = 'text/css; charset=utf-8';                  Cache = $assetCache },
  @{ Patterns = @('*.js', '*.mjs');       Type = 'text/javascript; charset=utf-8';           Cache = $assetCache },
  @{ Patterns = @('*.json');              Type = 'application/json; charset=utf-8';          Cache = 'public, max-age=300' },
  @{ Patterns = @('*.svg');               Type = 'image/svg+xml';                            Cache = $assetCache },
  @{ Patterns = @('*.webmanifest');       Type = 'application/manifest+json';                Cache = $assetCache },
  @{ Patterns = @('*.txt', '*.md');       Type = 'text/plain; charset=utf-8';                Cache = 'public, max-age=300' },
  @{ Patterns = @('*.woff2');             Type = 'font/woff2';                               Cache = 'public, max-age=31536000, immutable' },
  @{ Patterns = @('*.png');               Type = 'image/png';                                Cache = $assetCache },
  @{ Patterns = @('*.jpg', '*.jpeg');     Type = 'image/jpeg';                               Cache = $assetCache },
  @{ Patterns = @('*.webp');              Type = 'image/webp';                               Cache = $assetCache },
  @{ Patterns = @('*.ico');               Type = 'image/x-icon';                             Cache = $assetCache }
)

function Invoke-Sync([string[]]$includes, [string[]]$excludes, [string]$type, [string]$cache) {
  $a = @('s3', 'sync', $SiteDir, "s3://$($t.Bucket)/", '--profile', $AwsProfile, '--region', $Region, '--delete', '--no-progress')
  if ($includes) { $a += @('--exclude', '*'); foreach ($p in $includes) { $a += @('--include', $p) } }
  foreach ($p in $excludes) { $a += @('--exclude', $p) }
  if ($type) { $a += @('--content-type', $type) }
  $a += @('--cache-control', $cache)
  if ($dry) { $a += '--dryrun' }
  & aws @a
  if ($LASTEXITCODE -ne 0) { throw "aws s3 sync failed (exit $LASTEXITCODE)" }
}

# 3. Typed passes (each pass only adds/deletes keys matching its own patterns)
$typed = @()
foreach ($g in $groups) {
  Write-Host "-- $($g.Patterns -join ',')  ->  $($g.Type)"
  Invoke-Sync -includes $g.Patterns -excludes $globalExcludes -type $g.Type -cache $g.Cache
  $typed += $g.Patterns
}
# 4. Everything else: CLI guesses the type
Write-Host '-- everything else (type guessed)'
Invoke-Sync -includes $null -excludes ($typed + $globalExcludes) -type $null -cache 'public, max-age=86400'

# 5. Invalidate the Anvil distribution only
Invoke-AnvilInvalidation -Targets $t -AwsProfile $AwsProfile -Paths @('/*') -DryRun:$dry
Write-Host 'Note: aws s3 sync skips unchanged files, so header-only changes need the object re-uploaded.'
Write-Host "Done. $($t.SiteUrl)"
