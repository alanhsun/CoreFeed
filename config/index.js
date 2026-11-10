/**
 * 聚核 CoreFeed v2.0 — 全局动态配置管理模块 (config/index.js)
 *
 * 合并优先级：
 *   1. `data/settings.json` 动态持久化配置（通过 Web UI 设置弹窗或 `POST /api/config` 修改）
 *   2. 环境变量 (`.env` / `process.env`)
 *   3. 方案 2B 默认参数（GitHub `ag-snapshot/latest.json` 60m 自动同步、每日 08:00/12:30/19:30 定时同步）
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
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
    const defaultPushToGithub = getBooleanConfig('GITHUB_PUSH_ENABLED', getBooleanConfig('AG_GITHUB_SYNC', true));
    const defaultClientId = getConfig('CLIENT_ID', getConfig('AG_CLIENT_ID', os.hostname() || 'antigravity-client'));
    const agUpdateTimes = parseUpdateTimes(getConfig('AG_UPDATE_TIMES', getConfig('agUpdateTimes', '07:40,12:10,19:10')));
    const resolvedAgUpdateTimes = agUpdateTimes.length > 0 ? agUpdateTimes : ['07:40', '12:10', '19:10'];

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
            sourceConcurrency: getNumberConfig('AGENT_SOURCE_CONCURRENCY', 8),
            enableGoogleNewsFallback: getBooleanConfig('AGENT_GNEWS_PROXY_FALLBACK', true),
            freshnessHours: getNumberConfig('AGENT_FRESHNESS_HOURS', 48),
            publishSecret: getConfig('PUBLISH_SECRET', getConfig('PUBLISH_API_KEY', '')),
            siteUrl: getConfig('COREFEED_SITE_URL', `http://localhost:${getNumberConfig('PORT', 3120)}`),
            githubSyncEnabled: getBooleanConfig('GITHUB_SYNC_ENABLED', true),
            githubPushEnabled: defaultPushToGithub,
            pushToGithub: defaultPushToGithub,
            githubSnapshotUrl: getConfig(
                'GITHUB_SNAPSHOT_URL',
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
            ),
            githubSyncIntervalMinutes: getNumberConfig('GITHUB_SYNC_INTERVAL_MINUTES', 60),
            githubCooldownMinutes: getNumberConfig('GITHUB_COOLDOWN_MINUTES', 30),
            clientId: defaultClientId,
            githubBranch: getConfig('AG_GITHUB_BRANCH', 'ag-snapshot'),
            githubRemote: getConfig('AG_GITHUB_REMOTE', 'origin'),
            syncOnStartup: getBooleanConfig('GITHUB_SYNC_ON_STARTUP', true),
            updateTimes: resolvedAgUpdateTimes,
            scheduleTimes: resolvedAgUpdateTimes
        },

        // GitHub 快照中转同步配置 (多客户端方案 2B 统一中枢: Antigravity Clients <-> GitHub ag-snapshot -> 软路由)
        githubSync: {
            enabled: getBooleanConfig('GITHUB_SYNC_ENABLED', true),
            pushEnabled: defaultPushToGithub,
            pushToGithub: defaultPushToGithub,
            snapshotUrl: getConfig(
                'GITHUB_SNAPSHOT_URL',
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
            ),
            intervalMinutes: getNumberConfig('GITHUB_SYNC_INTERVAL_MINUTES', 60),
            cooldownMinutes: getNumberConfig('GITHUB_COOLDOWN_MINUTES', 30),
            clientId: defaultClientId,
            branch: getConfig('AG_GITHUB_BRANCH', 'ag-snapshot'),
            remote: getConfig('AG_GITHUB_REMOTE', 'origin'),
            syncOnStartup: getBooleanConfig('GITHUB_SYNC_ON_STARTUP', true)
        },

        // 新闻源与每日定时调度配置
        news: {
            apiKey: getConfig('NEWS_API_KEY', ''),
            newsApiEnabled: getBooleanConfig('NEWS_API_ENABLED', true),
            newsApiMaxArticles: getNumberConfig('NEWS_API_MAX_ARTICLES', 15),
            sources: parseSources(getConfig('NEWS_SOURCES', '')),
            rssSources: getConfig('RSS_SOURCES', ''),
            autoUpdateEnabled: getBooleanConfig('AUTO_UPDATE_ENABLED', true),
            updateTimes: parseUpdateTimes(getConfig('UPDATE_TIMES', getConfig('scheduleTimes', '08:00,12:30,19:30'))),
            scheduleTimes: parseUpdateTimes(getConfig('UPDATE_TIMES', getConfig('scheduleTimes', '08:00,12:30,19:30'))),
            timezone: getConfig('SCHEDULE_TIMEZONE', getConfig('timezone', 'Asia/Shanghai')),
            maxArticlesPerSource: getNumberConfig('MAX_ARTICLES_PER_SOURCE', 5),
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
            timeout: getNumberConfig('WEB_SCRAPING_TIMEOUT', 25000)
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

function parseBoolInput(val) {
    if (typeof val === 'boolean') return val;
    const str = String(val).toLowerCase().trim();
    return str === 'true' || str === '1' || str === 'yes';
}

/**
 * 动态保存设置到 data/settings.json 并刷新内存配置
 */
