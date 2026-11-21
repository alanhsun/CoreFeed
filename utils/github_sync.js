/**
 * CoreFeed v3.0 — GitHub 分域快照中转与增量同步模块 (utils/github_sync.js)
 *
 * 架构设计（采编客户端无需直连自托管内网服务端，自托管节点无需公网 IP 或 API Key）：
 *   1. 发布端 (`publishSnapshotToGitHub`)：
 *      使用 Git 底层 Plumbing 命令 (`hash-object` -> `mktree` -> `commit-tree` -> `push --force-with-lease`)
 *      将精编完成的 Schema v3.0 分域数据包（`manifest.json`、`news.json`、可选 `pulse.json` / `audio.json`、
 *      伴生 AI 简报 `briefing.json` / `briefing.md` 与双主播音频 `briefing-*.mp3`）作为单提交孤儿分支
 *      推送至 `ag-snapshot` 分支（彻底移除重复冗余的 `latest.json`），全程不触碰 `HEAD` 或 `main` 工作区。
 *   2. 服务端增量同步端 (`GitHubSyncManager` & `applyDomainUpdatesToRouter`)：
 *      优先携带持久化 ETag (`data/sync_state.json`) 拉取 ~600B 的 `manifest.json`：
 *      - 命中 304 或全部域 SHA-256 一致时零正文传输直接跳过；
 *      - 仅下载 SHA-256 发生变化的域文件 (`news.json` / `pulse.json` / `audio.json`) 并逐镜像校验 SHA-256 完整性；
 *      - 按变更域最小化落盘与单次 Socket.IO 广播（绝不重复发包或误重写未变更域）；
 *      - 若远端为仅含 `latest.json` 的旧版 mock/分支（`manifest.json` 返回 404），自动平滑回退旧全量拉取。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const config = require('../config');
const logger = require('./logger');
const { readJsonFile, writeJsonFile } = require('./helpers');
const { getHttpsAgent } = require('./network_config');
const {
    hasChineseText,
    renderSafeSummaryHtml,
    createSummaryArticleObject
} = require('./editorial_formatter');
const { buildSnapshotBriefingFiles } = require('./briefing_formatter');
const { normalizeSocialPulseBundle } = require('../services/social_pulse_service');
const {
    TRACK_SNAPSHOT_FILENAMES,
    AudioBroadcastService,
    normalizeAudioBroadcastBundle
} = require('../services/audio_broadcast_service');
const {
    SNAPSHOT_SCHEMA_VERSION,
    DEFAULT_SNAPSHOT_URL,
    computeSha256,
    deriveSiblingFileUrl,
    stripArticleForSnapshot,
    buildSnapshotArtifacts,
    reassembleCombinedSnapshot
} = require('./snapshot_schema');

/**
 * 查询远端快照分支当前 HEAD Commit SHA（分支不存在时返回空字符串 ''）
 */
function resolveRemoteBranchSha(repoDir, remote = 'origin', branch = 'ag-snapshot') {
    const out = execFileSync('git', ['ls-remote', remote, `refs/heads/${branch}`], {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20000
    }).trim();
    if (!out) return '';
    const firstLine = out.split(/\r?\n/)[0] || '';
    const sha = firstLine.split(/\s+/)[0] || '';
    return /^[0-9a-f]{40}$/i.test(sha) ? sha : '';
}

function readGitRefJson(repoDir, refPrefix, fileName) {
    try {
        const raw = execFileSync('git', ['show', `${refPrefix}:${fileName}`], {
            cwd: repoDir,
            encoding: 'utf8',
            maxBuffer: 25 * 1024 * 1024,
            stdio: ['ignore', 'pipe', 'ignore']
        });
        if (raw && raw.trim()) {
            return JSON.parse(raw);
        }
    } catch (_) {
        return null;
    }
    return null;
}

function readSnapshotFromGitRef(repoDir, refPrefix) {
    const manifest = readGitRefJson(repoDir, refPrefix, 'manifest.json');
    if (manifest && manifest.domains && manifest.domains.news) {
        const newsFile = manifest.domains.news.file || 'news.json';
        const newsDomain = readGitRefJson(repoDir, refPrefix, newsFile);
        const pulseDomain = manifest.domains.pulse?.file
            ? readGitRefJson(repoDir, refPrefix, manifest.domains.pulse.file)
            : null;
        const audioDomain = manifest.domains.audio?.file
            ? readGitRefJson(repoDir, refPrefix, manifest.domains.audio.file)
            : null;
        if (newsDomain) {
            return reassembleCombinedSnapshot({ manifest, newsDomain, pulseDomain, audioDomain });
        }
    }
    const directNews = readGitRefJson(repoDir, refPrefix, 'news.json');
    if (directNews && Array.isArray(directNews.news)) {
        const pulseDomain = readGitRefJson(repoDir, refPrefix, 'pulse.json');
        const audioDomain = readGitRefJson(repoDir, refPrefix, 'audio.json');
        return reassembleCombinedSnapshot({ newsDomain: directNews, pulseDomain, audioDomain });
    }
    // 兼容从历史 v2 分支迁移前的首次拉取
    return readGitRefJson(repoDir, refPrefix, 'latest.json');
}

/**
 * 直接通过 Git fetch 读取远端快照分支的权威 HEAD SHA 与分域快照（彻底规避 CDN 缓存与第三方镜像滞后）
 */
function fetchRemoteSnapshotViaGit(options = {}) {
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
    const skipFetch = Boolean(options.skipFetch);

    if (!skipFetch) {
        try {
            const remoteSha = resolveRemoteBranchSha(repoDir, remote, branch);
            if (!remoteSha) {
                return { exists: false, commitSha: '', snapshot: null, remote, branch };
            }
            execFileSync('git', ['fetch', '--depth=1', remote, `${branch}:refs/remotes/${remote}/${branch}`], {
                cwd: repoDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                timeout: 25000
            });
            const snapshot = readSnapshotFromGitRef(repoDir, `refs/remotes/${remote}/${branch}`);
            return { exists: true, commitSha: remoteSha, snapshot, remote, branch };
        } catch (err) {
            return { exists: false, commitSha: '', snapshot: null, remote, branch, error: err.message };
        }
    }

    for (const refPrefix of [`refs/remotes/${remote}/${branch}`, `refs/heads/${branch}`]) {
        try {
            const sha = execFileSync('git', ['rev-parse', '--verify', refPrefix], {
                cwd: repoDir,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            }).trim();
            if (!/^[0-9a-f]{40}$/i.test(sha)) continue;
            const snapshot = readSnapshotFromGitRef(repoDir, refPrefix);
            return { exists: true, commitSha: sha, snapshot, remote, branch };
        } catch (_) {
            // try next ref
        }
    }
    return { exists: false, commitSha: '', snapshot: null, remote, branch };
}

