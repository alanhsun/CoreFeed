/**
 * 聚核 CoreFeed v2.0 — 每日定时调度与 GitHub 快照轮询管理器 (utils/schedule_manager.js)
 *
 * 核心职责：
 *   1. 按北京时间 (`Asia/Shanghai`) 设定每日多个同步时间点（默认 `08:00`, `12:30`, `19:30`）
 *   2. 方案 2B 模式下：定时任务与每 60 分钟后台轮询从 GitHub `ag-snapshot/latest.json` 拉取最新精编快照；
 *      若远端无更新或网络波动，保持本地已发布的中文精编内容不变
 *   3. 单机模式下：触发 `NewsAgentService.runGlobalPatrolPipeline` 采集并编译
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cron = require('node-cron');
const config = require('../config');
const logger = require('./logger');
const { publishSnapshotToGitHub } = require('./github_sync');

class ScheduleManager {
    constructor(newsService, io, stateManager = null, newsAgentService = null, aiService = null, githubSyncManager = null) {
        this.newsService = newsService;
        this.io = io;
        this.stateManager = stateManager;
        this.newsAgentService = newsAgentService;
        this.aiService = aiService;
        this.githubSyncManager = githubSyncManager;
        this.currentTasks = [];
        this.githubSyncTimer = null;
        this.isRunning = false;
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

        // 若启用了 GitHub 快照中转同步，启动后台轮询定时器（默认 60 分钟，使用 .unref() 确保不阻塞进程退出）
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
     * 执行完整定时更新流程
     * 方案 2B (默认开启 GITHUB_SYNC_ENABLED)：仅从 GitHub ag-snapshot/latest.json 同步最新精编快照；
     * 若远端快照暂未更新或网络异常，保持本地已有中文精编快照不变，绝不回退执行本地英文 RSS 抓取覆盖。
     */
    async executeUpdate() {
        const githubSyncEnabled = Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true);
        if (githubSyncEnabled && this.githubSyncManager) {
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
                logger.warn('SCHEDULE', `定时从 GitHub 快照拉取失败，保持当前本地快照不变 (不回退本地 RSS 抓取): ${syncErr.message}`);
                return null;
            }
        }

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
                return null;
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

            // 方案 2B：若当前节点启用了 GitHub 推送且具备本地 Git 仓库，将定时采集结果自动同步至 ag-snapshot 分支
            const pushEnabled = Boolean(config.githubSync?.pushEnabled ?? config.agent?.githubPushEnabled ?? true);
            const repoRoot = path.resolve(__dirname, '..');
            if (finalArticles.length > 0 && pushEnabled && process.env.NODE_ENV !== 'test' && fs.existsSync(path.join(repoRoot, '.git'))) {
                try {
                    const publishedBy = String(
                        process.env.CLIENT_ID ||
                        config.githubSync?.clientId ||
                        config.agent?.clientId ||
                        os.hostname() ||
                        'antigravity-client'
                    ).trim();
                    const allEnhancedNews = (this.stateManager && this.stateManager.get('allEnhancedNews')) || finalArticles;
                    const nowIso = patrolResult.lastUpdated || new Date().toISOString();
                    const ghRes = publishSnapshotToGitHub(
                        {
                            version: '2.0',
                            publishedAt: nowIso,
                            lastUpdated: nowIso,
                            publishedBy,
                            clientId: publishedBy,
                            displayedCount: finalArticles.length,
                            totalPoolCount: allEnhancedNews.length,
                            news: finalArticles,
                            allEnhancedNews,
                            summary: summaryArticle,
                            summaryArticle,
                            sourceStats: patrolResult.sourceStats || []
                        },
                        {
                            repoDir: repoRoot,
                            branch: config.githubSync?.branch || 'ag-snapshot',
                            remote: config.githubSync?.remote || 'origin',
                            publishedBy,
                            clientId: publishedBy
                        }
                    );
                    if (this.stateManager) {
                        this.stateManager.set('lastPublishedBy', publishedBy, false);
                        await this.stateManager.saveToFile();
                    }
                    logger.success('SCHEDULE', `定时巡检结果已自动发布至 GitHub 快照分支 ${ghRes.branch} (commit=${ghRes.commitSha.slice(0, 8)}, by=${publishedBy})`);
                } catch (gitErr) {
                    logger.warn('SCHEDULE', `定时巡检结果推送至 GitHub 快照分支跳过: ${gitErr.message}`);
                }
            }

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
