/**
 * 聚核 CoreFeed v2.0 — 多 Agent 新闻采集与渐进式编译引擎 (services/news_agent_service.js)
 *
 * 核心职责：
 *   1. Scout 巡检员：并发巡检全球 37 大知名媒体矩阵 (RSS / Google News 代理 / Jina 列表兜底)
 *   2. Curator 聚类总编：时效过滤、跨信源同事件归并、题图智能补全 (og:image / Bing News) 与首屏中文翻译
 *   3. Compiler 编译员 & Chief Editor 主编：大模型批量中文精编与《全球要闻深度综述》生成
 *   4. 状态快照发布 (`_publishNewsSnapshot`)：同步更新内存 `stateManager`、`data/news.json` 与 Socket.IO 广播
 */
const config = require('../config');
const logger = require('../utils/logger');
const { writeJsonFile, stripHtml, SimpleCache } = require('../utils/helpers');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');
const {
    fetchFromGlobalSource,
    fetchArticleLeadImage,
    searchNewsImageByTitle,
    extractFullArticleContent,
    createArticleId
} = require('./agent_tools');

class NewsAgentService {
    constructor(io = null, stateManager = null, aiService = null, newsService = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.aiService = aiService;
        this.newsService = newsService;
        this.isRunningPatrol = false;
        this.lastSourceStats = [];
        this.agentLogs = [];
        this.fullTextTranslationCache = new SimpleCache(200, 6 * 60 * 60 * 1000);
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
     * @param {Object} options - { maxDisplayCount, generateSummary, categoryFilter }
     */
    async runGlobalPatrolPipeline(options = {}) {
        if (this.isRunningPatrol) {
            throw new Error('全球新闻采集与编译任务正在进行中，请稍候');
        }

        this.isRunningPatrol = true;
        const startTime = Date.now();

        const maxDisplayCount = options.maxDisplayCount || config.agent.maxCuratedArticles || 30;
        const maxCandidatePool = config.agent.maxCandidatePool || 60;
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

            const clusteredArticles = this.aiService.mergeDuplicateArticlesSync(cleanedArticles);
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
            // 规则二次归并：将翻译为中文后显现出同题事件的多媒报道先行合并
            candidatePool = this.aiService.mergeDuplicateArticlesSync(candidatePool);

            const preliminaryDisplay = candidatePool.slice(0, maxDisplayCount);
            const multiSourceEvents = candidatePool.filter(a => (a.sourceCount || 1) > 1).length;
            const withImagesCount = preliminaryDisplay.filter(a => Boolean(a.urlToImage)).length;
            const now = new Date();

            // 【阶段一即时发布】把去重聚类、已汉化且补全题图的最新全球新闻推送到前端展示
            await this._publishNewsSnapshot(preliminaryDisplay, candidatePool, sourceStats, now, 'collected');

            this.emitAgentEvent(
                'Curator 聚类总编',
                'curate_done',
                `已即时展示 ${preliminaryDisplay.length} 条中文精选新闻（含 ${withImagesCount} 张高清题图、${multiSourceEvents} 个多媒交叉热点），正在启动 AI 语义深度去重与精编...`,
                { progress: 48, clusteredCount: clusteredArticles.length, selectedCount: candidatePool.length }
            );

            // ==================== STAGE 3: AI 语义深度去重与渐进式批量编译 ====================
            const hasAiKey = this.aiService.getCurrentModelInfo().apiKeyConfigured;

            if (hasAiKey) {
                this.emitAgentEvent(
                    'Curator 聚类总编',
                    'ai_dedup',
                    `正在调用 AI 大模型对 ${candidatePool.length} 条中英双语标题执行同事件深度语义去重...`,
                    { progress: 52 }
                );
                candidatePool = await this.aiService.deduplicateWithLLM(candidatePool, { maxInspect: 42, timeout: 28000 });
                // AI 语义去重完成后立即刷新一次前端快照，让同事件卡片即时合并
                await this._publishNewsSnapshot(candidatePool.slice(0, maxDisplayCount), candidatePool, sourceStats, new Date(), 'collected');
            }

            if (this.stateManager) {
                this.stateManager.set('collectionPhase', 'compiling');
            }

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
                        // 每完成一批编译，立即更新 StateManager 并通知前端增量刷新卡片
                        const currentDisplay = currentFullList.slice(0, maxDisplayCount);
                        await this._publishNewsSnapshot(currentDisplay, currentFullList, sourceStats, new Date(), 'compiling');
                    }
                );
            } else {
                // 未配置 AI Key 时，确保全部汉化
                enhancedArticles = await this.aiService.ensureBatchInChinese(candidatePool, 6);
                await this._publishNewsSnapshot(enhancedArticles.slice(0, maxDisplayCount), enhancedArticles, sourceStats, new Date(), 'completed');
            }

            const finalDisplayArticles = enhancedArticles.slice(0, maxDisplayCount);
            const finalTime = new Date();
            await this._publishNewsSnapshot(finalDisplayArticles, enhancedArticles, sourceStats, finalTime, 'completed');

            // ==================== STAGE 4: CHIEF EDITOR AGENT (生成今日要闻综述) ====================
            let summaryArticle = null;
            if (shouldGenerateSummary) {
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
     * 在采集阶段并发抓取候选报道的原文完整正文（供采编阶段直接完成原文全文中文翻译并随快照上传 GitHub）
     */
    async _enrichMissingArticleFullTexts(articles) {
        if (!Array.isArray(articles) || articles.length === 0) return;

        const concurrency = 6;
        for (let i = 0; i < articles.length; i += concurrency) {
            const slice = articles.slice(i, i + concurrency);
            await Promise.all(
                slice.map(async (article) => {
                    if (!article) return;
                    const existingRaw = String(article.fullText || article.content || article.description || '')
                        .replace(/\[[^\]]*补充报道\]:?\s*/g, '\n\n')
                        .trim();

                    const isTestEnv = process.env.NODE_ENV === 'test';
                    const isLocalUrl = /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(article.url || '');

                    if (existingRaw.length < 450 && article.url && (!isTestEnv || isLocalUrl)) {
                        try {
                            let extracted = await extractFullArticleContent(article.url, { timeout: 6000, maxLength: 5500 });
                            if ((!extracted || !extracted.content || extracted.content.length < 220) && Array.isArray(article.relatedSources)) {
                                for (const rel of article.relatedSources.slice(0, 2)) {
                                    if (rel?.url && rel.url !== article.url) {
                                        const relExt = await extractFullArticleContent(rel.url, { timeout: 5000, maxLength: 5500 });
                                        if (relExt?.success && (relExt.content || '').length >= 220) {
                                            extracted = relExt;
                                            break;
                                        }
                                    }
                                }
                            }
                            if (extracted?.success && extracted.content && extracted.content.length > existingRaw.length) {
                                article.fullText = extracted.content;
                                article.fullTextContent = extracted.content;
                                if ((article.content || '').length < extracted.content.length) {
                                    article.content = extracted.content;
                                }
                            }
                        } catch (_) {}
                    }

                    const finalRaw = String(article.fullText || article.content || article.description || article.title || '')
                        .replace(/\[[^\]]*补充报道\]:?\s*/g, '\n\n')
                        .trim();
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
     * 获取外媒原文全文中文翻译（优先直接读取采集阶段预译并随 GitHub 快照同步的 translatedParagraphs，缺失时才实时兜底提取翻译）
     */
    async translateArticleFullText(articleInfo = {}) {
        const {
            url,
            title = '',
            translatedTitle = '',
            sourceName = '',
            existingSummary = ''
        } = articleInfo;

        if (!url) {
            throw new Error('缺少新闻原文 URL');
        }

        const cached = this.fullTextTranslationCache.get(url);
        if (cached) {
            return { ...cached, fromCache: true };
        }

        const newsData = (this.stateManager && this.stateManager.get('newsData')) || [];
        const allPool = (this.stateManager && this.stateManager.get('allEnhancedNews')) || [];
        const matchedArticle =
            newsData.find(a => a && a.url === url) ||
            allPool.find(a => a && a.url === url) ||
            null;

        // 若该新闻在抓取/编译阶段已预生成全文中文翻译并存入 GitHub 快照，直接零延迟返回
        if (matchedArticle && Array.isArray(matchedArticle.translatedParagraphs) && matchedArticle.translatedParagraphs.length > 0) {
            const prebuiltRes = {
                success: true,
                url,
                title: matchedArticle.translatedTitle || translatedTitle || matchedArticle.title || title || '原文全文中文翻译',
                originalTitle: matchedArticle.title || title || '',
                sourceName: matchedArticle.source?.name || sourceName || 'Global Media',
                region: matchedArticle.region || '国际',
                category: matchedArticle.category || '国际',
                summary: matchedArticle.summary || existingSummary || '',
                keyPoints: Array.isArray(matchedArticle.keyPoints) ? matchedArticle.keyPoints : [],
                extractionMethod: 'snapshot_pretranslated',
                fullText: matchedArticle.fullText || matchedArticle.content || matchedArticle.description || '',
                translatedText: matchedArticle.translatedContent || matchedArticle.translatedParagraphs.join('\n\n'),
                translatedParagraphs: matchedArticle.translatedParagraphs,
                originalParagraphs: Array.isArray(matchedArticle.originalParagraphs) ? matchedArticle.originalParagraphs : [],
                fromSnapshot: true
            };
            this.fullTextTranslationCache.set(url, prebuiltRes);
            return prebuiltRes;
        }

        let extracted = null;
        let extractionMethod = 'cheerio_readability';

        const preloadedFullText = matchedArticle?.fullText || matchedArticle?.fullTextContent || '';
        if (preloadedFullText && preloadedFullText.length >= 260) {
            extracted = {
                success: true,
                content: preloadedFullText,
                title: matchedArticle?.title || title,
                method: 'cached_fulltext'
            };
            extractionMethod = extracted.method;
        } else {
            extracted = await extractFullArticleContent(url, { timeout: 6500, maxLength: 5500 });
            if (extracted?.success && extracted.content) {
                extractionMethod = extracted.method || 'cheerio_readability';
                if (matchedArticle) {
                    matchedArticle.fullText = extracted.content;
                    matchedArticle.fullTextContent = extracted.content;
                }
            }
        }

        // 若主链接受防爬限制正文过短，自动尝试从同题交叉印证媒体 (relatedSources) 提取原文全文
        if ((!extracted || !extracted.content || extracted.content.length < 200) && Array.isArray(matchedArticle?.relatedSources)) {
            for (const rel of matchedArticle.relatedSources.slice(0, 2)) {
                if (rel?.url && rel.url !== url) {
                    const relExtracted = await extractFullArticleContent(rel.url, { timeout: 5500, maxLength: 5500 });
                    if (relExtracted?.success && (relExtracted.content || '').length >= 200) {
                        extracted = relExtracted;
                        extractionMethod = `${relExtracted.method || 'readability'} (${rel.name || '交叉信源'})`;
                        break;
                    }
                }
            }
        }

        const fallbackContent = [
            matchedArticle?.fullText || '',
            matchedArticle?.content || '',
            matchedArticle?.description || '',
            existingSummary || ''
        ].filter(Boolean).sort((a, b) => b.length - a.length)[0] || title;

        const rawBody = (extracted && extracted.success && extracted.content && extracted.content.length >= 80)
            ? extracted.content
            : fallbackContent;

        const leadSummary = matchedArticle?.summary || existingSummary || '';
        const keyPoints = Array.isArray(matchedArticle?.keyPoints) ? matchedArticle.keyPoints : [];
        const zhBody = await this.aiService.translateParagraphsToChinese(rawBody, 5500);

        const translatedParagraphs = stripHtml(zhBody)
            .split(/\n+/)
            .map(p => p.trim())
            .filter(p => p.length >= 10);

        const originalParagraphs = stripHtml(rawBody)
            .split(/\n+/)
            .map(p => p.trim())
            .filter(p => p.length >= 10);

        const finalParagraphs = translatedParagraphs.length > 0
            ? translatedParagraphs
            : (leadSummary ? [stripHtml(leadSummary)] : [stripHtml(rawBody)]);

        const finalRes = {
            success: true,
            url,
            title: matchedArticle?.translatedTitle || translatedTitle || title || extracted?.title || '原文全文中文翻译',
            originalTitle: matchedArticle?.title || title || extracted?.title || '',
            sourceName: matchedArticle?.source?.name || sourceName || 'Global Media',
            region: matchedArticle?.region || '国际',
            category: matchedArticle?.category || '国际',
            summary: leadSummary,
            keyPoints,
            extractionMethod,
            fullText: rawBody,
            translatedText: finalParagraphs.join('\n\n'),
            translatedParagraphs: finalParagraphs,
            originalParagraphs
        };

        this.fullTextTranslationCache.set(url, finalRes);
        return finalRes;
    }
}

module.exports = NewsAgentService;
