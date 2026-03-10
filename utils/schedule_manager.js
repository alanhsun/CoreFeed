const cron = require('node-cron');
const config = require('../config');
const logger = require('./logger');

/**
 * 定时任务管理器
 * 用于管理新闻自动更新的定时任务
 */
class ScheduleManager {
    constructor(newsService, io, stateManager = null) {
        this.newsService = newsService;
        this.io = io;
        this.stateManager = stateManager;
        this.currentTasks = []; // 改为数组支持多个任务
        this.isRunning = false;
    }

    /**
     * 启动定时任务
     * @param {Object} settings - 定时设置
     */
    start(settings = {}) {
        // 停止现有任务
        this.stop();

        const {
            enabled = config.news.autoUpdateEnabled,
            updateTimes = config.news.updateTimes || [config.news.updateTime || '08:00']
        } = settings;

        if (!enabled) {
            logger.warn('SCHEDULE', '自动更新已禁用');
            return;
        }

        // 获取更新时间列表
        let timesToSchedule = updateTimes;
        if (!Array.isArray(timesToSchedule) || timesToSchedule.length === 0) {
            timesToSchedule = [config.news.updateTime || '08:00'];
        }

        logger.info('SCHEDULE', `Tasks scheduled for: ${timesToSchedule.join(', ')}`);

        // 为每个时间创建定时任务
        for (const time of timesToSchedule) {
            const cronExpression = this.parseTimeToDaily(time);
            
            if (!cron.validate(cronExpression)) {
                logger.error('SCHEDULE', `无效的cron表达式: ${cronExpression}`, { time });
                continue;
            }

            const task = cron.schedule(cronExpression, async () => {
                await this.executeUpdate();
            }, {
                scheduled: true,
                timezone: 'Asia/Shanghai' // 北京时间
            });

            this.currentTasks.push({
                task,
                time,
                cronExpression
            });

            logger.debug('SCHEDULE', `添加任务: ${time}`, { cronExpression });
        }

        this.isRunning = this.currentTasks.length > 0;
        
        if (this.isRunning) {
            logger.success('SCHEDULE', `启动成功 (${this.currentTasks.length}个任务)`);
            logger.info('SCHEDULE', `Next execution time: ${this.getNextExecutionTime()}`);
        }
        
        // 通知前端
        if (this.io) {
            this.io.emit('schedule-updated', {
                enabled: this.isRunning,
                updateTimes: timesToSchedule,
                nextExecution: this.getNextExecutionTime(),
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 停止定时任务
     */
    stop() {
        if (this.currentTasks.length > 0) {
            this.currentTasks.forEach(({ task, time }) => {
                task.stop();
            });
            logger.info('SCHEDULE', `Stopped ${this.currentTasks.length} tasks`);
            this.currentTasks = [];
        }
        this.isRunning = false;
        
        // 通知前端
        if (this.io) {
            this.io.emit('schedule-updated', {
                enabled: false,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 执行新闻更新（完整流程）
     */
    async executeUpdate() {
        logger.info('SCHEDULE', 'Executing scheduled update...');
        
        try {
            // 通知前端开始更新
            if (this.io) {
                this.io.emit('news-update-started', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString()
                });
            }

            // 1. 获取原始新闻数据（不包含AI去重）
            const articles = await this.newsService.fetchAllNewsWithoutAIDedup();
            logger.info('SCHEDULE', `Fetched ${articles.length} articles.`);
            
            // 2. AI智能去重（在翻译之前进行，节省tokens）
            const AIService = require('../services/aiService');
            const aiService = new AIService(this.io);
            let dedupedArticles = articles;
            if (articles.length > 1) {
                try {
                    dedupedArticles = await aiService.removeDuplicateNewsWithAI(articles);
                    logger.info('SCHEDULE', `Deduplicated articles: ${dedupedArticles.length} remaining.`);
                } catch (error) {
                    logger.error('SCHEDULE', 'AI去重失败，继续使用原始数据', error.message);
                }
            }
            
            // 3. AI增强处理（翻译等）
            const enhancedArticles = await aiService.enhanceNewsArticles(dedupedArticles);
            
            // 4. 保存所有已翻译的新闻到状态管理器
            if (this.stateManager) {
                this.stateManager.set('allEnhancedNews', enhancedArticles);
            } else {
                global.allEnhancedNews = enhancedArticles;
            }
            logger.info('SCHEDULE', `所有已翻译新闻数量: ${enhancedArticles.length}`);
            
            // 5. 限制初始显示新闻数量为30条
            const finalArticles = enhancedArticles.slice(0, 30);
            logger.info('SCHEDULE', `Process complete. Displaying ${finalArticles.length} articles.`);
            
            // 6. 更新数据
            this.newsService.setNewsData(finalArticles);
            this.newsService.setLastUpdated(new Date());
            await this.newsService.saveLocalData(finalArticles);
            logger.info('SCHEDULE', `Saved ${finalArticles.length} articles.`);
            
            // 发送新闻更新完成通知
            if (this.io) {
                this.io.emit('news-updated', {
                    success: true,
                    total: finalArticles.length,
                    lastUpdated: new Date()
                });
            }
            
            // 6. 生成摘要文章
            let summaryArticle = null;
            let podcastResult = null;
            
            try {
                summaryArticle = await aiService.generateNewsSummaryArticle(finalArticles);
                
                // 保存摘要文章到状态管理器
                if (this.stateManager) {
                    this.stateManager.set('summaryArticle', summaryArticle);
                } else {
                    global.summaryArticle = summaryArticle;
                }
                
                // 保存摘要数据到文件
                const config = require('../config');
                const { writeJsonFile } = require('../utils/helpers');
                
                const summaryData = {
                    article: summaryArticle,
                    savedAt: new Date().toISOString(),
                    version: '1.0'
                };
                await writeJsonFile(config.storage.summaryFile, summaryData);
                
                if (this.io) {
                    this.io.emit('summary-completed', {
                        success: true,
                        article: summaryArticle
                    });
                }
                
                logger.info('SCHEDULE', 'Generated summary.');
                
            } catch (error) {
                logger.error('SCHEDULE', '摘要生成失败', error.message);
                if (this.io) {
                    this.io.emit('summary-completed', {
                        success: false,
                        error: error.message
                    });
                }
            }
            
            // 7. 生成音频（独立处理，避免摘要失败影响音频生成）
            try {
                if (finalArticles && finalArticles.length > 0) {
                    const script = await aiService.generatePodcastScript(finalArticles);
                    const AudioService = require('../services/audioService');
                    const audioService = new AudioService(this.io, this.stateManager);
                    
                    // 初始化TTS服务并验证可用性
                    try {
                        await audioService.initializeTTS();
                        logger.info('SCHEDULE', 'TTS服务初始化成功');
                    } catch (ttsError) {
                        logger.error('SCHEDULE', 'TTS服务初始化失败，跳过音频生成', ttsError.message);
                        throw new Error(`TTS服务不可用: ${ttsError.message}`);
                    }
                    
                    podcastResult = await audioService.generatePodcastAudio(script);
                    
                    // 保存播客信息到状态管理器
                    if (this.stateManager) {
                        this.stateManager.set('podcastInfo', podcastResult);
                    } else {
                        global.podcastInfo = podcastResult;
                    }
                    
                    if (this.io) {
                        this.io.emit('podcast-completed', {
                            success: true,
                            podcast: podcastResult
                        });
                    }
                    
                    logger.info('SCHEDULE', 'Generated audio.');
                } else {
                    logger.warn('SCHEDULE', '没有新闻数据，跳过音频生成');
                }
                
            } catch (error) {
                logger.error('SCHEDULE', '音频生成失败', error.message);
                if (this.io) {
                    this.io.emit('podcast-completed', {
                        success: false,
                        error: error.message
                    });
                }
            }
            
            // 通知前端更新完成
            const hasSummary = summaryArticle !== null;
            const hasPodcast = podcastResult !== null;
            const overallSuccess = finalArticles && finalArticles.length > 0;
            
            if (this.io) {
                this.io.emit('news-update-completed', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString(),
                    success: overallSuccess,
                    stats: {
                        newsCount: finalArticles ? finalArticles.length : 0,
                        hasSummary: hasSummary,
                        hasPodcast: hasPodcast
                    }
                });
            }
            
            logger.info('SCHEDULE', 'Update process completed.', {
                newsCount: finalArticles ? finalArticles.length : 0,
                hasSummary: hasSummary,
                hasPodcast: hasPodcast
            });
            
        } catch (error) {
            logger.error('SCHEDULE', '更新流程失败', error.message);
            
            // 通知前端更新失败
            if (this.io) {
                this.io.emit('news-update-failed', {
                    type: 'scheduled',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    /**
     * 将时间字符串转换为每日cron表达式
     * @param {string} time - 时间字符串，格式：HH:MM
     * @returns {string} cron表达式
     */
    parseTimeToDaily(time) {
        const [hour, minute] = time.split(':').map(Number);
        
        if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            logger.warn('SCHEDULE', '无效时间格式，使用默认 08:00', { time });
            return '0 8 * * *';
        }
        
        return `${minute} ${hour} * * *`;
    }

    /**
     * 获取下次执行时间
     * @returns {string} 下次执行时间
     */
    getNextExecutionTime() {
        try {
            // 获取配置的更新时间
            let updateTimes = [];
            
            if (this.currentTasks.length > 0) {
                // 如果有运行的任务，使用任务中的时间
                updateTimes = this.currentTasks.map(task => task.time);
            } else {
                // 如果没有运行的任务，从配置中获取时间
                updateTimes = config.news.updateTimes && config.news.updateTimes.length > 0 
                    ? config.news.updateTimes 
                    : [config.news.updateTime || '08:00'];
            }
            
            if (updateTimes.length === 0) {
                return '未设置';
            }

            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000);
            
            let nextExecution = null;
            
            // 查找今天剩余的执行时间
            for (const time of updateTimes) {
                const [hour, minute] = time.split(':').map(Number);
                if (isNaN(hour) || isNaN(minute)) continue;
                
                const executionTime = new Date(today.getTime() + hour * 60 * 60 * 1000 + minute * 60 * 1000);
                
                if (executionTime > now) {
                    if (!nextExecution || executionTime < nextExecution) {
                        nextExecution = executionTime;
                    }
                }
            }
            
            // 如果今天没有剩余执行时间，查找明天最早的执行时间
            if (!nextExecution) {
                for (const time of updateTimes) {
                    const [hour, minute] = time.split(':').map(Number);
                    if (isNaN(hour) || isNaN(minute)) continue;
                    
                    const executionTime = new Date(tomorrow.getTime() + hour * 60 * 60 * 1000 + minute * 60 * 1000);
                    
                    if (!nextExecution || executionTime < nextExecution) {
                        nextExecution = executionTime;
                    }
                }
            }
            
            return nextExecution ? nextExecution.toISOString() : '无法计算';
        } catch (error) {
            logger.error('SCHEDULE', '计算下次执行时间失败', error.message);
            return '无法计算';
        }
    }

    /**
     * 获取当前状态
     * @returns {Object} 当前状态信息
     */
    getStatus() {
        const updateTimes = config.news.updateTimes && config.news.updateTimes.length > 0 
            ? config.news.updateTimes 
            : [config.news.updateTime || '08:00'];
            
        return {
            isRunning: this.isRunning,
            enabled: config.news.autoUpdateEnabled,
            updateTimes: updateTimes,
            tasksCount: this.currentTasks.length,
            nextExecution: this.getNextExecutionTime()
        };
    }

    /**
     * 手动触发更新
     */
    async triggerUpdate() {
        logger.info('SCHEDULE', '手动触发更新');
        await this.executeUpdate();
    }

    /**
     * 重新启动定时任务（重新加载配置）
     */
    restart() {
        logger.info('SCHEDULE', '重新启动任务...');
        
        // 先停止现有任务
        this.stop();
        
        // 重新加载配置
        delete require.cache[require.resolve('../config')];
        const newConfig = require('../config');
        Object.assign(config, newConfig);
        
        // 重新启动任务
        this.start();
    }
}

module.exports = ScheduleManager;