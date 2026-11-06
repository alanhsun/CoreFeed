#!/bin/sh
# ============================================================================
# 聚核 CoreFeed v2.0 — OpenWrt / iStoreOS / Linux 软路由一键部署脚本 (POSIX sh 兼容)
# 支持在 Windows CMD 直接远程调用:
#   ssh root@10.10.20.10 "wget -qO- https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh | sh"
# ============================================================================

set -e

REMOTE_DIR="/opt/corefeed"
APP_PORT="3120"
TARBALL_URL="https://github.com/alanhsun/CoreFeed/archive/refs/heads/main.tar.gz"

echo "========================================================"
echo "🚀 聚核 CoreFeed v2.0 -> 软路由 Docker 自动部署"
echo "   安装目录: ${REMOTE_DIR}"
echo "   服务端口: ${APP_PORT}"
echo "========================================================"

mkdir -p "${REMOTE_DIR}/data" "${REMOTE_DIR}/logs"

echo "📥 [1/3] 正在从 GitHub 下载最新 CoreFeed v2.0 源码包..."
rm -rf /tmp/corefeed.tar.gz /tmp/CoreFeed-main
if command -v wget >/dev/null 2>&1; then
  wget -qO /tmp/corefeed.tar.gz "${TARBALL_URL}"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "${TARBALL_URL}" -o /tmp/corefeed.tar.gz
else
  echo "❌ 错误: 未找到 wget 或 curl 命令"
  exit 1
fi

echo "📂 正在解压源码至 ${REMOTE_DIR} (保留已有 data 与 .env)..."
tar -xzf /tmp/corefeed.tar.gz -C /tmp
cp -rf /tmp/CoreFeed-main/* "${REMOTE_DIR}/"
cp -f /tmp/CoreFeed-main/.env.example "${REMOTE_DIR}/.env.example" 2>/dev/null || true
cp -f /tmp/CoreFeed-main/.dockerignore "${REMOTE_DIR}/.dockerignore" 2>/dev/null || true
rm -rf /tmp/corefeed.tar.gz /tmp/CoreFeed-main

cd "${REMOTE_DIR}"

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "📝 已生成默认 .env 配置文件 (内置 ag/gemini-4-argon-high 模型配置)"
fi

echo "🔨 [2/3] 正在软路由上构建 Docker 镜像 corefeed:2.0 ..."
docker build -t corefeed:2.0 .

echo "▶️ [3/3] 正在启动 CoreFeed 容器..."
docker rm -f corefeed news-aggregator 2>/dev/null || true

docker run -d \
  --name corefeed \
  --restart unless-stopped \
  -p "${APP_PORT}:3120" \
  -e NODE_ENV=production \
  -e PORT=3120 \
  -e TZ=Asia/Shanghai \
  -e AI_BASE_URL="https://nl.alansun.host:9443/v1" \
  -e AI_API_KEY="sk-67a4e5e2baba0b27-666i7t-0f8052ff" \
  -e AI_MODEL="ag/gemini-4-argon-high" \
  --env-file "${REMOTE_DIR}/.env" \
  -v "${REMOTE_DIR}/data:/app/data" \
  -v "${REMOTE_DIR}/logs:/app/logs" \
  corefeed:2.0

sleep 3
echo "========================================================"
echo "✅ CoreFeed v2.0 部署成功！"
docker ps --filter "name=corefeed"
echo "🌐 请在浏览器打开: http://10.10.20.10:${APP_PORT}"
echo "🩺 健康检查接口:   http://10.10.20.10:${APP_PORT}/api/health"
echo "========================================================"
