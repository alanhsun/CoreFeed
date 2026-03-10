@echo off
echo 正在启动新闻聚合服务...

REM 检查Node.js是否安装
node --version >nul 2>&1
if errorlevel 1 (
    echo 错误: 未检测到Node.js，请先安装Node.js 18+
    pause
    exit /b 1
)

REM 检查依赖是否安装
if not exist "node_modules" (
    echo 正在安装依赖...
    npm install
    if errorlevel 1 (
        echo 错误: 依赖安装失败
        pause
        exit /b 1
    )
)

REM 检查环境配置文件
if not exist ".env" (
    echo 警告: 未找到.env文件，使用默认配置
    copy .env.example .env >nul 2>&1
)

REM 启动服务
echo 启动服务...
npm start

pause