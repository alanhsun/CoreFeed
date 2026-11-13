/**
 * 聚核 CoreFeed v2.0 — 全球信源纯网络抓取与快照状态广播服务 (services/news_agent_service.js)
 *
 * 核心职责：
 *   1. 纯网络搬运 (`_executeScoutPatrol`)：并发拉取全球 37 家权威外媒原始 RSS / Google News 代理 / Jina 列表
 *   2. 原始媒体资源提取 (`_enrichMissingArticleImages`, `_enrichMissingArticleFullTexts`)：抓取网页 og:image 题图 URL 与原始外文文本
 *   3. 快照状态广播 (`_publishNewsSnapshot`)：同步更新内存 `stateManager`、`data/news.json` 与 Socket.IO 实时推送
 *
 * 说明：
 *   本服务不包含任何规则打分、同题聚类、正则分类或机器翻译逻辑；
 *   所有选稿裁剪、跨源合并、正文提纯、全文翻译、标题/导语/要点精编及深度综述均由 Antigravity 客户端内置大模型完成。
 */
const config = require('../config');
const logger = require('../utils/logger');
const { stripHtml } = require('../utils/helpers');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');
const {
    fetchFromGlobalSource,
    fetchArticleLeadImage,
    searchNewsImageByTitle,
    extractFullArticleContent,
    createArticleId
} = require('./agent_tools');

class NewsAgentService {
    constructor(io = null, stateManager = null, newsService = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.newsService = newsService;
        this.lastSourceStats = [];
        this.agentLogs = [];
    }

    /**
     * 记录并广播实时工作流日志
     */
    emitAgentEvent(agentName, stage, message, detail = {}) {
        const entry = {
            id: Date.now() + '-' + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toISOString(),
            agent: agentName,
            stage,
            message,
            ...detail
        };

        this.agentLogs.push(entry);
        if (this.agentLogs.length > 80) {
            this.agentLogs.shift();
        }

        logger.info(`AGENT:${agentName}`, message, detail.progress !== undefined ? { progress: `${detail.progress}%` } : null);

        if (this.io) {
            this.io.emit('agent-event', entry);
            if (detail.progress !== undefined) {
                this.io.emit('update-progress', {
                    stage,
                    agent: agentName,
                    message,
                    percentage: detail.progress,
                    current: detail.current || detail.progress,
                    total: detail.total || 100
                });
            }
        }

        if (this.stateManager && detail.progress !== undefined) {
            this.stateManager.updateProgress(stage, detail.current || detail.progress, detail.total || 100, `[${agentName}] ${message}`);
        }
    }

    getRecentAgentLogs() {
        return this.agentLogs.slice(-40);
    }

    /**
     * 同步更新内存状态、本地磁盘缓存并向前端推送 Socket.IO 实时刷新事件
     */
    async _publishNewsSnapshot(displayList, fullPool, sourceStats, timestamp, phase = 'completed') {
        if (this.newsService) {
            this.newsService.setNewsData(displayList);
            this.newsService.setLastUpdated(timestamp);
            await this.newsService.saveLocalData(displayList);
        }

        if (this.stateManager) {
            this.stateManager.set('collectionPhase', phase, false);
            this.stateManager.set('sourceStats', sourceStats, false);
            this.stateManager.updateNewsData(displayList, fullPool);
        }

        if (this.io) {
            this.io.emit('news-updated', {
                success: true,
                phase,
                total: displayList.length,
                totalPool: fullPool.length,
                lastUpdated: timestamp.toISOString(),
                sourceStats
            });
        }
    }

