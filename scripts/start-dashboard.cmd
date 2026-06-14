@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dashboard.ps1" %*
exit /b %ERRORLEVEL%
