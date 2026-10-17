<#
Texting relay setup for Windows (Android phones). Your bot runs these steps on YOUR computer, one at a time;
each prints RELAY_STATUS lines it can read. Nothing here needs admin rights.
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 <step> [--dry-run] [options]
Steps: node install-node fetch deps test login, and (via scripts\setup-lib.mjs) keys ask show config
       gateway-check confirm-fingerprint claim deploy secrets google smoke resolve test-send copy-token
       clear-clipboard status
Secrets never appear on screen, in a log, or on a command line. They stay in .relay-local\ (gitignored).
iPhone needs a Mac in this version, so it is not offered here.
#>
param(
  [Parameter(Position = 0)][string]$Step = 'help',
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$RepoUrl = if ($env:RELAY_REPO_URL) { $env:RELAY_REPO_URL } else { 'https://github.com/OWNER/sms-relay-template.git' }  # set to the public repo when it is published
$NodeLine = 'latest-v22.x'
$NodeMin = 20
$NodeHome = Join-Path $env:LOCALAPPDATA 'sms-relay\node'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Parent = Split-Path -Parent $Here
if ($env:RELAY_DIR) { $Dir = $env:RELAY_DIR }
elseif ((Test-Path (Join-Path $Parent 'package.json')) -and (Select-String -Quiet -Path (Join-Path $Parent 'package.json') -Pattern '"sms-relay-template"')) { $Dir = $Parent }
else { $Dir = Join-Path $HOME 'texting-relay' }
if (Test-Path (Join-Path $NodeHome 'node.exe')) { $env:PATH = "$NodeHome;$env:PATH" }
$Dry = $Rest -contains '--dry-run'

function Write-Status([string]$Name, [string]$Result, [string[]]$Pairs = @()) {
  $line = "RELAY_STATUS step=$Name result=$Result"
  if ($Pairs.Count -gt 0) { $line += ' ' + ($Pairs -join ' ') }
  [Console]::Out.WriteLine($line)
}
function Get-LogPath([string]$Name) {
  $d = Join-Path $Dir '.relay-local\logs'
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  Join-Path $d "$Name.log"
}
function Invoke-Logged([string]$Name, [string]$CommandLine) {
  # cmd.exe does the redirection so npm/wrangler output goes to the log, not to the bot.
  $log = Get-LogPath $Name
  Push-Location $Dir
  try { & cmd.exe /d /c "$CommandLine > `"$log`" 2>&1"; return $LASTEXITCODE }
  catch { Add-Content -Path $log -Value "could not start: $CommandLine"; return 127 }
  finally { Pop-Location }
}
function Get-NodeMajor {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if (-not $n) { return 0 }
  return [int](& node -p 'process.versions.node.split(".")[0]')
}
function Assert-Repo {
  if (-not (Test-Path (Join-Path $Dir 'package.json'))) { Write-Status $Step 'fail' @('reason=run_fetch_first'); exit 1 }
}

function Step-Node {
  $m = Get-NodeMajor
  if ($m -ge $NodeMin) { Write-Status 'node' 'ok' @("version=$(& node -v)") }
  elseif ($m -gt 0) { Write-Status 'node' 'fail' @('reason=too_old', "version=$(& node -v)", 'next=install-node') }
  else { Write-Status 'node' 'fail' @('reason=missing', 'next=install-node') }
}

function Step-InstallNode {
  if ((Get-NodeMajor) -ge $NodeMin) { Write-Status 'install-node' 'skip' @("version=$(& node -v)"); return }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = "https://nodejs.org/dist/$NodeLine"
  if ($Dry) { Write-Status 'install-node' 'dry_run' @("would_get=$base/node-*-win-$arch.zip", "into=$NodeHome"); return }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('n'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    $sums = (Invoke-WebRequest -UseBasicParsing "$base/SHASUMS256.txt").Content -split "`n"
    $line = $sums | Where-Object { $_ -match "  (node-v[\d.]+-win-$arch\.zip)$" } | Select-Object -First 1
    if (-not $line) { Write-Status 'install-node' 'fail' @('reason=no_build_found'); exit 1 }
    $hash, $file = ($line.Trim() -split '\s+')
    $zip = Join-Path $tmp $file
    Invoke-WebRequest -UseBasicParsing "$base/$file" -OutFile $zip
    if ((Get-FileHash -Algorithm SHA256 $zip).Hash -ne $hash.ToUpper()) { Write-Status 'install-node' 'fail' @('reason=checksum_mismatch'); exit 1 }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force
    if (Test-Path $NodeHome) { Remove-Item -Recurse -Force $NodeHome }
    New-Item -ItemType Directory -Force -Path (Split-Path $NodeHome) | Out-Null
    Move-Item (Join-Path $tmp ($file -replace '\.zip$', '')) $NodeHome
    $env:PATH = "$NodeHome;$env:PATH"
    Write-Status 'install-node' 'ok' @("version=$(& node -v)", "where=$NodeHome")
  } catch {
    Write-Status 'install-node' 'fail' @('reason=download_failed')
    exit 1
  } finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
}

function Step-Fetch {
  if ($RepoUrl -like '*github.com/OWNER/*') { Write-Status 'fetch' 'fail' @('reason=repo_url_not_set'); exit 1 }
  $git = Get-Command git -ErrorAction SilentlyContinue
  if ($Dry) { Write-Status 'fetch' 'dry_run' @("would_get_into=$Dir", "how=$(if ($git) { 'git' } else { 'download' })"); return }
  if ($git -and (Test-Path (Join-Path $Dir '.git'))) {
    & git -C $Dir pull --ff-only -q *> (Get-LogPath 'fetch')
    if ($LASTEXITCODE -ne 0) { Write-Status 'fetch' 'fail' @('reason=update_failed', 'log=.relay-local/logs/fetch.log'); exit 1 }
    Write-Status 'fetch' 'ok' @('how=git_update', "commit=$(& git -C $Dir rev-parse --short HEAD)", "dir=$Dir")
  } elseif ($git) {
    & git clone -q $RepoUrl $Dir 2>$null
    if ($LASTEXITCODE -ne 0) { Write-Status 'fetch' 'fail' @('reason=clone_failed'); exit 1 }
    Write-Status 'fetch' 'ok' @('how=git_clone', "commit=$(& git -C $Dir rev-parse --short HEAD)", "dir=$Dir")
  } else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('n'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $zip = Join-Path $tmp 'src.zip'
      Invoke-WebRequest -UseBasicParsing (($RepoUrl -replace '\.git$', '') + '/archive/refs/heads/main.zip') -OutFile $zip
      Expand-Archive -Path $zip -DestinationPath $tmp -Force
      $top = Get-ChildItem -Directory $tmp | Select-Object -First 1
      New-Item -ItemType Directory -Force -Path $Dir | Out-Null
      Copy-Item -Recurse -Force (Join-Path $top.FullName '*') $Dir   # keeps .relay-local\ as it is
      Write-Status 'fetch' 'ok' @('how=download', "dir=$Dir")
    } catch { Write-Status 'fetch' 'fail' @('reason=download_failed'); exit 1 }
    finally { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue }
  }
}

