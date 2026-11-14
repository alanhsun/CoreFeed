/**
 * CoreFeed v2.0 — AI 助手结构化简报与智能音箱口播文稿纯数据格式化工具 (utils/briefing_formatter.js)
 *
 * 设计原则：
 *   本模块仅对已由 Antigravity 内置大模型精编完成的中文新闻与深度综述做确定性裁剪、符号清洗与自然句切分，
 *   供外部个人 AI 助手（如 Hermes Agent、OpenClaw）与智能音箱桥接服务（如 open-xiaoai-bridge）零延迟直读与分段朗读。
 *   严禁引入任何外部翻译接口、模型密钥或伪造生成逻辑。
 */

const DEFAULT_MAX_SEGMENT_CHARS = 240;
const DEFAULT_ORAL_MAX_CHARS = 280;

/**
 * 从信源显示名称中提取适合中文 TTS 朗读的媒体简称
 * 例如: "Reuters (路透社)" -> "路透社", "NHK (日本放送协会)" -> "日本放送协会", "CNBC" -> "CNBC"
 */
function extractSpokenSourceName(rawSource) {
    const raw = typeof rawSource === 'string'
        ? rawSource.trim()
        : String(rawSource?.name || '').trim();
    if (!raw) return '外媒';

    const parenMatch = raw.match(/[（(]([^）)]*[\u4e00-\u9fff][^）)]*)[）)]/);
    if (parenMatch && parenMatch[1]) {
        return parenMatch[1].trim();
    }

    const stripped = raw.replace(/\s*[（(][^）)]*[）)]\s*/g, '').trim();
    return stripped || raw;
}

/**
 * 将 ISO 时间戳转换为自然的北京时间口播与可读字符串
 */
