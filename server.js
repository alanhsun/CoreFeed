const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');
const cors = require('cors');
const config = require('./config');
const logger = require('./utils/logger');
const NetworkConfig = require('./utils/network_config');
const stateManager = require('./services/state_manager');
const {
    errorHandler,
    notFoundHandler,
    setupGlobalErrorHandlers,
    createRateLimiter
} = require('./middleware/error_handler');

const NewsService = require('./services/news_service');
const AIService = require('./services/ai_service');
const NewsAgentService = require('./services/news_agent_service');
const ScheduleManager = require('./utils/schedule_manager');
const initializeApiRoutes = require('./routes/api');
const { getGlobalSourceMatrix } = require('./config/global_sources');

// 初始化网络配置与全局异常处理
NetworkConfig.initialize();
setupGlobalErrorHandlers();

const app = express();
app.use(cors());

if (!fs.existsSync('./logs')) {
    fs.mkdirSync('./logs', { recursive: true });
}

const server = http.createServer(app);

const io = socketIo(server, {
    pingTimeout: config.socketio.pingTimeout,
    pingInterval: config.socketio.pingInterval,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    },
    connectTimeout: config.socketio.connectTimeout,
    maxHttpBufferSize: config.socketio.maxHttpBufferSize
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// 请求追踪 ID
app.use((req, res, next) => {
    req.id = require('crypto').randomBytes(6).toString('hex');
    res.setHeader('X-Request-ID', req.id);
    next();
});

// 生产环境速率限制（放宽额度以支持新闻图片代理并发加载）
if (config.server.env === 'production') {
    app.use('/api', createRateLimiter({
        windowMs: 15 * 60 * 1000,
        maxRequests: 2000,
        message: 'API请求过于频繁，请稍后再试'
    }));
}

// 视图与静态文件
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: config.server.env === 'production' ? '1h' : 0
}));

// API 响应禁用缓存（图片代理 /api/image-proxy 除外）
app.use('/api', (req, res, next) => {
    if (req.path === '/image-proxy') {
        return next();
    }
    res.set({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    });
    next();
});

// 初始化核心服务与多 Agent 引擎
const newsService = new NewsService(io, stateManager);
const aiService = new AIService(io, stateManager);
const newsAgentService = new NewsAgentService(io, stateManager, aiService, newsService);
const scheduleManager = new ScheduleManager(newsService, io, stateManager, newsAgentService, aiService);

app.locals.stateManager = stateManager;

// 监听状态变更并广播给前端
stateManager.on('newsData-changed', ({ value }) => {
    io.emit('news-updated', {
        success: true,
        phase: stateManager.get('collectionPhase') || 'idle',
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

stateManager.on('updateProgress-changed', ({ value }) => {
    io.emit('update-progress', value);
});

const services = {
    newsService,
    aiService,
    newsAgentService,
    scheduleManager
};

// 健康与版本端点
app.get('/api/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.status(200).json({
        status: 'healthy',
        version: '2.0.0',
        engine: 'CoreFeed Global News Collector v2.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024)
        }
    });
});

app.get('/api/version', (req, res) => {
    res.json({
        version: '2.0.0',
        timestamp: new Date().toISOString()
    });
});

// 挂载 API 路由
const apiRoutes = initializeApiRoutes(services, io, stateManager);
app.use('/api', apiRoutes);

