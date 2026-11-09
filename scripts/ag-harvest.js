#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Antigravity Path A: 阶段一全球信源并发采集与候选池生成工具 (ag-harvest.js)
 *
 * 功能说明：
 *   并发巡检内置 37 个全球权威信源，执行跨源事件初筛去重、规则预分类与高清题图补全，
 *   输出结构化候选池文件 `data/ag_candidates.json` 供后续 AI 深度编译或发布流水线使用。
 *
 * 常用参数：
 *   --out <path>           输出候选 JSON 路径 (默认: data/ag_candidates.json)
 *   --limit <number>       候选池保留的最大文章数 (默认: 35)
 *   --images <number>      补齐 og:image 高清配图的文章数 (默认: 30)
 *   --category <string>    按信源分类定向巡检 (默认: all)
 *   --translate-fallback   启用免密钥高速中文直译预填充
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const config = require('../config');
const logger = require('../utils/logger');
const { writeJsonFile, truncateText } = require('../utils/helpers');
const NewsService = require('../services/news_service');
const AIService = require('../services/ai_service');
const NewsAgentService = require('../services/news_agent_service');
const stateManager = require('../services/state_manager');

function parseArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const options = {
        out: process.env.AG_CANDIDATES_FILE || path.join(config.storage.dataDir, 'ag_candidates.json'),
        limit: 35,
        imageLimit: config.agent.maxCuratedArticles || 30,
        category: 'all',
        translateFallback: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--out' || arg === '--raw' || arg === '--candidates') && argv[i + 1]) {
            options.out = path.resolve(argv[++i]);
        } else if (arg.startsWith('--out=') || arg.startsWith('--raw=') || arg.startsWith('--candidates=')) {
            options.out = path.resolve(eqVal(arg));
        } else if (arg === '--limit' && argv[i + 1]) {
            options.limit = Math.max(1, parseInt(argv[++i], 10) || 35);
        } else if (arg.startsWith('--limit=')) {
            options.limit = Math.max(1, parseInt(eqVal(arg), 10) || 35);
        } else if (arg === '--images' && argv[i + 1] !== undefined) {
            options.imageLimit = Math.max(0, parseInt(argv[++i], 10));
        } else if (arg.startsWith('--images=')) {
            options.imageLimit = Math.max(0, parseInt(eqVal(arg), 10));
        } else if (arg === '--category' && argv[i + 1]) {
            options.category = argv[++i];
        } else if (arg.startsWith('--category=')) {
            options.category = eqVal(arg);
        } else if (arg === '--translate-fallback') {
            options.translateFallback = true;
        }
    }

    return options;
}

async function runHarvest(customOptions = {}) {
    const opts = { ...parseArgs([]), ...customOptions };
    const startTime = Date.now();

    const newsService = new NewsService(null, stateManager);
    const aiService = new AIService(null, stateManager);
    const agentService = new NewsAgentService(null, stateManager, aiService, newsService);

    logger.info('AG-HARVEST', `[1/4] 正在并发巡检全球知名信源矩阵 (category=${opts.category})...`);
    const { articles: rawHarvested, sourceStats } = await agentService._executeScoutPatrol(opts.category);

    if (!Array.isArray(rawHarvested) || rawHarvested.length === 0) {
        throw new Error('未能从任何信源获取到有效新闻，请检查网络连接');
    }

    const activeSources = sourceStats.filter(s => s.status === 'ok').length;
    logger.info(
        'AG-HARVEST',
        `[2/4] 原始捕获 ${rawHarvested.length} 篇 (${activeSources}/${sourceStats.length} 个活跃信源)，正在执行清洗、规则聚类与质量排序...`
    );

    const cleaned = newsService.filterAndCleanArticles(rawHarvested);
    const clustered = aiService.mergeDuplicateArticlesSync(cleaned);
    // 直接调用 _scoreArticlesByRules 确保即使 clustered.length <= limit 也会计算 qualityScore 并排序
    const scored = typeof aiService._scoreArticlesByRules === 'function'
        ? aiService._scoreArticlesByRules(clustered)
        : await aiService.selectTopQualityNews(clustered, Math.max(opts.limit, 40));

    let candidates = scored
        .slice(0, opts.limit)
        .map(item => aiService.applyPreliminaryMetadata(item));

    logger.info(
        'AG-HARVEST',
        `[3/4] 正在并发补全缺失高清题图 (前 ${Math.min(opts.imageLimit, candidates.length)} 篇)...`
    );

    const enrichTasks = [];
    if (opts.imageLimit > 0) {
        enrichTasks.push(agentService._enrichMissingArticleImages(candidates.slice(0, opts.imageLimit)));
    }
    if (opts.translateFallback) {
        enrichTasks.push(
            aiService.ensureBatchInChinese(candidates, 8).then(translated => {
                candidates = translated.map((item, idx) => ({
                    ...item,
                    urlToImage: item.urlToImage || candidates[idx]?.urlToImage || null,
                    content: candidates[idx]?.content || item.content || ''
                }));
            })
        );
    }

    if (enrichTasks.length > 0) {
        await Promise.all(enrichTasks);
    }

    const llmInput = candidates.map((a, idx) => ({
        index: idx + 1,
        id: a.id,
        sourceName: a.source?.name || 'Global Media',
        relatedSources: Array.isArray(a.relatedSources) ? a.relatedSources.map(r => r.name).filter(Boolean) : [],
        sourceCount: a.sourceCount || 1,
        title: a.title,
        translatedTitle: a.translatedTitle !== a.title ? a.translatedTitle : undefined,
        regionHint: a.region || '国际',
        categoryHint: a.category || '国际',
        publishedAt: a.publishedAt,
        url: a.url,
        excerpt: truncateText(a.content || a.description || a.title || '', 700)
    }));

    const payload = {
        harvestedAt: new Date().toISOString(),
        elapsedSeconds: Number(((Date.now() - startTime) / 1000).toFixed(1)),
        rawCount: rawHarvested.length,
        cleanedCount: cleaned.length,
        clusteredCount: clustered.length,
        candidateCount: candidates.length,
        sourceStats,
        fullCandidates: candidates,
        llmInput
    };

    await writeJsonFile(opts.out, payload);
    logger.success(
        'AG-HARVEST',
        `[4/4] 采集完成！共输出 ${candidates.length} 条精选候选新闻至 ${opts.out} (耗时 ${payload.elapsedSeconds}s)`
    );

    return payload;
}

if (require.main === module) {
    const cliOpts = parseArgs(process.argv.slice(2));
    runHarvest(cliOpts)
        .then(() => process.exit(0))
        .catch(err => {
            console.error('[AG-HARVEST] 采集失败:', err.message);
            process.exit(1);
        });
}

module.exports = { runHarvest, parseArgs };
