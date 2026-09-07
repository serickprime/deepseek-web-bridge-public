@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 goto node_missing

for /f "delims=" %%V in ('node -p "parseInt(process.versions.node)" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR goto node_missing
if %NODE_MAJOR% LSS 20 goto node_old

where npm >nul 2>&1
if errorlevel 1 goto npm_missing

node "%~dp0scripts\desktopStart.mjs"
set "START_STATUS=%ERRORLEVEL%"
if not "%START_STATUS%"=="0" (
  echo.
  pause
)
exit /b %START_STATUS%

:node_missing
echo Для запуска нужен Node.js 20 или новее.
echo Открываю официальную страницу загрузки Node.js...
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:npm_missing
echo Не найден npm. Установите Node.js 20 или новее с официального сайта.
echo Открываю официальную страницу загрузки Node.js...
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1

:node_old
echo Для запуска нужен Node.js 20 или новее.
echo Обнаружена устаревшая версия Node.js.
echo Открываю официальную страницу загрузки Node.js...
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1
