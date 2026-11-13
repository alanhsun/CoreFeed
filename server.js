/**
 * 聚核 CoreFeed v2.0 — 全球权威媒体要闻阅读与快照同步服务端主入口 (server.js)
 *
 * 架构概览：
 *   - 采编与精译（本机 Antigravity 客户端）：`ag:harvest` 纯网络搬运 37 家权威外媒原始素材，由 Antigravity 客户端内置大模型
 *     全流程完成选稿裁剪、跨源合并、正文提取、全文精译、标题/导语/要点精编与《全球要闻深度综述》，通过 `ag:publish` 推送至 GitHub `ag-snapshot/latest.json`；
 *   - 软路由只读拉取（本服务）：启动自检、每日定时任务 (08:00 / 12:30 / 19:30)、每 60 分钟 ETag 轮询及网页一键同步从 GitHub 拉取最新快照；
 *   - 界面渲染：Swiss Editorial 焦点轮播 + Bento 网格 SSR 首屏直出 + Socket.IO 实时刷新 + 离线秒开全文双语阅读器。
 */
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
const NewsAgentService = require('./services/news_agent_service');
const ScheduleManager = require('./utils/schedule_manager');
const { GitHubSyncManager } = require('./utils/github_sync');
const initializeApiRoutes = require('./routes/api');
const { getGlobalSourceMatrix } = require('./config/global_sources');

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

app.use((req, res, next) => {
    req.id = require('crypto').randomBytes(6).toString('hex');
    res.setHeader('X-Request-ID', req.id);
    next();
});

if (config.server.env === 'production') {
    app.use('/api', createRateLimiter({
        windowMs: 15 * 60 * 1000,
        maxRequests: 2000,
        message: 'API请求过于频繁，请稍后再试'
    }));
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: config.server.env === 'production' ? '1h' : 0,
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
    }
}));

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

// 初始化核心服务
const newsService = new NewsService(io, stateManager);
const newsAgentService = new NewsAgentService(io, stateManager, newsService);
const githubSyncManager = new GitHubSyncManager({ newsService, newsAgentService }, io, stateManager);
const scheduleManager = new ScheduleManager(newsService, io, stateManager, newsAgentService, githubSyncManager);

app.locals.stateManager = stateManager;

stateManager.on('newsData-changed', ({ value }) => {
    io.emit('news-updated', {
        success: true,
        phase: stateManager.get('collectionPhase') || 'idle',
        total: value?.length || 0,
        lastUpdated: stateManager.get('lastUpdated'),
        lastPublishedBy:
            stateManager.get('lastPublishedBy') ||
            (githubSyncManager ? githubSyncManager.getStatus().publishedBy : null) ||
            null
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
    newsAgentService,
    scheduleManager,
    githubSyncManager
};

app.get('/api/health', (req, res) => {
    const memUsage = process.memoryUsage();
    res.status(200).json({
        status: 'healthy',
        version: '2.0.0',
        engine: 'CoreFeed Global News Reader v2.0',
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        memory: {
            heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024),
            heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
            rss: Math.round(memUsage.rss / 1024 / 1024)
        }
    });
});

const apiRoutes = initializeApiRoutes(services, io, stateManager);
app.use('/api', apiRoutes);

app.get('/', (req, res) => {
    const newsData = stateManager.get('newsData') || [];
    const allEnhanced = stateManager.get('allEnhancedNews') || newsData;
    const summaryArticle = stateManager.get('summaryArticle') || null;
    const lastUpdated = stateManager.get('lastUpdated');
    const githubSyncStatus = githubSyncManager ? githubSyncManager.getStatus() : null;
    const scheduleStatus = scheduleManager ? scheduleManager.getStatus() : null;
    const clientId = String(
        process.env.CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        'antigravity-client'
    ).trim();
    const lastPublishedBy =
        stateManager.get('lastPublishedBy') ||
        (githubSyncStatus && githubSyncStatus.publishedBy) ||
        clientId;

    const displayNews = newsData.slice(0, config.agent.maxCuratedArticles || 30);

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.render('index', {
        news: displayNews,
        totalNews: allEnhanced.length || displayNews.length,
        displayedNews: displayNews.length,
        summaryArticle,
        lastUpdated,
        lastPublishedBy,
        clientId,
        githubSync: githubSyncStatus,
        schedule: scheduleStatus,
        config: {
            siteName: '聚核 CoreFeed · 全球要闻深度聚合',
            updateTimes: (config.news.updateTimes && config.news.updateTimes.length > 0)
                ? config.news.updateTimes
                : ['08:00', '12:30', '19:30'],
            autoUpdateEnabled: Boolean(config.news.autoUpdateEnabled)
        }
    });
});

app.use(notFoundHandler);
app.use(errorHandler);

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
        logger.info('SYSTEM', '本地新闻快照加载完成', {
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
            console.log(chalk.cyan('   - 采编模式:     Antigravity 客户端内置大模型全流程精编 (零外部 API Key)'));
            console.log(chalk.cyan(`   - 全球信源矩阵: 内置 ${matrixCount} 家国际权威外媒 + GitHub ag-snapshot 快照同步`));

            app.locals.services = services;
            scheduleManager.start();

            const githubSyncEnabled = Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true);
            if (
                githubSyncEnabled &&
                (config.githubSync?.syncOnStartup ?? true) &&
                process.env.NODE_ENV !== 'test'
            ) {
                setImmediate(async () => {
                    try {
                        const syncRes = await githubSyncManager.pullAndApply({ force: false, trigger: 'startup' });
                        if (syncRes && syncRes.applied) {
                            logger.success('SYSTEM', `启动时已从 GitHub 快照分支同步最新新闻 (${syncRes.displayedCount} 条)`);
                        }
                    } catch (err) {
                        logger.debug('SYSTEM', `启动时检查 GitHub 快照跳过: ${err.message}`);
                    }
                });
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
