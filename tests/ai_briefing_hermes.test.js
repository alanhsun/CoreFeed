/**
 * CoreFeed v2.0 — AI 助手直读接口 (/api/ai/*)、GitHub 轻量伴生快照与 Hermes × 小爱音箱技能端到端测试
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { promisify } = require('util');
const { execFile, execFileSync } = require('child_process');
const execFileAsync = promisify(execFile);

process.env.NODE_ENV = 'test';

const { app, server, io, services } = require('../server');
const stateManager = require('../services/state_manager');
const { publishSnapshotToGitHub } = require('../utils/github_sync');
const {
    extractSpokenSourceName,
    cleanTextForTts,
    splitIntoTtsSegments,
    buildAiBriefing
} = require('../utils/briefing_formatter');

const ROOT_DIR = path.resolve(__dirname, '..');
const CLI_SCRIPT = path.join(ROOT_DIR, 'integrations', 'hermes-skill', 'corefeed-news', 'scripts', 'corefeed_cli.py');
const INSTALL_SCRIPT = path.join(ROOT_DIR, 'integrations', 'hermes-skill', 'install.sh');
const SKILL_MD = path.join(ROOT_DIR, 'integrations', 'hermes-skill', 'corefeed-news', 'SKILL.md');

const SAMPLE_PUBLISHED_AT = '2026-11-14T00:30:00.000Z';
const SAMPLE_NEWS = [
    {
        id: 'ai-test-1',
        title: 'Federal Reserve Holds Benchmark Rate Steady Amid Sticky Core Inflation',
        translatedTitle: '美联储宣布维持基准利率不变并释放审慎政策信号',
        summary: '美联储联邦公开市场委员会一致决定维持利率区间不变，强调后续调整取决于核心通胀与就业数据走势。',
        keyPoints: [
            '联邦公开市场委员会全票维持现行基准利率不变',
            '鲍威尔指出核心服务通胀回落但仍具一定黏性',
            '美债收益率与美元指数在决议公布后窄幅震荡'
        ],
        translatedParagraphs: [
            '美联储在结束为期两天的货币政策例会后宣布，将联邦基金利率目标区间维持在当前水平不变，符合市场普遍预期。',
            '美联储主席鲍威尔在记者会上表示，近期通胀数据朝着2%目标进一步靠拢，但委员会仍需看到更多可持续回落的证据才会考虑下一步行动。'
        ],
        fullText: 'Full raw English article text '.repeat(120),
        region: '美国',
        category: '财经',
        url: 'https://www.reuters.com/markets/us-fed-rate-2026',
        publishedAt: SAMPLE_PUBLISHED_AT,
        aiCompiled: true,
        source: { id: 'reuters', name: 'Reuters (路透社)' },
        relatedSources: [{ name: 'Financial Times (金融时报)', url: 'https://www.ft.com/content/fed-2026' }],
        sourceCount: 2
    },
    {
        id: 'ai-test-2',
        title: 'Next-Gen Optical Interconnect Chip Cuts AI Cluster Power Consumption by 40%',
        translatedTitle: '新一代硅光互连芯片使超大规模AI算力集群功耗降低40%',
        summary: '国际半导体联合研发团队发布最新共封装光学互连架构，大幅缓解万卡级智算中心的数据传输能耗瓶颈。',
        keyPoints: [
            '采用共封装光学互连技术替代传统铜缆高速连接',
            '实测集群节点间通信延迟降低35%且整体功耗下降40%',
            '预计明年下半年在多家云服务商数据中心规模部署'
        ],
        translatedParagraphs: [
            '多家顶尖科研机构与芯片厂商联合展示了最新一代共封装硅光互连芯片，旨在攻克人工智能大模型训练集群的互连能耗墙。',
            '测试结果显示，在万卡规模算力网络中引入该光学互连方案后，跨机柜带宽密度提升三倍，同时传输功耗较传统电互连下降约40%。'
        ],
        fullText: 'Optical chip English body '.repeat(100),
        region: '国际',
        category: '科技',
        url: 'https://www.nature.com/articles/s41586-silicon-photonics-2026',
        publishedAt: SAMPLE_PUBLISHED_AT,
        aiCompiled: true,
        source: { id: 'nature', name: 'Nature (自然)' },
        relatedSources: [],
        sourceCount: 1
    },
    {
        id: 'ai-test-3',
        title: 'European Grid Operators Approve Cross-Border Offshore Wind Corridor',
        translatedTitle: '欧洲多国电网运营商批准北海跨境海上风电输电走廊计划',
        summary: '欧洲互联电网联盟签署联合投资协议，推进北海海上风电柔直输电枢纽建设以增强冬季能源韧性。',
        keyPoints: [
            '连接四个北海沿岸国家的海上柔性直流输电骨干网获批',
            '规划新增装机并网容量达12吉瓦',
            '配套跨境储能调峰机制同步启动建设'
        ],
        translatedParagraphs: [
            '欧洲多家输电系统运营商今日正式签署联合建设协议，批准在北海海域新建多端柔性直流跨境海上风电走廊。'
        ],
        fullText: 'European grid English body '.repeat(80),
        region: '欧洲',
        category: '能源',
        url: 'https://www.bbc.com/news/business-north-sea-grid-2026',
        publishedAt: SAMPLE_PUBLISHED_AT,
        aiCompiled: true,
        source: { id: 'bbc', name: 'BBC News (英国广播公司)' },
        relatedSources: [],
        sourceCount: 1
    }
];

const SAMPLE_SUMMARY = {
    title: '2026年11月14日 全球要闻深度综述：欧美货币与能源布局并进，AI光互连突破算力瓶颈',
    content: [
        '### 全球宏观与货币政策',
        '**美联储**宣布维持基准利率不变，强调政策节奏仍取决于核心通胀走势 [NEWS_1]。',
        '',
        '### 前沿科技与绿色基础设施',
        '新一代硅光互连芯片将超大规模AI集群功耗降低40% [NEWS_2]；与此同时，欧洲批准北海跨境海上风电输电走廊计划以提升清洁能源调配能力 [NEWS_3]。'
    ].join('\n'),
    htmlContent: '<h3 class="summary-section-title">全球宏观与货币政策</h3><p class="summary-paragraph">美联储维持利率不变。</p>',
    newsCount: 3,
    regions: ['美国', '国际', '欧洲'],
    generatedAt: SAMPLE_PUBLISHED_AT,
    wordCount: 168
};

describe('CoreFeed v2.0 — AI Briefing API & Hermes × Open-XiaoAI Bridge Integration Tests', () => {
    let baseUrl = '';
    let prevNoProxy;

    before(async () => {
        prevNoProxy = process.env.NO_PROXY;
        process.env.NO_PROXY = '127.0.0.1,localhost';

        stateManager.reset();
        stateManager.set('lastPublishedBy', 'ag-editor-test', false);
        stateManager.updateNewsData(SAMPLE_NEWS, SAMPLE_NEWS, SAMPLE_PUBLISHED_AT);
        stateManager.updateSummaryArticle(SAMPLE_SUMMARY);

        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
            });
        }
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (services.scheduleManager) services.scheduleManager.stop();
        if (io) io.close();
        if (server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
    });

    it('1. briefing_formatter cleans [NEWS_k]/Markdown for TTS, extracts Chinese media names, and enforces segment length bounds', () => {
        assert.equal(extractSpokenSourceName('Reuters (路透社)'), '路透社');
        assert.equal(extractSpokenSourceName({ name: 'BBC News (英国广播公司)' }), '英国广播公司');
        assert.equal(extractSpokenSourceName('CNBC'), 'CNBC');

        const cleaned = cleanTextForTts(SAMPLE_SUMMARY.content);
        assert.equal(cleaned.includes('[NEWS_'), false, 'TTS text must strip [NEWS_k] markers');
        assert.equal(cleaned.includes('###'), false, 'TTS text must strip Markdown headers');
        assert.equal(cleaned.includes('**'), false, 'TTS text must strip bold markers');
        assert.ok(cleaned.includes('全球宏观与货币政策：'), 'Section titles should become spoken transitions');

        const briefing = buildAiBriefing({
            newsList: SAMPLE_NEWS,
            summaryArticle: SAMPLE_SUMMARY,
            lastUpdated: SAMPLE_PUBLISHED_AT,
            lastPublishedBy: 'ag-editor-test',
            query: { limit: 3, maxSegmentChars: 110, oralMaxChars: 180 }
        });

        assert.equal(briefing.returnedCount, 3);
        assert.ok(briefing.tts.segments.length >= 2);
        for (const seg of briefing.tts.segments) {
            assert.ok(seg.length <= 110, `Segment length ${seg.length} exceeded maxSegmentChars 110: ${seg}`);
            assert.equal(seg.includes('[NEWS_'), false);
        }
        assert.ok(briefing.tts.shortText.length <= 180, 'shortText must obey oralMaxChars');
    });

    it('2. Express /api/ai/briefing, /api/ai/briefing.md & /api/ai/article/:ref serve filtered JSON, Markdown, oral & full article payloads', async () => {
        const resJson = await fetch(`${baseUrl}/api/ai/briefing?limit=2`);
        assert.equal(resJson.status, 200);
        const body = await resJson.json();
        assert.equal(body.success, true);
        assert.equal(body.totalAvailable, 3);
        assert.equal(body.returnedCount, 2);
        assert.equal(body.overview.available, true);
        assert.equal(body.items[0].spokenSource, '路透社');
        assert.equal(body.items[0].paragraphs, undefined, 'brief detail omits full paragraphs by default');

        const resTech = await fetch(`${baseUrl}/api/ai/briefing?category=${encodeURIComponent('科技')}`);
        const techBody = await resTech.json();
        assert.equal(techBody.returnedCount, 1);
        assert.equal(techBody.items[0].id, 'ai-test-2');

        const resMd = await fetch(`${baseUrl}/api/ai/briefing.md`);
        assert.equal(resMd.status, 200);
        assert.ok((resMd.headers.get('content-type') || '').includes('text/markdown'));
        const mdText = await resMd.text();
        assert.ok(mdText.includes('# CoreFeed · 全球要闻精编简报'));
        assert.ok(mdText.includes('新一代硅光互连芯片'));

        const resOral = await fetch(`${baseUrl}/api/ai/briefing?format=oral&oralMaxChars=220`);
        assert.equal(resOral.status, 200);
        const oralText = (await resOral.text()).trim();
        assert.ok(oralText.length > 10 && oralText.length <= 220);
        assert.equal(oralText.includes('#'), false);

        const resArt = await fetch(`${baseUrl}/api/ai/article/2`);
        assert.equal(resArt.status, 200);
        const artBody = await resArt.json();
        assert.equal(artBody.items.length, 1);
        assert.equal(artBody.items[0].index, 2);
        assert.equal(artBody.items[0].paragraphs.length, 2);
        assert.ok(artBody.tts.fullText.includes('自然报道：新一代硅光互连芯片'));

        const resNotFound = await fetch(`${baseUrl}/api/ai/article/99`);
        assert.equal(resNotFound.status, 404);
    });

    it('3. publishSnapshotToGitHub commits lightweight briefing.json & briefing.md alongside latest.json in single orphan commit', () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-ai-snap-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });
            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@local'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            const pub = publishSnapshotToGitHub(
                {
                    publishedAt: SAMPLE_PUBLISHED_AT,
                    news: SAMPLE_NEWS,
                    allEnhancedNews: SAMPLE_NEWS,
                    summaryArticle: SAMPLE_SUMMARY
                },
                { repoDir: workRepoDir, remote: 'origin', branch: 'ag-snapshot' }
            );

            assert.equal(pub.success, true);
            assert.deepEqual(pub.files, ['briefing.json', 'briefing.md', 'latest.json']);

            const commitCount = execFileSync('git', ['--git-dir', bareRemoteDir, 'rev-list', '--count', 'refs/heads/ag-snapshot'], { encoding: 'utf8' }).trim();
            assert.equal(commitCount, '1');

            const latestRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:latest.json'], { encoding: 'utf8' });
            const briefingJsonRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:briefing.json'], { encoding: 'utf8' });
            const briefingMdRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:briefing.md'], { encoding: 'utf8' });

            assert.ok(briefingJsonRaw.length < latestRaw.length, 'briefing.json should be much smaller than latest.json');
            const parsedBriefing = JSON.parse(briefingJsonRaw);
            assert.equal(parsedBriefing.articleCount, 3);
            assert.ok(Array.isArray(parsedBriefing.ttsPresets.top5Headlines.segments));
            assert.ok(briefingMdRaw.includes('美联储宣布维持基准利率不变'));
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('4. Hermes Skill installer, LAN/GitHub failover & Open-XiaoAI Bridge sequential TTS playback / interrupt E2E', async () => {
        // 4a. Validate SKILL.md frontmatter
        assert.equal(fs.existsSync(SKILL_MD), true);
        const skillContent = fs.readFileSync(SKILL_MD, 'utf8');
        assert.ok(/^---\r?\nname:\s*corefeed-news\r?\ndescription:\s*.+\r?\n---/.test(skillContent));

        // 4b. Mock GitHub raw server + Mock Open-XiaoAI Bridge HTTP server
        const { buildSnapshotBriefingFiles } = require('../utils/briefing_formatter');
        const { briefingJson } = buildSnapshotBriefingFiles({
            publishedAt: SAMPLE_PUBLISHED_AT,
            news: SAMPLE_NEWS,
            summaryArticle: SAMPLE_SUMMARY
        });

        let doubaoEnabled = false;
        let simulateInterruptOnFirstSegment = false;
        const bridgeCalls = [];

        const mockBridgeServer = http.createServer((req, res) => {
            let reqBody = '';
            req.on('data', (chunk) => { reqBody += chunk; });
            req.on('end', () => {
                const parsed = reqBody ? JSON.parse(reqBody) : null;
                bridgeCalls.push({ method: req.method, url: req.url, body: parsed });

                if (req.url === '/api/health') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, data: { status: 'healthy', speaker_ready: true } }));
                    return;
                }
                if (req.url === '/api/status') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, data: { status: 'idle' } }));
                    return;
                }
                if (req.url === '/api/interrupt' && req.method === 'POST') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                    return;
                }
                if (req.url === '/api/tts/doubao' && req.method === 'POST') {
                    if (!doubaoEnabled) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, error: 'Doubao TTS credentials not configured' }));
                        return;
                    }
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: !simulateInterruptOnFirstSegment }));
                    return;
                }
                if (req.url === '/api/play/text' && req.method === 'POST') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: !simulateInterruptOnFirstSegment }));
                    return;
                }
                if (req.url === '/ag-snapshot/briefing.json') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(briefingJson);
                    return;
                }
                res.writeHead(404);
                res.end('Not found');
            });
        });

        await new Promise((resolve, reject) => {
            mockBridgeServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        const mockBridgeUrl = `http://127.0.0.1:${mockBridgeServer.address().port}`;
        const tmpHermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-test-'));

        try {
            const childEnv = {
                ...process.env,
                HERMES_HOME: tmpHermesHome,
                NO_PROXY: '127.0.0.1,localhost',
                no_proxy: '127.0.0.1,localhost'
            };
            delete childEnv.COREFEED_BASE_URL;
            delete childEnv.OPENXIAOAI_BASE_URL;

            // 4c. Run install.sh into temporary HERMES_HOME
            await execFileAsync(
                'sh',
                [
                    INSTALL_SCRIPT,
                    `--hermes-home=${tmpHermesHome}`,
                    `--corefeed-url=${baseUrl}`,
                    `--xiaoai-url=${mockBridgeUrl}`,
                    '--skip-check'
                ],
                { env: childEnv, encoding: 'utf8' }
            );

            const installedCli = path.join(tmpHermesHome, 'skills', 'corefeed-news', 'scripts', 'corefeed_cli.py');
            assert.equal(fs.existsSync(installedCli), true);
            const envText = fs.readFileSync(path.join(tmpHermesHome, '.env'), 'utf8');
            assert.ok(envText.includes(`COREFEED_BASE_URL="${baseUrl}"`));
            assert.ok(envText.includes(`OPENXIAOAI_BASE_URL="${mockBridgeUrl}"`));

            // 4d. Text query via LAN (no speaker calls!)
            const { stdout: queryOut } = await execFileAsync('python3', [installedCli, 'query', '--limit', '2'], {
                env: childEnv,
                encoding: 'utf8'
            });
            assert.ok(queryOut.includes('美联储宣布维持基准利率不变'));
            assert.equal(bridgeCalls.length, 0, 'Text query must NEVER trigger speaker HTTP calls');

            // 4e. Oral short reply for open-xiaoai-bridge auto-TTS mode
            const { stdout: oralRaw } = await execFileAsync('python3', [installedCli, 'query', '--oral', '--max-chars', '200'], {
                env: childEnv,
                encoding: 'utf8'
            });
            const oralOut = oralRaw.trim();
            assert.ok(oralOut.length <= 200);
            assert.equal(oralOut.includes('#'), false);
            assert.equal(bridgeCalls.length, 0);

            // 4f. LAN unreachable -> automatic GitHub snapshot failover
            const { stdout: failoverRaw } = await execFileAsync(
                'python3',
                [
                    installedCli,
                    'query',
                    '--corefeed-url',
                    'http://127.0.0.1:9',
                    '--github-base',
                    `${mockBridgeUrl}/ag-snapshot`,
                    '--category',
                    '能源',
                    '--json'
                ],
                { env: childEnv, encoding: 'utf8' }
            );
            const failoverJson = JSON.parse(failoverRaw);
            assert.ok(failoverJson._dataSource.startsWith('github:'));
            assert.equal(failoverJson.returnedCount, 1);
            assert.equal(failoverJson.items[0].id, 'ai-test-3');

            // 4g. Speak command: Doubao unconfigured -> auto-fallback to XiaoAi native /api/play/text with blocking=true
            bridgeCalls.length = 0;
            doubaoEnabled = false;
            const { stdout: speakOut1 } = await execFileAsync(
                'python3',
                [installedCli, 'speak', '--limit', '3', '--segment-chars', '120'],
                { env: childEnv, encoding: 'utf8' }
            );
            assert.ok(speakOut1.includes('引擎=xiaoai'));
            const nativePlayCalls = bridgeCalls.filter(c => c.url === '/api/play/text');
            assert.ok(nativePlayCalls.length >= 2, 'Should split into multiple sequential segments');
            assert.equal(nativePlayCalls[0].body.blocking, true, 'Must send blocking=true so segments do not overlap');

            // 4h. Speak command with Doubao enabled + custom speaker + mid-broadcast user interrupt
            bridgeCalls.length = 0;
            doubaoEnabled = true;
            simulateInterruptOnFirstSegment = true;
            const { stdout: speakInterruptedOut } = await execFileAsync(
                'python3',
                [installedCli, 'speak', '--limit', '3', '--segment-chars', '100', '--speaker', 'zh_female_vv_uranus_bigtts'],
                { env: childEnv, encoding: 'utf8' }
            );
            assert.ok(speakInterruptedOut.includes('被语音打断'));
            const doubaoCalls = bridgeCalls.filter(c => c.url === '/api/tts/doubao');
            assert.equal(doubaoCalls.length, 1, 'Must halt remaining segments immediately when speaker returns interrupted');
            assert.equal(doubaoCalls[0].body.speaker_id, 'zh_female_vv_uranus_bigtts');

            // 4i. Stop command & Status command
            simulateInterruptOnFirstSegment = false;
            const { stdout: stopOut } = await execFileAsync('python3', [installedCli, 'stop'], { env: childEnv, encoding: 'utf8' });
            assert.ok(stopOut.includes('停止当前新闻播报'));
            assert.ok(bridgeCalls.some(c => c.url === '/api/interrupt'));

            const { stdout: statusRaw } = await execFileAsync(
                'python3',
                [installedCli, 'status', '--github-base', `${mockBridgeUrl}/ag-snapshot`, '--json'],
                { env: childEnv, encoding: 'utf8' }
            );
            const statusJson = JSON.parse(statusRaw);
            assert.equal(statusJson.corefeedLan.reachable, true);
            assert.equal(statusJson.openXiaoAiBridge.reachable, true);
            assert.equal(statusJson.openXiaoAiBridge.speakerReady, true);
        } finally {
            fs.rmSync(tmpHermesHome, { recursive: true, force: true });
            await new Promise((resolve) => mockBridgeServer.close(() => resolve()));
        }
    });
});
