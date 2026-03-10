const config = require('../config');
const { retryAsync, delay, stripHtml, truncateText } = require('../utils/helpers');
const logger = require('../utils/logger');
const RateLimiter = require('../utils/rate_limiter');

/**
 * AI服务类 - 使用MiniMax处理翻译、摘要生成等AI相关功能
 */
class AIService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.modelConfig = {}; // 存储模型配置信息
        this.initializeServices();
        
        // 使用新的速率限制器（根据配置决定是否启用）
        const tokensPerMinute = (config.minimax && config.minimax.rateLimitRpm) || 0;
        
        if (tokensPerMinute > 0) {
            // 启用速率限制
            this.rateLimiter = new RateLimiter({
                tokensPerMinute: tokensPerMinute,
                maxBurst: Math.max(1, (config.minimax && config.minimax.rateLimitBurst) || Math.ceil(tokensPerMinute / 3)),
                minInterval: Math.ceil(60000 / tokensPerMinute)
            });
            
            logger.info('AI', '速率限制器已启用', {
                requestsPerMinute: tokensPerMinute,
                minInterval: `${Math.ceil(60000 / tokensPerMinute)}ms`
            });
        } else {
            // 不启用速率限制，创建一个无限制的执行器
            this.rateLimiter = {
                execute: async (fn, options) => await fn(),
                getStats: () => ({
                    totalRequests: 0,
                    successfulRequests: 0,
                    queueLength: 0,
                    note: '速率限制已禁用'
                })
            };
            
            logger.info('AI', 'MiniMax模型速率限制已禁用');
        }
    }

    /**
     * 初始化AI服务
     */
    initializeServices() {
        try {
            // 读取MiniMax配置
            const minimaxConfig = config.minimax || {};
            const apiKey = minimaxConfig.apiKey || '';
            const baseUrl = (minimaxConfig.baseUrl || '').replace(/\/+$/, '');
            const model = minimaxConfig.model || 'MiniMax-M2.5';

            this.modelConfig = {
                apiKey: apiKey,
                baseUrl: baseUrl,
                model: model,
                provider: 'MiniMax'
            };

            if (apiKey) {
                logger.success('AI', 'AI服务初始化成功', {
                    model: model,
                    provider: 'MiniMax'
                });
            } else {
                logger.warn('AI', '未配置MiniMax API密钥');
            }
        } catch (error) {
            logger.error('AI', 'AI服务初始化失败', error.message);
        }
    }

    /**
     * 动态读取最新配置
     */
    refreshConfig() {
        try {
            // 清除require缓存，重新加载配置
            delete require.cache[require.resolve('../config')];
            const newConfig = require('../config');

            // 更新MiniMax配置
            const minimaxConfig = newConfig.minimax || {};
            const apiKey = minimaxConfig.apiKey || '';
            const baseUrl = (minimaxConfig.baseUrl || '').replace(/\/+$/, '');
            const model = minimaxConfig.model || 'MiniMax-M2.5';

            this.modelConfig = {
                apiKey: apiKey,
                baseUrl: baseUrl,
                model: model,
                provider: 'MiniMax'
            };

            // 更新速率限制器
            const tokensPerMinute = (minimaxConfig.rateLimitRpm) || 0;

            if (tokensPerMinute > 0 && tokensPerMinute !== (this.rateLimiter.tokensPerMinute || 0)) {
                // 重新创建速率限制器
                const RateLimiter = require('../utils/rate_limiter');
                this.rateLimiter = new RateLimiter({
                    tokensPerMinute: tokensPerMinute,
                    maxBurst: Math.max(1, (minimaxConfig.rateLimitBurst) || Math.ceil(tokensPerMinute / 3)),
                    minInterval: Math.ceil(60000 / tokensPerMinute)
                });

                logger.info('AI', '速率限制器已更新', {
                    requestsPerMinute: tokensPerMinute,
                    minInterval: `${Math.ceil(60000 / tokensPerMinute)}ms`
                });
            }

            // 记录配置更新信息
            const configInfo = {
                model: model,
                apiKey: apiKey ? '***' + apiKey.slice(-4) : '未设置',
                baseUrl: baseUrl,
                tokensPerMinute: tokensPerMinute
            };

            logger.info('AI', '配置已刷新', configInfo);

            return true;
        } catch (error) {
            logger.error('AI', '刷新配置失败', error.message);
            return false;
        }
    }

    /**
     * 核心方法：调用AI API
     */
    async _callAI(messages, model = null, options = {}) {
        const { priority = 5, timeout = 180000 } = options;

        // 在每次调用时检查配置是否需要更新
        this.refreshConfig();

        if (!this.modelConfig.apiKey) {
            throw new Error(`MiniMax API密钥未配置`);
        }

        const modelToUse = model || this.modelConfig.model;

        // 使用速率限制器执行请求
        return await this.rateLimiter.execute(async () => {
            const headers = {
                "Authorization": `Bearer ${this.modelConfig.apiKey}`,
                "Content-Type": "application/json"
            };

            const requestBody = {
                model: modelToUse,
                messages: messages,
                reasoning_split: true // 尝试分离思考过程，使content更纯净
            };

            // 调试日志：记录请求信息
            logger.debug('AI', `API请求 [${modelToUse}]`, {
                endpoint: `${this.modelConfig.baseUrl}/chat/completions`,
                provider: this.modelConfig.provider,
                messageCount: messages.length,
                timeout: `${timeout/1000}s`,
                firstMessage: messages[0] ? messages[0].content.substring(0, 100) : 'N/A'
            });

            let response;
            try {
                // 添加超时控制
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                response = await fetch(`${this.modelConfig.baseUrl}/chat/completions`, {
                    method: "POST",
                    headers,
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);
            } catch (fetchError) {
                // 网络层面的错误
                logger.error('AI', `网络请求失败 [${modelToUse}]`, {
                    error: fetchError.message,
                    errorName: fetchError.name,
                    endpoint: `${this.modelConfig.baseUrl}/chat/completions`
                });

                const error = new Error(`网络请求失败: ${fetchError.message}`);
                error.originalError = fetchError;
                error.status = 0;
                error.provider = this.modelConfig.provider;
                throw error;
            }

            if (!response.ok) {
                let errorDetails = '';
                try {
                    const errorBody = await response.json();
                    errorDetails = JSON.stringify(errorBody);
                } catch (e) {
                    errorDetails = await response.text();
                }

                const errorMessage = `HTTP error! status: ${response.status}, details: ${errorDetails}`;
                logger.error('AI', `API请求失败 [${modelToUse}]`, {
                    status: response.status,
                    statusText: response.statusText,
                    details: errorDetails,
                    endpoint: `${this.modelConfig.baseUrl}/chat/completions`,
                    model: modelToUse,
                    provider: this.modelConfig.provider
                });

                const error = new Error(errorMessage);
                error.status = response.status;
                error.details = errorDetails;
                error.provider = this.modelConfig.provider;
                throw error;
            }

            const data = await response.json();
            if (data.choices && data.choices.length > 0 && data.choices[0].message.content) {
                logger.debug('AI', `API请求成功 [${modelToUse}]`, {
                    provider: this.modelConfig.provider,
                    contentLength: data.choices[0].message.content.length
                });
                // 统一清理响应内容（去除思考过程等）
                return this._cleanAIResponse(data.choices[0].message.content);
            } else {
                throw new Error('AI响应格式不正确或内容为空');
            }
        }, { priority, maxRetries: 3 });
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
            apiKeyConfigured: !!this.modelConfig.apiKey,
            failureCount: 0
        };
    }

    /**
     * 重试AI请求 (简化版，不再切换模型)
     */
    async retryWithFallback(aiFunction, args = [], maxRetries = 3) {
        let retries = 0;
        let lastError;
        
        while (retries <= maxRetries) {
            try {
                return await aiFunction.apply(this, [this.modelConfig.model, ...args]);
            } catch (error) {
                lastError = error;
                retries++;
                
                logger.error('AI', `请求失败 (重试 ${retries}/${maxRetries})`, error.message);
                
                if (retries <= maxRetries) {
                    await delay(2000 * retries); // 指数退避
                }
            }
        }
        
        throw lastError;
    }

    /**
     * 翻译文本
     */
    async translateText(text, targetLanguage = 'zh', sourceLanguage = null) {
        if (!this.modelConfig.apiKey) {
            logger.warn('AI', 'AI未配置，无法翻译');
            return text;
        }
        if (!text || text.trim() === '') {
            return text;
        }

        try {
            return await this.retryWithFallback(this._translateWithAI, [text, targetLanguage, sourceLanguage]);
        } catch (error) {
            logger.error('AI', '翻译失败', error.message);
            return text;
        }
    }

    /**
     * 使用AI翻译
     */
    async _translateWithAI(modelName, text, targetLanguage, sourceLanguage) {
        const prompt = `请直接将以下文本翻译成${targetLanguage}。
重要规则：
1. 只输出翻译结果，不要包含任何解释、开场白（如"好的"、"翻译如下"等）、结束语或思考过程（<think>标签）。
2. 不要使用引号包裹结果。
3. 保持原意不变。

文本内容：
${text}`;
        const messages = [{ role: 'user', content: prompt }];
        const result = await this._callAI(messages, modelName);
        return this._cleanAIResponse(result);
    }

    /**
     * 清理AI响应中的多余字符
     */
    _cleanAIResponse(text) {
        if (!text) return text;
        
        let cleaned = text;
        
        // 0. 移除 <think>...</think> 思考过程块 (MiniMax等推理模型)
        // 增强版正则表达式，处理可能存在的属性和换行，并使用非贪婪匹配
        cleaned = cleaned.replace(/<think[\s\S]*?<\/think>/gi, '').trim();

        // 1. 移除Markdown代码块标记
        cleaned = cleaned.replace(/^```(json|text)?\n?([\s\S]*?)\n?```$/s, '$2').trim();
        
        // 2. 移除常见的对话前缀
        const conversationalRegex = /^(好的|当然|没问题|这里是|以下是|翻译如下|翻译结果|根据您的要求|提供以下|这里有).{0,100}?[：:,:：\n]/i;
        
        if (conversationalRegex.test(cleaned)) {
            cleaned = cleaned.replace(conversationalRegex, '').trim();
        }
        
        // 3. 移除首尾引号
        cleaned = cleaned.replace(/^["'「『](.*?)["'」』]$/s, '$1');
        
        return cleaned.trim();
    }

    /**
     * 翻译标题（带长度控制）
     */
    async translateTitle(title, targetLanguage = 'zh', sourceLanguage = null, maxLength = 30) {
        if (!title || title.trim() === '') {
            return title;
        }

        try {
            // 使用AI翻译
            const prompt = `请直接将以下标题翻译成${targetLanguage}。
重要规则：
1. 只输出翻译结果，不要包含任何解释、思考过程或<think>标签。
2. 保持简洁（不超过${maxLength}字）。
3. 不要使用引号。

标题：${title}`;
            const messages = [{ role: 'user', content: prompt }];
            let translatedTitle = await this._callAI(messages, this.getCurrentModelName());
            translatedTitle = this._cleanAIResponse(translatedTitle);
            
            if (translatedTitle.length > maxLength) {
                try {
                    const simplifiedTitle = await this._simplifyTextInternal(
                        this.getCurrentModelName(), 
                        translatedTitle, 
                        maxLength, 
                        '新闻标题'
                    );
                    if (simplifiedTitle && simplifiedTitle.length <= maxLength) {
                        return simplifiedTitle;
                    }
                } catch (simplifyError) {
                    logger.warn('AI', '标题简化失败，使用截断方案', simplifyError.message);
                }
                return this._smartTruncate(translatedTitle, maxLength);
            }
            return translatedTitle;
        } catch (error) {
            logger.error('AI', '标题翻译失败', error.message);
            return title;
        }
    }

    async _simplifyTextInternal(modelName, text, maxLength, context) {
        const prompt = `请将以下${context}简化为不超过${maxLength}个字符的简短版本。
规则：
1. 只输出简化后的内容，不要包含任何解释、思考过程或<think>标签。
2. 保持核心信息不变。

内容：${text}`;
        const messages = [{ role: 'user', content: prompt }];
        const result = await this._callAI(messages, modelName);
        return this._cleanAIResponse(result);
    }

    /**
     * 智能截断文本，在完整词语处截断
     */
    _smartTruncate(text, maxLength) {
        if (text.length <= maxLength) {
            return text;
        }
        
        // 尝试在标点符号处截断
        const punctuationCut = text.substring(0, maxLength).match(/^.*[。！？，；：]/);
        if (punctuationCut && punctuationCut[0].length >= maxLength * 0.7) {
            return punctuationCut[0].trim();
        }
        
        // 尝试在完整词语处截断
        const wordCut = text.substring(0, maxLength).match(/^.*\s/);
        if (wordCut && wordCut[0].length >= maxLength * 0.7) {
            return wordCut[0].trim();
        }
        
        // 最后使用直接截断
        return text.substring(0, maxLength);
    }

    /**
     * 批量翻译文本
     */
    async translateTexts(texts, targetLanguage = 'zh', sourceLanguage = null) {
        if (!texts || texts.length === 0) {
            return texts;
        }

        const promises = texts.map(async (text, i) => {
            if (text && text.trim() !== '') {
                try {
                    return await this._translateWithAI(
                        this.getCurrentModelName(), 
                        text, 
                        targetLanguage, 
                        sourceLanguage
                    );
                } catch (error) {
                    logger.error('AI', `批量翻译第${i + 1}条失败: ${text.substring(0, 50)}...`, error.message);
                    return text; // 失败时返回原文本
                }
            } else {
                return text;
            }
        });
        
        return Promise.all(promises);
    }

    /**
     * 使用AI判断新闻地区
     */
    /**
     * 批量确定新闻地区
     */
    async batchDetermineNewsRegions(articles) {
        if (!this.modelConfig.apiKey || !articles || articles.length === 0) {
            return new Map();
        }

        logger.info('AI', `开始批量识别新闻地区，共 ${articles.length} 条`);
        try {
            return await this.retryWithFallback(this._batchDetermineNewsRegionsInternal, [articles]);
        } catch (error) {
            logger.error('AI', '批量识别地区失败', error.message);
            return new Map();
        }
    }

    async _batchDetermineNewsRegionsInternal(modelName, articles) {
        const batchSize = 20;
        const regionMap = new Map();
        const validRegions = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '国际', '亚洲', '澳洲'];
        
        for (let i = 0; i < articles.length; i += batchSize) {
            const batch = articles.slice(i, i + batchSize);
            const batchContent = batch.map((article, idx) => {
                const title = (article.translatedTitle || article.title || '').replace(/\s+/g, ' ').substring(0, 100);
                const desc = (article.description || '').replace(/\s+/g, ' ').substring(0, 100);
                const source = article.source?.name || '';
                // 使用全局索引作为ID
                return `${i + idx + 1}. [${source}] ${title} - ${desc}`;
            }).join('\n');

            const prompt = `请分析以下新闻标题和来源，判断每条新闻主要涉及的地区。
可选地区：[${validRegions.join(', ')}]
规则：
1. 只返回JSON数组，格式为：[{"id": 1, "region": "地区"}, ...]
2. id对应输入的序号。
3. 如果无法确定或涉及多个地区，优先选择主要当事国所在地区，或者是'国际'。
4. 不要包含任何思考过程或<think>标签。

新闻列表：
${batchContent}`;

            try {
                const response = await this._callAI([{ role: 'user', content: prompt }], modelName);
                // 尝试提取JSON
                let jsonStr = response.trim();
                // 移除可能的markdown标记
                jsonStr = jsonStr.replace(/^```json\n?|\n?```$/g, '');
                // 移除可能的开头非JSON字符
                const jsonStart = jsonStr.indexOf('[');
                const jsonEnd = jsonStr.lastIndexOf(']');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
                }
                
                const results = JSON.parse(jsonStr);
                
                if (Array.isArray(results)) {
                    results.forEach(item => {
                        if (item && item.id && item.region) {
                            const originalIndex = item.id - 1;
                            let region = item.region;
                            // 验证地区是否有效
                            if (!validRegions.some(r => region.includes(r))) {
                                region = '国际';
                            } else {
                                // 规范化地区名称
                                const found = validRegions.find(r => region.includes(r));
                                if (found) region = found;
                            }
                            
                            if (originalIndex >= 0 && originalIndex < articles.length) {
                                regionMap.set(originalIndex, region);
                            }
                        }
                    });
                }
            } catch (e) {
                logger.warn('AI', `批次 ${Math.floor(i/batchSize) + 1} 地区识别解析失败`, e.message);
            }
            
            // 简单的速率控制
            if (i + batchSize < articles.length) {
                await delay(1000);
            }
        }
        
        return regionMap;
    }

    async determineNewsRegion(title, description, sourceName) {
        if (!this.modelConfig.apiKey) return '国际';
        try {
            return await this.retryWithFallback(this._determineNewsRegionInternal, [title, description, sourceName]);
        } catch (error) {
            logger.error('AI', 'AI地区判断失败', error.message);
            return '国际';
        }
    }

    async _determineNewsRegionInternal(modelName, title, description, sourceName) {
        const content = `${title} ${description} ${sourceName}`.substring(0, 500);
        const prompt = `请根据以下新闻内容判断其主要涉及的地区，只返回一个地区名称（如：中国、美国、欧洲、日本、韩国、东南亚、中东、非洲、拉美、国际等），不要包含任何思考过程或<think>标签：\n\n${content}`;
        const region = await this._callAI([{ role: 'user', content: prompt }], modelName);
        
        const validRegions = ['中国', '美国', '欧洲', '日本', '韩国', '东南亚', '中东', '非洲', '拉美', '国际', '亚洲', '澳洲'];
        const foundRegion = validRegions.find(r => region.includes(r));
        return foundRegion || '国际';
    }

    /**
     * 生成新闻摘要
     */
    async generateNewsSummary(title, description, content) {
        if (!this.modelConfig.apiKey) return description || title;
        try {
            return await this.retryWithFallback(this._generateNewsSummaryInternal, [title, description, content]);
        } catch (error) {
            logger.error('AI', 'AI摘要生成失败', error.message);
            return description || title;
        }
    }

    async _generateNewsSummaryInternal(modelName, title, description, content) {
        const fullContent = [title, description, content].filter(Boolean).join(' ').substring(0, 1000);
        if (fullContent.length < 50) return description || title;

        const prompt = `请为以下新闻生成一个客观简洁的中文摘要（80-120字），只列出事实要点，不要添加主观评价、分析或思考过程（<think>标签）。\n\n${fullContent}`;
        let summary = await this._callAI([{ role: 'user', content: prompt }], modelName);
        
        summary = stripHtml(summary)
            .replace(/^以下是根据要求生成的新闻摘要（\d+字）[：:]/i, '')
            .replace(/^摘要[：:]/i, '')
            .replace(/^新闻摘要[：:]/i, '')
            .trim();
        return truncateText(summary, 200) || description || title;
    }

    /**
     * 计算两个标题的相似度 (Jaccard Similarity of words/chars)
     */
    _calculateSimilarity(str1, str2) {
        if (!str1 || !str2) return 0;
        const s1 = str1.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, '');
        const s2 = str2.toLowerCase().replace(/[^\w\u4e00-\u9fa5\s]/g, '');
        
        if (s1 === s2) return 1;
        
        // 分词：如果是中文，按字分；如果是英文，按空格分
        const isChinese1 = /[\u4e00-\u9fa5]/.test(s1);
        const tokens1 = isChinese1 ? s1.split('') : s1.split(/\s+/).filter(t => t.length > 2);
        const tokens2 = isChinese1 ? s2.split('') : s2.split(/\s+/).filter(t => t.length > 2);
        
        if (tokens1.length === 0 || tokens2.length === 0) return 0;

        const set1 = new Set(tokens1);
        const set2 = new Set(tokens2);
        
        const intersection = new Set([...set1].filter(x => set2.has(x)));
        const union = new Set([...set1, ...set2]);
        
        return intersection.size / union.size;
    }

    /**
     * 批量生成新闻摘要
     */
    async batchGenerateSummaries(articles) {
        if (!this.modelConfig.apiKey || !articles || articles.length === 0) {
            return new Map();
        }

        logger.info('AI', `开始批量生成新闻摘要，共 ${articles.length} 条`);
        try {
            return await this.retryWithFallback(this._batchGenerateSummariesInternal, [articles]);
        } catch (error) {
            logger.error('AI', '批量生成摘要失败', error.message);
            return new Map();
        }
    }

    async _batchGenerateSummariesInternal(modelName, articles) {
        const batchSize = 5; // 摘要生成较重，每批5条
        const summaryMap = new Map();
        
        for (let i = 0; i < articles.length; i += batchSize) {
            const batch = articles.slice(i, i + batchSize);
            const batchContent = batch.map((article, idx) => {
                const title = article.translatedTitle || article.title || '';
                const desc = article.translatedDescription || article.description || '';
                const content = (article.content || '').substring(0, 200);
                const fullText = [title, desc, content].join(' ').substring(0, 500);
                
                // 使用全局索引作为ID
                return `${i + idx + 1}. [${title}] ${fullText}`;
            }).join('\n\n');

            const prompt = `请为以下新闻分别生成客观简洁的中文摘要（80-120字）。
规则：
1. 只返回JSON数组，格式为：[{"id": 1, "summary": "摘要内容"}, ...]
2. id对应输入的序号。
3. 摘要只列出事实要点，不要添加主观评价、分析或思考过程。
4. 确保每条新闻都有对应的摘要。

新闻列表：
${batchContent}`;

            try {
                const response = await this._callAI([{ role: 'user', content: prompt }], modelName);
                
                // 尝试提取JSON
                let jsonStr = response.trim();
                jsonStr = jsonStr.replace(/^```json\n?|\n?```$/g, '');
                const jsonStart = jsonStr.indexOf('[');
                const jsonEnd = jsonStr.lastIndexOf(']');
                
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    jsonStr = jsonStr.substring(jsonStart, jsonEnd + 1);
                    const results = JSON.parse(jsonStr);
                    
                    if (Array.isArray(results)) {
                        results.forEach(item => {
                            if (item && item.id && item.summary) {
                                const originalIndex = item.id - 1;
                                if (originalIndex >= 0 && originalIndex < articles.length) {
                                    summaryMap.set(originalIndex, item.summary);
                                }
                            }
                        });
                    }
                }
            } catch (e) {
                logger.warn('AI', `批次 ${Math.floor(i/batchSize) + 1} 摘要生成解析失败`, e.message);
            }
            
            if (i + batchSize < articles.length) {
                await delay(1000);
            }
        }
        
        return summaryMap;
    }

    /**
     * 使用AI智能去重新闻文章 (优化版：预聚类+AI裁决)
     */
    async removeDuplicateNewsWithAI(articles) {
        if (!this.modelConfig.apiKey || !articles || articles.length <= 1) {
            return articles;
        }

        logger.info('AI', `Deduplicating ${articles.length} articles (Optimized).`);
        try {
            // 1. 预聚类：使用标题相似度进行快速分组
            const clusters = this._clusterArticlesBySimilarity(articles);
            logger.debug('AI', `预聚类完成: ${clusters.length} 个组 (原始 ${articles.length} 条)`);

            // 2. AI裁决：对有重复的组进行AI筛选
            let uniqueArticles = [];
            const clustersToProcess = [];

            for (const cluster of clusters) {
                if (cluster.length === 1) {
                    uniqueArticles.push(cluster[0]);
                } else {
                    clustersToProcess.push(cluster);
                }
            }

            if (clustersToProcess.length > 0) {
                logger.info('AI', `需AI裁决 ${clustersToProcess.length} 个重复组`);
                const resolvedArticles = await this.retryWithFallback(this._resolveDuplicateClustersInternal, [clustersToProcess]);
                uniqueArticles = [...uniqueArticles, ...resolvedArticles];
            }

            logger.success('AI', `去重完成: ${articles.length}→${uniqueArticles.length}条`);
            return uniqueArticles;
        } catch (error) {
            logger.error('AI', 'AI去重失败，使用基础去重', error.message);
            return this.basicDuplicateRemoval(articles);
        }
    }

    _clusterArticlesBySimilarity(articles) {
        const clusters = [];
        // 降低阈值以捕获更多潜在重复
        const threshold = 0.4; 
        
        // 按时间排序，新的在前
        const sortedArticles = [...articles].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

        for (const article of sortedArticles) {
            let added = false;
            for (const cluster of clusters) {
                // 与组内第一条（最新的）比较
                const sim = this._calculateSimilarity(article.title, cluster[0].title);
                if (sim > threshold) {
                    cluster.push(article);
                    added = true;
                    break;
                }
            }
            if (!added) {
                clusters.push([article]);
            }
        }
        return clusters;
    }

    async _resolveDuplicateClustersInternal(modelName, clusters) {
        let resolvedArticles = [];
        // 将多个小组合并成批次处理，减少API调用
        // 但为了准确性，我们还是逐个组处理，或者每批处理几个组
        // 这里简化逻辑：每批处理5个组
        
        const batchSize = 5;
        for (let i = 0; i < clusters.length; i += batchSize) {
            const batchClusters = clusters.slice(i, i + batchSize);
            const batchResolved = await this._processClusterBatch(modelName, batchClusters);
            resolvedArticles = [...resolvedArticles, ...batchResolved];
            
            if (i + batchSize < clusters.length) {
                await delay(1000);
            }
        }
        return resolvedArticles;
    }

    async _processClusterBatch(modelName, clusters) {
        // 构建Prompt
        let promptContent = '';
        let globalIndex = 0;
        const indexMap = new Map(); // globalIndex -> article

        clusters.forEach((cluster, clusterIndex) => {
            promptContent += `\n【第 ${clusterIndex + 1} 组新闻】（请从中选出1篇最佳报道）：\n`;
            cluster.forEach(article => {
                globalIndex++;
                indexMap.set(globalIndex, article);
                const source = article.source?.name || '未知';
                const title = (article.translatedTitle || article.title || '').replace(/\s+/g, ' ');
                const desc = (article.description || '').substring(0, 100).replace(/\s+/g, ' ');
                promptContent += `${globalIndex}. [${source}] ${title} (${desc})\n`;
            });
        });

        const prompt = `你是一个专业新闻编辑。以下列出了几组关于同一事件的新闻报道。
请为**每一组**新闻选出**1篇**最佳报道。

选择标准：
1. 优先选择权威媒体（如新华社、路透社、BBC、CNN、纽约时报等）。
2. 优先选择信息量大、描述完整的报道。
3. 优先选择最新的报道。

请返回JSON数组，包含被选中新闻的编号：
{"selected_ids": [1, 4, 8]}

新闻列表：
${promptContent}

只返回JSON，不要包含其他内容。`;

        try {
            const response = await this._callAI([{ role: 'user', content: prompt }], modelName);
            const jsonStr = response.trim().replace(/^```json\n?|\n?```$/g, '');
            const match = jsonStr.match(/\{[\s\S]*\}/);
            
            if (match) {
                const result = JSON.parse(match[0]);
                if (result.selected_ids && Array.isArray(result.selected_ids)) {
                    return result.selected_ids.map(id => indexMap.get(id)).filter(Boolean);
                }
            }
        } catch (e) {
            logger.warn('AI', '去重裁决解析失败，默认保留每组第一条', e.message);
        }

        // 降级策略：每组保留第一条
        return clusters.map(c => c[0]);
    }

    /**
     * 基础去重方法（备用）
     */
    basicDuplicateRemoval(articles, existingArticles = []) {
        const seenTitles = new Set(existingArticles.map(a => a.title.toLowerCase().substring(0, 50)));
        return articles.filter(article => {
            const identifier = article.title.toLowerCase().substring(0, 50);
            if (seenTitles.has(identifier)) return false;
            seenTitles.add(identifier);
            return true;
        });
    }

    /**
     * AI智能选择最优质的30条新闻
     */
    async selectTopQualityNews(articles, targetCount = 30) {
        if (!this.modelConfig.apiKey || !articles || articles.length <= targetCount) {
            return articles;
        }

        logger.info('AI', `从 ${articles.length} 条新闻中智能选择 ${targetCount} 条最优质新闻`);
        
        try {
            const selectedArticles = await this.retryWithFallback(this._selectTopQualityNewsInternal, [articles, targetCount]);
            logger.success('AI', `智能选择完成: ${articles.length}→${selectedArticles.length}条`);
            return selectedArticles;
        } catch (error) {
            logger.error('AI', 'AI智能选择失败，使用规则评分', error.message);
            // 备用：使用规则评分
            const scoredArticles = this._scoreArticlesByRules(articles);
            return scoredArticles.slice(0, targetCount);
        }
    }

    _scoreArticlesByRules(articles) {
        const authorityScores = {
            'BBC': 95, 'CNN': 95, 'The New York Times': 96,
            'The Wall Street Journal': 96, 'Associated Press': 97, 'Bloomberg': 94,
            '新华社': 95, '纽约时报': 96, '华尔街日报': 96, 'Reuters': 97,
            'The Guardian': 88, 'Al Jazeera': 85, 'FRANCE 24': 85,
            'The Independent': 82, 'TIME': 84, 'The Japan Times': 80,
            'Channel News Asia': 82, 'Global News': 78, 'NHK World': 83,
            'AP News': 90, 'Fox News': 70, 'Russia Today': 60,
            'Japan Today': 72, 'Taipei Times': 68, 'The Washington Post': 94,
            'Financial Times': 95, 'CNBC': 90, 'Politico': 88,
            'Los Angeles Times': 92, 'USA Today': 88
        };

        return articles.map(article => {
            let score = 0;
            const sourceName = article.source?.name || '';
            let authorityScore = 50;
            for (const [source, points] of Object.entries(authorityScores)) {
                if (sourceName.includes(source)) {
                    authorityScore = points;
                    break;
                }
            }
            score += authorityScore * 0.4;
            
            const contentLength = (article.content || '').length;
            const descLength = (article.description || '').length;
            let completeness = 0;
            if (contentLength > 500 || descLength > 200) {
                completeness = 90;
            } else if (contentLength > 200 || descLength > 100) {
                completeness = 75;
            } else if (descLength > 50) {
                completeness = 60;
            } else {
                completeness = 40;
            }
            score += completeness * 0.3;
            
            const publishedAt = new Date(article.publishedAt || Date.now());
            const now = new Date();
            const hoursOld = (now - publishedAt) / (1000 * 60 * 60);
            let freshnessScore = 0;
            if (hoursOld < 6) {
                freshnessScore = 95;
            } else if (hoursOld < 12) {
                freshnessScore = 85;
            } else if (hoursOld < 24) {
                freshnessScore = 75;
            } else if (hoursOld < 48) {
                freshnessScore = 60;
            } else {
                freshnessScore = 40;
            }
            score += freshnessScore * 0.2;
            
            const titleLength = (article.title || '').length;
            let titleScore = 0;
            if (titleLength > 30 && titleLength < 100) {
                titleScore = 85;
            } else if (titleLength > 15) {
                titleScore = 70;
            } else {
                titleScore = 50;
            }
            score += titleScore * 0.1;
            
            return { article, score };
        })
        .sort((a, b) => b.score - a.score)
        .map(item => item.article);
    }

    async _selectTopQualityNewsInternal(modelName, articles, targetCount) {
        const batchSize = 10;
        const batches = [];
        for (let i = 0; i < articles.length; i += batchSize) {
            batches.push(articles.slice(i, i + batchSize));
        }

        let allScores = [];
        
        for (let i = 0; i < batches.length; i++) {
            logger.progress('AI', i + 1, batches.length, `评分第${i + 1}批`);
            const batchScores = await this._scoreNewsBatch(modelName, batches[i], i * batchSize);
            allScores = [...allScores, ...batchScores];
            if (i < batches.length - 1) await delay(1000);
        }

        allScores.sort((a, b) => b.score - a.score);
        const selectedIndices = allScores.slice(0, targetCount).map(item => item.index);
        
        logger.debug('AI', `选中新闻索引: ${selectedIndices.slice(0, 10).join(', ')}${selectedIndices.length > 10 ? '...' : ''}`);
        
        return selectedIndices.map(index => articles[index]).filter(Boolean);
    }

    async _scoreNewsBatch(modelName, batch, baseIndex) {
        const newsContent = batch.map((article, index) => {
            const actualIndex = baseIndex + index;
            const title = (article.translatedTitle || article.title || '').replace(/\s*[-|—]\s*[A-Za-z0-9 .,&()]+$/g, '').trim();
            const description = article.description || article.translatedDescription || '无';
            const source = article.source?.name || '未知';
            const contentLength = (article.content || '').length;
            
            return `${actualIndex + 1}. 标题: ${title}\n来源: ${source}\n描述: ${description.substring(0, 80)}${description.length > 80 ? '...' : ''}\n字数: ${contentLength}`;
        }).join('\n\n');

        const prompt = `作为专业编辑，请评估以下资讯的质量（0-100分）。

评分维度：
1. 信息源可信度（30%）：主流媒体90-100分，知名媒体70-89分，一般媒体50-69分
2. 内容完整度（30%）：丰富>500字90-100分，充分200-500字70-89分，简短<200字50-69分
3. 资讯价值（20%）：重要话题90-100分，一般话题70-89分，普通话题50-69分
4. 呈现质量（20%）：表述清晰90-100分，表述合理70-89分，表述欠佳50-69分

待评估资讯：
${newsContent}

请给出评分，JSON格式：
{
  "scores": [
    {"index": 1, "score": 85},
    {"index": 2, "score": 72}
  ]
}

仅返回JSON，无需解释或思考过程。`;

        const responseText = await this._callAI([{ role: 'user', content: prompt }], modelName);
        
        try {
            const cleanText = responseText.match(/\{[\s\S]*\}/)[0];
            const result = JSON.parse(cleanText);
            
            if (result.scores && Array.isArray(result.scores)) {
                return result.scores.map(item => ({
                    index: baseIndex + item.index - 1,
                    score: item.score
                }));
            }
            
            throw new Error('AI返回格式错误');
            
        } catch (e) {
            logger.warn('AI', 'AI评分响应解析失败，本批次使用默认评分', e.message);
            return batch.map((_, index) => ({
                index: baseIndex + index,
                score: 50
            }));
        }
    }

    async enhanceNewsArticle(article, index = 0, total = 1, skipSummary = false) {
        const enhancedArticle = { ...article };
        
        if (article.title && !this.isChineseText(article.title)) {
            enhancedArticle.translatedTitle = await this.translateTitle(article.title);
        }
        
        if (article.description && !this.isChineseText(article.description)) {
            enhancedArticle.translatedDescription = await this.translateText(article.description);
        }

        const summaryContent = enhancedArticle.translatedDescription || enhancedArticle.description || enhancedArticle.translatedTitle || enhancedArticle.title;
        if (summaryContent && !skipSummary) {
            enhancedArticle.summary = await this.generateNewsSummary(
                enhancedArticle.translatedTitle || enhancedArticle.title,
                enhancedArticle.translatedDescription || enhancedArticle.description,
                enhancedArticle.content
            );
        }

        if (!enhancedArticle.region) {
            enhancedArticle.region = await this.determineNewsRegion(
                enhancedArticle.translatedTitle || enhancedArticle.title,
                enhancedArticle.translatedDescription || enhancedArticle.description,
                enhancedArticle.source?.name || ''
            );
        }

        enhancedArticle.processedAt = new Date().toISOString();
        return enhancedArticle;
    }

    async enhanceNewsArticles(articles) {
        if (!this.modelConfig.apiKey || !articles || articles.length === 0) {
            return articles;
        }
        logger.info('AI', `开始处理新闻（翻译+摘要），共 ${articles.length} 条`);
        
        if (this.rateLimiter.getStats) {
            const stats = this.rateLimiter.getStats();
            logger.debug('AI', '速率限制器状态', stats);
        }

        // 1. 批量识别新闻地区
        const regionMap = await this.batchDetermineNewsRegions(articles);
        
        const enhancedArticles = [];
        const batchSize = 5; // 批量大小
        
        // 2. 分批处理
        for (let i = 0; i < articles.length; i += batchSize) {
            const batch = articles.slice(i, i + batchSize);
            const batchIndices = batch.map((_, idx) => i + idx);
            
            // 2.1 并行翻译（跳过单条摘要生成）
            const translatedBatch = await Promise.all(batch.map(async (article, idx) => {
                const globalIndex = i + idx;
                logger.progress('AI', globalIndex + 1, articles.length, '翻译进度');
                
                try {
                    // skipSummary = true
                    const enhanced = await this.enhanceNewsArticle(article, globalIndex, articles.length, true);
                    
                    // 注入地区
                    if (regionMap.has(globalIndex)) {
                        enhanced.region = regionMap.get(globalIndex);
                    }
                    
                    return enhanced;
                } catch (error) {
                    logger.error('AI', `翻译第 ${globalIndex + 1} 条新闻失败`, error.message);
                    return article;
                }
            }));
            
            // 2.2 批量生成摘要
            const summaryMap = await this.batchGenerateSummaries(translatedBatch);
            
            // 2.3 整合摘要
            translatedBatch.forEach((article, idx) => {
                const globalIndex = i + idx;
                if (summaryMap.has(globalIndex)) {
                    article.summary = summaryMap.get(globalIndex);
                } else {
                    // 降级：如果没有生成摘要，使用描述或标题
                    article.summary = article.translatedDescription || article.description || article.translatedTitle || article.title;
                }
            });
            
            enhancedArticles.push(...translatedBatch);
            
            // 简单的速率控制
            if (i + batchSize < articles.length) {
                await delay(1000);
            }
        }
        
        if (this.rateLimiter.getStats) {
            const finalStats = this.rateLimiter.getStats();
            logger.debug('AI', '处理完成统计', finalStats);
        }
        
        logger.success('AI', `处理完成: ${enhancedArticles.length}/${articles.length}`);
        return enhancedArticles;
    }

    async generateNewsSummaryArticle(newsData) {
        if (!this.modelConfig.apiKey) {
            const error = new Error('AI服务未初始化，无法生成摘要文章');
            logger.error('AI', '生成摘要文章失败', error);
            throw error;
        }
        if (!newsData || newsData.length === 0) {
            const error = new Error('没有新闻数据可用于生成摘要');
            logger.error('AI', '生成摘要文章失败', error);
            throw error;
        }

        logger.info('AI', '开始生成新闻摘要文章');

        try {
            const result = await this.retryWithFallback(this._generateNewsSummaryArticleInternal, [newsData]);

            logger.success('AI', '✅ 新闻摘要文章生成完成');
            return result;
        } catch (error) {
            logger.error('AI', '生成新闻摘要文章失败', error);
            throw error;
        }
    }

    async _generateNewsSummaryArticleInternal(modelName, newsData) {
        const newsContent = newsData.map((news, index) => {
            const title = news.translatedTitle || news.title;
            const summary = news.summary || news.translatedDescription || news.description;
            return `${index + 1}. 【${news.region || '国际'}】${title}\n摘要：${summary}\n标识符：NEWS_${index + 1}\n`;
        }).join('\n');

        const currentDate = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
        const prompt = `请基于以下新闻，生成一篇客观的新闻摘要文章。要求：
1. 标题为“${currentDate} 全球新闻摘要”。
2. 按地区分类，客观描述每条新闻要点。
3. 每条新闻摘要句末必须添加对应的标识符（如[NEWS_1]）。
4. 全文800-1200字。

新闻内容：
${newsContent}

请严格按照要求生成文章，确保包含所有标识符，不要包含思考过程。`;

        let articleContent = await this._callAI([{ role: 'user', content: prompt }], modelName);
        
        articleContent = this.cleanSummaryContent(articleContent);
        const summaryArticle = this.createSummaryArticleObject(articleContent, newsData, currentDate);

        logger.info('AI', 'Generated summary article.');
        return summaryArticle;
    }

    async generatePodcastScript(newsData) {
        if (!this.modelConfig.apiKey) {
            const error = new Error('AI服务未初始化，无法生成播客脚本');
            logger.error('AI', '生成播客脚本失败', error);
            throw error;
        }

        logger.info('AI', '正在生成音频对话脚本');

        try {
            const result = await this.retryWithFallback(this._generatePodcastScriptInternal, [newsData]);
            logger.success('AI', '✅ 播客脚本生成完成');
            return result;
        } catch (error) {
            logger.error('AI', '生成音频脚本失败', error);
            throw error;
        }
    }

    async _generatePodcastScriptInternal(modelName, newsData) {
        const stripSourceSuffix = (t) => (t || '').replace(/\s*[\-|—]\s*[A-Za-z0-9 .,&()]+$/g, '').trim();
        const newsSummaries = newsData.map((news, index) => 
            `${index + 1}. ${stripSourceSuffix(news.translatedTitle || news.title)}\n摘要：${news.summary || '无'}`
        ).join('\n\n');

        const dateStr = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Shanghai' });
        const beijingHour = new Date(new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })).getHours();
        const greeting = beijingHour < 12 ? '上午好' : (beijingHour < 18 ? '下午好' : '晚上好');

        const prompt = `请为两位播音员（A和B）生成一份专业新闻播报脚本。
严格输出要求（务必遵守）：
- 每一行必须以说话人标记开头，仅允许使用“[A] ”或“[B] ”，后跟一句播报内容
- 禁止使用序号、项目符号或任何额外结构（如 1. 、- 、• 等）
- A播报奇数条，B播报偶数条；每条40-70字，语言正式，直入主题
- 开场白与结束语各一行，其余每条新闻各占一行
- 禁止包含任何<think>标签或思考过程内容，直接输出脚本正文

开场白示例：
[A] ${greeting}，今天是${dateStr}，为您播报${newsData.length}条热点新闻。

结束语示例：
[B] 以上就是今天的新闻播报，感谢收听！

需覆盖的新闻要点（供参考，不要原样复制）：
${newsSummaries}

请仅输出完整脚本文本，逐行罗列，不要包含任何解释或思考过程，如：
[A] 开场白...
[A] 新闻1内容...
[B] 新闻2内容...
...
[B] 结束语...`;

        let script = await this._callAI([{ role: 'user', content: prompt }], modelName);
        
        // 额外的清理层：确保脚本只包含有效的对话行
        script = script.split('\n')
            .filter(line => line.trim().match(/^\[[AB]\]/))
            .join('\n');
            
        logger.info('AI', 'Generated podcast script.');
        return script;
    }

    isChineseText(text) {
        if (!text) return false;
        return /[一-鿿]/.test(text);
    }

    cleanSummaryContent(content) {
        return content.replace(/#{1,6}\s*/g, '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
    }

    createSummaryArticleObject(articleContent, newsData, currentDate) {
        const contentWithLinks = this.replaceNewsIdentifiersWithLinks(articleContent, newsData);
        return {
            title: this.extractTitleFromContent(articleContent) || `${currentDate} 全球新闻摘要`,
            content: contentWithLinks,
            htmlContent: this.convertToHtml(contentWithLinks),
            newsCount: newsData.length,
            regions: [...new Set(newsData.map(n => n.region || '全球'))],
            generatedAt: new Date().toISOString(),
            summary: this.generateArticleSummary(articleContent),
            wordCount: articleContent.length,
        };
    }

    replaceNewsIdentifiersWithLinks(content, newsData) {
        return content.replace(/\\\[NEWS_(\d+)\\\]/g, (match, p1) => {
            const index = parseInt(p1, 10) - 1;
            if (newsData[index] && newsData[index].url) {
                return ` <a href="${newsData[index].url}" target="_blank" class="news-link">[原文]</a>`;
            }
            return '';
        });
    }

    extractTitleFromContent(content) {
        const firstLine = content.split('\n')[0].trim();
        return (firstLine.length < 50 && !firstLine.endsWith('。')) ? firstLine : null;
    }

    generateArticleSummary(content) {
        return truncateText(content.split(/[。！？]/)[0] + '。', 100);
    }

    convertToHtml(text) {
        return text.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('\n');
    }
}

module.exports = AIService;
