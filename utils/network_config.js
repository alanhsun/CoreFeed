const axios = require('axios');
const config = require('../config');
const logger = require('./logger');
const { delay } = require('./helpers');

/**
 * 网络配置工具
 * 用于优化网络请求的稳定性和性能
 */
class NetworkConfig {
    /**
     * 初始化网络配置
     */
    static initialize() {
        // 配置axios默认设置
        axios.defaults.timeout = config.network.timeout;
        
        // 配置HTTP代理（如果需要）
        if (config.network.keepAlive) {
            const http = require('http');
            const https = require('https');
            
            // 创建HTTP代理
            const httpAgent = new http.Agent({
                keepAlive: true,
                maxSockets: config.network.maxSockets,
                timeout: config.network.timeout
            });
            
            // 创建HTTPS代理
            const httpsAgent = new https.Agent({
                keepAlive: true,
                maxSockets: config.network.maxSockets,
                timeout: config.network.timeout
            });
            
            // 设置默认代理
            axios.defaults.httpAgent = httpAgent;
            axios.defaults.httpsAgent = httpsAgent;
        }
        
        // 添加请求拦截器
        axios.interceptors.request.use(
            (config) => {
                // 添加请求时间戳
                config.metadata = { startTime: new Date() };
                return config;
            },
            (error) => {
                return Promise.reject(error);
            }
        );
        
        // 添加响应拦截器
        axios.interceptors.response.use(
            (response) => {
                // 计算请求耗时
                const endTime = new Date();
                const duration = endTime - response.config.metadata.startTime;
                
                if (duration > 10000) { // 超过10秒的请求记录警告
                    logger.warn('NETWORK', `慢请求: ${response.config.url}`, { duration: `${duration}ms` });
                }
                
                return response;
            },
            (error) => {
                // 记录网络错误
                if (error.code === 'ECONNABORTED') {
            logger.error('NETWORK', '请求超时', error.config?.url);
        } else if (error.code === 'ENOTFOUND') {
            logger.error('NETWORK', 'DNS解析失败', error.config?.url);
        } else if (error.code === 'ECONNRESET') {
            logger.error('NETWORK', '连接被重置', error.config?.url);
        } else {
            logger.error('NETWORK', '网络请求失败', error.message);
        }
                
                return Promise.reject(error);
            }
        );
        
        logger.success('NETWORK', '网络配置初始化完成', {
        timeout: `${config.network.timeout}ms`,
        retries: config.network.retries,
        retryDelay: `${config.network.retryDelay}ms`,
        keepAlive: config.network.keepAlive,
        maxSockets: config.network.maxSockets
    });
    }
    
    /**
     * 创建带有重试机制的axios实例
     * @param {Object} options - 配置选项
     * @returns {Object} axios实例
     */
    static createRetryInstance(options = {}) {
        const instance = axios.create({
            timeout: options.timeout || config.network.timeout,
            ...options
        });
        
        // 添加重试拦截器
        instance.interceptors.response.use(
            (response) => response,
            async (error) => {
                const { config: requestConfig } = error;
                
                // 如果没有重试配置，直接抛出错误
                if (!requestConfig || !requestConfig.retry) {
                    return Promise.reject(error);
                }
                
                // 检查是否应该重试
                if (this.shouldRetry(error) && requestConfig.retryCount < requestConfig.retry) {
                    requestConfig.retryCount = requestConfig.retryCount || 0;
                    requestConfig.retryCount++;
                    
                    logger.warn('NETWORK', `重试请求 ${requestConfig.retryCount}/${requestConfig.retry}`, requestConfig.url);
                    
                    // 等待重试延迟
                    await delay(requestConfig.retryDelay || config.network.retryDelay);
                    
                    // 重新发送请求
                    return instance(requestConfig);
                }
                
                return Promise.reject(error);
            }
        );
        
        return instance;
    }
    
    /**
     * 判断是否应该重试
     * @param {Error} error - 错误对象
     * @returns {boolean} 是否应该重试
     */
    static shouldRetry(error) {
        // 网络错误或超时错误应该重试
        if (error.code === 'ECONNABORTED' || 
            error.code === 'ENOTFOUND' || 
            error.code === 'ECONNRESET' ||
            error.code === 'ETIMEDOUT') {
            return true;
        }
        
        // 5xx服务器错误应该重试
        if (error.response && error.response.status >= 500) {
            return true;
        }
        
        // 429 Too Many Requests 应该重试
        if (error.response && error.response.status === 429) {
            return true;
        }
        
        return false;
    }
    
    /**
     * 获取网络状态信息
     * @returns {Object} 网络状态
     */
    static getNetworkStatus() {
        return {
            timeout: config.network.timeout,
            retries: config.network.retries,
            retryDelay: config.network.retryDelay,
            keepAlive: config.network.keepAlive,
            maxSockets: config.network.maxSockets,
            timestamp: new Date().toISOString()
        };
    }
}

module.exports = NetworkConfig;