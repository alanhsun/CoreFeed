/**
 * 聚核 CoreFeed v2.0 — AI 编译、事件聚类与综述渲染服务 (services/ai_service.js)
 *
 * 核心职责：
 *   1. 跨信源同事件聚类 (`mergeDuplicateArticlesSync`, `deduplicateWithLLM`) 与权威度/热度综合评分 (`selectTopQualityNews`)
 *   2. 地区与领域规则分类 (`determineNewsRegionSync`, `determineNewsCategorySync`, `applyPreliminaryMetadata`)
 *   3. 批量中文精编 (`enhanceNewsArticles`, `ensureBatchInChinese`)
 *   4. 《全球要闻深度综述》富文本 HTML 与可点击角标 (`[NEWS_x]` -> `.news-ref-link`) 渲染 (`convertSummaryToRichHtml`)
 */
const axios = require('axios');
const https = require('https');
const config = require('../config');
const { truncateText } = require('../utils/helpers');
const logger = require('../utils/logger');
const RateLimiter = require('../utils/rate_limiter');
const { getSourceAuthorityScore } = require('../config/global_sources');

const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

const VALID_REGIONS = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '澳洲', '亚洲', '国际'];
const VALID_CATEGORIES = ['政经', '外交', '科技', '财经', '军事', '社会', '能源', '国际'];

