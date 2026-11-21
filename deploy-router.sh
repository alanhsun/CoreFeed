#!/bin/sh
# ============================================================================
# 聚核 CoreFeed v3.0 — Linux / Docker 自托管服务端秒级热更新与部署脚本
# 支持远程一键调用 (将 <YOUR_SERVER_IP> 替换为目标服务器实际 IP):
#   ssh root@<YOUR_SERVER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"
# 若首次安装后后续只需秒级热更新代码:
#   ssh root@<YOUR_SERVER_IP> "sh /opt/corefeed/deploy-router.sh"
# 若修改了 package.json 需要强制重新构建镜像 (脚本亦会自动检测 lockfile 哈希变化):
#   ssh root@<YOUR_SERVER_IP> "sh /opt/corefeed/deploy-router.sh --rebuild"
# 若需强制重置自定义定时计划为默认 (08:00,12:30,19:30 Asia/Shanghai):
#   ssh root@<YOUR_SERVER_IP> "sh /opt/corefeed/deploy-router.sh --reset-schedule"
# ============================================================================

set -e

REMOTE_DIR="${REMOTE_DIR:-${APP_DIR:-/opt/corefeed}}"
APP_PORT="${APP_PORT:-3120}"
CONTAINER_NAME="${CONTAINER_NAME:-corefeed}"
IMAGE_NAME="${IMAGE_NAME:-corefeed:2.0}"
COREFEED_REPO="${COREFEED_REPO:-alanhsun/CoreFeed}"
COREFEED_BRANCH="${COREFEED_BRANCH:-main}"
AG_GITHUB_BRANCH="${AG_GITHUB_BRANCH:-ag-snapshot}"
TARBALL_URL="${TARBALL_URL:-https://github.com/${COREFEED_REPO}/archive/refs/heads/${COREFEED_BRANCH}.tar.gz}"
DEFAULT_SNAPSHOT_URL="https://raw.githubusercontent.com/${COREFEED_REPO}/${AG_GITHUB_BRANCH}/manifest.json"
DEFAULT_UPDATE_TIMES="08:00,12:30,19:30"
DEFAULT_TIMEZONE="Asia/Shanghai"
TMP_DIR="${TMP_DIR:-/tmp}"
FORCE_REBUILD="${FORCE_REBUILD:-0}"
RESET_SCHEDULE="${RESET_SCHEDULE:-0}"
WAIT_RETRIES="${WAIT_RETRIES:-15}"
WAIT_INTERVAL="${WAIT_INTERVAL:-1}"

for arg in "$@"; do
  case "$arg" in
    --rebuild)
      FORCE_REBUILD="1"
      ;;
    --reset-schedule)
      RESET_SCHEDULE="1"
      ;;
  esac
done

# ----------------------------------------------------------------------------
# POSIX 安全环境变量与哈希计算工具函数
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

compute_file_hash() {
  _target="$1"
  [ -f "$_target" ] || return 0
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$_target" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$_target" | awk '{print $1}'
  elif command -v cksum >/dev/null 2>&1; then
    cksum "$_target" | awk '{print $1 "-" $2}'
  fi
}

