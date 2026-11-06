const config = require('../config');
const logger = require('../utils/logger');
const { writeJsonFile, stripHtml } = require('../utils/helpers');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');
const {
    fetchFromGlobalSource,
    extractFullArticleContent,
    fetchArticleLeadImage,
    searchNewsImageByTitle,
    createArticleId
} = require('./agent_tools');

/**
 * 聚核多 Agent 新闻搜集与渐进式编译引擎 (NewsAgentService)
 * 采用两阶段渐进式架构：
 * - 第一阶段（秒级采集与即时展示）：并发采集全球名媒 -> 跨信源事件聚类 -> 规则预分类 -> 立即推送前端展示
 * - 第二阶段（后台渐进深读与编译）：Jina/Cheerio 全文提取 -> 分批 AI 中文编译并实时增量刷新卡片 -> 生成今日要闻综述
 */
class NewsAgentService {
    constructor(io = null, stateManager = null, aiService = null, newsService = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.aiService = aiService;
        this.newsService = newsService;
        this.isRunningPatrol = false;
        this.lastSourceStats = [];
        this.agentLogs = [];
    }

    setServices({ io, stateManager, aiService, newsService }) {
        if (io) this.io = io;
        if (stateManager) this.stateManager = stateManager;
        if (aiService) this.aiService = aiService;
        if (newsService) this.newsService = newsService;
    }

