/**
 * CoreFeed v2.0 — GitHub 快照中转同步模块 (utils/github_sync.js)
 *
 * 解决拓扑 2B（云端沙箱 Antigravity 无法直接访问局域网软路由 10.10.20.10:3120，且软路由无公网 IP）：
 *   1. 发布端 (`publishSnapshotToGitHub`)：
 *      使用 Git 底层 Plumbing 命令 (`hash-object` -> `mktree` -> `commit-tree` -> `update-ref` -> `push --force`)
 *      将精编完成的脱敏数据包 (`news`, `allEnhancedNews`, `summary`, `publishedAt`) 作为单文件孤儿提交 (orphan commit)
 *      推送至 `ag-snapshot` 分支下的 `latest.json`，全程不触碰 `HEAD`、`.git/index` 或 `main` 分支工作区。
 *   2. 软路由拉取端 (`GitHubSyncManager` & `applySnapshotToRouter`)：
 *      软路由容器无需安装 `git` 或配置凭据，直接通过 HTTPS 拉取 `GITHUB_SNAPSHOT_URL`（内置防缓存参数与多源加速回退），
 *      比对 `publishedAt` 时间戳防重后，自动更新内存 `stateManager`、持久化写入 `/opt/corefeed/data/{news,summary,state}.json`，
 *      并通过 Socket.IO 实时向全站前端广播。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const axios = require('axios');
const { execFileSync } = require('child_process');
const config = require('../config');
const logger = require('./logger');
const { writeJsonFile } = require('./helpers');

const syncHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

/**
 * 使用 Git Plumbing 命令将精编快照写入独立分支 (默认 ag-snapshot) 的 latest.json 并推送到远端仓库
 * 不切换当前分支、不污染工作区或暂存区、不产生历史提交膨胀
 */