sync_code_tree() {
  _src="$1"
  _dst="$2"
  for _dir in public views services config routes middleware utils scripts integrations; do
    if [ -d "${_src}/${_dir}" ]; then
      rm -rf "${_dst:?}/${_dir}"
      cp -rf "${_src}/${_dir}" "${_dst}/"
    fi
  done
  for _item in "${_src}"/* "${_src}"/.env.example "${_src}"/.dockerignore; do
    [ -f "$_item" ] || continue
    _base=$(basename "$_item")
    [ "$_base" = ".env" ] && continue
    cp -f "$_item" "${_dst}/${_base}"
  done
  if [ -f "${_dst}/docker-entrypoint.sh" ]; then
    chmod +x "${_dst}/docker-entrypoint.sh" 2>/dev/null || true
  fi
  if [ -f "${_dst}/deploy-router.sh" ]; then
    chmod +x "${_dst}/deploy-router.sh" 2>/dev/null || true
  fi
}

sync_settings_json() {
  _settings_file="$1"
  _active_enabled="$2"
  _active_times="$3"
  _active_tz="$4"
  _default_snap="$5"
  _settings_dir=$(dirname "$_settings_file")
  mkdir -p "$_settings_dir"
  _node_script='
    const fs = require("fs");
    const file = process.env.SETTINGS_FILE || process.argv[1];
    const activeEnabled = process.env.ACTIVE_AUTO_UPDATE !== "false";
    const activeTimesStr = (process.env.ACTIVE_UPDATE_TIMES || "08:00,12:30,19:30").trim();
    const activeTimesArr = activeTimesStr.split(",").map(s => s.trim()).filter(Boolean);
    const activeTz = (process.env.ACTIVE_TIMEZONE || "Asia/Shanghai").trim();
    const defaultSnap = process.env.DEFAULT_SNAPSHOT_URL || "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json";
    let current = {};
    try {
      if (fs.existsSync(file)) {
        current = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
      }
    } catch (_) {}
    const updated = {
      ...current,
      AUTO_UPDATE_ENABLED: activeEnabled,
      enabled: activeEnabled,
      scheduleEnabled: activeEnabled,
      UPDATE_TIMES: activeTimesArr.join(","),
      updateTimes: activeTimesArr.join(","),
      scheduleTimes: activeTimesArr,
      SCHEDULE_TIMEZONE: activeTz,
      timezone: activeTz,
      GITHUB_SYNC_ENABLED: current.GITHUB_SYNC_ENABLED !== undefined ? current.GITHUB_SYNC_ENABLED : true,
      GITHUB_SYNC_INTERVAL_MINUTES: current.GITHUB_SYNC_INTERVAL_MINUTES && Number(current.GITHUB_SYNC_INTERVAL_MINUTES) !== 5 && Number(current.GITHUB_SYNC_INTERVAL_MINUTES) !== 15 ? Number(current.GITHUB_SYNC_INTERVAL_MINUTES) : 60,
      GITHUB_SNAPSHOT_URL: current.GITHUB_SNAPSHOT_URL || defaultSnap,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf8");
  '
  if command -v node >/dev/null 2>&1; then
    SETTINGS_FILE="$_settings_file" \
    ACTIVE_AUTO_UPDATE="$_active_enabled" \
    ACTIVE_UPDATE_TIMES="$_active_times" \
    ACTIVE_TIMEZONE="$_active_tz" \
    DEFAULT_SNAPSHOT_URL="$_default_snap" \
      node -e "$_node_script" "$_settings_file" 2>/dev/null || true
  elif command -v jq >/dev/null 2>&1; then
    [ -f "$_settings_file" ] || printf '{}\n' > "$_settings_file"
    _jq_enabled="true"
    [ "$_active_enabled" = "false" ] && _jq_enabled="false"
    jq \
      --argjson en "$_jq_enabled" \
      --arg times "$_active_times" \
      --arg tz "$_active_tz" \
      --arg snap "$_default_snap" \
      '.AUTO_UPDATE_ENABLED=$en | .enabled=$en | .scheduleEnabled=$en | .UPDATE_TIMES=$times | .updateTimes=$times | .scheduleTimes=($times | split(",")) | .SCHEDULE_TIMEZONE=$tz | .timezone=$tz | .GITHUB_SYNC_ENABLED=(if .GITHUB_SYNC_ENABLED == null then true else .GITHUB_SYNC_ENABLED end) | .GITHUB_SYNC_INTERVAL_MINUTES=(if .GITHUB_SYNC_INTERVAL_MINUTES == null or .GITHUB_SYNC_INTERVAL_MINUTES == 5 or .GITHUB_SYNC_INTERVAL_MINUTES == 15 then 60 else .GITHUB_SYNC_INTERVAL_MINUTES end) | .GITHUB_SNAPSHOT_URL=(.GITHUB_SNAPSHOT_URL // $snap)' \
      "$_settings_file" > "${_settings_file}.tmp" 2>/dev/null && mv "${_settings_file}.tmp" "$_settings_file" || rm -f "${_settings_file}.tmp"
  elif command -v docker >/dev/null 2>&1 && docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
    docker run --rm \
      -e ACTIVE_AUTO_UPDATE="$_active_enabled" \
      -e ACTIVE_UPDATE_TIMES="$_active_times" \
      -e ACTIVE_TIMEZONE="$_active_tz" \
      -e DEFAULT_SNAPSHOT_URL="$_default_snap" \
      -v "${REMOTE_DIR}/data:/app/data" \
      "${IMAGE_NAME}" node -e "$_node_script" "/app/data/settings.json" >/dev/null 2>&1 || true
  elif [ ! -f "$_settings_file" ]; then
    _json_enabled="true"
    [ "$_active_enabled" = "false" ] && _json_enabled="false"
    cat > "$_settings_file" <<EOF
{
  "AUTO_UPDATE_ENABLED": ${_json_enabled},
  "enabled": ${_json_enabled},
  "scheduleEnabled": ${_json_enabled},
  "UPDATE_TIMES": "${_active_times}",
  "updateTimes": "${_active_times}",
  "SCHEDULE_TIMEZONE": "${_active_tz}",
  "timezone": "${_active_tz}",
  "GITHUB_SYNC_ENABLED": true,
  "GITHUB_SYNC_INTERVAL_MINUTES": 60,
  "GITHUB_SNAPSHOT_URL": "${_default_snap}"
}
EOF
  fi
}

check_health() {
  _health_url="http://127.0.0.1:${APP_PORT}/api/health"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --connect-timeout 3 --max-time 5 "$_health_url" >/dev/null 2>&1 && return 0
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- -T 5 "$_health_url" >/dev/null 2>&1 && return 0
  elif command -v docker >/dev/null 2>&1; then
    docker exec "${CONTAINER_NAME}" wget --no-verbose --tries=1 --spider "http://127.0.0.1:3120/api/health" >/dev/null 2>&1 && return 0
  fi
  return 1
}

post_schedule_config() {
  _en_bool="true"
  [ "${ACTIVE_AUTO_UPDATE}" = "false" ] && _en_bool="false"
  _payload=$(printf '{"enabled":%s,"updateTimes":"%s"}' "$_en_bool" "${ACTIVE_UPDATE_TIMES}")
  _url="http://127.0.0.1:${APP_PORT}/api/schedule/config"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -X POST "$_url" -H "X-Requested-With: CoreFeed-WebUI" -H "Content-Type: application/json" -d "$_payload" >/dev/null 2>&1 && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --header="X-Requested-With: CoreFeed-WebUI" --header="Content-Type: application/json" --post-data="$_payload" "$_url" >/dev/null 2>&1 && return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    docker exec -e CF_SCHED_PAYLOAD="$_payload" "${CONTAINER_NAME}" node -e '
      fetch("http://127.0.0.1:3120/api/schedule/config", {
        method: "POST",
        headers: { "X-Requested-With": "CoreFeed-WebUI", "Content-Type": "application/json" },
        body: process.env.CF_SCHED_PAYLOAD
      }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
    ' >/dev/null 2>&1 && return 0
  fi
  return 1
}

pull_github_snapshot() {
  _payload='{"force":true,"trigger":"ui"}'
  _url="http://127.0.0.1:${APP_PORT}/api/agent/pull-github"
  if command -v curl >/dev/null 2>&1; then
    curl -fsS -X POST "$_url" -H "X-Requested-With: CoreFeed-WebUI" -H "Content-Type: application/json" -d "$_payload" >/dev/null 2>&1 && return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --header="X-Requested-With: CoreFeed-WebUI" --header="Content-Type: application/json" --post-data="$_payload" "$_url" >/dev/null 2>&1 && return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    docker exec "${CONTAINER_NAME}" node -e '
      fetch("http://127.0.0.1:3120/api/agent/pull-github", {
        method: "POST",
        headers: { "X-Requested-With": "CoreFeed-WebUI", "Content-Type": "application/json" },
        body: JSON.stringify({ force: true, trigger: "ui" })
      }).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));
    ' >/dev/null 2>&1 && return 0
  fi
  return 1
}

echo "========================================================"
echo "🚀 聚核 CoreFeed v3.0 -> 自托管服务端快速更新与部署"
echo "   目标仓库: ${COREFEED_REPO} (${COREFEED_BRANCH})"
echo "   安装目录: ${REMOTE_DIR}"
echo "   服务端口: ${APP_PORT}"
echo "========================================================"

mkdir -p "${REMOTE_DIR}/data" "${REMOTE_DIR}/logs" "${TMP_DIR}"

echo "📥 [1/4] 正在从 GitHub 拉取最新源码..."
if [ -n "${LOCAL_SRC_DIR:-}" ] && [ -d "${LOCAL_SRC_DIR}" ]; then
  sync_code_tree "${LOCAL_SRC_DIR}" "${REMOTE_DIR}"
else
  EXTRACT_STAGE="${TMP_DIR}/corefeed-extract"
  rm -rf "${TMP_DIR}/corefeed.tar.gz" "${EXTRACT_STAGE}"
  FALLBACK_TARBALL_URL="https://ghfast.top/${TARBALL_URL}"
  DOWNLOAD_OK="0"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsSL --connect-timeout 15 --max-time 60 "${TARBALL_URL}" -o "${TMP_DIR}/corefeed.tar.gz"; then
      DOWNLOAD_OK="1"
    elif curl -fsSL --connect-timeout 15 --max-time 60 "${FALLBACK_TARBALL_URL}" -o "${TMP_DIR}/corefeed.tar.gz"; then
      echo "⚠️ GitHub 直连失败，已自动切换镜像下载源码"
      DOWNLOAD_OK="1"
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q -T 60 -O "${TMP_DIR}/corefeed.tar.gz" "${TARBALL_URL}"; then
      DOWNLOAD_OK="1"
    elif wget -q -T 60 -O "${TMP_DIR}/corefeed.tar.gz" "${FALLBACK_TARBALL_URL}"; then
      echo "⚠️ GitHub 直连失败，已自动切换镜像下载源码"
      DOWNLOAD_OK="1"
    fi
  else
    echo "❌ 错误: 未找到 wget 或 curl 命令"
    exit 1
  fi
  if [ "${DOWNLOAD_OK}" != "1" ] || [ ! -s "${TMP_DIR}/corefeed.tar.gz" ]; then
    echo "❌ 错误: 无法下载源码压缩包 (${TARBALL_URL})"
    exit 1
  fi

  echo "📂 正在同步最新代码至 ${REMOTE_DIR} (清理旧代码目录并保留已有 data / logs / .env)..."
  mkdir -p "${EXTRACT_STAGE}"
  tar -xzf "${TMP_DIR}/corefeed.tar.gz" -C "${EXTRACT_STAGE}"
  SRC_EXTRACT_DIR=$(find "${EXTRACT_STAGE}" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  if [ -z "${SRC_EXTRACT_DIR}" ] || [ ! -d "${SRC_EXTRACT_DIR}" ]; then
    SRC_EXTRACT_DIR="${EXTRACT_STAGE}"
  fi
  sync_code_tree "${SRC_EXTRACT_DIR}" "${REMOTE_DIR}"
  rm -rf "${TMP_DIR}/corefeed.tar.gz" "${EXTRACT_STAGE}"
fi

cd "${REMOTE_DIR}"

ENV_NEWLY_CREATED="0"
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
    ENV_NEWLY_CREATED="1"
    echo "📝 已生成默认 .env 配置文件"
  else
    : > .env
    ENV_NEWLY_CREATED="1"
  fi
fi

echo "🔄 [2/4] 正在迁移已有容器环境变量并同步定时与快照配置..."
HAS_PREV_CONTAINER="0"
CONTAINER_ENV_DUMP=""
if command -v docker >/dev/null 2>&1; then
  if CONTAINER_ENV_DUMP=$(docker inspect "${CONTAINER_NAME}" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null); then
    HAS_PREV_CONTAINER="1"
  else
    CONTAINER_ENV_DUMP=$(docker inspect news-aggregator --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null || true)
  fi
fi

if [ -n "${CONTAINER_ENV_DUMP}" ]; then
  for KEY in PUBLISH_SECRET PUBLISH_API_KEY GITHUB_SNAPSHOT_URL; do
    CONTAINER_VAL=$(get_env_var_from_dump "$KEY" "$CONTAINER_ENV_DUMP")
    if [ "$KEY" = "PUBLISH_SECRET" ] && is_empty_env_val "$CONTAINER_VAL"; then
      CONTAINER_VAL=$(get_env_var_from_dump "PUBLISH_API_KEY" "$CONTAINER_ENV_DUMP")
    fi
    if ! is_empty_env_val "$CONTAINER_VAL"; then
      CURRENT_VAL=$(get_env_var_from_file "$KEY" ".env")
      if is_empty_env_val "$CURRENT_VAL" || [ "$ENV_NEWLY_CREATED" = "1" ]; then
        upsert_env_var "$KEY" "$CONTAINER_VAL" ".env"
      fi
    fi
  done
fi

EXISTING_TIMES=$(get_env_var_from_file "UPDATE_TIMES" ".env")
EXISTING_AUTO=$(get_env_var_from_file "AUTO_UPDATE_ENABLED" ".env")
EXISTING_TZ=$(get_env_var_from_file "SCHEDULE_TIMEZONE" ".env")

if [ "${RESET_SCHEDULE}" = "1" ] || [ "${ENV_NEWLY_CREATED}" = "1" ] || is_empty_env_val "${EXISTING_TIMES}" || [ "${EXISTING_TIMES}" = "06:00,16:30" ]; then
  ACTIVE_AUTO_UPDATE="true"
  ACTIVE_UPDATE_TIMES="${DEFAULT_UPDATE_TIMES}"
  ACTIVE_TIMEZONE="${DEFAULT_TIMEZONE}"
else
  if is_empty_env_val "${EXISTING_AUTO}"; then
    ACTIVE_AUTO_UPDATE="true"
  else
    ACTIVE_AUTO_UPDATE="${EXISTING_AUTO}"
  fi
  ACTIVE_UPDATE_TIMES="${EXISTING_TIMES}"
  if is_empty_env_val "${EXISTING_TZ}"; then
    ACTIVE_TIMEZONE="${DEFAULT_TIMEZONE}"
  else
    ACTIVE_TIMEZONE="${EXISTING_TZ}"
  fi
fi

upsert_env_var "AUTO_UPDATE_ENABLED" "${ACTIVE_AUTO_UPDATE}" ".env"
upsert_env_var "UPDATE_TIMES" "${ACTIVE_UPDATE_TIMES}" ".env"
upsert_env_var "SCHEDULE_TIMEZONE" "${ACTIVE_TIMEZONE}" ".env"

if [ "${COREFEED_REPO}" != "alanhsun/CoreFeed" ] || is_empty_env_val "$(get_env_var_from_file "COREFEED_REPO" ".env")"; then
  upsert_env_var "COREFEED_REPO" "${COREFEED_REPO}" ".env"
fi

if is_empty_env_val "$(get_env_var_from_file "GITHUB_SYNC_ENABLED" ".env")"; then
  upsert_env_var "GITHUB_SYNC_ENABLED" "true" ".env"
fi
CURRENT_SYNC_INTERVAL=$(get_env_var_from_file "GITHUB_SYNC_INTERVAL_MINUTES" ".env")
if is_empty_env_val "$CURRENT_SYNC_INTERVAL" || [ "$CURRENT_SYNC_INTERVAL" = "5" ] || [ "$CURRENT_SYNC_INTERVAL" = "15" ]; then
  upsert_env_var "GITHUB_SYNC_INTERVAL_MINUTES" "60" ".env"
fi
if is_empty_env_val "$(get_env_var_from_file "GITHUB_SNAPSHOT_URL" ".env")"; then
  upsert_env_var "GITHUB_SNAPSHOT_URL" "${DEFAULT_SNAPSHOT_URL}" ".env"
fi

sync_settings_json "${REMOTE_DIR}/data/settings.json" "${ACTIVE_AUTO_UPDATE}" "${ACTIVE_UPDATE_TIMES}" "${ACTIVE_TIMEZONE}" "${DEFAULT_SNAPSHOT_URL}"

DEPS_FILE="${REMOTE_DIR}/package-lock.json"
[ -f "${DEPS_FILE}" ] || DEPS_FILE="${REMOTE_DIR}/package.json"
DEPS_HASH_FILE="${REMOTE_DIR}/data/.deps.sha256"
CURRENT_DEPS_HASH=$(compute_file_hash "${DEPS_FILE}")
STORED_DEPS_HASH=""
if [ -f "${DEPS_HASH_FILE}" ]; then
  STORED_DEPS_HASH=$(cat "${DEPS_HASH_FILE}" 2>/dev/null || true)
fi

if [ -n "${CURRENT_DEPS_HASH}" ] && [ -n "${STORED_DEPS_HASH}" ] && [ "${CURRENT_DEPS_HASH}" != "${STORED_DEPS_HASH}" ]; then
  echo "📦 检测到依赖清单变更，已自动触发 Docker 基础镜像重建..."
  FORCE_REBUILD="1"
fi

if [ "${FORCE_REBUILD}" = "1" ] || ! docker image inspect "${IMAGE_NAME}" >/dev/null 2>&1; then
  echo "🔨 [3/4] 正在构建 Docker 基础镜像 ${IMAGE_NAME} ..."
  docker build -t "${IMAGE_NAME}" .
  if [ -n "${CURRENT_DEPS_HASH}" ]; then
    printf '%s\n' "${CURRENT_DEPS_HASH}" > "${DEPS_HASH_FILE}"
  fi
else
  echo "⚡ [3/4] 检测到已存在 ${IMAGE_NAME} 镜像且依赖未变化，跳过构建（目录挂载秒级热更新）..."
  if [ -n "${CURRENT_DEPS_HASH}" ] && [ ! -f "${DEPS_HASH_FILE}" ]; then
    printf '%s\n' "${CURRENT_DEPS_HASH}" > "${DEPS_HASH_FILE}"
  fi
fi

echo "▶️ [4/4] 正在切换并启动 CoreFeed 容器 (支持健康检查失败自动回滚)..."
docker rm -f "${CONTAINER_NAME}-prev" news-aggregator 2>/dev/null || true

if [ "${HAS_PREV_CONTAINER}" = "1" ]; then
  docker stop "${CONTAINER_NAME}" >/dev/null 2>&1 || true
  docker rename "${CONTAINER_NAME}" "${CONTAINER_NAME}-prev"
fi

docker run -d \
  --name "${CONTAINER_NAME}" \
  --restart unless-stopped \
  --security-opt no-new-privileges:true \
  -p "${APP_PORT}:3120" \
  -e NODE_ENV=production \
  -e TZ="${ACTIVE_TIMEZONE}" \
  -e PORT=3120 \
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
  -v "${REMOTE_DIR}/integrations:/app/integrations" \
  -v "${REMOTE_DIR}/server.js:/app/server.js" \
  "${IMAGE_NAME}"

HEALTHY="0"
WAIT_COUNT="0"
while [ "$WAIT_COUNT" -lt "$WAIT_RETRIES" ]; do
  if check_health; then
    HEALTHY="1"
    break
  fi
  WAIT_COUNT=$((WAIT_COUNT + 1))
  if [ "$WAIT_INTERVAL" != "0" ]; then
    sleep "$WAIT_INTERVAL"
  fi
done

if [ "${HEALTHY}" != "1" ]; then
  echo "❌ 新容器健康检查超时失败 (GET http://127.0.0.1:${APP_PORT}/api/health)，最近日志如下："
  docker logs --tail 30 "${CONTAINER_NAME}" 2>&1 || true
  docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
  if [ "${HAS_PREV_CONTAINER}" = "1" ]; then
    echo "⏪ 正在自动回滚至上一版本容器 ${CONTAINER_NAME}-prev ..."
    docker rename "${CONTAINER_NAME}-prev" "${CONTAINER_NAME}"
    docker start "${CONTAINER_NAME}"
    echo "✅ 已自动回滚并恢复旧版 CoreFeed 容器运行。"
  fi
  exit 1
fi

if [ "${HAS_PREV_CONTAINER}" = "1" ]; then
  docker rm -f "${CONTAINER_NAME}-prev" 2>/dev/null || true
fi

if post_schedule_config; then
  echo "⏰ 已激活定时调度 (${ACTIVE_UPDATE_TIMES} ${ACTIVE_TIMEZONE}, enabled=${ACTIVE_AUTO_UPDATE})"
  if pull_github_snapshot; then
    echo "🔄 已从 GitHub 快照分支 (${AG_GITHUB_BRANCH}/manifest.json) 强制同步最新中文精编要闻"
  fi
else
  sync_settings_json "${REMOTE_DIR}/data/settings.json" "${ACTIVE_AUTO_UPDATE}" "${ACTIVE_UPDATE_TIMES}" "${ACTIVE_TIMEZONE}" "${DEFAULT_SNAPSHOT_URL}"
fi

SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
if [ -z "${SERVER_IP}" ]; then
  SERVER_IP=$(ip -4 route get 1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
fi

echo "========================================================"
echo "✅ CoreFeed v3.0 已完成秒级热更新并健康启动！"
docker ps --filter "name=${CONTAINER_NAME}"
echo "🌐 请在浏览器打开: http://${SERVER_IP:-<YOUR_SERVER_IP>}:${APP_PORT}"
echo "💡 后续更新只需执行: ssh root@${SERVER_IP:-<YOUR_SERVER_IP>} \"sh /opt/corefeed/deploy-router.sh\""
echo "========================================================"
