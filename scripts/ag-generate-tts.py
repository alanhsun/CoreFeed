#!/usr/bin/env python3
"""
CoreFeed v2.0 — Qwen3-TTS 1.7B Dual-Anchor Broadcast Script Builder, Colab Synthesizer & Studio Stitcher.

Generates broadcast-grade Mandarin dual-anchor radio programs (`Lin_Yuan` via VoiceDesign->Base ICL + `Serena` via CustomVoice) via `qwen3-tts-colab`:
  - `news`  : Opening (Serena) -> Global Summary Commentary (Lin_Yuan) -> Top 10 Curated News (Serena)
  - `pulse` : Opening (Serena) -> Transatlantic Overview & Contrasts (Lin_Yuan) -> US & EU Top Social Clashes (Serena)
  - `both`  : Synthesizes both `news` and `pulse` in ONE single Google Colab L4 batch, stitches MP3s,
              updates `CoreFeed/data/audio_broadcast.json`, and enforces 0.0 CU/hr Colab auto-stop.
"""
from __future__ import annotations

import argparse
import datetime as dt
import glob
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from typing import Any
import wave
from zoneinfo import ZoneInfo

try:
    import numpy as np
except ImportError:
    np = None  # type: ignore[assignment]

COREFEED_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = COREFEED_ROOT / "data"
AUDIO_DIR = DATA_DIR / "audio"
AUDIO_BROADCAST_JSON = DATA_DIR / "audio_broadcast.json"
VOICES_DIR = COREFEED_ROOT / "config" / "voices"
MALE_ANCHOR_ID = "Lin_Yuan"
MALE_ANCHOR_NAME = "林远"
MALE_ANCHOR_WAV = VOICES_DIR / "anchor_male_news.wav"
MALE_ANCHOR_META_JSON = VOICES_DIR / "anchor_male_news.json"
DEFAULT_MALE_ANCHOR_INSTRUCT = (
    "35岁标准普通话男性新闻主播，音色干净沉稳、中频清亮不浑浊，吐字字正腔圆，"
    "情绪高度克制客观，语速均匀流畅，绝不夸张拿腔，像财经新闻联播演播室播音。"
)

def _resolve_snapshot_raw_base() -> str:
    explicit = os.environ.get("COREFEED_SNAPSHOT_RAW_BASE", "").strip()
    if explicit:
        return explicit.rstrip("/")
    snap_url = os.environ.get("GITHUB_SNAPSHOT_URL", "").strip()
    if snap_url:
        cleaned = snap_url.split("?", 1)[0].rstrip("/")
        for suffix in ("/manifest.json", "/news.json", "/latest.json"):
            if cleaned.endswith(suffix):
                return cleaned[: -len(suffix)]
    repo = os.environ.get("COREFEED_REPO", "alanhsun/CoreFeed").strip().strip("/") or "alanhsun/CoreFeed"
    branch = os.environ.get("AG_GITHUB_BRANCH", "ag-snapshot").strip() or "ag-snapshot"
    return f"https://raw.githubusercontent.com/{repo}/{branch}"


def _resolve_colab_repo_root() -> Path:
    env_root = os.environ.get("QWEN3_COLAB_ROOT", "").strip()
    if env_root:
        return Path(env_root).expanduser()
    return Path.home() / "Documents" / "antigravity" / "Google_Colab"


def _resolve_skill_job_runner() -> Path:
    env_runner = os.environ.get("QWEN3_JOB_RUNNER", "").strip()
    if env_runner:
        return Path(env_runner).expanduser()
    return Path.home() / ".gemini" / "config" / "skills" / "qwen3-tts-colab" / "scripts" / "run_qwen3_tts_colab_job.py"


COLAB_REPO_ROOT = _resolve_colab_repo_root()
DEPLOY_COLAB_SCRIPT = COLAB_REPO_ROOT / "qwen3_tts_colab" / "scripts" / "deploy_colab.py"
SKILL_JOB_RUNNER = _resolve_skill_job_runner()

RAW_SNAPSHOT_BASE = _resolve_snapshot_raw_base()

CN_NUMS = {
    1: "第一",
    2: "第二",
    3: "第三",
    4: "第四",
    5: "第五",
    6: "第六",
    7: "第七",
    8: "第八",
    9: "第九",
    10: "第十",
}

COUNTRY_LABELS = {
    "US": "美国",
    "UK": "英国",
    "GB": "英国",
    "DE": "德国",
    "FR": "法国",
    "ES": "西班牙",
    "IT": "意大利",
    "NL": "荷兰",
    "PL": "波兰",
    "SE": "瑞典",
    "PT": "葡萄牙",
    "IE": "爱尔兰",
    "UA": "乌克兰",
    "CH": "瑞士",
    "AT": "奥地利",
    "BE": "比利时",
    "GR": "希腊",
    "HU": "匈牙利",
    "CZ": "捷克",
    "DK": "丹麦",
    "NO": "挪威",
    "FI": "芬兰",
    "CA": "加拿大",
    "AU": "澳大利亚",
    "EU": "欧洲",
}


def _ensure_utf8_stdio() -> None:
    for stream_name in ("stdout", "stderr"):
        st = getattr(sys, stream_name, None)
        if st is not None and hasattr(st, "reconfigure"):
            try:
                st.reconfigure(encoding="utf-8", errors="replace")
            except Exception:
                pass


def _find_ffmpeg_binary() -> str | None:
    direct = shutil.which("ffmpeg")
    if direct:
        return direct
    local_appdata = os.environ.get("LOCALAPPDATA", "")
    if local_appdata:
        pattern = os.path.join(
            local_appdata,
            "Microsoft",
            "WinGet",
            "Packages",
            "Gyan.FFmpeg*",
            "**",
            "ffmpeg.exe",
        )
        matches = glob.glob(pattern, recursive=True)
        if matches:
            return matches[0]
    return None


