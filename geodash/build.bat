@echo off
setlocal
cd /d "%~dp0web"
where node >nul 2>nul || ( echo Node.js 20+ not found. Install it from nodejs.org. & pause & exit /b 1 )
rem Keep the npm cache next to the project so it does not fill the system drive.
set "npm_config_cache=%~dp0.npm-cache"
call npm install --no-audit --no-fund || ( echo npm install failed. & pause & exit /b 1 )
call npm run build || ( echo Build failed. & pause & exit /b 1 )
echo.
echo Built web\dist. Start the app with run.bat
