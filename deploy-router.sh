#!/bin/sh
# ============================================================================
# 聚核 CoreFeed v2.0 — OpenWrt / iStoreOS / Linux 软路由秒级热更新与部署脚本
# 支持在 Windows CMD 直接远程调用:
#   ssh root@10.10.20.10 "wget -qO- https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh | sh"
# 若首次安装后后续只需秒级热更新代码:
#   ssh root@10.10.20.10 "sh /opt/corefeed/deploy-router.sh"
# 若修改了 package.json 需要强制重新构建镜像:
#   ssh root@10.10.20.10 "sh /opt/corefeed/deploy-router.sh --rebuild"
# ============================================================================

set -e

REMOTE_DIR="/opt/corefeed"
APP_PORT="3120"
TARBALL_URL="https://github.com/alanhsun/CoreFeed/archive/refs/heads/main.tar.gz"
FORCE_REBUILD="0"

if [ "$1" = "--rebuild" ]; then
  FORCE_REBUILD="1"
fi

echo "========================================================"
echo "🚀 聚核 CoreFeed v2.0 -> 软路由快速更新与部署"
echo "   安装目录: ${REMOTE_DIR}"
echo "   服务端口: ${APP_PORT}"
echo "========================================================"

mkdir -p "${REMOTE_DIR}/data" "${REMOTE_DIR}/logs"

echo "📥 [1/3] 正在从 GitHub 拉取最新源码..."
rm -rf /tmp/corefeed.tar.gz /tmp/CoreFeed-main
if command -v wget >/dev/null 2>&1; then
  wget -qO /tmp/corefeed.tar.gz "${TARBALL_URL}"
elif command -v curl >/dev/null 2>&1; then
  curl -fsSL "${TARBALL_URL}" -o /tmp/corefeed.tar.gz
else
  echo "❌ 错误: 未找到 wget 或 curl 命令"
  exit 1
fi

echo "📂 正在同步最新代码至 ${REMOTE_DIR} (保留已有 data 与 .env)..."
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

if [ "${FORCE_REBUILD}" = "1" ] || ! docker image inspect corefeed:2.0 >/dev/null 2>&1; then
  echo "🔨 [2/3] 正在构建 Docker 基础镜像 corefeed:2.0 ..."
  docker build -t corefeed:2.0 .
else
  echo "⚡ [2/3] 检测到已存在 corefeed:2.0 镜像，跳过构建（直接通过目录挂载秒级热更新代码）..."
fi

echo "▶️ [3/3] 正在启动/重启 CoreFeed 容器 (挂载源码目录支持秒级热更新)..."
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
  -v "${REMOTE_DIR}/public:/app/public" \
  -v "${REMOTE_DIR}/views:/app/views" \
  -v "${REMOTE_DIR}/services:/app/services" \
  -v "${REMOTE_DIR}/config:/app/config" \
  -v "${REMOTE_DIR}/routes:/app/routes" \
  -v "${REMOTE_DIR}/middleware:/app/middleware" \
  -v "${REMOTE_DIR}/utils:/app/utils" \
  -v "${REMOTE_DIR}/server.js:/app/server.js" \
  corefeed:2.0

sleep 2
echo "========================================================"
echo "✅ CoreFeed v2.0 已完成秒级热更新并启动！"
docker ps --filter "name=corefeed"
echo "🌐 请在浏览器打开: http://10.10.20.10:${APP_PORT}"
echo "💡 后续更新只需执行: ssh root@10.10.20.10 \"sh /opt/corefeed/deploy-router.sh\""
echo "========================================================"
