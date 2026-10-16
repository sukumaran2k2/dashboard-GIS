@echo off
setlocal
cd /d "%~dp0"
where python >nul 2>nul || ( echo Python 3.10+ not found. Install it from python.org and tick "Add python.exe to PATH". & pause & exit /b 1 )
if not exist .venv\Scripts\python.exe ( python -m venv .venv || ( echo Could not create virtual environment. & pause & exit /b 1 ) )
.venv\Scripts\python -m pip install -q -r requirements.txt || ( echo Dependency installation failed. & pause & exit /b 1 )
rem Optional settings (for example: set GOOGLE_MAPS_API_KEY=...) go in .env.bat, which is not committed.
if exist .env.bat call .env.bat
if not exist web\dist\index.html echo NOTE: the web UI is not built yet. Run build.bat once, then restart.
echo.
if defined GOOGLE_MAPS_API_KEY ( echo Google Maps basemap: enabled ) else ( echo Google Maps basemap: off ^(set GOOGLE_MAPS_API_KEY in .env.bat^) )
echo GeoDash running at http://127.0.0.1:8000  (Ctrl+C to stop)
.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
