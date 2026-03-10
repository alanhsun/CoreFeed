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
 * 重试执行函数
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
                // 构建详细的错误信息
                let errorMessage = error.message;
                if (error.response) {
                    // 如果是axios错误，包含状态码和URL信息
                    const status = error.response.status;
                    const url = error.config?.url || 'unknown URL';
                    errorMessage = `Request failed with status code ${status} - ${url}`;
                }
                
                const contextMsg = context ? `[${context}] ` : '';
                logger.warn('RETRY', `${contextMsg}重试 ${i + 1}/${maxRetries}`, errorMessage);
                await delay(delayMs * Math.pow(2, i)); // 指数退避
            }
        }
    }
    
    throw lastError;
}

/**
 * 批处理数组
 * @param {Array} array - 要处理的数组
 * @param {number} batchSize - 批次大小
 * @param {Function} processor - 处理函数
 * @returns {Promise<Array>} 处理结果数组
 */
async function processBatch(array, batchSize, processor) {
    const results = [];
    
    for (let i = 0; i < array.length; i += batchSize) {
        const batch = array.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    
    return results;
}

/**
 * 格式化时间
 * @param {Date|string} date - 日期对象或字符串
 * @param {string} locale - 地区设置
 * @returns {string} 格式化后的时间字符串
 */
function formatTime(date, locale = 'zh-CN') {
    const dateObj = date instanceof Date ? date : new Date(date);
    return dateObj.toLocaleString(locale, { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * 生成唯一ID
 * @param {number} length - ID长度
 * @returns {string} 唯一ID
 */
function generateId(length = 8) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return result;
}

/**
 * 清理HTML标签
 * @param {string} html - HTML字符串
 * @returns {string} 清理后的文本
 */
function stripHtml(html) {
    if (!html) return '';
    
    return html
        .replace(/<[^>]*>/g, '') // 移除HTML标签
        .replace(/&nbsp;/g, ' ') // 替换非断行空格
        .replace(/&amp;/g, '&') // 替换HTML实体
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ') // 合并多个空格
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
 * 获取文件扩展名
 * @param {string} filename - 文件名
 * @returns {string} 扩展名
 */
function getFileExtension(filename) {
    return path.extname(filename).toLowerCase().slice(1);
}

/**
 * 生成安全的文件名
 * @param {string} filename - 原始文件名
 * @returns {string} 安全的文件名
 */
function sanitizeFilename(filename) {
    return filename
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_') // 只保留字母、数字、中文、点、下划线、连字符
        .replace(/_{2,}/g, '_') // 合并多个下划线
        .replace(/^_+|_+$/g, ''); // 移除开头和结尾的下划线
}

/**
 * 计算文件大小的人类可读格式
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * 深度克隆对象
 * @param {*} obj - 要克隆的对象
 * @returns {*} 克隆后的对象
 */
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    
    if (obj instanceof Date) {
        return new Date(obj.getTime());
    }
    
    if (obj instanceof Array) {
        return obj.map(item => deepClone(item));
    }
    
    if (typeof obj === 'object') {
        const cloned = {};
        for (const key in obj) {
            if (obj.hasOwnProperty(key)) {
                cloned[key] = deepClone(obj[key]);
            }
        }
        return cloned;
    }
    
    return obj;
}

/**
 * 错误处理包装器
 * @param {Function} fn - 要包装的函数
 * @param {string} context - 错误上下文
 * @returns {Function} 包装后的函数
 */
function withErrorHandling(fn, context = '') {
    return async (...args) => {
        try {
            return await fn(...args);
        } catch (error) {
            const contextMsg = context ? `[${context}] ` : '';
            logger.error('HELPER', `${contextMsg}错误`, error.message);
            throw error;
        }
    };
}

/**
 * 简单的内存缓存实现
 */
class SimpleCache {
    constructor(maxSize = 100, ttl = 3600000) { // 默认1小时TTL
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = ttl;
    }
    
    set(key, value, customTtl = null) {
        const expiry = Date.now() + (customTtl || this.ttl);
        
        // 如果缓存已满，删除最旧的条目
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
    
    // 清理过期条目
    cleanup() {
        const now = Date.now();
        for (const [key, item] of this.cache.entries()) {
            if (now > item.expiry) {
                this.cache.delete(key);
            }
        }
    }
}

module.exports = {
    ensureDirectoryExists,
    readJsonFile,
    writeJsonFile,
    delay,
    retryAsync,
    processBatch,
    formatTime,
    generateId,
    stripHtml,
    truncateText,
    isValidUrl,
    getFileExtension,
    sanitizeFilename,
    formatFileSize,
    deepClone,
    withErrorHandling,
    SimpleCache
};