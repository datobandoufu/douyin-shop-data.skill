@echo off
REM daily-run.bat - 每日自动化启动脚本
REM 读取 .env 文件设置环境变量，然后运行完整流程

cd /d "%~dp0"

REM 读取 .env 并设置环境变量
if exist ".env" (
    for /f "tokens=*" %%a in (.env) do (
        echo %%a | findstr /r "^[^#]" >nul 2>&1
        if not errorlevel 1 set %%a
    )
)

REM 运行完整流程（DD_NODE 可覆盖 Node 可执行文件路径，默认 node）
if defined DD_NODE (set "NODE_EXE=%DD_NODE%") else (set "NODE_EXE=node")
call "%NODE_EXE%" "%~dp0run-all.cjs"

REM 记录结果
echo.
echo === %date% %time% 执行完毕 ===
