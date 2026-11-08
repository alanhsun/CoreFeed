#!/bin/sh
# ============================================================================
# 聚核 CoreFeed v2.0 — OpenWrt / iStoreOS / Linux 软路由秒级热更新与部署脚本
# 支持在 Windows PowerShell / CMD / Linux 终端远程一键调用 (将 <YOUR_ROUTER_IP> 替换为软路由实际 IP):
#   ssh root@<YOUR_ROUTER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"
# 若首次安装后后续只需秒级热更新代码:
#   ssh root@<YOUR_ROUTER_IP> "sh /opt/corefeed/deploy-router.sh"
# 若修改了 package.json 需要强制重新构建镜像:
#   ssh root@<YOUR_ROUTER_IP> "sh /opt/corefeed/deploy-router.sh --rebuild"
# ============================================================================

set -e

REMOTE_DIR="${REMOTE_DIR:-${APP_DIR:-/opt/corefeed}}"
APP_PORT="${APP_PORT:-3120}"
CONTAINER_NAME="${CONTAINER_NAME:-corefeed}"
IMAGE_NAME="${IMAGE_NAME:-corefeed:2.0}"
TARBALL_URL="${TARBALL_URL:-https://github.com/alanhsun/CoreFeed/archive/refs/heads/main.tar.gz}"
TMP_DIR="${TMP_DIR:-/tmp}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"
WAIT_RETRIES="${WAIT_RETRIES:-15}"
WAIT_INTERVAL="${WAIT_INTERVAL:-1}"

for arg in "$@"; do
  if [ "$arg" = "--rebuild" ]; then
    FORCE_REBUILD="1"
  fi
done

# ----------------------------------------------------------------------------
# POSIX 安全环境变量读写工具函数 (避免 sed 分隔符冲突与反斜杠转义问题)
# ----------------------------------------------------------------------------
get_env_var_from_file() {
  _key="$1"
  _file="$2"
  [ -f "$_file" ] || return 0
  ENV_K="$_key" awk '
    BEGIN { prefix = ENVIRON["ENV_K"] "=" }
    index($0, prefix) == 1 {
      val = substr($0, length(prefix) + 1)
      sub(/\r$/, "", val)
      print val
      exit
    }
  ' "$_file"
}

get_env_var_from_dump() {
  _key="$1"
  _dump="$2"
  [ -n "$_dump" ] || return 0
  printf '%s\n' "$_dump" | ENV_K="$_key" awk '
    BEGIN { prefix = ENVIRON["ENV_K"] "=" }
    index($0, prefix) == 1 {
      val = substr($0, length(prefix) + 1)
      sub(/\r$/, "", val)
      print val
      exit
    }
  '
}

upsert_env_var() {
  _key="$1"
  _val="$2"
  _file="$3"
  [ -f "$_file" ] || : > "$_file"
  ENV_K="$_key" ENV_V="$_val" awk '
    BEGIN {
      k = ENVIRON["ENV_K"]
      prefix = k "="
      v = ENVIRON["ENV_V"]
      found = 0
    }
    index($0, prefix) == 1 {
      if (!found) {
        print prefix v
        found = 1
      }
      next
    }
    {
      sub(/\r$/, "", $0)
      print $0
    }
    END {
      if (!found) {
        print prefix v
      }
    }
  ' "$_file" > "${_file}.tmp" && mv "${_file}.tmp" "$_file"
}

is_empty_env_val() {
  _v="$1"
  [ -z "$_v" ] || [ "$_v" = '""' ] || [ "$_v" = "''" ]
}

