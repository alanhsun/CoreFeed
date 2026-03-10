const BaseScraper = require('./base_scraper');

/**
 * Al Jazeera抓取器
 * 专门用于抓取Al Jazeera网站的新闻
 */
class AlJazeeraScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Al Jazeera',
            baseUrl: 'https://www.aljazeera.com',
            ...config
        });
    }

    /**
     * 获取Al Jazeera的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                'article h3 a',
                '.gc__content h3 a',
                '.featured-articles-list article a',
                '.topics-sec-item h3 a',
                '.u-clickable-card__link',
                'h3.gc__title a',
                '.gc__title-wrap a'
            ],
            title: [
                'h1',
                '.article-header h1',
                '.post-title',
                '.wysiwyg h1'
            ],
            content: [
                '.wysiwyg',
                '.article-p-wrapper',
                '.main-article-body',
                'div[data-module="ArticleBody"]',
                '.post-content'
            ],
            publishedAt: [
                // 优先使用JSON-LD结构化数据
                'script[type="application/ld+json"]',
                // Meta标签
                'meta[property="article:published_time"]',
                'meta[name="article:published_time"]',
                'meta[property="article:modified_time"]',
                // HTML元素
                'time[datetime]',
                '[datetime]',
                'time',
                '.date-simple',
                '.article-dates time'
            ],
            image: [
                '.article-featured-image img',
                '.responsive-image img',
                '.main-article-body img',
                'figure img',
                '.wysiwyg img'
            ]
        };
    }

    /**
     * 提取内容
     * 重写以清理干扰元素
     */
    extractContent($, selectors) {
        // 移除干扰元素
        $('.related-story, .related-stories, .more-on-this, .interrupter, .advertisement, .ad-container, .video-container, script, style').remove();
        
        // 移除辅助功能隐藏文本
        $('.sr-only, .visually-hidden, .u-hidden, .hidden, [aria-hidden="true"]').remove();

        // 针对Al Jazeera特定的清理
        // 移除 "Recommended Stories" 列表
        // 这些通常出现在 ul 或 div 中，可能没有明确的类名，或者类名是动态的
        
        // 移除包含 "Recommended Stories" 的标题及其后续列表
        $('h2, h3, h4, h5, h6').filter((i, el) => $(el).text().includes('Recommended Stories')).each((i, el) => {
            $(el).nextUntil('p').remove(); // 移除直到下一个段落的所有内容
            $(el).remove();
        });
        
        // 移除 "list of X items" 这种辅助功能文本容器
        // 有时候这些文本直接暴露在div中
        $('div').filter((i, el) => {
            const text = $(el).text().trim();
            return text.startsWith('list of') && text.includes('items');
        }).remove();

        // 移除包含 "list of X items" 的 ul
        $('ul').filter((i, el) => {
            const label = $(el).attr('aria-label') || '';
            return label.includes('list of') || $(el).text().includes('list of 4 items');
        }).remove();

        let content = super.extractContent($, selectors);
        
        // 最后再次清理文本中的 "list of X items"
        if (content) {
            content = content.replace(/^list of \d+ items$/gim, '');
            content = content.replace(/\nlist of \d+ items\n/gim, '\n');
        }
        
        return content;
    }

    /**
     * 验证是否为有效的Al Jazeera文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是Al Jazeera域名
            if (urlObj.hostname !== 'www.aljazeera.com' && urlObj.hostname !== 'aljazeera.com') {
                return false;
            }
            
            // Al Jazeera特殊的URL模式验证
            const pathname = urlObj.pathname;
            
            // 排除非文章页面
            const excludePatterns = [
                '/news/',
                '/opinions/',
                '/sports/',
                '/economy/',
                '/features/',
                '/investigations/',
                '/interactives/',
                '/indepth/',
                '/gallery/',
                '/video/',
                '/live/',
                '/podcasts/',
                '/program/',
                '/where/',
                '/topics/',
                '/tag/',
                '/author/',
                '/search'
            ];
            
            // 如果路径只是分类页面，不是具体文章
            for (const pattern of excludePatterns) {
                if (pathname === pattern || pathname === pattern) {
                    return false;
                }
            }
            
            // 文章URL通常包含日期格式 (YYYY/MM/DD)
            const datePattern = /\/\d{4}\/\d{1,2}\/\d{1,2}\//;
            if (!datePattern.test(pathname)) {
                // 如果不包含日期格式，检查是否是其他有效的文章格式
                const validPatterns = [
                    '/news/',
                    '/opinions/',
                    '/features/',
                    '/sports/',
                    '/economy/'
                ];
                
                let isValidPattern = false;
                for (const pattern of validPatterns) {
                    if (pathname.startsWith(pattern) && pathname.length > pattern.length + 10) {
                        isValidPattern = true;
                        break;
                    }
                }
                
                if (!isValidPattern) {
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
                name: 'Latest News',
                url: 'https://www.aljazeera.com/news/',
                description: 'Latest breaking news'
            },
            {
                name: 'Middle East',
                url: 'https://www.aljazeera.com/where/middleeast/',
                description: 'Middle East news'
            },
            {
                name: 'Asia Pacific',
                url: 'https://www.aljazeera.com/where/asia/',
                description: 'Asia Pacific news'
            },
            {
                name: 'Europe',
                url: 'https://www.aljazeera.com/where/europe/',
                description: 'European news'
            },
            {
                name: 'Africa',
                url: 'https://www.aljazeera.com/where/africa/',
                description: 'African news'
            },
            {
                name: 'Americas',
                url: 'https://www.aljazeera.com/where/americas/',
                description: 'Americas news'
            },
            {
                name: 'Economy',
                url: 'https://www.aljazeera.com/economy/',
                description: 'Economic news'
            },
            {
                name: 'Sports',
                url: 'https://www.aljazeera.com/sports/',
                description: 'Sports news'
            },
            {
                name: 'Features',
                url: 'https://www.aljazeera.com/features/',
                description: 'Feature articles'
            },
            {
                name: 'Opinions',
                url: 'https://www.aljazeera.com/opinions/',
                description: 'Opinion pieces'
            }
        ];
    }

    /**
     * 提取发布时间 - Al Jazeera专用实现
     * 优先从JSON-LD结构化数据中提取准确的时间
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string|null} ISO格式的发布时间
     */
    extractPublishedAt($, selectors) {
        // 1. 优先尝试从JSON-LD结构化数据提取时间
        const jsonLdElements = $('script[type="application/ld+json"]');
        for (let i = 0; i < jsonLdElements.length; i++) {
            const jsonText = $(jsonLdElements[i]).html();
            if (jsonText) {
                try {
                    const jsonData = JSON.parse(jsonText);
                    
                    // 查找时间字段，优先使用datePublished
                    const timeFields = ['datePublished', 'dateCreated', 'dateModified', 'uploadDate'];
                    
                    for (const field of timeFields) {
                        if (jsonData[field]) {
                            const timeString = jsonData[field];
                            const parsedDate = this.parseTimeString(timeString);
                            if (parsedDate) {
                                // 从JSON-LD字段提取时间成功
                                return parsedDate;
                            }
                        }
                    }
                } catch (e) {
                    // 忽略JSON解析错误，继续尝试下一个
                }
            }
        }
        
        // 2. 如果JSON-LD没有找到，尝试meta标签
        const metaSelectors = [
            'meta[property="article:published_time"]',
            'meta[name="article:published_time"]',
            'meta[property="article:modified_time"]'
        ];
        
        for (const selector of metaSelectors) {
            const element = $(selector);
            if (element.length > 0) {
                const content = element.attr('content');
                if (content) {
                    const parsedDate = this.parseTimeString(content);
                    if (parsedDate) {
                        // 从meta标签提取时间
                        return parsedDate;
                    }
                }
            }
        }
        
        // 3. 最后尝试HTML元素（但这通常会得到不准确的时间）
        // JSON-LD和meta标签都没有找到时间，尝试HTML元素
        return super.extractPublishedAt($, selectors);
    }

    /**
     * 创建指定分类的Al Jazeera抓取器
     * @param {string} category - 分类名称
     * @param {Object} config - 配置选项
     * @returns {AlJazeeraScraper|null} 抓取器实例
     */
    static createCategoryScraper(category, config = {}) {
        const categories = AlJazeeraScraper.getSupportedCategories();
        const categoryInfo = categories.find(cat => cat.name === category);
        
        if (!categoryInfo) {
            return null;
        }
        
        return new AlJazeeraScraper({
            name: `Al Jazeera - ${categoryInfo.name}`,
            baseUrl: categoryInfo.url,
            ...config
        });
    }
}

module.exports = AlJazeeraScraper;