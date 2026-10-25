@echo off
chcp 65001 >nul
title CHRONOCROSSFIT TV SERVER
echo ======================================================
echo   CHRONOCROSSFIT - SMART TV TIMER ^& SUGARWOD DISPLAY
echo ======================================================

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Demarrage via Node.js ^(server.js^)...
    if not exist node_modules (
        call npm install
    )
    start "" http://localhost:3000
    node server.js
    goto :eof
)

for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python*") do (
    if exist "%%D\python.exe" (
        echo [INFO] Demarrage via Python Backend ^(server.py^)...
        start "" http://localhost:3000
        "%%D\python.exe" server.py
        goto :eof
    )
)

where python >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Demarrage via Python Backend ^(server.py^)...
    start "" http://localhost:3000
    python server.py
    goto :eof
)

echo [ERREUR] Ni Node.js ni Python n'ont ete trouves sur ce systeme.
pause
