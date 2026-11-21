process.env.NODE_ENV = 'test';
process.env.NO_PROXY = '127.0.0.1,localhost';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const config = require('../config');
const stateManager = require('../services/state_manager');
const { app, server, io, services } = require('../server');
const {
    SNAPSHOT_SCHEMA_VERSION,
    computeSha256,
    splitCandidateParagraphs,
    deriveSiblingFileUrl,
    buildSnapshotArtifacts,
    reassembleCombinedSnapshot
} = require('../utils/snapshot_schema');
const {
    publishSnapshotToGitHub,
    applySnapshotToRouter,
    checkRemoteSnapshotCooldown,
    GitHubSyncManager
} = require('../utils/github_sync');
const ScheduleManager = require('../utils/schedule_manager');
const { inspectCandidates, computeHarvestId } = require('../scripts/ag-harvest');
const { runPublish } = require('../scripts/ag-publish');
const { runSyncPulse } = require('../scripts/ag-sync-pulse');
const { AudioBroadcastService } = require('../services/audio_broadcast_service');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const AUDIO_DIR = path.join(DATA_DIR, 'audio');

const BACKUP_TARGETS = [
    path.join(DATA_DIR, 'news.json'),
    path.join(DATA_DIR, 'summary.json'),
    path.join(DATA_DIR, 'state.json'),
    path.join(DATA_DIR, 'social_pulse.json'),
    path.join(DATA_DIR, 'audio_broadcast.json'),
    path.join(DATA_DIR, 'sync_state.json'),
    path.join(DATA_DIR, 'ag_candidates.json'),
    path.join(DATA_DIR, 'ag_compiled.json'),
    path.join(AUDIO_DIR, 'briefing-news.mp3'),
    path.join(AUDIO_DIR, 'briefing-pulse.mp3')
];

function initGitRepoPair(tmpRoot) {
    const bareRemoteDir = path.join(tmpRoot, 'remote.git');
    const workRepoDir = path.join(tmpRoot, 'work');
    fs.mkdirSync(bareRemoteDir, { recursive: true });
    fs.mkdirSync(workRepoDir, { recursive: true });
    execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
    execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'CoreFeed P3 Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'p3-test@corefeed.local'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
    fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# CoreFeed P3 Test Repo\n', 'utf8');
    execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
    execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });
    return { bareRemoteDir, workRepoDir };
}

function createSampleDigest(dateStr, extraTopic = 'AI Chips') {
    return {
        schema_version: '1.0',
        date: dateStr,
        mode: 'daily',
        generated_at: `${dateStr}T07:15:00+08:00`,
        window_hours: 24,
        headline: `${dateStr} 欧美社媒热议聚焦 ${extraTopic} 与宏观市场走势`,
        executive_summary: {
            overview: `${dateStr} 欧美三大社媒平台围绕 ${extraTopic} 与宏观资产定价展开密集讨论。`,
            platform_mood: {
                X: `${extraTopic} 基准测试实测数据在科技圈持续刷屏。`,
                Reddit: `多语种板块热议 ${extraTopic} 供应链与定价策略。`
            }
        },
        transatlantic_comparisons: [],
        clusters: [
            {
                id: `cluster-${dateStr}-1`,
                region: 'US',
                countries: ['US'],
                languages: ['en'],
                category: '科技',
                platforms: ['X', 'Reddit'],
                heat_score: 94,
                title_zh: `${extraTopic} 引发海外开发者密集讨论`,
                hook_one_liner: `围绕 ${extraTopic} 的最新评测与定价策略在 X 与 Reddit 上掀起激烈争论。`,
                trigger_and_context: `${extraTopic} 发布最新技术路线图后，海外社区围绕性价比与生态锁定展开辩论。`,
                camps: [
                    { label: '看好派', share_estimate: '约 55%', summary: '认为能效比和生态工具链具备显著优势。' },
                    { label: '质疑派', share_estimate: '约 45%', summary: '担忧采购成本与供应瓶颈。' }
                ],
                featured_quotes: [
                    {
                        platform: 'X',
                        community_or_handle: '@tech_analyst',
                        language: 'en',
                        metrics: '1,200 赞',
                        quote_zh: '在这一价位段下，基准测试成绩相当有说服力。',
                        quote_original: 'Benchmark numbers look compelling at this price tier.',
                        source_url: `https://x.com/tech_analyst/status/${dateStr.replace(/-/g, '')}01`
                    }
                ]
            },
            {
                id: `cluster-${dateStr}-2`,
                region: 'EU',
                countries: ['DE', 'FR'],
                languages: ['de', 'fr'],
                category: '财经',
                platforms: ['Reddit'],
                heat_score: 81,
                title_zh: '全球债券收益率波动牵动科技股估值预期',
                hook_one_liner: '市场参与者正在重新评估降息节奏对成长型科技资产的定价影响。',
                trigger_and_context: '欧美核心通胀读数分化引发长期国债收益率震荡。',
                camps: [],
                featured_quotes: []
            }
        ]
    };
}

