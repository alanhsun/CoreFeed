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
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');
const logger = require('../utils/logger');
const { applySnapshotToRouter } = require('../utils/github_sync');
const { buildAiBriefing } = require('../utils/briefing_formatter');
const { renderSafeSummaryHtml } = require('../utils/editorial_formatter');
const asyncHandler = require('../utils/async_handler');
const {
    verifyPublishSecret,
    checkSameOrigin,
    sameOriginOnly,
    requirePublishSecret
} = require('../middleware/auth');
const { createImageProxyHandler } = require('./image_proxy');
const { SocialPulseService, normalizeSocialPulseBundle } = require('../services/social_pulse_service');
const {
    VALID_TRACK_KEYS,
    AudioBroadcastService
} = require('../services/audio_broadcast_service');

/**
 * 初始化 API 路由
 */
function initializeApiRoutes(services, io, stateManager) {
    const router = express.Router();
    const { newsService, scheduleManager, newsAgentService, githubSyncManager, socialPulseService, audioBroadcastService } = services;
    const pulseService = socialPulseService || new SocialPulseService(io, stateManager);
    const audioService = audioBroadcastService || new AudioBroadcastService(io, stateManager);

    // 启动时加载持久化的今日综述与欧美社媒热议数据
    (async () => {
        try {
            const summaryData = await readJsonFile(config.storage.summaryFile);
            if (summaryData && summaryData.article) {
                stateManager.set('summaryArticle', summaryData.article, false);
            }
        } catch (err) {
            logger.debug('API', '加载初始综述缓存跳过', err.message);
        }
        try {
            if (!stateManager.get('socialPulse')) {
                const loadedPulse = await pulseService.loadLocalBundle();
                if (loadedPulse) {
                    stateManager.set('socialPulse', loadedPulse, false);
                    stateManager.set('lastSocialPulseUpdatedAt', loadedPulse.updatedAt || null, false);
                }
            }
        } catch (err) {
            logger.debug('API', '加载初始社媒热议缓存跳过', err.message);
        }
        try {
            if (!stateManager.get('audioBroadcast')) {
                const loadedAudio = await audioService.loadLocalBundle();
                if (loadedAudio) {
                    stateManager.set('audioBroadcast', loadedAudio, false);
                    stateManager.set('lastAudioBroadcastUpdatedAt', loadedAudio.updatedAt || null, false);
                }
            }
        } catch (err) {
            logger.debug('API', '加载初始语音播报缓存跳过', err.message);
        }
    })();

    // ==================== 0. 外媒新闻题图防盗链与跨境加速代理 ====================
    router.get('/image-proxy', createImageProxyHandler());

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
    router.post('/agent/pull-github', asyncHandler(async (req, res) => {
        try {
            const secretAuth = verifyPublishSecret(req);
            const sameOrigin = checkSameOrigin(req);
            const hasExplicitSnapshotUrl = Boolean(req.body?.snapshotUrl);
            const isWebUiHeader = req.get('x-requested-with') === 'CoreFeed-WebUI';
            const isWebUiDefaultPull = !hasExplicitSnapshotUrl && isWebUiHeader && sameOrigin.ok;

            if (!sameOrigin.ok && !(secretAuth.configured && secretAuth.authorized)) {
                return res.status(403).json({
                    success: false,
                    message: '跨站请求被拒绝 (Cross-Origin CSRF Blocked)'
                });
            }

            const auth = isWebUiDefaultPull ? { authorized: true } : secretAuth;
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
            const awaitAudioSync = req.body?.awaitAudioSync !== undefined
                ? Boolean(req.body.awaitAudioSync)
                : !isWebUiDefaultPull;
            const result = await githubSyncManager.pullAndApply({
                snapshotUrl: req.body?.snapshotUrl || null,
                force: forcePull,
                trigger: req.body?.trigger || (isWebUiDefaultPull ? 'ui' : 'api'),
                awaitAudioSync
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
    }));

    /**
     * 接收由外部 Agent (如 Antigravity 客户端) 采集、聚类并精编完成的全球新闻与综述数据包
     */
    router.post('/agent/publish', requirePublishSecret, asyncHandler(async (req, res) => {
        try {
            const applied = await applySnapshotToRouter(req.body || {}, {
                stateManager,
                newsAgentService,
                newsService,
                audioBroadcastService: audioService,
                io,
                sourceLabel: 'Antigravity 客户端',
                syncAudioFiles: false
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
    }));

    /**
     * 接收由外部 Agent 单独同步的欧美社媒热议 (Western Social Pulse) 精编数据包
     */
    router.post('/agent/publish-pulse', requirePublishSecret, asyncHandler(async (req, res) => {
        try {
            const rawInput = req.body?.socialPulse || req.body;
            const normalized = normalizeSocialPulseBundle(rawInput);
            if (!normalized) {
                return res.status(400).json({
                    success: false,
                    message: '无效的 socialPulse 数据包（缺少有效议题簇或期次字段）'
                });
            }

            if (config.storage?.socialPulseFile) {
                await writeJsonFile(config.storage.socialPulseFile, normalized);
            }
            if (typeof stateManager.updateSocialPulse === 'function') {
                stateManager.updateSocialPulse(normalized);
            } else {
                stateManager.set('socialPulse', normalized);
            }
            await stateManager.saveToFile();

            res.json({
                success: true,
                issueCount: normalized.issueCount,
                latestKey: normalized.latestKey,
                updatedAt: normalized.updatedAt,
                message: `成功同步 ${normalized.issueCount} 期欧美社媒热议`
            });
        } catch (error) {
            logger.error('API', '接收欧美社媒热议数据失败', error.message);
            res.status(500).json({
                success: false,
                message: '同步社媒热议失败: ' + error.message
            });
        }
    }));

    /**
     * 接收由外部 Agent 实时热推的双主播语音播报元数据与二进制音频 (POST /api/agent/publish-audio)
     */
    router.post('/agent/publish-audio', requirePublishSecret, asyncHandler(async (req, res) => {
        try {
            const body = req.body || {};
            let updatedBundle = null;

            if (body.track && body.trackMeta) {
                const cleanKey = String(body.track).replace(/\.mp3$/i, '').trim().toLowerCase();
                if (!VALID_TRACK_KEYS.includes(cleanKey)) {
                    return res.status(400).json({
                        success: false,
                        message: `不支持的语音播报音轨标识: ${body.track}`
                    });
                }
                const audioBuf = (typeof body.audioBase64 === 'string' && body.audioBase64.trim())
                    ? Buffer.from(body.audioBase64.trim(), 'base64')
                    : null;
                updatedBundle = await audioService.mergeTrack(cleanKey, body.trackMeta, audioBuf, { emit: true });
            } else if (body.audioBroadcast) {
                const filesMap = (body.files && typeof body.files === 'object') ? body.files : {};
                for (const [k, b64] of Object.entries(filesMap)) {
                    const cleanKey = String(k).replace(/\.mp3$/i, '').trim().toLowerCase();
                    if (VALID_TRACK_KEYS.includes(cleanKey) && typeof b64 === 'string' && b64.trim()) {
                        const targetPath = audioService.getTrackAudioPath(cleanKey);
                        if (targetPath) {
                            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                            const buf = Buffer.from(b64.trim(), 'base64');
                            const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
                            fs.writeFileSync(tmpPath, buf);
                            fs.renameSync(tmpPath, targetPath);
                        }
                    }
                }
                updatedBundle = await audioService.saveBundle(body.audioBroadcast, { emit: true });
            }

            if (!updatedBundle) {
                return res.status(400).json({
                    success: false,
                    message: '无效的语音播报数据包（缺少有效 trackMeta 或 audioBroadcast）'
                });
            }

            await stateManager.saveToFile();
            res.json({
                success: true,
                trackCount: updatedBundle.trackCount,
                updatedAt: updatedBundle.updatedAt,
                tracks: Object.keys(updatedBundle.tracks),
                audioBroadcast: updatedBundle,
                message: `成功同步双主播语音播报 (${Object.keys(updatedBundle.tracks).join(', ')})`
            });
        } catch (error) {
            logger.error('API', '接收语音播报数据失败', error.message);
            res.status(500).json({
                success: false,
                message: '同步语音播报失败: ' + error.message
            });
        }
    }));

    // ==================== 2. 新闻流查询、过滤、分页与今日综述接口 ====================

    router.get('/news', (req, res) => {
        const newsData = stateManager.get('newsData') || newsService.getNewsData() || [];
        const allEnhanced = stateManager.get('allEnhancedNews') || newsData;
        const lastUpdated = stateManager.get('lastUpdated') || newsService.getLastUpdated();
        const collectionPhase = stateManager.get('collectionPhase') || 'idle';

        const region = typeof req.query.region === 'string' ? req.query.region : '';
        const category = typeof req.query.category === 'string' ? req.query.category : '';
        const source = typeof req.query.source === 'string' ? req.query.source : '';
        const keyword = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';

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
        const rawOffset = parseInt(req.query.offset, 10);
        const rawLimit = parseInt(req.query.limit, 10);
        const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 30;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 50) : 15;
        const allEnhanced = stateManager.get('allEnhancedNews') || stateManager.get('newsData') || [];

        const moreNews = allEnhanced.slice(offset, offset + limit);

        res.json({
            success: true,
            news: moreNews,
            hasMore: offset + moreNews.length < allEnhanced.length,
            total: allEnhanced.length,
            nextOffset: offset + moreNews.length
        });
    });

    router.get('/summary', asyncHandler(async (req, res) => {
        let article = stateManager.get('summaryArticle');
        if (!article) {
            const loaded = await readJsonFile(config.storage.summaryFile);
            if (loaded && loaded.article) {
                article = loaded.article;
                stateManager.set('summaryArticle', article, false);
            }
        }
        const newsList = stateManager.get('newsData') || newsService.getNewsData() || [];
        const safeArticle = article
            ? {
                ...article,
                htmlContent: renderSafeSummaryHtml(article, newsList)
            }
            : null;
        res.json({
            success: true,
            article: safeArticle
        });
    }));

    /**
     * 获取欧美社媒热议数据包（支持可选 ?key=daily:YYYY-MM-DD 查询指定期次）
     */
    router.get('/pulse', asyncHandler(async (req, res) => {
        let pulse = stateManager.get('socialPulse');
        if (!pulse && config.storage?.socialPulseFile) {
            const loaded = await readJsonFile(config.storage.socialPulseFile, null);
            pulse = normalizeSocialPulseBundle(loaded);
            if (pulse) {
                stateManager.set('socialPulse', pulse, false);
            }
        }
        const requestedKey = typeof req.query.key === 'string' ? req.query.key.trim() : '';
        let selectedIssue = null;
        if (pulse && Array.isArray(pulse.issues) && pulse.issues.length > 0) {
            selectedIssue = (requestedKey && pulse.issues.find(it => it.key === requestedKey)) ||
                pulse.issues.find(it => it.key === pulse.latestKey) ||
                pulse.issues[0];
        }
        res.json({
            success: true,
            available: Boolean(pulse && pulse.issues?.length),
            socialPulse: pulse || null,
            selectedIssue
        });
    }));

    /**
     * 获取双主播语音播报元数据与章节清单 (GET /api/audio)
     */
    router.get('/audio', asyncHandler(async (req, res) => {
        let bundle = stateManager.get('audioBroadcast');
        if (!bundle) {
            bundle = await audioService.loadLocalBundle();
            if (bundle) {
                stateManager.set('audioBroadcast', bundle, false);
                stateManager.set('lastAudioBroadcastUpdatedAt', bundle.updatedAt || null, false);
            }
        }
        res.json({
            success: true,
            available: Boolean(bundle && bundle.trackCount > 0),
            audioBroadcast: bundle || null
        });
    }));

    /**
     * 流式提供双主播播报 MP3 音频，原生支持 HTTP Range (206 Partial Content) 进度条拖拽
     * 支持 /api/audio/news(.mp3) 与 /api/audio/pulse(.mp3)
     */
    router.get('/audio/:track', asyncHandler(async (req, res, next) => {
        try {
            const rawParam = String(req.params.track || '').trim().toLowerCase();
            const cleanKey = rawParam.replace(/\.mp3$/i, '');
            if (!VALID_TRACK_KEYS.includes(cleanKey)) {
                return res.status(404).json({
                    success: false,
                    message: '不存在的语音播报音轨'
                });
            }

            let bundle = stateManager.get('audioBroadcast');
            if (!bundle) {
                bundle = await audioService.loadLocalBundle();
                if (bundle) {
                    stateManager.set('audioBroadcast', bundle, false);
                }
            }

            const localAudioPath = await audioService.ensureLocalAudioFile(cleanKey, { bundle });
            if (!localAudioPath || !fs.existsSync(localAudioPath)) {
                return res.status(404).json({
                    success: false,
                    message: '当前音轨音频尚未生成或同步'
                });
            }

            return res.sendFile(path.resolve(localAudioPath), {
                acceptRanges: true,
                cacheControl: true,
                maxAge: '24h',
                headers: {
                    'Content-Type': 'audio/mpeg'
                }
            }, (sendErr) => {
                if (sendErr && !res.headersSent) {
                    next(sendErr);
                }
            });
        } catch (error) {
            logger.error('API', '读取语音播报音频流失败', error.message);
            if (!res.headersSent) {
                res.status(500).json({
                    success: false,
                    message: '读取音频流失败: ' + error.message
                });
            }
        }
    }));

    // ==================== 3. 系统状态、动态配置与定时调度接口 ====================

    router.get('/status', (req, res) => {
        const newsData = stateManager.get('newsData') || [];
        const summaryArticle = stateManager.get('summaryArticle');
        const socialPulse = stateManager.get('socialPulse');
        const audioBroadcast = stateManager.get('audioBroadcast');

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
            hasSocialPulse: Boolean(socialPulse && socialPulse.issueCount > 0),
            socialPulseCount: socialPulse?.issueCount || 0,
            socialPulseLatestKey: socialPulse?.latestKey || null,
            socialPulseUpdatedAt: socialPulse?.updatedAt || null,
            hasAudioBroadcast: Boolean(audioBroadcast && audioBroadcast.trackCount > 0),
            audioTrackCount: audioBroadcast?.trackCount || 0,
            audioUpdatedAt: audioBroadcast?.updatedAt || null,
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

    router.post('/config', sameOriginOnly, (req, res) => {
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
            res.status(error.statusCode || 500).json({
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

    router.post('/schedule/config', sameOriginOnly, (req, res) => {
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
            res.status(error.statusCode || 500).json({
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
            const currentPulse = stateManager.get('socialPulse');
            const currentAudio = stateManager.get('audioBroadcast');

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
                    content: renderSafeSummaryHtml(currentSummary, currentNewsData),
                    wordCount: currentSummary.wordCount,
                    regions: currentSummary.regions
                } : { available: false },
                socialPulse: currentPulse ? {
                    available: true,
                    updatedAt: currentPulse.updatedAt,
                    latestKey: currentPulse.latestKey,
                    issueCount: currentPulse.issueCount
                } : { available: false },
                audioBroadcast: currentAudio ? {
                    available: true,
                    updatedAt: currentAudio.updatedAt,
                    trackCount: currentAudio.trackCount,
                    tracks: Object.keys(currentAudio.tracks || {})
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

    router.get('/ai/briefing', asyncHandler((req, res) => handleAiBriefing(req, res)));
    router.get('/ai/briefing.md', asyncHandler((req, res) => handleAiBriefing(req, res, { format: 'markdown' })));
    router.get('/ai/article/:ref', asyncHandler((req, res) => {
        const ref = String(req.params.ref || '').trim();
        const isOneBasedIdx = /^\d+$/.test(ref);
        return handleAiBriefing(req, res, {
            mode: 'article',
            detail: 'full',
            ...(isOneBasedIdx ? { index: ref } : { id: ref })
        });
    }));

    const HERMES_SKILL_FILES = {
        'install.sh': path.join(__dirname, '..', 'integrations', 'hermes-skill', 'install.sh'),
        'install.ps1': path.join(__dirname, '..', 'integrations', 'hermes-skill', 'install.ps1'),
        'SKILL.md': path.join(__dirname, '..', 'integrations', 'hermes-skill', 'corefeed-news', 'SKILL.md'),
        'corefeed_cli.py': path.join(__dirname, '..', 'integrations', 'hermes-skill', 'corefeed-news', 'scripts', 'corefeed_cli.py')
    };

    router.get('/ai/hermes-skill/:file', (req, res) => {
        const targetPath = HERMES_SKILL_FILES[req.params.file];
        if (!targetPath || !fs.existsSync(targetPath)) {
            return res.status(404).json({ success: false, message: '未找到请求的 Hermes 技能文件' });
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.send(fs.readFileSync(targetPath, 'utf8'));
    });

    return router;
}

module.exports = initializeApiRoutes;
