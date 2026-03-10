const BaseScraper = require('./base_scraper');

/**
 * AP News抓取器
 * 专门用于抓取AP News网站的新闻
 */
class APNewsScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'AP News',
            baseUrl: 'https://apnews.com',
            ...config
        });
    }

    /**
     * 获取AP News的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                'article h3 a',
                '.PagePromo-content a',
                '.PageList-items-item h3 a',
                '.Component-root a[data-key]'
            ],
            title: [
                'h1',
                '.Page-headline',
                '.RichTextStoryBody h1'
            ],
            content: [
                '.RichTextStoryBody',
                '.Article',
                'article .content'
            ],
            publishedAt: [
                'time',
                '.Timestamp',
                '[data-source="AP"]'
            ],
            image: [
                '.RichTextStoryBody img',
                '.LeadPhoto img',
                '.Page-image img',
                'article img',
                'figure img',
                '.Component-image img',
                '[data-module="ArticlePhoto"] img'
            ]
        };
    }

    /**
     * 辅助方法：提取JSON-LD
     */
    extractJsonLd($) {
        const scripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < scripts.length; i++) {
            try {
                const data = JSON.parse($(scripts[i]).html());
                const items = Array.isArray(data) ? data : [data];
                
                // 查找 NewsArticle 或 Article
                const article = items.find(item => 
                    item['@type'] === 'NewsArticle' || 
                    item['@type'] === 'Article' || 
                    item['@type'] === 'ReportageNewsArticle'
                );
                
                if (article) return article;
            } catch (e) {}
        }
        return null;
    }

    /**
     * 提取标题
     */
    extractTitle($, selectors) {
        // 1. 尝试从JSON-LD提取
        try {
            const jsonLd = this.extractJsonLd($);
            if (jsonLd && jsonLd.headline) {
                return jsonLd.headline;
            }
        } catch (e) {}
        
        // 2. 标准提取
        return super.extractTitle($, selectors);
    }

    /**
     * 提取发布时间
     */
    extractPublishedAt($, selectors) {
        // 1. 尝试从JSON-LD提取
        try {
            const jsonLd = this.extractJsonLd($);
            if (jsonLd && (jsonLd.datePublished || jsonLd.dateModified)) {
                return jsonLd.datePublished || jsonLd.dateModified;
            }
        } catch (e) {}
        
        // 2. 标准提取
        return super.extractPublishedAt($, selectors);
    }

    /**
     * 提取图片
     */
    extractImage($, selectors, articleUrl) {
        // 1. 尝试从JSON-LD提取
        try {
            const jsonLd = this.extractJsonLd($);
            if (jsonLd && jsonLd.image) {
                if (Array.isArray(jsonLd.image)) {
                     // 通常第一个图片是主图
                     const img = jsonLd.image[0];
                     return img.url || img;
                } else if (typeof jsonLd.image === 'object') {
                    return jsonLd.image.url;
                } else {
                    return jsonLd.image;
                }
            }
        } catch (e) {}
        
        // 2. 标准提取
        return super.extractImage($, selectors, articleUrl);
    }

    /**
     * 提取内容
     */
    extractContent($, selectors) {
        // 移除干扰元素
        $('.Advertisement, script, style, .ad-container, .video-container, .share-tools, .SecondaryStoryComponent').remove();
        
        // 清理可能残留的内联脚本
        const content = super.extractContent($, selectors);
        
        // 简单的后处理，移除freestar等常见脚本残留
        // 注意：这里操作的是文本，所以只能用正则
        if (content) {
            return content
                .replace(/freestar\.queue\.push\(function[\s\S]*?\)\;?/g, '')
                .replace(/window\._taboola[\s\S]*?;/g, '')
                .trim();
        }
        return content;
    }

    /**
     * 验证是否为有效的AP News文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是AP News域名
            if (urlObj.hostname !== 'apnews.com') {
                return false;
            }
            
            // AP News特殊的URL模式验证
            const pathname = urlObj.pathname;
            
            // 排除非文章页面
            const excludePatterns = [
                '/hub/',
                '/topics/',
                '/tag/',
                '/ap-top-news',
                '/sports',
                '/business',
                '/politics',
                '/world-news',
                '/us-news',
                '/health',
                '/science',
                '/technology',
                '/entertainment',
                '/lifestyle'
            ];
            
            // 如果路径只是分类页面，不是具体文章
            for (const pattern of excludePatterns) {
                if (pathname === pattern || pathname === pattern + '/') {
                    return false;
                }
            }
            
            // 调用父类的通用验证
            return super.isValidArticleUrl(url);
            
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取支持的新闻分类URL
     * @returns {Array} 分类URL数组
     */
    static getSupportedCategories() {
        return [
            {
                name: 'Top News',
                url: 'https://apnews.com/ap-top-news',
                description: 'Top breaking news'
            },
            {
                name: 'World News',
                url: 'https://apnews.com/world-news',
                description: 'International news'
            },
            {
                name: 'US News',
                url: 'https://apnews.com/us-news',
                description: 'United States news'
            },
            {
                name: 'Politics',
                url: 'https://apnews.com/politics',
                description: 'Political news'
            },
            {
                name: 'Business',
                url: 'https://apnews.com/business',
                description: 'Business and economy news'
            },
            {
                name: 'Technology',
                url: 'https://apnews.com/technology',
                description: 'Technology news'
            },
            {
                name: 'Sports',
                url: 'https://apnews.com/sports',
                description: 'Sports news'
            },
            {
                name: 'Health',
                url: 'https://apnews.com/health',
                description: 'Health and medical news'
            },
            {
                name: 'Science',
                url: 'https://apnews.com/science',
                description: 'Science news'
            },
            {
                name: 'Entertainment',
                url: 'https://apnews.com/entertainment',
                description: 'Entertainment news'
            }
        ];
    }

    /**
     * 创建指定分类的AP News抓取器
     * @param {string} category - 分类名称
     * @param {Object} config - 配置选项
     * @returns {APNewsScraper|null} 抓取器实例
     */
    static createCategoryScraper(category, config = {}) {
        const categories = APNewsScraper.getSupportedCategories();
        const categoryInfo = categories.find(cat => cat.name === category);
        
        if (!categoryInfo) {
            return null;
        }
        
        return new APNewsScraper({
            name: `AP News - ${categoryInfo.name}`,
            baseUrl: categoryInfo.url,
            ...config
        });
    }
}

module.exports = APNewsScraper;