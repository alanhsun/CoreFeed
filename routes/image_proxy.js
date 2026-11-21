/**
 * 聚核 CoreFeed v2.0 — 外媒新闻题图防盗链与安全代理路由 (routes/image_proxy.js)
 *
 * 安全防护：
 *   1. 查询参数严格类型守卫（防数组污染触发 unhandledRejection）；
 *   2. DNS 解析 + net.BlockList 拦截全部私网/环回/链路本地/CGNAT/IPv6 ULA 及 IPv4-mapped IPv6，
 *      并通过固定解析 IP 的 lookup 回调防御 DNS 重绑定；
 *   3. 禁用自动重定向并逐跳复查目标 URL 与 DNS（最多 3 跳）；
 *   4. 严格光栅图片 Content-Type 白名单 + 文件头魔数校验（拒绝 SVG / HTML / XML，防止同源 XSS）；
 *   5. 响应强制附带 nosniff 与 CSP sandbox 头，缓存按总字节上限 (默认 64 MiB) 约束防软路由 OOM。
 */
const dns = require('dns');
const net = require('net');
const axios = require('axios');
const config = require('../config');
const { isSafeHttpUrl, ByteBoundedCache } = require('../utils/helpers');
const { getHttpsAgent } = require('../utils/network_config');
const asyncHandler = require('../utils/async_handler');

const MAX_REDIRECT_HOPS = 3;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MIN_IMAGE_BYTES = 32;

const ALLOWED_IMAGE_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'image/x-icon',
    'image/vnd.microsoft.icon'
]);

const blockedIpList = new net.BlockList();
// IPv4 private / loopback / link-local / CGNAT / documentation / multicast / reserved
blockedIpList.addSubnet('0.0.0.0', 8, 'ipv4');
blockedIpList.addSubnet('10.0.0.0', 8, 'ipv4');
blockedIpList.addSubnet('100.64.0.0', 10, 'ipv4');
blockedIpList.addSubnet('127.0.0.0', 8, 'ipv4');
blockedIpList.addSubnet('169.254.0.0', 16, 'ipv4');
blockedIpList.addSubnet('172.16.0.0', 12, 'ipv4');
blockedIpList.addSubnet('192.0.0.0', 24, 'ipv4');
blockedIpList.addSubnet('192.0.2.0', 24, 'ipv4');
blockedIpList.addSubnet('192.168.0.0', 16, 'ipv4');
blockedIpList.addSubnet('198.18.0.0', 15, 'ipv4');
blockedIpList.addSubnet('198.51.100.0', 24, 'ipv4');
blockedIpList.addSubnet('203.0.113.0', 24, 'ipv4');
blockedIpList.addSubnet('224.0.0.0', 4, 'ipv4');
blockedIpList.addSubnet('240.0.0.0', 4, 'ipv4');

// IPv6 unspecified / loopback / unique-local / link-local / multicast
blockedIpList.addAddress('::', 'ipv6');
blockedIpList.addAddress('::1', 'ipv6');
blockedIpList.addSubnet('fc00::', 7, 'ipv6');
blockedIpList.addSubnet('fe80::', 10, 'ipv6');
blockedIpList.addSubnet('ff00::', 8, 'ipv6');

/**
 * 提取 IPv4-mapped IPv6 地址中的 IPv4（兼容 ::ffff:127.0.0.1 与 ::ffff:7f00:1）
 */
function extractMappedIpv4(ip) {
    const lower = String(ip || '').toLowerCase();
    const dotted = lower.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
    if (dotted && net.isIPv4(dotted[1])) {
        return dotted[1];
    }
    const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16);
        const lo = parseInt(hexMapped[2], 16);
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        if (net.isIPv4(ipv4)) return ipv4;
    }
    return null;
}

/**
 * 判断 IP 地址是否落入私网/保留网段
 */
function isBlockedIpAddress(rawIp) {
    const ip = String(rawIp || '').trim().replace(/^\[|\]$/g, '');
    const version = net.isIP(ip);
    if (version === 4) {
        return blockedIpList.check(ip, 'ipv4');
    }
    if (version === 6) {
        const mappedV4 = extractMappedIpv4(ip);
        if (mappedV4 && blockedIpList.check(mappedV4, 'ipv4')) {
            return true;
        }
        return blockedIpList.check(ip, 'ipv6');
    }
    return true;
}

