/**
 * 网页抓取器模块索引文件
 * 提供统一的导入接口
 */

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

const ScraperFactory = require('./scraper_factory');

module.exports = {
    // 基础类
    BaseScraper,
    
    // 专用抓取器
    APNewsScraper,
    JapanTodayScraper,
    FoxNewsScraper,
    AlJazeeraScraper,
    ChannelNewsAsiaScraper,
    TaipeiTimesScraper,
    NhkWorldScraper,
    RussiaTodayScraper,
    DongaNewsScraper,
    
    // 工厂类
    ScraperFactory,
    
    // 便捷方法
    createScraper: (url, config) => ScraperFactory.createScraper(url, config),
    createScraperFromSource: (source, config) => ScraperFactory.createScraperFromSource(source, config),
    getSupportedSites: () => ScraperFactory.getSupportedSites(),
    isSupported: (url) => ScraperFactory.isSupported(url),
    getScraperType: (url) => ScraperFactory.getScraperType(url)
};