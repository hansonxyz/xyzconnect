@echo off
setlocal

set "SRC=\\xyzconnect-test\xyzconnect\gui\dist\win-unpacked"
set "DST=C:\xyzconnect"
set "LOG=\\xyzconnect-test\xyzconnect\gui-debug.log"

echo Killing any running XYZConnect ...
taskkill /IM XYZConnect.exe /F >nul 2>&1
timeout /t 2 /nobreak >nul

echo Syncing from %SRC% to %DST% ...
if not exist "%DST%" mkdir "%DST%"
robocopy "%SRC%" "%DST%" /MIR

echo.
echo Starting XYZConnect (logging to %LOG%) ...
start "" "%DST%\XYZConnect.exe" "--log-file=%LOG%" "--dev"
