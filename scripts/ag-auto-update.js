#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Antigravity 全自动四阶段采编发闭环编排脚本 (ag-auto-update.js)
 *
 * 功能说明：
 *   专为每天早 (07:40)、中 (12:10)、晚 (19:10) 三次定时自动更新（提前软路由 08:00/12:30/19:30 拉取时间 20 分钟预采编）及一键 CLI 触发设计的端到端编排器：
 *   - Stage 1 (Harvest) : 调用 `ag-harvest.js` 并发采集全球 37 大权威信源并提取正文与配图；
 *   - Stage 2 (Compile) : 自动执行 AI 跨源语义去重、中文精编、核心要点生成与《全球要闻深度综述》撰写（无密钥时无缝降级至免密钥高速中文编译兜底）；
 *   - Stage 3 (Publish) : 调用 `ag-publish.js` 将编译产物推送至 GitHub `origin/ag-snapshot` (`latest.json`) 及 `POST /api/agent/publish` 落盘并触发全站广播；
 *   - Stage 4 (Verify)  : 校验目标站点 `/api/health` 与 `/api/news` 在线健康状态，确保闭环更新成功。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const cron = require('node-cron');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');
const AIService = require('../services/ai_service');
const stateManager = require('../services/state_manager');
const { runHarvest } = require('./ag-harvest');
const { runPublish } = require('./ag-publish');
const { checkRemoteSnapshotCooldown } = require('../utils/github_sync');

const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

const DEFAULT_AG_UPDATE_TIMES = ['07:40', '12:10', '19:10'];

function parseScheduleTimesInput(raw) {
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    const timeRegex = /^([01]?[0-9]|2[0-3]):([0-5][0-9])$/;
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const m = String(item || '').trim().match(timeRegex);
        if (m) {
            const norm = `${String(parseInt(m[1], 10)).padStart(2, '0')}:${m[2]}`;
            if (!seen.has(norm)) {
                seen.add(norm);
                out.push(norm);
            }
        }
    }
    return out.sort();
}

function getTimesToSchedule(opts = {}) {
    if (Array.isArray(opts)) {
        const parsedArr = parseScheduleTimesInput(opts);
        if (parsedArr.length > 0) return parsedArr;
    } else if (opts && typeof opts === 'object') {
        const fromOpts = parseScheduleTimesInput(opts.times || opts.scheduleTimes || opts.updateTimes);
        if (fromOpts.length > 0) return fromOpts;
    } else if (typeof opts === 'string') {
        const parsedStr = parseScheduleTimesInput(opts);
        if (parsedStr.length > 0) return parsedStr;
    }

    const fromEnv = parseScheduleTimesInput(process.env.AG_UPDATE_TIMES);
    if (fromEnv.length > 0) return fromEnv;

    const fromConfig = parseScheduleTimesInput(config.agent?.updateTimes || config.agent?.scheduleTimes);
    if (fromConfig.length > 0) return fromConfig;

    return [...DEFAULT_AG_UPDATE_TIMES];
}

function resolveDefaultPushToGithub() {
    if (process.env.GITHUB_PUSH_ENABLED !== undefined && process.env.GITHUB_PUSH_ENABLED !== '') {
        const val = String(process.env.GITHUB_PUSH_ENABLED).toLowerCase().trim();
        return val !== 'false' && val !== '0' && val !== 'no';
    }
    if (process.env.AG_GITHUB_SYNC !== undefined && process.env.AG_GITHUB_SYNC !== '') {
        const val = String(process.env.AG_GITHUB_SYNC).toLowerCase().trim();
        return val !== 'false' && val !== '0' && val !== 'no';
    }
    return Boolean(config.githubSync?.pushEnabled ?? config.agent?.githubPushEnabled ?? true);
}

