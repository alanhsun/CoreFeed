/**
 * CoreFeed v2.0 — Antigravity 内置大模型全流程采编架构、GitHub 快照中枢与 Swiss Editorial UI 端到端测试套件
 *
 * 覆盖范围 (15 项端到端测试)：
 *   1. 服务与纯网络 CLI 模块导出契约及旧机器翻译/守护进程代码清零校验
 *   2. `POST /api/agent/publish` 鉴权校验 (401/200)
 *   3. `POST /api/agent/publish` 非法载荷拦截 (400)
 *   4. `POST /api/agent/publish` 状态落盘、`[NEWS_k]` 引注渲染与已移除旧路由 404 验证
 *   5. `scripts/ag-publish.js` 大模型精选顺序保留、`mergedIndices`/`duplicateGroups` 跨源归并与全中文严格校验拦截
 *   6. 每日早中晚三次 (`08:00, 12:30, 19:30` 北京时间) 软路由定时快照同步与配置持久化
 *   7. `scripts/ag-harvest.js` 纯网络原始 RSS/正文/配图抓取与 `--inspect` 按序号提取验证
 *   8. 局域网直推 (`--site`/`--file`/`X-Publish-Secret`) 与独立自包含精编快照发布
 *   9. Git Plumbing 孤儿分支 (`ag-snapshot/latest.json`) 无工作区污染发布
 *  10. 软路由 `POST /api/agent/pull-github` 与 `GET /api/agent/sync-status` 同步闭环
 *  11. 方案 2B 默认推送 GitHub 与 `publishedBy`/`clientId` 元数据透传
 *  12. 多客户端 30 分钟冷却防冲突协调 (`ag-harvest.js --check-cooldown`) 与 ETag `304 Not Modified` 轮询
 *  13. Swiss Editorial Bento UI SSR (`?v=2.7.0`)、`editorialEngine` 状态契约与一键同步验证
 *  14. 软路由零本地 RSS 回退保护与英文生肉污染自动自愈验证
 *  15. Antigravity 专属技能 (`.agents/skills/corefeed-editor/SKILL.md`) 与全仓零外部机器翻译/零 `AI_API_KEY` 纯净度契约
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

process.env.NODE_ENV = 'test';
process.env.AUTO_UPDATE_ENABLED = 'false';

const ROOT_DIR = path.resolve(__dirname, '..');
const config = require('../config');
const stateManager = require('../services/state_manager');
const { app, server, io, services } = require('../server');
const { parseArgs: parseHarvestArgs, runHarvest, inspectCandidates } = require('../scripts/ag-harvest');
const { parseArgs: parsePublishArgs, runPublish, validateCompiledArticle } = require('../scripts/ag-publish');
const { publishSnapshotToGitHub, checkRemoteSnapshotCooldown, isLocalNewsPolluted } = require('../utils/github_sync');

const DATA_DIR = config.storage.dataDir || path.join(ROOT_DIR, 'data');
const TRACKED_DATA_FILES = [
    'news.json',
    'summary.json',
    'state.json',
    'settings.json',
    'ag_candidates.json',
    'ag_compiled.json'
];

describe('CoreFeed v2.0 — Antigravity Built-in LLM Editorial Pipeline & Snapshot Sync Tests', () => {
    let baseUrl = '';
    let dataDirExisted = false;
    const fileBackups = new Map();

    before(async () => {
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

    it('1. Module export contract: server.js and pure CLI scripts export required interfaces while legacy AIService & unattended daemons are removed', () => {
        assert.ok(app, 'app should be exported');
        assert.ok(server, 'server should be exported');
        assert.ok(io, 'io should be exported');
        assert.ok(services.newsService, 'services.newsService should be initialized');
        assert.equal(services.aiService, undefined, 'Legacy services.aiService must be completely removed');
        assert.equal(config.ai, undefined, 'Legacy config.ai block must be completely removed');
        assert.ok(services.newsAgentService, 'services.newsAgentService should be initialized');
        assert.equal(services.newsAgentService.runGlobalPatrolPipeline, undefined, 'Programmatic patrol/compilation pipeline must be removed');
        assert.equal(app.locals.stateManager, stateManager, 'app.locals.stateManager should reference singleton stateManager');
        assert.notEqual(server.address().port, 3120, 'Test server should run on ephemeral port, not 3120');

        // Verify legacy programmatic translation / scheduler scripts were deleted
        assert.equal(fs.existsSync(path.join(ROOT_DIR, 'services', 'ai_service.js')), false, 'services/ai_service.js must be deleted');
        assert.equal(fs.existsSync(path.join(ROOT_DIR, 'utils', 'rate_limiter.js')), false, 'utils/rate_limiter.js must be deleted');
        assert.equal(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'ag-auto-update.js')), false, 'scripts/ag-auto-update.js must be deleted');
        assert.equal(fs.existsSync(path.join(ROOT_DIR, 'scripts', 'setup-schedule.js')), false, 'scripts/setup-schedule.js must be deleted');

        assert.equal(typeof parseHarvestArgs, 'function');
        assert.equal(typeof runHarvest, 'function');
        assert.equal(typeof inspectCandidates, 'function');
        assert.equal(typeof parsePublishArgs, 'function');
        assert.equal(typeof runPublish, 'function');
        assert.equal(typeof validateCompiledArticle, 'function');

        const hArgs = parseHarvestArgs(['--limit', '20', '--images', '10', '--category', 'tech', '--check-cooldown', '--force', '--inspect', '1,3,5']);
        assert.equal(hArgs.limit, 20);
        assert.equal(hArgs.imageLimit, 10);
        assert.equal(hArgs.category, 'tech');
        assert.equal(hArgs.checkCooldown, true);
        assert.equal(hArgs.force, true);
        assert.equal(hArgs.inspectIndices, '1,3,5');
        assert.equal(hArgs.translateFallback, undefined, '--translate-fallback must no longer exist');

        const pArgs = parsePublishArgs(['--target', 'http://127.0.0.1:3120', '--secret=sec1', '--limit=15', '--local-only']);
        assert.equal(pArgs.target, 'http://127.0.0.1:3120');
        assert.equal(pArgs.secret, 'sec1');
        assert.equal(pArgs.limit, 15);
        assert.equal(pArgs.localOnly, true);
        assert.equal(pArgs.fallbackCompile, undefined, '--fallback-compile must no longer exist');
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

        const resNoAuth = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resNoAuth.status, 401);
        const bodyNoAuth = await resNoAuth.json();
        assert.equal(bodyNoAuth.success, false);

        const resWrongBearer = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer wrong-secret'
            },
            body: JSON.stringify(minimalPayload)
        });
        assert.equal(resWrongBearer.status, 401);

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

        const resValidBodySecret = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
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

        const resEmptyObj = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers,
            body: JSON.stringify({})
        });
        assert.equal(resEmptyObj.status, 400);

        const resNonArray = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ news: 'not-an-array' })
        });
        assert.equal(resNonArray.status, 400);

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
                originalParagraphs: ['Major central banks announced a joint pilot for instant cross-border settlement.'],
                translatedParagraphs: ['多家主要央行今日宣布启动跨境即时结算联合试点，旨在降低国际贸易清算成本并显著提升跨境资金流转效率。'],
                translatedContent: '多家主要央行今日宣布启动跨境即时结算联合试点，旨在降低国际贸易清算成本并显著提升跨境资金流转效率。',
                url: 'https://www.reuters.com/markets/cbdc-settlement-2026',
                urlToImage: 'https://www.reuters.com/resizer/sample1.jpg',
                publishedAt: nowIso,
                region: '国际',
                category: '财经',
                keyPoints: ['启动跨境即时结算试点', '降低国际贸易清算成本', '建立多边央行流动性池'],
                aiCompiled: true,
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
                originalParagraphs: ['Independent winter testing confirmed 1000km range retention at -15C.'],
                translatedParagraphs: ['独立第三方测试机构发布的最新冬季严寒路测数据显示，新一代固态电池在零下15摄氏度环境中仍保持千公里续航能力。'],
                translatedContent: '独立第三方测试机构发布的最新冬季严寒路测数据显示，新一代固态电池在零下15摄氏度环境中仍保持千公里续航能力。',
                url: 'https://www.bbc.com/news/technology-battery-2026',
                urlToImage: 'https://www.bbc.com/images/sample2.jpg',
                publishedAt: nowIso,
                region: '欧洲',
                category: '科技',
                keyPoints: ['零下15度环境实测千公里续航', '快充10分钟补充80%电量', '预计2027年启动商业化量产'],
                aiCompiled: true,
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

        const resNews = await fetch(`${baseUrl}/api/news`);
        assert.equal(resNews.status, 200);
        const newsBody = await resNews.json();
        assert.equal(newsBody.success, true);
        assert.equal(newsBody.news.length, 2);
        assert.equal(newsBody.total, 3);
        assert.equal(newsBody.hasMore, true);
        assert.equal(newsBody.collectionPhase, 'completed');
        assert.equal(newsBody.news[0].translatedTitle, '多国央行协调跨境数字结算新框架');

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

        const resLatest = await fetch(`${baseUrl}/api/latest-data`);
        assert.equal(resLatest.status, 200);
        const latestBody = await resLatest.json();
        assert.equal(latestBody.success, true);
        assert.equal(latestBody.data.news.count, 2);
        assert.equal(latestBody.data.news.items[0].title, '多国央行协调跨境数字结算新框架');
        assert.equal(latestBody.data.news.items[0].aiCompiled, true);
        assert.equal(latestBody.data.summary.available, true);
        assert.ok(latestBody.data.summary.content.includes('class="news-ref-link"'));

        // Verify removed legacy / runtime-machine-translation endpoints return 404 Not Found
        const resRemovedDeepRead = await fetch(`${baseUrl}/api/agent/deep-read`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.reuters.com/markets/cbdc-settlement-2026' })
        });
        assert.equal(resRemovedDeepRead.status, 404, 'Removed /api/agent/deep-read route must return 404');

        const resRemovedRuntimeTranslate = await fetch(`${baseUrl}/api/news/translate-fulltext`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://www.reuters.com/markets/cbdc-settlement-2026' })
        });
        assert.equal(resRemovedRuntimeTranslate.status, 404, 'Removed runtime machine-translation /api/news/translate-fulltext route must return 404');

        const resRemovedSystemPerf = await fetch(`${baseUrl}/api/system/performance`);
        assert.equal(resRemovedSystemPerf.status, 404, 'Removed /api/system/performance route must return 404');

        const resHome = await fetch(`${baseUrl}/`);
        assert.equal(resHome.status, 200);
        const homeHtml = await resHome.text();
        assert.ok(homeHtml.includes('多国央行协调跨境数字结算新框架'), 'Homepage SSR should include published Chinese headline');
        assert.ok(homeHtml.includes('class="news-ref-link"'), 'Homepage SSR should include rendered summary citation links');

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

    it('5. scripts/ag-publish.js strict LLM editorial contract: publishes ONLY LLM-curated articles in exact order, merges cross-source relatedSources & images, and rejects raw English or missing fields', async () => {
        process.env.PUBLISH_SECRET = 'ag-test-secret-999';
        const candidatesPath = path.join(DATA_DIR, 'ag_candidates.json');
        const compiledPath = path.join(DATA_DIR, 'ag_compiled.json');
        const nowIso = new Date().toISOString();

        // 4 raw candidates: LLM selects [1 (merged with 3), 2], and intentionally drops noisy item 4
        const rawCandidates = [
            {
                index: 1,
                id: 'cand-1',
                title: 'UN Reaches Historic Global AI Safety Accord in New York',
                description: 'Member states signed the landmark framework on frontier AI governance.',
                content: 'Short report on UN AI accord.',
                fullText: 'United Nations member states signed a historic binding governance pact on frontier artificial intelligence in New York.',
                url: 'https://www.bbc.com/news/world-un-ai-pact-2026',
                urlToImage: null, // Missing image on primary -> should inherit image from merged companion cand-3!
                publishedAt: nowIso,
                source: { id: 'bbc', name: 'BBC News (英国广播公司)', authority: 90 }
            },
            {
                index: 2,
                id: 'cand-2',
                title: 'Asian Markets Rally as Semiconductor Exports Surge 28%',
                description: 'Strong chip demand lifted major Asian indices on Monday.',
                content: 'Detailed market report on semiconductor export growth...',
                fullText: 'Semiconductor exports jumped 28% year-on-year in October as global AI server deployments accelerated.',
                url: 'https://asia.nikkei.com/Economy/chip-exports-2026',
                urlToImage: 'https://asia.nikkei.com/img/chips.jpg',
                publishedAt: nowIso,
                source: { id: 'nikkei', name: 'Nikkei Asia (日经亚洲)', authority: 90 }
            },
            {
                index: 3,
                id: 'cand-3',
                title: 'United Nations Adopts Binding AI Governance Pact',
                description: 'Reuters coverage of the UN frontier AI treaty in New York.',
                content: 'Comprehensive Reuters dispatch on the UN binding AI treaty.',
                fullText: 'Reuters dispatch from New York detailing the UN frontier AI governance treaty and compliance mechanism.',
                url: 'https://www.reuters.com/technology/un-ai-accord-2026',
                urlToImage: 'https://www.reuters.com/img/ai-accord.jpg',
                publishedAt: nowIso,
                source: { id: 'reuters', name: 'Reuters (路透社)', authority: 99 }
            },
            {
                index: 4,
                id: 'cand-dropped-noise-4',
                title: '10 Best Coffee Makers on Sale This Weekend',
                description: 'Affiliate shopping roundup that LLM editor must filter out.',
                content: 'Shopping deals roundup...',
                url: 'https://example.com/deals/coffee-makers',
                publishedAt: nowIso,
                source: { id: 'deals', name: 'Shopping Deals', authority: 50 }
            }
        ];

        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(candidatesPath, JSON.stringify({
            harvestedAt: nowIso,
            rawCount: 10,
            candidateCount: 4,
            sourceStats: [{ id: 'reuters', name: 'Reuters', count: 5, status: 'ok' }],
            briefIndex: rawCandidates.map(c => ({
                index: c.index,
                id: c.id,
                sourceName: c.source.name,
                title: c.title,
                rssExcerpt: c.description
            })),
            fullCandidates: rawCandidates
        }, null, 2));

        // 5a. Negative contract check: missing translatedParagraphs or raw English summary must be strictly rejected with 400
        const invalidCompiledPath = path.join(DATA_DIR, 'ag_compiled.json');
        fs.writeFileSync(invalidCompiledPath, JSON.stringify({
            articles: [
                {
                    candidateIndex: 1,
                    id: 'cand-1',
                    translatedTitle: 'UN Reaches Historic Global AI Safety Accord', // Raw English!
                    summary: 'Raw English summary without translation',
                    keyPoints: ['Point 1'],
                    translatedParagraphs: []
                }
            ],
            summaryMarkdown: 'English summary only'
        }, null, 2));

        await assert.rejects(
            () => runPublish({
                candidates: candidatesPath,
                compiled: invalidCompiledPath,
                localOnly: true,
                pushToGithub: false
            }),
            (err) => err.statusCode === 400 && /中文标题/.test(err.message),
            'runPublish must strictly reject untranslated English titles with statusCode 400'
        );

        // Also verify missing translatedParagraphs is rejected
        fs.writeFileSync(invalidCompiledPath, JSON.stringify({
            articles: [
                {
                    candidateIndex: 1,
                    id: 'cand-1',
                    translatedTitle: '联合国在纽约达成历史性全球人工智能安全协议',
                    summary: '联合国成员国在纽约正式签署具有里程碑意义的前沿人工智能治理框架协议。',
                    keyPoints: ['签署前沿AI治理框架', '确立跨国安全评估标准', '建立联合核查机制'],
                    translatedParagraphs: ['Untranslated English paragraph only.']
                }
            ],
            summaryMarkdown: '### 科技治理\n联合国签署人工智能治理框架协议 [NEWS_1]。'
        }, null, 2));

        await assert.rejects(
            () => runPublish({
                candidates: candidatesPath,
                compiled: invalidCompiledPath,
                localOnly: true,
                pushToGithub: false
            }),
            (err) => err.statusCode === 400 && /translatedParagraphs/.test(err.message),
            'runPublish must strictly reject articles lacking Chinese translatedParagraphs'
        );

        // 5b. Valid Antigravity LLM compilation with mergedIndices [3] & duplicateGroups [[1, 3]], placing item 2 first and merged item 1 second
        fs.writeFileSync(compiledPath, JSON.stringify({
            duplicateGroups: [[1, 3]],
            articles: [
                {
                    candidateIndex: 2,
                    id: 'cand-2',
                    translatedTitle: '半导体出口激增28%推动亚太股市全线上扬',
                    summary: '受全球人工智能算力芯片强劲需求拉动，最新贸易数据显示十月半导体出口同比大增28%，全面提振亚太主要股指表现。',
                    region: '亚太',
                    category: '财经',
                    keyPoints: ['十月半导体出口同比大增28%', '全球AI服务器算力需求持续旺盛', '亚太主要科技股指全线走高'],
                    originalParagraphs: ['Semiconductor exports jumped 28% year-on-year in October as global AI server deployments accelerated.'],
                    translatedParagraphs: ['受全球人工智能服务器部署加速带动，十月份半导体出口额同比激增28%，推动亚太主要股市全线上扬。']
                },
                {
                    candidateIndex: 1,
                    mergedIndices: [3],
                    id: 'cand-1',
                    translatedTitle: '联合国在纽约达成历史性全球人工智能安全协议',
                    summary: '联合国成员国在纽约正式签署具有里程碑意义的前沿人工智能治理框架协议，首次在跨国层面确立高风险模型安全评估与通报准则。',
                    region: '北美',
                    category: '科技',
                    keyPoints: ['联合国签署前沿AI治理框架协议', '确立跨国高风险模型安全评估标准', '设立多边人工智能风险通报机制'],
                    originalParagraphs: [
                        'United Nations member states signed a historic binding governance pact on frontier artificial intelligence in New York.',
                        'Reuters dispatch from New York detailing the UN frontier AI governance treaty and compliance mechanism.'
                    ],
                    translatedParagraphs: [
                        '联合国各成员国代表今日在纽约总部正式签署具有约束力的前沿人工智能全球安全治理协议。',
                        '路透社发自纽约的报道指出，该条约明确了超大规模模型在跨境部署前的红队安全测试与风险通报机制。'
                    ]
                }
            ],
            summaryMarkdown: '2026年全球要闻深度综述\n\n### 亚太经贸动态\n受算力需求拉动，半导体出口同比增长28%，带动亚太市场走强 [NEWS_1]。\n\n### 科技与全球治理\n联合国达成历史性全球人工智能安全协议，多国确立统一治理标准 [NEWS_2]。'
        }, null, 2));

        const publishScript = path.join(ROOT_DIR, 'scripts', 'ag-publish.js');
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
        assert.equal(latestBody.data.news.count, 2, 'Unselected candidate #4 must NOT be included, and [1,3] must merge into 1 item');
        assert.equal(latestBody.data.news.items[0].title, '半导体出口激增28%推动亚太股市全线上扬', 'Exact LLM ranking order must be preserved');
        assert.equal(latestBody.data.news.items[1].title, '联合国在纽约达成历史性全球人工智能安全协议');
        assert.equal(latestBody.data.news.items[1].sourceCount, 2, 'Merged cluster [1,3] should have sourceCount === 2');
        assert.equal(latestBody.data.news.items[1].urlToImage, 'https://www.reuters.com/img/ai-accord.jpg', 'Primary article without image should inherit companion Reuters image');
        assert.equal(latestBody.data.summary.available, true);
        assert.ok(latestBody.data.summary.content.includes('class="news-ref-link"'));

        // Verify stateManager pool also excludes unselected raw English candidate #4
        const statePool = stateManager.get('allEnhancedNews');
        assert.equal(statePool.length, 2);
        assert.equal(statePool.some(item => item.id === 'cand-dropped-noise-4'), false);
    });

    it('6. 3x/day schedule configuration (08:00, 12:30, 19:30 Asia/Shanghai), GET /api/schedule/status, POST /api/schedule/config & timezone-aware getNextExecutionTime()', async () => {
        assert.deepEqual(config.news.updateTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(config.news.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(config.news.timezone, 'Asia/Shanghai');

        const resStatus = await fetch(`${baseUrl}/api/schedule/status`);
        assert.equal(resStatus.status, 200);
        const statusBody = await resStatus.json();
        assert.equal(statusBody.success, true);
        assert.deepEqual(statusBody.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.deepEqual(statusBody.updateTimes, ['08:00', '12:30', '19:30']);
        assert.equal(statusBody.timezone, 'Asia/Shanghai');
        assert.ok(statusBody.schedule, 'status response should include nested schedule object');

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

        const nextExecDate = new Date(postScheduleBody.nextExecution);
        assert.ok(!isNaN(nextExecDate.getTime()), 'nextExecution should be a valid ISO timestamp');
        assert.ok(nextExecDate.getTime() > Date.now(), 'nextExecution should be in the future');
        const utcHm = `${String(nextExecDate.getUTCHours()).padStart(2, '0')}:${String(nextExecDate.getUTCMinutes()).padStart(2, '0')}`;
        assert.ok(
            ['00:00', '04:30', '11:30'].includes(utcHm),
            `nextExecution UTC time (${utcHm}) must match 08:00, 12:30, or 19:30 Asia/Shanghai`
        );

        const savedSettings = JSON.parse(fs.readFileSync(config.storage.settingsFile, 'utf8'));
        assert.equal(savedSettings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.deepEqual(savedSettings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(savedSettings.timezone, 'Asia/Shanghai');

        if (services.scheduleManager) {
            services.scheduleManager.stop();
        }
    });

    it('7. scripts/ag-harvest.js pure network harvester & --inspect E2E: fetches raw RSS + full article text + og:image without machine translation or rule scoring', async () => {
        const nowRfc822 = new Date().toUTCString();
        let mockRssPort = 0;

        const mockFeedServer = http.createServer((req, res) => {
            if (req.url === '/rss.xml') {
                const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Mock Global Wire</title>
    <link>http://127.0.0.1:${mockRssPort}</link>
    <description>Pure raw feed</description>
    <item>
      <title>Global Fusion Reactor Sets 20-Minute Plasma Record</title>
      <link>http://127.0.0.1:${mockRssPort}/article-fusion</link>
      <description>Scientists achieved a 20-minute steady-state high-confinement plasma discharge.</description>
      <pubDate>${nowRfc822}</pubDate>
    </item>
    <item>
      <title>Duplicate Fusion Link Should Be Deduplicated By Exact URL</title>
      <link>http://127.0.0.1:${mockRssPort}/article-fusion/</link>
      <description>Duplicate trailing-slash URL entry.</description>
      <pubDate>${nowRfc822}</pubDate>
    </item>
    <item>
      <title>International Maritime Corridor Cuts Shipping Emissions by 18%</title>
      <link>http://127.0.0.1:${mockRssPort}/article-maritime</link>
      <description>Green methanol bunkering hubs opened in Rotterdam and Singapore.</description>
      <pubDate>${nowRfc822}</pubDate>
    </item>
  </channel>
</rss>`;
                res.writeHead(200, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
                res.end(rssXml);
                return;
            }

            if (req.url === '/article-fusion') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!doctype html>
<html>
<head>
  <title>Global Fusion Reactor Sets 20-Minute Plasma Record</title>
  <meta property="og:image" content="http://127.0.0.1:${mockRssPort}/media/fusion-hero.jpg" />
</head>
<body>
  <article>
    <p>International researchers operating the experimental superconducting tokamak announced on Tuesday that they sustained a high-confinement plasma reaction for twenty consecutive minutes at 120 million degrees Celsius.</p>
    <p>Engineers noted that the upgraded tungsten divertor withstood peak heat flux within safety margins, providing crucial operational data for commercial fusion power plant designs.</p>
  </article>
</body>
</html>`);
                return;
            }

            if (req.url === '/article-maritime') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(`<!doctype html>
<html>
<head>
  <title>International Maritime Corridor Cuts Shipping Emissions by 18%</title>
  <meta property="og:image" content="http://127.0.0.1:${mockRssPort}/media/maritime-green.jpg" />
</head>
<body>
  <article>
    <p>Port authorities in Singapore and Rotterdam reported an eighteen percent reduction in container corridor carbon intensity twelve months after launching coordinated green methanol bunkering and digital just-in-time arrival scheduling.</p>
    <p>More than forty ultra-large container vessels participated in the first year of the zero-emission corridor initiative.</p>
  </article>
</body>
</html>`);
                return;
            }

            res.writeHead(404);
            res.end('Not found');
        });

        await new Promise((resolve, reject) => {
            mockFeedServer.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
        });
        mockRssPort = mockFeedServer.address().port;

        const prevRssSources = config.news.rssSources;
        const prevJinaEnabled = config.agent.jinaReaderEnabled;
        const prevNoProxy = process.env.NO_PROXY;
        const tmpOutPath = path.join(os.tmpdir(), `corefeed-harvest-test-${Date.now()}.json`);

        try {
            process.env.NO_PROXY = '127.0.0.1,localhost';
            config.news.rssSources = `MockGlobalWire|http://127.0.0.1:${mockRssPort}/rss.xml`;
            config.agent.jinaReaderEnabled = false;

            const harvestRes = await runHarvest({
                out: tmpOutPath,
                category: 'custom',
                limit: 10,
                imageLimit: 10
            });

            assert.equal(harvestRes.rawCount, 3, 'Raw RSS had 3 items before exact-URL deduplication');
            assert.equal(harvestRes.candidateCount, 2, 'Exact URL deduplication must collapse trailing-slash duplicate into 2 unique candidates');
            assert.equal(harvestRes.briefIndex.length, 2);
            assert.equal(harvestRes.fullCandidates.length, 2);

            const firstCand = harvestRes.fullCandidates[0];
            assert.equal(firstCand.translatedTitle, undefined, 'ag-harvest.js must NOT run any machine translation');
            assert.equal(firstCand.aiCompiled, undefined, 'ag-harvest.js must NOT mark raw items as aiCompiled');
            assert.ok(firstCand.urlToImage && firstCand.urlToImage.includes('/media/'), 'ag-harvest.js should extract og:image URL from article HTML');
            assert.ok((firstCand.fullText || '').length > 180, 'ag-harvest.js should extract raw full text from <article>');

            // Verify --inspect / inspectCandidates reads selected 1-based indices cleanly
            const inspectRes = await runHarvest({
                out: tmpOutPath,
                inspectIndices: '2'
            });
            assert.equal(inspectRes.totalCandidates, 2);
            assert.equal(inspectRes.inspectedCount, 1);
            assert.equal(inspectRes.items[0].index, 2);
            assert.ok(inspectRes.items[0].rawText.length > 150);
        } finally {
            config.news.rssSources = prevRssSources;
            config.agent.jinaReaderEnabled = prevJinaEnabled;
            if (prevNoProxy === undefined) {
                delete process.env.NO_PROXY;
            } else {
                process.env.NO_PROXY = prevNoProxy;
            }
            if (fs.existsSync(tmpOutPath)) {
                fs.unlinkSync(tmpOutPath);
            }
            await new Promise((resolve) => mockFeedServer.close(() => resolve()));
        }
    });

    it('8. LAN Push Ergonomics: --site/--url/--file CLI flags, safe = secret parsing, X-Publish-Secret header, and standalone ag_compiled.json without ag_candidates.json', async () => {
        const pArgs = parsePublishArgs([
            '--site', 'http://192.0.2.10:3120',
            '--file', 'data/ag_compiled.json',
            '--secret=sec=with=equals==',
            '--github',
            '--github-branch=ag-snapshot',
            '--github-remote=origin',
            '--snapshot-out=/tmp/snap-test.json'
        ]);
        assert.equal(pArgs.target, 'http://192.0.2.10:3120');
        assert.equal(pArgs.compiled, path.resolve('data/ag_compiled.json'));
        assert.equal(pArgs.secret, 'sec=with=equals==');
        assert.equal(pArgs.githubSync, true);
        assert.equal(pArgs.githubBranch, 'ag-snapshot');
        assert.equal(pArgs.githubRemote, 'origin');
        assert.equal(pArgs.snapshotOut, path.resolve('/tmp/snap-test.json'));

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
                        translatedTitle: '自托管服务端直推测试文章：全球算力网络升级',
                        summary: '客户端通过内网向 192.0.2.10:3120 发起直接推送并触发实时落盘与广播。',
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
                    summary: '欧洲央行在最新货币政策会议上决定维持基准利率不变，并继续评估欧元区核心通胀走势与信贷复苏情况。',
                    url: 'https://www.ft.com/content/ecb-rate-2026',
                    region: '欧洲',
                    category: '财经',
                    keyPoints: ['欧洲央行维持三大关键利率不变', '持续评估欧元区服务业核心通胀', '重申基于数据逐次会议决策机制'],
                    originalParagraphs: ['The European Central Bank kept its benchmark deposit facility rate unchanged on Thursday as policymakers assessed underlying inflation dynamics.'],
                    translatedParagraphs: ['欧洲央行周四宣布维持基准存款便利利率不变，管理委员会表示将继续密切评估潜在通胀走势与融资环境变化。'],
                    source: { name: 'Financial Times (金融时报)' }
                }
            ],
            summary: {
                title: '2026年全球要闻深度综述（独立快照版）',
                content: '### 欧洲货币政策\n欧洲央行宣布维持基准利率不变，持续观察核心通胀回落节奏 [NEWS_1]。'
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
                        category: '财经',
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

            const mainHeadAfter = execFileSync('git', ['-C', workRepoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
            const currentBranch = execFileSync('git', ['-C', workRepoDir, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
            const statusPorcelain = execFileSync('git', ['-C', workRepoDir, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
            assert.equal(mainHeadAfter, mainHeadBefore, 'HEAD on main must not change');
            assert.equal(currentBranch, 'main', 'Checked-out branch must remain main');
            assert.equal(statusPorcelain, '', 'Working tree must remain 100% clean');

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

    it('10. Router GitHub Snapshot Puller E2E: POST /api/agent/pull-github, GET /api/agent/sync-status, deduplication guard, force override & ScheduleManager.executeUpdate()', async () => {
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
                    translatedParagraphs: ['欧洲量子通信基础设施项目今日宣布，连接多国首都的跨国光纤量子密钥分发骨干网已正式投入运行。'],
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
                    translatedParagraphs: ['最新航运统计显示，受益于港口自动化调度升级与亚欧干线需求回暖，第三季度全球海运贸易量同比增长6.2%。'],
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

        const prevNoProxy = process.env.NO_PROXY;
        try {
            process.env.NO_PROXY = '127.0.0.1,localhost';
            process.env.PUBLISH_SECRET = 'router-sync-sec-123';
            process.env.GITHUB_SNAPSHOT_URL = mockSnapshotUrl;
            stateManager.reset();

            const resUnauth = await fetch(`${baseUrl}/api/agent/pull-github`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ snapshotUrl: mockSnapshotUrl })
            });
            assert.equal(resUnauth.status, 401);

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

            const resNews = await fetch(`${baseUrl}/api/news`);
            const newsData = await resNews.json();
            assert.equal(newsData.news.length, 2);
            assert.equal(newsData.news[0].translatedTitle, '欧洲多国首都间量子通信骨干链路正式投入运行');

            const resSum = await fetch(`${baseUrl}/api/summary`);
            const sumData = await resSum.json();
            assert.ok(sumData.article.htmlContent.includes('class="news-ref-link"'));
            assert.ok(sumData.article.htmlContent.includes('https://www.bbc.com/news/science-quantum-link-2026'));

            const diskNews = JSON.parse(fs.readFileSync(config.storage.newsFile, 'utf8'));
            assert.equal(diskNews.news.length, 2);

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

            const newerTimestamp = new Date(Date.now() - 2 * 60 * 1000).toISOString();
            mockSnapshotPayload = {
                ...mockSnapshotPayload,
                publishedAt: newerTimestamp,
                lastUpdated: newerTimestamp,
                publishedBy: 'cloud-client-test'
            };
            stateManager.set('lastUpdated', new Date(Date.now() - 45 * 60 * 1000).toISOString(), false);
            await services.scheduleManager.executeUpdate();
            assert.equal(stateManager.get('lastUpdated'), newerTimestamp, 'ScheduleManager.executeUpdate() should apply newer GitHub snapshot');
            assert.equal(stateManager.get('lastPublishedBy'), 'cloud-client-test');
        } finally {
            if (prevNoProxy === undefined) delete process.env.NO_PROXY;
            else process.env.NO_PROXY = prevNoProxy;
            delete process.env.GITHUB_SNAPSHOT_URL;
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('11. Method 2B Default GitHub Push (pushToGithub=true), --no-github / GITHUB_PUSH_ENABLED=false opt-out & publishedBy / clientId metadata', async () => {
        assert.equal(config.githubSync.pushEnabled, true, 'config.githubSync.pushEnabled should default to true');
        assert.equal(config.githubSync.intervalMinutes, 60, 'config.githubSync.intervalMinutes should default to 60');
        assert.equal(config.githubSync.cooldownMinutes, 30, 'config.githubSync.cooldownMinutes should default to 30');
        assert.ok(config.githubSync.clientId && config.githubSync.clientId.length > 0, 'config.githubSync.clientId should have a non-empty default');

        const defaultPubArgs = parsePublishArgs([]);
        assert.equal(defaultPubArgs.pushToGithub, true);
        assert.equal(defaultPubArgs.githubSync, true);
        assert.equal(defaultPubArgs.github, true);
        assert.ok(defaultPubArgs.clientId.length > 0);

        const optOutPubArgs = parsePublishArgs(['--no-github', '--client-id=client-workstation-a']);
        assert.equal(optOutPubArgs.pushToGithub, false);
        assert.equal(optOutPubArgs.githubSync, false);
        assert.equal(optOutPubArgs.github, false);
        assert.equal(optOutPubArgs.clientId, 'client-workstation-a');
        assert.equal(optOutPubArgs.publishedBy, 'client-workstation-a');

        process.env.GITHUB_PUSH_ENABLED = 'false';
        try {
            assert.equal(parsePublishArgs([]).pushToGithub, false);
        } finally {
            delete process.env.GITHUB_PUSH_ENABLED;
        }

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

            const nowIso = new Date().toISOString();
            fs.writeFileSync(compiledPath, JSON.stringify({
                publishedAt: nowIso,
                articles: [
                    {
                        candidateIndex: 1,
                        id: 'cand-1',
                        translatedTitle: '多客户端默认推送测试标题一',
                        summary: '验证默认开启 Method 2B 自动推送到 GitHub ag-snapshot 分支并记录客户端标识。',
                        region: '国际',
                        category: '科技',
                        keyPoints: ['默认推送至ag-snapshot分支', '工作区零污染提交', '支持多客户端协同防冲突'],
                        translatedParagraphs: ['验证默认开启方案 2B 自动将大模型精编快照推送至 GitHub ag-snapshot 分支并记录发布客户端标识。']
                    },
                    {
                        candidateIndex: 2,
                        id: 'cand-2',
                        translatedTitle: '多客户端默认推送测试标题二',
                        summary: '验证多客户端协同元数据与文章数量统计在远端快照中的完整性。',
                        region: '亚太',
                        category: '财经',
                        keyPoints: ['记录publishedBy元数据', '校验文章与信源统计计数', '全文译文随快照同步'],
                        translatedParagraphs: ['验证多客户端协同元数据与文章数量统计在远端单文件快照中的完整性与一致性。']
                    }
                ],
                summaryMarkdown: '### 全球科技与经贸\n多客户端默认推送测试综述，完整支持引注锚点跳转 [NEWS_1] [NEWS_2]。'
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

    it('12. Multi-Client Cooldown Coordination (ag-harvest.js --check-cooldown skips when fresh, proceeds on expired) & ETag If-None-Match 304 polling', async () => {
        let currentEtag = '"snap-etag-v1"';
        const ifNoneMatchHeaders = [];
        let mockRemoteSnapshot = {
            version: '2.0',
            publishedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5m ago (< 30m cooldown)
            lastUpdated: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
            publishedBy: 'peer-client-windows',
            clientId: 'peer-client-windows',
            news: [
                {
                    id: 'cooldown-news-1',
                    title: 'Peer Client Windows Published Fresh Global Brief',
                    translatedTitle: '其他客户端五分钟前刚发布的全球要闻：跨国清洁能源走廊投运',
                    summary: '由于其他客户端在30分钟冷却窗口内刚完成采集与精编发布，当前客户端直接检测到冷却期并避免重复抓取。',
                    url: 'https://www.reuters.com/world/cooldown-test-2026',
                    region: '国际',
                    category: '财经',
                    keyPoints: ['30分钟冷却窗口防冲突', '支持ETag条件请求轮询'],
                    translatedParagraphs: ['由于其他客户端在30分钟冷却窗口内刚完成采集与精编发布，当前客户端可直接跳过重复采集。'],
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

        const prevNoProxy = process.env.NO_PROXY;
        try {
            process.env.NO_PROXY = '127.0.0.1,localhost';

            // 12a. Fresh remote snapshot (5m old < 30m cooldown) -> runHarvest({ checkCooldown: true }) returns cooldownSkipped: true immediately without scraping RSS
            const cooldownHarvestRes = await runHarvest({
                checkCooldown: true,
                cooldownMinutes: 30,
                snapshotUrl: mockSnapshotUrl
            });
            assert.equal(cooldownHarvestRes.cooldownSkipped, true);
            assert.equal(cooldownHarvestRes.inCooldown, true);
            assert.equal(cooldownHarvestRes.publishedBy, 'peer-client-windows');

            // 12b. Expired remote snapshot (45m old > 30m cooldown) -> checkRemoteSnapshotCooldown returns inCooldown === false
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

            // 12c. ETag If-None-Match -> 304 Not Modified fast polling in GitHubSyncManager
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
            if (prevNoProxy === undefined) delete process.env.NO_PROXY;
            else process.env.NO_PROXY = prevNoProxy;
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('13. Purified Frontend UI SSR (GET /), GET /api/status editorialEngine contract, GET/POST /api/config persistence, and Web UI one-click sync', async () => {
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
                    summary: '通过顶部「同步最新」按钮，无需任何外部 API Key 即可直接从 ag-snapshot/latest.json 同步 Antigravity 大模型精编全文。',
                    url: 'https://www.bbc.com/news/ui-sync-test-2026',
                    region: '国际',
                    category: '科技',
                    keyPoints: ['支持一键同步最新快照', '极简纸媒阅读体验', '内置完整中英全文对照段落'],
                    originalParagraphs: ['Readers can open the full-text drawer instantaneously from the pre-compiled GitHub snapshot without runtime translation calls.'],
                    translatedParagraphs: ['读者可直接从预编译的 GitHub 快照秒开全文阅读抽屉，无需在软路由端发起任何实时机器翻译请求。'],
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

        const prevNoProxy = process.env.NO_PROXY;
        try {
            process.env.NO_PROXY = '127.0.0.1,localhost';
            stateManager.set('lastPublishedBy', 'antigravity-cloud-vm', false);
            const resHome = await fetch(`${baseUrl}/`);
            assert.equal(resHome.status, 200);
            const html = await resHome.text();

            assert.ok(html.includes('CoreFeed'), 'SSR HTML should contain CoreFeed brand title');
            assert.ok(html.includes('全球要闻深度聚合'), 'SSR HTML should contain editorial subtitle "全球要闻深度聚合"');
            assert.ok(html.includes('id="lastUpdateTime"'), 'SSR HTML should contain #lastUpdateTime in masthead');
            assert.ok(html.includes('更新于'), 'SSR HTML should display "更新于" timestamp prefix');
            assert.ok(html.includes('id="syncGithubBtn"'), 'SSR HTML should contain #syncGithubBtn');
            assert.ok(html.includes('同步最新'), 'SSR HTML should contain restrained "同步最新" button label');
            assert.ok(html.includes('id="btnSettings"'), 'SSR HTML should contain #btnSettings button');
            assert.ok(html.includes('id="settingsModal"'), 'SSR HTML should contain #settingsModal');
            assert.ok(html.includes('id="cfgAutoUpdateEnabled"'), 'SSR HTML should contain #cfgAutoUpdateEnabled');
            assert.ok(html.includes('id="cfgUpdateTimes"'), 'SSR HTML should contain #cfgUpdateTimes');
            assert.ok(html.includes('id="modalSyncStatusText"'), 'SSR HTML should contain #modalSyncStatusText');
            assert.ok(html.includes('id="btnSaveSettings"'), 'SSR HTML should contain #btnSaveSettings');
            assert.ok(html.includes('id="heroCarousel"'), 'SSR HTML should render #heroCarousel for Top-3 news items');

            assert.ok(!html.includes('id="cfgAiApiKey"'), 'SSR HTML must NOT contain #cfgAiApiKey');
            assert.ok(!html.includes('id="cfgAiBaseUrl"'), 'SSR HTML must NOT contain #cfgAiBaseUrl');
            assert.ok(!html.includes('id="cfgAiModel"'), 'SSR HTML must NOT contain #cfgAiModel');
            assert.ok(html.includes('/css/style.css?v=2.7.0'), 'SSR HTML should include cache-busted /css/style.css?v=2.7.0');
            assert.ok(html.includes('/js/main.js?v=2.7.0'), 'SSR HTML should include cache-busted /js/main.js?v=2.7.0');
            assert.ok(html.includes('id="fullTextModal"') && html.includes('fulltext-reader-sheet'), 'SSR HTML should include #fullTextModal and .fulltext-reader-sheet');

            const mainJsSource = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'main.js'), 'utf8');
            assert.ok(
                mainJsSource.includes('openFullTextModal') &&
                !mainJsSource.includes('/api/news/translate-fulltext'),
                'public/js/main.js must read pre-compiled translatedParagraphs from snapshot without runtime translation API calls'
            );

            // Verify GET /api/config exposes schedule & githubSync without legacy ai block
            const resGetCfg = await fetch(`${baseUrl}/api/config`);
            assert.equal(resGetCfg.status, 200);
            const getCfgData = await resGetCfg.json();
            assert.equal(getCfgData.success, true);
            assert.equal(getCfgData.config.ai, undefined, 'GET /api/config must not expose legacy external AI config');
            assert.equal(typeof getCfgData.config.GITHUB_SYNC_ENABLED, 'boolean');
            assert.equal(typeof getCfgData.config.GITHUB_PUSH_ENABLED, 'boolean');
            assert.equal(typeof getCfgData.config.GITHUB_SYNC_INTERVAL_MINUTES, 'number');
            assert.ok(getCfgData.config.CLIENT_ID);
            assert.equal(getCfgData.config.lastPublishedBy, 'antigravity-cloud-vm');

            // Verify POST /api/config saves settings cleanly and preserves existing keys
            const resPostCfg = await fetch(`${baseUrl}/api/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    GITHUB_SYNC_ENABLED: true,
                    GITHUB_PUSH_ENABLED: false,
                    GITHUB_SYNC_INTERVAL_MINUTES: 45,
                    CLIENT_ID: 'edge-node-01',
                    GITHUB_SNAPSHOT_URL: mockUiSnapshotUrl,
                    AUTO_UPDATE_ENABLED: true,
                    UPDATE_TIMES: '07:30,12:00,20:00'
                })
            });
            assert.equal(resPostCfg.status, 200);
            const postCfgData = await resPostCfg.json();
            assert.equal(postCfgData.success, true);
            assert.equal(postCfgData.config.GITHUB_SYNC_INTERVAL_MINUTES, 45);
            assert.equal(postCfgData.config.CLIENT_ID, 'edge-node-01');
            assert.equal(postCfgData.config.UPDATE_TIMES, '07:30,12:00,20:00');

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
            assert.equal(postModalCfgData.config.GITHUB_PUSH_ENABLED, false, 'Modal save must preserve existing GITHUB_PUSH_ENABLED');
            assert.equal(postModalCfgData.config.CLIENT_ID, 'edge-node-01', 'Modal save must preserve existing CLIENT_ID');

            // Verify Web UI one-click POST /api/agent/pull-github works seamlessly even when PUBLISH_SECRET is set
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
            assert.equal(statusAfterUiPull.editorialEngine, 'antigravity-builtin-llm');
            assert.equal(statusAfterUiPull.ai, undefined, 'GET /api/status must not include legacy ai object');
            assert.equal(statusAfterUiPull.lastPublishedBy, 'ui-sync-publisher');
            assert.equal(statusAfterUiPull.githubSync.lastPublishedBy, 'ui-sync-publisher');
        } finally {
            services.scheduleManager.stop();
            if (prevNoProxy === undefined) delete process.env.NO_PROXY;
            else process.env.NO_PROXY = prevNoProxy;
            await new Promise((resolve) => mockUiGhServer.close(() => resolve()));
        }
    });

    it('14. Router Protection: ScheduleManager never scrapes local RSS when GitHub snapshot is older than cooldown or unreachable, and GitHubSyncManager heals polluted local English state', async () => {
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
                    translatedParagraphs: ['欧洲央行宣布启动新一代跨境数字支付结算框架，全面提升欧元区与全球主要市场的清算效率。'],
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

        const originalScoutPatrol = services.newsAgentService._executeScoutPatrol;
        let scoutPatrolCallCount = 0;
        services.newsAgentService._executeScoutPatrol = async (...args) => {
            scoutPatrolCallCount += 1;
            return originalScoutPatrol.apply(services.newsAgentService, args);
        };

        const prevNoProxy = process.env.NO_PROXY;
        try {
            process.env.NO_PROXY = '127.0.0.1,localhost';
            process.env.GITHUB_SNAPSHOT_URL = mockSnapshotUrl;
            process.env.PUBLISH_SECRET = 'router-protect-sec';

            const initialPull = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: true,
                trigger: 'startup'
            });
            assert.equal(initialPull.applied, true);
            assert.equal(stateManager.get('lastUpdated'), threeHoursAgoIso);
            assert.equal(stateManager.get('lastSnapshotPublishedAt'), threeHoursAgoIso);
            assert.equal(isLocalNewsPolluted(stateManager.get('newsData')), false);

            // 14a. Remote snapshot is 3 hours old (> 30m cooldown) -> ScheduleManager.executeUpdate() MUST NOT scrape local RSS
            await services.scheduleManager.executeUpdate();
            assert.equal(scoutPatrolCallCount, 0, 'ScheduleManager must NEVER execute local RSS scraping');
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架'
            );

            // Remote GitHub server unreachable (500) -> still preserves local Chinese snapshot
            mockServerFail = true;
            await services.scheduleManager.executeUpdate();
            assert.equal(scoutPatrolCallCount, 0);
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架'
            );
            mockServerFail = false;

            // 14b. Simulate accidental English RSS pollution in stateManager -> pullAndApply({ force: false }) auto-heals
            const newerPollutedIso = new Date().toISOString();
            stateManager.updateNewsData(
                [
                    {
                        id: 'en-polluted-1',
                        title: 'Breaking English RSS News Without Translation',
                        translatedTitle: 'Breaking English RSS News Without Translation',
                        summary: 'Raw English RSS summary scraped locally without LLM',
                        aiCompiled: false
                    }
                ],
                null,
                newerPollutedIso
            );
            assert.equal(isLocalNewsPolluted(stateManager.get('newsData')), true);

            const healRes = await services.githubSyncManager.pullAndApply({
                snapshotUrl: mockSnapshotUrl,
                force: false,
                trigger: 'schedule'
            });
            assert.equal(healRes.applied, true);
            assert.equal(
                stateManager.get('newsData')[0].translatedTitle,
                '欧洲央行宣布启动新一代跨境数字支付结算框架'
            );
            assert.equal(stateManager.get('lastSnapshotPublishedAt'), threeHoursAgoIso);
        } finally {
            services.newsAgentService._executeScoutPatrol = originalScoutPatrol;
            if (prevNoProxy === undefined) delete process.env.NO_PROXY;
            else process.env.NO_PROXY = prevNoProxy;
            delete process.env.GITHUB_SNAPSHOT_URL;
            delete process.env.PUBLISH_SECRET;
            await new Promise((resolve) => mockGhServer.close(() => resolve()));
        }
    });

    it('15. Antigravity Skill (.agents/skills/corefeed-editor/SKILL.md) & Zero-Machine-Translation Codebase Purity Contract', () => {
        // 15a. Verify workspace skill exists, has valid YAML frontmatter, and documents the 5-step pure-LLM workflow
        const skillPath = path.join(ROOT_DIR, '.agents', 'skills', 'corefeed-editor', 'SKILL.md');
        assert.equal(fs.existsSync(skillPath), true, '.agents/skills/corefeed-editor/SKILL.md must exist');
        const skillContent = fs.readFileSync(skillPath, 'utf8');
        assert.ok(/^---\r?\n[\s\S]*?name:\s*corefeed-editor[\s\S]*?description:\s*.+[\s\S]*?\r?\n---/.test(skillContent), 'SKILL.md must contain valid YAML frontmatter with name: corefeed-editor');
        assert.ok(skillContent.includes('ag-harvest.js'), 'SKILL.md must instruct running ag-harvest.js for raw network fetching');
        assert.ok(skillContent.includes('--inspect'), 'SKILL.md must instruct inspecting selected full texts via --inspect');
        assert.ok(skillContent.includes('ag_compiled.json'), 'SKILL.md must define the ag_compiled.json schema');
        assert.ok(skillContent.includes('translatedParagraphs'), 'SKILL.md must require full-text Chinese translatedParagraphs');
        assert.ok(skillContent.includes('ag:publish'), 'SKILL.md must instruct publishing via npm run ag:publish');

        // 15b. Verify package.json & ecosystem.config.js only retain pure server + ag:harvest + ag:publish scripts
        const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
        assert.ok(pkgJson.scripts['ag:harvest'], 'package.json must define ag:harvest');
        assert.ok(pkgJson.scripts['ag:publish'], 'package.json must define ag:publish');
        assert.equal(pkgJson.scripts['ag:auto'], undefined, 'ag:auto script must be removed');
        assert.equal(pkgJson.scripts['ag:daemon'], undefined, 'ag:daemon script must be removed');
        assert.equal(pkgJson.scripts['ag:schedule'], undefined, 'ag:schedule script must be removed');
        assert.equal(pkgJson.scripts['pm2:daemon'], undefined, 'pm2:daemon script must be removed');

        const ecosystemConfig = require('../ecosystem.config.js');
        assert.equal(ecosystemConfig.apps.length, 1, 'ecosystem.config.js must only contain the web server app');
        assert.equal(ecosystemConfig.apps[0].name, 'corefeed');

        // 15c. Scan all production JS files to ensure zero Google Translate / MyMemory / AI_API_KEY / AIService remnants
        const prodDirs = ['config', 'middleware', 'public/js', 'routes', 'scripts', 'services', 'utils'];
        const jsFiles = [path.join(ROOT_DIR, 'server.js')];
        for (const relDir of prodDirs) {
            const absDir = path.join(ROOT_DIR, relDir);
            if (!fs.existsSync(absDir)) continue;
            for (const entry of fs.readdirSync(absDir)) {
                if (entry.endsWith('.js')) {
                    jsFiles.push(path.join(absDir, entry));
                }
            }
        }

        for (const filePath of jsFiles) {
            const code = fs.readFileSync(filePath, 'utf8');
            const rel = path.relative(ROOT_DIR, filePath);
            assert.equal(code.includes('translate.googleapis.com'), false, `${rel} must NOT call Google Translate endpoint`);
            assert.equal(code.includes('mymemory.translated.net'), false, `${rel} must NOT call MyMemory translation endpoint`);
            assert.equal(code.includes('AI_API_KEY'), false, `${rel} must NOT reference external AI_API_KEY`);
            assert.equal(code.includes('ai_service'), false, `${rel} must NOT import removed ai_service`);
        }
    });
});