/**
 * 判断主机名是否属于明显的内网保留域名
 */
function isBlockedHostname(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!host) return true;
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host.endsWith('.home.arpa')
    ) {
        return true;
    }
    return false;
}

/**
 * 校验目标 URL 合法性并解析 DNS，确认全部解析结果均为公网地址
 */
async function validateProxyTarget(rawUrl, options = {}) {
    const lookupFn = options.dnsLookup || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

    if (typeof rawUrl !== 'string' || !isSafeHttpUrl(rawUrl)) {
        const err = new Error('无效的图片地址');
        err.statusCode = 400;
        throw err;
    }

    const parsed = new URL(rawUrl.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) {
        const err = new Error('不支持的 URL 协议');
        err.statusCode = 400;
        throw err;
    }

    const bareHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (isBlockedHostname(bareHost)) {
        const err = new Error('禁止访问内网或保留主机');
        err.statusCode = 403;
        throw err;
    }

    const literalVersion = net.isIP(bareHost);
    if (literalVersion) {
        if (isBlockedIpAddress(bareHost)) {
            const err = new Error('禁止访问私网或保留 IP');
            err.statusCode = 403;
            throw err;
        }
        return {
            parsed,
            bareHost,
            resolvedAddress: { address: bareHost, family: literalVersion }
        };
    }

    let records;
    try {
        records = await lookupFn(bareHost);
    } catch (_) {
        const err = new Error('目标主机 DNS 解析失败');
        err.statusCode = 502;
        throw err;
    }

    const normalizedRecords = Array.isArray(records) ? records : (records ? [records] : []);
    if (normalizedRecords.length === 0) {
        const err = new Error('目标主机无有效 DNS 记录');
        err.statusCode = 502;
        throw err;
    }

    for (const rec of normalizedRecords) {
        if (!rec || !rec.address || isBlockedIpAddress(rec.address)) {
            const err = new Error('目标域名解析至受限私网或保留 IP');
            err.statusCode = 403;
            throw err;
        }
    }

    return {
        parsed,
        bareHost,
        resolvedAddress: normalizedRecords[0]
    };
}

/**
 * 魔数嗅探：拦截伪装成光栅图片的 SVG / HTML / XML / 脚本响应
 */
function isSafeRasterBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < MIN_IMAGE_BYTES) {
        return false;
    }
    const headAscii = buffer.subarray(0, Math.min(256, buffer.length)).toString('utf8').trimStart().toLowerCase();
    if (
        headAscii.startsWith('<svg') ||
        headAscii.startsWith('<?xml') ||
        headAscii.startsWith('<!doctype') ||
        headAscii.startsWith('<html') ||
        headAscii.startsWith('<script')
    ) {
        return false;
    }

    // JPEG: FF D8 FF
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        buffer.length >= 8 &&
        buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
        buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
    ) {
        return true;
    }
    // GIF: GIF87a / GIF89a
    if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return true;
    // WebP: RIFF....WEBP
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
    ) {
        return true;
    }
    // AVIF / HEIF ISO BMFF box: ....ftyp
    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') return true;
    // ICO / CUR: 00 00 01 00 or 00 00 02 00
    if (buffer[0] === 0x00 && buffer[1] === 0x00 && (buffer[2] === 0x01 || buffer[2] === 0x02) && buffer[3] === 0x00) {
        return true;
    }
    return false;
}

/**
 * 构建加固后的 /api/image-proxy 处理器（支持在测试中注入 dnsLookup / httpGet / cache）
 */
