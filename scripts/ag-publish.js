#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Antigravity 大模型精编产物校验、跨源归并与快照发布工具 (scripts/ag-publish.js)
 *
 * 设计原则：
 *   本脚本不包含任何机器翻译、规则打分或模板综述兜底逻辑！
 *   严格接收由 Antigravity 客户端内置大模型全流程完成的编译产物 `data/ag_compiled.json`：
 *   1. 按大模型选定的精选顺序合并原始候选元数据，并根据 `mergedIndices` / `duplicateGroups` 归并同事件跨媒链接 (`relatedSources`)；
 *   2. 严格校验每篇入选报道均具备大模型精编的中文标题、中文导语摘要、核心看点与全文中文译文段落 (`translatedParagraphs`)，以及今日《全球要闻深度综述》；
 *   3. 将综述中的 `[NEWS_k]` 引用渲染为可点击 HTML 锚点，更新本地 `data/*.json`；
 *   4. 通过 Git Plumbing 零污染推送单文件快照至 GitHub `ag-snapshot/latest.json`（可选同步直推 `/api/agent/publish`）。
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
const stateManager = require('../services/state_manager');
const { publishSnapshotToGitHub } = require('../utils/github_sync');
const {
    hasChineseText,
    normalizeRegion,
    normalizeCategory,
    splitTextIntoParagraphs,
    mergeClusterArticles,
    convertSummaryToRichHtml,
    createSummaryArticleObject
} = require('../utils/editorial_formatter');

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
    return Boolean(config.githubSync?.pushEnabled ?? true);
}

function parseArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const options = {
        candidates: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        compiled: process.env.AG_COMPILED_FILE || path.join(config.storage.dataDir, 'ag_compiled.json'),
        target: process.env.COREFEED_SITE_URL || `http://localhost:${config.server.port || 3120}`,
        targetExplicit: false,
        secret: process.env.PUBLISH_SECRET || config.agent.publishSecret || '',
        limit: config.agent.maxCuratedArticles || 30,
        localOnly: false,
        pushToGithub: resolveDefaultPushToGithub(),
        githubExplicit: false,
        githubBranch: process.env.AG_GITHUB_BRANCH || config.githubSync?.branch || 'ag-snapshot',
        githubRemote: process.env.AG_GITHUB_REMOTE || config.githubSync?.remote || 'origin',
        repoDir: null,
        skipGitPush: false,
        snapshotOut: null,
        clientId: process.env.CLIENT_ID || process.env.AG_CLIENT_ID || config.githubSync?.clientId || ''
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--candidates' && argv[i + 1]) {
            options.candidates = path.resolve(argv[++i]);
        } else if (arg.startsWith('--candidates=')) {
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
        } else if (arg === '--local-only') {
            options.localOnly = true;
        } else if (arg === '--github' || arg === '--push-github') {
            options.pushToGithub = true;
            options.githubExplicit = true;
        } else if (arg === '--no-github') {
            options.pushToGithub = false;
            options.githubExplicit = true;
        } else if ((arg === '--branch' || arg === '--github-branch') && argv[i + 1]) {
            options.githubBranch = argv[++i];
        } else if (arg.startsWith('--branch=') || arg.startsWith('--github-branch=')) {
            options.githubBranch = eqVal(arg);
        } else if ((arg === '--remote' || arg === '--github-remote') && argv[i + 1]) {
            options.githubRemote = argv[++i];
        } else if (arg.startsWith('--remote=') || arg.startsWith('--github-remote=')) {
            options.githubRemote = eqVal(arg);
        } else if (arg === '--repo-dir' && argv[i + 1]) {
            options.repoDir = path.resolve(argv[++i]);
        } else if (arg.startsWith('--repo-dir=')) {
            options.repoDir = path.resolve(eqVal(arg));
        } else if (arg === '--skip-git-push') {
            options.skipGitPush = true;
        } else if (arg === '--snapshot-out' && argv[i + 1]) {
            options.snapshotOut = path.resolve(argv[++i]);
        } else if (arg.startsWith('--snapshot-out=')) {
            options.snapshotOut = path.resolve(eqVal(arg));
        } else if ((arg === '--client-id' || arg === '--published-by') && argv[i + 1]) {
            options.clientId = argv[++i];
        } else if (arg.startsWith('--client-id=') || arg.startsWith('--published-by=')) {
            options.clientId = eqVal(arg);
        }
    }

    options.githubSync = options.pushToGithub;
    options.github = options.pushToGithub;
    options.publishedBy = options.clientId;

    return options;
}

