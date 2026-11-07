const cron = require('node-cron');
const config = require('../config');
const logger = require('./logger');

/**
 * 定时任务管理器 (CoreFeed v2.0)
 * 定时触发全球知名信源巡检、渐进式编译及今日要闻综述生成
 */
class ScheduleManager {
    constructor(newsService, io, stateManager = null, newsAgentService = null, aiService = null) {
        this.newsService = newsService;
        this.io = io;
        this.stateManager = stateManager;
        this.newsAgentService = newsAgentService;
        this.aiService = aiService;
        this.currentTasks = [];
        this.isRunning = false;
    }

    setServices({ newsAgentService, aiService }) {
        if (newsAgentService) this.newsAgentService = newsAgentService;
        if (aiService) this.aiService = aiService;
    }

    /**
     * 启动定时任务
     */
    start(settings = {}) {
        this.stop();

        const {
            enabled = config.news.autoUpdateEnabled,
            updateTimes = config.news.updateTimes && config.news.updateTimes.length > 0
                ? config.news.updateTimes
                : ['08:00', '12:30', '19:30']
        } = settings;

        if (!enabled) {
            logger.warn('SCHEDULE', '自动定时更新已禁用');
            return;
        }

        const timesToSchedule = Array.isArray(updateTimes) && updateTimes.length > 0
            ? updateTimes
            : ['08:00', '12:30', '19:30'];

        logger.info('SCHEDULE', `定时全球新闻采集计划时间: ${timesToSchedule.join(', ')}`);

        for (const time of timesToSchedule) {
            const cronExpression = this.parseTimeToDaily(time);

            if (!cron.validate(cronExpression)) {
                logger.error('SCHEDULE', `无效的 cron 表达式: ${cronExpression}`, { time });
                continue;
            }

            const task = cron.schedule(
                cronExpression,
                async () => {
                    await this.executeUpdate();
                },
                {
                    scheduled: true,
                    timezone: 'Asia/Shanghai'
                }
            );

            this.currentTasks.push({
                task,
                time,
                cronExpression
            });
        }

        this.isRunning = this.currentTasks.length > 0;

        if (this.isRunning) {
            logger.success('SCHEDULE', `定时调度器启动成功 (${this.currentTasks.length} 个时间点)`);
            logger.info('SCHEDULE', `下次执行时间: ${this.getNextExecutionTime()}`);
        }

        if (this.io) {
            this.io.emit('schedule-updated', {
                enabled: this.isRunning,
                updateTimes: timesToSchedule,
                scheduleTimes: timesToSchedule,
                timezone: config.news.timezone || 'Asia/Shanghai',
                nextExecution: this.getNextExecutionTime(),
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 停止所有定时任务
     */
    stop() {
        if (this.currentTasks.length > 0) {
            this.currentTasks.forEach(({ task }) => task.stop());
            this.currentTasks = [];
        }
        this.isRunning = false;

        if (this.io) {
            this.io.emit('schedule-updated', {
                enabled: false,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * 执行完整定时更新流程 (信源采集 -> 聚类即时展示 -> 正文深读与中文编译 -> 今日要闻综述)
     * 内置 10 分钟新鲜度防重守卫：若过去 10 分钟内已通过外部流水线或手动巡检完成发布，则自动跳过本次重复巡检。
     */
    async executeUpdate() {
        if (this.stateManager) {
            const phase = this.stateManager.get('collectionPhase');
            const lastUpdated = this.stateManager.get('lastUpdated');
            const newsData = this.stateManager.get('newsData');
            if (
                phase === 'completed' &&
                lastUpdated &&
                Array.isArray(newsData) &&
                newsData.length > 0 &&
                Date.now() - new Date(lastUpdated).getTime() < 10 * 60 * 1000
            ) {
                logger.info('SCHEDULE', `检测到过去 10 分钟内已完成新鲜发布 (${lastUpdated})，跳过本次重复巡检`);
                return;
            }
        }

        logger.info('SCHEDULE', '开始执行定时全球新闻采集与编译流程...');

        try {
            if (this.io) {
                this.io.emit('news-update-started', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString()
                });
            }

            const AIService = require('../services/ai_service');
            const NewsAgentService = require('../services/news_agent_service');

            const aiService = this.aiService || new AIService(this.io, this.stateManager);
            const agentService = this.newsAgentService || new NewsAgentService(this.io, this.stateManager, aiService, this.newsService);

            const patrolResult = await agentService.runGlobalPatrolPipeline({
                generateSummary: true
            });

            const finalArticles = patrolResult.news || [];
            const summaryArticle = patrolResult.summaryArticle || null;

            if (this.io) {
                this.io.emit('news-update-completed', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString(),
                    success: finalArticles.length > 0,
                    stats: {
                        newsCount: finalArticles.length,
                        hasSummary: Boolean(summaryArticle)
                    }
                });
            }
        } catch (error) {
            logger.error('SCHEDULE', '定时更新流程失败', error.message);
            if (this.io) {
                this.io.emit('news-update-failed', {
                    type: 'scheduled',
                    error: error.message,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    parseTimeToDaily(time) {
        const [hour, minute] = String(time || '08:00').split(':').map(Number);
        if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            return '0 8 * * *';
        }
        return `${minute} ${hour} * * *`;
    }

    getNextExecutionTime() {
        try {
            const updateTimes = this.currentTasks.length > 0
                ? this.currentTasks.map(t => t.time)
                : (config.news.updateTimes?.length ? config.news.updateTimes : ['08:00', '12:30', '19:30']);

            if (!updateTimes.length) return '未设置';

            const now = new Date();
            const shanghaiOffsetMs = 8 * 3600000;
            const shNow = new Date(now.getTime() + shanghaiOffsetMs);
            const shYear = shNow.getUTCFullYear();
            const shMonth = shNow.getUTCMonth();
            const shDate = shNow.getUTCDate();

            let nextExecution = null;

            for (const time of updateTimes) {
                const [hour, minute] = String(time).split(':').map(Number);
                if (isNaN(hour) || isNaN(minute)) continue;
                const execTime = new Date(Date.UTC(shYear, shMonth, shDate, hour - 8, minute, 0, 0));
                if (execTime > now && (!nextExecution || execTime < nextExecution)) {
                    nextExecution = execTime;
                }
            }

            if (!nextExecution) {
                for (const time of updateTimes) {
                    const [hour, minute] = String(time).split(':').map(Number);
                    if (isNaN(hour) || isNaN(minute)) continue;
                    const execTime = new Date(Date.UTC(shYear, shMonth, shDate + 1, hour - 8, minute, 0, 0));
                    if (!nextExecution || execTime < nextExecution) {
                        nextExecution = execTime;
                    }
                }
            }

            return nextExecution ? nextExecution.toISOString() : '无法计算';
        } catch (_) {
            return '无法计算';
        }
    }

    getStatus() {
        const updateTimes = config.news.updateTimes?.length
            ? config.news.updateTimes
            : ['08:00', '12:30', '19:30'];

        return {
            isRunning: this.isRunning,
            enabled: config.news.autoUpdateEnabled,
            updateTimes,
            scheduleTimes: updateTimes,
            timezone: config.news.timezone || 'Asia/Shanghai',
            tasksCount: this.currentTasks.length,
            nextExecution: this.getNextExecutionTime()
        };
    }

    async triggerUpdate() {
        await this.executeUpdate();
    }

    restart() {
        this.stop();
        config.reload();
        this.start();
    }
}

module.exports = ScheduleManager;
