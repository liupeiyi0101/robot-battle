@echo off
setlocal
cd /d "%~dp0"

set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if exist "%NODE_EXE%" goto run

where node.exe >nul 2>nul
if %ERRORLEVEL%==0 (
  set "NODE_EXE=node.exe"
  goto run
)

echo Cannot find Node.js on this computer.
echo Please install Node.js from https://nodejs.org, then run this file again.
pause
exit /b 1

:run
echo Starting Robot Battle...
echo.
echo When you see "Robot Battle server running", open:
echo http://localhost:4173
echo.
start "" "http://localhost:4173"
"%NODE_EXE%" server.js
pause
