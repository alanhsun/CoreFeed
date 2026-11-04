@echo off
chcp 65001 >nul
echo ====================================================
echo   聚核 CoreFeed v2.0 · 全球知名信源 Agent 情报中心
echo ====================================================

if not exist ".env" (
    echo [提示] 未找到 .env 文件，已从 .env.example 复制默认配置
    copy .env.example .env >nul 2>&1
)

where node >nul 2>&1
if %errorlevel% equ 0 (
    echo [启动] 检测到 Node.js 环境，正在启动服务...
    node server.js
    goto :eof
)

where deno >nul 2>&1
if %errorlevel% equ 0 (
    echo [启动] 检测到 Deno (Node兼容模式) 环境，正在启动服务...
    deno run -A server.js
    goto :eof
)

echo [错误] 未检测到 Node.js 或 Deno 运行环境，请先安装 Node.js 18+ 或使用 Docker Compose 启动。
pause
exit /b 1
