#!/usr/bin/env node
/**
 * CoreFeed v3.0 — 纯网络原始信源搬运工具 (scripts/ag-harvest.js)
 *
 * 设计原则：
 *   本脚本仅负责纯网络 I/O（并发拉取内置 56 家全球权威多语种外媒的原始 RSS、原网页文本与配图 URL），
 *   不做任何规则打分、相似度去重、正则分类或机器翻译！
 *   为防止高频通讯社挤掉低频深度源，采用确定性「单源保底 + 单源上限 + 全局时间回填」分层入池机制；
 *   输出的 `data/ag_candidates.json` 包含轻量全景索引 `briefIndex` 与完整原始数据 `fullCandidates`，
 *   后续的选稿裁剪、同题合并、正文提纯、全文翻译、标题/导语/要点精编及深度综述 100% 交由 Antigravity 客户端内置大模型完成。
 *
 * 常用参数：
 *   --out <path>             输出原始候选 JSON 路径 (默认: data/ag_candidates.json)
 *   --limit <number>         抓取网页原文与配图的最大原始条目数 (默认: 110)
 *   --max-per-source <num>   单信源在候选池中的常规上限条数 (默认: 4)
 *   --images <number>        补齐缺失 og:image 题图 URL 的最大条目数 (默认与 limit 一致)
 *   --category <string>      按信源分类定向拉取 (默认: all)
 *   --check-cooldown         拉取前检查 GitHub ag-snapshot/latest.json 是否在 30 分钟冷却期内
 *   --force                  忽略远端冷却期强制拉取
 *   --inspect <indices>      按 1-based 序号读取已有候选池中的指定原始全文 (例如: --inspect 1,4,7,12)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile, truncateText } = require('../utils/helpers');
const NewsService = require('../services/news_service');
const NewsAgentService = require('../services/news_agent_service');
const stateManager = require('../services/state_manager');
const { checkRemoteSnapshotCooldown } = require('../utils/github_sync');

function parseArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const defaultLimit = Number(config.agent?.maxCandidatePool || 110);
    const defaultMaxPerSource = Number(config.agent?.maxPerSourceInPool || 4);
    const options = {
        out: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        limit: defaultLimit,
        maxPerSource: defaultMaxPerSource,
        imageLimit: null,
        category: 'all',
        checkCooldown: false,
        force: false,
        cooldownMinutes: Number(config.githubSync?.cooldownMinutes ?? 30),
        inspectIndices: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--out' || arg === '--raw' || arg === '--candidates') && argv[i + 1]) {
            options.out = path.resolve(argv[++i]);
        } else if (arg.startsWith('--out=') || arg.startsWith('--raw=') || arg.startsWith('--candidates=')) {
            options.out = path.resolve(eqVal(arg));
        } else if (arg === '--limit' && argv[i + 1]) {
            options.limit = Math.max(1, parseInt(argv[++i], 10) || defaultLimit);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Math.max(1, parseInt(eqVal(arg), 10) || defaultLimit);
        } else if (arg === '--max-per-source' && argv[i + 1]) {
            options.maxPerSource = Math.max(1, parseInt(argv[++i], 10) || defaultMaxPerSource);
        } else if (arg.startsWith('--max-per-source=')) {
            options.maxPerSource = Math.max(1, parseInt(eqVal(arg), 10) || defaultMaxPerSource);
        } else if (arg === '--images' && argv[i + 1] !== undefined) {
            options.imageLimit = Math.max(0, parseInt(argv[++i], 10));
        } else if (arg.startsWith('--images=')) {
            options.imageLimit = Math.max(0, parseInt(eqVal(arg), 10));
        } else if (arg === '--category' && argv[i + 1]) {
            options.category = argv[++i];
        } else if (arg.startsWith('--category=')) {
            options.category = eqVal(arg);
        } else if (arg === '--check-cooldown') {
            options.checkCooldown = true;
        } else if (arg === '--force') {
            options.force = true;
        } else if (arg === '--cooldown' && argv[i + 1] !== undefined) {
            options.cooldownMinutes = Math.max(0, parseInt(argv[++i], 10));
        } else if (arg.startsWith('--cooldown=')) {
            options.cooldownMinutes = Math.max(0, parseInt(eqVal(arg), 10));
        } else if (arg === '--inspect' && argv[i + 1]) {
            options.inspectIndices = String(argv[++i]);
        } else if (arg.startsWith('--inspect=')) {
            options.inspectIndices = eqVal(arg);
        }
    }

    if (options.imageLimit === null) {
        options.imageLimit = options.limit;
    }

    return options;
}

/**
 * 仅对完全相同的 URL 去重并按发布时间倒序排列（不做任何相似度聚类或规则打分）
 */
function deduplicateExactUrlsAndSortByTime(articles = []) {
    const seenUrls = new Set();
    const unique = [];

    for (const item of articles) {
        if (!item) continue;
        const normUrl = String(item.url || '').trim().replace(/\/+$/, '');
        if (normUrl) {
            if (seenUrls.has(normUrl)) continue;
            seenUrls.add(normUrl);
        }
        unique.push(item);
    }

    return unique.sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
    });
}

