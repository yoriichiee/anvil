<#
.SYNOPSIS
  Publish the pinned CLI tarball(s), SHA256SUMS, installers and the add-on registry to the Anvil bucket.

.DESCRIPTION
  Uploads (keys in the Anvil bucket; URLs on anvil.horvans.com):
    dist\anvil-<ver>.tgz (every dist\*.tgz)  -> /dl/<name>         immutable, 1 year
    dist\SHA256SUMS                          -> /dl/SHA256SUMS     5 min
    install\install.sh                       -> /install.sh        5 min
    install\install.ps1                      -> /install.ps1       5 min
    registry index.json (if found)           -> /registry/index.json 5 min
  Safety:
    - every tgz must be listed in SHA256SUMS with a matching hash (checked locally before any upload)
    - a published version is immutable: if /dl/<name> exists with a different sha256, it refuses (unless -Force)
    - install.sh with CRLF line endings is refused (it would break `curl | sh`)
    - same bucket/distribution guards as deploy-site.ps1 (stack output lookup, 'hovarns' refused)
  -WhatIf: dry run (aws s3 cp --dryrun, no invalidation).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AwsProfile = 'hovarn',
  [string]$Region = 'ap-southeast-2',
  [string]$DistDir = '',
  [string]$InstallDir = '',
  [string]$RegistryFile = '',
  [switch]$Force
)

. "$PSScriptRoot\_anvil-common.ps1"

$dry = [bool]$WhatIfPreference
$WhatIfPreference = $false

$root = $script:AnvilRepoRoot
if (-not $DistDir) { $DistDir = Join-Path $root 'dist' }
if (-not $InstallDir) { $InstallDir = Join-Path $root 'install' }
if (-not $RegistryFile) {
  foreach ($c in @('registry\index.json', 'dist\registry\index.json', 'addons-spec\registry\index.json', 'addons-spec\repo-template\index.json', 'site\registry\index.json')) {
    $p = Join-Path $root $c
    if (Test-Path $p) { $RegistryFile = $p; break }
  }
}

$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$mainTgz = Join-Path $DistDir "anvil-$version.tgz"
$sumsFile = Join-Path $DistDir 'SHA256SUMS'
if (-not (Test-Path $mainTgz)) { throw "Missing $mainTgz (run: npm run pack:dl)" }
if (-not (Test-Path $sumsFile)) { throw "Missing $sumsFile (run: npm run pack:dl)" }

# --- local integrity checks -------------------------------------------------------------------------
$sums = @{}
foreach ($line in (Get-Content $sumsFile)) {
  if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S+)\s*$') { $sums[$Matches[2]] = $Matches[1].ToLower() }
}
$tgzs = @(Get-ChildItem -Path $DistDir -Filter '*.tgz' -File)
foreach ($f in $tgzs) {
  if ($f.Name -notmatch '^anvil-\d+\.\d+\.\d+([-.][0-9A-Za-z.]+)?\.tgz$') { throw "Unexpected tarball name: $($f.Name)" }
  $h = (Get-FileHash -Algorithm SHA256 -Path $f.FullName).Hash.ToLower()
  if (-not $sums.ContainsKey($f.Name)) { throw "$($f.Name) is not listed in SHA256SUMS" }
  if ($sums[$f.Name] -ne $h) { throw "SHA256 mismatch for $($f.Name): SHA256SUMS says $($sums[$f.Name]), file is $h" }
}
Write-Host "Local check ok: $($tgzs.Count) tarball(s) match SHA256SUMS (version $version)"

$installers = @()
foreach ($n in @('install.sh', 'install.ps1')) {
  $p = Join-Path $InstallDir $n
  if (Test-Path $p) { $installers += $p } else { Write-Warning "installer missing: $p (skipped)" }
}
$sh = Join-Path $InstallDir 'install.sh'
if ((Test-Path $sh) -and ([System.IO.File]::ReadAllText($sh).Contains("`r`n"))) {
  throw 'install.sh has CRLF line endings; convert to LF before publishing.'
}
if ($RegistryFile) {
  try { $null = Get-Content $RegistryFile -Raw | ConvertFrom-Json } catch { throw "Registry file is not valid JSON: $RegistryFile" }
} else {
  Write-Warning 'No registry index.json found (looked in registry\, dist\registry\, addons-spec\registry\, site\registry\); skipped.'
}

