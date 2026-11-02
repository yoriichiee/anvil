<#
.SYNOPSIS
  Fallback for the AnvilCert stack: request the anvil.horvans.com ACM certificate directly in us-east-1.

.DESCRIPTION
  The project's managed SCP explicitly denies CloudFormation in us-east-1 (seen 2026-11-02 on
  cloudformation:DescribeStacks), so `cdk deploy AnvilCert` cannot run there. ACM itself is usable in
  us-east-1 (existing horvans.com certificates live there), and CloudFront requires the cert in us-east-1.
  This script is idempotent: if a PENDING_VALIDATION/ISSUED cert for the domain already exists it reuses it.
  CREATES REMOTE STATE (one ACM certificate, free) unless -WhatIf. Founder runs it after approving.
  Then: add the CNAME it prints at Hostinger, wait for ISSUED, and deploy Anvil with -c certArn=<arn>.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$AwsProfile = 'hovarn',
  [string]$DomainName = 'anvil.horvans.com'
)
. "$PSScriptRoot\_anvil-common.ps1"
$dry = [bool]$WhatIfPreference
$WhatIfPreference = $false

if ($DomainName -ne 'anvil.horvans.com' -and $DomainName -notlike '*.anvil.horvans.com') {
  throw "REFUSING: this script only requests certificates for anvil.horvans.com (got $DomainName)."
}

$existing = Invoke-Aws -AwsArgs @('acm', 'list-certificates', '--region', 'us-east-1', '--profile', $AwsProfile,
  '--certificate-statuses', 'PENDING_VALIDATION', 'ISSUED',
  '--query', "CertificateSummaryList[?DomainName=='$DomainName'].CertificateArn | [0]", '--output', 'text')
if ($existing -and $existing -ne 'None') {
  Write-Host "Reusing existing certificate: $existing"
} elseif ($dry) {
  Write-Host "[dry-run] would run: aws acm request-certificate --region us-east-1 --domain-name $DomainName --validation-method DNS --tags Key=Project,Value=anvil"
  return
} else {
  $existing = Invoke-Aws -AwsArgs @('acm', 'request-certificate', '--region', 'us-east-1', '--profile', $AwsProfile,
    '--domain-name', $DomainName, '--validation-method', 'DNS', '--idempotency-token', 'anvilsite1',
    '--tags', 'Key=Project,Value=anvil', '--query', 'CertificateArn', '--output', 'text')
  Write-Host "Requested certificate: $existing"
  Start-Sleep -Seconds 10   # ACM needs a few seconds to generate the validation record
}

& "$PSScriptRoot\cert-cname.ps1" -AwsProfile $AwsProfile -DomainName $DomainName
Write-Host ''
Write-Host "Next: after status is ISSUED, deploy with:  npx cdk deploy Anvil --profile $AwsProfile -c certArn=$existing"
Write-Host "      (or put it in cdk.json context 'anvil:certificateArn')."
