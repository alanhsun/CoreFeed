#!/usr/bin/env python3
"""
CoreFeed News & XiaoAI Voice Briefing CLI for Hermes Agent
零第三方依赖（仅使用 Python 3 标准库）：
  1. 优先直连局域网 CoreFeed 服务 (:3120)，不可达时自动回退至 GitHub ag-snapshot 分支精简快照；
  2. 支持按分类、地区、信源、关键词、单篇序号直接读取大模型已精编完成的中文新闻与深度综述（零重复抓取）；
  3. 对接 open-xiaoai-bridge (:9092) 实现口语化去噪、自然句切分、豆包/小爱原生 TTS 自动回退与阻塞式顺序播报。
"""

import argparse
import datetime
import ipaddress
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_GITHUB_SNAPSHOT_BASE = "https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot"
DEFAULT_SEGMENT_CHARS = 240
DEFAULT_ORAL_CHARS = 280

_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def is_local_or_lan_url(url):
    """判断是否为本机回环或局域网私有地址（直连绕过系统代理，避免 Clash/Mihomo 等代理拦截内网软路由与音箱请求）"""
    try:
        host = (urllib.parse.urlparse(url).hostname or "").strip().lower()
        if not host:
            return False
        if host in ("localhost", "host.docker.internal") or host.endswith((".local", ".lan", ".home", ".internal")):
            return True
        ip_obj = ipaddress.ip_address(host)
        return bool(ip_obj.is_loopback or ip_obj.is_private or ip_obj.is_link_local)
    except ValueError:
        return False


def open_url(req, timeout=6.0):
    target_url = req.full_url if isinstance(req, urllib.request.Request) else str(req)
    if is_local_or_lan_url(target_url):
        return _DIRECT_OPENER.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def load_dotenv_files():
    """按优先级加载本地环境变量文件（不覆盖已存在的系统环境变量）"""
    script_dir = Path(__file__).resolve().parent
    skill_dir = script_dir.parent
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    candidates = [
        skill_dir / ".env",
        hermes_home / ".env",
    ]
    for env_path in candidates:
        if not env_path.is_file():
            continue
        try:
            for raw_line in env_path.read_text(encoding="utf-8").splitlines():
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                if line.startswith("export "):
                    line = line[len("export "):].strip()
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = val
        except Exception:
            pass


def discover_openxiaoai_base_url(explicit_url=None):
    """自动探测 open-xiaoai-bridge HTTP API 地址"""
    if explicit_url and explicit_url.strip():
        return explicit_url.strip().rstrip("/")
    env_url = os.environ.get("OPENXIAOAI_BASE_URL", "").strip()
    if env_url:
        return env_url.rstrip("/")

    # 尝试从已安装的 xiaoai-tts skill 脚本中读取默认地址
    hermes_home = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes"))
    api_client_candidates = [
        hermes_home / "skills" / "xiaoai-tts" / "scripts" / "api_client.py",
        Path.home() / ".openclaw" / "skills" / "xiaoai-tts" / "scripts" / "api_client.py",
    ]
    for candidate in api_client_candidates:
        if candidate.is_file():
            try:
                content = candidate.read_text(encoding="utf-8")
                match = re.search(r'OPENXIAOAI_BASE_URL"\s*,\s*"(https?://[^"]+)"', content)
                if match:
                    return match.group(1).strip().rstrip("/")
            except Exception:
                pass

    return "http://127.0.0.1:9092"


def discover_corefeed_lan_candidates(explicit_url=None):
    """生成待尝试的局域网 CoreFeed 服务地址列表"""
    if explicit_url and explicit_url.strip():
        return [explicit_url.strip().rstrip("/")]
    env_url = (
        os.environ.get("COREFEED_BASE_URL", "").strip()
        or os.environ.get("COREFEED_SITE_URL", "").strip()
        or os.environ.get("COREFEED_URL", "").strip()
    )
    if env_url:
        return [env_url.rstrip("/")]
    return ["http://127.0.0.1:3120"]


