@echo off
chcp 65001 >nul
title CoreFeed v2.0 本地快速测试
echo ========================================================
echo 🚀 聚核 CoreFeed v2.0 — Windows 本机一键快速测试
echo ========================================================

cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ❌ 未检测到 Node.js，请先安装 Node.js ^(https://nodejs.org/^)
    pause
    exit /b 1
)

if exist ".git" (
    echo 📥 正在同步最新 GitHub 代码...
    git pull origin main
)

if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo 📝 已自动创建默认 .env 配置文件
    )
)

if not exist "node_modules" (
    echo 📦 首次运行，正在安装依赖包...
    call npm install --omit=dev
)

echo ⏰ 正在配置本机每日定时采编翻译任务 (07:40, 12:10, 19:10 Asia/Shanghai)...
node scripts/setup-schedule.js --install

echo 🌐 正在打开浏览器 http://localhost:3120 ...
start "" "http://localhost:3120"

echo ▶️ 正在启动 CoreFeed 服务 (按 Ctrl+C 可停止)...
node server.js
pause