function formatTimestampInfo(isoStr) {
    if (!isoStr) {
        return { display: '未知时间', spoken: '' };
    }
    const dt = new Date(isoStr);
    if (isNaN(dt.getTime())) {
        return { display: String(isoStr), spoken: '' };
    }

    try {
        const parts = new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: false
        }).formatToParts(dt);

        const getPart = (type) => parts.find(p => p.type === type)?.value || '';
        const year = getPart('year');
        const month = getPart('month');
        const day = getPart('day');
        const rawHour = parseInt(getPart('hour'), 10);
        const hour = isNaN(rawHour) ? 0 : (rawHour === 24 ? 0 : rawHour);
        const minuteStr = getPart('minute');
        const minute = parseInt(minuteStr, 10) || 0;

        const display = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (北京时间)`;
        const minuteSpoken = minute === 0 ? '整' : `${minute}分`;
        const spoken = `${month}月${day}日${hour}点${minuteSpoken}`;
        return { display, spoken };
    } catch (_) {
        return { display: dt.toISOString(), spoken: '' };
    }
}

/**
 * 清洗文本中的 Markdown 标记、`[NEWS_k]` 引注角标、HTML 标签与裸 URL，使其适合智能音箱 TTS 自然朗读
 */
function cleanTextForTts(rawText = '') {
    if (!rawText || typeof rawText !== 'string') return '';

    const lines = rawText.replace(/\r\n/g, '\n').split('\n');
    const cleanedParagraphs = [];

    for (const rawLine of lines) {
        let line = rawLine.trim();
        if (!line) continue;

        // 转换 Markdown 标题或方括号小标题为自然口语过渡
        const mdHeading = line.match(/^#{1,6}\s+(.+)$/);
        if (mdHeading) {
            const headingText = cleanInlineForTts(mdHeading[1]);
            if (headingText) {
                cleanedParagraphs.push(/[。！？：:]$/.test(headingText) ? headingText : `${headingText}：`);
            }
            continue;
        }

        const bracketHeading = line.match(/^【(.+?)】$/);
        if (bracketHeading) {
            const headingText = cleanInlineForTts(bracketHeading[1]);
            if (headingText) {
                cleanedParagraphs.push(/[。！？：:]$/.test(headingText) ? headingText : `${headingText}：`);
            }
            continue;
        }

        // 去除无序/有序列表前缀符号
        line = line.replace(/^[-*•]+\s+/, '');
        line = cleanInlineForTts(line);
        if (!line) continue;

        if (!/[。！？；：.!?;:]$/.test(line)) {
            line += '。';
        }
        cleanedParagraphs.push(line);
    }

    return cleanedParagraphs.join('\n');
}

function cleanInlineForTts(str = '') {
    return String(str)
        // 移除 [NEWS_1] 引用角标
        .replace(/\[NEWS_\d+\]/gi, '')
        // 将 Markdown 链接 [文本](url) 替换为纯文本
        .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, '$1')
        // 移除裸 URL
        .replace(/https?:\/\/\S+/gi, '')
        // 移除 HTML 标签
        .replace(/<[^>]+>/g, '')
        // 移除粗体、斜体、行内代码等符号
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/[*_~#]+/g, '')
        // 将英文括号外媒尾缀清理或保留中文说明
        .replace(/\s*\(([A-Za-z0-9\s.&'-]+)\)/g, '')
        // 清理多余空白与重复标点
        .replace(/[ \t]+/g, ' ')
        .replace(/([。！？；，、])\1+/g, '$1')
        .replace(/\s+([。！？；，、：])/g, '$1')
        .trim();
}

/**
 * 将清洗后的口播文本按句号/分号/逗号自然边界切分为不超过 maxChars 的语音分段数组
 * 适配小爱音箱原生 TTS 与 open-xiaoai-bridge 豆包 TTS 单次播报长度限制
 */
function splitIntoTtsSegments(rawText = '', maxChars = DEFAULT_MAX_SEGMENT_CHARS) {
    const limit = Math.max(80, Math.min(800, parseInt(maxChars, 10) || DEFAULT_MAX_SEGMENT_CHARS));
    const cleaned = cleanTextForTts(rawText);
    if (!cleaned) return [];

    // 先按段落与句末标点拆分为原子句
    const atomicUnits = [];
    for (const para of cleaned.split(/\n+/)) {
        const trimmed = para.trim();
        if (!trimmed) continue;
        const sentences = trimmed.match(/[^。！？；!?;\n]+[。！？；!?;]?/g) || [trimmed];
        for (const s of sentences) {
            const unit = s.trim();
            if (!unit) continue;
            if (unit.length <= limit) {
                atomicUnits.push(unit);
            } else {
                // 超长单句按逗号/顿号二次拆分
                const clauses = unit.match(/[^，、,]+[，、,]?/g) || [unit];
                let clauseBuf = '';
                for (const c of clauses) {
                    if (!c) continue;
                    if ((clauseBuf + c).length <= limit) {
                        clauseBuf += c;
                    } else {
                        if (clauseBuf) atomicUnits.push(clauseBuf.trim());
                        if (c.length <= limit) {
                            clauseBuf = c;
                        } else {
                            for (let pos = 0; pos < c.length; pos += limit) {
                                atomicUnits.push(c.slice(pos, pos + limit));
                            }
                            clauseBuf = '';
                        }
                    }
                }
                if (clauseBuf.trim()) atomicUnits.push(clauseBuf.trim());
            }
        }
    }

    const segments = [];
    let current = '';
    for (const unit of atomicUnits) {
        if (!current) {
            current = unit;
            continue;
        }
        const sep = /[：:]$/.test(current) ? '' : '';
        if ((current.length + sep.length + unit.length) <= limit) {
            current = current + sep + unit;
        } else {
            segments.push(current.trim());
            current = unit;
        }
    }
    if (current.trim()) {
        segments.push(current.trim());
    }

    return segments;
}

/**
 * 生成不超过 maxChars 字数的单段精炼口语回复（专供 open-xiaoai-bridge 自动 TTS 模式一次播完）
 */
function buildShortOralReply({ items = [], overviewPlain = '', timeSpoken = '', maxChars = DEFAULT_ORAL_MAX_CHARS }) {
    const limit = Math.max(100, Math.min(600, parseInt(maxChars, 10) || DEFAULT_ORAL_MAX_CHARS));

    if (items.length === 0 && !overviewPlain) {
        return '当前暂无符合条件的精编新闻数据。';
    }

    const prefix = timeSpoken
        ? `聚核要闻简报，更新于${timeSpoken}：`
        : '为您播报最新聚核要闻：';

    if (items.length > 0) {
        let buf = prefix;
        const maxHeadlines = Math.min(items.length, 5);
        let added = 0;
        for (let i = 0; i < maxHeadlines; i++) {
            const item = items[i];
            const firstPoint = Array.isArray(item.keyPoints) && item.keyPoints[0]
                ? cleanInlineForTts(item.keyPoints[0])
                : '';
            const titleClean = cleanInlineForTts(item.title);
            const entry = firstPoint && (buf.length + titleClean.length + firstPoint.length + 14 <= limit && maxHeadlines <= 2)
                ? `第${i + 1}条，${titleClean}，${firstPoint}。`
                : `第${i + 1}条，${titleClean}。`;

            if (buf.length + entry.length <= limit - 12) {
                buf += entry;
                added += 1;
            } else {
                break;
            }
        }

        if (added === 0 && items[0]) {
            const fallback = `${prefix}${cleanInlineForTts(items[0].title)}。`;
            return fallback.slice(0, limit);
        }

        if (items.length > added && buf.length + 12 <= limit) {
            buf += `其余要闻可继续追问。`;
        }
        return buf;
    }

    const combined = `${prefix}${overviewPlain}`;
    if (combined.length <= limit) return combined;
    const clipped = combined.slice(0, limit - 1);
    const lastStop = Math.max(clipped.lastIndexOf('。'), clipped.lastIndexOf('；'), clipped.lastIndexOf('，'));
    return lastStop > prefix.length + 20 ? `${clipped.slice(0, lastStop)}。` : `${clipped}。`;
}

/**
 * 归一化单条新闻为 AI 助手友好的精简结构
 */
function formatBriefingItem(rawItem, oneBasedIndex, includeFullParagraphs = false) {
    const sourceName = typeof rawItem?.source === 'string'
        ? rawItem.source
        : String(rawItem?.source?.name || rawItem?.sourceName || 'Global Media').trim();
    const spokenSource = extractSpokenSourceName(sourceName);
    const title = String(rawItem?.translatedTitle || rawItem?.title || '').trim();
    const originalTitle = String(rawItem?.originalTitle || rawItem?.title || '').trim();
    const summary = String(rawItem?.summary || rawItem?.translatedDescription || rawItem?.description || '').trim();
    const keyPoints = Array.isArray(rawItem?.keyPoints)
        ? rawItem.keyPoints.map(k => String(k || '').trim()).filter(Boolean)
        : (Array.isArray(rawItem?.highlights)
            ? rawItem.highlights.map(k => String(k || '').trim()).filter(Boolean)
            : []);
    const paragraphs = Array.isArray(rawItem?.translatedParagraphs) && rawItem.translatedParagraphs.length > 0
        ? rawItem.translatedParagraphs.map(p => String(p || '').trim()).filter(Boolean)
        : (Array.isArray(rawItem?.paragraphs)
            ? rawItem.paragraphs.map(p => String(p || '').trim()).filter(Boolean)
            : []);
    const relatedSources = Array.isArray(rawItem?.relatedSources)
        ? rawItem.relatedSources.map(r => ({
            name: String(r?.name || '').trim(),
            url: String(r?.url || '').trim()
        })).filter(r => r.name && r.url)
        : [];

    const formatted = {
        index: oneBasedIndex,
        id: String(rawItem?.id || rawItem?.url || `item-${oneBasedIndex}`),
        title,
        originalTitle,
        summary,
        keyPoints,
        region: String(rawItem?.region || '国际').trim(),
        category: String(rawItem?.category || '国际').trim(),
        source: sourceName,
        spokenSource,
        sourceCount: Number(rawItem?.sourceCount) || (1 + relatedSources.length),
        relatedSources,
        publishedAt: rawItem?.publishedAt || null,
        url: String(rawItem?.url || '').trim()
    };

    if (includeFullParagraphs) {
        formatted.paragraphs = paragraphs;
    }

    return formatted;
}

/**
 * 构建供 AI 助手直接展示或阅读的 Markdown 简报
 */
function buildBriefingMarkdown({
    items = [],
    overview = null,
    timeInfo = { display: '' },
    mode = 'mixed',
    filters = {},
    totalAvailable = 0,
    matchedCount = 0
}) {
    const lines = [];
    const headerTitle = mode === 'article' && items[0]
        ? `# ${items[0].title}`
        : '# CoreFeed · 全球要闻精编简报';
    lines.push(headerTitle);

    const metaParts = [];
    if (timeInfo.display) metaParts.push(`更新时间：${timeInfo.display}`);
    if (mode !== 'article') metaParts.push(`精选条目：${items.length} / ${matchedCount || totalAvailable} 条`);
    const activeFilterTags = [
        filters.region ? `地区=${filters.region}` : '',
        filters.category ? `领域=${filters.category}` : '',
        filters.source ? `信源=${filters.source}` : '',
        filters.q ? `关键词="${filters.q}"` : ''
    ].filter(Boolean);
    if (activeFilterTags.length > 0) {
        metaParts.push(`筛选：${activeFilterTags.join('，')}`);
    }
    if (metaParts.length > 0) {
        lines.push(`> ${metaParts.join(' ｜ ')}`);
    }
    lines.push('');

    if (mode === 'article' && items[0]) {
        const art = items[0];
        lines.push(`- **信源**：${art.source}${art.sourceCount > 1 ? `（含 ${art.sourceCount} 家外媒交叉印证）` : ''}`);
        lines.push(`- **分类**：${art.region} · ${art.category}`);
        if (art.url) lines.push(`- **原文链接**：${art.url}`);
        lines.push('');
        if (art.summary) {
            lines.push(`## 核心导语`);
            lines.push(art.summary);
            lines.push('');
        }
        if (art.keyPoints && art.keyPoints.length > 0) {
            lines.push(`## 核心看点`);
            art.keyPoints.forEach(kp => lines.push(`- ${kp}`));
            lines.push('');
        }
        if (art.paragraphs && art.paragraphs.length > 0) {
            lines.push(`## 全文精译`);
            art.paragraphs.forEach((p) => {
                lines.push(p);
                lines.push('');
            });
        }
        return lines.join('\n').trim() + '\n';
    }

    const hasActiveFilter = Boolean(filters.region || filters.category || filters.source || filters.q);
    if (overview?.available && (mode === 'summary' || (mode === 'mixed' && !hasActiveFilter))) {
        lines.push(`## ${overview.title || '全球要闻深度综述'}`);
        lines.push('');
        const cleanOverviewMd = String(overview.markdown || '')
            .replace(/\s*\[NEWS_(\d+)\]/g, ' [#$1]')
            .trim();
        lines.push(cleanOverviewMd);
        lines.push('');
    }

    if (mode !== 'summary') {
        lines.push(`## 精选要闻列表`);
        lines.push('');
        if (items.length === 0) {
            lines.push('暂无匹配的精编新闻条目。');
        } else {
            for (const item of items) {
                lines.push(`### ${item.index}. [${item.category}/${item.region}] ${item.title}`);
                lines.push(`- **信源**：${item.source}${item.sourceCount > 1 ? ` (+${item.sourceCount - 1} 家交叉核实)` : ''}`);
                if (item.summary) {
                    lines.push(`- **导语**：${item.summary}`);
                }
                if (item.keyPoints && item.keyPoints.length > 0) {
                    lines.push(`- **看点**：${item.keyPoints.join('；')}`);
                }
                if (item.url) {
                    lines.push(`- **链接**：${item.url}`);
                }
                lines.push('');
            }
        }
    }

    return lines.join('\n').trim() + '\n';
}

