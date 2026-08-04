[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$stopScript = Join-Path $PSScriptRoot "stop-relay.ps1"
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopScript
$launcher = Join-Path ([Environment]::GetFolderPath("Startup")) "PlusExtractorRelay.vbs"
if (Test-Path -LiteralPath $launcher -PathType Leaf) {
  Remove-Item -LiteralPath $launcher -Force
}
Write-Output "AUTOSTART_REMOVED=$launcher"
