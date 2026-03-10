const path = require('path');
const fs = require('fs');
require('dotenv').config();

// 尝试加载持久化设置
let savedSettings = {};
try {
    const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
    if (fs.existsSync(settingsPath)) {
        savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        console.log('已加载持久化配置:', Object.keys(savedSettings).join(', '));
    }
} catch (e) {
    console.error('加载 settings.json 失败', e.message);
}

/**
 * 配置验证函数
 * @param {string} key - 环境变量键名
 * @param {*} defaultValue - 默认值
 * @param {boolean} required - 是否必需
 * @returns {*} 配置值
 */
function getConfig(key, defaultValue = null, required = false) {
    // 优先读取持久化配置
    if (savedSettings[key] !== undefined && savedSettings[key] !== null && savedSettings[key] !== '') {
        return savedSettings[key];
    }

    const value = process.env[key] || defaultValue;
    
    if (required && !value) {
        throw new Error(`必需的环境变量 ${key} 未设置`);
    }
    
    return value;
}

/**
 * 验证数字类型配置
 * @param {string} key - 环境变量键名
 * @param {number} defaultValue - 默认值
 * @param {boolean} required - 是否必需
 * @returns {number} 数字值
 */
function getNumberConfig(key, defaultValue = null, required = false) {
    const value = getConfig(key, defaultValue, required);
    const numValue = parseInt(value, 10);
    
    if (isNaN(numValue)) {
        if (required) {
            throw new Error(`环境变量 ${key} 必须是有效的数字`);
        }
        return defaultValue;
    }
    
    return numValue;
}

/**
 * 验证布尔类型配置
 * @param {string} key - 环境变量键名
 * @param {boolean} defaultValue - 默认值
 * @returns {boolean} 布尔值
 */
function getBooleanConfig(key, defaultValue = false) {
    const value = getConfig(key, defaultValue.toString());
    return value === 'true' || value === '1' || value === 'yes';
}

/**
 * 解析每个源的文章数量配置
 * @param {string} sourceArticleCounts - 源文章数量配置字符串
 * @param {number} defaultCount - 默认文章数量
 * @returns {Object} 源名称到文章数量的映射
 */
function parseSourceArticleCounts(sourceArticleCounts, defaultCount = 5) {
    const counts = {};
    
    if (!sourceArticleCounts || sourceArticleCounts.trim() === '') {
        return counts;
    }
    
    // 解析格式：source1:count1,source2:count2
    const pairs = sourceArticleCounts.split(',');
    for (const pair of pairs) {
        const trimmed = pair.trim();
        if (trimmed.includes(':')) {
            const [source, count] = trimmed.split(':').map(s => s.trim());
            const numCount = parseInt(count, 10);
            if (source && !isNaN(numCount) && numCount > 0) {
                counts[source] = numCount;
            }
        }
    }
    
    return counts;
}

/**
 * 解析多个更新时间配置
 * @param {string} updateTimesStr - 更新时间配置字符串，格式："08:00,12:00,18:00"
 * @returns {Array} 更新时间数组
 */
function parseUpdateTimes(updateTimesStr) {
    if (!updateTimesStr || updateTimesStr.trim() === '') {
        return [];
    }
    
    const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
    const times = updateTimesStr.split(',').map(time => time.trim()).filter(time => {
        return time && timeRegex.test(time);
    });
    
    return times.sort(); // 按时间排序
}

/**
 * 解析逗号分隔的源列表
 * @param {string} sourcesStr - 源列表字符串，格式："source1,source2,source3"
 * @returns {Array} 源数组
 */
function parseSources(sourcesStr) {
    if (!sourcesStr || sourcesStr.trim() === '') {
        return [];
    }
    
    return sourcesStr.split(',').map(source => source.trim()).filter(source => source);
}

