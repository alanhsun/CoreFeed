const express = require('express');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { writeJsonFile, readJsonFile, formatFileSize } = require('../utils/helpers');
const logger = require('../utils/logger');
const { getGlobalSourceMatrix, saveGlobalSourceMatrixUpdate } = require('../config/global_sources');
const EpubEmailService = require('../services/epub_email_service');

/**
 * 初始化 API 路由 (CoreFeed v2.0 - Agent 驱动版)
 */
function initializeApiRoutes(services, io, stateManager) {
    const router = express.Router();
    const { newsService, aiService, audioService, scheduleManager, newsAgentService } = services;
    const epubEmailService = new EpubEmailService(stateManager);

    // 启动时加载持久化的新闻、摘要与专题报告数据
    (async () => {
        try {
            const summaryData = await readJsonFile(config.storage.summaryFile);
            if (summaryData && summaryData.article) {
                stateManager.set('summaryArticle', summaryData.article);
            }
            const podcastInfo = await audioService.getPodcastInfo();
            if (podcastInfo) {
                stateManager.set('podcastInfo', podcastInfo);
            }
        } catch (err) {
            logger.debug('API', '加载初始缓存数据跳过', err.message);
        }
    })();

    // ==================== 1. Agent 专属接口 (CoreFeed v2.0) ====================

    /**
     * 获取 Agent 引擎状态、实时日志与信源巡检统计
     */
    router.get('/agent/status', async (req, res) => {
        const lastResearch = await newsAgentService.getLastResearchReport();
        res.json({
            success: true,
            isRunningPatrol: newsAgentService.isRunningPatrol,
            isUpdating: stateManager.get('isUpdating'),
            progress: stateManager.get('updateProgress'),
            aiModel: aiService.getCurrentModelInfo(),
            jinaReaderEnabled: config.agent.jinaReaderEnabled,
            sourceStats: stateManager.get('sourceStats') || newsAgentService.getLastSourceStats() || [],
            recentLogs: newsAgentService.getRecentAgentLogs(),
            lastResearchTopic: lastResearch?.topic || null
        });
    });

    /**
     * 触发多 Agent 全球知名信源巡检与整合流水线
     */
    router.post('/agent/patrol', async (req, res) => {
        try {
            if (newsAgentService.isRunningPatrol || stateManager.get('isUpdating')) {
                return res.status(409).json({
                    success: false,
                    message: 'Agent 全球巡检任务正在运行中，请稍候'
                });
            }

            const {
                categoryFilter = 'all',
                maxDisplayCount = config.agent.maxCuratedArticles || 30,
                deepReadCount = config.agent.deepReadTopCount || 8,
                generateSummary = true,
                generatePodcast = false
            } = req.body || {};

            const result = await newsAgentService.runGlobalPatrolPipeline({
                categoryFilter,
                maxDisplayCount: Number(maxDisplayCount),
                deepReadCount: Number(deepReadCount),
                generateSummary: Boolean(generateSummary)
            });

            // 如果同时请求生成播客音频
            let podcastInfo = null;
            if (generatePodcast && result.news && result.news.length > 0) {
                try {
                    const script = await aiService.generatePodcastScript(result.news);
                    await audioService.initializeTTS();
                    podcastInfo = await audioService.generatePodcastAudio(script);
                    stateManager.set('podcastInfo', podcastInfo);
                } catch (podErr) {
                    logger.warn('API', `播客顺带生成失败: ${podErr.message}`);
                }
            }

            res.json({
                ...result,
                podcastInfo
            });
        } catch (error) {
            logger.error('API', 'Agent 巡检执行失败', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    });

    /**
     * 触发按需专题调查 Agent (搜索全球权威外媒 + Jina 全文深读 + 跨信源对比报告)
     */
    router.post('/agent/research', async (req, res) => {
        try {
            const { topic, authoritativeOnly = false, timeRange = '7d', maxArticles = 12 } = req.body || {};
            if (!topic || !String(topic).trim()) {
                return res.status(400).json({
                    success: false,
                    message: '请输入要研究的新闻主题或关键词'
                });
            }

            const report = await newsAgentService.runTopicResearchPipeline(String(topic).trim(), {
                authoritativeOnly: Boolean(authoritativeOnly),
                timeRange,
                maxArticles: Number(maxArticles) || 12
            });

            res.json(report);
        } catch (error) {
            logger.error('API', 'Agent 专题调查失败', error.message);
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    });

    /**
     * 获取最近一次专题调查报告
     */
    router.get('/agent/research/latest', async (req, res) => {
        const report = await newsAgentService.getLastResearchReport();
        res.json({
            success: true,
            report
        });
    });

    /**
     * 单篇外媒报道即时全文深读 (Jina Reader + AI 中文精译解读)
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

    // ==================== 3. 新闻数据与刷新接口 (向后兼容) ====================

    router.get('/news', (req, res) => {
        const newsData = stateManager.get('newsData') || newsService.getNewsData() || [];
        const allEnhanced = stateManager.get('allEnhancedNews') || newsData;
        const lastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();

        const region = req.query.region;
        const category = req.query.category;
        const keyword = (req.query.q || '').trim().toLowerCase();

        let filtered = [...newsData];
        if (region && region !== 'all' && region !== '全部') {
            filtered = filtered.filter(n => n.region === region);
        }
        if (category && category !== 'all' && category !== '全部') {
            filtered = filtered.filter(n => n.category === category);
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
     * 手动刷新新闻（默认直接调用多 Agent 巡检与整合流水线）
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

    // ==================== 4. 深度综述、EPUB 与 Kindle 邮件接口 ====================

    router.get('/summary', async (req, res) => {
        let article = stateManager.get('summaryArticle');
        if (!article) {
            const loaded = await readJsonFile(config.storage.summaryFile);
            if (loaded && loaded.article) {
                article = loaded.article;
                stateManager.set('summaryArticle', article);
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
                    message: '当前没有新闻数据，请先执行 Agent 全球巡检'
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

    router.post('/generate-epub', async (req, res) => {
        try {
            const summaryArticle = stateManager.get('summaryArticle');
            const newsData = stateManager.get('newsData') || [];
            if (!summaryArticle) {
                return res.status(400).json({
                    success: false,
                    message: '请先生成全球新闻深度综述后再导出 EPUB'
                });
            }

            const epubInfo = await epubEmailService.generateEpubFile(summaryArticle, newsData);
            res.json({
                success: true,
                epub: epubInfo,
                downloadUrl: `/api/epub/download/${encodeURIComponent(epubInfo.filename)}`
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '生成 EPUB 失败: ' + error.message
            });
        }
    });

    router.get('/epub/download/:filename', (req, res) => {
        const filename = path.basename(req.params.filename);
        const filePath = path.join(config.storage.epubDir, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: 'EPUB 文件不存在' });
        }
        res.download(filePath, filename);
    });

    router.post('/send-email', async (req, res) => {
        try {
            const { email } = req.body || {};
            const recipientEmail = email || config.smtp.defaultRecipient;
            let summaryArticle = stateManager.get('summaryArticle');
            const newsData = stateManager.get('newsData') || [];

            if (!summaryArticle) {
                if (newsData.length > 0) {
                    summaryArticle = await aiService.generateNewsSummaryArticle(newsData);
                    stateManager.updateSummaryArticle(summaryArticle);
                } else {
                    return res.status(400).json({
                        success: false,
                        message: '没有可发送的综述内容，请先采集并生成综述'
                    });
                }
            }

            const epubInfo = await epubEmailService.generateEpubFile(summaryArticle, newsData);
            const mailResult = await epubEmailService.sendEmailWithEpub(recipientEmail, summaryArticle, epubInfo.path);

            res.json({
                success: true,
                message: `EPUB 简报已发送至 ${mailResult.recipient}`,
                ...mailResult
            });
        } catch (error) {
            logger.error('API', '发送 Kindle 邮件失败', error.message);
            res.status(500).json({
                success: false,
                message: '发送邮件失败: ' + error.message
            });
        }
    });

    // ==================== 5. AI 播客合成与 FTP 上传接口 ====================

    router.post('/generate-podcast', async (req, res) => {
        try {
            const isDemo = req.query.demo === '1' || req.body?.demo === true;
            const newsData = stateManager.get('newsData') || newsService.getNewsData() || [];

            let script = '';
            if (isDemo) {
                script = `[A] 大家好，欢迎收听聚核全球知名信源AI播客测试。\n[B] 本节目由多Agent智能采集路透社、BBC、纽约时报等权威报道并自动合成语音。`;
            } else {
                if (!newsData.length) {
                    return res.status(400).json({
                        success: false,
                        message: '当前没有新闻数据，请先执行 Agent 巡检'
                    });
                }
                script = await aiService.generatePodcastScript(newsData);
            }

            await audioService.initializeTTS();
            const podcastInfo = await audioService.generatePodcastAudio(script);
            stateManager.updatePodcastInfo(podcastInfo);

            res.json({
                success: true,
                podcast: podcastInfo,
                info: podcastInfo
            });
        } catch (error) {
            logger.error('API', '生成播客失败', error.message);
            res.status(500).json({
                success: false,
                message: '生成播客失败: ' + error.message
            });
        }
    });

    router.get('/podcast/info', async (req, res) => {
        let info = stateManager.get('podcastInfo') || await audioService.getPodcastInfo();
        res.json({
            success: true,
            podcast: info || null
        });
    });

    router.get('/podcast/complete', async (req, res) => {
        const filePath = path.join(config.storage.podcastDir, 'podcast_complete.mp3');
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ success: false, message: '播客音频文件尚未生成' });
        }
        res.setHeader('Content-Type', 'audio/mpeg');
        fs.createReadStream(filePath).pipe(res);
    });

    router.get('/ftp/config', (req, res) => {
        res.json({
            success: true,
            config: audioService.getFtpConfig()
        });
    });

    router.post('/ftp/test', async (req, res) => {
        const result = await audioService.testFtpConnection();
        res.json(result);
    });

    // ==================== 6. 系统配置、AI 配置与定时任务接口 ====================

    router.get('/status', async (req, res) => {
        const newsData = stateManager.get('newsData') || [];
        const summaryArticle = stateManager.get('summaryArticle');
        const podcastInfo = stateManager.get('podcastInfo') || await audioService.getPodcastInfo();

        res.json({
            success: true,
            status: 'running',
            version: '2.0.0',
            newsCount: newsData.length,
            lastUpdated: stateManager.get('lastUpdated'),
            hasSummary: Boolean(summaryArticle),
            hasPodcast: Boolean(podcastInfo),
            aiConfigured: Boolean(config.minimax.apiKey),
            aiModel: aiService.getCurrentModelInfo(),
            ttsConfigured: Boolean(config.tts.baseUrl),
            ttsReady: audioService.ttsReady,
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
                tts: {
                    baseUrl: config.tts.baseUrl,
                    hostVoice: config.tts.hostVoice,
                    guestVoice: config.tts.guestVoice
                },
                smtp: {
                    host: config.smtp.host,
                    port: config.smtp.port,
                    user: config.smtp.user,
                    defaultRecipient: config.smtp.defaultRecipient
                },
                ftp: audioService.getFtpConfig(),
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

    // ==================== 7. 第三方聚合数据接口 (/api/latest-data) ====================

    router.get('/latest-data', async (req, res) => {
        try {
            const currentNewsData = stateManager.get('newsData') || newsService.getNewsData() || [];
            const currentLastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();
            const currentSummary = stateManager.get('summaryArticle');
            const currentPodcast = stateManager.get('podcastInfo') || await audioService.getPodcastInfo();

            const responseData = {
                meta: {
                    timestamp: new Date().toISOString(),
                    version: '2.0.0',
                    engine: 'CoreFeed Multi-Agent Intelligence',
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
                } : { available: false },
                podcast: currentPodcast ? {
                    available: true,
                    duration: currentPodcast.duration,
                    size: currentPodcast.sizeFormatted || formatFileSize(currentPodcast.ftp?.fileSize || 0),
                    createdAt: currentPodcast.createdAt,
                    downloadUrl: '/api/podcast/complete'
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
