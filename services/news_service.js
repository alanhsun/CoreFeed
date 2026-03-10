const axios = require('axios');
const Parser = require('rss-parser');
const config = require('../config');
const { retryAsync, delay, stripHtml, truncateText, isValidUrl } = require('../utils/helpers');
const logger = require('../utils/logger');
const WebScrapingService = require('./web_scraping_service');

// RSS解析器配置
const parser = new Parser({
    customFields: {
        feed: ['language', 'copyright'],
        item: ['media:content', 'media:thumbnail', 'enclosure']
    }
});

/**
 * 新闻服务类
 */
class NewsService {
    constructor(io, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        // 向后兼容：如果没有状态管理器，仍使用实例变量
        this.newsData = [];
        this.lastUpdated = null;
        this.webScrapingService = new WebScrapingService();
        // 增量更新相关变量
        this.processedNewsIds = new Set(); // 已处理新闻的标识符
        this.lastProcessedTime = null; // 上次处理时间
        // 失效源跟踪
        this.failedSources = new Map(); // 源名称 -> 失败次数
        this.failedSourceThreshold = 5; // 连续失败5次后提示
    }

    /**
     * 设置Socket.IO实例
     * @param {Object} io - Socket.IO实例
     */
    setSocketIO(io) {
        this.io = io;
    }

    /**
     * 设置状态管理器
     * @param {Object} stateManager - 状态管理器实例
     */
    setStateManager(stateManager) {
        this.stateManager = stateManager;
    }



    /**
     * 从NewsAPI获取新闻
     * @returns {Promise<Array>} 新闻文章数组
     */
    async fetchNewsApiArticles() {
        const { apiKey, newsApiEnabled, newsApiMaxArticles, sources, maxArticlesPerSource, sourceArticleCountsMap, disabledSources } = config.news;
        
        if (!newsApiEnabled) {
            logger.debug('NEWS', 'NewsAPI已禁用');
            return [];
        }
        
        if (!apiKey) {
            logger.warn('NEWS', 'NewsAPI配置不完整');
            return [];
        }

        try {
            logger.info('NEWS', '📡 连接NewsAPI...');
            
            // 如果没有配置特定源，则获取通用的top-headlines
            if (!sources || typeof sources !== 'string' || sources.trim() === '') {
                logger.debug('NEWS', '获取通用top-headlines');
                const response = await retryAsync(
                    () => axios.get('https://newsapi.org/v2/top-headlines', {
                        params: {
                            country: 'us', // 默认获取美国的头条新闻
                            apiKey: apiKey,
                            pageSize: newsApiMaxArticles || 20
                        },
                        timeout: config.network.timeout
                    }),
                    config.network.retries,
                    config.network.retryDelay,
                    'NewsAPI'
                );
                
                const articles = response.data.articles || [];
                logger.info('NEWSAPI', 'Fetched top-headlines successfully.');
                logger.info('NEWSAPI', `Fetched ${articles.length} articles (general).`);
                return articles;
            }
            
            // 解析源列表，支持"名称|ID"格式
            const sourceList = this.parseApiSources(sources);
            
            // 解析禁用源列表
            const disabledSourcesSet = new Set();
            if (disabledSources && typeof disabledSources === 'string') {
                disabledSources.split(',').forEach(source => {
                    if (source.trim()) {
                        disabledSourcesSet.add(source.trim());
                    }
                });
            }
            
            // 过滤掉禁用的源
            const enabledSources = sourceList.filter(apiSource => {
                const sourceName = apiSource.name || apiSource.id;
                return !disabledSourcesSet.has(sourceName) && !disabledSourcesSet.has(apiSource.id);
            });
            
            if (enabledSources.length === 0) {
                logger.debug('NEWS', '无启用源，获取通用headlines');
                const response = await retryAsync(
                    () => axios.get('https://newsapi.org/v2/top-headlines', {
                        params: {
                            country: 'us', // 默认获取美国的头条新闻
                            apiKey: apiKey,
                            pageSize: newsApiMaxArticles || 20
                        },
                        timeout: config.network.timeout
                    }),
                    config.network.retries,
                    config.network.retryDelay
                );
                
                const articles = response.data.articles || [];
                logger.info('NEWSAPI', 'Fetched fallback top-headlines successfully.');
                logger.info('NEWSAPI', `Fetched ${articles.length} articles (fallback).`);
                return articles;
            }
            
            const allArticles = [];
            
            // 为每个启用的源单独获取新闻，使用各自的文章数量配置
            for (const apiSource of enabledSources) {
                const sourceId = apiSource.id;
                const sourceName = apiSource.name || sourceId;
                const articleCount = sourceArticleCountsMap[sourceName] || sourceArticleCountsMap[sourceId] || newsApiMaxArticles || maxArticlesPerSource;
                
                try {
                    const response = await retryAsync(
                        () => axios.get('https://newsapi.org/v2/top-headlines', {
                            params: {
                                sources: sourceId,
                                apiKey: apiKey,
                                pageSize: articleCount
                            },
                            timeout: config.network.timeout
                        }),
                        config.network.retries,
                        config.network.retryDelay,
                        `NewsAPI-${sourceName}`
                    );
                    
                    const articles = response.data.articles || [];
                    logger.debug('NEWS', `${sourceName}: ${articles.length}/${articleCount}条`);
                    allArticles.push(...articles);
                    
                    // 添加延迟避免API限制
                    if (sourceList.indexOf(apiSource) < sourceList.length - 1) {
                        await delay(200);
                    }
                } catch (sourceError) {
                    logger.error('NEWS', `${sourceName}获取失败`, sourceError.message);
                    // 跟踪失效源
                    this.trackFailedSource(sourceName, sourceError.message);
                }
            }
            
            logger.info('NEWSAPI', 'Fetched multi-source top-headlines successfully.');
            logger.info('NEWSAPI', `Fetched ${allArticles.length} articles in total.`);
            return allArticles;
            
        } catch (error) {
            logger.error('NEWSAPI', 'Failed to fetch news from NewsAPI.');
            logger.error('NEWS', 'NewsAPI获取失败', error.message);
            // 跟踪NewsAPI整体失效
            this.trackFailedSource('NewsAPI', error.message);
            return [];
        }
    }

