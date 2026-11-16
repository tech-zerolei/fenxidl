@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   FenxiDL - Windows 构建脚本
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 https://nodejs.org/ 的 LTS 版本
  echo        安装时请勾选 "Add to PATH"
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do set NODEVER=%%v
echo Node.js 版本: %NODEVER%
echo.

echo [1/4] 安装依赖...
call npm install
if errorlevel 1 (
  echo [错误] 依赖安装失败。若为网络问题，请先设置镜像：
  echo        set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
  pause
  exit /b 1
)
echo.

echo [2/4] 类型检查与构建...
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败，请把上面的错误信息发出来
  pause
  exit /b 1
)
echo.

echo [3/4] 运行测试...
call npm test
if errorlevel 1 (
  echo [警告] 有测试未通过，继续生成安装包
)
echo.

echo [4/4] 生成 Windows 安装程序...
call npx electron-builder --win --x64
if errorlevel 1 (
  echo [错误] 打包失败
  echo        尝试: rmdir /s /q release ^& rmdir /s /q node_modules ^& npm install
  pause
  exit /b 1
)
echo.

echo ============================================
echo   构建完成！产物在 release\ 目录：
echo     FenxiDL-1.1.0-x64.exe          安装程序
echo     FenxiDL-1.1.0-portable.exe     免安装版
echo     win-unpacked\FenxiDL.exe       可直接运行
echo ============================================
dir /b release\*.exe 2>nul
pause
