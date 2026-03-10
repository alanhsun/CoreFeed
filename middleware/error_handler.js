const logger = require('../utils/logger');
const config = require('../config');

/**
 * 错误类型定义
 */
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

/**
 * 预定义错误类型
 */
class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}

class NotFoundError extends AppError {
    constructor(resource = '资源') {
        super(`${resource}未找到`, 404, 'NOT_FOUND');
    }
}

class UnauthorizedError extends AppError {
    constructor(message = '未授权访问') {
        super(message, 401, 'UNAUTHORIZED');
    }
}

class RateLimitError extends AppError {
    constructor(message = '请求过于频繁，请稍后再试') {
        super(message, 429, 'RATE_LIMIT_EXCEEDED');
    }
}

class ServiceUnavailableError extends AppError {
    constructor(service = '服务') {
        super(`${service}暂时不可用`, 503, 'SERVICE_UNAVAILABLE');
    }
}

class ExternalAPIError extends AppError {
    constructor(service, originalError = null) {
        const message = `外部API调用失败: ${service}`;
        super(message, 502, 'EXTERNAL_API_ERROR', {
            service,
            originalError: originalError?.message
        });
    }
}

/**
 * 错误处理中间件
 */
function errorHandler(err, req, res, next) {
    // 确保错误对象有基本属性
    const error = {
        message: err.message || '内部服务器错误',
        statusCode: err.statusCode || 500,
        code: err.code || 'INTERNAL_ERROR',
        timestamp: err.timestamp || new Date().toISOString(),
        details: err.details || null
    };

    // 记录错误日志
    const logData = {
        url: req.url,
        method: req.method,
        ip: req.ip || req.connection.remoteAddress,
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

    // 构建响应
    const response = {
        success: false,
        error: {
            message: error.message,
            code: error.code,
            timestamp: error.timestamp
        }
    };

    // 开发环境下包含更多错误信息
    if (config.server.env === 'development') {
        response.error.details = error.details;
        response.error.stack = err.stack;
        response.debug = logData;
    }

    // 生产环境下隐藏敏感信息
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
 * 异步错误包装器
 * 用于包装异步路由处理器，自动捕获Promise rejection
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * 验证中间件
 * 用于验证请求参数
 */
function validateRequest(schema) {
    return (req, res, next) => {
        try {
            const { error, value } = schema.validate({
                body: req.body,
                query: req.query,
                params: req.params
            }, { abortEarly: false });

            if (error) {
                const details = error.details.map(detail => ({
                    field: detail.path.join('.'),
                    message: detail.message,
                    value: detail.context?.value
                }));
                
                throw new ValidationError('请求参数验证失败', details);
            }

            // 将验证后的值赋回请求对象
            req.body = value.body || req.body;
            req.query = value.query || req.query;
            req.params = value.params || req.params;
            
            next();
        } catch (err) {
            next(err);
        }
    };
}

/**
 * 速率限制中间件
 */
function createRateLimiter(options = {}) {
    const {
        windowMs = 15 * 60 * 1000, // 15分钟
        maxRequests = 100,
        message = '请求过于频繁，请稍后再试',
        skipSuccessfulRequests = false
    } = options;

    const requests = new Map();

    // 清理过期记录
    setInterval(() => {
        const now = Date.now();
        for (const [key, data] of requests.entries()) {
            if (now - data.resetTime > windowMs) {
                requests.delete(key);
            }
        }
    }, windowMs);

    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress;
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

        // 设置响应头
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
 * 全局未捕获异常处理
 */
function setupGlobalErrorHandlers() {
    // 未捕获的Promise rejection
    process.on('unhandledRejection', (reason, promise) => {
        logger.error('SYSTEM', '未处理的Promise rejection', {
            reason: reason?.message || reason,
            stack: reason?.stack,
            promise: promise.toString()
        });
        
        // 在生产环境中可能需要优雅关闭
        if (config.server.env === 'production') {
            process.exit(1);
        }
    });

    // 未捕获的异常
    process.on('uncaughtException', (error) => {
        logger.error('SYSTEM', '未捕获的异常', {
            message: error.message,
            stack: error.stack
        });
        
        // 立即退出，因为应用状态可能不一致
        process.exit(1);
    });

    // 优雅关闭信号
    ['SIGTERM', 'SIGINT'].forEach(signal => {
        process.on(signal, () => {
            logger.info('SYSTEM', `收到${signal}信号，开始优雅关闭`);
            // 这里可以添加清理逻辑
            process.exit(0);
        });
    });
}

module.exports = {
    // 错误类
    AppError,
    ValidationError,
    NotFoundError,
    UnauthorizedError,
    RateLimitError,
    ServiceUnavailableError,
    ExternalAPIError,
    
    // 中间件
    errorHandler,
    notFoundHandler,
    asyncHandler,
    validateRequest,
    createRateLimiter,
    
    // 工具函数
    setupGlobalErrorHandlers
};