/**
 * 使用 Git Plumbing 命令将精编分域快照 (manifest.json / news.json / pulse.json / audio.json / briefing.* / *.mp3)
 * 写入独立孤儿分支 (默认 ag-snapshot) 并推送到远端仓库（不再生成冗余的 latest.json）
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
    const skipPush = Boolean(options.skipPush);
    const forceUnchecked = Boolean(options.forceUnchecked);

    const publishedBy = String(
        options.publishedBy ||
        options.clientId ||
        snapshotPayload.publishedBy ||
        snapshotPayload.clientId ||
        process.env.CLIENT_ID ||
        process.env.AG_CLIENT_ID ||
        config.githubSync?.clientId ||
        config.agent?.clientId ||
        os.hostname() ||
        'antigravity-client'
    ).trim();
    const resolvedClientId = String(options.clientId || snapshotPayload.clientId || publishedBy).trim();
    const baseRawUrl = String(
        config.githubSync?.snapshotUrl ||
        config.agent?.githubSnapshotUrl ||
        DEFAULT_SNAPSHOT_URL
    ).trim();

    const artifacts = buildSnapshotArtifacts(snapshotPayload, {
        publishedBy,
        clientId: resolvedClientId,
        snapshotUrl: baseRawUrl
    });

    if (options.snapshotOut) {
        const outPath = path.resolve(options.snapshotOut);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, JSON.stringify(artifacts.combinedPayload, null, 2) + '\n', 'utf8');
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

    // 1. 写入分域 Git Blob 对象（manifest.json + news.json + 可选 pulse.json / audio.json）
    const manifestBlobSha = runGit(['hash-object', '-w', '--stdin'], artifacts.manifestJson);
    const newsBlobSha = runGit(['hash-object', '-w', '--stdin'], artifacts.newsJson);
    const treeFiles = new Map([
        ['manifest.json', manifestBlobSha],
        ['news.json', newsBlobSha]
    ]);

    let pulseBlobSha = null;
    if (artifacts.pulseJson) {
        pulseBlobSha = runGit(['hash-object', '-w', '--stdin'], artifacts.pulseJson);
        treeFiles.set('pulse.json', pulseBlobSha);
    }

    let audioBlobMetaSha = null;
    if (artifacts.audioJson) {
        audioBlobMetaSha = runGit(['hash-object', '-w', '--stdin'], artifacts.audioJson);
        treeFiles.set('audio.json', audioBlobMetaSha);
    }

    let briefingJsonBlobSha = null;
    let briefingMdBlobSha = null;
    if (options.includeBriefingFiles !== false) {
        const { briefingJson, briefingMarkdown } = buildSnapshotBriefingFiles(artifacts.combinedPayload);
        briefingJsonBlobSha = runGit(['hash-object', '-w', '--stdin'], briefingJson);
        briefingMdBlobSha = runGit(['hash-object', '-w', '--stdin'], briefingMarkdown);
        treeFiles.set('briefing.json', briefingJsonBlobSha);
        treeFiles.set('briefing.md', briefingMdBlobSha);
    }

    // 1b. 若快照包含双主播语音播报 (audioBroadcast)，将 MP3 二进制文件作为顶层 Blob 写入 ag-snapshot 树
    const audioFilesCommitted = [];
    const audioTracks = (artifacts.audioPayload && typeof artifacts.audioPayload.tracks === 'object')
        ? artifacts.audioPayload.tracks
        : {};
    const defaultRepoRoot = path.resolve(__dirname, '..');
    const isDefaultRepo = path.resolve(repoDir) === defaultRepoRoot;
    const primaryAudioDir = options.audioDir
        ? path.resolve(options.audioDir)
        : (isDefaultRepo && config.storage?.audioDir ? config.storage.audioDir : path.join(repoDir, 'data', 'audio'));

    let remoteBranchFetched = false;
    for (const [trackKey, trackFileName] of Object.entries(TRACK_SNAPSHOT_FILENAMES)) {
        if (!audioTracks[trackKey] || treeFiles.has(trackFileName)) continue;
        const candidatePaths = [
            options.audioFiles?.[trackKey],
            path.join(primaryAudioDir, trackFileName),
            ...(config.storage?.audioDir ? [path.join(config.storage.audioDir, trackFileName)] : [])
        ].filter(Boolean);

        const localAudioFile = candidatePaths.find((p) => fs.existsSync(p));
        let audioBlobSha = null;
        if (localAudioFile) {
            audioBlobSha = runGit(['hash-object', '-w', '--no-filters', '--', localAudioFile]);
        } else {
            const resolveExistingBlob = () => {
                for (const refPrefix of [`refs/heads/${branch}`, `refs/remotes/${remote}/${branch}`]) {
                    try {
                        const prevSha = runGit(['rev-parse', '--verify', `${refPrefix}:${trackFileName}`]);
                        if (prevSha && /^[0-9a-f]{40}$/i.test(prevSha)) {
                            return prevSha;
                        }
                    } catch (_) {
                        // ignore missing ref or blob
                    }
                }
                return null;
            };

            audioBlobSha = resolveExistingBlob();
            if (!audioBlobSha && !skipPush && !remoteBranchFetched) {
                remoteBranchFetched = true;
                try {
                    runGit(['fetch', '--depth=1', remote, `${branch}:refs/remotes/${remote}/${branch}`]);
                    audioBlobSha = resolveExistingBlob();
                } catch (_) {
                    // ignore if remote snapshot branch does not exist yet
                }
            }
        }

        if (audioBlobSha) {
            treeFiles.set(trackFileName, audioBlobSha);
            audioFilesCommitted.push(trackFileName);
        }
    }

    // 2. 构建按文件名排序的 Git Tree 对象
    const treeEntry = [...treeFiles.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, sha]) => `100644 blob ${sha}\t${name}`)
        .join('\n') + '\n';
    const treeSha = runGit(['mktree'], treeEntry);

    // 3. 创建无父节点的孤儿 Commit 对象，保持快照分支永远只有 1 个最新提交
    const commitMessage = `chore(snapshot): publish CoreFeed v3 split snapshot (${artifacts.publishedAt} by ${publishedBy})`;
    const commitSha = runGit(['commit-tree', treeSha, '-m', commitMessage]);

    // 4. 推送至远端仓库分支（默认使用 --force-with-lease 防并发覆写；推送成功后再更新本地 ref）
    let leaseUsed = false;
    let leaseExpectedSha = null;
    if (!skipPush) {
        let pushArgs;
        if (forceUnchecked) {
            pushArgs = ['push', '--force', remote, `${commitSha}:refs/heads/${branch}`];
        } else {
            const expectedSha = options.expectedRemoteSha !== undefined && options.expectedRemoteSha !== null
                ? String(options.expectedRemoteSha).trim()
                : resolveRemoteBranchSha(repoDir, remote, branch);
            leaseUsed = true;
            leaseExpectedSha = expectedSha;
            pushArgs = [
                'push',
                `--force-with-lease=refs/heads/${branch}:${expectedSha}`,
                remote,
                `${commitSha}:refs/heads/${branch}`
            ];
        }

        try {
            runGit(pushArgs);
        } catch (pushErr) {
            const stderr = String(pushErr?.stderr || pushErr?.message || '');
            if (leaseUsed && /stale info|rejected|failed to push some refs/i.test(stderr)) {
                const conflictErr = new Error(
                    `远端分支 ${branch} 在推送期间已被其他客户端更新（--force-with-lease 冲突，expected=${leaseExpectedSha || '<empty>'}）: ${stderr.trim()}`
                );
                conflictErr.code = 'LEASE_CONFLICT';
                conflictErr.expectedRemoteSha = leaseExpectedSha;
                throw conflictErr;
            }
            throw pushErr;
        }

        runGit(['update-ref', `refs/heads/${branch}`, commitSha]);
        try {
            runGit(['update-ref', `refs/remotes/${remote}/${branch}`, commitSha]);
        } catch (_) {
            // ignore
        }
    } else {
        runGit(['update-ref', `refs/heads/${branch}`, commitSha]);
    }

    const manifestUrl = baseRawUrl ? deriveSiblingFileUrl(baseRawUrl, 'manifest.json') : null;
    const newsUrl = baseRawUrl ? deriveSiblingFileUrl(baseRawUrl, 'news.json') : null;
    const briefingJsonUrl = baseRawUrl ? deriveSiblingFileUrl(baseRawUrl, 'briefing.json') : null;
    const briefingMdUrl = baseRawUrl ? deriveSiblingFileUrl(baseRawUrl, 'briefing.md') : null;

    return {
        success: true,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        branch,
        remote,
        fileName: 'manifest.json',
        files: [...treeFiles.keys()].sort(),
        audioFiles: audioFilesCommitted,
        blobSha: manifestBlobSha,
        manifestBlobSha,
        newsBlobSha,
        pulseBlobSha,
        audioBlobSha: audioBlobMetaSha,
        briefingJsonBlobSha,
        briefingMdBlobSha,
        treeSha,
        commitSha,
        pushed: !skipPush,
        leaseUsed,
        leaseExpectedSha,
        publishedAt: artifacts.publishedAt,
        publishedBy,
        clientId: resolvedClientId,
        editionId: artifacts.editionId,
        manifest: artifacts.manifestPayload,
        sizes: artifacts.sizes,
        rawUrl: manifestUrl,
        manifestUrl,
        newsUrl,
        briefingJsonUrl,
        briefingMdUrl
    };
}

const KNOWN_TEST_FIXTURE_IDS = new Set([
    'standalone-1',
    'lan-push-1',
    'gh-snap-1',
    'ui-sync-news-1',
    'cooldown-news-1',
    'router-sync-1',
    'pollute-test-1'
]);

/**
 * 检测新闻列表是否疑似来自自动化单元测试夹具（防止测试残留数据意外覆盖线上 ag-snapshot）
 */
function isSuspectedTestFixtureNews(newsList) {
    if (!Array.isArray(newsList) || newsList.length === 0) {
        return false;
    }
    return newsList.some((item) => {
        if (!item || typeof item !== 'object') return false;
        const id = String(item.id || '').trim();
        const title = String(item.translatedTitle || item.title || '').trim();
        if (KNOWN_TEST_FIXTURE_IDS.has(id)) return true;
        if (/独立自包含精编快照条目|自托管服务端直推测试文章|前端一键同步最新快照测试/.test(title)) {
            return true;
        }
        return false;
    });
}

/**
 * 检测本地状态中的新闻是否为空、非快照精编或包含未翻译的英文标题
 */
function isLocalNewsPolluted(newsList) {
    if (!Array.isArray(newsList) || newsList.length === 0) {
        return true;
    }
    return newsList.some((item) => {
        if (!item || typeof item !== 'object') return true;
        if (item.aiCompiled === false) return true;
        const title = String(item.translatedTitle || item.title || '').trim();
        return !title || !hasChineseText(title);
    });
}

