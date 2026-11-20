/**
 * 聚核 CoreFeed v2.0 — 通用文件读写、文本处理与内存缓存工具 (utils/helpers.js)
 */
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

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
 * 安全地读取JSON文件（缺失或损坏时降级为默认值，避免服务端崩溃）
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
        if (error instanceof SyntaxError) {
            console.warn(`[helpers] JSON 文件损坏，已降级为默认值 (${filePath}): ${error.message}`);
            return defaultValue;
        }
        throw error;
    }
}

/**
 * 原子地写入JSON文件（先写入同目录临时文件并 fsync，再 rename 替换目标，避免断电/崩溃写坏文件）
 * @param {string} filePath - 文件路径
 * @param {*} data - 要写入的数据
 * @param {boolean} createDir - 是否创建目录
 */
async function writeJsonFile(filePath, data, createDir = true) {
    if (createDir) {
        await ensureDirectoryExists(path.dirname(filePath));
    }

    const jsonString = JSON.stringify(data, null, 2);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    let handle = null;
    try {
        handle = await fs.open(tmpPath, 'w', 0o644);
        await handle.writeFile(jsonString, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(tmpPath, filePath);
    } catch (err) {
        if (handle) {
            try { await handle.close(); } catch (_) {}
        }
        try { await fs.unlink(tmpPath); } catch (_) {}
        throw err;
    }
}

/**
 * 将任意值安全序列化为可内联至 HTML <script> 标签的 JSON 文本（防 </script> 注入与行分隔符破坏）
 * @param {*} value
 * @returns {string}
 */
function serializeForScript(value) {
    const json = JSON.stringify(value === undefined ? null : value);
    return (json === undefined ? 'null' : json)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

/**
 * 校验 URL 是否为安全的 http/https 地址（拦截 javascript:、data:、vbscript: 等危险协议）
 * @param {string} url
 * @returns {boolean}
 */
function isSafeHttpUrl(url) {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    try {
        const parsed = new URL(trimmed);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * 返回校验通过的 http(s) URL，否则返回 fallback
 * @param {string} url
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeHttpUrl(url, fallback = '') {
    return isSafeHttpUrl(url) ? String(url).trim() : fallback;
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

        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
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

/**
 * 按字节上限与条数双重约束的 TTL + LRU 缓存（适用于图片代理二进制缓存，防止低内存软路由 OOM）
 */
class ByteBoundedCache {
    constructor({ maxBytes = 64 * 1024 * 1024, maxItems = 150, ttl = 2 * 60 * 60 * 1000, sizeOf = null } = {}) {
        this.cache = new Map();
        this.maxBytes = Math.max(1024, Number(maxBytes) || 64 * 1024 * 1024);
        this.maxItems = Math.max(1, Number(maxItems) || 150);
        this.ttl = ttl;
        this.sizeOf = typeof sizeOf === 'function'
            ? sizeOf
            : (v) => (Buffer.isBuffer(v?.buffer) ? v.buffer.length : (Buffer.isBuffer(v) ? v.length : 1024));
        this.currentBytes = 0;
    }

    _evictKey(key) {
        const existing = this.cache.get(key);
        if (!existing) return false;
        this.currentBytes = Math.max(0, this.currentBytes - existing.bytes);
        return this.cache.delete(key);
    }

    _pruneExpired() {
        const now = Date.now();
        for (const [k, entry] of this.cache.entries()) {
            if (now > entry.expiry) {
                this._evictKey(k);
            }
        }
    }

    set(key, value, customTtl = null) {
        const bytes = Math.max(0, Number(this.sizeOf(value)) || 0);
        if (bytes > this.maxBytes) {
            this._evictKey(key);
            return false;
        }

        this._evictKey(key);
        this._pruneExpired();

        while (
            this.cache.size > 0 &&
            (this.cache.size >= this.maxItems || this.currentBytes + bytes > this.maxBytes)
        ) {
            const oldestKey = this.cache.keys().next().value;
            this._evictKey(oldestKey);
        }

        const expiry = Date.now() + (customTtl || this.ttl);
        this.cache.set(key, { value, expiry, bytes });
        this.currentBytes += bytes;
        return true;
    }

    get(key) {
        const entry = this.cache.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiry) {
            this._evictKey(key);
            return null;
        }
        // Refresh LRU recency
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    delete(key) {
        return this._evictKey(key);
    }

    clear() {
        this.cache.clear();
        this.currentBytes = 0;
    }

    size() {
        return this.cache.size;
    }

    bytes() {
        return this.currentBytes;
    }
}

module.exports = {
    ensureDirectoryExists,
    readJsonFile,
    writeJsonFile,
    serializeForScript,
    isSafeHttpUrl,
    sanitizeHttpUrl,
    delay,
    stripHtml,
    truncateText,
    isValidUrl,
    SimpleCache,
    ByteBoundedCache
};