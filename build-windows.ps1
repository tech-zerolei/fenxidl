# FenxiDL Windows 构建脚本 (PowerShell)
# 用法: 右键 -> 使用 PowerShell 运行，或执行:
#   powershell -ExecutionPolicy Bypass -File .\build-windows.ps1

$ErrorActionPreference = 'Stop'

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  FenxiDL - Windows 构建脚本" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan

try {
    $nodeVersion = (node -v)
    Write-Host "Node.js: $nodeVersion" -ForegroundColor Green
} catch {
    Write-Host "[错误] 未找到 Node.js。请安装 https://nodejs.org/ 的 LTS 版本。" -ForegroundColor Red
    exit 1
}

# 国内网络默认使用镜像，可通过 -NoMirror 关闭
if ($args -notcontains '-NoMirror') {
    $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    Write-Host "已设置 Electron 下载镜像" -ForegroundColor DarkGray
}

Write-Host "`n[1/4] 安装依赖..." -ForegroundColor Yellow
npm install
if ($LASTEXITCODE -ne 0) { throw "依赖安装失败" }

# 新版 npm 可能要求批准安装脚本
try {
    npm install-scripts approve electron esbuild 2>$null | Out-Null
    npm install | Out-Null
} catch { }

Write-Host "`n[2/4] 类型检查与构建..." -ForegroundColor Yellow
npm run build
if ($LASTEXITCODE -ne 0) { throw "构建失败" }

Write-Host "`n[3/4] 运行测试..." -ForegroundColor Yellow
npm test
if ($LASTEXITCODE -ne 0) { Write-Host "[警告] 存在未通过的测试" -ForegroundColor DarkYellow }

Write-Host "`n[4/4] 生成安装程序..." -ForegroundColor Yellow
npx electron-builder --win --x64
if ($LASTEXITCODE -ne 0) { throw "打包失败" }

Write-Host "`n============================================" -ForegroundColor Green
Write-Host "  构建完成" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Green
Get-ChildItem release\*.exe | ForEach-Object {
    Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) -ForegroundColor Green
}
Write-Host "`n双击上面的 exe 即可安装或运行。"