function hasStateListener(stateManager, eventName) {
    return Boolean(
        stateManager &&
        typeof stateManager.listenerCount === 'function' &&
        stateManager.listenerCount(eventName) > 0
    );
}

/**
 * 应用新闻与深度综述域至软路由内存与磁盘（Schema v3.0 瘦身结构，兼容旧 allEnhancedNews 与新 extraPoolNews）
 */
async function applyNewsAndSummaryDomain(
    newsDomain,
    { stateManager, newsAgentService, newsService, io } = {}
) {
    const rawNews = Array.isArray(newsDomain?.news)
        ? newsDomain.news
        : (Array.isArray(newsDomain?.articles) ? newsDomain.articles : null);

    if (!Array.isArray(rawNews) || rawNews.length === 0) {
        const err = new Error('推送或拉取的 news 数组不能为空');
        err.statusCode = 400;
        throw err;
    }

    const rawTimestamp = newsDomain.publishedAt || newsDomain.lastUpdated || null;
    const publishedBy = String(newsDomain.publishedBy || newsDomain.clientId || '').trim() || null;
    const editionId = String(newsDomain.editionId || '').trim() || null;
    const parsedDate = rawTimestamp ? new Date(rawTimestamp) : new Date();
    const timestamp = isNaN(parsedDate.getTime()) ? new Date() : parsedDate;
    const nowIso = timestamp.toISOString();

    const normalizedNews = rawNews
        .filter(Boolean)
        .map((item, idx) => stripArticleForSnapshot(item, idx, nowIso))
        .filter(Boolean);
    if (normalizedNews.length === 0) {
        const err = new Error('推送或拉取的 news 数组不包含有效新闻对象');
        err.statusCode = 400;
        throw err;
    }

    let normalizedFullPool = normalizedNews;
    if (Array.isArray(newsDomain.allEnhancedNews) && newsDomain.allEnhancedNews.length > 0) {
        normalizedFullPool = newsDomain.allEnhancedNews
            .filter(Boolean)
            .map((item, idx) => stripArticleForSnapshot(item, idx, nowIso))
            .filter(Boolean);
    } else if (Array.isArray(newsDomain.extraPoolNews) && newsDomain.extraPoolNews.length > 0) {
        const extraNorm = newsDomain.extraPoolNews
            .filter(Boolean)
            .map((item, idx) => stripArticleForSnapshot(item, normalizedNews.length + idx, nowIso))
            .filter(Boolean);
        normalizedFullPool = [...normalizedNews, ...extraNorm];
    }

    const normalizedStats = Array.isArray(newsDomain.sourceStats) ? newsDomain.sourceStats : [];

    // 1. 同步更新 NewsService、StateManager、写入 data/news.json 并触发单次 news-updated 广播
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
        stateManager.updateNewsData(normalizedNews, normalizedFullPool, nowIso);
    }

    if (editionId && config.storage?.newsFile) {
        await writeJsonFile(config.storage.newsFile, {
            editionId,
            ...(newsDomain.harvestId ? { harvestId: newsDomain.harvestId } : {}),
            news: normalizedNews,
            lastUpdated: nowIso,
            total: normalizedNews.length
        });
    }

    if (stateManager) {
        stateManager.set('lastUpdated', nowIso, false);
        stateManager.set('lastSnapshotPublishedAt', nowIso, false);
        if (publishedBy) {
            stateManager.set('lastPublishedBy', publishedBy, false);
        }
        if (editionId) {
            stateManager.set('lastEditionId', editionId, false);
        }
    }

    // 2. 处理并持久化今日深度综述（始终通过 renderSafeSummaryHtml 在本地重建安全 HTML）
    let finalSummary = null;
    const summaryArticle = newsDomain.summaryArticle || newsDomain.summary || null;
    const summaryMarkdown = newsDomain.summaryMarkdown || null;
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

    if (rawMdInput) {
        const firstLine = rawMdInput.split('\n').map(l => l.trim()).find(Boolean) || '';
        const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
            ? `${currentDate} 全球要闻深度综述\n\n${rawMdInput}`
            : rawMdInput;
        finalSummary = createSummaryArticleObject(mdWithTitle, normalizedNews, currentDate);
    } else if (summaryArticle && typeof summaryArticle === 'object') {
        const rawBody = String(summaryArticle.content || summaryArticle.markdown || '').trim();
        const normalizedBody = rawBody
            ? rawBody.split('\n').map(l => l.trim()).filter(Boolean).join('\n\n')
            : '';
        const htmlContent = renderSafeSummaryHtml(summaryArticle, normalizedNews);

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
            ...(editionId ? { editionId } : {}),
            article: finalSummary,
            savedAt: new Date().toISOString(),
            version: SNAPSHOT_SCHEMA_VERSION
        });
        if (io && !hasStateListener(stateManager, 'summaryArticle-changed')) {
            io.emit('summary-completed', {
                success: true,
                article: finalSummary
            });
        }
    }

    return {
        displayedCount: normalizedNews.length,
        totalPoolCount: normalizedFullPool.length,
        hasSummary: Boolean(finalSummary),
        publishedAt: nowIso,
        lastUpdated: nowIso,
        publishedBy,
        editionId
    };
}

/**
 * 应用欧美社媒热议域至软路由内存与磁盘（单次 pulse-updated 广播）
 */
async function applyPulseDomain(pulseInput, { updatedAt, stateManager, io } = {}) {
    if (!pulseInput || typeof pulseInput !== 'object') return null;
    const appliedPulse = normalizeSocialPulseBundle(pulseInput, {
        updatedAt: updatedAt || pulseInput.updatedAt
    });
    if (!appliedPulse || !Array.isArray(appliedPulse.issues) || appliedPulse.issues.length === 0) {
        return null;
    }
    if (stateManager) {
        stateManager.updateSocialPulse(appliedPulse);
    }
    if (config.storage?.socialPulseFile) {
        await writeJsonFile(config.storage.socialPulseFile, appliedPulse);
    }
    if (io && !hasStateListener(stateManager, 'socialPulse-changed')) {
        io.emit('pulse-updated', {
            success: true,
            socialPulse: appliedPulse
        });
    }
    return appliedPulse;
}

/**
 * 应用双主播语音播报域至软路由内存、磁盘与本地 MP3 缓存（支持音频移除清理与单次 audio-updated 广播）
 */
async function applyAudioDomain(
    audioInput,
    {
        updatedAt,
        removed = false,
        snapshotUrl = null,
        stateManager,
        audioBroadcastService,
        io,
        syncAudioFiles = true,
        awaitAudioSync = true
    } = {}
) {
    if (removed) {
        if (stateManager) {
            if (typeof stateManager.updateAudioBroadcast === 'function') {
                stateManager.updateAudioBroadcast(null);
            } else {
                stateManager.set('audioBroadcast', null);
            }
        }
        if (config.storage?.audioBroadcastFile && fs.existsSync(config.storage.audioBroadcastFile)) {
            try {
                fs.unlinkSync(config.storage.audioBroadcastFile);
            } catch (_) {}
        }
        if (io && !hasStateListener(stateManager, 'audioBroadcast-changed')) {
            io.emit('audio-updated', {
                success: true,
                audioBroadcast: null
            });
        }
        return { bundle: null, syncFn: null };
    }

    if (!audioInput || typeof audioInput !== 'object') {
        return { bundle: null, syncFn: null };
    }

    const appliedAudio = normalizeAudioBroadcastBundle(audioInput, {
        updatedAt: updatedAt || audioInput.updatedAt,
        snapshotUrl
    });
    if (!appliedAudio || appliedAudio.trackCount === 0) {
        return { bundle: null, syncFn: null };
    }

    if (stateManager) {
        if (typeof stateManager.updateAudioBroadcast === 'function') {
            stateManager.updateAudioBroadcast(appliedAudio);
        } else {
            stateManager.set('audioBroadcast', appliedAudio);
        }
    }
    if (config.storage?.audioBroadcastFile) {
        await writeJsonFile(config.storage.audioBroadcastFile, appliedAudio);
    }
    if (io && !hasStateListener(stateManager, 'audioBroadcast-changed')) {
        io.emit('audio-updated', {
            success: true,
            audioBroadcast: appliedAudio
        });
    }

    const syncFn = syncAudioFiles
        ? async () => {
            const audioSvc = audioBroadcastService || new AudioBroadcastService(io, stateManager);
            if (awaitAudioSync) {
                try {
                    await audioSvc.syncRemoteAudioFiles(appliedAudio, { snapshotUrl });
                } catch (audioErr) {
                    logger.warn('AUDIO-SYNC', `快照音频文件同步暂跳过: ${audioErr.message}`);
                }
            } else {
                audioSvc.syncRemoteAudioFiles(appliedAudio, { snapshotUrl }).catch((audioErr) => {
                    logger.warn('AUDIO-SYNC', `后台异步缓存音频暂跳过: ${audioErr.message}`);
                });
            }
        }
        : null;

    return { bundle: appliedAudio, syncFn };
}

