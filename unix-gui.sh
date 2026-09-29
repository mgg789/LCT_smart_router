#!/usr/bin/env sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Install Python 3.10+: https://www.python.org/downloads/"
  exit 1
fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))' >/dev/null 2>&1; then
  echo "Python 3.10+ is required: https://www.python.org/downloads/"
  exit 1
fi
if ! python3 -c 'import tkinter' >/dev/null 2>&1; then
  echo "Install Tkinter (Linux: python3-tk; macOS: Python with Tcl/Tk)."
  exit 1
fi
exec python3 -m launch.gui "$@"
