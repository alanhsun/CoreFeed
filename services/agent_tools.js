/**
 * 聚核 CoreFeed v2.0 — 全球信源 RSS/Atom 抓取与题图智能提取工具集 (services/agent_tools.js)
 *
 * 核心能力：
 *   1. 多级容错信源采集 (`fetchFromGlobalSource`)：官方主/备 RSS -> Google News 站点代理 -> Jina Reader 列表兜底
 *   2. 高清题图提取与分辨率升级 (`extractImageFromItem`, `fetchArticleLeadImage`, `searchNewsImageByTitle`, `upgradeImageResolution`)
 */
const axios = require('axios');
const https = require('https');
const Parser = require('rss-parser');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { stripHtml, truncateText, isValidUrl, SimpleCache } = require('../utils/helpers');
const { getSourceAuthorityScore } = require('../config/global_sources');

const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const parser = new Parser({
    timeout: 10000,
    customFields: {
        feed: ['language', 'copyright'],
        item: [
            ['media:content', 'mediaContent', { keepArray: true }],
            ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
            'media:group',
            ['enclosure', 'enclosures', { keepArray: true }],
            'enclosure',
            'itunes:image',
            'content:encoded',
            ['description', 'rawDescription'],
            ['summary', 'rawSummary'],
            ['image', 'itemImage'],
            ['thumb', 'itemThumb'],
            ['News:Image', 'bingNewsImage'],
            'source'
        ]
    }
});

// 题图与标题搜图缓存（TTL 6小时）
const imageLookupCache = new SimpleCache(400, 6 * 60 * 60 * 1000);

/**
 * 生成文章唯一ID
 */
function createArticleId(url, title = '') {
    const raw = (url || title || Math.random().toString()).trim();
    return crypto.createHash('md5').update(raw).digest('hex').substring(0, 12);
}

/**
 * 清理 Google News 或 RSS 标题末尾自带的 " - Source Name" 后缀
 */