# --- targets ----------------------------------------------------------------------------------------
$t = Get-AnvilTargets -AwsProfile $AwsProfile -Region $Region
Write-Host "Target bucket: $($t.Bucket)   distribution: $($t.DistributionId)"
if ($dry) { Write-Host '[dry-run] no objects will change' }

function Send-File([string]$path, [string]$key, [string]$type, [string]$cache, [string]$sha) {
  $a = @('s3', 'cp', $path, "s3://$($t.Bucket)/$key", '--profile', $AwsProfile, '--region', $Region,
    '--content-type', $type, '--cache-control', $cache, '--no-progress')
  if ($sha) { $a += @('--metadata', "sha256=$sha") }
  if ($dry) { $a += '--dryrun' }
  & aws @a
  if ($LASTEXITCODE -ne 0) { throw "upload failed: $key" }
}

# --- tarballs: immutable per version ----------------------------------------------------------------
foreach ($f in $tgzs) {
  $key = "dl/$($f.Name)"
  $h = $sums[$f.Name]
  $head = Invoke-Aws -AllowFail -AwsArgs @('s3api', 'head-object', '--bucket', $t.Bucket, '--key', $key,
    '--profile', $AwsProfile, '--region', $Region, '--query', 'Metadata.sha256', '--output', 'text')
  if ($head.Code -eq 0) {
    $remote = $head.Out.Trim().ToLower()
    if ($remote -eq $h) { Write-Host "= $key already published with same sha256; skipped"; continue }
    if (-not $Force) { throw "REFUSING: $key already published with sha256 '$remote' (local $h). Bump the version, or pass -Force (old bytes stay recoverable via bucket versioning)." }
    Write-Warning "-Force: overwriting $key"
  }
  Send-File $f.FullName $key 'application/gzip' 'public, max-age=31536000, immutable' $h
}
Send-File $sumsFile 'dl/SHA256SUMS' 'text/plain; charset=utf-8' 'public, max-age=300' $null
foreach ($p in $installers) {
  Send-File $p (Split-Path $p -Leaf) 'text/plain; charset=utf-8' 'public, max-age=300' $null
}
if ($RegistryFile) {
  # Pack files first (the index points at packs/<id>/<ver>/anvil-addon.json, relative to /registry/), then the index.
  $packsDir = Join-Path (Split-Path $RegistryFile -Parent) 'packs'
  if (Test-Path $packsDir) {
    $regRoot = (Resolve-Path (Split-Path $RegistryFile -Parent)).Path.TrimEnd('\')
    foreach ($pf in @(Get-ChildItem -Path $packsDir -Recurse -File -Filter 'anvil-addon.json')) {
      $rel = $pf.FullName.Substring($regRoot.Length + 1).Replace('\', '/')
      if ($rel -notmatch '^packs/[a-z0-9][a-z0-9-]{1,63}/\d+\.\d+\.\d+[^/]*/anvil-addon\.json$') { throw "Unexpected pack path: $rel" }
      Send-File $pf.FullName "registry/$rel" 'application/json; charset=utf-8' 'public, max-age=31536000, immutable' $null
    }
  }
  Send-File $RegistryFile 'registry/index.json' 'application/json; charset=utf-8' 'public, max-age=300' $null
}

Invoke-AnvilInvalidation -Targets $t -AwsProfile $AwsProfile -DryRun:$dry `
  -Paths @('/dl/SHA256SUMS', '/install.sh', '/install.ps1', '/registry/*')
Write-Host "Done. $($t.SiteUrl)/dl/anvil-$version.tgz"
