# Shared helpers for Anvil deploy scripts. Dot-source only:  . "$PSScriptRoot\_anvil-common.ps1"
# Windows PowerShell 5.1 compatible. Never prints secrets.

$ErrorActionPreference = 'Stop'
$env:PYTHONUTF8 = '1'
$env:AWS_PAGER = ''

# Distribution that serves paying Hovarns/Horvans Edu customers. Never touched by Anvil scripts.
$script:ForbiddenDistributionIds = @('ETM7IT2AITC6U')
$script:AnvilStackName = 'Anvil'          # hardcoded on purpose
$script:AnvilRepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

function Invoke-Aws {
  param([Parameter(Mandatory)][string[]]$AwsArgs, [switch]$AllowFail)
  $out = & aws @AwsArgs
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFail) {
    throw "aws $($AwsArgs[0]) $($AwsArgs[1]) failed (exit $code)"
  }
  if ($AllowFail) { return [pscustomobject]@{ Code = $code; Out = ($out -join "`n") } }
  return ($out -join "`n")
}

function Assert-SafeBucketName {
  param([Parameter(Mandatory)][string]$Bucket)
  if ($Bucket -match '(?i)hovarns|horvans') {
    throw "REFUSING: bucket '$Bucket' looks like a Hovarns/Horvans bucket. Anvil scripts only write to anvil-site-<account>."
  }
  if ($Bucket -notmatch '^anvil-site-\d{12}$') {
    throw "REFUSING: bucket '$Bucket' is not of the form anvil-site-<12-digit account>."
  }
}

# Looks up the Anvil stack outputs and cross-checks that the distribution really fronts the Anvil bucket.
function Get-AnvilTargets {
  param([Parameter(Mandatory)][string]$AwsProfile, [Parameter(Mandatory)][string]$Region)

  $json = Invoke-Aws -AwsArgs @('cloudformation', 'describe-stacks', '--stack-name', $script:AnvilStackName,
    '--region', $Region, '--profile', $AwsProfile, '--query', 'Stacks[0].Outputs', '--output', 'json')
  $outputs = @{}
  foreach ($o in ($json | ConvertFrom-Json)) { $outputs[$o.OutputKey] = $o.OutputValue }

  $bucket = $outputs['SiteBucketName']
  $distId = $outputs['DistributionId']
  if (-not $bucket -or -not $distId) { throw "Stack '$($script:AnvilStackName)' in $Region has no SiteBucketName/DistributionId outputs. Deployed?" }

  Assert-SafeBucketName -Bucket $bucket
  if ($script:ForbiddenDistributionIds -contains $distId) { throw "REFUSING: distribution $distId belongs to Hovarns." }
  if ($distId -notmatch '^E[A-Z0-9]{8,20}$') { throw "Unexpected distribution id format: $distId" }

  # The distribution must have the Anvil bucket as an origin, and must not carry any Hovarns alias.
  $cfg = Invoke-Aws -AwsArgs @('cloudfront', 'get-distribution', '--id', $distId, '--profile', $AwsProfile,
    '--query', 'Distribution.DistributionConfig.{origins: Origins.Items[].DomainName, aliases: Aliases.Items}', '--output', 'json') | ConvertFrom-Json
  $originHit = @($cfg.origins | Where-Object { $_ -like "$bucket.s3.*" })
  if ($originHit.Count -eq 0) { throw "REFUSING: distribution $distId does not use bucket $bucket as an origin." }
  foreach ($a in @($cfg.aliases)) {
    if ($a -and $a -ne 'anvil.horvans.com') { throw "REFUSING: distribution $distId carries unexpected alias '$a'." }
  }

  return [pscustomobject]@{
    Bucket         = $bucket
    DistributionId = $distId
    DomainName     = $outputs['DistributionDomainName']
    SiteUrl        = $outputs['SiteUrl']
  }
}

function Invoke-AnvilInvalidation {
  param([Parameter(Mandatory)]$Targets, [Parameter(Mandatory)][string]$AwsProfile, [Parameter(Mandatory)][string[]]$Paths, [switch]$DryRun)
  if ($script:ForbiddenDistributionIds -contains $Targets.DistributionId) { throw 'REFUSING: Hovarns distribution.' }
  if ($DryRun) {
    Write-Host "[dry-run] would invalidate on $($Targets.DistributionId): $($Paths -join ' ')"
    return
  }
  $args2 = @('cloudfront', 'create-invalidation', '--distribution-id', $Targets.DistributionId, '--profile', $AwsProfile,
    '--query', 'Invalidation.Id', '--output', 'text', '--paths') + $Paths
  $id = Invoke-Aws -AwsArgs $args2
  Write-Host "Invalidation $id created on $($Targets.DistributionId) for: $($Paths -join ' ')"
}

# Cheap pre-upload scan for real-looking secrets. Reports file + pattern name only, never the match.
function Find-SecretLikeFiles {
  param([Parameter(Mandatory)][string]$Dir)
  $patterns = [ordered]@{
    'stripe-live-key'   = 'sk_live_[0-9A-Za-z]{10,}'
    'aws-access-key-id' = '(AKIA|ASIA)[0-9A-Z]{16}'
    'private-key-block' = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    'anthropic-key'     = 'sk-ant-[0-9A-Za-z_-]{20,}'
    'github-token'      = '(ghp|gho|ghs|ghu|github_pat)_[0-9A-Za-z_]{20,}'
  }
  $hits = @()
  Get-ChildItem -Path $Dir -Recurse -File | Where-Object { $_.Length -lt 5MB } | ForEach-Object {
    $file = $_
    $text = $null
    try { $text = [System.IO.File]::ReadAllText($file.FullName) } catch { return }
    foreach ($name in $patterns.Keys) {
      if ($text -match $patterns[$name]) {
        $hits += [pscustomobject]@{ File = $file.FullName.Substring($Dir.Length).TrimStart('\').Replace('\', '/'); Pattern = $name }
      }
    }
  }
  return $hits
}
