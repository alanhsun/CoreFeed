const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const cron = require('node-cron');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const NetworkConfig = require('./utils/network_config');
const { setupGracefulShutdown } = require('./utils/helpers');

// PM2日志格式优化
if (process.env.NODE_ENV === 'production') {
  console.log = function(...args) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp: timestamp,
      level: 'INFO',
      message: args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '),
      pid: process.pid
    };
    process.stdout.write(JSON.stringify(logEntry) + '\n');
  };

  console.error = function(...args) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp: timestamp,
      level: 'ERROR',
      message: args.map(arg => 
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' '),
      pid: process.pid
    };
    process.stderr.write(JSON.stringify(logEntry) + '\n');
  };
}


// 导入状态管理和错误处理
const stateManager = require('./services/state_manager');
const { 
    errorHandler, 
    notFoundHandler, 
    setupGlobalErrorHandlers,
    createRateLimiter 
} = require('./middleware/error_handler');

// 导入服务
const NewsService = require('./services/news_service');
const AIService = require('./services/ai_service');
const AudioService = require('./services/audio_service');
const ScheduleManager = require('./utils/schedule_manager');
const initializeApiRoutes = require('./routes/api');
const { readJsonFile } = require('./utils/helpers');

// 初始化网络配置
NetworkConfig.initialize();

// 设置全局错误处理
setupGlobalErrorHandlers();

// 初始化Express应用
const app = express();

// 启用CORS
app.use(cors());

// 创建日志目录
if (!fs.existsSync('./logs')) {
  fs.mkdirSync('./logs', { recursive: true });
}

// 健康检查端点
app.get('/api/health', async (req, res) => {
    try {
        const uptime = process.uptime();
        const memUsage = process.memoryUsage();
        
        res.json({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: Math.floor(uptime),
            memory: {
                heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
                rss: Math.round(memUsage.rss / 1024 / 1024)
            },
            version: '1.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            error: error.message
        });
    }
});
const server = http.createServer(app);

// 增强Socket.IO配置以提高连接稳定性
const io = socketIo(server, {
    pingTimeout: config.socketio.pingTimeout,
    pingInterval: config.socketio.pingInterval,
    transports: ['websocket', 'polling'], // 支持多种传输方式
    allowEIO3: true,           // 兼容旧版本
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    connectTimeout: config.socketio.connectTimeout,
    maxHttpBufferSize: config.socketio.maxHttpBufferSize
});

// 中间件配置
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求ID中间件（用于日志追踪）
app.use((req, res, next) => {
    req.id = require('crypto').randomBytes(8).toString('hex');
    global.currentRequestId = req.id;
    res.setHeader('X-Request-ID', req.id);
    next();
});

// 速率限制
if (config.server.env === 'production') {
    app.use('/api', createRateLimiter({
        windowMs: 15 * 60 * 1000, // 15分钟
        maxRequests: 100,
        message: 'API请求过于频繁，请稍后再试'
    }));
}

// 设置视图引擎
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// 静态文件 - 放在最前面避免静态文件缓存被禁用
app.use(express.static(path.join(__dirname, 'public')));

// 强化缓存控制中间件 - 完全禁用浏览器缓存，确保始终获取最新内容
app.use((req, res, next) => {
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substr(2, 9);
    const nanoTime = process.hrtime.bigint().toString();
    
    // 通用的强制无缓存头 - 增强版
    const noCacheHeaders = {
        'Cache-Control': 'no-cache, no-store, must-revalidate, private, max-age=0, s-maxage=0, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '-1',
        'Last-Modified': new Date().toUTCString(),
        'ETag': `"${timestamp}-${randomId}-${nanoTime}"`,
        'X-App-Version': '1.0.0',
        'X-Timestamp': timestamp.toString(),
        'X-Random-ID': randomId,
        'X-Nano-Time': nanoTime,
        'Vary': 'Accept-Encoding, User-Agent, Cache-Control',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'X-XSS-Protection': '1; mode=block',
        'Surrogate-Control': 'no-store',
        'Clear-Site-Data': '"cache"'
    };
    
    // 对于所有请求都应用最严格的缓存控制
    res.set(noCacheHeaders);
    
    // 额外的防缓存措施
    if (req.path === '/' || req.path.startsWith('/api/')) {
        res.set({
            'X-Accel-Expires': '0',
            'X-Cache': 'MISS',
            'X-Force-Refresh': 'true'
        });
    }
    
    next();
});