function Step-Dependency {
  Assert-Repo
  if ($Dry) { Write-Status 'deps' 'dry_run' @('would_run=npm_ci'); return }
  if ((Invoke-Logged 'deps' 'npm ci --legacy-peer-deps --no-audit --no-fund') -eq 0) { Write-Status 'deps' 'ok' }
  else { Write-Status 'deps' 'fail' @('log=.relay-local/logs/deps.log'); exit 1 }
}

function Step-Test {
  Assert-Repo
  if ((Invoke-Logged 'test' 'npm test && npm run typecheck') -eq 0) {
    $n = 0
    Select-String -Path (Get-LogPath 'test') -Pattern 'Tests +(\d+) passed' | ForEach-Object { $n += [int]$_.Matches[0].Groups[1].Value }
    Write-Status 'test' 'ok' @("passed=$n", 'typecheck=clean')
  } else { Write-Status 'test' 'fail' @('log=.relay-local/logs/test.log', 'next=stop_do_not_deploy'); exit 1 }
}

function Step-Login {
  Assert-Repo
  if ($Dry) { Write-Status 'login' 'dry_run' @('would_open=cloudflare_sign_in_in_your_browser'); return }
  [void](Invoke-Logged 'login' 'npx wrangler whoami')
  if (Select-String -Quiet -Path (Get-LogPath 'login') -Pattern 'not authenticated|not logged in') {
    if ((Invoke-Logged 'login' 'npx wrangler login') -ne 0) { Write-Status 'login' 'needs_human' @('reason=browser_sign_in_not_finished'); exit 2 }
  }
  $rc = Invoke-Logged 'login-check' 'npx wrangler whoami'
  if ($rc -eq 0 -and -not (Select-String -Quiet -Path (Get-LogPath 'login-check') -Pattern 'not authenticated|not logged in')) { Write-Status 'login' 'ok' }
  else { Write-Status 'login' 'needs_human' @('reason=sign_in_failed'); exit 2 }
}

$LibSteps = @('keys', 'ask', 'show', 'config', 'gateway-check', 'confirm-fingerprint', 'claim', 'deploy', 'secrets',
  'google', 'smoke', 'resolve', 'test-send', 'copy-token', 'clear-clipboard', 'status')

switch ($Step) {
  'node' { Step-Node }
  'install-node' { Step-InstallNode }
  'fetch' { Step-Fetch }
  'deps' { Step-Dependency }
  'test' { Step-Test }
  'login' { Step-Login }
  'iphone-helper' { Write-Status 'iphone-helper' 'fail' @('reason=iphone_needs_a_mac'); exit 1 }
  'help' { Get-Help $MyInvocation.MyCommand.Path; exit 0 }
  default {
    if ($LibSteps -contains $Step) {
      Assert-Repo
      if ((Get-NodeMajor) -lt $NodeMin) { Write-Status $Step 'fail' @('reason=no_node', 'next=install-node'); exit 1 }
      & node (Join-Path $Dir 'scripts\setup-lib.mjs') $Step @Rest
      exit $LASTEXITCODE
    }
    Write-Status 'usage' 'fail' @("unknown_step=$Step")
    exit 3
  }
}