function publishSnapshotToGitHub(snapshotPayload, options = {}) {
    if (!snapshotPayload || typeof snapshotPayload !== 'object') {
        throw new Error('snapshotPayload 必须是非空对象');
    }
    const newsList = Array.isArray(snapshotPayload.news)
        ? snapshotPayload.news
        : (Array.isArray(snapshotPayload.articles) ? snapshotPayload.articles : []);
    if (newsList.length === 0) {
        throw new Error('snapshotPayload.news 不能为空数组');
    }

    const repoDir = options.repoDir || path.resolve(__dirname, '..');
    const remote = String(
        options.remote ||
        process.env.AG_GITHUB_REMOTE ||
        config.githubSync?.remote ||
        config.agent?.githubRemote ||
        'origin'
    ).trim();
    const branch = String(
        options.branch ||
        process.env.AG_GITHUB_BRANCH ||
        config.githubSync?.branch ||
        config.agent?.githubBranch ||
        'ag-snapshot'
    ).trim();
    const fileName = String(options.fileName || 'latest.json').trim();
    const skipPush = Boolean(options.skipPush);

    const publishedAt = snapshotPayload.publishedAt || snapshotPayload.lastUpdated || new Date().toISOString();
    const normalizedPayload = {
        version: '2.0',
        publishedAt,
        lastUpdated: snapshotPayload.lastUpdated || publishedAt,
        displayedCount: newsList.length,
        totalPoolCount: Array.isArray(snapshotPayload.allEnhancedNews)
            ? snapshotPayload.allEnhancedNews.length
            : newsList.length,
        ...snapshotPayload
    };

    const jsonContent = JSON.stringify(normalizedPayload, null, 2) + '\n';

    if (options.snapshotOut) {
        const outPath = path.resolve(options.snapshotOut);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, jsonContent, 'utf8');
    }

    const gitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'CoreFeed Bot',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'bot@corefeed.local',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'CoreFeed Bot',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'bot@corefeed.local'
    };

    const runGit = (args, input = undefined) => {
        return execFileSync('git', args, {
            cwd: repoDir,
            input,
            encoding: 'utf8',
            env: gitEnv,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
    };

    // 1. 写入 Git Blob 对象
    const blobSha = runGit(['hash-object', '-w', '--stdin'], jsonContent);

    // 2. 构建仅包含 latest.json 的单文件 Git Tree 对象
    const treeEntry = `100644 blob ${blobSha}\t${fileName}\n`;
    const treeSha = runGit(['mktree'], treeEntry);

    // 3. 创建无父节点的孤儿 Commit 对象，保持快照分支永远只有 1 个最新提交
    const commitMessage = `chore(snapshot): publish CoreFeed compiled snapshot (${publishedAt})`;
    const commitSha = runGit(['commit-tree', treeSha, '-m', commitMessage]);

    // 4. 更新本地引用 refs/heads/<branch>
    runGit(['update-ref', `refs/heads/${branch}`, commitSha]);

    // 5. 推送至远端仓库分支
    if (!skipPush) {
        runGit(['push', '--force', remote, `${commitSha}:refs/heads/${branch}`]);
    }

    return {
        success: true,
        branch,
        remote,
        fileName,
        blobSha,
        treeSha,
        commitSha,
        pushed: !skipPush,
        publishedAt,
        rawUrl: config.githubSync?.snapshotUrl || config.agent?.githubSnapshotUrl
    };
}

/**
 * 将快照数据标准化并应用至软路由内存状态 (stateManager)、磁盘文件 (data/{news,summary,state}.json) 与 WebSocket 广播
 */
async function applySnapshotToRouter(
    snapshot,
    { stateManager, newsAgentService, aiService, newsService, io, sourceLabel = 'GitHub 快照中转同步' } = {}
) {
    const rawNews = Array.isArray(snapshot?.news)
        ? snapshot.news
        : (Array.isArray(snapshot?.articles) ? snapshot.articles : null);

    if (!Array.isArray(rawNews) || rawNews.length === 0) {
        const err = new Error('推送或拉取的 news 数组不能为空');
        err.statusCode = 400;
        throw err;
    }

    const allEnhancedNews = snapshot.allEnhancedNews || null;
    const summaryArticle = snapshot.summaryArticle || snapshot.summary || null;
    const summaryMarkdown = snapshot.summaryMarkdown || null;
    const sourceStats = snapshot.sourceStats || [];
    const rawTimestamp = snapshot.publishedAt || snapshot.lastUpdated || null;

    const parsedDate = rawTimestamp ? new Date(rawTimestamp) : new Date();
    const timestamp = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const nowIso = timestamp.toISOString();

    const normalizeArticle = (item, idx) => {
        const rawTitle = String(item?.title || item?.translatedTitle || `News #${idx + 1}`).trim();
        const zhTitle = String(item?.translatedTitle || rawTitle).trim();
        const rawDesc = String(
            item?.description || item?.summary || item?.translatedDescription || item?.content || rawTitle
        ).trim();
        const zhSummary = String(item?.summary || item?.translatedDescription || rawDesc).trim();
        const sourceObj = (item?.source && typeof item.source === 'object')
            ? { ...item.source, name: String(item.source.name || 'Global Media').trim() }
            : {
                id: 'external',
                name: String(item?.source || item?.sourceName || 'Global Media').trim(),
                strategy: 'agent_publish'
            };
        const relatedSources = Array.isArray(item?.relatedSources) ? item.relatedSources : [];
        const keyPoints = Array.isArray(item?.keyPoints) ? item.keyPoints.filter(Boolean).map(String) : [];
        const region = item?.region || (aiService
            ? aiService.determineNewsRegionSync(`${rawTitle} ${zhTitle}`, `${rawDesc} ${zhSummary}`, sourceObj.name, '国际')
            : '国际');
        const category = item?.category || (aiService
            ? aiService.determineNewsCategorySync(`${rawTitle} ${zhTitle}`, `${rawDesc} ${zhSummary}`, sourceObj.category || '', '国际')
            : '国际');

        return {
            ...item,
            id: item?.id || `ag-${Date.now()}-${idx + 1}`,
            title: rawTitle,
            translatedTitle: zhTitle,
            description: rawDesc,
            translatedDescription: zhSummary,
            summary: zhSummary,
            content: String(item?.content || item?.fullTextContent || rawDesc).trim(),
            fullTextContent: item?.fullTextContent || null,
            url: item?.url || '',
            urlToImage: item?.urlToImage || null,
            publishedAt: item?.publishedAt || nowIso,
            processedAt: item?.processedAt || nowIso,
            region,
            category,
            keyPoints,
            aiCompiled: item?.aiCompiled !== undefined ? Boolean(item.aiCompiled) : true,
            qualityScore: Number(item?.qualityScore) || 88,
            source: sourceObj,
            relatedSources,
            sourceCount: Number(item?.sourceCount) || (1 + relatedSources.length)
        };
    };

    const normalizedNews = rawNews.filter(Boolean).map((item, idx) => normalizeArticle(item, idx));
    if (normalizedNews.length === 0) {
        const err = new Error('推送或拉取的 news 数组不包含有效新闻对象');
        err.statusCode = 400;
        throw err;
    }

    const normalizedFullPool = Array.isArray(allEnhancedNews) && allEnhancedNews.length > 0
        ? allEnhancedNews.filter(Boolean).map((item, idx) => normalizeArticle(item, idx))
        : normalizedNews;
    const normalizedStats = Array.isArray(sourceStats) ? sourceStats : [];

    // 1. 同步更新 NewsService、StateManager、写入 data/news.json 并广播 news-updated
    if (newsAgentService) {
        newsAgentService.lastSourceStats = normalizedStats;
        await newsAgentService._publishNewsSnapshot(
            normalizedNews,
            normalizedFullPool,
            normalizedStats,
            timestamp,
            'completed'
        );
    } else if (newsService && stateManager) {
        await newsService.saveLocalData(normalizedNews);
        stateManager.set('collectionPhase', 'completed', false);
        stateManager.set('sourceStats', normalizedStats, false);
        stateManager.updateNewsData(normalizedNews, normalizedFullPool);
    }

    if (stateManager) {
        stateManager.set('lastUpdated', nowIso, false);
    }

    // 2. 处理并持久化今日深度综述 (支持完整对象、仅含 content 的对象或 Markdown 字符串)
    let finalSummary = null;
    const currentDate = timestamp.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'Asia/Shanghai'
    });

    const rawMdInput = typeof summaryArticle === 'string'
        ? summaryArticle.trim()
        : (typeof summaryMarkdown === 'string' ? summaryMarkdown.trim() : '');

    if (rawMdInput && aiService) {
        const firstLine = rawMdInput.split('\n').map(l => l.trim()).find(Boolean) || '';
        const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
            ? `${currentDate} 全球要闻深度综述\n\n${rawMdInput}`
            : rawMdInput;
        finalSummary = aiService.createSummaryArticleObject(mdWithTitle, normalizedNews, currentDate);
    } else if (summaryArticle && typeof summaryArticle === 'object') {
        const rawBody = String(summaryArticle.content || summaryArticle.markdown || '').trim();
        const normalizedBody = rawBody
            ? rawBody.split('\n').map(l => l.trim()).filter(Boolean).join('\n\n')
            : '';
        const needsCitationRender = normalizedBody.includes('[NEWS_') &&
            (!summaryArticle.htmlContent || !String(summaryArticle.htmlContent).includes('news-ref-link'));
        const htmlContent = (!needsCitationRender && summaryArticle.htmlContent)
            ? summaryArticle.htmlContent
            : ((normalizedBody && aiService) ? aiService.convertSummaryToRichHtml(normalizedBody, normalizedNews) : (summaryArticle.htmlContent || ''));

        if (htmlContent || normalizedBody) {
            const plainForSummary = normalizedBody.replace(/\[NEWS_\d+\]/g, '').replace(/#+\s*/g, '');
            finalSummary = {
                title: summaryArticle.title || `${currentDate} 全球要闻深度综述`,
                content: normalizedBody || rawBody,
                htmlContent,
                newsCount: Number(summaryArticle.newsCount) || normalizedNews.length,
                regions: Array.isArray(summaryArticle.regions) && summaryArticle.regions.length > 0
                    ? summaryArticle.regions
                    : [...new Set(normalizedNews.map(n => n.region || '国际'))],
                generatedAt: summaryArticle.generatedAt || nowIso,
                summary: summaryArticle.summary || plainForSummary.slice(0, 160),
                wordCount: Number(summaryArticle.wordCount) || (normalizedBody || htmlContent).length
            };
        }
    }

    if (finalSummary) {
        if (stateManager) {
            stateManager.updateSummaryArticle(finalSummary);
        }
        await writeJsonFile(config.storage.summaryFile, {
            article: finalSummary,
            savedAt: new Date().toISOString(),
            version: '2.0'
        });
        if (io) {
            io.emit('summary-completed', {
                success: true,
                article: finalSummary
            });
        }
    }

    // 3. 立即将内存状态持久化至 data/state.json，防止 5 分钟定时器覆盖
    if (stateManager) {
        await stateManager.saveToFile();
    }

    if (newsAgentService && typeof newsAgentService.emitAgentEvent === 'function') {
        newsAgentService.emitAgentEvent(
            sourceLabel,
            'completed',
            `已同步发布 ${normalizedNews.length} 条精选新闻${finalSummary ? '及今日全球要闻深度综述' : ''}`,
            { progress: 100, current: normalizedNews.length, total: normalizedFullPool.length }
        );
    }

    return {
        success: true,
        displayedCount: normalizedNews.length,
        totalPoolCount: normalizedFullPool.length,
        hasSummary: Boolean(finalSummary),
        publishedAt: nowIso,
        lastUpdated: nowIso
    };
}