function resolveDefaultCooldownMinutes() {
    if (process.env.GITHUB_COOLDOWN_MINUTES !== undefined && process.env.GITHUB_COOLDOWN_MINUTES !== '') {
        const parsed = Number(process.env.GITHUB_COOLDOWN_MINUTES);
        if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    const cfgVal = Number(config.githubSync?.cooldownMinutes ?? config.agent?.githubCooldownMinutes ?? 30);
    return Number.isFinite(cfgVal) ? Math.max(0, cfgVal) : 30;
}

function parseArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const defaultPort = config.server?.port || 3120;
    const defaultGithubSync = resolveDefaultPushToGithub();
    const defaultClientId = String(
        process.env.CLIENT_ID ||
        process.env.AG_CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        os.hostname() ||
        'antigravity-client'
    ).trim();
    const defaultScheduleTimes = getTimesToSchedule();
    const options = {
        candidates: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        compiled: process.env.AG_COMPILED_FILE || path.join(config.storage.dataDir, 'ag_compiled.json'),
        target: process.env.COREFEED_SITE_URL || config.agent?.siteUrl || `http://localhost:${defaultPort}`,
        secret: process.env.PUBLISH_SECRET || process.env.PUBLISH_API_KEY || config.agent?.publishSecret || '',
        limit: config.agent?.maxCuratedArticles || 30,
        imageLimit: config.agent?.maxCuratedArticles || 30,
        category: 'all',
        skipHarvest: false,
        useExistingCompiled: false,
        fallbackCompile: false,
        localOnly: false,
        pushToGithub: defaultGithubSync,
        githubSync: defaultGithubSync,
        github: defaultGithubSync,
        githubExplicit: false,
        githubBranch: process.env.AG_GITHUB_BRANCH || config.githubSync?.branch || 'ag-snapshot',
        githubRemote: process.env.AG_GITHUB_REMOTE || config.githubSync?.remote || 'origin',
        cooldownMinutes: resolveDefaultCooldownMinutes(),
        force: false,
        clientId: defaultClientId,
        publishedBy: defaultClientId,
        snapshotUrl: process.env.GITHUB_SNAPSHOT_URL || config.githubSync?.snapshotUrl || null,
        snapshotOut: process.env.AG_SNAPSHOT_OUT || null,
        times: defaultScheduleTimes,
        scheduleTimes: defaultScheduleTimes,
        daemon: false,
        status: false,
        catchup: true,
        runNow: false,
        targetExplicit: Boolean(process.env.COREFEED_SITE_URL)
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--candidates' || arg === '--raw') && argv[i + 1]) {
            options.candidates = path.resolve(argv[++i]);
        } else if (arg.startsWith('--candidates=') || arg.startsWith('--raw=')) {
            options.candidates = path.resolve(eqVal(arg));
        } else if ((arg === '--compiled' || arg === '--file') && argv[i + 1]) {
            options.compiled = path.resolve(argv[++i]);
        } else if (arg.startsWith('--compiled=') || arg.startsWith('--file=')) {
            options.compiled = path.resolve(eqVal(arg));
        } else if ((arg === '--target' || arg === '--site' || arg === '--url') && argv[i + 1]) {
            options.target = argv[++i];
            options.targetExplicit = true;
        } else if (arg.startsWith('--target=') || arg.startsWith('--site=') || arg.startsWith('--url=')) {
            options.target = eqVal(arg);
            options.targetExplicit = true;
        } else if (arg === '--secret' && argv[i + 1] !== undefined) {
            options.secret = argv[++i];
        } else if (arg.startsWith('--secret=')) {
            options.secret = eqVal(arg);
        } else if (arg === '--limit' && argv[i + 1]) {
            options.limit = Math.max(1, parseInt(argv[++i], 10) || 30);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Math.max(1, parseInt(eqVal(arg), 10) || 30);
        } else if (arg === '--images' && argv[i + 1] !== undefined) {
            options.imageLimit = Math.max(0, parseInt(argv[++i], 10));
        } else if (arg.startsWith('--images=')) {
            options.imageLimit = Math.max(0, parseInt(eqVal(arg), 10));
        } else if (arg === '--category' && argv[i + 1]) {
            options.category = argv[++i];
        } else if (arg.startsWith('--category=')) {
            options.category = eqVal(arg);
        } else if (arg === '--skip-harvest') {
            options.skipHarvest = true;
        } else if (arg === '--use-existing-compiled') {
            options.useExistingCompiled = true;
        } else if (arg === '--fallback-compile') {
            options.fallbackCompile = true;
        } else if (arg === '--local-only' || arg === '--no-push') {
            options.localOnly = true;
        } else if (arg === '--github' || arg === '--github-sync') {
            options.pushToGithub = true;
            options.githubSync = true;
            options.github = true;
            options.githubExplicit = true;
        } else if (arg === '--no-github' || arg === '--no-github-sync') {
            options.pushToGithub = false;
            options.githubSync = false;
            options.github = false;
            options.githubExplicit = true;
        } else if (arg === '--github-branch' && argv[i + 1]) {
            options.githubBranch = argv[++i];
        } else if (arg.startsWith('--github-branch=')) {
            options.githubBranch = eqVal(arg);
        } else if (arg === '--github-remote' && argv[i + 1]) {
            options.githubRemote = argv[++i];
        } else if (arg.startsWith('--github-remote=')) {
            options.githubRemote = eqVal(arg);
        } else if (arg === '--cooldown' && argv[i + 1] !== undefined) {
            const parsed = Number(argv[++i]);
            if (Number.isFinite(parsed)) {
                options.cooldownMinutes = Math.max(0, parsed);
            }
        } else if (arg.startsWith('--cooldown=')) {
            const parsed = Number(eqVal(arg));
            if (Number.isFinite(parsed)) {
                options.cooldownMinutes = Math.max(0, parsed);
            }
        } else if (arg === '--force' || arg === '-f') {
            options.force = true;
        } else if ((arg === '--client-id' || arg === '--published-by') && argv[i + 1]) {
            const val = String(argv[++i]).trim();
            if (val) {
                options.clientId = val;
                options.publishedBy = val;
            }
        } else if (arg.startsWith('--client-id=') || arg.startsWith('--published-by=')) {
            const val = String(eqVal(arg)).trim();
            if (val) {
                options.clientId = val;
                options.publishedBy = val;
            }
        } else if (arg === '--snapshot-url' && argv[i + 1]) {
            options.snapshotUrl = String(argv[++i]).trim();
        } else if (arg.startsWith('--snapshot-url=')) {
            options.snapshotUrl = String(eqVal(arg)).trim();
        } else if (arg === '--snapshot-out' && argv[i + 1]) {
            options.snapshotOut = path.resolve(argv[++i]);
        } else if (arg.startsWith('--snapshot-out=')) {
            options.snapshotOut = path.resolve(eqVal(arg));
        } else if ((arg === '--times' || arg === '--schedule-times') && argv[i + 1]) {
            const parsedTimes = parseScheduleTimesInput(argv[++i]);
            if (parsedTimes.length > 0) {
                options.times = parsedTimes;
                options.scheduleTimes = parsedTimes;
            }
        } else if (arg.startsWith('--times=') || arg.startsWith('--schedule-times=')) {
            const parsedTimes = parseScheduleTimesInput(eqVal(arg));
            if (parsedTimes.length > 0) {
                options.times = parsedTimes;
                options.scheduleTimes = parsedTimes;
            }
        } else if (arg === '--daemon') {
            options.daemon = true;
        } else if (arg === '--status') {
            options.status = true;
        } else if (arg === '--no-catchup') {
            options.catchup = false;
        } else if (arg === '--catchup') {
            options.catchup = true;
        } else if (arg === '--run-now' || arg === '--immediate') {
            options.runNow = true;
        }
    }

    return options;
}

