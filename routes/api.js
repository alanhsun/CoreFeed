const express = require('express');
const axios = require('axios');
const https = require('https');
const config = require('../config');
const { writeJsonFile, readJsonFile, isValidUrl, SimpleCache } = require('../utils/helpers');
const logger = require('../utils/logger');
const { getGlobalSourceMatrix, saveGlobalSourceMatrixUpdate } = require('../config/global_sources');

const proxyHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const imageProxyCache = new SimpleCache(150, 2 * 60 * 60 * 1000);

/**
 * 初始化 API 路由 (CoreFeed v2.0 - 专注全球新闻采集、渐进编译与展示)
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
            const auth = verifyPublishSecret(req);
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

            const result = await githubSyncManager.pullAndApply({
                snapshotUrl: req.body?.snapshotUrl || null,
                force: Boolean(req.body?.force),
                trigger: 'api'
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

            const {
                news,
                allEnhancedNews = null,
                summaryArticle: rawSummaryArticle = null,
                summary = null,
                summaryMarkdown = null,
                sourceStats = [],
                lastUpdated = null,
                publishedAt = null
            } = req.body || {};

            const summaryArticle = rawSummaryArticle || summary || null;
            const effectiveLastUpdated = lastUpdated || publishedAt || null;

            if (!Array.isArray(news) || news.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: '推送的 news 数组不能为空'
                });
            }

            const parsedDate = effectiveLastUpdated ? new Date(effectiveLastUpdated) : new Date();
            const timestamp = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
            const nowIso = timestamp.toISOString();

            const normalizeArticle = (item, idx) => {
                const rawTitle = String(item?.title || item?.translatedTitle || `News #${idx + 1}`).trim();
                const zhTitle = String(item?.translatedTitle || rawTitle).trim();
                const rawDesc = String(item?.description || item?.summary || item?.translatedDescription || item?.content || rawTitle).trim();
                const zhSummary = String(item?.summary || item?.translatedDescription || rawDesc).trim();
                const sourceObj = (item?.source && typeof item.source === 'object')
                    ? { ...item.source, name: String(item.source.name || 'Global Media').trim() }
                    : { id: 'external', name: String(item?.source || item?.sourceName || 'Global Media').trim(), strategy: 'agent_publish' };
                const relatedSources = Array.isArray(item?.relatedSources) ? item.relatedSources : [];
                const keyPoints = Array.isArray(item?.keyPoints) ? item.keyPoints.filter(Boolean).map(String) : [];
                const region = item?.region || aiService.determineNewsRegionSync(`${rawTitle} ${zhTitle}`, `${rawDesc} ${zhSummary}`, sourceObj.name, '国际');
                const category = item?.category || aiService.determineNewsCategorySync(`${rawTitle} ${zhTitle}`, `${rawDesc} ${zhSummary}`, sourceObj.category || '', '国际');

                return {
                    ...item,
                    id: item?.id || `ag-${Date.now()}-${idx + 1}`,
                    title: rawTitle,
                    translatedTitle: zhTitle,
                    description: rawDesc,
                    translatedDescription: zhSummary,
                    summary: zhSummary,
                    content: String(item?.content || item?.fullTextContent || rawDesc).trim(),
                    fullTextContent: item?.fullTextContent || null,
                    url: item?.url || '',
                    urlToImage: item?.urlToImage || null,
                    publishedAt: item?.publishedAt || nowIso,
                    processedAt: item?.processedAt || nowIso,
                    region,
                    category,
                    keyPoints,
                    aiCompiled: item?.aiCompiled !== undefined ? Boolean(item.aiCompiled) : true,
                    qualityScore: Number(item?.qualityScore) || 88,
                    source: sourceObj,
                    relatedSources,
                    sourceCount: Number(item?.sourceCount) || (1 + relatedSources.length)
                };
            };

            const normalizedNews = news.filter(Boolean).map((item, idx) => normalizeArticle(item, idx));
            if (normalizedNews.length === 0) {
                return res.status(400).json({
                    success: false,
                    message: '推送的 news 数组不包含有效新闻对象'
                });
            }

            const normalizedFullPool = Array.isArray(allEnhancedNews) && allEnhancedNews.length > 0
                ? allEnhancedNews.filter(Boolean).map((item, idx) => normalizeArticle(item, idx))
                : normalizedNews;
            const normalizedStats = Array.isArray(sourceStats) ? sourceStats : [];

            // 1. 同步更新 NewsService、StateManager、写入 data/news.json 并广播 news-updated
            newsAgentService.lastSourceStats = normalizedStats;
            await newsAgentService._publishNewsSnapshot(
                normalizedNews,
                normalizedFullPool,
                normalizedStats,
                timestamp,
                'completed'
            );
            stateManager.set('lastUpdated', nowIso, false);

            // 2. 处理并持久化今日深度综述 (支持完整对象、仅含 content 的对象或 Markdown 字符串)
            let finalSummary = null;
            const currentDate = timestamp.toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                weekday: 'long',
                timeZone: 'Asia/Shanghai'
            });

            const rawMdInput = typeof summaryArticle === 'string'
                ? summaryArticle.trim()
                : (typeof summaryMarkdown === 'string' ? summaryMarkdown.trim() : '');

            if (rawMdInput) {
                const firstLine = rawMdInput.split('\n').map(l => l.trim()).find(Boolean) || '';
                const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
                    ? `${currentDate} 全球要闻深度综述\n\n${rawMdInput}`
                    : rawMdInput;
                finalSummary = aiService.createSummaryArticleObject(mdWithTitle, normalizedNews, currentDate);
            } else if (summaryArticle && typeof summaryArticle === 'object') {
                const rawBody = String(summaryArticle.content || summaryArticle.markdown || '').trim();
                const normalizedBody = rawBody
                    ? rawBody.split('\n').map(l => l.trim()).filter(Boolean).join('\n\n')
                    : '';
                const htmlContent = summaryArticle.htmlContent
                    || (normalizedBody ? aiService.convertSummaryToRichHtml(normalizedBody, normalizedNews) : '');

                if (htmlContent || normalizedBody) {
                    const plainForSummary = normalizedBody.replace(/\[NEWS_\d+\]/g, '').replace(/#+\s*/g, '');
                    finalSummary = {
                        title: summaryArticle.title || `${currentDate} 全球要闻深度综述`,
                        content: normalizedBody || rawBody,
                        htmlContent,
                        newsCount: Number(summaryArticle.newsCount) || normalizedNews.length,
                        regions: Array.isArray(summaryArticle.regions) && summaryArticle.regions.length > 0
                            ? summaryArticle.regions
                            : [...new Set(normalizedNews.map(n => n.region || '国际'))],
                        generatedAt: summaryArticle.generatedAt || nowIso,
                        summary: summaryArticle.summary || plainForSummary.slice(0, 160),
                        wordCount: Number(summaryArticle.wordCount) || (normalizedBody || htmlContent).length
                    };
                }
            }

            if (finalSummary) {
                stateManager.updateSummaryArticle(finalSummary);
                await writeJsonFile(config.storage.summaryFile, {
                    article: finalSummary,
                    savedAt: new Date().toISOString(),
                    version: '2.0'
                });
                if (io) {
                    io.emit('summary-completed', {
                        success: true,
                        article: finalSummary
                    });
                }
            }

            // 3. 立即将内存状态持久化至 data/state.json，防止 5 分钟定时器覆盖
            await stateManager.saveToFile();

            newsAgentService.emitAgentEvent(
                'Antigravity 客户端',
                'completed',
                `已同步发布 ${normalizedNews.length} 条精选新闻${finalSummary ? '及今日全球要闻深度综述' : ''}`,
                { progress: 100, current: normalizedNews.length, total: normalizedFullPool.length }
            );

            res.json({
                success: true,
                message: `成功发布 ${normalizedNews.length} 条全球精选新闻${finalSummary ? '与今日深度综述' : ''}`,
                displayedCount: normalizedNews.length,
                totalPoolCount: normalizedFullPool.length,
                hasSummary: Boolean(finalSummary),
                publishedAt: nowIso,
                lastUpdated: nowIso
            });
        } catch (error) {
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
            if (
                scheduleManager &&
                (updates.AUTO_UPDATE_ENABLED !== undefined ||
                    updates.UPDATE_TIMES !== undefined ||
                    updates.scheduleTimes !== undefined)
            ) {
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
