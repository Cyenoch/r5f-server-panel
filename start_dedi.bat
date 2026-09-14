@echo off
rem Double-click entry point: opens the interactive dashboard.
rem For scripted use call r5-server.exe with a subcommand instead.
cd /d "%~dp0"
r5-server.exe %*
if errorlevel 1 pause