/**
 * 软路由端 GitHub 快照拉取与同步管理器
 */
class GitHubSyncManager {
    constructor(services = {}, io = null, stateManager = null) {
        this.services = services;
        this.io = io;
        this.stateManager = stateManager;
        this.isSyncing = false;
        this.lastSyncCheckAt = null;
        this.lastSyncedAt = null;
        this.lastSyncedPublishedAt = null;
        this.lastSyncStatus = 'idle';
        this.lastSyncError = null;
        this.lastSyncSourceUrl = null;
    }

    buildCandidateEndpoints(primaryUrl) {
        const cleanUrl = String(primaryUrl || '').trim();
        const endpoints = [{ url: cleanUrl, headers: {} }];

        const rawMatch = cleanUrl.match(
            /^https:\/\/raw\.githubusercontent\.com\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^?#]+)$/
        );
        if (rawMatch) {
            const [, owner, repo, branch, filePath] = rawMatch;
            endpoints.push({
                url: `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
                headers: {
                    Accept: 'application/vnd.github.v3.raw'
                }
            });
            endpoints.push({
                url: `https://ghfast.top/${cleanUrl}`,
                headers: {}
            });
        }

        return endpoints;
    }

    async fetchRemoteSnapshot(customSnapshotUrl = null) {
        const targetUrl = String(
            customSnapshotUrl ||
            process.env.GITHUB_SNAPSHOT_URL ||
            config.githubSync?.snapshotUrl ||
            config.agent?.githubSnapshotUrl ||
            'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
        ).trim();

        if (!targetUrl) {
            const err = new Error('未配置 GITHUB_SNAPSHOT_URL');
            err.statusCode = 400;
            throw err;
        }

        const candidates = this.buildCandidateEndpoints(targetUrl);
        let lastError = null;

        for (const candidate of candidates) {
            const sep = candidate.url.includes('?') ? '&' : '?';
            const requestUrl = `${candidate.url}${sep}_t=${Date.now()}`;
            try {
                const response = await axios.get(requestUrl, {
                    timeout: 15000,
                    httpsAgent: syncHttpsAgent,
                    responseType: 'json',
                    headers: {
                        'Cache-Control': 'no-cache, no-store, must-revalidate',
                        'Pragma': 'no-cache',
                        'User-Agent': 'CoreFeed-Router-Sync/2.0',
                        ...candidate.headers
                    }
                });

                let parsed = response.data;
                if (typeof parsed === 'string') {
                    parsed = JSON.parse(parsed);
                }

                if (!parsed || typeof parsed !== 'object') {
                    const schemaErr = new Error('远端快照返回内容不是有效的 JSON 对象');
                    schemaErr.statusCode = 400;
                    throw schemaErr;
                }

                return {
                    data: parsed,
                    sourceUrl: candidate.url
                };
            } catch (err) {
                lastError = err;
                if (err.statusCode === 400) {
                    throw err;
                }
            }
        }

        const finalErr = new Error(lastError?.message || `无法从 ${targetUrl} 拉取快照`);
        finalErr.statusCode = lastError?.statusCode || 502;
        throw finalErr;
    }