// 应用配置
const config = {
    // 服务器配置
    server: {
        port: getNumberConfig('PORT', 3120),
        host: getConfig('HOST', '0.0.0.0'),
        env: getConfig('NODE_ENV', 'development')
    },
    
    // 新闻API配置
    news: {
        apiKey: getConfig('NEWS_API_KEY'),
        newsApiEnabled: getBooleanConfig('NEWS_API_ENABLED', true),
        newsApiMaxArticles: getNumberConfig('NEWS_API_MAX_ARTICLES', 20),
        sources: parseSources(getConfig('NEWS_SOURCES', '')), // 不设置默认源，由用户配置
        rssSources: getConfig('RSS_SOURCES', ''),
        webScrapingSources: getConfig('WEB_SCRAPING_SOURCES', ''), // 网页抓取源配置
        updateInterval: getConfig('NEWS_UPDATE_INTERVAL', '0 */2 * * *'), // 每2小时更新
        autoUpdateEnabled: getBooleanConfig('AUTO_UPDATE_ENABLED', false), // 是否启用自动更新
        updateTime: getConfig('UPDATE_TIME', '08:00'), // 更新时间（北京时间）- 向后兼容
        updateTimes: parseUpdateTimes(getConfig('UPDATE_TIMES', '')), // 多个更新时间
        updateFrequency: getConfig('UPDATE_FREQUENCY', 'daily'), // 更新频率：daily, hourly, custom
        maxArticlesPerSource: getNumberConfig('MAX_ARTICLES_PER_SOURCE', 5),
        sourceArticleCounts: getConfig('SOURCE_ARTICLE_COUNTS', ''), // 每个源的文章数量配置
        sourceArticleCountsMap: parseSourceArticleCounts(getConfig('SOURCE_ARTICLE_COUNTS', ''), getNumberConfig('MAX_ARTICLES_PER_SOURCE', 5)),
        disabledSources: parseSources(getConfig('DISABLED_SOURCES', '')) // 禁用的源列表
    },
    
    // Gnews API配置
    gnews: {
        apiKey: getConfig('GNEWS_API_KEY'),
        enabled: getBooleanConfig('GNEWS_ENABLED', false),
        category: getConfig('GNEWS_CATEGORY', 'general'), // general, world, nation, business, technology, entertainment, sports, science, health
        language: getConfig('GNEWS_LANGUAGE', 'en'), // 语言代码
        country: getConfig('GNEWS_COUNTRY', 'us'), // 国家代码
        maxArticles: getNumberConfig('GNEWS_MAX_ARTICLES', 10)
    },
    
    // 内容过滤配置
    filter: {
        enabled: getBooleanConfig('FILTER_ENABLED', false),
        keywords: parseSources(getConfig('FILTER_KEYWORDS', '')), // 关键词列表
        filterTitle: getBooleanConfig('FILTER_TITLE', true), // 是否过滤标题
        filterContent: getBooleanConfig('FILTER_CONTENT', true), // 是否过滤内容
        filterSource: getBooleanConfig('FILTER_SOURCE', true) // 是否过滤来源
    },
    
    // Google服务配置 (已不再用于TTS，保留占位)
    google: {
        ttsApiKey: getConfig('GOOGLE_TTS_API_KEY')
    },

    // TTS服务配置（OpenAI-Edge-TTS）
    tts: {
        baseUrl: getConfig('TTS_BASE_URL', 'http://10.10.10.80:5050/v1/audio/speech'),
        model: getConfig('TTS_MODEL', 'tts-1'),
        format: getConfig('TTS_FORMAT', 'mp3'),
        hostVoice: getConfig('TTS_HOST_VOICE', 'zh-CN-XiaoxiaoNeural'),
        guestVoice: getConfig('TTS_GUEST_VOICE', 'zh-CN-YunyangNeural'),
        apiKey: getConfig('TTS_API_KEY') // 可选
    },


    
    // SMTP邮件配置
    smtp: {
        host: getConfig('SMTP_HOST'),
        port: getNumberConfig('SMTP_PORT', 587),
        secure: getBooleanConfig('SMTP_SECURE', false),
        user: getConfig('SMTP_USER'),
        pass: getConfig('SMTP_PASS'),
        fromName: getConfig('SMTP_FROM_NAME', '聚核 (CoreFeed)'),
        fromEmail: getConfig('SMTP_FROM_EMAIL'),
        defaultRecipient: getConfig('DEFAULT_RECIPIENT_EMAIL')
    },
    
    // 数据存储配置
    storage: {
        dataDir: path.join(__dirname, '..', 'data'),
        newsFile: path.join(__dirname, '..', 'data', 'news.json'),
        podcastDir: path.join(__dirname, '..', 'data', 'podcast'),
        epubDir: path.join(__dirname, '..', 'data', 'epub'),
        summaryFile: path.join(__dirname, '..', 'data', 'summary.json'),
        sourcesFile: path.join(__dirname, '..', 'config', 'sources.json'),
        newsDataPath: 'data/news.json'
    },
    
    // AI服务配置
    ai: {
        maxRetries: getNumberConfig('AI_MAX_RETRIES', 3),
        requestTimeout: getNumberConfig('AI_REQUEST_TIMEOUT', 30000),
        batchSize: getNumberConfig('AI_BATCH_SIZE', 5)
    },

    // MiniMax配置
    minimax: {
        baseUrl: getConfig('AI_BASE_URL', 'https://api.minimaxi.com/v1'),
        apiKey: getConfig('AI_API_KEY', ''),
        model: getConfig('AI_MODEL', 'MiniMax-M2.5'),
        // 速率限制配置
        rateLimitRpm: getNumberConfig('AI_RATE_LIMIT_RPM', 60),
        rateLimitBurst: getNumberConfig('AI_RATE_LIMIT_BURST', 10)
    },

    // FTP服务器配置
    ftp: {
        host: getConfig('FTP_HOST', '80.251.219.189'),
        username: getConfig('FTP_USERNAME', 'audio'),
        password: getConfig('FTP_PASSWORD', 'Hp4j9ZDzeKNJ'),
        filename: getConfig('FTP_FILENAME', 'news_global_today.mp3'),
        port: getNumberConfig('FTP_PORT', 21),
        secure: getBooleanConfig('FTP_SECURE', false),
        enabled: getBooleanConfig('FTP_ENABLED', true)
    },
    
    // 音频配置
    audio: {
        voice: getConfig('TTS_VOICE', 'zh-CN-XiaoxiaoNeural'),
        speed: getConfig('TTS_SPEED', '1.0'),
        format: getConfig('TTS_FORMAT', 'mp3'),
        quality: getConfig('TTS_QUALITY', 'high'),
        useFFmpeg: getBooleanConfig('USE_FFMPEG', true), // 是否使用ffmpeg合并音频
        ffmpegPath: getConfig('FFMPEG_PATH', 'ffmpeg') // ffmpeg可执行文件路径
    },
    
    // 缓存配置
    cache: {
        enabled: getBooleanConfig('CACHE_ENABLED', true),
        ttl: getNumberConfig('CACHE_TTL', 3600), // 1小时
        maxSize: getNumberConfig('CACHE_MAX_SIZE', 100)
    },
    
    // 日志配置
    logging: {
        level: getConfig('LOG_LEVEL', 'info'),
        file: getBooleanConfig('LOG_TO_FILE', false),
        console: getBooleanConfig('LOG_TO_CONSOLE', true)
    },
    
    // 网络配置
    network: {
        timeout: getNumberConfig('NETWORK_TIMEOUT', 30000), // 30秒超时
        retries: getNumberConfig('NETWORK_RETRIES', 5),     // 重试5次
        retryDelay: getNumberConfig('NETWORK_RETRY_DELAY', 2000), // 重试间隔2秒
        keepAlive: getBooleanConfig('NETWORK_KEEP_ALIVE', true),
        maxSockets: getNumberConfig('NETWORK_MAX_SOCKETS', 50)
    },
    
    // 网页抓取配置
    webScraping: {
        enabled: getBooleanConfig('WEB_SCRAPING_ENABLED', false),
        userAgent: getConfig('WEB_SCRAPING_USER_AGENT', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'),
        timeout: getNumberConfig('WEB_SCRAPING_TIMEOUT', 30000),
        maxArticles: getNumberConfig('WEB_SCRAPING_MAX_ARTICLES', 10),
        retries: getNumberConfig('WEB_SCRAPING_RETRIES', 3),
        retryDelay: getNumberConfig('WEB_SCRAPING_RETRY_DELAY', 2000),
        respectRobotsTxt: getBooleanConfig('WEB_SCRAPING_RESPECT_ROBOTS', true),
        delayBetweenRequests: getNumberConfig('WEB_SCRAPING_DELAY', 1000) // 请求间隔1秒
    },
    
    // Socket.IO配置
    socketio: {
        pingTimeout: getNumberConfig('SOCKETIO_PING_TIMEOUT', 60000),
        pingInterval: getNumberConfig('SOCKETIO_PING_INTERVAL', 25000),
        connectTimeout: getNumberConfig('SOCKETIO_CONNECT_TIMEOUT', 45000),
        maxHttpBufferSize: getNumberConfig('SOCKETIO_MAX_BUFFER_SIZE', 1000000)
    }
};

/**
 * 验证所有必需的配置
 */
function validateConfig() {
    const errors = [];
    const warnings = [];
    
    try {
        // 在生产环境验证必需的API密钥
        if (config.server.env === 'production') {
            if (!config.news.apiKey) {
                errors.push('NEWS_API_KEY 是必需的');
            }
            
            if (!config.minimax.apiKey) {
                errors.push('AI_API_KEY 是必需的 (MiniMax)');
            }
            
            if (config.gnews.enabled && !config.gnews.apiKey) {
                errors.push('GNEWS_API_KEY 是必需的（当启用Gnews时）');
            }
        } else {
            // 开发环境只给出警告
            if (!config.news.apiKey) {
                warnings.push('NEWS_API_KEY 未设置，新闻获取功能将不可用');
            }
            
            if (!config.minimax.apiKey) {
                warnings.push('AI_API_KEY 未设置，AI功能将不可用 (MiniMax)');
            }
            
            if (config.gnews.enabled && !config.gnews.apiKey) {
                warnings.push('GNEWS_API_KEY 未设置，Gnews功能将不可用');
            }
        }
        
        // 验证端口范围
        if (config.server.port < 1 || config.server.port > 65535) {
            errors.push('PORT 必须在 1-65535 范围内');
        }
        
        // 验证SMTP配置（如果启用邮件功能）
        if (config.smtp.host && (!config.smtp.user || !config.smtp.pass)) {
            errors.push('如果设置了 SMTP_HOST，则 SMTP_USER 和 SMTP_PASS 也是必需的');
        }
        
        if (errors.length > 0) {
            throw new Error(`配置验证失败:\n${errors.join('\n')}`);
        }
        
        const logger = require('../utils/logger');
        logger.success('CONFIG', '配置验证通过');
    } catch (error) {
        const logger = require('../utils/logger');
        if (warnings.length > 0) {
            logger.warn('CONFIG', '配置警告', { warnings });
        }
        logger.error('CONFIG', '配置验证失败', error.message);
        process.exit(1);
    }
}

/**
 * 获取环境特定的配置
 */
function getEnvironmentConfig() {
    const env = config.server.env;
    
    const envConfigs = {
        development: {
            logging: { level: 'debug' },
            cache: { enabled: false }
        },
        production: {
            logging: { level: 'warn', file: true },
            cache: { enabled: true }
        },
        test: {
            logging: { level: 'error', console: false },
            cache: { enabled: false }
        }
    };
    
    return envConfigs[env] || {};
}

/**
 * 合并环境特定配置
 */
function mergeEnvironmentConfig() {
    const envConfig = getEnvironmentConfig();
    
    // 深度合并配置
    function deepMerge(target, source) {
        for (const key in source) {
            if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
                target[key] = target[key] || {};
                deepMerge(target[key], source[key]);
            } else {
                target[key] = source[key];
            }
        }
        return target;
    }
    
    return deepMerge(config, envConfig);
}

// 导出最终配置
const finalConfig = mergeEnvironmentConfig();

// 在非测试环境下验证配置
if (process.env.NODE_ENV !== 'test') {
    validateConfig();
}

module.exports = finalConfig;