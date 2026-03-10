const BaseScraper = require('./base_scraper');
const logger = require('../../utils/logger');

/**
 * Russia Today (RT.com) 抓取器
 * 专门用于抓取RT.com网站的完整新闻内容
 */
class RussiaTodayScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Russia Today',
            baseUrl: 'https://www.rt.com',
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...config
        });
        
        // 配置更真实的浏览器请求头
        this.httpClient.defaults.headers = {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'DNT': '1'
        };
    }

    /**
     * 获取RT.com的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                // RT.com主要文章链接选择器
                '.link_hover',
                '.main-promobox__link',
                '.card__heading a',
                '.article-card__link',
                '.listing__item a',
                '.listing-item a',
                'a[href*="/news/"]',
                '.article__heading a',
                'h2 a',
                'h3 a'
            ],
            title: [
                'h1.article__heading',
                'h1.article-heading',
                '.article__title',
                'h1',
                '.heading'
            ],
            content: [
                '.article__text',
                '.article-text',
                '.article__summary',
                'article .text',
                '.article-content',
                '.article .content'
            ],
            publishedAt: [
                'time[datetime]',
                '.date',
                '.article__date',
                '.article-date',
                'time',
                '.time'
            ],
            image: [
                '.article__cover img',
                '.media__item img',
                '.article-cover img',
                'article img',
                'figure img',
                '.main-photo img'
            ]
        };
    }

    /**
     * 验证是否为有效的RT文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是RT域名
            if (!urlObj.hostname.includes('rt.com')) {
                return false;
            }
            
            const pathname = urlObj.pathname;
            
            // RT.com的文章通常在/news/路径下，且有具体的文章slug
            if (!pathname.includes('/news/') && !pathname.includes('/russia/') && 
                !pathname.includes('/usa/') && !pathname.includes('/business/')) {
                return false;
            }
            
            // 排除分类首页
            if (pathname === '/news/' || pathname === '/news') {
                return false;
            }
            
            // 文章URL通常包含日期或ID
            const hasContentIndicator = /\d{6,}/.test(pathname) || /-[a-z0-9]{3,}/.test(pathname);
            if (!hasContentIndicator) {
                return false;
            }
            
            // 调用父类的通用验证
            return super.isValidArticleUrl(url);
            
        } catch (error) {
            return false;
        }
    }

    /**
     * 提取标题（RT.com特殊处理）
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 标题
     */
    extractTitle($, selectors) {
        // 尝试从多个位置提取标题
        for (const selector of selectors.title) {
            const titleElement = $(selector).first();
            if (titleElement.length) {
                let title = titleElement.text().trim();
                // 移除可能的前缀
                title = title.replace(/^RT\s*[-–]\s*/i, '');
                if (title) {
                    return title;
                }
            }
        }
        
        // 尝试从meta标签获取
        const ogTitle = $('meta[property="og:title"]').attr('content');
        if (ogTitle) {
            return ogTitle.replace(/^RT\s*[-–]\s*/i, '').trim();
        }
        
        return '';
    }

    /**
     * 提取内容（RT.com特殊处理）
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        let content = '';
        
        // 尝试提取文章摘要（通常在文章开头）
        const summary = $('.article__summary').text().trim();
        if (summary) {
            content += summary + '\n\n';
        }
        
        // 提取主要内容
        for (const selector of selectors.content) {
            const contentElement = $(selector);
            if (contentElement.length) {
                // RT的文章内容可能分散在多个段落中
                contentElement.find('p').each((i, elem) => {
                    const paraText = $(elem).text().trim();
                    if (paraText && paraText.length > 20) {
                        content += paraText + '\n\n';
                    }
                });
                
                if (content.length > 100) {
                    break;
                }
            }
        }
        
        // 如果没有找到内容，尝试直接获取所有p标签
        if (content.length < 100) {
            $('article p, .article p').each((i, elem) => {
                const paraText = $(elem).text().trim();
                if (paraText && paraText.length > 20) {
                    content += paraText + '\n\n';
                }
            });
        }
        
        return content.trim();
    }

    /**
     * 提取发布时间（RT.com特殊处理）
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string|null} ISO格式的发布时间
     */
    extractPublishedAt($, selectors) {
        // 尝试从time标签获取
        const timeElement = $('time[datetime]').first();
        if (timeElement.length) {
            const datetime = timeElement.attr('datetime');
            if (datetime) {
                const parsedDate = this.parseTimeString(datetime);
                if (parsedDate) {
                    return parsedDate;
                }
            }
        }
        
        // 尝试从meta标签获取
        const articlePublished = $('meta[property="article:published_time"]').attr('content');
        if (articlePublished) {
            const parsedDate = this.parseTimeString(articlePublished);
            if (parsedDate) {
                return parsedDate;
            }
        }
        
        // 尝试从日期选择器获取
        const dateText = $('.article__date, .date, .time').first().text().trim();
        if (dateText) {
            const parsedDate = this.parseTimeString(dateText);
            if (parsedDate) {
                return parsedDate;
            }
        }
        
        // 调用父类方法
        return super.extractPublishedAt($, selectors);
    }

    /**
     * 获取支持的新闻分类URL
     * @returns {Array} 分类URL数组
     */
    static getSupportedCategories() {
        return [
            {
                name: 'News',
                url: 'https://www.rt.com/news/',
                description: 'General news'
            },
            {
                name: 'Russia',
                url: 'https://www.rt.com/russia/',
                description: 'Russia news'
            },
            {
                name: 'USA',
                url: 'https://www.rt.com/usa/',
                description: 'United States news'
            },
            {
                name: 'Business',
                url: 'https://www.rt.com/business/',
                description: 'Business news'
            }
        ];
    }
}

module.exports = RussiaTodayScraper;