def http_json(url, method="GET", payload=None, timeout=6.0):
    """发送 HTTP 请求并解析 JSON"""
    headers = {
        "Accept": "application/json",
        "User-Agent": "CoreFeed-Hermes-Skill/2.0",
    }
    data_bytes = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(url, data=data_bytes, headers=headers, method=method)
    with open_url(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
        return json.loads(raw)


def extract_spoken_source(raw_source):
    """提取适合语音播报的中文信源简称"""
    raw = raw_source if isinstance(raw_source, str) else str((raw_source or {}).get("name") or "")
    raw = raw.strip()
    if not raw:
        return "外媒"
    m = re.search(r"[（(]([^）)]*[\u4e00-\u9fff][^）)]*)[）)]", raw)
    if m:
        return m.group(1).strip()
    stripped = re.sub(r"\s*[（(][^）)]*[）)]\s*", "", raw).strip()
    return stripped or raw


def clean_inline_tts(text):
    if not text:
        return ""
    s = str(text)
    s = re.sub(r"\[NEWS_\d+\]", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\[([^\]]+)\]\((?:https?://|/)[^)]+\)", r"\1", s)
    s = re.sub(r"https?://\S+", "", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"[*_~#]+", "", s)
    s = re.sub(r"\s*\([A-Za-z0-9\s.&'-]+\)", "", s)
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"([。！？；，、])\1+", r"\1", s)
    s = re.sub(r"\s+([。！？；，、：])", r"\1", s)
    return s.strip()


def clean_text_for_tts(raw_text):
    if not raw_text:
        return ""
    out = []
    for raw_line in str(raw_text).replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        md_h = re.match(r"^#{1,6}\s+(.+)$", line)
        if md_h:
            h = clean_inline_tts(md_h.group(1))
            if h:
                out.append(h if re.search(r"[。！？：:]$", h) else f"{h}：")
            continue
        br_h = re.match(r"^【(.+?)】$", line)
        if br_h:
            h = clean_inline_tts(br_h.group(1))
            if h:
                out.append(h if re.search(r"[。！？：:]$", h) else f"{h}：")
            continue
        line = re.sub(r"^[-*•]+\s+", "", line)
        line = clean_inline_tts(line)
        if not line:
            continue
        if not re.search(r"[。！？；：.!?;:]$", line):
            line += "。"
        out.append(line)
    return "\n".join(out)


def split_tts_segments(raw_text, max_chars=DEFAULT_SEGMENT_CHARS):
    limit = max(80, min(800, int(max_chars or DEFAULT_SEGMENT_CHARS)))
    cleaned = clean_text_for_tts(raw_text)
    if not cleaned:
        return []

    atomic = []
    for para in re.split(r"\n+", cleaned):
        para = para.strip()
        if not para:
            continue
        sentences = re.findall(r"[^。！？；!?;\n]+[。！？；!?;]?", para) or [para]
        for s in sentences:
            unit = s.strip()
            if not unit:
                continue
            if len(unit) <= limit:
                atomic.append(unit)
            else:
                clauses = re.findall(r"[^，、,]+[，、,]?", unit) or [unit]
                buf = ""
                for c in clauses:
                    if len(buf) + len(c) <= limit:
                        buf += c
                    else:
                        if buf.strip():
                            atomic.append(buf.strip())
                        if len(c) <= limit:
                            buf = c
                        else:
                            for pos in range(0, len(c), limit):
                                atomic.append(c[pos:pos + limit])
                            buf = ""
                if buf.strip():
                    atomic.append(buf.strip())

    segments = []
    current = ""
    for unit in atomic:
        if not current:
            current = unit
        elif len(current) + len(unit) <= limit:
            current += unit
        else:
            segments.append(current.strip())
            current = unit
    if current.strip():
        segments.append(current.strip())
    return segments


def format_beijing_time(iso_str):
    if not iso_str:
        return ("未知时间", "")
    try:
        s = str(iso_str).strip()
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        dt = datetime.datetime.fromisoformat(s)
        bj_tz = datetime.timezone(datetime.timedelta(hours=8))
        bj = dt.astimezone(bj_tz)
        display = bj.strftime("%Y-%m-%d %H:%M (北京时间)")
        minute_spoken = "整" if bj.minute == 0 else f"{bj.minute}分"
        spoken = f"{bj.month}月{bj.day}日{bj.hour}点{minute_spoken}"
        return (display, spoken)
    except Exception:
        return (str(iso_str), "")


def build_briefing_locally(raw_items, raw_summary, last_updated, published_by, args):
    """当回退读取旧版服务端接口或 GitHub 静态快照时，在本地执行统一的筛选、Markdown 排版与口播分段"""
    region = (args.region or "").strip()
    category = (args.category or "").strip()
    source = (args.source or "").strip()
    keyword = (args.keyword or "").strip()
    kw_lower = keyword.lower()
    index_ref = str(args.index).strip() if getattr(args, "index", None) else ""

    mode = (args.mode or "").strip().lower()
    if mode not in ("mixed", "headlines", "summary", "article"):
        if index_ref:
            mode = "article"
        elif region or category or source or keyword:
            mode = "headlines"
        else:
            mode = "mixed"

    indexed = list(enumerate(raw_items or [], start=1))
    matched = indexed

    if mode == "article" and index_ref:
        if index_ref.isdigit():
            idx_num = int(index_ref)
            matched = [indexed[idx_num - 1]] if 1 <= idx_num <= len(indexed) else []
        else:
            matched = [(i, it) for (i, it) in indexed if str(it.get("id") or "") == index_ref]
    else:
        if region and region not in ("all", "全部"):
            matched = [(i, it) for (i, it) in matched if region in str(it.get("region") or "")]
        if category and category not in ("all", "全部"):
            matched = [(i, it) for (i, it) in matched if category in str(it.get("category") or "")]
        if source and source not in ("all", "全部"):
            src_low = source.lower()
            matched = [
                (i, it)
                for (i, it) in matched
                if src_low in (
                    it.get("source")
                    if isinstance(it.get("source"), str)
                    else str((it.get("source") or {}).get("name") or "")
                ).lower()
            ]
        if kw_lower:
            def _hit(it):
                src_str = it.get("source") if isinstance(it.get("source"), str) else str((it.get("source") or {}).get("name") or "")
                parts = [
                    it.get("translatedTitle"),
                    it.get("title"),
                    it.get("summary"),
                    it.get("description"),
                    src_str,
                    *(it.get("keyPoints") or []),
                    *(it.get("translatedParagraphs") or it.get("paragraphs") or []),
                ]
                return kw_lower in " ".join(str(p) for p in parts if p).lower()
            matched = [(i, it) for (i, it) in matched if _hit(it)]

    limit = 1 if mode == "article" else max(1, min(50, int(args.limit or 8)))
    sliced = []
    for idx_num, raw in matched[:limit]:
        src_name = raw.get("source") if isinstance(raw.get("source"), str) else str((raw.get("source") or {}).get("name") or "Global Media")
        paragraphs = raw.get("paragraphs") or raw.get("translatedParagraphs") or []
        item_obj = {
            "index": idx_num,
            "id": str(raw.get("id") or raw.get("url") or f"item-{idx_num}"),
            "title": str(raw.get("translatedTitle") or raw.get("title") or "").strip(),
            "originalTitle": str(raw.get("originalTitle") or raw.get("title") or "").strip(),
            "summary": str(raw.get("summary") or raw.get("translatedDescription") or raw.get("description") or "").strip(),
            "keyPoints": [str(k).strip() for k in (raw.get("keyPoints") or []) if str(k).strip()],
            "region": str(raw.get("region") or "国际").strip(),
            "category": str(raw.get("category") or "国际").strip(),
            "source": src_name.strip(),
            "spokenSource": raw.get("spokenSource") or extract_spoken_source(src_name),
            "sourceCount": int(raw.get("sourceCount") or (1 + len(raw.get("relatedSources") or []))),
            "url": str(raw.get("url") or "").strip(),
            "publishedAt": raw.get("publishedAt"),
            "paragraphs": [str(p).strip() for p in paragraphs if str(p).strip()],
        }
        sliced.append(item_obj)

    overview_md = ""
    overview_title = "全球要闻深度综述"
    if isinstance(raw_summary, dict):
        overview_md = str(raw_summary.get("markdown") or raw_summary.get("content") or "").strip()
        overview_title = str(raw_summary.get("title") or overview_title).strip()
    overview_plain = clean_text_for_tts(overview_md) if overview_md else ""
    overview_available = bool(overview_md)

    display_time, spoken_time = format_beijing_time(last_updated)
    seg_chars = int(getattr(args, "segment_chars", DEFAULT_SEGMENT_CHARS) or DEFAULT_SEGMENT_CHARS)
    oral_chars = int(getattr(args, "max_chars", DEFAULT_ORAL_CHARS) or DEFAULT_ORAL_CHARS)

    # 组装口播全文
    if mode == "article":
        if not sliced:
            full_tts = "未找到指定序号或编号的新闻报道。"
        else:
            art = sliced[0]
            body = clean_text_for_tts("\n".join(art["paragraphs"])) if art["paragraphs"] else clean_text_for_tts(art["summary"])
            full_tts = f"{art['spokenSource']}报道：{clean_inline_tts(art['title'])}。\n{body}"
    elif mode == "summary" and overview_available:
        intro = f"为您播报聚核全球要闻深度综述，更新于{spoken_time}。" if spoken_time else "为您播报聚核全球要闻深度综述。"
        full_tts = f"{intro}\n{overview_plain}\n以上就是今日全球要闻综述。"
    elif not sliced:
        full_tts = overview_plain if overview_available else "当前暂无符合筛选条件的精编新闻。"
    else:
        scope = "".join([p for p in [region, category, source, f"关于{keyword}的" if keyword else ""] if p]) or "全球"
        intro = (
            f"为您播报聚核最新{scope}要闻简报，更新于{spoken_time}，共{len(sliced)}条重点消息。"
            if spoken_time
            else f"为您播报聚核最新{scope}要闻简报，共{len(sliced)}条重点消息。"
        )
        tts_lines = [intro]
        for pos, it in enumerate(sliced, start=1):
            t_clean = clean_inline_tts(it["title"])
            s_clean = clean_inline_tts(it["summary"])
            body = f"{t_clean}。{s_clean}" if s_clean and not s_clean.startswith(t_clean) else (s_clean or f"{t_clean}。")
            if not re.search(r"[。！？]$", body):
                body += "。"
            tts_lines.append(f"第{pos}条，据{it['spokenSource']}消息，{body}")
        tts_lines.append("以上就是本次新闻播报。")
        full_tts = "\n".join(tts_lines)

    segments = split_tts_segments(full_tts, seg_chars)

    # 组装短口语回复 (<= oral_chars)
    prefix = f"聚核要闻简报，更新于{spoken_time}：" if spoken_time else "为您播报最新聚核要闻："
    if sliced:
        short_buf = prefix
        added = 0
        for idx_s, it in enumerate(sliced[:5], start=1):
            entry = f"第{idx_s}条，{clean_inline_tts(it['title'])}。"
            if len(short_buf) + len(entry) <= oral_chars - 12:
                short_buf += entry
                added += 1
            else:
                break
        if added == 0:
            short_buf = f"{prefix}{clean_inline_tts(sliced[0]['title'])}。"[:oral_chars]
        elif len(sliced) > added and len(short_buf) + 12 <= oral_chars:
            short_buf += "其余要闻可继续追问。"
        short_text = short_buf
    elif overview_plain:
        short_text = f"{prefix}{overview_plain}"[:oral_chars]
    else:
        short_text = "当前暂无符合条件的精编新闻数据。"

    # 组装 Markdown
    md_lines = []
    if mode == "article" and sliced:
        art = sliced[0]
        md_lines.append(f"# {art['title']}")
        md_lines.append(f"> 更新时间：{display_time} ｜ 信源：{art['source']} ｜ 分类：{art['region']}·{art['category']}")
        if art["url"]:
            md_lines.append(f"- **原文链接**：{art['url']}")
        md_lines.append("")
        if art["summary"]:
            md_lines.extend(["## 核心导语", art["summary"], ""])
        if art["keyPoints"]:
            md_lines.append("## 核心看点")
            md_lines.extend([f"- {kp}" for kp in art["keyPoints"]])
            md_lines.append("")
        if art["paragraphs"]:
            md_lines.append("## 全文精译")
            for p in art["paragraphs"]:
                md_lines.extend([p, ""])
    else:
        md_lines.append("# CoreFeed · 全球要闻精编简报")
        md_lines.append(f"> 更新时间：{display_time} ｜ 精选条目：{len(sliced)} / {len(matched)} 条")
        md_lines.append("")
        has_filter = bool(region or category or source or keyword)
        if overview_available and (mode == "summary" or (mode == "mixed" and not has_filter)):
            md_lines.extend([f"## {overview_title}", "", re.sub(r"\s*\[NEWS_(\d+)\]", r" [#\1]", overview_md), ""])
        if mode != "summary":
            md_lines.extend(["## 精选要闻列表", ""])
            if not sliced:
                md_lines.append("暂无匹配的精编新闻条目。")
            for it in sliced:
                md_lines.append(f"### {it['index']}. [{it['category']}/{it['region']}] {it['title']}")
                md_lines.append(f"- **信源**：{it['source']}")
                if it["summary"]:
                    md_lines.append(f"- **导语**：{it['summary']}")
                if it["keyPoints"]:
                    md_lines.append(f"- **看点**：{'；'.join(it['keyPoints'])}")
                if it["url"]:
                    md_lines.append(f"- **链接**：{it['url']}")
                md_lines.append("")

    return {
        "success": True,
        "lastUpdated": last_updated,
        "lastUpdatedDisplay": display_time,
        "publishedBy": published_by,
        "totalAvailable": len(raw_items or []),
        "matchedCount": len(matched),
        "returnedCount": len(sliced),
        "items": sliced,
        "markdown": "\n".join(md_lines).strip() + "\n",
        "tts": {
            "mode": mode,
            "maxSegmentChars": seg_chars,
            "segmentCount": len(segments),
            "shortText": short_text,
            "fullText": full_tts,
            "segments": segments,
        },
    }


def fetch_briefing_with_failover(args):
    """
    多级零延迟读取瀑布流：
      1. 优先直连局域网 CoreFeed 服务端 /api/ai/briefing（若旧版容器尚未升级则平滑回退读取 /api/news + /api/summary）
      2. 若局域网不可达，自动回退拉取 GitHub ag-snapshot 分支上的 briefing.json（或 latest.json）
    """
    errors = []
    lan_urls = [] if getattr(args, "github_only", False) else discover_corefeed_lan_candidates(args.corefeed_url)

    query_params = {}
    if getattr(args, "limit", None):
        query_params["limit"] = str(args.limit)
    if getattr(args, "region", None):
        query_params["region"] = args.region
    if getattr(args, "category", None):
        query_params["category"] = args.category
    if getattr(args, "source", None):
        query_params["source"] = args.source
    if getattr(args, "keyword", None):
        query_params["q"] = args.keyword
    if getattr(args, "mode", None):
        query_params["mode"] = args.mode
    if getattr(args, "index", None):
        query_params["index"] = str(args.index)
        query_params["mode"] = "article"
        query_params["detail"] = "full"
    if getattr(args, "segment_chars", None):
        query_params["maxSegmentChars"] = str(args.segment_chars)
    if getattr(args, "max_chars", None):
        query_params["oralMaxChars"] = str(args.max_chars)

    qs = urllib.parse.urlencode(query_params)

    for base in lan_urls:
        ai_url = f"{base}/api/ai/briefing" + (f"?{qs}" if qs else "")
        try:
            data = http_json(ai_url, timeout=3.5)
            if isinstance(data, dict) and data.get("success") and "tts" in data:
                data["_dataSource"] = f"lan:{base}/api/ai/briefing"
                return data
        except urllib.error.HTTPError as he:
            if he.code == 404 and not getattr(args, "index", None):
                # 兼容尚未热更新 /api/ai/briefing 的旧版局域网容器
                try:
                    news_resp = http_json(f"{base}/api/news", timeout=3.5)
                    sum_resp = http_json(f"{base}/api/summary", timeout=3.5)
                    built = build_briefing_locally(
                        news_resp.get("news") or [],
                        sum_resp.get("article"),
                        news_resp.get("lastUpdated"),
                        news_resp.get("lastPublishedBy"),
                        args,
                    )
                    built["_dataSource"] = f"lan-legacy:{base}/api/news"
                    return built
                except Exception as leg_err:
                    errors.append(f"{base} (legacy): {leg_err}")
            elif he.code == 404 and getattr(args, "index", None):
                raise RuntimeError(f"未找到第 {args.index} 条精编新闻")
            else:
                errors.append(f"{ai_url}: HTTP {he.code}")
        except Exception as exc:
            errors.append(f"{ai_url}: {exc}")

    # 回退至 GitHub ag-snapshot 分支
    gh_base = (
        getattr(args, "github_base", None)
        or os.environ.get("COREFEED_GITHUB_SNAPSHOT_BASE", "").strip()
        or DEFAULT_GITHUB_SNAPSHOT_BASE
    ).rstrip("/")

    for filename in ("briefing.json", "latest.json"):
        gh_url = f"{gh_base}/{filename}"
        try:
            snap = http_json(gh_url, timeout=10.0)
            items = snap.get("items") if filename == "briefing.json" else (snap.get("news") or snap.get("articles") or [])
            summary_obj = snap.get("overview") if filename == "briefing.json" else (snap.get("summaryArticle") or snap.get("summary"))
            built = build_briefing_locally(
                items,
                summary_obj,
                snap.get("lastUpdated") or snap.get("publishedAt"),
                snap.get("publishedBy") or snap.get("clientId"),
                args,
            )
            built["_dataSource"] = f"github:{gh_url}"
            return built
        except Exception as exc:
            errors.append(f"{gh_url}: {exc}")

    raise RuntimeError("无法从局域网 CoreFeed 或 GitHub 快照读取新闻数据：\n  - " + "\n  - ".join(errors))


def wait_until_speaker_idle(xiaoai_base, max_wait_sec=90.0):
    """轮询 open-xiaoai-bridge /api/status 确保上一段音频播放完毕再发下一段"""
    deadline = time.time() + max_wait_sec
    while time.time() < deadline:
        try:
            st = http_json(f"{xiaoai_base}/api/status", timeout=4.0)
            status_val = ((st or {}).get("data") or {}).get("status", "idle")
            if status_val != "playing":
                return status_val
        except Exception:
            return "unknown"
        time.sleep(0.4)
    return "timeout"


def play_single_segment(xiaoai_base, text, engine="auto", speaker=None, speed=1.0, emotion=None):
    """向 open-xiaoai-bridge 发送单段阻塞式 TTS 请求（支持豆包优先、失败自动回退小爱原生 TTS）"""
    if engine in ("auto", "doubao"):
        doubao_payload = {
            "text": text,
            "speed": float(speed),
            "blocking": True,
        }
        if speaker:
            doubao_payload["speaker_id"] = speaker
        if emotion:
            doubao_payload["emotion"] = emotion
        try:
            res = http_json(
                f"{xiaoai_base}/api/tts/doubao",
                method="POST",
                payload=doubao_payload,
                timeout=120.0,
            )
            if isinstance(res, dict) and res.get("success") is True:
                return ("doubao", True, None)
            if isinstance(res, dict) and res.get("success") is False and not res.get("error"):
                # 阻塞播放返回 success=False 通常表示被用户语音唤醒“小爱同学”主动打断
                return ("doubao", False, "interrupted")
            if engine == "doubao":
                return ("doubao", False, str(res))
        except Exception as exc:
            if engine == "doubao":
                return ("doubao", False, str(exc))

    # 回退或直接调用小爱原生 TTS (/api/play/text)
    native_payload = {
        "text": text,
        "blocking": True,
        "timeout": 120000,
    }
    res = http_json(
        f"{xiaoai_base}/api/play/text",
        method="POST",
        payload=native_payload,
        timeout=125.0,
    )
    if isinstance(res, dict) and res.get("success") is True:
        return ("xiaoai", True, None)
    if isinstance(res, dict) and res.get("success") is False and not res.get("error"):
        return ("xiaoai", False, "interrupted")
    return ("xiaoai", False, str(res))


def cmd_query(args):
    data = fetch_briefing_with_failover(args)
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
        return 0
    if args.oral:
        print(data["tts"]["shortText"])
        return 0
    print(data["markdown"], end="")
    return 0


def cmd_speak(args):
    if not args.limit:
        args.limit = 5
    data = fetch_briefing_with_failover(args)
    segments = (data.get("tts") or {}).get("segments") or []
    if not segments:
        print("当前没有可播报的精编新闻内容。")
        return 1

    xiaoai_base = discover_openxiaoai_base_url(args.xiaoai_url)

    if args.dry_run:
        print(f"[Dry-Run] 数据源: {data.get('_dataSource')} | 目标音箱桥接: {xiaoai_base} | 共 {len(segments)} 段：")
        for idx, seg in enumerate(segments, start=1):
            print(f"  [{idx}/{len(segments)}] ({len(seg)}字) {seg}")
        return 0

    engine = (args.engine or os.environ.get("COREFEED_TTS_ENGINE", "auto")).strip().lower()
    speaker = (args.speaker or os.environ.get("COREFEED_TTS_SPEAKER", "")).strip() or None
    speed = float(args.speed if args.speed is not None else os.environ.get("COREFEED_TTS_SPEED", "1.0"))
    emotion = (args.emotion or os.environ.get("COREFEED_TTS_EMOTION", "")).strip() or None

    used_engine = engine
    played_count = 0
    for idx, seg in enumerate(segments, start=1):
        used_engine, ok, err_reason = play_single_segment(
            xiaoai_base=xiaoai_base,
            text=seg,
            engine=engine,
            speaker=speaker,
            speed=speed,
            emotion=emotion,
        )
        if not ok:
            if err_reason == "interrupted":
                print(f"⏹️ 小爱音箱播报在第 {idx}/{len(segments)} 段被语音打断。")
                break
            print(f"❌ 第 {idx}/{len(segments)} 段播报失败 ({used_engine}): {err_reason}", file=sys.stderr)
            return 1
        played_count += 1
        if idx < len(segments):
            wait_until_speaker_idle(xiaoai_base, max_wait_sec=60.0)

    print(
        f"🔊 已通过小爱音箱 ({xiaoai_base}, 引擎={used_engine}) 播报 {played_count}/{len(segments)} 段新闻简报"
        f"（数据源: {data.get('_dataSource')}）。\n"
    )
    print(data["markdown"], end="")
    return 0


def cmd_stop(args):
    xiaoai_base = discover_openxiaoai_base_url(args.xiaoai_url)
    res = http_json(f"{xiaoai_base}/api/interrupt", method="POST", payload={}, timeout=6.0)
    if isinstance(res, dict) and res.get("success"):
        print(f"⏹️ 已通知小爱音箱 ({xiaoai_base}) 停止当前新闻播报。")
        return 0
    print(f"⚠️ 打断返回异常: {res}", file=sys.stderr)
    return 1


def cmd_status(args):
    lan_candidates = discover_corefeed_lan_candidates(args.corefeed_url)
    xiaoai_base = discover_openxiaoai_base_url(args.xiaoai_url)
    report = {
        "corefeedLan": {"url": lan_candidates[0], "reachable": False},
        "corefeedGithubFallback": {"url": f"{DEFAULT_GITHUB_SNAPSHOT_BASE}/latest.json", "reachable": False},
        "openXiaoAiBridge": {"url": xiaoai_base, "reachable": False, "speakerReady": False},
    }

    try:
        st = http_json(f"{lan_candidates[0]}/api/status", timeout=3.0)
        report["corefeedLan"].update({
            "reachable": True,
            "newsCount": st.get("newsCount"),
            "lastUpdated": st.get("lastUpdated"),
            "hasSummary": st.get("hasSummary"),
        })
    except Exception as exc:
        report["corefeedLan"]["error"] = str(exc)

    gh_base = (getattr(args, "github_base", None) or os.environ.get("COREFEED_GITHUB_SNAPSHOT_BASE") or DEFAULT_GITHUB_SNAPSHOT_BASE).rstrip("/")
    for fn in ("briefing.json", "latest.json"):
        test_url = f"{gh_base}/{fn}"
        try:
            req = urllib.request.Request(test_url, method="HEAD", headers={"User-Agent": "CoreFeed-Hermes-Skill/2.0"})
            with open_url(req, timeout=6.0) as resp:
                if 200 <= resp.status < 400:
                    report["corefeedGithubFallback"] = {"url": test_url, "reachable": True}
                    break
        except Exception as exc:
            report["corefeedGithubFallback"] = {"url": test_url, "reachable": False, "error": str(exc)}

    try:
        xh = http_json(f"{xiaoai_base}/api/health", timeout=3.0)
        xdata = (xh or {}).get("data") or {}
        report["openXiaoAiBridge"].update({
            "reachable": bool(xh.get("success")),
            "status": xdata.get("status"),
            "speakerReady": bool(xdata.get("speaker_ready")),
        })
    except Exception as exc:
        report["openXiaoAiBridge"]["error"] = str(exc)

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        lan_ok = "✅ 已连通" if report["corefeedLan"]["reachable"] else "⚠️ 未连通 (将自动回退 GitHub 快照)"
        gh_ok = "✅ 可用" if report["corefeedGithubFallback"]["reachable"] else "❌ 不可达"
        xa_ok = (
            "✅ 在线且音箱就绪"
            if report["openXiaoAiBridge"]["reachable"] and report["openXiaoAiBridge"]["speakerReady"]
            else ("⚠️ 服务在线但音箱未就绪" if report["openXiaoAiBridge"]["reachable"] else "❌ 未连通")
        )
        print(f"CoreFeed 局域网接口 ({report['corefeedLan']['url']}): {lan_ok}")
        print(f"CoreFeed GitHub 快照回退 ({report['corefeedGithubFallback']['url']}): {gh_ok}")
        print(f"Open-XiaoAI Bridge ({report['openXiaoAiBridge']['url']}): {xa_ok}")
    return 0


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--corefeed-url", default=None, help="CoreFeed 局域网地址，例如 http://192.168.1.2:3120")
    common.add_argument("--github-base", default=None, help="GitHub 快照 Raw 基础目录 URL")
    common.add_argument("--github-only", action="store_true", help="跳过局域网探测，直接读取 GitHub 快照")
    common.add_argument("--xiaoai-url", default=None, help="open-xiaoai-bridge HTTP 地址，例如 http://192.168.1.5:9092")

    filter_opts = argparse.ArgumentParser(add_help=False)
    filter_opts.add_argument("--limit", "-n", type=int, default=None, help="返回或播报的新闻条数")
    filter_opts.add_argument("--category", "-c", default=None, help="按领域筛选：政经/外交/科技/财经/军事/社会/能源/国际")
    filter_opts.add_argument("--region", "-r", default=None, help="按地区筛选：中国/美国/欧洲/日本/韩国/东南亚/中东/国际等")
    filter_opts.add_argument("--source", default=None, help="按媒体名称筛选，如 路透社 / BBC / FT")
    filter_opts.add_argument("--keyword", "-q", default=None, help="按关键词搜索标题、导语、要点或译文")
    filter_opts.add_argument(
        "--mode",
        choices=["mixed", "headlines", "summary", "article"],
        default=None,
        help="输出模式：mixed(综述+要闻) / headlines(仅要闻列表) / summary(仅全球综述) / article(单篇全文)",
    )
    filter_opts.add_argument("--index", "-i", default=None, help="读取或朗读第 N 条新闻的完整中文译文（1-based 序号或文章 ID）")
    filter_opts.add_argument("--segment-chars", type=int, default=DEFAULT_SEGMENT_CHARS, help="语音分段单段最大字数（默认 240）")

    parser = argparse.ArgumentParser(description="CoreFeed 全球要闻直读与小爱音箱语音播报工具 (Hermes Skill CLI)")
    sub = parser.add_subparsers(dest="subcommand", required=True)

    p_query = sub.add_parser("query", parents=[common, filter_opts], help="查询已精编完成的新闻摘要（不触发音箱播放）")
    p_query.add_argument("--oral", action="store_true", help="输出单段纯口语短文本（供 open-xiaoai-bridge 自动 TTS 回复模式直接朗读）")
    p_query.add_argument("--max-chars", type=int, default=DEFAULT_ORAL_CHARS, help="--oral 模式最大字数（默认 280）")
    p_query.add_argument("--json", action="store_true", help="输出原始结构化 JSON")

    p_speak = sub.add_parser("speak", parents=[common, filter_opts], help="生成口语化短稿并通过 open-xiaoai-bridge 分段语音播报")
    p_speak.add_argument("--engine", choices=["auto", "doubao", "xiaoai"], default=None, help="TTS 引擎：auto(默认豆包优先回退小爱) / doubao / xiaoai")
    p_speak.add_argument("--speaker", "-s", default=None, help="豆包 TTS 音色 ID（如 zh_female_vv_uranus_bigtts 或 S_xxx）")
    p_speak.add_argument("--speed", type=float, default=None, help="豆包 TTS 语速 (0.8-2.0)")
    p_speak.add_argument("--emotion", "-e", default=None, help="豆包 1.0 多情感音色情感参数（如 news）")
    p_speak.add_argument("--dry-run", action="store_true", help="仅打印口播分段预览，不实际发送音箱请求")

    sub.add_parser("stop", parents=[common], help="立即打断小爱音箱当前的新闻朗读")

    p_status = sub.add_parser("status", parents=[common], help="检查 CoreFeed 与 open-xiaoai-bridge 连通状态")
    p_status.add_argument("--json", action="store_true", help="输出 JSON 格式诊断结果")

    return parser


def main(argv=None):
    load_dotenv_files()
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.subcommand == "query":
            return cmd_query(args)
        if args.subcommand == "speak":
            return cmd_speak(args)
        if args.subcommand == "stop":
            return cmd_stop(args)
        if args.subcommand == "status":
            return cmd_status(args)
        return 1
    except Exception as exc:
        print(f"❌ CoreFeed 执行失败: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
