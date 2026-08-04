param(
  [string]$Root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
)

$ErrorActionPreference = "Stop"

$files = @(
  @{ Backup = "background.js.original"; Target = "chatgpt-checkout-helper\background.js" },
  @{ Backup = "content.js.original"; Target = "chatgpt-checkout-helper\content.js" },
  @{ Backup = "background.test.cjs.original"; Target = "chatgpt-checkout-helper\tests\background.test.cjs" },
  @{ Backup = "content.test.cjs.original"; Target = "chatgpt-checkout-helper\tests\content.test.cjs" },
  @{ Backup = "manifest.json.original"; Target = "chatgpt-checkout-helper\manifest.json" },
  @{ Backup = "README.md.original"; Target = "README.md" },
  @{ Backup = "chatgpt-checkout-helper.zip.original"; Target = "chatgpt-checkout-helper.zip" }
)

foreach ($file in $files) {
  $source = Join-Path $PSScriptRoot $file.Backup
  $target = Join-Path $Root $file.Target
  if (-not (Test-Path -LiteralPath $source)) {
    throw "Missing rollback source: $source"
  }
  $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source).Hash
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Force
  $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $target).Hash
  if ($targetHash -ne $sourceHash) {
    throw "Rollback verification failed: $target"
  }
  Write-Output "RESTORED $($file.Target) SHA256=$targetHash"
}

Write-Output "ROLLBACK_OK Root=$Root"
