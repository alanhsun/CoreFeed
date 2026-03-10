const { URL } = require('url');
const config = require('../config');
const { delay, isValidUrl } = require('../utils/helpers');
const logger = require('../utils/logger');
const { ScraperFactory } = require('./scrapers');

/**
 * 网页抓取服务类
 * 用于抓取没有RSS源的网站新闻内容
 * 使用模块化的抓取器架构
 */
class WebScrapingService {
    constructor() {
        this.userAgent = config.webScraping.userAgent;
        this.timeout = config.webScraping.timeout;
        this.maxArticles = config.webScraping.maxArticles;
        this.retries = config.webScraping.retries;
        this.retryDelay = config.webScraping.retryDelay;
        this.delayBetweenRequests = config.webScraping.delayBetweenRequests;
        
        // 抓取器配置
        this.scraperConfig = {
            userAgent: this.userAgent,
            timeout: this.timeout,
            retries: this.retries,
            retryDelay: this.retryDelay,
            delayBetweenRequests: this.delayBetweenRequests
        };
    }

    /**
     * 从网页抓取源获取新闻
     * @returns {Promise<Array>} 新闻文章数组
     */
    async fetchWebScrapingArticles() {
        const { webScrapingSources, maxArticlesPerSource, sourceArticleCountsMap, disabledSources } = config.news;
        
        if (!config.webScraping.enabled) {
            logger.debug('WEBSCRAPING', '网页抓取已禁用');
            return [];
        }
        
        if (!webScrapingSources || typeof webScrapingSources !== 'string' || webScrapingSources.trim() === '') {
            logger.debug('WEBSCRAPING', '网页抓取源配置为空');
            return [];
        }

        const scrapingArticles = [];
        
        try {
            logger.info('WEBSCRAPING', '🕷️ 开始网页抓取...');
            
            // 解析网页抓取源配置
            const sources = this.parseWebScrapingSources(webScrapingSources);
            
            // 解析禁用源列表
            const disabledSourcesSet = new Set();
            if (disabledSources) {
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
            const enabledSources = sources.filter(scrapingSource => {
                const sourceName = scrapingSource.name || new URL(scrapingSource.url).hostname;
                return !disabledSourcesSet.has(sourceName);
            });
            
            if (enabledSources.length === 0) {
                logger.debug('WEBSCRAPING', '没有启用的网页抓取源');
                return [];
            }
            
            // 创建抓取器并执行抓取
            for (const scrapingSource of enabledSources) {
                try {
                    const sourceName = scrapingSource.name || new URL(scrapingSource.url).hostname;
                    const articleCount = sourceArticleCountsMap[sourceName] || maxArticlesPerSource;
                    
                    // 使用抓取器工厂创建合适的抓取器
                    const scraper = ScraperFactory.createScraperFromSource(scrapingSource, this.scraperConfig);
                    
                    if (!scraper) {
                        logger.error('WEBSCRAPING', `无法创建抓取器: ${sourceName}`);
                        continue;
                    }
                    
                    const articles = await scraper.scrapeArticles(scrapingSource.url, articleCount);
                    scrapingArticles.push(...articles);
                    
                    // 添加延迟避免被反爬虫
                    if (enabledSources.indexOf(scrapingSource) < enabledSources.length - 1) {
                        await delay(this.delayBetweenRequests);
                    }
                } catch (sourceError) {
                    const sourceName = scrapingSource.name || new URL(scrapingSource.url).hostname;
                    logger.error('WEBSCRAPING', `${sourceName}抓取失败`, sourceError.message);
                }
            }
            
            logger.info('WEBSCRAPING', `Fetched ${scrapingArticles.length} articles from web scraping.`);
            return scrapingArticles;
            
        } catch (error) {
            logger.error('WEBSCRAPING', '网页抓取失败', error.message);
            return [];
        }
    }

    /**
     * 解析网页抓取源配置
     * @param {string} webScrapingSources - 网页抓取源配置字符串
     * @returns {Array} 解析后的网页抓取源数组
     */
    parseWebScrapingSources(webScrapingSources) {
        if (!webScrapingSources || typeof webScrapingSources !== 'string') {
            return [];
        }
        
        return webScrapingSources.split(',').map(source => {
            const trimmed = source.trim();
            if (trimmed.includes('|')) {
                const [name, url] = trimmed.split('|').map(s => s.trim());
                return { name, url };
            } else {
                return { name: null, url: trimmed };
            }
        }).filter(source => source.url && isValidUrl(source.url));
    }


}

module.exports = WebScrapingService;