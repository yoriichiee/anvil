# Anvil installer for Windows (PowerShell 5.1+).
#   irm https://anvil.horvans.com/install.ps1 | iex
# Downloads one pinned version, verifies its SHA256, installs it globally with npm, and installs the Anvil skills
# for Claude Code (~/.claude/skills) and Codex (~/.codex/skills) when those tools are present.
# Testing overrides (optional):
#   $env:ANVIL_BASE_URL   folder that holds anvil-<ver>.tgz and SHA256SUMS (default https://anvil.horvans.com/dl)
#   $env:ANVIL_NPM_PREFIX install into this npm prefix instead of the global one
#   $env:ANVIL_HOME       use this folder instead of your home folder for .claude / .codex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $AnvilVersion = '0.2.0'
  $FileName = "anvil-$AnvilVersion.tgz"

  function Fail([string]$msg) { Write-Host "anvil install: $msg" -ForegroundColor Red; throw "anvil install failed" }

  $base = 'https://anvil.horvans.com/dl'
  if ($env:ANVIL_BASE_URL) { $base = $env:ANVIL_BASE_URL.TrimEnd('/') }
  $homeDir = $HOME
  if ($env:ANVIL_HOME) { $homeDir = $env:ANVIL_HOME }

  Write-Host "Installing Anvil $AnvilVersion"

  # Node 20+ and npm
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Fail 'Node.js 20 or newer is required. Install it from https://nodejs.org and run this again.' }
  $nodeVer = (& node -p "process.versions.node").Trim()
  if ([int]($nodeVer.Split('.')[0]) -lt 20) { Fail "Node.js 20 or newer is required (found $nodeVer)." }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail 'npm was not found. Reinstall Node.js with npm.' }

  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("anvil-install-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force $tmp | Out-Null
  try {
    $tgz = Join-Path $tmp $FileName
    $sums = Join-Path $tmp 'SHA256SUMS'
    Write-Host "Downloading $base/$FileName"
    try {
      Invoke-WebRequest -UseBasicParsing -Uri "$base/$FileName" -OutFile $tgz
      Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    } catch { Fail "download failed: $($_.Exception.Message)" }

    # Verify SHA256
    $line = Get-Content $sums | Where-Object { $_ -match "^\s*([0-9a-fA-F]{64})\s+\*?$([regex]::Escape($FileName))\s*$" } | Select-Object -First 1
    if (-not $line) { Fail "SHA256SUMS has no entry for $FileName." }
    $expected = ([regex]::Match($line, '[0-9a-fA-F]{64}')).Value.ToLower()
    $actual = (Get-FileHash -Algorithm SHA256 -Path $tgz).Hash.ToLower()
    if ($actual -ne $expected) { Fail "checksum mismatch for $FileName (expected $expected, got $actual). Nothing was installed." }
    Write-Host "SHA256 verified: $actual"

    # Install the verified local file
    $npmArgs = @('install', '-g', '--no-fund', '--no-audit')
    if ($env:ANVIL_NPM_PREFIX) { $npmArgs += @('--prefix', $env:ANVIL_NPM_PREFIX) }
    $npmArgs += $tgz
    & npm @npmArgs
    if ($LASTEXITCODE -ne 0) { Fail "npm install failed (exit $LASTEXITCODE)." }

    # Skills come from the same verified tarball (npm's own output can redact parts of paths, so we do not parse it).
    $unpack = Join-Path $tmp 'x'
    New-Item -ItemType Directory -Force $unpack | Out-Null
    & tar.exe -xzf $tgz -C $unpack package/skill
    if ($LASTEXITCODE -ne 0) { Fail "could not unpack the skills from $FileName (tar.exe exit $LASTEXITCODE)." }
    $skillSrc = Join-Path $unpack 'package\skill'
    if (-not (Test-Path $skillSrc)) { Fail "skills missing from $FileName" }

    $installed = @()
    foreach ($agent in @('.claude', '.codex')) {
      $agentDir = Join-Path $homeDir $agent
      if (-not (Test-Path $agentDir)) { continue }
      $skillsDir = Join-Path $agentDir 'skills'
      New-Item -ItemType Directory -Force $skillsDir | Out-Null
      foreach ($s in @('anvil', 'anvil-fix')) {
        $src = Join-Path $skillSrc $s
        if (-not (Test-Path $src)) { continue }
        $dst = Join-Path $skillsDir $s
        New-Item -ItemType Directory -Force $dst | Out-Null
        Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
        $installed += $dst
      }
    }
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }

  Write-Host ''
  Write-Host "Anvil $AnvilVersion is installed." -ForegroundColor Green
  if ($installed.Count) { $installed | ForEach-Object { Write-Host "  skill: $_" } }
  else { Write-Host '  No ~/.claude or ~/.codex folder found, so no skills were copied.' }
  Write-Host ''
  Write-Host 'Connect your agent (run once):'
  Write-Host '  claude mcp add anvil -- anvil-mcp'
  Write-Host '  codex mcp add anvil -- anvil-mcp'
  Write-Host ''
  Write-Host 'Then open your project and say "check my app before launch" (or "start anvil").'
  Write-Host 'Without an agent:  anvil scan http://localhost:3000'
}
