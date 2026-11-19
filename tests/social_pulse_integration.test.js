/**
 * CoreFeed v2.0 — 欧美社媒热议 (Western Social Pulse) 集成、快照协同与 UI 测试套件
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.AUTO_UPDATE_ENABLED = 'false';

const config = require('../config');
const stateManager = require('../services/state_manager');
const { server, io, services } = require('../server');
const { normalizeSocialPulseBundle } = require('../services/social_pulse_service');
const { runPublish } = require('../scripts/ag-publish');
const { parsePulseSyncArgs, runSyncPulse } = require('../scripts/ag-sync-pulse');
const { checkRemoteSnapshotCooldown } = require('../utils/github_sync');

const DATA_DIR = config.storage.dataDir || path.join(__dirname, '..', 'data');
const TRACKED_FILES = [
    'news.json',
    'summary.json',
    'social_pulse.json',
    'audio_broadcast.json',
    'state.json',
    'settings.json',
    'ag_candidates.json',
    'ag_compiled.json'
];

function createSampleDigest(date = '2026-11-15', mode = 'daily', slug = null) {
    return {
        schema_version: '1.0',
        mode,
        date,
        ...(mode === 'topic' ? { slug: slug || 'ai-act', query: 'EU AI Act' } : {}),
        generated_at: `${date}T23:00:00+08:00`,
        window_hours: 24,
        headline: '全美空管停飞打脸官方，欧美激辩AI代价与代际养老账单',
        executive_summary: {
            overview: '过去24小时，欧美三大社媒平台围绕关键基建失信、算力寡头垄断与代际分配断崖全面引爆。',
            platform_mood: {
                X: 'SpaceX捕获星舰与迈阿密机场擦撞快讯同屏刷屏。',
                Threads: '议员与白领集中追责空管预算错配与生活成本。',
                Reddit: '美欧多语种版块深扒循环融资与72岁退休冲击波。'
            }
        },
        transatlantic_comparisons: [
            {
                topic: '科技垄断与AI冲击波',
                us_angle: '聚焦GPU循环融资抬价与职场摄像头监控。',
                eu_angle: '聚焦意大利8亿欧重罚Meta与英国白领AI失业潮预警。',
                verdict: '西岸清算寡头控价，东岸焦虑服务业饭碗。'
            }
        ],
        clusters: [
            {
                id: 'us-01',
                region: 'US',
                countries: ['US'],
                languages: ['en'],
                category: '政经政策',
                platforms: ['Reddit', 'X', 'Threads'],
                heat_score: 98,
                is_followup: false,
                followup_note: null,
                title_zh: '全美空管停飞后再撞机：60名空管打脸交通部长',
                hook_one_liner: '前脚甩锅老旧路由超载，后脚迈阿密两机滑行擦撞。',
                trigger_and_context: '全美空域突发大规模停飞后，60名一线空管集体反驳交通部长解释。',
                camps: [
                    { label: '彻查瞒报派', share_estimate: '约 65%', summary: '呼吁国会彻查8.75亿AI系统真实状态。' },
                    { label: '预算清算派', share_estimate: '约 35%', summary: '痛批基础设施拨款长期不足。' }
                ],
                platform_vibes: {
                    Reddit: 'r/technology高赞热评逐段抓包前后矛盾。',
                    X: '迈阿密擦撞快讯浏览破90万。'
                },
                featured_quotes: [
                    {
                        platform: 'Reddit',
                        community_or_handle: 'r/technology · u/PizzaWall',
                        language: 'en',
                        metrics: '8,839 赞',
                        quote_zh: '他们越是千方百计绕开这件事，我就越确定这里面绝对得彻查到底。',
                        quote_original: 'The more they sidestep this, the more I know it needs to be investigated.',
                        source_url: 'https://www.reddit.com/r/technology/comments/1xwelwa/johnson_says_we_dont_really_need_any/19sn68bgkkwap'
                    }
                ]
            },
            {
                id: 'eu-01',
                region: 'EU',
                countries: ['DE', 'FR'],
                languages: ['de', 'fr'],
                category: '民生与消费',
                platforms: ['Reddit'],
                heat_score: 91,
                is_followup: false,
                followup_note: null,
                title_zh: '希腊拟自动推迟退休至72岁震动法德养老金账本',
                hook_one_liner: '法德打工人连夜掏出计算器拆穿养老金购买力幻觉。',
                trigger_and_context: '希腊酝酿随预期寿命自动推迟退休年龄，引发法德版块连锁算账。',
                camps: [
                    { label: '反薪资紧缩派', share_estimate: '约 55%', summary: '直指工资停滞才是缴费不足主因。' },
                    { label: '精算折现派', share_estimate: '约 45%', summary: '折算35年后法定养老金购买力缩水过半。' }
                ],
                platform_vibes: {
                    Reddit: 'r/Finanzen与r/france展开硬核精算交锋。'
                },
                featured_quotes: [
                    {
                        platform: 'Reddit',
                        community_or_handle: 'r/Finanzen · u/rldml',
                        language: 'de',
                        metrics: '301 赞',
                        quote_zh: '等35年后开始领退休金时，7050欧元购买力只相当于今天的3599.51欧元。',
                        quote_original: 'Faustregel: Die 7050 Euro werden zu Rentenbeginn ungefähr so viel wert sein, wie 3599,51 Euro heute',
                        source_url: 'https://www.reddit.com/r/finanzen/comments/1xwdu00/gesetzliche_rente_von_7050_brutto_in_35j_zu_sch%C3%B6n/19sn4w38wtfph'
                    }
                ]
            }
        ]
    };
}

describe('CoreFeed x Western Social Pulse Integration Suite', () => {
    let baseUrl = '';
    const backups = new Map();

    before(async () => {
        process.env.NO_PROXY = '127.0.0.1,localhost';
        for (const fn of TRACKED_FILES) {
            const p = path.join(DATA_DIR, fn);
            if (fs.existsSync(p)) {
                backups.set(p, fs.readFileSync(p));
            }
        }
        const audioMetaPath = path.join(DATA_DIR, 'audio_broadcast.json');
        if (fs.existsSync(audioMetaPath)) fs.unlinkSync(audioMetaPath);
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

        for (const fn of TRACKED_FILES) {
            const p = path.join(DATA_DIR, fn);
            if (backups.has(p)) {
                fs.mkdirSync(path.dirname(p), { recursive: true });
                fs.writeFileSync(p, backups.get(p));
            } else if (fs.existsSync(p)) {
                fs.unlinkSync(p);
            }
        }
    });

    it('1. normalizeSocialPulseBundle deduplicates, sorts daily before topic, sanitizes social URLs, and caps issues', () => {
        const d14 = createSampleDigest('2026-11-14', 'daily');
        const t15 = createSampleDigest('2026-11-15', 'topic', 'faa-ground-stop');
        const d15 = createSampleDigest('2026-11-15', 'daily');
        // Inject untrusted non-social URL to verify sanitization
        t15.clusters[0].featured_quotes[0].source_url = 'javascript:alert(1)';

        const bundle = normalizeSocialPulseBundle({ issues: [d14, t15, d15] }, { maxIssues: 2 });
        assert.ok(bundle);
        assert.equal(bundle.issueCount, 2);
        assert.equal(bundle.latestKey, 'daily:2026-11-15');
        assert.equal(bundle.issues[0].key, 'daily:2026-11-15');
        assert.equal(bundle.issues[1].key, 'topic:2026-11-15:faa-ground-stop');
        assert.equal(bundle.issues[1].clusters[0].featured_quotes[0].source_url, '');
    });

    it('2. POST /api/agent/publish-pulse & GET /api/pulse & SSR 3rd Tab (#tabBtn-pulse / #tabPanel-pulse) contract', async () => {
        process.env.PUBLISH_SECRET = 'pulse-sec-123';

        const unauthRes = await fetch(`${baseUrl}/api/agent/publish-pulse`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(createSampleDigest('2026-11-15'))
        });
        assert.equal(unauthRes.status, 401);

        const pubRes = await fetch(`${baseUrl}/api/agent/publish-pulse`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer pulse-sec-123'
            },
            body: JSON.stringify({
                socialPulse: {
                    issues: [
                        createSampleDigest('2026-11-15', 'daily'),
                        createSampleDigest('2026-11-14', 'daily')
                    ]
                }
            })
        });
        assert.equal(pubRes.status, 200);
        const pubData = await pubRes.json();
        assert.equal(pubData.success, true);
        assert.equal(pubData.issueCount, 2);
        assert.equal(pubData.latestKey, 'daily:2026-11-15');

        const getRes = await fetch(`${baseUrl}/api/pulse?key=daily:2026-11-14`);
        assert.equal(getRes.status, 200);
        const getBody = await getRes.json();
        assert.equal(getBody.available, true);
        assert.equal(getBody.socialPulse.issueCount, 2);
        assert.equal(getBody.selectedIssue.key, 'daily:2026-11-14');

        const homeRes = await fetch(`${baseUrl}/`);
        assert.equal(homeRes.status, 200);
        const html = await homeRes.text();
        assert.ok(html.includes('id="tabBtn-pulse"'), 'SSR HTML must include 3rd tab button #tabBtn-pulse');
        assert.ok(html.includes('欧美社媒'), 'SSR HTML must render 欧美社媒 tab label');
        assert.ok(html.includes('id="tabPanel-pulse"'), 'SSR HTML must include #tabPanel-pulse');
        assert.ok(html.includes('hidden="until-found"'), 'Inactive tab panels must use hidden="until-found"');
        assert.ok(html.includes('全美空管停飞打脸官方'), 'SSR HTML must include latest social pulse headline');
    });

    it('3. Non-destructive coexistence: ag-sync-pulse.js merges into ag-snapshot without tripping 07:40 news cooldown, ag-publish.js carries socialPulse forward, and GitHubSyncManager detects pulse-only updates', async () => {
        process.env.PUBLISH_SECRET = 'pulse-sec-123';
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-pulse-sync-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const extPulseWs = path.join(tmpRoot, 'ext-pulse');

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });
            fs.mkdirSync(path.join(extPulseWs, 'data', 'digests'), { recursive: true });
            fs.mkdirSync(path.join(extPulseWs, 'data', 'topics'), { recursive: true });

            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            // Step A: Publish an evening news snapshot from 10 hours ago (simulating last night's 19:10 run)
            const tenHoursAgoIso = new Date(Date.now() - 10 * 3600 * 1000).toISOString();
            const standaloneNewsPath = path.join(tmpRoot, 'standalone_news.json');
            fs.writeFileSync(standaloneNewsPath, JSON.stringify({
                publishedAt: tenHoursAgoIso,
                news: [
                    {
                        id: 'n-1',
                        title: 'Global Semiconductor Capacity Report',
                        translatedTitle: '全球半导体产能最新评估报告发布',
                        summary: '国际半导体协会发布年度产能评估报告，晶圆代工投资持续增长。',
                        url: 'https://www.reuters.com/tech/semi-report-2026',
                        region: '国际',
                        category: '科技',
                        keyPoints: ['晶圆代工投资增长', '先进封装产能扩张', '汽车芯片供需平衡'],
                        translatedParagraphs: ['国际半导体协会发布年度产能评估报告，晶圆代工与先进封装投资保持稳健增长。'],
                        source: { name: 'Reuters (路透社)' }
                    }
                ],
                summary: '### 科技要闻\n全球半导体产能最新评估报告发布 [NEWS_1]。'
            }, null, 2), 'utf8');

            // Reset social_pulse.json first so Step A has news only
            if (fs.existsSync(config.storage.socialPulseFile)) {
                fs.unlinkSync(config.storage.socialPulseFile);
            }
            stateManager.updateSocialPulse(null, false);

            await runPublish({
                candidates: path.join(tmpRoot, 'missing_cand.json'),
                file: standaloneNewsPath,
                target: baseUrl,
                secret: 'pulse-sec-123',
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'evening-news-1910'
            });

            // Reset social_pulse.json & state.json pulse before Step B so we test a clean 1-issue ingest
            if (fs.existsSync(config.storage.socialPulseFile)) {
                fs.unlinkSync(config.storage.socialPulseFile);
            }
            stateManager.updateSocialPulse(null, false);
            await stateManager.saveToFile(config.storage.stateFile);

            // Step B: At 07:15 next morning, write 2026-11-15.json in extPulseWs and run ag-sync-pulse.js
            fs.writeFileSync(
                path.join(extPulseWs, 'data', 'digests', '2026-11-15.json'),
                JSON.stringify(createSampleDigest('2026-11-15', 'daily'), null, 2),
                'utf8'
            );
            const parsedCli = parsePulseSyncArgs(['--source-dir', extPulseWs, '--github', '--max-issues=10']);
            assert.equal(parsedCli.sourceDir, path.resolve(extPulseWs));
            assert.equal(parsedCli.pushToGithub, true);
            assert.equal(parsedCli.maxIssues, 10);

            const syncRes = await runSyncPulse({
                sourceDir: extPulseWs,
                target: baseUrl,
                secret: 'pulse-sec-123',
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'morning-pulse-0715'
            });
            assert.equal(syncRes.success, true);
            assert.equal(syncRes.issueCount, 1);
            assert.ok(syncRes.githubSync && syncRes.githubSync.pushed);

            // Inspect ag-snapshot:latest.json from bare remote git repo
            const committedJson = JSON.parse(
                execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:latest.json'], { encoding: 'utf8' })
            );
            assert.equal(committedJson.news.length, 1, 'ag-sync-pulse must preserve existing global news');
            assert.equal(committedJson.publishedAt, tenHoursAgoIso, 'ag-sync-pulse must preserve news publishedAt so 07:40 news cooldown is NOT tripped');
            assert.equal(committedJson.socialPulse.issueCount, 1);
            assert.equal(committedJson.socialPulse.latestKey, 'daily:2026-11-15');
            const treeFiles = execFileSync('git', ['--git-dir', bareRemoteDir, 'ls-tree', '--name-only', 'ag-snapshot'], { encoding: 'utf8' }).trim().split(/\r?\n/);
            assert.ok(treeFiles.includes('latest.json') && treeFiles.includes('briefing.json') && treeFiles.includes('briefing.md'), 'ag-sync-pulse must preserve briefing.json and briefing.md in ag-snapshot tree');

            // Verify 07:40 cooldown check against committedJson returns inCooldown === false!
            let currentRemotePayload = committedJson;
            const mockGh = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json', ETag: `"etag-${currentRemotePayload.socialPulseUpdatedAt || '1'}"` });
                res.end(JSON.stringify(currentRemotePayload));
            });
            await new Promise((res, rej) => mockGh.listen(0, '127.0.0.1', e => (e ? rej(e) : res())));
            const mockSnapUrl = `http://127.0.0.1:${mockGh.address().port}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

            try {
                const cdCheck = await checkRemoteSnapshotCooldown({
                    snapshotUrl: mockSnapUrl,
                    cooldownMinutes: 30
                });
                assert.equal(cdCheck.inCooldown, false, '07:15 social pulse push must NOT trigger 30m news cooldown for 07:40');

                // Verify router/server with older state (news already synced at tenHoursAgoIso, but socialPulse missing!) pulls and applies socialPulse even with force: false!
                stateManager.set('lastUpdated', tenHoursAgoIso, false);
                stateManager.set('lastSnapshotPublishedAt', tenHoursAgoIso, false);
                stateManager.updateSocialPulse(null, false);

                const pullRes = await services.githubSyncManager.pullAndApply({
                    snapshotUrl: mockSnapUrl,
                    force: false,
                    trigger: 'schedule'
                });
                assert.equal(pullRes.applied, true, 'GitHubSyncManager must detect and apply new socialPulse even when news publishedAt is unchanged');
                assert.equal(pullRes.hasSocialPulse, true);
                assert.equal(stateManager.get('socialPulse').latestKey, 'daily:2026-11-15');

                // Step C: When 07:40 runs ag-publish.js for fresh morning news, it automatically carries forward socialPulse from data/social_pulse.json!
                const morningNewsIso = new Date().toISOString();
                fs.writeFileSync(standaloneNewsPath, JSON.stringify({
                    publishedAt: morningNewsIso,
                    news: [
                        {
                            id: 'n-morning-1',
                            title: 'Morning Global Dispatch',
                            translatedTitle: '早间全球权威要闻更新：跨境电网互联提速',
                            summary: '多国能源部门签署新一轮跨境特高压电网互联建设计划。',
                            url: 'https://www.bbc.com/news/morning-grid-2026',
                            region: '欧洲',
                            category: '能源',
                            keyPoints: ['签署跨境电网互联计划', '提升可再生能源消纳', '降低冬季峰谷电价波动'],
                            translatedParagraphs: ['欧洲多国能源部门正式签署新一轮跨境特高压电网互联建设计划，旨在降低冬季峰谷电价波动。'],
                            source: { name: 'BBC News (英国广播公司)' }
                        }
                    ],
                    summary: '### 能源动态\n跨境电网互联提速 [NEWS_1]。'
                }, null, 2), 'utf8');

                await runPublish({
                    candidates: path.join(tmpRoot, 'missing_cand.json'),
                    file: standaloneNewsPath,
                    target: baseUrl,
                    secret: 'pulse-sec-123',
                    pushToGithub: true,
                    repoDir: workRepoDir,
                    clientId: 'morning-news-0740'
                });

                const morningSnap = JSON.parse(
                    execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'ag-snapshot:latest.json'], { encoding: 'utf8' })
                );
                assert.equal(morningSnap.news[0].translatedTitle, '早间全球权威要闻更新：跨境电网互联提速');
                assert.ok(morningSnap.socialPulse, '07:40 ag-publish.js must retain socialPulse in ag-snapshot/latest.json');
                assert.equal(morningSnap.socialPulse.latestKey, 'daily:2026-11-15');
            } finally {
                await new Promise((r) => mockGh.close(() => r()));
            }
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});