config.saveDynamicSettings = function (updates = {}) {
    const current = loadSavedSettings();
    const raw = { ...updates };
    const normalizedUpdates = {};

    // 1. 兼容驼峰与别名键名映射至标准大写配置键
    if (raw.githubSyncEnabled !== undefined && raw.GITHUB_SYNC_ENABLED === undefined) {
        raw.GITHUB_SYNC_ENABLED = raw.githubSyncEnabled;
    }
    if (raw.githubPushEnabled !== undefined && raw.GITHUB_PUSH_ENABLED === undefined) {
        raw.GITHUB_PUSH_ENABLED = raw.githubPushEnabled;
    }
    if (raw.pushToGithub !== undefined && raw.GITHUB_PUSH_ENABLED === undefined) {
        raw.GITHUB_PUSH_ENABLED = raw.pushToGithub;
    }
    if (raw.githubSyncIntervalMinutes !== undefined && raw.GITHUB_SYNC_INTERVAL_MINUTES === undefined) {
        raw.GITHUB_SYNC_INTERVAL_MINUTES = raw.githubSyncIntervalMinutes;
    }
    if (raw.githubCooldownMinutes !== undefined && raw.GITHUB_COOLDOWN_MINUTES === undefined) {
        raw.GITHUB_COOLDOWN_MINUTES = raw.githubCooldownMinutes;
    }
    if (raw.clientId !== undefined && raw.CLIENT_ID === undefined) {
        raw.CLIENT_ID = raw.clientId;
    }
    if (raw.githubSnapshotUrl !== undefined && raw.GITHUB_SNAPSHOT_URL === undefined) {
        raw.GITHUB_SNAPSHOT_URL = raw.githubSnapshotUrl;
    }
    if (raw.autoUpdateEnabled !== undefined && raw.AUTO_UPDATE_ENABLED === undefined) {
        raw.AUTO_UPDATE_ENABLED = raw.autoUpdateEnabled;
    }
    if (raw.scheduleEnabled !== undefined && raw.AUTO_UPDATE_ENABLED === undefined) {
        raw.AUTO_UPDATE_ENABLED = raw.scheduleEnabled;
    }
    if (raw.updateTimes !== undefined && raw.UPDATE_TIMES === undefined) {
        raw.UPDATE_TIMES = raw.updateTimes;
    }
    if (raw.scheduleTimes !== undefined && raw.UPDATE_TIMES === undefined) {
        raw.UPDATE_TIMES = Array.isArray(raw.scheduleTimes)
            ? raw.scheduleTimes.join(',')
            : String(raw.scheduleTimes);
    }

    const aliasKeys = new Set([
        'githubSyncEnabled',
        'githubPushEnabled',
        'pushToGithub',
        'githubSyncIntervalMinutes',
        'githubCooldownMinutes',
        'clientId',
        'githubSnapshotUrl',
        'autoUpdateEnabled',
        'scheduleEnabled',
        'updateTimes'
    ]);

    for (const [k, v] of Object.entries(raw)) {
        if (aliasKeys.has(k) || v === undefined || v === null) continue;
        normalizedUpdates[k] = v;
    }

    // 2. 保护可选外部 AI 配置项不被空字符串或脱敏掩码 ('***') 覆盖清除
    if (normalizedUpdates.AI_API_KEY !== undefined) {
        const keyStr = String(normalizedUpdates.AI_API_KEY).trim();
        if (!keyStr || keyStr.startsWith('***')) {
            delete normalizedUpdates.AI_API_KEY;
        } else {
            normalizedUpdates.AI_API_KEY = keyStr;
        }
    }
    if (normalizedUpdates.AI_BASE_URL !== undefined) {
        const urlStr = String(normalizedUpdates.AI_BASE_URL).trim();
        if (!urlStr) {
            delete normalizedUpdates.AI_BASE_URL;
        } else {
            normalizedUpdates.AI_BASE_URL = urlStr;
        }
    }
    if (normalizedUpdates.AI_MODEL !== undefined) {
        const modelStr = String(normalizedUpdates.AI_MODEL).trim();
        if (!modelStr) {
            delete normalizedUpdates.AI_MODEL;
        } else {
            normalizedUpdates.AI_MODEL = modelStr;
        }
    }

    // 3. 规范化方案 2B 与定时调度参数
    if (normalizedUpdates.GITHUB_SYNC_ENABLED !== undefined) {
        normalizedUpdates.GITHUB_SYNC_ENABLED = parseBoolInput(normalizedUpdates.GITHUB_SYNC_ENABLED);
    }
    if (normalizedUpdates.GITHUB_PUSH_ENABLED !== undefined) {
        normalizedUpdates.GITHUB_PUSH_ENABLED = parseBoolInput(normalizedUpdates.GITHUB_PUSH_ENABLED);
        normalizedUpdates.AG_GITHUB_SYNC = normalizedUpdates.GITHUB_PUSH_ENABLED;
    }
    if (normalizedUpdates.AUTO_UPDATE_ENABLED !== undefined) {
        normalizedUpdates.AUTO_UPDATE_ENABLED = parseBoolInput(normalizedUpdates.AUTO_UPDATE_ENABLED);
    }
    if (normalizedUpdates.JINA_READER_ENABLED !== undefined) {
        normalizedUpdates.JINA_READER_ENABLED = parseBoolInput(normalizedUpdates.JINA_READER_ENABLED);
    }
    if (normalizedUpdates.GITHUB_SYNC_INTERVAL_MINUTES !== undefined) {
        const interval = parseInt(normalizedUpdates.GITHUB_SYNC_INTERVAL_MINUTES, 10);
        normalizedUpdates.GITHUB_SYNC_INTERVAL_MINUTES = !isNaN(interval) && interval > 0 ? interval : 60;
    }
    if (normalizedUpdates.GITHUB_COOLDOWN_MINUTES !== undefined) {
        const cooldown = parseInt(normalizedUpdates.GITHUB_COOLDOWN_MINUTES, 10);
        normalizedUpdates.GITHUB_COOLDOWN_MINUTES = !isNaN(cooldown) && cooldown >= 0 ? cooldown : 30;
    }
    if (normalizedUpdates.CLIENT_ID !== undefined) {
        const cid = String(normalizedUpdates.CLIENT_ID).trim();
        if (cid) {
            normalizedUpdates.CLIENT_ID = cid;
            normalizedUpdates.AG_CLIENT_ID = cid;
        } else {
            delete normalizedUpdates.CLIENT_ID;
        }
    }
    if (normalizedUpdates.GITHUB_SNAPSHOT_URL !== undefined) {
        const snapUrl = String(normalizedUpdates.GITHUB_SNAPSHOT_URL).trim();
        if (snapUrl) {
            normalizedUpdates.GITHUB_SNAPSHOT_URL = snapUrl;
        } else {
            delete normalizedUpdates.GITHUB_SNAPSHOT_URL;
        }
    }
    if (normalizedUpdates.UPDATE_TIMES !== undefined) {
        const parsed = parseUpdateTimes(normalizedUpdates.UPDATE_TIMES);
        const finalTimes = parsed.length > 0
            ? parsed
            : (config.news?.updateTimes?.length ? config.news.updateTimes : ['08:00', '12:30', '19:30']);
        normalizedUpdates.UPDATE_TIMES = finalTimes.join(',');
        normalizedUpdates.scheduleTimes = finalTimes;
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
        if (v !== undefined && v !== null && v !== '') {
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
    const envPath = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envPath)) {
        try {
            const parsedEnv = require('dotenv').parse(fs.readFileSync(envPath, 'utf8'));
            for (const [k, v] of Object.entries(parsedEnv)) {
                if (v !== undefined && v !== null && String(v).trim() !== '') {
                    process.env[k] = String(v);
                } else if (process.env[k] === undefined) {
                    process.env[k] = '';
                }
            }
        } catch (_) {}
    }
    const saved = loadSavedSettings();
    for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined && v !== null && v !== '' && k !== 'updatedAt' && k !== 'scheduleTimes') {
            process.env[k] = Array.isArray(v) ? v.join(',') : String(v);
        }
    }
    const refreshed = buildConfig();
    Object.assign(config, refreshed);
    return config;
};

module.exports = config;
