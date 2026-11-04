const cron = require('node-cron');
const config = require('../config');
const logger = require('./logger');

/**
 * 定时任务管理器 (CoreFeed v2.0)
 * 定时触发多 Agent 全球知名信源巡检、深度综述生成及 TTS 播客合成
 */
class ScheduleManager {
    constructor(newsService, io, stateManager = null, newsAgentService = null, aiService = null, audioService = null) {
        this.newsService = newsService;
        this.io = io;
        this.stateManager = stateManager;
        this.newsAgentService = newsAgentService;
        this.aiService = aiService;
        this.audioService = audioService;
        this.currentTasks = [];
        this.isRunning = false;
    }

    setServices({ newsAgentService, aiService, audioService }) {
        if (newsAgentService) this.newsAgentService = newsAgentService;
        if (aiService) this.aiService = aiService;
        if (audioService) this.audioService = audioService;
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
                : [config.news.updateTime || '08:00']
        } = settings;

        if (!enabled) {
            logger.warn('SCHEDULE', '自动定时更新已禁用');
            return;
        }

        let timesToSchedule = Array.isArray(updateTimes) && updateTimes.length > 0
            ? updateTimes
            : [config.news.updateTime || '08:00'];

        logger.info('SCHEDULE', `定时 Agent 巡检任务计划时间: ${timesToSchedule.join(', ')}`);

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
     * 执行完整定时更新流程 (Agent 巡检 -> 编译 -> 深度综述 -> 播客合成与 FTP 上传)
     */
    async executeUpdate() {
        logger.info('SCHEDULE', '开始执行定时 Agent 全球新闻巡检与整合流程...');

        try {
            if (this.io) {
                this.io.emit('news-update-started', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString()
                });
            }

            const AIService = require('../services/ai_service');
            const AudioService = require('../services/audio_service');
            const NewsAgentService = require('../services/news_agent_service');

            const aiService = this.aiService || new AIService(this.io, this.stateManager);
            const audioService = this.audioService || new AudioService(this.io, this.stateManager);
            const agentService = this.newsAgentService || new NewsAgentService(this.io, this.stateManager, aiService, this.newsService);

            // 1-4: 执行多 Agent 巡检、聚类、深读、编译与深度综述生成
            const patrolResult = await agentService.runGlobalPatrolPipeline({
                generateSummary: true
            });

            const finalArticles = patrolResult.news || [];
            const summaryArticle = patrolResult.summaryArticle || null;
            let podcastResult = null;

            // 5: 独立生成 TTS 播客并上传 FTP
            if (finalArticles.length > 0) {
                try {
                    const script = await aiService.generatePodcastScript(finalArticles);
                    await audioService.initializeTTS();
                    podcastResult = await audioService.generatePodcastAudio(script);

                    if (this.stateManager) {
                        this.stateManager.set('podcastInfo', podcastResult);
                    }
                    if (this.io) {
                        this.io.emit('podcast-completed', {
                            success: true,
                            podcast: podcastResult
                        });
                    }
                } catch (audioErr) {
                    logger.warn('SCHEDULE', `定时播客合成跳过: ${audioErr.message}`);
                }
            }

            if (this.io) {
                this.io.emit('news-update-completed', {
                    type: 'scheduled',
                    timestamp: new Date().toISOString(),
                    success: finalArticles.length > 0,
                    stats: {
                        newsCount: finalArticles.length,
                        hasSummary: Boolean(summaryArticle),
                        hasPodcast: Boolean(podcastResult)
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
                : (config.news.updateTimes?.length ? config.news.updateTimes : [config.news.updateTime || '08:00']);

            if (!updateTimes.length) return '未设置';

            const now = new Date();
            const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const tomorrow = new Date(today.getTime() + 86400000);

            let nextExecution = null;

            for (const time of updateTimes) {
                const [hour, minute] = time.split(':').map(Number);
                if (isNaN(hour) || isNaN(minute)) continue;
                const execTime = new Date(today.getTime() + hour * 3600000 + minute * 60000);
                if (execTime > now && (!nextExecution || execTime < nextExecution)) {
                    nextExecution = execTime;
                }
            }

            if (!nextExecution) {
                for (const time of updateTimes) {
                    const [hour, minute] = time.split(':').map(Number);
                    if (isNaN(hour) || isNaN(minute)) continue;
                    const execTime = new Date(tomorrow.getTime() + hour * 3600000 + minute * 60000);
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
            : [config.news.updateTime || '08:00'];

        return {
            isRunning: this.isRunning,
            enabled: config.news.autoUpdateEnabled,
            updateTimes,
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
