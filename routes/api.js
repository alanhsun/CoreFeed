/**
 * 聚核 CoreFeed v2.0 — RESTful API 路由控制器 (routes/api.js)
 *
 * 核心路由模块：
 *   0. `/api/image-proxy`        — 外媒新闻题图防盗链与跨境加速代理
 *   1. `/api/agent/*`            — GitHub 快照拉取 (`pull-github`)、外部精编发布 (`publish`) 与同步状态 (`sync-status`)
 *   2. `/api/news`, `/api/summary` — 新闻流多维筛选、增量分页、全文中文翻译与今日全球要闻深度综述
 *   3. `/api/status`, `/api/config`, `/api/schedule/*`, `/api/latest-data` — 系统遥测、动态配置持久化与聚合输出
 */
const express = require('express');
const axios = require('axios');
const https = require('https');
const config = require('../config');
const { readJsonFile, isValidUrl, SimpleCache } = require('../utils/helpers');
const logger = require('../utils/logger');
const { applySnapshotToRouter } = require('../utils/github_sync');
const { buildAiBriefing } = require('../utils/briefing_formatter');

const proxyHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const imageProxyCache = new SimpleCache(150, 2 * 60 * 60 * 1000);

/**
 * 初始化 API 路由
 */
function initializeApiRoutes(services, io, stateManager) {
    const router = express.Router();
    const { newsService, scheduleManager, newsAgentService, githubSyncManager } = services;

    const verifyPublishSecret = (req) => {
        const expectedSecret = String(
            process.env.PUBLISH_SECRET !== undefined
                ? process.env.PUBLISH_SECRET
                : (process.env.PUBLISH_API_KEY !== undefined
                    ? process.env.PUBLISH_API_KEY
                    : (config.agent?.publishSecret || ''))
        ).trim();

        if (!expectedSecret) {
            return { authorized: true };
        }

        const authHeader = String(req.get('Authorization') || req.headers?.authorization || '').trim();
        const bearerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
        const publishSecretHeader = String(req.get('x-publish-secret') || req.headers?.['x-publish-secret'] || '').trim();
        const apiKeyHeader = String(req.get('x-api-key') || req.headers?.['x-api-key'] || '').trim();
        const bodySecret = String(req.body?.secret || '').trim();
        const providedToken = bearerToken || publishSecretHeader || apiKeyHeader || bodySecret;

        if (!providedToken || providedToken !== expectedSecret) {
            return { authorized: false };
        }
        return { authorized: true };
    };

    // 启动时加载持久化的今日综述数据
    (async () => {
        try {
            const summaryData = await readJsonFile(config.storage.summaryFile);
            if (summaryData && summaryData.article) {
                stateManager.set('summaryArticle', summaryData.article, false);
            }
        } catch (err) {
            logger.debug('API', '加载初始综述缓存跳过', err.message);
        }
    })();

    // ==================== 0. 外媒新闻题图防盗链与跨境加速代理 ====================
    router.get('/image-proxy', async (req, res) => {
        const rawUrl = (req.query.url || '').trim();
        if (!rawUrl || !isValidUrl(rawUrl)) {
            return res.status(400).end();
        }

        let parsed;
        try {
            parsed = new URL(rawUrl);
            if (!['http:', 'https:'].includes(parsed.protocol)) {
                return res.status(400).end();
            }
            const host = parsed.hostname.toLowerCase();
            if (
                host === 'localhost' ||
                host.startsWith('127.') ||
                host.startsWith('10.') ||
                host.startsWith('192.168.') ||
                host === '0.0.0.0' ||
                host.endsWith('.local')
            ) {
                return res.status(403).end();
            }
        } catch (_) {
            return res.status(400).end();
        }

        const cached = imageProxyCache.get(rawUrl);
        if (cached && cached.buffer) {
            res.setHeader('Content-Type', cached.contentType || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(cached.buffer);
        }

        const fetchImageBuffer = async (withReferer = true) => {
            const headers = {
                'User-Agent': config.webScraping.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9'
            };
            if (withReferer) {
                headers['Referer'] = `${parsed.origin}/`;
            }
            return await axios.get(rawUrl, {
                responseType: 'arraybuffer',
                timeout: 8000,
                maxRedirects: 5,
                maxContentLength: 8 * 1024 * 1024,
                httpsAgent: proxyHttpsAgent,
                headers
            });
        };

        try {
            let upstream;
            try {
                upstream = await fetchImageBuffer(true);
            } catch (firstErr) {
                upstream = await fetchImageBuffer(false);
            }

            const contentType = String(upstream.headers['content-type'] || 'image/jpeg').toLowerCase();
            if (contentType.includes('text/html')) {
                return res.status(404).end();
            }

            const buffer = Buffer.from(upstream.data);
            if (!buffer || buffer.length < 120) {
                return res.status(404).end();
            }

            imageProxyCache.set(rawUrl, { buffer, contentType });
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buffer);
        } catch (err) {
            return res.status(502).end();
        }
    });

    // ==================== 1. GitHub 快照同步与外部精编发布接口 ====================

    /**
     * 获取 GitHub 快照中转同步状态
     */
    router.get('/agent/sync-status', (req, res) => {
        res.json({
            success: true,
            ...(githubSyncManager ? githubSyncManager.getStatus() : { enabled: false })
        });
    });

    /**
     * 从 GitHub 快照分支 (默认 ag-snapshot/latest.json) 拉取最新精编新闻并应用至软路由
     */
    router.post('/agent/pull-github', async (req, res) => {
        try {
            const isWebUiDefaultPull =
                !req.body?.snapshotUrl &&
                (req.get('x-requested-with') === 'CoreFeed-WebUI' || req.body?.trigger === 'ui');
            const auth = isWebUiDefaultPull ? { authorized: true } : verifyPublishSecret(req);
            if (!auth.authorized) {
                return res.status(401).json({
                    success: false,
                    message: '未授权的同步请求 (Invalid PUBLISH_SECRET)'
                });
            }

            if (!githubSyncManager) {
                return res.status(500).json({
                    success: false,
                    message: 'GitHubSyncManager 未初始化'
                });
            }

            const forcePull = req.body?.force !== undefined ? Boolean(req.body.force) : true;
            const result = await githubSyncManager.pullAndApply({
                snapshotUrl: req.body?.snapshotUrl || null,
                force: forcePull,
                trigger: req.body?.trigger || (isWebUiDefaultPull ? 'ui' : 'api')
            });

            res.json(result);
        } catch (error) {
            logger.error('API', '从 GitHub 拉取快照失败', error.message);
            const statusCode = error.statusCode || 502;
            res.status(statusCode).json({
                success: false,
                message: '从 GitHub 同步快照失败: ' + error.message
            });
        }
    });

    /**
     * 接收由外部 Agent (如 Antigravity 客户端) 采集、聚类并精编完成的全球新闻与综述数据包
     */
    router.post('/agent/publish', async (req, res) => {
        try {
            const auth = verifyPublishSecret(req);
            if (!auth.authorized) {
                return res.status(401).json({
                    success: false,
                    message: '未授权的发布请求 (Invalid PUBLISH_SECRET)'
                });
            }

            const applied = await applySnapshotToRouter(req.body || {}, {
                stateManager,
                newsAgentService,
                newsService,
                io,
                sourceLabel: 'Antigravity 客户端'
            });

            res.json({
                ...applied,
                message: `成功发布 ${applied.displayedCount} 条全球精选新闻${applied.hasSummary ? '与今日深度综述' : ''}`
            });
        } catch (error) {
            if (error.statusCode === 400) {
                return res.status(400).json({
                    success: false,
                    message: error.message
                });
            }
            logger.error('API', '接收外部发布新闻数据失败', error.message);
            res.status(500).json({
                success: false,
                message: '发布失败: ' + error.message
            });
        }
    });

    // ==================== 2. 新闻流查询、过滤、分页与今日综述接口 ====================

    router.get('/news', (req, res) => {
        const newsData = stateManager.get('newsData') || newsService.getNewsData() || [];
        const allEnhanced = stateManager.get('allEnhancedNews') || newsData;
        const lastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();
        const collectionPhase = stateManager.get('collectionPhase') || 'idle';

        const region = req.query.region;
        const category = req.query.category;
        const source = req.query.source;
        const keyword = (req.query.q || '').trim().toLowerCase();

        let filtered = [...newsData];
        if (region && region !== 'all' && region !== '全部') {
            filtered = filtered.filter(n => n.region === region);
        }
        if (category && category !== 'all' && category !== '全部') {
            filtered = filtered.filter(n => n.category === category);
        }
        if (source && source !== 'all' && source !== '全部') {
            filtered = filtered.filter(n => (n.source?.name || '') === source);
        }
        if (keyword) {
            filtered = filtered.filter(n =>
                (n.translatedTitle || '').toLowerCase().includes(keyword) ||
                (n.title || '').toLowerCase().includes(keyword) ||
                (n.summary || '').toLowerCase().includes(keyword) ||
                (n.source?.name || '').toLowerCase().includes(keyword)
            );
        }

        res.json({
            success: true,
            news: filtered,
            total: allEnhanced.length,
            displayed: filtered.length,
            hasMore: allEnhanced.length > newsData.length,
            collectionPhase,
            lastUpdated,
            lastPublishedBy:
                stateManager.get('lastPublishedBy') ||
                (githubSyncManager ? githubSyncManager.getStatus().publishedBy : null) ||
                null
        });
    });

    router.get('/news/more', (req, res) => {
        const offset = parseInt(req.query.offset, 10) || 30;
        const limit = parseInt(req.query.limit, 10) || 15;
        const allEnhanced = stateManager.get('allEnhancedNews') || stateManager.get('newsData') || [];

        const moreNews = allEnhanced.slice(offset, offset + limit);
        const currentDisplayed = stateManager.get('newsData') || [];

        if (moreNews.length > 0) {
            const merged = [...currentDisplayed, ...moreNews];
            stateManager.set('newsData', merged);
        }

        res.json({
            success: true,
            news: moreNews,
            hasMore: offset + limit < allEnhanced.length,
            total: allEnhanced.length,
            nextOffset: offset + moreNews.length
        });
    });

    router.get('/summary', async (req, res) => {
        let article = stateManager.get('summaryArticle');
        if (!article) {
            const loaded = await readJsonFile(config.storage.summaryFile);
            if (loaded && loaded.article) {
                article = loaded.article;
                stateManager.set('summaryArticle', article, false);
            }
        }
        res.json({
            success: true,
            article: article || null
        });
    });

    // ==================== 3. 系统状态、动态配置与定时调度接口 ====================

    router.get('/status', (req, res) => {
        const newsData = stateManager.get('newsData') || [];
        const summaryArticle = stateManager.get('summaryArticle');

        res.json({
            success: true,
            status: 'running',
            version: '2.0.0',
            newsCount: newsData.length,
            lastUpdated: stateManager.get('lastUpdated'),
            lastPublishedBy:
                stateManager.get('lastPublishedBy') ||
                (githubSyncManager ? githubSyncManager.getStatus().publishedBy : null) ||
                null,
            collectionPhase: stateManager.get('collectionPhase') || 'idle',
            hasSummary: Boolean(summaryArticle),
            editorialEngine: 'antigravity-builtin-llm',
            schedule: scheduleManager ? scheduleManager.getStatus() : null,
            githubSync: githubSyncManager ? githubSyncManager.getStatus() : null
        });
    });

    const buildConfigPayload = () => {
        const syncStatus = githubSyncManager ? githubSyncManager.getStatus() : {};
        const scheduleStatus = scheduleManager ? scheduleManager.getStatus() : {
            isRunning: false,
            enabled: config.news.autoUpdateEnabled,
            updateTimes: config.news.updateTimes,
            scheduleTimes: config.news.scheduleTimes || config.news.updateTimes,
            timezone: config.news.timezone || 'Asia/Shanghai'
        };
        const lastPublishedBy =
            stateManager.get('lastPublishedBy') ||
            syncStatus.publishedBy ||
            null;
        const updateTimesArr = Array.isArray(scheduleStatus.updateTimes) && scheduleStatus.updateTimes.length > 0
            ? scheduleStatus.updateTimes
            : (config.news.updateTimes || ['08:00', '12:30', '19:30']);

        return {
            GITHUB_SYNC_ENABLED: Boolean(config.githubSync?.enabled ?? true),
            GITHUB_PUSH_ENABLED: Boolean(config.githubSync?.pushEnabled ?? true),
            GITHUB_SYNC_INTERVAL_MINUTES: Number(config.githubSync?.intervalMinutes || 60),
            GITHUB_COOLDOWN_MINUTES: Number(config.githubSync?.cooldownMinutes ?? 30),
            CLIENT_ID: config.githubSync?.clientId || config.agent?.clientId || 'antigravity-client',
            GITHUB_SNAPSHOT_URL: config.githubSync?.snapshotUrl || config.agent?.githubSnapshotUrl || '',
            AG_GITHUB_BRANCH: config.githubSync?.branch || 'ag-snapshot',
            UPDATE_TIMES: updateTimesArr.join(','),
            AUTO_UPDATE_ENABLED: Boolean(config.news.autoUpdateEnabled),
            SCHEDULE_TIMEZONE: config.news.timezone || 'Asia/Shanghai',
            lastPublishedBy,
            agent: {
                jinaReaderEnabled: config.agent.jinaReaderEnabled,
                maxCuratedArticles: config.agent.maxCuratedArticles,
                freshnessHours: config.agent.freshnessHours,
                githubSyncEnabled: Boolean(config.githubSync?.enabled ?? true),
                githubPushEnabled: Boolean(config.githubSync?.pushEnabled ?? true),
                githubSyncIntervalMinutes: Number(config.githubSync?.intervalMinutes || 60),
                clientId: config.githubSync?.clientId || config.agent?.clientId || 'antigravity-client',
                githubSnapshotUrl: config.githubSync?.snapshotUrl || config.agent?.githubSnapshotUrl || ''
            },
            githubSync: {
                ...syncStatus,
                enabled: Boolean(config.githubSync?.enabled ?? true),
                pushEnabled: Boolean(config.githubSync?.pushEnabled ?? true),
                intervalMinutes: Number(config.githubSync?.intervalMinutes || 60),
                cooldownMinutes: Number(config.githubSync?.cooldownMinutes ?? 30),
                clientId: config.githubSync?.clientId || config.agent?.clientId || 'antigravity-client',
                snapshotUrl: config.githubSync?.snapshotUrl || syncStatus.snapshotUrl || '',
                branch: config.githubSync?.branch || syncStatus.branch || 'ag-snapshot',
                lastPublishedBy,
                lastSyncAt: syncStatus.lastSyncedAt || syncStatus.lastSyncCheckAt || null
            },
            schedule: scheduleStatus
        };
    };

    router.get('/config', (req, res) => {
        res.json({
            success: true,
            config: buildConfigPayload()
        });
    });

    router.post('/config', (req, res) => {
        try {
            const updates = req.body || {};
            config.saveDynamicSettings(updates);
            if (
                scheduleManager &&
                (updates.AUTO_UPDATE_ENABLED !== undefined ||
                    updates.autoUpdateEnabled !== undefined ||
                    updates.scheduleEnabled !== undefined ||
                    updates.UPDATE_TIMES !== undefined ||
                    updates.updateTimes !== undefined ||
                    updates.scheduleTimes !== undefined ||
                    updates.GITHUB_SYNC_INTERVAL_MINUTES !== undefined ||
                    updates.githubSyncIntervalMinutes !== undefined ||
                    updates.GITHUB_SYNC_ENABLED !== undefined ||
                    updates.githubSyncEnabled !== undefined)
            ) {
                scheduleManager.restart();
            }
            res.json({
                success: true,
                message: '系统配置已保存并生效',
                config: buildConfigPayload()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '保存配置失败: ' + error.message
            });
        }
    });

    const handleScheduleStatus = (req, res) => {
        const status = scheduleManager ? scheduleManager.getStatus() : {
            isRunning: false,
            enabled: config.news.autoUpdateEnabled,
            updateTimes: config.news.updateTimes,
            scheduleTimes: config.news.scheduleTimes || config.news.updateTimes,
            timezone: config.news.timezone || 'Asia/Shanghai',
            tasksCount: 0,
            nextExecution: '未设置'
        };
        res.json({
            success: true,
            ...status,
            schedule: status
        });
    };

    router.get('/schedule/config', handleScheduleStatus);
    router.get('/schedule/status', handleScheduleStatus);

    router.post('/schedule/config', (req, res) => {
        try {
            const body = req.body || {};
            const rawTimes = body.updateTimes !== undefined ? body.updateTimes : body.scheduleTimes;
            const timesStr = Array.isArray(rawTimes)
                ? rawTimes.join(',')
                : String(rawTimes || '08:00,12:30,19:30');
            const enabled = body.enabled !== undefined ? Boolean(body.enabled) : true;

            config.saveDynamicSettings({
                AUTO_UPDATE_ENABLED: enabled,
                UPDATE_TIMES: timesStr
            });

            if (scheduleManager) {
                scheduleManager.restart();
            }

            const status = scheduleManager ? scheduleManager.getStatus() : {
                isRunning: false,
                enabled: config.news.autoUpdateEnabled,
                updateTimes: config.news.updateTimes,
                scheduleTimes: config.news.scheduleTimes || config.news.updateTimes,
                timezone: config.news.timezone || 'Asia/Shanghai'
            };

            res.json({
                success: true,
                message: '定时巡检配置已更新',
                ...status,
                schedule: status
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '更新定时配置失败: ' + error.message
            });
        }
    });

    // ==================== 4. 第三方聚合数据接口 (/api/latest-data) ====================

    router.get('/latest-data', (req, res) => {
        try {
            const currentNewsData = stateManager.get('newsData') || newsService.getNewsData() || [];
            const currentLastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();
            const currentSummary = stateManager.get('summaryArticle');

            const responseData = {
                meta: {
                    timestamp: new Date().toISOString(),
                    version: '2.0.0',
                    engine: 'CoreFeed Global News Collector',
                    serverTime: new Date().toISOString()
                },
                news: {
                    count: currentNewsData.length,
                    lastUpdated: currentLastUpdated,
                    items: currentNewsData.map(item => ({
                        id: item.id || item.url,
                        title: item.translatedTitle || item.title,
                        originalTitle: item.title,
                        description: item.summary || item.description,
                        summary: item.summary || item.description,
                        region: item.region || '国际',
                        category: item.category || '国际',
                        source: item.source?.name,
                        relatedSources: item.relatedSources || [],
                        sourceCount: item.sourceCount || 1,
                        aiCompiled: Boolean(item.aiCompiled),
                        publishedAt: item.publishedAt,
                        url: item.url,
                        urlToImage: item.urlToImage || null
                    }))
                },
                summary: currentSummary ? {
                    available: true,
                    title: currentSummary.title,
                    generatedAt: currentSummary.generatedAt,
                    content: currentSummary.htmlContent,
                    wordCount: currentSummary.wordCount,
                    regions: currentSummary.regions
                } : { available: false }
            };

            res.json({
                success: true,
                data: responseData
            });
        } catch (error) {
            logger.error('API', '获取第三方聚合数据失败', error.message);
            res.status(500).json({
                success: false,
                message: '获取数据失败: ' + error.message
            });
        }
    });

    // ==================== 5. AI 助手精编直读与智能音箱口播接口 (/api/ai/*) ====================

    const resolveCurrentNewsAndSummary = async () => {
        const allEnhanced = stateManager.get('allEnhancedNews');
        const displayed = stateManager.get('newsData') || newsService.getNewsData() || [];
        const newsList = Array.isArray(allEnhanced) && allEnhanced.length >= displayed.length && displayed.length === 0
            ? allEnhanced
            : displayed;
        const lastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();
        const lastPublishedBy =
            stateManager.get('lastPublishedBy') ||
            (githubSyncManager ? githubSyncManager.getStatus().publishedBy : null) ||
            null;

        let summaryArticle = stateManager.get('summaryArticle');
        if (!summaryArticle) {
            try {
                const loaded = await readJsonFile(config.storage.summaryFile);
                if (loaded && loaded.article) {
                    summaryArticle = loaded.article;
                    stateManager.set('summaryArticle', summaryArticle, false);
                }
            } catch (_) {
                // ignore missing summary file
            }
        }
        return { newsList, summaryArticle, lastUpdated, lastPublishedBy };
    };

    const handleAiBriefing = async (req, res, forcedQuery = {}) => {
        try {
            const { newsList, summaryArticle, lastUpdated, lastPublishedBy } = await resolveCurrentNewsAndSummary();
            const mergedQuery = { ...(req.query || {}), ...forcedQuery };
            const briefing = buildAiBriefing({
                newsList,
                summaryArticle,
                lastUpdated,
                lastPublishedBy,
                query: mergedQuery
            });

            if (mergedQuery.mode === 'article' && briefing.items.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: '未找到指定序号或 ID 的精编报道'
                });
            }

            const format = String(mergedQuery.format || 'json').toLowerCase().trim();
            if (format === 'markdown' || format === 'md') {
                res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
                return res.send(briefing.markdown);
            }
            if (format === 'tts' || format === 'speech') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                return res.send(briefing.tts.fullText + '\n');
            }
            if (format === 'oral' || format === 'short') {
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                return res.send(briefing.tts.shortText + '\n');
            }

            return res.json(briefing);
        } catch (error) {
            logger.error('API', '生成 AI 简报数据失败', error.message);
            return res.status(500).json({
                success: false,
                message: '生成 AI 简报失败: ' + error.message
            });
        }
    };

    router.get('/ai/briefing', (req, res) => handleAiBriefing(req, res));
    router.get('/ai/briefing.md', (req, res) => handleAiBriefing(req, res, { format: 'markdown' }));
    router.get('/ai/article/:ref', (req, res) => {
        const ref = String(req.params.ref || '').trim();
        const isOneBasedIdx = /^\d+$/.test(ref);
        return handleAiBriefing(req, res, {
            mode: 'article',
            detail: 'full',
            ...(isOneBasedIdx ? { index: ref } : { id: ref })
        });
    });

    return router;
}

module.exports = initializeApiRoutes;
