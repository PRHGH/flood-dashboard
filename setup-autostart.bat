@echo off
REM Setup Auto-Start Script
REM This script sets up the backend to run automatically on PC startup

setlocal enabledelayedexpansion

REM Get admin privileges check
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo.
    echo ========================================
    echo ERROR: This script requires Administrator privileges
    echo ========================================
    echo Please run this script as Administrator.
    echo.
    pause
    exit /b 1
)

set SCRIPT_DIR=%~dp0
set START_SCRIPT=%SCRIPT_DIR%start.bat

REM Get the startup folder path
set STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

REM Create a shortcut to start.bat in the Startup folder
echo.
echo ========================================
echo Setting up Auto-Start...
echo ========================================
echo.

REM Create a VBScript to make the shortcut
set VBS_FILE=%TEMP%\CreateShortcut.vbs

(
echo Set oWS = WScript.CreateObject("WScript.Shell"^)
echo sLinkFile = "%STARTUP_FOLDER%\SCADA Backend Auto-Start.lnk"
echo Set oLink = oWS.CreateShortcut(sLinkFile^)
echo oLink.TargetPath = "%START_SCRIPT%"
echo oLink.WorkingDirectory = "%SCRIPT_DIR%"
echo oLink.Description = "SCADA Backend Server Auto-Start"
echo oLink.WindowStyle = 1
echo oLink.Save
) > "%VBS_FILE%"

cscript.exe "%VBS_FILE%"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo ========================================
    echo SUCCESS!
    echo ========================================
    echo Backend auto-start has been configured.
    echo The backend will start automatically when you restart your PC.
    echo.
    echo To remove auto-start:
    echo - Go to: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
    echo - Delete "SCADA Backend Auto-Start.lnk"
    echo.
) else (
    echo.
    echo ERROR: Failed to create startup shortcut.
    echo.
)

REM Clean up temporary VBS file
del /f /q "%VBS_FILE%" 2>nul

pause