/**
 * 根据不同播报模式组装完整的智能音箱口播文稿
 */
function buildFullTtsScript({
    items = [],
    overview = null,
    timeSpoken = '',
    mode = 'mixed',
    filters = {}
}) {
    if (mode === 'article') {
        const art = items[0];
        if (!art) return '未找到指定序号或编号的新闻报道。';
        const parts = [];
        parts.push(`${art.spokenSource}报道：${cleanInlineForTts(art.title)}。`);
        if (Array.isArray(art.paragraphs) && art.paragraphs.length > 0) {
            parts.push(cleanTextForTts(art.paragraphs.join('\n')));
        } else if (art.summary) {
            parts.push(cleanTextForTts(art.summary));
            if (Array.isArray(art.keyPoints) && art.keyPoints.length > 0) {
                parts.push(`核心看点：${art.keyPoints.map(k => cleanInlineForTts(k)).join('；')}。`);
            }
        }
        return parts.join('\n');
    }

    if (mode === 'summary' && overview?.available && overview.plainText) {
        const intro = timeSpoken
            ? `为您播报聚核全球要闻深度综述，更新于${timeSpoken}。`
            : `为您播报聚核全球要闻深度综述。`;
        return `${intro}\n${overview.plainText}\n以上就是今日全球要闻综述。`;
    }

    if (items.length === 0) {
        if (overview?.available && overview.plainText) {
            return overview.plainText;
        }
        return '当前暂无符合筛选条件的精编新闻。';
    }

    const filterDescParts = [
        filters.region || '',
        filters.category || '',
        filters.source || '',
        filters.q ? `关于${filters.q}的` : ''
    ].filter(Boolean);
    const scopeLabel = filterDescParts.length > 0 ? filterDescParts.join('') : '全球';
    const intro = timeSpoken
        ? `为您播报聚核最新${scopeLabel}要闻简报，更新于${timeSpoken}，共${items.length}条重点消息。`
        : `为您播报聚核最新${scopeLabel}要闻简报，共${items.length}条重点消息。`;

    const lines = [intro];
    items.forEach((item, idx) => {
        const num = idx + 1;
        const titleClean = cleanInlineForTts(item.title);
        const summaryClean = cleanInlineForTts(item.summary);
        const leadSentence = summaryClean
            ? (summaryClean.split(/[。！？]/)[0] || '').trim()
            : '';
        // 避免导语首句与标题高度重复时啰嗦复读
        const bodyPart = leadSentence && leadSentence !== titleClean
            ? `${titleClean}。${summaryClean}`
            : (summaryClean || `${titleClean}。`);
        const normalizedBody = /[。！？]$/.test(bodyPart) ? bodyPart : `${bodyPart}。`;
        lines.push(`第${num}条，据${item.spokenSource}消息，${normalizedBody}`);
    });
    lines.push('以上就是本次新闻播报。');

    return lines.join('\n');
}