// 首页渲染路由
app.get('/', (req, res) => {
    const newsData = stateManager.get('newsData') || [];
    const allEnhanced = stateManager.get('allEnhancedNews') || newsData;
    const summaryArticle = stateManager.get('summaryArticle') || null;
    const lastUpdated = stateManager.get('lastUpdated');
    const sourceMatrix = getGlobalSourceMatrix();

    const displayNews = newsData.slice(0, config.agent.maxCuratedArticles || 30);

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.render('index', {
        news: displayNews,
        totalNews: allEnhanced.length || displayNews.length,
        displayedNews: displayNews.length,
        summaryArticle,
        lastUpdated,
        sourceMatrix,
        appVersion: '2.0.0',
        config: {
            siteName: '聚核 CoreFeed · 全球知名信源实时聚合与深读平台',
            aiModel: config.minimax.model || 'MiniMax-M2.5',
            aiConfigured: Boolean(config.minimax.apiKey),
            jinaReaderEnabled: config.agent.jinaReaderEnabled
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        state: stateManager.getStats(),
        logs: logger.getMetrics(),
        version: '2.0.0'
    });
});

app.use(notFoundHandler);
app.use(errorHandler);

// WebSocket 连接管理
io.on('connection', (socket) => {
    socket.emit('connected', {
        id: socket.id,
        version: '2.0.0',
        isUpdating: stateManager.get('isUpdating'),
        collectionPhase: stateManager.get('collectionPhase') || 'idle',
        progress: stateManager.get('updateProgress'),
        recentLogs: newsAgentService.getRecentAgentLogs(),
        timestamp: new Date().toISOString()
    });

    socket.on('ping', () => {
        socket.emit('pong');
    });
});

async function startServer() {
    try {
        await stateManager.loadFromFile();
        stateManager.set('isUpdating', false, false);
        stateManager.set('collectionPhase', 'idle', false);

        await newsService.loadLocalData();

        const currentNewsData = stateManager.get('newsData');
        if (!currentNewsData || currentNewsData.length === 0) {
            const localNews = newsService.getNewsData();
            const lastUpdated = newsService.getLastUpdated();
            if (localNews && localNews.length > 0) {
                stateManager.updateNewsData(localNews, localNews);
                if (lastUpdated) {
                    stateManager.set('lastUpdated', lastUpdated);
                }
            }
        } else if (!stateManager.get('allEnhancedNews') || stateManager.get('allEnhancedNews').length === 0) {
            stateManager.set('allEnhancedNews', currentNewsData, false);
        }

        const finalNewsData = stateManager.get('newsData');
        logger.info('SYSTEM', '本地新闻库加载完成', {
            count: finalNewsData?.length || 0
        });

        server.listen(config.server.port, () => {
            const os = require('os');
            const networkInterfaces = os.networkInterfaces();
            let networkHost = 'localhost';

            for (const interfaceName in networkInterfaces) {
                for (const iface of networkInterfaces[interfaceName]) {
                    if (iface.family === 'IPv4' && !iface.internal) {
                        networkHost = iface.address;
                        break;
                    }
                }
                if (networkHost !== 'localhost') break;
            }

            logger.startup(config.server.port, networkHost);
            const matrixCount = getGlobalSourceMatrix().filter(s => s.enabled).length;
            console.log(chalk.cyan(`   - 核心引擎:     CoreFeed v2.0 两阶段渐进式采集与编译 (${config.minimax.model})`));
            console.log(chalk.cyan(`   - 全球信源矩阵: 已启用 ${matrixCount} 个国际权威信源 + Jina 全文深读`));

            app.locals.services = services;
            scheduleManager.start();

            // 启动自愈：如果本地已缓存的新闻存在未翻译的英文条目或缺失配图，后台自动补全汉化与标题图
            if (Array.isArray(finalNewsData) && finalNewsData.length > 0 && services.aiService && services.newsAgentService) {
                const hasUntranslated = finalNewsData.some(item => !services.aiService.isChineseText(item.translatedTitle) || !services.aiService.isChineseText(item.summary));
                const hasMissingImages = finalNewsData.some(item => !item.urlToImage);
                if (hasUntranslated || hasMissingImages) {
                    setImmediate(async () => {
                        try {
                            logger.info('SYSTEM', '检测到本地缓存新闻包含未汉化或无配图条目，正在后台自动补全...');
                            let updatedList = [...finalNewsData];
                            if (hasUntranslated) {
                                updatedList = await services.aiService.ensureBatchInChinese(updatedList, 6);
                            }
                            if (hasMissingImages) {
                                await services.newsAgentService._enrichMissingArticleImages(updatedList);
                            }
                            await services.newsAgentService._publishNewsSnapshot(
                                updatedList,
                                updatedList,
                                stateManager.get('sourceStats') || [],
                                new Date(stateManager.get('lastUpdated') || Date.now()),
                                'completed'
                            );
                            logger.info('SYSTEM', '本地缓存新闻自动汉化与配图补全完成');
                        } catch (e) {
                            logger.warn('SYSTEM', `缓存新闻自动补全异常: ${e.message}`);
                        }
                    });
                }
            }
        });

        setInterval(async () => {
            await stateManager.saveToFile();
        }, 5 * 60 * 1000);
    } catch (error) {
        logger.error('SERVER', '启动服务器失败', error.message);
        process.exit(1);
    }
}

async function gracefulShutdown(signal) {
    logger.info('SERVER', `收到 ${signal} 信号，正在优雅关闭服务器...`);
    try {
        await stateManager.saveToFile();
        if (scheduleManager) scheduleManager.stop();
        if (io) io.close();
        await new Promise((resolve) => server.close(resolve));
        process.exit(0);
    } catch (error) {
        process.exit(1);
    }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

if (require.main === module) {
    startServer();
}

module.exports = { app, server, io, services };
