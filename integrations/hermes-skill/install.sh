#!/usr/bin/env sh
# CoreFeed × Hermes Agent 技能一键安装脚本 (integrations/hermes-skill/install.sh)
# 用法:
#   sh integrations/hermes-skill/install.sh
#   sh integrations/hermes-skill/install.sh --corefeed-url http://192.168.1.2:3120 --xiaoai-url http://192.168.1.5:9092

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC_SKILL_DIR="$SCRIPT_DIR/corefeed-news"
HERMES_HOME_DIR="${HERMES_HOME:-$HOME/.hermes}"
DEST_SKILL_DIR="$HERMES_HOME_DIR/skills/corefeed-news"
ENV_FILE="$HERMES_HOME_DIR/.env"

COREFEED_URL_ARG=""
XIAOAI_URL_ARG=""
SKIP_CHECK=0
EXPLICIT_HERMES_HOME=0

while [ "$#" -gt 0 ]; do
    case "$1" in
        --corefeed-url)
            COREFEED_URL_ARG="$2"
            shift 2
            ;;
        --corefeed-url=*)
            COREFEED_URL_ARG="${1#*=}"
            shift 1
            ;;
        --xiaoai-url)
            XIAOAI_URL_ARG="$2"
            shift 2
            ;;
        --xiaoai-url=*)
            XIAOAI_URL_ARG="${1#*=}"
            shift 1
            ;;
        --hermes-home)
            HERMES_HOME_DIR="$2"
            DEST_SKILL_DIR="$HERMES_HOME_DIR/skills/corefeed-news"
            ENV_FILE="$HERMES_HOME_DIR/.env"
            EXPLICIT_HERMES_HOME=1
            shift 2
            ;;
        --hermes-home=*)
            HERMES_HOME_DIR="${1#*=}"
            DEST_SKILL_DIR="$HERMES_HOME_DIR/skills/corefeed-news"
            ENV_FILE="$HERMES_HOME_DIR/.env"
            EXPLICIT_HERMES_HOME=1
            shift 1
            ;;
        --skip-check)
            SKIP_CHECK=1
            shift 1
            ;;
        *)
            echo "未知参数: $1" >&2
            exit 1
            ;;
    esac
done

RAW_SKILL_BASE="${COREFEED_RAW_SKILL_BASE:-https://raw.githubusercontent.com/alanhsun/CoreFeed/main/integrations/hermes-skill/corefeed-news}"

download_file() {
    _url="$1"
    _dest="$2"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$_url" -o "$_dest"
    elif command -v wget >/dev/null 2>&1; then
        wget -qO "$_dest" "$_url"
    else
        echo "❌ 未找到本地技能文件且系统缺少 curl/wget，无法远程拉取: $_url" >&2
        exit 1
    fi
}

upsert_env_key_to_file() {
    _key="$1"
    _val="$2"
    _target_env="$3"
    [ -z "$_val" ] && return 0
    mkdir -p "$(dirname "$_target_env")"
    touch "$_target_env"
    _tmp_file="${_target_env}.tmp.$$"
    awk -v k="$_key" -v v="$_val" '
        BEGIN { found = 0 }
        $0 ~ "^[[:space:]]*(export[[:space:]]+)?" k "=" {
            print k "=\"" v "\""
            found = 1
            next
        }
        { print }
        END {
            if (!found) {
                print k "=\"" v "\""
            }
        }
    ' "$_target_env" > "$_tmp_file"
    mv "$_tmp_file" "$_target_env"
}

install_to_hermes_dir() {
    _target_home="$1"
    _target_skill_dir="$_target_home/skills/corefeed-news"
    _target_env_file="$_target_home/.env"
    mkdir -p "$_target_skill_dir/scripts"
    if [ "$DEST_SKILL_DIR" != "$_target_skill_dir" ]; then
        cp "$DEST_SKILL_DIR/SKILL.md" "$_target_skill_dir/SKILL.md"
        cp "$DEST_SKILL_DIR/scripts/corefeed_cli.py" "$_target_skill_dir/scripts/corefeed_cli.py"
        chmod +x "$_target_skill_dir/scripts/corefeed_cli.py"
    fi
    if [ -n "$COREFEED_URL_ARG" ]; then
        upsert_env_key_to_file "COREFEED_BASE_URL" "$COREFEED_URL_ARG" "$_target_env_file"
        upsert_env_key_to_file "COREFEED_BASE_URL" "$COREFEED_URL_ARG" "$_target_skill_dir/.env"
    fi
    if [ -n "$XIAOAI_URL_ARG" ]; then
        upsert_env_key_to_file "OPENXIAOAI_BASE_URL" "$XIAOAI_URL_ARG" "$_target_env_file"
        upsert_env_key_to_file "OPENXIAOAI_BASE_URL" "$XIAOAI_URL_ARG" "$_target_skill_dir/.env"
    fi
}

