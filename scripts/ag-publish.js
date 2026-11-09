#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Antigravity Path A: 阶段二新闻合入、二次聚类与远程发布工具 (ag-publish.js)
 *
 * 功能说明：
 *   读取 `data/ag_candidates.json` 与编译结果 `data/ag_compiled.json`，将中文精编标题、摘要、
 *   要点、分类标签及单篇深读内容合入候选文章，支持通过 `duplicateGroups` 并查集 (Union-Find)
 *   执行二次语义去重与 `relatedSources` 多媒交叉印证合并，自动将综述中的 `[NEWS_k]` 引用渲染为
 *   可点击的原文锚点，并通过 `POST /api/agent/publish` 推送至目标 CoreFeed 站点。
 *
 * 常用参数：
 *   --candidates <path>    候选新闻输入路径 (默认: data/ag_candidates.json)
 *   --compiled <path>      编译结果输入路径 (默认: data/ag_compiled.json)
 *   --target <url>         目标 CoreFeed 服务地址 (默认: http://localhost:3120)
 *   --secret <token>       发布鉴权密钥 (对应 PUBLISH_SECRET)
 *   --limit <number>       最终精选发布条数 (默认: 30)
 *   --fallback-compile     当缺少预编译文件时自动使用内置编译/翻译兜底生成
 *   --local-only           仅写入本地 data/*.json，不发起远程 HTTP 推送
 */
const os = require('os');
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
const { publishSnapshotToGitHub } = require('../utils/github_sync');

const VALID_REGIONS = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '澳洲', '亚洲', '国际'];
const VALID_CATEGORIES = ['政经', '外交', '科技', '财经', '军事', '社会', '能源', '国际'];
const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

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
    const options = {
        candidates: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        compiled: process.env.AG_COMPILED_FILE || path.join(config.storage.dataDir, 'ag_compiled.json'),
        target: process.env.COREFEED_SITE_URL || config.agent?.siteUrl || `http://localhost:${defaultPort}`,
        secret: process.env.PUBLISH_SECRET || process.env.PUBLISH_API_KEY || config.agent?.publishSecret || '',
        limit: config.agent?.maxCuratedArticles || 30,
        fallbackCompile: false,
        localOnly: false,
        pushToGithub: defaultGithubSync,
        githubSync: defaultGithubSync,
        github: defaultGithubSync,
        githubExplicit: false,
        githubBranch: process.env.AG_GITHUB_BRANCH || config.githubSync?.branch || 'ag-snapshot',
        githubRemote: process.env.AG_GITHUB_REMOTE || config.githubSync?.remote || 'origin',
        clientId: defaultClientId,
        publishedBy: defaultClientId,
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
        } else if (arg === '--snapshot-out' && argv[i + 1]) {
            options.snapshotOut = path.resolve(argv[++i]);
        } else if (arg.startsWith('--snapshot-out=')) {
            options.snapshotOut = path.resolve(eqVal(arg));
        }
    }

    return options;
}

function normalizeRegion(rawRegion, fallback = '国际') {
    if (!rawRegion) return VALID_REGIONS.includes(fallback) ? fallback : '国际';
    return VALID_REGIONS.find(r => String(rawRegion).includes(r)) || (VALID_REGIONS.includes(fallback) ? fallback : '国际');
}

function normalizeCategory(rawCategory, fallback = '国际') {
    if (!rawCategory) return VALID_CATEGORIES.includes(fallback) ? fallback : '国际';
    return VALID_CATEGORIES.find(c => String(rawCategory).includes(c)) || (VALID_CATEGORIES.includes(fallback) ? fallback : '国际');
}

