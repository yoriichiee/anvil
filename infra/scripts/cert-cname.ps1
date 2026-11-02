<#
.SYNOPSIS
  Read-only: print the ACM DNS-validation CNAME for anvil.horvans.com (us-east-1) to add at Hostinger.
  Run it while `cdk deploy AnvilCert` is waiting in CREATE_IN_PROGRESS.
#>
param(
  [string]$AwsProfile = 'hovarn',
  [string]$DomainName = 'anvil.horvans.com'
)
. "$PSScriptRoot\_anvil-common.ps1"

$arns = Invoke-Aws -AwsArgs @('acm', 'list-certificates', '--region', 'us-east-1', '--profile', $AwsProfile,
  '--certificate-statuses', 'PENDING_VALIDATION', 'ISSUED',
  '--query', "CertificateSummaryList[?DomainName=='$DomainName'].CertificateArn", '--output', 'json') | ConvertFrom-Json
if (-not $arns -or @($arns).Count -eq 0) { Write-Host "No ACM certificate for $DomainName in us-east-1 yet (deploy AnvilCert first)."; return }

foreach ($arn in @($arns)) {
  $c = Invoke-Aws -AwsArgs @('acm', 'describe-certificate', '--region', 'us-east-1', '--profile', $AwsProfile,
    '--certificate-arn', $arn, '--query', 'Certificate.{status: Status, rr: DomainValidationOptions[0].ResourceRecord}', '--output', 'json') | ConvertFrom-Json
  Write-Host "Certificate: $arn  ($($c.status))"
  if ($c.rr) {
    $hostPart = $c.rr.Name.TrimEnd('.') -replace "\.horvans\.com$", ''
    Write-Host '  Add at Hostinger (DNS zone horvans.com):'
    Write-Host "    Type : CNAME"
    Write-Host "    Name : $hostPart        (full: $($c.rr.Name))"
    Write-Host "    Value: $($c.rr.Value)"
  } else {
    Write-Host '  Validation record not generated yet; re-run in ~30 s.'
  }
}
