@echo off
REM Start Backend Server Script
REM This script starts the Node.js backend server

setlocal enabledelayedexpansion

REM Get the directory where this batch file is located
set SCRIPT_DIR=%~dp0

REM Change to the backend directory
cd /d "%SCRIPT_DIR%"

REM Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ========================================
    echo ERROR: Node.js is not installed or not in PATH
    echo ========================================
    echo.
    pause
    exit /b 1
)

REM Start the server in a new window
echo.
echo ========================================
echo Starting SCADA Backend Server...
echo ========================================
echo.

start "SCADA Backend Server" /d "%SCRIPT_DIR%" node server.js

REM Wait a moment for the server to start
timeout /t 2 /nobreak

echo Backend server started in a new window.
echo To stop the server, run stop.bat or close the server window.
echo.
pause
