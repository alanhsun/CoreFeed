/**
 * 聚核 CoreFeed v3.0 — 零依赖 HTTP Gzip 响应压缩中间件 (middleware/compression.js)
 *
 * 特点：
 *   - 仅使用 Node 内置 zlib，不引入额外第三方包；
 *   - 自动压缩 HTML、JSON、JS、CSS、SVG 等文本响应（>= 1024 字节）；
 *   - 显式跳过 /api/audio/*（保留 HTTP 206 Range 拖拽）、/api/image-proxy（已压缩光栅图）、
 *     /socket.io 与 204/206/304 响应。
 */
const zlib = require('zlib');

const MIN_COMPRESS_BYTES = 1024;
const COMPRESSIBLE_MIME_RE = /^(?:text\/|application\/(?:json|javascript|x-javascript|xml|xhtml\+xml)|image\/svg\+xml)/i;

function appendVaryAcceptEncoding(res) {
    const existing = res.getHeader('Vary');
    if (!existing) {
        res.setHeader('Vary', 'Accept-Encoding');
        return;
    }
    const parts = String(existing).split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.some(p => p.toLowerCase() === 'accept-encoding')) {
        parts.push('Accept-Encoding');
        res.setHeader('Vary', parts.join(', '));
    }
}

function shouldSkipRequest(req) {
    if (!req) return true;
    if (req.method === 'HEAD') return true;
    if (req.headers?.range) return true;
    const ae = String(req.headers?.['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(ae)) return true;
    const reqPath = String(req.path || req.url || '');
    if (
        reqPath.startsWith('/api/audio') ||
        reqPath.startsWith('/api/image-proxy') ||
        reqPath.startsWith('/socket.io')
    ) {
        return true;
    }
    return false;
}

function isCompressibleResponse(res) {
    if (res.headersSent) return false;
    const status = res.statusCode || 200;
    if (status < 200 || status >= 300 || status === 204 || status === 206) {
        return false;
    }
    if (res.getHeader('Content-Encoding')) {
        return false;
    }
    const contentType = String(res.getHeader('Content-Type') || '').split(';')[0].trim();
    return COMPRESSIBLE_MIME_RE.test(contentType);
}

function compressionMiddleware(req, res, next) {
    if (shouldSkipRequest(req)) {
        return next();
    }

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const origOn = res.on.bind(res);

    let gzipStream = null;
    let decided = false;
    let passthrough = false;
    let upstreamNeedDrain = false;
    let waitingSocketDrain = false;

    const toBuffer = (chunk, encoding) => {
        if (chunk === undefined || chunk === null) return null;
        if (Buffer.isBuffer(chunk)) return chunk;
        return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
    };

    const startStreamGzip = () => {
        res.removeHeader('Content-Length');
        res.setHeader('Content-Encoding', 'gzip');
        appendVaryAcceptEncoding(res);
        gzipStream = zlib.createGzip({ level: 6 });
        gzipStream.on('data', (compressedChunk) => {
            if (!origWrite(compressedChunk)) {
                waitingSocketDrain = true;
                gzipStream.pause();
                res.once('drain', () => {
                    waitingSocketDrain = false;
                    if (gzipStream && !gzipStream.destroyed) {
                        gzipStream.resume();
                    }
                });
            }
        });
        gzipStream.on('drain', () => {
            if (upstreamNeedDrain && !waitingSocketDrain) {
                upstreamNeedDrain = false;
                res.emit('drain');
            }
        });
        gzipStream.on('end', () => {
            origEnd();
        });
        gzipStream.on('error', () => {
            try {
                origEnd();
            } catch (_) {}
        });
        res.once('close', () => {
            if (gzipStream && !gzipStream.destroyed && !res.writableEnded) {
                gzipStream.destroy();
            }
        });
    };

    res.write = function wrappedWrite(chunk, encoding, cb) {
        if (!decided) {
            decided = true;
            const rawLen = Number(res.getHeader('Content-Length'));
            const knownTooSmall = Number.isFinite(rawLen) && rawLen > 0 && rawLen < MIN_COMPRESS_BYTES;
            if (!knownTooSmall && isCompressibleResponse(res)) {
                startStreamGzip();
            } else {
                passthrough = true;
            }
        }
        if (passthrough || !gzipStream) {
            return origWrite(chunk, encoding, cb);
        }
        const ok = gzipStream.write(chunk, encoding, cb);
        if (!ok) {
            upstreamNeedDrain = true;
        }
        return ok;
    };

    res.end = function wrappedEnd(chunk, encoding, cb) {
        if (typeof chunk === 'function') {
            cb = chunk;
            chunk = undefined;
            encoding = undefined;
        } else if (typeof encoding === 'function') {
            cb = encoding;
            encoding = undefined;
        }

        if (!decided) {
            decided = true;
            const buf = toBuffer(chunk, encoding);
            if (buf && buf.length >= MIN_COMPRESS_BYTES && isCompressibleResponse(res)) {
                try {
                    const compressed = zlib.gzipSync(buf, { level: 6 });
                    res.setHeader('Content-Encoding', 'gzip');
                    res.setHeader('Content-Length', compressed.length);
                    appendVaryAcceptEncoding(res);
                    return origEnd(compressed, cb);
                } catch (_) {
                    // Fallback to uncompressed send on unexpected zlib error
                }
            }
            passthrough = true;
            return chunk !== undefined ? origEnd(chunk, encoding, cb) : origEnd(cb);
        }

        if (passthrough || !gzipStream) {
            return chunk !== undefined ? origEnd(chunk, encoding, cb) : origEnd(cb);
        }

        if (typeof cb === 'function') {
            origOn('finish', cb);
        }
        return chunk !== undefined ? gzipStream.end(chunk, encoding) : gzipStream.end();
    };

    return next();
}

module.exports = {
    compressionMiddleware,
    MIN_COMPRESS_BYTES
};
