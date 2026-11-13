/**
 * 聚核 CoreFeed v2.0 — 软路由端每日定时调度与 GitHub 快照轮询管理器 (utils/schedule_manager.js)
 *
 * 核心职责：
 *   1. 按北京时间 (`Asia/Shanghai`) 设定每日多个快照同步时间点（默认 `08:00`, `12:30`, `19:30`）
 *   2. 定时任务与每 60 分钟后台轮询仅从 GitHub `ag-snapshot/latest.json` 拉取由 Antigravity 客户端大模型精编发布的最新快照；
 *      若远端无更新或网络波动，严格保持本地已有中文精编内容不变，绝不执行本地英文 RSS 抓取或机器翻译回退。
 */
const cron = require('node-cron');
const config = require('../config');
const logger = require('./logger');

class ScheduleManager {
    constructor(newsService, io, stateManager = null, newsAgentService = null, githubSyncManager = null) {
        this.newsService = newsService;
        this.io = io;
        this.stateManager = stateManager;
        this.newsAgentService = newsAgentService;
        this.githubSyncManager = githubSyncManager;
        this.currentTasks = [];
        this.githubSyncTimer = null;
        this.isRunning = false;
    }

    /**
     * 启动定时同步任务
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
            logger.warn('SCHEDULE', '自动定时同步已禁用');
            return;
        }

        const timesToSchedule = Array.isArray(updateTimes) && updateTimes.length > 0
            ? updateTimes
            : ['08:00', '12:30', '19:30'];

        logger.info('SCHEDULE', `定时 GitHub 快照同步计划时间: ${timesToSchedule.join(', ')}`);

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

        // 后台 ETag 轻量轮询定时器（默认 60 分钟，使用 .unref() 确保不阻塞进程退出）
        const githubSyncEnabled = Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true);
        const syncIntervalMinutes = Number(config.githubSync?.intervalMinutes || config.agent?.githubSyncIntervalMinutes || 60);
        if (githubSyncEnabled && this.githubSyncManager && syncIntervalMinutes > 0 && process.env.NODE_ENV !== 'test') {
            this.githubSyncTimer = setInterval(async () => {
                try {
                    await this.githubSyncManager.pullAndApply({ force: false, trigger: 'periodic' });
                } catch (err) {
                    logger.debug('SCHEDULE', `后台定期检查 GitHub 快照跳过: ${err.message}`);
                }
            }, syncIntervalMinutes * 60 * 1000);
            if (typeof this.githubSyncTimer.unref === 'function') {
                this.githubSyncTimer.unref();
            }
        }

        if (this.isRunning) {
            logger.success('SCHEDULE', `定时调度器启动成功 (${this.currentTasks.length} 个时间点)`);
            logger.info('SCHEDULE', `下次同步时间: ${this.getNextExecutionTime()}`);
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
        if (this.githubSyncTimer) {
            clearInterval(this.githubSyncTimer);
            this.githubSyncTimer = null;
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
     * 执行定时同步：仅从 GitHub ag-snapshot/latest.json 同步由 Antigravity 大模型发布的最新精编快照
     */
    async executeUpdate() {
        const githubSyncEnabled = Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true);
        if (!githubSyncEnabled || !this.githubSyncManager) {
            logger.info('SCHEDULE', 'GitHub 快照同步未启用，跳过定时拉取');
            return null;
        }

        try {
            const syncResult = await this.githubSyncManager.pullAndApply({ force: false, trigger: 'schedule' });
            if (syncResult && syncResult.applied) {
                logger.success('SCHEDULE', `已通过 GitHub 快照中转同步完成定时更新 (${syncResult.displayedCount} 条新闻, by=${syncResult.publishedBy || 'remote'})`);
                if (this.io) {
                    this.io.emit('news-update-completed', {
                        type: 'scheduled',
                        timestamp: new Date().toISOString(),
                        success: true,
                        stats: {
                            newsCount: syncResult.displayedCount,
                            hasSummary: Boolean(syncResult.hasSummary)
                        }
                    });
                }
                return syncResult;
            }
            logger.info(
                'SCHEDULE',
                `定时检查 GitHub 快照完成：远端暂无更新快照 (${syncResult?.publishedAt || 'unknown'}, reason=${syncResult?.reason || 'up-to-date'})，保持当前中文精编内容不变`
            );
            return syncResult;
        } catch (syncErr) {
            logger.warn('SCHEDULE', `定时从 GitHub 快照拉取失败，保持当前本地快照不变: ${syncErr.message}`);
            return null;
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
        const updateTimes = this.currentTasks.length > 0
            ? this.currentTasks.map(t => t.time)
            : (config.news.updateTimes?.length ? config.news.updateTimes : ['08:00', '12:30', '19:30']);

        return {
            isRunning: this.isRunning,
            enabled: Boolean(config.news.autoUpdateEnabled),
            updateTimes,
            scheduleTimes: updateTimes,
            timezone: config.news.timezone || 'Asia/Shanghai',
            tasksCount: this.currentTasks.length,
            nextExecution: this.getNextExecutionTime(),
            githubSync: this.githubSyncManager ? this.githubSyncManager.getStatus() : null
        };
    }

    restart() {
        this.stop();
        config.reload();
        this.start();
    }
}

module.exports = ScheduleManager;