const sharedFallbackAiService = new AIService(null, stateManager);

function extractFallbackKeyPoints(article, aiServiceInstance = null) {
    const svc = aiServiceInstance || sharedFallbackAiService;
    if (typeof svc._buildChineseKeyPoints === 'function') {
        const zhTitle = article.translatedTitle || article.title || '';
        const zhSummary = article.summary || article.translatedDescription || article.description || '';
        return svc._buildChineseKeyPoints(
            zhTitle,
            zhSummary,
            zhSummary,
            article,
            article.region || '国际',
            article.category || '国际'
        );
    }
    if (Array.isArray(article.keyPoints) && article.keyPoints.length >= 3) {
        return article.keyPoints.slice(0, 3);
    }
    return [];
}

async function probeAiEndpointReachable(aiService, timeoutMs = 2500) {
    if (!aiService?.modelConfig?.apiKey || !aiService?.modelConfig?.baseUrl) {
        return false;
    }
    if (Date.now() < (aiService._endpointUnreachableUntil || 0)) {
        return false;
    }
    try {
        const res = await axios.get(`${aiService.modelConfig.baseUrl}/models`, {
            headers: {
                'Authorization': `Bearer ${aiService.modelConfig.apiKey}`,
                'User-Agent': 'CoreFeed/2.0'
            },
            timeout: timeoutMs,
            httpsAgent: httpsAgentIgnoreTls,
            validateStatus: () => true
        });
        const ok = res.status >= 200 && res.status < 500 && res.status !== 403 && res.status !== 404;
        if (!ok) {
            aiService._endpointUnreachableUntil = Date.now() + 180000;
        }
        return ok;
    } catch (_) {
        aiService._endpointUnreachableUntil = Date.now() + 180000;
        return false;
    }
}

async function verifyTargetHealth(opts) {
    let healthVerified = false;
    let healthStatus = null;
    if (!opts.localOnly && opts.target) {
        const baseTarget = opts.target.replace(/\/+$/, '').replace(/\/api\/agent\/publish$/, '');
        const healthUrl = `${baseTarget}/api/health`;
        try {
            const healthRes = await axios.get(healthUrl, {
                timeout: 10000,
                httpsAgent: httpsAgentIgnoreTls,
                validateStatus: () => true
            });
            healthStatus = healthRes.data;
            healthVerified = healthRes.status === 200 && (healthRes.data?.status === 'healthy' || healthRes.data?.status === 'ok');
            logger.info('AG-AUTO', `[Stage 4/4] 目标站点健康检查 (${healthUrl}): verified=${healthVerified}`);
        } catch (err) {
            logger.warn('AG-AUTO', `[Stage 4/4] 目标站点健康检查失败 (${healthUrl}): ${err.message}`);
        }
    }
    return { healthVerified, healthStatus };
}

