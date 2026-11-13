/**
 * CoreFeed v2.0 — 纯数据结构化校验、跨源元数据归并与综述引注 HTML 渲染工具 (utils/editorial_formatter.js)
 *
 * 设计原则：
 *   本模块仅提供确定性的数据校验、同事件跨源链接归并（按大模型指定的分组）及 Markdown `[NEWS_k]` 锚点 HTML 转换；
 *   不包含任何机器翻译、规则打分、正则分类或模板拼接逻辑（所有采编、提取、翻译与综述工作 100% 由 Antigravity 客户端内置大模型完成）。
 */

const VALID_REGIONS = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '澳洲', '亚洲', '国际'];
const VALID_CATEGORIES = ['政经', '外交', '科技', '财经', '军事', '社会', '能源', '国际'];

function hasChineseText(text, minChars = 1) {
    if (!text || typeof text !== 'string') return false;
    const matches = text.match(/[\u4e00-\u9fff]/g);
    return Boolean(matches && matches.length >= minChars);
}

function normalizeRegion(rawRegion, fallback = '国际') {
    if (!rawRegion) return VALID_REGIONS.includes(fallback) ? fallback : '国际';
    const str = String(rawRegion).trim();
    if (VALID_REGIONS.includes(str)) return str;
    return VALID_REGIONS.find(r => str.includes(r)) || (VALID_REGIONS.includes(fallback) ? fallback : '国际');
}

function normalizeCategory(rawCategory, fallback = '国际') {
    if (!rawCategory) return VALID_CATEGORIES.includes(fallback) ? fallback : '国际';
    const str = String(rawCategory).trim();
    if (VALID_CATEGORIES.includes(str)) return str;
    return VALID_CATEGORIES.find(c => str.includes(c)) || (VALID_CATEGORIES.includes(fallback) ? fallback : '国际');
}

function splitTextIntoParagraphs(rawText = '') {
    if (!rawText || typeof rawText !== 'string') return [];
    return rawText
        .replace(/\r\n/g, '\n')
        .split(/\n+/)
        .map(p => p.trim())
        .filter(p => p.length >= 10);
}

/**
 * 按大模型识别的同事件分组，将关联候选文章的信源信息与备用题图合并到主文章中
 */
function mergeClusterArticles(primaryArticle, companionArticles = []) {
    if (!primaryArticle) return null;
    const companions = Array.isArray(companionArticles) ? companionArticles.filter(Boolean) : [];
    if (companions.length === 0) {
        const existingRel = Array.isArray(primaryArticle.relatedSources) ? primaryArticle.relatedSources : [];
        return {
            ...primaryArticle,
            relatedSources: existingRel,
            sourceCount: Number(primaryArticle.sourceCount) || (1 + existingRel.length)
        };
    }

    const primarySourceName = String(primaryArticle.source?.name || '').trim();
    const primaryUrl = String(primaryArticle.url || '').trim();
    const seenUrls = new Set(primaryUrl ? [primaryUrl] : []);
    const seenNames = new Set(primarySourceName ? [primarySourceName.toLowerCase()] : []);
    const relatedSources = [];

    const pushRelated = (srcItem) => {
        if (!srcItem) return;
        const name = String(srcItem.name || srcItem.source?.name || '').trim();
        const url = String(srcItem.url || '').trim();
        if (!name || !url) return;
        if (seenUrls.has(url) || seenNames.has(name.toLowerCase())) return;
        seenUrls.add(url);
        seenNames.add(name.toLowerCase());
        relatedSources.push({
            name,
            url,
            title: String(srcItem.title || '').trim(),
            publishedAt: srcItem.publishedAt || null
        });
    };

    if (Array.isArray(primaryArticle.relatedSources)) {
        primaryArticle.relatedSources.forEach(pushRelated);
    }

    let bestImage = primaryArticle.urlToImage || null;
    for (const comp of companions) {
        if (!bestImage && comp.urlToImage) {
            bestImage = comp.urlToImage;
        }
        pushRelated({
            name: comp.source?.name || comp.sourceName || 'Global Media',
            url: comp.url,
            title: comp.title,
            publishedAt: comp.publishedAt
        });
        if (Array.isArray(comp.relatedSources)) {
            comp.relatedSources.forEach(pushRelated);
        }
    }

    return {
        ...primaryArticle,
        urlToImage: bestImage,
        relatedSources,
        sourceCount: 1 + relatedSources.length
    };
}

