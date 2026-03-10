const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { retryAsync, delay, stripHtml, truncateText } = require('../../utils/helpers');
const logger = require('../../utils/logger');

/**
 * 基础网页抓取器类
 * 提供通用的抓取功能和接口定义
 */
class BaseScraper {
    constructor(config = {}) {
        this.name = config.name || 'Unknown';
        this.baseUrl = config.baseUrl;
        this.userAgent = config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        this.timeout = config.timeout || 30000;
        this.retries = config.retries || 3;
        this.retryDelay = config.retryDelay || 2000;
        this.delayBetweenRequests = config.delayBetweenRequests || 1000;
        
        // 配置axios实例
        this.httpClient = axios.create({
            timeout: this.timeout,
            headers: {
                'User-Agent': this.userAgent,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Accept-Encoding': 'gzip, deflate',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
    }

    /**
     * 获取网站选择器配置
     * 子类必须实现此方法
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        throw new Error('子类必须实现 getSelectors 方法');
    }

    /**
     * 验证是否为有效的文章URL
     * 子类可以重写此方法以实现特定的URL验证逻辑
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            const baseUrlObj = new URL(this.baseUrl);
            
            // 必须是同一个域名
            if (urlObj.hostname !== baseUrlObj.hostname) {
                return false;
            }
            
            // 排除一些非文章页面
            const excludePatterns = [
                '/tag/',
                '/category/',
                '/author/',
                '/search',
                '/archive/',  // 改为更精确的模式，避免匹配 /archives/
                '/page/',
                '#',
                'javascript:',
                'mailto:',
                '.pdf',
                '.jpg',
                '.png',
                '.gif',
                '.mp4',
                '.mp3'
            ];
            
            for (const pattern of excludePatterns) {
                if (url.includes(pattern)) {
                    return false;
                }
            }
            
            return true;
            
        } catch (error) {
            return false;
        }
    }

    /**
     * 抓取网站新闻
     * @param {string|number} urlOrMaxArticles - URL或最大文章数量（向后兼容）
     * @param {number} maxArticles - 最大文章数量
     * @returns {Promise<Array>} 新闻文章数组
     */
    async scrapeArticles(urlOrMaxArticles = 10, maxArticles = 10) {
        let targetUrl = this.baseUrl;
        let articleLimit = maxArticles;
        
        // 处理参数：如果第一个参数是字符串，则为URL；否则为文章数量
        if (typeof urlOrMaxArticles === 'string') {
            targetUrl = urlOrMaxArticles;
            articleLimit = maxArticles;
        } else {
            articleLimit = urlOrMaxArticles;
        }
        
        try {
            logger.debug('WEBSCRAPING', `正在抓取: ${this.name} - ${targetUrl}`);
            
            // 获取网页内容
            const response = await retryAsync(
                () => this.httpClient.get(targetUrl),
                this.retries,
                this.retryDelay
            );
            
            const html = response.data;
            const $ = cheerio.load(html);
            
            // 提取文章链接
            const articles = await this.extractArticles($, articleLimit, targetUrl);
            
            logger.debug('WEBSCRAPING', `${this.name}: ${articles.length}/${articleLimit}条`);
            return articles;
            
        } catch (error) {
            logger.error('WEBSCRAPING', `${this.name}抓取失败`, error.message);
            return [];
        }
    }

    /**
     * 从网页中提取新闻文章
     * @param {Object} $ - Cheerio对象
     * @param {number} maxArticles - 最大文章数量
     * @param {string} baseUrl - 基础URL，用于解析相对链接
     * @returns {Promise<Array>} 新闻文章数组
     */
    async extractArticles($, maxArticles, baseUrl = null) {
        const articles = [];
        const selectors = this.getSelectors();
        const resolveBaseUrl = baseUrl || this.baseUrl;
        
        // 查找文章链接
        const articleLinks = new Set();
        
        for (const selector of selectors.articleLinks) {
            $(selector).each((index, element) => {
                if (articleLinks.size >= maxArticles) return false;
                
                const link = $(element).attr('href');
                if (link) {
                    const fullUrl = this.resolveUrl(link, resolveBaseUrl);
                    if (fullUrl && this.isValidArticleUrl(fullUrl)) {
                        articleLinks.add(fullUrl);
                    }
                }
            });
        }
        
        // 限制文章数量
        const limitedLinks = Array.from(articleLinks).slice(0, maxArticles);
        
        // 抓取每篇文章的详细信息
        for (const articleUrl of limitedLinks) {
            try {
                const article = await this.scrapeArticleDetails(articleUrl);
                if (article) {
                    articles.push(article);
                }
                
                // 添加延迟避免被反爬虫
                await delay(500);
                
            } catch (error) {
                logger.debug('WEBSCRAPING', `抓取文章详情失败: ${articleUrl}`, error.message);
            }
        }
        
        return articles;
    }

    /**
     * 抓取文章详细信息
     * @param {string} articleUrl - 文章URL
     * @returns {Promise<Object|null>} 文章对象
     */
    async scrapeArticleDetails(articleUrl) {
        try {
            const response = await retryAsync(
                () => this.httpClient.get(articleUrl),
                this.retries,
                this.retryDelay
            );
            
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
            
            // 提取发布时间
            const publishedAt = this.extractPublishedAt($, selectors);
            
            // 提取图片
            const imageUrl = this.extractImage($, selectors, articleUrl);
            
            // 生成描述（从内容的前500个字符）
            const description = truncateText(stripHtml(content), 500);
            
            return {
                title: title,
                description: description,
                content: truncateText(stripHtml(content), 1000),
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
            logger.debug('WEBSCRAPING', `抓取文章详情失败: ${articleUrl}`, error.message);
            return null;
        }
    }

    /**
     * 提取标题
     * 子类可以重写此方法以实现特定的标题提取逻辑
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 标题
     */
    extractTitle($, selectors) {
        for (const selector of selectors.title) {
            const titleElement = $(selector).first();
            if (titleElement.length) {
                return titleElement.text().trim();
            }
        }
        return '';
    }

    /**
     * 提取内容
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        for (const selector of selectors.content) {
            const contentElement = $(selector).first();
            if (contentElement.length) {
                return contentElement.text().trim();
            }
        }
        return '';
    }

    /**
     * 提取发布时间
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string|null} ISO格式的发布时间，如果无法提取则返回null
     */
    extractPublishedAt($, selectors) {
        // 扩展的时间选择器列表
        const enhancedSelectors = [
            ...selectors.publishedAt,
            // 通用时间选择器
            'time[datetime]',
            '[datetime]',
            '.published-date',
            '.publish-date',
            '.publication-date',
            '.article-date',
            '.news-date',
            '.date-published',
            '.timestamp',
            '.time',
            '.date',
            // Meta标签
            'meta[property="article:published_time"]',
            'meta[name="article:published_time"]',
            'meta[property="article:modified_time"]',
            'meta[name="pubdate"]',
            'meta[name="date"]',
            // JSON-LD结构化数据
            'script[type="application/ld+json"]'
        ];
        
        // 尝试从各种选择器提取时间
        for (const selector of enhancedSelectors) {
            try {
                if (selector === 'script[type="application/ld+json"]') {
                    // 处理JSON-LD结构化数据
                    const jsonLdElements = $(selector);
                    for (let i = 0; i < jsonLdElements.length; i++) {
                        const jsonText = $(jsonLdElements[i]).html();
                        if (jsonText) {
                            try {
                                const jsonData = JSON.parse(jsonText);
                                const publishedTime = this.extractTimeFromJsonLd(jsonData);
                                if (publishedTime) {
                                    return publishedTime;
                                }
                            } catch (e) {
                                // 忽略JSON解析错误
                            }
                        }
                    }
                } else {
                    const timeElement = $(selector).first();
                    if (timeElement.length) {
                        // 尝试多种属性和文本提取方式
                        const timeText = timeElement.attr('datetime') || 
                                       timeElement.attr('content') || 
                                       timeElement.attr('value') || 
                                       timeElement.text().trim();
                        
                        if (timeText) {
                            const parsedDate = this.parseTimeString(timeText);
                            if (parsedDate) {
                                return parsedDate;
                            }
                        }
                    }
                }
            } catch (error) {
                // 忽略单个选择器的错误，继续尝试下一个
                continue;
            }
        }
        
        // 如果无法提取到有效的发布时间，返回null而不是当前时间
        return null;
    }
    
    /**
     * 从JSON-LD结构化数据中提取时间
     * @param {Object} jsonData - JSON-LD数据
     * @returns {string|null} ISO格式的时间
     */
    extractTimeFromJsonLd(jsonData) {
        if (!jsonData) return null;
        
        // 处理数组格式
        if (Array.isArray(jsonData)) {
            for (const item of jsonData) {
                const time = this.extractTimeFromJsonLd(item);
                if (time) return time;
            }
            return null;
        }
        
        // 查找发布时间字段
        const timeFields = [
            'datePublished',
            'dateCreated',
            'dateModified',
            'publishedAt',
            'published',
            'created',
            'modified'
        ];
        
        for (const field of timeFields) {
            if (jsonData[field]) {
                const parsedDate = this.parseTimeString(jsonData[field]);
                if (parsedDate) {
                    return parsedDate;
                }
            }
        }
        
        return null;
    }
    
    /**
     * 解析时间字符串
     * @param {string} timeString - 时间字符串
     * @returns {string|null} ISO格式的时间
     */
    parseTimeString(timeString) {
        if (!timeString || typeof timeString !== 'string') {
            return null;
        }
        
        // 清理时间字符串
        let cleanTimeString = timeString.trim();
        
        // 移除常见的前缀和后缀
        cleanTimeString = cleanTimeString.replace(/^(发布时间|发表时间|更新时间|时间|Published On)[:：\s]*/, '');
        cleanTimeString = cleanTimeString.replace(/\s*(KST|UTC|GMT|EST|PST)\s*$/, '');
        
        // 处理Channel News Asia格式: "26 Jul 2025 07:12AM\n(Updated: 26 Jul 2025 07:24AM)"
        // 提取第一个时间
        const cnaTimeMatch = cleanTimeString.match(/(\d{1,2}\s+\w{3}\s+\d{4}\s+\d{1,2}:\d{2}[AP]M)/);
        if (cnaTimeMatch) {
            cleanTimeString = cnaTimeMatch[1];
        }
        
        // 特殊处理Al Jazeera的重复日期格式
        // 例如: "26 Jul 202526 Jul 2025" -> "26 Jul 2025"
        const duplicateDatePattern = /(\d{1,2}\s+\w{3}\s+\d{4})(\d{1,2}\s+\w{3}\s+\d{4})/;
        const duplicateMatch = cleanTimeString.match(duplicateDatePattern);
        if (duplicateMatch) {
            // 使用第二个日期（通常是正确的）
            cleanTimeString = duplicateMatch[2];
        }
        
        // 处理其他重复模式
        // 例如: "26 Jul 202526" -> "26 Jul 2025"
        cleanTimeString = cleanTimeString.replace(/(\d{1,2}\s+\w{3}\s+\d{4})\d{2}$/, '$1');
        
        // 特殊处理Channel News Asia格式: "26 Jul 2025 07:12AM"
        const cnaFormatMatch = cleanTimeString.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})\s+(\d{1,2}):(\d{2})(AM|PM)/);
        if (cnaFormatMatch) {
            const [, day, month, year, hour, minute, ampm] = cnaFormatMatch;
            const monthMap = {
                'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
                'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
                'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
            };
            
            let hour24 = parseInt(hour);
            if (ampm === 'PM' && hour24 !== 12) {
                hour24 += 12;
            } else if (ampm === 'AM' && hour24 === 12) {
                hour24 = 0;
            }
            
            const isoString = `${year}-${monthMap[month]}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute}:00.000Z`;
            try {
                const parsedDate = new Date(isoString);
                if (!isNaN(parsedDate.getTime())) {
                    return parsedDate.toISOString();
                }
            } catch (error) {
                // 继续尝试其他格式
            }
        }
        
        // 尝试解析各种时间格式
        const timeFormats = [
            // ISO格式
            cleanTimeString,
            // 常见的日期格式
            cleanTimeString.replace(/年|월/, '-').replace(/日|일/, ''),
            cleanTimeString.replace(/\./g, '-'),
            cleanTimeString.replace(/\//g, '-'),
            // 移除多余的空格和特殊字符
            cleanTimeString.replace(/[^\d\-T:Z\s]/g, ' ').trim()
        ];
        
        for (const format of timeFormats) {
            try {
                const parsedDate = new Date(format);
                if (!isNaN(parsedDate.getTime()) && parsedDate.getFullYear() > 2000 && parsedDate.getFullYear() < 2100) {
                    return parsedDate.toISOString();
                }
            } catch (error) {
                continue;
            }
        }
        
        return null;
    }

    /**
     * 提取图片
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @param {string} articleUrl - 文章URL
     * @returns {string|null} 图片URL
     */
    extractImage($, selectors, articleUrl) {
        // 1. 优先尝试从meta标签获取图片
        const metaSelectors = [
            'meta[property="og:image"]',
            'meta[name="twitter:image"]',
            'meta[property="article:image"]'
        ];
        
        for (const selector of metaSelectors) {
            const metaElement = $(selector).first();
            if (metaElement.length) {
                const content = metaElement.attr('content');
                if (content && content.startsWith('http')) {
                    return content;
                }
            }
        }
        
        // 2. 如果meta标签没有图片，尝试从页面内容中提取
        for (const selector of selectors.image) {
            const imgElement = $(selector).first();
            if (imgElement.length) {
                const src = imgElement.attr('src') || imgElement.attr('data-src') || imgElement.attr('data-original');
                if (src) {
                    const imageUrl = this.resolveUrl(src, articleUrl);
                    // 过滤掉明显的非内容图片
                    if (imageUrl && !imageUrl.includes('logo') && !imageUrl.includes('icon') && !imageUrl.includes('avatar')) {
                        return imageUrl;
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * 解析相对URL为绝对URL
     * @param {string} url - 相对或绝对URL
     * @param {string} baseUrl - 基础URL
     * @returns {string} 绝对URL
     */
    resolveUrl(url, baseUrl) {
        try {
            return new URL(url, baseUrl).href;
        } catch (error) {
            return null;
        }
    }
}

module.exports = BaseScraper;