function cleanHeadlineSuffix(title = '') {
    if (!title) return '';
    let cleaned = title.trim();
    cleaned = cleaned.replace(/\s+[-|—]\s+[A-Za-z0-9\s.&'()/\u4e00-\u9fa5]{2,35}$/, '').trim();
    return cleaned || title.trim();
}

/**
 * 预清理可能存在未转义字符的 XML 文本
 */
function sanitizeXmlString(xml = '') {
    if (!xml || typeof xml !== 'string') return '';
    return xml
        .replace(/^\uFEFF/, '')
        .replace(/&(?!(?:apos|quot|[gl]t|amp);|#)/g, '&amp;')
        .trim();
}

/**
 * 将外媒常见的低清缩略图 URL 自动升级为高清大图 URL
 */
function upgradeImageResolution(url) {
    if (!url || typeof url !== 'string') return url;
    let upgraded = url.trim();

    // 1. BBC iChef CDN: /standard/240/ 或 /news/240/ -> /standard/800/
    if (upgraded.includes('ichef.bbci.co.uk')) {
        upgraded = upgraded
            .replace(/\/(ace\/standard|news)\/(?:144|200|240|320|464|480)\//i, '/$1/800/');
    }

    // 2. New York Times: -moth.jpg / -thumbStandard.jpg / -thumbLarge.jpg -> -articleLarge.jpg
    if (upgraded.includes('static01.nyt.com/images/')) {
        upgraded = upgraded.replace(/-(?:moth(?:-v\d+)?|thumbStandard(?:-v\d+)?|thumbLarge(?:-v\d+)?|mediumSquare149)\.(jpg|jpeg|png|webp)/i, '-articleLarge.$1');
    }

    // 3. Bing News Thumbnail: 补充高清 16:9 尺寸参数
    if (upgraded.includes('bing.com/th') && !/[?&]w=\d+/i.test(upgraded)) {
        upgraded += (upgraded.includes('?') ? '&' : '?') + 'w=720&h=405&c=7';
    }

    return upgraded;
}

/**
 * 校验并规范化图片 URL（过滤 tracking pixel / logo / icon，并自动升级分辨率）
 */
function normalizeValidImageUrl(rawUrl, baseUrl = null) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let cleaned = rawUrl
        .trim()
        .replace(/&amp;/g, '&')
        .replace(/^\/\//, 'https://');

    if (baseUrl && !/^https?:\/\//i.test(cleaned)) {
        try {
            cleaned = new URL(cleaned, baseUrl).href;
        } catch (_) {
            return null;
        }
    }

    if (!isValidUrl(cleaned)) return null;
    if (/\b(1x1|pixel|tracker|spacer|avatar|logo|favicon|badge|sprite|blank\.gif|feedburner|doubleclick|googlesyndication|gravatar)\b/i.test(cleaned)) {
        return null;
    }
    if (/\.(svg|ico)(\?|$)/i.test(cleaned)) return null;
    return upgradeImageResolution(cleaned);
}

/**
 * 从一组 media 节点中选择分辨率最高（width 最大）的有效图片 URL
 */
function pickBestMediaImage(nodeList, baseUrl = null) {
    if (!Array.isArray(nodeList) || nodeList.length === 0) return null;
    let bestUrl = null;
    let bestWidth = -1;

    for (const node of nodeList) {
        if (!node) continue;
        const attrs = node['$'] || node;
        const medium = String(attrs.medium || '').toLowerCase();
        const type = String(attrs.type || '').toLowerCase();
        if (medium === 'video' || medium === 'audio' || type.startsWith('video/') || type.startsWith('audio/')) {
            continue;
        }
        const rawUrl = attrs.url || attrs.href || (typeof node === 'string' ? node : null);
        const valid = normalizeValidImageUrl(rawUrl, baseUrl);
        if (!valid) continue;

        const w = parseInt(attrs.width, 10) || 0;
        if (w > bestWidth) {
            bestWidth = w;
            bestUrl = valid;
        }
    }
    return bestUrl;
}

/**
 * 从 HTML 片段中遍历所有 <img> 标签（含 src / data-src / srcset）提取第一张有效新闻配图
 */
function extractFirstValidImgFromHtml(html, baseUrl = null) {
    if (!html || typeof html !== 'string' || !html.includes('<img')) return null;

    const imgTagRegex = /<img\b[^>]*>/gi;
    let tagMatch;
    while ((tagMatch = imgTagRegex.exec(html)) !== null) {
        const tag = tagMatch[0];
        if (/\b(?:width|height)=["']?[12]\b/i.test(tag)) continue;

        // 优先尝试单属性 URL
        const attrMatch = tag.match(/\b(?:data-src|data-original|data-lazy-src|src)=["']([^"']+)["']/i);
        if (attrMatch && attrMatch[1]) {
            const valid = normalizeValidImageUrl(attrMatch[1], baseUrl);
            if (valid) return valid;
        }

        // 尝试从 srcset 中提取最高分辨率 URL
        const srcsetMatch = tag.match(/\b(?:data-srcset|srcset)=["']([^"']+)["']/i);
        if (srcsetMatch && srcsetMatch[1]) {
            const candidates = srcsetMatch[1]
                .split(',')
                .map(part => part.trim().split(/\s+/)[0])
                .filter(Boolean);
            for (let i = candidates.length - 1; i >= 0; i--) {
                const valid = normalizeValidImageUrl(candidates[i], baseUrl);
                if (valid) return valid;
            }
        }
    }
    return null;
}

/**
 * 从 RSS/Atom Item 多维度提取最高质量的新闻配图
 */
function extractImageFromItem(item, baseUrl = null) {
    if (!item) return null;

    // 1. Bing News / 专用图片字段
    if (item.bingNewsImage) {
        const valid = normalizeValidImageUrl(
            typeof item.bingNewsImage === 'string' ? item.bingNewsImage : item.bingNewsImage?.['$']?.url || item.bingNewsImage?._,
            baseUrl
        );
        if (valid) return valid;
    }

    // 2. media:content 数组或单对象（自动挑最大 width，适配卫报/纽时等）
    const mcList = item.mediaContent || (item['media:content'] ? [item['media:content']] : []);
    const bestMc = pickBestMediaImage(mcList, baseUrl);
    if (bestMc) return bestMc;

    // 3. media:thumbnail 数组或单对象（自动挑最大 width，适配 BBC/Sky/CNA 等）
    const mtList = item.mediaThumbnail || (item['media:thumbnail'] ? [item['media:thumbnail']] : []);
    const bestMt = pickBestMediaImage(mtList, baseUrl);
    if (bestMt) return bestMt;

    // 4. media:group 嵌套结构
    const mg = item['media:group'];
    if (mg) {
        const groupContent = Array.isArray(mg['media:content']) ? mg['media:content'] : (mg['media:content'] ? [mg['media:content']] : []);
        const bestGroupMc = pickBestMediaImage(groupContent, baseUrl);
        if (bestGroupMc) return bestGroupMc;

        const groupThumb = Array.isArray(mg['media:thumbnail']) ? mg['media:thumbnail'] : (mg['media:thumbnail'] ? [mg['media:thumbnail']] : []);
        const bestGroupMt = pickBestMediaImage(groupThumb, baseUrl);
        if (bestGroupMt) return bestGroupMt;
    }

    // 5. enclosures 数组或单个 enclosure 附件 (适配明镜周刊、France24、WSJ 等)
    const encList = Array.isArray(item.enclosures)
        ? item.enclosures
        : (item.enclosure ? [item.enclosure] : []);
    const bestEnc = pickBestMediaImage(encList, baseUrl);
    if (bestEnc) return bestEnc;

    // 6. itemImage / itemThumb / itunes:image
    for (const field of [item.itemImage, item.itemThumb, item['itunes:image']]) {
        if (!field) continue;
        const raw = typeof field === 'string'
            ? field
            : (field?.['$']?.url || field?.['$']?.href || field?.url || field?.href || field?._);
        const valid = normalizeValidImageUrl(raw, baseUrl);
        if (valid) return valid;
    }

    // 7. 从 HTML 内容 (content:encoded / content / rawDescription / description / rawSummary / summary) 遍历所有 <img>
    const htmlBlocks = [
        item['content:encoded'],
        item.content,
        item.rawDescription,
        item.description,
        item.rawSummary,
        item.summary
    ].filter(Boolean).join(' ');

    const htmlImg = extractFirstValidImgFromHtml(htmlBlocks, baseUrl);
    if (htmlImg) return htmlImg;

    return null;
}

/**
 * 解析单个 RSS URL（优先使用 axios 获取并清洗 XML，再交由 rss-parser 解析）
 */
async function parseRssUrlRobust(rssUrl, timeout = 10000) {
    try {
        const response = await axios.get(rssUrl, {
            timeout,
            httpsAgent: httpsAgentIgnoreTls,
            headers: {
                'User-Agent': config.webScraping.userAgent,
                'Accept': 'application/rss+xml, application/xml, text/xml, application/atom+xml, */*'
            },
            responseType: 'text'
        });
        const cleanXml = sanitizeXmlString(response.data);
        return await parser.parseString(cleanXml);
    } catch (firstErr) {
        return await parser.parseURL(rssUrl);
    }
}

/**
 * 构造 Google News 定向域名 RSS 检索 URL（用于突破 Cloudflare 或无 RSS 知名站点）
 */
function buildGoogleNewsDomainRssUrl(domain, when = '24h', hl = 'en-US', gl = 'US', ceid = 'US:en') {
    const query = encodeURIComponent(`when:${when} site:${domain}`);
    return `https://news.google.com/rss/search?q=${query}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

/**
 * 采集单个全球知名信源 (支持主 RSS + 备用官方 RSS + Google News 站点代理 + Jina 列表抽取)
 */
async function fetchFromGlobalSource(source, maxItemsOverride = null) {
    const maxItems = maxItemsOverride || source.maxArticles || config.news.maxArticlesPerSource || 5;
    const sourceName = source.name || source.id || '未知信源';

    let feed = null;
    let usedStrategy = source.strategy || 'rss';

    try {
        if (source.rssUrl) {
            feed = await parseRssUrlRobust(source.rssUrl, 10000);
        } else if (source.domain) {
            usedStrategy = 'gnews_proxy';
            const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '24h');
            feed = await parseRssUrlRobust(proxyUrl, 10000);
        }
    } catch (rssError) {
        // 优先尝试该信源配置的备用官方 RSS (backupRssUrl)
        if (source.backupRssUrl) {
            try {
                usedStrategy = 'backup_rss';
                feed = await parseRssUrlRobust(source.backupRssUrl, 10000);
            } catch (_) {}
        }

        // 若仍未成功且配置了 domain，降级到 Google News Domain Proxy
        if ((!feed || !Array.isArray(feed.items) || feed.items.length === 0) && source.domain && config.agent.enableGoogleNewsFallback !== false) {
            try {
                usedStrategy = 'gnews_proxy_fallback';
                const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '24h');
                logger.debug('AGENT_TOOL', `${sourceName} 直接RSS受阻，自动切换 Google News 站点代理: site:${source.domain}`);
                feed = await parseRssUrlRobust(proxyUrl, 10000);
            } catch (fallbackErr) {
                logger.warn('AGENT_TOOL', `${sourceName} 代理采集亦失败: ${fallbackErr.message}`);
            }
        } else if (!feed) {
            logger.warn('AGENT_TOOL', `${sourceName} RSS采集失败: ${rssError.message}`);
        }
    }

    // 如果 RSS/Proxy 成功拿到条目
    if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        const items = feed.items.slice(0, maxItems);
        const articles = [];

        for (const item of items) {
            if (!item.title || !item.link) continue;

            const rawContent = item['content:encoded'] || item.content || item.rawDescription || item.contentSnippet || item.summary || item.description || '';
            const rawDesc = item.contentSnippet || item.summary || item.rawDescription || item.description || rawContent || '';

            let cleanDesc = stripHtml(rawDesc);
            let cleanContent = stripHtml(rawContent);

            const cleanTitle = cleanHeadlineSuffix(item.title);
            if (cleanDesc && cleanDesc.startsWith(cleanTitle)) {
                cleanDesc = cleanDesc.substring(cleanTitle.length).replace(/^[\s\-|—:]+/, '').trim();
            }
            if (!cleanDesc || cleanDesc.length < 15) {
                cleanDesc = cleanTitle;
            }

            const baseUrl = source.url || item.link;
            const extractedImg = extractImageFromItem(item, baseUrl);

            articles.push({
                id: createArticleId(item.link, cleanTitle),
                title: cleanTitle,
                description: truncateText(cleanDesc, 500),
                content: truncateText(cleanContent || cleanDesc, 2500),
                url: item.link,
                urlToImage: extractedImg,
                publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                source: {
                    id: source.id || null,
                    name: sourceName,
                    domain: source.domain || null,
                    category: source.category || 'global',
                    authority: source.authority || getSourceAuthorityScore(sourceName),
                    strategy: usedStrategy
                },
                author: item.creator || item.author || null,
                region: source.region || null
            });
        }

        return articles;
    }

    // 如果没有 RSS 且开启了 Jina Reader，尝试通过 Jina 抓取列表页
    if (source.url && config.agent.jinaReaderEnabled) {
        try {
            return await scrapeSourceListViaJina(source, maxItems);
        } catch (jinaErr) {
            logger.warn('AGENT_TOOL', `${sourceName} Jina列表采集失败: ${jinaErr.message}`);
        }
    }

    return [];
}

/**
 * 使用 Jina Reader 抓取新闻栏目页中的文章列表
 */
async function scrapeSourceListViaJina(source, maxItems = 5) {
    const jinaUrl = `https://r.jina.ai/${source.url}`;
    const headers = {
        'Accept': 'text/plain',
        'X-Return-Format': 'markdown'
    };
    if (config.agent.jinaApiKey) {
        headers['Authorization'] = `Bearer ${config.agent.jinaApiKey}`;
    }

    const response = await axios.get(jinaUrl, { timeout: 15000, headers, httpsAgent: httpsAgentIgnoreTls });
    const markdown = String(response.data || '');
    if (!markdown) return [];

    const linkRegex = /\[([^\]]{18,160})\]\((https?:\/\/[^\s)]+)\)/g;
    const seenUrls = new Set();
    const articles = [];
    let match;

    while ((match = linkRegex.exec(markdown)) !== null && articles.length < maxItems) {
        const rawTitle = match[1].replace(/\s+/g, ' ').trim();
        const link = match[2].trim();

        if (
            seenUrls.has(link) ||
            /\/(login|signup|subscribe|privacy|terms|about|contact|author|tag|topic)\b/i.test(link) ||
            rawTitle.includes('![')
        ) {
            continue;
        }
        seenUrls.add(link);

        articles.push({
            id: createArticleId(link, rawTitle),
            title: cleanHeadlineSuffix(rawTitle),
            description: rawTitle,
            content: rawTitle,
            url: link,
            urlToImage: null,
            publishedAt: new Date().toISOString(),
            source: {
                id: source.id || 'jina-web',
                name: source.name || new URL(source.url).hostname,
                domain: source.domain || null,
                category: source.category || 'global',
                authority: source.authority || getSourceAuthorityScore(source.name),
                strategy: 'jina_scrape'
            },
            author: null,
            region: source.region || null
        });
    }

    return articles;
}

/**
 * 轻量级快速抓取文章 og:image / twitter:image / JSON-LD 封面图
 * （移除会导致部分 CDN 返回 416 错误的 Range 请求头，改用标准 HTML 读取）
 */
async function fetchArticleLeadImage(url, timeout = 5500) {
    if (!url || !isValidUrl(url) || url.includes('news.google.com/rss/articles/')) {
        return null;
    }

    const cached = imageLookupCache.get(`url:${url}`);
    if (cached) return cached;

    try {
        const response = await axios.get(url, {
            timeout,
            maxRedirects: 5,
            maxContentLength: 450 * 1024,
            httpsAgent: httpsAgentIgnoreTls,
            headers: {
                'User-Agent': config.webScraping.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
            },
            responseType: 'text'
        });

        const html = String(response.data || '');
        if (!html) return null;
        const resolvedUrl = response.request?.res?.responseUrl || url;

        // 1. 正则快速匹配 <meta property="og:image" / "twitter:image">
        const metaMatch =
            html.match(/<meta[^>]+property=["']og:image(?::secure_url|:url)?["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url|:url)?["']/i) ||
            html.match(/<meta[^>]+(?:name|property)=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']twitter:image(?::src)?["']/i) ||
            html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i);

        if (metaMatch && metaMatch[1]) {
            const valid = normalizeValidImageUrl(metaMatch[1], resolvedUrl);
            if (valid) {
                imageLookupCache.set(`url:${url}`, valid);
                return valid;
            }
        }

        // 2. 匹配 JSON-LD 中的 "thumbnailUrl" 或 "image":{"url":"..."}
        const jsonLdImgMatch =
            html.match(/"thumbnailUrl"\s*:\s*"(https?:\/\/[^"]+)"/i) ||
            html.match(/"image"\s*:\s*\{\s*"@type"\s*:\s*"ImageObject"[^}]*"url"\s*:\s*"(https?:\/\/[^"]+)"/i) ||
            html.match(/"image"\s*:\s*"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/i);

        if (jsonLdImgMatch && jsonLdImgMatch[1]) {
            const valid = normalizeValidImageUrl(jsonLdImgMatch[1].replace(/\\u002F/gi, '/').replace(/\\\//g, '/'), resolvedUrl);
            if (valid) {
                imageLookupCache.set(`url:${url}`, valid);
                return valid;
            }
        }

        // 3. 从正文区域提取首张有效大图
        const bodyImg = extractFirstValidImgFromHtml(html, resolvedUrl);
        if (bodyImg) {
            imageLookupCache.set(`url:${url}`, bodyImg);
            return bodyImg;
        }
    } catch (_) {}

    return null;
}

/**
 * 通过 Bing News RSS 按新闻标题智能检索匹配的高清新闻配图
 * （专用于解决 Reuters GoogleNews 重定向链接、Bloomberg/AlJazeera 等无原生 RSS 图片的痛点）
 */
async function searchNewsImageByTitle(title, sourceDomain = '', timeout = 4500) {
    if (!title || typeof title !== 'string' || title.trim().length < 8) return null;

    const cleanQuery = title
        .replace(/[^\w\u4e00-\u9fa5\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .slice(0, 10)
        .join(' ');

    if (!cleanQuery) return null;

    const cacheKey = `title:${cleanQuery.toLowerCase()}`;
    const cached = imageLookupCache.get(cacheKey);
    if (cached) return cached;

    try {
        const searchUrl = `https://www.bing.com/news/search?q=${encodeURIComponent(cleanQuery)}&format=rss`;
        const response = await axios.get(searchUrl, {
            timeout,
            httpsAgent: httpsAgentIgnoreTls,
            headers: {
                'User-Agent': config.webScraping.userAgent,
                'Accept': 'application/rss+xml, application/xml, text/xml, */*'
            },
            responseType: 'text'
        });

        const xml = String(response.data || '');
        if (!xml) return null;

        // 提取 <News:Image>... 或 <media:content url="...">
        const newsImgMatch =
            xml.match(/<News:Image>([^<]+)<\/News:Image>/i) ||
            xml.match(/<media:content[^>]+url=["']([^"']+)["']/i) ||
            xml.match(/<enclosure[^>]+url=["']([^"']+)["']/i);

        if (newsImgMatch && newsImgMatch[1]) {
            const valid = normalizeValidImageUrl(newsImgMatch[1]);
            if (valid) {
                imageLookupCache.set(cacheKey, valid);
                return valid;
            }
        }
    } catch (_) {}

    return null;
}

module.exports = {
    createArticleId,
    cleanHeadlineSuffix,
    normalizeValidImageUrl,
    upgradeImageResolution,
    parseRssUrlRobust,
    buildGoogleNewsDomainRssUrl,
    fetchFromGlobalSource,
    fetchArticleLeadImage,
    searchNewsImageByTitle
};