/**
 * 分域增量应用器：仅落盘、更新状态并广播本次真正发生变化的域 (`news` / `pulse` / `audio`)
 */
async function applyDomainUpdatesToRouter({
    manifest = null,
    newsDomain = null,
    pulseDomain = null,
    audioDomain = null,
    audioRemoved = false,
    stateManager,
    newsAgentService,
    newsService,
    audioBroadcastService,
    io,
    sourceLabel = 'GitHub 增量快照同步',
    snapshotUrl = null,
    syncAudioFiles = true,
    awaitAudioSync = true
} = {}) {
    const updatedDomains = [];
    let newsResult = null;
    let appliedPulse = null;
    let appliedAudio = null;
    let audioSyncFn = null;

    if (newsDomain) {
        newsResult = await applyNewsAndSummaryDomain(newsDomain, {
            stateManager,
            newsAgentService,
            newsService,
            io
        });
        updatedDomains.push('news');
    }

    if (pulseDomain) {
        appliedPulse = await applyPulseDomain(pulseDomain, {
            updatedAt: manifest?.domains?.pulse?.updatedAt || pulseDomain.updatedAt,
            stateManager,
            io
        });
        if (appliedPulse) {
            updatedDomains.push('pulse');
        }
    }

    if (audioDomain || audioRemoved) {
        const audioRes = await applyAudioDomain(audioDomain, {
            updatedAt: manifest?.domains?.audio?.updatedAt || audioDomain?.updatedAt,
            removed: audioRemoved,
            snapshotUrl,
            stateManager,
            audioBroadcastService,
            io,
            syncAudioFiles,
            awaitAudioSync
        });
        appliedAudio = audioRes.bundle;
        audioSyncFn = audioRes.syncFn;
        if (appliedAudio || audioRemoved) {
            updatedDomains.push('audio');
        }
    }

    if (stateManager && updatedDomains.length > 0) {
        await stateManager.saveToFile();
    }

    if (audioSyncFn) {
        await audioSyncFn();
    }

    const currentNewsCount = newsResult?.displayedCount ?? (stateManager?.get('newsData')?.length || 0);
    const currentPoolCount = newsResult?.totalPoolCount ?? (stateManager?.get('allEnhancedNews')?.length || currentNewsCount);
    const currentHasSummary = newsResult ? newsResult.hasSummary : Boolean(stateManager?.get('summaryArticle'));
    const currentPulse = appliedPulse || stateManager?.get('socialPulse') || null;
    const currentAudio = audioRemoved ? null : (appliedAudio || stateManager?.get('audioBroadcast') || null);
    const publishedAt = newsResult?.publishedAt || manifest?.publishedAt || stateManager?.get('lastSnapshotPublishedAt') || new Date().toISOString();
    const publishedBy = newsResult?.publishedBy || manifest?.publishedBy || stateManager?.get('lastPublishedBy') || null;
    const editionId = newsResult?.editionId || manifest?.editionId || stateManager?.get('lastEditionId') || null;

    if (newsAgentService && typeof newsAgentService.emitAgentEvent === 'function' && updatedDomains.length > 0) {
        const parts = [];
        if (updatedDomains.includes('news')) {
            parts.push(`${currentNewsCount} 条精选新闻${currentHasSummary ? '及深度综述' : ''}`);
        }
        if (updatedDomains.includes('pulse') && currentPulse?.issueCount) {
            parts.push(`欧美社媒热议 (${currentPulse.issueCount} 期)`);
        }
        if (updatedDomains.includes('audio')) {
            parts.push(currentAudio?.trackCount ? `双主播语音播报 (${currentAudio.trackCount} 轨)` : '已清理过期音频');
        }
        newsAgentService.emitAgentEvent(
            sourceLabel,
            'completed',
            `增量同步完成 [${updatedDomains.join('+')}]: ${parts.join(' + ')}`,
            { progress: 100, current: currentNewsCount, total: currentPoolCount }
        );
    }

    return {
        success: true,
        updatedDomains,
        displayedCount: currentNewsCount,
        totalPoolCount: currentPoolCount,
        hasSummary: currentHasSummary,
        hasSocialPulse: Boolean(currentPulse?.issueCount),
        socialPulseCount: currentPulse?.issueCount || 0,
        hasAudioBroadcast: Boolean(currentAudio?.trackCount),
        audioTrackCount: currentAudio?.trackCount || 0,
        publishedAt,
        lastUpdated: publishedAt,
        publishedBy,
        editionId
    };
}

/**
 * 将完整快照数据标准化并应用至软路由内存状态、磁盘文件与 WebSocket 广播（供直推 /api/agent/publish 与旧格式回退复用）
 */
async function applySnapshotToRouter(
    snapshot,
    {
        stateManager,
        newsAgentService,
        newsService,
        audioBroadcastService,
        io,
        sourceLabel = 'GitHub 快照中转同步',
        snapshotUrl = null,
        syncAudioFiles = true,
        awaitAudioSync = true
    } = {}
) {
    const newsResult = await applyNewsAndSummaryDomain(snapshot, {
        stateManager,
        newsAgentService,
        newsService,
        io
    });

    const appliedPulse = snapshot.socialPulse
        ? await applyPulseDomain(snapshot.socialPulse, {
            updatedAt: snapshot.socialPulseUpdatedAt || snapshot.socialPulse.updatedAt || newsResult.publishedAt,
            stateManager,
            io
        })
        : null;

    const audioRes = snapshot.audioBroadcast
        ? await applyAudioDomain(snapshot.audioBroadcast, {
            updatedAt: snapshot.audioBroadcastUpdatedAt || snapshot.audioBroadcast.updatedAt || newsResult.publishedAt,
            snapshotUrl,
            stateManager,
            audioBroadcastService,
            io,
            syncAudioFiles,
            awaitAudioSync
        })
        : { bundle: null, syncFn: null };

    if (stateManager) {
        await stateManager.saveToFile();
    }

    if (audioRes.syncFn) {
        await audioRes.syncFn();
    }

    if (newsAgentService && typeof newsAgentService.emitAgentEvent === 'function') {
        const pulseNote = appliedPulse?.issueCount ? ` + 欧美社媒热议 (${appliedPulse.issueCount} 期)` : '';
        const audioNote = audioRes.bundle?.trackCount ? ` + 双主播语音播报 (${audioRes.bundle.trackCount} 轨)` : '';
        newsAgentService.emitAgentEvent(
            sourceLabel,
            'completed',
            `已同步发布 ${newsResult.displayedCount} 条精选新闻${newsResult.hasSummary ? '及今日全球要闻深度综述' : ''}${pulseNote}${audioNote}`,
            { progress: 100, current: newsResult.displayedCount, total: newsResult.totalPoolCount }
        );
    }

    return {
        success: true,
        displayedCount: newsResult.displayedCount,
        totalPoolCount: newsResult.totalPoolCount,
        hasSummary: newsResult.hasSummary,
        hasSocialPulse: Boolean(appliedPulse?.issueCount),
        socialPulseCount: appliedPulse?.issueCount || 0,
        hasAudioBroadcast: Boolean(audioRes.bundle?.trackCount),
        audioTrackCount: audioRes.bundle?.trackCount || 0,
        publishedAt: newsResult.publishedAt,
        lastUpdated: newsResult.lastUpdated,
        publishedBy: newsResult.publishedBy,
        editionId: newsResult.editionId
    };
}

/**
 * 多客户端协同冷却检查：优先拉取 ~600B 的 manifest.json（404 时平滑回退目标 URL），检查 publishedAt 是否在冷却窗口内
 */