    /**
     * 记录并广播 Agent 实时工作流日志
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

    getLastSourceStats() {
        return this.lastSourceStats;
    }

    /**
     * 核心流水线：两阶段渐进式全球新闻采集、即时展示与后台 AI 编译
     * @param {Object} options - { maxDisplayCount, deepReadCount, generateSummary, categoryFilter }
     */
    async runGlobalPatrolPipeline(options = {}) {
        if (this.isRunningPatrol) {
            throw new Error('全球新闻采集与编译任务正在进行中，请稍候');
        }

        this.isRunningPatrol = true;
        const startTime = Date.now();

        const maxDisplayCount = options.maxDisplayCount || config.agent.maxCuratedArticles || 30;
        const maxCandidatePool = config.agent.maxCandidatePool || 60;
        const deepReadCount = options.deepReadCount !== undefined ? options.deepReadCount : (config.agent.deepReadTopCount || 8);
        const shouldGenerateSummary = options.generateSummary !== undefined ? options.generateSummary : true;

        try {
            if (this.stateManager) {
                this.stateManager.set('collectionPhase', 'collecting');
                this.stateManager.setUpdateStatus(true, {
                    stage: 'scout',
                    current: 5,
                    total: 100,
                    message: 'Scout Agent 启动全球知名信源并发采集...'
                });
            }

            // ==================== STAGE 1: SCOUT AGENT (全球信源并发巡检) ====================
            this.emitAgentEvent('Scout 巡检员', 'scout', '正在并发巡检全球知名媒体矩阵 (Reuters, AP, BBC, NYT, Bloomberg, SCMP, NHK 等)...', {
                progress: 8
            });

            const { articles: rawHarvested, sourceStats } = await this._executeScoutPatrol(options.categoryFilter);
            this.lastSourceStats = sourceStats;

            if (rawHarvested.length === 0) {
                throw new Error('未能从任何信源获取到有效新闻，请检查网络连接');
            }

            const activeSourceCount = sourceStats.filter(s => s.status === 'ok').length;
            this.emitAgentEvent(
                'Scout 巡检员',
                'scout_done',
                `信源采集完成：成功从 ${activeSourceCount}/${sourceStats.length} 个全球信源捕获 ${rawHarvested.length} 篇最新报道`,
                { progress: 30, rawCount: rawHarvested.length, activeSources: activeSourceCount }
            );

            // ==================== STAGE 2: CURATOR AGENT (跨源聚类、打分与即时展示) ====================
            this.emitAgentEvent('Curator 聚类总编', 'curate', '正在进行时效过滤、跨信源事件合并与权威度排序...', {
                progress: 38
            });

            const cleanedArticles = this.newsService
                ? this.newsService.filterAndCleanArticles(rawHarvested)
                : this._basicCleanArticles(rawHarvested);

            const clusteredArticles = await this.aiService.removeDuplicateNewsWithAI(cleanedArticles);
            const rankedCandidates = await this.aiService.selectTopQualityNews(clusteredArticles, maxCandidatePool);

            // 选取进入展示与编译池的候选集，并立即赋予规则预判的地区、分类与初始摘要
            let candidatePool = rankedCandidates
                .slice(0, Math.max(maxDisplayCount + 10, 40))
                .map(item => this.aiService.applyPreliminaryMetadata(item));

            // 【阶段一快速中文化与配图补全】并发执行首屏中文翻译与缺失题图抓取，确保首屏即呈现带图中文卡片
            this.emitAgentEvent('Curator 聚类总编', 'curate_translate', '正在对精选新闻执行高速首屏汉化与高清题图补全...', {
                progress: 43
            });
            const topForImages = candidatePool.slice(0, maxDisplayCount);
            const [translatedPool] = await Promise.all([
                this.aiService.ensureBatchInChinese(candidatePool, 8),
                this._enrichMissingArticleImages(topForImages)
            ]);
            candidatePool = translatedPool.map((item, idx) => ({
                ...item,
                urlToImage: item.urlToImage || topForImages[idx]?.urlToImage || null
            }));

            const preliminaryDisplay = candidatePool.slice(0, maxDisplayCount);
            const multiSourceEvents = candidatePool.filter(a => (a.sourceCount || 1) > 1).length;
            const withImagesCount = preliminaryDisplay.filter(a => Boolean(a.urlToImage)).length;
            const now = new Date();

            // 【阶段一即时发布】把去重聚类、已汉化且补全题图的最新全球新闻推送到前端展示！
            await this._publishNewsSnapshot(preliminaryDisplay, candidatePool, sourceStats, now, 'collected');

            this.emitAgentEvent(
                'Curator 聚类总编',
                'curate_done',
                `已即时展示 ${preliminaryDisplay.length} 条中文精选新闻（含 ${withImagesCount} 张高清题图、${multiSourceEvents} 个多媒交叉热点），正在后台启动全文深读与 AI 精编...`,
                { progress: 48, clusteredCount: clusteredArticles.length, selectedCount: candidatePool.length }
            );

            // ==================== STAGE 3: DEEP-READER & COMPILER (全文深读、配图补全与渐进式批量编译) ====================

            if (deepReadCount > 0) {
                this.emitAgentEvent(
                    'Deep-Reader 深读员',
                    'deep_read',
                    `正在使用 Jina Reader 与智能正文抽取器提取前 ${deepReadCount} 条核心焦点报道全文...`,
                    { progress: 55 }
                );
                await this._enrichTopArticlesWithFullText(candidatePool, deepReadCount);
            }

            if (this.stateManager) {
                this.stateManager.set('collectionPhase', 'compiling');
            }

            const hasAiKey = this.aiService.getCurrentModelInfo().apiKeyConfigured;
            let enhancedArticles = candidatePool;

            if (hasAiKey) {
                this.emitAgentEvent(
                    'Compiler 编译员',
                    'compile',
                    `正在分批执行 AI 深度中文精编 (${candidatePool.length} 条)，每完成一批将实时刷新页面卡片...`,
                    { progress: 62 }
                );

                enhancedArticles = await this.aiService.enhanceNewsArticles(
                    candidatePool,
                    ({ current, total, batchIndex, totalBatches }) => {
                        const pct = 62 + Math.round((current / Math.max(1, total)) * 24);
                        this.emitAgentEvent(
                            'Compiler 编译员',
                            'compile_progress',
                            `正在精编第 ${batchIndex}/${totalBatches} 批新闻卡片 (${current}/${total})...`,
                            { progress: pct, current, total }
                        );
                    },
                    async (_compiledBatch, _startIndex, currentFullList) => {
                        // 每完成一批编译，立即更新 StateManager 并通知前端增量刷新卡片！
                        const currentDisplay = currentFullList.slice(0, maxDisplayCount);
                        await this._publishNewsSnapshot(currentDisplay, currentFullList, sourceStats, new Date(), 'compiling');
                    }
                );
            } else {
                // 未配置 AI Key 时，同步 Jina 提取后的最新摘要并确保全部汉化
                enhancedArticles = await this.aiService.ensureBatchInChinese(candidatePool, 6);
                await this._publishNewsSnapshot(enhancedArticles.slice(0, maxDisplayCount), enhancedArticles, sourceStats, new Date(), 'completed');
            }

            const finalDisplayArticles = enhancedArticles.slice(0, maxDisplayCount);
            const finalTime = new Date();
            await this._publishNewsSnapshot(finalDisplayArticles, enhancedArticles, sourceStats, finalTime, 'completed');

            // ==================== STAGE 4: CHIEF EDITOR AGENT (生成今日要闻综述) ====================
            let summaryArticle = null;
            if (shouldGenerateSummary && hasAiKey) {
                try {
                    this.emitAgentEvent(
                        'Chief Editor 主编',
                        'summary',
                        `正在统筹 ${finalDisplayArticles.length} 条要闻撰写今日《全球要闻深度综述》...`,
                        { progress: 90 }
                    );

                    summaryArticle = await this.aiService.generateNewsSummaryArticle(finalDisplayArticles);

                    if (this.stateManager) {
                        this.stateManager.updateSummaryArticle(summaryArticle);
                    }

                    await writeJsonFile(config.storage.summaryFile, {
                        article: summaryArticle,
                        savedAt: new Date().toISOString(),
                        version: '2.0'
                    });

                    if (this.io) {
                        this.io.emit('summary-completed', {
                            success: true,
                            article: summaryArticle
                        });
                    }
                } catch (sumErr) {
                    logger.warn('AGENT', `生成综述文章失败: ${sumErr.message}`);
                }
            }

            const elapsedSeconds = ((Date.now() - startTime) / 1000).toFixed(1);
            this.emitAgentEvent(
                'CoreFeed 中枢',
                'completed',
                `全球新闻采集与编译全部完成！共展示 ${finalDisplayArticles.length} 条精选新闻（总耗时 ${elapsedSeconds}s）`,
                { progress: 100, elapsedSeconds }
            );

            return {
                success: true,
                displayedCount: finalDisplayArticles.length,
                totalEnhancedCount: enhancedArticles.length,
                rawHarvestedCount: rawHarvested.length,
                sourceStats,
                news: finalDisplayArticles,
                summaryArticle,
                lastUpdated: finalTime.toISOString(),
                elapsedSeconds: Number(elapsedSeconds)
            };
        } finally {
            this.isRunningPatrol = false;
            if (this.stateManager) {
                this.stateManager.set('collectionPhase', 'idle');
                this.stateManager.setUpdateStatus(false);
            }
        }
    }

