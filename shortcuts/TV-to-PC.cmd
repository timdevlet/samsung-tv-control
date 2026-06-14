@echo off
REM Double-click launcher for the Samsung TV -> PC switcher.
REM This script lives in shortcuts/; %~dp0\.. is the project root, so it works
REM wherever the repo is.
cd /d "%~dp0.."

call npm start 

REM Keep the window open only if something failed, so you can read the error.
if errorlevel 1 (
  echo.
  echo  -----------------------------------------------------------
  echo  Something went wrong. Common cause: the SmartThings token
  echo  expired ^(PATs last 24h^). Generate a new one and set it:
  echo      setx SMARTTHINGS_TOKEN "your-new-token"
  echo  ...then open a NEW window and try again.
  echo  -----------------------------------------------------------
  echo.
  pause
)