/**
 * 构建统一的 AI 简报与语音播报响应对象
 */
function buildAiBriefing({
    newsList = [],
    summaryArticle = null,
    lastUpdated = null,
    lastPublishedBy = null,
    query = {}
} = {}) {
    const safeNews = Array.isArray(newsList) ? newsList : [];
    const region = query.region && query.region !== 'all' && query.region !== '全部'
        ? String(query.region).trim()
        : '';
    const category = query.category && query.category !== 'all' && query.category !== '全部'
        ? String(query.category).trim()
        : '';
    const source = query.source && query.source !== 'all' && query.source !== '全部'
        ? String(query.source).trim()
        : '';
    const q = String(query.q || query.keyword || '').trim();
    const qLower = q.toLowerCase();

    const detail = String(query.detail || 'brief').toLowerCase() === 'full' ? 'full' : 'brief';
    const rawMode = String(query.mode || '').toLowerCase().trim();
    const articleRef = query.index !== undefined && query.index !== null && query.index !== ''
        ? String(query.index).trim()
        : (query.id ? String(query.id).trim() : '');

    let mode = ['mixed', 'headlines', 'summary', 'article'].includes(rawMode)
        ? rawMode
        : (articleRef ? 'article' : ((region || category || source || q) ? 'headlines' : 'mixed'));

    const maxSegmentChars = Math.max(
        80,
        Math.min(800, parseInt(query.maxSegmentChars || query.segmentChars, 10) || DEFAULT_MAX_SEGMENT_CHARS)
    );
    const oralMaxChars = Math.max(
        100,
        Math.min(600, parseInt(query.oralMaxChars || query.maxChars, 10) || DEFAULT_ORAL_MAX_CHARS)
    );

    const indexedPool = safeNews.map((item, idx) => ({ raw: item, oneBasedIndex: idx + 1 }));

    let matched = indexedPool;
    if (mode === 'article' && articleRef) {
        const numericIdx = /^\d+$/.test(articleRef) ? parseInt(articleRef, 10) : NaN;
        if (!isNaN(numericIdx) && numericIdx >= 1 && numericIdx <= indexedPool.length) {
            matched = [indexedPool[numericIdx - 1]];
        } else {
            matched = indexedPool.filter(
                entry => String(entry.raw?.id || '') === articleRef || String(entry.raw?.url || '') === articleRef
            );
        }
    } else {
        if (region) {
            matched = matched.filter(e => String(e.raw?.region || '').includes(region));
        }
        if (category) {
            matched = matched.filter(e => String(e.raw?.category || '').includes(category));
        }
        if (source) {
            const srcLower = source.toLowerCase();
            matched = matched.filter(e => {
                const sName = typeof e.raw?.source === 'string'
                    ? e.raw.source
                    : String(e.raw?.source?.name || '');
                return sName.toLowerCase().includes(srcLower);
            });
        }
        if (qLower) {
            matched = matched.filter(({ raw }) => {
                const haystack = [
                    raw?.translatedTitle,
                    raw?.title,
                    raw?.summary,
                    raw?.description,
                    typeof raw?.source === 'string' ? raw.source : raw?.source?.name,
                    ...(Array.isArray(raw?.keyPoints) ? raw.keyPoints : []),
                    ...(Array.isArray(raw?.translatedParagraphs) ? raw.translatedParagraphs : [])
                ]
                    .filter(Boolean)
                    .join(' ')
                    .toLowerCase();
                return haystack.includes(qLower);
            });
        }
    }

    const defaultLimit = mode === 'article' ? 1 : 10;
    const limit = mode === 'article'
        ? 1
        : Math.max(1, Math.min(50, parseInt(query.limit, 10) || defaultLimit));

    const includeFull = detail === 'full' || mode === 'article';
    const sliced = matched.slice(0, limit).map(e => formatBriefingItem(e.raw, e.oneBasedIndex, includeFull));

    const rawOverviewMd = String(summaryArticle?.content || summaryArticle?.markdown || '').trim();
    const overviewPlain = rawOverviewMd ? cleanTextForTts(rawOverviewMd) : '';
    const overview = summaryArticle && (rawOverviewMd || summaryArticle.htmlContent)
        ? {
            available: true,
            title: String(summaryArticle.title || '全球要闻深度综述').trim(),
            markdown: rawOverviewMd,
            plainText: overviewPlain,
            wordCount: Number(summaryArticle.wordCount) || rawOverviewMd.length,
            regions: Array.isArray(summaryArticle.regions) ? summaryArticle.regions : [],
            generatedAt: summaryArticle.generatedAt || lastUpdated || null
        }
        : { available: false, title: '', markdown: '', plainText: '', wordCount: 0, regions: [], generatedAt: null };

    const timeInfo = formatTimestampInfo(lastUpdated || summaryArticle?.generatedAt || null);
    const filters = {
        region: region || null,
        category: category || null,
        source: source || null,
        q: q || null,
        mode,
        detail: includeFull ? 'full' : 'brief',
        limit
    };

    const fullTtsText = buildFullTtsScript({
        items: sliced,
        overview,
        timeSpoken: timeInfo.spoken,
        mode,
        filters
    });
    const segments = splitIntoTtsSegments(fullTtsText, maxSegmentChars);
    const shortText = buildShortOralReply({
        items: sliced,
        overviewPlain,
        timeSpoken: timeInfo.spoken,
        maxChars: oralMaxChars
    });

    const markdown = buildBriefingMarkdown({
        items: sliced,
        overview,
        timeInfo,
        mode,
        filters,
        totalAvailable: safeNews.length,
        matchedCount: matched.length
    });

    return {
        success: true,
        version: '2.0',
        publishedAt: lastUpdated || null,
        lastUpdated: lastUpdated || null,
        lastUpdatedDisplay: timeInfo.display,
        publishedBy: lastPublishedBy || null,
        totalAvailable: safeNews.length,
        matchedCount: matched.length,
        returnedCount: sliced.length,
        filters,
        overview,
        items: sliced,
        markdown,
        tts: {
            mode,
            maxSegmentChars,
            totalChars: fullTtsText.length,
            segmentCount: segments.length,
            shortText,
            fullText: fullTtsText,
            segments
        }
    };
}

