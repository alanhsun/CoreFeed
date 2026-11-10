/**
 * 聚核 CoreFeed v2.0 — RESTful API 路由控制器 (routes/api.js)
 *
 * 核心路由模块：
 *   0. `/api/image-proxy`        — 外媒新闻题图防盗链与跨境加速代理
 *   1. `/api/agent/*`            — GitHub 快照拉取 (`pull-github`)、外部精编发布 (`publish`) 与同步状态 (`sync-status`)
 *   2. `/api/sources/matrix`     — 全球 37 大知名信源矩阵查询与配置
 *   3. `/api/news`, `/api/summary` — 新闻流多维筛选、增量分页与今日全球要闻深度综述
 *   4. `/api/status`, `/api/config`, `/api/schedule/*` — 系统状态遥测、动态配置持久化与定时同步管理
 */
const express = require('express');
const axios = require('axios');
const https = require('https');
const config = require('../config');
const { writeJsonFile, readJsonFile, isValidUrl, SimpleCache } = require('../utils/helpers');
const logger = require('../utils/logger');
const { getGlobalSourceMatrix, saveGlobalSourceMatrixUpdate } = require('../config/global_sources');
const { applySnapshotToRouter } = require('../utils/github_sync');

const proxyHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const imageProxyCache = new SimpleCache(150, 2 * 60 * 60 * 1000);

/**
 * 初始化 API 路由
 */
