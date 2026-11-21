/**
 * 聚核 CoreFeed v2.0 — 全局 HTTP/HTTPS 连接池与请求拦截配置 (utils/network_config.js)
 */
const http = require('http');
const https = require('https');
const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

const cachedHttpsAgents = new Map();
let insecureTlsWarned = false;

/**
 * 是否允许跳过出站 HTTPS 证书校验（仅在显式配置 ALLOW_INSECURE_TLS=true 时开启，默认严格校验证书）
 */
function isInsecureTlsAllowed() {
    const raw = process.env.ALLOW_INSECURE_TLS !== undefined
        ? process.env.ALLOW_INSECURE_TLS
        : (config.network?.allowInsecureTls ?? false);
    if (typeof raw === 'boolean') return raw;
    const str = String(raw || '').toLowerCase().trim();
    return str === 'true' || str === '1' || str === 'yes';
}

/**
 * 获取统一受 ALLOW_INSECURE_TLS 控制的 https.Agent（默认 rejectUnauthorized: true）
 */
function getHttpsAgent(options = {}) {
    const keepAlive = options.keepAlive !== undefined ? Boolean(options.keepAlive) : true;
    const allowInsecure = options.allowInsecureTls !== undefined
        ? Boolean(options.allowInsecureTls)
        : isInsecureTlsAllowed();

    if (allowInsecure && !insecureTlsWarned) {
        insecureTlsWarned = true;
        logger.warn(
            'NETWORK',
            'ALLOW_INSECURE_TLS=true 已启用，出站 HTTPS 将跳过证书校验（仅建议在本地 MITM 代理或自签证书环境临时开启）'
        );
    }

    const hasCustomSizing = options.maxSockets !== undefined || options.timeout !== undefined;
    if (!hasCustomSizing) {
        const cacheKey = `${allowInsecure ? 'insecure' : 'verified'}:${keepAlive ? 'ka' : 'close'}`;
        if (!cachedHttpsAgents.has(cacheKey)) {
            cachedHttpsAgents.set(cacheKey, new https.Agent({
                keepAlive,
                rejectUnauthorized: !allowInsecure
            }));
        }
        return cachedHttpsAgents.get(cacheKey);
    }

    return new https.Agent({
        keepAlive,
        ...(options.maxSockets !== undefined ? { maxSockets: options.maxSockets } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        rejectUnauthorized: !allowInsecure
    });
}

class NetworkConfig {
    /**
     * 初始化全局 Axios 连接池与慢请求监控拦截器
     */
    static initialize() {
        axios.defaults.timeout = config.network.timeout;

        if (config.network.keepAlive) {
            const httpAgent = new http.Agent({
                keepAlive: true,
                maxSockets: config.network.maxSockets,
                timeout: config.network.timeout
            });

            const httpsAgent = getHttpsAgent({
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
            maxSockets: config.network.maxSockets,
            allowInsecureTls: isInsecureTlsAllowed()
        });
    }
}

NetworkConfig.isInsecureTlsAllowed = isInsecureTlsAllowed;
NetworkConfig.getHttpsAgent = getHttpsAgent;

module.exports = NetworkConfig;