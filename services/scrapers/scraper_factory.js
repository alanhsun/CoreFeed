const BaseScraper = require('./base_scraper');
const APNewsScraper = require('./ap_news_scraper');
const JapanTodayScraper = require('./japan_today_scraper');
const FoxNewsScraper = require('./fox_news_scraper');
const AlJazeeraScraper = require('./al_jazeera_scraper');
const ChannelNewsAsiaScraper = require('./channel_news_asia_scraper');
const TaipeiTimesScraper = require('./taipei_times_scraper');
const NhkWorldScraper = require('./nhk_world_scraper');
const RussiaTodayScraper = require('./russia_today_scraper');
const DongaNewsScraper = require('./donga_news_scraper');
const { URL } = require('url');
const logger = require('../../utils/logger');

/**
 * 抓取器工厂类
 * 负责根据URL创建合适的抓取器实例
 */
class ScraperFactory {
    constructor() {
        // 注册所有可用的抓取器
        this.scrapers = new Map();
        this.registerScrapers();
    }

    /**
     * 注册所有抓取器
     */
    registerScrapers() {
        // AP News
        this.scrapers.set('apnews.com', APNewsScraper);
        
        // Japan Today
        this.scrapers.set('japantoday.com', JapanTodayScraper);
        this.scrapers.set('www.japantoday.com', JapanTodayScraper);
        
        // Fox News
        this.scrapers.set('foxnews.com', FoxNewsScraper);
        this.scrapers.set('www.foxnews.com', FoxNewsScraper);
        
        // Al Jazeera
        this.scrapers.set('aljazeera.com', AlJazeeraScraper);
        this.scrapers.set('www.aljazeera.com', AlJazeeraScraper);
        
        // Channel News Asia
        this.scrapers.set('channelnewsasia.com', ChannelNewsAsiaScraper);
        this.scrapers.set('www.channelnewsasia.com', ChannelNewsAsiaScraper);
        
        // Taipei Times
        this.scrapers.set('taipeitimes.com', TaipeiTimesScraper);
        this.scrapers.set('www.taipeitimes.com', TaipeiTimesScraper);
        
        // NHK World
        this.scrapers.set('www3.nhk.or.jp', NhkWorldScraper);
        this.scrapers.set('nhk.or.jp', NhkWorldScraper);
        
        // Russia Today (RT.com)
        this.scrapers.set('rt.com', RussiaTodayScraper);
        this.scrapers.set('www.rt.com', RussiaTodayScraper);

        // Donga News
        this.scrapers.set('donga.com', DongaNewsScraper);
        this.scrapers.set('www.donga.com', DongaNewsScraper);
    }

    /**
     * 根据URL创建合适的抓取器
     * @param {string} url - 网站URL
     * @param {Object} config - 配置选项
     * @returns {BaseScraper} 抓取器实例
     */
    createScraper(url, config = {}) {
        try {
            const urlObj = new URL(url);
            const hostname = urlObj.hostname;
            
            // 查找专用抓取器
            const ScraperClass = this.scrapers.get(hostname);
            
            if (ScraperClass) {
                logger.debug('WEBSCRAPING', `使用专用抓取器: ${ScraperClass.name} for ${hostname}`);
                return new ScraperClass({
                    baseUrl: url,
                    ...config
                });
            } else {
                // 不支持的网站，返回null
                logger.warn('WEBSCRAPING', `不支持的网站: ${hostname}，请使用专用抓取器`);
                return null;
            }
            
        } catch (error) {
            logger.error('WEBSCRAPING', `创建抓取器失败: ${url}`, error.message);
            return null;
        }
    }

    /**
     * 根据源配置创建抓取器
     * @param {Object} source - 源配置 {name, url}
     * @param {Object} config - 配置选项
     * @returns {BaseScraper} 抓取器实例
     */
    createScraperFromSource(source, config = {}) {
        const scraper = this.createScraper(source.url, config);
        
        if (scraper && source.name) {
            // 如果源配置中有名称，使用该名称
            scraper.name = source.name;
        }
        
        return scraper;
    }

    /**
     * 获取所有支持的网站列表
     * @returns {Array} 支持的网站列表
     */
    getSupportedSites() {
        const sites = [];
        
        // 添加专用抓取器支持的网站
        for (const [hostname, ScraperClass] of this.scrapers) {
            sites.push({
                hostname: hostname,
                scraperType: ScraperClass.name,
                categories: ScraperClass.getSupportedCategories ? ScraperClass.getSupportedCategories() : []
            });
        }
        
        return sites;
    }

    /**
     * 检查是否支持指定网站
     * @param {string} url - 网站URL
     * @returns {boolean} 是否支持
     */
    isSupported(url) {
        try {
            const urlObj = new URL(url);
            return this.scrapers.has(urlObj.hostname);
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取网站的抓取器类型
     * @param {string} url - 网站URL
     * @returns {string} 抓取器类型
     */
    getScraperType(url) {
        try {
            const urlObj = new URL(url);
            const ScraperClass = this.scrapers.get(urlObj.hostname);
            return ScraperClass ? ScraperClass.name : 'Unsupported';
        } catch (error) {
            return 'Unsupported';
        }
    }

    /**
     * 注册新的抓取器
     * @param {string} hostname - 主机名
     * @param {Class} ScraperClass - 抓取器类
     */
    registerScraper(hostname, ScraperClass) {
        this.scrapers.set(hostname, ScraperClass);
        logger.info('WEBSCRAPING', `注册新抓取器: ${ScraperClass.name} for ${hostname}`);
    }

    /**
     * 注销抓取器
     * @param {string} hostname - 主机名
     */
    unregisterScraper(hostname) {
        if (this.scrapers.has(hostname)) {
            this.scrapers.delete(hostname);
            logger.info('WEBSCRAPING', `注销抓取器: ${hostname}`);
        }
    }

    /**
     * 批量创建抓取器
     * @param {Array} sources - 源配置数组
     * @param {Object} config - 配置选项
     * @returns {Array} 抓取器实例数组
     */
    createScrapers(sources, config = {}) {
        const scrapers = [];
        
        for (const source of sources) {
            const scraper = this.createScraperFromSource(source, config);
            if (scraper) {
                scrapers.push(scraper);
            }
        }
        
        return scrapers;
    }

    /**
     * 获取抓取器统计信息
     * @returns {Object} 统计信息
     */
    getStats() {
        const stats = {
            totalRegistered: this.scrapers.size,
            specializedScrapers: 0,
            supportedSites: []
        };
        
        for (const [hostname, ScraperClass] of this.scrapers) {
            stats.specializedScrapers++;
            stats.supportedSites.push({
                hostname: hostname,
                scraperType: ScraperClass.name
            });
        }
        
        return stats;
    }
}

// 导出单例实例
module.exports = new ScraperFactory();