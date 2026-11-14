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
            shift 2
            ;;
        --hermes-home=*)
            HERMES_HOME_DIR="${1#*=}"
            DEST_SKILL_DIR="$HERMES_HOME_DIR/skills/corefeed-news"
            ENV_FILE="$HERMES_HOME_DIR/.env"
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

mkdir -p "$DEST_SKILL_DIR/scripts"
if [ -f "$SRC_SKILL_DIR/SKILL.md" ] && [ -f "$SRC_SKILL_DIR/scripts/corefeed_cli.py" ]; then
    cp "$SRC_SKILL_DIR/SKILL.md" "$DEST_SKILL_DIR/SKILL.md"
    cp "$SRC_SKILL_DIR/scripts/corefeed_cli.py" "$DEST_SKILL_DIR/scripts/corefeed_cli.py"
else
    download_file "$RAW_SKILL_BASE/SKILL.md" "$DEST_SKILL_DIR/SKILL.md"
    download_file "$RAW_SKILL_BASE/scripts/corefeed_cli.py" "$DEST_SKILL_DIR/scripts/corefeed_cli.py"
fi
chmod +x "$DEST_SKILL_DIR/scripts/corefeed_cli.py"

upsert_env_key() {
    key="$1"
    val="$2"
    [ -z "$val" ] && return 0
    mkdir -p "$(dirname "$ENV_FILE")"
    touch "$ENV_FILE"
    tmp_file="${ENV_FILE}.tmp.$$"
    awk -v k="$key" -v v="$val" '
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
    ' "$ENV_FILE" > "$tmp_file"
    mv "$tmp_file" "$ENV_FILE"
}

if [ -n "$COREFEED_URL_ARG" ]; then
    upsert_env_key "COREFEED_BASE_URL" "$COREFEED_URL_ARG"
fi

if [ -n "$XIAOAI_URL_ARG" ]; then
    upsert_env_key "OPENXIAOAI_BASE_URL" "$XIAOAI_URL_ARG"
fi

echo "✅ 已安装 Hermes 技能至: $DEST_SKILL_DIR"
if [ -n "$COREFEED_URL_ARG" ] || [ -n "$XIAOAI_URL_ARG" ]; then
    echo "✅ 已更新环境变量配置: $ENV_FILE"
fi

if [ "$SKIP_CHECK" -eq 0 ] && command -v python3 >/dev/null 2>&1; then
    echo "--- 连通性自检 ---"
    HERMES_HOME="$HERMES_HOME_DIR" python3 "$DEST_SKILL_DIR/scripts/corefeed_cli.py" status || true
fi