    async pullAndApply(options = {}) {
        const {
            snapshotUrl = null,
            force = false,
            trigger = 'manual'
        } = options;

        if (this.isSyncing && !force) {
            return {
                success: true,
                updated: false,
                applied: false,
                skipped: true,
                reason: 'sync-in-progress',
                trigger
            };
        }

        this.isSyncing = true;
        this.lastSyncCheckAt = new Date().toISOString();

        try {
            const { data, sourceUrl } = await this.fetchRemoteSnapshot(snapshotUrl);
            const newsList = Array.isArray(data?.news)
                ? data.news
                : (Array.isArray(data?.articles) ? data.articles : null);

            if (!Array.isArray(newsList) || newsList.length === 0) {
                const invalidErr = new Error('GitHub 快照中不包含有效的 news 数组');
                invalidErr.statusCode = 400;
                throw invalidErr;
            }

            const remotePublishedAt = data.publishedAt || data.lastUpdated || null;
            const remoteMs = remotePublishedAt ? new Date(remotePublishedAt).getTime() : 0;
            const currentNews = this.stateManager ? (this.stateManager.get('newsData') || []) : [];
            const stateLastUpdated = this.stateManager ? this.stateManager.get('lastUpdated') : null;
            const lastKnownTime = stateLastUpdated
                ? Math.max(
                    this.lastSyncedPublishedAt ? new Date(this.lastSyncedPublishedAt).getTime() : 0,
                    new Date(stateLastUpdated).getTime()
                )
                : 0;

            if (
                !force &&
                currentNews.length > 0 &&
                remoteMs > 0 &&
                !isNaN(remoteMs) &&
                !isNaN(lastKnownTime) &&
                remoteMs <= lastKnownTime
            ) {
                this.lastSyncStatus = 'up-to-date';
                this.lastSyncError = null;
                this.lastSyncSourceUrl = sourceUrl;
                return {
                    success: true,
                    updated: false,
                    applied: false,
                    skipped: true,
                    reason: 'already-up-to-date',
                    trigger,
                    snapshotUrl: sourceUrl,
                    publishedAt: remotePublishedAt,
                    lastUpdated: stateLastUpdated || remotePublishedAt,
                    displayedCount: currentNews.length
                };
            }

            const applied = await applySnapshotToRouter(data, {
                stateManager: this.stateManager,
                newsAgentService: this.services.newsAgentService,
                aiService: this.services.aiService,
                newsService: this.services.newsService,
                io: this.io,
                sourceLabel: 'GitHub 快照中转同步'
            });

            this.lastSyncedAt = new Date().toISOString();
            this.lastSyncedPublishedAt = remotePublishedAt || applied.lastUpdated;
            this.lastSyncStatus = 'synced';
            this.lastSyncError = null;
            this.lastSyncSourceUrl = sourceUrl;

            return {
                success: true,
                updated: true,
                applied: true,
                skipped: false,
                trigger,
                snapshotUrl: sourceUrl,
                ...applied
            };
        } catch (err) {
            this.lastSyncStatus = 'error';
            this.lastSyncError = err.message;
            throw err;
        } finally {
            this.isSyncing = false;
        }
    }

    getStatus() {
        return {
            enabled: Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true),
            snapshotUrl:
                process.env.GITHUB_SNAPSHOT_URL ||
                config.githubSync?.snapshotUrl ||
                config.agent?.githubSnapshotUrl ||
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json',
            branch:
                process.env.AG_GITHUB_BRANCH ||
                config.githubSync?.branch ||
                config.agent?.githubBranch ||
                'ag-snapshot',
            intervalMinutes: Number(
                config.githubSync?.intervalMinutes || config.agent?.githubSyncIntervalMinutes || 15
            ),
            isSyncing: this.isSyncing,
            lastSyncCheckAt: this.lastSyncCheckAt,
            lastSyncedAt: this.lastSyncedAt,
            lastSyncedPublishedAt: this.lastSyncedPublishedAt,
            lastSyncStatus: this.lastSyncStatus,
            lastSyncError: this.lastSyncError,
            lastSyncSourceUrl: this.lastSyncSourceUrl
        };
    }
}

module.exports = {
    publishSnapshotToGitHub,
    applySnapshotToRouter,
    GitHubSyncManager
};
