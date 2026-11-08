@echo off
cd /d "%~dp0"
py -3 --version >nul 2>&1
if not errorlevel 1 (
  py -3 app.py
  goto done
)
python --version >nul 2>&1
if not errorlevel 1 (
  python app.py
  goto done
)
if exist "D:\python3.11.9\python.exe" (
  "D:\python3.11.9\python.exe" app.py
  goto done
)
echo Python 3 not found. Install Python and the requirements first.
:done
pause
