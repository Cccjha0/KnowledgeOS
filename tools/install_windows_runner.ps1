param(
  [Parameter(Mandatory = $true)] [string] $VaultPath,
  [ValidateSet("Install", "Uninstall")] [string] $Action = "Install",
  [string] $TaskName = "KnowledgeOS Local Task Runner"
)

$ErrorActionPreference = "Stop"
$engineRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $engineRoot "dist\cli.js"
$nodePath = (Get-Command node -ErrorAction Stop).Source
$resolvedVault = (Resolve-Path -LiteralPath $VaultPath -ErrorAction Stop).Path

if ($Action -eq "Uninstall") {
  & schtasks.exe /Delete /TN $TaskName /F | Out-Host
  exit $LASTEXITCODE
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Build output is missing: $cliPath. Run npm run build first."
}

$arguments = '"' + $cliPath + '" runtime watch --vault "' + $resolvedVault + '"'
$taskCommand = '"' + $nodePath + '" ' + $arguments
& schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskCommand /RL LIMITED /F | Out-Host
if ($LASTEXITCODE -ne 0) { throw "Task Scheduler registration failed with exit code $LASTEXITCODE." }

Write-Host "Installed '$TaskName'. It starts after Windows login and performs startup reconciliation before watching the queue."
