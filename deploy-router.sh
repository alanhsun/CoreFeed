#!/usr/bin/env bash
# ============================================================================
# 聚核 CoreFeed v2.0 — 软路由 (10.10.20.10) 一键 Docker 部署脚本
# 支持 OpenWrt / iStoreOS / Debian / Ubuntu / Unraid 等软路由系统
# 用法:
#   在本机电脑执行: bash deploy-router.sh [路由IP]
#   默认路由地址:   10.10.20.10 (默认用户 root, 默认目录 /opt/corefeed)
# ============================================================================

set -e

ROUTER_HOST="${1:-10.10.20.10}"
ROUTER_USER="${ROUTER_USER:-root}"
ROUTER_PORT="${ROUTER_PORT:-22}"
REMOTE_DIR="${REMOTE_DIR:-/opt/corefeed}"
APP_PORT="${APP_PORT:-3120}"

echo "========================================================"
echo "🚀 聚核 CoreFeed v2.0 -> 软路由 Docker 自动部署"
echo "   目标路由: ${ROUTER_USER}@${ROUTER_HOST}:${ROUTER_PORT}"
echo "   部署路径: ${REMOTE_DIR}"
echo "   访问端口: ${APP_PORT}"
echo "========================================================"

# 远程在软路由上执行的容器构建与启动逻辑（自动兼容 docker compose 与纯 docker CLI）
REMOTE_START_SCRIPT='
set -e
cd "'"${REMOTE_DIR}"'"
mkdir -p data logs

if [ ! -f .env ] && [ -f .env.example ]; then
  cp .env.example .env
  echo "📝 已从 .env.example 初始化默认 .env 配置文件"
fi

echo "🔨 正在软路由上构建 Docker 镜像 corefeed:2.0 ..."
docker build -t corefeed:2.0 .

echo "🔄 正在停止并清理旧容器 (如果存在)..."
docker rm -f corefeed news-aggregator 2>/dev/null || true

echo "▶️ 正在启动 CoreFeed 容器..."
docker run -d \
  --name corefeed \
  --restart unless-stopped \
  -p '"${APP_PORT}"':3120 \
  -e NODE_ENV=production \
  -e PORT=3120 \
  -e TZ=Asia/Shanghai \
  --env-file .env \
  -v "'"${REMOTE_DIR}"'/data:/app/data" \
  -v "'"${REMOTE_DIR}"'/logs:/app/logs" \
  corefeed:2.0

echo "⏳ 等待服务启动就绪..."
sleep 3
docker ps --filter "name=corefeed" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
'

# 判断当前是否已经在目标软路由本机终端内运行
CURRENT_IPS=$(hostname -I 2>/dev/null || ifconfig 2>/dev/null || echo "")
if echo "${CURRENT_IPS}" | grep -q "${ROUTER_HOST}"; then
  echo "📍 检测到当前已在软路由 (${ROUTER_HOST}) 终端内，直接执行本地 Docker 部署..."
  mkdir -p "${REMOTE_DIR}"
  if [ "$(pwd)" != "${REMOTE_DIR}" ]; then
    tar --exclude='./node_modules' --exclude='./.git' --exclude='./logs/*' -cf - . | (cd "${REMOTE_DIR}" && tar -xf -)
  fi
  bash -c "${REMOTE_START_SCRIPT}"
else
  echo "📦 [1/2] 正在通过 SSH 将项目代码打包传输至 ${ROUTER_USER}@${ROUTER_HOST}:${REMOTE_DIR} ..."
  echo "    (无需软路由安装 git 或 rsync，自动保留软路由已有的 data/ 与 .env)"
  tar --exclude='./node_modules' \
      --exclude='./.git' \
      --exclude='./logs/*' \
      --exclude='./data/*' \
      -czf - . | ssh -p "${ROUTER_PORT}" "${ROUTER_USER}@${ROUTER_HOST}" "mkdir -p '${REMOTE_DIR}/data' '${REMOTE_DIR}/logs' && tar -xzf - -C '${REMOTE_DIR}'"

  # 如果本机已经配置了 .env，同步上传到软路由
  if [ -f .env ]; then
    echo "🔑 检测到本机存在 .env 配置，正在同步至软路由..."
    scp -P "${ROUTER_PORT}" .env "${ROUTER_USER}@${ROUTER_HOST}:${REMOTE_DIR}/.env"
  fi

  echo "🐳 [2/2] 正在软路由 ${ROUTER_HOST} 上构建并启动 Docker 容器..."
  ssh -p "${ROUTER_PORT}" "${ROUTER_USER}@${ROUTER_HOST}" "${REMOTE_START_SCRIPT}"
fi

echo "========================================================"
echo "✅ 部署完成！"
echo "🌐 局域网访问地址: http://${ROUTER_HOST}:${APP_PORT}"
echo "🩺 健康检查地址:   http://${ROUTER_HOST}:${APP_PORT}/api/health"
echo "📂 软路由数据目录: ${REMOTE_DIR}/data"
echo "⚙️  修改大模型密钥: ssh ${ROUTER_USER}@${ROUTER_HOST} \"vi ${REMOTE_DIR}/.env && docker restart corefeed\""
echo "========================================================"