    /**
     * 从Gnews API获取新闻
     * @returns {Promise<Array>} 新闻文章数组
     */
    async fetchGnewsArticles() {
        const { apiKey, enabled, category, language, country, maxArticles } = config.gnews;
        
        if (!enabled || !apiKey) {
            logger.debug('NEWS', 'Gnews已禁用');
            return [];
        }

        try {
            logger.info('NEWS', '📡 连接Gnews API...');
            
            const response = await retryAsync(
                () => axios.get('https://gnews.io/api/v4/top-headlines', {
                    params: {
                        category: category,
                        lang: language,
                        country: country,
                        max: maxArticles,
                        apikey: apiKey
                    },
                    timeout: config.network.timeout
                }),
                config.network.retries,
                config.network.retryDelay,
                'Gnews'
            );
            
            const articles = response.data.articles || [];
            logger.info('GNEWS', 'Fetched top-headlines successfully.');
            logger.info('GNEWS', `Fetched ${articles.length} articles.`);
            
            // 转换Gnews文章格式为标准格式
            return articles.map(article => this.convertGnewsArticleToStandard(article));
            
        } catch (error) {
            logger.error('GNEWS', 'Failed to fetch news from Gnews.');
            logger.error('NEWS', 'Gnews获取失败', error.message);
            // 跟踪Gnews整体失效
            this.trackFailedSource('Gnews', error.message);
            return [];
        }
    }

    /**
     * 将Gnews文章转换为标准格式
     * @param {Object} article - Gnews文章对象
     * @returns {Object} 标准化的新闻文章
     */
    convertGnewsArticleToStandard(article) {
        return {
            title: article.title,
            description: article.description,
            content: article.content || article.description,
            url: article.url,
            urlToImage: article.image,
            publishedAt: article.publishedAt,
            source: {
                id: 'gnews',
                name: article.source?.name || 'Gnews'
            },
            author: null,
            region: null
        };
    }

    /**
     * 从RSS源获取新闻
     * @returns {Promise<Array>} 新闻文章数组
     */
    async fetchRSSArticles() {
        const { rssSources, maxArticlesPerSource, sourceArticleCountsMap, disabledSources } = config.news;
        
        if (!rssSources || typeof rssSources !== 'string' || rssSources.trim() === '') {
            logger.debug('NEWS', 'RSS源配置为空，跳过RSS获取');
            return [];
        }

        const rssArticles = [];
        
        // 解析RSS源配置
        const sources = this.parseRSSSources(rssSources);
        
        // 解析禁用源列表
        const disabledSourcesSet = new Set();
        if (disabledSources) {
            // disabledSources 已经是数组（由 parseSources 处理）
            if (Array.isArray(disabledSources)) {
                disabledSources.forEach(source => {
                    if (source && source.trim()) {
                        disabledSourcesSet.add(source.trim());
                    }
                });
            } else if (typeof disabledSources === 'string') {
                disabledSources.split(',').forEach(source => {
                    if (source.trim()) {
                        disabledSourcesSet.add(source.trim());
                    }
                });
            }
        }
        
        // 过滤掉禁用的源
        const enabledSources = sources.filter(rssSource => {
            const sourceName = rssSource.name || new URL(rssSource.url).hostname;
            return !disabledSourcesSet.has(sourceName);
        });
        
        if (enabledSources.length === 0) {
            logger.debug('NEWS', '没有启用的RSS源，跳过RSS获取');
            return [];
        }
        
        const rssPromises = enabledSources.map(async (rssSource) => {
            try {
                const sourceName = rssSource.name || new URL(rssSource.url).hostname;
                logger.debug('NEWS', `解析RSS源: ${sourceName}`);
                
                const feed = await retryAsync(
                    () => parser.parseURL(rssSource.url),
                    config.network.retries,
                    config.network.retryDelay,
                    `RSS-${sourceName}`
                );
                
                const finalSourceName = rssSource.name || feed.title || new URL(rssSource.url).hostname;
                
                // 使用源特定的文章数量配置
                const articleCount = sourceArticleCountsMap[finalSourceName] || sourceArticleCountsMap[rssSource.name] || maxArticlesPerSource;
                const items = feed.items.slice(0, articleCount);
                
                logger.debug('NEWS', `${finalSourceName}: ${items.length}/${articleCount}条`);
                
                const sourceArticles = [];
                for (const item of items) {
                    const article = this.convertRSSItemToArticle(item, sourceName);
                    if (article) {
                        sourceArticles.push(article);
                    }
                }
                
                return sourceArticles;
            } catch (error) {
                const sourceName = rssSource.name || new URL(rssSource.url).hostname;
                logger.error('NEWS', `RSS源解析失败: ${sourceName}`, error.message);
                // 跟踪失效源
                this.trackFailedSource(sourceName, error.message);
                return [];
            }
        });
        
        const results = await Promise.all(rssPromises);
        for (const articles of results) {
            rssArticles.push(...articles);
        }
        
        logger.info('RSS', `Fetched ${rssArticles.length} articles in total.`);
        return rssArticles;
    }