// 初始化服务
const newsService = new NewsService(io, stateManager);
const aiService = new AIService(io, stateManager);
const audioService = new AudioService(io, stateManager);
const scheduleManager = new ScheduleManager(newsService, io, stateManager);

// 初始化TTS服务
(async () => {
    try {
        await audioService.initializeTTS();
        logger.success('SERVER', 'TTS服务初始化成功');
    } catch (error) {
        logger.error('SERVER', 'TTS服务初始化失败，播客功能将不可用', error.message);
    }
})();

// 将状态管理器设置为全局可访问
app.locals.stateManager = stateManager;

// 监听状态变化并通过WebSocket广播
stateManager.on('newsData-changed', ({ value }) => {
    io.emit('news-updated', {
        success: true,
        total: value?.length || 0,
        lastUpdated: stateManager.get('lastUpdated')
    });
});

stateManager.on('summaryArticle-changed', ({ value }) => {
    if (value) {
        io.emit('summary-completed', {
            success: true,
            article: value
        });
    }
});

stateManager.on('podcastInfo-changed', ({ value }) => {
    if (value) {
        io.emit('podcast-completed', {
            success: true,
            info: value
        });
    }
});

stateManager.on('updateProgress-changed', ({ value }) => {
    io.emit('update-progress', value);
});

// 服务集合
const services = {
    newsService,
    aiService,
    audioService,
    scheduleManager
};

// 健康检查端点
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    version: process.version
  });
});



