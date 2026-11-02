# Build the Windows installers locally (Windows 10/11).
# Prerequisites: Bun, Rust (rustup, MSVC toolchain), Visual Studio Build Tools
# with "Desktop development with C++".
# Usage (from the project root):
#   powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

foreach ($tool in "bun", "cargo") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "Missing $tool. Install it first (see the header of this script)." }
}

bun install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
# No updater signing key locally: skip updater artifacts. Output both MSI and NSIS setup.exe.
bun run tauri build --bundles msi,nsis --config '{\"bundle\":{\"createUpdaterArtifacts\":false}}'
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

$out = Join-Path (Get-Location) "installer"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem src-tauri\target\release\bundle\msi\*.msi, src-tauri\target\release\bundle\nsis\*.exe | Copy-Item -Destination $out -Force
Write-Host "Installers copied to $out" -ForegroundColor Green
Get-ChildItem $out
