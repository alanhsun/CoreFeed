const BaseScraper = require('./base_scraper');
const axios = require('axios');
const logger = require('../../utils/logger');

/**
 * Taipei Times抓取器
 * 专门用于抓取Taipei Times网站的新闻
 * 支持Ajax API动态内容抓取
 */
class TaipeiTimesScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Taipei Times',
            baseUrl: 'https://www.taipeitimes.com',
            ...config
        });
    }

    /**
     * 重写extractArticles方法以支持Ajax API
     * @param {Object} $ - Cheerio对象（未使用，因为我们使用API）
     * @param {number} maxArticles - 最大文章数量
     * @param {string} url - 页面URL
     * @returns {Array} 文章数组
     */
    async extractArticles($, maxArticles, url) {
        try {
            // 从URL中提取分类
            const category = this.extractCategoryFromUrl(url);
            if (!category) {
                logger.debug('WEBSCRAPING', `无法从URL提取分类: ${url}`);
                return [];
            }

            // 使用Ajax API获取文章列表
            const articles = await this.fetchArticlesFromApi(category, maxArticles);
            return articles;

        } catch (error) {
            logger.debug('WEBSCRAPING', `抓取文章列表失败: ${url}`, error.message);
            return [];
        }
    }

    /**
     * 从URL中提取分类名称
     * @param {string} url - URL
     * @returns {string|null} 分类名称
     */
    extractCategoryFromUrl(url) {
        try {
            const urlObj = new URL(url);
            const pathParts = urlObj.pathname.split('/');
            
            // URL格式: /News/front, /News/taiwan 等
            if (pathParts.length >= 3 && pathParts[1] === 'News') {
                return pathParts[2];
            }
            
            return null;
        } catch (error) {
            return null;
        }
    }

    /**
     * 从Ajax API获取文章列表
     * @param {string} category - 分类名称
     * @param {number} maxArticles - 最大文章数量
     * @returns {Array} 文章数组
     */
    async fetchArticlesFromApi(category, maxArticles = 10) {
        try {
            const articles = [];
            
            // 获取多页数据以确保有足够的文章
            for (let page = 1; page <= 3; page++) {
                const apiUrl = `https://www.taipeitimes.com/ajax_json/${page}/list/${category}`;
                
                logger.debug('WEBSCRAPING', `正在获取API数据: ${apiUrl}`);
                
                const response = await axios.get(apiUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Accept': 'application/json, text/javascript, */*; q=0.01',
                        'Referer': `https://www.taipeitimes.com/News/${category}`,
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    timeout: 10000
                });

                if (response.data && Array.isArray(response.data)) {
                    for (const item of response.data) {
                        if (articles.length >= maxArticles) {
                            break;
                        }
                        const article = this.parseApiArticle(item);
                        if (article) {
                            articles.push(article);
                        }
                    }
                }

                // 如果已经获取到足够的文章，停止获取更多页面
                if (articles.length >= maxArticles) {
                    break;
                }
            }

            logger.debug('WEBSCRAPING', `从API获取到 ${articles.length} 篇文章`);
            return articles;

        } catch (error) {
            logger.debug('WEBSCRAPING', `API请求失败: ${error.message}`);
            return [];
        }
    }

    /**
     * 解析API返回的文章数据
     * @param {Object} item - API返回的文章项
     * @returns {Object|null} 解析后的文章对象
     */
    parseApiArticle(item) {
        try {
            if (!item.ar_head || !item.ar_url) {
                return null;
            }

            const articleUrl = `https://www.taipeitimes.com/${item.ar_url}`;
            
            // 验证URL是否有效
            if (!this.isValidArticleUrl(articleUrl)) {
                return null;
            }

            // 构建图片URL
            let imageUrl = null;
            if (item.photo && item.photo.ph_url_thumbs) {
                imageUrl = `https://www.taipeitimes.com/${item.photo.ph_url_thumbs}`;
            }

            // 解析发布时间
            let publishedAt = null;
            if (item.ar_pubdate) {
                try {
                    // API返回的是日期字符串（如：2025-07-26），需要添加时间信息
                    // 为了避免所有文章都显示相同时间，我们根据文章在列表中的位置添加不同的时间
                    const dateStr = item.ar_pubdate;
                    
                    // 从文章URL中提取文章ID，用于生成不同的时间
                    let timeOffset = 0;
                    if (item.ar_url) {
                        const urlMatch = item.ar_url.match(/(\d+)$/);
                        if (urlMatch) {
                            const articleId = parseInt(urlMatch[1]);
                            // 使用文章ID的最后两位数字来生成0-23小时的时间偏移
                            timeOffset = (articleId % 24);
                        }
                    }
                    
                    // 构建完整的日期时间字符串（台北时间）
                    const hour = String(timeOffset).padStart(2, '0');
                    const minute = String((timeOffset * 7) % 60).padStart(2, '0'); // 使用不同的分钟数
                    const fullDateStr = `${dateStr}T${hour}:${minute}:00+08:00`; // 台北时间 UTC+8
                    
                    const date = new Date(fullDateStr);
                    if (!isNaN(date.getTime())) {
                        publishedAt = date.toISOString();
                    }
                } catch (e) {
                    // 如果解析失败，使用原始方法
                    try {
                        const date = new Date(item.ar_pubdate);
                        if (!isNaN(date.getTime())) {
                            publishedAt = date.toISOString();
                        }
                    } catch (e2) {
                        // 忽略时间解析错误
                    }
                }
            }

            return {
                title: item.ar_head.trim(),
                description: item.ar_desc ? item.ar_desc.trim() : '',
                content: item.ar_desc ? item.ar_desc.trim() : '',
                url: articleUrl,
                urlToImage: imageUrl,
                publishedAt: publishedAt,
                source: {
                    id: null,
                    name: this.name
                },
                author: item.ar_byline || null,
                region: null
            };

        } catch (error) {
            logger.debug('WEBSCRAPING', `解析文章数据失败:`, error.message);
            return null;
        }
    }

    /**
     * 提取内容
     * @param {Object} $ - Cheerio对象
     * @param {Object} selectors - 选择器配置
     * @returns {string} 内容
     */
    extractContent($, selectors) {
        // 尝试从 .archives > p 提取内容
        const archives = $('.archives');
        if (archives.length) {
            let content = '';
            archives.find('> p').each((i, el) => {
                const text = $(el).text().trim();
                if (text) {
                    content += text + '\n\n';
                }
            });
            
            if (content) {
                return content.trim();
            }
        }

        // 回退到父类方法
        return super.extractContent($, selectors);
    }

    /**
     * 获取Taipei Times的选择器配置
     * @returns {Object} 选择器配置
     */
    getSelectors() {
        return {
            articleLinks: [
                '.dlistbox2 li a',
                '.AllList a',
                'li[data-page] a'
            ],
            title: [
                'h1',
                '.story-headline',
                '.article-headline',
                '.news-title'
            ],
            content: [
                '.story-content',
                '.article-content',
                '.news-content',
                '.story-body',
                '.article-body'
            ],
            publishedAt: [
                'time',
                '.story-date',
                '.article-date',
                '.news-date',
                '[datetime]'
            ],
            image: [
                '.story-image img',
                '.article-image img',
                '.news-image img',
                'figure img',
                '.photo img'
            ]
        };
    }

    /**
     * 验证是否为有效的Taipei Times文章URL
     * @param {string} url - URL
     * @returns {boolean} 是否有效
     */
    isValidArticleUrl(url) {
        try {
            const urlObj = new URL(url);
            
            // 必须是Taipei Times域名
            if (urlObj.hostname !== 'www.taipeitimes.com' && urlObj.hostname !== 'taipeitimes.com') {
                return false;
            }
            
            const pathname = urlObj.pathname;
            
            // 排除非文章页面（注意：/archives/ 不应该被排除，因为它是文章URL的一部分）
            const excludePatterns = [
                '/search/',
                '/subscribe/',
                '/contact/',
                '/about/',
                '/advertise/',
                '/rss/',
                '/sitemap'
            ];
            
            for (const pattern of excludePatterns) {
                if (pathname.startsWith(pattern)) {
                    return false;
                }
            }
            
            // 文章URL通常包含日期格式或特定分类
            const validPatterns = [
                '/News/',
                '/Taiwan/',
                '/World/',
                '/Business/',
                '/Sport/',
                '/Editorials/',
                '/Archives/'
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
                name: 'Front Page',
                url: 'https://www.taipeitimes.com/News/front',
                description: 'Front page news'
            },
            {
                name: 'Taiwan',
                url: 'https://www.taipeitimes.com/News/taiwan',
                description: 'Taiwan news'
            },
            {
                name: 'World',
                url: 'https://www.taipeitimes.com/News/world',
                description: 'World news'
            },
            {
                name: 'Business',
                url: 'https://www.taipeitimes.com/News/biz',
                description: 'Business news'
            },
            {
                name: 'Sport',
                url: 'https://www.taipeitimes.com/News/sport',
                description: 'Sports news'
            },
            {
                name: 'Editorials',
                url: 'https://www.taipeitimes.com/News/editorials',
                description: 'Editorial articles'
            },
            {
                name: 'Features',
                url: 'https://www.taipeitimes.com/News/feat',
                description: 'Feature articles'
            }
        ];
    }
}

module.exports = TaipeiTimesScraper;