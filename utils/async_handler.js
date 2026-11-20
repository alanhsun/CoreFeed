/**
 * 聚核 CoreFeed v2.0 — Express async 路由异常捕获包装器 (utils/async_handler.js)
 *
 * 将 async 路由处理器中的未捕获 Promise rejection 自动转发给 Express 全局 errorHandler，
 * 避免触发进程级 unhandledRejection 导致服务退出。
 */
function asyncHandler(fn) {
    return function wrappedAsyncHandler(req, res, next) {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

module.exports = asyncHandler;
