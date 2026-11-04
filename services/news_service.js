const axios = require('axios');
const path = require('path');
const config = require('../config');
const {
    retryAsync,
    delay,
    stripHtml,
    truncateText,
    isValidUrl,
    readJsonFile,
    writeJsonFile,
    ensureDirectoryExists
} = require('../utils/helpers');
const logger = require('../utils/logger');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');
const { fetchFromGlobalSource, parseRssUrlRobust, createArticleId, cleanHeadlineSuffix } = require('./agent_tools');

/**
 * 基础新闻源与本地缓存服务 (CoreFeed v2.0)
 * 负责对接全球知名信源矩阵、NewsAPI、Gnews、自定义RSS以及本地持久化数据管理
 */
class NewsService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.newsData = [];
        this.lastUpdated = null;
        this.processedNewsIds = new Set();
    }

    setSocketIO(io) {
        this.io = io;
    }

    setStateManager(stateManager) {
        this.stateManager = stateManager;
    }

    /**
     * 从全球知名信源矩阵获取文章
     */
    async fetchGlobalMatrixArticles() {
        try {
            const matrix = getGlobalSourceMatrix().filter(s => s.enabled);
            const disabledSet = new Set((config.news.disabledSources || []).map(s => s.trim()));
            const enabledSources = matrix.filter(s => !disabledSet.has(s.name) && !disabledSet.has(s.id));

            const articles = [];
            const concurrency = config.agent?.sourceConcurrency || 6;

            for (let i = 0; i < enabledSources.length; i += concurrency) {
                const batch = enabledSources.slice(i, i + concurrency);
                const results = await Promise.all(
                    batch.map(src => fetchFromGlobalSource(src).catch(() => []))
                );
                results.forEach(items => articles.push(...items));
            }

            logger.info('NEWS', `全球知名信源矩阵采集完成: ${articles.length} 条`);
            return articles;
        } catch (error) {
            logger.warn('NEWS', `全球知名信源矩阵获取异常: ${error.message}`);
            return [];
        }
    }

    /**
     * 从 NewsAPI 获取头条新闻
     */
    async fetchNewsApiArticles() {
        const { apiKey, newsApiEnabled, newsApiMaxArticles, sources } = config.news;
        if (!newsApiEnabled || !apiKey) return [];

        try {
            const params = {
                apiKey,
                pageSize: newsApiMaxArticles || 15
            };

            if (Array.isArray(sources) && sources.length > 0) {
                params.sources = sources.join(',');
            } else {
                params.country = 'us';
            }

            const response = await retryAsync(
                () => axios.get('https://newsapi.org/v2/top-headlines', {
                    params,
                    timeout: config.network.timeout
                }),
                2,
                1500,
                'NewsAPI'
            );

            const articles = response.data?.articles || [];
            return articles.map(a => ({
                id: createArticleId(a.url, a.title),
                title: cleanHeadlineSuffix(a.title, a.source?.name),
                description: stripHtml(a.description || a.title || ''),
                content: stripHtml(a.content || a.description || ''),
                url: a.url,
                urlToImage: a.urlToImage,
                publishedAt: a.publishedAt || new Date().toISOString(),
                source: {
                    id: a.source?.id || 'newsapi',
                    name: a.source?.name || 'NewsAPI',
                    authority: getSourceAuthorityScore(a.source?.name),
                    strategy: 'newsapi'
                },
                author: a.author || null,
                region: null
            }));
        } catch (error) {
            logger.warn('NEWS', `NewsAPI 获取跳过: ${error.message}`);
            return [];
        }
    }

    /**
     * 从 Gnews API 获取头条新闻
     */
    async fetchGnewsArticles() {
        const { apiKey, enabled, category, language, country, maxArticles } = config.gnews;
        if (!enabled || !apiKey) return [];

        try {
            const response = await retryAsync(
                () => axios.get('https://gnews.io/api/v4/top-headlines', {
                    params: {
                        category,
                        lang: language,
                        country,
                        max: maxArticles || 15,
                        apikey: apiKey
                    },
                    timeout: config.network.timeout
                }),
                2,
                1500,
                'Gnews'
            );

            const articles = response.data?.articles || [];
            return articles.map(article => ({
                id: createArticleId(article.url, article.title),
                title: cleanHeadlineSuffix(article.title, article.source?.name),
                description: stripHtml(article.description || ''),
                content: stripHtml(article.content || article.description || ''),
                url: article.url,
                urlToImage: article.image || null,
                publishedAt: article.publishedAt || new Date().toISOString(),
                source: {
                    id: 'gnews',
                    name: article.source?.name || 'Gnews',
                    authority: getSourceAuthorityScore(article.source?.name),
                    strategy: 'gnews'
                },
                author: null,
                region: null
            }));
        } catch (error) {
            logger.warn('NEWS', `Gnews 获取跳过: ${error.message}`);
            return [];
        }
    }

    /**
     * 从环境变量配置的额外 RSS 源获取新闻
     */
    async fetchRSSArticles() {
        const { rssSources, maxArticlesPerSource, sourceArticleCountsMap, disabledSources } = config.news;
        if (!rssSources || typeof rssSources !== 'string' || !rssSources.trim()) {
            return [];
        }

        const sources = this.parseRSSSources(rssSources);
        const disabledSet = new Set(Array.isArray(disabledSources) ? disabledSources : []);

        const enabledSources = sources.filter(s => {
            const name = s.name || new URL(s.url).hostname;
            return !disabledSet.has(name);
        });

        const results = await Promise.all(
            enabledSources.map(async (rssSource) => {
                try {
                    const sourceName = rssSource.name || new URL(rssSource.url).hostname;
                    const count = sourceArticleCountsMap[sourceName] || maxArticlesPerSource || 5;
                    const feed = await parseRssUrlRobust(rssSource.url, 15000);
                    const items = (feed.items || []).slice(0, count);

                    return items
                        .filter(item => item.title && item.link)
                        .map(item => ({
                            id: createArticleId(item.link, item.title),
                            title: cleanHeadlineSuffix(item.title, sourceName),
                            description: truncateText(stripHtml(item.contentSnippet || item.summary || item.description || item.title), 500),
                            content: truncateText(stripHtml(item['content:encoded'] || item.content || item.description || item.title), 2500),
                            url: item.link,
                            urlToImage: null,
                            publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
                            source: {
                                id: null,
                                name: sourceName,
                                authority: getSourceAuthorityScore(sourceName),
                                strategy: 'rss'
                            },
                            author: item.creator || item.author || null,
                            region: null
                        }));
                } catch (_) {
                    return [];
                }
            })
        );

        return results.flat();
    }

    parseRSSSources(rssSources) {
        if (!rssSources || typeof rssSources !== 'string') return [];
        return rssSources
            .split(',')
            .map(source => {
                const trimmed = source.trim();
                if (trimmed.includes('|')) {
                    const [name, url] = trimmed.split('|').map(s => s.trim());
                    return { name, url };
                }
                return { name: null, url: trimmed };
            })
            .filter(source => source.url && isValidUrl(source.url));
    }

    /**
     * 获取所有原始新闻（供 Agent 流水线进一步聚类与编译）
     */
    async fetchAllNewsWithoutAIDedup() {
        const [matrixArticles, newsApiArticles, gnewsArticles, rssArticles] = await Promise.all([
            this.fetchGlobalMatrixArticles(),
            this.fetchNewsApiArticles(),
            this.fetchGnewsArticles(),
            this.fetchRSSArticles()
        ]);

        let allArticles = [...matrixArticles, ...newsApiArticles, ...gnewsArticles, ...rssArticles];
        allArticles = this.filterAndCleanArticles(allArticles);
        allArticles = this.removeDuplicateArticles(allArticles);

        allArticles.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
        return allArticles.slice(0, config.agent?.maxCandidatePool || 80);
    }

    /**
     * 过滤和清洗新闻文章
     */
    filterAndCleanArticles(articles = []) {
        const freshnessHours = config.agent?.freshnessHours || 48;
        const cutoffTime = Date.now() - freshnessHours * 3600000;
        const tomorrow = Date.now() + 24 * 3600000;

        return articles
            .filter(article => {
                if (!article || !article.title || !article.title.trim()) return false;
                if (article.title.includes('[Removed]') || article.title.includes('[Deleted]')) return false;

                if (article.publishedAt) {
                    const pubTime = new Date(article.publishedAt).getTime();
                    if (!isNaN(pubTime) && (pubTime < cutoffTime || pubTime > tomorrow)) {
                        return false;
                    }
                }

                return this.passesKeywordFilter(article);
            })
            .map(article => ({
                ...article,
                title: article.title.trim(),
                description: stripHtml(article.description || article.title).trim(),
                content: stripHtml(article.content || article.description || article.title).trim(),
                source: {
                    ...article.source,
                    name: article.source?.name?.trim() || 'Global Media'
                }
            }));
    }

    passesKeywordFilter(article) {
        const { filter } = config;
        if (!filter.enabled || !Array.isArray(filter.keywords) || filter.keywords.length === 0) {
            return true;
        }

        const parts = [];
        if (filter.filterTitle && article.title) parts.push(article.title.toLowerCase());
        if (filter.filterContent) {
            if (article.description) parts.push(article.description.toLowerCase());
            if (article.content) parts.push(article.content.toLowerCase());
        }
        if (filter.filterSource && article.source?.name) parts.push(article.source.name.toLowerCase());

        const combined = parts.join(' ');
        for (const kw of filter.keywords) {
            if (kw && kw.trim() && combined.includes(kw.toLowerCase().trim())) {
                return false;
            }
        }
        return true;
    }

    removeDuplicateArticles(articles = []) {
        const seen = new Set();
        return articles.filter(article => {
            const key = (article.translatedTitle || article.title || '')
                .toLowerCase()
                .replace(/[^\u4e00-\u9fa5a-z0-9]/g, '')
                .substring(0, 45);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    async loadLocalData() {
        try {
            const dataFile = path.join(__dirname, '..', 'data', 'news.json');
            const data = await readJsonFile(dataFile);
            if (data && Array.isArray(data.news)) {
                if (this.stateManager) {
                    this.stateManager.updateNewsData(data.news, data.news);
                    if (data.lastUpdated) {
                        this.stateManager.set('lastUpdated', data.lastUpdated);
                    }
                } else {
                    this.newsData = data.news;
                    this.lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
                }
                logger.info('NEWS', `从本地文件加载了 ${data.news.length} 条新闻数据`);
                return true;
            }
            return false;
        } catch (error) {
            return false;
        }
    }

    async saveLocalData(data = null) {
        const dataDir = path.join(__dirname, '..', 'data');
        const dataFile = path.join(dataDir, 'news.json');
        await ensureDirectoryExists(dataDir);

        const list = data || this.getNewsData();
        await writeJsonFile(dataFile, {
            news: list,
            lastUpdated: new Date().toISOString(),
            total: list.length
        });
    }

    getNewsData() {
        if (this.stateManager) {
            return this.stateManager.get('newsData') || [];
        }
        return this.newsData;
    }

    setNewsData(data) {
        if (this.stateManager) {
            this.stateManager.updateNewsData(data);
        } else {
            this.newsData = data;
            this.lastUpdated = new Date();
        }
    }

    getLastUpdated() {
        if (this.stateManager) {
            const lu = this.stateManager.get('lastUpdated');
            return lu ? new Date(lu) : null;
        }
        return this.lastUpdated;
    }

    setLastUpdated(date) {
        const iso = date instanceof Date ? date.toISOString() : new Date(date || Date.now()).toISOString();
        if (this.stateManager) {
            this.stateManager.set('lastUpdated', iso);
        } else {
            this.lastUpdated = new Date(iso);
        }
    }
}

module.exports = NewsService;
