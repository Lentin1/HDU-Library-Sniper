# 在 Windows 10/11 上本地构建安装包。
# 前置：Bun、Rust (rustup, MSVC 工具链)、Visual Studio Build Tools（勾选“使用 C++ 的桌面开发”）。
#   winget install Oven-sh.Bun Rustlang.Rustup Microsoft.VisualStudio.2022.BuildTools
# 用法：在项目根目录执行  powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

foreach ($tool in "bun", "cargo") {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "缺少 $tool，请先安装（见脚本开头说明）" }
}

bun install --frozen-lockfile
# 本地没有 updater 签名私钥，关闭 updater 产物；同时输出 MSI 和 NSIS(setup.exe)。
bun run tauri build --bundles msi,nsis --config '{\"bundle\":{\"createUpdaterArtifacts\":false}}'

$out = Join-Path (Get-Location) "installer"
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem src-tauri\target\release\bundle\msi\*.msi, src-tauri\target\release\bundle\nsis\*.exe | Copy-Item -Destination $out -Force
Write-Host "安装包已输出到 $out" -ForegroundColor Green
Get-ChildItem $out