/**
 * 两阶段「单源保底 + 单源上限 + 全局时间回填」分层入池采样：
 *   1. Pass 1（单源保底）：按源分组并轮询保底，确保每个活跃源至少进入 minQuota 条（常规 1 条，东亚/财经重点源 2 条），避免高频源淹没低频深源；
 *   2. Pass 2（时间回填）：在单源不超过 maxPerSource (默认 4) 的前提下，按全局发布时间倒序补满至 limit；
 *   3. Pass 3（稀疏兜底）：仅在单源/窄分类场景下仍未满 limit 时放宽上限按时间补齐，确保定向拉取不无故丢稿；
 *   最终按发布时间倒序输出，不引入任何主观规则打分。
 */
function selectStratifiedCandidates(sortedArticles = [], { limit = 110, maxPerSource = 4 } = {}) {
    if (!Array.isArray(sortedArticles) || sortedArticles.length === 0) return [];
    const targetLimit = Math.max(1, Number(limit) || 110);
    const sourceCap = Math.max(1, Number(maxPerSource) || 4);

    if (sortedArticles.length <= targetLimit) {
        return [...sortedArticles];
    }

    const getSourceKey = (item) => String(item?.source?.id || item?.source?.name || 'unknown');
    const groups = new Map();
    for (const item of sortedArticles) {
        const key = getSourceKey(item);
        if (!groups.has(key)) {
            const rawQuota = Number(item?.source?.minQuota);
            const quota = Number.isFinite(rawQuota) && rawQuota >= 1
                ? Math.min(sourceCap, Math.floor(rawQuota))
                : 1;
            groups.set(key, { key, quota, items: [] });
        }
        groups.get(key).items.push(item);
    }

    const selected = [];
    const selectedSet = new Set();
    const pickedCount = new Map();

    // Pass 1: 轮询单源保底（先满足所有源的第 1 条，再满足重点源的第 2 条）
    const maxQuotaRound = Math.max(...Array.from(groups.values()).map(g => g.quota), 1);
    for (let round = 0; round < maxQuotaRound && selected.length < targetLimit; round++) {
        for (const grp of groups.values()) {
            if (selected.length >= targetLimit) break;
            if (round >= grp.quota) continue;
            const candidate = grp.items[round];
            if (!candidate || selectedSet.has(candidate)) continue;
            selected.push(candidate);
            selectedSet.add(candidate);
            pickedCount.set(grp.key, (pickedCount.get(grp.key) || 0) + 1);
        }
    }

    // Pass 2: 按全局时间倒序回填，并遵守单源常规上限 maxPerSource
    if (selected.length < targetLimit) {
        for (const item of sortedArticles) {
            if (selected.length >= targetLimit) break;
            if (selectedSet.has(item)) continue;
            const key = getSourceKey(item);
            if ((pickedCount.get(key) || 0) >= sourceCap) continue;
            selected.push(item);
            selectedSet.add(item);
            pickedCount.set(key, (pickedCount.get(key) || 0) + 1);
        }
    }

    // Pass 3: 若活跃源很少导致未达 targetLimit，放宽单源上限补齐
    if (selected.length < targetLimit) {
        for (const item of sortedArticles) {
            if (selected.length >= targetLimit) break;
            if (selectedSet.has(item)) continue;
            selected.push(item);
            selectedSet.add(item);
        }
    }

    return selected.sort((a, b) => {
        const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
        const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
    });
}

async function inspectCandidates(candidatesFile, rawIndicesStr) {
    const data = await readJsonFile(candidatesFile, null);
    if (!data || !Array.isArray(data.fullCandidates)) {
        throw new Error(`无法读取候选池文件: ${candidatesFile}`);
    }

    const wanted = new Set(
        String(rawIndicesStr || '')
            .split(',')
            .map(s => parseInt(s.trim(), 10))
            .filter(n => !isNaN(n) && n >= 1)
    );

    const selected = [];
    data.fullCandidates.forEach((item, idx) => {
        const oneBased = item.index || idx + 1;
        if (wanted.size === 0 || wanted.has(oneBased)) {
            selected.push({
                index: oneBased,
                id: item.id,
                sourceName: item.source?.name || 'Global Media',
                sourceAuthority: item.source?.authority || null,
                language: item.source?.language || 'en',
                paywall: item.source?.paywall || 'open',
                publishedAt: item.publishedAt || null,
                url: item.url,
                urlToImage: item.urlToImage || null,
                title: item.title,
                rssDescription: item.description || '',
                rawText: item.fullText || item.content || item.description || ''
            });
        }
    });

    return {
        harvestedAt: data.harvestedAt,
        totalCandidates: data.fullCandidates.length,
        inspectedCount: selected.length,
        items: selected
    };
}

