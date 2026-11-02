@echo off
rem 双击打开 Superagent 面板；token 每次启动都会变，所以从最新日志里取。
cd /d "%~dp0"
python scripts\open-panel.py
if errorlevel 1 pause
