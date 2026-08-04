param([string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\..")))
$ErrorActionPreference = "Stop"
$files = @(
  @{ Backup = "content.js.original"; Target = "chatgpt-checkout-helper\content.js" },
  @{ Backup = "content.test.cjs.original"; Target = "chatgpt-checkout-helper\tests\content.test.cjs" },
  @{ Backup = "manifest.json.original"; Target = "chatgpt-checkout-helper\manifest.json" },
  @{ Backup = "README.md.original"; Target = "README.md" },
  @{ Backup = "chatgpt-checkout-helper.zip.original"; Target = "chatgpt-checkout-helper.zip" }
)
foreach ($file in $files) {
  $source = Join-Path $PSScriptRoot $file.Backup
  $target = Join-Path $Root $file.Target
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
  if ((Get-FileHash -Algorithm SHA256 $source).Hash -ne (Get-FileHash -Algorithm SHA256 $target).Hash) {
    throw "Rollback verification failed: $target"
  }
  Write-Output "RESTORED $($file.Target)"
}
Write-Output "ROLLBACK_OK Root=$Root"
