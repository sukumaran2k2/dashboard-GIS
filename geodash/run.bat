@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul || ( echo Python 3.10+ not found. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b 1 )
if not exist .venv\Scripts\python.exe ( python -m venv .venv || ( echo Could not create virtual environment. & pause & exit /b 1 ) )
.venv\Scripts\python -m pip install -q -r requirements.txt || ( echo Dependency installation failed. & pause & exit /b 1 )
echo.
echo GeoDash running at http://127.0.0.1:8000  (Ctrl+C to stop)
.venv\Scripts\python -m uvicorn main:app --host 127.0.0.1 --port 8000
