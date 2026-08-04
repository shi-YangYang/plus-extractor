[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
try {
  $result = Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:17898/shutdown" -ContentType "application/json" -Body "{}" -TimeoutSec 3
  Write-Output "RELAY_STOP_REQUESTED=$($result.shuttingDown)"
} catch {
  Write-Output "RELAY_ALREADY_STOPPED"
}
