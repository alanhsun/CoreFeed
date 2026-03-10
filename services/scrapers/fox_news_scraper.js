const BaseScraper = require('./base_scraper');
const logger = require('../../utils/logger');
const { delay } = require('../../utils/helpers');

/**
 * Fox News抓取器
 * 专门用于抓取Fox News网站的新闻
 */
class FoxNewsScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Fox News',
            baseUrl: 'https://www.foxnews.com/world',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...config
        });

        // 配置更真实的请求头
        this.httpClient.defaults.headers = {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'DNT': '1',
            'Cache-Control': 'no-cache'
        };

        // 备用URL列表
        this.alternativeUrls = [
            'https://www.foxnews.com',
            'https://www.foxnews.com/us',
            'https://www.foxnews.com/politics',
            'https://www.foxnews.com/world',
            'https://www.foxnews.com/tech'
        ];
    }

    /**
     * 重写抓取方法，添加备用策略
     */
    async scrapeArticles(maxArticles = 10) {
        logger.info('WEBSCRAPING', `尝试抓取Fox News: ${this.baseUrl}`);

        // 策略1: 抓取主URL
        logger.info('WEBSCRAPING', '策略1: 抓取主URL');
        let articles = await this.tryScrape(this.baseUrl, maxArticles);
        if (articles.length > 0) {
            logger.success('WEBSCRAPING', `从主URL成功抓取 ${articles.length} 篇文章`);
            return articles;
        }

        // 策略2: 尝试备用URL
        logger.info('WEBSCRAPING', '策略2: 尝试备用URL');
        for (const altUrl of this.alternativeUrls) {
            if (altUrl === this.baseUrl) continue; // 跳过主URL

            logger.debug('WEBSCRAPING', `尝试备用URL: ${altUrl}`);
            articles = await this.tryScrape(altUrl, maxArticles);

            if (articles.length > 0) {
                logger.success('WEBSCRAPING', `从备用URL成功抓取: ${altUrl}`);
                return articles;
            }

            await delay(2000); // 避免请求过快
        }

        logger.warn('WEBSCRAPING', 'Fox News所有抓取策略均失败');
        return [];
    }

    /**
     * 尝试从指定URL抓取文章
     */
    async tryScrape(url, maxArticles) {
        try {
            const response = await this.httpClient.get(url);
            const html = response.data;
            const cheerio = require('cheerio');
            const $ = cheerio.load(html);

            return await this.extractArticles($, maxArticles, url);

        } catch (error) {
            logger.debug('WEBSCRAPING', `抓取失败 (${url}): ${error.message}`);
            return [];
        }
    }

    /**
     * 重写提取内容方法，优先尝试从JSON-LD提取
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        // 1. 尝试从JSON-LD提取 (Fox News的JSON-LD包含非常干净的articleBody)
        try {
            const jsonLdScripts = $('script[type="application/ld+json"]');
            for (let i = 0; i < jsonLdScripts.length; i++) {
                const scriptContent = $(jsonLdScripts[i]).html();
                if (!scriptContent) continue;

                const data = JSON.parse(scriptContent);
                
                // 处理数组/图形式的JSON-LD
                const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
                
                for (const item of items) {
                    if (item.articleBody) {
                        logger.debug('WEBSCRAPING', '从JSON-LD成功提取文章内容');
                        return item.articleBody;
                    }
                }
            }
        } catch (error) {
            logger.debug('WEBSCRAPING', `JSON-LD内容提取失败: ${error.message}`);
        }

        // 2. 尝试清理常见的干扰元素
        $('.video-ct, .video-player, .ad-container, .speakable, .featured-video').remove();

        // 3. 回退到标准选择器提取
        return super.extractContent($, selectors);
    }

    /**
     * 获取Fox News的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            // 文章链接选择器 - 基于调试结果优化
            articleLinks: [
                '.article a[href*="/world/"]',
                '.content a[href*="/world/"]',
                '.title a[href*="/world/"]',
                'article a[href*="/world/"]',
                'a[href*="/world/"][href*="-"]',
                'a[href*="/politics/"][href*="-"]',
                'a[href*="/us/"][href*="-"]'
            ],
            
            // 文章详情页选择器
            title: [
                'h1.headline',
                'h1',
                '.article-header h1',
                '.story-title',
                '.title h1',
                '[data-module="ArticleHeader"] h1'
            ],
            content: [
                '[data-module="ArticleBody"]',
                '.article-body',
                '.article-content',
                '.story-body',
                '.entry-content',
                '.content p',
                'p'
            ],
            publishedAt: [
                'time[datetime]',
                '.article-date time',
                '.timestamp',
                '.date',
                '[data-module="ArticleHeader"] time'
            ],
            image: [
                'meta[property="og:image"]',
                '.article-image img',
                '.story-image img',
                '.featured-image img',
                'img'
            ]
        };
    }

    /**
     * 验证是否为有效的Fox News文章URL
     * @param {string} url - 要验证的URL
     * @returns {boolean} 是否为有效的文章URL
     */
    isValidArticleUrl(url) {
        // Fox News的文章URL格式: /category/article-title
        if (!url.includes('foxnews.com/')) {
            return false;
        }
        
        // 必须包含这些分类之一
        const validCategories = ['/world/', '/politics/', '/us/', '/tech/', '/sports/', '/entertainment/', '/health/', '/science/', '/lifestyle/'];
        const hasValidCategory = validCategories.some(category => url.includes(category));
        
        if (!hasValidCategory) {
            return false;
        }
        
        // 排除分类页面和其他非文章页面
        const excludePatterns = [
            '/category/',
            '/tag/',
            '/author/',
            '/search',
            '/archive',
            '/page/',
            '/video/',
            '/live/',
            '/shows/',
            '#',
            'javascript:',
            'mailto:'
        ];
        
        for (const pattern of excludePatterns) {
            if (url.includes(pattern)) {
                return false;
            }
        }
        
        // 文章URL应该有具体的标题（包含连字符）
        return url.match(/\/\w+\/[\w-]+-[\w-]+/) !== null;
    }

    /**
     * 获取支持的新闻分类URL
     * @returns {Array} 分类URL数组
     */
    static getSupportedCategories() {
        return [
            {
                name: 'World',
                url: 'https://www.foxnews.com/world',
                description: 'World news'
            },
            {
                name: 'Politics',
                url: 'https://www.foxnews.com/politics',
                description: 'Political news'
            },
            {
                name: 'US',
                url: 'https://www.foxnews.com/us',
                description: 'US news'
            },
            {
                name: 'Business',
                url: 'https://www.foxnews.com/category/us/economy',
                description: 'Business and economy news'
            },
            {
                name: 'Tech',
                url: 'https://www.foxnews.com/tech',
                description: 'Technology news'
            },
            {
                name: 'Sports',
                url: 'https://www.foxnews.com/sports',
                description: 'Sports news'
            },
            {
                name: 'Entertainment',
                url: 'https://www.foxnews.com/entertainment',
                description: 'Entertainment news'
            },
            {
                name: 'Health',
                url: 'https://www.foxnews.com/health',
                description: 'Health news'
            },
            {
                name: 'Science',
                url: 'https://www.foxnews.com/science',
                description: 'Science news'
            },
            {
                name: 'Lifestyle',
                url: 'https://www.foxnews.com/lifestyle',
                description: 'Lifestyle news'
            }
        ];
    }

    /**
     * 创建指定分类的Fox News抓取器
     * @param {string} category - 分类名称
     * @param {Object} config - 配置选项
     * @returns {FoxNewsScraper|null} 抓取器实例
     */
    static createCategoryScraper(category, config = {}) {
        const categories = FoxNewsScraper.getSupportedCategories();
        const categoryInfo = categories.find(cat => cat.name === category);
        
        if (!categoryInfo) {
            return null;
        }
        
        return new FoxNewsScraper({
            name: `Fox News - ${categoryInfo.name}`,
            baseUrl: categoryInfo.url,
            ...config
        });
    }
}

module.exports = FoxNewsScraper;