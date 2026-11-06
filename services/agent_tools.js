const axios = require('axios');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { stripHtml, truncateText, isValidUrl, SimpleCache } = require('../utils/helpers');
const { getSourceAuthorityScore } = require('../config/global_sources');

const parser = new Parser({
    timeout: 10000,
    customFields: {
        feed: ['language', 'copyright'],
        item: ['media:content', 'media:thumbnail', 'enclosure', 'content:encoded', 'source']
    }
});

// 全文提取缓存（避免重复抓取同一URL，TTL 2小时）
const fullTextCache = new SimpleCache(300, 2 * 60 * 60 * 1000);

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
 * 从 RSS Item 提取图片
 */
function extractImageFromItem(item) {
    if (!item) return null;
    if (item['media:content']?.['$']?.url) return item['media:content']['$'].url;
    if (item['media:thumbnail']?.['$']?.url) return item['media:thumbnail']['$'].url;
    if (item.enclosure?.url && (!item.enclosure.type || item.enclosure.type.startsWith('image/'))) {
        return item.enclosure.url;
    }
    const html = item['content:encoded'] || item.content || item.description || '';
    if (typeof html === 'string' && html.includes('<img')) {
        const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
        if (match && isValidUrl(match[1])) return match[1];
    }
    return null;
}

/**
 * 解析单个 RSS URL（优先使用 axios 获取并清洗 XML，再交由 rss-parser 解析）
 */
