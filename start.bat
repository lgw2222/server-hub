@echo off
title Server Hub
cd /d "%~dp0"
if not exist node_modules (
  echo First run - installing...
  call npm install
)
:loop
node server.js
if %errorlevel%==7 (
  echo Restarting after update...
  goto loop
)
pause
