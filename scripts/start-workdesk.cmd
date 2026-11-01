@echo off
rem WorkDesk without the exe: runs on the Node.js already installed on this PC and opens in the browser.
rem Keep this window open (minimise it); closing it stops WorkDesk. Updates from Settings restart it here by themselves.
title WorkDesk
cd /d "%~dp0"
where node >nul 2>&1 || (echo WorkDesk needs Node.js 20 or newer. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not defined PORT set "PORT=4321"
set "WORKDESK_TASKS=%~dp0tasks"
set "WORKDESK_ENV=%~dp0.env"
set "WORKDESK_STATE=%~dp0.workdesk-sync.json"
rem Already running (started earlier)? Just open it.
node -e "fetch('http://127.0.0.1:%PORT%/api/config',{signal:AbortSignal.timeout(2000)}).then(()=>process.exit(0),()=>process.exit(1))"
if %errorlevel%==0 (start "" http://127.0.0.1:%PORT%/ & exit /b 0)
if not defined WORKDESK_OPEN set "WORKDESK_OPEN=1"
:run
echo WorkDesk is running at http://127.0.0.1:%PORT%/  - keep this window open (minimise it). Close it to stop WorkDesk.
node "%~dp0app\server.js"
rem Exit code 75 means "updated, start the new version".
if %errorlevel%==75 (set "WORKDESK_OPEN=" & echo Updated. Starting the new version... & goto run)
echo WorkDesk stopped.
pause
