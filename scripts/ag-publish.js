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
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');
const { getHttpsAgent } = require('../utils/network_config');
const stateManager = require('../services/state_manager');
const {
    publishSnapshotToGitHub,
    fetchRemoteSnapshotViaGit
} = require('../utils/snapshot_publisher');
const {
    GitHubSyncManager,
    isSuspectedTestFixtureNews
} = require('../utils/github_sync');
const { SocialPulseService, normalizeSocialPulseBundle } = require('../services/social_pulse_service');
const { AudioBroadcastService, normalizeAudioBroadcastBundle } = require('../services/audio_broadcast_service');
const {
    hasChineseText,
    normalizeRegion,
    normalizeCategory,
    splitTextIntoParagraphs,
    mergeClusterArticles,
    renderSafeSummaryHtml,
    stripNewsCitationsAndMarkdown,
    createSummaryArticleObject
} = require('../utils/editorial_formatter');
const {
    inspectCompiledArticle,
    validateCompiledBundle,
    formatValidationReport
} = require('../utils/compiled_validator');
const {
    splitCandidateParagraphs,
    stripArticleForSnapshot
} = require('../utils/snapshot_schema');

function computeNewsEditionId(finalNews = [], summaryArticle = null) {
    const parts = (Array.isArray(finalNews) ? finalNews : [])
        .map((a, idx) => `${idx + 1}|${a?.id || a?.url || ''}|${a?.translatedTitle || a?.title || ''}`);
    parts.push(`summary|${summaryArticle?.title || ''}`);
    return `ed-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12)}`;
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
        validateOnly: false,
        strict: false,
        ignoreHarvestId: false,
        force: false,
        cooldownMinutes: Number(config.githubSync?.cooldownMinutes ?? 30),
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
        } else if (arg === '--validate' || arg === '--check') {
            options.validateOnly = true;
        } else if (arg === '--strict') {
            options.strict = true;
        } else if (arg === '--ignore-harvest-id') {
            options.ignoreHarvestId = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--cooldown' && argv[i + 1] !== undefined) {
            const parsedCd = parseInt(argv[++i], 10);
            if (!isNaN(parsedCd) && parsedCd >= 0) options.cooldownMinutes = parsedCd;
        } else if (arg.startsWith('--cooldown=')) {
            const parsedCd = parseInt(eqVal(arg), 10);
            if (!isNaN(parsedCd) && parsedCd >= 0) options.cooldownMinutes = parsedCd;
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

function createValidationError(message, details = null) {
    const err = new Error(message);
    err.statusCode = 400;
    if (details) err.validationReport = details;
    return err;
}

/**
 * 校验单篇大模型精编文章是否满足全中文精编契约（严禁未翻译生肉或空字段混入快照）
 */
function validateCompiledArticle(article, position, context = {}) {
    const { errors } = inspectCompiledArticle(article, position, context);
    if (errors.length > 0) {
        throw createValidationError(errors[0]);
    }
}

/**
 * 根据本期新闻 editionId 过滤本地/远端音频轨道（Q2=A：剔除过期的 tracks.news，保留独立周期的 tracks.pulse）
 */
function resolveEditionMatchedAudio({ localAudio, remoteSnap, editionId }) {
    const tracks = {};
    let droppedStaleNewsAudio = false;
    let staleNewsAudioReason = null;

    const localNewsTrack = localAudio?.tracks?.news || null;
    const remoteNewsTrack = remoteSnap?.audioBroadcast?.tracks?.news || null;

    if (localNewsTrack) {
        if (localNewsTrack.editionId && localNewsTrack.editionId !== editionId) {
            droppedStaleNewsAudio = true;
            staleNewsAudioReason = `local news audio editionId=${localNewsTrack.editionId} !== ${editionId}`;
            logger.warn(
                'AG-PUBLISH',
                `检测到本地新闻播音 editionId=${localNewsTrack.editionId} 与本期新闻 ${editionId} 不匹配，已自动剔除过期新闻音轨（保留社媒音轨）`
            );
        } else {
            tracks.news = localNewsTrack;
        }
    } else if (remoteNewsTrack) {
        if (remoteNewsTrack.editionId && remoteNewsTrack.editionId === editionId) {
            tracks.news = remoteNewsTrack;
            logger.info('AG-PUBLISH', `远端新闻播音与本期 ${editionId} 一致，已继承保留 tracks.news`);
        } else {
            droppedStaleNewsAudio = true;
            staleNewsAudioReason = `remote news audio editionId=${remoteNewsTrack.editionId || '<legacy>'} !== ${editionId}`;
            logger.info(
                'AG-PUBLISH',
                `远端 tracks.news (${remoteNewsTrack.editionId || '无 editionId'}) 属于旧期次新闻，本期未继承以免声画错配`
            );
        }
    }

    const pulseTrack = localAudio?.tracks?.pulse || remoteSnap?.audioBroadcast?.tracks?.pulse || null;
    if (pulseTrack) {
        tracks.pulse = pulseTrack;
    }

    const effectiveAudio = Object.keys(tracks).length > 0
        ? normalizeAudioBroadcastBundle({
            updatedAt: localAudio?.updatedAt || remoteSnap?.audioBroadcastUpdatedAt || remoteSnap?.audioBroadcast?.updatedAt || new Date().toISOString(),
            tracks
        })
        : null;

    return {
        effectiveAudio,
        droppedStaleNewsAudio,
        staleNewsAudioReason
    };
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
    if (customOptions.target && customOptions.targetExplicit !== false) {
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
    const articleContexts = [];
    const preAssemblyErrors = [];
    let duplicateSkippedCount = 0;

    for (let i = 0; i < rawEntryList.length; i++) {
        const comp = rawEntryList[i];
        if (!comp || typeof comp !== 'object') {
            preAssemblyErrors.push(`第 ${i + 1} 条精编记录不是有效对象`);
            continue;
        }

        const lookupIndex = typeof comp.candidateIndex === 'number'
            ? comp.candidateIndex
            : (typeof comp.index === 'number' ? comp.index : null);

        const candByIndex = lookupIndex !== null ? (rawByOneBasedIndex.get(lookupIndex) || null) : null;
        const candById = comp.id ? (rawById.get(String(comp.id)) || null) : null;

        if (lookupIndex !== null && rawCandidates.length > 0) {
            if (!candByIndex) {
                preAssemblyErrors.push(
                    `第 ${i + 1} 篇指定的 candidateIndex=${lookupIndex} 在候选池中越界或不存在（有效范围 1..${rawCandidates.length}）`
                );
            } else if (comp.id && candByIndex.id && String(candByIndex.id) !== String(comp.id)) {
                preAssemblyErrors.push(
                    `第 ${i + 1} 篇 id="${comp.id}" 与 candidateIndex=${lookupIndex} 对应候选 id="${candByIndex.id}" 不匹配（疑似候选池已发生重采位移）`
                );
            }
        }

        const baseCand = candById || candByIndex || null;

        const resolvedOneBased = lookupIndex ||
            (baseCand ? (Number(baseCand.index) || rawCandidates.indexOf(baseCand) + 1) : null);

        const ufGroupMembers = resolvedOneBased ? findRootGroupIndices(resolvedOneBased) : [];
        if (ufGroupMembers.length > 1) {
            const rootKey = ufGroupMembers[0];
            if (consumedClusterRoots.has(rootKey)) {
                duplicateSkippedCount++;
                continue;
            }
            consumedClusterRoots.add(rootKey);
        }

        // 收集大模型标注的同事件关联报道 (mergedIndices / mergedIds / duplicateGroups)
        const companionList = [];
        const explicitMergedIndices = Array.isArray(comp.mergedIndices) ? comp.mergedIndices : [];
        const explicitMergedIds = Array.isArray(comp.mergedIds) ? comp.mergedIds : [];
        const normalizedExplicitMerged = [];

        for (const mIdx of explicitMergedIndices) {
            const num = parseInt(String(mIdx).replace(/\D+/g, ''), 10);
            if (!isNaN(num)) {
                if (rawCandidates.length > 0 && !rawByOneBasedIndex.has(num)) {
                    preAssemblyErrors.push(`第 ${i + 1} 篇 mergedIndices 包含越界序号 ${num}`);
                } else if (num !== resolvedOneBased) {
                    normalizedExplicitMerged.push(num);
                }
            }
        }

        for (const mIdx of [...ufGroupMembers, ...normalizedExplicitMerged]) {
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

        const rawFull = String(comp.fullText || baseMerged?.fullText || baseMerged?.content || baseMerged?.description || '').trim();
        const candParagraphs = Array.isArray(baseCand?.paragraphs) && baseCand.paragraphs.length > 0
            ? baseCand.paragraphs
            : (Array.isArray(baseMerged?.paragraphs) && baseMerged.paragraphs.length > 0
                ? baseMerged.paragraphs
                : splitCandidateParagraphs(rawFull, baseCand?.source?.language || baseMerged?.source?.language || 'en'));

        let keepResolvedParagraphs = [];
        if (Array.isArray(comp.keepParagraphs)) {
            if (comp.keepParagraphs.length === 0 && (!Array.isArray(comp.originalParagraphs) || comp.originalParagraphs.length === 0)) {
                preAssemblyErrors.push(`第 ${i + 1} 篇 keepParagraphs 不能为空数组`);
            } else {
                const seenParaIdx = new Set();
                for (const rawP of comp.keepParagraphs) {
                    const pNum = typeof rawP === 'number' ? rawP : (/^\d+$/.test(String(rawP).trim()) ? parseInt(String(rawP).trim(), 10) : NaN);
                    if (!Number.isInteger(pNum) || pNum < 1 || pNum > candParagraphs.length) {
                        preAssemblyErrors.push(
                            `第 ${i + 1} 篇 keepParagraphs 包含越界或非法段号 ${JSON.stringify(rawP)}（候选原文有效范围 1..${candParagraphs.length}）`
                        );
                    } else if (!seenParaIdx.has(pNum)) {
                        seenParaIdx.add(pNum);
                        keepResolvedParagraphs.push(candParagraphs[pNum - 1]);
                    }
                }
            }
        }

        const originalParagraphs = Array.isArray(comp.originalParagraphs) && comp.originalParagraphs.length > 0
            ? comp.originalParagraphs.map(p => String(p).trim()).filter(Boolean)
            : (keepResolvedParagraphs.length > 0
                ? keepResolvedParagraphs
                : (Array.isArray(baseMerged?.originalParagraphs) && baseMerged.originalParagraphs.length > 0
                    ? baseMerged.originalParagraphs
                    : splitTextIntoParagraphs(rawFull)));

        const sourceObj = (comp.source && typeof comp.source === 'object')
            ? comp.source
            : (baseMerged?.source && typeof baseMerged.source === 'object'
                ? baseMerged.source
                : {
                    id: 'global',
                    name: String(comp.sourceName || comp.source || 'Global Media').trim()
                });

        const relatedSources = Array.isArray(comp.relatedSources) && comp.relatedSources.length > (baseMerged?.relatedSources?.length || 0)
            ? comp.relatedSources
            : (baseMerged?.relatedSources || []);

        const assembled = stripArticleForSnapshot({
            id: comp.id || baseMerged?.id || `ag-${Date.now()}-${i + 1}`,
            title: String(baseCand?.title || comp.originalTitle || comp.title || zhTitle).trim(),
            translatedTitle: zhTitle,
            summary: zhSummary,
            originalParagraphs,
            translatedParagraphs,
            keyPoints,
            url: comp.url || baseMerged?.url || '',
            urlToImage: comp.urlToImage || baseMerged?.urlToImage || null,
            publishedAt: comp.publishedAt || baseMerged?.publishedAt || nowIso,
            processedAt: nowIso,
            region: normalizeRegion(comp.region, baseMerged?.region || '国际'),
            category: normalizeCategory(comp.category, baseMerged?.category || '国际'),
            aiCompiled: true,
            qualityScore: Number(comp.qualityScore || baseMerged?.qualityScore) || 88,
            source: sourceObj,
            relatedSources,
            sourceCount: 1 + relatedSources.length
        }, i, nowIso);

        curatedArticles.push(assembled);
        articleContexts.push({
            rawComp: comp,
            baseCand,
            assembled,
            resolvedOneBased,
            explicitMergedIndices: normalizedExplicitMerged
        });
    }

    const finalNews = curatedArticles.slice(0, opts.limit);

    // 组装并渲染由大模型撰写的《今日全球要闻深度综述》
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
        const htmlContent = renderSafeSummaryHtml({ ...rawSummaryObj, content }, finalNews);
        summaryArticle = {
            title: rawSummaryObj.title || `${currentDate} 全球要闻深度综述`,
            content,
            htmlContent,
            newsCount: rawSummaryObj.newsCount || finalNews.length,
            regions: Array.isArray(rawSummaryObj.regions) && rawSummaryObj.regions.length > 0
                ? rawSummaryObj.regions
                : [...new Set(finalNews.map(n => n.region || '国际'))],
            generatedAt: rawSummaryObj.generatedAt || nowIso,
            summary: rawSummaryObj.summary || stripNewsCitationsAndMarkdown(content, 160),
            wordCount: rawSummaryObj.wordCount || content.length
        };
    } else if (rawSummaryMd.length > 0) {
        const firstLine = rawSummaryMd.split('\n').map(l => l.trim()).find(Boolean) || '';
        const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
            ? `${currentDate} 全球要闻深度综述\n\n${rawSummaryMd}`
            : rawSummaryMd;
        summaryArticle = createSummaryArticleObject(mdWithTitle, finalNews, currentDate);
    }

    // 聚合全量契约校验（一次性输出全部 errors 与 warnings）
    const validationReport = validateCompiledBundle({
        compiledData,
        harvestData,
        rawEntries: rawEntryList,
        preAssemblyErrors,
        curatedArticles,
        finalNews,
        articleContexts: articleContexts.slice(0, opts.limit),
        summaryArticle,
        duplicateSkippedCount,
        options: {
            strict: Boolean(opts.strict),
            ignoreHarvestId: Boolean(opts.ignoreHarvestId)
        }
    });

    if (opts.validateOnly) {
        return {
            success: validationReport.valid,
            validateOnly: true,
            editionId: validationReport.valid ? (String(compiledData.editionId || '').trim() || computeNewsEditionId(finalNews, summaryArticle)) : null,
            validation: validationReport,
            reportText: formatValidationReport(validationReport)
        };
    }

    if (!validationReport.valid) {
        throw createValidationError(formatValidationReport(validationReport), validationReport);
    }

    if (validationReport.warnings.length > 0) {
        logger.warn('AG-PUBLISH', formatValidationReport(validationReport));
    }

    const editionId = String(compiledData.editionId || '').trim() || computeNewsEditionId(finalNews, summaryArticle);
    const harvestId = String(compiledData.harvestId || harvestData?.harvestId || '').trim() || null;

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

    if (
        process.env.NODE_ENV !== 'test' &&
        shouldPushToGithub &&
        isSuspectedTestFixtureNews(finalNews)
    ) {
        throw createValidationError('检测到疑似自动化单元测试夹具条目，已拦截向远端 ag-snapshot 推送以防覆盖线上新闻');
    }

    const socialPulseService = new SocialPulseService(null, stateManager);
    let existingPulse = null;
    if (customOptions.socialPulse) {
        existingPulse = normalizeSocialPulseBundle(customOptions.socialPulse);
        if (existingPulse) {
            await socialPulseService.saveBundle(existingPulse, { emit: false });
        }
    } else if (compiledData.socialPulse) {
        existingPulse = normalizeSocialPulseBundle(compiledData.socialPulse);
        if (existingPulse) {
            await socialPulseService.saveBundle(existingPulse, { emit: false });
        }
    } else if (process.env.NODE_ENV !== 'test') {
        existingPulse = await socialPulseService.syncFromExternalWorkspace({ emit: false });
        if (!existingPulse) {
            existingPulse = await socialPulseService.loadLocalBundle();
        }
    } else {
        existingPulse = await socialPulseService.loadLocalBundle();
        if (existingPulse) {
            stateManager.updateSocialPulse(existingPulse);
        }
    }

    const audioBroadcastService = new AudioBroadcastService(null, stateManager);
    let localAudio = null;
    if (customOptions.audioBroadcast) {
        localAudio = normalizeAudioBroadcastBundle(customOptions.audioBroadcast);
        if (localAudio) {
            await audioBroadcastService.saveBundle(localAudio, { emit: false });
        }
    } else if (compiledData.audioBroadcast) {
        localAudio = normalizeAudioBroadcastBundle(compiledData.audioBroadcast);
        if (localAudio) {
            await audioBroadcastService.saveBundle(localAudio, { emit: false });
        }
    } else {
        localAudio = await audioBroadcastService.loadLocalBundle();
    }

    const isUnscopedTestRun =
        process.env.NODE_ENV === 'test' &&
        !opts.repoDir &&
        !opts.skipGitPush;

    // 从远端 Git 权威分支获取当前 HEAD SHA 与最新快照（供多客户端冷却复查、pulse 继承及 --force-with-lease 使用）
    let remoteGitInfo = null;
    let remoteSnap = null;
    const repoDir = opts.repoDir || path.resolve(__dirname, '..');
    const gitBranch = opts.githubBranch || 'ag-snapshot';
    const gitRemote = opts.githubRemote || 'origin';

    if (shouldPushToGithub && !isUnscopedTestRun) {
        remoteGitInfo = fetchRemoteSnapshotViaGit({
            repoDir,
            remote: gitRemote,
            branch: gitBranch,
            skipFetch: Boolean(opts.skipGitPush)
        });
        remoteSnap = remoteGitInfo?.snapshot || null;

        if (!remoteSnap && process.env.NODE_ENV !== 'test' && !opts.skipGitPush) {
            try {
                const ghMgr = new GitHubSyncManager();
                const res = await ghMgr.fetchRemoteSnapshot(null, { useEtag: false, force: true });
                remoteSnap = res?.data || null;
            } catch (_) {}
        }

        // 发布期多客户端冷却复查：防止两台客户端分别编译 40 分钟后互相覆盖最新新闻
        if (!opts.force && opts.cooldownMinutes > 0 && remoteSnap && !opts.skipGitPush) {
            const remotePublishedMs = Date.parse(remoteSnap.publishedAt || remoteSnap.lastUpdated || '');
            const remoteBy = String(remoteSnap.publishedBy || remoteSnap.clientId || '').trim();
            const isDifferentClient = Boolean(remoteBy && publishedBy && remoteBy.toLowerCase() !== publishedBy.toLowerCase());
            const remoteEdition = String(remoteSnap.editionId || '').trim();
            if (
                isDifferentClient &&
                Number.isFinite(remotePublishedMs) &&
                remotePublishedMs > 0 &&
                (Date.now() - remotePublishedMs) < opts.cooldownMinutes * 60 * 1000 &&
                remoteEdition !== editionId
            ) {
                const ageMin = ((Date.now() - remotePublishedMs) / 60000).toFixed(1);
                const cdErr = new Error(
                    `发布期冷却拦截: 远端快照在 ${ageMin} 分钟前刚由其他客户端 (${remoteBy}) 发布（冷却窗口 ${opts.cooldownMinutes}m），为防覆盖他人新稿已中止推送（传 --force 可强制覆盖）`
                );
                cdErr.code = 'COOLDOWN_CONFLICT';
                cdErr.statusCode = 409;
                throw cdErr;
            }
        }
    }

    // 多客户端协同：继承远端 socialPulse（不覆盖丢失）
    if (!existingPulse && remoteSnap?.socialPulse) {
        const inheritedPulse = normalizeSocialPulseBundle(remoteSnap.socialPulse, {
            updatedAt: remoteSnap.socialPulseUpdatedAt || remoteSnap.socialPulse.updatedAt
        });
        if (inheritedPulse && inheritedPulse.issueCount > 0) {
            existingPulse = inheritedPulse;
            await socialPulseService.saveBundle(existingPulse, { emit: false });
            logger.info('AG-PUBLISH', `已从远端 ag-snapshot 继承保留欧美社媒热议 (${existingPulse.issueCount} 期)`);
        }
    }

    // 分轨匹配本期 editionId：剔除过期的 tracks.news，保留有效的 tracks.pulse（Q2=A）
    const audioMatch = resolveEditionMatchedAudio({
        localAudio,
        remoteSnap,
        editionId
    });
    let existingAudio = audioMatch.effectiveAudio;

    if (existingAudio) {
        if (audioMatch.droppedStaleNewsAudio || (!localAudio && existingAudio)) {
            await audioBroadcastService.saveBundle(existingAudio, { emit: false });
        }
        stateManager.updateAudioBroadcast(existingAudio, false);
    } else if (audioMatch.droppedStaleNewsAudio) {
        stateManager.updateAudioBroadcast(null, false);
    }

    const extraPoolNews = curatedArticles.length > finalNews.length
        ? curatedArticles.slice(finalNews.length)
        : [];
    const buildSnapshotPayload = (pulseBundle, audioBundle) => ({
        version: '3.0',
        schemaVersion: '3.0',
        editionId,
        ...(harvestId ? { harvestId } : {}),
        publishedAt: nowIso,
        lastUpdated: nowIso,
        publishedBy,
        clientId: publishedBy,
        sourceCount: sourceStats.length,
        articleCount: finalNews.length,
        displayedCount: finalNews.length,
        totalPoolCount: curatedArticles.length,
        news: finalNews,
        ...(extraPoolNews.length > 0 ? { extraPoolNews } : {}),
        summaryArticle,
        sourceStats,
        ...(pulseBundle && pulseBundle.issueCount > 0
            ? {
                socialPulse: pulseBundle,
                socialPulseUpdatedAt: pulseBundle.updatedAt
            }
            : {}),
        ...(audioBundle && audioBundle.trackCount > 0
            ? {
                audioBroadcast: audioBundle,
                audioBroadcastUpdatedAt: audioBundle.updatedAt
            }
            : {})
    });

    let snapshotPayload = buildSnapshotPayload(existingPulse, existingAudio);

    if (opts.snapshotOut) {
        await writeJsonFile(opts.snapshotOut, snapshotPayload);
        logger.info('AG-PUBLISH', `已导出精编快照文件至: ${opts.snapshotOut}`);
    }

    await writeJsonFile(config.storage.newsFile, {
        editionId,
        ...(harvestId ? { harvestId } : {}),
        news: finalNews,
        lastUpdated: nowIso,
        total: finalNews.length
    });

    await writeJsonFile(config.storage.summaryFile, {
        editionId,
        article: summaryArticle,
        savedAt: nowIso,
        version: '2.0'
    });

    stateManager.set('collectionPhase', 'completed', false);
    stateManager.set('sourceStats', sourceStats, false);
    stateManager.set('lastPublishedBy', publishedBy, false);
    stateManager.set('lastEditionId', editionId, false);
    stateManager.updateNewsData(finalNews, curatedArticles);
    stateManager.updateSummaryArticle(summaryArticle);
    await stateManager.saveToFile(config.storage.stateFile);

    logger.info(
        'AG-PUBLISH',
        `本地数据文件已更新: editionId=${editionId}, news=${finalNews.length} 条 (精选池 ${curatedArticles.length} 条), summary=${summaryArticle.wordCount} 字`
    );

    let githubSyncResult = null;
    if (shouldPushToGithub && !isUnscopedTestRun) {
        const expectedRemoteSha = customOptions.expectedRemoteSha !== undefined
            ? customOptions.expectedRemoteSha
            : (remoteGitInfo && !remoteGitInfo.error ? remoteGitInfo.commitSha : undefined);

        const tryPush = (payloadToPush, leaseSha) => publishSnapshotToGitHub(payloadToPush, {
            branch: gitBranch,
            remote: gitRemote,
            repoDir,
            skipPush: Boolean(opts.skipGitPush),
            publishedBy,
            clientId: publishedBy,
            ...(leaseSha !== undefined ? { expectedRemoteSha: leaseSha } : {})
        });

        try {
            try {
                githubSyncResult = tryPush(snapshotPayload, expectedRemoteSha);
            } catch (firstPushErr) {
                if (firstPushErr.code === 'LEASE_CONFLICT' && !opts.skipGitPush) {
                    const freshRemote = fetchRemoteSnapshotViaGit({
                        repoDir,
                        remote: gitRemote,
                        branch: gitBranch
                    });
                    const prevNewsAt = remoteSnap?.publishedAt || null;
                    const freshNewsAt = freshRemote?.snapshot?.publishedAt || null;
                    const prevNewsEdition = remoteSnap?.editionId || null;
                    const freshNewsEdition = freshRemote?.snapshot?.editionId || null;
                    const newsUnchanged = Boolean(
                        freshRemote.exists &&
                        freshRemote.snapshot &&
                        freshNewsAt === prevNewsAt &&
                        freshNewsEdition === prevNewsEdition
                    );

                    if (newsUnchanged) {
                        logger.warn(
                            'AG-PUBLISH',
                            '检测到并发期间远端仅更新了欧美社媒/音轨（要闻未变），正在自动合并最新 pulse 后重试 --force-with-lease 推送...'
                        );
                        if (freshRemote.snapshot.socialPulse) {
                            const mergedPulse = normalizeSocialPulseBundle(freshRemote.snapshot.socialPulse, {
                                updatedAt: freshRemote.snapshot.socialPulseUpdatedAt || freshRemote.snapshot.socialPulse.updatedAt
                            });
                            if (mergedPulse) existingPulse = mergedPulse;
                        }
                        const retriedAudioMatch = resolveEditionMatchedAudio({
                            localAudio: existingAudio,
                            remoteSnap: freshRemote.snapshot,
                            editionId
                        });
                        existingAudio = retriedAudioMatch.effectiveAudio;
                        snapshotPayload = buildSnapshotPayload(existingPulse, existingAudio);
                        githubSyncResult = tryPush(snapshotPayload, freshRemote.commitSha);
                    } else {
                        throw firstPushErr;
                    }
                } else {
                    throw firstPushErr;
                }
            }
            logger.success(
                'AG-PUBLISH',
                `已发布大模型精编快照至 GitHub 分支 ${githubSyncResult.branch} (edition=${editionId}, commit=${githubSyncResult.commitSha.slice(0, 8)}, pushed=${githubSyncResult.pushed}, by=${publishedBy})`
            );
        } catch (gitErr) {
            if (hasExplicitGithubOpt || opts.repoDir || gitErr.code === 'LEASE_CONFLICT') {
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

        let isLocalOrLanTarget = false;
        try {
            const parsedHost = new URL(publishUrl).hostname.toLowerCase();
            isLocalOrLanTarget =
                parsedHost === 'localhost' ||
                parsedHost === '127.0.0.1' ||
                parsedHost === '::1' ||
                parsedHost === '[::1]' ||
                parsedHost.startsWith('192.168.') ||
                parsedHost.startsWith('10.') ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(parsedHost);
        } catch (_) {}

        try {
            const response = await axios.post(
                publishUrl,
                {
                    editionId,
                    ...(harvestId ? { harvestId } : {}),
                    news: finalNews,
                    allEnhancedNews: curatedArticles,
                    summary: summaryArticle,
                    summaryArticle,
                    sourceStats,
                    publishedAt: nowIso,
                    lastUpdated: nowIso,
                    publishedBy,
                    clientId: publishedBy,
                    ...(existingPulse && existingPulse.issueCount > 0
                        ? {
                            socialPulse: existingPulse,
                            socialPulseUpdatedAt: existingPulse.updatedAt
                        }
                        : {}),
                    ...(existingAudio && existingAudio.trackCount > 0
                        ? {
                            audioBroadcast: existingAudio,
                            audioBroadcastUpdatedAt: existingAudio.updatedAt
                        }
                        : {})
                },
                {
                    headers: { ...headers, Connection: 'close' },
                    timeout: 20000,
                    httpsAgent: getHttpsAgent({ keepAlive: false }),
                    ...(isLocalOrLanTarget ? { proxy: false } : {})
                }
            );

            remoteResponse = response.data;
            logger.success('AG-PUBLISH', `成功推送至网站 ${publishUrl}:`, remoteResponse);

            if (existingAudio && existingAudio.tracks?.news) {
                const newsAudioFile = audioBroadcastService.getTrackAudioPath('news');
                if (newsAudioFile && fs.existsSync(newsAudioFile)) {
                    const audioEndpoint = publishUrl.replace(/\/api\/agent\/publish$/, '/api/agent/publish-audio');
                    try {
                        await axios.post(
                            audioEndpoint,
                            {
                                track: 'news',
                                trackMeta: existingAudio.tracks.news,
                                audioBase64: fs.readFileSync(newsAudioFile).toString('base64'),
                                publishedBy
                            },
                            {
                                headers,
                                timeout: 30000,
                                maxBodyLength: 50 * 1024 * 1024,
                                httpsAgent: getHttpsAgent({ keepAlive: false }),
                                ...(isLocalOrLanTarget ? { proxy: false } : {})
                            }
                        );
                    } catch (_) {
                        // Ignore optional binary audio hot-push failure when target does not yet expose /publish-audio
                    }
                }
            }
        } catch (httpErr) {
            const isConnRefused =
                httpErr.code === 'ECONNREFUSED' ||
                httpErr.name === 'AggregateError' ||
                (Array.isArray(httpErr.errors) && httpErr.errors.some(e => e?.code === 'ECONNREFUSED'));
            if (githubSyncResult?.success && !opts.targetExplicit && (isConnRefused || !httpErr.response)) {
                logger.info('AG-PUBLISH', `本地服务 ${publishUrl} 未运行，已完成 GitHub 快照发布`);
            } else {
                throw httpErr;
            }
        }
    }

    return {
        success: true,
        editionId,
        harvestId,
        displayedCount: finalNews.length,
        totalPoolCount: curatedArticles.length,
        summaryArticle,
        publishedAt: nowIso,
        lastUpdated: nowIso,
        publishedBy,
        clientId: publishedBy,
        droppedStaleNewsAudio: audioMatch.droppedStaleNewsAudio,
        validation: validationReport,
        snapshotOut: opts.snapshotOut || null,
        githubSync: githubSyncResult,
        remoteResponse
    };
}

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
    runPublish(cliOpts)
        .then((res) => {
            if (cliOpts.validateOnly) {
                console.log(JSON.stringify(res.validation, null, 2));
                if (res.reportText) console.error(res.reportText);
                process.exit(res.success ? 0 : 1);
            }
            process.exit(0);
        })
        .catch(err => {
            const status = err.response?.status ? ` (HTTP ${err.response.status})` : '';
            const detail = err.response?.data?.message || err.message;
            console.error(`[AG-PUBLISH] 发布失败${status}:`, detail);
            process.exit(1);
        });
}

module.exports = {
    runPublish,
    parseArgs,
    validateCompiledArticle,
    computeNewsEditionId,
    resolveEditionMatchedAudio
};