def _extract_spoken_source(raw_source: Any) -> str:
    if isinstance(raw_source, dict):
        raw = str(raw_source.get("name") or "").strip()
    else:
        raw = str(raw_source or "").strip()
    if not raw:
        return "国际媒体"
    m = re.search(r"[（(]([^）)]*[\u4e00-\u9fff][^）)]*)[）)]", raw)
    if m and m.group(1):
        zh_part = m.group(1).strip()
        prefix = re.sub(r"\s*[（(][^）)]*[）)]\s*", "", raw).strip()
        if zh_part in ("全球财经", "国际频道") and prefix:
            short_prefix = prefix.split()[0]
            return f"{short_prefix}{zh_part}"
        return zh_part
    return re.sub(r"\s*[（(][^）)]*[）)]\s*", "", raw).strip() or raw


def _clean_spoken_text(raw: str, is_pulse: bool = False) -> str:
    if not raw:
        return ""
    s = str(raw)
    # Remove [NEWS_k] citations and markdown links/URLs/HTML
    s = re.sub(r"\[NEWS_\d+\]", "", s, flags=re.IGNORECASE)
    s = re.sub(r"\[([^\]]+)\]\((?:https?://|/)[^)]+\)", r"\1", s)
    s = re.sub(r"https?://\S+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"<[^>]+>", "", s)
    # Social media handles & subreddits for pulse readability
    if is_pulse:
        s = re.sub(r"\br/([A-Za-z0-9_]+)", r"Reddit \1 版块", s)
        s = re.sub(r"\bu/([A-Za-z0-9_-]+)", r"网友", s)
        s = re.sub(r"\s+vs\.?\s+", " 对比 ", s, flags=re.IGNORECASE)
    # Clean markdown formatting
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"__(.+?)__", r"\1", s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"[*_~#]+", "", s)
    # Strip pure-ASCII parenthetical clutter e.g. (Reuters) while preserving short acronyms if needed
    s = re.sub(r"\s*[（(][A-Za-z0-9\s.&'\-/]{4,}[）)]", "", s)
    # Convert decimal numbers (e.g. 1.5万, 4.4亿) to spoken Chinese so TTS sentence splitter never splits on '.'
    s = re.sub(r"(?<=\d)\.(?=\d)", "点", s)
    # Replace slash between words with natural conjunction
    s = re.sub(r"(?<=[\u4e00-\u9fffA-Za-z])/(?=[\u4e00-\u9fffA-Za-z])", "与", s)
    # Normalize quotes & brackets for natural TTS prosody
    s = s.replace("「", "“").replace("」", "”").replace("『", "“").replace("』", "”")
    s = re.sub(r"[ \t]+", " ", s)
    s = re.sub(r"([。！？；，、])\1+", r"\1", s)
    s = re.sub(r"\s+([。！？；，、：])", r"\1", s)
    return s.strip()


def _ensure_sentence_end(text: str) -> str:
    t = text.strip()
    if not t:
        return ""
    if t[-1] not in "。！？!?":
        t += "。"
    return t


def _format_shanghai_edition(iso_str: str | None) -> dict[str, str]:
    tz = ZoneInfo("Asia/Shanghai")
    now_dt = dt.datetime.now(tz)
    target_dt = now_dt
    if iso_str:
        try:
            cleaned = str(iso_str).replace("Z", "+00:00")
            parsed = dt.datetime.fromisoformat(cleaned)
            target_dt = parsed.astimezone(tz) if parsed.tzinfo else parsed.replace(tzinfo=tz)
        except Exception:
            target_dt = now_dt

    hour = target_dt.hour
    minute = target_dt.minute
    if hour < 11:
        period = "早间"
    elif hour < 16:
        period = "午间"
    else:
        period = "晚间"

    min_spoken = "整" if minute == 0 else f"{minute}分"
    return {
        "date_ymd": target_dt.strftime("%Y-%m-%d"),
        "date_zh": f"{target_dt.year}年{target_dt.month}月{target_dt.day}日",
        "spoken_date": f"{target_dt.month}月{target_dt.day}日",
        "period": period,
        "spoken_clock": f"{hour}点{min_spoken}",
        "iso": target_dt.isoformat(),
    }


