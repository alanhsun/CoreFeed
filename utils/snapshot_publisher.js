/**
 * CoreFeed v3.0 — 采编客户端 GitHub 快照发布与冷却协同模块 (utils/snapshot_publisher.js)
 *
 * 从 `utils/github_sync.js` 独立拆出的客户端发布侧逻辑：
 *   - 仅在采编发布端 (`scripts/ag-publish.js` / `scripts/ag-sync-pulse.js` / `scripts/ag-harvest.js`) 使用；
 *   - 负责 Git Plumbing 单提交孤儿分支写入、`--force-with-lease` 并发锁、Git 权威基线读取与多客户端冷却检查；
 *   - 软路由常驻服务端无需直接调用本模块的 Git 写命令。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');
const { buildSnapshotBriefingFiles } = require('./briefing_formatter');
const { TRACK_SNAPSHOT_FILENAMES } = require('../services/audio_broadcast_service');
const {
    SNAPSHOT_SCHEMA_VERSION,
    DEFAULT_SNAPSHOT_URL,
    deriveSiblingFileUrl,
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

    const { GitHubSyncManager } = require('./github_sync');
    const manager = options.syncManager || new GitHubSyncManager();
    const targetUrl = manager.resolveTargetSnapshotUrl(options.snapshotUrl || null);
    const manifestUrl = deriveSiblingFileUrl(targetUrl, 'manifest.json');

    try {
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

module.exports = {
    resolveRemoteBranchSha,
    readGitRefJson,
    readSnapshotFromGitRef,
    fetchRemoteSnapshotViaGit,
    publishSnapshotToGitHub,
    checkRemoteSnapshotCooldown
};
