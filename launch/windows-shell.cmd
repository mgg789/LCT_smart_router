@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0.."
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -m launch.cli %*
) else (
  where python >nul 2>nul
  if errorlevel 1 (
    echo Install Python 3.10+ with Tcl/Tk: https://www.python.org/downloads/
    pause
    exit /b 1
  )
  python -m launch.cli %*
)
if errorlevel 1 pause