mkdir -p "$DEST_SKILL_DIR/scripts"
if [ -f "$SRC_SKILL_DIR/SKILL.md" ] && [ -f "$SRC_SKILL_DIR/scripts/corefeed_cli.py" ]; then
    cp "$SRC_SKILL_DIR/SKILL.md" "$DEST_SKILL_DIR/SKILL.md"
    cp "$SRC_SKILL_DIR/scripts/corefeed_cli.py" "$DEST_SKILL_DIR/scripts/corefeed_cli.py"
else
    download_file "$RAW_SKILL_BASE/SKILL.md" "$DEST_SKILL_DIR/SKILL.md"
    download_file "$RAW_SKILL_BASE/scripts/corefeed_cli.py" "$DEST_SKILL_DIR/scripts/corefeed_cli.py"
fi
chmod +x "$DEST_SKILL_DIR/scripts/corefeed_cli.py"

install_to_hermes_dir "$HERMES_HOME_DIR"

echo "✅ 已安装 Hermes 技能至: $DEST_SKILL_DIR"
if [ -n "$COREFEED_URL_ARG" ] || [ -n "$XIAOAI_URL_ARG" ]; then
    echo "✅ 已更新环境变量配置: $ENV_FILE"
fi

# 自动探测同机 Docker 运行的 Hermes 容器挂载目录并同步（如 /opt/hermes -> /opt/data 或 /.hermes）
if [ "$EXPLICIT_HERMES_HOME" -eq 0 ] && command -v docker >/dev/null 2>&1; then
    HERMES_CONTAINERS=$(docker ps --format '{{.Names}}|{{.Image}}' 2>/dev/null | awk -F'|' 'tolower($1) ~ /hermes/ || tolower($2) ~ /hermes/ { print $1 }' || true)
    for _cname in $HERMES_CONTAINERS; do
        [ -n "$_cname" ] || continue
        _mounts=$(docker inspect "$_cname" --format '{{range .Mounts}}{{println .Source "|" .Destination}}{{end}}' 2>/dev/null || true)
        _synced_mount=0
        if [ -n "$_mounts" ]; then
            while IFS='|' read -r _src _dst; do
                _src=$(printf '%s' "$_src" | sed 's/[[:space:]]*$//')
                _dst=$(printf '%s' "$_dst" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
                case "$_dst" in
                    */.hermes|/opt/data|/data/hermes)
                        if [ -n "$_src" ] && [ -d "$_src" ] && [ "$_src" != "$HERMES_HOME_DIR" ]; then
                            install_to_hermes_dir "$_src"
                            echo "✅ 检测到 Hermes 容器 ($_cname)，已同步技能至挂载目录: $_src"
                            _synced_mount=1
                        fi
                        ;;
                esac
            done <<EOF
$_mounts
EOF
        fi
        if [ "$_synced_mount" -eq 0 ]; then
            _c_home=$(docker exec "$_cname" sh -c 'printf "%s" "${HERMES_HOME:-$HOME/.hermes}"' 2>/dev/null || true)
            if [ -n "$_c_home" ]; then
                docker exec "$_cname" mkdir -p "$_c_home/skills" 2>/dev/null || true
                if docker cp "$DEST_SKILL_DIR" "$_cname:$_c_home/skills/" 2>/dev/null; then
                    echo "✅ 检测到 Hermes 容器 ($_cname)，已直接注入容器技能目录: $_c_home/skills/corefeed-news"
                fi
            fi
        fi
    done
fi

if [ "$SKIP_CHECK" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
    echo "--- 连通性自检 ---"
    HERMES_HOME="$HERMES_HOME_DIR" python3 "$DEST_SKILL_DIR/scripts/corefeed_cli.py" status || true
fi
