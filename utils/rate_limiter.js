const logger = require('./logger');
const { delay } = require('./helpers');

/**
 * 令牌桶速率限制器
 * 用于平滑控制API请求频率，避免触发429错误
 */
class RateLimiter {
    /**
     * @param {Object} options - 配置选项
     * @param {number} options.tokensPerMinute - 每分钟可用的令牌数（请求数）
     * @param {number} options.maxBurst - 最大突发请求数
     * @param {number} options.minInterval - 最小请求间隔（毫秒）
     */
    constructor(options = {}) {
        this.tokensPerMinute = options.tokensPerMinute || 15; // 默认每分钟15次（保守值）
        this.maxBurst = options.maxBurst || Math.min(5, this.tokensPerMinute); // 最大突发数
        this.minInterval = options.minInterval || Math.ceil(60000 / this.tokensPerMinute); // 最小间隔
        
        // 令牌桶
        this.tokens = this.maxBurst;
        this.lastRefillTime = Date.now();
        
        // 请求队列
        this.queue = [];
        this.processing = false;
        
        // 统计信息
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
     * @param {Function} requestFn - 要执行的请求函数
     * @param {Object} options - 选项
     * @param {number} options.priority - 优先级（数字越小优先级越高）
     * @param {number} options.maxRetries - 最大重试次数（针对429错误）
     * @returns {Promise<*>} 请求结果
     */
    async execute(requestFn, options = {}) {
        const { priority = 5, maxRetries = 3 } = options;
        
        return new Promise((resolve, reject) => {
            // 将请求加入队列
            this.queue.push({
                requestFn,
                priority,
                maxRetries,
                resolve,
                reject,
                addedAt: Date.now(),
                retryCount: 0
            });
            
            // 按优先级排序队列
            this.queue.sort((a, b) => a.priority - b.priority);
            
            // 开始处理队列
            this.processQueue();
        });
    }
    
    /**
     * 处理请求队列
     */
    async processQueue() {
        // 如果正在处理或队列为空，直接返回
        if (this.processing || this.queue.length === 0) {
            return;
        }
        
        this.processing = true;
        
        while (this.queue.length > 0) {
            // 补充令牌
            this.refillTokens();
            
            // 如果没有可用令牌，等待
            if (this.tokens < 1) {
                const waitTime = this.minInterval;
                logger.debug('RATE_LIMITER', `等待令牌补充: ${waitTime}ms`);
                await delay(waitTime);
                continue;
            }
            
            // 获取队列中的第一个请求
            const task = this.queue.shift();
            
            // 消耗一个令牌
            this.tokens -= 1;
            
            // 执行请求
            try {
                const startTime = Date.now();
                const waitTime = startTime - task.addedAt;
                
                // 更新统计信息
                this.stats.totalRequests++;
                this.stats.lastRequestTime = new Date().toISOString();
                this.stats.averageWaitTime = (this.stats.averageWaitTime * (this.stats.totalRequests - 1) + waitTime) / this.stats.totalRequests;
                
                logger.debug('RATE_LIMITER', `执行请求 (等待: ${waitTime}ms, 剩余令牌: ${this.tokens.toFixed(2)})`);
                
                const result = await task.requestFn();
                
                this.stats.successfulRequests++;
                task.resolve(result);
                
            } catch (error) {
                this.stats.failedRequests++;
                
                // 检查是否为429错误
                const is429Error = this.is429Error(error);
                
                if (is429Error) {
                    this.stats.rateLimitErrors++;
                    logger.warn('RATE_LIMITER', `遇到429错误 (重试 ${task.retryCount}/${task.maxRetries})`);
                    
                    // 如果还有重试次数，重新加入队列
                    if (task.retryCount < task.maxRetries) {
                        task.retryCount++;
                        task.addedAt = Date.now();
                        
                        // 计算指数退避延迟
                        const backoffDelay = Math.min(60000, 1000 * Math.pow(2, task.retryCount));
                        
                        logger.info('RATE_LIMITER', `将在 ${backoffDelay}ms 后重试`);
                        
                        // 延迟后重新加入队列
                        await delay(backoffDelay);
                        this.queue.unshift(task); // 加到队列前面
                        
                        // 重置令牌桶，更保守地限流
                        this.tokens = 0;
                        this.lastRefillTime = Date.now();
                        
                        continue;
                    }
                }
                
                task.reject(error);
            }
            
            // 确保最小请求间隔
            await delay(this.minInterval);
        }
        
        this.processing = false;
    }
    
    /**
     * 检查错误是否为429速率限制错误
     * @param {Error} error - 错误对象
     * @returns {boolean} 是否为429错误
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
     * @returns {Object} 统计信息
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
    
    /**
     * 重置统计信息
     */
    resetStats() {
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            rateLimitErrors: 0,
            lastRequestTime: null,
            averageWaitTime: 0
        };
    }
    
    /**
     * 清空队列
     */
    clearQueue() {
        while (this.queue.length > 0) {
            const task = this.queue.shift();
            task.reject(new Error('Queue cleared'));
        }
    }
    
    /**
     * 调整速率限制参数
     * @param {Object} options - 新的配置选项
     */
    adjustLimits(options = {}) {
        if (options.tokensPerMinute !== undefined) {
            this.tokensPerMinute = options.tokensPerMinute;
            this.minInterval = Math.ceil(60000 / this.tokensPerMinute);
        }
        
        if (options.maxBurst !== undefined) {
            this.maxBurst = options.maxBurst;
            this.tokens = Math.min(this.tokens, this.maxBurst);
        }
        
        logger.info('RATE_LIMITER', '速率限制参数已调整', {
            tokensPerMinute: this.tokensPerMinute,
            maxBurst: this.maxBurst,
            minInterval: `${this.minInterval}ms`
        });
    }
}

module.exports = RateLimiter;
