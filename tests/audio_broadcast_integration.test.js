/**
 * CoreFeed v2.0 — Qwen3-TTS 1.7B 双主播语音播报 (AudioBroadcast) 集成、Range 流媒体、快照协同与播放器 UI 测试套件
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.AUTO_UPDATE_ENABLED = 'false';

const config = require('../config');
const stateManager = require('../services/state_manager');
const { server, io, services } = require('../server');
const {
    AudioBroadcastService,
    normalizeAudioBroadcastBundle,
    computeBufferSha256,
    resolveSnapshotRawDirUrl
} = require('../services/audio_broadcast_service');
const { runPublish } = require('../scripts/ag-publish');
const { runSyncPulse } = require('../scripts/ag-sync-pulse');
const { resolveColabPython } = require('../scripts/ag-tts');

const DATA_DIR = config.storage.dataDir || path.join(__dirname, '..', 'data');
const AUDIO_DIR = config.storage.audioDir || path.join(DATA_DIR, 'audio');
const TRACKED_FILES = [
    'news.json',
    'summary.json',
    'social_pulse.json',
    'audio_broadcast.json',
    'state.json',
    'settings.json',
    'ag_candidates.json',
    'ag_compiled.json',
    path.join('audio', 'briefing-news.mp3'),
    path.join('audio', 'briefing-pulse.mp3')
];

function createSyntheticMp3Buffer(tagLabel = 'NEWS') {
    // Valid ID3v2 header + synthetic payload >= 512 bytes for Range & SHA-256 verification
    const header = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10]);
    const body = Buffer.alloc(1024, tagLabel, 'utf8');
    return Buffer.concat([header, body]);
}

function createSampleDigest(date = '2026-11-18') {
    return {
        schema_version: '1.0',
        mode: 'daily',
        date,
        generated_at: `${date}T07:20:00+08:00`,
        window_hours: 24,
        headline: '美欧多语种社区激辩数字基础设施韧性与跨洋贸易关税',
        executive_summary: {
            overview: '过去24小时，欧美三大平台围绕云服务韧性与欧洲能源账单展开高强度交锋。',
            platform_mood: {
                X: '实时快讯与高管回应刷屏。',
                Threads: '白领聚焦通勤与账单压力。',
                Reddit: '多语种长帖深扒技术根因。'
            }
        },
        transatlantic_comparisons: [
            {
                topic: '数字基建冗余度 vs 公共监管成本',
                us_angle: '美国网友追责大规模裁员削弱运维防线。',
                eu_angle: '欧洲网友关注数字主权与替代方案推进速度。',
                verdict: '美方焦虑运维空心化，欧方焦虑外部依赖。'
            }
        ],
        clusters: [
            {
                id: 'us-01',
                region: 'US',
                countries: ['US'],
                languages: ['en'],
                category: '科技与AI',
                platforms: ['Reddit', 'X'],
                heat_score: 96,
                title_zh: '云服务连环抖动引发运维裁员大反思',
                hook_one_liner: '一线工程师列举近三年值班人手减半账本。',
                trigger_and_context: '多家核心SaaS服务同日出现认证延迟，引发r/technology热议。',
                camps: [{ label: '工程冗余派', share_estimate: '约 70%', summary: '呼吁恢复核心SRE编制。' }],
                featured_quotes: [
                    {
                        platform: 'Reddit',
                        community_or_handle: 'r/technology · u/ops_vet',
                        language: 'en',
                        metrics: '4,200 赞',
                        quote_zh: '省下一名资深SRE的年薪，最后往往要用千万美元级别的停机事故来买单。',
                        quote_original: 'Saving one senior SRE salary ends up costing millions in downtime.',
                        source_url: 'https://www.reddit.com/r/technology/comments/1abcde/cloud_outage/'
                    }
                ]
            },
            {
                id: 'eu-01',
                region: 'EU',
                countries: ['DE', 'FR'],
                languages: ['de', 'fr'],
                category: '政经政策',
                platforms: ['Reddit'],
                heat_score: 90,
                title_zh: '德法社区热议冬季工业电价补贴新政',
                hook_one_liner: '制造业岗位保卫战与财政赤字红线正面碰撞。',
                trigger_and_context: '德国经济部公布新一轮电网过网费减免草案。',
                camps: [{ label: '产业护航派', share_estimate: '约 60%', summary: '支持优先稳住制造业能源成本。' }],
                featured_quotes: [
                    {
                        platform: 'Reddit',
                        community_or_handle: 'r/de · u/strompreis',
                        language: 'de',
                        metrics: '610 赞',
                        quote_zh: '如果连电网基础过网费都降不下来，谈何工业电气化转型。',
                        quote_original: 'Ohne niedrigere Netzentgelte gelingt keine Elektrifizierung.',
                        source_url: 'https://www.reddit.com/r/de/comments/1fghij/netzentgelte/'
                    }
                ]
            }
        ]
    };
}

describe('CoreFeed x Qwen3-TTS Dual-Anchor Audio Broadcast Suite', () => {
    let baseUrl = '';
    const backups = new Map();

    before(async () => {
        process.env.NO_PROXY = '127.0.0.1,localhost';
        for (const rel of TRACKED_FILES) {
            const p = path.join(DATA_DIR, rel);
            if (fs.existsSync(p)) {
                backups.set(p, fs.readFileSync(p));
            }
        }
        for (const cleanRel of ['audio_broadcast.json', path.join('audio', 'briefing-news.mp3'), path.join('audio', 'briefing-pulse.mp3')]) {
            const cp = path.join(DATA_DIR, cleanRel);
            if (fs.existsSync(cp)) fs.unlinkSync(cp);
        }
        stateManager.reset();
        await new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', (err) => {
                if (err) return reject(err);
                baseUrl = `http://127.0.0.1:${server.address().port}`;
                resolve();
            });
        });
    });

    after(async () => {
        delete process.env.PUBLISH_SECRET;
        if (services.scheduleManager) services.scheduleManager.stop();
        await new Promise((r) => io.close(() => r()));
        await new Promise((r) => (server.listening ? server.close(() => r()) : r()));

        for (const rel of TRACKED_FILES) {
            const p = path.join(DATA_DIR, rel);
            if (backups.has(p)) {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, backups.get(p));
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        }
    });

    it('1. ag-generate-tts.py --dry-run-script builds clean Lin_Yuan + Serena dual-anchor chapters for both news and pulse', () => {
        const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-tts-plan-'));
        try {
            fs.writeFileSync(path.join(tmpData, 'news.json'), JSON.stringify({
                lastUpdated: '2026-11-18T11:20:00.000Z',
                news: Array.from({ length: 7 }, (_, i) => ({
                    id: `n-${i + 1}`,
                    translatedTitle: `全球重点要闻测试标题第${i + 1}条`,
                    summary: `这是第${i + 1}条重点要闻的深度导语摘要，涵盖核心数据与跨国影响。`,
                    source: { name: 'Reuters (路透社)' },
                    region: '国际',
                    category: '政经'
                }))
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(tmpData, 'summary.json'), JSON.stringify({
                article: {
                    title: '2026年11月18日 全球要闻深度综述：跨境清算与能源协作',
                    content: '### 宏观与金融\n全球央行推进实时清算互联 [NEWS_1] [NEWS_2]。\n### 科技与产业\n半导体供应链投资稳健增长 [NEWS_3]。'
                }
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(tmpData, 'social_pulse.json'), JSON.stringify({
                latestKey: 'daily:2026-11-18',
                issues: [createSampleDigest('2026-11-18')]
            }, null, 2), 'utf8');

            const pyBin = resolveColabPython();
            const rawOut = execFileSync(
                pyBin,
                [
                    path.join(__dirname, '..', 'scripts', 'ag-generate-tts.py'),
                    '--mode', 'both',
                    '--data-dir', tmpData,
                    '--dry-run-script'
                ],
                { encoding: 'utf8' }
            );
            const parsed = JSON.parse(rawOut);
            assert.equal(parsed.ok, true);
            assert.equal(parsed.plans.length, 2);

            const newsPlan = parsed.plans.find((p) => p.track === 'news');
            const pulsePlan = parsed.plans.find((p) => p.track === 'pulse');
            assert.ok(newsPlan && pulsePlan);

            assert.equal(newsPlan.chapters.length, 4);
            assert.equal(newsPlan.chapters[0].speaker, 'Serena');
            assert.equal(newsPlan.chapters[1].speaker, 'Lin_Yuan');
            assert.ok(!newsPlan.chapters[1].text.includes('[NEWS_'), 'Spoken script must strip [NEWS_k] citations');
            assert.equal(newsPlan.chapters[2].speaker, 'Serena');
            assert.ok(newsPlan.chapters[2].text.includes('路透社'), 'Spoken script must use Chinese source short name');

            assert.equal(pulsePlan.chapters.length, 4);
            assert.equal(pulsePlan.chapters[1].speaker, 'Lin_Yuan');
            assert.ok(!pulsePlan.chapters[1].text.includes(' vs '), 'Spoken pulse script must convert vs to 对比');
            assert.ok(!pulsePlan.chapters[2].text.includes('r/technology'), 'Spoken pulse script must expand r/subreddit');
        } finally {
            fs.rmSync(tmpData, { recursive: true, force: true });
        }
    });

    it('2. POST /api/agent/publish-audio, GET /api/audio, HTTP 206 Range streaming & SSR Broadcast Player contract', async () => {
        process.env.PUBLISH_SECRET = 'audio-sec-777';
        const newsMp3 = createSyntheticMp3Buffer('NEWS_AUDIO_STREAM_');

        const unauth = await fetch(`${baseUrl}/api/agent/publish-audio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ track: 'news', trackMeta: { title: 'Test', durationSec: 120 } })
        });
        assert.equal(unauth.status, 401);

        const pubRes = await fetch(`${baseUrl}/api/agent/publish-audio`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer audio-sec-777'
            },
            body: JSON.stringify({
                track: 'news',
                trackMeta: {
                    title: '2026年11月18日晚间 · 全球要闻双主播精播',
                    subtitle: '深度综述 + 前 10 条重点要闻 · 林远 & Serena',
                    durationSec: 325.4,
                    chapters: [
                        { index: 1, id: 'c1', title: '开场导视', speaker: 'Serena', startSec: 0, durationSec: 12.5, text: '欢迎收听聚核全球要闻播报。' },
                        { index: 2, id: 'c2', title: '全球要闻深度综述', speaker: 'Lin_Yuan', startSec: 13.0, durationSec: 180.0, text: '下面来看今日全球态势综述。' }
                    ]
                },
                audioBase64: newsMp3.toString('base64')
            })
        });
        assert.equal(pubRes.status, 200);
        const pubBody = await pubRes.json();
        assert.equal(pubBody.success, true);
        assert.equal(pubBody.trackCount, 1);

        // Verify GET /api/audio metadata
        const metaRes = await fetch(`${baseUrl}/api/audio`);
        assert.equal(metaRes.status, 200);
        const metaJson = await metaRes.json();
        assert.equal(metaJson.available, true);
        assert.equal(metaJson.audioBroadcast.tracks.news.sha256, computeBufferSha256(newsMp3));

        // Verify HTTP 206 Partial Content Range streaming for mobile/desktop scrubbing
        const rangeRes = await fetch(`${baseUrl}/api/audio/news.mp3`, {
            headers: { Range: 'bytes=0-63' }
        });
        assert.equal(rangeRes.status, 206);
        assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
        assert.ok((rangeRes.headers.get('content-type') || '').includes('audio/mpeg'));
        const partialBytes = Buffer.from(await rangeRes.arrayBuffer());
        assert.equal(partialBytes.length, 64);
        assert.deepEqual(partialBytes, newsMp3.subarray(0, 64));

        // Verify SSR HTML renders #broadcastPlayerDeck, native range slider & accessible transcript details
        const homeRes = await fetch(`${baseUrl}/`);
        assert.equal(homeRes.status, 200);
        const html = await homeRes.text();
        assert.ok(html.includes('id="broadcastPlayerDeck"'), 'SSR HTML must include #broadcastPlayerDeck');
        assert.ok(!html.includes('id="broadcastPlayerDeck" class="kami-card broadcast-deck hidden"'), 'Broadcast deck must be visible when audio track exists');
        assert.ok(html.includes('id="broadcastSeekSlider"'), 'SSR HTML must include native range slider #broadcastSeekSlider');
        assert.ok(html.includes('id="broadcastAudioEl"'), 'SSR HTML must include #broadcastAudioEl');
        assert.ok(html.includes('aria-details="broadcastTranscriptDetails"'), '<audio> must link transcript via aria-details');
        assert.ok(html.includes('2026年11月18日晚间 · 全球要闻双主播精播'), 'SSR HTML must render active broadcast episode title');
    });

    it('3. ag-snapshot binary MP3 coexistence & router auto-caching: pulse (07:15) + news (07:40) preserve both MP3 blobs and pullAndApply caches MP3s locally', async () => {
        process.env.PUBLISH_SECRET = 'audio-sec-777';
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-audio-snap-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const extPulseWs = path.join(tmpRoot, 'ext-pulse');

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(path.join(workRepoDir, 'data', 'audio'), { recursive: true });
            fs.mkdirSync(path.join(extPulseWs, 'data', 'digests'), { recursive: true });

            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            const newsMp3Buf = createSyntheticMp3Buffer('NEWS_BLOB_V1_');
            const pulseMp3Buf = createSyntheticMp3Buffer('PULSE_BLOB_V1_');
            fs.mkdirSync(AUDIO_DIR, { recursive: true });
            fs.writeFileSync(path.join(AUDIO_DIR, 'briefing-news.mp3'), newsMp3Buf);
            fs.writeFileSync(path.join(AUDIO_DIR, 'briefing-pulse.mp3'), pulseMp3Buf);
            fs.writeFileSync(path.join(workRepoDir, 'data', 'audio', 'briefing-news.mp3'), newsMp3Buf);
            fs.writeFileSync(path.join(workRepoDir, 'data', 'audio', 'briefing-pulse.mp3'), pulseMp3Buf);

            const audioSvc = new AudioBroadcastService(null, stateManager);
            await audioSvc.mergeTrack('news', {
                title: '早间全球要闻双主播播报',
                durationSec: 310,
                chapters: [{ index: 1, title: '开场', speaker: 'Serena', startSec: 0, durationSec: 12, text: '早安。' }]
            }, newsMp3Buf, { emit: false });

            const tenHoursAgoIso = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
            const standaloneNewsPath = path.join(tmpRoot, 'news_in.json');
            fs.writeFileSync(standaloneNewsPath, JSON.stringify({
                publishedAt: tenHoursAgoIso,
                news: [
                    {
                        id: 'n-1',
                        title: 'Global Energy Grid',
                        translatedTitle: '全球跨境清洁电网互联协议签署',
                        summary: '多国能源部长签署跨境清洁电力调度合作框架协议。',
                        url: 'https://www.reuters.com/energy/grid-2026',
                        region: '国际',
                        category: '能源',
                        keyPoints: ['签署跨境调度协议', '提升清洁电力消纳', '增强电网韧性'],
                        translatedParagraphs: ['多国能源部长正式签署跨境清洁电力调度合作框架协议。'],
                        source: { name: 'Reuters (路透社)' }
                    }
                ],
                summary: '### 能源要闻\n全球跨境清洁电网互联协议签署 [NEWS_1]。'
            }, null, 2), 'utf8');

            await runPublish({
                candidates: path.join(tmpRoot, 'no_cand.json'),
                file: standaloneNewsPath,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'news-pub'
            });

            // Now simulate 07:15 pulse + pulse audio sync (delete workRepoDir news mp3 to prove git blob reuse!)
            fs.unlinkSync(path.join(workRepoDir, 'data', 'audio', 'briefing-news.mp3'));
            fs.unlinkSync(path.join(AUDIO_DIR, 'briefing-news.mp3'));
            await audioSvc.mergeTrack('pulse', {
                title: '早班车欧美社媒热议观察',
                issueKey: 'daily:2026-11-18',
                durationSec: 285,
                chapters: [{ index: 1, title: '导播', speaker: 'Serena', startSec: 0, durationSec: 11, text: '早上好。' }]
            }, pulseMp3Buf, { emit: false });

            fs.writeFileSync(
                path.join(extPulseWs, 'data', 'digests', '2026-11-18.json'),
                JSON.stringify(createSampleDigest('2026-11-18'), null, 2),
                'utf8'
            );

            await runSyncPulse({
                sourceDir: extPulseWs,
                localOnly: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'pulse-pub-0715'
            });

            const treeNames = execFileSync('git', ['--git-dir', bareRemoteDir, 'ls-tree', '--name-only', 'ag-snapshot'], { encoding: 'utf8' })
                .trim()
                .split(/\r?\n/);
            assert.ok(treeNames.includes('briefing-news.mp3'), 'ag-snapshot must retain briefing-news.mp3 blob across 07:15 pulse sync');
            assert.ok(treeNames.includes('briefing-pulse.mp3'), 'ag-snapshot must include briefing-pulse.mp3 blob');

            const snapJson = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:latest.json'], { encoding: 'utf8' })
            );
            assert.equal(snapJson.publishedAt, tenHoursAgoIso, '07:15 pulse+audio sync must NOT alter news publishedAt');
            assert.equal(snapJson.audioBroadcast.trackCount, 2);

            // Simulate a clean soft-router with ZERO local MP3 files pulling from ag-snapshot HTTP server
            for (const fn of ['briefing-news.mp3', 'briefing-pulse.mp3']) {
                const p = path.join(AUDIO_DIR, fn);
                if (fs.existsSync(p)) fs.unlinkSync(p);
            }
            stateManager.updateAudioBroadcast(null, false);

            const mockSnapshotHttp = http.createServer((req, res) => {
                const u = (req.url || '').split('?')[0];
                if (u.endsWith('/latest.json')) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(snapJson));
                } else if (u.endsWith('/briefing-news.mp3')) {
                    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
                    res.end(newsMp3Buf);
                } else if (u.endsWith('/briefing-pulse.mp3')) {
                    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
                    res.end(pulseMp3Buf);
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
            await new Promise((r, j) => mockSnapshotHttp.listen(0, '127.0.0.1', (e) => (e ? j(e) : r())));
            const mockSnapUrl = `http://127.0.0.1:${mockSnapshotHttp.address().port}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

            try {
                const pullRes = await services.githubSyncManager.pullAndApply({
                    snapshotUrl: mockSnapUrl,
                    force: false,
                    trigger: 'schedule'
                });
                assert.equal(pullRes.applied, true);
                assert.equal(pullRes.hasAudioBroadcast, true);
                assert.equal(pullRes.audioTrackCount, 2);
                assert.deepEqual(fs.readFileSync(path.join(AUDIO_DIR, 'briefing-news.mp3')), newsMp3Buf);
                assert.deepEqual(fs.readFileSync(path.join(AUDIO_DIR, 'briefing-pulse.mp3')), pulseMp3Buf);
            } finally {
                await new Promise((r) => mockSnapshotHttp.close(() => r()));
            }

            // Verify resolveSnapshotRawDirUrl canonicalizes GitHub Contents API & ghfast.top mirror URLs
            assert.equal(
                resolveSnapshotRawDirUrl('https://api.github.com/repos/alanhsun/CoreFeed/contents/latest.json?ref=ag-snapshot'),
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot'
            );
            assert.equal(
                resolveSnapshotRawDirUrl('https://ghfast.top/https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'),
                'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot'
            );
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