function createImageProxyHandler(options = {}) {
    const imageProxyCache = options.cache || new ByteBoundedCache({
        maxBytes: options.maxCacheBytes || 64 * 1024 * 1024,
        maxItems: options.maxCacheItems || 150,
        ttl: options.cacheTtlMs || 2 * 60 * 60 * 1000
    });
    const httpGet = options.httpGet || ((url, reqCfg) => axios.get(url, reqCfg));
    const dnsLookup = options.dnsLookup;

    const fetchWithValidatedRedirects = async (initialUrl, withReferer = true) => {
        let currentUrl = initialUrl;
        for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
            const { parsed, bareHost, resolvedAddress } = await validateProxyTarget(currentUrl, { dnsLookup });

            const headers = {
                'User-Agent': config.webScraping?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'image/avif,image/webp,image/apng,image/png,image/jpeg,image/gif,*/*;q=0.5',
                'Accept-Language': 'en-US,en;q=0.9'
            };
            if (withReferer) {
                headers.Referer = `${parsed.origin}/`;
            }

            const pinnedLookup = (hostname, opts, cb) => {
                const callback = typeof opts === 'function' ? opts : cb;
                const lookupOpts = typeof opts === 'function' ? {} : (opts || {});
                const normHost = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
                if (normHost === bareHost) {
                    if (lookupOpts.all) {
                        return callback(null, [{ address: resolvedAddress.address, family: resolvedAddress.family }]);
                    }
                    return callback(null, resolvedAddress.address, resolvedAddress.family);
                }
                return dns.lookup(hostname, lookupOpts, callback);
            };

            const upstream = await httpGet(currentUrl, {
                responseType: 'arraybuffer',
                timeout: 8000,
                maxRedirects: 0,
                maxContentLength: MAX_IMAGE_BYTES,
                maxBodyLength: MAX_IMAGE_BYTES,
                httpsAgent: getHttpsAgent({ keepAlive: true }),
                lookup: pinnedLookup,
                headers,
                validateStatus: (status) => status >= 200 && status < 400
            });

            if (upstream.status >= 300 && upstream.status < 400) {
                const location = upstream.headers?.location || upstream.headers?.Location;
                if (!location || hop >= MAX_REDIRECT_HOPS) {
                    const redirErr = new Error('重定向次数超限或缺少 Location');
                    redirErr.statusCode = 502;
                    throw redirErr;
                }
                currentUrl = new URL(String(location), currentUrl).toString();
                continue;
            }

            return upstream;
        }

        const err = new Error('重定向次数超限');
        err.statusCode = 502;
        throw err;
    };

    const handler = asyncHandler(async (req, res) => {
        if (typeof req.query?.url !== 'string') {
            return res.status(400).end();
        }
        const rawUrl = req.query.url.trim();
        if (!rawUrl || rawUrl.length > 2048 || !isSafeHttpUrl(rawUrl)) {
            return res.status(400).end();
        }

        // 即使命中缓存前也先做静态主机校验，防止缓存键绕过
        try {
            await validateProxyTarget(rawUrl, { dnsLookup });
        } catch (valErr) {
            return res.status(valErr.statusCode || 400).end();
        }

        const cached = imageProxyCache.get(rawUrl);
        if (cached && cached.buffer) {
            res.setHeader('Content-Type', cached.contentType || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
            return res.send(cached.buffer);
        }

        let upstream;
        try {
            try {
                upstream = await fetchWithValidatedRedirects(rawUrl, true);
            } catch (firstErr) {
                if (firstErr && (firstErr.statusCode === 400 || firstErr.statusCode === 403)) {
                    throw firstErr;
                }
                upstream = await fetchWithValidatedRedirects(rawUrl, false);
            }
        } catch (err) {
            if (err && (err.statusCode === 400 || err.statusCode === 403)) {
                return res.status(err.statusCode).end();
            }
            return res.status(502).end();
        }

        const rawContentType = String(upstream.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_IMAGE_MIME_TYPES.has(rawContentType)) {
            return res.status(415).end();
        }

        const buffer = Buffer.from(upstream.data || '');
        if (!isSafeRasterBuffer(buffer)) {
            return res.status(415).end();
        }

        imageProxyCache.set(rawUrl, { buffer, contentType: rawContentType });
        res.setHeader('Content-Type', rawContentType);
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        return res.send(buffer);
    });

    handler.cache = imageProxyCache;
    return handler;
}

module.exports = {
    ALLOWED_IMAGE_MIME_TYPES,
    isBlockedIpAddress,
    isBlockedHostname,
    validateProxyTarget,
    isSafeRasterBuffer,
    createImageProxyHandler
};