// 获取当前版本信息端点
app.get('/api/version', (req, res) => {
    res.json({
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

// 初始化API路由
const apiRoutes = initializeApiRoutes(services, io, stateManager);
app.use('/api', apiRoutes);

// 主页路由
app.get('/', (req, res) => {
    const newsData = stateManager.get('newsData') || [];
    const lastUpdated = stateManager.get('lastUpdated');
    
    // 限制显示的新闻数量为30条
    const displayNews = newsData ? newsData.slice(0, 30) : [];
    
    res.render('index', {
        news: displayNews,
        totalNews: newsData ? newsData.length : 0,
        displayedNews: displayNews.length,
        lastUpdated: lastUpdated,
        appVersion: '1.0.0', // 添加版本号
        config: {
            siteName: '聚核 (CoreFeed)',
            enableAudio: config.audio && config.audio.enabled
        }
    });
});

// 健康检查路由
app.get('/health', (req, res) => {
    const stats = stateManager.getStats();
    const logMetrics = logger.getMetrics();
    
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        state: stats,
        logs: logMetrics,
        version: '1.0.0'
    });
});

// 404处理
app.use(notFoundHandler);

// 错误处理中间件（必须在最后）
app.use(errorHandler);

// WebSocket连接处理
io.on('connection', (socket) => {
    const logger = require('./utils/logger');
    logger.debug('SOCKET', `客户端已连接: ${socket.id}`);
    
    // 发送连接确认
    socket.emit('connected', {
        id: socket.id,
        timestamp: new Date().toISOString()
    });
    
    // 处理心跳检测
    socket.on('ping', () => {
        socket.emit('pong');
    });
    
    // 处理断开连接
    socket.on('disconnect', (reason) => {
        const logger = require('./utils/logger');
        logger.debug('SOCKET', `客户端已断开连接: ${socket.id}`, { reason });
    });
    
    // 处理连接错误
    socket.on('error', (error) => {
        const logger = require('./utils/logger');
        logger.error('SOCKET', `Socket错误 ${socket.id}`, error.message);
    });
});

// 定时任务管理器将在服务器启动后初始化

// 启动服务器
async function startServer() {
    try {
        // 检查是否应该加载状态文件（避免加载过期数据）
        const shouldLoadState = true;
        
        if (shouldLoadState) {
            // 加载状态管理器数据
            await stateManager.loadFromFile();
            logger.info('SYSTEM', '状态管理器数据加载完成');
            
            // 验证加载的数据是否有效且未过期
            const loadedLastUpdated = stateManager.get('lastUpdated');
            const loadedNewsData = stateManager.get('newsData');
            
            if (loadedLastUpdated && loadedNewsData && loadedNewsData.length > 0) {
                const timeDiff = Date.now() - new Date(loadedLastUpdated).getTime();
                const maxAge = 10 * 60 * 1000; // 10分钟
                
                if (timeDiff > maxAge) {
                    logger.info('SYSTEM', '状态文件中的数据已过期，将重置状态');
                    stateManager.reset(['newsData', 'lastUpdated', 'summaryArticle', 'podcastInfo']);
                } else {
                    logger.info('SYSTEM', '加载了有效的状态数据', {
                        newsCount: loadedNewsData.length,
                        lastUpdated: loadedLastUpdated
                    });
                }
            } else {
                logger.info('SYSTEM', '状态文件中无有效数据，使用默认状态');
            }
        } else {
            logger.info('SYSTEM', '跳过状态文件加载，数据可能已过期');
        }
        
        // 加载本地新闻数据（向后兼容）
        await newsService.loadLocalData();
        
        // 将新闻数据同步到状态管理器（如果状态管理器中没有有效数据）
        const currentNewsData = stateManager.get('newsData');
        if (!currentNewsData || currentNewsData.length === 0) {
            const newsData = newsService.getNewsData();
            const lastUpdated = newsService.getLastUpdated();
            if (newsData && newsData.length > 0) {
                stateManager.updateNewsData(newsData);
                if (lastUpdated) {
                    stateManager.set('lastUpdated', lastUpdated);
                }
                logger.info('SYSTEM', '从本地文件同步新闻数据到状态管理器', {
                    count: newsData.length
                });
            }
        }
        
        const finalNewsData = stateManager.get('newsData');
        logger.info('SYSTEM', '本地新闻数据加载完成', {
            count: finalNewsData?.length || 0
        });
        
        // 启动HTTP服务器
        server.listen(config.server.port, () => {
            const logger = require('./utils/logger');
            
            // 收集启用的功能
            const features = [];
            if (config.news.newsApiEnabled) features.push('NewsAPI');
            if (config.gnews.enabled) features.push('Gnews');
            if (config.google.geminiApiKey) features.push('Gemini AI');
            if (config.google.translateApiKey) features.push('Google翻译');
            if (config.news.autoUpdateEnabled) features.push('定时更新');
            if (config.logging.file) features.push('文件日志');
            
            // 获取主机名用于网络访问显示
            const os = require('os');
            const hostname = os.hostname();
            const networkInterfaces = os.networkInterfaces();
            let networkHost = 'localhost';
            
            // 获取第一个非内部IPv4地址
            for (const interfaceName in networkInterfaces) {
                const interfaces = networkInterfaces[interfaceName];
                for (const iface of interfaces) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        networkHost = iface.address;
                        break;
                    }
                }
                if (networkHost !== 'localhost') break;
            }
            
            logger.startup(config.server.port, networkHost);
            
            // 单独显示启用的功能
            if (features.length > 0) {
                console.log(chalk.cyan(`   - 启用的功能:   ${features.join(', ')}`));
            }
            
            // 设置服务到app.locals，供API路由使用
            app.locals.services = services;
            
            // 初始化定时任务管理器
            scheduleManager.start();
        });
        
        // 监听服务器错误事件
        server.on('error', (error) => {
            const logger = require('./utils/logger');
            
            if (error.code === 'EADDRINUSE') {
                logger.error('SERVER', `端口 ${config.server.port} 已被占用`, {
                    port: config.server.port,
                    code: error.code,
                    message: `请检查是否有其他程序正在使用端口 ${config.server.port}，或尝试使用其他端口`
                });
                console.error(`\n❌ 服务器启动失败: 端口 ${config.server.port} 已被占用`);
                console.error(`💡 解决方案:`);
                console.error(`   1. 关闭占用端口 ${config.server.port} 的其他程序`);
                console.error(`   2. 修改配置文件中的端口号`);
                console.error(`   3. 使用命令查看端口占用: netstat -ano | findstr :${config.server.port}\n`);
            } else if (error.code === 'EACCES') {
                logger.error('SERVER', `权限不足，无法绑定端口 ${config.server.port}`, {
                    port: config.server.port,
                    code: error.code,
                    message: '请以管理员权限运行程序或使用大于1024的端口号'
                });
                console.error(`\n❌ 服务器启动失败: 权限不足，无法绑定端口 ${config.server.port}`);
                console.error(`💡 解决方案:`);
                console.error(`   1. 以管理员权限运行程序`);
                console.error(`   2. 使用大于1024的端口号\n`);
            } else {
                logger.error('SERVER', '服务器启动失败', {
                    code: error.code,
                    message: error.message,
                    stack: error.stack
                });
                console.error(`\n❌ 服务器启动失败: ${error.message}`);
                console.error(`错误代码: ${error.code}\n`);
            }
            
            process.exit(1);
        });
        
        // 定期保存状态
        setInterval(async () => {
            try {
                await stateManager.saveToFile();
            } catch (error) {
                logger.error('SYSTEM', '状态保存失败', error.message);
            }
        }, 5 * 60 * 1000); // 每5分钟保存一次
        
    } catch (error) {
        const logger = require('./utils/logger');
        logger.error('SERVER', '启动服务器失败', error.message);
        process.exit(1);
    }
}

