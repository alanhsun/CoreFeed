/**
 * 聚核 CoreFeed v2.0 — Express 全局异常捕获、404 与 API 速率限制中间件 (middleware/error_handler.js)
 */
const logger = require('../utils/logger');
const config = require('../config');

class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = 'AppError';
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        this.isOperational = true;
        this.timestamp = new Date().toISOString();

        Error.captureStackTrace(this, this.constructor);
    }
}

class NotFoundError extends AppError {
    constructor(resource = '资源') {
        super(`${resource}未找到`, 404, 'NOT_FOUND');
    }
}

class RateLimitError extends AppError {
    constructor(message = '请求过于频繁，请稍后再试') {
        super(message, 429, 'RATE_LIMIT_EXCEEDED');
    }
}

/**
 * 错误处理中间件
 */
function errorHandler(err, req, res, next) {
    const error = {
        message: err.message || '内部服务器错误',
        statusCode: err.statusCode || 500,
        code: err.code || 'INTERNAL_ERROR',
        timestamp: err.timestamp || new Date().toISOString(),
        details: err.details || null
    };

    const logData = {
        url: req.url,
        method: req.method,
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('User-Agent'),
        error: {
            message: error.message,
            code: error.code,
            stack: err.stack
        }
    };

    if (error.statusCode >= 500) {
        logger.error('ERROR', `服务器错误: ${error.message}`, logData);
    } else if (error.statusCode >= 400) {
        logger.warn('ERROR', `客户端错误: ${error.message}`, logData);
    }

    const response = {
        success: false,
        error: {
            message: error.message,
            code: error.code,
            timestamp: error.timestamp
        }
    };

    if (config.server.env === 'development') {
        response.error.details = error.details;
        response.error.stack = err.stack;
        response.debug = logData;
    }

    if (config.server.env === 'production' && error.statusCode >= 500) {
        response.error.message = '服务器内部错误';
    }

    res.status(error.statusCode).json(response);
}

/**
 * 404 处理中间件
 */
function notFoundHandler(req, res, next) {
    const error = new NotFoundError(`路径 ${req.originalUrl}`);
    next(error);
}

/**
 * 速率限制中间件
 */
function createRateLimiter(options = {}) {
    const {
        windowMs = 15 * 60 * 1000,
        maxRequests = 100,
        message = '请求过于频繁，请稍后再试'
    } = options;

    const requests = new Map();

    const cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, data] of requests.entries()) {
            if (now - data.resetTime > windowMs) {
                requests.delete(key);
            }
        }
    }, windowMs);
    if (typeof cleanupTimer.unref === 'function') {
        cleanupTimer.unref();
    }

    return (req, res, next) => {
        const key = req.ip || req.connection?.remoteAddress;
        const now = Date.now();

        let requestData = requests.get(key);

        if (!requestData || now - requestData.resetTime > windowMs) {
            requestData = {
                count: 0,
                resetTime: now
            };
            requests.set(key, requestData);
        }

        requestData.count++;

        res.set({
            'X-RateLimit-Limit': maxRequests,
            'X-RateLimit-Remaining': Math.max(0, maxRequests - requestData.count),
            'X-RateLimit-Reset': new Date(requestData.resetTime + windowMs)
        });

        if (requestData.count > maxRequests) {
            throw new RateLimitError(message);
        }

        next();
    };
}

/**
 * 全局未捕获异常处理（优雅停机信号交由 server.js 处理）
 */
function setupGlobalErrorHandlers() {
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('SYSTEM', '未处理的Promise rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack,
            promise: promise.toString()
        });

        if (config.server.env === 'production') {
            process.exit(1);
        }
    });

    process.on('uncaughtException', (error) => {
        logger.error('SYSTEM', '未捕获的异常', {
            message: error.message,
            stack: error.stack
        });

        process.exit(1);
    });
}

module.exports = {
    errorHandler,
    notFoundHandler,
    createRateLimiter,
    setupGlobalErrorHandlers
};