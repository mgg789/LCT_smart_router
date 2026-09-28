@echo off
setlocal
set "NAVIX_PYTHON="
chcp 65001 >nul
cd /d "%~dp0.."
where py >nul 2>nul
if not errorlevel 1 (
  py -3 -c "import sys, tkinter; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
  if not errorlevel 1 set "NAVIX_PYTHON=py -3"
)
if not defined NAVIX_PYTHON (
  python -c "import sys, tkinter; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
  if not errorlevel 1 set "NAVIX_PYTHON=python"
)
if not defined NAVIX_PYTHON (
  echo Install Python 3.10+ with Tcl/Tk: https://www.python.org/downloads/
  pause
  exit /b 1
)
%NAVIX_PYTHON% -m launch.gui %*
set "NAVIX_EXIT=%ERRORLEVEL%"
if not "%NAVIX_EXIT%"=="0" pause
exit /b %NAVIX_EXIT%
