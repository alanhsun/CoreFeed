/**
 * 聚核 CoreFeed v2.0 — 发布鉴权、常量时间密钥校验与同源防 CSRF 中间件 (middleware/auth.js)
 */
const crypto = require('crypto');
const config = require('../config');

/**
 * 读取当前生效的 PUBLISH_SECRET（忽略空字符串占位符，防止 docker-compose 的 `PUBLISH_SECRET=` 覆盖有效配置）
 */
function getExpectedPublishSecret() {
    const candidates = [
        process.env.PUBLISH_SECRET,
        process.env.PUBLISH_API_KEY,
        config.agent?.publishSecret
    ];
    for (const raw of candidates) {
        const val = String(raw || '').trim();
        if (val) return val;
    }
    return '';
}

/**
 * 常量时间字符串比对（通过固定长度 SHA-256 摘要规避长度侧信道与 Buffer 长度异常）
 */
function timingSafeEqualStr(a, b) {
    const hashA = crypto.createHash('sha256').update(String(a)).digest();
    const hashB = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(hashA, hashB);
}

/**
 * 校验外部发布/同步请求是否携带有效的 PUBLISH_SECRET
 */
function verifyPublishSecret(req) {
    const expectedSecret = getExpectedPublishSecret();
    if (!expectedSecret) {
        return { authorized: true, configured: false };
    }

    const authHeader = String(req.get('Authorization') || req.headers?.authorization || '').trim();
    const bearerToken = /^Bearer\s+/i.test(authHeader)
        ? authHeader.replace(/^Bearer\s+/i, '').trim()
        : '';
    const publishSecretHeader = String(req.get('x-publish-secret') || req.headers?.['x-publish-secret'] || '').trim();
    const apiKeyHeader = String(req.get('x-api-key') || req.headers?.['x-api-key'] || '').trim();
    const bodySecret = String(req.body?.secret || '').trim();
    const providedToken = bearerToken || publishSecretHeader || apiKeyHeader || bodySecret;

    if (!providedToken || !timingSafeEqualStr(providedToken, expectedSecret)) {
        return { authorized: false, configured: true };
    }
    return { authorized: true, configured: true };
}

/**
 * 解析显式允许的跨源白名单 (CORS_ORIGINS，逗号分隔)
 */
function getAllowedCorsOrigins() {
    const raw = String(process.env.CORS_ORIGINS || '').trim();
    if (!raw) return [];
    return raw
        .split(',')
        .map(item => item.trim().replace(/\/+$/, '').toLowerCase())
        .filter(Boolean);
}

/**
 * 判断给定的 Origin 是否属于当前请求同源或显式 CORS_ORIGINS 白名单
 */
function isOriginAllowed(origin, reqHost) {
    if (!origin || typeof origin !== 'string') return false;
    const trimmed = origin.trim();
    if (!trimmed || trimmed.toLowerCase() === 'null') return false;

    const normalizedOrigin = trimmed.replace(/\/+$/, '').toLowerCase();
    const allowedList = getAllowedCorsOrigins();
    if (allowedList.includes(normalizedOrigin)) {
        return true;
    }

    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
    }

    const hostHeader = String(reqHost || '').trim().toLowerCase();
    if (!hostHeader) return false;
    return parsed.host.toLowerCase() === hostHeader;
}

/**
 * 校验浏览器请求是否为同源（用于防御局域网跨站 CSRF，不阻断同源 Web UI 与无 Origin 的本地脚本调用）
 */
function checkSameOrigin(req) {
    const reqHost = req.get ? req.get('host') : req.headers?.host;
    const origin = String((req.get ? req.get('origin') : req.headers?.origin) || '').trim();
    const referer = String((req.get ? req.get('referer') : req.headers?.referer) || '').trim();
    const secFetchSite = String((req.get ? req.get('sec-fetch-site') : req.headers?.['sec-fetch-site']) || '')
        .trim()
        .toLowerCase();

    if (secFetchSite === 'cross-site') {
        if (!origin || !getAllowedCorsOrigins().includes(origin.replace(/\/+$/, '').toLowerCase())) {
            return { ok: false, reason: 'cross-site Sec-Fetch-Site' };
        }
    }

    if (origin) {
        if (!isOriginAllowed(origin, reqHost)) {
            return { ok: false, reason: 'cross-origin Origin header' };
        }
        return { ok: true };
    }

    if (referer) {
        try {
            const refOrigin = new URL(referer).origin;
            if (!isOriginAllowed(refOrigin, reqHost)) {
                return { ok: false, reason: 'cross-origin Referer header' };
            }
        } catch {
            return { ok: false, reason: 'invalid Referer header' };
        }
    }

    return { ok: true };
}

/**
 * 同源防 CSRF 中间件（针对 Web UI 触发的状态变更接口）
 */
function sameOriginOnly(req, res, next) {
    const check = checkSameOrigin(req);
    if (!check.ok) {
        return res.status(403).json({
            success: false,
            message: '跨站请求被拒绝 (Cross-Origin CSRF Blocked)'
        });
    }
    return next();
}

/**
 * 强制校验 PUBLISH_SECRET 的中间件（用于 /api/agent/publish* 等外部写入接口）
 */
function requirePublishSecret(req, res, next) {
    const auth = verifyPublishSecret(req);
    if (!auth.authorized) {
        return res.status(401).json({
            success: false,
            message: '未授权的发布请求 (Invalid PUBLISH_SECRET)'
        });
    }
    return next();
}

module.exports = {
    getExpectedPublishSecret,
    timingSafeEqualStr,
    verifyPublishSecret,
    getAllowedCorsOrigins,
    isOriginAllowed,
    checkSameOrigin,
    sameOriginOnly,
    requirePublishSecret
};