async function runAutoUpdate(customOptions = {}) {
    const opts = { ...parseArgs([]), ...customOptions };
    if (customOptions.file && !customOptions.compiled) {
        opts.compiled = path.resolve(customOptions.file);
    }
    if ((customOptions.site || customOptions.url) && !customOptions.target) {
        opts.target = customOptions.site || customOptions.url;
        opts.targetExplicit = true;
    }
    if (customOptions.target) {
        opts.targetExplicit = true;
    }

    let shouldPushToGithub = Boolean(opts.pushToGithub);
    if (
        customOptions.noGithub === true ||
        customOptions.pushToGithub === false ||
        customOptions.githubSync === false ||
        customOptions.github === false
    ) {
        shouldPushToGithub = false;
    } else if (
        customOptions.pushToGithub === true ||
        customOptions.githubSync === true ||
        customOptions.github === true
    ) {
        shouldPushToGithub = true;
    }
    opts.pushToGithub = shouldPushToGithub;
    opts.githubSync = shouldPushToGithub;
    opts.github = shouldPushToGithub;

    const publishedBy = String(
        customOptions.publishedBy ||
        customOptions.clientId ||
        opts.publishedBy ||
        opts.clientId ||
        process.env.CLIENT_ID ||
        process.env.AG_CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        os.hostname() ||
        'antigravity-client'
    ).trim();
    opts.publishedBy = publishedBy;
    opts.clientId = publishedBy;

    const startTime = Date.now();
    const aiService = new AIService(null, stateManager);

    // Stage 0: Multi-Client Cooldown Check (方案 2B 多客户端防冲突保护)
    const hasExplicitTestSnapshotUrl = Boolean(
        customOptions.snapshotUrl ||
        process.env.GITHUB_SNAPSHOT_URL ||
        customOptions.checkCooldown
    );
    const shouldCheckCooldown =
        !opts.force &&
        opts.cooldownMinutes > 0 &&
        (!opts.skipHarvest || customOptions.checkCooldown) &&
        (process.env.NODE_ENV !== 'test' || hasExplicitTestSnapshotUrl);

    if (shouldCheckCooldown) {
        const cooldownCheck = await checkRemoteSnapshotCooldown({
            snapshotUrl: opts.snapshotUrl,
            cooldownMinutes: opts.cooldownMinutes
        });
        if (cooldownCheck.inCooldown && cooldownCheck.snapshot) {
            logger.info(
                'AG-AUTO',
                `[Multi-Client Cooldown] 远端快照已由客户端 "${cooldownCheck.publishedBy}" 于 ${cooldownCheck.publishedAt} 更新 (距今 ${cooldownCheck.ageMinutes} 分钟 < 冷却窗口 ${opts.cooldownMinutes} 分钟)，直接拉取同步至本地...`
            );
            await writeJsonFile(opts.compiled, cooldownCheck.snapshot);
            const publishResult = await runPublish({
                candidates: opts.candidates,
                compiled: opts.compiled,
                target: opts.target,
                targetExplicit: opts.targetExplicit,
                secret: opts.secret,
                limit: opts.limit,
                localOnly: opts.localOnly,
                pushToGithub: false,
                githubSync: false,
                github: false,
                syncedFromGithub: true,
                snapshotOut: opts.snapshotOut,
                publishedAt: cooldownCheck.publishedAt,
                publishedBy: cooldownCheck.publishedBy,
                clientId: cooldownCheck.clientId
            });
            const { healthVerified, healthStatus } = await verifyTargetHealth(opts);
            return {
                success: true,
                mode: 'cooldown-remote-sync',
                skippedHarvest: true,
                cooldownTriggered: true,
                cooldownSkipped: true,
                cooldownMinutes: opts.cooldownMinutes,
                remoteAgeMinutes: cooldownCheck.ageMinutes,
                publishedBy: cooldownCheck.publishedBy,
                clientId: cooldownCheck.clientId,
                harvestedCount: 0,
                compiledCount: publishResult.totalPoolCount,
                displayedCount: publishResult.displayedCount,
                totalPoolCount: publishResult.totalPoolCount,
                summaryWordCount: publishResult.summaryArticle?.wordCount || 0,
                publishedAt: publishResult.publishedAt,
                lastUpdated: publishResult.lastUpdated,
                target: opts.localOnly ? 'local-only' : opts.target,
                snapshotUrl: cooldownCheck.sourceUrl,
                healthVerified,
                healthStatus,
                githubSync: {
                    success: true,
                    pulledFromRemote: true,
                    publishedAt: cooldownCheck.publishedAt,
                    publishedBy: cooldownCheck.publishedBy,
                    sourceUrl: cooldownCheck.sourceUrl
                },
                remoteResponse: publishResult.remoteResponse,
                elapsedSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1))
            };
        }
    }

    // Stage 1: Harvest (or load existing candidates)
    let harvestData = null;
    if (!opts.skipHarvest) {
        logger.info('AG-AUTO', '[Stage 1/4] 正在执行全球新闻巡检与候选集采集 (ag-harvest)...');
        harvestData = await runHarvest({
            out: opts.candidates,
            limit: Math.max(opts.limit + 5, 35),
            imageLimit: opts.imageLimit,
            category: opts.category
        });
    } else {
        logger.info('AG-AUTO', `[Stage 1/4] 跳过实时采集 (--skip-harvest)，读取候选集: ${opts.candidates}`);
        harvestData = await readJsonFile(opts.candidates, null);
    }

    if (!harvestData || !Array.isArray(harvestData.fullCandidates) || harvestData.fullCandidates.length === 0) {
        throw new Error(`无法读取有效候选新闻集: ${opts.candidates}`);
    }

    // Stage 2: Compile (reuse existing compiled JSON if requested & valid, else compile via AI or fast Chinese fallback)
    let compiledData = null;
    let compilationMode = 'existing-compiled';

    if (opts.useExistingCompiled) {
        compiledData = await readJsonFile(opts.compiled, null);
        if (compiledData && Array.isArray(compiledData.articles) && compiledData.articles.length > 0) {
            logger.info('AG-AUTO', `[Stage 2/4] 复用已有精编结果 (--use-existing-compiled): ${opts.compiled} (${compiledData.articles.length} 条)`);
        } else {
            compiledData = null;
        }
    }

    if (!compiledData) {
        const currentDate = new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
            timeZone: 'Asia/Shanghai'
        });

        const canUseRemoteAi = !opts.fallbackCompile && (await probeAiEndpointReachable(aiService, 2500));
        let compiledArticles = [];
        let summaryArticle = null;
        let duplicateGroups = [];

        if (canUseRemoteAi) {
            compilationMode = 'ai-endpoint';
            logger.info('AG-AUTO', `[Stage 2/4] 远端 AI 端点可达，正在执行批量深度精编 (${harvestData.fullCandidates.length} 条)...`);
            compiledArticles = await aiService.enhanceNewsArticles(harvestData.fullCandidates);
            summaryArticle = await aiService.generateNewsSummaryArticle(compiledArticles.slice(0, opts.limit));
        } else {
            compilationMode = 'fallback-chinese';
            logger.info('AG-AUTO', `[Stage 2/4] 启用高速中文精译与结构化综述编译 (${harvestData.fullCandidates.length} 条)...`);
            const prelim = harvestData.fullCandidates.map(item => aiService.applyPreliminaryMetadata(item));
            const translated = await aiService.ensureBatchInChinese(prelim, 8);
            compiledArticles = translated.map(item => ({
                ...item,
                keyPoints: extractFallbackKeyPoints(item, aiService),
                aiCompiled: true,
                processedAt: new Date().toISOString()
            }));

            if (compiledArticles.length > opts.limit && typeof aiService._calculateArticleSimilarity === 'function') {
                for (let i = 0; i < compiledArticles.length; i++) {
                    for (let j = i + 1; j < compiledArticles.length; j++) {
                        if (aiService._calculateArticleSimilarity(compiledArticles[i], compiledArticles[j]) >= 0.30) {
                            duplicateGroups.push([i + 1, j + 1]);
                        }
                    }
                }
            }

            let summaryTargetArticles = compiledArticles;
            if (duplicateGroups.length > 0 && compiledArticles.length > 1) {
                const n = compiledArticles.length;
                const parent = Array.from({ length: n }, (_, i) => i);
                const find = (x) => {
                    while (parent[x] !== x) {
                        parent[x] = parent[parent[x]];
                        x = parent[x];
                    }
                    return x;
                };
                const union = (a, b) => {
                    const ra = find(a);
                    const rb = find(b);
                    if (ra !== rb) {
                        if (ra < rb) parent[rb] = ra;
                        else parent[ra] = rb;
                    }
                };
                for (const [a, b] of duplicateGroups) {
                    if (a >= 1 && a <= n && b >= 1 && b <= n) {
                        union(a - 1, b - 1);
                    }
                }
                const clusterMap = new Map();
                for (let i = 0; i < n; i++) {
                    const root = find(i);
                    if (!clusterMap.has(root)) clusterMap.set(root, []);
                    clusterMap.get(root).push(compiledArticles[i]);
                }
                summaryTargetArticles = Array.from(clusterMap.values())
                    .map(g => aiService._mergeArticleCluster(g))
                    .filter(Boolean);
            }

            summaryArticle = aiService._buildFallbackSummaryObject(summaryTargetArticles.slice(0, opts.limit), currentDate);
        }

        compiledData = {
            compiledAt: new Date().toISOString(),
            mode: compilationMode,
            publishedBy,
            clientId: publishedBy,
            duplicateGroups,
            articles: compiledArticles.map((item, idx) => ({
                index: idx + 1,
                id: item.id,
                translatedTitle: item.translatedTitle || item.title,
                summary: item.summary || item.translatedDescription || item.description || item.title,
                fullText: item.fullText || item.content || item.description || '',
                originalParagraphs: Array.isArray(item.originalParagraphs) ? item.originalParagraphs : [],
                translatedContent: item.translatedContent || (Array.isArray(item.translatedParagraphs) ? item.translatedParagraphs.join('\n\n') : ''),
                translatedParagraphs: Array.isArray(item.translatedParagraphs) ? item.translatedParagraphs : [],
                region: item.region || '国际',
                category: item.category || '国际',
                keyPoints: extractFallbackKeyPoints(item, aiService)
            })),
            summaryMarkdown: summaryArticle?.content || '',
            summaryArticle
        };

        await writeJsonFile(opts.compiled, compiledData);
        logger.success('AG-AUTO', `[Stage 2/4] 编译结果已写入 ${opts.compiled} (mode=${compilationMode}, count=${compiledData.articles.length})`);
    }

    // Stage 3: Publish to local files, GitHub snapshot branch (default enabled in Method 2B), & target server
    logger.info('AG-AUTO', `[Stage 3/4] 正在发布精编新闻与综述至 ${opts.localOnly ? '本地存储' : opts.target}...`);
    const publishResult = await runPublish({
        candidates: opts.candidates,
        compiled: opts.compiled,
        target: opts.target,
        targetExplicit: opts.targetExplicit,
        secret: opts.secret,
        limit: opts.limit,
        fallbackCompile: true,
        localOnly: opts.localOnly,
        pushToGithub: shouldPushToGithub,
        githubSync: shouldPushToGithub,
        github: shouldPushToGithub,
        githubExplicit: Boolean(
            opts.githubExplicit ||
            customOptions.githubExplicit ||
            customOptions.pushToGithub !== undefined ||
            customOptions.githubSync !== undefined ||
            customOptions.github !== undefined ||
            customOptions.noGithub !== undefined
        ),
        githubBranch: opts.githubBranch,
        githubRemote: opts.githubRemote,
        publishedBy,
        clientId: publishedBy,
        snapshotOut: opts.snapshotOut,
        repoDir: opts.repoDir,
        skipGitPush: opts.skipGitPush
    });

    // Stage 4: Verify target website /api/health
    const { healthVerified, healthStatus } = await verifyTargetHealth(opts);

    const result = {
        success: true,
        mode: compilationMode,
        skippedHarvest: Boolean(opts.skipHarvest),
        cooldownTriggered: false,
        cooldownSkipped: false,
        publishedBy: publishResult.publishedBy || publishedBy,
        clientId: publishResult.clientId || publishedBy,
        harvestedCount: harvestData.fullCandidates.length,
        compiledCount: Array.isArray(compiledData.articles) ? compiledData.articles.length : 0,
        displayedCount: publishResult.displayedCount,
        totalPoolCount: publishResult.totalPoolCount,
        summaryWordCount: publishResult.summaryArticle?.wordCount || 0,
        publishedAt: publishResult.publishedAt || publishResult.lastUpdated,
        lastUpdated: publishResult.lastUpdated,
        target: opts.localOnly ? 'local-only' : opts.target,
        healthVerified,
        healthStatus,
        githubSync: publishResult.githubSync || null,
        remoteResponse: publishResult.remoteResponse,
        elapsedSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1))
    };

    return result;
}

