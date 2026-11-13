#!/usr/bin/env node
/**
 * CoreFeed v2.0 — 纯网络原始信源搬运工具 (scripts/ag-harvest.js)
 *
 * 设计原则：
 *   本脚本仅负责纯网络 I/O（并发拉取内置 37 家全球权威外媒的原始 RSS、原网页文本与配图 URL），
 *   不做任何规则打分、相似度去重、正则分类或机器翻译！
 *   输出的 `data/ag_candidates.json` 包含轻量全景索引 `briefIndex` 与完整原始数据 `fullCandidates`，
 *   后续的选稿裁剪、同题合并、正文提纯、全文翻译、标题/导语/要点精编及深度综述 100% 交由 Antigravity 客户端内置大模型完成。
 *
 * 常用参数：
 *   --out <path>           输出原始候选 JSON 路径 (默认: data/ag_candidates.json)
 *   --limit <number>       抓取网页原文与配图的最大原始条目数 (默认: 80)
 *   --images <number>      补齐缺失 og:image 题图 URL 的最大条目数 (默认与 limit 一致)
 *   --category <string>    按信源分类定向拉取 (默认: all)
 *   --check-cooldown       拉取前检查 GitHub ag-snapshot/latest.json 是否在 30 分钟冷却期内
 *   --force                忽略远端冷却期强制拉取
 *   --inspect <indices>    按 1-based 序号读取已有候选池中的指定原始全文 (例如: --inspect 1,4,7,12)
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
    const options = {
        out: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        limit: 80,
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
            options.limit = Math.max(1, parseInt(argv[++i], 10) || 80);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Math.max(1, parseInt(eqVal(arg), 10) || 80);
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

    logger.info('AG-HARVEST', `[1/3] 正在并发拉取全球 37 家权威外媒原始信源 (category=${opts.category})...`);
    const { articles: rawHarvested, sourceStats } = await agentService._executeScoutPatrol(opts.category);

    if (!Array.isArray(rawHarvested) || rawHarvested.length === 0) {
        throw new Error('未能从任何信源获取到有效原始条目，请检查网络连接');
    }

    const activeSources = sourceStats.filter(s => s.status === 'ok').length;
    const freshCleaned = newsService.filterAndCleanArticles(rawHarvested);
    const uniqueSorted = deduplicateExactUrlsAndSortByTime(freshCleaned);
    const candidates = uniqueSorted.slice(0, opts.limit).map((item, idx) => ({
        ...item,
        index: idx + 1
    }));

    logger.info(
        'AG-HARVEST',
        `[2/3] 原始捕获 ${rawHarvested.length} 篇 (${activeSources}/${sourceStats.length} 个活跃信源)，48h 时效与相同 URL 去重后保留 ${candidates.length} 篇，正在并发抓取原网页文本与题图 URL...`
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
        sourceStats,
        briefIndex,
        fullCandidates: candidates
    };

    await writeJsonFile(opts.out, payload);
    logger.success(
        'AG-HARVEST',
        `[3/3] 原始信源搬运完成！共输出 ${candidates.length} 条原始外媒素材至 ${opts.out} (耗时 ${payload.elapsedSeconds}s)，请交由 Antigravity 大模型执行选稿、精译与综述创作`
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

module.exports = { runHarvest, inspectCandidates, parseArgs };