async function checkRemoteSnapshotCooldown(options = {}) {
    const rawCooldown = options.cooldownMinutes !== undefined
        ? Number(options.cooldownMinutes)
        : Number(process.env.GITHUB_COOLDOWN_MINUTES ?? config.githubSync?.cooldownMinutes ?? config.agent?.githubCooldownMinutes ?? 30);
    const cooldownMinutes = Number.isFinite(rawCooldown) ? Math.max(0, rawCooldown) : 30;
    const nowMs = Number(options.nowMs) || Date.now();

    if (cooldownMinutes <= 0) {
        return {
            inCooldown: false,
            reachable: false,
            reason: 'cooldown-disabled',
            cooldownMinutes
        };
    }

    const manager = options.syncManager || new GitHubSyncManager();
    const targetUrl = manager.resolveTargetSnapshotUrl(options.snapshotUrl || null);
    const manifestUrl = deriveSiblingFileUrl(targetUrl, 'manifest.json');

    try {
        // 1. 优先拉取轻量 manifest.json (~600B)
        let manifestRes = null;
        if (manifestUrl) {
            manifestRes = await manager.fetchRemoteFile(manifestUrl, {
                useEtag: false,
                force: true,
                accept404: true
            });
            if (!manifestRes.notFound && manifestRes.data && manifestRes.data.domains?.news) {
                const m = manifestRes.data;
                const remotePublishedAt = m.domains.news.publishedAt || m.publishedAt || m.lastUpdated || null;
                const publishedMs = remotePublishedAt ? new Date(remotePublishedAt).getTime() : NaN;
                const articleCount = Number(m.domains.news.articleCount) || 0;

                if (articleCount <= 0 || isNaN(publishedMs) || publishedMs <= 0) {
                    return {
                        inCooldown: false,
                        reachable: true,
                        reason: 'invalid-or-empty-snapshot',
                        cooldownMinutes,
                        sourceUrl: manifestRes.sourceUrl
                    };
                }

                const ageMs = nowMs - publishedMs;
                const inCooldown = ageMs < cooldownMinutes * 60 * 1000;
                const ageMinutes = Number((Math.max(0, ageMs) / 60000).toFixed(2));
                const publishedBy = String(m.publishedBy || m.clientId || 'unknown').trim();
                return {
                    inCooldown,
                    reachable: true,
                    reason: inCooldown ? 'within-cooldown-window' : 'cooldown-expired',
                    cooldownMinutes,
                    ageMinutes,
                    publishedAt: new Date(publishedMs).toISOString(),
                    publishedBy,
                    clientId: String(m.clientId || publishedBy).trim(),
                    editionId: m.editionId || m.domains.news.editionId || null,
                    displayedCount: articleCount,
                    sourceUrl: manifestRes.sourceUrl,
                    viaManifest: true
                };
            }
        }

        // 2. 平滑回退至传统快照 URL（如旧分支或测试 mock）；若 manifest 探测已直接返回完整旧快照则直接复用
        const reusedLegacy = Boolean(
            manifestRes &&
            !manifestRes.notFound &&
            manifestRes.data &&
            (Array.isArray(manifestRes.data.news) || Array.isArray(manifestRes.data.articles))
        );
        const { data, sourceUrl } = reusedLegacy
            ? manifestRes
            : await manager.fetchRemoteSnapshot(targetUrl, { useEtag: false, force: true });
        const newsList = Array.isArray(data?.news)
            ? data.news
            : (Array.isArray(data?.articles) ? data.articles : []);
        const remotePublishedAt = data?.publishedAt || data?.lastUpdated || null;
        const publishedMs = remotePublishedAt ? new Date(remotePublishedAt).getTime() : NaN;

        if (!Array.isArray(newsList) || newsList.length === 0 || isNaN(publishedMs) || publishedMs <= 0) {
            return {
                inCooldown: false,
                reachable: true,
                reason: 'invalid-or-empty-snapshot',
                cooldownMinutes,
                sourceUrl
            };
        }

        const ageMs = nowMs - publishedMs;
        const cooldownMs = cooldownMinutes * 60 * 1000;
        const inCooldown = ageMs < cooldownMs;
        const ageMinutes = Number((Math.max(0, ageMs) / 60000).toFixed(2));
        const publishedBy = String(data.publishedBy || data.clientId || 'unknown').trim();

        return {
            inCooldown,
            reachable: true,
            reason: inCooldown ? 'within-cooldown-window' : 'cooldown-expired',
            cooldownMinutes,
            ageMinutes,
            publishedAt: new Date(publishedMs).toISOString(),
            publishedBy,
            clientId: String(data.clientId || publishedBy).trim(),
            displayedCount: newsList.length,
            sourceUrl,
            snapshot: data
        };
    } catch (err) {
        return {
            inCooldown: false,
            reachable: false,
            reason: 'remote-unreachable',
            error: err.message,
            cooldownMinutes
        };
    }
}

/**
 * 软路由端 GitHub 分域快照拉取与持久化增量同步管理器
 */
class GitHubSyncManager {
    constructor(services = {}, io = null, stateManager = null, options = {}) {
        this.services = services;
        this.io = io;
        this.stateManager = stateManager;
        this.syncStateFile = options.syncStateFile || config.storage?.syncStateFile || path.join(__dirname, '..', 'data', 'sync_state.json');
        this.isSyncing = false;
        this._inflightPull = null;
        this.lastSyncCheckAt = null;
        this.lastSyncedAt = null;
        this.lastSyncedPublishedAt = null;
        this.lastSyncedPublishedBy = null;
        this.lastSyncStatus = 'idle';
        this.lastSyncError = null;
        this.lastSyncSourceUrl = null;
        this.lastSyncMode = null;
        this.lastEtag = null;
        this.etagCache = new Map();
        this._syncStateLoaded = false;
        this._persistedState = { version: SNAPSHOT_SCHEMA_VERSION, sources: {} };
    }

    resolveTargetSnapshotUrl(customSnapshotUrl = null) {
        return String(
            customSnapshotUrl ||
            process.env.GITHUB_SNAPSHOT_URL ||
            config.githubSync?.snapshotUrl ||
            config.agent?.githubSnapshotUrl ||
            DEFAULT_SNAPSHOT_URL
        ).trim();
    }

    getSourceBucketKey(targetUrl) {
        const dirUrl = deriveSiblingFileUrl(targetUrl, 'manifest.json');
        return dirUrl || String(targetUrl || '').split('?')[0];
    }

    async loadPersistedSyncState() {
        if (this._syncStateLoaded) return this._persistedState;
        this._syncStateLoaded = true;
        try {
            const loaded = await readJsonFile(this.syncStateFile, null);
            if (loaded && typeof loaded === 'object' && loaded.sources && typeof loaded.sources === 'object') {
                this._persistedState = loaded;
            }
        } catch (_) {
            this._persistedState = { version: SNAPSHOT_SCHEMA_VERSION, sources: {} };
        }
        return this._persistedState;
    }

    async savePersistedSyncState() {
        try {
            const entries = Object.entries(this._persistedState.sources || {});
            if (entries.length > 8) {
                entries.sort((a, b) => Date.parse(b[1]?.lastSyncedAt || 0) - Date.parse(a[1]?.lastSyncedAt || 0));
                this._persistedState.sources = Object.fromEntries(entries.slice(0, 8));
            }
            this._persistedState.version = SNAPSHOT_SCHEMA_VERSION;
            this._persistedState.savedAt = new Date().toISOString();
            await writeJsonFile(this.syncStateFile, this._persistedState);
        } catch (err) {
            logger.debug('GITHUB-SYNC', `持久化 sync_state.json 跳过: ${err.message}`);
        }
    }

    buildCandidateEndpoints(primaryUrl) {
        let cleanUrl = String(primaryUrl || '').trim();
        const endpoints = [];

        // 兼容 ghfast.top 前缀代理与 GitHub Contents API URL，统一还原为 canonical raw URL 以启用全量镜像回退
        const proxyUnwrap = cleanUrl.match(/^https:\/\/ghfast\.top\/(https:\/\/.+)$/i);
        if (proxyUnwrap) {
            cleanUrl = proxyUnwrap[1];
        }
        const apiMatch = cleanUrl.match(
            /^https:\/\/api\.github\.com\/repos\/([^/?#]+)\/([^/?#]+)\/contents\/([^?#]+)(?:\?([^#]*))?$/i
        );
        if (apiMatch) {
            const [, owner, repo, relPath, qs = ''] = apiMatch;
            const params = new URLSearchParams(qs);
            const branch = (params.get('ref') || 'ag-snapshot').trim();
            cleanUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${relPath}`;
        }

        const rawMatch = cleanUrl.match(
            /^https:\/\/raw\.githubusercontent\.com\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^?#]+)$/
        );
        if (rawMatch) {
            const [, owner, repo, branch, filePath] = rawMatch;
            const decodedBranch = decodeURIComponent(branch);
            endpoints.push({
                url: `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(decodedBranch)}`,
                headers: {
                    Accept: 'application/vnd.github.v3.raw'
                }
            });
            endpoints.push({ url: cleanUrl, headers: {} });
            endpoints.push({
                url: `https://ghfast.top/${cleanUrl}`,
                headers: {}
            });
        } else {
            endpoints.push({ url: cleanUrl, headers: {} });
        }

