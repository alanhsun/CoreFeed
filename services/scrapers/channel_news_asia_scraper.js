const BaseScraper = require('./base_scraper');

/**
 * Channel News Asia抓取器
 * 专门用于抓取Channel News Asia网站的新闻
 */
class ChannelNewsAsiaScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Channel News Asia',
            baseUrl: 'https://www.channelnewsasia.com',
            ...config
        });
    }

    /**
     * 获取Channel News Asia的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                '.card-headline a',
                '.list-object h3 a',
                '.teaser-card h3 a',
                '.story-card h3 a',
                '.headline a',
                'h3 a',
                '.card-title a',
                '.story-headline a'
            ],
            title: [
                'h1',
                '.article-headline',
                '.story-headline',
                '.content-detail__headline'
            ],
            content: [
                '.text-long',
                '.article-content',
                '.story-content',
                '.content-detail__body',
                '.article-body'
            ],
            publishedAt: [
                '.article-publish',
                '*[class*="publish"]',
                'time',
                '.article-publish-date',
                '.story-publish-date',
                '.content-detail__date',
                '[datetime]'
            ],
            image: [
                '.article-image img',
                '.story-image img',
                '.content-detail__image img',
                'figure img',
                '.hero-image img'
            ]
        };
    }

    /**
     * 从JSON-LD提取数据
     * @param {Object} $ - Cheerio对象
     * @returns {Object|null} JSON-LD数据
     */
    extractJsonLd($) {
        const scripts = $('script[type="application/ld+json"]');
        for (let i = 0; i < scripts.length; i++) {
            try {
                const data = JSON.parse($(scripts[i]).html());
                
                // 处理 @graph 结构
                let items = [];
                if (data['@graph']) {
                    items = data['@graph'];
                } else if (Array.isArray(data)) {
                    items = data;
                } else {
                    items = [data];
                }

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
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 标题
     */
    extractTitle($, selectors) {
        const jsonLd = this.extractJsonLd($);
        if (jsonLd && jsonLd.headline) {
            return jsonLd.headline;
        }
        return super.extractTitle($, selectors);
    }

    /**
     * 提取发布时间
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string|null} 发布时间
     */
    extractPublishedAt($, selectors) {
        const jsonLd = this.extractJsonLd($);
        if (jsonLd) {
            if (jsonLd.datePublished) return jsonLd.datePublished;
            if (jsonLd.dateCreated) return jsonLd.dateCreated;
        }
        return super.extractPublishedAt($, selectors);
    }

    /**
     * 提取图片
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @param {string} articleUrl - 文章URL
     * @returns {string|null} 图片URL
     */
    extractImage($, selectors, articleUrl) {
        const jsonLd = this.extractJsonLd($);
        if (jsonLd) {
            if (jsonLd.image) {
                if (typeof jsonLd.image === 'string') return jsonLd.image;
                if (Array.isArray(jsonLd.image)) return jsonLd.image[0];
                if (jsonLd.image.url) return jsonLd.image.url;
            }
        }
        return super.extractImage($, selectors, articleUrl);
    }

    /**
     * 提取内容
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        for (const selector of selectors.content) {
            const elements = $(selector);
            if (elements.length) {
                for (let i = 0; i < elements.length; i++) {
                    const element = elements.eq(i);
                    
                    // 克隆元素以避免修改全局$对象
                    const clone = element.clone();
                    
                    // 移除干扰元素
                    clone.find('.block-type--interactive, .block--type-interactive').remove();
                    clone.find('script, style, iframe, .ad, .advertisement, .social-share, .related-links, .outbrain').remove();
                    clone.find('.quick-link, .read-more, .related-stories').remove();
                    
                    const text = clone.text().trim();
                    // 如果内容长度足够，认为是正文
                    if (text.length > 50) {
                        return text;
                    }
                }
            }
        }
        return '';
    }

    /**
     * 验证是否为有效的Channel News Asia文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是Channel News Asia域名
            if (urlObj.hostname !== 'www.channelnewsasia.com' && urlObj.hostname !== 'channelnewsasia.com') {
                return false;
            }
            
            const pathname = urlObj.pathname;
            
            // 排除非文章页面
            const excludePatterns = [
                '/live-tv',
                '/watch',
                '/podcasts',
                '/newsletters',
                '/about-us',
                '/contact-us',
                '/privacy-policy',
                '/terms-of-use',
                '/advertise',
                '/careers',
                '/rss-feeds'
            ];
            
            for (const pattern of excludePatterns) {
                if (pathname.startsWith(pattern)) {
                    return false;
                }
            }
            
            // 文章URL通常以特定格式开始
            const validPatterns = [
                '/asia/',
                '/world/',
                '/business/',
                '/sport/',
                '/singapore/',
                '/commentary/',
                '/lifestyle/',
                '/sustainability/',
                '/cnainsider/'
            ];
            
            let isValidPattern = false;
            for (const pattern of validPatterns) {
                if (pathname.startsWith(pattern) && pathname.length > pattern.length + 5) {
                    isValidPattern = true;
                    break;
                }
            }
            
            if (!isValidPattern) {
                return false;
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
                name: 'Asia',
                url: 'https://www.channelnewsasia.com/asia',
                description: 'Asian news'
            },
            {
                name: 'World',
                url: 'https://www.channelnewsasia.com/world',
                description: 'World news'
            },
            {
                name: 'Business',
                url: 'https://www.channelnewsasia.com/business',
                description: 'Business news'
            },
            {
                name: 'Singapore',
                url: 'https://www.channelnewsasia.com/singapore',
                description: 'Singapore news'
            },
            {
                name: 'Sport',
                url: 'https://www.channelnewsasia.com/sport',
                description: 'Sports news'
            },
            {
                name: 'Commentary',
                url: 'https://www.channelnewsasia.com/commentary',
                description: 'Commentary and analysis'
            },
            {
                name: 'Lifestyle',
                url: 'https://www.channelnewsasia.com/lifestyle',
                description: 'Lifestyle news'
            },
            {
                name: 'Sustainability',
                url: 'https://www.channelnewsasia.com/sustainability',
                description: 'Sustainability news'
            }
        ];
    }
}

module.exports = ChannelNewsAsiaScraper;