function escapeHtmlBasic(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 将大模型撰写的《全球要闻深度综述》Markdown 文本与 `[NEWS_k]` 角标渲染为富文本 HTML
 */
function convertSummaryToRichHtml(text, newsData = []) {
    if (!text || typeof text !== 'string') return '';
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const htmlBlocks = [];

    const renderInline = (lineStr) => {
        let escaped = escapeHtmlBasic(lineStr);
        escaped = escaped.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        escaped = escaped.replace(/(?:\[NEWS_(\d+)\])+/g, (fullMatch) => {
            const nums = [...fullMatch.matchAll(/\[NEWS_(\d+)\]/g)].map(m => parseInt(m[1], 10));
            return nums
                .map((num) => {
                    const article = newsData[num - 1];
                    if (!article || !article.url) return '';
                    const targetUrl = escapeHtmlBasic(article.url);
                    const srcName = escapeHtmlBasic(
                        article.source?.name ? article.source.name.split('(')[0].trim() : '原文'
                    );
                    const sourceTitle = escapeHtmlBasic(article.translatedTitle || article.title || '');
                    return ` <a href="${targetUrl}" target="_blank" rel="noopener noreferrer" class="news-ref-link" data-news-index="${num - 1}" title="${sourceTitle}">[${srcName}]</a>`;
                })
                .join('');
        });
        return escaped;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
        if (hMatch) {
            htmlBlocks.push(`<h3 class="summary-section-title">${renderInline(hMatch[2].replace(/\*\*/g, '').trim())}</h3>`);
            continue;
        }

        const bracketHeading = line.match(/^【(.+?)】(.*)$/);
        if (bracketHeading && !bracketHeading[2].trim()) {
            htmlBlocks.push(`<h3 class="summary-section-title">${renderInline(bracketHeading[1].trim())}</h3>`);
            continue;
        }

        const bulletMatch = line.match(/^[-*•]\s+(.+)$/);
        if (bulletMatch) {
            htmlBlocks.push(`<p class="summary-paragraph summary-bullet">• ${renderInline(bulletMatch[1].trim())}</p>`);
            continue;
        }

        htmlBlocks.push(`<p class="summary-paragraph">${renderInline(line)}</p>`);
    }

    return htmlBlocks.join('\n');
}

/**
 * 将大模型撰写的综述 Markdown 包装为标准 summaryArticle 对象
 */
function createSummaryArticleObject(articleContent, newsData = [], currentDate = '') {
    const raw = String(articleContent || '').replace(/\r\n/g, '\n').trim();
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

    let title = `${currentDate} 全球要闻深度综述`.trim();
    let bodyLines = lines;

    if (lines.length > 1) {
        const first = lines[0];
        const isSectionHeader = /^#{2,4}\s+/.test(first) || /^【.+】$/.test(first);
        if (!isSectionHeader && first.length <= 60) {
            title = first.replace(/^#\s+/, '').replace(/^\*\*(.+)\*\*$/, '$1').trim();
            bodyLines = lines.slice(1);
        }
    }

    const content = bodyLines.join('\n\n');
    const htmlContent = convertSummaryToRichHtml(content, newsData);
    const plainSummary = content
        .replace(/\[NEWS_\d+\]/g, '')
        .replace(/#+\s*/g, '')
        .replace(/\*\*/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);

    const regions = [...new Set((newsData || []).map(n => n?.region).filter(Boolean))];

    return {
        title,
        content,
        htmlContent,
        newsCount: Array.isArray(newsData) ? newsData.length : 0,
        regions: regions.length > 0 ? regions : ['国际'],
        generatedAt: new Date().toISOString(),
        summary: plainSummary,
        wordCount: content.length
    };
}

module.exports = {
    VALID_REGIONS,
    VALID_CATEGORIES,
    hasChineseText,
    normalizeRegion,
    normalizeCategory,
    splitTextIntoParagraphs,
    mergeClusterArticles,
    convertSummaryToRichHtml,
    createSummaryArticleObject
};
