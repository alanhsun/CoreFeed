#!/usr/bin/env node
/**
 * CoreFeed v2.0 — 欧美社媒热议 (Western Social Pulse) 同步与快照合入工具 (scripts/ag-sync-pulse.js)
 *
 * 功能说明：
 *   1. 扫描本机 `欧美社媒热议/data/{digests,topics}/*.json`（或指定 `--file` / `--source-dir`），
 *      经标准化去重后写入 `CoreFeed/data/social_pulse.json` 与 `data/state.json`；
 *   2. 读取当前最新的全球要闻与今日综述（本地 `data/news.json` 或远端 `ag-snapshot/latest.json`），
 *      在不篡改要闻 `publishedAt`（从而不误触发早间 07:40 要闻采编 30 分钟冷却窗口）的前提下，
 *      将最新 `socialPulse` 合入并通过 Git Plumbing 推送至 `origin/ag-snapshot` 分支 `latest.json`；
 *   3. 若目标 CoreFeed 服务端在线，同步调用 `POST /api/agent/publish-pulse` 触发全站 Socket.IO 实时刷新。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const axios = require('axios');
const http = require('http');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');
const { getHttpsAgent } = require('../utils/network_config');
const stateManager = require('../services/state_manager');
const { SocialPulseService, getDefaultExternalPulseDir } = require('../services/social_pulse_service');
const { AudioBroadcastService, normalizeAudioBroadcastBundle } = require('../services/audio_broadcast_service');
const {
    publishSnapshotToGitHub,
    fetchRemoteSnapshotViaGit,
    GitHubSyncManager,
    isLocalNewsPolluted,
    isSuspectedTestFixtureNews
} = require('../utils/github_sync');

const httpAgentNoKeepAlive = new http.Agent({ keepAlive: false });

function resolveDefaultPushToGithub() {
    if (process.env.GITHUB_PUSH_ENABLED !== undefined && process.env.GITHUB_PUSH_ENABLED !== '') {
        const val = String(process.env.GITHUB_PUSH_ENABLED).toLowerCase().trim();
        return val !== 'false' && val !== '0' && val !== 'no';
    }
    if (process.env.AG_GITHUB_SYNC !== undefined && process.env.AG_GITHUB_SYNC !== '') {
        const val = String(process.env.AG_GITHUB_SYNC).toLowerCase().trim();
        return val !== 'false' && val !== '0' && val !== 'no';
    }
    return Boolean(config.githubSync?.pushEnabled ?? config.agent?.githubPushEnabled ?? true);
}

function parsePulseSyncArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const defaultPort = config.server?.port || 3120;
    const defaultGithubSync = resolveDefaultPushToGithub();
    const defaultClientId = String(
        process.env.CLIENT_ID ||
        process.env.AG_CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        os.hostname() ||
        'antigravity-pulse-sync'
    ).trim();

    const options = {
        sourceDir: getDefaultExternalPulseDir(),
        files: [],
        maxIssues: config.socialPulse?.maxIssues || 14,
        target: process.env.COREFEED_SITE_URL || config.agent?.siteUrl || `http://localhost:${defaultPort}`,
        targetExplicit: Boolean(process.env.COREFEED_SITE_URL),
        secret: process.env.PUBLISH_SECRET || process.env.PUBLISH_API_KEY || config.agent?.publishSecret || '',
        localOnly: false,
        pushToGithub: defaultGithubSync,
        githubExplicit: false,
        githubBranch: process.env.AG_GITHUB_BRANCH || config.githubSync?.branch || 'ag-snapshot',
        githubRemote: process.env.AG_GITHUB_REMOTE || config.githubSync?.remote || 'origin',
        clientId: defaultClientId,
        publishedBy: defaultClientId,
        repoDir: null,
        skipGitPush: false,
        snapshotOut: null
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if ((arg === '--source-dir' || arg === '--workspace') && argv[i + 1]) {
            options.sourceDir = path.resolve(argv[++i]);
        } else if (arg.startsWith('--source-dir=') || arg.startsWith('--workspace=')) {
            options.sourceDir = path.resolve(eqVal(arg));
        } else if ((arg === '--file' || arg === '--digest') && argv[i + 1]) {
            options.files.push(path.resolve(argv[++i]));
        } else if (arg.startsWith('--file=') || arg.startsWith('--digest=')) {
            options.files.push(path.resolve(eqVal(arg)));
        } else if (arg === '--max-issues' && argv[i + 1]) {
            options.maxIssues = Math.max(1, parseInt(argv[++i], 10) || 14);
        } else if (arg.startsWith('--max-issues=')) {
            options.maxIssues = Math.max(1, parseInt(eqVal(arg), 10) || 14);
        } else if ((arg === '--target' || arg === '--site' || arg === '--url') && argv[i + 1]) {
            options.target = argv[++i];
            options.targetExplicit = true;
        } else if (arg.startsWith('--target=') || arg.startsWith('--site=') || arg.startsWith('--url=')) {
            options.target = eqVal(arg);
            options.targetExplicit = true;
        } else if (arg === '--secret' && argv[i + 1] !== undefined) {
            options.secret = argv[++i];
        } else if (arg.startsWith('--secret=')) {
            options.secret = eqVal(arg);
        } else if (arg === '--local-only' || arg === '--no-push') {
            options.localOnly = true;
        } else if (arg === '--github' || arg === '--github-sync') {
            options.pushToGithub = true;
            options.githubExplicit = true;
        } else if (arg === '--no-github' || arg === '--no-github-sync') {
            options.pushToGithub = false;
            options.githubExplicit = true;
        } else if (arg === '--github-branch' && argv[i + 1]) {
            options.githubBranch = argv[++i];
        } else if (arg.startsWith('--github-branch=')) {
            options.githubBranch = eqVal(arg);
        } else if (arg === '--github-remote' && argv[i + 1]) {
            options.githubRemote = argv[++i];
        } else if (arg.startsWith('--github-remote=')) {
            options.githubRemote = eqVal(arg);
        } else if ((arg === '--client-id' || arg === '--published-by') && argv[i + 1]) {
            const val = String(argv[++i]).trim();
            if (val) {
                options.clientId = val;
                options.publishedBy = val;
            }
        } else if (arg.startsWith('--client-id=') || arg.startsWith('--published-by=')) {
            const val = String(eqVal(arg)).trim();
            if (val) {
                options.clientId = val;
                options.publishedBy = val;
            }
        } else if (arg === '--snapshot-out' && argv[i + 1]) {
            options.snapshotOut = path.resolve(argv[++i]);
        } else if (arg.startsWith('--snapshot-out=')) {
            options.snapshotOut = path.resolve(eqVal(arg));
        }
    }

    return options;
}

async function resolveBaseNewsSnapshot(opts = {}, { preferGit = false, includeMeta = false } = {}) {
    const localNewsDoc = await readJsonFile(config.storage.newsFile, null);
    const localSummaryDoc = await readJsonFile(config.storage.summaryFile, null);
    const localStateDoc = await readJsonFile(config.storage.stateFile, null);

    const localNews = Array.isArray(localNewsDoc?.news) && localNewsDoc.news.length > 0
        ? localNewsDoc.news
        : (Array.isArray(localStateDoc?.newsData) && localStateDoc.newsData.length > 0 ? localStateDoc.newsData : []);

    let localCandidate = null;
    if (localNews.length > 0) {
        const localInvalid = isLocalNewsPolluted(localNews) || isSuspectedTestFixtureNews(localNews);
        if (localInvalid) {
            logger.warn('AG-PULSE', '检测到本地 data/news.json 含有测试夹具或未精编数据，将跳过本地基础要闻并优先使用远端快照');
        } else {
            const allEnhancedNews = Array.isArray(localStateDoc?.allEnhancedNews) && localStateDoc.allEnhancedNews.length >= localNews.length
                ? localStateDoc.allEnhancedNews
                : localNews;
            const summaryArticle = localSummaryDoc?.article || localStateDoc?.summaryArticle || null;
            const sourceStats = Array.isArray(localStateDoc?.sourceStats) ? localStateDoc.sourceStats : [];
            const basePublishedAt =
                localStateDoc?.lastSnapshotPublishedAt ||
                localNewsDoc?.lastUpdated ||
                localStateDoc?.lastUpdated ||
                new Date().toISOString();
            const localEditionId = String(localNewsDoc?.editionId || localStateDoc?.lastEditionId || '').trim() || undefined;
            const localHarvestId = String(localNewsDoc?.harvestId || '').trim() || undefined;

            localCandidate = {
                ...(localEditionId ? { editionId: localEditionId } : {}),
                ...(localHarvestId ? { harvestId: localHarvestId } : {}),
                publishedAt: basePublishedAt,
                lastUpdated: basePublishedAt,
                publishedBy: localStateDoc?.lastPublishedBy || opts.publishedBy,
                clientId: localStateDoc?.lastPublishedBy || opts.clientId,
                sourceCount: sourceStats.length,
                articleCount: localNews.length,
                displayedCount: localNews.length,
                totalPoolCount: allEnhancedNews.length,
                news: localNews,
                allEnhancedNews,
                summary: summaryArticle,
                summaryArticle,
                sourceStats
            };
        }
    }

    let remoteCandidate = null;
    let remoteCommitSha;
    let remoteFromGit = false;

    if (preferGit) {
        const gitInfo = fetchRemoteSnapshotViaGit({
            repoDir: opts.repoDir || path.resolve(__dirname, '..'),
            remote: opts.githubRemote || 'origin',
            branch: opts.githubBranch || 'ag-snapshot',
            skipFetch: Boolean(opts.skipGitPush)
        });
        if (!gitInfo.error) {
            remoteCommitSha = gitInfo.commitSha;
        }
        const gitNews = Array.isArray(gitInfo.snapshot?.news) ? gitInfo.snapshot.news : [];
        if (gitNews.length > 0 && !isLocalNewsPolluted(gitNews) && !isSuspectedTestFixtureNews(gitNews)) {
            remoteCandidate = gitInfo.snapshot;
            remoteFromGit = true;
        }
    }

    if (!remoteCandidate && (opts.snapshotUrl || process.env.NODE_ENV !== 'test')) {
        try {
            const ghMgr = new GitHubSyncManager();
            const { data } = await ghMgr.fetchRemoteSnapshot(opts.snapshotUrl || null, { useEtag: false, force: true });
            const remoteNews = Array.isArray(data?.news) ? data.news : [];
            if (remoteNews.length > 0 && !isLocalNewsPolluted(remoteNews) && !isSuspectedTestFixtureNews(remoteNews)) {
                remoteCandidate = data;
            }
        } catch (err) {
            logger.debug('AG-PULSE', `拉取远端基础要闻快照跳过: ${err.message}`);
        }
    }

    let selected = null;
    if (localCandidate && remoteCandidate) {
        const localMs = Date.parse(localCandidate.publishedAt || localCandidate.lastUpdated || '') || 0;
        const remoteMs = Date.parse(remoteCandidate.publishedAt || remoteCandidate.lastUpdated || '') || 0;
        const remoteIsNewer = remoteMs > localMs;
        const remoteEqualAndAuthoritative = remoteFromGit && remoteMs === localMs && remoteCandidate.news.length >= localCandidate.news.length;
        const localLooksTruncated = localCandidate.news.length <= 2 && remoteCandidate.news.length >= 5;
        if (remoteIsNewer || localLooksTruncated || remoteEqualAndAuthoritative) {
            if (remoteIsNewer || localLooksTruncated) {
                logger.info(
                    'AG-PULSE',
                    `远端快照基础要闻更完整/更新 (remote=${remoteCandidate.news.length}条@${remoteCandidate.publishedAt}, local=${localCandidate.news.length}条@${localCandidate.publishedAt})，优先沿用远端基础要闻`
                );
            }
            selected = remoteCandidate;
        } else {
            selected = localCandidate;
        }
    } else {
        selected = localCandidate || remoteCandidate || null;
    }

    if (includeMeta) {
        return {
            baseSnap: selected,
            remoteCommitSha,
            remoteFromGit
        };
    }
    return selected;
}

function mergeAudioForPulseSync(baseAudio, localAudio, baseEditionId) {
    if (!baseAudio && !localAudio) return null;
    const mergedTracks = {};

    const baseNews = baseAudio?.tracks?.news || null;
    const localNews = localAudio?.tracks?.news || null;
    const targetEdition = String(baseEditionId || '').trim();
    const isNewsValidForEdition = (track) => {
        if (!track) return false;
        const trEd = String(track.editionId || '').trim();
        if (!targetEdition || !trEd) return true;
        return trEd === targetEdition;
    };

    const validBaseNews = isNewsValidForEdition(baseNews) ? baseNews : null;
    const validLocalNews = isNewsValidForEdition(localNews) ? localNews : null;

    if (validBaseNews && validLocalNews) {
        const baseGen = Date.parse(validBaseNews.generatedAt || '') || 0;
        const localGen = Date.parse(validLocalNews.generatedAt || '') || 0;
        mergedTracks.news = localGen >= baseGen ? validLocalNews : validBaseNews;
    } else if (validBaseNews) {
        mergedTracks.news = validBaseNews;
    } else if (validLocalNews) {
        mergedTracks.news = validLocalNews;
    }

    if (localAudio?.tracks?.pulse) {
        mergedTracks.pulse = localAudio.tracks.pulse;
    } else if (baseAudio?.tracks?.pulse) {
        mergedTracks.pulse = baseAudio.tracks.pulse;
    }

    if (Object.keys(mergedTracks).length === 0) return null;
    return normalizeAudioBroadcastBundle({
        updatedAt: localAudio?.updatedAt || baseAudio?.updatedAt || new Date().toISOString(),
        tracks: mergedTracks
    });
}

async function runSyncPulse(customOptions = {}) {
    const opts = { ...parsePulseSyncArgs([]), ...customOptions };
    if (customOptions.file && (!Array.isArray(opts.files) || !opts.files.includes(path.resolve(customOptions.file)))) {
        opts.files = [...(opts.files || []), path.resolve(customOptions.file)];
    }

    let shouldPushToGithub = Boolean(opts.pushToGithub);
    if (customOptions.noGithub === true || customOptions.pushToGithub === false || customOptions.github === false) {
        shouldPushToGithub = false;
    } else if (customOptions.pushToGithub === true || customOptions.github === true) {
        shouldPushToGithub = true;
    }

    await stateManager.loadFromFile();
    const pulseService = new SocialPulseService(null, stateManager);
    const socialPulse = await pulseService.syncFromExternalWorkspace({
        sourceDir: opts.sourceDir,
        files: opts.files,
        maxIssues: opts.maxIssues,
        bumpTimestamp: true,
        emit: false
    });

    if (!socialPulse || !Array.isArray(socialPulse.issues) || socialPulse.issues.length === 0) {
        throw new Error('未找到可合并的欧美社媒热议精编数据（请检查 欧美社媒热议/data/digests 目录或 --file 参数）');
    }

    const audioBroadcastService = new AudioBroadcastService(null, stateManager);
    const localAudioBundle = customOptions.audioBroadcast
        ? normalizeAudioBroadcastBundle(customOptions.audioBroadcast)
        : await audioBroadcastService.loadLocalBundle();
    if (localAudioBundle) {
        await audioBroadcastService.saveBundle(localAudioBundle, { emit: false });
    }

    await stateManager.saveToFile(config.storage.stateFile);
    logger.success(
        'AG-PULSE',
        `已同步欧美社媒热议至本地存储: 共 ${socialPulse.issueCount} 期，最新期次=${socialPulse.latestKey}`
    );

    let githubSyncResult = null;
    const isUnscopedTestRun =
        process.env.NODE_ENV === 'test' &&
        !opts.repoDir &&
        !opts.skipGitPush;

    if (shouldPushToGithub && !isUnscopedTestRun) {
        const maxLeaseAttempts = 3;
        for (let attempt = 0; attempt < maxLeaseAttempts; attempt++) {
            const baseInfo = await resolveBaseNewsSnapshot(opts, {
                preferGit: true,
                includeMeta: true
            });
            const baseSnap = baseInfo.baseSnap;
            if (!baseSnap || !Array.isArray(baseSnap.news) || baseSnap.news.length === 0) {
                logger.warn('AG-PULSE', '本地与远端均暂无基础新闻列表，本次仅落盘 data/social_pulse.json，待下次要闻发布一并推送快照');
                break;
            }

            const mergedAudio = mergeAudioForPulseSync(baseSnap.audioBroadcast, localAudioBundle, baseSnap.editionId);
            const combinedPayload = {
                ...baseSnap,
                version: '2.0',
                // 保持要闻原始 publishedAt 不变，避免早间 07:15 推送社媒热议误触发 07:40 要闻采编 30 分钟冷却跳过
                publishedAt: baseSnap.publishedAt || baseSnap.lastUpdated || new Date().toISOString(),
                lastUpdated: baseSnap.lastUpdated || baseSnap.publishedAt || new Date().toISOString(),
                socialPulse,
                socialPulseUpdatedAt: socialPulse.updatedAt
            };
            if (mergedAudio && mergedAudio.trackCount > 0) {
                combinedPayload.audioBroadcast = mergedAudio;
                combinedPayload.audioBroadcastUpdatedAt = mergedAudio.updatedAt;
            } else {
                delete combinedPayload.audioBroadcast;
                delete combinedPayload.audioBroadcastUpdatedAt;
            }

            const leaseSha = attempt === 0 && customOptions.expectedRemoteSha !== undefined
                ? customOptions.expectedRemoteSha
                : baseInfo.remoteCommitSha;

            try {
                githubSyncResult = publishSnapshotToGitHub(combinedPayload, {
                    branch: opts.githubBranch,
                    remote: opts.githubRemote,
                    repoDir: opts.repoDir,
                    skipPush: Boolean(opts.skipGitPush),
                    snapshotOut: opts.snapshotOut,
                    publishedBy: baseSnap.publishedBy || opts.publishedBy,
                    clientId: baseSnap.clientId || opts.clientId,
                    ...(leaseSha !== undefined ? { expectedRemoteSha: leaseSha } : {})
                });
                if (attempt > 0) {
                    githubSyncResult.retriedAfterLeaseConflict = attempt;
                }
                logger.success(
                    'AG-PULSE',
                    `已将欧美社媒热议合入 GitHub 分支 ${githubSyncResult.branch} (commit=${githubSyncResult.commitSha.slice(0, 8)}, issues=${socialPulse.issueCount})`
                );
                break;
            } catch (gitErr) {
                if (gitErr.code === 'LEASE_CONFLICT' && !opts.skipGitPush && attempt + 1 < maxLeaseAttempts) {
                    logger.warn(
                        'AG-PULSE',
                        `GitHub 快照推送遇到并发 lease 冲突，正在重新拉取最新远端要闻基线并合入重试 (${attempt + 1}/${maxLeaseAttempts - 1})...`
                    );
                    continue;
                }
                if (opts.githubExplicit || opts.repoDir || gitErr.code === 'LEASE_CONFLICT') {
                    throw gitErr;
                }
                logger.warn('AG-PULSE', `推送 GitHub 快照跳过或失败 (${gitErr.message})`);
                githubSyncResult = { success: false, skipped: true, error: gitErr.message };
                break;
            }
        }
    } else if (opts.snapshotOut) {
        const baseSnap = await resolveBaseNewsSnapshot(opts);
        if (baseSnap) {
            await writeJsonFile(opts.snapshotOut, {
                ...baseSnap,
                socialPulse,
                socialPulseUpdatedAt: socialPulse.updatedAt
            });
        }
    }

    let remoteResponse = null;
    if (!opts.localOnly && opts.target) {
        const cleanTarget = opts.target.replace(/\/+$/, '');
        const publishUrl = `${cleanTarget}/api/agent/publish-pulse`;
        const headers = { 'Content-Type': 'application/json' };
        if (opts.secret) {
            headers['Authorization'] = `Bearer ${opts.secret}`;
            headers['X-Publish-Secret'] = opts.secret;
            headers['x-api-key'] = opts.secret;
        }
        let isLocalOrLanTarget = false;
        try {
            const parsedHost = new URL(publishUrl).hostname.toLowerCase();
            isLocalOrLanTarget =
                parsedHost === 'localhost' ||
                parsedHost === '127.0.0.1' ||
                parsedHost === '::1' ||
                parsedHost === '[::1]' ||
                parsedHost.startsWith('192.168.') ||
                parsedHost.startsWith('10.') ||
                /^172\.(1[6-9]|2\d|3[0-1])\./.test(parsedHost);
        } catch (_) {}

        try {
            const res = await axios.post(
                publishUrl,
                {
                    socialPulse,
                    publishedBy: opts.publishedBy,
                    clientId: opts.clientId
                },
                {
                    headers,
                    timeout: 15000,
                    httpAgent: httpAgentNoKeepAlive,
                    httpsAgent: getHttpsAgent({ keepAlive: false }),
                    ...(isLocalOrLanTarget ? { proxy: false } : {})
                }
            );
            remoteResponse = res.data;
            logger.success('AG-PULSE', `已实时热推欧美社媒热议至 ${publishUrl}`);

            if (localAudioBundle && localAudioBundle.tracks?.pulse) {
                const pulseAudioFile = audioBroadcastService.getTrackAudioPath('pulse');
                if (pulseAudioFile && fs.existsSync(pulseAudioFile)) {
                    const audioUrl = `${cleanTarget}/api/agent/publish-audio`;
                    try {
                        await axios.post(
                            audioUrl,
                            {
                                track: 'pulse',
                                trackMeta: localAudioBundle.tracks.pulse,
                                audioBase64: fs.readFileSync(pulseAudioFile).toString('base64'),
                                publishedBy: opts.publishedBy
                            },
                            {
                                headers,
                                timeout: 30000,
                                maxBodyLength: 50 * 1024 * 1024,
                                httpAgent: httpAgentNoKeepAlive,
                                httpsAgent: getHttpsAgent({ keepAlive: false }),
                                ...(isLocalOrLanTarget ? { proxy: false } : {})
                            }
                        );
                    } catch (_) {
                        // Ignore optional audio push error if server has not reloaded yet
                    }
                }
            }
        } catch (httpErr) {
            const status = httpErr.response?.status;
            if (httpErr.code === 'ECONNREFUSED' || httpErr.code === 'ECONNRESET') {
                logger.info('AG-PULSE', `目标 Web 服务 ${publishUrl} 未运行，已完成本地落盘与 GitHub 快照同步`);
            } else if (status === 404 && githubSyncResult?.success) {
                logger.info('AG-PULSE', `目标 Web 服务 ${publishUrl} 尚未热加载新路由（重启服务后生效），已完成本地落盘与 GitHub 快照同步`);
            } else if (opts.targetExplicit) {
                throw httpErr;
            }
        }
    }

    return {
        success: true,
        issueCount: socialPulse.issueCount,
        latestKey: socialPulse.latestKey,
        updatedAt: socialPulse.updatedAt,
        socialPulse,
        githubSync: githubSyncResult,
        remoteResponse
    };
}

if (require.main === module) {
    const cliOpts = parsePulseSyncArgs(process.argv.slice(2));
    runSyncPulse(cliOpts)
        .then((res) => {
            console.log(JSON.stringify({
                success: res.success,
                issueCount: res.issueCount,
                latestKey: res.latestKey,
                updatedAt: res.updatedAt,
                githubPushed: Boolean(res.githubSync?.pushed)
            }, null, 2));
            process.exit(0);
        })
        .catch((err) => {
            console.error('[AG-PULSE] 同步失败:', err.message);
            process.exit(1);
        });
}

module.exports = {
    parsePulseSyncArgs,
    runSyncPulse
};
