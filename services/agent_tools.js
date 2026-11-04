const axios = require('axios');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../utils/logger');
const { stripHtml, truncateText, isValidUrl, SimpleCache } = require('../utils/helpers');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');

const parser = new Parser({
    timeout: 15000,
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
function cleanHeadlineSuffix(title = '', sourceName = '') {
    if (!title) return '';
    let cleaned = title.trim();
    // 移除末尾形如 " - Reuters" / " | BBC News" 的媒体名后缀
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
async function parseRssUrlRobust(rssUrl, timeout = 15000) {
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
        // 回退到 rss-parser 原生 parseURL
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
            feed = await parseRssUrlRobust(source.rssUrl, 16000);
        } else if (source.domain) {
            usedStrategy = 'gnews_proxy';
            const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '2d');
            feed = await parseRssUrlRobust(proxyUrl, 16000);
        }
    } catch (rssError) {
        // 如果直接 RSS 失败且配置了 domain，自动降级到 Google News Domain Proxy
        if (source.domain && config.agent.enableGoogleNewsFallback !== false) {
            try {
                usedStrategy = 'gnews_proxy_fallback';
                const proxyUrl = buildGoogleNewsDomainRssUrl(source.domain, '2d');
                logger.debug('AGENT_TOOL', `${sourceName} 直接RSS受阻，自动切换 Google News 站点代理: site:${source.domain}`);
                feed = await parseRssUrlRobust(proxyUrl, 16000);
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

            // Google News RSS 的 description 往往只有与标题重复的一句话，清理掉冗余
            const cleanTitle = cleanHeadlineSuffix(item.title, sourceName);
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
            usedStrategy = 'jina_scrape';
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

    const response = await axios.get(jinaUrl, { timeout: 20000, headers });
    const markdown = String(response.data || '');
    if (!markdown) return [];

    // 从 Markdown 中提取形如 [Headline](https://...) 的新闻链接
    const linkRegex = /\[([^\]]{18,160})\]\((https?:\/\/[^\s)]+)\)/g;
    const seenUrls = new Set();
    const articles = [];
    let match;

    while ((match = linkRegex.exec(markdown)) !== null && articles.length < maxItems) {
        const rawTitle = match[1].replace(/\s+/g, ' ').trim();
        const link = match[2].trim();

        // 过滤非新闻路径
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
            title: cleanHeadlineSuffix(rawTitle, source.name),
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

    // Google News 跳转链接不直接交给 Jina（因为 Google News 重定向页依赖 JS 跳转），优先尝试 Jina，若短则回退
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
                timeout: options.timeout || 18000,
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

            // 清理 Markdown 中的图片、导航链接噪音
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
            timeout: options.timeout || 15000,
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

        // 移除脚本、样式、导航、页脚、广告等无关节点
        $('script, style, noscript, iframe, nav, footer, header, aside, form, .ad, .advertisement, .social-share, .related-articles, .newsletter').remove();

        const pageTitle =
            $('meta[property="og:title"]').attr('content') ||
            $('h1').first().text().trim() ||
            $('title').text().trim();

        const metaDesc =
            $('meta[property="og:description"]').attr('content') ||
            $('meta[name="description"]').attr('content') ||
            '';

        // 按优先级寻找正文容器
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

        // 如果仍未提取到足够段落，回退扫描所有 <p>
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
        .replace(/!\[[^\]]*\]\([^)]+\)/g, '') // 移除图片标记
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // 保留链接锚文本，去掉URL噪音
        .replace(/^[*\-+]\s+.{1,25}$/gm, '') // 移除短菜单项
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * 工具 3: 按主题/关键词主动搜索全球知名媒体报道
 * @param {string} query - 搜索主题或关键词（支持中英文）
 * @param {Object} options - { maxResults, timeRange, authoritativeOnly, language }
 */
async function searchGlobalNewsByTopic(query, options = {}) {
    const {
        maxResults = 15,
        timeRange = '2d',
        authoritativeOnly = false,
        language = 'en'
    } = options;

    if (!query || !query.trim()) return [];

    const results = [];
    const isChineseQuery = /[\u4e00-\u9fa5]/.test(query);

    // 1. Google News RSS 搜索（支持中英文与权威站点限定）
    try {
        let searchQuery = query.trim();
        if (authoritativeOnly && !isChineseQuery) {
            searchQuery += ' (site:reuters.com OR site:apnews.com OR site:bbc.com OR site:nytimes.com OR site:bloomberg.com OR site:theguardian.com OR site:scmp.com OR site:aljazeera.com OR site:ft.com OR site:cnbc.com)';
        }
        if (timeRange) {
            searchQuery += ` when:${timeRange}`;
        }

        const hl = isChineseQuery ? 'zh-CN' : (language === 'zh' ? 'zh-CN' : 'en-US');
        const gl = isChineseQuery ? 'CN' : 'US';
        const ceid = isChineseQuery ? 'CN:zh-Hans' : 'US:en';

        const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
        const feed = await parseRssUrlRobust(rssUrl, 15000);

        if (feed && Array.isArray(feed.items)) {
            for (const item of feed.items.slice(0, maxResults)) {
                // 提取 Google News 条目的真实来源名称
                let outletName = 'Global Media';
                if (item.source && typeof item.source === 'string') {
                    outletName = item.source;
                } else if (item.source && item.source._) {
                    outletName = item.source._;
                } else {
                    const suffixMatch = (item.title || '').match(/\s+[-|—]\s+([A-Za-z0-9\s.&'()/\u4e00-\u9fa5]{2,35})$/);
                    if (suffixMatch) outletName = suffixMatch[1].trim();
                }

                const cleanTitle = cleanHeadlineSuffix(item.title, outletName);
                const desc = stripHtml(item.contentSnippet || item.description || cleanTitle);

                results.push({
                    id: createArticleId(item.link, cleanTitle),
                    title: cleanTitle,
                    description: truncateText(desc, 400),
                    content: truncateText(desc, 1500),
                    url: item.link,
                    urlToImage: null,
                    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                    source: {
                        id: 'gnews-search',
                        name: outletName,
                        authority: getSourceAuthorityScore(outletName),
                        strategy: 'agent_search'
                    },
                    region: null
                });
            }
        }
    } catch (err) {
        logger.warn('AGENT_TOOL', `Google News 主题检索失败 (${query}): ${err.message}`);
    }

    // 2. 如果配置了 NewsAPI，并行补充检索
    if (config.news.newsApiEnabled && config.news.apiKey && results.length < maxResults) {
        try {
            const response = await axios.get('https://newsapi.org/v2/everything', {
                params: {
                    q: query,
                    sortBy: 'publishedAt',
                    pageSize: Math.min(10, maxResults),
                    apiKey: config.news.apiKey
                },
                timeout: 12000
            });
            const apiArticles = response.data?.articles || [];
            for (const a of apiArticles) {
                if (!a.title || a.title.includes('[Removed]')) continue;
                results.push({
                    id: createArticleId(a.url, a.title),
                    title: a.title,
                    description: stripHtml(a.description || a.title),
                    content: stripHtml(a.content || a.description || a.title),
                    url: a.url,
                    urlToImage: a.urlToImage,
                    publishedAt: a.publishedAt || new Date().toISOString(),
                    source: {
                        id: a.source?.id || 'newsapi',
                        name: a.source?.name || 'NewsAPI',
                        authority: getSourceAuthorityScore(a.source?.name),
                        strategy: 'newsapi_search'
                    },
                    region: null
                });
            }
        } catch (err) {
            logger.debug('AGENT_TOOL', `NewsAPI 补充检索跳过: ${err.message}`);
        }
    }

    // 按权威度与时间综合排序并去重
    const seen = new Set();
    return results.filter(item => {
        const key = item.title.toLowerCase().substring(0, 45);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, maxResults);
}

/**
 * 供大模型 Tool-Use (Function Calling) 调用的标准工具定义
 */
const AGENT_TOOL_DEFINITIONS = [
    {
        type: 'function',
        function: {
            name: 'search_global_news',
            description: '在全球知名新闻媒体（Reuters、AP、BBC、NYT、Bloomberg、SCMP、Al Jazeera等）中按主题或关键词搜索最新报道',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '搜索关键词或主题（建议使用英文关键词以覆盖更多国际大报，或使用中文搜索华语媒体）'
                    },
                    authoritativeOnly: {
                        type: 'boolean',
                        description: '是否仅限定在路透、美联、BBC、纽时、彭博等顶级外媒域名内检索'
                    },
                    maxResults: {
                        type: 'integer',
                        description: '返回的最大新闻条数（默认10）'
                    }
                },
                required: ['query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'read_article_fulltext',
            description: '通过 Jina Reader 和智能正文抽取工具读取指定新闻 URL 的完整正文内容，以便深入核实细节',
            parameters: {
                type: 'object',
                properties: {
                    url: {
                        type: 'string',
                        description: '需要深读的新闻原文 URL'
                    }
                },
                required: ['url']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'patrol_source_category',
            description: '巡检指定类别的全球知名信源矩阵（wire=国际通讯社, western=欧美主流大报, asiapacific=亚太名媒, finance=全球财经, tech=前沿科技）',
            parameters: {
                type: 'object',
                properties: {
                    category: {
                        type: 'string',
                        enum: ['wire', 'western', 'asiapacific', 'finance', 'tech', 'all'],
                        description: '要巡检的信源类别'
                    }
                },
                required: ['category']
            }
        }
    }
];

/**
 * 执行大模型发起的 Tool Call
 */
async function executeAgentToolCall(toolName, args = {}) {
    switch (toolName) {
        case 'search_global_news': {
            const articles = await searchGlobalNewsByTopic(args.query, {
                authoritativeOnly: Boolean(args.authoritativeOnly),
                maxResults: args.maxResults || 10
            });
            return {
                query: args.query,
                count: articles.length,
                articles: articles.map(a => ({
                    title: a.title,
                    source: a.source?.name,
                    publishedAt: a.publishedAt,
                    description: a.description,
                    url: a.url
                }))
            };
        }
        case 'read_article_fulltext': {
            const res = await extractFullArticleContent(args.url, { maxLength: 3500 });
            return res;
        }
        case 'patrol_source_category': {
            const matrix = getGlobalSourceMatrix().filter(s => s.enabled);
            const targetSources = args.category && args.category !== 'all'
                ? matrix.filter(s => s.category === args.category)
                : matrix.slice(0, 8);

            const harvested = [];
            for (const src of targetSources.slice(0, 6)) {
                const items = await fetchFromGlobalSource(src, 4);
                harvested.push(...items);
            }
            return {
                category: args.category,
                sourcesPatrolled: targetSources.map(s => s.name),
                count: harvested.length,
                articles: harvested.map(a => ({
                    title: a.title,
                    source: a.source?.name,
                    publishedAt: a.publishedAt,
                    description: a.description,
                    url: a.url
                }))
            };
        }
        default:
            return { error: `未知工具: ${toolName}` };
    }
}

module.exports = {
    createArticleId,
    cleanHeadlineSuffix,
    parseRssUrlRobust,
    buildGoogleNewsDomainRssUrl,
    fetchFromGlobalSource,
    extractFullArticleContent,
    searchGlobalNewsByTopic,
    AGENT_TOOL_DEFINITIONS,
    executeAgentToolCall
};

