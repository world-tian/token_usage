param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Code
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
Invoke-WebRequest -UseBasicParsing -Uri "$Server/install/collector.mjs" -OutFile $Collector
Invoke-WebRequest -UseBasicParsing -Uri "$Server/install/adapters.mjs" -OutFile $Adapters

& node $Collector sync --server $Server --code $Code
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