class AIService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.modelConfig = {};
        this._endpointUnreachableUntil = 0;
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
        const nextBaseUrl = (minimaxConfig.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
        if (this.modelConfig && this.modelConfig.baseUrl && this.modelConfig.baseUrl !== nextBaseUrl) {
            this._endpointUnreachableUntil = 0;
        }
        this.modelConfig = {
            apiKey: minimaxConfig.apiKey || '',
            baseUrl: nextBaseUrl,
            model: minimaxConfig.model || 'gpt-4o-mini',
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
     * 底层大模型调用 (使用 axios + TLS 容错 + 不可达快速熔断，全面兼容自建反代与 OpenAI/Gemini 网关)
     */
    async _callAI(messages, model = null, options = {}) {
        const { priority = 5, timeout = 90000, bypassRateLimiter = false, maxRetries = 2 } = options;

        this.refreshConfig();

        if (!this.modelConfig.apiKey) {
            throw new Error('AI_API_KEY 未配置');
        }

        if (Date.now() < this._endpointUnreachableUntil) {
            throw new Error('AI 端点连接超时熔断中');
        }

        const modelToUse = model || this.modelConfig.model;

        const doRequest = async () => {
            if (Date.now() < this._endpointUnreachableUntil) {
                throw new Error('AI 端点连接超时熔断中');
            }

            const headers = {
                'Authorization': `Bearer ${this.modelConfig.apiKey}`,
                'Content-Type': 'application/json',
                'User-Agent': 'CoreFeed/2.0'
            };

            const requestBody = {
                model: modelToUse,
                messages,
                temperature: 0.3
            };
            if (this.modelConfig.baseUrl.includes('minimaxi.com') || /minimax/i.test(modelToUse)) {
                requestBody.reasoning_split = true;
            }

            let response;
            try {
                response = await axios.post(`${this.modelConfig.baseUrl}/chat/completions`, requestBody, {
                    headers,
                    timeout: Math.min(timeout, 15000),
                    httpsAgent: httpsAgentIgnoreTls,
                    validateStatus: () => true
                });
            } catch (netErr) {
                this._endpointUnreachableUntil = Date.now() + 180000;
                throw new Error(`大模型网络请求失败: ${netErr.message}`);
            }

            if (response.status < 200 || response.status >= 300) {
                if (response.status === 403 || response.status === 502 || response.status === 504) {
                    this._endpointUnreachableUntil = Date.now() + 180000;
                }
                const errText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data || {});
                throw new Error(`HTTP ${response.status}: ${errText.substring(0, 300)}`);
            }

            const data = response.data;
            const msg = data?.choices?.[0]?.message;
            if (!msg) {
                throw new Error('AI 响应内容为空');
            }

            const rawContent = Array.isArray(msg.content)
                ? msg.content.map(part => (typeof part === 'string' ? part : part?.text || '')).join('')
                : (msg.content || msg.reasoning_content || '');

            return this._cleanAIResponse(rawContent);
        };

        if (bypassRateLimiter) {
            return await doRequest();
        }

        return await this.rateLimiter.execute(doRequest, { priority, maxRetries });
    }

    /**
     * 清理 <think> 标签、代码块包裹等杂质
     */
    _cleanAIResponse(text) {
        if (!text) return '';
        let cleaned = String(text);
        cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        cleaned = cleaned.replace(/^```(json|markdown|text|html)?\s*\n?([\s\S]*?)\n?```$/i, '$2').trim();
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
        } catch (_) {}

        // 优先提取 ```json ... ``` 代码块
        const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (codeBlockMatch && codeBlockMatch[1]) {
            try {
                return JSON.parse(codeBlockMatch[1].trim());
            } catch (_) {}
        }

        // 查找形如 [ { ... } ] 的 JSON 数组起始位置（避免误匹配 [#1]）
        const arrayObjMatch = cleaned.match(/\[\s*\{/);
        const arrEnd = cleaned.lastIndexOf(']');
        if (arrayObjMatch && arrEnd > arrayObjMatch.index) {
            try {
                return JSON.parse(cleaned.substring(arrayObjMatch.index, arrEnd + 1));
            } catch (_) {}
        }

        const objStart = cleaned.indexOf('{');
        const objEnd = cleaned.lastIndexOf('}');
        if (objStart !== -1 && objEnd > objStart) {
            try {
                return JSON.parse(cleaned.substring(objStart, objEnd + 1));
            } catch (_) {}
        }
        return null;
    }

    /**
     * 将同一事件簇中的多篇外媒报道合并为单张主卡片，并保留所有交叉印证信源 (relatedSources)
     */
    _mergeArticleCluster(cluster) {
        if (!Array.isArray(cluster) || cluster.length === 0) return null;
        if (cluster.length === 1) {
            const single = cluster[0];
            const existingRelated = Array.isArray(single.relatedSources) ? single.relatedSources : [];
            return {
                ...single,
                relatedSources: existingRelated,
                sourceCount: 1 + existingRelated.length
            };
        }

        const sorted = [...cluster].sort((a, b) => {
            const imgBonusA = (a.urlToImage ? 18 : 0) + (a.url && !a.url.includes('news.google.com') ? 10 : 0);
            const imgBonusB = (b.urlToImage ? 18 : 0) + (b.url && !b.url.includes('news.google.com') ? 10 : 0);
            const scoreA = getSourceAuthorityScore(a.source?.name) * 2 + Math.min(50, (a.content || '').length / 20) + imgBonusA;
            const scoreB = getSourceAuthorityScore(b.source?.name) * 2 + Math.min(50, (b.content || '').length / 20) + imgBonusB;
            return scoreB - scoreA;
        });

        const primary = { ...sorted[0] };
        const seenOutlets = new Set([primary.source?.name]);
        const relatedSources = [];

        if (Array.isArray(primary.relatedSources)) {
            for (const rel of primary.relatedSources) {
                if (rel && rel.name && !seenOutlets.has(rel.name)) {
                    seenOutlets.add(rel.name);
                    relatedSources.push(rel);
                }
            }
        }

        for (const other of sorted.slice(1)) {
            const outlet = other.source?.name || '其他媒体';
            if (!seenOutlets.has(outlet)) {
                seenOutlets.add(outlet);
                relatedSources.push({
                    name: outlet,
                    title: other.translatedTitle || other.title,
                    url: other.url,
                    publishedAt: other.publishedAt
                });
            }
            if (Array.isArray(other.relatedSources)) {
                for (const subRel of other.relatedSources) {
                    if (subRel && subRel.name && !seenOutlets.has(subRel.name)) {
                        seenOutlets.add(subRel.name);
                        relatedSources.push(subRel);
                    }
                }
            }
            if (!primary.urlToImage && other.urlToImage) {
                primary.urlToImage = other.urlToImage;
            }
            if ((!Array.isArray(primary.keyPoints) || primary.keyPoints.length === 0) && Array.isArray(other.keyPoints) && other.keyPoints.length > 0) {
                primary.keyPoints = other.keyPoints;
            }
            if ((primary.content || '').length < 250 && (other.content || '').length > (primary.content || '').length) {
                primary.content = `${primary.content}\n\n[${outlet} 补充报道]: ${other.content}`;
            }
        }

        primary.relatedSources = relatedSources;
        primary.sourceCount = 1 + relatedSources.length;
        return primary;
    }

    mergeDuplicateArticlesSync(articles) {
        if (!articles || articles.length <= 1) return articles || [];

        const clusters = this._clusterArticlesBySimilarity(articles);
        logger.info('AI', `跨信源事件规则聚类: ${articles.length} 篇报道聚合为 ${clusters.length} 个独立事件簇`);

        return clusters.map(cluster => this._mergeArticleCluster(cluster)).filter(Boolean);
    }

    /**
     * AI 大模型深度语义事件聚类去重 (识别不同外媒从不同切入点、不同措辞报道的同一底层新闻事件)
     */
    async deduplicateWithLLM(articles, options = {}) {
        const baseList = this.mergeDuplicateArticlesSync(articles);
        if (!baseList || baseList.length <= 1) return baseList || [];

        this.refreshConfig();
        if (!this.modelConfig.apiKey) {
            return baseList;
        }

        const maxInspect = Math.min(baseList.length, options.maxInspect || 45);
        const head = baseList.slice(0, maxInspect);
        const tail = baseList.slice(maxInspect);

        const itemsLines = head.map((item, idx) => {
            const zh = item.translatedTitle && item.translatedTitle !== item.title ? item.translatedTitle : '';
            const en = item.title || '';
            const titleText = zh && en ? `${zh} | ${en}` : (zh || en);
            const snippet = truncateText(item.summary || item.description || '', 65);
            return `[#${idx + 1}] [${item.source?.name || 'Media'}] ${titleText}${snippet ? ` — ${snippet}` : ''}`;
        }).join('\n');

        const prompt = `你是一位资深国际新闻总编，请对以下 ${head.length} 条全球新闻执行“AI 语义同事件去重聚类”。

严格判定规则：
1. 仔细比对每条新闻的核心事实（涉及的人物/机构、核心地点、突发事件或政策决定）。
2. 只要两条或多条新闻报道的是【同一个具体新闻事件】（哪怕不同外媒标题切入角度不同、英文用词不同、或伤亡/判刑等数字存在细微出入，例如“肯尼亚邪教头目因谋杀190名儿童被判200年”与“肯尼亚末日邪教头目因谋杀191名信徒获刑200年”、“东京近海6.1级地震”与“日本本州东岸海域发生地震”），都必须判定为同一事件并归入同一个编号数组！
3. 注意区分：“同一具体事件的各方反应/多媒报道”（应合并）与“同一国家的不同独立事件”（不可合并）。
4. 只输出存在重复的编号组（每组包含 2 个或以上的编号，对应 [#1] 到 [#${head.length}] 的数字）。如果没有任何重复事件，输出 {"duplicateGroups": []}。
5. 严格只输出纯 JSON 对象，格式如下，严禁包含任何解释文字或 <think> 标签：
{"duplicateGroups": [[1, 5], [3, 8, 12]]}

待去重新闻列表：
${itemsLines}`;

        try {
            const rawResponse = await this._callAI(
                [{ role: 'user', content: prompt }],
                null,
                {
                    priority: 8,
                    timeout: options.timeout || 28000,
                    bypassRateLimiter: Boolean(options.bypassRateLimiter),
                    maxRetries: 1
                }
            );

            const parsed = this._extractJson(rawResponse);
            const rawGroups = Array.isArray(parsed)
                ? parsed
                : (parsed?.duplicateGroups || parsed?.clusters || parsed?.groups || []);

            if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
                logger.info('AI', `🤖 AI 语义深度去重校验完成: 当前前 ${head.length} 条均为独立事件`);
                return baseList;
            }

            // 使用并查集 (Union-Find) 合并 AI 识别出的同事件组（支持传递闭包归并）
            const parent = Array.from({ length: head.length }, (_, i) => i);
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
                    // 保持靠前（高分）条目的索引作为根
                    if (ra < rb) parent[rb] = ra;
                    else parent[ra] = rb;
                }
            };

            for (const grp of rawGroups) {
                if (!Array.isArray(grp) || grp.length < 2 || grp.length > 8) continue;
                const validIndices = grp
                    .map(v => parseInt(String(v).replace(/\D+/g, ''), 10) - 1)
                    .filter(idx => !isNaN(idx) && idx >= 0 && idx < head.length);

                if (validIndices.length >= 2) {
                    const first = validIndices[0];
                    for (let k = 1; k < validIndices.length; k++) {
                        union(first, validIndices[k]);
                    }
                }
            }

            const clusterMap = new Map();
            for (let i = 0; i < head.length; i++) {
                const root = find(i);
                if (!clusterMap.has(root)) {
                    clusterMap.set(root, []);
                }
                clusterMap.get(root).push(head[i]);
            }

            const mergedHead = [];
            for (const group of clusterMap.values()) {
                mergedHead.push(this._mergeArticleCluster(group));
            }

            const removedCount = head.length - mergedHead.length;
            if (removedCount > 0) {
                logger.success('AI', `🤖 AI 语义深度去重成功: 额外识别并合并了 ${removedCount} 条同事件异题报道 (${head.length} -> ${mergedHead.length} 条)`);
            } else {
                logger.info('AI', `🤖 AI 语义深度去重校验完成: 未发现额外重复事件`);
            }

            return [...mergedHead, ...tail];
        } catch (err) {
            logger.warn('AI', `AI 语义深度去重跳过，保留规则聚类结果: ${err.message}`);
            return baseList;
        }
    }

    _clusterArticlesBySimilarity(articles) {
        const clusters = [];
        const threshold = 0.30;

        const sorted = [...articles].sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));

        for (const article of sorted) {
            let matchedCluster = null;
            for (const cluster of clusters) {
                let isSameEvent = false;
                for (const member of cluster) {
                    const sim = this._calculateArticleSimilarity(article, member);
                    if (sim >= threshold) {
                        isSameEvent = true;
                        break;
                    }
                }
                if (isSameEvent) {
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

    /**
     * 综合对比两篇报道的英文标题、中文译题与首段导语核心实体相似度
     */
    _calculateArticleSimilarity(a, b) {
        if (!a || !b) return 0;
        if (a.url && b.url && a.url === b.url) return 1;

        const simEn = this._calculateSimilarity(a.title || '', b.title || '');
        const hasZhA = a.translatedTitle && a.translatedTitle !== a.title && this.isChineseText(a.translatedTitle);
        const hasZhB = b.translatedTitle && b.translatedTitle !== b.title && this.isChineseText(b.translatedTitle);
        const simZh = (hasZhA && hasZhB) ? this._calculateSimilarity(a.translatedTitle, b.translatedTitle) : 0;

        // 结合标题与前120字导语做交叉实体比对（防止一家媒体标题写人名、另一家把人名放在导语首句）
        const leadA = `${a.title || ''} ${(a.description || '').slice(0, 120)}`;
        const leadB = `${b.title || ''} ${(b.description || '').slice(0, 120)}`;
        const simLead = this._calculateSimilarity(leadA, leadB) * 0.9;

        return Math.max(simEn, simZh, simLead);
    }

    _calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;

        const stopWords = new Set([
            'the', 'and', 'for', 'with', 'from', 'that', 'this', 'over', 'after', 'into', 'amid',
            'says', 'said', 'say', 'new', 'how', 'why', 'what', 'who', 'are', 'was', 'were', 'has',
            'have', 'had', 'will', 'would', 'could', 'should', 'about', 'more', 'than', 'most', 'some',
            'out', 'off', 'near', 'under', 'between', 'during', 'before', 'since', 'while', 'where',
            'when', 'been', 'being', 'their', 'there', 'they', 'them', 'his', 'her', 'its', 'our',
            'news', 'report', 'reports', 'world', 'global', 'update', 'live', 'latest', 'watch', 'video'
        ]);

        const synonymMap = {
            'kenyan': 'kenya', 'canadian': 'canada', 'american': 'us', 'usa': 'us', 'united': 'us',
            'british': 'uk', 'britain': 'uk', 'england': 'uk', 'french': 'france', 'german': 'germany',
            'japanese': 'japan', 'chinese': 'china', 'russian': 'russia', 'ukrainian': 'ukraine',
            'israeli': 'israel', 'iranian': 'iran', 'palestinian': 'palestine', 'australian': 'australia',
            'indian': 'india', 'korean': 'korea', 'mexican': 'mexico', 'brazilian': 'brazil',
            'syrian': 'syria', 'lebanese': 'lebanon', 'egyptian': 'egypt', 'turkish': 'turkey',
            'sentenced': 'jail', 'sentence': 'jail', 'jailed': 'jail', 'imprisoned': 'jail', 'prison': 'jail', 'convicted': 'jail',
            'kills': 'death', 'killed': 'death', 'killing': 'death', 'dead': 'death', 'deaths': 'death',
            'died': 'death', 'dies': 'death', 'murder': 'death', 'murdered': 'death', 'starvation': 'death', 'massacre': 'death',
            'followers': 'victim', 'children': 'victim', 'victims': 'victim', 'disciples': 'victim',
            'earthquake': 'quake', 'tremor': 'quake', 'seismic': 'quake', 'quakes': 'quake',
            'strikes': 'attack', 'struck': 'attack', 'attacks': 'attack', 'attacked': 'attack', 'bombing': 'attack', 'raid': 'attack',
            'negotiations': 'talks', 'summit': 'talks', 'ceasefire': 'talks', 'truce': 'talks',
            'tariffs': 'tariff', 'duties': 'tariff', 'sanctions': 'sanction',
            'plunges': 'drop', 'plunge': 'drop', 'drops': 'drop', 'falls': 'drop', 'slump': 'drop', 'tumbles': 'drop',
            'surges': 'rise', 'surge': 'rise', 'soars': 'rise', 'jumps': 'rise', 'rallies': 'rise', 'gains': 'rise'
        };

        const stemWord = (w) => {
            if (synonymMap[w]) return synonymMap[w];
            let s = w;
            if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
            else if (s.length > 5 && s.endsWith('ed')) s = s.slice(0, -2);
            else if (s.length > 4 && s.endsWith('es') && !s.endsWith('ses')) s = s.slice(0, -2);
            else if (s.length > 4 && s.endsWith('s') && !s.endsWith('ss') && !s.endsWith('us') && !s.endsWith('is')) s = s.slice(0, -1);
            return synonymMap[s] || s;
        };

        const normalize = (s) => String(s)
            .toLowerCase()
            .replace(/u\.s\.a?\.?/g, ' us ')
            .replace(/u\.k\.?/g, ' uk ')
            .replace(/e\.u\.?/g, ' eu ')
            .replace(/u\.n\.?/g, ' un ')
            .replace(/['’]s\b/g, ' ')
            .replace(/[^\w\u4e00-\u9fa5.\s]/g, ' ');

        const s1 = normalize(str1).trim();
        const s2 = normalize(str2).trim();
        if (!s1 || !s2) return 0;
        if (s1 === s2) return 1;

        const isZh = /[\u4e00-\u9fa5]/.test(s1) && /[\u4e00-\u9fa5]/.test(s2);

        const tokenizeEn = (s) => {
            const keepShort = new Set(['us', 'uk', 'eu', 'un', 'ai', 'ev']);
            return s
                .replace(/\.(?!\d)/g, ' ')
                .split(/\s+/)
                .map(t => t.trim())
                .filter(t => (t.length > 2 || keepShort.has(t) || /^\d+(\.\d+)?$/.test(t)) && !stopWords.has(t))
                .map(stemWord);
        };

        const tokenizeZh = (s) => {
            const zhStopChars = /[的了在是被因与和及或将已对从向为以于由把让给但而并又更最很也还就都却正曾名个位次年日号月]/g;
            const cleaned = s.replace(zhStopChars, ' ');
            const tokens = [];
            // 提取所有数字（如 200、190、6.1）
            const nums = cleaned.match(/\d+(\.\d+)?/g) || [];
            tokens.push(...nums);
            // 提取中文双字词 (2-gram)
            const zhChunks = cleaned.match(/[\u4e00-\u9fa5]+/g) || [];
            for (const chunk of zhChunks) {
                if (chunk.length === 1) {
                    tokens.push(chunk);
                } else {
                    for (let i = 0; i < chunk.length - 1; i++) {
                        tokens.push(chunk.slice(i, i + 2));
                    }
                }
            }
            return tokens;
        };

        const t1 = isZh ? tokenizeZh(s1) : tokenizeEn(s1);
        const t2 = isZh ? tokenizeZh(s2) : tokenizeEn(s2);
        if (!t1.length || !t2.length) return 0;

        const set1 = new Set(t1);
        const set2 = new Set(t2);
        let inter = 0;
        let sharedNumOrKey = 0;
        for (const x of set1) {
            if (set2.has(x)) {
                inter++;
                if (/^\d+(\.\d+)?$/.test(x) || x.length >= 6) {
                    sharedNumOrKey++;
                }
            }
        }
        if (inter === 0) return 0;

        const jaccard = inter / (set1.size + set2.size - inter);
        const minSize = Math.min(set1.size, set2.size);
        const overlap = minSize >= 3 ? inter / minSize : jaccard;

        // 当两条新闻共享至少3个核心词（或2个核心词+关键数字/长专有名词）时，融合 Jaccard 与 Overlap 评分
        let score = jaccard * 0.65 + overlap * 0.35;
        if (inter >= 3 && sharedNumOrKey >= 1) {
            score += 0.06;
        }
        return Math.min(1, score);
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
                const imageAndDirectBonus = (article.urlToImage ? 6 : 0) + (article.url && !article.url.includes('news.google.com') ? 4 : 0);

                const contentLen = (article.content || '').length;
                const descLen = (article.description || '').length;
                const completeness = contentLen > 600 ? 95 : contentLen > 250 ? 82 : descLen > 100 ? 70 : 55;

                const hoursOld = Math.max(0, (Date.now() - new Date(article.publishedAt || Date.now()).getTime()) / 3600000);
                const freshness = hoursOld < 6 ? 98 : hoursOld < 12 ? 90 : hoursOld < 24 ? 80 : hoursOld < 48 ? 65 : 40;

                const totalScore = Math.round(authority * 0.45 + completeness * 0.25 + freshness * 0.30 + multiSourceBonus + imageAndDirectBonus);

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
        const matchRegion = (t) => {
            if (!t) return null;
            const text = String(t).toLowerCase();
            if (/\b(china|chinese|beijing|shanghai|shenzhen|hong kong|taiwan|taipei|xinhua)\b|中国|北京|上海|香港|台湾/.test(text)) return '中国';
            if (/\b(japan|japanese|tokyo|nhk|nikkei|yen|osaka|hokkaido|fukushima)\b|日本|东京|大阪|日元/.test(text)) return '日本';
            if (/\b(korea|korean|seoul|pyongyang|yonhap)\b|韩国|朝鲜|首尔|平壤/.test(text)) return '韩国';
            if (/\b(israel|israeli|gaza|palestin|iran|iranian|tehran|middle east|saudi|syria|lebanon|hezbollah|hamas|yemen|red sea|iraq|qatar)\b|中东|以色列|加沙|巴勒斯坦|伊朗|沙特|叙利亚|黎巴嫩|也门/.test(text)) return '中东';
            if (/\b(africa|african|nigeria|kenya|kenyan|south africa|egypt|sudan|ethiopia|congo)\b|非洲|肯尼亚|尼日利亚|埃及|南非|苏丹/.test(text)) return '非洲';
            if (/\b(asean|singapore|vietnam|philippines|indonesia|malaysia|thailand|myanmar)\b|东南亚|新加坡|越南|菲律宾|印尼|马来西亚|泰国|缅甸/.test(text)) return '东南亚';
            if (/\b(australia|australian|sydney|canberra|new zealand)\b|澳洲|澳大利亚|新西兰|悉尼/.test(text)) return '澳洲';
            if (/\b(india|indian|new delhi|modi|pakistan|bangladesh|sri lanka)\b|印度|南亚|巴基斯坦|孟加拉/.test(text)) return '亚洲';
            if (/\b(brazil|mexico|argentina|latin america|colombia|chile|venezuela|peru)\b|拉美|巴西|墨西哥|阿根廷|智利|委内瑞拉/.test(text)) return '拉美';
            if (/\b(europe|european|eu|uk|britain|british|london|france|french|paris|germany|german|berlin|ukraine|ukrainian|russia|russian|moscow|kyiv|nato|italy|spain|vatican|pope)\b|欧洲|欧盟|英国|伦敦|法国|巴黎|德国|俄乌|俄罗斯|乌克兰|莫斯科|梵蒂冈|教皇/.test(text)) return '欧洲';
            if (/\b(u\.s\.|us|united states|america|american|washington|white house|biden|trump|pentagon|congress|senate|fed|wall street|california|new york|texas|florida)\b|美国|华盛顿|白宫|特朗普|拜登|五角大楼|华尔街/.test(text)) return '美国';
            return null;
        };

        // 优先从新闻标题判定核心发生地（避免摘要中提及"据美国地质调查局测定，日本东京发生地震"被误判为美国）
        const titleRegion = matchRegion(title);
        if (titleRegion) return titleRegion;

        const descRegion = matchRegion(description);
        if (descRegion) return descRegion;

        if (fallbackRegion && VALID_REGIONS.includes(fallbackRegion)) return fallbackRegion;
        return '国际';
    }

    determineNewsCategorySync(title = '', description = '', sourceCategory = '', fallbackCategory = null) {
        const matchCat = (t) => {
            if (!t) return null;
            const text = String(t).toLowerCase();
            if (/\b(ai|artificial intelligence|openai|chip|semiconductor|nvidia|apple|google|microsoft|cyber|software|quantum|robot|space|nasa|spacex|tech)\b|人工智能|芯片|半导体|科技|大模型|算力|航天/.test(text)) return '科技';
            if (/\b(market|stock|bond|inflation|fed|central bank|interest rate|gdp|tariff|trade|economy|economic|bank|invest|earnings|wall street|currency|bitcoin|crypto)\b|财经|金融|股市|汇率|央行|降息|通胀|关税|贸易|经济/.test(text)) return '财经';
            if (/\b(oil|gas|opec|energy|solar|wind|nuclear power|battery|ev|climate|carbon)\b|能源|石油|天然气|核能|光伏|气候|碳排放/.test(text)) return '能源';
            if (/\b(military|missile|army|navy|defense|weapon|strike|war|troops|drone|air force|pentagon|nato)\b|军事|导弹|国防|战机|航母|武装|空袭|军队/.test(text)) return '军事';
            if (/\b(summit|diploma|treaty|embassy|foreign minister|united nations|sanction|bilateral|talks|ceasefire|negotiation)\b|外交|峰会|会谈|制裁|联合国|停火|谈判/.test(text)) return '外交';
            if (/\b(earthquake|quake|tsunami|typhoon|hurricane|flood|wildfire|cult|murder|jailed|sentenced|prison|police|crime|crash|disaster)\b|社会|地震|海啸|台风|洪水|邪教|谋杀|获刑|判处|监禁|警方|事故|灾难/.test(text)) return '社会';
            if (/\b(election|parliament|president|prime minister|government|policy|law|court|supreme court|vote|senate|congress)\b|政经|大选|议会|总统|总理|法案|政府|最高法院/.test(text)) return '政经';
            return null;
        };

        const titleCat = matchCat(title);
        if (titleCat) return titleCat;

        const descCat = matchCat(description);
        if (descCat) return descCat;

        if (sourceCategory === 'tech') return '科技';
        if (sourceCategory === 'finance') return '财经';
        if (fallbackCategory && VALID_CATEGORIES.includes(fallbackCategory)) return fallbackCategory;
        return '国际';
    }

    _isMostlyChinese(text, minChineseChars = 4) {
        if (!text || typeof text !== 'string') return false;
        const stripped = text
            .replace(/\[[^\]]*补充报道\]:?/g, '')
            .replace(/\([^)]*[\u4e00-\u9fa5]+[^)]*\)/g, '');
        const zhCount = (stripped.match(/[\u4e00-\u9fa5]/g) || []).length;
        const enCount = (stripped.match(/[A-Za-z]/g) || []).length;
        return zhCount >= minChineseChars && zhCount * 2 >= enCount;
    }

    /**
     * 免密钥高速中文翻译兜底 (多端点自动容错回退：clients5 dict-chrome-ex -> googleapis dict-chrome-ex -> google client=at -> gtx -> MyMemory)
     */
    async translateTextToChinese(text, timeout = 8000) {
        if (!text || typeof text !== 'string') return '';
        const trimmed = text.replace(/\[[^\]]*补充报道\]:?\s*/g, ' ').trim();
        if (!trimmed || this._isMostlyChinese(trimmed, 4)) return trimmed;

        const q = encodeURIComponent(trimmed.substring(0, 1200));
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
        };

        const endpoints = [
            {
                url: `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=zh-CN&q=${q}`,
                parse: (data) => {
                    if (Array.isArray(data)) {
                        if (Array.isArray(data[0])) return data.map(seg => (Array.isArray(seg) ? seg[0] : '')).join('');
                        if (typeof data[0] === 'string') return data[0];
                    }
                    return '';
                }
            },
            {
                url: `https://translate.googleapis.com/translate_a/single?client=dict-chrome-ex&sl=auto&tl=zh-CN&dt=t&q=${q}`,
                parse: (data) => (Array.isArray(data) && Array.isArray(data[0]))
                    ? data[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join('')
                    : ''
            },
            {
                url: `https://translate.google.com/translate_a/single?client=at&dt=t&dj=1&sl=auto&tl=zh-CN&q=${q}`,
                parse: (data) => Array.isArray(data?.sentences)
                    ? data.sentences.map(s => s?.trans || '').join('')
                    : ''
            },
            {
                url: `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=${q}`,
                parse: (data) => (Array.isArray(data) && Array.isArray(data[0]))
                    ? data[0].map(seg => (Array.isArray(seg) ? seg[0] : '')).join('')
                    : ''
            },
            {
                url: `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed.substring(0, 480))}&langpair=en|zh-CN`,
                parse: (data) => data?.responseData?.translatedText || ''
            }
        ];

        for (const ep of endpoints) {
            try {
                const res = await axios.get(ep.url, {
                    timeout: Math.min(timeout, 6500),
                    httpsAgent: httpsAgentIgnoreTls,
                    headers
                });
                const translated = String(ep.parse(res.data) || '').trim();
                if (translated && this._isMostlyChinese(translated, 2)) {
                    return translated;
                }
            } catch (err) {
                logger.debug('AI', `中文翻译端点回退 (${ep.url.slice(0, 48)}...): ${err.message}`);
            }
        }

        return trimmed;
    }

    _splitIntoParagraphs(rawText = '') {
        if (!rawText || typeof rawText !== 'string') return [];
        const cleaned = rawText
            .replace(/\[[^\]]*补充报道\]:?\s*/g, '\n\n')
            .replace(/\r\n/g, '\n')
            .trim();
        if (!cleaned) return [];

        const initialBlocks = cleaned
            .split(/\n+/)
            .map(p => p.trim())
            .filter(p => p.length >= 12);

        const paragraphs = [];
        for (const block of initialBlocks) {
            if (block.length <= 360) {
                paragraphs.push(block);
                continue;
            }
            // 将无换行的超长单段按句号切分为适读段落（每段约 160-280 字符）
            const sentences = block.split(/(?<=[.!?。！？；])\s+/);
            let acc = '';
            for (const sent of sentences) {
                const s = sent.trim();
                if (!s) continue;
                if (acc && (acc.length + s.length) > 260) {
                    paragraphs.push(acc.trim());
                    acc = s;
                } else {
                    acc = acc ? `${acc} ${s}` : s;
                }
            }
            if (acc.trim()) {
                paragraphs.push(acc.trim());
            }
        }
        return paragraphs;
    }

    _cleanChineseParagraph(para = '') {
        return String(para || '')
            .replace(/\[[^\]]*补充报道\]:?\s*/g, '')
            .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
            .replace(/(\d+)\s+([年月日%亿万])/g, '$1$2')
            .replace(/([“‘（《])\s+/g, '$1')
            .replace(/\s+([”’）》])/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * 多段落长文并发中文精译（在新闻抓取与编译阶段直接生成原文全文中文翻译）
     */
    async translateParagraphsToChinese(text, maxChars = 6000) {
        if (!text || typeof text !== 'string') return '';
        const sliced = text.trim().slice(0, maxChars);
        if (!sliced) return '';
        if (this._isMostlyChinese(sliced, 12)) return sliced;

        const rawParas = this._splitIntoParagraphs(sliced);

        if (rawParas.length === 0) {
            return await this.translateTextToChinese(sliced);
        }

        // 将段落打包为 <= 950 字符的块并发翻译，并保留段落换行结构
        const chunks = [];
        let currentChunk = '';
        for (const p of rawParas) {
            if ((currentChunk + '\n\n' + p).length > 950 && currentChunk) {
                chunks.push(currentChunk);
                currentChunk = p;
            } else {
                currentChunk = currentChunk ? `${currentChunk}\n\n${p}` : p;
            }
        }
        if (currentChunk) chunks.push(currentChunk);

        const translatedChunks = await Promise.all(
            chunks.slice(0, 6).map(chunk => this.translateTextToChinese(chunk, 7500))
        );
        return translatedChunks.filter(Boolean).join('\n\n');
    }

    _extractSourceChineseName(sourceName = '') {
        const raw = String(sourceName || '国际权威媒体').trim();
        const parenMatch = raw.match(/\(([^)]*[\u4e00-\u9fa5]+[^)]*)\)/);
        if (parenMatch && parenMatch[1]) return parenMatch[1].trim();
        if (this.isChineseText(raw)) return raw.split('(')[0].trim();
        const map = {
            reuters: '路透社',
            bbc: '英国广播公司',
            'associated press': '美联社',
            'ap news': '美联社',
            'new york times': '纽约时报',
            bloomberg: '彭博社',
            'financial times': '金融时报',
            guardian: '英国卫报',
            'wall street journal': '华尔街日报',
            'al jazeera': '半岛电视台',
            scmp: '南华早报',
            nhk: '日本放送协会',
            nikkei: '日经亚洲',
            yonhap: '韩联社',
            cna: '新加坡亚洲新闻台',
            axios: 'Axios快讯',
            politico: '政客新闻网',
            semafor: 'Semafor全球情报',
            fortune: '财富杂志',
            'ars technica': 'Ars科技评论',
            techcrunch: 'TechCrunch科技',
            'the verge': 'The Verge科技',
            'fox news': '福克斯新闻',
            'sky news': '天空新闻',
            'le monde': '法国世界报',
            dw: '德国之声',
            france24: '法国24台',
            cnbc: 'CNBC财经',
            economist: '经济学人',
            'washington post': '华盛顿邮报'
        };
        const lower = raw.toLowerCase();
        for (const [k, v] of Object.entries(map)) {
            if (lower.includes(k)) return v;
        }
        return '国际权威媒体';
    }

    _formatChineseTitle(rawTitle = '', article = {}, region = '国际', category = '国际') {
        let t = String(rawTitle || '')
            .replace(/\s*[-|—–]\s*[A-Za-z0-9\s.&']+$/g, '')
            .replace(/\s*[（(][A-Za-z\s.,'-]{2,}[)）]/g, '')
            .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
            .replace(/(\d+)\s+([年月日%亿万])/g, '$1$2')
            .replace(/([“‘（《])\s+/g, '$1')
            .replace(/\s+([”’）》])/g, '$1')
            .replace(/^[\s|｜•·-]+/, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!this._isMostlyChinese(t, 4)) {
            const srcZh = this._extractSourceChineseName(article.source?.name);
            t = `${srcZh}聚焦${region}${category}最新焦点动态与政策走向`;
        }

        t = t.replace(/^[“"'](.+)[”"']$/, '$1').trim();

        if (t.length > 32) {
            const colonParts = t.split(/[：:—–]+/).map(s => s.trim()).filter(s => s.length >= 10 && this._isMostlyChinese(s, 4));
            const fittingColon = colonParts.find(p => p.length <= 32);
            if (fittingColon) {
                t = fittingColon;
            } else {
                const clauseParts = t.split(/[，；、。！？!?]+/).map(s => s.trim()).filter(Boolean);
                let acc = '';
                for (const part of clauseParts) {
                    const next = acc ? `${acc}，${part}` : part;
                    if (next.length <= 32) {
                        acc = next;
                    } else {
                        break;
                    }
                }
                t = (acc && acc.length >= 10) ? acc : t.slice(0, 32);
            }
        }
        return t
            .slice(0, 32)
            .replace(/[，、；：:（(“"'\s]+$/, '')
            .replace(/(凭借|以及|因为|由于|关于|随着|对于|通过|成为|围绕|针对|在|的|与|和|及|或|并|向|对|于|为)$/, '');
    }

    _formatChineseSummary(rawZhBody = '', zhTitle = '', article = {}, region = '国际', category = '国际') {
        const srcZh = this._extractSourceChineseName(article.source?.name);
        let text = String(rawZhBody || '')
            .replace(/\[[^\]]*补充报道\]:?\s*/g, ' ')
            .replace(/\s*[（(][A-Za-z\s.,'-]{2,}[)）]/g, '')
            .replace(/\.{2,}|…+/g, '。')
            .replace(/([\u4e00-\u9fa5])\s+([\u4e00-\u9fa5])/g, '$1$2')
            .replace(/(\d+)\s+([年月日%亿万])/g, '$1$2')
            .replace(/^\s*[^|｜]{0,18}[|｜]\s*/, '')
            .replace(/^[\s|｜•·-]+/, '')
            .replace(/\s+/g, ' ')
            .trim();

        if (!this._isMostlyChinese(text, 8)) {
            text = `据${srcZh}报道，${zhTitle}。该事件涉及${region}${category}领域的核心议题与最新政策动向，多方机构正密切评估其对区域局势及全球市场的后续影响。`;
        }

        const sentences = text
            .split(/(?<=[。！？；])/)
            .map(s => s.replace(/^[\s|｜•·-]+/, '').trim())
            .filter(s => s && this._isMostlyChinese(s, 4));

        let summary = '';
        for (const s of sentences) {
            const cleanedSent = /[。！？；]$/.test(s) ? s : `${s}。`;
            if ((summary + cleanedSent).length <= 128) {
                summary += cleanedSent;
                if (summary.length >= 82) break;
            } else if (summary.length < 80) {
                const remain = 126 - summary.length;
                const sub = cleanedSent.slice(0, remain);
                const lastComma = Math.max(sub.lastIndexOf('，'), sub.lastIndexOf('；'));
                const cut = (summary.length + lastComma >= 82) ? sub.slice(0, lastComma) : sub;
                summary += `${cut.replace(/[，、；：:\s]+$/, '')}。`;
                break;
            } else {
                break;
            }
        }

        if (!summary || !this._isMostlyChinese(summary, 15)) {
            summary = `据${srcZh}报道，${zhTitle}。`;
        }

        if (summary.length < 80) {
            const filler = `据${srcZh}报道，该事件涉及${region}${category}领域的核心议题与最新政策动向，相关进展及各方表态正引发国际社会与全球市场的广泛关注，后续态势演进仍有待进一步观察。`;
            const combined = `${summary.replace(/[。！？；]+$/, '')}。${filler}`;
            if (combined.length <= 128) {
                summary = combined;
            } else {
                const slice127 = combined.slice(0, 127);
                const lastPunct = Math.max(slice127.lastIndexOf('。'), slice127.lastIndexOf('；'), slice127.lastIndexOf('，'));
                if (lastPunct >= 82) {
                    summary = slice127.slice(0, lastPunct).replace(/[，、；：:\s]+$/, '') + '。';
                } else {
                    summary = slice127.replace(/[，、；：:\s]+$/, '') + '。';
                }
            }
        }

        if (summary.length > 130) {
            summary = summary.slice(0, 128).replace(/[，、；：:（(“"'\s]+$/, '') + '。';
        }

        return summary;
    }

    _buildChineseKeyPoints(zhTitle = '', rawZhBody = '', zhSummary = '', article = {}, region = '国际', category = '国际') {
        const srcZh = this._extractSourceChineseName(article.source?.name);
        const existing = Array.isArray(article.keyPoints)
            ? article.keyPoints
                .map(k => String(k).replace(/^[\s|｜•·-]+/, '').trim())
                .filter(k => k.length >= 6 && this._isMostlyChinese(k, 4))
            : [];
        if (existing.length >= 3) {
            return existing.slice(0, 3).map(k => k.slice(0, 34));
        }

        const pool = [...existing];
        const rawClauses = `${zhSummary}。${rawZhBody}`
            .replace(/\[[^\]]*补充报道\]:?\s*/g, ' ')
            .replace(/\s*[（(][A-Za-z\s.,'-]{2,}[)）]/g, '')
            .split(/[。！？；|｜\n]+/)
            .flatMap(s => s.split(/[，]+/))
            .map(s => s.replace(/^[\s|｜:：•·“”"'-]+|[“”"'\s]+$/g, '').replace(/^(此外|同时|据悉|报道称|分析指出|对此|目前|当地时间|并|而|但)\s*/, '').trim())
            .filter(s => s.length >= 8 && s.length <= 30 && this._isMostlyChinese(s, 5));

        for (const c of rawClauses) {
            if (pool.length >= 3) break;
            if (!pool.some(existingPt => existingPt.includes(c.slice(0, 6)) || c.includes(existingPt.slice(0, 6)))) {
                pool.push(c);
            }
        }

        const fallbacks = [
            `核心焦点：${zhTitle.slice(0, 22)}`,
            article.sourceCount > 1
                ? `多源印证：${srcZh}等${article.sourceCount}家权威外媒交叉报道`
                : `权威信源：${srcZh}追踪报道${region}${category}最新进展`,
            `态势研判：事件牵动${region}${category}格局与后续政策走向`
        ];

        for (const fb of fallbacks) {
            if (pool.length >= 3) break;
            if (!pool.includes(fb)) {
                pool.push(fb);
            }
        }

        return pool.slice(0, 3);
    }

    /**
     * 确保单条新闻的标题、摘要、核心要点及原文全文译文均为高质量中文（在采编阶段直接生成完整中文译文并随快照上传 GitHub）
     */
    async ensureArticleInChinese(article) {
        if (!article) return article;
        const currentTitle = (article.translatedTitle || article.title || '').trim();
        const existingSummary = (article.summary || article.translatedDescription || '').trim();

        const descText = String(article.description || '').replace(/\[[^\]]*补充报道\]:?\s*/g, ' ').trim();
        const contentText = String(article.fullText || article.content || '').replace(/\[[^\]]*补充报道\]:?\s*/g, '\n\n').trim();
        let combinedBodySource = '';
        if (descText && contentText) {
            if (contentText.startsWith(descText.slice(0, Math.min(40, descText.length)))) {
                combinedBodySource = contentText;
            } else if (descText.startsWith(contentText.slice(0, Math.min(40, contentText.length)))) {
                combinedBodySource = descText;
            } else {
                combinedBodySource = `${descText}\n\n${contentText}`;
            }
        } else {
            combinedBodySource = contentText || descText || existingSummary || currentTitle;
        }
        const sourceToTranslate = combinedBodySource.replace(/\s+/g, ' ').trim().slice(0, 650);
        const rawFullSource = combinedBodySource.trim().slice(0, 5500);
        const originalParagraphs = (Array.isArray(article.originalParagraphs) && article.originalParagraphs.length > 0)
            ? article.originalParagraphs
            : this._splitIntoParagraphs(rawFullSource);

        let zhTitle = currentTitle;
        let zhBody = this._isMostlyChinese(existingSummary, 15) ? existingSummary : sourceToTranslate;
        let zhFullText = '';

        const hasExistingTranslatedParas =
            Array.isArray(article.translatedParagraphs) &&
            article.translatedParagraphs.length > 0 &&
            article.translatedParagraphs.every(p => this._isMostlyChinese(p, 4));

        const tasks = [];
        if (!this._isMostlyChinese(zhTitle, 4)) {
            tasks.push(
                this.translateTextToChinese(article.title || currentTitle).then(res => {
                    zhTitle = res || currentTitle;
                })
            );
        }

        const needBodyTranslate = !this._isMostlyChinese(zhBody, 15) ||
            zhBody === article.title ||
            (zhBody.length < 80 && sourceToTranslate.length > zhBody.length && !this._isMostlyChinese(sourceToTranslate, 15));

        if (!hasExistingTranslatedParas && (rawFullSource.length > 650 || originalParagraphs.length > 1)) {
            tasks.push(
                this.translateParagraphsToChinese(rawFullSource, 5500).then(res => {
                    zhFullText = res || '';
                    if (needBodyTranslate && zhFullText && this._isMostlyChinese(zhFullText, 15)) {
                        zhBody = zhFullText.replace(/\s+/g, ' ').trim().slice(0, 500);
                    }
                })
            );
        } else if (needBodyTranslate) {
            tasks.push(
                this.translateTextToChinese(sourceToTranslate).then(res => {
                    zhBody = res || zhBody;
                })
            );
        }

        if (tasks.length > 0) {
            await Promise.all(tasks);
        }

        const region = this.determineNewsRegionSync(
            `${article.title || ''} ${zhTitle}`,
            `${article.description || ''} ${zhBody}`,
            article.source?.name || '',
            article.region
        );
        const category = this.determineNewsCategorySync(
            `${article.title || ''} ${zhTitle}`,
            `${article.description || ''} ${zhBody}`,
            article.source?.category || '',
            article.category
        );

        const formattedTitle = this._formatChineseTitle(zhTitle, article, region, category);
        const formattedSummary = this._formatChineseSummary(zhBody, formattedTitle, article, region, category);
        const keyPoints = this._buildChineseKeyPoints(formattedTitle, zhBody, formattedSummary, article, region, category);

        let translatedParagraphs = [];
        if (hasExistingTranslatedParas) {
            translatedParagraphs = article.translatedParagraphs.map(p => this._cleanChineseParagraph(p)).filter(Boolean);
        } else {
            const rawZhCandidate = zhFullText || (this._isMostlyChinese(rawFullSource, 15) ? rawFullSource : zhBody);
            translatedParagraphs = this._splitIntoParagraphs(rawZhCandidate)
                .map(p => this._cleanChineseParagraph(p))
                .filter(p => p.length >= 10 && this._isMostlyChinese(p, 4));
        }

        if (translatedParagraphs.length === 0) {
            translatedParagraphs = [formattedSummary];
        }

        const translatedContent = translatedParagraphs.join('\n\n');

        return {
            ...article,
            fullText: article.fullText || rawFullSource || article.content || article.description || '',
            originalParagraphs,
            translatedTitle: formattedTitle,
            translatedDescription: formattedSummary,
            summary: formattedSummary,
            translatedContent,
            translatedParagraphs,
            keyPoints,
            region,
            category,
            aiCompiled: this._isMostlyChinese(formattedTitle, 4) && this._isMostlyChinese(formattedSummary, 15)
        };
    }

    /**
     * 批量并发确保新闻列表已翻译为中文（用于第一阶段快速汉化与第二阶段兜底）
     */
    async ensureBatchInChinese(articles, concurrency = 6) {
        if (!Array.isArray(articles) || articles.length === 0) return [];
        const results = [...articles];
        for (let i = 0; i < results.length; i += concurrency) {
            const slice = results.slice(i, i + concurrency);
            const translatedSlice = await Promise.all(slice.map(item => this.ensureArticleInChinese(item)));
            for (let j = 0; j < translatedSlice.length; j++) {
                results[i + j] = translatedSlice[j];
            }
        }
        return results;
    }

    /**
     * 高效结构化批量编译 (支持分批增量回调 onBatchCompiled，用于前端渐进式实时更新)
     */
    async enhanceNewsArticles(articles, onProgress = null, onBatchCompiled = null) {
        if (!articles || articles.length === 0) return [];
        this.refreshConfig();

        const initialized = articles.map(a => this.applyPreliminaryMetadata(a));

        if (!this.modelConfig.apiKey) {
            logger.warn('AI', '未配置 AI_API_KEY，启用内置高速中文翻译通道...');
            return await this.ensureBatchInChinese(initialized, 6);
        }

        logger.info('AI', `启动 Agent 批量深度编译，共 ${initialized.length} 条全球新闻`);
        const batchSize = Math.min(config.ai.batchSize || 4, 5);
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
                logger.warn('AI', `批次 ${batchIndex} 大模型编译降级，自动切换高速中文翻译兜底: ${err.message}`);
                compiledBatch = batch.map(item => ({
                    ...item,
                    processedAt: new Date().toISOString()
                }));
            }

            // 二次校验：对本批次中任何未成功生成中文标题或中文摘要的条目，自动执行高速中文翻译补全
            compiledBatch = await this.ensureBatchInChinese(compiledBatch, 4);

            for (let j = 0; j < compiledBatch.length; j++) {
                enhancedList[i + j] = compiledBatch[j];
            }

            if (typeof onBatchCompiled === 'function') {
                try {
                    const deduplicatedCurrent = this.mergeDuplicateArticlesSync(enhancedList);
                    await onBatchCompiled(compiledBatch, i, deduplicatedCurrent);
                } catch (_) {}
            }
        }

        return await this.deduplicateWithLLM(enhancedList, { maxInspect: 42, timeout: 25000 });
    }

    async _compileBatchWithLLM(batch) {
        const itemsText = batch.map((article, idx) => {
            const sourceName = article.source?.name || 'Global Media';
            const relatedInfo = article.relatedSources?.length
                ? ` (交叉印证媒体: ${article.relatedSources.map(r => r.name).join(', ')})`
                : '';
            const bodySnippet = truncateText(article.content || article.description || '', 700);
            return `[#${idx + 1}] 来源: ${sourceName}${relatedInfo}\n原标题: ${article.title}\n正文摘录: ${bodySnippet}`;
        }).join('\n\n---\n\n');

        const prompt = `你是一位资深国际新闻总编。请将以下 ${batch.length} 条全球权威媒体报道编译为高质量中文情报卡片。

严格要求：
1. 返回纯 JSON 数组，每个元素对应输入的一条新闻：
[
  {
    "id": 1,
    "translatedTitle": "简洁专业的中文新闻标题（不超过32字，直述核心事实，必须为中文）",
    "summary": "客观详实的中文深度摘要（80-130字，交代核心事实、关键数据或各方立场，必须为中文）",
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
        parsed.forEach((entry, idx) => {
            if (!entry || typeof entry !== 'object') return;
            if (typeof entry.id === 'number') {
                resultMap.set(entry.id - 1, entry);
            } else if (typeof entry.id === 'string') {
                const num = parseInt(entry.id.replace(/\D+/g, ''), 10);
                if (!isNaN(num) && num >= 1) {
                    resultMap.set(num - 1, entry);
                } else {
                    resultMap.set(idx, entry);
                }
            } else {
                resultMap.set(idx, entry);
            }
        });

        return batch.map((article, idx) => {
            const compiled = resultMap.get(idx) || parsed[idx] || {};
            const region = VALID_REGIONS.find(r => (compiled.region || '').includes(r)) || article.region || '国际';
            const category = VALID_CATEGORIES.find(c => (compiled.category || '').includes(c)) || article.category || '国际';

            const candidateTitle = (compiled.translatedTitle || compiled.title || article.translatedTitle || article.title || '').trim();
            const candidateSummary = (compiled.summary || compiled.description || article.summary || article.description || article.title || '').trim();

            return {
                ...article,
                translatedTitle: candidateTitle,
                translatedDescription: candidateSummary,
                summary: candidateSummary,
                region,
                category,
                keyPoints: Array.isArray(compiled.keyPoints) ? compiled.keyPoints.slice(0, 3) : [],
                aiCompiled: this.isChineseText(candidateTitle),
                processedAt: new Date().toISOString()
            };
        });
    }

    /**
     * 主编 Agent：生成结构化《全球新闻深度综述文章》
     */
    async generateNewsSummaryArticle(newsData) {
        if (!newsData || newsData.length === 0) {
            throw new Error('没有可用的新闻数据');
        }

        const currentDate = new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            weekday: 'long',
            timeZone: 'Asia/Shanghai'
        });

        if (!this.modelConfig.apiKey) {
            return this._buildFallbackSummaryObject(newsData, currentDate);
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

        const prompt = `你是“聚核 (CoreFeed)”全球情报中心的主编 Agent。请基于以下采集自全球知名媒体（路透社、美联社、BBC、纽约时报、彭博社、南华早报等）的 ${newsData.length} 条新闻，撰写一篇结构严谨、洞察深刻的《${currentDate} 全球新闻深度综述》。

写作要求：
1. 第一行直接输出文章标题：${currentDate} 全球要闻深度综述
2. 包含一个简短的【全球态势导读】（100-150字，提炼今日全球政经、科技与地缘核心脉络）。
3. 正文按重点板块或地区（如【国际政经与大国博弈】、【欧美动态】、【亚太与中国周边】、【中东与地区冲突】、【前沿科技与全球市场】）分节综述，每节以“### 板块名称”作为小标题。
4. 将零散新闻有机串联对比，客观陈述各方信源事实；在引述具体新闻事实的句末，**必须原样附上对应的引用标识符**，格式严格为 [NEWS_1]、[NEWS_2] 等。
5. 全文篇幅控制在 1000-1600 字，语言凝练、专业，不要输出任何 <think> 思考过程。

今日全球信源素材：
${newsContent}`;

        try {
            let rawContent = await this._callAI([{ role: 'user', content: prompt }]);
            rawContent = this._cleanAIResponse(rawContent);
            if (rawContent && rawContent.length >= 100) {
                return this.createSummaryArticleObject(rawContent, newsData, currentDate);
            }
        } catch (err) {
            logger.warn('AI', `大模型综述生成异常，自动切换结构化智能综述生成: ${err.message}`);
        }

        return this._buildFallbackSummaryObject(newsData, currentDate);
    }

    _buildFallbackSummaryObject(newsData, currentDate) {
        const grouped = {};
        newsData.forEach((item, idx) => {
            const cat = item.category || '国际';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push({ item, refIdx: idx + 1 });
        });

        const sections = [];
        sections.push(`${currentDate} 全球要闻深度综述`);
        sections.push(`### 全球态势导读\n本期共聚合全球权威媒体 ${newsData.length} 起核心焦点事件，覆盖 ${[...new Set(newsData.map(n => n.region || '国际'))].join('、')} 等重点地区，围绕 ${Object.keys(grouped).join('、')} 展开多信源交叉印证。`);

        for (const [cat, list] of Object.entries(grouped)) {
            const lines = list.map(({ item, refIdx }) => {
                const title = item.translatedTitle || item.title;
                const summary = item.summary || item.description || '';
                return `**${title}**：${summary} [NEWS_${refIdx}]`;
            });
            sections.push(`### ${cat}焦点动态\n${lines.join('\n\n')}`);
        }

        return this.createSummaryArticleObject(sections.join('\n\n'), newsData, currentDate);
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