    /**
     * 同步更新内存状态、本地磁盘缓存并向前端推送 Socket.IO 实时刷新事件
     */
    async _publishNewsSnapshot(displayList, fullPool, sourceStats, timestamp, phase = 'collected') {
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
     * Scout Agent 并发巡检所有启用的全球信源 + NewsAPI + Gnews
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

            const progress = 8 + Math.round(((i + batch.length) / Math.max(1, enabledMatrixSources.length)) * 20);
            this.emitAgentEvent(
                'Scout 巡检员',
                'scout_batch',
                `已巡检 ${Math.min(i + batch.length, enabledMatrixSources.length)}/${enabledMatrixSources.length} 个信源，累计捕获 ${allArticles.length} 篇报道`,
                { progress }
            );
        }

        if (!categoryFilter || categoryFilter === 'all') {
            if (this.newsService && config.news.newsApiEnabled && config.news.apiKey) {
                try {
                    const apiItems = await this.newsService.fetchNewsApiArticles();
                    if (apiItems.length > 0) {
                        allArticles.push(...apiItems);
                        sourceStats.push({
                            id: 'newsapi',
                            name: 'NewsAPI Global Headlines',
                            category: 'api',
                            count: apiItems.length,
                            status: 'ok',
                            strategy: 'api'
                        });
                    }
                } catch (_) {}
            }

            if (this.newsService && config.gnews.enabled && config.gnews.apiKey) {
                try {
                    const gnewsItems = await this.newsService.fetchGnewsArticles();
                    if (gnewsItems.length > 0) {
                        allArticles.push(...gnewsItems);
                        sourceStats.push({
                            id: 'gnews',
                            name: 'GNews Global Top',
                            category: 'api',
                            count: gnewsItems.length,
                            status: 'ok',
                            strategy: 'api'
                        });
                    }
                } catch (_) {}
            }
        }

