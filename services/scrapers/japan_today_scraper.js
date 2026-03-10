const BaseScraper = require('./base_scraper');

/**
 * Japan Today抓取器
 * 专门用于抓取Japan Today网站的新闻
 */
class JapanTodayScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Japan Today',
            baseUrl: 'https://japantoday.com/category/world',
            ...config
        });
    }

    /**
     * 获取Japan Today的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            // 文章链接选择器 - 使用更精确的选择器
            articleLinks: [
                'a[href*="/category/world/"]',
                'a[href^="/category/"][href*="-"]'
            ],
            
            // 文章详情页选择器
            title: [
                'h1',
                '.headline', 
                '.story-title'
            ],
            content: [
                'div[itemprop="articleBody"]',
                '.story-content',
                '.article-content', 
                '.entry-content'
                // 移除 'p' 选择器，防止抓取到页脚或其他非正文内容
            ],
            publishedAt: [
                'time[datetime]',
                'time',
                '.date',
                '.timestamp'
            ],
            image: [
                'meta[property="og:image"]',
                '.story-image img',
                '.article-image img',
                'img'
            ]
        };
    }

    /**
     * 验证是否为有效的Japan Today文章URL
     * @param {string} url - 要验证的URL
     * @returns {boolean} 是否为有效的文章URL
     */
    isValidArticleUrl(url) {
        // 排除已知的非文章页面
        if (url.includes('/category/new-products') || 
            url.includes('/category/features') || 
            url.includes('/category/reviews') ||
            url.includes('/category/executive-impact')) {
            return false;
        }

        // Japan Today的文章URL格式: /category/xxx/article-title
        return url.includes('japantoday.com/category/') && url.match(/\/category\/\w+\/[\w-]+$/);
    }

    /**
     * 获取支持的新闻分类URL
     * @returns {Array} 分类URL数组
     */
    static getSupportedCategories() {
        return [
            {
                name: 'World',
                url: 'https://japantoday.com/category/world',
                description: 'World news'
            },
            {
                name: 'National',
                url: 'https://japantoday.com/category/national',
                description: 'Japan national news'
            },
            {
                name: 'Crime',
                url: 'https://japantoday.com/category/crime',
                description: 'Crime news'
            },
            {
                name: 'Politics',
                url: 'https://japantoday.com/category/politics',
                description: 'Political news'
            },
            {
                name: 'Business',
                url: 'https://japantoday.com/category/business',
                description: 'Business news'
            },
            {
                name: 'Tech',
                url: 'https://japantoday.com/category/tech',
                description: 'Technology news'
            },
            {
                name: 'Entertainment',
                url: 'https://japantoday.com/category/entertainment',
                description: 'Entertainment news'
            },
            {
                name: 'Sports',
                url: 'https://japantoday.com/category/sports',
                description: 'Sports news'
            },
            {
                name: 'Features',
                url: 'https://japantoday.com/category/features',
                description: 'Feature articles'
            },
            {
                name: 'Lifestyle',
                url: 'https://japantoday.com/category/lifestyle',
                description: 'Lifestyle news'
            }
        ];
    }

    /**
     * 创建指定分类的Japan Today抓取器
     * @param {string} category - 分类名称
     * @param {Object} config - 配置选项
     * @returns {JapanTodayScraper|null} 抓取器实例
     */
    static createCategoryScraper(category, config = {}) {
        const categories = JapanTodayScraper.getSupportedCategories();
        const categoryInfo = categories.find(cat => cat.name === category);
        
        if (!categoryInfo) {
            return null;
        }
        
        return new JapanTodayScraper({
            name: `Japan Today - ${categoryInfo.name}`,
            baseUrl: categoryInfo.url,
            ...config
        });
    }
}

module.exports = JapanTodayScraper;