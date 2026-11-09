/**
 * 聚核 CoreFeed v2.0 — 全局 HTTP/HTTPS 连接池与请求拦截配置 (utils/network_config.js)
 */
const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

class NetworkConfig {
    /**
     * 初始化全局 Axios 连接池与慢请求监控拦截器
     */
    static initialize() {
        axios.defaults.timeout = config.network.timeout;

        if (config.network.keepAlive) {
            const http = require('http');
            const https = require('https');

            const httpAgent = new http.Agent({
                keepAlive: true,
                maxSockets: config.network.maxSockets,
                timeout: config.network.timeout
            });

            const httpsAgent = new https.Agent({
                keepAlive: true,
                maxSockets: config.network.maxSockets,
                timeout: config.network.timeout
            });

            axios.defaults.httpAgent = httpAgent;
            axios.defaults.httpsAgent = httpsAgent;
        }

        axios.interceptors.request.use(
            (reqConfig) => {
                reqConfig.metadata = { startTime: new Date() };
                return reqConfig;
            },
            (error) => Promise.reject(error)
        );

        axios.interceptors.response.use(
            (response) => {
                const startTime = response.config?.metadata?.startTime;
                if (startTime) {
                    const duration = Date.now() - startTime.getTime();
                    if (duration > 10000) {
                        logger.warn('NETWORK', `慢请求: ${response.config.url}`, { duration: `${duration}ms` });
                    }
                }
                return response;
            },
            (error) => {
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
}

module.exports = NetworkConfig;