/**
 * 聚核 CoreFeed v2.0 — 软路由端每日定时调度与 GitHub 快照轮询管理器 (utils/schedule_manager.js)
 *
 * 核心职责：
 *   1. 按北京时间 (`Asia/Shanghai`) 设定每日多个快照同步时间点（默认 `08:00`, `12:30`, `19:30`）
 *   2. 定时任务与每 60 分钟后台轮询仅从 GitHub `ag-snapshot/manifest.json` 增量拉取由 Antigravity 客户端大模型精编发布的最新快照；
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
                : ['08:00', '12:30', '19:30'],
            timezone = config.news.timezone || 'Asia/Shanghai',
            allowPeriodicInTest = false
        } = settings;

        const timesToSchedule = Array.isArray(updateTimes) && updateTimes.length > 0
            ? updateTimes
            : ['08:00', '12:30', '19:30'];

        if (!enabled) {
            logger.warn('SCHEDULE', '每日固定时间点定时同步已禁用（后台定期增量轮询仍由 GITHUB_SYNC_ENABLED 独立控制）');
        } else {
            logger.info('SCHEDULE', `定时 GitHub 快照同步计划时间 (${timezone}): ${timesToSchedule.join(', ')}`);

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
                        timezone,
                        noOverlap: true
                    }
                );

                this.currentTasks.push({
                    task,
                    time,
                    cronExpression,
                    timezone
                });
            }
        }

        this.isRunning = this.currentTasks.length > 0;

        // 后台 manifest.json ETag 轻量增量轮询定时器（默认 60 分钟，独立于每日固定 cron 点，使用 .unref() 不阻塞进程退出）
        const githubSyncEnabled = Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true);
        const syncIntervalMinutes = Number(config.githubSync?.intervalMinutes || config.agent?.githubSyncIntervalMinutes || 60);
        if (githubSyncEnabled && this.githubSyncManager && syncIntervalMinutes > 0 && (process.env.NODE_ENV !== 'test' || allowPeriodicInTest)) {
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
            logger.success('SCHEDULE', `定时调度器启动成功 (${this.currentTasks.length} 个时间点, timezone=${timezone})`);
            logger.info('SCHEDULE', `下次同步时间: ${this.getNextExecutionTime()}`);
        }

        if (this.io) {
            this.io.emit('schedule-updated', {
                enabled: this.isRunning,
                updateTimes: timesToSchedule,
                scheduleTimes: timesToSchedule,
                timezone,
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
            this.currentTasks.forEach(({ task }) => {
                if (!task) return;
                try {
                    if (typeof task.stop === 'function') task.stop();
                } catch (_) {}
                try {
                    if (typeof task.destroy === 'function') task.destroy();
                } catch (_) {}
            });
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
     * 执行定时同步：仅从 GitHub ag-snapshot/manifest.json 增量同步由 Antigravity 大模型发布的最新精编快照
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

    _computeNextRunInTimezone(timeStr, timezone, now = new Date()) {
        const [hour, minute] = String(timeStr || '').split(':').map(Number);
        if (isNaN(hour) || isNaN(minute)) return null;
        const tz = timezone || 'Asia/Shanghai';

        // 使用 Intl.DateTimeFormat 计算目标时区当前年月日及 UTC 偏移（支持任意 IANA 时区）
        const getTzParts = (dateObj) => {
            const fmt = new Intl.DateTimeFormat('en-US', {
                timeZone: tz,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            const map = {};
            for (const part of fmt.formatToParts(dateObj)) {
                if (part.type !== 'literal') map[part.type] = Number(part.value);
            }
            return {
                year: map.year,
                month: map.month,
                day: map.day,
                hour: map.hour === 24 ? 0 : map.hour,
                minute: map.minute,
                second: map.second
            };
        };

        const toUtcForLocal = (year, month, day, h, m) => {
            const guessUtcMs = Date.UTC(year, month - 1, day, h, m, 0, 0);
            const observed = getTzParts(new Date(guessUtcMs));
            const observedAsUtcMs = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second, 0);
            const offsetMs = observedAsUtcMs - guessUtcMs;
            return new Date(guessUtcMs - offsetMs);
        };

        const cur = getTzParts(now);
        let candidate = toUtcForLocal(cur.year, cur.month, cur.day, hour, minute);
        if (candidate <= now) {
            const nextDayAnchor = new Date(Date.UTC(cur.year, cur.month - 1, cur.day + 1, 12, 0, 0));
            const nextDay = getTzParts(nextDayAnchor);
            candidate = toUtcForLocal(nextDay.year, nextDay.month, nextDay.day, hour, minute);
        }
        return candidate;
    }

    getNextExecutionTime() {
        try {
            // 优先使用 node-cron v4 原生 task.getNextRun()
            let earliest = null;
            for (const item of this.currentTasks) {
                if (item.task && typeof item.task.getNextRun === 'function') {
                    const nextDt = item.task.getNextRun();
                    if (nextDt instanceof Date && !isNaN(nextDt.getTime())) {
                        if (!earliest || nextDt < earliest) {
                            earliest = nextDt;
                        }
                    }
                }
            }
            if (earliest) {
                return earliest.toISOString();
            }

            const updateTimes = this.currentTasks.length > 0
                ? this.currentTasks.map(t => t.time)
                : (config.news.updateTimes?.length ? config.news.updateTimes : ['08:00', '12:30', '19:30']);
            if (!updateTimes.length) return '未设置';

            const timezone = (this.currentTasks[0] && this.currentTasks[0].timezone) || config.news.timezone || 'Asia/Shanghai';
            const now = new Date();
            let nextExecution = null;
            for (const time of updateTimes) {
                const candidate = this._computeNextRunInTimezone(time, timezone, now);
                if (candidate && (!nextExecution || candidate < nextExecution)) {
                    nextExecution = candidate;
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