    /**
     * 并发拉取所有启用的全球信源与自定义补充 RSS 源（纯网络搬运，不做任何筛选或加工）
     */
    async _executeScoutPatrol(categoryFilter = null) {
        const matrix = getGlobalSourceMatrix();
        const disabledSet = new Set((config.news.disabledSources || []).map(s => s.trim()));

        let enabledMatrixSources = matrix.filter(s => s.enabled && !disabledSet.has(s.name) && !disabledSet.has(s.id));
        if (categoryFilter && categoryFilter !== 'all') {
            enabledMatrixSources = enabledMatrixSources.filter(s => s.category === categoryFilter);
        }

        const envRssList = this.newsService ? this.newsService.parseRSSSources(config.news.rssSources) : [];
        const existingUrls = new Set(enabledMatrixSources.map(s => s.rssUrl).filter(Boolean));
        const existingNames = new Set(enabledMatrixSources.map(s => s.name.toLowerCase()));

        for (const envSrc of envRssList) {
            if (!envSrc.url || existingUrls.has(envSrc.url)) continue;
            const nameLower = (envSrc.name || '').toLowerCase();
            if (nameLower && existingNames.has(nameLower)) continue;
            if (disabledSet.has(envSrc.name)) continue;

            enabledMatrixSources.push({
                id: `env-${createArticleId(envSrc.url)}`,
                name: envSrc.name || new URL(envSrc.url).hostname,
                category: 'custom',
                region: null,
                authority: getSourceAuthorityScore(envSrc.name),
                enabled: true,
                maxArticles: config.news.maxArticlesPerSource || 5,
                strategy: 'rss',
                rssUrl: envSrc.url,
                url: envSrc.url
            });
        }

        const allArticles = [];
        const sourceStats = [];
        const concurrency = config.agent.sourceConcurrency || 8;

        for (let i = 0; i < enabledMatrixSources.length; i += concurrency) {
            const batch = enabledMatrixSources.slice(i, i + concurrency);
            const batchResults = await Promise.all(
                batch.map(async (src) => {
                    const t0 = Date.now();
                    try {
                        const items = await fetchFromGlobalSource(src);
                        const durationMs = Date.now() - t0;
                        sourceStats.push({
                            id: src.id,
                            name: src.name,
                            category: src.category,
                            count: items.length,
                            status: items.length > 0 ? 'ok' : 'empty',
                            strategy: items[0]?.source?.strategy || src.strategy,
                            durationMs
                        });
                        return items;
                    } catch (err) {
                        sourceStats.push({
                            id: src.id,
                            name: src.name,
                            category: src.category,
                            count: 0,
                            status: 'error',
                            error: err.message,
                            durationMs: Date.now() - t0
                        });
                        return [];
                    }
                })
            );

            for (const items of batchResults) {
                allArticles.push(...items);
            }

            const progress = 10 + Math.round(((i + batch.length) / Math.max(1, enabledMatrixSources.length)) * 40);
            this.emitAgentEvent(
                'Harvester 抓取器',
                'harvest_batch',
                `已拉取 ${Math.min(i + batch.length, enabledMatrixSources.length)}/${enabledMatrixSources.length} 个信源，累计获取 ${allArticles.length} 篇原始条目`,
                { progress }
            );
        }

        this.lastSourceStats = sourceStats;
        return { articles: allArticles, sourceStats };
    }

    /**
     * 对缺失配图的候选报道并发抓取原网页 og:image / twitter:image 或检索匹配题图 URL
     */
    async _enrichMissingArticleImages(articles) {
        if (!Array.isArray(articles) || articles.length === 0) return;
        const missing = articles.filter(a => !a.urlToImage);
        if (missing.length === 0) return;

        const concurrency = 8;
        for (let i = 0; i < missing.length; i += concurrency) {
            const slice = missing.slice(i, i + concurrency);
            await Promise.all(
                slice.map(async (article) => {
                    try {
                        let img = await fetchArticleLeadImage(article.url, 4500);
                        if (!img && article.title) {
                            img = await searchNewsImageByTitle(article.title, article.source?.domain || '', 4000);
                        }
                        if (img) {
                            article.urlToImage = img;
                        }
                    } catch (_) {}
                })
            );
        }
    }

    /**
     * 并发抓取候选报道的原网页原始外文文本（供 Antigravity 内置大模型直接提纯与全文精译）
     */
    async _enrichMissingArticleFullTexts(articles) {
        if (!Array.isArray(articles) || articles.length === 0) return;

        const concurrency = 8;
        for (let i = 0; i < articles.length; i += concurrency) {
            const slice = articles.slice(i, i + concurrency);
            await Promise.all(
                slice.map(async (article) => {
                    if (!article) return;
                    const existingRaw = String(article.fullText || article.content || article.description || '').trim();
                    const isTestEnv = process.env.NODE_ENV === 'test';
                    const isLocalUrl = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(article.url || '');

                    if (existingRaw.length < 450 && article.url && (!isTestEnv || isLocalUrl)) {
                        try {
                            const extracted = await extractFullArticleContent(article.url, { timeout: 6000, maxLength: 6500 });
                            if (extracted?.success && extracted.content && extracted.content.length > existingRaw.length) {
                                article.fullText = extracted.content;
                                if ((article.content || '').length < extracted.content.length) {
                                    article.content = extracted.content;
                                }
                            }
                        } catch (_) {}
                    }

                    const finalRaw = String(article.fullText || article.content || article.description || article.title || '').trim();
                    if (!article.fullText && finalRaw) {
                        article.fullText = finalRaw;
                    }
                    if (!Array.isArray(article.originalParagraphs) || article.originalParagraphs.length === 0) {
                        article.originalParagraphs = stripHtml(finalRaw)
                            .split(/\n+/)
                            .map(p => p.trim())
                            .filter(p => p.length >= 10);
                    }
                })
            );
        }
    }
}

module.exports = NewsAgentService;
