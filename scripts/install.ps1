<#
.SYNOPSIS
  agent-mesh installer (Windows / PowerShell).
.DESCRIPTION
  Builds the npm tarball from this checkout and installs the `agent-mesh` CLI
  globally — the same artifact you would distribute and `npm i -g`. Zero-dep,
  Node >= 20. Works in Windows PowerShell and PowerShell 7 (pwsh).
.PARAMETER Pack
  Only produce the .tgz (no global install).
.PARAMETER NoTest
  Skip the test gate before installing.
.EXAMPLE
  ./scripts/install.ps1
  ./scripts/install.ps1 -Pack
  ./scripts/install.ps1 -NoTest
#>
param(
  [switch]$Pack,
  [switch]$NoTest
)
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# 1. Preflight: Node >= 20.
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error 'node is not on PATH. Install Node >= 20 first.'; exit 1
}
$nodeMajor = [int](node -p "parseInt(process.versions.node)")
if ($nodeMajor -lt 20) {
  Write-Error "Node >= 20 required (found $(node -v))."; exit 1
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  Write-Error 'npm is not on PATH.'; exit 1
}
Write-Host "OK node $(node -v), npm $(npm -v)"

# 2. Test gate (hermetic; stubs the claude binary).
if (-not $NoTest) {
  Write-Host '-> running test suite (npm test)...'
  npm test
  if ($LASTEXITCODE -ne 0) { Write-Error 'tests failed'; exit 1 }
  Write-Host 'OK tests passed'
}

# 3. Pack the publishable tarball (honors package.json "files").
Write-Host '-> npm pack...'
$tarball = (npm pack) | Select-Object -Last 1
if (-not $tarball -or -not (Test-Path $tarball)) {
  Write-Error 'npm pack did not produce a tarball.'; exit 1
}
Write-Host "OK packed $tarball"

if ($Pack) {
  Write-Host "Tarball ready: $RepoRoot\$tarball"
  Write-Host 'Distribute it, then on the target machine:  npm i -g <tarball>'
  exit 0
}

# 4. Global install of the exact packed artifact.
Write-Host "-> npm install -g $tarball..."
npm install -g $tarball
if ($LASTEXITCODE -ne 0) { Write-Error 'global install failed'; exit 1 }

# 5. Verify the CLI resolved on PATH.
if (-not (Get-Command agent-mesh -ErrorAction SilentlyContinue)) {
  Write-Warning "'agent-mesh' is installed but not on PATH. Add npm's global bin: $(npm prefix -g)"
} else {
  Write-Host "OK installed: $((Get-Command agent-mesh).Source)"
}

Write-Host ''
Write-Host 'Done. Next steps:'
Write-Host '  agent-mesh init-mesh <folder>'
Write-Host '  agent-mesh add <mesh> <agent-folder>'
Write-Host '  agent-mesh dashboard <mesh> --allow-shell'
Write-Host ''
Write-Host 'Windows note: for do-mode (write) delegations, set the deployment attestation'
Write-Host '  setx AGENT_MESH_ATTEST_MANAGED_COMPATIBLE 1'
Write-Host 'only after confirming your managed-settings policy is compatible with the mesh path-guard.'