async function runPublish(customOptions = {}) {
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

    const hasExplicitGithubOpt = Boolean(
        opts.githubExplicit ||
        customOptions.githubExplicit ||
        customOptions.pushToGithub !== undefined ||
        customOptions.githubSync !== undefined ||
        customOptions.github !== undefined ||
        customOptions.noGithub !== undefined
    );

    const aiService = new AIService(null, stateManager);

    let harvestData = await readJsonFile(opts.candidates, null);
    let compiledData = await readJsonFile(opts.compiled, null);

    // 支持独立自包含的 ag_compiled.json 或远端同步快照文件（当 compiledData 包含完整 news 数组或缺少候选集文件时直接以其为准）
    const hasStandaloneNews = Boolean(compiledData && Array.isArray(compiledData.news) && compiledData.news.length > 0);
    if (hasStandaloneNews || ((!harvestData || !Array.isArray(harvestData.fullCandidates) || harvestData.fullCandidates.length === 0) && compiledData)) {
        const standaloneCandidates = hasStandaloneNews
            ? compiledData.news
            : (Array.isArray(compiledData.fullCandidates) && compiledData.fullCandidates.length > 0
                ? compiledData.fullCandidates
                : (Array.isArray(compiledData.articles) && compiledData.articles.length > 0
                    ? compiledData.articles
                    : null));
        if (standaloneCandidates) {
            harvestData = {
                fullCandidates: standaloneCandidates,
                sourceStats: Array.isArray(compiledData.sourceStats) ? compiledData.sourceStats : []
            };
        }
    }

    if (!harvestData || !Array.isArray(harvestData.fullCandidates) || harvestData.fullCandidates.length === 0) {
        throw new Error(`无法读取有效候选新闻集: ${opts.candidates}`);
    }

    if (!compiledData) {
        if (opts.fallbackCompile) {
            logger.warn('AG-PUBLISH', `未找到 ${opts.compiled}，启用 --fallback-compile 自动汉化与综述生成...`);
            const translated = await aiService.ensureBatchInChinese(harvestData.fullCandidates, 8);
            compiledData = {
                duplicateGroups: [],
                articles: translated.map((item, idx) => ({
                    index: idx + 1,
                    id: item.id,
                    translatedTitle: item.translatedTitle || item.title,
                    summary: item.summary || item.description,
                    region: item.region || '国际',
                    category: item.category || '国际',
                    keyPoints: item.keyPoints || []
                })),
                summaryMarkdown: null
            };
        } else {
            throw new Error(`缺少编译结果文件: ${opts.compiled}（可使用 --fallback-compile 启用自动兜底编译）`);
        }
    }

    const rawCandidates = harvestData.fullCandidates;
    const rawTimestamp = customOptions.publishedAt || compiledData.publishedAt || compiledData.lastUpdated || null;
    const parsedTs = rawTimestamp ? new Date(rawTimestamp) : new Date();
    const nowIso = isNaN(parsedTs.getTime()) ? new Date().toISOString() : parsedTs.toISOString();

    // 1. 先按原始候选列表索引 (1-based index) 和 id 关联 Agent 编译字段，防止后续去重改变下标导致错位
    const byId = new Map();
    const byIndex = new Map();
    if (Array.isArray(compiledData.articles)) {
        compiledData.articles.forEach((entry, idx) => {
            if (!entry || typeof entry !== 'object') return;
            if (entry.id) byId.set(String(entry.id), entry);
            const numIdx = typeof entry.index === 'number'
                ? entry.index
                : (typeof entry.id === 'number' ? entry.id : idx + 1);
            if (!isNaN(numIdx) && numIdx >= 1) {
                byIndex.set(numIdx, entry);
            }
        });
    }

    let annotatedCandidates = rawCandidates.map((article, idx) => {
        const comp = (article.id && byId.get(String(article.id))) || byIndex.get(idx + 1) || null;
        if (!comp) {
            return {
                ...article,
                _hasAgentCompilation: false
            };
        }

        const zhTitle = (comp.translatedTitle || comp.title || article.translatedTitle || article.title || '').trim();
        const zhSummary = (comp.summary || comp.translatedDescription || comp.description || article.summary || article.description || '').trim();
        const region = normalizeRegion(comp.region, article.region);
        const category = normalizeCategory(comp.category, article.category);
        const keyPoints = Array.isArray(comp.keyPoints)
            ? comp.keyPoints.map(k => String(k).trim()).filter(Boolean).slice(0, 4)
            : (Array.isArray(article.keyPoints) ? article.keyPoints : []);

        return {
            ...article,
            translatedTitle: zhTitle,
            translatedDescription: zhSummary,
            summary: zhSummary,
            region,
            category,
            keyPoints,
            aiCompiled: true,
            processedAt: nowIso,
            _hasAgentCompilation: true
        };
    });

    // 2. 应用 Agent 识别出的同事件去重分组 (duplicateGroups) — 使用并查集 (Union-Find) 支持传递闭包并保持原序
    const rawGroups = Array.isArray(compiledData.duplicateGroups) ? compiledData.duplicateGroups : [];
    if (rawGroups.length > 0 && annotatedCandidates.length > 1) {
        const n = annotatedCandidates.length;
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

        for (const grp of rawGroups) {
            if (!Array.isArray(grp) || grp.length < 2) continue;
            const validIndices = grp
                .map(v => parseInt(String(v).replace(/\D+/g, ''), 10) - 1)
                .filter(idx => !isNaN(idx) && idx >= 0 && idx < n);
            if (validIndices.length >= 2) {
                const first = validIndices[0];
                for (let k = 1; k < validIndices.length; k++) {
                    union(first, validIndices[k]);
                }
            }
        }

        const clusterMap = new Map();
        for (let i = 0; i < n; i++) {
            const root = find(i);
            if (!clusterMap.has(root)) clusterMap.set(root, []);
            clusterMap.get(root).push(annotatedCandidates[i]);
        }

        const mergedList = [];
        for (const group of clusterMap.values()) {
            const merged = aiService._mergeArticleCluster(group);
            // 若 _mergeArticleCluster 因分数重排选了未直接编译的条目作为 primary，把同簇已编译条目的中文精编字段继承过来
            const compiledMember = group.find(m => m._hasAgentCompilation);
            if (merged && compiledMember && !merged._hasAgentCompilation) {
                merged.translatedTitle = compiledMember.translatedTitle;
                merged.translatedDescription = compiledMember.translatedDescription;
                merged.summary = compiledMember.summary;
                merged.region = compiledMember.region;
                merged.category = compiledMember.category;
                if (!Array.isArray(merged.keyPoints) || merged.keyPoints.length === 0) {
                    merged.keyPoints = compiledMember.keyPoints || [];
                }
                merged.aiCompiled = true;
                merged.processedAt = nowIso;
            }
            if (merged) {
                delete merged._hasAgentCompilation;
                mergedList.push(merged);
            }
        }
        annotatedCandidates = mergedList;
    } else {
        annotatedCandidates.forEach(item => {
            delete item._hasAgentCompilation;
        });
    }

    // 3. 若 compiledData 仅按去重后顺序提供 articles，或部分条目未命中中文翻译，确保最终列表全部拥有合规中文元数据
    const needFallbackChinese = annotatedCandidates.some(a => !aiService.isChineseText(a.translatedTitle || '') || !aiService.isChineseText(a.summary || ''));
    if (needFallbackChinese && opts.fallbackCompile) {
        annotatedCandidates = await aiService.ensureBatchInChinese(annotatedCandidates, 6);
    }

    const allEnhancedNews = annotatedCandidates.map(article => ({
        ...article,
        translatedTitle: article.translatedTitle || article.title,
        translatedDescription: article.translatedDescription || article.summary || article.description || article.title,
        summary: article.summary || article.translatedDescription || article.description || article.title,
        region: normalizeRegion(article.region, '国际'),
        category: normalizeCategory(article.category, '国际'),
        keyPoints: Array.isArray(article.keyPoints) ? article.keyPoints : [],
        aiCompiled: Boolean(article.aiCompiled || aiService.isChineseText(article.translatedTitle || '')),
        processedAt: article.processedAt || nowIso
    }));

    const finalNews = allEnhancedNews.slice(0, opts.limit);

    // 4. 构建《今日全球要闻深度综述》并渲染 [NEWS_k] 引用链接
    const currentDate = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'Asia/Shanghai'
    });

    let summaryArticle = null;
    const rawSummaryObj = (compiledData.summaryArticle && typeof compiledData.summaryArticle === 'object')
        ? compiledData.summaryArticle
        : ((compiledData.summary && typeof compiledData.summary === 'object') ? compiledData.summary : null);
    const rawSummaryMd = typeof compiledData.summaryMarkdown === 'string' && compiledData.summaryMarkdown.trim()
        ? compiledData.summaryMarkdown.trim()
        : (typeof compiledData.summaryArticle === 'string' && compiledData.summaryArticle.trim()
            ? compiledData.summaryArticle.trim()
            : (typeof compiledData.summary === 'string' && compiledData.summary.trim() ? compiledData.summary.trim() : ''));

    if (rawSummaryObj) {
        const content = rawSummaryObj.content || rawSummaryMd || '';
        const htmlContent = rawSummaryObj.htmlContent || aiService.convertSummaryToRichHtml(content, finalNews);
        summaryArticle = {
            title: rawSummaryObj.title || `${currentDate} 全球要闻深度综述`,
            content,
            htmlContent,
            newsCount: rawSummaryObj.newsCount || finalNews.length,
            regions: Array.isArray(rawSummaryObj.regions) && rawSummaryObj.regions.length > 0
                ? rawSummaryObj.regions
                : [...new Set(finalNews.map(n => n.region || '国际'))],
            generatedAt: rawSummaryObj.generatedAt || nowIso,
            summary: rawSummaryObj.summary || content.replace(/\[NEWS_\d+\]/g, '').replace(/#+\s*/g, '').trim().slice(0, 160),
            wordCount: rawSummaryObj.wordCount || content.length
        };
    } else if (rawSummaryMd.length > 0) {
        const firstLine = rawSummaryMd.split('\n').map(l => l.trim()).find(Boolean) || '';
        const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
            ? `${currentDate} 全球要闻深度综述\n\n${rawSummaryMd}`
            : rawSummaryMd;
        summaryArticle = aiService.createSummaryArticleObject(mdWithTitle, finalNews, currentDate);
    } else {
        summaryArticle = aiService._buildFallbackSummaryObject(finalNews, currentDate);
    }

    const sourceStats = harvestData.sourceStats || [];
    const publishedBy = String(
        customOptions.publishedBy ||
        customOptions.clientId ||
        compiledData?.publishedBy ||
        compiledData?.clientId ||
        opts.publishedBy ||
        opts.clientId ||
        process.env.CLIENT_ID ||
        process.env.AG_CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        os.hostname() ||
        'antigravity-client'
    ).trim();

    const snapshotPayload = {
        version: '2.0',
        publishedAt: nowIso,
        lastUpdated: nowIso,
        publishedBy,
        clientId: publishedBy,
        sourceCount: sourceStats.length,
        articleCount: finalNews.length,
        displayedCount: finalNews.length,
        totalPoolCount: allEnhancedNews.length,
        news: finalNews,
        allEnhancedNews,
        summary: summaryArticle,
        summaryArticle,
        sourceStats
    };

    if (opts.snapshotOut) {
        await writeJsonFile(opts.snapshotOut, snapshotPayload);
        logger.info('AG-PUBLISH', `已导出精编快照文件至: ${opts.snapshotOut}`);
    }

    // 5. 先完成本地持久化 (data/news.json, data/summary.json, data/state.json)，避免与本地服务端并发写盘竞争
    await writeJsonFile(config.storage.newsFile, {
        news: finalNews,
        lastUpdated: nowIso,
        total: finalNews.length
    });

    await writeJsonFile(config.storage.summaryFile, {
        article: summaryArticle,
        savedAt: nowIso,
        version: '2.0'
    });

    stateManager.set('collectionPhase', 'completed', false);
    stateManager.set('sourceStats', sourceStats, false);
    stateManager.set('lastPublishedBy', publishedBy, false);
    stateManager.updateNewsData(finalNews, allEnhancedNews);
    stateManager.updateSummaryArticle(summaryArticle);
    await stateManager.saveToFile(config.storage.stateFile);

    logger.info(
        'AG-PUBLISH',
        `本地数据文件已更新: news=${finalNews.length} 条 (总池 ${allEnhancedNews.length} 条), summary=${summaryArticle.wordCount} 字`
    );

    // 6. 方案 2B 默认开启：推送快照至 GitHub 独立分支 (默认 ag-snapshot)，供多客户端协同与内网软路由自动拉取同步
    let githubSyncResult = null;
    const isUnscopedTestRun =
        process.env.NODE_ENV === 'test' &&
        !opts.repoDir &&
        !opts.skipGitPush &&
        process.env.GITHUB_PUSH_ENABLED !== 'true';

    if (shouldPushToGithub && !isUnscopedTestRun) {
        try {
            githubSyncResult = publishSnapshotToGitHub(snapshotPayload, {
                branch: opts.githubBranch,
                remote: opts.githubRemote,
                repoDir: opts.repoDir,
                skipPush: Boolean(opts.skipGitPush),
                publishedBy,
                clientId: publishedBy
            });
            logger.success(
                'AG-PUBLISH',
                `已发布精编快照至 GitHub 分支 ${githubSyncResult.branch} (commit=${githubSyncResult.commitSha.slice(0, 8)}, pushed=${githubSyncResult.pushed}, by=${publishedBy})`
            );
        } catch (gitErr) {
            if (hasExplicitGithubOpt || opts.repoDir) {
                throw gitErr;
            }
            logger.warn('AG-PUBLISH', `推送快照至 GitHub 跳过或失败 (${gitErr.message})，继续执行本地与目标站点发布`);
            githubSyncResult = {
                success: false,
                skipped: true,
                error: gitErr.message
            };
        }
    }

    // 7. 通过 HTTP POST 推送至网站 /api/agent/publish 接口
    let remoteResponse = null;
    if (!opts.localOnly && opts.target) {
        const cleanTarget = opts.target.replace(/\/+$/, '');
        const publishUrl = cleanTarget.endsWith('/api/agent/publish')
            ? cleanTarget
            : `${cleanTarget}/api/agent/publish`;

        const headers = { 'Content-Type': 'application/json' };
        if (opts.secret) {
            headers['Authorization'] = `Bearer ${opts.secret}`;
            headers['X-Publish-Secret'] = opts.secret;
            headers['x-api-key'] = opts.secret;
        }

        try {
            const response = await axios.post(
                publishUrl,
                {
                    news: finalNews,
                    allEnhancedNews,
                    summary: summaryArticle,
                    summaryArticle,
                    sourceStats,
                    publishedAt: nowIso,
                    lastUpdated: nowIso,
                    publishedBy,
                    clientId: publishedBy
                },
                {
                    headers,
                    timeout: 20000,
                    httpsAgent: httpsAgentIgnoreTls
                }
            );

            remoteResponse = response.data;
            logger.success('AG-PUBLISH', `成功推送至网站 ${publishUrl}:`, remoteResponse);
        } catch (httpErr) {
            if ((githubSyncResult?.success || opts.syncedFromGithub) && !opts.targetExplicit && httpErr.code === 'ECONNREFUSED') {
                logger.info('AG-PUBLISH', `本地服务 ${publishUrl} 未运行，已完成 GitHub 快照同步/发布`);
            } else {
                throw httpErr;
            }
        }
    }

    return {
        success: true,
        displayedCount: finalNews.length,
        totalPoolCount: allEnhancedNews.length,
        summaryArticle,
        publishedAt: nowIso,
        lastUpdated: nowIso,
        publishedBy,
        clientId: publishedBy,
        snapshotOut: opts.snapshotOut || null,
        githubSync: githubSyncResult,
        remoteResponse
    };
}

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
    runPublish(cliOpts)
        .then(() => process.exit(0))
        .catch(err => {
            const status = err.response?.status ? ` (HTTP ${err.response.status})` : '';
            const detail = err.response?.data?.message || err.message;
            console.error(`[AG-PUBLISH] 发布失败${status}:`, detail);
            process.exit(1);
        });
}

module.exports = { runPublish, parseArgs };
