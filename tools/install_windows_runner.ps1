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
  & schtasks.exe /Delete /TN $TaskName /F 2>$null | Out-Host
  $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Software\Microsoft\Windows\CurrentVersion\Run", $true)
  if ($runKey) { try { $runKey.DeleteValue($TaskName, $false) } finally { $runKey.Dispose() } }
  Write-Host "Removed '$TaskName' from Task Scheduler and the current-user login startup registry."
  exit 0
}

if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
  throw "Build output is missing: $cliPath. Run npm run build first."
}

$arguments = '"' + $cliPath + '" runtime watch --vault "' + $resolvedVault + '"'
$taskCommand = '"' + $nodePath + '" ' + $arguments
& schtasks.exe /Create /TN $TaskName /SC ONLOGON /TR $taskCommand /RL LIMITED /F | Out-Host
if ($LASTEXITCODE -eq 0) {
  Write-Host "Installed '$TaskName' with Task Scheduler. It starts after Windows login and performs startup reconciliation before watching the queue."
  exit 0
}

$escapedNode = $nodePath.Replace("'", "''")
$escapedCli = $cliPath.Replace("'", "''")
$escapedVault = $resolvedVault.Replace("'", "''")
$watchCommand = "& '$escapedNode' '$escapedCli' runtime watch --vault '$escapedVault'"
$registryCommand = 'powershell.exe -NoProfile -WindowStyle Hidden -Command "' + $watchCommand + '"'
$runKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Software\Microsoft\Windows\CurrentVersion\Run", $true)
if (-not $runKey) { throw "Both Task Scheduler and current-user startup registration failed." }
try { $runKey.SetValue($TaskName, $registryCommand, [Microsoft.Win32.RegistryValueKind]::String) }
finally { $runKey.Dispose() }
Write-Host "Task Scheduler was unavailable; installed '$TaskName' in the current-user login startup registry instead."