    /**
     * 解析API源配置
     * @param {string} apiSources - API源配置字符串
     * @returns {Array} 解析后的API源数组
     */
    parseApiSources(apiSources) {
        // 检查输入类型，如果不是字符串则返回空数组
        if (!apiSources || typeof apiSources !== 'string') {
            return [];
        }
        
        return apiSources.split(',').map(source => {
            const trimmed = source.trim();
            if (trimmed.includes('|')) {
                const [name, id] = trimmed.split('|').map(s => s.trim());
                return { name, id };
            } else {
                return { name: null, id: trimmed };
            }
        }).filter(source => source.id);
    }

    /**
     * 解析RSS源配置
     * @param {string} rssSources - RSS源配置字符串
     * @returns {Array} 解析后的RSS源数组
     */
    parseRSSSources(rssSources) {
        // 检查输入类型，如果不是字符串则返回空数组
        if (!rssSources || typeof rssSources !== 'string') {
            return [];
        }
        
        return rssSources.split(',').map(source => {
            const trimmed = source.trim();
            if (trimmed.includes('|')) {
                const [name, url] = trimmed.split('|').map(s => s.trim());
                return { name, url };
            } else {
                return { name: null, url: trimmed };
            }
        }).filter(source => source.url && isValidUrl(source.url));
    }

    /**
     * 将RSS条目转换为标准新闻文章格式
     * @param {Object} item - RSS条目
     * @param {string} sourceName - 源名称
     * @returns {Object|null} 标准化的新闻文章
     */
    convertRSSItemToArticle(item, sourceName) {
        if (!item.title || !item.link) {
            return null;
        }

        // 提取图片URL
        const imageUrl = this.extractImageFromRSSItem(item);
        
        // 增强内容提取：尝试多个字段获取最完整的内容
        let rawContent = '';
        let rawDescription = '';
        
        // 优先级顺序：content:encoded > content > contentSnippet > summary > description
        if (item['content:encoded']) {
            rawContent = item['content:encoded'];
        } else if (item.content) {
            rawContent = item.content;
        } else if (item.contentSnippet) {
            rawContent = item.contentSnippet;
        } else if (item.summary) {
            rawContent = item.summary;
        } else if (item.description) {
            rawContent = item.description;
        }
        
        // 描述字段提取
        if (item.contentSnippet) {
            rawDescription = item.contentSnippet;
        } else if (item.summary) {
            rawDescription = item.summary;
        } else if (item.description) {
            rawDescription = item.description;
        } else if (item['content:encoded']) {
            rawDescription = item['content:encoded'];
        } else if (item.content) {
            rawDescription = item.content;
        }
        
        // 清理HTML标签
        const description = stripHtml(rawDescription);
        const content = stripHtml(rawContent);
        
        // 如果内容太短且包含"RT.com"或引导用户访问网站的文本，记录警告
        if (content.length < 100 && (content.includes('RT.com') || content.includes('visit') || content.includes('Read more'))) {
            logger.debug('NEWS', `RT.com RSS内容较短，可能需要抓取原文: ${item.title?.substring(0, 50)}...`);
        }
        
        return {
            title: item.title.trim(),
            description: truncateText(description, 500),
            content: truncateText(content, 2000), // 增加到2000字符
            url: item.link,
            urlToImage: imageUrl,
            publishedAt: item.pubDate || item.isoDate || new Date().toISOString(),
            source: {
                id: null,
                name: sourceName
            },
            author: item.creator || item.author || null,
            region: null // 将在后续处理中设置
        };
    }

    /**
     * 从RSS条目中提取图片URL
     * @param {Object} item - RSS条目
     * @returns {string|null} 图片URL
     */
    extractImageFromRSSItem(item) {
        // 尝试从media:content提取
        if (item['media:content'] && item['media:content']['$'] && item['media:content']['$'].url) {
            return item['media:content']['$'].url;
        }
        
        // 尝试从media:thumbnail提取
        if (item['media:thumbnail'] && item['media:thumbnail']['$'] && item['media:thumbnail']['$'].url) {
            return item['media:thumbnail']['$'].url;
        }
        
        // 尝试从enclosure提取
        if (item.enclosure && item.enclosure.url && item.enclosure.type && item.enclosure.type.startsWith('image/')) {
            return item.enclosure.url;
        }
        
        // 尝试从内容中提取图片
        if (item.content && item.content.includes('<img')) {
            const imgMatch = item.content.match(/<img[^>]+src="([^"]+)"/i);
            if (imgMatch && isValidUrl(imgMatch[1])) {
                return imgMatch[1];
            }
        }
        
