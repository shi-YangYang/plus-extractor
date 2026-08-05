[CmdletBinding()]
param(
  [ValidateSet("all", "backend", "frontend")]
  [string]$Target = "all"
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$bundledNode = "C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
$pathNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1
$node = @($pathNode, $bundledNode) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

if (-not $node) {
  throw "Node.js 20 or newer is required."
}

$entry = switch ($Target) {
  "backend" { Join-Path $root "server\index.js" }
  "frontend" { Join-Path $root "scripts\serve-web.js" }
  default { Join-Path $root "scripts\dev.js" }
}

Push-Location $root
try {
  & $node $entry
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