async function runHarvest(customOptions = {}) {
    const opts = { ...parseArgs([]), ...customOptions };
    if (opts.imageLimit === null || opts.imageLimit === undefined) {
        opts.imageLimit = opts.limit;
    }

    if (opts.inspectIndices) {
        return inspectCandidates(opts.out, opts.inspectIndices);
    }

    if (opts.checkCooldown && !opts.force && opts.cooldownMinutes > 0) {
        const cooldownRes = await checkRemoteSnapshotCooldown({
            cooldownMinutes: opts.cooldownMinutes,
            snapshotUrl: customOptions.snapshotUrl || null
        });
        if (cooldownRes.inCooldown) {
            logger.info(
                'AG-HARVEST',
                `检测到 GitHub 快照在 ${cooldownRes.ageMinutes} 分钟前刚由 ${cooldownRes.publishedBy || '其他客户端'} 发布 (冷却窗口 ${opts.cooldownMinutes}m)，跳过重复采集（传 --force 可强制采集）`
            );
            return {
                cooldownSkipped: true,
                inCooldown: true,
                ageMinutes: cooldownRes.ageMinutes,
                publishedAt: cooldownRes.publishedAt,
                publishedBy: cooldownRes.publishedBy,
                sourceUrl: cooldownRes.sourceUrl
            };
        }
    }

    const startTime = Date.now();
    const newsService = new NewsService(null, stateManager);
    const agentService = new NewsAgentService(null, stateManager, newsService);

    logger.info('AG-HARVEST', `[1/3] 正在并发拉取全球多语种权威外媒原始信源 (category=${opts.category}, limit=${opts.limit})...`);
    const { articles: rawHarvested, sourceStats } = await agentService._executeScoutPatrol(opts.category);

    if (!Array.isArray(rawHarvested) || rawHarvested.length === 0) {
        throw new Error('未能从任何信源获取到有效原始条目，请检查网络连接');
    }

    const activeSources = sourceStats.filter(s => s.status === 'ok').length;
    const freshCleaned = newsService.filterAndCleanArticles(rawHarvested);
    const uniqueSorted = deduplicateExactUrlsAndSortByTime(freshCleaned);
    const sampled = selectStratifiedCandidates(uniqueSorted, {
        limit: opts.limit,
        maxPerSource: opts.maxPerSource
    });
    const candidates = sampled.map((item, idx) => ({
        ...item,
        index: idx + 1
    }));

    const representedSources = new Set(candidates.map(c => c.source?.id || c.source?.name)).size;
    logger.info(
        'AG-HARVEST',
        `[2/3] 原始捕获 ${rawHarvested.length} 篇 (${activeSources}/${sourceStats.length} 个活跃信源)，时效过滤与分层保底采样后保留 ${candidates.length} 篇（覆盖 ${representedSources} 个信源），正在并发抓取原网页文本与题图 URL...`
    );

    const enrichTasks = [];
    if (opts.imageLimit > 0) {
        const imgSlice = candidates.slice(0, opts.imageLimit);
        enrichTasks.push(agentService._enrichMissingArticleImages(imgSlice));
    }
    enrichTasks.push(agentService._enrichMissingArticleFullTexts(candidates));
    await Promise.all(enrichTasks);

    const briefIndex = candidates.map((a, idx) => ({
        index: idx + 1,
        id: a.id,
        sourceName: a.source?.name || 'Global Media',
        sourceAuthority: a.source?.authority || null,
        sourceCategory: a.source?.category || 'global',
        sourceRegion: a.region || null,
        language: a.source?.language || 'en',
        paywall: a.source?.paywall || 'open',
        publishedAt: a.publishedAt || null,
        title: a.title,
        rssExcerpt: truncateText(a.description || '', 240),
        hasImage: Boolean(a.urlToImage),
        rawTextChars: (a.fullText || a.content || '').length,
        url: a.url
    }));

    const payload = {
        harvestedAt: new Date().toISOString(),
        elapsedSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
        rawCount: rawHarvested.length,
        cleanedCount: freshCleaned.length,
        candidateCount: candidates.length,
        representedSourceCount: representedSources,
        sourceStats,
        briefIndex,
        fullCandidates: candidates
    };

    await writeJsonFile(opts.out, payload);
    logger.success(
        'AG-HARVEST',
        `[3/3] 原始信源搬运完成！共输出 ${candidates.length} 条多语种外媒素材（覆盖 ${representedSources} 家信源）至 ${opts.out} (耗时 ${payload.elapsedSeconds}s)，请交由 Antigravity 大模型执行选稿、精译与综述创作`
    );

    return payload;
}

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
    runHarvest(cliOpts)
        .then((res) => {
            if (cliOpts.inspectIndices || res?.cooldownSkipped) {
                console.log(JSON.stringify(res, null, 2));
            }
            process.exit(0);
        })
        .catch(err => {
            console.error('[AG-HARVEST] 原始采集失败:', err.message);
            process.exit(1);
        });
}

module.exports = {
    runHarvest,
    inspectCandidates,
    parseArgs,
    deduplicateExactUrlsAndSortByTime,
    selectStratifiedCandidates
};
