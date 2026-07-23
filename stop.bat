@echo off
REM Stop Backend Server Script
REM This script stops the Node.js backend server

echo.
echo ========================================
echo Stopping SCADA Backend Server...
echo ========================================
echo.

REM Kill all node.exe processes (the backend server)
taskkill /FI "WINDOWTITLE eq SCADA Backend Server*" /T /F

if %ERRORLEVEL% EQU 0 (
    echo Backend server stopped successfully.
) else (
    echo No running backend server found.
)

echo.
pause
