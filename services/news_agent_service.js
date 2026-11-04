const config = require('../config');
const logger = require('../utils/logger');
const { writeJsonFile, readJsonFile, stripHtml, truncateText } = require('../utils/helpers');
const { getGlobalSourceMatrix, getSourceAuthorityScore } = require('../config/global_sources');
const {
    fetchFromGlobalSource,
    extractFullArticleContent,
    searchGlobalNewsByTopic,
    createArticleId
} = require('./agent_tools');

/**
 * 聚核多 Agent 协同引擎 (NewsAgentService)
 * 负责统筹：
 * 1. Scout Agent (全球知名信源矩阵巡检)
 * 2. Curator Agent (跨信源事件聚类、交叉验证与价值排序)
 * 3. Deep-Reader & Compiler Agent (Jina Reader 全文深读 + 批量中文情报编译)
 * 4. Chief Editor & Investigator Agent (全局深度综述、播客脚本与按需专题深挖)
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
     * 核心流水线 1：执行全球知名信源巡检与多 Agent 整合
     * @param {Object} options - { maxDisplayCount, deepReadCount, generateSummary, categoryFilter }
     */
    async runGlobalPatrolPipeline(options = {}) {
        if (this.isRunningPatrol) {
            throw new Error('Agent 全球巡检任务正在进行中，请稍候');
        }

        this.isRunningPatrol = true;
        const startTime = Date.now();

        const maxDisplayCount = options.maxDisplayCount || config.agent.maxCuratedArticles || 30;
        const maxCandidatePool = config.agent.maxCandidatePool || 60;
        const deepReadCount = options.deepReadCount !== undefined ? options.deepReadCount : (config.agent.deepReadTopCount || 8);
        const shouldGenerateSummary = options.generateSummary !== undefined ? options.generateSummary : true;

        try {
            if (this.stateManager) {
                this.stateManager.setUpdateStatus(true, {
                    stage: 'scout',
                    current: 5,
                    total: 100,
                    message: 'Scout Agent 启动全球知名信源巡检...'
                });
            }

            // ==================== STAGE 1: SCOUT AGENT (全球信源巡检) ====================
            this.emitAgentEvent('Scout Agent (信源巡检员)', 'scout', '正在并发巡检全球知名媒体矩阵 (Reuters, AP, BBC, NYT, Bloomberg, SCMP, NHK 等)...', {
                progress: 8
            });

            const { articles: rawHarvested, sourceStats } = await this._executeScoutPatrol(options.categoryFilter);
            this.lastSourceStats = sourceStats;

            if (rawHarvested.length === 0) {
                throw new Error('未能从任何信源获取到有效新闻，请检查网络连接');
            }

            const activeSourceCount = sourceStats.filter(s => s.status === 'ok').length;
            this.emitAgentEvent(
                'Scout Agent (信源巡检员)',
                'scout_done',
                `巡检完成：成功从 ${activeSourceCount}/${sourceStats.length} 个全球信源采集到 ${rawHarvested.length} 篇原始报道`,
                { progress: 28, rawCount: rawHarvested.length, activeSources: activeSourceCount }
            );

            // ==================== STAGE 2: CURATOR AGENT (清洗、跨源聚类与价值甄选) ====================
            this.emitAgentEvent('Curator Agent (聚类甄选总编)', 'curate', '正在进行时效性过滤、跨信源事件聚类与多媒交叉验证...', {
                progress: 35
            });

            const cleanedArticles = this.newsService
                ? this.newsService.filterAndCleanArticles(rawHarvested)
                : this._basicCleanArticles(rawHarvested);

            // 跨信源事件聚类与合并关联报道
            const clusteredArticles = await this.aiService.removeDuplicateNewsWithAI(cleanedArticles);

            // 权威度 + 时效 + 多信源热度排序，保留前 maxCandidatePool 条进入编译池
            const rankedCandidates = await this.aiService.selectTopQualityNews(clusteredArticles, maxCandidatePool);

            const multiSourceEvents = rankedCandidates.filter(a => (a.sourceCount || 1) > 1).length;
            this.emitAgentEvent(
                'Curator Agent (聚类甄选总编)',
                'curate_done',
                `聚类甄选完成：合并为 ${clusteredArticles.length} 个独立事件（其中 ${multiSourceEvents} 个热点获多家权威外媒交叉报道），精选 Top ${rankedCandidates.length} 进入编译池`,
                { progress: 45, clusteredCount: clusteredArticles.length, selectedCount: rankedCandidates.length }
            );

            // ==================== STAGE 3: DEEP-READER & COMPILER AGENT (全文深读与中文编译) ====================
            const toCompile = rankedCandidates.slice(0, Math.max(maxDisplayCount + 10, 40));

            if (deepReadCount > 0) {
                this.emitAgentEvent(
                    'Deep-Reader Agent (全文深读员)',
                    'deep_read',
                    `正在使用 Jina Reader 与智能正文抽取器深读前 ${deepReadCount} 条核心焦点报道全文...`,
                    { progress: 52 }
                );
                await this._enrichTopArticlesWithFullText(toCompile, deepReadCount);
            }

            this.emitAgentEvent(
                'Compiler Agent (编译分析员)',
                'compile',
                `正在批量编译 ${toCompile.length} 条全球新闻（生成中文标题、百字深度摘要、地域与领域标签）...`,
                { progress: 62 }
            );

            const enhancedArticles = await this.aiService.enhanceNewsArticles(toCompile, ({ current, total }) => {
                const pct = 62 + Math.round((current / Math.max(1, total)) * 22);
                this.emitAgentEvent(
                    'Compiler Agent (编译分析员)',
                    'compile_progress',
                    `正在编译全球情报卡片 (${current}/${total})...`,
                    { progress: pct, current, total }
                );
            });

            const finalDisplayArticles = enhancedArticles.slice(0, maxDisplayCount);
            const now = new Date();

            // 同步更新到 NewsService 和 StateManager 并落盘
            if (this.newsService) {
                this.newsService.setNewsData(finalDisplayArticles);
                this.newsService.setLastUpdated(now);
                await this.newsService.saveLocalData(finalDisplayArticles);
            }

            if (this.stateManager) {
                this.stateManager.updateNewsData(finalDisplayArticles, enhancedArticles);
                this.stateManager.set('sourceStats', sourceStats);
            }

            if (this.io) {
                this.io.emit('news-updated', {
                    success: true,
                    total: finalDisplayArticles.length,
                    totalPool: enhancedArticles.length,
                    lastUpdated: now.toISOString(),
                    sourceStats
                });
            }

            // ==================== STAGE 4: CHIEF EDITOR AGENT (生成全球深度综述) ====================
            let summaryArticle = null;
            if (shouldGenerateSummary && this.aiService.getCurrentModelInfo().apiKeyConfigured) {
                try {
                    this.emitAgentEvent(
                        'Chief Editor Agent (主编综述员)',
                        'summary',
                        `正在统筹 ${finalDisplayArticles.length} 条要闻撰写今日《全球新闻深度综述》...`,
                        { progress: 88 }
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
                'Orchestrator (聚核中枢)',
                'completed',
                `全球知名信源搜集与整合完成！共输出 ${finalDisplayArticles.length} 条精选情报（耗时 ${elapsedSeconds}s）`,
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
                lastUpdated: now.toISOString(),
                elapsedSeconds: Number(elapsedSeconds)
            };
        } finally {
            this.isRunningPatrol = false;
            if (this.stateManager) {
                this.stateManager.setUpdateStatus(false);
            }
        }
    }

    /**
     * Scout Agent 并发巡检所有启用的全球信源 + NewsAPI + Gnews
     */
    async _executeScoutPatrol(categoryFilter = null) {
        const matrix = getGlobalSourceMatrix();
        const disabledSet = new Set((config.news.disabledSources || []).map(s => s.trim()));

        // 1. 筛选启用的预置与自定义矩阵信源
        let enabledMatrixSources = matrix.filter(s => s.enabled && !disabledSet.has(s.name) && !disabledSet.has(s.id));
        if (categoryFilter && categoryFilter !== 'all') {
            enabledMatrixSources = enabledMatrixSources.filter(s => s.category === categoryFilter);
        }

        // 2. 合并用户在 .env RSS_SOURCES 中额外配置的非重复源
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
        const concurrency = config.agent.sourceConcurrency || 6;

        // 分批并发巡检信源矩阵
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

            const progress = 8 + Math.round(((i + batch.length) / Math.max(1, enabledMatrixSources.length)) * 18);
            this.emitAgentEvent(
                'Scout Agent (信源巡检员)',
                'scout_batch',
                `已巡检 ${Math.min(i + batch.length, enabledMatrixSources.length)}/${enabledMatrixSources.length} 个信源，累计捕获 ${allArticles.length} 篇报道`,
                { progress }
            );
        }

        // 3. 并行补充 NewsAPI 与 GNews（若启用且无特定分类过滤）
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
                        const extracted = await extractFullArticleContent(article.url, { timeout: 12000, maxLength: 2500 });
                        if (extracted && extracted.success && extracted.content) {
                            article.fullTextContent = extracted.content;
                            article.content = extracted.content;
                            article.deepReadMethod = extracted.method;
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
     * 核心流水线 2：按需专题调查 Agent (Interactive Topic Research Agent)
     * 用户输入任意全球热点主题，Agent 自动规划中英文检索词、跨源搜集名媒报道、深读原文并生成对比分析报告
     * @param {string} topic - 专题或问题（如“中东局势”、“美联储降息”、“台积电与AI芯片”）
     * @param {Object} options - { authoritativeOnly, maxArticles }
     */
    async runTopicResearchPipeline(topic, options = {}) {
        if (!topic || !topic.trim()) {
            throw new Error('请输入要搜集整合的新闻主题或关键词');
        }

        const cleanTopic = topic.trim();
        const authoritativeOnly = options.authoritativeOnly !== undefined ? Boolean(options.authoritativeOnly) : false;
        const maxArticles = options.maxArticles || 12;

        this.emitAgentEvent(
            'Research Agent (专题调查员)',
            'research_start',
            `收到专题指令：「${cleanTopic}」，正在规划全球多语种检索策略...`,
            { progress: 10 }
        );

        // 1. 让 AI 生成最佳英文国际媒体检索词 + 中文检索词
        let englishQuery = cleanTopic;
        if (this.aiService.getCurrentModelInfo().apiKeyConfigured && /[\u4e00-\u9fa5]/.test(cleanTopic)) {
            try {
                const qPrompt = `请将以下中文新闻搜索主题转换为最适合在 Reuters、BBC、NYT、Bloomberg 等英文国际媒体上检索的精炼英文关键词（2-5个词，不要带引号或多余解释）：\n${cleanTopic}`;
                const translatedQ = await this.aiService._callAI([{ role: 'user', content: qPrompt }]);
                if (translatedQ && translatedQ.length < 80) {
                    englishQuery = translatedQ.replace(/["'。]/g, '').trim();
                }
            } catch (_) {}
        }

        this.emitAgentEvent(
            'Research Agent (专题调查员)',
            'research_search',
            `正在检索全球知名媒体：英文检索词 [${englishQuery}] / 原始主题 [${cleanTopic}]...`,
            { progress: 30 }
        );

        // 2. 并行执行国际英文名媒检索 + 原始词检索
        const [enResults, rawResults] = await Promise.all([
            searchGlobalNewsByTopic(englishQuery, {
                maxResults: maxArticles,
                authoritativeOnly,
                timeRange: options.timeRange || '7d',
                language: 'en'
            }),
            englishQuery !== cleanTopic
                ? searchGlobalNewsByTopic(cleanTopic, {
                    maxResults: Math.ceil(maxArticles / 2),
                    authoritativeOnly: false,
                    timeRange: options.timeRange || '7d'
                })
                : Promise.resolve([])
        ]);

        const combined = [...enResults, ...rawResults];
        const deduped = await this.aiService.removeDuplicateNewsWithAI(combined);
        const topSelected = await this.aiService.selectTopQualityNews(deduped, maxArticles);

        if (topSelected.length === 0) {
            return {
                success: false,
                topic: cleanTopic,
                englishQuery,
                message: `未能在近期全球主流信源中检索到关于「${cleanTopic}」的报道，请尝试更换关键词。`,
                articles: [],
                reportHtml: ''
            };
        }

        // 3. 对前 4 篇核心报道执行 Jina Reader 全文深读
        this.emitAgentEvent(
            'Deep-Reader Agent (全文深读员)',
            'research_deep_read',
            `已捕获 ${topSelected.length} 篇外媒报道，正在深读前 4 篇权威原文提取核心事实...`,
            { progress: 55 }
        );
        await this._enrichTopArticlesWithFullText(topSelected, 4);

        // 4. 批量编译检索到的文章卡片
        this.emitAgentEvent(
            'Compiler Agent (编译分析员)',
            'research_compile',
            `正在编译 ${topSelected.length} 篇专题情报卡片...`,
            { progress: 72 }
        );
        const compiledArticles = await this.aiService.enhanceNewsArticles(topSelected);

        // 5. 生成跨信源深度对比分析报告
        let reportMarkdown = '';
        let reportHtml = '';

        if (this.aiService.getCurrentModelInfo().apiKeyConfigured) {
            this.emitAgentEvent(
                'Chief Analyst Agent (首席分析员)',
                'research_synthesize',
                `正在交叉比对各方信源立场，撰写《「${cleanTopic}」全球多信源深度整合报告》...`,
                { progress: 88 }
            );

            const dossierInput = compiledArticles.map((a, idx) => {
                const body = truncateText(a.fullTextContent || a.summary || a.description || '', 500);
                return `[#${idx + 1}] 媒体: ${a.source?.name || '外媒'} | 标题: ${a.translatedTitle || a.title}\n摘要与正文要点: ${body}`;
            }).join('\n\n');

            const reportPrompt = `你是“聚核 (CoreFeed)”首席国际情报分析 Agent。用户请求围绕专题「${cleanTopic}」搜集整合全球知名信源的报道。
以下是我们刚刚从全球媒体实时检索并深读的 ${compiledArticles.length} 篇报道：

${dossierInput}

请撰写一份结构清晰、客观专业的《「${cleanTopic}」全球信源深度整合报告》，包含以下四个部分（使用 ### 作为小标题）：
### 一、 核心态势综述
（150-250字，直击事件最新进展与核心焦点，在引述处标注 [NEWS_1]、[NEWS_2] 等）
### 二、 关键事实与数据脉络
（列出3-5条经多方核实的核心事实或关键表态，标注 [NEWS_X]）
### 三、 全球知名媒体视角对比
（对比分析不同国际媒体——如欧美主流媒体、通讯社、亚太媒体等——在报道该议题时的侧重点或观点差异）
### 四、 后续演进与关注点
（简明总结接下来值得跟踪的关键节点）

请直接输出报告正文，不要包含任何 <think> 思考过程。`;

            reportMarkdown = await this.aiService._callAI([{ role: 'user', content: reportPrompt }]);
            reportHtml = this.aiService.convertSummaryToRichHtml(reportMarkdown, compiledArticles);
        } else {
            reportMarkdown = compiledArticles.map((a, idx) => `${idx + 1}. **${a.translatedTitle || a.title}** (${a.source?.name})\n${a.summary}`).join('\n\n');
            reportHtml = this.aiService.convertSummaryToRichHtml(reportMarkdown, compiledArticles);
        }

        const researchResult = {
            success: true,
            topic: cleanTopic,
            englishQuery,
            generatedAt: new Date().toISOString(),
            articleCount: compiledArticles.length,
            sourcesCovered: [...new Set(compiledArticles.map(a => a.source?.name).filter(Boolean))],
            reportMarkdown,
            reportHtml,
            articles: compiledArticles
        };

        await writeJsonFile(config.storage.researchFile, researchResult);

        this.emitAgentEvent(
            'Research Agent (专题调查员)',
            'research_completed',
            `专题「${cleanTopic}」全球信源整合报告已生成！涵盖 ${researchResult.sourcesCovered.length} 家权威媒体共 ${compiledArticles.length} 篇报道`,
            { progress: 100 }
        );

        if (this.io) {
            this.io.emit('agent-research-completed', researchResult);
        }

        return researchResult;
    }

    /**
     * 核心流水线 3：单篇外媒报道即时全文深读与深度解读
     */
    async deepReadSingleArticle({ url, title = '', sourceName = '', existingSummary = '' }) {
        if (!url) {
            throw new Error('缺少新闻原文 URL');
        }

        const extracted = await extractFullArticleContent(url, { timeout: 18000, maxLength: 4500 });
        const rawBody = (extracted && extracted.success && extracted.content)
            ? extracted.content
            : existingSummary || title;

        if (!this.aiService.getCurrentModelInfo().apiKeyConfigured) {
            return {
                success: true,
                url,
                title,
                sourceName,
                extractionMethod: extracted?.method || 'fallback',
                fullText: rawBody,
                analysisHtml: `<p>${stripHtml(rawBody).replace(/\n+/g, '</p><p>')}</p>`
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
    }

    /**
     * 加载最近一次保存的专题研究报告
     */
    async getLastResearchReport() {
        try {
            return await readJsonFile(config.storage.researchFile, null);
        } catch (_) {
            return null;
        }
    }
}

module.exports = NewsAgentService;