def _compute_plan_script_sha256(chapters: list[dict[str, Any]]) -> str:
    canonical = [
        {
            "id": str(ch.get("id") or ""),
            "speaker": str(ch.get("speaker") or ""),
            "text": str(ch.get("text") or "").strip(),
        }
        for ch in (chapters or [])
    ]
    payload = json.dumps(canonical, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_news_broadcast_plan(data_dir: Path = DATA_DIR, max_headlines: int = 10) -> dict[str, Any]:
    news_doc = json.loads((data_dir / "news.json").read_text(encoding="utf-8"))
    summary_doc = json.loads((data_dir / "summary.json").read_text(encoding="utf-8"))

    news_list: list[dict[str, Any]] = list(news_doc.get("news") or [])
    summary_art: dict[str, Any] = dict(summary_doc.get("article") or {})
    if not news_list:
        raise RuntimeError(f"No curated news articles found in {data_dir / 'news.json'}")

    edition_id = str(news_doc.get("editionId") or summary_doc.get("editionId") or "").strip() or None
    last_updated = str(news_doc.get("lastUpdated") or summary_art.get("generatedAt") or "")
    ed = _format_shanghai_edition(last_updated)
    top_items = news_list[: max(1, min(max_headlines, len(news_list)))]
    count_zh = f"{len(top_items)}条" if len(top_items) != 10 else "十条"

    # Chapter 1: Serena Opening
    ch1_text = (
        f"各位听众朋友大家好，欢迎收听聚核全球要闻{ed['period']}播报。"
        f"本期节目更新于北京时间{ed['spoken_date']}{ed['spoken_clock']}。"
        f"首先由评论员{MALE_ANCHOR_NAME}为您深度解读本时段全球政经与科技态势，"
        f"随后由我为您精播前{count_zh}国际重点要闻。"
    )

    # Chapter 2: Lin_Yuan Summary Commentary (VoiceDesign -> Base ICL voice-locked male news anchor)
    raw_summary_md = str(summary_art.get("content") or summary_art.get("markdown") or "").strip()
    summary_paragraphs: list[str] = ["听众朋友好，下面来看本时段的全球要闻深度综述。"]
    section_idx = 0
    transitions = ["首先聚焦", "再来关注", "把目光转向", "最后来看"]
    for raw_line in raw_summary_md.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        heading_match = re.match(r"^#{1,6}\s+(.+)$", line)
        if heading_match:
            h_clean = _clean_spoken_text(heading_match.group(1))
            if h_clean:
                prefix = transitions[min(section_idx, len(transitions) - 1)]
                section_idx += 1
                summary_paragraphs.append(_ensure_sentence_end(f"{prefix}：{h_clean}"))
            continue
        p_clean = _clean_spoken_text(line)
        if p_clean:
            summary_paragraphs.append(_ensure_sentence_end(p_clean))

    summary_paragraphs.append(
        f"好，以上就是本时段的全球态势深度综述。接下来把时间交给 Serena，为您逐条播报前{count_zh}重点要闻。"
    )
    ch2_text = "\n".join(summary_paragraphs)

    # Helper to format individual news item for Serena
    def _format_headline_item(idx_1based: int, item: dict[str, Any]) -> str:
        ord_label = CN_NUMS.get(idx_1based, f"第{idx_1based}") + "条"
        src_spoken = _extract_spoken_source(item.get("source"))
        title_clean = _clean_spoken_text(str(item.get("translatedTitle") or item.get("title") or ""))
        sum_clean = _clean_spoken_text(str(item.get("summary") or item.get("translatedDescription") or ""))
        first_clause = sum_clean.split("。")[0].strip() if sum_clean else ""
        if first_clause and title_clean and (first_clause == title_clean or title_clean in first_clause):
            body = _ensure_sentence_end(sum_clean)
        elif sum_clean:
            body = f"{_ensure_sentence_end(title_clean)}{_ensure_sentence_end(sum_clean)}"
        else:
            body = _ensure_sentence_end(title_clean)
        return f"{ord_label}，据{src_spoken}消息，{body}"

    first_batch = top_items[:5]
    second_batch = top_items[5:]

    ch3_lines = [f"好的，谢谢{MALE_ANCHOR_NAME}。下面为您精播重点要闻。"]
    for i, it in enumerate(first_batch, start=1):
        ch3_lines.append(_format_headline_item(i, it))
    if not second_batch:
        ch3_lines.append("以上就是本期聚核全球要闻播报的全部内容，感谢您的收听，我们下个时段再见。")
    ch3_text = "\n".join(ch3_lines)

    chapters: list[dict[str, Any]] = [
        {
            "index": 1,
            "id": "news-opening",
            "title": "开场导视",
            "speaker": "Serena",
            "speakerLabel": "Serena · 要闻主播",
            "instruct": "知性温暖、端庄干练的中文国际新闻女主播语气，吐字清晰流畅，节奏明快自然",
            "text": ch1_text,
        },
        {
            "index": 2,
            "id": "news-summary",
            "title": "全球要闻深度综述",
            "speaker": MALE_ANCHOR_ID,
            "speakerLabel": f"{MALE_ANCHOR_NAME} · 深度评论",
            "instruct": DEFAULT_MALE_ANCHOR_INSTRUCT,
            "text": ch2_text,
        },
        {
            "index": 3,
            "id": "news-headlines-1",
            "title": f"重点要闻精播 (01–{len(first_batch):02d})",
            "speaker": "Serena",
            "speakerLabel": "Serena · 要闻主播",
            "instruct": "知性干练的新闻女主播播报语气，条理分明，句间停顿清晰自然",
            "text": ch3_text,
        },
    ]

    if second_batch:
        ch4_lines = []
        for i, it in enumerate(second_batch, start=6):
            ch4_lines.append(_format_headline_item(i, it))
        ch4_lines.append("以上就是本期聚核全球要闻播报的全部内容。感谢您的收听，我们下个时段再见。")
        chapters.append(
            {
                "index": 4,
                "id": "news-headlines-2",
                "title": f"重点要闻精播 (06–{len(top_items):02d})",
                "speaker": "Serena",
                "speakerLabel": "Serena · 要闻主播",
                "instruct": "知性干练的新闻女主播播报语气，条理分明，结尾温和亲切",
                "text": "\n".join(ch4_lines),
            }
        )

    raw_title = str(summary_art.get("title") or "").strip()
    subtitle_part = raw_title.split("：", 1)[1].strip() if "：" in raw_title else f"前 {len(top_items)} 条国际权威要闻精播"
    return {
        "track": "news",
        "label": "全球要闻播报",
        "title": f"{ed['date_zh']}{ed['period']} · 全球要闻双主播精播",
        "subtitle": f"{subtitle_part} · {MALE_ANCHOR_NAME} & Serena",
        "editionId": edition_id,
        "editionTimestamp": last_updated or ed["iso"],
        "scriptSha256": _compute_plan_script_sha256(chapters),
        "totalChars": sum(len(ch["text"]) for ch in chapters),
        "chapters": chapters,
    }


def build_pulse_broadcast_plan(data_dir: Path = DATA_DIR, pulse_file: Path | None = None) -> dict[str, Any]:
    target_path = pulse_file or (data_dir / "social_pulse.json")
    raw_doc = json.loads(target_path.read_text(encoding="utf-8"))
    issues = list(raw_doc.get("issues") or ([raw_doc] if raw_doc.get("clusters") else []))
    if not issues:
        raise RuntimeError(f"No social pulse issues found in {target_path}")

    latest_key = str(raw_doc.get("latestKey") or "")
    issue = next((it for it in issues if it.get("key") == latest_key), issues[0])
    issue_date = str(issue.get("date") or "")
    m_date = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", issue_date)
    spoken_date = f"{int(m_date.group(2))}月{int(m_date.group(3))}日" if m_date else "今日"

    headline = _clean_spoken_text(str(issue.get("headline") or ""), is_pulse=True)
    overview = _clean_spoken_text(
        str((issue.get("executive_summary") or {}).get("overview") or ""),
        is_pulse=True,
    )
    comparisons = list(issue.get("transatlantic_comparisons") or [])
    clusters = list(issue.get("clusters") or [])

    # Chapter 1: Serena Opening
    ch1_text = (
        f"各位听众朋友早上好，欢迎收听聚核欧美社媒早班车。"
        f"今天是{spoken_date}，我们为您深度盘点过去二十四小时美国与欧洲多语种社区在 X、Threads 与 Reddit 三大平台上的公共讨论。"
        f"首先请评论员{MALE_ANCHOR_NAME}为您拆解今日跨大西洋舆论主线与美欧同题温差。"
    )

    # Chapter 2: Lin_Yuan Overview & Transatlantic Contrasts
    ch2_lines = [f"早上好。过去二十四小时，欧美社交舆论场的核心主线是：{_ensure_sentence_end(headline)}"]
    if overview:
        ch2_lines.append(_ensure_sentence_end(overview))
    for idx, comp in enumerate(comparisons[:2], start=1):
        topic = _clean_spoken_text(str(comp.get("topic") or ""), is_pulse=True)
        us_ang = _clean_spoken_text(str(comp.get("us_angle") or ""), is_pulse=True)
        eu_ang = _clean_spoken_text(str(comp.get("eu_angle") or ""), is_pulse=True)
        verdict = _clean_spoken_text(str(comp.get("verdict") or ""), is_pulse=True)
        lead = "在跨大西洋同题温差上，" if idx == 1 else "另一组鲜明对比是，"
        seg = f"{lead}围绕“{topic}”，美国舆论聚焦于：{_ensure_sentence_end(us_ang)}而欧洲社区则聚焦于：{_ensure_sentence_end(eu_ang)}"
        if verdict:
            seg += f"可以说，{_ensure_sentence_end(verdict)}"
        ch2_lines.append(seg)
    ch2_lines.append("接下来请 Serena 带大家走进美欧两地热度最高的社媒交锋现场与高赞网友辣评。")
    ch2_text = "\n".join(ch2_lines)

    us_clusters = sorted(
        [c for c in clusters if c.get("region") == "US"],
        key=lambda x: int(x.get("heat_score") or 0),
        reverse=True,
    )[:4]
    eu_clusters = sorted(
        [c for c in clusters if c.get("region") != "US"],
        key=lambda x: int(x.get("heat_score") or 0),
        reverse=True,
    )[:4]
    if not us_clusters:
        us_clusters = clusters[:3]

    def _format_cluster_item(idx_1based: int, cl: dict[str, Any], include_country: bool = False) -> str:
        ord_word = CN_NUMS.get(idx_1based, f"第{idx_1based}") + "个焦点"
        title_zh = _clean_spoken_text(str(cl.get("title_zh") or ""), is_pulse=True)
        hook = _clean_spoken_text(str(cl.get("hook_one_liner") or ""), is_pulse=True)
        country_prefix = ""
        if include_country:
            countries = [COUNTRY_LABELS.get(str(c).upper(), str(c)) for c in (cl.get("countries") or []) if c]
            uniq_c = list(dict.fromkeys(countries))[:2]
            if uniq_c:
                country_prefix = f"来自{'与'.join(uniq_c)}社区，"
        quotes = list(cl.get("featured_quotes") or [])
        quote_part = ""
        if quotes:
            q_zh = _clean_spoken_text(str(quotes[0].get("quote_zh") or ""), is_pulse=True)
            if q_zh:
                quote_part = f"有高赞网友评论道：“{_ensure_sentence_end(q_zh)}”"
        body = f"{ord_word}，{country_prefix}{_ensure_sentence_end(title_zh)}{_ensure_sentence_end(hook)}{quote_part}"
        return body

    ch3_lines = [f"好的，谢谢{MALE_ANCHOR_NAME}。我们先来看美国舆论场的高热交锋。"]
    for idx, cl in enumerate(us_clusters, start=1):
        ch3_lines.append(_format_cluster_item(idx, cl, include_country=False))
    if not eu_clusters:
        ch3_lines.append("以上就是本期聚核欧美社媒早班车的全部内容，感谢收听，祝您今天心情愉快。")
    ch3_text = "\n".join(ch3_lines)

    chapters: list[dict[str, Any]] = [
        {
            "index": 1,
            "id": "pulse-opening",
            "title": "早班车导播",
            "speaker": "Serena",
            "speakerLabel": "Serena · 社媒观察主播",
            "instruct": "知性明快的早间新闻播客女主播语气，充满亲和力，吐字清晰自然",
            "text": ch1_text,
        },
        {
            "index": 2,
            "id": "pulse-overview",
            "title": "跨大西洋总览与温差",
            "speaker": MALE_ANCHOR_ID,
            "speakerLabel": f"{MALE_ANCHOR_NAME} · 跨洋评论",
            "instruct": DEFAULT_MALE_ANCHOR_INSTRUCT,
            "text": ch2_text,
        },
        {
            "index": 3,
            "id": "pulse-us",
            "title": "美国舆论场高热交锋",
            "speaker": "Serena",
            "speakerLabel": "Serena · 社媒观察主播",
            "instruct": "生动知性的新闻播客女主播语气，引述网友热评时自然鲜活",
            "text": ch3_text,
        },
    ]

    if eu_clusters:
        ch4_lines = ["再把视线投向大西洋彼岸的欧洲多语种社区。"]
        for idx, cl in enumerate(eu_clusters, start=1):
            ch4_lines.append(_format_cluster_item(idx, cl, include_country=True))
        ch4_lines.append("以上就是今天聚核欧美社媒早班车的全部内容，感谢您的收听，我们明天早间再见。")
        chapters.append(
            {
                "index": 4,
                "id": "pulse-eu",
                "title": "欧洲多语种社区交锋",
                "speaker": "Serena",
                "speakerLabel": "Serena · 社媒观察主播",
                "instruct": "生动知性的新闻播客女主播语气，条理清晰，收尾温暖亲切",
                "text": "\n".join(ch4_lines),
            }
        )

    issue_key = str(issue.get("key") or f"daily:{issue_date}")
    return {
        "track": "pulse",
        "label": "欧美社媒早班车",
        "title": f"{issue_date} · 欧美社媒热议双主播观察",
        "subtitle": f"{headline[:36]} · {MALE_ANCHOR_NAME} & Serena",
        "issueKey": issue_key,
        "editionTimestamp": str(issue.get("generated_at") or ""),
        "scriptSha256": _compute_plan_script_sha256(chapters),
        "totalChars": sum(len(ch["text"]) for ch in chapters),
        "chapters": chapters,
    }


def _read_wav_float32_mono(wav_path: Path) -> tuple[np.ndarray, int]:
    if np is None:
        raise RuntimeError("numpy is required for WAV decoding/stitching (install via `pip install numpy`).")
    with wave.open(str(wav_path), "rb") as wf:
        sr = wf.getframerate()
        nch = wf.getnchannels()
        sw = wf.getsampwidth()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    if nframes <= 0 or not raw:
        return np.zeros(0, dtype=np.float32), int(sr or 24000)
    if sw == 2:
        arr = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 4:
        arr = np.frombuffer(raw, dtype="<i4").astype(np.float32) / 2147483648.0
    else:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    if nch > 1:
        arr = arr.reshape(-1, nch).mean(axis=1)
    return arr.astype(np.float32), int(sr)


def _normalize_chapter_loudness(samples: np.ndarray, sample_rate: int) -> np.ndarray:
    if samples.size == 0:
        return samples
    mono = samples.copy()
    # Gentle speech RMS leveling across Uncle_Fu and Serena so host switches sound studio-balanced
    active = mono[np.abs(mono) > 0.012]
    rms = float(np.sqrt(np.mean(active ** 2))) if active.size > 200 else float(np.sqrt(np.mean(mono ** 2)))
    if rms > 1e-4:
        gain = max(0.65, min(1.85, 0.135 / rms))
        mono *= gain

    peak = float(np.max(np.abs(mono)))
    if peak > 0.94:
        mono *= 0.94 / peak

    fade_n = min(int(sample_rate * 0.020), mono.size // 4)
    if fade_n > 1:
        ramp = 0.5 * (1.0 - np.cos(np.linspace(0.0, math.pi, fade_n, dtype=np.float32)))
        mono[:fade_n] *= ramp
        mono[-fade_n:] *= ramp[::-1]
    return mono.astype(np.float32)


def stitch_chapters_to_mp3(
    chapter_wavs: list[Path],
    chapters_meta: list[dict[str, Any]],
    out_mp3_path: Path,
    handoff_pause_ms: int = 480,
    bitrate_kbps: int = 80,
) -> tuple[list[dict[str, Any]], float, int]:
    target_sr = 24000
    gap_samples = int(target_sr * max(0, handoff_pause_ms) / 1000.0)
    gap_arr = np.zeros(gap_samples, dtype=np.float32)

    pieces: list[np.ndarray] = []
    final_chapters: list[dict[str, Any]] = []
    cursor_samples = 0

    for idx, (wav_path, ch_meta) in enumerate(zip(chapter_wavs, chapters_meta)):
        arr, sr = _read_wav_float32_mono(wav_path)
        if sr != target_sr and arr.size > 0:
            new_len = max(1, int(round(arr.size * float(target_sr) / float(sr))))
            arr = np.interp(
                np.linspace(0.0, 1.0, num=new_len, endpoint=False),
                np.linspace(0.0, 1.0, num=arr.size, endpoint=False),
                arr,
            ).astype(np.float32)

        leveled = _normalize_chapter_loudness(arr, target_sr)
        if idx > 0 and gap_arr.size > 0:
            pieces.append(gap_arr)
            cursor_samples += gap_arr.size

        start_sec = round(cursor_samples / float(target_sr), 2)
        dur_sec = round(leveled.size / float(target_sr), 2)
        pieces.append(leveled)
        cursor_samples += leveled.size

        final_chapters.append(
            {
                "index": ch_meta["index"],
                "id": ch_meta["id"],
                "title": ch_meta["title"],
                "speaker": ch_meta["speaker"],
                "speakerLabel": ch_meta["speakerLabel"],
                "startSec": start_sec,
                "durationSec": dur_sec,
                "text": ch_meta["text"],
            }
        )

    master_wave = np.concatenate(pieces, axis=0) if pieces else np.zeros(int(target_sr * 0.5), dtype=np.float32)
    total_duration_sec = round(master_wave.size / float(target_sr), 2)

    ffmpeg_bin = _find_ffmpeg_binary()
    if not ffmpeg_bin:
        raise RuntimeError("Local ffmpeg binary not found; required to encode master MP3 with seek header.")

    out_mp3_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="corefeed_tts_master_") as tmp_d:
        master_wav_path = Path(tmp_d) / "master_24k.wav"
        pcm16 = (np.clip(master_wave, -1.0, 1.0) * 32767.0).astype("<i2")
        with wave.open(str(master_wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(target_sr)
            wf.writeframes(pcm16.tobytes())

        tmp_mp3 = out_mp3_path.with_suffix(f".tmp.{os.getpid()}.mp3")
        cmd = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(master_wav_path),
            "-codec:a",
            "libmp3lame",
            "-ar",
            str(target_sr),
            "-ac",
            "1",
            "-b:a",
            f"{bitrate_kbps}k",
            "-write_xing",
            "1",
            str(tmp_mp3),
        ]
        subprocess.run(cmd, check=True, timeout=300)
        raw_mp3 = tmp_mp3.read_bytes()
        if len(raw_mp3) < 256:
            tmp_mp3.unlink(missing_ok=True)
            raise RuntimeError(f"Encoded MP3 is unexpectedly small ({len(raw_mp3)} bytes)")
        os.replace(tmp_mp3, out_mp3_path)

    return final_chapters, total_duration_sec, target_sr


def _preflight_check_scripts(using_external_server: bool = False) -> None:
    if not SKILL_JOB_RUNNER.is_file():
        raise RuntimeError(
            f"Qwen3-TTS job runner script not found: {SKILL_JOB_RUNNER}. "
            "Set env QWEN3_JOB_RUNNER to the path of run_qwen3_tts_colab_job.py."
        )
    if not using_external_server and not DEPLOY_COLAB_SCRIPT.is_file():
        raise RuntimeError(
            f"Google Colab deploy script not found: {DEPLOY_COLAB_SCRIPT}. "
            "Set env QWEN3_COLAB_ROOT to your Google_Colab directory."
        )


def _ensure_colab_stopped(timeout_sec: int = 90) -> dict[str, Any]:
    if not DEPLOY_COLAB_SCRIPT.is_file():
        return {"error": f"deploy_colab.py not found: {DEPLOY_COLAB_SCRIPT}"}
    try:
        proc = subprocess.run(
            [sys.executable, str(DEPLOY_COLAB_SCRIPT), "stop"],
            cwd=str(COLAB_REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired:
        return {"error": f"deploy_colab.py stop timed out after {timeout_sec}s", "timed_out": True}
    last_json: dict[str, Any] = {}
    for line in (proc.stdout or "").splitlines():
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            try:
                last_json = json.loads(s)
            except Exception:
                pass
    if not last_json and proc.returncode != 0:
        return {"error": f"deploy_colab.py stop exited with code {proc.returncode}", "stderr": (proc.stderr or "").strip()[:300]}
    return last_json


def _verify_zero_billing(receipt: dict[str, Any] | None) -> tuple[bool, str]:
    if not isinstance(receipt, dict) or not receipt:
        return False, "missing billing receipt from Colab stop"
    if receipt.get("timed_out") or receipt.get("error"):
        return False, f"Colab stop error: {receipt.get('error') or 'timed_out'}"
    if receipt.get("ok") is False:
        return False, "Colab stop receipt returned ok=False"
    if receipt.get("stopped") is False:
        return False, "Colab stop receipt returned stopped=False"

    if "active_assignments" in receipt:
        active = receipt["active_assignments"]
        if isinstance(active, bool):
            if active:
                return False, "active_assignments is True"
        elif isinstance(active, (int, float)):
            if active > 0:
                return False, f"active_assignments={active} (> 0)"
        elif isinstance(active, (list, tuple, set, dict)):
            if len(active) > 0:
                return False, f"active_assignments still non-empty ({len(active)})"
        elif isinstance(active, str):
            if active.strip().lower() not in ("", "0", "[]", "none", "false", "{}"):
                return False, f"active_assignments={active!r}"

    for rate_key in ("cu_per_hour", "billing_rate", "current_cu_per_hour"):
        if rate_key in receipt and receipt[rate_key] is not None:
            try:
                rate_val = float(receipt[rate_key])
            except (TypeError, ValueError):
                return False, f"unparseable {rate_key}={receipt[rate_key]!r}"
            if rate_val > 1e-6:
                return False, f"{rate_key}={rate_val} CU/hr (> 0.0)"

    return True, "verified 0.0 CU/hr and 0 active assignments"


def _check_colab_login_and_balance(timeout_sec: int = 60) -> dict[str, Any]:
    try:
        proc = subprocess.run(
            [sys.executable, str(DEPLOY_COLAB_SCRIPT), "status"],
            cwd=str(COLAB_REPO_ROOT),
            capture_output=True,
            text=True,
            check=True,
            timeout=timeout_sec,
        )
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError(f"Google Colab status check timed out after {timeout_sec}s.") from exc
    info: dict[str, Any] = {}
    for line in (proc.stdout or "").splitlines():
        s = line.strip()
        if s.startswith("{") and s.endswith("}"):
            info = json.loads(s)
    if not info.get("logged_in"):
        raise RuntimeError("Google Colab OAuth is not logged in. Run `colab_bridge.py auth_url` to re-authorize.")
    bal = float(info.get("paid_balance") or 0.0)
    if bal <= 1.0:
        raise RuntimeError(f"Insufficient Google Colab compute balance: {bal} CU (must be > 1.0 CU).")
    print(
        f"[COLAB-STATUS] logged_in=True | paid_balance={bal} CU | active_assignments={info.get('active_assignments')}",
        flush=True,
    )
    return info


def _can_reuse_existing_track(
    plan: dict[str, Any],
    existing_tracks: dict[str, Any],
    audio_dir: Path,
) -> bool:
    track_key = plan["track"]
    existing = existing_tracks.get(track_key)
    if not isinstance(existing, dict):
        return False
    out_mp3 = audio_dir / f"briefing-{track_key}.mp3"
    if not out_mp3.is_file() or out_mp3.stat().st_size < 256:
        return False
    plan_script_sha = str(plan.get("scriptSha256") or "").strip()
    existing_script_sha = str(existing.get("scriptSha256") or "").strip()
    if not plan_script_sha or existing_script_sha != plan_script_sha:
        return False
    if track_key == "news":
        plan_ed = str(plan.get("editionId") or "").strip()
        if plan_ed and str(existing.get("editionId") or "").strip() != plan_ed:
            return False
    if track_key == "pulse":
        plan_issue = str(plan.get("issueKey") or "").strip()
        if plan_issue and str(existing.get("issueKey") or "").strip() != plan_issue:
            return False
    return True


def main(argv: list[str] | None = None) -> int:
    _ensure_utf8_stdio()
    parser = argparse.ArgumentParser(description="Generate CoreFeed Dual-Anchor Qwen3-TTS 1.7B Broadcast Audio")
    parser.add_argument("--mode", choices=("news", "pulse", "both"), default="news", help="Broadcast track(s) to synthesize")
    parser.add_argument("--data-dir", type=Path, default=DATA_DIR, help="CoreFeed data directory")
    parser.add_argument("--pulse-file", type=Path, default=None, help="Optional explicit social pulse JSON file")
    parser.add_argument("--max-headlines", type=int, default=10, help="Number of curated news items to broadcast")
    parser.add_argument("--gpu", default="L4", help="Preferred Google Colab GPU tier (default: L4)")
    parser.add_argument("--speed", type=float, default=1.03, help="Speech speed multiplier (default: 1.03 crisp broadcast pace)")
    parser.add_argument("--bitrate-kbps", type=int, default=80, help="Output MP3 bitrate in kbps (default: 80)")
    parser.add_argument("--base-url", default="", help="Optional existing/mock Qwen3-TTS server URL (skips Colab VM)")
    parser.add_argument("--api-key", default="", help="Optional API key when --base-url is used")
    parser.add_argument("--timeout-sec", type=int, default=1200, help="Subprocess timeout in seconds for TTS synthesis (default: 1200)")
    parser.add_argument("--max-total-chars", type=int, default=12000, help="Max total spoken characters across planned chapters (default: 12000)")
    parser.add_argument("--force", action="store_true", help="Force re-synthesis even when local audio already matches scriptSha256 and editionId")
    parser.add_argument("--dry-run-script", action="store_true", help="Print compiled dual-anchor script JSON without running TTS")
    args = parser.parse_args(argv)

    data_dir = args.data_dir.resolve()
    audio_dir = data_dir / "audio"
    broadcast_json_path = data_dir / "audio_broadcast.json"

    plans: list[dict[str, Any]] = []
    if args.mode in ("news", "both"):
        plans.append(build_news_broadcast_plan(data_dir=data_dir, max_headlines=args.max_headlines))
    if args.mode in ("pulse", "both"):
        plans.append(build_pulse_broadcast_plan(data_dir=data_dir, pulse_file=args.pulse_file))

    total_chars = sum(int(p.get("totalChars") or sum(len(c.get("text") or "") for c in p.get("chapters") or [])) for p in plans)
    if args.max_total_chars > 0 and total_chars > args.max_total_chars:
        raise RuntimeError(
            f"Planned TTS script length ({total_chars} chars) exceeds --max-total-chars limit ({args.max_total_chars}). "
            "Refusing to launch synthesis to prevent runaway GPU cost."
        )

    if args.dry_run_script:
        print(json.dumps({"ok": True, "totalChars": total_chars, "plans": plans}, ensure_ascii=False, indent=2))
        return 0

    # Load existing audio_broadcast.json to support idempotent reuse and sibling-track preservation
    existing_bundle: dict[str, Any] = {}
    if broadcast_json_path.is_file():
        try:
            existing_bundle = json.loads(broadcast_json_path.read_text(encoding="utf-8"))
        except Exception:
            existing_bundle = {}
    tracks_map: dict[str, Any] = dict(existing_bundle.get("tracks") or {})

    reused_tracks: list[str] = []
    pending_plans: list[dict[str, Any]] = []
    for plan in plans:
        if not args.force and _can_reuse_existing_track(plan, tracks_map, audio_dir):
            reused_tracks.append(plan["track"])
        else:
            pending_plans.append(plan)

    if not pending_plans:
        result_report = {
            "ok": True,
            "mode": args.mode,
            "reused": reused_tracks,
            "synthesized": [],
            "skipped_colab": True,
            "broadcast_json": str(broadcast_json_path),
        }
        print("\n=== COREFEED DUAL-ANCHOR TTS SUMMARY (REUSED) ===", flush=True)
        print(json.dumps(result_report, ensure_ascii=False, indent=2), flush=True)
        return 0

    using_external_server = bool(args.base_url.strip())
    _preflight_check_scripts(using_external_server=using_external_server)
    if not using_external_server:
        _check_colab_login_and_balance()

    billing_receipt: dict[str, Any] = {}
    billing_verified = True
    billing_error = ""
    anchor_meta: dict[str, Any] = {}
    if MALE_ANCHOR_META_JSON.is_file():
        try:
            anchor_meta = json.loads(MALE_ANCHOR_META_JSON.read_text(encoding="utf-8"))
        except Exception:
            anchor_meta = {}
    anchor_ref_text = str(
        anchor_meta.get("ref_text")
        or "听众朋友好，欢迎收听聚核全球要闻深度综述。今天我们将聚焦主要经济体政策动向、科技产业格局变化与国际地缘局势的最新进展。"
    ).strip()
    has_male_anchor_wav = MALE_ANCHOR_WAV.is_file()

    with tempfile.TemporaryDirectory(prefix="corefeed_qwen3_batch_") as work_tmp:
        work_dir = Path(work_tmp)
        custom_jobs: list[dict[str, Any]] = []
        male_jobs: list[dict[str, Any]] = []
        plan_wav_map: dict[str, list[Path]] = {}

        for plan in pending_plans:
            track_key = plan["track"]
            wav_list: list[Path] = []
            for ch in plan["chapters"]:
                wav_out = work_dir / f"{track_key}_{ch['index']:02d}_{ch['id']}.wav"
                wav_list.append(wav_out)
                if ch["speaker"] == MALE_ANCHOR_ID:
                    if has_male_anchor_wav:
                        male_jobs.append(
                            {
                                "name": f"{track_key}_{ch['index']:02d}_{ch['id']}",
                                "task": "voice_clone",
                                "ref_voice": MALE_ANCHOR_ID,
                                "language": "Chinese",
                                "text": ch["text"],
                                "speed": args.speed,
                                "auto_chunk": True,
                                "max_chunk_chars": 150,
                                "output_format": "wav",
                                "seed": 42,
                                "output_path": str(wav_out),
                            }
                        )
                    else:
                        is_first_male = len(male_jobs) == 0
                        job_entry: dict[str, Any] = {
                            "name": f"{track_key}_{ch['index']:02d}_{ch['id']}",
                            "task": "voice_design" if is_first_male else "voice_clone",
                            "language": "Chinese",
                            "text": ch["text"],
                            "speed": args.speed,
                            "auto_chunk": True,
                            "max_chunk_chars": 150,
                            "output_format": "wav",
                            "seed": 101 if is_first_male else 42,
                            "output_path": str(wav_out),
                        }
                        if is_first_male:
                            job_entry["instruct"] = ch.get("instruct") or DEFAULT_MALE_ANCHOR_INSTRUCT
                            job_entry["save_output_as_voice"] = MALE_ANCHOR_ID
                            job_entry["persist_voice"] = False
                        else:
                            job_entry["ref_voice"] = MALE_ANCHOR_ID
                        male_jobs.append(job_entry)
                else:
                    custom_jobs.append(
                        {
                            "name": f"{track_key}_{ch['index']:02d}_{ch['id']}",
                            "task": "custom_voice",
                            "speaker": ch["speaker"],
                            "language": "Chinese",
                            "instruct": ch["instruct"],
                            "text": ch["text"],
                            "speed": args.speed,
                            "auto_chunk": True,
                            "max_chunk_chars": 150,
                            "output_format": "wav",
                            "seed": 42,
                            "output_path": str(wav_out),
                        }
                    )
            plan_wav_map[track_key] = wav_list

        # Group jobs by model variant (custom_voice first, then voice_clone) to avoid model swaps on smaller GPUs
        jobs = custom_jobs + male_jobs

        manifest_out = work_dir / "tts_batch_manifest.json"
        spec_path = work_dir / "qwen3_tts_jobs.json"
        spec_payload: dict[str, Any] = {
            "gpu": args.gpu,
            "keep_alive_after": False,
            "manifest_out": str(manifest_out),
            "jobs": jobs,
        }
        if has_male_anchor_wav and male_jobs:
            spec_payload["voices"] = [
                {
                    "alias": MALE_ANCHOR_ID,
                    "name": f"{MALE_ANCHOR_ID}_News_Anchor",
                    "audio_path": str(MALE_ANCHOR_WAV),
                    "ref_text": anchor_ref_text,
                    "persist": False,
                }
            ]
        spec_path.write_text(json.dumps(spec_payload, ensure_ascii=False, indent=2), encoding="utf-8")

        runner_cmd = [
            sys.executable,
            "-u",
            str(SKILL_JOB_RUNNER),
            "--spec",
            str(spec_path),
        ]
        if using_external_server:
            runner_cmd.extend(["--base-url", args.base_url.strip(), "--api-key", args.api_key.strip()])

        try:
            for attempt_idx in range(2):
                try:
                    subprocess.run(runner_cmd, check=True, timeout=max(30, int(args.timeout_sec)))
                    break
                except subprocess.TimeoutExpired as exc:
                    raise RuntimeError(
                        f"Qwen3-TTS synthesis timed out after {args.timeout_sec}s; forcing Colab VM shutdown."
                    ) from exc
                except subprocess.CalledProcessError:
                    if using_external_server or attempt_idx == 1:
                        raise
                    print(
                        "[WARN] First Colab synthesis attempt failed (likely stale reused assignment); "
                        "ensuring VM release and retrying once on a fresh GPU...",
                        flush=True,
                    )
                    _ensure_colab_stopped()
        finally:
            if not using_external_server:
                billing_receipt = _ensure_colab_stopped()
                if manifest_out.is_file() and (not billing_receipt or billing_receipt.get("error")):
                    try:
                        m_doc = json.loads(manifest_out.read_text(encoding="utf-8"))
                        manifest_billing = dict(m_doc.get("billing_status") or {})
                        if manifest_billing:
                            billing_receipt = manifest_billing
                    except Exception:
                        pass
                billing_verified, billing_error = _verify_zero_billing(billing_receipt)
                if not billing_verified:
                    print(
                        f"[WARN] Colab 0.0 CU/hr shutdown verification failed ({billing_error}); retrying stop once...",
                        file=sys.stderr,
                        flush=True,
                    )
                    billing_receipt = _ensure_colab_stopped()
                    billing_verified, billing_error = _verify_zero_billing(billing_receipt)
                    if not billing_verified:
                        print(
                            f"[CRITICAL][BILLING] Failed to verify 0.0 CU/hr Colab shutdown: {billing_error} | receipt={billing_receipt}",
                            file=sys.stderr,
                            flush=True,
                        )

        now_iso = dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")
        synthesized_summary: list[dict[str, Any]] = []

        for plan in pending_plans:
            track_key = plan["track"]
            file_name = f"briefing-{track_key}.mp3"
            out_mp3 = audio_dir / file_name
            stitched_chapters, total_dur_sec, sample_rate = stitch_chapters_to_mp3(
                chapter_wavs=plan_wav_map[track_key],
                chapters_meta=plan["chapters"],
                out_mp3_path=out_mp3,
                handoff_pause_ms=480,
                bitrate_kbps=args.bitrate_kbps,
            )
            mp3_bytes = out_mp3.read_bytes()
            sha256_hex = hashlib.sha256(mp3_bytes).hexdigest()
            ver_short = sha256_hex[:10]

            track_record: dict[str, Any] = {
                "track": track_key,
                "label": plan["label"],
                "title": plan["title"],
                "subtitle": plan["subtitle"],
                "editionId": plan.get("editionId"),
                "issueKey": plan.get("issueKey"),
                "editionTimestamp": plan.get("editionTimestamp"),
                "scriptSha256": plan.get("scriptSha256"),
                "generatedAt": now_iso,
                "fileName": file_name,
                "audioUrl": f"/api/audio/{track_key}.mp3?v={ver_short}",
                "rawUrl": f"{RAW_SNAPSHOT_BASE}/{file_name}",
                "sha256": sha256_hex,
                "format": "mp3",
                "mimeType": "audio/mpeg",
                "sampleRate": sample_rate,
                "bitrateKbps": args.bitrate_kbps,
                "sizeBytes": len(mp3_bytes),
                "durationSec": total_dur_sec,
                "model": "Qwen3-TTS-12Hz-1.7B (CustomVoice + Base ICL)",
                "voices": [
                    {"id": MALE_ANCHOR_ID, "name": MALE_ANCHOR_NAME, "role": "深度综述评论"},
                    {"id": "Serena", "name": "Serena", "role": "重点要闻主播"},
                ],
                "chapters": stitched_chapters,
            }
            tracks_map[track_key] = track_record
            synthesized_summary.append(
                {
                    "track": track_key,
                    "edition_id": plan.get("editionId"),
                    "script_sha256": plan.get("scriptSha256"),
                    "output_mp3": str(out_mp3),
                    "duration_sec": total_dur_sec,
                    "size_kb": round(len(mp3_bytes) / 1024.0, 1),
                    "sha256": sha256_hex,
                    "chapters": len(stitched_chapters),
                }
            )

        ordered_tracks = {k: tracks_map[k] for k in ("news", "pulse") if k in tracks_map}
        default_track = "news" if "news" in ordered_tracks else next(iter(ordered_tracks.keys()))
        final_bundle = {
            "version": "1.0",
            "updatedAt": now_iso,
            "defaultTrack": default_track,
            "trackCount": len(ordered_tracks),
            "tracks": ordered_tracks,
        }
        broadcast_json_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_json = broadcast_json_path.with_suffix(".tmp.json")
        tmp_json.write_text(json.dumps(final_bundle, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_json, broadcast_json_path)

    result_report: dict[str, Any] = {
        "ok": True if (using_external_server or billing_verified) else False,
        "mode": args.mode,
        "reused": reused_tracks,
        "synthesized": synthesized_summary,
        "broadcast_json": str(broadcast_json_path),
        "billing_status": billing_receipt,
        "billing_verified": True if using_external_server else billing_verified,
    }
    if not using_external_server and not billing_verified:
        result_report["billing_error"] = billing_error
        print("\n=== COREFEED DUAL-ANCHOR TTS SUMMARY (BILLING ALERT) ===", flush=True)
        print(json.dumps(result_report, ensure_ascii=False, indent=2), flush=True)
        return 2

    print("\n=== COREFEED DUAL-ANCHOR TTS SUMMARY ===", flush=True)
    print(json.dumps(result_report, ensure_ascii=False, indent=2), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