function createBloatedArticle(i) {
    const p1 = `Paragraph one of global report #${i}: Central banks and industrial regulators coordinate new cross-border settlement frameworks across major financial corridors.`;
    const p2 = `Paragraph two of global report #${i}: Energy grid operators reported record renewable storage deployment while semiconductor supply chains expanded regional capacity.`;
    const p3 = `Paragraph three of global report #${i}: Economists noted that trade flows and capital expenditures remained resilient despite heightened geopolitical uncertainty.`;
    const fullText = `${p1}\n\n${p2}\n\n${p3}`;
    const zh1 = `全球报道第${i}篇第一段：多国央行与产业监管机构正在主要金融走廊推进跨境结算新框架，提升清算韧性与透明度。`;
    const zh2 = `全球报道第${i}篇第二段：能源电网运营商披露可再生能源储能装机再创新高，同时半导体供应链继续扩大区域产能布局。`;
    const zh3 = `全球报道第${i}篇第三段：经济学家指出，尽管地缘政治不确定性犹存，全球贸易流向与资本开支仍展现出较强韧性。`;
    const summary = `围绕全球金融结算、能源储能与半导体产能的最新进展，报道第${i}篇披露了多国政策协同与产业链投资的关键细节，引发市场高度关注。`;
    return {
        id: `slim-art-${i}`,
        title: `Global Report #${i}: Cross-Border Settlement & Clean Grid Expansion`,
        translatedTitle: `全球要闻第${i}篇：跨境金融结算与清洁电网储能加速扩容`,
        summary,
        description: p1,
        translatedDescription: summary,
        content: fullText,
        fullText,
        translatedContent: `${zh1}\n\n${zh2}\n\n${zh3}`,
        originalParagraphs: [p1, p2, p3],
        translatedParagraphs: [zh1, zh2, zh3],
        keyPoints: [
            `要点一：第${i}篇聚焦跨境金融结算框架升级`,
            `要点二：电网储能与半导体区域产能同步扩张`,
            `要点三：资本开支与贸易流向维持韧性`
        ],
        url: `https://www.reuters.com/world/slim-report-${i}`,
        urlToImage: `https://images.example.com/slim-${i}.jpg`,
        publishedAt: '2026-11-20T06:30:00.000Z',
        region: '国际',
        category: '财经',
        aiCompiled: true,
        qualityScore: 91,
        source: { id: 'reuters', name: 'Reuters (路透社)', authority: 5, language: 'en' },
        relatedSources: [
            { name: 'Bloomberg (彭博社)', url: `https://www.bloomberg.com/news/slim-${i}`, title: `Bloomberg take #${i}` }
        ]
    };
}

function rawHttpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks)
                });
            });
        });
        req.on('error', reject);
    });
}

