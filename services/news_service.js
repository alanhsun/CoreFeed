/**
 * 聚核 CoreFeed v2.0 — 基础新闻源清洗与本地缓存持久化服务 (services/news_service.js)
 *
 * 核心职责：
 *   1. 新闻条目时效过滤、HTML 标签剥离与敏感词过滤 (`filterAndCleanArticles`, `passesKeywordFilter`)
 *   2. 辅助 API 数据源采集 (`fetchNewsApiArticles`, `fetchGnewsArticles`) 与自定义 RSS 字符串解析 (`parseRSSSources`)
 *   3. 本地 JSON 持久化读写 (`loadLocalData`, `saveLocalData`) 与内存状态桥接
 */
const axios = require('axios');
const path = require('path');
const config = require('../config');
const {
    retryAsync,
    stripHtml,
    isValidUrl,
    readJsonFile,
    writeJsonFile,
    ensureDirectoryExists
} = require('../utils/helpers');
const logger = require('../utils/logger');
const { getSourceAuthorityScore } = require('../config/global_sources');
const { createArticleId, cleanHeadlineSuffix } = require('./agent_tools');

class NewsService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.newsData = [];
        this.lastUpdated = null;
    }

    setSocketIO(io) {
        this.io = io;
    }

    setStateManager(stateManager) {
        this.stateManager = stateManager;
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
     * 解析环境变量中的自定义 RSS 源配置 (格式: 名称|URL,名称|URL)
     */
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