        return null;
    }

    /**
     * 获取所有新闻数据
     * @returns {Promise<Array>} 新闻文章数组
     */
    /**
     * 获取所有新闻（不包含AI去重，用于优化token使用）
     * @returns {Promise<Array>} 新闻文章数组
     */
    async fetchAllNewsWithoutAIDedup() {
        try {
            logger.info('NEWS', '开始获取新闻数据');
            
            // 并行获取NewsAPI、Gnews、RSS和网页抓取新闻
            const [newsApiArticles, gnewsArticles, rssArticles, webScrapingArticles] = await Promise.all([
                this.fetchNewsApiArticles(),
                this.fetchGnewsArticles(),
                this.fetchRSSArticles(),
                this.webScrapingService.fetchWebScrapingArticles()
            ]);

            // 合并所有新闻数据
            let allArticles = [...newsApiArticles, ...gnewsArticles, ...rssArticles, ...webScrapingArticles];
            
            logger.info('NEWS', `获取新闻总数: ${allArticles.length}`, {
                newsApi: newsApiArticles.length,
                gnews: gnewsArticles.length,
                rss: rssArticles.length,
                webScraping: webScrapingArticles.length
            });

            // 应用过滤和清理
            allArticles = this.filterAndCleanArticles(allArticles);
            logger.debug('NEWS', `过滤清理后: ${allArticles.length}条`);

            // 基础去重（快速去除明显重复）
            allArticles = this.removeDuplicateArticles(allArticles);
            logger.debug('NEWS', `基础去重后: ${allArticles.length}条`);
            
            // 按发布时间排序（最新的在前面）
            allArticles.sort((a, b) => {
                const dateA = new Date(a.publishedAt || 0);
                const dateB = new Date(b.publishedAt || 0);
                return dateB - dateA;
            });

            // 限制总新闻数量（在AI处理之前限制，进一步节省tokens）
            const limitedArticles = allArticles.slice(0, 60); // 增加到60以便AI去重有更多选择
            
            logger.info('NEWS', `Fetched ${limitedArticles.length} articles to be processed by AI.`);
            
            return limitedArticles;
            
        } catch (error) {
            logger.error('NEWS', '获取新闻失败', error.message);
            throw error;
        }
    }

    async fetchAllNews(incremental = false) {
        try {
            logger.info('NEWS', `开始${incremental ? '增量' : '全量'}获取新闻数据`);
            
            let allArticles;
            
            if (incremental) {
                // 增量模式：只获取新新闻
                allArticles = await this.fetchIncrementalNews();
                
                if (allArticles.length === 0) {
                    logger.info('NEWS', '没有发现新新闻，返回空数组');
                    return [];
                }
            } else {
                // 全量模式：获取所有新闻
                const [newsApiArticles, gnewsArticles, rssArticles, webScrapingArticles] = await Promise.all([
                    this.fetchNewsApiArticles(),
                    this.fetchGnewsArticles(),
                    this.fetchRSSArticles(),
                    this.webScrapingService.fetchWebScrapingArticles()
                ]);

                // 合并所有新闻数据
                allArticles = [...newsApiArticles, ...gnewsArticles, ...rssArticles, ...webScrapingArticles];
            }
            
            logger.info('NEWS', `获取新闻总数: ${allArticles.length}`, {
                incremental: incremental,
                newsApi: allArticles.filter(a => a.source?.id === 'newsapi').length,
                gnews: allArticles.filter(a => a.source?.id === 'gnews').length,
                rss: allArticles.filter(a => !a.source?.id || a.source.id === null).length,
                webScraping: allArticles.filter(a => a.source?.id === 'webscraping').length
            });

            // 应用过滤和清理
            allArticles = this.filterAndCleanArticles(allArticles);
            logger.debug('NEWS', `过滤清理后: ${allArticles.length}条`);

            // 基础去重（快速去除明显重复）
            allArticles = this.removeDuplicateArticles(allArticles);
            logger.debug('NEWS', `基础去重后: ${allArticles.length}条`);
            
            // 按发布时间排序（最新的在前面）
            allArticles.sort((a, b) => {
                const dateA = new Date(a.publishedAt || 0);
                const dateB = new Date(b.publishedAt || 0);
                return dateB - dateA;
            });

            // 使用AI智能去重
            if (allArticles.length > 1) {
                const AIService = require('./ai_service');
                const aiService = new AIService();

                try {
                    allArticles = await aiService.removeDuplicateNewsWithAI(allArticles);
                    logger.info('AI', `AI deduplicated articles, ${allArticles.length} remaining.`);
                } catch (error) {
                    logger.error('NEWS', 'AI去重失败，使用基础去重', error.message);
                }
            }

            // AI智能选择最优质30条新闻（基于来源权威性、内容完整性等）
            if (allArticles.length > 30) {
                const AIService = require('./ai_service');
                const aiService = new AIService();

                try {
                    allArticles = await aiService.selectTopQualityNews(allArticles, 30);
                    logger.info('AI', `AI智能选择完成, ${allArticles.length} articles selected.`);
                } catch (error) {
                    logger.error('NEWS', 'AI智能选择失败，使用默认排序', error.message);
                    // 备用：按时间排序取前30条
                    allArticles = allArticles.slice(0, 30);
                }
            }

            // AI智能分类新闻地域
            if (allArticles.length > 0) {
                const AIService = require('./ai_service');
                const aiService = new AIService();
                
                try {
                    const regionMap = await aiService.batchDetermineNewsRegions(allArticles);
                    
                    // 将地域信息应用到新闻对象
                    allArticles.forEach((article, index) => {
                        if (regionMap.has(index)) {
                            article.region = regionMap.get(index);
                        } else {
                            // 默认地域或基于规则的后备分类
                            article.region = this.determineRegionByRule(article) || '国际';
                        }
                    });
                    
                    logger.info('AI', `新闻地域分类完成`);
                } catch (error) {
                    logger.error('NEWS', 'AI地域分类失败', error.message);
                    // 失败时使用规则分类
                    allArticles.forEach(article => {
                        article.region = this.determineRegionByRule(article) || '国际';
                    });
                }
            }
            
            // 标记已处理的新闻
            allArticles.forEach(article => this.markNewsAsProcessed(article));
            
            logger.info('NEWS', `返回 ${allArticles.length} 条最终新闻`);
            
            return allArticles;
            
        } catch (error) {
            logger.error('NEWS', '获取新闻失败', error.message);
            throw error;
        }
    }

    /**
     * 过滤和清理新闻数据
     * @param {Array} articles - 原始新闻文章数组
     * @returns {Array} 过滤后的新闻文章数组
     */
    filterAndCleanArticles(articles) {
        // 计算2天前的时间戳
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        
        return articles.filter(article => {
            // 过滤掉无效的文章
            if (!article.title || article.title.trim() === '') {
                return false;
            }
            
            // 过滤掉被删除的文章
            if (article.title.includes('[Removed]') || article.title.includes('[Deleted]')) {
                return false;
            }
            
            // 过滤掉内容不足的文章（描述和内容都太短）
            const description = article.description || '';
            const content = article.content || '';
            
            // 如果描述和内容都太短，过滤掉
            if (description.length < 20 && content.length < 50) {
                logger.debug('NEWS', `过滤内容不足的文章: ${article.title.substring(0, 50)}...`);
                return false;
            }
            
            // 过滤掉明显的"Read more"引导文章（内容太短且包含引导文本）
            if (content.length < 100) {
                const lowerContent = content.toLowerCase();
                if (lowerContent.includes('read more') || 
                    lowerContent.includes('visit') && lowerContent.includes('.com') ||
                    lowerContent.includes('full article') ||
                    lowerContent.includes('continue reading')) {
                    logger.debug('NEWS', `过滤引导类文章: ${article.title.substring(0, 50)}...`);
                    return false;
                }
            }
            
            // 日期过滤：排除2天前的老新闻
            if (article.publishedAt) {
                try {
                    const publishDate = new Date(article.publishedAt);
                    if (!isNaN(publishDate.getTime())) {
                        // 排除超过2天的老新闻
                        if (publishDate < twoDaysAgo) {
                            logger.debug('NEWS', `过滤老新闻 (${publishDate.toISOString().split('T')[0]}): ${article.title.substring(0, 50)}...`);
                            return false;
                        }
                        
                        // 排除未来的新闻（可能是日期解析错误）
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        if (publishDate > tomorrow) {
                            logger.debug('NEWS', `过滤未来日期新闻 (${publishDate.toISOString().split('T')[0]}): ${article.title.substring(0, 50)}...`);
                            return false;
                        }
                    }
                } catch (error) {
                    // 日期解析失败，记录但不过滤
                    logger.debug('NEWS', `日期解析失败: ${article.publishedAt}`, error.message);
                }
            }
            
            // 关键词过滤
            if (!this.passesKeywordFilter(article)) {
                return false;
            }
            
            return true;
        }).map(article => {
            // 清理文章数据
            return {
                ...article,
                title: article.title.trim(),
                description: stripHtml(article.description || '').trim(),
                content: stripHtml(article.content || '').trim(),
                source: {
                    ...article.source,
                    name: article.source?.name?.trim() || '未知来源'
                }
            };
        });
    }

    /**
     * 检查文章是否通过关键词过滤
     * @param {Object} article - 新闻文章
     * @returns {boolean} 是否通过过滤
     */
    passesKeywordFilter(article) {
        const { filter } = config;
        
        // 如果关键词过滤未启用，直接通过
        if (!filter.enabled || !filter.keywords || filter.keywords.length === 0) {
            return true;
        }
        
        // 准备要检查的文本内容
        const textsToCheck = [];
        
        if (filter.filterTitle && article.title) {
            textsToCheck.push(article.title.toLowerCase());
        }
        
        if (filter.filterContent) {
            if (article.description) {
                textsToCheck.push(article.description.toLowerCase());
            }
            if (article.content) {
                textsToCheck.push(article.content.toLowerCase());
            }
        }
        
        if (filter.filterSource && article.source?.name) {
            textsToCheck.push(article.source.name.toLowerCase());
        }
        
        // 如果没有要检查的文本，直接通过
        if (textsToCheck.length === 0) {
            return true;
        }
        
        // 检查是否包含任何屏蔽关键词
        const combinedText = textsToCheck.join(' ');
        for (const keyword of filter.keywords) {
            if (keyword && keyword.trim() && combinedText.includes(keyword.toLowerCase().trim())) {
                logger.debug('NEWS', `关键词过滤: "${keyword}"`, { title: article.title });
                return false;
            }
        }
        
        return true;
    }

    /**
     * 检查新闻是否重复
     * @param {Array} articles - 新闻文章数组
     * @returns {Array} 去重后的新闻文章数组
     */
    removeDuplicateArticles(articles) {
        const seen = new Set();
        
        const normalizeTitle = (t) => {
            if (!t) return '';
            // 去掉来源后缀（例如 “ - BBC” / “ — AP”）及多余标点与空白
            return t
                .replace(/\s*[\-|—]\s*[A-Za-z0-9 .,&()]+$/g, '')
                .replace(/[\u2018\u2019\u201c\u201d]/g, '"')
                .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ') // 去标点
                .toLowerCase()
                .replace(/\s+/g, ' ') // 归一空白
                .trim();
        };
        
        return articles.filter(article => {
            // 优先使用翻译后的标题进行归一，再回退到原始标题
            const keyTitle = normalizeTitle(article.translatedTitle || article.title || '');
            if (!keyTitle) return false;
            
            // 对完全相同（归一后）标题进行去重（忽略不同来源URL）
            if (seen.has(keyTitle)) {
                return false;
            }
            
            seen.add(keyTitle);
            return true;
        });
    }

    /**
     * 加载本地新闻数据
     * @returns {Promise<boolean>} 是否成功加载
     */
    async loadLocalData() {
        const { readJsonFile } = require('../utils/helpers');
        const path = require('path');
        
        try {
            const dataFile = path.join(__dirname, '..', 'data', 'news.json');
            const data = await readJsonFile(dataFile);
            
            if (data && data.news) {
                // 优先更新状态管理器
                if (this.stateManager) {
                    this.stateManager.updateNewsData(data.news);
                    if (data.lastUpdated) {
                        this.stateManager.set('lastUpdated', data.lastUpdated);
                    }
                } else {
                    // 向后兼容
                    this.newsData = data.news;
                    this.lastUpdated = data.lastUpdated ? new Date(data.lastUpdated) : null;
                }
                
                logger.info('NEWS', `从本地文件加载了 ${data.news.length} 条新闻数据`);
                return true;
            }
            
            logger.info('NEWS', '本地新闻数据文件为空或格式不正确');
            return false;
            
        } catch (error) {
            if (error.code === 'ENOENT') {
                logger.info('NEWS', '没有找到本地新闻数据，将在首次刷新时获取');
            } else {
                logger.error('NEWS', '读取本地新闻数据失败', error.message);
            }
            return false;
        }
    }

    /**
     * 保存新闻数据到本地
     * @param {Array} data - 新闻数据
     * @returns {Promise<void>}
     */
    async saveLocalData(data = null) {
        const { writeJsonFile, ensureDirectoryExists } = require('../utils/helpers');
        const path = require('path');
        
        try {
            const dataDir = path.join(__dirname, '..', 'data');
            const dataFile = path.join(dataDir, 'news.json');
            
            // 确保目录存在
            await ensureDirectoryExists(dataDir);
            
            const newsDataWithTimestamp = {
                news: data || this.newsData,
                lastUpdated: new Date().toISOString(),
                total: (data || this.newsData).length
            };
            
            await writeJsonFile(dataFile, newsDataWithTimestamp);
            logger.info('NEWS', `数据已保存到本地: ${dataFile}`);
            
        } catch (error) {
            logger.error('NEWS', '保存数据失败', error.message);
            throw error;
        }
    }

    /**
     * 生成新闻唯一标识符
     * @param {Object} article - 新闻文章
     * @returns {string} 唯一标识符
     */
    generateNewsId(article) {
        // 使用标题、URL和发布时间生成唯一ID
        const title = article.title.toLowerCase().replace(/\s+/g, ' ').trim();
        const url = article.url || '';
        const publishedAt = article.publishedAt || '';
        return `${title}_${url}_${publishedAt}`;
    }

    /**
     * 检查新闻是否已处理过
     * @param {Object} article - 新闻文章
     * @returns {boolean} 是否已处理
     */
    isNewsProcessed(article) {
        const newsId = this.generateNewsId(article);
        return this.processedNewsIds.has(newsId);
    }

    /**
     * 标记新闻为已处理
     * @param {Object} article - 新闻文章
     */
    markNewsAsProcessed(article) {
        const newsId = this.generateNewsId(article);
        this.processedNewsIds.add(newsId);
        
        // 限制已处理新闻的数量，避免内存泄漏
        if (this.processedNewsIds.size > 1000) {
            const oldestIds = Array.from(this.processedNewsIds).slice(0, 100);
            oldestIds.forEach(id => this.processedNewsIds.delete(id));
        }
    }

    /**
     * 获取增量更新的新闻（先全部去重，再取最新30条）
     * @returns {Promise<Array>} 新的新闻文章数组
     */
    async fetchIncrementalNews() {
        try {
            logger.info('NEWS', '开始增量获取新闻数据');
            
            // 并行获取所有新闻源的数据
            const [newsApiArticles, gnewsArticles, rssArticles, webScrapingArticles] = await Promise.all([
                this.fetchNewsApiArticles(),
                this.fetchGnewsArticles(),
                this.fetchRSSArticles(),
                this.webScrapingService.fetchWebScrapingArticles()
            ]);

            // 合并所有新闻数据
            let allArticles = [...newsApiArticles, ...gnewsArticles, ...rssArticles, ...webScrapingArticles];
            
            logger.info('NEWS', `获取新闻总数: ${allArticles.length}`, {
                newsApi: newsApiArticles.length,
                gnews: gnewsArticles.length,
                rss: rssArticles.length,
                webScraping: webScrapingArticles.length
            });

            // 应用过滤和清理
            allArticles = this.filterAndCleanArticles(allArticles);
            logger.debug('NEWS', `过滤清理后: ${allArticles.length}条`);

            // 基础去重（快速去除明显重复）
            allArticles = this.removeDuplicateArticles(allArticles);
            logger.debug('NEWS', `基础去重后: ${allArticles.length}条`);
            
            // 按发布时间排序（最新的在前面）
            allArticles.sort((a, b) => {
                const dateA = new Date(a.publishedAt || 0);
                const dateB = new Date(b.publishedAt || 0);
                return dateB - dateA;
            });

            // 使用AI智能去重（对所有新闻进行去重）
            if (allArticles.length > 1) {
                const AIService = require('./ai_service');
                const aiService = new AIService();

                try {
                    allArticles = await aiService.removeDuplicateNewsWithAI(allArticles);
                    logger.info('AI', `AI去重完成: ${allArticles.length}条新闻`);
                } catch (error) {
                    logger.error('NEWS', 'AI去重失败，使用基础去重', error.message);
                }
            }

            // AI智能选择最优质30条新闻（基于来源权威性、内容完整性等）
            let latestArticles;
            if (allArticles.length > 30) {
                const AIService = require('./ai_service');
                const aiService = new AIService();
                
                try {
                    latestArticles = await aiService.selectTopQualityNews(allArticles, 30);
                    logger.info('AI', `AI智能选择完成, ${latestArticles.length} articles selected.`);
                } catch (error) {
                    logger.error('NEWS', 'AI智能选择失败，使用默认排序', error.message);
                    // 备用：按时间排序取前30条
                    latestArticles = allArticles.slice(0, 30);
                }
            } else {
                latestArticles = allArticles;
            }

            // 过滤掉已处理过的新闻
            const newArticles = latestArticles.filter(article => !this.isNewsProcessed(article));
            
            logger.info('NEWS', `增量更新结果: 总新闻${allArticles.length}条, 新新闻${newArticles.length}条, 最新${latestArticles.length}条`);
            
            return latestArticles;
            
        } catch (error) {
            logger.error('NEWS', '增量获取新闻失败', error.message);
            throw error;
        }
    }

    /**
     * 获取新闻数据
     * @returns {Array} 当前新闻数据
     */
    getNewsData() {
        if (this.stateManager) {
            return this.stateManager.get('newsData') || [];
        }
        return this.newsData;
    }

    /**
     * 设置新闻数据
     * @param {Array} data - 新闻数据
     */
    setNewsData(data) {
        if (this.stateManager) {
            this.stateManager.updateNewsData(data);
            this.stateManager.set('lastUpdated', new Date().toISOString());
        } else {
            this.newsData = data;
            this.lastUpdated = new Date();
        }
    }

    /**
     * 获取最后更新时间
     * @returns {Date|null} 最后更新时间
     */
    getLastUpdated() {
        if (this.stateManager) {
            const lastUpdated = this.stateManager.get('lastUpdated');
            return lastUpdated ? new Date(lastUpdated) : null;
        }
        return this.lastUpdated;
    }

    /**
     * 设置最后更新时间
     * @param {Date} date - 更新时间
     */
    setLastUpdated(date) {
        if (this.stateManager) {
            this.stateManager.set('lastUpdated', date.toISOString());
        } else {
            this.lastUpdated = date;
        }
    }

    /**
     * 获取新闻统计信息
     * @returns {Object} 统计信息
     */
    getNewsStats() {
        const newsData = this.getNewsData();
        const lastUpdated = this.getLastUpdated();
        
        const regions = [...new Set(newsData.map(news => news.region).filter(region => region))];
        const sources = [...new Set(newsData.map(news => news.source?.name).filter(source => source))];
        
        return {
            total: newsData.length,
            regions: regions.length > 0 ? regions : ['全球'],
            sources: sources,
            lastUpdated: lastUpdated
        };
    }

    /**
     * 根据条件搜索新闻
     * @param {Object} criteria - 搜索条件
     * @returns {Array} 匹配的新闻文章
     */
    searchNews(criteria = {}) {
        let results = [...this.getNewsData()];
        
        // 按关键词搜索
        if (criteria.keyword) {
            const keyword = criteria.keyword.toLowerCase();
            results = results.filter(article => 
                article.title.toLowerCase().includes(keyword) ||
                article.description.toLowerCase().includes(keyword) ||
                article.translatedTitle?.toLowerCase().includes(keyword) ||
                article.summary?.toLowerCase().includes(keyword)
            );
        }
        
        // 按地区过滤
        if (criteria.region) {
            results = results.filter(article => 
                article.region === criteria.region
            );
        }
        
        // 按来源过滤
        if (criteria.source) {
            results = results.filter(article => 
                article.source?.name === criteria.source
            );
        }
        
        // 按时间范围过滤
        if (criteria.dateFrom || criteria.dateTo) {
            results = results.filter(article => {
                const articleDate = new Date(article.publishedAt);
                
                if (criteria.dateFrom && articleDate < new Date(criteria.dateFrom)) {
                    return false;
                }
                
                if (criteria.dateTo && articleDate > new Date(criteria.dateTo)) {
                    return false;
                }
                
                return true;
            });
        }
        
        return results;
    }

    /**
     * 跟踪失效源
     * @param {string} sourceName - 源名称
     * @param {string} errorMessage - 错误信息
     */
    trackFailedSource(sourceName, errorMessage) {
        const currentCount = this.failedSources.get(sourceName) || 0;
        const newCount = currentCount + 1;
        this.failedSources.set(sourceName, newCount);
        
        // 如果连续失败达到阈值，生成警告日志
        if (newCount >= this.failedSourceThreshold) {
            logger.warn('NEWS', `⚠️ 源持续失效警告：${sourceName} 已连续失败${newCount}次`);
            logger.warn('NEWS', `最后错误信息：${errorMessage}`);
            
            // 每5次失败后继续提示，避免日志过多
            if (newCount % 5 === 0) {
                logger.warn('NEWS', `🔴 ${sourceName} 源持续不可用，请检查网络连接或API配置`);
            }
        }
    }
    
    /**
     * 重置源失败计数（当源成功获取时调用）
     * @param {string} sourceName - 源名称
     */
    resetFailedSource(sourceName) {
        if (this.failedSources.has(sourceName)) {
            const previousCount = this.failedSources.get(sourceName);
            if (previousCount >= this.failedSourceThreshold) {
                logger.info('NEWS', `✅ ${sourceName} 源已恢复正常`);
            }
            this.failedSources.delete(sourceName);
        }
    }

    /**
     * 基于规则的新闻地域判断（作为AI分类的后备）
     * @param {Object} article - 新闻文章
     * @returns {string|null} 地域名称或null
     */
    determineRegionByRule(article) {
        const title = (article.title || '').toLowerCase();
        const description = (article.description || '').toLowerCase();
        const sourceName = (article.source?.name || '').toLowerCase();
        const content = (article.content || '').toLowerCase();
        const fullText = `${title} ${description} ${sourceName} ${content}`;
        
        // 1. 基于来源的判断
        if (sourceName.includes('china') || sourceName.includes('xinhua') || sourceName.includes('scmp') || sourceName.includes('global times')) return '中国';
        if (sourceName.includes('bbc') || sourceName.includes('reuters') || sourceName.includes('guardian')) return '欧洲'; // 或者是国际
        if (sourceName.includes('cnn') || sourceName.includes('fox') || sourceName.includes('nytimes') || sourceName.includes('washington post')) return '美国';
        if (sourceName.includes('al jazeera')) return '中东';
        if (sourceName.includes('korea') || sourceName.includes('yonhap')) return '韩国';
        if (sourceName.includes('japan') || sourceName.includes('kyodo') || sourceName.includes('nikkei')) return '日本';
        
        // 2. 基于内容的关键词判断
        // 中国
        if (fullText.includes('china') || fullText.includes('beijing') || fullText.includes('shanghai') || fullText.includes('chinese') || fullText.includes('xi jinping')) return '中国';
        // 美国
        if (fullText.includes('usa') || fullText.includes('united states') || fullText.includes('america') || fullText.includes('white house') || fullText.includes('biden') || fullText.includes('trump')) return '美国';
        // 欧洲
        if (fullText.includes('europe') || fullText.includes('eu ') || fullText.includes('uk ') || fullText.includes('britain') || fullText.includes('germany') || fullText.includes('france') || fullText.includes('ukraine') || fullText.includes('russia')) return '欧洲';
        // 日本
        if (fullText.includes('japan') || fullText.includes('tokyo')) return '日本';
        // 韩国
        if (fullText.includes('korea') || fullText.includes('seoul')) return '韩国';
        // 中东
        if (fullText.includes('middle east') || fullText.includes('israel') || fullText.includes('gaza') || fullText.includes('palestine') || fullText.includes('iran') || fullText.includes('iraq') || fullText.includes('saudi')) return '中东';
        // 东南亚
        if (fullText.includes('asean') || fullText.includes('vietnam') || fullText.includes('thailand') || fullText.includes('philippines') || fullText.includes('indonesia') || fullText.includes('malaysia') || fullText.includes('singapore')) return '东南亚';
        
        // 默认返回null，由调用者决定默认值
        return null;
    }
}

module.exports = NewsService;