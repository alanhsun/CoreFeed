#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Antigravity 全自动四阶段采编发闭环编排脚本 (ag-auto-update.js)
 *
 * 功能说明：
 *   专为每天早 (08:00)、中 (12:30)、晚 (19:30) 三次定时自动更新及一键 CLI 触发设计的端到端编排器：
 *   - Stage 1 (Harvest) : 调用 `ag-harvest.js` 并发采集全球 30 大权威信源并提取正文与配图；
 *   - Stage 2 (Compile) : 自动执行 AI 跨源语义去重、中文精编、单篇深读生成与《全球要闻深度综述》撰写（无密钥时无缝降级至免密钥高速中文编译兜底）；
 *   - Stage 3 (Publish) : 调用 `ag-publish.js` 将编译产物推送至 `POST /api/agent/publish` 落盘并触发全站 WebSocket 广播；
 *   - Stage 4 (Verify)  : 校验目标站点 `/api/health` 与 `/api/news` 在线健康状态，确保闭环更新成功。
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');
const AIService = require('../services/ai_service');
const stateManager = require('../services/state_manager');
const { runHarvest } = require('./ag-harvest');
const { runPublish } = require('./ag-publish');

const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function parseArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const defaultPort = config.server?.port || 3120;
    const defaultGithubSync = String(process.env.AG_GITHUB_SYNC || '').toLowerCase() === 'true';
    const options = {
        candidates: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        compiled: process.env.AG_COMPILED_FILE || path.join(config.storage.dataDir, 'ag_compiled.json'),
        target: process.env.COREFEED_SITE_URL || config.agent?.siteUrl || `http://localhost:${defaultPort}`,
        secret: process.env.PUBLISH_SECRET || process.env.PUBLISH_API_KEY || config.agent?.publishSecret || '',
        limit: config.agent?.maxCuratedArticles || 30,
        deepRead: config.agent?.deepReadTopCount !== undefined ? config.agent.deepReadTopCount : 8,
        imageLimit: config.agent?.maxCuratedArticles || 30,
        category: 'all',
        skipHarvest: false,
        useExistingCompiled: false,
        fallbackCompile: false,
        localOnly: false,
        githubSync: defaultGithubSync,
        github: defaultGithubSync,
        githubBranch: process.env.AG_GITHUB_BRANCH || config.githubSync?.branch || 'ag-snapshot',
        githubRemote: process.env.AG_GITHUB_REMOTE || config.githubSync?.remote || 'origin',
        snapshotOut: process.env.AG_SNAPSHOT_OUT || null,
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
        } else if (arg === '--deep-read' && argv[i + 1] !== undefined) {
            options.deepRead = Math.max(0, parseInt(argv[++i], 10));
        } else if (arg.startsWith('--deep-read=')) {
            options.deepRead = Math.max(0, parseInt(eqVal(arg), 10));
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
            options.githubSync = true;
            options.github = true;
        } else if (arg === '--github-branch' && argv[i + 1]) {
            options.githubBranch = argv[++i];
        } else if (arg.startsWith('--github-branch=')) {
            options.githubBranch = eqVal(arg);
        } else if (arg === '--github-remote' && argv[i + 1]) {
            options.githubRemote = argv[++i];
        } else if (arg.startsWith('--github-remote=')) {
            options.githubRemote = eqVal(arg);
        } else if (arg === '--snapshot-out' && argv[i + 1]) {
            options.snapshotOut = path.resolve(argv[++i]);
        } else if (arg.startsWith('--snapshot-out=')) {
            options.snapshotOut = path.resolve(eqVal(arg));
        }
    }

    return options;
}

function extractFallbackKeyPoints(article) {
    if (Array.isArray(article.keyPoints) && article.keyPoints.length > 0) {
        return article.keyPoints.slice(0, 3);
    }
    const text = String(article.summary || article.translatedDescription || article.translatedTitle || '').trim();
    if (!text) return [];
    const clauses = text
        .split(/[。；！？!?]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 6 && s.length <= 60);
    if (clauses.length >= 2) {
        return clauses.slice(0, 3);
    }
    const subClauses = text
        .split(/[，,、]+/)
        .map(s => s.trim())
        .filter(s => s.length >= 6 && s.length <= 45);
    return subClauses.slice(0, 2);
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

async function runAutoUpdate(customOptions = {}) {
    const opts = { ...parseArgs([]), ...customOptions };
    const startTime = Date.now();
    const aiService = new AIService(null, stateManager);

    // Stage 1: Harvest (or load existing candidates)
    let harvestData = null;
    if (!opts.skipHarvest) {
        logger.info('AG-AUTO', '[Stage 1/4] 正在执行全球新闻巡检与全文深读采集 (ag-harvest)...');
        harvestData = await runHarvest({
            out: opts.candidates,
            limit: Math.max(opts.limit + 5, 35),
            deepRead: opts.deepRead,
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
                keyPoints: extractFallbackKeyPoints(item),
                aiCompiled: true,
                processedAt: new Date().toISOString()
            }));
            summaryArticle = aiService._buildFallbackSummaryObject(compiledArticles.slice(0, opts.limit), currentDate);
        }

        compiledData = {
            compiledAt: new Date().toISOString(),
            mode: compilationMode,
            duplicateGroups: [],
            articles: compiledArticles.map((item, idx) => ({
                index: idx + 1,
                id: item.id,
                translatedTitle: item.translatedTitle || item.title,
                summary: item.summary || item.translatedDescription || item.description || item.title,
                region: item.region || '国际',
                category: item.category || '国际',
                keyPoints: extractFallbackKeyPoints(item)
            })),
            summaryMarkdown: summaryArticle?.content || '',
            summaryArticle
        };

        await writeJsonFile(opts.compiled, compiledData);
        logger.success('AG-AUTO', `[Stage 2/4] 编译结果已写入 ${opts.compiled} (mode=${compilationMode}, count=${compiledData.articles.length})`);
    }

    // Stage 3: Publish to local files, GitHub snapshot branch (if enabled), & target server
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
        githubSync: Boolean(opts.github || opts.githubSync),
        githubBranch: opts.githubBranch,
        githubRemote: opts.githubRemote,
        snapshotOut: opts.snapshotOut,
        repoDir: opts.repoDir,
        skipGitPush: opts.skipGitPush
    });

    // Stage 4: Verify target website /api/health
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

    const result = {
        success: true,
        mode: compilationMode,
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

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
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

module.exports = { runAutoUpdate, parseArgs };
