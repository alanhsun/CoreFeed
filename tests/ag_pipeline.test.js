/**
 * CoreFeed v2.0 — Antigravity Path A 发布接口、CLI 流水线与早中晚自动调度端到端测试套件
 *
 * 覆盖范围 (7 项端到端测试)：
 *   1. `POST /api/agent/publish` 鉴权校验 (401/403) 与非法载荷拦截 (400)
 *   2. `POST /api/agent/publish` 正常发布、文件持久化 (`news.json`/`summary.json`/`state.json`) 与增量路由验证
 *   3. `scripts/ag-publish.js` 并查集 (`duplicateGroups`) 合并、`[NEWS_k]` 引注渲染与远程推送闭环
 *   4. 预编译深读 (`ag_precompiled`) 秒级直出验证，确保点击「全文深读」零外部网络阻塞
 *   5. `scripts/ag-harvest.js` CLI 参数解析与候选池导出契约验证
 *   6. 每日早中晚三次 (`08:00, 12:30, 19:30` 北京时间) 定时调度状态与动态配置 API 验证
 *   7. `scripts/ag-auto-update.js` 全自动四阶段流水线编排与免密钥编译兜底验证
 *
 * 安全保证：测试开始前自动备份 `data/*.json` 至内存，测试结束后完整还原现场数据。
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

// Ensure non-production mode so rate limiter setInterval is not created
process.env.NODE_ENV = 'test';
process.env.AUTO_UPDATE_ENABLED = 'false';

const config = require('../config');
const stateManager = require('../services/state_manager');
const { app, server, io, services } = require('../server');
const { parseArgs: parseHarvestArgs, runHarvest } = require('../scripts/ag-harvest');
const { parseArgs: parsePublishArgs, runPublish } = require('../scripts/ag-publish');
const { parseArgs: parseAutoArgs, runAutoUpdate } = require('../scripts/ag-auto-update');

const DATA_DIR = config.storage.dataDir || path.join(__dirname, '..', 'data');
const TRACKED_DATA_FILES = [
    'news.json',
    'summary.json',
    'state.json',
    'settings.json',
    'ag_candidates.json',
    'ag_compiled.json'
];

describe('CoreFeed Path A — Antigravity Publish API & CLI Pipeline Tests', () => {
    let baseUrl = '';
    let dataDirExisted = false;
    const fileBackups = new Map();

    before(async () => {
        // Backup any existing data/ files so test run is non-destructive
        dataDirExisted = fs.existsSync(DATA_DIR);
        if (dataDirExisted) {
            for (const fileName of TRACKED_DATA_FILES) {
                const fullPath = path.join(DATA_DIR, fileName);
                if (fs.existsSync(fullPath)) {
                    fileBackups.set(fullPath, fs.readFileSync(fullPath));
                }
            }
        }

        stateManager.reset();

        await new Promise((resolve, reject) => {
            server.listen(0, '127.0.0.1', (err) => {
                if (err) return reject(err);
                const addr = server.address();
                baseUrl = `http://127.0.0.1:${addr.port}`;
                resolve();
            });
        });
    });

    after(async () => {
        delete process.env.PUBLISH_SECRET;
        if (services.scheduleManager) {
            services.scheduleManager.stop();
        }
        await new Promise((resolve) => io.close(() => resolve()));
        await new Promise((resolve) => {
            if (server.listening) {
                server.close(() => resolve());
            } else {
                resolve();
            }
        });

        // Restore or clean up data/ files
        for (const fileName of TRACKED_DATA_FILES) {
            const fullPath = path.join(DATA_DIR, fileName);
            if (fileBackups.has(fullPath)) {
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, fileBackups.get(fullPath));
            } else if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }
        if (!dataDirExisted && fs.existsSync(DATA_DIR)) {
            const remaining = fs.readdirSync(DATA_DIR);
            if (remaining.length === 0) {
                fs.rmdirSync(DATA_DIR);
            }
        }
    });

    it('1. Module export contract: server.js and CLI scripts export required interfaces without auto-starting port 3120', () => {
        assert.ok(app, 'app should be exported');
        assert.ok(server, 'server should be exported');
        assert.ok(io, 'io should be exported');
        assert.ok(services.newsService, 'services.newsService should be initialized');
        assert.ok(services.aiService, 'services.aiService should be initialized');
        assert.ok(services.newsAgentService, 'services.newsAgentService should be initialized');
        assert.equal(app.locals.stateManager, stateManager, 'app.locals.stateManager should reference singleton stateManager');
        assert.notEqual(server.address().port, 3120, 'Test server should run on ephemeral port, not 3120');

        assert.equal(typeof parseHarvestArgs, 'function');
        assert.equal(typeof runHarvest, 'function');
        assert.equal(typeof parsePublishArgs, 'function');
        assert.equal(typeof runPublish, 'function');

        const hArgs = parseHarvestArgs(['--limit', '20', '--deep-read=4', '--images', '10', '--category', 'tech', '--translate-fallback']);
        assert.equal(hArgs.limit, 20);
        assert.equal(hArgs.deepRead, 4);
        assert.equal(hArgs.imageLimit, 10);
        assert.equal(hArgs.category, 'tech');
        assert.equal(hArgs.translateFallback, true);

        const pArgs = parsePublishArgs(['--target', 'http://127.0.0.1:3120', '--secret=sec1', '--limit=15', '--fallback-compile', '--local-only']);
        assert.equal(pArgs.target, 'http://127.0.0.1:3120');
        assert.equal(pArgs.secret, 'sec1');
        assert.equal(pArgs.limit, 15);
        assert.equal(pArgs.fallbackCompile, true);
        assert.equal(pArgs.localOnly, true);
    });

    it('2. POST /api/agent/publish authentication: enforces PUBLISH_SECRET (401 on missing/wrong, 200 on Bearer, x-api-key, or body.secret)', async () => {
        process.env.PUBLISH_SECRET = 'ag-test-secret-999';

        const minimalPayload = {
            news: [
                {
                    id: 'auth-test-1',
                    title: 'Global Summit Opens in Geneva',
                    translatedTitle: '全球峰会在日内瓦开幕',
                    summary: '多国代表齐聚日内瓦讨论全球经济与技术治理议题。',
                    url: 'https://www.reuters.com/world/geneva-summit-2026',
                    source: { name: 'Reuters (路透社)' },
                    region: '欧洲',
                    category: '政经',
                    publishedAt: new Date().toISOString()
                }
            ]
        };

        // 2a. Missing secret -> 401
        const resNoAuth = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resNoAuth.status, 401);
        const bodyNoAuth = await resNoAuth.json();
        assert.equal(bodyNoAuth.success, false);

        // 2b. Wrong Bearer token -> 401
        const resWrongBearer = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer wrong-secret'
            },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resWrongBearer.status, 401);

        // 2c. Valid Bearer token -> 200
        const resValidBearer = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ag-test-secret-999'
            },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resValidBearer.status, 200);
        const bodyValidBearer = await resValidBearer.json();
        assert.equal(bodyValidBearer.success, true);

        // 2d. Valid x-api-key header -> 200
        const resValidApiKey = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': 'ag-test-secret-999'
            },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resValidApiKey.status, 200);
        const bodyValidApiKey = await resValidApiKey.json();
        assert.equal(bodyValidApiKey.success, true);

        // 2e. Valid req.body.secret -> 200
        const resValidBodySecret = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...minimalPayload,
                secret: 'ag-test-secret-999'
            })
        });
        assert.equal(resValidBodySecret.status, 200);
        const bodyValidBodySecret = await resValidBodySecret.json();
        assert.equal(bodyValidBodySecret.success, true);
    });

    it('3. POST /api/agent/publish payload validation: returns 400 on missing, non-array, or empty news', async () => {
        process.env.PUBLISH_SECRET = 'ag-test-secret-999';
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ag-test-secret-999'
        };

        // 3a. Empty object {}
        const resEmptyObj = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers,
            body: JSON.stringify({})
        });
        assert.equal(resEmptyObj.status, 400);

        // 3b. Non-array news
        const resNonArray = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ news: 'not-an-array' })
        });
        assert.equal(resNonArray.status, 400);

        // 3c. Empty array news: []
        const resEmptyArr = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ news: [] })
        });
        assert.equal(resEmptyArr.status, 400);
    });

    it('4. POST /api/agent/publish full state, [NEWS_1] citation rendering, pre-compiled deep-read & disk persistence', async () => {
        process.env.PUBLISH_SECRET = 'ag-test-secret-999';
        const nowIso = new Date().toISOString();

        const displayedNews = [
            {
                id: 'news-item-1',
                title: 'Central Banks Coordinate Cross-Border Digital Settlement Framework',
                translatedTitle: '多国央行协调跨境数字结算新框架',
                description: 'Major central banks announced a joint pilot for instant cross-border settlement.',
                translatedDescription: '多家主要央行宣布启动跨境即时结算联合试点项目。',
                summary: '多家主要央行今日宣布启动跨境数字结算联合试点，旨在降低国际贸易清算成本并提升透明度。',
                content: 'Full article text for item 1...',
                fullTextContent: 'Full article text for item 1 with more than 260 characters so single-article deep read cache hits immediately without external network requests. The new cross-border settlement rail connects major financial hubs across Europe and Asia with atomic settlement guarantees and real-time liquidity management.',
                deepReadHtml: '<h3 class="summary-section-title">核心导读</h3><p class="summary-paragraph">多国央行联合启动跨境数字结算走廊。</p>',
                url: 'https://www.reuters.com/markets/cbdc-settlement-2026',
                urlToImage: 'https://www.reuters.com/resizer/sample1.jpg',
                publishedAt: nowIso,
                region: '国际',
                category: '财经',
                keyPoints: ['启动跨境即时结算试点', '降低国际贸易清算成本'],
                aiCompiled: true,
                qualityScore: 92,
                source: { id: 'reuters', name: 'Reuters (路透社)', url: 'https://www.reuters.com' },
                relatedSources: [{ name: 'BBC News', title: 'Central banks test new settlement rail', url: 'https://www.bbc.com/news/business-1' }],
                sourceCount: 2
            },
            {
                id: 'news-item-2',
                title: 'Next-Gen Solid-State Battery Achieves 1000km Range in Winter Trial',
                translatedTitle: '新一代固态电池在冬季实测中实现千公里续航',
                description: 'Independent winter testing confirmed 1000km range retention at -15C.',
                translatedDescription: '独立冬季测试证实新型固态电池在零下15度环境下仍可保持千公里续航。',
                summary: '最新第三方冬季严寒测试显示，新一代高能量密度固态电池在零下15摄氏度环境中成功实现1000公里续航。',
                content: 'Full article text for item 2...',
                deepReadAnalysis: '### 核心导读\n固态电池在零下15度严寒测试中保持千公里续航能力。',
                url: 'https://www.bbc.com/news/technology-battery-2026',
                urlToImage: 'https://www.bbc.com/images/sample2.jpg',
                publishedAt: nowIso,
                region: '欧洲',
                category: '科技',
                keyPoints: ['零下15度环境实测千公里续航', '快充10分钟补充80%电量'],
                aiCompiled: true,
                qualityScore: 89,
                source: { id: 'bbc', name: 'BBC News (英国广播公司)', url: 'https://www.bbc.com/news' },
                relatedSources: [],
                sourceCount: 1
            }
        ];

        const allEnhancedPool = [
            ...displayedNews,
            {
                ...displayedNews[1],
                id: 'news-item-3',
                title: 'Extra Pool Article for Pagination Verification',
                translatedTitle: '用于分页验证的候选池扩展新闻条目',
                url: 'https://apnews.com/article/extra-pool-3'
            }
        ];

        const summaryArticle = {
            title: '2026年全球要闻深度综述：跨境金融改革与能源科技突破',
            content: '### 全球财经动态\n多国央行宣布启动跨境数字结算联合试点，推动清算体系升级 [NEWS_1]。\n\n### 前沿科技突破\n新一代固态电池在严寒测试中突破千公里续航大关 [NEWS_2]。',
            newsCount: 2,
            regions: ['国际', '欧洲'],
            generatedAt: nowIso,
            summary: '多国央行启动跨境结算试点，新一代固态电池实现严寒千公里续航。',
            wordCount: 128
        };

        const resPublish = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ag-test-secret-999'
            },
            body: JSON.stringify({
                news: displayedNews,
                allEnhancedNews: allEnhancedPool,
                summaryArticle,
                sourceStats: [{ id: 'reuters', name: 'Reuters', count: 5, status: 'ok' }],
                lastUpdated: nowIso
            })
        });

        assert.equal(resPublish.status, 200);
        const pubData = await resPublish.json();
        assert.equal(pubData.success, true);
        assert.equal(pubData.displayedCount, 2);
        assert.equal(pubData.hasSummary, true);

        // Verify GET /api/news
        const resNews = await fetch(`${baseUrl}/api/news`);
        assert.equal(resNews.status, 200);
        const newsBody = await resNews.json();
        assert.equal(newsBody.success, true);
        assert.equal(newsBody.news.length, 2);
        assert.equal(newsBody.total, 3);
        assert.equal(newsBody.hasMore, true);
        assert.equal(newsBody.collectionPhase, 'completed');
        assert.equal(newsBody.news[0].translatedTitle, '多国央行协调跨境数字结算新框架');

        // Verify GET /api/summary and [NEWS_1] -> <a ... class="news-ref-link"> conversion
        const resSummary = await fetch(`${baseUrl}/api/summary`);
        assert.equal(resSummary.status, 200);
        const summaryBody = await resSummary.json();
        assert.equal(summaryBody.success, true);
        assert.ok(summaryBody.article, 'summaryArticle should exist');
        assert.ok(
            summaryBody.article.htmlContent.includes('class="news-ref-link"'),
            'summaryArticle.htmlContent must convert [NEWS_1] into <a ... class="news-ref-link">'
        );
        assert.ok(
            summaryBody.article.htmlContent.includes('href="https://www.reuters.com/markets/cbdc-settlement-2026"'),
            'summaryArticle.htmlContent must link to NEWS_1 url'
        );
        assert.ok(
            summaryBody.article.htmlContent.includes('[Reuters]'),
            'summaryArticle.htmlContent must render cleaned source label [Reuters]'
        );

        // Verify GET /api/latest-data
        const resLatest = await fetch(`${baseUrl}/api/latest-data`);
        assert.equal(resLatest.status, 200);
        const latestBody = await resLatest.json();
        assert.equal(latestBody.success, true);
        assert.equal(latestBody.data.news.count, 2);
        assert.equal(latestBody.data.news.items[0].title, '多国央行协调跨境数字结算新框架');
        assert.equal(latestBody.data.news.items[0].aiCompiled, true);
        assert.equal(latestBody.data.summary.available, true);
        assert.ok(latestBody.data.summary.content.includes('class="news-ref-link"'));

        // Verify POST /api/agent/deep-read with pre-compiled deepReadHtml and deepReadAnalysis
        const resDeepRead1 = await fetch(`${baseUrl}/api/agent/deep-read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: 'https://www.reuters.com/markets/cbdc-settlement-2026',
                title: '多国央行协调跨境数字结算新框架'
            })
        });
        assert.equal(resDeepRead1.status, 200);
        const deepReadBody1 = await resDeepRead1.json();
        assert.equal(deepReadBody1.success, true);
        assert.equal(deepReadBody1.fromCache, true);
        assert.ok(deepReadBody1.analysisHtml.includes('多国央行联合启动跨境数字结算走廊'));

        const resDeepRead2 = await fetch(`${baseUrl}/api/agent/deep-read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: 'https://www.bbc.com/news/technology-battery-2026',
                title: '新一代固态电池在冬季实测中实现千公里续航'
            })
        });
        assert.equal(resDeepRead2.status, 200);
        const deepReadBody2 = await resDeepRead2.json();
        assert.equal(deepReadBody2.success, true);
        assert.ok(deepReadBody2.analysisHtml.includes('固态电池在零下15度严寒测试中保持千公里续航能力'));

        // Verify GET / (homepage SSR HTML)
        const resHome = await fetch(`${baseUrl}/`);
        assert.equal(resHome.status, 200);
        const homeHtml = await resHome.text();
        assert.ok(homeHtml.includes('多国央行协调跨境数字结算新框架'), 'Homepage SSR should include published Chinese headline');
        assert.ok(homeHtml.includes('class="news-ref-link"'), 'Homepage SSR should include rendered summary citation links');

        // Verify disk files data/news.json, data/summary.json, data/state.json
        const diskNews = JSON.parse(fs.readFileSync(config.storage.newsFile, 'utf8'));
        assert.equal(diskNews.news.length, 2);
        assert.equal(diskNews.total, 2);

        const diskSummary = JSON.parse(fs.readFileSync(config.storage.summaryFile, 'utf8'));
        assert.ok(diskSummary.article.htmlContent.includes('class="news-ref-link"'));

        const diskState = JSON.parse(fs.readFileSync(config.storage.stateFile, 'utf8'));
        assert.equal(diskState.version, '2.0');
        assert.equal(diskState.newsData.length, 2);
        assert.equal(diskState.allEnhancedNews.length, 3);
        assert.ok(diskState.summaryArticle.htmlContent.includes('class="news-ref-link"'));
    });

    it('5. scripts/ag-publish.js CLI end-to-end execution: merges duplicateGroups (preserving Chinese compilation even when secondary member has higher authority), renders citations, saves files & POSTs to server', async () => {
        process.env.PUBLISH_SECRET = 'ag-test-secret-999';
        const candidatesPath = path.join(DATA_DIR, 'ag_candidates.json');
        const compiledPath = path.join(DATA_DIR, 'ag_compiled.json');
        const nowIso = new Date().toISOString();

        // Notice cand-1 has lower source authority & no image, while cand-3 (secondary in duplicateGroups [[1, 3]]) has higher authority (Reuters) + image + longer content so _mergeArticleCluster picks cand-3 as primary
        const rawCandidates = [
            {
                id: 'cand-1',
                title: 'UN Reaches Historic Global AI Safety Accord in New York',
                description: 'Member states signed the landmark framework on frontier AI governance.',
                content: 'Short report on UN AI accord.',
                url: 'https://www.bbc.com/news/world-un-ai-pact-2026',
                publishedAt: nowIso,
                region: '国际',
                category: '科技',
                source: { id: 'bbc', name: 'BBC News (英国广播公司)', authority: 90 },
                relatedSources: [],
                sourceCount: 1
            },
            {
                id: 'cand-2',
                title: 'Asian Markets Rally as Semiconductor Exports Surge 28%',
                description: 'Strong chip demand lifted major Asian indices on Monday.',
                content: 'Detailed market report on semiconductor export growth...',
                url: 'https://asia.nikkei.com/Economy/chip-exports-2026',
                urlToImage: 'https://asia.nikkei.com/img/chips.jpg',
                publishedAt: nowIso,
                region: '亚洲',
                category: '财经',
                source: { id: 'nikkei', name: 'Nikkei Asia (日经亚洲)', authority: 90 },
                relatedSources: [],
                sourceCount: 1
            },
            {
                id: 'cand-3',
                title: 'United Nations Adopts Binding AI Governance Pact',
                description: 'Reuters coverage of the UN frontier AI treaty in New York.',
                content: 'Comprehensive Reuters dispatch with extensive details on the United Nations binding AI safety governance treaty signed in New York by member states...',
                url: 'https://www.reuters.com/technology/un-ai-accord-2026',
                urlToImage: 'https://www.reuters.com/img/ai-accord.jpg',
                publishedAt: nowIso,
                region: '国际',
                category: '科技',
                source: { id: 'reuters', name: 'Reuters (路透社)', authority: 99 },
                relatedSources: [],
                sourceCount: 1
            }
        ];

        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(candidatesPath, JSON.stringify({
            harvestedAt: nowIso,
            rawCount: 10,
            candidateCount: 3,
            sourceStats: [{ id: 'reuters', name: 'Reuters', count: 5, status: 'ok' }],
            fullCandidates: rawCandidates,
            llmInput: rawCandidates.map((c, idx) => ({
                index: idx + 1,
                id: c.id,
                sourceName: c.source.name,
                relatedSources: [],
                title: c.title,
                regionHint: c.region,
                categoryHint: c.category,
                excerpt: c.description
            }))
        }, null, 2));

        fs.writeFileSync(compiledPath, JSON.stringify({
            duplicateGroups: [[1, 3]],
            articles: [
                {
                    index: 1,
                    id: 'cand-1',
                    translatedTitle: '联合国在纽约达成历史性全球人工智能安全协议',
                    summary: '联合国成员国在纽约正式签署具有里程碑意义的前沿人工智能治理框架协议，确立跨国安全评估标准。',
                    region: '国际',
                    category: '科技',
                    keyPoints: ['签署前沿AI治理框架', '确立跨国安全评估标准']
                },
                {
                    index: 2,
                    id: 'cand-2',
                    translatedTitle: '半导体出口激增28%推动亚太股市全线上扬',
                    summary: '受全球人工智能算力芯片强劲需求拉动，最新贸易数据显示半导体出口同比大增28%，提振亚太主要股指。',
                    region: '亚洲',
                    category: '财经',
                    keyPoints: ['半导体出口同比大增28%', '亚太主要股指全线上涨']
                }
            ],
            summaryMarkdown: '2026年全球要闻深度综述\n\n### 科技与全球治理\n联合国达成历史性全球人工智能安全协议，多国确立统一治理标准 [NEWS_1]。\n\n### 亚太经贸动态\n受算力需求拉动，半导体出口同比增长28%，带动亚太市场走强 [NEWS_2]。'
        }, null, 2));

        const publishScript = path.join(__dirname, '..', 'scripts', 'ag-publish.js');
        await execFileAsync(process.execPath, [
            publishScript,
            '--candidates', candidatesPath,
            '--compiled', compiledPath,
            '--target', baseUrl,
            '--secret', 'ag-test-secret-999'
        ], {
            env: {
                ...process.env,
                COREFEED_SITE_URL: baseUrl,
                PUBLISH_SECRET: 'ag-test-secret-999'
            }
        });

        const resLatest = await fetch(`${baseUrl}/api/latest-data`);
        assert.equal(resLatest.status, 200);
        const latestBody = await resLatest.json();
        assert.equal(latestBody.data.news.count, 2, 'duplicateGroups [[1,3]] should merge 3 candidates into 2 articles');
        assert.equal(latestBody.data.news.items[0].title, '联合国在纽约达成历史性全球人工智能安全协议');
        assert.equal(latestBody.data.news.items[0].aiCompiled, true);
        assert.equal(latestBody.data.news.items[0].sourceCount, 2, 'Merged cluster should have sourceCount === 2');
        assert.equal(latestBody.data.summary.available, true);
        assert.ok(latestBody.data.summary.content.includes('class="news-ref-link"'));
    });

    it('6. 3x/day schedule configuration (08:00, 12:30, 19:30 Asia/Shanghai), GET /api/schedule/status, POST /api/schedule/config & timezone-aware getNextExecutionTime()', async () => {
        // Verify default config values
        assert.deepEqual(config.news.updateTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(config.news.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(config.news.timezone, 'Asia/Shanghai');

        // Verify GET /api/schedule/status
        const resStatus = await fetch(`${baseUrl}/api/schedule/status`);
        assert.equal(resStatus.status, 200);
        const statusBody = await resStatus.json();
        assert.equal(statusBody.success, true);
        assert.deepEqual(statusBody.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(statusBody.updateTimes, ['08:00', '12:30', '19:30']);
        assert.equal(statusBody.timezone, 'Asia/Shanghai');
        assert.ok(statusBody.schedule, 'status response should include nested schedule object');

        // Verify POST /api/schedule/config normalizes single-digit hour ('8:00' -> '08:00') and starts 3 tasks
        const resPostSchedule = await fetch(`${baseUrl}/api/schedule/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                enabled: true,
                scheduleTimes: ['8:00', '12:30', '19:30']
            })
        });
        assert.equal(resPostSchedule.status, 200);
        const postScheduleBody = await resPostSchedule.json();
        assert.equal(postScheduleBody.success, true);
        assert.equal(postScheduleBody.enabled, true);
        assert.equal(postScheduleBody.isRunning, true);
        assert.equal(postScheduleBody.tasksCount, 3);
        assert.deepEqual(postScheduleBody.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(postScheduleBody.timezone, 'Asia/Shanghai');

        // Verify nextExecution is a valid future ISO timestamp corresponding to 08:00, 12:30, or 19:30 Asia/Shanghai (00:00, 04:30, or 11:30 UTC)
        const nextExecDate = new Date(postScheduleBody.nextExecution);
        assert.ok(!isNaN(nextExecDate.getTime()), 'nextExecution should be a valid ISO timestamp');
        assert.ok(nextExecDate.getTime() > Date.now(), 'nextExecution should be in the future');
        const utcHm = `${String(nextExecDate.getUTCHours()).padStart(2, '0')}:${String(nextExecDate.getUTCMinutes()).padStart(2, '0')}`;
        assert.ok(
            ['00:00', '04:30', '11:30'].includes(utcHm),
            `nextExecution UTC time (${utcHm}) must match 08:00, 12:30, or 19:30 Asia/Shanghai`
        );

        // Verify persisted data/settings.json
        const savedSettings = JSON.parse(fs.readFileSync(config.storage.settingsFile, 'utf8'));
        assert.equal(savedSettings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.deepEqual(savedSettings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(savedSettings.timezone, 'Asia/Shanghai');

        // Stop cron tasks so test runner exits cleanly
        if (services.scheduleManager) {
            services.scheduleManager.stop();
        }
    });

    it('7. scripts/ag-auto-update.js CLI flag contract, standalone fallback compilation & E2E runAutoUpdate with health verification', async () => {
        assert.equal(typeof parseAutoArgs, 'function');
        assert.equal(typeof runAutoUpdate, 'function');

        const parsed = parseAutoArgs([
            '--target', 'http://127.0.0.1:3120',
            '--secret=my-sec',
            '--limit', '25',
            '--deep-read=6',
            '--images=20',
            '--category=tech',
            '--skip-harvest',
            '--use-existing-compiled',
            '--fallback-compile',
            '--local-only'
        ]);
        assert.equal(parsed.target, 'http://127.0.0.1:3120');
        assert.equal(parsed.secret, 'my-sec');
        assert.equal(parsed.limit, 25);
        assert.equal(parsed.deepRead, 6);
        assert.equal(parsed.imageLimit, 20);
        assert.equal(parsed.category, 'tech');
        assert.equal(parsed.skipHarvest, true);
        assert.equal(parsed.useExistingCompiled, true);
        assert.equal(parsed.fallbackCompile, true);
        assert.equal(parsed.localOnly, true);

        process.env.PUBLISH_SECRET = 'ag-test-secret-999';
        const candidatesPath = path.join(DATA_DIR, 'ag_candidates.json');
        const compiledPath = path.join(DATA_DIR, 'ag_compiled.json');

        // 7a. Run with --skip-harvest --use-existing-compiled
        const resExisting = await runAutoUpdate({
            candidates: candidatesPath,
            compiled: compiledPath,
            target: baseUrl,
            secret: 'ag-test-secret-999',
            limit: 10,
            skipHarvest: true,
            useExistingCompiled: true
        });
        assert.equal(resExisting.success, true);
        assert.equal(resExisting.mode, 'existing-compiled');
        assert.equal(resExisting.displayedCount, 2);
        assert.equal(resExisting.healthVerified, true);

        // 7b. Run with standalone compilation (--skip-harvest --fallback-compile, useExistingCompiled=false)
        const resFallback = await runAutoUpdate({
            candidates: candidatesPath,
            compiled: compiledPath,
            target: baseUrl,
            secret: 'ag-test-secret-999',
            limit: 10,
            skipHarvest: true,
            useExistingCompiled: false,
            fallbackCompile: true
        });
        assert.equal(resFallback.success, true);
        assert.equal(resFallback.mode, 'fallback-chinese');
        assert.equal(resFallback.compiledCount, 3);
        assert.equal(resFallback.displayedCount, 3);
        assert.ok(resFallback.summaryWordCount > 50, 'Fallback compilation must generate a Chinese summary article');
        assert.equal(resFallback.healthVerified, true);
    });
});
