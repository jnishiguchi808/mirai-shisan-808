@echo off
title Mirai Ticker Admin
where pwsh >nul 2>&1
if errorlevel 1 (
  echo PowerShell 7 ^(pwsh^) is required.
  pause
  exit /b 1
)
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0ticker-admin.ps1"
