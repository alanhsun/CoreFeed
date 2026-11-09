/**
 * 聚核 CoreFeed v2.0 — 令牌桶 API 速率限制器 (utils/rate_limiter.js)
 * 用于平滑控制大模型 API 请求频率并自动指数退避重试 429 错误
 */
const logger = require('./logger');
const { delay } = require('./helpers');

class RateLimiter {
    /**
     * @param {Object} options - 配置选项
     * @param {number} options.tokensPerMinute - 每分钟可用的令牌数（请求数）
     * @param {number} options.maxBurst - 最大突发请求数
     * @param {number} options.minInterval - 最小请求间隔（毫秒）
     */
    constructor(options = {}) {
        this.tokensPerMinute = options.tokensPerMinute || 15;
        this.maxBurst = options.maxBurst || Math.min(5, this.tokensPerMinute);
        this.minInterval = options.minInterval || Math.ceil(60000 / this.tokensPerMinute);

        this.tokens = this.maxBurst;
        this.lastRefillTime = Date.now();

        this.queue = [];
        this.processing = false;

        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rateLimitErrors: 0,
            lastRequestTime: null,
            averageWaitTime: 0
        };

        logger.info('RATE_LIMITER', '速率限制器初始化', {
            tokensPerMinute: this.tokensPerMinute,
            maxBurst: this.maxBurst,
            minInterval: `${this.minInterval}ms`
        });
    }

    /**
     * 补充令牌（基于时间流逝）
     */
    refillTokens() {
        const now = Date.now();
        const timePassed = now - this.lastRefillTime;
        const tokensToAdd = (timePassed / 60000) * this.tokensPerMinute;

        this.tokens = Math.min(this.maxBurst, this.tokens + tokensToAdd);
        this.lastRefillTime = now;
    }

    /**
     * 执行带速率限制的请求
     */
    async execute(requestFn, options = {}) {
        const { priority = 5, maxRetries = 3 } = options;

        return new Promise((resolve, reject) => {
            this.queue.push({
                requestFn,
                priority,
                maxRetries,
                resolve,
                reject,
                addedAt: Date.now(),
                retryCount: 0
            });

            this.queue.sort((a, b) => a.priority - b.priority);
            this.processQueue();
        });
    }

    /**
     * 处理请求队列
     */
    async processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        while (this.queue.length > 0) {
            this.refillTokens();

            if (this.tokens < 1) {
                const waitTime = this.minInterval;
                logger.debug('RATE_LIMITER', `等待令牌补充: ${waitTime}ms`);
                await delay(waitTime);
                continue;
            }

            const task = this.queue.shift();
            this.tokens -= 1;

            try {
                const startTime = Date.now();
                const waitTime = startTime - task.addedAt;

                this.stats.totalRequests++;
                this.stats.lastRequestTime = new Date().toISOString();
                this.stats.averageWaitTime = (this.stats.averageWaitTime * (this.stats.totalRequests - 1) + waitTime) / this.stats.totalRequests;

                logger.debug('RATE_LIMITER', `执行请求 (等待: ${waitTime}ms, 剩余令牌: ${this.tokens.toFixed(2)})`);

                const result = await task.requestFn();

                this.stats.successfulRequests++;
                task.resolve(result);
            } catch (error) {
                this.stats.failedRequests++;

                const is429Error = this.is429Error(error);

                if (is429Error) {
                    this.stats.rateLimitErrors++;
                    logger.warn('RATE_LIMITER', `遇到429错误 (重试 ${task.retryCount}/${task.maxRetries})`);

                    if (task.retryCount < task.maxRetries) {
                        task.retryCount++;
                        task.addedAt = Date.now();

                        const backoffDelay = Math.min(60000, 1000 * Math.pow(2, task.retryCount));
                        logger.info('RATE_LIMITER', `将在 ${backoffDelay}ms 后重试`);

                        await delay(backoffDelay);
                        this.queue.unshift(task);

                        this.tokens = 0;
                        this.lastRefillTime = Date.now();
                        continue;
                    }
                }

                task.reject(error);
            }

            await delay(this.minInterval);
        }

        this.processing = false;
    }

    /**
     * 检查错误是否为429速率限制错误
     */
    is429Error(error) {
        if (!error) return false;

        const errorMessage = error.message?.toLowerCase() || '';
        const errorStatus = error.status || error.response?.status;

        return errorStatus === 429 ||
               errorMessage.includes('rate limit') ||
               errorMessage.includes('too many requests') ||
               errorMessage.includes('quota') ||
               errorMessage.includes('overloaded');
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            ...this.stats,
            queueLength: this.queue.length,
            availableTokens: this.tokens.toFixed(2),
            successRate: this.stats.totalRequests > 0
                ? ((this.stats.successfulRequests / this.stats.totalRequests) * 100).toFixed(2) + '%'
                : '0%',
            averageWaitTime: `${Math.round(this.stats.averageWaitTime)}ms`
        };
    }
}

module.exports = RateLimiter;
