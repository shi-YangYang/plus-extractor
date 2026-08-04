[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$startScript = Join-Path $PSScriptRoot "start-relay.ps1"
$startup = [Environment]::GetFolderPath("Startup")
$launcher = Join-Path $startup "PlusExtractorRelay.vbs"
$escapedStartScript = $startScript.Replace('"', '""')
$vbs = @"
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$escapedStartScript""", 0, False
"@
Set-Content -LiteralPath $launcher -Value $vbs -Encoding Unicode
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $startScript
if ($LASTEXITCODE -ne 0) {
  throw "Relay start failed with exit $LASTEXITCODE"
}
Write-Output "AUTOSTART_INSTALLED=$launcher"