sync_settings_json() {
  _settings_file="$1"
  _settings_dir=$(dirname "$_settings_file")
  mkdir -p "$_settings_dir"
  _node_script='
    const fs = require("fs");
    const file = process.env.SETTINGS_FILE || process.argv[1];
    let current = {};
    try {
      if (fs.existsSync(file)) {
        current = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
      }
    } catch (_) {}
    const times = ["08:00", "12:30", "19:30"];
    const updated = {
      ...current,
      AUTO_UPDATE_ENABLED: true,
      enabled: true,
      scheduleEnabled: true,
      UPDATE_TIMES: "08:00,12:30,19:30",
      updateTimes: "08:00,12:30,19:30",
      scheduleTimes: times,
      SCHEDULE_TIMEZONE: "Asia/Shanghai",
      timezone: "Asia/Shanghai",
      GITHUB_SYNC_ENABLED: current.GITHUB_SYNC_ENABLED !== undefined ? current.GITHUB_SYNC_ENABLED : true,
      GITHUB_SYNC_INTERVAL_MINUTES: current.GITHUB_SYNC_INTERVAL_MINUTES && Number(current.GITHUB_SYNC_INTERVAL_MINUTES) !== 5 && Number(current.GITHUB_SYNC_INTERVAL_MINUTES) !== 15 ? Number(current.GITHUB_SYNC_INTERVAL_MINUTES) : 60,
      GITHUB_SNAPSHOT_URL: current.GITHUB_SNAPSHOT_URL || "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json",
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf8");
  '
  if command -v node >/dev/null 2>&1; then
    SETTINGS_FILE="$_settings_file" node -e "$_node_script" "$_settings_file" 2>/dev/null || true
  elif command -v jq >/dev/null 2>&1; then
    [ -f "$_settings_file" ] || printf '{}\n' > "$_settings_file"
    jq '.AUTO_UPDATE_ENABLED=true | .enabled=true | .scheduleEnabled=true | .UPDATE_TIMES="08:00,12:30,19:30" | .updateTimes="08:00,12:30,19:30" | .scheduleTimes=["08:00","12:30","19:30"] | .SCHEDULE_TIMEZONE="Asia/Shanghai" | .timezone="Asia/Shanghai" | .GITHUB_SYNC_ENABLED=(if .GITHUB_SYNC_ENABLED == null then true else .GITHUB_SYNC_ENABLED end) | .GITHUB_SYNC_INTERVAL_MINUTES=(if .GITHUB_SYNC_INTERVAL_MINUTES == null or .GITHUB_SYNC_INTERVAL_MINUTES == 5 or .GITHUB_SYNC_INTERVAL_MINUTES == 15 then 60 else .GITHUB_SYNC_INTERVAL_MINUTES end) | .GITHUB_SNAPSHOT_URL=(.GITHUB_SNAPSHOT_URL // "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json")' "$_settings_file" > "${_settings_file}.tmp" 2>/dev/null && mv "${_settings_file}.tmp" "$_settings_file" || rm -f "${_settings_file}.tmp"
  elif command -v docker >/dev/null 2>&1 && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
    docker run --rm -v "${REMOTE_DIR}/data:/app/data" "${IMAGE_NAME}" node -e "$_node_script" "/app/data/settings.json" >/dev/null 2>&1 || true
  elif [ ! -f "$_settings_file" ]; then
    cat > "$_settings_file" <<'EOF'
{
  "AUTO_UPDATE_ENABLED": true,
  "enabled": true,
  "scheduleEnabled": true,
  "UPDATE_TIMES": "08:00,12:30,19:30",
  "updateTimes": "08:00,12:30,19:30",
  "scheduleTimes": [
    "08:00",
    "12:30",
    "19:30"
  ],
  "SCHEDULE_TIMEZONE": "Asia/Shanghai",
  "timezone": "Asia/Shanghai",
  "GITHUB_SYNC_ENABLED": true,
  "GITHUB_SYNC_INTERVAL_MINUTES": 60,
  "GITHUB_SNAPSHOT_URL": "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json"
}
EOF
  fi
}

post_schedule_config() {
  _payload='{"enabled":true,"updateTimes":"08:00,12:30,19:30"}'
  _url="http://127.0.0.1:${APP_PORT}/api/schedule/config"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -X POST "$_url" -H "Content-Type: application/json" -d "$_payload" >/dev/null 2>&1 && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --header="Content-Type: application/json" --post-data="$_payload" "$_url" >/dev/null 2>&1 && return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    docker exec "${CONTAINER_NAME}" node -e '
      fetch("http://127.0.0.1:3120/api/schedule/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, updateTimes: "08:00,12:30,19:30" })
      }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
    ' >/dev/null 2>&1 && return 0
  fi
  return 1
}

echo "========================================================"
echo "🚀 聚核 CoreFeed v2.0 -> 软路由快速更新与部署"
echo "   安装目录: ${REMOTE_DIR}"
echo "   服务端口: ${APP_PORT}"
echo "========================================================"

mkdir -p "${REMOTE_DIR}/data" "${REMOTE_DIR}/logs" "${TMP_DIR}"

echo "📥 [1/4] 正在从 GitHub 拉取最新源码..."
if [ -n "${LOCAL_SRC_DIR:-}" ] && [ -d "${LOCAL_SRC_DIR}" ]; then
  cp -rf "${LOCAL_SRC_DIR}/"* "${REMOTE_DIR}/"
  cp -f "${LOCAL_SRC_DIR}/.env.example" "${REMOTE_DIR}/.env.example" 2>/dev/null || true
  cp -f "${LOCAL_SRC_DIR}/.dockerignore" "${REMOTE_DIR}/.dockerignore" 2>/dev/null || true
else
  rm -rf "${TMP_DIR}/corefeed.tar.gz" "${TMP_DIR}/CoreFeed-main"
  if command -v wget >/dev/null 2>&1; then
    wget -qO "${TMP_DIR}/corefeed.tar.gz" "${TARBALL_URL}"
  elif command -v curl >/dev/null 2>&1; then
    curl -fsSL "${TARBALL_URL}" -o "${TMP_DIR}/corefeed.tar.gz"
  else
    echo "❌ 错误: 未找到 wget 或 curl 命令"
    exit 1
  fi

  echo "📂 正在同步最新代码至 ${REMOTE_DIR} (保留已有 data 与 .env)..."
  tar -xzf "${TMP_DIR}/corefeed.tar.gz" -C "${TMP_DIR}"
  cp -rf "${TMP_DIR}/CoreFeed-main/"* "${REMOTE_DIR}/"
  cp -f "${TMP_DIR}/CoreFeed-main/.env.example" "${REMOTE_DIR}/.env.example" 2>/dev/null || true
  cp -f "${TMP_DIR}/CoreFeed-main/.dockerignore" "${REMOTE_DIR}/.dockerignore" 2>/dev/null || true
  rm -rf "${TMP_DIR}/corefeed.tar.gz" "${TMP_DIR}/CoreFeed-main"
fi

cd "${REMOTE_DIR}"

ENV_NEWLY_CREATED="0"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    ENV_NEWLY_CREATED="1"
    echo "📝 已生成默认 .env 配置文件 (可在 ${REMOTE_DIR}/.env 中配置 AI_API_KEY)"
  else
    : > .env
    ENV_NEWLY_CREATED="1"
  fi
fi

echo "🔄 [2/4] 正在迁移已有容器环境变量并同步每日早中晚三次 (08:00,12:30,19:30) 定时配置..."
CONTAINER_ENV_DUMP=""
if command -v docker >/dev/null 2>&1; then
  CONTAINER_ENV_DUMP=$(docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || docker inspect news-aggregator --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
fi

if [ -n "${CONTAINER_ENV_DUMP}" ]; then
  PRIOR_ENV_AI_KEY=$(get_env_var_from_file "AI_API_KEY" ".env")
  for KEY in AI_BASE_URL AI_API_KEY AI_MODEL PUBLISH_SECRET PUBLISH_API_KEY GITHUB_SNAPSHOT_URL; do
    CONTAINER_VAL=$(get_env_var_from_dump "$KEY" "$CONTAINER_ENV_DUMP")
    if [ "$KEY" = "PUBLISH_SECRET" ] && is_empty_env_val "$CONTAINER_VAL"; then
      CONTAINER_VAL=$(get_env_var_from_dump "PUBLISH_API_KEY" "$CONTAINER_ENV_DUMP")
    fi
    if ! is_empty_env_val "$CONTAINER_VAL"; then
      CURRENT_VAL=$(get_env_var_from_file "$KEY" ".env")
      SHOULD_UPDATE="0"
      if is_empty_env_val "$CURRENT_VAL" || [ "$ENV_NEWLY_CREATED" = "1" ]; then
        SHOULD_UPDATE="1"
      elif is_empty_env_val "$PRIOR_ENV_AI_KEY"; then
        if [ "$KEY" = "AI_BASE_URL" ] && [ "$CURRENT_VAL" = "https://api.openai.com/v1" ]; then
          SHOULD_UPDATE="1"
        elif [ "$KEY" = "AI_MODEL" ] && [ "$CURRENT_VAL" = "gpt-4o-mini" ]; then
          SHOULD_UPDATE="1"
        fi
      fi
      if [ "$SHOULD_UPDATE" = "1" ]; then
        upsert_env_var "$KEY" "$CONTAINER_VAL" ".env"
      fi
    fi
  done
fi

upsert_env_var "AUTO_UPDATE_ENABLED" "true" ".env"
upsert_env_var "UPDATE_TIMES" "08:00,12:30,19:30" ".env"
upsert_env_var "SCHEDULE_TIMEZONE" "Asia/Shanghai" ".env"

if is_empty_env_val "$(get_env_var_from_file "GITHUB_SYNC_ENABLED" ".env")"; then
  upsert_env_var "GITHUB_SYNC_ENABLED" "true" ".env"
fi
CURRENT_SYNC_INTERVAL=$(get_env_var_from_file "GITHUB_SYNC_INTERVAL_MINUTES" ".env")
if is_empty_env_val "$CURRENT_SYNC_INTERVAL" || [ "$CURRENT_SYNC_INTERVAL" = "5" ] || [ "$CURRENT_SYNC_INTERVAL" = "15" ]; then
  upsert_env_var "GITHUB_SYNC_INTERVAL_MINUTES" "60" ".env"
fi
if is_empty_env_val "$(get_env_var_from_file "GITHUB_SNAPSHOT_URL" ".env")"; then
  upsert_env_var "GITHUB_SNAPSHOT_URL" "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json" ".env"
fi

sync_settings_json "${REMOTE_DIR}/data/settings.json"

if [ "${FORCE_REBUILD}" = "1" ] || ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "🔨 [3/4] 正在构建 Docker 基础镜像 ${IMAGE_NAME} ..."
  docker build -t "${IMAGE_NAME}" .
else
  echo "⚡ [3/4] 检测到已存在 ${IMAGE_NAME} 镜像，跳过构建（直接通过目录挂载秒级热更新代码）..."
fi

echo "▶️ [4/4] 正在启动/重启 CoreFeed 容器 (挂载源码目录支持秒级热更新)..."
docker rm -f "${CONTAINER_NAME}" news-aggregator 2>/dev/null || true

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  -p "${APP_PORT}:3120" \
  -e NODE_ENV=production \
  -e PORT=3120 \
  -e TZ=Asia/Shanghai \
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
  -v "${REMOTE_DIR}/scripts:/app/scripts" \
  -v "${REMOTE_DIR}/server.js:/app/server.js" \
  "${IMAGE_NAME}"

SCHEDULE_SYNCED="0"
WAIT_COUNT="0"
while [ "$WAIT_COUNT" -lt "$WAIT_RETRIES" ]; do
  if post_schedule_config; then
    SCHEDULE_SYNCED="1"
    echo "⏰ 已激活每日早中晚三次 (08:00, 12:30, 19:30 Asia/Shanghai) 自动更新调度"
    break
  fi
  WAIT_COUNT=$((WAIT_COUNT + 1))
  sleep "$WAIT_INTERVAL"
done

if [ "$SCHEDULE_SYNCED" != "1" ]; then
  sync_settings_json "${REMOTE_DIR}/data/settings.json"
fi

ROUTER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "${ROUTER_IP}" ]; then
  ROUTER_IP=$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
fi

echo "========================================================"
echo "✅ CoreFeed v2.0 已完成秒级热更新并启动！"
docker ps --filter "name=${CONTAINER_NAME}"
echo "🌐 请在浏览器打开: http://${ROUTER_IP:-<YOUR_ROUTER_IP>}:${APP_PORT}"
echo "💡 后续更新只需执行: ssh root@${ROUTER_IP:-<YOUR_ROUTER_IP>} \"sh /opt/corefeed/deploy-router.sh\""
echo "========================================================"
