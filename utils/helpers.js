/**
 * 聚核 CoreFeed v2.0 — 通用文件读写、文本处理与内存缓存工具 (utils/helpers.js)
 */
const fs = require('fs').promises;
const path = require('path');
const logger = require('./logger');

/**
 * 确保目录存在
 * @param {string} dirPath - 目录路径
 */
async function ensureDirectoryExists(dirPath) {
    try {
        await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
        if (error.code !== 'EEXIST') {
            throw error;
        }
    }
}

/**
 * 安全地读取JSON文件
 * @param {string} filePath - 文件路径
 * @param {*} defaultValue - 默认值
 * @returns {Promise<*>} 解析后的JSON数据
 */
async function readJsonFile(filePath, defaultValue = null) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return defaultValue;
        }
        throw error;
    }
}

/**
 * 安全地写入JSON文件
 * @param {string} filePath - 文件路径
 * @param {*} data - 要写入的数据
 * @param {boolean} createDir - 是否创建目录
 */
async function writeJsonFile(filePath, data, createDir = true) {
    if (createDir) {
        await ensureDirectoryExists(path.dirname(filePath));
    }

    const jsonString = JSON.stringify(data, null, 2);
    await fs.writeFile(filePath, jsonString, 'utf8');
}

/**
 * 延迟执行
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 重试执行函数（指数退避）
 * @param {Function} fn - 要执行的函数
 * @param {number} maxRetries - 最大重试次数
 * @param {number} delayMs - 重试间隔
 * @param {string} context - 上下文信息（可选）
 * @returns {Promise<*>} 函数执行结果
 */
async function retryAsync(fn, maxRetries = 3, delayMs = 1000, context = '') {
    let lastError;

    for (let i = 0; i <= maxRetries; i++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;

            if (i < maxRetries) {
                let errorMessage = error.message;
                if (error.response) {
                    const status = error.response.status;
                    const url = error.config?.url || 'unknown URL';
                    errorMessage = `Request failed with status code ${status} - ${url}`;
                }

                const contextMsg = context ? `[${context}] ` : '';
                logger.warn('RETRY', `${contextMsg}重试 ${i + 1}/${maxRetries}`, errorMessage);
                await delay(delayMs * Math.pow(2, i));
            }
        }
    }

    throw lastError;
}

/**
 * 清理HTML标签与常见实体
 * @param {string} html - HTML字符串
 * @returns {string} 清理后的文本
 */
function stripHtml(html) {
    if (!html) return '';

    return html
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 截断文本
 * @param {string} text - 原始文本
 * @param {number} maxLength - 最大长度
 * @param {string} suffix - 后缀
 * @returns {string} 截断后的文本
 */
function truncateText(text, maxLength = 100, suffix = '...') {
    if (!text || text.length <= maxLength) {
        return text || '';
    }

    return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * 验证URL格式
 * @param {string} url - URL字符串
 * @returns {boolean} 是否为有效URL
 */
function isValidUrl(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

/**
 * 轻量级带 TTL 的内存 LRU 缓存
 */
class SimpleCache {
    constructor(maxSize = 100, ttl = 3600000) {
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = ttl;
    }

    set(key, value, customTtl = null) {
        const expiry = Date.now() + (customTtl || this.ttl);

        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, { value, expiry });
    }

    get(key) {
        const item = this.cache.get(key);

        if (!item) {
            return null;
        }

        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    has(key) {
        return this.get(key) !== null;
    }

    delete(key) {
        return this.cache.delete(key);
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

module.exports = {
    ensureDirectoryExists,
    readJsonFile,
    writeJsonFile,
    delay,
    retryAsync,
    stripHtml,
    truncateText,
    isValidUrl,
    SimpleCache
};