function formatShanghaiTimestamp(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    const sh = new Date(d.getTime() + 8 * 3600000);
    const yyyy = sh.getUTCFullYear();
    const mm = String(sh.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(sh.getUTCDate()).padStart(2, '0');
    const hh = String(sh.getUTCHours()).padStart(2, '0');
    const mi = String(sh.getUTCMinutes()).padStart(2, '0');
    const ss = String(sh.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss} Asia/Shanghai`;
}

function getNextExecutionTime(updateTimes = null) {
    const times = Array.isArray(updateTimes) && updateTimes.length > 0
        ? parseScheduleTimesInput(updateTimes)
        : getTimesToSchedule(updateTimes);

    const now = new Date();
    const shanghaiOffsetMs = 8 * 3600000;
    const shNow = new Date(now.getTime() + shanghaiOffsetMs);
    const shYear = shNow.getUTCFullYear();
    const shMonth = shNow.getUTCMonth();
    const shDate = shNow.getUTCDate();

    let nextExecution = null;
    for (const time of times) {
        const [hour, minute] = String(time).split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) continue;
        const execTime = new Date(Date.UTC(shYear, shMonth, shDate, hour - 8, minute, 0, 0));
        if (execTime > now && (!nextExecution || execTime < nextExecution)) {
            nextExecution = execTime;
        }
    }

    if (!nextExecution) {
        for (const time of times) {
            const [hour, minute] = String(time).split(':').map(Number);
            if (isNaN(hour) || isNaN(minute)) continue;
            const execTime = new Date(Date.UTC(shYear, shMonth, shDate + 1, hour - 8, minute, 0, 0));
            if (!nextExecution || execTime < nextExecution) {
                nextExecution = execTime;
            }
        }
    }

    return nextExecution ? nextExecution.toISOString() : null;
}

function getLastExecutionTime(updateTimes = null, nowDate = new Date()) {
    const times = Array.isArray(updateTimes) && updateTimes.length > 0
        ? parseScheduleTimesInput(updateTimes)
        : getTimesToSchedule(updateTimes);

    const now = nowDate instanceof Date ? nowDate : new Date(nowDate);
    const shanghaiOffsetMs = 8 * 3600000;
    const shNow = new Date(now.getTime() + shanghaiOffsetMs);
    const shYear = shNow.getUTCFullYear();
    const shMonth = shNow.getUTCMonth();
    const shDate = shNow.getUTCDate();

    let lastExecution = null;
    for (const time of times) {
        const [hour, minute] = String(time).split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) continue;
        const execTime = new Date(Date.UTC(shYear, shMonth, shDate, hour - 8, minute, 0, 0));
        if (execTime <= now && (!lastExecution || execTime > lastExecution)) {
            lastExecution = execTime;
        }
    }

    if (!lastExecution) {
        for (const time of times) {
            const [hour, minute] = String(time).split(':').map(Number);
            if (isNaN(hour) || isNaN(minute)) continue;
            const execTime = new Date(Date.UTC(shYear, shMonth, shDate - 1, hour - 8, minute, 0, 0));
            if (!lastExecution || execTime > lastExecution) {
                lastExecution = execTime;
            }
        }
    }

    return lastExecution ? lastExecution.toISOString() : null;
}

function getDaemonPaths() {
    const dataDir = config.storage?.dataDir || path.join(__dirname, '..', 'data');
    const logsDir = path.join(__dirname, '..', 'logs');
    return {
        dataDir,
        logsDir,
        statusFile: path.join(dataDir, 'ag_daemon_status.json'),
        pidFile: path.join(logsDir, 'ag-daemon.pid'),
        logFile: path.join(logsDir, 'ag-daemon.log'),
        stateFile: path.join(dataDir, 'state.json'),
        compiledFile: path.join(dataDir, 'ag_compiled.json')
    };
}

function isPidAlive(pid) {
    const num = Number(pid);
    if (!Number.isInteger(num) || num <= 0) return false;
    try {
        process.kill(num, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function getDaemonStatus(cliOpts = {}) {
    const opts = { ...parseArgs([]), ...cliOpts };
    const paths = getDaemonPaths();
    const times = getTimesToSchedule(cliOpts);
    const timezone = config.news?.timezone || 'Asia/Shanghai';
    const nextExecution = getNextExecutionTime(times);
    const nextExecutionShanghai = formatShanghaiTimestamp(nextExecution);
    const nextTimeSlot = nextExecutionShanghai ? nextExecutionShanghai.slice(11, 16) : null;
    const lastScheduledExecution = getLastExecutionTime(times);
    const lastScheduledShanghai = formatShanghaiTimestamp(lastScheduledExecution);
    const lastScheduledSlot = lastScheduledShanghai ? lastScheduledShanghai.slice(11, 16) : null;

    let savedStatus = null;
    if (fs.existsSync(paths.statusFile)) {
        try {
            savedStatus = JSON.parse(fs.readFileSync(paths.statusFile, 'utf8'));
        } catch (_) {}
    }

    let pid = savedStatus?.pid || null;
    if (!pid && fs.existsSync(paths.pidFile)) {
        try {
            const rawPid = parseInt(fs.readFileSync(paths.pidFile, 'utf8').trim(), 10);
            if (!isNaN(rawPid)) pid = rawPid;
        } catch (_) {}
    }

    const running = isPidAlive(pid);

    let lastPublishedAt = savedStatus?.lastPublishedAt || null;
    let lastPublishedBy = savedStatus?.lastPublishedBy || null;
    if (fs.existsSync(paths.stateFile)) {
        try {
            const st = JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'));
            lastPublishedAt = st.lastSnapshotPublishedAt || st.lastUpdated || lastPublishedAt;
            lastPublishedBy = st.lastPublishedBy || lastPublishedBy;
        } catch (_) {}
    } else if (fs.existsSync(paths.compiledFile)) {
        try {
            const comp = JSON.parse(fs.readFileSync(paths.compiledFile, 'utf8'));
            lastPublishedAt = comp.publishedAt || comp.compiledAt || lastPublishedAt;
            lastPublishedBy = comp.publishedBy || comp.clientId || lastPublishedBy;
        } catch (_) {}
    }

    const cronExpressions = {
        Asia_Shanghai: times.map(t => {
            const [h, m] = String(t).split(':').map(Number);
            return `${m} ${h} * * *`;
        }),
        UTC: times.map(t => {
            const [h, m] = String(t).split(':').map(Number);
            const utcH = (h - 8 + 24) % 24;
            return `${m} ${utcH} * * *`;
        })
    };

    return {
        running,
        pid: running ? pid : null,
        startedAt: savedStatus?.startedAt || null,
        clientId: savedStatus?.clientId || opts.clientId,
        target: savedStatus?.target || opts.target,
        scheduleTimes: times,
        timezone,
        cronExpressions,
        nextExecution,
        nextExecutionShanghai,
        nextTimeSlot,
        lastScheduledExecution,
        lastScheduledShanghai,
        lastScheduledSlot,
        lastRunAt: savedStatus?.lastRunAt || null,
        lastRunStatus: savedStatus?.lastRunStatus || 'idle',
        lastPublishedAt,
        lastPublishedAtShanghai: formatShanghaiTimestamp(lastPublishedAt),
        lastPublishedBy,
        statusFile: paths.statusFile,
        pidFile: paths.pidFile,
        logFile: paths.logFile
    };
}

function appendDaemonLog(message) {
    try {
        const paths = getDaemonPaths();
        fs.mkdirSync(paths.logsDir, { recursive: true });
        const line = `[${new Date().toISOString()}] ${message}\n`;
        fs.appendFileSync(paths.logFile, line, 'utf8');
    } catch (_) {}
}

function persistDaemonStatus(patch = {}, cliOpts = {}) {
    try {
        const paths = getDaemonPaths();
        fs.mkdirSync(paths.dataDir, { recursive: true });
        fs.mkdirSync(paths.logsDir, { recursive: true });
        let current = {};
        if (fs.existsSync(paths.statusFile)) {
            try {
                current = JSON.parse(fs.readFileSync(paths.statusFile, 'utf8'));
            } catch (_) {}
        }
        const times = getTimesToSchedule(cliOpts);
        const nextExecution = getNextExecutionTime(times);
        const nextExecutionShanghai = formatShanghaiTimestamp(nextExecution);
        const nextTimeSlot = nextExecutionShanghai ? nextExecutionShanghai.slice(11, 16) : null;
        const updated = {
            ...current,
            pid: process.pid,
            clientId: cliOpts.clientId || current.clientId || 'antigravity-client',
            target: cliOpts.target || current.target || 'http://localhost:3120',
            scheduleTimes: times,
            timezone: config.news?.timezone || 'Asia/Shanghai',
            nextExecution,
            nextExecutionShanghai,
            nextTimeSlot,
            updatedAt: new Date().toISOString(),
            ...patch
        };
        fs.writeFileSync(paths.statusFile, JSON.stringify(updated, null, 2), 'utf8');
        fs.writeFileSync(paths.pidFile, `${process.pid}\n`, 'utf8');
        return updated;
    } catch (_) {
        return null;
    }
}

function startAutoUpdateDaemon(cliOpts = {}) {
    const opts = { ...parseArgs([]), ...cliOpts };
    const times = getTimesToSchedule(cliOpts);
    const timezone = config.news?.timezone || 'Asia/Shanghai';
    const startedAt = new Date().toISOString();

    persistDaemonStatus({
        startedAt,
        lastRunStatus: 'scheduled-waiting'
    }, opts);

    const nextIso = getNextExecutionTime(times);
    const startMsg = `启动 Method 2B 定时守护进程 (PID=${process.pid}): 计划时间 [${times.join(', ')}] (${timezone}), 下次执行=${formatShanghaiTimestamp(nextIso)} (${nextIso}), clientId=${opts.clientId}`;
    logger.info('AG-AUTO', startMsg);
    appendDaemonLog(startMsg);

    let activeRunPromise = null;
    let lastAttemptedSlotIso = null;
    let lastAttemptAtMs = 0;

    const executeScheduledSlot = async (timeSlot, triggerLabel = 'CRON') => {
        if (activeRunPromise) {
            appendDaemonLog(`[${triggerLabel} ${timeSlot} ${timezone}] 已有采编任务正在执行中，跳过重复触发`);
            return activeRunPromise;
        }
        activeRunPromise = (async () => {
            const runStartIso = new Date().toISOString();
            appendDaemonLog(`[${triggerLabel} ${timeSlot} ${timezone}] 开始执行自动采编与 GitHub 快照发布...`);
            persistDaemonStatus({
                lastRunAt: runStartIso,
                lastRunSlot: timeSlot,
                lastRunStatus: 'running'
            }, opts);
            try {
                const res = await runAutoUpdate(opts);
                const doneMsg = `[${triggerLabel} ${timeSlot} ${timezone}] 执行成功: mode=${res.mode}, displayed=${res.displayedCount}, publishedAt=${res.publishedAt}, githubPushed=${Boolean(res.githubSync?.pushed || res.githubSync?.pulledFromRemote)}`;
                logger.success('AG-AUTO', doneMsg);
                appendDaemonLog(doneMsg);
                persistDaemonStatus({
                    lastRunAt: runStartIso,
                    lastCompletedAt: new Date().toISOString(),
                    lastRunStatus: 'success',
                    lastPublishedAt: res.publishedAt,
                    lastPublishedBy: res.publishedBy
                }, opts);
                return res;
            } catch (err) {
                const errMsg = `定时自动更新任务执行失败 (${timeSlot}): ${err.message}`;
                logger.error('AG-AUTO', errMsg);
                appendDaemonLog(`[ERROR] ${errMsg}`);
                persistDaemonStatus({
                    lastRunAt: runStartIso,
                    lastRunStatus: `error: ${err.message}`
                }, opts);
                return null;
            } finally {
                activeRunPromise = null;
            }
        })();
        return activeRunPromise;
    };

    const checkAndRunMissedSlot = async () => {
        if (activeRunPromise) return;
        const lastSlotIso = getLastExecutionTime(times);
        if (!lastSlotIso) return;
        const lastSlotMs = new Date(lastSlotIso).getTime();
        if (isNaN(lastSlotMs)) return;

        if (lastAttemptedSlotIso === lastSlotIso && Date.now() - lastAttemptAtMs < 15 * 60 * 1000) {
            return;
        }

        const currentStatus = getDaemonStatus(opts);
        const localPubMs = currentStatus.lastPublishedAt ? new Date(currentStatus.lastPublishedAt).getTime() : 0;
        if (localPubMs >= lastSlotMs) {
            return;
        }

        try {
            const remoteCheck = await checkRemoteSnapshotCooldown({
                snapshotUrl: opts.snapshotUrl,
                cooldownMinutes: opts.cooldownMinutes
            });
            const remotePubMs = remoteCheck?.publishedAt ? new Date(remoteCheck.publishedAt).getTime() : 0;
            if (remotePubMs >= lastSlotMs) {
                persistDaemonStatus({
                    lastPublishedAt: remoteCheck.publishedAt,
                    lastPublishedBy: remoteCheck.publishedBy || currentStatus.lastPublishedBy
                }, opts);
                return;
            }
        } catch (_) {}

        lastAttemptedSlotIso = lastSlotIso;
        lastAttemptAtMs = Date.now();
        const slotLabel = formatShanghaiTimestamp(lastSlotIso)?.slice(11, 16) || 'catchup';
        const catchupMsg = `检测到最近计划档期 (${formatShanghaiTimestamp(lastSlotIso)}) 尚未完成发布，自动触发漏档补采编...`;
        logger.info('AG-AUTO', catchupMsg);
        appendDaemonLog(catchupMsg);
        await executeScheduledSlot(slotLabel, 'CATCHUP');
    };

    const tasks = [];
    for (const time of times) {
        const [hour, minute] = String(time).split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) continue;
        const expr = `${minute} ${hour} * * *`;
        const task = cron.schedule(
            expr,
            async () => {
                await executeScheduledSlot(time, 'CRON');
            },
            { scheduled: true, timezone }
        );
        tasks.push(task);
    }

    let catchupTimer = null;
    if (opts.runNow && process.env.NODE_ENV !== 'test') {
        setImmediate(() => {
            executeScheduledSlot('immediate', 'STARTUP').catch(() => {});
        });
    } else if (opts.catchup !== false && process.env.NODE_ENV !== 'test') {
        setImmediate(() => {
            checkAndRunMissedSlot().catch(() => {});
        });
        catchupTimer = setInterval(() => {
            checkAndRunMissedSlot().catch(() => {});
        }, 60 * 1000);
        if (typeof catchupTimer.unref === 'function') {
            catchupTimer.unref();
        }
    }

    return {
        tasks,
        catchupTimer,
        status: getDaemonStatus(opts)
    };
}

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
    if (cliOpts.status) {
        const status = getDaemonStatus(cliOpts);
        console.log(JSON.stringify(status, null, 2));
        process.exit(0);
    } else if (cliOpts.daemon) {
        startAutoUpdateDaemon(cliOpts);
    } else {
        runAutoUpdate(cliOpts)
            .then(result => {
                console.log(JSON.stringify(result, null, 2));
                process.exit(0);
            })
            .catch(err => {
                console.error('[AG-AUTO] 自动更新流水线失败:', err.message);
                process.exit(1);
            });
    }
}

module.exports = {
    runAutoUpdate,
    parseArgs,
    startAutoUpdateDaemon,
    getDaemonStatus,
    getNextExecutionTime,
    getLastExecutionTime,
    getTimesToSchedule
};
