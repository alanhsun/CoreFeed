/**
 * 聚核 CoreFeed v2.0 — 基础新闻源清洗与本地缓存持久化服务 (services/news_service.js)
 *
 * 核心职责：
 *   1. 新闻条目时效过滤与 HTML 标签剥离 (`filterAndCleanArticles`)
 *   2. 自定义补充 RSS 字符串解析 (`parseRSSSources`)
 *   3. 本地 JSON 持久化读写 (`loadLocalData`, `saveLocalData`) 与内存状态桥接
 */
const path = require('path');
const config = require('../config');
const {
    stripHtml,
    isValidUrl,
    readJsonFile,
    writeJsonFile,
    ensureDirectoryExists
} = require('../utils/helpers');
const logger = require('../utils/logger');

class NewsService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.newsData = [];
        this.lastUpdated = null;
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

                return true;
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
