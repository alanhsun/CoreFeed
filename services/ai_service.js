const config = require('../config');
const { delay, truncateText } = require('../utils/helpers');
const logger = require('../utils/logger');
const RateLimiter = require('../utils/rate_limiter');
const { getSourceAuthorityScore } = require('../config/global_sources');

const VALID_REGIONS = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '澳洲', '亚洲', '国际'];
const VALID_CATEGORIES = ['政经', '外交', '科技', '财经', '军事', '社会', '能源', '国际'];

/**
 * AI 编译与事件聚类推理服务 (CoreFeed v2.0)
 * 专注于：跨信源事件聚类、质量评分、规则预分类、结构化批量中文编译与每日要闻综述生成
 */
class AIService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.modelConfig = {};
        this.initializeServices();
        this._initRateLimiter();
    }

    _initRateLimiter() {
        const tokensPerMinute = (config.minimax && config.minimax.rateLimitRpm) || 0;
        if (tokensPerMinute > 0) {
            this.rateLimiter = new RateLimiter({
                tokensPerMinute,
                maxBurst: Math.max(1, (config.minimax && config.minimax.rateLimitBurst) || Math.ceil(tokensPerMinute / 3)),
                minInterval: Math.ceil(60000 / tokensPerMinute)
            });
        } else {
            this.rateLimiter = {
                execute: async (fn) => await fn(),
                getStats: () => ({ totalRequests: 0, successfulRequests: 0, queueLength: 0, note: '速率限制未启用' })
            };
        }
    }

    initializeServices() {
        const minimaxConfig = config.minimax || {};
        this.modelConfig = {
            apiKey: minimaxConfig.apiKey || '',
            baseUrl: (minimaxConfig.baseUrl || 'https://nl.alansun.host:9443/v1').replace(/\/+$/, ''),
            model: minimaxConfig.model || 'ag/gemini-4-argon-high',
            provider: 'OpenAI-Compatible'
        };
    }

    refreshConfig() {
        try {
            config.reload();
            this.initializeServices();
            return true;
        } catch (error) {
            logger.error('AI', '刷新AI配置失败', error.message);
            return false;
        }
    }

    setSocketIO(io) {
        this.io = io;
    }

    setStateManager(stateManager) {
        this.stateManager = stateManager;
    }

    getCurrentModelName() {
        return this.modelConfig.model;
    }

    getCurrentModelInfo() {
        return {
            name: this.modelConfig.model,
            provider: this.modelConfig.provider,
            baseUrl: this.modelConfig.baseUrl,
            apiKeyConfigured: Boolean(this.modelConfig.apiKey),
            failureCount: 0
        };
    }

    /**
     * 底层大模型调用
     */
    async _callAI(messages, model = null, options = {}) {
        const { priority = 5, timeout = 90000 } = options;

        this.refreshConfig();

        if (!this.modelConfig.apiKey) {
            throw new Error('AI_API_KEY 未配置');
        }

        const modelToUse = model || this.modelConfig.model;

        return await this.rateLimiter.execute(async () => {
            const headers = {
                'Authorization': `Bearer ${this.modelConfig.apiKey}`,
                'Content-Type': 'application/json'
            };

            const requestBody = {
                model: modelToUse,
                messages
            };
            if (this.modelConfig.baseUrl.includes('minimaxi.com') || /minimax/i.test(modelToUse)) {
                requestBody.reasoning_split = true;
            }

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            let response;
            try {
                response = await fetch(`${this.modelConfig.baseUrl}/chat/completions`, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}: ${errText.substring(0, 300)}`);
            }

            const data = await response.json();
            const msg = data.choices?.[0]?.message;
            if (!msg) {
                throw new Error('AI 响应内容为空');
            }

            const rawContent = Array.isArray(msg.content)
                ? msg.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
                : (msg.content || '');

            return this._cleanAIResponse(rawContent);
        }, { priority, maxRetries: 2 });
    }

    /**
     * 清理 <think> 标签、代码块包裹等杂质
     */
    _cleanAIResponse(text) {
        if (!text) return '';
        let cleaned = String(text);
        cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        cleaned = cleaned.replace(/^```(json|markdown|text|html)?\n?([\s\S]*?)\n?```$/i, '$2').trim();
        return cleaned.trim();
    }

    /**
     * 从大模型输出中鲁棒提取 JSON 对象或数组
     */
    _extractJson(text) {
        if (!text) return null;
        const cleaned = this._cleanAIResponse(text);
        try {
            return JSON.parse(cleaned);
        } catch (_) {
            const arrStart = cleaned.indexOf('[');
            const arrEnd = cleaned.lastIndexOf(']');
            const objStart = cleaned.indexOf('{');
            const objEnd = cleaned.lastIndexOf('}');

            if (arrStart !== -1 && arrEnd > arrStart && (objStart === -1 || arrStart < objStart)) {
                try {
                    return JSON.parse(cleaned.substring(arrStart, arrEnd + 1));
                } catch (_) {}
            }
            if (objStart !== -1 && objEnd > objStart) {
                try {
                    return JSON.parse(cleaned.substring(objStart, objEnd + 1));
                } catch (_) {}
            }
        }
        return null;
    }

    /**
     * 跨信源事件聚类与去重 (Event Clustering & Cross-Source Verification)
     * 将同一事件来自不同名媒（如路透、BBC、NYT）的报道合并为 relatedSources
     */
    async removeDuplicateNewsWithAI(articles) {
        if (!articles || articles.length <= 1) return articles || [];

        const clusters = this._clusterArticlesBySimilarity(articles);
        logger.info('AI', `跨信源事件预聚类: ${articles.length} 篇报道聚合为 ${clusters.length} 个独立事件簇`);

        const curatedList = [];

        for (const cluster of clusters) {
            if (cluster.length === 1) {
                curatedList.push({
                    ...cluster[0],
                    relatedSources: [],
                    sourceCount: 1
                });
            } else {
                const sorted = [...cluster].sort((a, b) => {
                    const scoreA = getSourceAuthorityScore(a.source?.name) * 2 + Math.min(50, (a.content || '').length / 20);
                    const scoreB = getSourceAuthorityScore(b.source?.name) * 2 + Math.min(50, (b.content || '').length / 20);
                    return scoreB - scoreA;
                });

                const primary = { ...sorted[0] };
                const seenOutlets = new Set([primary.source?.name]);
                const relatedSources = [];

                for (const other of sorted.slice(1)) {
                    const outlet = other.source?.name || '其他媒体';
                    if (!seenOutlets.has(outlet)) {
                        seenOutlets.add(outlet);
                        relatedSources.push({
                            name: outlet,
                            title: other.title,
                            url: other.url,
                            publishedAt: other.publishedAt
                        });
                    }
                    if (!primary.urlToImage && other.urlToImage) {
                        primary.urlToImage = other.urlToImage;
                    }
                    if ((primary.content || '').length < 250 && (other.content || '').length > (primary.content || '').length) {
                        primary.content = `${primary.content}\n\n[${outlet} 补充报道]: ${other.content}`;
                    }
                }

                primary.relatedSources = relatedSources;
                primary.sourceCount = 1 + relatedSources.length;
                curatedList.push(primary);
            }
        }

        return curatedList;
    }

    _clusterArticlesBySimilarity(articles) {
        const clusters = [];
        const threshold = 0.36;

        const sorted = [...articles].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

        for (const article of sorted) {
            let matchedCluster = null;
            for (const cluster of clusters) {
                const sim = this._calculateSimilarity(article.title, cluster[0].title);
                if (sim >= threshold) {
                    matchedCluster = cluster;
                    break;
                }
            }
            if (matchedCluster) {
                matchedCluster.push(article);
            } else {
                clusters.push([article]);
            }
        }
        return clusters;
    }

    _calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'over', 'after', 'into', 'amid', 'says', 'new', 'how', 'why', 'what', 'who', 'are', 'was', 'were', 'has', 'have', 'had', 'will']);
        const normalize = (s) => s.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, ' ');
        const s1 = normalize(str1);
        const s2 = normalize(str2);
        if (s1 === s2) return 1;

        const isZh = /[\u4e00-\u9fa5]/.test(s1) || /[\u4e00-\u9fa5]/.test(s2);
        const tokenize = (s) => isZh
            ? s.replace(/\s+/g, '').split('')
            : s.split(/\s+/).filter(t => t.length > 2 && !stopWords.has(t));

        const t1 = tokenize(s1);
        const t2 = tokenize(s2);
        if (!t1.length || !t2.length) return 0;

        const set1 = new Set(t1);
        const set2 = new Set(t2);
        let inter = 0;
        for (const x of set1) {
            if (set2.has(x)) inter++;
        }
        return inter / (set1.size + set2.size - inter);
    }

    /**
     * 智能评估与甄选高价值全球新闻
     */
    async selectTopQualityNews(articles, targetCount = 30) {
        if (!articles || articles.length <= targetCount) {
            return articles || [];
        }
        const scored = this._scoreArticlesByRules(articles);
        return scored.slice(0, targetCount);
    }

    _scoreArticlesByRules(articles) {
        return articles
            .map(article => {
                const authority = article.source?.authority || getSourceAuthorityScore(article.source?.name);
                const multiSourceBonus = Math.min(20, ((article.sourceCount || 1) - 1) * 7);

                const contentLen = (article.content || '').length;
                const descLen = (article.description || '').length;
                const completeness = contentLen > 600 ? 95 : contentLen > 250 ? 82 : descLen > 100 ? 70 : 55;

                const hoursOld = Math.max(0, (Date.now() - new Date(article.publishedAt || Date.now()).getTime()) / 3600000);
                const freshness = hoursOld < 6 ? 98 : hoursOld < 12 ? 90 : hoursOld < 24 ? 80 : hoursOld < 48 ? 65 : 40;

                const totalScore = Math.round(authority * 0.45 + completeness * 0.25 + freshness * 0.30 + multiSourceBonus);

                return {
                    article: {
                        ...article,
                        qualityScore: Math.min(99, totalScore)
                    },
                    score: totalScore
                };
            })
            .sort((a, b) => b.score - a.score)
            .map(item => item.article);
    }

    /**
     * 快速基于规则预判文章地区与领域（用于第一阶段秒级展示及无 AI Key 场景）
     */
    applyPreliminaryMetadata(article) {
        const title = article.title || '';
        const desc = article.description || article.content || '';
        const sourceName = article.source?.name || '';
        const sourceCat = article.source?.category || '';

        const region = this.determineNewsRegionSync(title, desc, sourceName, article.region);
        const category = this.determineNewsCategorySync(title, desc, sourceCat, article.category);
        const cleanSummary = truncateText(article.description || article.content || article.title, 180);

        return {
            ...article,
            translatedTitle: article.translatedTitle || article.title,
            summary: article.summary || cleanSummary,
            region,
            category,
            aiCompiled: Boolean(article.aiCompiled)
        };
    }

    determineNewsRegionSync(title = '', description = '', sourceName = '', fallbackRegion = null) {
        const text = `${title} ${description}`.toLowerCase();
        if (/\b(china|chinese|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|scmp|xinhua)\b|中国|北京|上海|香港|台湾/.test(text)) return '中国';
        if (/\b(u\.s\.|us|united states|america|washington|white house|biden|trump|pentagon|congress|senate|fed|wall street|california|new york)\b|美国|华盛顿|白宫|特朗普|拜登/.test(text)) return '美国';
        if (/\b(europe|european|eu|uk|britain|british|london|france|french|paris|germany|german|berlin|ukraine|russia|russian|moscow|kyiv|nato|italy|spain)\b|欧洲|欧盟|英国|法国|德国|俄乌|俄罗斯|乌克兰/.test(text)) return '欧洲';
        if (/\b(japan|japanese|tokyo|nhk|nikkei|yen|osaka)\b|日本|东京|日元/.test(text)) return '日本';
        if (/\b(korea|korean|seoul|pyongyang|yonhap)\b|韩国|朝鲜|首尔/.test(text)) return '韩国';
        if (/\b(israel|israeli|gaza|palestin|iran|iranian|tehran|middle east|saudi|syria|lebanon|hezbollah|hamas|yemen|red sea)\b|中东|以色列|加沙|伊朗|沙特|叙利亚|黎巴嫩/.test(text)) return '中东';
        if (/\b(asean|singapore|vietnam|philippines|indonesia|malaysia|thailand|myanmar)\b|东南亚|新加坡|越南|菲律宾|印尼|泰国/.test(text)) return '东南亚';
        if (/\b(australia|australian|sydney|canberra|new zealand)\b|澳洲|澳大利亚|新西兰/.test(text)) return '澳洲';
        if (/\b(india|indian|new delhi|modi|pakistan|bangladesh)\b|印度|南亚|巴基斯坦/.test(text)) return '亚洲';
        if (/\b(africa|african|nigeria|kenya|south africa|egypt|sudan)\b|非洲|埃及|南非/.test(text)) return '非洲';
        if (/\b(brazil|mexico|argentina|latin america|colombia|chile|venezuela)\b|拉美|巴西|墨西哥|阿根廷/.test(text)) return '拉美';
        if (fallbackRegion && VALID_REGIONS.includes(fallbackRegion)) return fallbackRegion;
        return '国际';
    }

    determineNewsCategorySync(title = '', description = '', sourceCategory = '', fallbackCategory = null) {
        const text = `${title} ${description}`.toLowerCase();
        if (/\b(ai|artificial intelligence|openai|chip|semiconductor|nvidia|apple|google|microsoft|cyber|software|quantum|robot|space|nasa|spacex|tech)\b|人工智能|芯片|半导体|科技|大模型|算力/.test(text)) return '科技';
        if (/\b(market|stock|bond|inflation|fed|central bank|interest rate|gdp|tariff|trade|economy|economic|bank|invest|earnings|wall street|currency|bitcoin|crypto)\b|财经|金融|股市|汇率|央行|降息|通胀|关税|贸易|经济/.test(text)) return '财经';
        if (/\b(oil|gas|opec|energy|solar|wind|nuclear power|battery|ev|climate|carbon)\b|能源|石油|天然气|核能|光伏|气候/.test(text)) return '能源';
        if (/\b(military|missile|army|navy|defense|weapon|strike|war|troops|drone|air force|nuclear|pentagon|nato)\b|军事|导弹|国防|战机|航母|武装|空袭/.test(text)) return '军事';
        if (/\b(summit|diploma|treaty|embassy|foreign minister|un|united nations|sanction|bilateral|talks|ceasefire|negotiation)\b|外交|峰会|会谈|制裁|联合国|停火|谈判/.test(text)) return '外交';
        if (/\b(election|parliament|president|prime minister|government|policy|law|court|supreme court|vote|senate|congress)\b|政经|大选|议会|总统|总理|法案|政府/.test(text)) return '政经';
        if (sourceCategory === 'tech') return '科技';
        if (sourceCategory === 'finance') return '财经';
        if (fallbackCategory && VALID_CATEGORIES.includes(fallbackCategory)) return fallbackCategory;
        return '国际';
    }

    /**
     * 高效结构化批量编译 (支持分批增量回调 onBatchCompiled，用于前端渐进式实时更新)
     */
    async enhanceNewsArticles(articles, onProgress = null, onBatchCompiled = null) {
        if (!articles || articles.length === 0) return [];
        this.refreshConfig();

        const initialized = articles.map(a => this.applyPreliminaryMetadata(a));

        if (!this.modelConfig.apiKey) {
            logger.warn('AI', '未配置 AI_API_KEY，使用规则预分类与原文摘要直接展示');
            return initialized;
        }

        logger.info('AI', `启动 Agent 批量深度编译，共 ${initialized.length} 条全球新闻`);
        const batchSize = config.ai.batchSize || 8;
        const enhancedList = [...initialized];

        for (let i = 0; i < initialized.length; i += batchSize) {
            const batch = initialized.slice(i, i + batchSize);
            const batchIndex = Math.floor(i / batchSize) + 1;
            const totalBatches = Math.ceil(initialized.length / batchSize);

            if (typeof onProgress === 'function') {
                onProgress({
                    current: Math.min(i + batch.length, initialized.length),
                    total: initialized.length,
                    batchIndex,
                    totalBatches
                });
            }

            let compiledBatch;
            try {
                compiledBatch = await this._compileBatchWithLLM(batch);
            } catch (err) {
                logger.warn('AI', `批次 ${batchIndex} 批量编译降级: ${err.message}`);
                compiledBatch = batch.map(item => ({
                    ...item,
                    processedAt: new Date().toISOString()
                }));
            }

            for (let j = 0; j < compiledBatch.length; j++) {
                enhancedList[i + j] = compiledBatch[j];
            }

            if (typeof onBatchCompiled === 'function') {
                try {
                    await onBatchCompiled(compiledBatch, i, enhancedList);
                } catch (_) {}
            }
        }

        return enhancedList;
    }

    async _compileBatchWithLLM(batch) {
        const itemsText = batch.map((article, idx) => {
            const sourceName = article.source?.name || 'Global Media';
            const relatedInfo = article.relatedSources?.length
                ? ` (交叉印证媒体: ${article.relatedSources.map(r => r.name).join(', ')})`
                : '';
            const bodySnippet = truncateText(article.fullTextContent || article.content || article.description || '', 700);
            return `[#${idx + 1}] 来源: ${sourceName}${relatedInfo}\n原标题: ${article.title}\n正文摘录: ${bodySnippet}`;
        }).join('\n\n---\n\n');

        const prompt = `你是一位资深国际新闻总编。请将以下 ${batch.length} 条全球权威媒体报道编译为高质量中文情报卡片。

严格要求：
1. 返回纯 JSON 数组，每个元素对应输入的一条新闻：
[
  {
    "id": 1,
    "translatedTitle": "简洁专业的中文新闻标题（不超过32字，直述核心事实）",
    "summary": "客观详实的中文深度摘要（80-130字，交代核心事实、关键数据或各方立场，不加主观评论）",
    "region": "主要涉及地区（只能从 [${VALID_REGIONS.join(', ')}] 中选1个）",
    "category": "新闻领域（只能从 [${VALID_CATEGORIES.join(', ')}] 中选1个）",
    "keyPoints": ["核心要点1", "核心要点2"]
  }
]
2. 即使原文已经是中文，也请提炼出精炼的 summary 和准确的 region、category。
3. 只输出 JSON 数组，严禁包含任何解释文字或 <think> 标签。

待编译新闻列表：
${itemsText}`;

        const rawResponse = await this._callAI([{ role: 'user', content: prompt }]);
        const parsed = this._extractJson(rawResponse);

        if (!Array.isArray(parsed)) {
            throw new Error('编译返回非JSON数组');
        }

        const resultMap = new Map();
        for (const entry of parsed) {
            if (entry && typeof entry.id === 'number') {
                resultMap.set(entry.id - 1, entry);
            }
        }

        return batch.map((article, idx) => {
            const compiled = resultMap.get(idx) || {};
            const region = VALID_REGIONS.find(r => (compiled.region || '').includes(r)) || article.region || '国际';
            const category = VALID_CATEGORIES.find(c => (compiled.category || '').includes(c)) || article.category || '国际';

            return {
                ...article,
                translatedTitle: (compiled.translatedTitle || article.translatedTitle || article.title).trim(),
                translatedDescription: (compiled.summary || article.summary || article.description || article.title).trim(),
                summary: (compiled.summary || article.summary || article.description || article.title).trim(),
                region,
                category,
                keyPoints: Array.isArray(compiled.keyPoints) ? compiled.keyPoints.slice(0, 3) : [],
                aiCompiled: Boolean(compiled.translatedTitle || compiled.summary),
                processedAt: new Date().toISOString()
            };
        });
    }

    /**
     * 主编 Agent：生成结构化《全球新闻深度综述文章》
     */
    async generateNewsSummaryArticle(newsData) {
        if (!this.modelConfig.apiKey) {
            throw new Error('AI服务未配置密钥，无法生成综述文章');
        }
        if (!newsData || newsData.length === 0) {
            throw new Error('没有可用的新闻数据');
        }

        logger.info('AI', `主编 Agent 正在整合 ${newsData.length} 条全球新闻生成深度综述...`);

        const newsContent = newsData.map((news, index) => {
            const title = news.translatedTitle || news.title;
            const summary = news.summary || news.translatedDescription || news.description;
            const sourceName = news.source?.name || '外媒';
            const crossSources = news.relatedSources?.length
                ? `（同时由 ${news.relatedSources.map(s => s.name).join('、')} 报道）`
                : '';
            return `${index + 1}. 【${news.region || '国际'} | ${news.category || '要闻'}】${title}\n主信源：${sourceName}${crossSources}\n核心摘要：${summary}\n引用标识：[NEWS_${index + 1}]`;
        }).join('\n\n');

        const currentDate = new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
            timeZone: 'Asia/Shanghai'
        });

        const prompt = `你是“聚核 (CoreFeed)”全球情报中心的主编 Agent。请基于以下采集自全球知名媒体（路透社、美联社、BBC、纽约时报、彭博社、南华早报等）的 ${newsData.length} 条新闻，撰写一篇结构严谨、洞察深刻的《${currentDate} 全球新闻深度综述》。

写作要求：
1. 第一行直接输出文章标题：${currentDate} 全球要闻深度综述
2. 包含一个简短的【全球态势导读】（100-150字，提炼今日全球政经、科技与地缘核心脉络）。
3. 正文按重点板块或地区（如【国际政经与大国博弈】、【欧美动态】、【亚太与中国周边】、【中东与地区冲突】、【前沿科技与全球市场】）分节综述，每节以“### 板块名称”作为小标题。
4. 将零散新闻有机串联对比，客观陈述各方信源事实；在引述具体新闻事实的句末，**必须原样附上对应的引用标识符**，格式严格为 [NEWS_1]、[NEWS_2] 等。
5. 全文篇幅控制在 1000-1600 字，语言凝练、专业，不要输出任何 <think> 思考过程。

今日全球信源素材：
${newsContent}`;

        let rawContent = await this._callAI([{ role: 'user', content: prompt }]);
        rawContent = this._cleanAIResponse(rawContent);

        return this.createSummaryArticleObject(rawContent, newsData, currentDate);
    }

    createSummaryArticleObject(articleContent, newsData, currentDate) {
        const lines = articleContent.split('\n').map(l => l.trim()).filter(Boolean);
        let title = `${currentDate} 全球要闻深度综述`;
        let bodyLines = lines;

        if (lines.length > 0 && lines[0].length < 60 && !lines[0].endsWith('。')) {
            title = lines[0].replace(/^#+\s*/, '').replace(/\*\*/g, '');
            bodyLines = lines.slice(1);
        }

        const cleanBody = bodyLines.join('\n\n');
        const htmlContent = this.convertSummaryToRichHtml(cleanBody, newsData);

        return {
            title,
            content: cleanBody,
            htmlContent,
            newsCount: newsData.length,
            regions: [...new Set(newsData.map(n => n.region || '国际'))],
            generatedAt: new Date().toISOString(),
            summary: truncateText(cleanBody.replace(/\[NEWS_\d+\]/g, '').replace(/#+\s*/g, ''), 160),
            wordCount: cleanBody.length
        };
    }

    convertSummaryToRichHtml(text, newsData) {
        const withLinks = text.replace(/\[NEWS_(\d+)\]/g, (match, numStr) => {
            const idx = parseInt(numStr, 10) - 1;
            const item = newsData[idx];
            if (item && item.url) {
                const srcName = item.source?.name ? item.source.name.split('(')[0].trim() : '原文';
                return ` <a href="${item.url}" target="_blank" rel="noopener noreferrer" class="news-ref-link" title="${(item.translatedTitle || item.title).replace(/"/g, '&quot;')}">[${srcName}]</a>`;
            }
            return '';
        });

        const blocks = withLinks.split(/\n{2,}/);
        return blocks.map(block => {
            const trimmed = block.trim();
            if (!trimmed) return '';
            if (/^#{1,4}\s+(.+)$/.test(trimmed) || /^【.+】$/.test(trimmed)) {
                const headingText = trimmed.replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '');
                return `<h3 class="summary-section-title">${headingText}</h3>`;
            }
            const formatted = trimmed
                .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
                .replace(/\n/g, '<br>');
            return `<p class="summary-paragraph">${formatted}</p>`;
        }).join('\n');
    }

    isChineseText(text) {
        if (!text) return false;
        return /[\u4e00-\u9fa5]/.test(text);
    }
}

module.exports = AIService;