describe('CoreFeed v3.0 — Phase 3 Snapshot Slimming, Incremental Sync, Runtime Perf & Self-Hosted Assets', () => {
    const backups = new Map();
    let baseUrl = '';
    let ownsServer = false;

    before(async () => {
        for (const p of BACKUP_TARGETS) {
            backups.set(p, fs.existsSync(p) ? fs.readFileSync(p) : null);
        }
        stateManager.reset();
        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
            });
            ownsServer = true;
        }
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
    });

    after(async () => {
        if (ownsServer && server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
        for (const [p, buf] of backups.entries()) {
            if (buf === null) {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } else {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, buf);
            }
        }
    });

    it('1. Schema v3.0 slimming removes duplicate fields & latest.json (Q1=B), shrinks payload >50%, and preserves extraPoolNews', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p3-slim-'));
        try {
            const { bareRemoteDir, workRepoDir } = initGitRepoPair(tmpRoot);
            const articles25 = Array.from({ length: 25 }, (_, i) => createBloatedArticle(i + 1));
            const extra2 = [createBloatedArticle(26), createBloatedArticle(27)];
            const fullPool27 = [...articles25, ...extra2];
            const summaryObj = {
                title: '2026年11月20日早间 全球要闻深度综述：跨境金融与能源转型共振',
                content: '### 宏观与金融\n多国央行加速跨境结算合作 [NEWS_1]。\n\n### 能源与科技\n电网储能与半导体产能扩张持续推进 [NEWS_2]。',
                htmlContent: '<h3>宏观与金融</h3><p>多国央行加速跨境结算合作 <a href="#news-1">[1]</a>。</p>'
            };
            const pulseBundle = {
                updatedAt: '2026-11-20T07:15:00.000Z',
                issues: [
                    createSampleDigest('2026-11-20', 'Blackwell'),
                    createSampleDigest('2026-11-19', 'Fed Minutes')
                ]
            };
            const audioBundle = {
                updatedAt: '2026-11-20T07:45:00.000Z',
                tracks: {
                    news: {
                        fileName: 'briefing-news.mp3',
                        title: '早间全球要闻双主播精播',
                        editionId: 'ed-112233445566',
                        sha256: 'a'.repeat(64),
                        sizeBytes: 123456,
                        durationSec: 240,
                        chapters: [{ index: 1, title: '开场', speaker: 'Serena', startSec: 0, durationSec: 15, text: '早上好。' }]
                    }
                }
            };

            const bloatedV2Payload = {
                version: '2.0',
                editionId: 'ed-112233445566',
                publishedAt: '2026-11-20T07:40:00.000Z',
                lastUpdated: '2026-11-20T07:40:00.000Z',
                publishedBy: 'p3-slim-tester',
                news: articles25,
                allEnhancedNews: fullPool27,
                summary: summaryObj,
                summaryArticle: summaryObj,
                socialPulse: pulseBundle,
                audioBroadcast: audioBundle,
                sourceStats: [{ id: 'reuters', name: 'Reuters', count: 25, status: 'ok' }]
            };

            const naiveV2Bytes = Buffer.byteLength(JSON.stringify(bloatedV2Payload, null, 2) + '\n', 'utf8');
            const artifacts = buildSnapshotArtifacts(bloatedV2Payload);
            assert.equal(artifacts.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
            assert.ok(
                artifacts.sizes.totalJson < naiveV2Bytes * 0.5,
                `v3.0 split JSON (${artifacts.sizes.totalJson} B) must be >50% smaller than naive v2 latest.json (${naiveV2Bytes} B)`
            );

            const pub = publishSnapshotToGitHub(bloatedV2Payload, {
                repoDir: workRepoDir,
                remote: 'origin',
                branch: 'ag-snapshot'
            });
            assert.equal(pub.success, true);
            assert.equal(pub.schemaVersion, '3.0');

            const treeFiles = execFileSync('git', ['--git-dir', bareRemoteDir, 'ls-tree', '--name-only', 'refs/heads/ag-snapshot'], { encoding: 'utf8' })
                .trim()
                .split(/\r?\n/);
            assert.ok(treeFiles.includes('manifest.json'));
            assert.ok(treeFiles.includes('news.json'));
            assert.ok(treeFiles.includes('pulse.json'));
            assert.ok(treeFiles.includes('audio.json'));
            assert.ok(treeFiles.includes('briefing.json'));
            assert.ok(treeFiles.includes('briefing.md'));
            assert.ok(!treeFiles.includes('latest.json'), 'Q1=B: ag-snapshot must NOT contain latest.json');

            const newsDoc = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:news.json'], { encoding: 'utf8' }));
            assert.equal(newsDoc.allEnhancedNews, undefined, 'news.json must omit duplicate allEnhancedNews');
            assert.equal(newsDoc.summary, undefined, 'news.json must omit duplicate summary');
            assert.equal(newsDoc.summaryArticle.htmlContent, undefined, 'summaryArticle must omit server-rebuilt htmlContent');
            assert.equal(newsDoc.news.length, 25);
            assert.equal(newsDoc.extraPoolNews.length, 2, 'extraPoolNews must retain overflow pool articles');
            assert.equal(newsDoc.totalPoolCount, 27);

            for (const art of newsDoc.news) {
                assert.equal(art.fullText, undefined);
                assert.equal(art.content, undefined);
                assert.equal(art.translatedContent, undefined);
                assert.equal(art.translatedDescription, undefined);
                assert.equal(art.description, undefined);
                assert.equal(art.originalParagraphs.length, 3);
                assert.equal(art.translatedParagraphs.length, 3);
            }

            // Reassembly round-trip check
            const manifestDoc = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' }));
            const pulseDoc = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:pulse.json'], { encoding: 'utf8' }));
            const audioDoc = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:audio.json'], { encoding: 'utf8' }));
            const reassembled = reassembleCombinedSnapshot({
                manifest: manifestDoc,
                newsDomain: newsDoc,
                pulseDomain: pulseDoc,
                audioDomain: audioDoc
            });
            assert.equal(reassembled.news.length, 25);
            assert.equal(reassembled.extraPoolNews.length, 2);
            assert.equal(reassembled.socialPulse.issueCount, 2);
            assert.equal(reassembled.audioBroadcast.trackCount, 1);

            // Sibling URL derivation sanity across raw, GitHub API & mirror forms
            assert.equal(
                deriveSiblingFileUrl('https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json', 'pulse.json'),
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/pulse.json'
            );
            assert.equal(
                deriveSiblingFileUrl('https://api.github.com/repos/alanhsun/CoreFeed/contents/latest.json?ref=ag-snapshot', 'manifest.json'),
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json'
            );
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('2. Cross-publish domain SHA-256 stability: pulse sync preserves exact news.sha256, and news publish preserves exact pulse.sha256', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p3-sha-'));
        try {
            const { bareRemoteDir, workRepoDir } = initGitRepoPair(tmpRoot);
            const compiled1Path = path.join(tmpRoot, 'compiled1.json');
            const compiled2Path = path.join(tmpRoot, 'compiled2.json');
            const pulseWs = path.join(tmpRoot, 'pulse-ws');
            fs.mkdirSync(path.join(pulseWs, 'data', 'digests'), { recursive: true });
            fs.writeFileSync(
                path.join(pulseWs, 'data', 'digests', '2026-11-20.json'),
                JSON.stringify(createSampleDigest('2026-11-20', 'Gemini 3'), null, 2),
                'utf8'
            );

            // Clear any pre-existing local pulse/audio so Step A starts clean
            if (fs.existsSync(config.storage.socialPulseFile)) fs.unlinkSync(config.storage.socialPulseFile);
            if (fs.existsSync(config.storage.audioBroadcastFile)) fs.unlinkSync(config.storage.audioBroadcastFile);
            stateManager.updateSocialPulse(null, false);
            stateManager.updateAudioBroadcast(null, false);

            const t1 = '2026-11-20T00:00:00.000Z';
            fs.writeFileSync(compiled1Path, JSON.stringify({
                publishedAt: t1,
                articles: [createBloatedArticle(1)],
                summaryArticle: {
                    title: '第一期全球要闻综述',
                    content: '### 宏观\n第一期深度综述正文 [NEWS_1]。'
                }
            }), 'utf8');

            // Step A: Publish news edition 1
            await runPublish({
                candidates: path.join(tmpRoot, 'missing_cand.json'),
                compiled: compiled1Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'pub-a'
            });
            const m1 = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' }));
            assert.ok(m1.domains.news.sha256);
            assert.equal(m1.domains.pulse, null);

            // Step B: Sync social pulse only -> news.sha256 MUST stay byte-for-byte identical
            await runSyncPulse({
                sourceDir: pulseWs,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'pulse-b'
            });
            const m2 = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' }));
            assert.equal(m2.domains.news.sha256, m1.domains.news.sha256, 'Pulse-only sync MUST NOT alter news.json SHA-256');
            assert.equal(m2.publishedAt, m1.publishedAt, 'Pulse-only sync MUST NOT alter news publishedAt');
            assert.ok(m2.domains.pulse && m2.domains.pulse.sha256, 'manifest.domains.pulse must now be populated');

            // Step C: Publish news edition 2 -> pulse.sha256 MUST stay byte-for-byte identical
            const t2 = '2026-11-20T08:00:00.000Z';
            fs.writeFileSync(compiled2Path, JSON.stringify({
                publishedAt: t2,
                articles: [createBloatedArticle(2)],
                summaryArticle: {
                    title: '第二期全球要闻综述',
                    content: '### 科技\n第二期全新综述正文 [NEWS_1]。'
                }
            }), 'utf8');
            await runPublish({
                candidates: path.join(tmpRoot, 'missing_cand.json'),
                compiled: compiled2Path,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'pub-a',
                force: true
            });
            const m3 = JSON.parse(execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:manifest.json'], { encoding: 'utf8' }));
            assert.notEqual(m3.domains.news.sha256, m1.domains.news.sha256, 'New news edition must update news.json SHA-256');
            assert.equal(m3.domains.pulse.sha256, m2.domains.pulse.sha256, 'News-only publish MUST NOT alter pulse.json SHA-256');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('3. Incremental manifest.json sync, restart ETag persistence (sync_state.json), SHA-256 mirror tamper rejection, audio removal & lightweight cooldown', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p3-inc-'));
        const syncStatePath = path.join(tmpRoot, 'sync_state.json');

        const fakeMp3V1 = Buffer.alloc(2048, 0x49);
        const basePayload = {
            editionId: 'ed-aaaa11112222',
            publishedAt: '2026-11-20T07:40:00.000Z',
            lastUpdated: '2026-11-20T07:40:00.000Z',
            publishedBy: 'inc-publisher',
            news: [createBloatedArticle(1)],
            summaryArticle: { title: '增量测试综述', content: '### 宏观\n增量同步测试 [NEWS_1]。' },
            socialPulse: { updatedAt: '2026-11-20T07:15:00.000Z', issues: [createSampleDigest('2026-11-20', 'PulseV1')] },
            audioBroadcast: {
                updatedAt: '2026-11-20T07:45:00.000Z',
                tracks: {
                    news: {
                        fileName: 'briefing-news.mp3',
                        title: '早间播报',
                        editionId: 'ed-aaaa11112222',
                        sha256: computeSha256(fakeMp3V1),
                        sizeBytes: fakeMp3V1.length,
                        durationSec: 60,
                        chapters: []
                    }
                }
            }
        };

        let currentArtifacts = buildSnapshotArtifacts(basePayload);
        let manifestEtag = '"m-etag-v1"';
        const hits = { manifest: 0, news: 0, pulse: 0, audio: 0, mp3: 0, latest: 0 };

        const goodServer = http.createServer((req, res) => {
            const urlPath = (req.url || '').split('?')[0];
            if (urlPath.endsWith('/manifest.json')) {
                hits.manifest++;
                if (req.headers['if-none-match'] === manifestEtag) {
                    res.writeHead(304, { ETag: manifestEtag });
                    res.end();
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json', ETag: manifestEtag });
                res.end(currentArtifacts.manifestJson);
                return;
            }
            if (urlPath.endsWith('/news.json')) {
                hits.news++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(currentArtifacts.newsJson);
                return;
            }
            if (urlPath.endsWith('/pulse.json')) {
                hits.pulse++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(currentArtifacts.pulseJson);
                return;
            }
            if (urlPath.endsWith('/audio.json')) {
                hits.audio++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(currentArtifacts.audioJson);
                return;
            }
            if (urlPath.endsWith('/briefing-news.mp3')) {
                hits.mp3++;
                res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
                res.end(fakeMp3V1);
                return;
            }
            if (urlPath.endsWith('/latest.json')) {
                hits.latest++;
            }
            res.writeHead(404);
            res.end();
        });

        // Stale/tampered mirror returning mismatched news.json bytes
        let tamperedHits = 0;
        const tamperedMirror = http.createServer((req, res) => {
            const urlPath = (req.url || '').split('?')[0];
            if (urlPath.endsWith('/news.json')) {
                tamperedHits++;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ news: [{ id: 'stale-mirror-news', translatedTitle: '篡改或陈旧镜像数据' }] }));
                return;
            }
            res.writeHead(404);
            res.end();
        });

        await Promise.all([
            new Promise((r, j) => goodServer.listen(0, '127.0.0.1', (e) => (e ? j(e) : r()))),
            new Promise((r, j) => tamperedMirror.listen(0, '127.0.0.1', (e) => (e ? j(e) : r())))
        ]);

        const goodBase = `http://127.0.0.1:${goodServer.address().port}/alanhsun/CoreFeed/ag-snapshot`;
        const tamperedBase = `http://127.0.0.1:${tamperedMirror.address().port}/alanhsun/CoreFeed/ag-snapshot`;
        const manifestUrl = `${goodBase}/manifest.json`;

        try {
            stateManager.reset();
            const mgr1 = new GitHubSyncManager(services, io, stateManager, { syncStateFile: syncStatePath });

            // Pull #1: downloads all 3 domains and persists sync_state.json
            const r1 = await mgr1.pullAndApply({ snapshotUrl: manifestUrl, force: false, trigger: 'boot' });
            assert.equal(r1.applied, true);
            assert.equal(r1.syncMode, 'incremental');
            assert.deepEqual(r1.updatedDomains, ['news', 'pulse', 'audio']);
            assert.equal(hits.news, 1);
            assert.equal(hits.pulse, 1);
            assert.equal(hits.audio, 1);
            assert.ok(fs.existsSync(syncStatePath), 'sync_state.json must be persisted to disk');

            // Pull #2 after simulated restart (fresh GitHubSyncManager instance sharing syncStatePath): HTTP 304 -> 0 domain downloads!
            const mgrAfterRestart = new GitHubSyncManager(services, io, stateManager, { syncStateFile: syncStatePath });
            const r2 = await mgrAfterRestart.pullAndApply({ snapshotUrl: manifestUrl, force: false, trigger: 'periodic' });
            assert.equal(r2.applied, false);
            assert.equal(r2.notModified, true);
            assert.equal(r2.reason, 'already-up-to-date');
            assert.equal(hits.news, 1, 'Restart 304 poll must NOT re-download news.json');
            assert.equal(hits.pulse, 1, 'Restart 304 poll must NOT re-download pulse.json');
            assert.equal(hits.audio, 1, 'Restart 304 poll must NOT re-download audio.json');

            // Pull #3: Update ONLY pulse.json + manifest.json -> downloads ONLY pulse.json!
            currentArtifacts = buildSnapshotArtifacts({
                ...basePayload,
                socialPulse: {
                    updatedAt: '2026-11-20T12:15:00.000Z',
                    issues: [createSampleDigest('2026-11-20', 'PulseV2-Incremental')]
                }
            });
            manifestEtag = '"m-etag-v2"';
            const r3 = await mgrAfterRestart.pullAndApply({ snapshotUrl: manifestUrl, force: false, trigger: 'periodic' });
            assert.equal(r3.applied, true);
            assert.deepEqual(r3.updatedDomains, ['pulse']);
            assert.equal(hits.news, 1, 'Pulse-only update must NOT re-download news.json');
            assert.equal(hits.audio, 1, 'Pulse-only update must NOT re-download audio.json');
            assert.equal(hits.pulse, 2, 'Pulse-only update must download pulse.json exactly once');

            // Pull #4: Drop audio domain (audio: null) -> clears local audioBroadcast without re-downloading news/pulse
            currentArtifacts = buildSnapshotArtifacts({
                ...basePayload,
                socialPulse: {
                    updatedAt: '2026-11-20T12:15:00.000Z',
                    issues: [createSampleDigest('2026-11-20', 'PulseV2-Incremental')]
                },
                audioBroadcast: null
            });
            manifestEtag = '"m-etag-v3"';
            const r4 = await mgrAfterRestart.pullAndApply({ snapshotUrl: manifestUrl, force: false, trigger: 'periodic' });
            assert.equal(r4.applied, true);
            assert.deepEqual(r4.updatedDomains, ['audio']);
            assert.equal(stateManager.get('audioBroadcast'), null, 'Removing audio in manifest must clear local audioBroadcast');
            assert.equal(hits.news, 1);
            assert.equal(hits.pulse, 2);
            assert.equal(hits.audio, 1);

            // Pull #5: Mirror SHA-256 tamper/stale rejection -> tampered mirror rejected, good mirror succeeds!
            const mgrMirrorTest = new GitHubSyncManager(services, io, stateManager, {
                syncStateFile: path.join(tmpRoot, 'sync_state_mirror.json')
            });
            const origBuildEndpoints = mgrMirrorTest.buildCandidateEndpoints.bind(mgrMirrorTest);
            mgrMirrorTest.buildCandidateEndpoints = (url) => {
                if (url.endsWith('/news.json')) {
                    return [
                        { label: 'stale-tampered-mirror', url: `${tamperedBase}/news.json` },
                        { label: 'good-origin', url: `${goodBase}/news.json` }
                    ];
                }
                return origBuildEndpoints(url);
            };
            const r5 = await mgrMirrorTest.pullAndApply({ snapshotUrl: manifestUrl, force: true, trigger: 'manual' });
            assert.equal(r5.applied, true);
            assert.equal(tamperedHits, 1, 'Tampered mirror should have been attempted first and rejected on SHA-256 mismatch');
            assert.equal(hits.news, 2, 'Good origin should be used as fallback after SHA-256 mismatch');
            assert.equal(stateManager.get('newsData')[0].id, 'slim-art-1');

            // Cooldown check hits lightweight manifest.json only (ZERO news.json / latest.json hits)
            const newsHitsBeforeCd = hits.news;
            const cdRes = await checkRemoteSnapshotCooldown({
                snapshotUrl: manifestUrl,
                cooldownMinutes: 30,
                nowMs: Date.parse('2026-11-20T07:50:00.000Z')
            });
            assert.equal(cdRes.viaManifest, true);
            assert.equal(cdRes.inCooldown, true);
            assert.equal(hits.news, newsHitsBeforeCd, 'Cooldown check must NOT fetch news.json');
            assert.equal(hits.latest, 0, 'Cooldown check must NOT fetch legacy latest.json');
        } finally {
            await Promise.all([
                new Promise((r) => goodServer.close(() => r())),
                new Promise((r) => tamperedMirror.close(() => r()))
            ]);
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('4. keepParagraphs end-to-end: ag-harvest emits indexedParagraphs, ag-publish reconstructs exact originalParagraphs and blocks out-of-range indices', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-p3-keepp-'));
        try {
            const rawBody = [
                'First paragraph introduces the new multilateral green hydrogen corridor agreed by European and Middle Eastern ministries.',
                'Second paragraph contains boilerplate newsletter signup details that editors want to skip.',
                'Third paragraph provides concrete investment commitments totaling 18 billion euros over the next five years.',
                'Fourth paragraph quotes energy analysts projecting sharp declines in industrial electrolysis costs.'
            ].join('\n\n');
            const paras = splitCandidateParagraphs(rawBody, 'en');
            assert.equal(paras.length, 4);

            const candList = [
                {
                    index: 1,
                    id: 'keepp-cand-1',
                    title: 'Multilateral Green Hydrogen Corridor Reaches 18 Billion Euro Deal',
                    url: 'https://www.reuters.com/business/energy/hydrogen-corridor-2026',
                    publishedAt: '2026-11-20T05:00:00.000Z',
                    fullText: rawBody,
                    paragraphs: paras,
                    source: { id: 'reuters', name: 'Reuters (路透社)', language: 'en', authority: 5 }
                }
            ];
            const harvestId = computeHarvestId(candList);
            const candidatesPath = path.join(tmpRoot, 'ag_candidates.json');
            fs.writeFileSync(candidatesPath, JSON.stringify({
                harvestId,
                harvestedAt: '2026-11-20T06:00:00.000Z',
                candidateCount: 1,
                sourceStats: [{ id: 'reuters', name: 'Reuters (路透社)', count: 1, status: 'ok' }],
                briefIndex: [{ index: 1, id: 'keepp-cand-1', paragraphCount: 4, title: candList[0].title }],
                fullCandidates: candList
            }, null, 2), 'utf8');

            // 4a. inspectCandidates exposes paragraphCount + 1-based indexedParagraphs
            const inspected = await inspectCandidates(candidatesPath, '1');
            assert.equal(inspected.items.length, 1);
            assert.equal(inspected.items[0].paragraphCount, 4);
            assert.equal(inspected.items[0].indexedParagraphs.length, 4);
            assert.equal(inspected.items[0].indexedParagraphs[0].p, 1);
            assert.equal(inspected.items[0].indexedParagraphs[2].p, 3);
            assert.equal(inspected.items[0].indexedParagraphs[2].text, paras[2]);

            // 4b. runPublish with keepParagraphs: [1, 3] (omitting originalParagraphs) reconstructs exact 2 paragraphs
            const validCompiledPath = path.join(tmpRoot, 'compiled_keepp.json');
            fs.writeFileSync(validCompiledPath, JSON.stringify({
                harvestId,
                articles: [
                    {
                        candidateIndex: 1,
                        translatedTitle: '欧中东多国签署180亿欧元绿氢跨境走廊联合投资协议',
                        summary: '欧洲与中东多国能源部长正式达成总规模达180亿欧元的绿氢跨境走廊协议，未来五年将重点投入工业电解槽产能与跨海输氢基础设施建设，加速重工业脱碳进程。',
                        region: '欧洲',
                        category: '能源',
                        keyPoints: ['多国达成绿氢跨境走廊协议', '未来五年承诺投资180亿欧元', '工业电解槽成本预计显著下降'],
                        keepParagraphs: [1, 3],
                        translatedParagraphs: [
                            '欧洲与中东多国能源部长共同宣布启动全新多边绿氢走廊框架，打通跨区域清洁燃料贸易通道。',
                            '协议明确未来五年内落实总计180亿欧元的具体资本投入承诺，用于配套储能与港口液化设施。'
                        ]
                    }
                ],
                summaryArticle: {
                    title: '全球能源要闻深度综述：跨境绿氢投资提速',
                    content: '### 能源转型\n欧中东多国推进180亿欧元绿氢走廊建设 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            const pubRes = await runPublish({
                candidates: candidatesPath,
                compiled: validCompiledPath,
                localOnly: true,
                pushToGithub: false,
                clientId: 'keepp-tester'
            });
            assert.equal(pubRes.success, true);
            const savedNews = JSON.parse(fs.readFileSync(config.storage.newsFile, 'utf8'));
            assert.equal(savedNews.news[0].originalParagraphs.length, 2);
            assert.equal(savedNews.news[0].originalParagraphs[0], paras[0]);
            assert.equal(savedNews.news[0].originalParagraphs[1], paras[2]);

            // 4c. Out-of-range keepParagraphs [1, 99] must fail validation cleanly
            const badCompiledPath = path.join(tmpRoot, 'compiled_keepp_bad.json');
            fs.writeFileSync(badCompiledPath, JSON.stringify({
                harvestId,
                articles: [
                    {
                        candidateIndex: 1,
                        translatedTitle: '欧中东多国签署180亿欧元绿氢跨境走廊联合投资协议',
                        summary: '欧洲与中东多国能源部长正式达成总规模达180亿欧元的绿氢跨境走廊协议，未来五年将重点投入工业电解槽产能与跨海输氢基础设施建设，加速重工业脱碳进程。',
                        region: '欧洲',
                        category: '能源',
                        keyPoints: ['多国达成绿氢跨境走廊协议', '未来五年承诺投资180亿欧元', '工业电解槽成本预计显著下降'],
                        keepParagraphs: [1, 99],
                        translatedParagraphs: ['段落一译文。', '段落二译文。']
                    }
                ],
                summaryArticle: {
                    title: '全球能源要闻深度综述',
                    content: '### 能源转型\n欧中东绿氢走廊建设 [NEWS_1]。'
                }
            }, null, 2), 'utf8');

            await assert.rejects(
                () => runPublish({
                    candidates: candidatesPath,
                    compiled: badCompiledPath,
                    localOnly: true,
                    pushToGithub: false,
                    clientId: 'keepp-tester'
                }),
                (err) => err.message.includes('keepParagraphs') && err.message.includes('99')
            );
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('5. Runtime perf: deduplicated WS broadcasts (1x each), Gzip HTML/CSS compression, uncompressed HTTP 206 audio Range, SSR lazy socialPulse & ScheduleManager', async () => {
        // 5a. Deduplicated WebSocket broadcasts during applySnapshotToRouter (server.js already listens on stateManager)
        const emittedEvents = [];
        const origEmit = io.emit.bind(io);
        io.emit = (ev, payload) => {
            emittedEvents.push(ev);
            return origEmit(ev, payload);
        };

        try {
            const mp3Buf = Buffer.alloc(4096, 0x49);
            fs.mkdirSync(AUDIO_DIR, { recursive: true });
            fs.writeFileSync(path.join(AUDIO_DIR, 'briefing-news.mp3'), mp3Buf);
            const audioSvc = new AudioBroadcastService(io, stateManager);
            const sampleSnap = {
                publishedAt: '2026-11-20T09:00:00.000Z',
                news: [createBloatedArticle(1), createBloatedArticle(2)],
                summaryArticle: {
                    title: '运行时性能验证综述',
                    content: '### 宏观\n测试运行时性能与去重广播 [NEWS_1] [NEWS_2]。'
                },
                socialPulse: {
                    updatedAt: '2026-11-20T07:15:00.000Z',
                    issues: [
                        createSampleDigest('2026-11-20', 'Latest Full Issue'),
                        createSampleDigest('2026-11-19', 'Older Historical Issue')
                    ]
                },
                audioBroadcast: {
                    updatedAt: '2026-11-20T09:05:00.000Z',
                    tracks: {
                        news: {
                            fileName: 'briefing-news.mp3',
                            title: '双主播测试播报',
                            sha256: computeSha256(mp3Buf),
                            sizeBytes: mp3Buf.length,
                            durationSec: 120,
                            chapters: []
                        }
                    }
                }
            };

            await applySnapshotToRouter(sampleSnap, {
                stateManager,
                newsAgentService: services.newsAgentService,
                newsService: services.newsService,
                audioBroadcastService: audioSvc,
                io,
                syncAudioFiles: false
            });

            const countOf = (name) => emittedEvents.filter((e) => e === name).length;
            assert.equal(countOf('news-updated'), 1, `news-updated should fire strictly once (got ${countOf('news-updated')})`);
            assert.equal(countOf('summary-completed'), 1, `summary-completed should fire strictly once (got ${countOf('summary-completed')})`);
            assert.equal(countOf('pulse-updated'), 1, `pulse-updated should fire strictly once (got ${countOf('pulse-updated')})`);
            assert.equal(countOf('audio-updated'), 1, `audio-updated should fire strictly once (got ${countOf('audio-updated')})`);
        } finally {
            io.emit = origEmit;
        }

        // 5b. Gzip compression on GET / + SSR lazy socialPulse payload verification
        const homeRes = await rawHttpGet(`${baseUrl}/`, { 'Accept-Encoding': 'gzip' });
        assert.equal(homeRes.statusCode, 200);
        assert.equal(homeRes.headers['content-encoding'], 'gzip', 'GET / must be gzip-compressed');
        assert.match(String(homeRes.headers.vary || ''), /accept-encoding/i);
        const homeHtml = zlib.gunzipSync(homeRes.body).toString('utf8');
        const stateMatch = homeHtml.match(/window\.__INITIAL_STATE__\s*=\s*\{[\s\S]*?\n\s*\};/);
        assert.ok(stateMatch, 'SSR HTML must embed window.__INITIAL_STATE__');
        const vm = require('vm');
        const sandbox = { window: {} };
        vm.runInNewContext(stateMatch[0], sandbox);
        const initialState = sandbox.window.__INITIAL_STATE__;
        assert.equal(initialState.socialPulse.issues.length, 2);
        assert.equal(initialState.socialPulse.issues[0].clusters.length, 2, 'Latest issue in SSR must keep full clusters');
        assert.equal(initialState.socialPulse.issues[0]._summaryOnly, undefined);
        assert.equal(initialState.socialPulse.issues[1]._summaryOnly, true, 'Historical issues in SSR must be summary-only stubs');
        assert.equal(initialState.socialPulse.issues[1].clusterCount, 2);
        assert.equal(initialState.socialPulse.issues[1].clusters, undefined, 'Historical SSR stub must omit clusters payload');

        // Verify lazy-load endpoint returns full historical issue clusters on demand
        const lazyPulseRes = await rawHttpGet(`${baseUrl}/api/pulse?key=daily:2026-11-19`);
        assert.equal(lazyPulseRes.statusCode, 200);
        const lazyPulseJson = JSON.parse(lazyPulseRes.body.toString('utf8'));
        assert.equal(lazyPulseJson.success, true);
        assert.equal(lazyPulseJson.selectedIssue.clusters.length, 2);

        // 5c. Gzip compression on static CSS & multi-chunk JS (/css/style.css & /js/main.js)
        const cssRes = await rawHttpGet(`${baseUrl}/css/style.css`, { 'Accept-Encoding': 'gzip' });
        assert.equal(cssRes.statusCode, 200);
        assert.equal(cssRes.headers['content-encoding'], 'gzip', 'Static /css/style.css must be gzip-compressed');
        const cssText = zlib.gunzipSync(cssRes.body).toString('utf8');
        assert.ok(cssText.includes('--bg-canvas'));

        const jsRes = await rawHttpGet(`${baseUrl}/js/main.js`, { 'Accept-Encoding': 'gzip' });
        assert.equal(jsRes.statusCode, 200);
        assert.equal(jsRes.headers['content-encoding'], 'gzip', 'Multi-chunk /js/main.js must be gzip-compressed without backpressure deadlock');
        const jsText = zlib.gunzipSync(jsRes.body).toString('utf8');
        assert.ok(jsText.includes('CoreFeedApp'));

        const pulseModRes = await rawHttpGet(`${baseUrl}/js/modules/social_pulse.js`, { 'Accept-Encoding': 'gzip' });
        assert.equal(pulseModRes.statusCode, 200);
        assert.equal(pulseModRes.headers['content-encoding'], 'gzip', 'ES module /js/modules/social_pulse.js must be gzip-compressed');
        const pulseModText = zlib.gunzipSync(pulseModRes.body).toString('utf8');
        assert.ok(pulseModText.includes('selectPulseIssue'));

        // 5d. Audio HTTP 206 Range streaming must NEVER be gzip-compressed
        const audioRes = await rawHttpGet(`${baseUrl}/api/audio/news.mp3`, {
            'Accept-Encoding': 'gzip',
            Range: 'bytes=0-31'
        });
        assert.equal(audioRes.statusCode, 206);
        assert.equal(audioRes.headers['content-encoding'], undefined, '/api/audio/news.mp3 Range response must remain uncompressed');
        assert.equal(audioRes.body.length, 32);

        // 5e. ScheduleManager decouples periodic GitHub sync from AUTO_UPDATE_ENABLED and honors custom timezone
        const sched = new ScheduleManager(null, null, stateManager, null, { pullAndApply: async () => ({ applied: false }) });
        try {
            sched.start({ enabled: false, timezone: 'UTC', allowPeriodicInTest: true });
            assert.equal(sched.currentTasks.length, 0, 'Disabled cron must schedule 0 daily tasks');
            assert.ok(sched.githubSyncTimer !== null, 'Periodic GitHub sync timer must stay active even when AUTO_UPDATE_ENABLED=false');

            sched.start({ enabled: true, updateTimes: ['09:15'], timezone: 'UTC', allowPeriodicInTest: false });
            assert.equal(sched.currentTasks.length, 1);
            assert.equal(sched.currentTasks[0].timezone, 'UTC', 'ScheduleManager must honor configured timezone');
        } finally {
            sched.stop();
        }
    });

    it('6. Self-hosted frontend assets (Q2=B): zero external CDN references on GET / and 100% icon & utility coverage', async () => {
        const homeRes = await rawHttpGet(`${baseUrl}/`, { 'Accept-Encoding': 'identity' });
        assert.equal(homeRes.statusCode, 200);
        const html = homeRes.body.toString('utf8');

        // Zero external CDN domains
        for (const forbidden of ['cdn.tailwindcss.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'cdnjs.cloudflare.com']) {
            assert.ok(!html.includes(forbidden), `GET / HTML must NOT reference external CDN: ${forbidden}`);
        }

        // Local static CSS bundles return HTTP 200
        for (const assetPath of ['/css/utilities.css', '/css/icons.css', '/css/style.css']) {
            const res = await rawHttpGet(`${baseUrl}${assetPath}`);
            assert.equal(res.statusCode, 200, `${assetPath} must return HTTP 200`);
            assert.match(String(res.headers['content-type'] || ''), /text\/css/i);
        }

        // Static audit: 100% of fa-* icon classes in views/index.ejs and public/js/**/*.js exist in public/css/icons.css
        const ejsSrc = fs.readFileSync(path.join(ROOT_DIR, 'views', 'index.ejs'), 'utf8');
        const jsModulesDir = path.join(ROOT_DIR, 'public', 'js', 'modules');
        const allJsSources = [
            fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'main.js'), 'utf8'),
            ...fs.readdirSync(jsModulesDir)
                .filter(f => f.endsWith('.js'))
                .map(f => fs.readFileSync(path.join(jsModulesDir, f), 'utf8'))
        ].join('\n');
        const iconsCss = fs.readFileSync(path.join(ROOT_DIR, 'public', 'css', 'icons.css'), 'utf8');
        const utilCss = fs.readFileSync(path.join(ROOT_DIR, 'public', 'css', 'utilities.css'), 'utf8');
        const styleCss = fs.readFileSync(path.join(ROOT_DIR, 'public', 'css', 'style.css'), 'utf8');
        const allCss = `${iconsCss}\n${utilCss}\n${styleCss}`;

        const usedFaClasses = [...new Set([...(`${ejsSrc}\n${allJsSources}`).matchAll(/\bfa-[a-z0-9-]+\b/g)].map(m => m[0]))];
        assert.ok(usedFaClasses.length >= 20, 'Should detect used FontAwesome icon classes');
        const missingIcons = usedFaClasses.filter((cls) => !new RegExp(`\\.${cls}(?![a-z0-9-])`).test(iconsCss));
        assert.deepEqual(missingIcons, [], `All used fa-* classes must be defined in icons.css (missing: ${missingIcons.join(', ')})`);

        // Static audit: 100% of concrete class="..." tokens in views/index.ejs & public/js/**/*.js exist in self-hosted CSS
        const classStrings = [
            ...[...ejsSrc.matchAll(/class="([^"]+)"/g)].map(m => m[1]),
            ...[...allJsSources.matchAll(/class="([^"]+)"/g)].map(m => m[1])
        ];
        const structuralHooks = new Set(['pulse-panel-inner', 'pulse-spectrum-seg--']);
        const usedClasses = new Set();
        for (const s of classStrings) {
            const cleaned = s.replace(/<%[\s\S]*?%>/g, ' ').replace(/\$\{[^}]+\}/g, ' ');
            for (const tok of cleaned.split(/\s+/)) {
                if (!tok || structuralHooks.has(tok) || tok.endsWith('--')) continue;
                if (/^[a-zA-Z][a-zA-Z0-9_:/.\[\]-]*$/.test(tok)) usedClasses.add(tok);
            }
        }
        const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const cssHasClass = (cls) => {
            const cssSelector = '.' + cls.replace(/([:/.\[\]])/g, '\\$1');
            return new RegExp(`${escapeRegex(cssSelector)}(?![a-zA-Z0-9_-])`).test(allCss);
        };
        const missingUsedClasses = [...usedClasses].filter((cls) => !cssHasClass(cls));
        assert.deepEqual(
            missingUsedClasses,
            [],
            `Every CSS class used in index.ejs/main.js must be defined in self-hosted CSS (missing: ${missingUsedClasses.join(', ')})`
        );

        // Spot-check critical self-hosted utility classes
        for (const utilCls of [
            'hidden', 'flex', 'inline-flex', 'grid', 'flex-shrink-0',
            'items-center', 'justify-between', 'space-y-3', 'space-y-5',
            'rounded-md', 'line-clamp-2', 'text-[11px]', 'hover:underline',
            'sm:flex-row', 'sm:w-72', 'fixed', 'inset-0', 'z-50'
        ]) {
            assert.ok(cssHasClass(utilCls), `Expected self-hosted utility class .${utilCls} in utilities.css`);
        }
    });
});
