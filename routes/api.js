const express = require('express');
const config = require('../config');
const { writeJsonFile, readJsonFile } = require('../utils/helpers');
const logger = require('../utils/logger');
const { getGlobalSourceMatrix, saveGlobalSourceMatrixUpdate } = require('../config/global_sources');

/**
 * 初始化 API 路由 (CoreFeed v2.0 - 专注全球新闻采集、渐进编译与展示)
 */
function initializeApiRoutes(services, io, stateManager) {
    const router = express.Router();
    const { newsService, aiService, scheduleManager, newsAgentService } = services;

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

    // ==================== 1. Agent 采集与深读接口 ====================

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
            recentLogs: newsAgentService.getRecentAgentLogs()
        });
    });

    /**
     * 触发两阶段渐进式全球知名信源巡检与编译流水线
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
                deepReadCount = config.agent.deepReadTopCount || 8,
                generateSummary = true
            } = req.body || {};

            const result = await newsAgentService.runGlobalPatrolPipeline({
                categoryFilter,
                maxDisplayCount: Number(maxDisplayCount),
                deepReadCount: Number(deepReadCount),
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
     * 单篇外媒报道即时全文深读 (Jina Reader + Cheerio + AI 中文精译解读)
     */
    router.post('/agent/deep-read', async (req, res) => {
        try {
            const { url, title, sourceName, existingSummary } = req.body || {};
            if (!url) {
                return res.status(400).json({
                    success: false,
                    message: '请提供新闻原文 URL'
                });
            }

            const result = await newsAgentService.deepReadSingleArticle({
                url,
                title,
                sourceName,
                existingSummary
            });

            res.json(result);
        } catch (error) {
            logger.error('API', '单篇全文深读失败', error.message);
            res.status(500).json({
                success: false,
                message: error.message
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
            lastUpdated
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
            collectionPhase: stateManager.get('collectionPhase') || 'idle',
            hasSummary: Boolean(summaryArticle),
            aiConfigured: Boolean(config.minimax.apiKey),
            aiModel: aiService.getCurrentModelInfo(),
            schedule: scheduleManager ? scheduleManager.getStatus() : null
        });
    });

    router.get('/config', (req, res) => {
        res.json({
            success: true,
            config: {
                agent: {
                    jinaReaderEnabled: config.agent.jinaReaderEnabled,
                    maxCuratedArticles: config.agent.maxCuratedArticles,
                    deepReadTopCount: config.agent.deepReadTopCount,
                    freshnessHours: config.agent.freshnessHours
                },
                ai: {
                    baseUrl: config.minimax.baseUrl,
                    model: config.minimax.model,
                    apiKeyConfigured: Boolean(config.minimax.apiKey),
                    rateLimitRpm: config.minimax.rateLimitRpm
                },
                schedule: scheduleManager ? scheduleManager.getStatus() : {}
            }
        });
    });

    router.post('/config', (req, res) => {
        try {
            const updates = req.body || {};
            config.saveDynamicSettings(updates);
            aiService.refreshConfig();
            if (scheduleManager && (updates.AUTO_UPDATE_ENABLED !== undefined || updates.UPDATE_TIMES !== undefined)) {
                scheduleManager.restart();
            }
            res.json({
                success: true,
                message: '系统配置已保存并生效'
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '保存配置失败: ' + error.message
            });
        }
    });

    router.get('/ai/config', (req, res) => {
        res.json({
            success: true,
            aiConfig: {
                apiKey: config.minimax.apiKey ? '***' + config.minimax.apiKey.slice(-4) : '',
                hasApiKey: Boolean(config.minimax.apiKey),
                baseUrl: config.minimax.baseUrl || 'https://api.minimaxi.com/v1',
                model: config.minimax.model || 'MiniMax-M2.5',
                rateLimitRpm: config.minimax.rateLimitRpm || 30,
                rateLimitBurst: config.minimax.rateLimitBurst || 5
            }
        });
    });

    router.post('/ai/config', (req, res) => {
        try {
            const { apiKey, baseUrl, model, rateLimitRpm, rateLimitBurst } = req.body || {};
            const updates = {};
            if (apiKey && !apiKey.startsWith('***')) updates.AI_API_KEY = apiKey.trim();
            if (baseUrl) updates.AI_BASE_URL = baseUrl.trim();
            if (model) updates.AI_MODEL = model.trim();
            if (rateLimitRpm !== undefined) updates.AI_RATE_LIMIT_RPM = Number(rateLimitRpm);
            if (rateLimitBurst !== undefined) updates.AI_RATE_LIMIT_BURST = Number(rateLimitBurst);

            config.saveDynamicSettings(updates);
            aiService.refreshConfig();

            res.json({
                success: true,
                message: 'AI 模型配置已保存并热重载',
                modelInfo: aiService.getCurrentModelInfo()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '保存 AI 配置失败: ' + error.message
            });
        }
    });

    router.get('/schedule/config', (req, res) => {
        res.json({
            success: true,
            schedule: scheduleManager ? scheduleManager.getStatus() : {
                enabled: config.news.autoUpdateEnabled,
                updateTimes: config.news.updateTimes
            }
        });
    });

    router.post('/schedule/config', (req, res) => {
        try {
            const { enabled, updateTimes } = req.body || {};
            const timesStr = Array.isArray(updateTimes) ? updateTimes.join(',') : String(updateTimes || '06:00,16:30');

            config.saveDynamicSettings({
                AUTO_UPDATE_ENABLED: Boolean(enabled),
                UPDATE_TIMES: timesStr
            });

            if (scheduleManager) {
                scheduleManager.restart();
            }

            res.json({
                success: true,
                message: '定时巡检配置已更新',
                schedule: scheduleManager ? scheduleManager.getStatus() : null
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
