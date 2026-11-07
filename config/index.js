const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const SETTINGS_FILE_PATH = path.join(__dirname, '..', 'data', 'settings.json');

/**
 * 加载持久化设置 (data/settings.json)
 */
function loadSavedSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(SETTINGS_FILE_PATH, 'utf8'));
        }
    } catch (e) {
        console.error('加载 settings.json 失败:', e.message);
    }
    return {};
}

let savedSettings = loadSavedSettings();

/**
 * 配置读取辅助函数
 */
function getConfig(key, defaultValue = null, required = false) {
    if (savedSettings[key] !== undefined && savedSettings[key] !== null && savedSettings[key] !== '') {
        return savedSettings[key];
    }

    const value = process.env[key] !== undefined && process.env[key] !== '' ? process.env[key] : defaultValue;

    if (required && !value) {
        throw new Error(`必需的环境变量 ${key} 未设置`);
    }

    return value;
}

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

function getBooleanConfig(key, defaultValue = false) {
    const value = getConfig(key, defaultValue.toString());
    if (typeof value === 'boolean') return value;
    const str = String(value).toLowerCase().trim();
    return str === 'true' || str === '1' || str === 'yes';
}

function parseSourceArticleCounts(sourceArticleCounts, defaultCount = 5) {
    const counts = {};
    if (!sourceArticleCounts || typeof sourceArticleCounts !== 'string' || sourceArticleCounts.trim() === '') {
        return counts;
    }
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

function parseUpdateTimes(updateTimesStr) {
    if (!updateTimesStr) return [];
    const rawList = Array.isArray(updateTimesStr)
        ? updateTimesStr
        : (typeof updateTimesStr === 'string' ? updateTimesStr.split(',') : []);

    const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    const times = [];
    const seen = new Set();

    for (const item of rawList) {
        const trimmed = String(item || '').trim();
        const match = trimmed.match(timeRegex);
        if (match) {
            const normalized = `${String(parseInt(match[1], 10)).padStart(2, '0')}:${match[2]}`;
            if (!seen.has(normalized)) {
                seen.add(normalized);
                times.push(normalized);
            }
        }
    }

    return times.sort();
}

function parseSources(sourcesStr) {
    if (!sourcesStr) return [];
    if (Array.isArray(sourcesStr)) return sourcesStr;
    if (typeof sourcesStr !== 'string' || sourcesStr.trim() === '') {
        return [];
    }
    return sourcesStr.split(',').map(source => source.trim()).filter(Boolean);
}

/**
 * 构建完整配置对象
 */
function buildConfig() {
    savedSettings = loadSavedSettings();

    const env = getConfig('NODE_ENV', 'development');

    const baseConfig = {
        server: {
            port: getNumberConfig('PORT', 3120),
            host: getConfig('HOST', '0.0.0.0'),
            env
        },

        // Agent 搜集与整合引擎配置 (CoreFeed v2.0)
        agent: {
            enabled: getBooleanConfig('AGENT_ENABLED', true),
            jinaReaderEnabled: getBooleanConfig('JINA_READER_ENABLED', true),
            jinaApiKey: getConfig('JINA_API_KEY', ''),
            maxCuratedArticles: getNumberConfig('AGENT_MAX_CURATED_ARTICLES', 30),
            maxCandidatePool: getNumberConfig('AGENT_MAX_CANDIDATE_POOL', 80),
            deepReadTopCount: getNumberConfig('AGENT_DEEP_READ_COUNT', 10),
            sourceConcurrency: getNumberConfig('AGENT_SOURCE_CONCURRENCY', 8),
            enableGoogleNewsFallback: getBooleanConfig('AGENT_GNEWS_PROXY_FALLBACK', true),
            freshnessHours: getNumberConfig('AGENT_FRESHNESS_HOURS', 48),
            publishSecret: getConfig('PUBLISH_SECRET', getConfig('PUBLISH_API_KEY', '')),
            siteUrl: getConfig('COREFEED_SITE_URL', `http://localhost:${getNumberConfig('PORT', 3120)}`),
            githubSyncEnabled: getBooleanConfig('GITHUB_SYNC_ENABLED', true),
            githubSnapshotUrl: getConfig(
                'GITHUB_SNAPSHOT_URL',
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
            ),
            githubSyncIntervalMinutes: getNumberConfig('GITHUB_SYNC_INTERVAL_MINUTES', 15),
            githubBranch: getConfig('AG_GITHUB_BRANCH', 'ag-snapshot'),
            githubRemote: getConfig('AG_GITHUB_REMOTE', 'origin'),
            syncOnStartup: getBooleanConfig('GITHUB_SYNC_ON_STARTUP', true)
        },

        // GitHub 快照中转同步配置 (云端 Antigravity -> GitHub ag-snapshot -> 软路由)
        githubSync: {
            enabled: getBooleanConfig('GITHUB_SYNC_ENABLED', true),
            snapshotUrl: getConfig(
                'GITHUB_SNAPSHOT_URL',
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
            ),
            intervalMinutes: getNumberConfig('GITHUB_SYNC_INTERVAL_MINUTES', 15),
            branch: getConfig('AG_GITHUB_BRANCH', 'ag-snapshot'),
            remote: getConfig('AG_GITHUB_REMOTE', 'origin'),
            syncOnStartup: getBooleanConfig('GITHUB_SYNC_ON_STARTUP', true)
        },

        // 新闻API与源配置
        news: {
            apiKey: getConfig('NEWS_API_KEY', ''),
            newsApiEnabled: getBooleanConfig('NEWS_API_ENABLED', true),
            newsApiMaxArticles: getNumberConfig('NEWS_API_MAX_ARTICLES', 15),
            sources: parseSources(getConfig('NEWS_SOURCES', '')),
            rssSources: getConfig('RSS_SOURCES', ''),
            webScrapingSources: getConfig('WEB_SCRAPING_SOURCES', ''),
            updateInterval: getConfig('NEWS_UPDATE_INTERVAL', '0 */2 * * *'),
            autoUpdateEnabled: getBooleanConfig('AUTO_UPDATE_ENABLED', true),
            updateTime: getConfig('UPDATE_TIME', '08:00'),
            updateTimes: parseUpdateTimes(getConfig('UPDATE_TIMES', getConfig('scheduleTimes', '08:00,12:30,19:30'))),
            scheduleTimes: parseUpdateTimes(getConfig('UPDATE_TIMES', getConfig('scheduleTimes', '08:00,12:30,19:30'))),
            timezone: getConfig('SCHEDULE_TIMEZONE', getConfig('timezone', 'Asia/Shanghai')),
            updateFrequency: getConfig('UPDATE_FREQUENCY', 'daily'),
            maxArticlesPerSource: getNumberConfig('MAX_ARTICLES_PER_SOURCE', 5),
            sourceArticleCounts: getConfig('SOURCE_ARTICLE_COUNTS', ''),
            sourceArticleCountsMap: parseSourceArticleCounts(
                getConfig('SOURCE_ARTICLE_COUNTS', ''),
                getNumberConfig('MAX_ARTICLES_PER_SOURCE', 5)
            ),
            disabledSources: parseSources(getConfig('DISABLED_SOURCES', ''))
        },

        // Gnews API配置
        gnews: {
            apiKey: getConfig('GNEWS_API_KEY', ''),
            enabled: getBooleanConfig('GNEWS_ENABLED', false),
            category: getConfig('GNEWS_CATEGORY', 'general'),
            language: getConfig('GNEWS_LANGUAGE', 'en'),
            country: getConfig('GNEWS_COUNTRY', 'us'),
            maxArticles: getNumberConfig('GNEWS_MAX_ARTICLES', 15)
        },

        // 内容过滤配置
        filter: {
            enabled: getBooleanConfig('FILTER_ENABLED', false),
            keywords: parseSources(getConfig('FILTER_KEYWORDS', '')),
            filterTitle: getBooleanConfig('FILTER_TITLE', true),
            filterContent: getBooleanConfig('FILTER_CONTENT', true),
            filterSource: getBooleanConfig('FILTER_SOURCE', false)
        },

        // 数据存储配置
        storage: {
            dataDir: path.join(__dirname, '..', 'data'),
            newsFile: path.join(__dirname, '..', 'data', 'news.json'),
            stateFile: path.join(__dirname, '..', 'data', 'state.json'),
            summaryFile: path.join(__dirname, '..', 'data', 'summary.json'),
            settingsFile: SETTINGS_FILE_PATH,
            newsDataPath: 'data/news.json'
        },

        // AI服务配置
        ai: {
            maxRetries: getNumberConfig('AI_MAX_RETRIES', 3),
            requestTimeout: getNumberConfig('AI_REQUEST_TIMEOUT', 90000),
            batchSize: getNumberConfig('AI_BATCH_SIZE', 8)
        },

        // 大模型配置 (OpenAI 兼容端点)
        minimax: {
            baseUrl: getConfig('AI_BASE_URL', 'https://api.openai.com/v1'),
            apiKey: getConfig('AI_API_KEY', ''),
            model: getConfig('AI_MODEL', 'gpt-4o-mini'),
            rateLimitRpm: getNumberConfig('AI_RATE_LIMIT_RPM', 30),
            rateLimitBurst: getNumberConfig('AI_RATE_LIMIT_BURST', 5)
        },

        // 缓存配置
        cache: {
            enabled: env === 'production' ? true : getBooleanConfig('CACHE_ENABLED', false),
            ttl: getNumberConfig('CACHE_TTL', 3600),
            maxSize: getNumberConfig('CACHE_MAX_SIZE', 200)
        },

        // 日志配置
        logging: {
            level: getConfig('LOG_LEVEL', env === 'production' ? 'info' : 'debug'),
            file: getBooleanConfig('LOG_TO_FILE', env === 'production'),
            console: getBooleanConfig('LOG_TO_CONSOLE', true)
        },

        // 网络配置
        network: {
            timeout: getNumberConfig('NETWORK_TIMEOUT', 25000),
            retries: getNumberConfig('NETWORK_RETRIES', 3),
            retryDelay: getNumberConfig('NETWORK_RETRY_DELAY', 1500),
            keepAlive: getBooleanConfig('NETWORK_KEEP_ALIVE', true),
            maxSockets: getNumberConfig('NETWORK_MAX_SOCKETS', 50)
        },

        // 网页抓取配置
        webScraping: {
            enabled: getBooleanConfig('WEB_SCRAPING_ENABLED', true),
            userAgent: getConfig(
                'WEB_SCRAPING_USER_AGENT',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
            ),
            timeout: getNumberConfig('WEB_SCRAPING_TIMEOUT', 25000),
            maxArticles: getNumberConfig('WEB_SCRAPING_MAX_ARTICLES', 5),
            retries: getNumberConfig('WEB_SCRAPING_RETRIES', 2),
            retryDelay: getNumberConfig('WEB_SCRAPING_RETRY_DELAY', 1500),
            respectRobotsTxt: getBooleanConfig('WEB_SCRAPING_RESPECT_ROBOTS', false),
            delayBetweenRequests: getNumberConfig('WEB_SCRAPING_DELAY', 500)
        },

        // Socket.IO配置
        socketio: {
            pingTimeout: getNumberConfig('SOCKETIO_PING_TIMEOUT', 60000),
            pingInterval: getNumberConfig('SOCKETIO_PING_INTERVAL', 25000),
            connectTimeout: getNumberConfig('SOCKETIO_CONNECT_TIMEOUT', 45000),
            maxHttpBufferSize: getNumberConfig('SOCKETIO_MAX_BUFFER_SIZE', 1000000)
        }
    };

    return baseConfig;
}

const config = buildConfig();

/**
 * 动态保存设置到 data/settings.json 并刷新内存配置
 */
config.saveDynamicSettings = function (updates = {}) {
    const current = loadSavedSettings();
    const normalizedUpdates = { ...updates };
    if (normalizedUpdates.scheduleTimes !== undefined && normalizedUpdates.UPDATE_TIMES === undefined) {
        normalizedUpdates.UPDATE_TIMES = Array.isArray(normalizedUpdates.scheduleTimes)
            ? normalizedUpdates.scheduleTimes.join(',')
            : String(normalizedUpdates.scheduleTimes);
    }
    if (normalizedUpdates.UPDATE_TIMES !== undefined) {
        const parsed = parseUpdateTimes(normalizedUpdates.UPDATE_TIMES);
        normalizedUpdates.UPDATE_TIMES = parsed.join(',');
        normalizedUpdates.scheduleTimes = parsed;
    }
    const merged = {
        timezone: 'Asia/Shanghai',
        ...current,
        ...normalizedUpdates,
        updatedAt: new Date().toISOString()
    };
    const dir = path.dirname(SETTINGS_FILE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_FILE_PATH, JSON.stringify(merged, null, 2), 'utf8');

    // 同时同步更新 process.env 以便子模块立即读取
    for (const [k, v] of Object.entries(normalizedUpdates)) {
        if (v !== undefined && v !== null) {
            process.env[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
    }

    const refreshed = buildConfig();
    Object.assign(config, refreshed);
    return config;
};

/**
 * 重新加载配置
 */
config.reload = function () {
    require('dotenv').config({ override: true });
    const refreshed = buildConfig();
    Object.assign(config, refreshed);
    return config;
};

module.exports = config;