        return endpoints;
    }

    /**
     * 通用多镜像 JSON 拉取器：支持持久化 If-None-Match 304、内容寻址 ?_v=<sha>、GitHub base64 拆包、
     * 404 静默识别 (accept404) 与严格 SHA-256 镜像完整性校验 (expectedSha256)
     */
    async fetchRemoteFile(targetUrl, options = {}) {
        const cleanTarget = String(targetUrl || '').trim();
        if (!cleanTarget) {
            const err = new Error('未配置 GITHUB_SNAPSHOT_URL');
            err.statusCode = 400;
            throw err;
        }

        const useEtag = options.useEtag !== false && !options.force && !options.expectedSha256;
        const expectedSha = options.expectedSha256 ? String(options.expectedSha256).trim().toLowerCase() : null;
        const accept404 = Boolean(options.accept404);
        const candidates = this.buildCandidateEndpoints(cleanTarget);
        let lastError = null;
        let all404 = true;

        for (let idx = 0; idx < candidates.length; idx++) {
            const candidate = candidates[idx];
            const hasMoreMirrors = idx < candidates.length - 1;
            const memCached = useEtag ? this.etagCache.get(candidate.url) : null;
            const effectiveEtag = useEtag ? (memCached?.etag || options.cachedEtag || null) : null;

            const sep = candidate.url.includes('?') ? '&' : '?';
            let requestUrl = candidate.url;
            if (expectedSha) {
                requestUrl = `${candidate.url}${sep}_v=${expectedSha.slice(0, 12)}`;
            } else if (options.force || !effectiveEtag) {
                requestUrl = `${candidate.url}${sep}_t=${Date.now()}`;
            }

            const reqHeaders = {
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'User-Agent': 'CoreFeed-Router-Sync/3.0',
                ...candidate.headers
            };
            if (effectiveEtag) {
                reqHeaders['If-None-Match'] = effectiveEtag;
            }

            let isLocalHost = false;
            try {
                const host = new URL(requestUrl).hostname.toLowerCase();
                isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
            } catch (_) {}

            try {
                const response = await axios.get(requestUrl, {
                    timeout: 15000,
                    httpsAgent: getHttpsAgent({ keepAlive: true }),
                    responseType: 'text',
                    transformResponse: [(data) => data],
                    validateStatus: (status) => (status >= 200 && status < 300) || status === 304 || (accept404 && status === 404),
                    headers: reqHeaders,
                    ...(isLocalHost ? { proxy: false } : {})
                });

                if (response.status === 404 && accept404) {
                    lastError = Object.assign(new Error(`HTTP 404: ${candidate.url}`), { statusCode: 404 });
                    continue;
                }
                all404 = false;

                if (response.status === 304) {
                    const cachedEtag = String(response.headers?.etag || response.headers?.ETag || effectiveEtag || '').trim() || null;
                    if (cachedEtag) this.lastEtag = cachedEtag;
                    return {
                        data: memCached?.data || null,
                        rawText: null,
                        sourceUrl: candidate.url,
                        notModified: true,
                        notFound: false,
                        etag: cachedEtag
                    };
                }

                let rawText = typeof response.data === 'string'
                    ? response.data
                    : (Buffer.isBuffer(response.data) ? response.data.toString('utf8') : JSON.stringify(response.data));

                let parsed = JSON.parse(rawText);

                // 兼容上游代理剥离 Accept: vnd.github.v3.raw 后 GitHub Contents API 返回的 base64 JSON 包装
                if (
                    parsed &&
                    typeof parsed === 'object' &&
                    parsed.encoding === 'base64' &&
                    typeof parsed.content === 'string' &&
                    !parsed.domains &&
                    !Array.isArray(parsed.news) &&
                    !Array.isArray(parsed.articles) &&
                    !Array.isArray(parsed.issues) &&
                    !parsed.tracks
                ) {
                    rawText = Buffer.from(parsed.content.replace(/\s+/g, ''), 'base64').toString('utf8');
                    parsed = JSON.parse(rawText);
                }

                if (!parsed || typeof parsed !== 'object') {
                    const schemaErr = new Error('远端快照返回内容不是有效的 JSON 对象');
                    schemaErr.statusCode = 400;
                    throw schemaErr;
                }

                if (expectedSha) {
                    const actualSha = computeSha256(rawText);
                    if (actualSha !== expectedSha) {
                        const shaErr = new Error(
                            `镜像内容 SHA-256 校验不匹配 (${candidate.url}): expected=${expectedSha.slice(0, 12)}, actual=${actualSha.slice(0, 12)}`
                        );
                        shaErr.code = 'SHA_MISMATCH';
                        shaErr.statusCode = 502;
                        logger.warn('GITHUB-SYNC', shaErr.message);
                        throw shaErr;
                    }
                }

                if (typeof options.validatePayload === 'function' && !options.validatePayload(parsed)) {
                    const vErr = new Error('当前镜像返回数据结构不符合预期，尝试切换下一镜像');
                    vErr.statusCode = hasMoreMirrors ? 502 : 400;
                    throw vErr;
                }

                const responseEtag = String(response.headers?.etag || response.headers?.ETag || '').trim() || null;
                if (responseEtag && !expectedSha) {
                    this.lastEtag = responseEtag;
                    this.etagCache.set(candidate.url, {
                        etag: responseEtag,
                        data: parsed,
                        publishedAt: parsed.publishedAt || parsed.lastUpdated || null,
                        publishedBy: parsed.publishedBy || parsed.clientId || null
                    });
                }

                return {
                    data: parsed,
                    rawText,
                    sourceUrl: candidate.url,
                    notModified: false,
                    notFound: false,
                    etag: responseEtag
                };
            } catch (err) {
                all404 = false;
                lastError = err;
                if (err.statusCode === 400 && !hasMoreMirrors) {
                    throw err;
                }
            }
        }

        if (accept404 && all404) {
            return {
                data: null,
                rawText: null,
                sourceUrl: candidates[0]?.url || cleanTarget,
                notModified: false,
                notFound: true,
                etag: null
            };
        }

        const finalErr = new Error(lastError?.message || `无法从 ${cleanTarget} 拉取快照`);
        finalErr.statusCode = lastError?.statusCode || 502;
        if (lastError?.code) finalErr.code = lastError.code;
        throw finalErr;
    }

    /**
     * 向后兼容接口：拉取完整快照 JSON（供旧分支/单文件 mock 或直接调用方使用）
     */
    async fetchRemoteSnapshot(customSnapshotUrl = null, options = {}) {
        const targetUrl = this.resolveTargetSnapshotUrl(customSnapshotUrl);
        return await this.fetchRemoteFile(targetUrl, {
            ...options,
            validatePayload: (parsed) => Array.isArray(parsed.news) || Array.isArray(parsed.articles)
        });
    }

    async pullAndApply(options = {}) {
        const {
            snapshotUrl = null,
            force = false,
            trigger = 'manual',
            awaitAudioSync = true
        } = options;

        while (this._inflightPull) {
            if (!force) {
                return {
                    success: true,
                    updated: false,
                    applied: false,
                    skipped: true,
                    reason: 'sync-in-progress',
                    trigger
                };
            }
            if (this._inflightPull.force && this._inflightPull.snapshotUrl === snapshotUrl) {
                return await this._inflightPull.promise;
            }
            await this._inflightPull.promise.catch(() => null);
        }

        const entry = {
            force: Boolean(force),
            snapshotUrl,
            promise: null
        };
        this.isSyncing = true;
        this.lastSyncCheckAt = new Date().toISOString();

        const runPromise = (async () => {
            try {
                const targetUrl = this.resolveTargetSnapshotUrl(snapshotUrl);
                if (!targetUrl) {
                    const err = new Error('未配置 GITHUB_SNAPSHOT_URL');
                    err.statusCode = 400;
                    throw err;
                }

                await this.loadPersistedSyncState();
                const bucketKey = this.getSourceBucketKey(targetUrl);
                const bucket = this._persistedState.sources[bucketKey] || {
                    manifestEtag: null,
                    latestEtag: null,
                    domains: {}
                };

                const currentNewsBefore = this.stateManager ? (this.stateManager.get('newsData') || []) : [];
                const stateLastUpdatedBefore = this.stateManager ? this.stateManager.get('lastUpdated') : null;
                const stateSnapshotAtBefore = this.stateManager ? this.stateManager.get('lastSnapshotPublishedAt') : null;
                const knownSyncedAt = stateSnapshotAtBefore || this.lastSyncedPublishedAt || bucket.domains?.news?.publishedAt || null;
                const stateUpdatedMs = stateLastUpdatedBefore ? new Date(stateLastUpdatedBefore).getTime() : 0;
                const knownSyncedMs = knownSyncedAt ? new Date(knownSyncedAt).getTime() : 0;
                const localPolluted = isLocalNewsPolluted(currentNewsBefore);
                const localStateIntact =
                    !localPolluted &&
                    knownSyncedMs > 0 &&
                    !isNaN(knownSyncedMs) &&
                    stateUpdatedMs > 0 &&
                    !isNaN(stateUpdatedMs) &&
                    stateUpdatedMs === knownSyncedMs;

                // ========== 路径 1：Schema v3.0 manifest.json 分域增量同步 ==========
                const manifestUrl = deriveSiblingFileUrl(targetUrl, 'manifest.json');
                const manifestRes = manifestUrl
                    ? await this.fetchRemoteFile(manifestUrl, {
                        useEtag: !force && localStateIntact && Boolean(bucket.manifestEtag),
                        force: force || !localStateIntact,
                        cachedEtag: bucket.manifestEtag,
                        accept404: true
                    })
                    : { notFound: true };

                if (manifestRes.notModified && !force && localStateIntact) {
                    this.lastSyncStatus = 'up-to-date';
                    this.lastSyncError = null;
                    this.lastSyncSourceUrl = manifestRes.sourceUrl;
                    this.lastSyncMode = 'incremental';
                    if (!this.lastSyncedAt) this.lastSyncedAt = this.lastSyncCheckAt;
                    return {
                        success: true,
                        updated: false,
                        applied: false,
                        skipped: true,
                        reason: 'already-up-to-date',
                        notModified: true,
                        syncMode: 'incremental',
                        updatedDomains: [],
                        etag: manifestRes.etag || bucket.manifestEtag || this.lastEtag,
                        trigger,
                        snapshotUrl: manifestRes.sourceUrl,
                        publishedAt: bucket.domains?.news?.publishedAt || stateSnapshotAtBefore || null,
                        publishedBy: this.lastSyncedPublishedBy || this.stateManager?.get('lastPublishedBy') || null,
                        lastUpdated: stateLastUpdatedBefore || bucket.domains?.news?.publishedAt || null,
                        displayedCount: currentNewsBefore.length
                    };
                }

                if (!manifestRes.notFound && manifestRes.data && manifestRes.data.domains?.news?.file) {
                    const manifest = manifestRes.data;
                    const remoteNewsMeta = manifest.domains.news;
                    const remotePulseMeta = manifest.domains.pulse || null;
                    const remoteAudioMeta = manifest.domains.audio || null;
                    const localDomains = bucket.domains || {};

                    const localHasPulse = Boolean(this.stateManager?.get('socialPulse')?.issues?.length);
                    const localHasAudio = Boolean(this.stateManager?.get('audioBroadcast')?.trackCount);

                    const needNews = Boolean(
                        force ||
                        !localStateIntact ||
                        !localDomains.news?.sha256 ||
                        localDomains.news.sha256 !== remoteNewsMeta.sha256
                    );
                    const needPulse = Boolean(
                        remotePulseMeta &&
                        remotePulseMeta.file &&
                        remotePulseMeta.sha256 &&
                        (force || !localHasPulse || !localDomains.pulse?.sha256 || localDomains.pulse.sha256 !== remotePulseMeta.sha256)
                    );
                    const audioRemoved = Boolean(!remoteAudioMeta && localHasAudio);
                    const needAudio = Boolean(
                        remoteAudioMeta &&
                        remoteAudioMeta.file &&
                        remoteAudioMeta.sha256 &&
                        (force || !localHasAudio || !localDomains.audio?.sha256 || localDomains.audio.sha256 !== remoteAudioMeta.sha256)
                    );

                    if (!needNews && !needPulse && !needAudio && !audioRemoved) {
                        if (manifestRes.etag && manifestRes.etag !== bucket.manifestEtag) {
                            bucket.manifestEtag = manifestRes.etag;
                            this._persistedState.sources[bucketKey] = bucket;
                            await this.savePersistedSyncState();
                        }
                        this.lastSyncStatus = 'up-to-date';
                        this.lastSyncError = null;
                        this.lastSyncSourceUrl = manifestRes.sourceUrl;
                        this.lastSyncMode = 'incremental';
                        if (!this.lastSyncedAt) this.lastSyncedAt = this.lastSyncCheckAt;
                        const remotePublishedAt = remoteNewsMeta.publishedAt || manifest.publishedAt || null;
                        const remotePublishedBy = String(manifest.publishedBy || manifest.clientId || '').trim() || null;
                        if (remotePublishedAt) this.lastSyncedPublishedAt = remotePublishedAt;
                        if (remotePublishedBy) this.lastSyncedPublishedBy = remotePublishedBy;
                        return {
                            success: true,
                            updated: false,
                            applied: false,
                            skipped: true,
                            reason: 'already-up-to-date',
                            notModified: false,
                            syncMode: 'incremental',
                            updatedDomains: [],
                            etag: manifestRes.etag || bucket.manifestEtag || this.lastEtag,
                            trigger,
                            snapshotUrl: manifestRes.sourceUrl,
                            publishedAt: remotePublishedAt,
                            publishedBy: remotePublishedBy || this.lastSyncedPublishedBy,
                            lastUpdated: stateLastUpdatedBefore || remotePublishedAt,
                            displayedCount: currentNewsBefore.length
                        };
                    }

                    // 仅并行拉取 SHA-256 发生变化的域，并严格校验完整性
                    const [newsRes, pulseRes, audioRes] = await Promise.all([
                        needNews
                            ? this.fetchRemoteFile(deriveSiblingFileUrl(targetUrl, remoteNewsMeta.file), {
                                expectedSha256: remoteNewsMeta.sha256,
                                useEtag: false,
                                validatePayload: (p) => Array.isArray(p.news) && p.news.length > 0
                            })
                            : Promise.resolve(null),
                        needPulse
                            ? this.fetchRemoteFile(deriveSiblingFileUrl(targetUrl, remotePulseMeta.file), {
                                expectedSha256: remotePulseMeta.sha256,
                                useEtag: false,
                                validatePayload: (p) => Array.isArray(p.issues) && p.issues.length > 0
                            })
                            : Promise.resolve(null),
                        needAudio
                            ? this.fetchRemoteFile(deriveSiblingFileUrl(targetUrl, remoteAudioMeta.file), {
                                expectedSha256: remoteAudioMeta.sha256,
                                useEtag: false,
                                validatePayload: (p) => Boolean(p && typeof p.tracks === 'object')
                            })
                            : Promise.resolve(null)
                    ]);

                    const applied = await applyDomainUpdatesToRouter({
                        manifest,
                        newsDomain: newsRes?.data || null,
                        pulseDomain: pulseRes?.data || null,
                        audioDomain: audioRes?.data || null,
                        audioRemoved,
                        stateManager: this.stateManager,
                        newsAgentService: this.services.newsAgentService,
                        newsService: this.services.newsService,
                        audioBroadcastService: this.services.audioBroadcastService,
                        io: this.io,
                        sourceLabel: 'GitHub 增量快照同步',
                        snapshotUrl: manifestRes.sourceUrl,
                        syncAudioFiles: true,
                        awaitAudioSync
                    });

                    const nowSyncedIso = new Date().toISOString();
                    this._persistedState.sources[bucketKey] = {
                        manifestEtag: manifestRes.etag || bucket.manifestEtag || null,
                        latestEtag: bucket.latestEtag || null,
                        lastSyncedAt: nowSyncedIso,
                        domains: {
                            news: {
                                sha256: remoteNewsMeta.sha256,
                                editionId: remoteNewsMeta.editionId || manifest.editionId || null,
                                publishedAt: remoteNewsMeta.publishedAt || manifest.publishedAt || null
                            },
                            pulse: remotePulseMeta
                                ? {
                                    sha256: remotePulseMeta.sha256,
                                    latestKey: remotePulseMeta.latestKey || null,
                                    updatedAt: remotePulseMeta.updatedAt || null
                                }
                                : null,
                            audio: remoteAudioMeta
                                ? {
                                    sha256: remoteAudioMeta.sha256,
                                    updatedAt: remoteAudioMeta.updatedAt || null
                                }
                                : null
                        }
                    };
                    await this.savePersistedSyncState();

                    this.lastSyncedAt = nowSyncedIso;
                    this.lastSyncedPublishedAt = remoteNewsMeta.publishedAt || manifest.publishedAt || applied.lastUpdated;
                    this.lastSyncedPublishedBy = manifest.publishedBy || applied.publishedBy || null;
                    this.lastSyncStatus = 'synced';
                    this.lastSyncError = null;
                    this.lastSyncSourceUrl = manifestRes.sourceUrl;
                    this.lastSyncMode = 'incremental';

                    return {
                        success: true,
                        updated: true,
                        applied: true,
                        skipped: false,
                        notModified: false,
                        syncMode: 'incremental',
                        etag: manifestRes.etag || this.lastEtag,
                        trigger,
                        snapshotUrl: manifestRes.sourceUrl,
                        ...applied,
                        publishedBy: this.lastSyncedPublishedBy
                    };
                }

                // ========== 路径 2：平滑回退至单文件快照（兼容仅提供 latest.json 的历史 mock/节点） ==========
                const reusedLegacyFromManifestProbe = Boolean(
                    !manifestRes.notFound &&
                    !manifestRes.notModified &&
                    manifestRes.data &&
                    !manifestRes.data.domains?.news?.file &&
                    (Array.isArray(manifestRes.data.news) || Array.isArray(manifestRes.data.articles))
                );
                const { data, sourceUrl, notModified, etag } = reusedLegacyFromManifestProbe
                    ? manifestRes
                    : await this.fetchRemoteSnapshot(targetUrl, {
                        useEtag: !force && localStateIntact,
                        force: force || !localStateIntact,
                        cachedEtag: bucket.latestEtag
                    });

                if (notModified && !force && localStateIntact && !data) {
                    this.lastSyncStatus = 'up-to-date';
                    this.lastSyncError = null;
                    this.lastSyncSourceUrl = sourceUrl;
                    this.lastSyncMode = 'legacy-full';
                    if (!this.lastSyncedAt) this.lastSyncedAt = this.lastSyncCheckAt;
                    return {
                        success: true,
                        updated: false,
                        applied: false,
                        skipped: true,
                        reason: 'already-up-to-date',
                        notModified: true,
                        syncMode: 'legacy-full',
                        etag: etag || bucket.latestEtag || this.lastEtag,
                        trigger,
                        snapshotUrl: sourceUrl,
                        publishedAt: stateSnapshotAtBefore || this.lastSyncedPublishedAt || null,
                        publishedBy: this.lastSyncedPublishedBy || this.stateManager?.get('lastPublishedBy') || null,
                        lastUpdated: stateLastUpdatedBefore || null,
                        displayedCount: currentNewsBefore.length
                    };
                }

                const newsList = Array.isArray(data?.news)
                    ? data.news
                    : (Array.isArray(data?.articles) ? data.articles : null);

                if (!Array.isArray(newsList) || newsList.length === 0) {
                    const invalidErr = new Error('GitHub 快照中不包含有效的 news 数组');
                    invalidErr.statusCode = 400;
                    throw invalidErr;
                }

                const remotePublishedAt = data.publishedAt || data.lastUpdated || null;
                const remotePublishedBy = String(data.publishedBy || data.clientId || '').trim() || null;
                const remoteMs = remotePublishedAt ? new Date(remotePublishedAt).getTime() : 0;

                const remotePulseUpdatedAt = data.socialPulseUpdatedAt || data.socialPulse?.updatedAt || null;
                const localPulseUpdatedAt = this.stateManager
                    ? (this.stateManager.get('lastSocialPulseUpdatedAt') || this.stateManager.get('socialPulse')?.updatedAt || null)
                    : null;
                const hasNewerPulse = Boolean(
                    data.socialPulse &&
                    Array.isArray(data.socialPulse.issues) &&
                    data.socialPulse.issues.length > 0 &&
                    (!localPulseUpdatedAt || (remotePulseUpdatedAt && remotePulseUpdatedAt !== localPulseUpdatedAt))
                );

                const remoteAudioUpdatedAt = data.audioBroadcastUpdatedAt || data.audioBroadcast?.updatedAt || null;
                const localAudioUpdatedAt = this.stateManager
                    ? (this.stateManager.get('lastAudioBroadcastUpdatedAt') || this.stateManager.get('audioBroadcast')?.updatedAt || null)
                    : null;
                const hasNewerAudio = Boolean(
                    data.audioBroadcast &&
                    data.audioBroadcast.tracks &&
                    Object.keys(data.audioBroadcast.tracks).length > 0 &&
                    (!localAudioUpdatedAt || (remoteAudioUpdatedAt && remoteAudioUpdatedAt !== localAudioUpdatedAt))
                );

                const isSameRemoteSnapshot =
                    localStateIntact &&
                    !hasNewerPulse &&
                    !hasNewerAudio &&
                    (notModified ||
                        (remoteMs > 0 &&
                            !isNaN(remoteMs) &&
                            remoteMs === knownSyncedMs));

                if (!force && isSameRemoteSnapshot) {
                    this.lastSyncStatus = 'up-to-date';
                    this.lastSyncError = null;
                    this.lastSyncSourceUrl = sourceUrl;
                    this.lastSyncMode = 'legacy-full';
                    if (!this.lastSyncedAt) this.lastSyncedAt = this.lastSyncCheckAt;
                    if (remotePublishedAt) this.lastSyncedPublishedAt = remotePublishedAt;
                    if (remotePublishedBy) {
                        this.lastSyncedPublishedBy = remotePublishedBy;
                        if (this.stateManager && !this.stateManager.get('lastPublishedBy')) {
                            this.stateManager.set('lastPublishedBy', remotePublishedBy, false);
                        }
                    }
                    return {
                        success: true,
                        updated: false,
                        applied: false,
                        skipped: true,
                        reason: 'already-up-to-date',
                        notModified: Boolean(notModified),
                        syncMode: 'legacy-full',
                        etag: etag || this.lastEtag,
                        trigger,
                        snapshotUrl: sourceUrl,
                        publishedAt: remotePublishedAt,
                        publishedBy: remotePublishedBy || this.lastSyncedPublishedBy,
                        lastUpdated: stateLastUpdatedBefore || remotePublishedAt,
                        displayedCount: currentNewsBefore.length
                    };
                }

                const applied = await applySnapshotToRouter(data, {
                    stateManager: this.stateManager,
                    newsAgentService: this.services.newsAgentService,
                    newsService: this.services.newsService,
                    audioBroadcastService: this.services.audioBroadcastService,
                    io: this.io,
                    sourceLabel: 'GitHub 快照中转同步',
                    snapshotUrl: sourceUrl,
                    syncAudioFiles: true,
                    awaitAudioSync
                });

                const nowSyncedIso = new Date().toISOString();
                if (etag) {
                    bucket.latestEtag = etag;
                    bucket.lastSyncedAt = nowSyncedIso;
                    this._persistedState.sources[bucketKey] = bucket;
                    await this.savePersistedSyncState();
                }

                this.lastSyncedAt = nowSyncedIso;
                this.lastSyncedPublishedAt = remotePublishedAt || applied.lastUpdated;
                this.lastSyncedPublishedBy = remotePublishedBy || applied.publishedBy || null;
                this.lastSyncStatus = 'synced';
                this.lastSyncError = null;
                this.lastSyncSourceUrl = sourceUrl;
                this.lastSyncMode = 'legacy-full';

                return {
                    success: true,
                    updated: true,
                    applied: true,
                    skipped: false,
                    notModified: false,
                    syncMode: 'legacy-full',
                    etag: etag || this.lastEtag,
                    trigger,
                    snapshotUrl: sourceUrl,
                    ...applied,
                    publishedBy: this.lastSyncedPublishedBy
                };
            } catch (err) {
                this.lastSyncStatus = 'error';
                this.lastSyncError = err.message;
                throw err;
            } finally {
                if (this._inflightPull === entry) {
                    this._inflightPull = null;
                    this.isSyncing = false;
                }
            }
        })();

        entry.promise = runPromise;
        this._inflightPull = entry;
        return await runPromise;
    }

    getStatus() {
        const statePublishedBy = this.stateManager ? this.stateManager.get('lastPublishedBy') : null;
        const publishedBy = statePublishedBy || this.lastSyncedPublishedBy || null;
        const lastSnapshotPublishedAt =
            (this.stateManager && this.stateManager.get('lastSnapshotPublishedAt')) ||
            this.lastSyncedPublishedAt ||
            null;
        const clientId = String(
            config.githubSync?.clientId ||
            config.agent?.clientId ||
            process.env.CLIENT_ID ||
            process.env.AG_CLIENT_ID ||
            os.hostname() ||
            'antigravity-client'
        ).trim();
        return {
            enabled: Boolean(config.githubSync?.enabled ?? config.agent?.githubSyncEnabled ?? true),
            pushEnabled: Boolean(config.githubSync?.pushEnabled ?? config.agent?.githubPushEnabled ?? true),
            clientId,
            snapshotUrl: this.resolveTargetSnapshotUrl(null),
            branch:
                process.env.AG_GITHUB_BRANCH ||
                config.githubSync?.branch ||
                config.agent?.githubBranch ||
                'ag-snapshot',
            intervalMinutes: Number(
                config.githubSync?.intervalMinutes || config.agent?.githubSyncIntervalMinutes || 60
            ),
            cooldownMinutes: Number(
                config.githubSync?.cooldownMinutes ?? config.agent?.githubCooldownMinutes ?? 30
            ),
            isSyncing: this.isSyncing,
            lastSyncCheckAt: this.lastSyncCheckAt,
            lastSyncedAt: this.lastSyncedAt,
            lastSyncAt: this.lastSyncedAt || this.lastSyncCheckAt || null,
            lastSyncedPublishedAt: this.lastSyncedPublishedAt || lastSnapshotPublishedAt,
            lastSnapshotPublishedAt,
            lastSyncedPublishedBy: publishedBy,
            publishedBy,
            lastPublishedBy: publishedBy,
            lastEtag: this.lastEtag,
            lastSyncMode: this.lastSyncMode,
            lastSyncStatus: this.lastSyncStatus,
            lastSyncError: this.lastSyncError,
            lastSyncSourceUrl: this.lastSyncSourceUrl
        };
    }
}

module.exports = {
    publishSnapshotToGitHub,
    fetchRemoteSnapshotViaGit,
    resolveRemoteBranchSha,
    applySnapshotToRouter,
    applyDomainUpdatesToRouter,
    checkRemoteSnapshotCooldown,
    isLocalNewsPolluted,
    isSuspectedTestFixtureNews,
    GitHubSyncManager
};
