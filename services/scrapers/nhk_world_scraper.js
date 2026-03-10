const BaseScraper = require('./base_scraper');
const cheerio = require('cheerio');

/**
 * NHK World抓取器
 * 专门用于抓取NHK World网站的新闻
 */
class NhkWorldScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'NHK World',
            baseUrl: 'https://www3.nhk.or.jp/nhkworld/en/news/list/',  // 使用新闻列表页面作为默认URL
            ...config
        });
    }

    /**
     * 获取NHK World的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                'h3 a',  // 主要的文章链接选择器
                '.news-item h3 a',
                '.article-title a',
                '.headline a',
                '.story-headline a',
                '.news-headline a',
                '.item-title a',
                '.content-title a'
            ],
            title: [
                'h1',
                '.article-headline',
                '.story-headline',
                '.news-title',
                '.content-title'
            ],
            content: [
                '.p-article__body', // NHK World特定的内容容器
                'main p',  // 主要内容在main标签的段落中
                'main',
                '.article-content',
                '.story-content',
                '.news-content',
                '.article-body',
                '.story-body',
                '.content-body'
            ],
            publishedAt: [
                'time',
                '.article-date',
                '.story-date',
                '.news-date',
                '.publish-date',
                '[datetime]'
            ],
            image: [
                '.article-image img',
                '.story-image img',
                '.news-image img',
                'figure img',
                '.hero-image img',
                '.content-image img'
            ]
        };
    }

    /**
     * 验证是否为有效的NHK World文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是NHK World域名
            if (urlObj.hostname !== 'www3.nhk.or.jp' && urlObj.hostname !== 'nhk.or.jp') {
                return false;
            }
            
            const pathname = urlObj.pathname;
            
            // 必须包含nhkworld路径
            if (!pathname.includes('/nhkworld/')) {
                return false;
            }
            
            // 排除非文章页面
            const excludePatterns = [
                '/nhkworld/en/tv/',
                '/nhkworld/en/radio/',
                '/nhkworld/en/ondemand/',
                '/nhkworld/en/live/',
                '/nhkworld/en/schedule/',
                '/nhkworld/en/about/',
                '/nhkworld/en/contact/',
                '/nhkworld/en/app/'
            ];
            
            for (const pattern of excludePatterns) {
                if (pathname.startsWith(pattern)) {
                    return false;
                }
            }
            
            // 文章URL通常包含特定格式
            const validPatterns = [
                '/nhkworld/en/news/',
                '/nhkworld/en/newsline/',
                '/nhkworld/en/newsroom/'
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
     * 提取内容
     * 优先从JSON-LD提取，然后尝试选择器
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        // 1. 优先从JSON-LD提取
        try {
            let jsonLdContent = null;
            $('script[type="application/ld+json"]').each((i, el) => {
                if (jsonLdContent) return false;
                try {
                    const jsonData = JSON.parse($(el).html());
                    if (jsonData.articleBody) {
                        jsonLdContent = jsonData.articleBody;
                    }
                } catch (e) {}
            });
            
            if (jsonLdContent) {
                return jsonLdContent;
            }
        } catch (e) {}

        // 2. 特殊处理 .p-article__body
        // BaseScraper的extractContent只取第一个匹配元素，但如果是容器，.text()会返回所有文本
        // 如果 selectors.content[0] 是 .p-article__body，BaseScraper应该能正常工作
        // 但为了安全起见，这里显式处理
        const body = $('.p-article__body');
        if (body.length) {
            // 移除干扰元素
            const clone = body.clone();
            clone.find('.p-article__meta').remove(); // 移除元数据（如日期）
            return clone.text().trim();
        }

        // 3. 回退到父类方法
        return super.extractContent($, selectors);
    }

    /**
     * 重写时间提取方法，优先从JSON-LD提取，避免08:00问题
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @param {string} articleUrl - 文章URL（可选）
     * @returns {string|null} ISO格式的发布时间
     */
    extractPublishedAt($, selectors, articleUrl) {
        // 开始提取时间信息
        
        // 1. 优先从JSON-LD结构化数据中提取
        let jsonLdTime = null;
        try {
            $('script[type="application/ld+json"]').each((i, el) => {
                if (jsonLdTime) return false; // 如果已找到时间，停止循环
                
                try {
                    const jsonData = JSON.parse($(el).html());
                    
                    // 查找各种可能的日期字段
                    const dateFields = ['datePublished', 'dateCreated', 'dateModified', 'uploadDate'];
                    
                    for (const field of dateFields) {
                        if (jsonData[field]) {
                            let dateStr = jsonData[field];
                            // 尝试解析时间字段
                            
                            // 处理NHK特殊的时区格式: "2025-07-26T14:02:00 JST+0900"
                            if (dateStr.includes(' JST+')) {
                                // 移除 " JST+0900" 部分，添加标准时区格式
                                dateStr = dateStr.replace(/ JST\+0900$/, '+09:00');
                                // 转换时区格式
                            }
                            
                            const parsedDate = new Date(dateStr);
                            
                            if (!isNaN(parsedDate.getTime())) {
                                // 从JSON-LD字段提取时间成功
                                jsonLdTime = parsedDate.toISOString();
                                break;
                            } else {
                                // 时间解析失败
                            }
                        }
                    }
                } catch (error) {
                    // 忽略JSON解析错误
                }
            });
        } catch (error) {
            // JSON-LD解析失败
        }
        
        if (jsonLdTime) {
            return jsonLdTime;
        }
        
        // 2. 尝试父类的标准方法
        const standardTime = super.extractPublishedAt($, selectors);
        if (standardTime) {
            // 从标准选择器提取时间
            return standardTime;
        }
        
        // 3. 最后从URL中提取日期，但设置为日本时间的合理时间（而不是00:00）
        if (articleUrl) {
            const urlMatch = articleUrl.match(/\/(\d{8})_/);
            if (urlMatch) {
                const dateStr = urlMatch[1];
                const year = dateStr.substring(0, 4);
                const month = dateStr.substring(4, 6);
                const day = dateStr.substring(6, 8);
                
                try {
                    // 设置为日本时间的上午9点（JST），这样转换为本地时间时不会是00:00
                    const date = new Date(`${year}-${month}-${day}T09:00:00+09:00`);
                    if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2100) {
                        // 从URL提取日期，设置为JST 09:00
                        return date.toISOString();
                    }
                } catch (error) {
                    // 如果时区解析失败，尝试简单的UTC时间加8小时（接近中国时间）
                    try {
                        const date = new Date(`${year}-${month}-${day}T09:00:00.000Z`);
                        if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2100) {
                            // 从URL提取日期，设置为UTC 09:00
                            return date.toISOString();
                        }
                    } catch (error2) {
                        // 忽略日期解析错误
                    }
                }
            }
        }
        
        // 所有时间提取方法都失败
        return null;
    }
    
    /**
     * 重写文章详情抓取方法，传递URL给时间提取方法
     * @param {string} articleUrl - 文章URL
     * @returns {Object|null} 文章详情
     */
    async scrapeArticleDetails(articleUrl) {
        try {
            const response = await this.httpClient.get(articleUrl);
            if (!response) {
                return null;
            }
            
            const html = response.data;
            const $ = cheerio.load(html);
            const selectors = this.getSelectors();
            
            // 提取标题
            const title = this.extractTitle($, selectors);
            if (!title) {
                return null;
            }
            
            // 提取内容
            const content = this.extractContent($, selectors);
            
            // 提取发布时间（传递URL）
            const publishedAt = this.extractPublishedAt($, selectors, articleUrl);
            
            // 提取图片
            const imageUrl = this.extractImage($, selectors, articleUrl);
            
            // 生成描述：优先从JSON-LD提取，否则从内容生成
            const { truncateText, stripHtml } = require('../../utils/helpers');
            let description = null;
            
            // 为NHK创建独特的描述，避免与内容重复
            if (content && title) {
                // 从内容中提取关键词和主要信息
                const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 10);
                
                if (sentences.length > 0) {
                    // 创建基于标题的描述格式
                    const firstSentence = sentences[0].trim();
                    
                    // 提取关键信息（通常在第一句中）
                    let keyInfo = '';
                    if (firstSentence.includes('NHK')) {
                        keyInfo = 'NHK报道，';
                    } else if (firstSentence.includes('said') || firstSentence.includes('announced')) {
                        keyInfo = '据报道，';
                    } else {
                        keyInfo = '最新消息，';
                    }
                    
                    // 从内容中提取核心事实（跳过开头，取中间部分）
                    let coreInfo = '';
                    if (sentences.length >= 2) {
                        // 取第二句或第三句作为核心信息
                        const targetSentence = sentences.length >= 3 ? sentences[1] : sentences[1];
                        coreInfo = targetSentence.trim();
                        
                        // 限制长度
                        if (coreInfo.length > 80) {
                            coreInfo = coreInfo.substring(0, 80).trim() + '...';
                        }
                    } else {
                        // 如果只有一句，从中间截取
                        const words = firstSentence.split(' ');
                        if (words.length > 10) {
                            coreInfo = words.slice(5, 15).join(' ') + '...';
                        } else {
                            coreInfo = '相关详情正在报道中。';
                        }
                    }
                    
                    description = keyInfo + coreInfo;
                    // 生成独特的新闻摘要
                } else {
                    description = '最新消息，' + content.substring(20, 100).trim() + '...';
                    // 从内容中段生成描述
                }
            }
            
            // 如果仍然没有描述，尝试从JSON-LD中提取
            if (!description) {
                try {
                    $('script[type="application/ld+json"]').each((i, el) => {
                        if (description) return false;
                        
                        try {
                            const jsonData = JSON.parse($(el).html());
                            if (jsonData.description) {
                                description = jsonData.description;
                                // 从JSON-LD提取描述
                                return false;
                            }
                        } catch (error) {
                            // 忽略JSON解析错误
                        }
                    });
                } catch (error) {
                    // 忽略错误
                }
            }
            
            return {
                title: title,
                description: description,
                content: truncateText(stripHtml(content), 2000),  // 增加内容长度限制
                url: articleUrl,
                urlToImage: imageUrl,
                publishedAt: publishedAt,
                source: {
                    id: null,
                    name: this.name
                },
                author: null,
                region: null
            };
            
        } catch (error) {
            const logger = require('../../utils/logger');
            logger.debug('WEBSCRAPING', `抓取文章详情失败: ${articleUrl}`, error.message);
            return null;
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
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/list/',
                description: 'Latest news from Japan'
            },
            {
                name: 'Japan News',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/',
                description: 'News from Japan'
            },
            {
                name: 'Asia Pacific',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/asiapacific/',
                description: 'Asia Pacific news'
            },
            {
                name: 'Business',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/business/',
                description: 'Business news'
            },
            {
                name: 'Science & Technology',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/science/',
                description: 'Science and technology news'
            },
            {
                name: 'Culture',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/culture/',
                description: 'Culture and society news'
            },
            {
                name: 'Sports',
                url: 'https://www3.nhk.or.jp/nhkworld/en/news/sports/',
                description: 'Sports news'
            }
        ];
    }
}

module.exports = NhkWorldScraper;