async function parseRssUrlRobust(rssUrl, timeout = 10000) {
    try {
        const response = await axios.get(rssUrl, {
            timeout,
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
function buildGoogleNewsDomainRssUrl(domain, when = '2d', hl = 'en-US', gl = 'US', ceid = 'US:en') {
    const query = encodeURIComponent(`site:${domain} when:${when}`);
    return `https://news.google.com/rss/search?q=${query}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

/**
 * 工具 1: 采集单个全球知名信源 (支持 RSS + Google News 站点代理自动降级 + Jina 网页解析)
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
            const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '2d');
            feed = await parseRssUrlRobust(proxyUrl, 10000);
        }
    } catch (rssError) {
        // 如果直接 RSS 失败且配置了 domain，自动降级到 Google News Domain Proxy
        if (source.domain && config.agent.enableGoogleNewsFallback !== false) {
            try {
                usedStrategy = 'gnews_proxy_fallback';
                const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '2d');
                logger.debug('AGENT_TOOL', `${sourceName} 直接RSS受阻，自动切换 Google News 站点代理: site:${source.domain}`);
                feed = await parseRssUrlRobust(proxyUrl, 10000);
            } catch (fallbackErr) {
                logger.warn('AGENT_TOOL', `${sourceName} 代理采集亦失败: ${fallbackErr.message}`);
            }
        } else {
            logger.warn('AGENT_TOOL', `${sourceName} RSS采集失败: ${rssError.message}`);
        }
    }

    // 如果 RSS/Proxy 成功拿到条目
    if (feed && Array.isArray(feed.items) && feed.items.length > 0) {
        const items = feed.items.slice(0, maxItems);
        const articles = [];

        for (const item of items) {
            if (!item.title || !item.link) continue;

            const rawContent = item['content:encoded'] || item.content || item.contentSnippet || item.summary || item.description || '';
            const rawDesc = item.contentSnippet || item.summary || item.description || rawContent || '';

            let cleanDesc = stripHtml(rawDesc);
            let cleanContent = stripHtml(rawContent);

            const cleanTitle = cleanHeadlineSuffix(item.title);
            if (cleanDesc && cleanDesc.startsWith(cleanTitle)) {
                cleanDesc = cleanDesc.substring(cleanTitle.length).replace(/^[\s\-|—:]+/, '').trim();
            }
            if (!cleanDesc || cleanDesc.length < 15) {
                cleanDesc = cleanTitle;
            }

            articles.push({
                id: createArticleId(item.link, cleanTitle),
                title: cleanTitle,
                description: truncateText(cleanDesc, 500),
                content: truncateText(cleanContent || cleanDesc, 2500),
                url: item.link,
                urlToImage: extractImageFromItem(item),
                publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                source: {
                    id: source.id || null,
                    name: sourceName,
                    category: source.category || 'global',
                    authority: source.authority || getSourceAuthorityScore(sourceName),
                    strategy: usedStrategy
                },
                author: item.creator || item.author || null,
                region: source.region || null,
                needsDeepRead: (cleanContent || '').length < 250
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

    const response = await axios.get(jinaUrl, { timeout: 15000, headers });
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
                category: source.category || 'global',
                authority: source.authority || getSourceAuthorityScore(source.name),
                strategy: 'jina_scrape'
            },
            author: null,
            region: source.region || null,
            needsDeepRead: true
        });
    }

    return articles;
}

/**
 * 工具 2: 提取单篇新闻全文 (Jina Reader 优先 + 本地 Cheerio Readability 回退)
 * @param {string} url - 新闻原文链接
 * @param {Object} options - 选项
 * @returns {Promise<Object>} { success, title, content, publishedTime, excerpt, method }
 */
async function extractFullArticleContent(url, options = {}) {
    if (!url || !isValidUrl(url)) {
        return { success: false, error: '无效的URL' };
    }

    const cached = fullTextCache.get(url);
    if (cached && !options.forceRefresh) {
        return { ...cached, fromCache: true };
    }

    const isGoogleNewsRedirect = url.includes('news.google.com/rss/articles/');

    // 策略 A: 使用 Jina Reader (r.jina.ai) 获取干净的 Markdown 正文
    if (config.agent.jinaReaderEnabled && !isGoogleNewsRedirect) {
        try {
            const jinaUrl = `https://r.jina.ai/${url}`;
            const headers = {
                'Accept': 'application/json',
                'User-Agent': config.webScraping.userAgent
            };
            if (config.agent.jinaApiKey) {
                headers['Authorization'] = `Bearer ${config.agent.jinaApiKey}`;
            }

            const response = await axios.get(jinaUrl, {
                timeout: options.timeout || 15000,
                headers
            });

            let title = '';
            let content = '';
            let publishedTime = null;

            if (response.data && typeof response.data === 'object' && response.data.data) {
                title = response.data.data.title || '';
                content = response.data.data.content || '';
                publishedTime = response.data.data.publishedTime || null;
            } else if (typeof response.data === 'string') {
                content = response.data;
                const titleMatch = content.match(/^Title:\s*(.+)$/m);
                if (titleMatch) title = titleMatch[1].trim();
            }

            const cleanedContent = cleanExtractedMarkdown(content);

            if (cleanedContent && cleanedContent.length >= 150) {
                const result = {
                    success: true,
                    url,
                    title,
                    content: truncateText(cleanedContent, options.maxLength || 4500, ''),
                    excerpt: truncateText(cleanedContent, 350),
                    publishedTime,
                    method: 'jina_reader'
                };
                fullTextCache.set(url, result);
                return result;
            }
        } catch (jinaError) {
            logger.debug('AGENT_TOOL', `Jina全文提取未命中 (${url.substring(0, 60)}): ${jinaError.message}`);
        }
    }

    // 策略 B: 本地 HTTP + Cheerio Readability 正文抽取
    try {
        const response = await axios.get(url, {
            timeout: options.timeout || 12000,
            maxRedirects: 5,
            headers: {
                'User-Agent': config.webScraping.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8'
            }
        });

        const html = response.data;
        if (typeof html !== 'string') {
            throw new Error('响应非HTML文本');
        }

        const $ = cheerio.load(html);

        $('script, style, noscript, iframe, nav, footer, header, aside, form, .ad, .advertisement, .social-share, .related-articles, .newsletter').remove();

        const pageTitle =
            $('meta[property="og:title"]').attr('content') ||
            $('h1').first().text().trim() ||
            $('title').text().trim();

        const metaDesc =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            '';

        const selectors = [
            'article [itemprop="articleBody"] p',
            '[itemprop="articleBody"] p',
            'article .article-body p',
            'article .story-body p',
            'article p',
            'main article p',
            '.article-content p',
            '.post-content p',
            '.entry-content p',
            'main p'
        ];

        let paragraphs = [];
        for (const sel of selectors) {
            const found = [];
            $(sel).each((_, el) => {
                const txt = $(el).text().replace(/\s+/g, ' ').trim();
                if (txt.length >= 35 && !/^(Read more|Subscribe|Sign up|Copyright|All rights reserved)/i.test(txt)) {
                    found.push(txt);
                }
            });
            if (found.join('\n\n').length >= 200) {
                paragraphs = found;
                break;
            }
        }

        if (paragraphs.length === 0) {
            $('p').each((_, el) => {
                const txt = $(el).text().replace(/\s+/g, ' ').trim();
                if (txt.length >= 45) {
                    paragraphs.push(txt);
                }
            });
        }

        const bodyText = paragraphs.join('\n\n').trim() || stripHtml(metaDesc);

        if (bodyText && bodyText.length >= 80) {
            const result = {
                success: true,
                url: response.request?.res?.responseUrl || url,
                title: pageTitle,
                content: truncateText(bodyText, options.maxLength || 4500, ''),
                excerpt: truncateText(bodyText, 350),
                publishedTime: $('meta[property="article:published_time"]').attr('content') || null,
                method: 'cheerio_readability'
            };
            fullTextCache.set(url, result);
            return result;
        }
    } catch (htmlError) {
        logger.debug('AGENT_TOOL', `本地正文提取失败 (${url.substring(0, 60)}): ${htmlError.message}`);
    }

    return {
        success: false,
        url,
        error: '无法提取该页面正文（可能受反爬保护或为重定向链接）'
    };
}

/**
 * 清理 Jina Reader 返回的 Markdown 文本中的链接和导航噪音
 */
function cleanExtractedMarkdown(md = '') {
    if (!md) return '';
    return md
        .replace(/^Title:.*$/gm, '')
        .replace(/^URL Source:.*$/gm, '')
        .replace(/^Markdown Content:.*$/gm, '')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/^[*\-+]\s+.{1,25}$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

module.exports = {
    createArticleId,
    cleanHeadlineSuffix,
    parseRssUrlRobust,
    buildGoogleNewsDomainRssUrl,
    fetchFromGlobalSource,
    extractFullArticleContent
};