/**
 * 为 GitHub `ag-snapshot` 分支构建轻量级 AI 伴生快照文件 (`briefing.json` 与 `briefing.md`)
 * 体积相比 `latest.json` (~1MB) 缩减超过 90%，方便云端或跨网段 AI 助手秒级回退拉取
 */
function buildSnapshotBriefingFiles(snapshotPayload = {}) {
    const newsList = Array.isArray(snapshotPayload.news)
        ? snapshotPayload.news
        : (Array.isArray(snapshotPayload.articles) ? snapshotPayload.articles : []);
    const summaryArticle = snapshotPayload.summaryArticle || snapshotPayload.summary || null;
    const publishedAt = snapshotPayload.publishedAt || snapshotPayload.lastUpdated || new Date().toISOString();
    const publishedBy = snapshotPayload.publishedBy || snapshotPayload.clientId || null;

    const fullBriefing = buildAiBriefing({
        newsList,
        summaryArticle,
        lastUpdated: publishedAt,
        lastPublishedBy: publishedBy,
        query: {
            limit: newsList.length || 30,
            mode: 'mixed',
            detail: 'full',
            maxSegmentChars: DEFAULT_MAX_SEGMENT_CHARS
        }
    });

    const summaryTts = buildAiBriefing({
        newsList,
        summaryArticle,
        lastUpdated: publishedAt,
        lastPublishedBy: publishedBy,
        query: {
            limit: 5,
            mode: 'summary',
            maxSegmentChars: DEFAULT_MAX_SEGMENT_CHARS
        }
    }).tts;

    const top5HeadlinesTts = buildAiBriefing({
        newsList,
        summaryArticle,
        lastUpdated: publishedAt,
        lastPublishedBy: publishedBy,
        query: {
            limit: 5,
            mode: 'headlines',
            maxSegmentChars: DEFAULT_MAX_SEGMENT_CHARS
        }
    }).tts;

    const briefingPayload = {
        version: '2.0',
        publishedAt,
        lastUpdated: publishedAt,
        lastUpdatedDisplay: fullBriefing.lastUpdatedDisplay,
        publishedBy,
        articleCount: fullBriefing.items.length,
        overview: fullBriefing.overview,
        ttsPresets: {
            top5Headlines: top5HeadlinesTts,
            summary: summaryTts
        },
        items: fullBriefing.items
    };

    return {
        briefingPayload,
        briefingJson: JSON.stringify(briefingPayload, null, 2) + '\n',
        briefingMarkdown: fullBriefing.markdown
    };
}

module.exports = {
    DEFAULT_MAX_SEGMENT_CHARS,
    DEFAULT_ORAL_MAX_CHARS,
    extractSpokenSourceName,
    formatTimestampInfo,
    cleanTextForTts,
    cleanInlineForTts,
    splitIntoTtsSegments,
    buildShortOralReply,
    formatBriefingItem,
    buildAiBriefing,
    buildSnapshotBriefingFiles
};
