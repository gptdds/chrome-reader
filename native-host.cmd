@echo off
setlocal
set "PYTHONUNBUFFERED=1"
"%~dp0.venv\Scripts\python.exe" -I -B "%~dp0native_host.py" %*
exit /b %errorlevel%