// 优雅关闭函数
async function gracefulShutdown(signal) {
    const logger = require('./utils/logger');
    logger.info('SERVER', `收到${signal}信号，正在优雅关闭服务器`);
    
    try {
        // 1. 停止定时任务
        logger.info('SERVER', '正在停止定时任务');
        if (scheduleManager) {
            scheduleManager.stop();
        }
        
        // 2. 关闭WebSocket连接
        logger.info('SERVER', '正在关闭WebSocket连接');
        if (io) {
            io.close();
        }
        
        // 3. 关闭HTTP服务器
        logger.info('SERVER', '正在关闭HTTP服务器');
        await new Promise((resolve) => {
            server.close(resolve);
        });
        
        // 4. 清理服务资源
        logger.info('SERVER', '正在清理服务资源');
        // 这里可以添加其他服务的清理逻辑
        
        logger.success('SERVER', '服务器已优雅关闭');
        process.exit(0);
    } catch (error) {
        logger.error('SERVER', '关闭服务器时发生错误', error.message);
        process.exit(1);
    }
}

// 监听关闭信号
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
    const logger = require('./utils/logger');
    logger.error('SERVER', '未捕获的异常', {
        message: error.message,
        stack: error.stack,
        name: error.name
    });
    console.error('未捕获的异常详细信息:', error);
    gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
    const logger = require('./utils/logger');
    logger.error('SERVER', '未处理的Promise拒绝', {
        reason: reason,
        promise: promise
    });
    console.error('未处理的Promise拒绝详细信息:', reason, promise);
    gracefulShutdown('unhandledRejection');
});

// 启动服务器
if (require.main === module) {
    startServer();
}

module.exports = { app, server, io, services };