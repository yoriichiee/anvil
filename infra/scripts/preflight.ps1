<#
.SYNOPSIS
  Read-only preflight before any Anvil deploy. Changes nothing in AWS.

.DESCRIPTION
  1. aws sts get-caller-identity
  2. aws freetier get-account-plan-state  (FREE vs PAID plan)
  3. prints the Region (param, profile config) and where to confirm it in AWS Settings
  4. reports CDK bootstrap status in us-east-1 and the project Region (describe only; never bootstraps)
  5. npx cdk diff AnvilCert Anvil --no-change-set  (no change sets are created)
  Show the diff output to the founder before any deploy.
#>
param(
  [string]$AwsProfile = 'hovarn',
  [string]$Region = 'ap-southeast-2',
  [string]$CertArn = ''
)

. "$PSScriptRoot\_anvil-common.ps1"
$infraDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

Write-Host '== 1. Caller identity'
& aws sts get-caller-identity --profile $AwsProfile --output table
if ($LASTEXITCODE -ne 0) { throw "Not signed in for profile '$AwsProfile' (try: aws login --profile $AwsProfile / aws sso login)." }

Write-Host '== 2. Account plan'
$plan = Invoke-Aws -AllowFail -AwsArgs @('freetier', 'get-account-plan-state', '--profile', $AwsProfile, '--region', 'us-east-1', '--output', 'json')
if ($plan.Code -eq 0) { $plan.Out } else { Write-Warning 'freetier get-account-plan-state failed (see error above).' }

Write-Host '== 3. Region'
$cfgRegion = (& aws configure get region --profile $AwsProfile)
Write-Host "Anvil stack Region (param): $Region"
Write-Host "Profile '$AwsProfile' region (~/.aws/config): $cfgRegion"
if ($cfgRegion -and $cfgRegion -ne $Region) { Write-Warning "Region mismatch: profile says $cfgRegion, script uses $Region." }
Write-Host 'Confirm the project Region in AWS Settings > View all projects > Overview > Additional Info > Region.'
Write-Host 'AnvilCert is the ONLY us-east-1 stack (ACM for CloudFront).'

Write-Host '== 4. CDK bootstrap (describe only)'
foreach ($r in @('us-east-1', $Region)) {
  $b = Invoke-Aws -AllowFail -AwsArgs @('cloudformation', 'describe-stacks', '--stack-name', 'CDKToolkit', '--region', $r,
    '--profile', $AwsProfile, '--query', 'Stacks[0].StackStatus', '--output', 'text')
  if ($b.Code -eq 0) { Write-Host "  $r : CDKToolkit $($b.Out)" } else { Write-Host "  $r : NOT bootstrapped (founder runs: npx cdk bootstrap aws://<acct>/$r --profile $AwsProfile)" }
}
foreach ($s in @(@{ n = 'AnvilCert'; r = 'us-east-1' }, @{ n = 'Anvil'; r = $Region })) {
  $st = Invoke-Aws -AllowFail -AwsArgs @('cloudformation', 'describe-stacks', '--stack-name', $s.n, '--region', $s.r,
    '--profile', $AwsProfile, '--query', 'Stacks[0].StackStatus', '--output', 'text')
  if ($st.Code -eq 0) { Write-Host "  stack $($s.n) ($($s.r)): $($st.Out)" } else { Write-Host "  stack $($s.n) ($($s.r)): not deployed" }
}

if (-not $CertArn) {
  $c = Invoke-Aws -AllowFail -AwsArgs @('cloudformation', 'describe-stacks', '--stack-name', 'AnvilCert', '--region', 'us-east-1',
    '--profile', $AwsProfile, '--query', "Stacks[0].Outputs[?OutputKey=='CertificateArn'].OutputValue | [0]", '--output', 'text')
  if ($c.Code -eq 0 -and $c.Out -match '^arn:aws:acm:us-east-1:') { $CertArn = $c.Out.Trim(); Write-Host "Using cert from AnvilCert: $CertArn" }
}

Write-Host '== 5. cdk diff (read-only, no change sets)'
Push-Location $infraDir
try {
  # One stack per call, so an SCP denial on us-east-1 CloudFormation does not hide the Anvil diff.
  foreach ($stack in @('AnvilCert', 'Anvil')) {
    Write-Host "---- cdk diff $stack"
    $diffArgs = @('cdk', 'diff', $stack, '--profile', $AwsProfile, '--no-change-set', '--no-notices', '-c', "region=$Region")
    if ($CertArn) { $diffArgs += @('-c', "certArn=$CertArn") }
    & npx @diffArgs
    Write-Host "cdk diff $stack exit code: $LASTEXITCODE (1 = differences found, expected before first deploy)"
  }
  Write-Host 'If AnvilCert fails with an SCP explicit deny on cloudformation in us-east-1, use scripts\request-cert.ps1 instead (see README).'
} finally { Pop-Location }
