param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Code,
  [string]$CodexRoot,
  [string]$ClaudeRoot,
  [string]$AntigravityRoot
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Token Tide requires Node.js 22 or newer for this PoC installer. Install Node.js and run the same command again."
}

$HomeDir = if ($env:TOKEN_TIDE_HOME) { $env:TOKEN_TIDE_HOME } else { Join-Path $env:LOCALAPPDATA "TokenTide" }
$BinDir = Join-Path $HomeDir "bin"
$Collector = Join-Path $BinDir "token-tide.mjs"
$Adapters = Join-Path $BinDir "adapters.mjs"
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

Write-Host "Token Tide: installing the collector in $BinDir"
$T = [int][double]::Parse((Get-Date (Get-Date).ToUniversalTime() -UFormat %s))
Invoke-WebRequest -UseBasicParsing -Uri "$Server/install/collector.mjs?t=$T" -OutFile $Collector
Invoke-WebRequest -UseBasicParsing -Uri "$Server/install/adapters.mjs?t=$T" -OutFile $Adapters

$ArgsList = @("daemon", "--server", $Server, "--code", $Code)
if ($CodexRoot) { $ArgsList += "--codexRoot"; $ArgsList += $CodexRoot }
if ($ClaudeRoot) { $ArgsList += "--claudeRoot"; $ArgsList += $ClaudeRoot }
if ($AntigravityRoot) { $ArgsList += "--antigravityRoot"; $ArgsList += $AntigravityRoot }

& node $Collector @ArgsList
if ($LASTEXITCODE -ne 0) {
  Write-Warning "Token Tide: collector sync returned a non-zero exit code ($LASTEXITCODE). This usually happens because you do not have any local Claude Code or Codex usage logs on this computer yet. Your installation is complete. You can test end-to-end sync by running: node `"$Collector`" demo-sync --server `"$Server`" --code `"$Code`""
}
