@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-native-host.ps1"
if errorlevel 1 (
  echo.
  echo Setup failed. Please keep this window open and report the error above.
  pause
  exit /b 1
)
echo.
echo Setup complete. Reload the Reader extension at chrome://extensions.
pause
