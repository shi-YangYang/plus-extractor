[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$relayScript = Join-Path $PSScriptRoot "local-relay.js"
$nodeCandidates = @(@(
  "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe",
  (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) })

if ($nodeCandidates.Count -eq 0) {
  throw "Node.js runtime was not found"
}

try {
  $status = Invoke-RestMethod -Uri "http://127.0.0.1:17898/status" -TimeoutSec 2
  if ($status.ready) {
    Write-Output "RELAY_ALREADY_RUNNING"
    Write-Output "PROXY=127.0.0.1:17897"
    exit 0
  }
} catch {
  # Start below.
}

$logDir = Join-Path $env:LOCALAPPDATA "PlusExtractorRelay"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$stdout = Join-Path $logDir "relay.log"
$stderr = Join-Path $logDir "relay-error.log"
$process = Start-Process -FilePath $nodeCandidates[0] -ArgumentList @($relayScript) `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput $stdout `
  -RedirectStandardError $stderr -PassThru

for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
  Start-Sleep -Milliseconds 125
  try {
    $status = Invoke-RestMethod -Uri "http://127.0.0.1:17898/status" -TimeoutSec 1
    if ($status.ready) {
      Write-Output "RELAY_STARTED"
      Write-Output "PID=$($process.Id)"
      Write-Output "PROXY=127.0.0.1:17897"
      exit 0
    }
  } catch {
    # Continue polling.
  }
}

throw "Relay process did not become ready; inspect $stderr"
