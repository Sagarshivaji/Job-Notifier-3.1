@echo off
title Job Pulse Launcher
echo ===================================================
echo               Launching Job Pulse
echo ===================================================
echo.

echo Installing backend dependencies...
cd backend
call npm install
cd ..

if not exist "frontend\node_modules\" (
    echo Installing frontend dependencies... Please wait.
    cd frontend
    call npm install
    cd ..
)

echo Starting backend server on port 5000...
start "Job Pulse Backend" cmd /k "cd backend && npm start"

echo Starting frontend Vite server on port 5173...
start "Job Pulse Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo ===================================================
echo  Job Pulse is launching!
echo  - Frontend Dashboard: http://localhost:5173
echo  - Backend API: http://localhost:5000
echo.
echo  Keep the opened console windows running. 
echo  Press any key in this window to close launcher...
echo ===================================================
pause > nul