function createValidationError(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
}

/**
 * 校验单篇大模型精编文章是否满足全中文精编契约（严禁未翻译生肉或空字段混入快照）
 */
function validateCompiledArticle(article, position) {
    const label = `第 ${position} 篇 (${article.id || article.url || 'unknown'})`;
    if (!hasChineseText(article.translatedTitle, 2)) {
        throw createValidationError(`${label} 缺少由大模型精编的中文标题 (translatedTitle): "${article.translatedTitle || ''}"`);
    }
    if (!hasChineseText(article.summary, 6)) {
        throw createValidationError(`${label} 缺少由大模型撰写的中文导语摘要 (summary)`);
    }
    if (!Array.isArray(article.keyPoints) || article.keyPoints.length === 0 || !article.keyPoints.every(kp => hasChineseText(kp, 2))) {
        throw createValidationError(`${label} 缺少由大模型提取的中文核心看点数组 (keyPoints)`);
    }
    if (!Array.isArray(article.translatedParagraphs) || article.translatedParagraphs.length === 0 || !article.translatedParagraphs.some(p => hasChineseText(p, 4))) {
        throw createValidationError(`${label} 缺少由大模型翻译的全文中文段落数组 (translatedParagraphs)`);
    }
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

    const compiledData = await readJsonFile(opts.compiled, null);
    if (!compiledData || typeof compiledData !== 'object') {
        throw createValidationError(
            `缺少大模型精编产物文件: ${opts.compiled}。请先在 Antigravity 客户端运行 /corefeed-editor 技能由内置大模型完成选稿、全文精译与综述撰写。`
        );
    }

    const harvestData = await readJsonFile(opts.candidates, null);
    const rawCandidates = Array.isArray(harvestData?.fullCandidates)
        ? harvestData.fullCandidates
        : (Array.isArray(compiledData.fullCandidates) ? compiledData.fullCandidates : []);

    const rawTimestamp = customOptions.publishedAt || compiledData.publishedAt || compiledData.lastUpdated || null;
    const parsedTs = rawTimestamp ? new Date(rawTimestamp) : new Date();
    const nowIso = isNaN(parsedTs.getTime()) ? new Date().toISOString() : parsedTs.toISOString();

    // 构建原始候选集映射表 (支持 id 与 1-based index 查找)
    const rawById = new Map();
    const rawByOneBasedIndex = new Map();
    rawCandidates.forEach((cand, idx) => {
        if (!cand || typeof cand !== 'object') return;
        const oneBased = Number(cand.index) || idx + 1;
        rawByOneBasedIndex.set(oneBased, cand);
        if (cand.id) rawById.set(String(cand.id), cand);
    });

    // 若顶层提供了 duplicateGroups (例如 [[1, 14, 27], [3, 19]])，使用并查集预计算每个原始序号所属的同事件簇
    const ufClusters = new Map();
    const rawGroups = Array.isArray(compiledData.duplicateGroups) ? compiledData.duplicateGroups : [];
    if (rawGroups.length > 0 && rawCandidates.length > 1) {
        const n = rawCandidates.length;
        const parent = Array.from({ length: n + 1 }, (_, i) => i);
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
            const validOneBased = grp
                .map(v => parseInt(String(v).replace(/\D+/g, ''), 10))
                .filter(idx => !isNaN(idx) && idx >= 1 && idx <= n);
            if (validOneBased.length >= 2) {
                const first = validOneBased[0];
                for (let k = 1; k < validOneBased.length; k++) {
                    union(first, validOneBased[k]);
                }
            }
        }

        for (let i = 1; i <= n; i++) {
            const root = find(i);
            if (!ufClusters.has(root)) ufClusters.set(root, []);
            ufClusters.get(root).push(i);
        }
    }

    const findRootGroupIndices = (oneBasedIdx) => {
        if (!oneBasedIdx || ufClusters.size === 0) return [];
        for (const members of ufClusters.values()) {
            if (members.includes(oneBasedIdx)) return members;
        }
        return [];
    };

    const rawEntryList = Array.isArray(compiledData.articles) && compiledData.articles.length > 0
        ? compiledData.articles
        : (Array.isArray(compiledData.news) && compiledData.news.length > 0 ? compiledData.news : null);

    if (!rawEntryList || rawEntryList.length === 0) {
        throw createValidationError(`${opts.compiled} 中缺少有效的 articles 精编新闻数组`);
    }

    // 仅按大模型选定的精编条目与顺序组装发布列表（未入选的原始候选绝不混入），并对同一并查集簇去重
    const consumedClusterRoots = new Set();
    const curatedArticles = [];

    for (let i = 0; i < rawEntryList.length; i++) {
        const comp = rawEntryList[i];
        if (!comp || typeof comp !== 'object') continue;

        const lookupIndex = typeof comp.candidateIndex === 'number'
            ? comp.candidateIndex
            : (typeof comp.index === 'number' ? comp.index : null);

        const baseCand = (comp.id && rawById.get(String(comp.id))) ||
            (lookupIndex && rawByOneBasedIndex.get(lookupIndex)) ||
            null;

        const resolvedOneBased = lookupIndex ||
            (baseCand ? (Number(baseCand.index) || rawCandidates.indexOf(baseCand) + 1) : null);

        const ufGroupMembers = resolvedOneBased ? findRootGroupIndices(resolvedOneBased) : [];
        if (ufGroupMembers.length > 1) {
            const rootKey = ufGroupMembers[0];
            if (consumedClusterRoots.has(rootKey)) {
                continue;
            }
            consumedClusterRoots.add(rootKey);
        }

        // 收集大模型标注的同事件关联报道 (mergedIndices / mergedIds / duplicateGroups)
        const companionList = [];
        const explicitMergedIndices = Array.isArray(comp.mergedIndices) ? comp.mergedIndices : [];
        const explicitMergedIds = Array.isArray(comp.mergedIds) ? comp.mergedIds : [];

        for (const mIdx of [...ufGroupMembers, ...explicitMergedIndices]) {
            const num = parseInt(String(mIdx).replace(/\D+/g, ''), 10);
            if (!isNaN(num) && num !== resolvedOneBased && rawByOneBasedIndex.has(num)) {
                companionList.push(rawByOneBasedIndex.get(num));
            }
        }
        for (const mId of explicitMergedIds) {
            if (mId && String(mId) !== String(baseCand?.id || comp.id || '') && rawById.has(String(mId))) {
                companionList.push(rawById.get(String(mId)));
            }
        }

        const baseMerged = mergeClusterArticles(baseCand || comp, companionList);
        const zhTitle = String(comp.translatedTitle || comp.title || '').trim();
        const zhSummary = String(comp.summary || comp.translatedDescription || '').trim();
        const keyPoints = Array.isArray(comp.keyPoints)
            ? comp.keyPoints.map(k => String(k).trim()).filter(Boolean).slice(0, 4)
            : [];
        const translatedParagraphs = Array.isArray(comp.translatedParagraphs) && comp.translatedParagraphs.length > 0
            ? comp.translatedParagraphs.map(p => String(p).trim()).filter(Boolean)
            : (comp.translatedContent ? splitTextIntoParagraphs(String(comp.translatedContent)) : []);
        const translatedContent = String(comp.translatedContent || translatedParagraphs.join('\n\n')).trim();

        const rawFull = String(comp.fullText || baseMerged?.fullText || baseMerged?.content || baseMerged?.description || '').trim();
        const originalParagraphs = Array.isArray(comp.originalParagraphs) && comp.originalParagraphs.length > 0
            ? comp.originalParagraphs.map(p => String(p).trim()).filter(Boolean)
            : (Array.isArray(baseMerged?.originalParagraphs) && baseMerged.originalParagraphs.length > 0
                ? baseMerged.originalParagraphs
                : splitTextIntoParagraphs(rawFull));

        const sourceObj = (comp.source && typeof comp.source === 'object')
            ? comp.source
            : (baseMerged?.source && typeof baseMerged.source === 'object'
                ? baseMerged.source
                : {
                    id: 'global',
                    name: String(comp.sourceName || comp.source || 'Global Media').trim()
                });

        const assembled = {
            ...(baseMerged || {}),
            id: comp.id || baseMerged?.id || `ag-${Date.now()}-${i + 1}`,
            title: String(baseCand?.title || comp.originalTitle || comp.title || zhTitle).trim(),
            description: String(baseCand?.description || comp.description || zhSummary).trim(),
            content: String(baseCand?.content || rawFull || zhSummary).trim(),
            fullText: rawFull,
            originalParagraphs,
            translatedTitle: zhTitle,
            translatedDescription: zhSummary,
            summary: zhSummary,
            translatedParagraphs,
            translatedContent,
            url: comp.url || baseMerged?.url || '',
            urlToImage: comp.urlToImage || baseMerged?.urlToImage || null,
            publishedAt: comp.publishedAt || baseMerged?.publishedAt || nowIso,
            processedAt: nowIso,
            region: normalizeRegion(comp.region, baseMerged?.region || '国际'),
            category: normalizeCategory(comp.category, baseMerged?.category || '国际'),
            keyPoints,
            aiCompiled: true,
            source: sourceObj,
            relatedSources: Array.isArray(comp.relatedSources) && comp.relatedSources.length > (baseMerged?.relatedSources?.length || 0)
                ? comp.relatedSources
                : (baseMerged?.relatedSources || []),
            sourceCount: 1 + (
                Array.isArray(comp.relatedSources) && comp.relatedSources.length > (baseMerged?.relatedSources?.length || 0)
                    ? comp.relatedSources.length
                    : (baseMerged?.relatedSources?.length || 0)
            )
        };

        validateCompiledArticle(assembled, curatedArticles.length + 1);
        curatedArticles.push(assembled);
    }

    if (curatedArticles.length === 0) {
        throw createValidationError('未能从精编产物中解析出任何有效中文报道');
    }

    const finalNews = curatedArticles.slice(0, opts.limit);

    // 校验并渲染由大模型撰写的《今日全球要闻深度综述》
    const currentDate = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'Asia/Shanghai'
    });

    const rawSummaryObj = (compiledData.summaryArticle && typeof compiledData.summaryArticle === 'object')
        ? compiledData.summaryArticle
        : ((compiledData.summary && typeof compiledData.summary === 'object') ? compiledData.summary : null);
    const rawSummaryMd = typeof compiledData.summaryMarkdown === 'string' && compiledData.summaryMarkdown.trim()
        ? compiledData.summaryMarkdown.trim()
        : (typeof compiledData.summaryArticle === 'string' && compiledData.summaryArticle.trim()
            ? compiledData.summaryArticle.trim()
            : (typeof compiledData.summary === 'string' && compiledData.summary.trim() ? compiledData.summary.trim() : ''));

    let summaryArticle = null;
    if (rawSummaryObj) {
        const content = String(rawSummaryObj.content || rawSummaryObj.markdown || rawSummaryMd || '').trim();
        const htmlContent = rawSummaryObj.htmlContent && !content.includes('[NEWS_')
            ? rawSummaryObj.htmlContent
            : (content ? convertSummaryToRichHtml(content, finalNews) : (rawSummaryObj.htmlContent || ''));
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
        summaryArticle = createSummaryArticleObject(mdWithTitle, finalNews, currentDate);
    }

    if (!summaryArticle || !hasChineseText(summaryArticle.content || summaryArticle.htmlContent || '', 10)) {
        throw createValidationError('缺少由大模型撰写的中文《全球要闻深度综述》(summaryArticle / summaryMarkdown)');
    }

    const sourceStats = harvestData?.sourceStats || compiledData.sourceStats || [];
    const publishedBy = String(
        customOptions.publishedBy ||
        customOptions.clientId ||
        compiledData?.publishedBy ||
        compiledData?.clientId ||
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
        totalPoolCount: curatedArticles.length,
        news: finalNews,
        allEnhancedNews: curatedArticles,
        summary: summaryArticle,
        summaryArticle,
        sourceStats
    };

    if (opts.snapshotOut) {
        await writeJsonFile(opts.snapshotOut, snapshotPayload);
        logger.info('AG-PUBLISH', `已导出精编快照文件至: ${opts.snapshotOut}`);
    }

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
    stateManager.updateNewsData(finalNews, curatedArticles);
    stateManager.updateSummaryArticle(summaryArticle);
    await stateManager.saveToFile(config.storage.stateFile);

    logger.info(
        'AG-PUBLISH',
        `本地数据文件已更新: news=${finalNews.length} 条 (精选池 ${curatedArticles.length} 条), summary=${summaryArticle.wordCount} 字`
    );

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
                `已发布大模型精编快照至 GitHub 分支 ${githubSyncResult.branch} (commit=${githubSyncResult.commitSha.slice(0, 8)}, pushed=${githubSyncResult.pushed}, by=${publishedBy})`
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
                    allEnhancedNews: curatedArticles,
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
            if (githubSyncResult?.success && !opts.targetExplicit && httpErr.code === 'ECONNREFUSED') {
                logger.info('AG-PUBLISH', `本地服务 ${publishUrl} 未运行，已完成 GitHub 快照发布`);
            } else {
                throw httpErr;
            }
        }
    }

    return {
        success: true,
        displayedCount: finalNews.length,
        totalPoolCount: curatedArticles.length,
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

module.exports = { runPublish, parseArgs, validateCompiledArticle };
