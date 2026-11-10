/**
 * CoreFeed v2.0 — Plan 2B 发布接口、CLI 流水线、多客户端协同与 Swiss Editorial UI 端到端测试套件
 *
 * 覆盖范围 (15 项端到端测试)：
 *   1. 服务与 CLI 模块导出契约校验
 *   2. `POST /api/agent/publish` 鉴权校验 (401/200)
 *   3. `POST /api/agent/publish` 非法载荷拦截 (400)
 *   4. `POST /api/agent/publish` 状态落盘、`[NEWS_k]` 引注渲染与已移除旧路由 404 验证
 *   5. `scripts/ag-publish.js` 并查集 (`duplicateGroups`) 合并与远程推送闭环
 *   6. 每日早中晚三次 (`08:00, 12:30, 19:30` 北京时间) 定时调度与配置持久化
 *   7. `scripts/ag-auto-update.js` 全自动四阶段流水线编排与免密钥编译兜底
 *   8. 局域网直推 (`--site`/`--file`/`X-Publish-Secret`) 与独立自包含快照发布
 *   9. Git Plumbing 孤儿分支 (`ag-snapshot/latest.json`) 无工作区污染发布
 *  10. 软路由 `POST /api/agent/pull-github` 与 `GET /api/agent/sync-status` 同步闭环
 *  11. 方案 2B 默认推送 GitHub 与 `publishedBy`/`clientId` 元数据透传
 *  12. 多客户端 30 分钟冷却防冲突协调与 ETag `304 Not Modified` 轮询
 *  13. Swiss Editorial Bento UI SSR (`?v=2.5.4`)、深读组件彻底移除与一键同步验证
 *  14. 方案 2B 软路由防回退保护与英文生肉污染自动自愈验证
 *  15. 无人值守 100% 纯正中文编译契约 (`<=32` 字标题、`80-130` 字摘要、3 条中文要点、引注综述) 与 `ag:daemon` / `ag:status` 调度支持
 *
 * 安全保证：测试开始前自动备份 `data/*.json` 至内存，测试结束后完整还原现场数据。
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile, execFileSync } = require('node:child_process');
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
const { parseArgs: parseAutoArgs, runAutoUpdate, getDaemonStatus, getNextExecutionTime, getLastExecutionTime } = require('../scripts/ag-auto-update');
const { buildSchedulePlan, installSchedule } = require('../scripts/setup-schedule');
const { publishSnapshotToGitHub, checkRemoteSnapshotCooldown, isLocalNewsPolluted } = require('../utils/github_sync');

const DATA_DIR = config.storage.dataDir || path.join(__dirname, '..', 'data');
const TRACKED_DATA_FILES = [
    'news.json',
    'summary.json',
    'state.json',
    'settings.json',
    'ag_candidates.json',
    'ag_compiled.json',
    'ag_daemon_status.json'
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

        const hArgs = parseHarvestArgs(['--limit', '20', '--images', '10', '--category', 'tech', '--translate-fallback']);
        assert.equal(hArgs.limit, 20);
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

    it('4. POST /api/agent/publish full state, [NEWS_1] citation rendering, removed legacy routes 404 contract & disk persistence', async () => {
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

        // Verify removed legacy / Deep-Read endpoints return 404 Not Found
        const resRemovedDeepRead = await fetch(`${baseUrl}/api/agent/deep-read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.reuters.com/markets/cbdc-settlement-2026' })
        });
        assert.equal(resRemovedDeepRead.status, 404, 'Removed /api/agent/deep-read route must return 404');

        const resRemovedSystemPerf = await fetch(`${baseUrl}/api/system/performance`);
        assert.equal(resRemovedSystemPerf.status, 404, 'Removed /api/system/performance route must return 404');

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
            '--secret', 'ag-test-secret-999',
            '--no-github'
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
        // Verify default config values (router/server pull at 08:00, 12:30, 19:30 vs client pre-fetch at 07:40, 12:10, 19:10)
        assert.deepEqual(config.news.updateTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(config.news.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(config.agent.updateTimes, ['07:40', '12:10', '19:10']);
        assert.deepEqual(config.agent.scheduleTimes, ['07:40', '12:10', '19:10']);
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

    it('8. LAN Push Ergonomics: --site/--url/--file CLI flags, safe = secret parsing, X-Publish-Secret header, and standalone ag_compiled.json without ag_candidates.json', async () => {
        const pArgs = parsePublishArgs([
            '--site', 'http://10.10.20.10:3120',
            '--file', 'data/ag_compiled.json',
            '--secret=sec=with=equals==',
            '--github',
            '--github-branch=ag-snapshot',
            '--github-remote=origin',
            '--snapshot-out=/tmp/snap-test.json'
        ]);
        assert.equal(pArgs.target, 'http://10.10.20.10:3120');
        assert.equal(pArgs.compiled, path.resolve('data/ag_compiled.json'));
        assert.equal(pArgs.secret, 'sec=with=equals==');
        assert.equal(pArgs.githubSync, true);
        assert.equal(pArgs.githubBranch, 'ag-snapshot');
        assert.equal(pArgs.githubRemote, 'origin');
        assert.equal(pArgs.snapshotOut, path.resolve('/tmp/snap-test.json'));

        const aArgs = parseAutoArgs([
            '--site=http://10.10.20.10:3120',
            '--file=data/ag_compiled.json',
            '--secret=my=token==',
            '--github'
        ]);
        assert.equal(aArgs.target, 'http://10.10.20.10:3120');
        assert.equal(aArgs.compiled, path.resolve('data/ag_compiled.json'));
        assert.equal(aArgs.secret, 'my=token==');
        assert.equal(aArgs.githubSync, true);

        // Verify POST /api/agent/publish accepts X-Publish-Secret header and { news, summary, publishedAt } payload
        process.env.PUBLISH_SECRET = 'lan-secret-10=20==';
        const customPublishedAt = '2026-11-07T06:30:00.000Z';
        const resHeaderAuth = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Publish-Secret': 'lan-secret-10=20=='
            },
            body: JSON.stringify({
                publishedAt: customPublishedAt,
                news: [
                    {
                        id: 'lan-push-1',
                        title: 'Router Direct Push Test Article',
                        translatedTitle: '局域网软路由直推测试文章：全球算力网络升级',
                        summary: '本机通过局域网向 10.10.20.10:3120 发起直接推送并触发实时落盘与广播。',
                        url: 'https://www.reuters.com/technology/lan-push-test-2026',
                        region: '国际',
                        category: '科技',
                        source: { name: 'Reuters (路透社)' }
                    }
                ],
                summary: '### 算力基础设施动态\n全球算力网络迎来新一轮架构升级 [NEWS_1]。'
            })
        });
        assert.equal(resHeaderAuth.status, 200);
        const headerAuthBody = await resHeaderAuth.json();
        assert.equal(headerAuthBody.success, true);
        assert.equal(headerAuthBody.displayedCount, 1);
        assert.equal(headerAuthBody.hasSummary, true);
        assert.equal(headerAuthBody.publishedAt, customPublishedAt);
        assert.equal(headerAuthBody.lastUpdated, customPublishedAt);

        // Verify standalone ag_compiled.json publishing when ag_candidates.json is absent
        const missingCandidatesPath = path.join(DATA_DIR, 'non_existent_candidates_999.json');
        if (fs.existsSync(missingCandidatesPath)) {
            fs.unlinkSync(missingCandidatesPath);
        }
        const standaloneCompiledPath = path.join(DATA_DIR, 'ag_compiled.json');
        fs.writeFileSync(standaloneCompiledPath, JSON.stringify({
            publishedAt: '2026-11-07T06:35:00.000Z',
            news: [
                {
                    id: 'standalone-1',
                    title: 'Standalone Compiled Snapshot Item 1',
                    translatedTitle: '独立自包含精编快照条目一：欧洲央行维持关键利率不变',
                    summary: '欧洲央行在最新货币政策会议上决定维持基准利率不变，并继续评估通胀走势。',
                    url: 'https://www.ft.com/content/ecb-rate-2026',
                    region: '欧洲',
                    category: '财经',
                    keyPoints: ['维持基准利率不变', '持续评估核心通胀'],
                    source: { name: 'Financial Times (金融时报)' }
                }
            ],
            summary: {
                title: '2026年全球要闻深度综述（独立快照版）',
                content: '### 欧洲货币政策\n欧洲央行宣布维持基准利率不变 [NEWS_1]。'
            }
        }, null, 2), 'utf8');

        const standaloneRes = await runPublish({
            candidates: missingCandidatesPath,
            file: standaloneCompiledPath,
            site: baseUrl,
            secret: 'lan-secret-10=20=='
        });
        assert.equal(standaloneRes.success, true);
        assert.equal(standaloneRes.displayedCount, 1);
        assert.equal(standaloneRes.publishedAt, '2026-11-07T06:35:00.000Z');
        assert.ok(standaloneRes.summaryArticle.htmlContent.includes('class="news-ref-link"'));
    });

    it('9. GitHub Snapshot Relay Publisher (publishSnapshotToGitHub): commits latest.json to orphan branch ag-snapshot via Git plumbing without touching working tree or HEAD', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-git-plumbing-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const snapOutPath = path.join(tmpRoot, 'exported_latest.json');

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });

            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });

            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# CoreFeed Test Repo\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'initial main commit'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            const mainHeadBefore = execFileSync('git', ['-C', workRepoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

            const snapPayload1 = {
                publishedAt: '2026-11-07T06:40:00.000Z',
                news: [
                    {
                        id: 'gh-snap-1',
                        title: 'Global Clean Energy Investment Hits Record High',
                        translatedTitle: '全球清洁能源年度投资创历史新高',
                        summary: '国际能源署最新报告指出，全球清洁能源与电网基础设施投资规模再创新高。',
                        url: 'https://www.reuters.com/sustainability/clean-energy-2026',
                        region: '国际',
                        category: '能源',
                        source: { name: 'Reuters (路透社)' }
                    }
                ],
                summary: {
                    title: '2026年全球能源要闻综述',
                    content: '### 绿色能源投资\n全球清洁能源与电网基础设施投资创历史新高 [NEWS_1]。'
                }
            };

            const pub1 = publishSnapshotToGitHub(snapPayload1, {
                repoDir: workRepoDir,
                remote: 'origin',
                branch: 'ag-snapshot',
                snapshotOut: snapOutPath
            });
            assert.equal(pub1.success, true);
            assert.equal(pub1.branch, 'ag-snapshot');
            assert.equal(pub1.pushed, true);
            assert.ok(fs.existsSync(snapOutPath), 'snapshotOut file should be written');

            // Publish a second snapshot to verify ag-snapshot stays a 1-commit orphan branch
            const snapPayload2 = {
                ...snapPayload1,
                publishedAt: '2026-11-07T06:45:00.000Z'
            };
            const pub2 = publishSnapshotToGitHub(snapPayload2, {
                repoDir: workRepoDir,
                remote: 'origin',
                branch: 'ag-snapshot'
            });
            assert.equal(pub2.success, true);
            assert.notEqual(pub2.commitSha, pub1.commitSha);

            // Verify working tree and HEAD on main were completely untouched
            const mainHeadAfter = execFileSync('git', ['-C', workRepoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            const currentBranch = execFileSync('git', ['-C', workRepoDir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
            const statusPorcelain = execFileSync('git', ['-C', workRepoDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
            assert.equal(mainHeadAfter, mainHeadBefore, 'HEAD on main must not change');
            assert.equal(currentBranch, 'main', 'Checked-out branch must remain main');
            assert.equal(statusPorcelain, '', 'Working tree must remain 100% clean');

            // Verify remote bare repo has ag-snapshot with exactly 1 orphan commit containing latest.json
            const commitCount = execFileSync('git', ['--git-dir', bareRemoteDir, 'rev-list', '--count', 'refs/heads/ag-snapshot'], { encoding: 'utf8' }).trim();
            assert.equal(commitCount, '1', 'ag-snapshot must be a single-commit orphan branch without history bloat');

            const remoteJsonRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:latest.json'], { encoding: 'utf8' });
            const remoteSnap = JSON.parse(remoteJsonRaw);
            assert.equal(remoteSnap.publishedAt, '2026-11-07T06:45:00.000Z');
            assert.equal(remoteSnap.news.length, 1);
            assert.equal(remoteSnap.news[0].translatedTitle, '全球清洁能源年度投资创历史新高');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('10. Router GitHub Snapshot Puller E2E: POST /api/agent/pull-github, GET /api/agent/sync-status, deduplication guard, force override & ScheduleManager pre-check', async () => {
        const snapshotTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        let mockSnapshotPayload = {
            version: '2.0',
            publishedAt: snapshotTimestamp,
            lastUpdated: snapshotTimestamp,
            publishedBy: 'ag-client-alpha',
            clientId: 'ag-client-alpha',
            news: [
                {
                    id: 'gh-pull-1',
                    title: 'Quantum Communication Link Operational Across European Capitals',
                    translatedTitle: '欧洲多国首都间量子通信骨干链路正式投入运行',
                    summary: '欧洲量子通信基础设施项目宣布跨国光纤量子密钥分发骨干网正式贯通。',
                    url: 'https://www.bbc.com/news/science-quantum-link-2026',
                    region: '欧洲',
                    category: '科技',
                    keyPoints: ['跨国量子通信骨干网贯通', '支持政务与金融高安全传输'],
                    source: { id: 'bbc', name: 'BBC News (英国广播公司)' }
                },
                {
                    id: 'gh-pull-2',
                    title: 'Global Maritime Trade Volume Rises 6.2% in Q3',
                    translatedTitle: '第三季度全球海运贸易总量同比增长6.2%',
                    summary: '港口自动化效率提升与亚欧航线复苏推动全球集装箱吞吐量稳步增长。',
                    url: 'https://www.reuters.com/markets/maritime-trade-q3-2026',
                    region: '国际',
                    category: '财经',
                    keyPoints: ['海运贸易量同比增长6.2%', '亚欧航线集装箱吞吐量回升'],
                    source: { id: 'reuters', name: 'Reuters (路透社)' }
                }
            ],
            summary: {
                title: '2026年全球要闻深度综述（GitHub 快照同步验证）',
                content: '### 科技前沿\n欧洲多国首都间量子通信骨干链路正式投运 [NEWS_1]。\n\n### 全球贸易\n第三季度全球海运贸易总量同比增长6.2% [NEWS_2]。'
            },
            sourceStats: [{ id: 'bbc', name: 'BBC News', count: 2, status: 'ok' }]
        };

        const mockGhServer = http.createServer((req, res) => {
            if (req.url && req.url.startsWith('/alanhsun/CoreFeed/ag-snapshot/latest.json')) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(mockSnapshotPayload));
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
        });

        await new Promise((resolve, reject) => {
            mockGhServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        const ghPort = mockGhServer.address().port;
        const mockSnapshotUrl = `http://127.0.0.1:${ghPort}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

        try {
            process.env.PUBLISH_SECRET = 'router-sync-sec-123';
            process.env.GITHUB_SNAPSHOT_URL = mockSnapshotUrl;
            stateManager.reset();

            // 10a. Unauthorized POST /api/agent/pull-github -> 401
            const resUnauth = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snapshotUrl: mockSnapshotUrl })
            });
            assert.equal(resUnauth.status, 401);

            // 10b. Authorized POST /api/agent/pull-github -> pulls & applies snapshot
            const resPull1 = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Publish-Secret': 'router-sync-sec-123'
                },
                body: JSON.stringify({ snapshotUrl: mockSnapshotUrl })
            });
            assert.equal(resPull1.status, 200);
            const pullBody1 = await resPull1.json();
            assert.equal(pullBody1.success, true);
            assert.equal(pullBody1.updated, true);
            assert.equal(pullBody1.applied, true);
            assert.equal(pullBody1.skipped, false);
            assert.equal(pullBody1.displayedCount, 2);
            assert.equal(pullBody1.hasSummary, true);
            assert.equal(pullBody1.publishedAt, snapshotTimestamp);
            assert.equal(pullBody1.publishedBy, 'ag-client-alpha');

            // Verify router GET /api/news and GET /api/summary reflect pulled snapshot
            const resNews = await fetch(`${baseUrl}/api/news`);
            const newsData = await resNews.json();
            assert.equal(newsData.news.length, 2);
            assert.equal(newsData.news[0].translatedTitle, '欧洲多国首都间量子通信骨干链路正式投入运行');

            const resSum = await fetch(`${baseUrl}/api/summary`);
            const sumData = await resSum.json();
            assert.ok(sumData.article.htmlContent.includes('class="news-ref-link"'));
            assert.ok(sumData.article.htmlContent.includes('https://www.bbc.com/news/science-quantum-link-2026'));

            // Verify disk files match pulled snapshot
            const diskNews = JSON.parse(fs.readFileSync(config.storage.newsFile, 'utf8'));
            assert.equal(diskNews.news.length, 2);

            // 10c. Calling POST /api/agent/pull-github again with force: false and unchanged publishedAt skips re-application
            const resPull2 = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Publish-Secret': 'router-sync-sec-123'
                },
                body: JSON.stringify({ snapshotUrl: mockSnapshotUrl, force: false })
            });
            assert.equal(resPull2.status, 200);
            const pullBody2 = await resPull2.json();
            assert.equal(pullBody2.success, true);
            assert.equal(pullBody2.updated, false);
            assert.equal(pullBody2.applied, false);
            assert.equal(pullBody2.skipped, true);
            assert.equal(pullBody2.reason, 'already-up-to-date');

            // 10d. Calling POST /api/agent/pull-github with force: true re-applies
            const resPullForce = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Publish-Secret': 'router-sync-sec-123'
                },
                body: JSON.stringify({ snapshotUrl: mockSnapshotUrl, force: true })
            });
            assert.equal(resPullForce.status, 200);
            const pullBodyForce = await resPullForce.json();
            assert.equal(pullBodyForce.success, true);
            assert.equal(pullBodyForce.updated, true);
            assert.equal(pullBodyForce.applied, true);

            // 10e. Verify GET /api/agent/sync-status
            const resSyncStatus = await fetch(`${baseUrl}/api/agent/sync-status`);
            assert.equal(resSyncStatus.status, 200);
            const syncStatusBody = await resSyncStatus.json();
            assert.equal(syncStatusBody.success, true);
            assert.equal(syncStatusBody.enabled, true);
            assert.equal(syncStatusBody.intervalMinutes, 60);
            assert.equal(syncStatusBody.lastSyncStatus, 'synced');
            assert.equal(syncStatusBody.lastSyncedPublishedAt, snapshotTimestamp);
            assert.equal(syncStatusBody.lastSyncedPublishedBy, 'ag-client-alpha');
            assert.equal(syncStatusBody.publishedBy, 'ag-client-alpha');

            // 10f. Verify ScheduleManager.executeUpdate() pulls newer GitHub snapshot and skips local patrol
            const newerTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            mockSnapshotPayload = {
                ...mockSnapshotPayload,
                publishedAt: newerTimestamp,
                lastUpdated: newerTimestamp,
                publishedBy: 'cloud-client-test'
            };
            // Set stateManager.lastUpdated to 45 minutes ago so 10-minute/30-minute guard allows executeUpdate() to run
            stateManager.set('lastUpdated', new Date(Date.now() - 45 * 60 * 1000).toISOString(), false);
            await services.scheduleManager.executeUpdate();
            assert.equal(stateManager.get('lastUpdated'), newerTimestamp, 'ScheduleManager.executeUpdate() should apply newer GitHub snapshot');
            assert.equal(stateManager.get('lastPublishedBy'), 'cloud-client-test');
        } finally {
            delete process.env.GITHUB_SNAPSHOT_URL;
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('11. Method 2B Default GitHub Push (pushToGithub=true), --no-github / GITHUB_PUSH_ENABLED=false opt-out & publishedBy / clientId metadata', async () => {
        // 11a. Verify config defaults
        assert.equal(config.githubSync.pushEnabled, true, 'config.githubSync.pushEnabled should default to true');
        assert.equal(config.githubSync.intervalMinutes, 60, 'config.githubSync.intervalMinutes should default to 60');
        assert.equal(config.githubSync.cooldownMinutes, 30, 'config.githubSync.cooldownMinutes should default to 30');
        assert.ok(config.githubSync.clientId && config.githubSync.clientId.length > 0, 'config.githubSync.clientId should have a non-empty default');

        // 11b. Verify CLI default parseArgs in ag-publish.js and ag-auto-update.js
        const defaultPubArgs = parsePublishArgs([]);
        assert.equal(defaultPubArgs.pushToGithub, true);
        assert.equal(defaultPubArgs.githubSync, true);
        assert.equal(defaultPubArgs.github, true);
        assert.ok(defaultPubArgs.clientId.length > 0);

        const defaultAutoArgs = parseAutoArgs([]);
        assert.equal(defaultAutoArgs.pushToGithub, true);
        assert.equal(defaultAutoArgs.githubSync, true);
        assert.equal(defaultAutoArgs.github, true);
        assert.equal(defaultAutoArgs.cooldownMinutes, 30);
        assert.equal(defaultAutoArgs.force, false);
        assert.ok(defaultAutoArgs.clientId.length > 0);

        // 11c. Verify --no-github, --cooldown, --client-id, --force flags & GITHUB_PUSH_ENABLED=false opt-out
        const optOutPubArgs = parsePublishArgs(['--no-github', '--client-id=win-pc-alan']);
        assert.equal(optOutPubArgs.pushToGithub, false);
        assert.equal(optOutPubArgs.githubSync, false);
        assert.equal(optOutPubArgs.github, false);
        assert.equal(optOutPubArgs.clientId, 'win-pc-alan');
        assert.equal(optOutPubArgs.publishedBy, 'win-pc-alan');

        const optOutAutoArgs = parseAutoArgs(['--no-github', '--cooldown=20', '--client-id=mac-alan', '--force']);
        assert.equal(optOutAutoArgs.pushToGithub, false);
        assert.equal(optOutAutoArgs.githubSync, false);
        assert.equal(optOutAutoArgs.github, false);
        assert.equal(optOutAutoArgs.cooldownMinutes, 20);
        assert.equal(optOutAutoArgs.clientId, 'mac-alan');
        assert.equal(optOutAutoArgs.publishedBy, 'mac-alan');
        assert.equal(optOutAutoArgs.force, true);

        process.env.GITHUB_PUSH_ENABLED = 'false';
        try {
            assert.equal(parsePublishArgs([]).pushToGithub, false);
            assert.equal(parseAutoArgs([]).pushToGithub, false);
        } finally {
            delete process.env.GITHUB_PUSH_ENABLED;
        }

        // 11d. Verify runPublish pushes to ag-snapshot by default (without passing github: true) and embeds publishedBy / clientId
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-m2b-default-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const candidatesPath = path.join(DATA_DIR, 'ag_candidates.json');
        const compiledPath = path.join(DATA_DIR, 'ag_compiled.json');

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });
            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            // Write 2 compiled items so candidates + compiled merge cleanly
            const nowIso = new Date().toISOString();
            fs.writeFileSync(compiledPath, JSON.stringify({
                publishedAt: nowIso,
                articles: [
                    {
                        index: 1,
                        id: 'cand-1',
                        translatedTitle: '多客户端默认推送测试标题一',
                        summary: '验证默认开启 Method 2B 自动推送到 GitHub ag-snapshot 分支并记录客户端标识。',
                        region: '国际',
                        category: '科技',
                        keyPoints: ['默认推送ag-snapshot']
                    },
                    {
                        index: 2,
                        id: 'cand-2',
                        translatedTitle: '多客户端默认推送测试标题二',
                        summary: '验证多客户端协同元数据与文章数量统计。',
                        region: '亚洲',
                        category: '财经',
                        keyPoints: ['记录publishedBy元数据']
                    }
                ],
                summaryMarkdown: '### 全球科技与经贸\n多客户端默认推送测试综述 [NEWS_1] [NEWS_2]。'
            }, null, 2), 'utf8');

            const pubDefaultRes = await runPublish({
                candidates: candidatesPath,
                compiled: compiledPath,
                repoDir: workRepoDir,
                localOnly: true,
                clientId: 'test-client-m2b'
            });
            assert.equal(pubDefaultRes.success, true);
            assert.equal(pubDefaultRes.publishedBy, 'test-client-m2b');
            assert.equal(pubDefaultRes.clientId, 'test-client-m2b');
            assert.ok(pubDefaultRes.githubSync, 'runPublish should push to GitHub by default when repoDir is provided');
            assert.equal(pubDefaultRes.githubSync.pushed, true);
            assert.equal(pubDefaultRes.githubSync.publishedBy, 'test-client-m2b');

            const remoteJsonRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:latest.json'], { encoding: 'utf8' });
            const remoteSnap = JSON.parse(remoteJsonRaw);
            assert.equal(remoteSnap.publishedBy, 'test-client-m2b');
            assert.equal(remoteSnap.clientId, 'test-client-m2b');
            assert.ok(remoteSnap.articleCount >= 2);
            assert.ok(remoteSnap.sourceCount >= 1);

            // Verify explicit pushToGithub: false skips GitHub push
            const pubDisabledRes = await runPublish({
                candidates: candidatesPath,
                compiled: compiledPath,
                repoDir: workRepoDir,
                localOnly: true,
                pushToGithub: false
            });
            assert.equal(pubDisabledRes.success, true);
            assert.equal(pubDisabledRes.githubSync, null);
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });

    it('12. Multi-Client Cooldown Coordination (skip harvest & auto-pull when fresh, proceed on --force or expired cooldown) & ETag If-None-Match 304 polling', async () => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-m2b-cooldown-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const tmpCompiledPath = path.join(tmpRoot, 'cooldown_compiled.json');
        const candidatesPath = path.join(DATA_DIR, 'ag_candidates.json');
        const compiledPath = path.join(DATA_DIR, 'ag_compiled.json');

        let currentEtag = '"snap-etag-v1"';
        const ifNoneMatchHeaders = [];
        let mockRemoteSnapshot = {
            version: '2.0',
            publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins ago (within 30m cooldown)
            lastUpdated: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            publishedBy: 'peer-client-windows',
            clientId: 'peer-client-windows',
            news: [
                {
                    id: 'cooldown-news-1',
                    title: 'Peer Client Windows Published Fresh Global Brief',
                    translatedTitle: '其他客户端五分钟前刚发布的全球要闻：跨国清洁能源走廊投运',
                    summary: '由于其他客户端在30分钟冷却窗口内刚完成采集与精编发布，当前客户端直接拉取复用该快照而无需重复采集。',
                    url: 'https://www.reuters.com/world/cooldown-test-2026',
                    region: '国际',
                    category: '能源',
                    keyPoints: ['30分钟冷却窗口防冲突', '自动拉取远端快照同步本地'],
                    source: { id: 'reuters', name: 'Reuters (路透社)' }
                }
            ],
            summary: {
                title: '2026年全球要闻深度综述（多客户端协同复用）',
                content: '### 多客户端协同\n跨国清洁能源走廊正式投运 [NEWS_1]。'
            },
            sourceStats: [{ id: 'reuters', name: 'Reuters', count: 1, status: 'ok' }]
        };

        const mockGhServer = http.createServer((req, res) => {
            if (req.url && req.url.startsWith('/alanhsun/CoreFeed/ag-snapshot/latest.json')) {
                const inm = req.headers['if-none-match'];
                if (inm) {
                    ifNoneMatchHeaders.push(inm);
                }
                if (inm && inm === currentEtag) {
                    res.writeHead(304, { ETag: currentEtag });
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'ETag': currentEtag
                });
                res.end(JSON.stringify(mockRemoteSnapshot));
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
        });

        await new Promise((resolve, reject) => {
            mockGhServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        const ghPort = mockGhServer.address().port;
        const mockSnapshotUrl = `http://127.0.0.1:${ghPort}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });
            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            process.env.PUBLISH_SECRET = 'router-sync-sec-123';

            // 12a. Fresh remote snapshot (5m old < 30m cooldown) -> skips harvest/compile and pulls remote snapshot to local & target server
            const cooldownSyncRes = await runAutoUpdate({
                snapshotUrl: mockSnapshotUrl,
                target: baseUrl,
                secret: 'router-sync-sec-123',
                cooldownMinutes: 30,
                compiled: tmpCompiledPath,
                skipHarvest: false
            });
            assert.equal(cooldownSyncRes.success, true);
            assert.equal(cooldownSyncRes.mode, 'cooldown-remote-sync');
            assert.equal(cooldownSyncRes.skippedHarvest, true);
            assert.equal(cooldownSyncRes.cooldownTriggered, true);
            assert.equal(cooldownSyncRes.publishedBy, 'peer-client-windows');
            assert.equal(cooldownSyncRes.displayedCount, 1);
            assert.equal(cooldownSyncRes.healthVerified, true);
            assert.ok(fs.existsSync(tmpCompiledPath), 'Remote snapshot should be saved to compiled path');

            const resNewsAfterCooldown = await fetch(`${baseUrl}/api/news`);
            const newsAfterCooldown = await resNewsAfterCooldown.json();
            assert.equal(newsAfterCooldown.news.length, 1);
            assert.equal(newsAfterCooldown.news[0].translatedTitle, '其他客户端五分钟前刚发布的全球要闻：跨国清洁能源走廊投运');
            assert.equal(stateManager.get('lastPublishedBy'), 'peer-client-windows');

            // 12b. --force bypasses the 30m cooldown and publishes with override-client metadata
            const forceRes = await runAutoUpdate({
                snapshotUrl: mockSnapshotUrl,
                candidates: candidatesPath,
                compiled: compiledPath,
                skipHarvest: true,
                useExistingCompiled: true,
                force: true,
                clientId: 'override-client',
                repoDir: workRepoDir,
                localOnly: true
            });
            assert.equal(forceRes.success, true);
            assert.equal(forceRes.mode, 'existing-compiled');
            assert.equal(forceRes.cooldownTriggered, false);
            assert.equal(forceRes.publishedBy, 'override-client');
            assert.ok(forceRes.githubSync?.pushed);

            const forcedRemoteRaw = execFileSync('git', ['--git-dir', bareRemoteDir, 'show', 'refs/heads/ag-snapshot:latest.json'], { encoding: 'utf8' });
            const forcedRemoteSnap = JSON.parse(forcedRemoteRaw);
            assert.equal(forcedRemoteSnap.publishedBy, 'override-client');

            // 12c. Expired remote snapshot (45m old > 30m cooldown) returns inCooldown === false
            mockRemoteSnapshot = {
                ...mockRemoteSnapshot,
                publishedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
                lastUpdated: new Date(Date.now() - 45 * 60 * 1000).toISOString()
            };
            const expiredCheck = await checkRemoteSnapshotCooldown({
                snapshotUrl: mockSnapshotUrl,
                cooldownMinutes: 30
            });
            assert.equal(expiredCheck.inCooldown, false);
            assert.equal(expiredCheck.reason, 'cooldown-expired');
            assert.ok(expiredCheck.ageMinutes >= 44);

            // 12d. ETag If-None-Match -> 304 Not Modified fast polling in GitHubSyncManager
            currentEtag = '"snap-etag-v2"';
            const freshEtagTs = new Date(Date.now() - 1 * 60 * 1000).toISOString();
            mockRemoteSnapshot = {
                ...mockRemoteSnapshot,
                publishedAt: freshEtagTs,
                lastUpdated: freshEtagTs,
                publishedBy: 'etag-publisher-client'
            };

            const firstPull = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: true
            });
            assert.equal(firstPull.applied, true);
            assert.equal(firstPull.etag, '"snap-etag-v2"');
            assert.equal(firstPull.publishedBy, 'etag-publisher-client');

            ifNoneMatchHeaders.length = 0;
            const secondPull304 = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: false
            });
            assert.ok(ifNoneMatchHeaders.includes('"snap-etag-v2"'), 'Second poll must send If-None-Match header');
            assert.equal(secondPull304.success, true);
            assert.equal(secondPull304.applied, false);
            assert.equal(secondPull304.skipped, true);
            assert.equal(secondPull304.notModified, true);
            assert.equal(secondPull304.reason, 'already-up-to-date');
        } finally {
            fs.rmSync(tmpRoot, { recursive: true, force: true });
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('13. Purified Frontend UI SSR (GET /), GET/POST /api/config persistence, and Web UI one-click POST /api/agent/pull-github', async () => {
        const mockUiSnapshot = {
            version: '2.0',
            publishedAt: new Date().toISOString(),
            lastUpdated: new Date().toISOString(),
            publishedBy: 'ui-sync-publisher',
            clientId: 'ui-sync-publisher',
            news: [
                {
                    id: 'ui-sync-news-1',
                    title: 'Web UI One-Click GitHub Snapshot Sync Verification',
                    translatedTitle: '前端一键同步最新快照测试：多客户端快照中枢秒级载入',
                    summary: '通过顶部「同步最新」按钮，无需填写外部 API Key 即可直接从 ag-snapshot/latest.json 同步最新精编内容。',
                    url: 'https://www.bbc.com/news/ui-sync-test-2026',
                    region: '国际',
                    category: '科技',
                    keyPoints: ['支持一键同步最新快照', '极简纸媒阅读体验'],
                    source: { id: 'bbc', name: 'BBC News' }
                }
            ],
            summary: {
                title: '2026年全球要闻深度综述（Web UI 同步验证）',
                content: '### 全球科技动态\n多客户端快照中枢秒级载入 [NEWS_1]。'
            },
            sourceStats: [{ id: 'bbc', name: 'BBC News', count: 1, status: 'ok' }]
        };

        const mockUiGhServer = http.createServer((req, res) => {
            if (req.url && req.url.startsWith('/alanhsun/CoreFeed/ag-snapshot/latest.json')) {
                res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"ui-etag-1"' });
                res.end(JSON.stringify(mockUiSnapshot));
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
        });

        await new Promise((resolve, reject) => {
            mockUiGhServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        const uiGhPort = mockUiGhServer.address().port;
        const mockUiSnapshotUrl = `http://127.0.0.1:${uiGhPort}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

        try {
            // 13a. Verify GET / SSR HTML conforms to the purified, restrained editorial UI contract
            stateManager.set('lastPublishedBy', 'antigravity-cloud-vm', false);
            const resHome = await fetch(`${baseUrl}/`);
            assert.equal(resHome.status, 200);
            const html = await resHome.text();

            // (a) Presence of purified masthead, restrained action buttons, and simplified settings modal
            assert.ok(html.includes('CoreFeed'), 'SSR HTML should contain CoreFeed brand title');
            assert.ok(html.includes('全球要闻深度聚合'), 'SSR HTML should contain editorial subtitle "全球要闻深度聚合"');
            assert.ok(html.includes('id="lastUpdateTime"'), 'SSR HTML should contain #lastUpdateTime in masthead');
            assert.ok(html.includes('更新于'), 'SSR HTML should display "更新于" timestamp prefix');
            assert.ok(html.includes('id="syncGithubBtn"'), 'SSR HTML should contain #syncGithubBtn');
            assert.ok(html.includes('同步最新'), 'SSR HTML should contain restrained "同步最新" button label');
            assert.ok(html.includes('id="btnSettings"'), 'SSR HTML should contain #btnSettings button');
            assert.ok(html.includes('设置'), 'SSR HTML should contain "设置" button label');
            assert.ok(html.includes('id="settingsModal"'), 'SSR HTML should contain #settingsModal');
            assert.ok(!html.includes('id="cfgGithubSyncEnabled"'), 'SSR HTML must NOT contain removed #cfgGithubSyncEnabled option');
            assert.ok(!html.includes('id="cfgGithubSyncInterval"'), 'SSR HTML must NOT contain removed #cfgGithubSyncInterval option');
            assert.ok(html.includes('id="cfgAutoUpdateEnabled"'), 'SSR HTML should contain #cfgAutoUpdateEnabled');
            assert.ok(html.includes('id="cfgUpdateTimes"'), 'SSR HTML should contain #cfgUpdateTimes');
            assert.ok(html.includes('id="modalSyncStatusText"'), 'SSR HTML should contain concise sync status display #modalSyncStatusText');
            assert.ok(html.includes('id="btnSaveSettings"'), 'SSR HTML should contain #btnSaveSettings');
            assert.ok(html.includes('id="heroCarousel"'), 'SSR HTML should render #heroCarousel for Top-3 news items');
            assert.ok(html.includes('hero-carousel-slide'), 'SSR HTML should render .hero-carousel-slide inside #heroCarousel');

            // (b) Absence of removed cluttered buttons, engineering badges, status bars, and low-level modal inputs
            assert.ok(!html.includes('立即采集全球新闻'), 'SSR HTML must NOT contain removed manual harvest button "立即采集全球新闻"');
            assert.ok(!html.includes('id="btnRunPatrol"'), 'SSR HTML must NOT contain #btnRunPatrol');
            assert.ok(!html.includes('重新生成综述'), 'SSR HTML must NOT contain "重新生成综述"');
            assert.ok(!html.includes('生成今日综述'), 'SSR HTML must NOT contain "生成今日综述"');
            assert.ok(!html.includes('生成 / 刷新今日综述'), 'SSR HTML must NOT contain "生成 / 刷新今日综述"');
            assert.ok(!html.includes('id="btnGenSummary"'), 'SSR HTML must NOT contain #btnGenSummary');
            assert.ok(!html.includes('30 大权威信源'), 'SSR HTML must NOT contain cluttered badge "30 大权威信源"');
            assert.ok(!html.includes('48h 时效过滤'), 'SSR HTML must NOT contain cluttered badge "48h 时效过滤"');
            assert.ok(!html.includes('AI 去重精译'), 'SSR HTML must NOT contain cluttered badge "AI 去重精译"');
            assert.ok(!html.includes('id="githubSyncHeaderBadge"'), 'SSR HTML must NOT contain #githubSyncHeaderBadge');
            assert.ok(!html.includes('id="publisherHeaderBadge"'), 'SSR HTML must NOT contain #publisherHeaderBadge');
            assert.ok(!html.includes('发布端:'), 'SSR HTML must NOT contain "发布端:" engineering badge');
            assert.ok(!html.includes('发布端：'), 'SSR HTML must NOT contain "发布端：" status bar label');
            assert.ok(!html.includes('流水线状态：'), 'SSR HTML must NOT contain "流水线状态："');
            assert.ok(!html.includes('候选池'), 'SSR HTML must NOT contain "候选池"');
            assert.ok(!html.includes('信源巡检'), 'SSR HTML must NOT contain "信源巡检"');
            assert.ok(!html.includes('展开实时采集日志'), 'SSR HTML must NOT contain "展开实时采集日志"');
            assert.ok(!html.includes('id="optionalAiConfigDetails"'), 'SSR HTML must NOT contain #optionalAiConfigDetails');
            assert.ok(!html.includes('id="cfgAiApiKey"'), 'SSR HTML must NOT contain #cfgAiApiKey');
            assert.ok(!html.includes('id="cfgAiBaseUrl"'), 'SSR HTML must NOT contain #cfgAiBaseUrl');
            assert.ok(!html.includes('id="cfgAiModel"'), 'SSR HTML must NOT contain #cfgAiModel');
            assert.ok(!html.includes('id="cfgClientId"'), 'SSR HTML must NOT contain #cfgClientId');
            assert.ok(!html.includes('id="cfgGithubSnapshotUrl"'), 'SSR HTML must NOT contain #cfgGithubSnapshotUrl');
            assert.ok(!html.includes('id="cfgGithubPushEnabled"'), 'SSR HTML must NOT contain #cfgGithubPushEnabled');
            assert.ok(!html.includes('id="cfgMaxCurated"'), 'SSR HTML must NOT contain #cfgMaxCurated');
            assert.ok(!html.includes('id="cfgDeepReadCount"'), 'SSR HTML must NOT contain #cfgDeepReadCount');
            assert.ok(!html.includes('id="cfgFreshnessHours"'), 'SSR HTML must NOT contain #cfgFreshnessHours');

            // (c) Verify v2.5.4 cache busting, Deep-Read removal, Bento Grid span class purity (no md:col-span-2 override), editorial keypoints, and CSS Grid min-width: 0 locks
            assert.ok(html.includes('/css/style.css?v=2.5.4'), 'SSR HTML should include cache-busted /css/style.css?v=2.5.4');
            assert.ok(html.includes('/js/main.js?v=2.5.4'), 'SSR HTML should include cache-busted /js/main.js?v=2.5.4');
            assert.ok(!html.includes('md:col-span-2'), 'SSR HTML must NOT include Tailwind md:col-span-2 that overrides .bento-span-* on desktop');
            assert.ok(!html.includes('全文深读'), 'SSR HTML must NOT contain removed "全文深读" button');
            assert.ok(!html.includes('btn-read-more'), 'SSR HTML must NOT contain .btn-read-more');
            assert.ok(!html.includes('deepReadModal'), 'SSR HTML must NOT contain #deepReadModal');
            assert.ok(!html.includes('articleModal'), 'SSR HTML must NOT contain #articleModal');
            assert.ok(!html.includes('openDeepRead'), 'SSR HTML must NOT contain openDeepRead handler');
            assert.ok(html.includes('card-timestamp'), 'SSR HTML .card-footer should retain .card-timestamp');
            assert.ok(html.includes('btn-source-link'), 'SSR HTML .card-footer should retain .btn-source-link');
            assert.ok(html.includes('card-keypoints'), 'SSR HTML should render keypoints inside .card-keypoints');
            assert.ok(html.includes('card-keypoint-item'), 'SSR HTML should render keypoint items with .card-keypoint-item');

            const mainJsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
            assert.ok(!mainJsSource.includes('md:col-span-2'), 'public/js/main.js must NOT include md:col-span-2');
            assert.ok(!mainJsSource.includes('openDeepRead'), 'public/js/main.js must NOT include openDeepRead');
            assert.ok(!mainJsSource.includes('closeDeepReadModal'), 'public/js/main.js must NOT include closeDeepReadModal');
            assert.ok(!mainJsSource.includes('btn-read-more'), 'public/js/main.js must NOT include btn-read-more');
            assert.ok(!mainJsSource.includes('/api/agent/deep-read'), 'public/js/main.js must NOT reference /api/agent/deep-read');
            assert.ok(mainJsSource.includes('card-timestamp'), 'public/js/main.js should render .card-timestamp');
            assert.ok(mainJsSource.includes('btn-source-link'), 'public/js/main.js should render .btn-source-link');
            assert.ok(mainJsSource.includes('card-keypoints'), 'public/js/main.js should render .card-keypoints');
            assert.ok(mainJsSource.includes('card-keypoint-item'), 'public/js/main.js should render .card-keypoint-item');

            const styleCssSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
            assert.ok(!styleCssSource.includes('.btn-read-more'), 'public/css/style.css must NOT define .btn-read-more');
            assert.ok(!styleCssSource.includes('.taste-drawer-surface'), 'public/css/style.css must NOT define .taste-drawer-surface');
            assert.ok(
                styleCssSource.includes('minmax(0, 1.08fr) minmax(0, 0.92fr)'),
                'public/css/style.css should lock .lead-bento-inner.has-media columns with minmax(0, 1.08fr) minmax(0, 0.92fr)'
            );
            assert.ok(
                styleCssSource.includes('aspect-ratio: 16 / 9;'),
                'public/css/style.css should lock .card-cover to unified 16:9 aspect ratio'
            );
            assert.ok(
                styleCssSource.includes('object-position: center 22%;'),
                'public/css/style.css should set upper-third object-position on .card-cover-img'
            );
            assert.ok(
                !styleCssSource.includes('height: 196px;') && !styleCssSource.includes('height: 168px;'),
                'public/css/style.css must NOT use fixed pixel heights that distort image proportions'
            );
            assert.ok(styleCssSource.includes('min-width: 0;'), 'public/css/style.css should include min-width: 0 defensive locks');
            assert.ok(styleCssSource.includes('.card-keypoints'), 'public/css/style.css should define .card-keypoints');
            assert.ok(styleCssSource.includes('.card-keypoint-item'), 'public/css/style.css should define .card-keypoint-item');
            assert.ok(!styleCssSource.includes('Instrument Serif') && !styleCssSource.includes('Plus Jakarta Sans'), 'public/css/style.css must NOT use banned fonts Instrument Serif or Plus Jakarta Sans');
            assert.ok(styleCssSource.includes('Newsreader') && styleCssSource.includes('Geist'), 'public/css/style.css should pair Newsreader display with Geist sans');
            assert.ok(!html.includes('DISPATCH // 01') && !mainJsSource.includes('DISPATCH // 01'), 'SSR and client markup must NOT render pseudo-technical DISPATCH // 01 eyebrow');
            assert.ok(!html.includes('kami-edition-dot'), 'SSR HTML must NOT render decorative status dot');
            assert.ok(styleCssSource.includes('--t-body:            1rem;') && styleCssSource.includes('font-size: var(--t-body);'), 'public/css/style.css should render .card-summary at 16px (1rem) in ink');

            // 13b. Verify GET /api/config exposes Method 2B and schedule fields
            const resGetCfg = await fetch(`${baseUrl}/api/config`);
            assert.equal(resGetCfg.status, 200);
            const getCfgData = await resGetCfg.json();
            assert.equal(getCfgData.success, true);
            assert.equal(typeof getCfgData.config.GITHUB_SYNC_ENABLED, 'boolean');
            assert.equal(typeof getCfgData.config.GITHUB_PUSH_ENABLED, 'boolean');
            assert.equal(typeof getCfgData.config.GITHUB_SYNC_INTERVAL_MINUTES, 'number');
            assert.ok(getCfgData.config.CLIENT_ID);
            assert.equal(getCfgData.config.lastPublishedBy, 'antigravity-cloud-vm');
            assert.ok(getCfgData.config.githubSync);
            assert.ok(getCfgData.config.schedule);

            // 13c. Verify POST /api/config saves both full backward-compatible payloads and the simplified 4-field modal payload without wiping existing settings
            process.env.AI_API_KEY = 'sk-existing-secret-preserve';
            config.reload();

            const resPostCfg = await fetch(`${baseUrl}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    GITHUB_SYNC_ENABLED: true,
                    GITHUB_PUSH_ENABLED: false,
                    GITHUB_SYNC_INTERVAL_MINUTES: 45,
                    CLIENT_ID: 'router-10-10-20-10',
                    GITHUB_SNAPSHOT_URL: mockUiSnapshotUrl,
                    AUTO_UPDATE_ENABLED: true,
                    UPDATE_TIMES: '07:30,12:00,20:00',
                    AI_API_KEY: '',
                    AI_BASE_URL: ''
                })
            });
            assert.equal(resPostCfg.status, 200);
            const postCfgData = await resPostCfg.json();
            assert.equal(postCfgData.success, true);
            assert.equal(postCfgData.config.GITHUB_SYNC_ENABLED, true);
            assert.equal(postCfgData.config.GITHUB_PUSH_ENABLED, false);
            assert.equal(postCfgData.config.GITHUB_SYNC_INTERVAL_MINUTES, 45);
            assert.equal(postCfgData.config.CLIENT_ID, 'router-10-10-20-10');
            assert.equal(postCfgData.config.UPDATE_TIMES, '07:30,12:00,20:00');
            assert.equal(postCfgData.config.AUTO_UPDATE_ENABLED, true);
            assert.equal(postCfgData.config.ai.apiKeyConfigured, true, 'Empty AI_API_KEY in POST /api/config must not erase existing configured key');

            // Also verify the simplified modal's 4-key payload preserves CLIENT_ID, GITHUB_PUSH_ENABLED, and GITHUB_SNAPSHOT_URL
            const resPostModalCfg = await fetch(`${baseUrl}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    GITHUB_SYNC_ENABLED: true,
                    GITHUB_SYNC_INTERVAL_MINUTES: 60,
                    AUTO_UPDATE_ENABLED: true,
                    UPDATE_TIMES: '08:00,12:30,19:30'
                })
            });
            assert.equal(resPostModalCfg.status, 200);
            const postModalCfgData = await resPostModalCfg.json();
            assert.equal(postModalCfgData.success, true);
            assert.equal(postModalCfgData.config.GITHUB_SYNC_INTERVAL_MINUTES, 60);
            assert.equal(postModalCfgData.config.UPDATE_TIMES, '08:00,12:30,19:30');
            assert.equal(postModalCfgData.config.GITHUB_PUSH_ENABLED, false, '4-key modal save must preserve existing GITHUB_PUSH_ENABLED');
            assert.equal(postModalCfgData.config.CLIENT_ID, 'router-10-10-20-10', '4-key modal save must preserve existing CLIENT_ID');

            const savedOnDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'));
            assert.equal(savedOnDisk.GITHUB_SYNC_INTERVAL_MINUTES, 60);
            assert.equal(savedOnDisk.GITHUB_PUSH_ENABLED, false);
            assert.equal(savedOnDisk.CLIENT_ID, 'router-10-10-20-10');
            assert.equal(savedOnDisk.UPDATE_TIMES, '08:00,12:30,19:30');

            // 13d. Verify Web UI one-click POST /api/agent/pull-github works seamlessly even when PUBLISH_SECRET is set
            process.env.PUBLISH_SECRET = 'router-ui-secret-999';
            const resUiPull = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'CoreFeed-WebUI'
                },
                body: JSON.stringify({
                    force: true,
                    trigger: 'ui'
                })
            });
            assert.equal(resUiPull.status, 200);
            const uiPullData = await resUiPull.json();
            assert.equal(uiPullData.success, true);
            assert.equal(uiPullData.applied, true);
            assert.equal(uiPullData.publishedBy, 'ui-sync-publisher');
            assert.equal(uiPullData.displayedCount, 1);

            const resStatusAfterUiPull = await fetch(`${baseUrl}/api/status`);
            const statusAfterUiPull = await resStatusAfterUiPull.json();
            assert.equal(statusAfterUiPull.lastPublishedBy, 'ui-sync-publisher');
            assert.equal(statusAfterUiPull.githubSync.lastPublishedBy, 'ui-sync-publisher');
        } finally {
            services.scheduleManager.stop();
            delete process.env.AI_API_KEY;
            await new Promise((resolve) => mockUiGhServer.close(() => resolve()));
        }
    });

    it('14. Plan 2B Router Protection: ScheduleManager never falls back to local RSS patrol when GitHub snapshot is older than cooldown, and GitHubSyncManager overwrites polluted/newer local English RSS state', async () => {
        const threeHoursAgoIso = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
        let mockServerFail = false;
        const mockSnapshotEtag = '"router-protect-etag-1"';
        const mockChineseSnapshot = {
            version: '2.0',
            publishedAt: threeHoursAgoIso,
            lastUpdated: threeHoursAgoIso,
            publishedBy: 'antigravity-cloud-vm',
            clientId: 'antigravity-cloud-vm',
            news: [
                {
                    id: 'zh-snap-1',
                    title: 'European Central Bank Announces New Cross-Border Payment Framework',
                    translatedTitle: '欧洲央行宣布启动新一代跨境数字支付结算框架',
                    summary: '欧洲央行正式发布新一代跨境实时清算标准，旨在降低欧元区与亚太市场间的跨境汇兑成本。',
                    url: 'https://www.reuters.com/markets/ecb-payment-framework-2026',
                    region: '欧洲',
                    category: '财经',
                    keyPoints: ['欧洲央行发布跨境清算新标准', '大幅降低跨国汇兑与结算成本'],
                    aiCompiled: true,
                    source: { id: 'reuters', name: 'Reuters (路透社)' }
                }
            ],
            summary: {
                title: '2026年11月9日 全球要闻深度综述（路由器防回退测试）',
                content: '### 全球财经\n欧洲央行宣布启动新一代跨境数字支付结算框架 [NEWS_1]。'
            },
            sourceStats: [{ id: 'reuters', name: 'Reuters', count: 1, status: 'ok' }]
        };

        const mockGhServer = http.createServer((req, res) => {
            if (mockServerFail) {
                res.writeHead(500);
                res.end('Internal Server Error');
                return;
            }
            if (req.url && req.url.startsWith('/alanhsun/CoreFeed/ag-snapshot/latest.json')) {
                const inm = req.headers['if-none-match'];
                if (inm && inm === mockSnapshotEtag) {
                    res.writeHead(304, { ETag: mockSnapshotEtag });
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    ETag: mockSnapshotEtag
                });
                res.end(JSON.stringify(mockChineseSnapshot));
                return;
            }
            res.writeHead(404);
            res.end('Not Found');
        });

        await new Promise((resolve, reject) => {
            mockGhServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        const ghPort = mockGhServer.address().port;
        const mockSnapshotUrl = `http://127.0.0.1:${ghPort}/alanhsun/CoreFeed/ag-snapshot/latest.json`;

        const originalRunPatrol = services.newsAgentService.runGlobalPatrolPipeline;
        let patrolCallCount = 0;
        services.newsAgentService.runGlobalPatrolPipeline = async (...args) => {
            patrolCallCount += 1;
            return originalRunPatrol.apply(services.newsAgentService, args);
        };

        try {
            process.env.GITHUB_SNAPSHOT_URL = mockSnapshotUrl;
            process.env.PUBLISH_SECRET = 'router-protect-sec';

            // Initial sync so local state holds the 3-hour-old Chinese snapshot and ETag is cached
            const initialPull = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: true,
                trigger: 'startup'
            });
            assert.equal(initialPull.applied, true);
            assert.equal(stateManager.get('lastUpdated'), threeHoursAgoIso);
            assert.equal(stateManager.get('lastSnapshotPublishedAt'), threeHoursAgoIso);
            assert.equal(isLocalNewsPolluted(stateManager.get('newsData')), false);

            // 14a. Remote snapshot is 3 hours old (> 30m cooldown) and already synced -> ScheduleManager.executeUpdate() MUST NOT call runGlobalPatrolPipeline()
            await services.scheduleManager.executeUpdate();
            assert.equal(
                patrolCallCount,
                0,
                'ScheduleManager.executeUpdate() must NEVER fall back to runGlobalPatrolPipeline() when remote snapshot is older than 30m cooldown'
            );
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架',
                'Existing Chinese news must remain intact when remote snapshot has not changed'
            );

            // Also verify when remote GitHub server is unreachable (500): ScheduleManager.executeUpdate() still never falls back to local RSS patrol
            mockServerFail = true;
            await services.scheduleManager.executeUpdate();
            assert.equal(
                patrolCallCount,
                0,
                'ScheduleManager.executeUpdate() must NEVER fall back to runGlobalPatrolPipeline() when GitHub snapshot fetch fails'
            );
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架'
            );
            mockServerFail = false;

            // 14b. Simulate router 19:30 local English RSS pollution (newer lastUpdated > remotePublishedAt, untranslated English title, ETag cached)
            const newerPollutedIso = new Date().toISOString();
            stateManager.updateNewsData(
                [
                    {
                        id: 'en-polluted-1',
                        title: 'Breaking English RSS News Without Translation',
                        translatedTitle: 'Breaking English RSS News Without Translation',
                        summary: 'Raw English RSS summary scraped locally without AI key',
                        aiCompiled: false
                    }
                ],
                null,
                newerPollutedIso
            );
            assert.equal(isLocalNewsPolluted(stateManager.get('newsData')), true);
            assert.ok(
                new Date(stateManager.get('lastUpdated')).getTime() > new Date(threeHoursAgoIso).getTime(),
                'Polluted local state has a newer lastUpdated timestamp than the 3h-old GitHub snapshot'
            );

            // Calling pullAndApply({ force: false }) (or scheduleManager.executeUpdate()) must bypass 304 ETag and timestamp lockout and heal the state
            const healRes = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: false,
                trigger: 'schedule'
            });
            assert.equal(healRes.applied, true, 'pullAndApply({ force: false }) must overwrite polluted English RSS state even when localLastUpdated > remotePublishedAt');
            assert.equal(healRes.skipped, false);
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架',
                'Chinese GitHub snapshot headline must be restored after healing'
            );
            assert.equal(stateManager.get('lastUpdated'), threeHoursAgoIso);
            assert.equal(stateManager.get('lastSnapshotPublishedAt'), threeHoursAgoIso);

            // 14c. When remotePublishedAt !== lastSnapshotPublishedAt even if stateManager.lastUpdated is newer than remotePublishedAt, pullAndApply({ force: false }) overwrites
            stateManager.set('lastUpdated', new Date(Date.now() + 60 * 1000).toISOString(), false);
            stateManager.set('lastSnapshotPublishedAt', new Date(Date.now() - 6 * 3600 * 1000).toISOString(), false);
            const divergedRes = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: false,
                trigger: 'periodic'
            });
            assert.equal(divergedRes.applied, true, 'pullAndApply({ force: false }) must overwrite when lastSnapshotPublishedAt !== remotePublishedAt');
            assert.equal(stateManager.get('lastSnapshotPublishedAt'), threeHoursAgoIso);

            // 14d. Calling POST /api/agent/pull-github without force (e.g. Web UI "同步最新" button) defaults to force: true and always overwrites
            const resWebUiDefault = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'CoreFeed-WebUI'
                },
                body: JSON.stringify({
                    trigger: 'ui'
                })
            });
            assert.equal(resWebUiDefault.status, 200);
            const webUiDefaultBody = await resWebUiDefault.json();
            assert.equal(webUiDefaultBody.success, true);
            assert.equal(webUiDefaultBody.applied, true, 'POST /api/agent/pull-github without explicit force: false must default to force: true and apply');
            assert.equal(webUiDefaultBody.skipped, false);
        } finally {
            services.newsAgentService.runGlobalPatrolPipeline = originalRunPatrol;
            delete process.env.GITHUB_SNAPSHOT_URL;
            delete process.env.PUBLISH_SECRET;
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('15. Unattended Chinese compilation contract (100% Chinese titles/summaries/keyPoints/briefing) & ag:daemon / ag:status schedule support', async () => {
        // 15a. Verify package.json and ecosystem.config.js expose daemon & status scripts
        const pkgJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
        assert.ok(pkgJson.scripts['ag:daemon'], 'package.json must define ag:daemon script');
        assert.ok(pkgJson.scripts['ag:status'], 'package.json must define ag:status script');
        assert.ok(pkgJson.scripts['ag:daemon:status'], 'package.json must define ag:daemon:status script');
        assert.ok(pkgJson.scripts['ag:schedule'], 'package.json must define ag:schedule script');
        assert.ok(pkgJson.scripts['ag:schedule:remove'], 'package.json must define ag:schedule:remove script');
        assert.ok(pkgJson.scripts['pm2:daemon'], 'package.json must define pm2:daemon script');
        assert.ok(pkgJson.scripts['ag:daemon'].includes('ag-auto-update.js') && pkgJson.scripts['ag:daemon'].includes('--daemon'));
        assert.ok(pkgJson.scripts['ag:status'].includes('ag-auto-update.js') && pkgJson.scripts['ag:status'].includes('--status'));

        const ecosystemConfig = require('../ecosystem.config.js');
        assert.ok(Array.isArray(ecosystemConfig.apps), 'ecosystem.config.js must export apps array');
        const daemonApp = ecosystemConfig.apps.find(a => a.name === 'corefeed-ag-daemon');
        assert.ok(daemonApp, 'ecosystem.config.js should include corefeed-ag-daemon app');
        assert.ok(String(daemonApp.script).includes('ag-auto-update.js'));
        assert.equal(daemonApp.env.AG_UPDATE_TIMES, '07:40,12:10,19:10');

        // 15b. Verify parseAutoArgs(--daemon / --status / --times), getNextExecutionTime, getLastExecutionTime, and getDaemonStatus (20m pre-fetch: 07:40, 12:10, 19:10)
        const daemonArgs = parseAutoArgs(['--daemon', '--client-id=daemon-test-node', '--times=07:40,12:10,19:10']);
        assert.equal(daemonArgs.daemon, true);
        assert.equal(daemonArgs.clientId, 'daemon-test-node');
        assert.deepEqual(daemonArgs.scheduleTimes, ['07:40', '12:10', '19:10']);

        const statusArgs = parseAutoArgs(['--status']);
        assert.equal(statusArgs.status, true);

        assert.equal(typeof getNextExecutionTime, 'function');
        const nextIso = getNextExecutionTime();
        const nextDate = new Date(nextIso);
        assert.ok(!isNaN(nextDate.getTime()) && nextDate.getTime() > Date.now(), 'getNextExecutionTime must return a future ISO date');
        const utcHm = `${String(nextDate.getUTCHours()).padStart(2, '0')}:${String(nextDate.getUTCMinutes()).padStart(2, '0')}`;
        assert.ok(['23:40', '04:10', '11:10'].includes(utcHm), `UTC time ${utcHm} must match 07:40, 12:10, or 19:10 Asia/Shanghai`);

        assert.equal(typeof getLastExecutionTime, 'function');
        const lastIso = getLastExecutionTime();
        const lastDate = new Date(lastIso);
        assert.ok(!isNaN(lastDate.getTime()) && lastDate.getTime() <= Date.now(), 'getLastExecutionTime must return a past/present ISO date');
        const lastUtcHm = `${String(lastDate.getUTCHours()).padStart(2, '0')}:${String(lastDate.getUTCMinutes()).padStart(2, '0')}`;
        assert.ok(['23:40', '04:10', '11:10'].includes(lastUtcHm), `Last UTC time ${lastUtcHm} must match 07:40, 12:10, or 19:10 Asia/Shanghai`);

        assert.equal(typeof getDaemonStatus, 'function');
        const dStatus = getDaemonStatus({ clientId: 'daemon-test-node' });
        assert.deepEqual(dStatus.scheduleTimes, ['07:40', '12:10', '19:10']);
        assert.equal(dStatus.timezone, 'Asia/Shanghai');
        assert.ok(dStatus.nextExecution, 'getDaemonStatus must report nextExecution');
        assert.ok(dStatus.nextExecutionShanghai && dStatus.nextExecutionShanghai.includes('Asia/Shanghai'));
        assert.ok(['07:40', '12:10', '19:10'].includes(dStatus.nextTimeSlot), `nextTimeSlot (${dStatus.nextTimeSlot}) must be one of 07:40, 12:10, 19:10`);
        assert.ok(['07:40', '12:10', '19:10'].includes(dStatus.lastScheduledSlot), `lastScheduledSlot (${dStatus.lastScheduledSlot}) must be one of 07:40, 12:10, 19:10`);
        assert.deepEqual(dStatus.cronExpressions.Asia_Shanghai, ['40 7 * * *', '10 12 * * *', '10 19 * * *']);
        assert.deepEqual(dStatus.cronExpressions.UTC, ['40 23 * * *', '10 4 * * *', '10 11 * * *']);

        // Verify cross-platform setup-schedule.js plan & dry-run installer
        const winPlan = buildSchedulePlan({ platform: 'win32', clientId: 'win-test', times: ['07:40', '12:10', '19:10'] });
        assert.equal(winPlan.windowsTasks.length, 3);
        assert.equal(winPlan.windowsTasks[0].taskName, 'CoreFeed_AutoUpdate_0740');
        assert.ok(winPlan.windowsTasks[0].psEnhanceCmd.includes('-StartWhenAvailable'));
        const dryRes = installSchedule({ dryRun: true, clientId: 'dry-test' });
        assert.equal(dryRes.success, true);
        assert.deepEqual(dryRes.scheduleTimes, ['07:40', '12:10', '19:10']);

        // 15c. Verify unattended runAutoUpdate compiles raw English candidates into 100% pure Chinese articles + briefing and pushes to ag-snapshot
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-unattended-zh-'));
        const bareRemoteDir = path.join(tmpRoot, 'remote.git');
        const workRepoDir = path.join(tmpRoot, 'work');
        const candidatesPath = path.join(tmpRoot, 'ag_candidates.json');
        const compiledPath = path.join(tmpRoot, 'ag_compiled.json');
        const nowIso = new Date().toISOString();

        try {
            fs.mkdirSync(bareRemoteDir, { recursive: true });
            fs.mkdirSync(workRepoDir, { recursive: true });
            execFileSync('git', ['init', '--bare', bareRemoteDir], { stdio: 'ignore' });
            execFileSync('git', ['init', workRepoDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.name', 'Test User'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'remote', 'add', 'origin', bareRemoteDir], { stdio: 'ignore' });
            fs.writeFileSync(path.join(workRepoDir, 'README.md'), '# Test\n', 'utf8');
            execFileSync('git', ['-C', workRepoDir, 'add', 'README.md'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
            execFileSync('git', ['-C', workRepoDir, 'branch', '-M', 'main'], { stdio: 'ignore' });

            const englishCandidates = [
                {
                    id: 'en-cand-1',
                    title: 'Federal Reserve Signals Steady Interest Rate Policy Amid Global Trade Shifts',
                    description: 'Central bank policymakers emphasized data-dependent monetary policy decisions while inflation moderates across major economies.',
                    content: 'Federal Reserve officials indicated on Monday that interest rates will remain steady as inflation continues to cool and global supply chains stabilize.',
                    url: 'https://www.reuters.com/markets/fed-policy-steady-2026',
                    urlToImage: 'https://www.reuters.com/img/fed.jpg',
                    publishedAt: nowIso,
                    region: '美国',
                    category: '财经',
                    source: { id: 'reuters', name: 'Reuters (路透社)', authority: 99 },
                    relatedSources: [],
                    sourceCount: 1
                },
                {
                    id: 'en-cand-2',
                    title: 'European Space Agency Launches Next-Generation Earth Observation Satellite',
                    description: 'The new orbital sensor will monitor ocean temperatures, polar ice thickness, and carbon emissions with unprecedented precision.',
                    content: 'European Space Agency engineers confirmed successful orbital insertion of the Sentinel-Next satellite from Kourou spaceport.',
                    url: 'https://www.bbc.com/news/science-esa-satellite-2026',
                    urlToImage: 'https://www.bbc.com/img/esa.jpg',
                    publishedAt: nowIso,
                    region: '欧洲',
                    category: '科技',
                    source: { id: 'bbc', name: 'BBC News (英国广播公司)', authority: 95 },
                    relatedSources: [],
                    sourceCount: 1
                }
            ];

            fs.writeFileSync(candidatesPath, JSON.stringify({
                harvestedAt: nowIso,
                rawCount: 2,
                candidateCount: 2,
                sourceStats: [{ id: 'reuters', name: 'Reuters', count: 1, status: 'ok' }],
                fullCandidates: englishCandidates,
                llmInput: englishCandidates.map((c, idx) => ({
                    index: idx + 1,
                    id: c.id,
                    sourceName: c.source.name,
                    title: c.title,
                    excerpt: c.description
                }))
            }, null, 2), 'utf8');

            process.env.PUBLISH_SECRET = 'unattended-zh-sec';
            config.githubSync.pushEnabled = true;
            const autoRes = await runAutoUpdate({
                candidates: candidatesPath,
                compiled: compiledPath,
                target: baseUrl,
                secret: 'unattended-zh-sec',
                skipHarvest: true,
                useExistingCompiled: false,
                fallbackCompile: true,
                force: true,
                pushToGithub: true,
                repoDir: workRepoDir,
                clientId: 'unattended-daemon-test'
            });

            assert.equal(autoRes.success, true);
            assert.equal(autoRes.displayedCount, 2);
            assert.equal(autoRes.healthVerified, true);
            assert.ok(autoRes.githubSync && autoRes.githubSync.pushed, 'Unattended runAutoUpdate must push snapshot to GitHub ag-snapshot');

            const liveNews = stateManager.get('newsData');
            assert.equal(liveNews.length, 2);
            assert.equal(isLocalNewsPolluted(liveNews), false, 'Unattended compiled output must NEVER be flagged as polluted English RSS');

            for (const item of liveNews) {
                assert.equal(item.aiCompiled, true, 'Every article must have aiCompiled: true');
                assert.ok(/[\u4e00-\u9fff]/.test(item.translatedTitle), `translatedTitle must contain Chinese characters: ${item.translatedTitle}`);
                assert.ok(item.translatedTitle.length <= 32, `translatedTitle length (${item.translatedTitle.length}) must be <= 32: ${item.translatedTitle}`);
                assert.ok(/[\u4e00-\u9fff]/.test(item.summary), `summary must contain Chinese characters: ${item.summary}`);
                assert.ok(
                    item.summary.length >= 80 && item.summary.length <= 130,
                    `summary length (${item.summary.length}) must be 80-130 chars: ${item.summary}`
                );
                assert.ok(Array.isArray(item.keyPoints) && item.keyPoints.length === 3, 'Each article must have strictly 3 keyPoints');
                for (const kp of item.keyPoints) {
                    assert.ok(/[\u4e00-\u9fff]/.test(kp), `keyPoint must contain Chinese characters: ${kp}`);
                }
            }

            const liveSummary = stateManager.get('summaryArticle');
            assert.ok(liveSummary && /[\u4e00-\u9fff]/.test(liveSummary.title), 'summaryArticle must have a Chinese title');
            assert.ok(liveSummary.htmlContent.includes('class="news-ref-link"'), 'summaryArticle must render [NEWS_k] citation links');
        } finally {
            delete process.env.PUBLISH_SECRET;
            fs.rmSync(tmpRoot, { recursive: true, force: true });
        }
    });
});