        return { articles: allArticles, sourceStats };
    }

    /**
     * 对缺失配图的精选报道并发抓取页面 og:image / twitter:image 或通过 Bing News 智能检索匹配题图
     */
    async _enrichMissingArticleImages(articles) {
        if (!Array.isArray(articles) || articles.length === 0) return;
        const missing = articles.filter(a => !a.urlToImage);
        if (missing.length === 0) return;

        const concurrency = 6;
        for (let i = 0; i < missing.length; i += concurrency) {
            const slice = missing.slice(i, i + concurrency);
            await Promise.all(
                slice.map(async (article) => {
                    try {
                        let img = await fetchArticleLeadImage(article.url, 4500);
                        if (!img && Array.isArray(article.relatedSources)) {
                            for (const rel of article.relatedSources) {
                                if (rel.url) {
                                    img = await fetchArticleLeadImage(rel.url, 4000);
                                    if (img) break;
                                }
                            }
                        }
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
     * 对高优先级但摘要较短的新闻执行 Jina Reader / Readability 全文深读扩充
     */
    async _enrichTopArticlesWithFullText(articles, maxDeepRead = 8) {
        const candidates = articles
            .filter(a => a.url && ((a.content || '').length < 350 || a.needsDeepRead))
            .slice(0, maxDeepRead);

        if (candidates.length === 0) return;

        const concurrency = 4;
        for (let i = 0; i < candidates.length; i += concurrency) {
            const batch = candidates.slice(i, i + concurrency);
            await Promise.all(
                batch.map(async (article) => {
                    try {
                        const extracted = await extractFullArticleContent(article.url, { timeout: 10000, maxLength: 2500 });
                        if (extracted && extracted.success && extracted.content) {
                            article.fullTextContent = extracted.content;
                            article.content = extracted.content;
                            article.deepReadMethod = extracted.method;
                        }
                        if (!article.urlToImage && extracted?.imageUrl) {
                            article.urlToImage = extracted.imageUrl;
                        }
                    } catch (_) {}
                })
            );
        }
    }

    _basicCleanArticles(articles) {
        const cutoff = Date.now() - (config.agent.freshnessHours || 48) * 3600000;
        return articles.filter(a => {
            if (!a || !a.title || a.title.includes('[Removed]')) return false;
            if (a.publishedAt) {
                const t = new Date(a.publishedAt).getTime();
                if (!isNaN(t) && t < cutoff) return false;
            }
            return true;
        });
    }

    /**
     * 单篇外媒报道即时全文深读与深度解读
     */
    async deepReadSingleArticle({ url, title = '', sourceName = '', existingSummary = '' }) {
        if (!url) {
            throw new Error('缺少新闻原文 URL');
        }

        const extracted = await extractFullArticleContent(url, { timeout: 15000, maxLength: 4500 });
        const rawBody = (extracted && extracted.success && extracted.content)
            ? extracted.content
            : existingSummary || title;

        const buildFallbackTranslationHtml = async () => {
            const zhBody = await this.aiService.translateTextToChinese(rawBody.slice(0, 1500));
            const paragraphs = stripHtml(zhBody)
                .split(/\n+/)
                .map(p => p.trim())
                .filter(Boolean)
                .map(p => `<p class="summary-paragraph">${p}</p>`)
                .join('');
            return `<h3 class="summary-section-title">全文核心内容中文直译</h3>${paragraphs || `<p class="summary-paragraph">${stripHtml(zhBody)}</p>`}`;
        };

        if (!this.aiService.getCurrentModelInfo().apiKeyConfigured) {
            const analysisHtml = await buildFallbackTranslationHtml();
            return {
                success: true,
                url,
                title,
                sourceName,
                extractionMethod: extracted?.method || 'fallback',
                fullText: rawBody,
                analysisHtml
            };
        }

        const prompt = `你是一位资深国际新闻编译专家。请对以下来自 [${sourceName || '国际知名媒体'}] 的外媒报道进行全文深读与中文精译解读。

新闻标题：${title || extracted?.title || ''}
提取到的原文内容：
${rawBody}

请按以下结构输出（使用 ### 小标题）：
### 核心导读
（用一段话概括这篇报道最核心的增量信息）
### 全文核心内容精译
（详实、流畅地将报道的核心段落、关键引语和数据编译为中文，保留关键人物与机构名称）
### 背景与深层解读
（简明分析该报道背后的地缘政治、经济或产业背景）

直接输出内容，不要包含 <think> 标签。`;

        try {
            const analysisText = await this.aiService._callAI([{ role: 'user', content: prompt }]);
            const analysisHtml = this.aiService.convertSummaryToRichHtml(analysisText, []);
            return {
                success: true,
                url,
                title: title || extracted?.title || '',
                sourceName,
                extractionMethod: extracted?.success ? extracted.method : 'summary_fallback',
                fullText: rawBody,
                analysisMarkdown: analysisText,
                analysisHtml
            };
        } catch (err) {
            logger.warn('AGENT', `单篇深读大模型调用降级，使用自动中文翻译: ${err.message}`);
            const analysisHtml = await buildFallbackTranslationHtml();
            return {
                success: true,
                url,
                title: title || extracted?.title || '',
                sourceName,
                extractionMethod: extracted?.success ? extracted.method : 'summary_fallback',
                fullText: rawBody,
                analysisHtml
            };
        }
    }
}

module.exports = NewsAgentService;