function initializeApiRoutes(services, io, stateManager) {
    const router = express.Router();
    const { newsService, aiService, scheduleManager, newsAgentService, githubSyncManager } = services;

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

    // ==================== 1. Agent 状态、GitHub 快照同步与发布接口 ====================

    /**
     * 获取 Agent 引擎状态、实时日志与信源巡检统计
     */
    router.get('/agent/status', (req, res) => {
        res.json({
            success: true,
            isRunningPatrol: newsAgentService.isRunningPatrol,
            isUpdating: stateManager.get('isUpdating'),
            collectionPhase: stateManager.get('collectionPhase') || 'idle',
            progress: stateManager.get('updateProgress'),
            aiModel: aiService.getCurrentModelInfo(),
            jinaReaderEnabled: config.agent.jinaReaderEnabled,
            sourceStats: stateManager.get('sourceStats') || newsAgentService.getLastSourceStats() || [],
            recentLogs: newsAgentService.getRecentAgentLogs(),
            githubSync: githubSyncManager ? githubSyncManager.getStatus() : null
        });
    });

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
     * 触发全球知名信源巡检与编译流水线（单机模式使用）
     */
    router.post('/agent/patrol', async (req, res) => {
        try {
            if (newsAgentService.isRunningPatrol || stateManager.get('isUpdating')) {
                return res.status(409).json({
                    success: false,
                    message: '全球新闻采集任务正在运行中，请稍候'
                });
            }

            const {
                categoryFilter = 'all',
                maxDisplayCount = config.agent.maxCuratedArticles || 30,
                generateSummary = true
            } = req.body || {};

            const result = await newsAgentService.runGlobalPatrolPipeline({
                categoryFilter,
                maxDisplayCount: Number(maxDisplayCount),
                generateSummary: Boolean(generateSummary)
            });

            res.json(result);
        } catch (error) {
            logger.error('API', 'Agent 巡检执行失败', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    });

    /**
     * 点击新闻卡片主体时，实时抓取外媒原文全文并执行分段中文翻译
     */
    router.post('/news/translate-fulltext', async (req, res) => {
        try {
            const { url, title, translatedTitle, sourceName, existingSummary } = req.body || {};
            if (!url) {
                return res.status(400).json({
                    success: false,
                    message: '请提供新闻原文 URL'
                });
            }

            const result = await newsAgentService.translateArticleFullText({
                url,
                title,
                translatedTitle,
                sourceName,
                existingSummary
            });

            res.json(result);
        } catch (error) {
            logger.error('API', '原文全文中文翻译失败', error.message);
            res.status(500).json({
                success: false,
                message: error.message
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
                aiService,
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

    // ==================== 2. 全球知名信源矩阵管理接口 ====================

    router.get('/sources/matrix', (req, res) => {
        const matrix = getGlobalSourceMatrix();
        const stats = stateManager.get('sourceStats') || newsAgentService.getLastSourceStats() || [];
        const statsMap = new Map(stats.map(s => [s.id, s]));

        const enriched = matrix.map(src => ({
            ...src,
            lastStat: statsMap.get(src.id) || null
        }));

        res.json({
            success: true,
            total: enriched.length,
            enabledCount: enriched.filter(s => s.enabled).length,
            sources: enriched
        });
    });

    router.post('/sources/matrix', (req, res) => {
        try {
            const { overrides = {}, customSources = null } = req.body || {};
            const updated = saveGlobalSourceMatrixUpdate({ overrides, customSources });
            res.json({
                success: true,
                message: '全球信源矩阵配置已保存',
                total: updated.length,
                enabledCount: updated.filter(s => s.enabled).length,
                sources: updated
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '保存信源矩阵失败: ' + error.message
            });
        }
    });

    // ==================== 3. 新闻流查询、过滤与分页接口 ====================

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

    /**
     * 手动刷新新闻
     */
    router.post('/refresh', async (req, res) => {
        try {
            if (newsAgentService.isRunningPatrol || stateManager.get('isUpdating')) {
                return res.status(409).json({
                    success: false,
                    message: '正在执行搜集整合任务，请勿重复点击'
                });
            }

            const result = await newsAgentService.runGlobalPatrolPipeline({
                generateSummary: true
            });

            res.json({
                success: true,
                message: `成功搜集并整合 ${result.displayedCount} 条全球权威新闻`,
                count: result.displayedCount,
                total: result.totalEnhancedCount,
                news: result.news,
                summaryArticle: result.summaryArticle,
                sourceStats: result.sourceStats,
                lastUpdated: result.lastUpdated
            });
        } catch (error) {
            logger.error('API', '刷新新闻失败', error.message);
            res.status(500).json({
                success: false,
                message: '刷新新闻失败: ' + error.message
            });
        }
    });

    // ==================== 4. 今日要闻深度综述接口 ====================

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

    router.post('/generate-summary', async (req, res) => {
        try {
            const newsData = stateManager.get('newsData') || newsService.getNewsData() || [];
            if (!newsData.length) {
                return res.status(400).json({
                    success: false,
                    message: '当前没有新闻数据，请先执行全球新闻采集'
                });
            }

            const summaryArticle = await aiService.generateNewsSummaryArticle(newsData);
            stateManager.updateSummaryArticle(summaryArticle);

            await writeJsonFile(config.storage.summaryFile, {
                article: summaryArticle,
                savedAt: new Date().toISOString(),
                version: '2.0'
            });

            res.json({
                success: true,
                article: summaryArticle
            });
        } catch (error) {
            logger.error('API', '生成深度综述失败', error.message);
            res.status(500).json({
                success: false,
                message: '生成综述失败: ' + error.message
            });
        }
    });

    // ==================== 5. 系统配置、AI 配置与定时调度接口 ====================

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
            aiConfigured: Boolean(config.minimax.apiKey),
            aiModel: aiService.getCurrentModelInfo(),
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
            ai: {
                baseUrl: config.minimax.baseUrl,
                model: config.minimax.model,
                apiKeyConfigured: Boolean(config.minimax.apiKey),
                rateLimitRpm: config.minimax.rateLimitRpm
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
            aiService.refreshConfig();
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

    // ==================== 6. 第三方聚合数据接口 (/api/latest-data) ====================

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
                        url: item.url
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

    router.get('/health', (req, res) => {
        res.json({
            success: true,
            status: 'ok',
            version: '2.0.0',
            timestamp: new Date().toISOString()
        });
    });

    return router;
}

module.exports = initializeApiRoutes;
