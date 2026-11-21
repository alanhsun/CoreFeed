/**
 * CoreFeed v2.0 — Phase 1 Security & Stability Hardening Test Suite
 *
 * 覆盖验证项：
 *  1. SSR 存储型 XSS 防护（__INITIAL_STATE__ 逃逸、htmlContent 重建、javascript: 拦截、无内联 onclick 注入）
 *  2. 鉴权、CSRF、CORS、配置白名单与 PUBLISH_SECRET 空串占位修复
 *  3. /api/image-proxy 数组查询防崩溃、SSRF 全私网/IPv6/重定向跳拦截、SVG/MIME 伪装拒绝、安全头与字节上限缓存
 *  4. /api/news/more 纯只读不修改全局状态
 *  5. 原子 JSON 写入、损坏 JSON 降级读取、并发同步锁串行/合并、音频 SHA-256 mtime 缓存
 *  6. .dockerignore 对 Hermes SKILL.md 的放行契约与安全响应头
 */
process.env.NODE_ENV = 'test';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../config');
const stateManager = require('../services/state_manager');
const {
    readJsonFile,
    writeJsonFile,
    serializeForScript,
    isSafeHttpUrl,
    ByteBoundedCache
} = require('../utils/helpers');
const { convertSummaryToRichHtml, renderSafeSummaryHtml } = require('../utils/editorial_formatter');
const { verifyPublishSecret, getExpectedPublishSecret } = require('../middleware/auth');
const { createImageProxyHandler, isBlockedIpAddress } = require('../routes/image_proxy');
const { AudioBroadcastService, computeBufferSha256 } = require('../services/audio_broadcast_service');
const { server, services } = require('../server');

const VALID_1X1_PNG = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082',
    'hex'
);

function createMockRes() {
    const res = {
        statusCode: 200,
        headers: {},
        body: null,
        ended: false,
        status(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(k, v) {
            this.headers[String(k).toLowerCase()] = v;
        },
        send(payload) {
            this.body = payload;
            this.ended = true;
            return this;
        },
        end(payload) {
            if (payload !== undefined) this.body = payload;
            this.ended = true;
            return this;
        }
    };
    return res;
}

describe('CoreFeed v2.0 — Phase 1 Security & Stability Hardening Suite', () => {
    let baseUrl = '';
    let tempDir = '';
    let prevNoProxy;
    let prevPublishSecret;
    let prevPublishApiKey;
    let prevHttpsProxy;
    let originalSettingsBackup = null;
    const settingsPath = config.storage.settingsFile;
    const trackedDataFiles = [
        config.storage.newsFile,
        config.storage.summaryFile,
        config.storage.stateFile
    ];
    const dataBackups = new Map();

    before(async () => {
        prevNoProxy = process.env.NO_PROXY;
        prevPublishSecret = process.env.PUBLISH_SECRET;
        prevPublishApiKey = process.env.PUBLISH_API_KEY;
        prevHttpsProxy = process.env.HTTPS_PROXY;
        process.env.NO_PROXY = '127.0.0.1,localhost';

        if (fs.existsSync(settingsPath)) {
            originalSettingsBackup = fs.readFileSync(settingsPath, 'utf8');
        }
        for (const f of trackedDataFiles) {
            if (f && fs.existsSync(f)) {
                dataBackups.set(f, fs.readFileSync(f));
            }
        }
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-sec-test-'));

        if (!server.listening) {
            await new Promise((resolve, reject) => {
                server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
            });
        }
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (services.scheduleManager) services.scheduleManager.stop();
        if (prevNoProxy === undefined) delete process.env.NO_PROXY;
        else process.env.NO_PROXY = prevNoProxy;
        if (prevPublishSecret === undefined) delete process.env.PUBLISH_SECRET;
        else process.env.PUBLISH_SECRET = prevPublishSecret;
        if (prevPublishApiKey === undefined) delete process.env.PUBLISH_API_KEY;
        else process.env.PUBLISH_API_KEY = prevPublishApiKey;
        if (prevHttpsProxy === undefined) delete process.env.HTTPS_PROXY;
        else process.env.HTTPS_PROXY = prevHttpsProxy;

        if (originalSettingsBackup !== null) {
            fs.writeFileSync(settingsPath, originalSettingsBackup, 'utf8');
        } else if (fs.existsSync(settingsPath)) {
            fs.unlinkSync(settingsPath);
        }
        for (const f of trackedDataFiles) {
            if (!f) continue;
            if (dataBackups.has(f)) {
                fs.writeFileSync(f, dataBackups.get(f));
            } else if (fs.existsSync(f)) {
                fs.unlinkSync(f);
            }
        }
        config.reload();

        fs.rmSync(tempDir, { recursive: true, force: true });
        if (server.listening) {
            await new Promise((resolve) => server.close(() => resolve()));
        }
    });

    it('1. Stored XSS defense: SSR __INITIAL_STATE__ escapes </script>, summary htmlContent is always regenerated safely, and javascript:/quote URLs are neutralized', async () => {
        const maliciousNews = [
            {
                id: 'xss-1',
                title: 'Breaking </script><script>window.__xss=1</script> <img src=x onerror=alert(1)>',
                translatedTitle: '测试标题 </script><script>alert("pwn")</script>',
                summary: '摘要含 </script> 与 <svg onload=alert(1)>',
                url: "https://example.com/news/a');alert(1);//",
                urlToImage: 'javascript:alert(9)',
                region: "美国');alert(1);//",
                category: "科技');alert(2);//",
                source: { name: 'Reuters' },
                relatedSources: [
                    { name: 'EvilSrc', url: 'javascript:alert(3)', title: 'Bad' },
                    { name: 'SafeSrc', url: 'https://www.reuters.com/world/safe-1', title: 'Good' }
                ],
                publishedAt: new Date().toISOString(),
                aiCompiled: true
            },
            {
                id: 'xss-2',
                title: 'Second story',
                translatedTitle: '第二条测试新闻',
                summary: '正常导语',
                url: 'javascript:alert(4)',
                region: '欧洲',
                category: '财经',
                source: { name: 'BBC' },
                publishedAt: new Date().toISOString(),
                aiCompiled: true
            }
        ];

        const maliciousSummary = {
            title: '综述 </script><script>alert(5)</script>',
            content: '### 宏观板块\n\n第一条引用 [NEWS_1] 与危险链接引用 [NEWS_2] 与原文 `<script>alert(6)</script>`。',
            htmlContent: '<script>alert("injected")</script><img src=x onerror=alert(7)><a class="news-ref-link" href="javascript:alert(8)">fake</a>',
            regions: ['美国'],
            generatedAt: new Date().toISOString(),
            wordCount: 80
        };

        stateManager.reset();
        stateManager.updateNewsData(maliciousNews, maliciousNews, new Date().toISOString());
        stateManager.updateSummaryArticle(maliciousSummary);

        // 1a. Verify serializeForScript directly
        const serialized = serializeForScript({ t: '</script>&>\u2028\u2029' });
        assert.ok(!serialized.includes('</script>'));
        assert.ok(serialized.includes('\\u003c/script\\u003e'));
        assert.ok(serialized.includes('\\u2028'));

        // 1b. Verify SSR HTML page
        const ssrRes = await fetch(`${baseUrl}/`);
        assert.equal(ssrRes.status, 200);
        const html = await ssrRes.text();

        assert.ok(!html.includes('<script>window.__xss=1</script>'), 'SSR must escape </script><script> in news JSON');
        assert.ok(!html.includes('<script>alert("pwn")</script>'), 'SSR must escape </script><script> in translatedTitle');
        assert.ok(!html.includes('<script>alert("injected")</script>'), 'SSR must never trust raw summaryArticle.htmlContent');
        assert.ok(!html.includes('onerror=alert(7)'), 'SSR summary must strip injected img onerror');
        assert.ok(!html.includes('href="javascript:'), 'SSR must block all javascript: href URLs');
        assert.ok(!html.includes('src="javascript:'), 'SSR must block javascript: image URLs');
        assert.ok(!html.includes('onclick="app.handleCardBodyClick('), 'SSR must use delegated data-card-url instead of inline onclick');
        assert.ok(html.includes('data-card-url='), 'SSR card trigger must expose data-card-url attribute');

        // 1c. Verify /api/summary & /api/latest-data also regenerate safe htmlContent
        const sumRes = await fetch(`${baseUrl}/api/summary`);
        const sumJson = await sumRes.json();
        assert.equal(sumJson.success, true);
        assert.ok(!sumJson.article.htmlContent.includes('<script>'));
        assert.ok(!sumJson.article.htmlContent.includes('onerror='));
        assert.ok(!sumJson.article.htmlContent.includes('javascript:'));
        assert.ok(sumJson.article.htmlContent.includes('<span class="news-ref-link"'), 'Unsafe article URL citation must degrade to non-link span');

        // 1d. Verify legacy summary with htmlContent-only (no content) still strips raw tags
        const legacyOnlyHtml = renderSafeSummaryHtml({
            htmlContent: '<script>evil()</script><p>安全文本内容</p><img src=x onerror=alert(1)>'
        }, []);
        assert.ok(!legacyOnlyHtml.includes('<script>'));
        assert.ok(!legacyOnlyHtml.includes('onerror='));
        assert.ok(legacyOnlyHtml.includes('安全文本内容'));

        // 1e. Verify public/js/main.js uses event delegation & URL/HTML sanitizers instead of inline interpolated onclicks
        const mainJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'main.js'), 'utf8');
        assert.ok(!mainJs.includes('onclick="app.setRegionFilter('));
        assert.ok(!mainJs.includes('onclick="app.setCategoryFilter('));
        assert.ok(!mainJs.includes('onclick="app.setPulseRegionFilter('));
        assert.ok(!mainJs.includes('onclick="app.setPulseLangFilter('));
        assert.ok(!mainJs.includes('onclick="app.setPulseCategoryFilter('));
        assert.ok(!mainJs.includes('onclick="app.handleCardBodyClick('));
        assert.ok(mainJs.includes('sanitizeSummaryHtml('));
        assert.ok(mainJs.includes('safeHttpUrl('));
    });

    it('2. Auth, CSRF, CORS, security headers, and dynamic config allowlist enforcement', async () => {
        delete process.env.PUBLISH_SECRET;
        delete process.env.PUBLISH_API_KEY;

        // 2a. Security headers & disabled x-powered-by
        const healthRes = await fetch(`${baseUrl}/api/health`);
        assert.equal(healthRes.status, 200);
        assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(healthRes.headers.get('x-frame-options'), 'SAMEORIGIN');
        assert.ok(healthRes.headers.get('referrer-policy'));
        assert.equal(healthRes.headers.get('x-powered-by'), null);

        // 2b. CORS blocks cross-origin reads, allows same-origin
        const crossCorsRes = await fetch(`${baseUrl}/api/status`, {
            headers: { Origin: 'https://evil.example' }
        });
        assert.equal(crossCorsRes.headers.get('access-control-allow-origin'), null);

        const sameCorsRes = await fetch(`${baseUrl}/api/status`, {
            headers: { Origin: baseUrl }
        });
        assert.equal(sameCorsRes.headers.get('access-control-allow-origin'), baseUrl);

        // 2c. Cross-origin CSRF blocked on POST /api/config & POST /api/schedule/config
        const csrfOriginRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://evil.example'
            },
            body: JSON.stringify({ AUTO_UPDATE_ENABLED: false })
        });
        assert.equal(csrfOriginRes.status, 403);

        const csrfNullOriginRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'null'
            },
            body: JSON.stringify({ AUTO_UPDATE_ENABLED: false })
        });
        assert.equal(csrfNullOriginRes.status, 403);

        const csrfSecFetchRes = await fetch(`${baseUrl}/api/schedule/config`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Sec-Fetch-Site': 'cross-site'
            },
            body: JSON.stringify({ enabled: true, updateTimes: ['08:00'] })
        });
        assert.equal(csrfSecFetchRes.status, 403);

        // 2d. Config allowlist rejects PUBLISH_SECRET, HTTPS_PROXY, NODE_ENV, and javascript: snapshot URL
        const secretInjectRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: baseUrl },
            body: JSON.stringify({ PUBLISH_SECRET: 'attacker-secret' })
        });
        assert.equal(secretInjectRes.status, 400);
        assert.notEqual(process.env.PUBLISH_SECRET, 'attacker-secret');

        const proxyInjectRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: baseUrl },
            body: JSON.stringify({ HTTPS_PROXY: 'http://evil-proxy.example:8888' })
        });
        assert.equal(proxyInjectRes.status, 400);
        assert.notEqual(process.env.HTTPS_PROXY, 'http://evil-proxy.example:8888');

        const badSnapUrlRes = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: baseUrl },
            body: JSON.stringify({ GITHUB_SNAPSHOT_URL: 'javascript:alert(1)' })
        });
        assert.equal(badSnapUrlRes.status, 400);

        // 2e. Empty PUBLISH_SECRET="" placeholder must NOT shadow PUBLISH_API_KEY
        process.env.PUBLISH_SECRET = '';
        process.env.PUBLISH_API_KEY = 'fallback-key-xyz';
        assert.equal(getExpectedPublishSecret(), 'fallback-key-xyz');

        const unauthPublish = await fetch(`${baseUrl}/api/agent/publish`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ news: [] })
        });
        assert.equal(unauthPublish.status, 401);

        // 2f. pull-github: trigger:'ui' body alone cannot bypass secret; cross-origin X-Requested-With gets 403; explicit snapshotUrl requires secret
        process.env.PUBLISH_SECRET = 'strict-pull-secret';
        delete process.env.PUBLISH_API_KEY;

        const triggerBypassRes = await fetch(`${baseUrl}/api/agent/pull-github`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger: 'ui', force: true })
        });
        assert.equal(triggerBypassRes.status, 401, 'body.trigger="ui" without X-Requested-With header must NOT bypass auth');

        const crossOriginPullRes = await fetch(`${baseUrl}/api/agent/pull-github`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Origin: 'https://evil.example',
                'X-Requested-With': 'CoreFeed-WebUI'
            },
            body: JSON.stringify({ trigger: 'ui', force: true })
        });
        assert.equal(crossOriginPullRes.status, 403, 'Cross-origin pull-github with WebUI header must be rejected with 403');

        const explicitUrlPullRes = await fetch(`${baseUrl}/api/agent/pull-github`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Requested-With': 'CoreFeed-WebUI'
            },
            body: JSON.stringify({ snapshotUrl: 'https://evil.example/latest.json' })
        });
        assert.equal(explicitUrlPullRes.status, 401, 'Explicit snapshotUrl must require PUBLISH_SECRET');

        delete process.env.PUBLISH_SECRET;
    });

    it('3. /api/image-proxy hardening: duplicate query params do not crash server, SSRF ranges & redirect hops blocked, SVG/MIME spoofing rejected, byte-bounded cache works', async () => {
        // 3a. Duplicate query param (?url=a&url=b) must return 400 and NOT crash server
        const dupRes = await fetch(`${baseUrl}/api/image-proxy?url=https://a.example/1.jpg&url=https://b.example/2.jpg`);
        assert.equal(dupRes.status, 400);
        const stillAlive = await fetch(`${baseUrl}/api/health`);
        assert.equal(stillAlive.status, 200);

        // 3b. Direct private / loopback / metadata / IPv6 / decimal IP SSRF targets all return 403
        const ssrfTargets = [
            'http://127.0.0.1/secret',
            'http://172.17.0.1/docker-api',
            'http://[::1]:3120/api/config',
            'http://[::ffff:127.0.0.1]/secret',
            'http://169.254.169.254/latest/meta-data/',
            'http://10.0.0.1/router',
            'http://192.168.1.1/admin',
            'http://localhost:3120/api/health',
            'http://2130706433/decimal-loopback'
        ];
        for (const target of ssrfTargets) {
            const r = await fetch(`${baseUrl}/api/image-proxy?url=${encodeURIComponent(target)}`);
            assert.equal(r.status, 403, `SSRF target must be rejected with 403: ${target}`);
        }
        assert.equal(isBlockedIpAddress('::ffff:7f00:1'), true);
        assert.equal(isBlockedIpAddress('100.64.0.1'), true);
        assert.equal(isBlockedIpAddress('93.184.216.34'), false);

        // 3c. Redirect hop to 127.0.0.1 blocked before second request is made
        let hopRequests = [];
        const redirectHandler = createImageProxyHandler({
            dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
            httpGet: async (url) => {
                hopRequests.push(url);
                return {
                    status: 302,
                    headers: { location: 'http://127.0.0.1:9999/internal-secret' },
                    data: Buffer.alloc(0)
                };
            }
        });
        const redirRes = createMockRes();
        await new Promise((resolve) => {
            redirectHandler({ query: { url: 'https://cdn.public-news.example/photo.jpg' } }, redirRes, () => resolve());
            setImmediate(resolve);
        });
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(redirRes.statusCode, 403, '302 redirect to 127.0.0.1 must be blocked with 403');
        assert.equal(hopRequests.length, 1, 'Must never execute request to 127.0.0.1 redirect target');

        // 3d. SVG same-origin XSS rejected (415) & spoofed image/jpeg containing <svg> rejected (415)
        const svgHandler = createImageProxyHandler({
            dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
            httpGet: async () => ({
                status: 200,
                headers: { 'content-type': 'image/svg+xml' },
                data: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>')
            })
        });
        const svgRes = createMockRes();
        svgHandler({ query: { url: 'https://cdn.public-news.example/evil.svg' } }, svgRes, () => {});
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(svgRes.statusCode, 415, 'image/svg+xml must be rejected');

        const spoofHandler = createImageProxyHandler({
            dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
            httpGet: async () => ({
                status: 200,
                headers: { 'content-type': 'image/jpeg' },
                data: Buffer.from('<svg onload=alert(1)>' + ' '.repeat(120))
            })
        });
        const spoofRes = createMockRes();
        spoofHandler({ query: { url: 'https://cdn.public-news.example/spoof.jpg' } }, spoofRes, () => {});
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(spoofRes.statusCode, 415, 'Spoofed raster MIME with SVG body must be rejected');

        // 3e. Valid raster PNG succeeds with nosniff + CSP sandbox headers
        const validHandler = createImageProxyHandler({
            dnsLookup: async () => [{ address: '93.184.216.34', family: 4 }],
            httpGet: async () => ({
                status: 200,
                headers: { 'content-type': 'image/png' },
                data: VALID_1X1_PNG
            })
        });
        const okRes = createMockRes();
        validHandler({ query: { url: 'https://cdn.public-news.example/ok.png' } }, okRes, () => {});
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(okRes.statusCode, 200);
        assert.equal(okRes.headers['content-type'], 'image/png');
        assert.equal(okRes.headers['x-content-type-options'], 'nosniff');
        assert.equal(okRes.headers['content-security-policy'], "sandbox; default-src 'none'");

        // 3f. ByteBoundedCache strictly enforces maxBytes ceiling
        const boundedCache = new ByteBoundedCache({ maxBytes: 2048, maxItems: 10, ttl: 60000 });
        boundedCache.set('k1', { buffer: Buffer.alloc(1000) });
        boundedCache.set('k2', { buffer: Buffer.alloc(1000) });
        assert.equal(boundedCache.size(), 2);
        assert.equal(boundedCache.bytes(), 2000);
        boundedCache.set('k3', { buffer: Buffer.alloc(1000) });
        assert.ok(boundedCache.bytes() <= 2048, 'ByteBoundedCache must evict oldest entries to stay within maxBytes');
        assert.equal(boundedCache.get('k1'), null, 'Oldest entry k1 must be evicted');
        assert.ok(boundedCache.get('k3'), 'Newest entry k3 must remain cached');
    });

    it('4. Stability: /api/news/more is strictly read-only, atomic writeJsonFile + corrupt readJsonFile tolerate faults, concurrent sync coalesces, audio SHA cache works, and .dockerignore retains SKILL.md', async () => {
        // 4a. GET /api/news/more called 100 times never mutates stateManager.newsData
        const pool = Array.from({ length: 40 }, (_, i) => ({
            id: `more-${i}`,
            title: `Story ${i}`,
            translatedTitle: `测试新闻 ${i}`,
            url: `https://example.com/story/${i}`,
            region: '国际',
            category: '政经',
            source: { name: 'Reuters' },
            publishedAt: new Date().toISOString(),
            aiCompiled: true
        }));
        stateManager.updateNewsData(pool.slice(0, 10), pool, new Date().toISOString());
        assert.equal(stateManager.get('newsData').length, 10);

        for (let i = 0; i < 100; i++) {
            const res = await fetch(`${baseUrl}/api/news/more?offset=10&limit=100`);
            assert.equal(res.status, 200);
            const data = await res.json();
            assert.equal(data.success, true);
            assert.equal(data.news.length, 30, 'Should slice remaining 30 items and cap limit <= 50');
        }
        assert.equal(stateManager.get('newsData').length, 10, 'GET /api/news/more must NEVER mutate shared newsData');

        // 4b. Atomic writeJsonFile preserves original file on serialization failure & leaves no tmp files
        const atomicPath = path.join(tempDir, 'atomic.json');
        await writeJsonFile(atomicPath, { version: 1, ok: true });
        const circular = {};
        circular.self = circular;
        await assert.rejects(() => writeJsonFile(atomicPath, circular));
        const intact = await readJsonFile(atomicPath);
        assert.deepEqual(intact, { version: 1, ok: true });
        const leftoverTmps = fs.readdirSync(tempDir).filter((f) => f.endsWith('.tmp'));
        assert.equal(leftoverTmps.length, 0);

        // 4c. Corrupt JSON file degrades safely to defaultValue
        const corruptPath = path.join(tempDir, 'corrupt.json');
        fs.writeFileSync(corruptPath, '{"broken": [1, 2,', 'utf8');
        const recovered = await readJsonFile(corruptPath, { fallback: true });
        assert.deepEqual(recovered, { fallback: true });

        // 4d. Concurrent GitHubSyncManager.pullAndApply coalesces identical force pulls without lock race
        let upstreamHits = 0;
        const slowSnapServer = http.createServer((req, res) => {
            upstreamHits++;
            setTimeout(() => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    version: '2.0',
                    publishedAt: new Date().toISOString(),
                    publishedBy: 'concurrency-test',
                    news: [
                        {
                            id: 'conc-1',
                            title: 'Concurrent Sync Test',
                            translatedTitle: '并发同步测试新闻',
                            summary: '用于验证并发同步锁不会竞态解锁的测试条目。',
                            url: 'https://www.reuters.com/world/conc-1',
                            region: '国际',
                            category: '政经',
                            source: { name: 'Reuters' },
                            publishedAt: new Date().toISOString(),
                            aiCompiled: true
                        }
                    ],
                    summaryArticle: {
                        title: '并发测试综述',
                        content: '### 并发测试\n\n单飞锁测试 [NEWS_1]。'
                    }
                }));
            }, 120);
        });
        await new Promise((resolve) => slowSnapServer.listen(0, '127.0.0.1', resolve));
        const slowUrl = `http://127.0.0.1:${slowSnapServer.address().port}/ag-snapshot/latest.json`;
        try {
            const p1 = services.githubSyncManager.pullAndApply({ snapshotUrl: slowUrl, force: true, trigger: 'test-1', awaitAudioSync: false });
            const p2 = services.githubSyncManager.pullAndApply({ snapshotUrl: slowUrl, force: true, trigger: 'test-2', awaitAudioSync: false });
            const p3 = services.githubSyncManager.pullAndApply({ snapshotUrl: slowUrl, force: false, trigger: 'test-3', awaitAudioSync: false });
            const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
            assert.equal(upstreamHits, 1, 'Concurrent identical force pulls must coalesce into a single upstream fetch');
            assert.equal(r1.applied, true);
            assert.equal(r2.applied, true);
            assert.equal(r3.skipped, true);
            assert.equal(r3.reason, 'sync-in-progress');
            assert.equal(services.githubSyncManager.isSyncing, false);
        } finally {
            await new Promise((resolve) => slowSnapServer.close(() => resolve()));
        }

        // 4e. AudioBroadcastService SHA-256 mtime/size cache avoids re-reading disk on every check
        const audioSvc = new AudioBroadcastService(null, stateManager);
        const dummyMp3Path = path.join(tempDir, 'briefing-news.mp3');
        const buf1 = Buffer.alloc(512, 0x41);
        fs.writeFileSync(dummyMp3Path, buf1);
        const sha1 = computeBufferSha256(buf1);
        assert.equal(audioSvc.isLocalAudioFresh({ sha256: sha1 }, dummyMp3Path), true);
        assert.equal(audioSvc._shaCache.size, 1);
        const cachedBefore = audioSvc._shaCache.get(path.resolve(dummyMp3Path));
        assert.equal(audioSvc.isLocalAudioFresh({ sha256: sha1 }, dummyMp3Path), true);
        assert.equal(audioSvc._shaCache.get(path.resolve(dummyMp3Path)), cachedBefore, 'Second check must hit _shaCache');
        // Mutating file size invalidates cache
        const buf2 = Buffer.alloc(640, 0x42);
        fs.writeFileSync(dummyMp3Path, buf2);
        assert.equal(audioSvc.isLocalAudioFresh({ sha256: sha1 }, dummyMp3Path), false);
        assert.equal(audioSvc.isLocalAudioFresh({ sha256: computeBufferSha256(buf2) }, dummyMp3Path), true);

        // 4f. .dockerignore allows Hermes SKILL.md and /api/ai/hermes-skill/SKILL.md returns 200
        const dockerignore = fs.readFileSync(path.join(__dirname, '..', '.dockerignore'), 'utf8');
        const mdIdx = dockerignore.indexOf('*.md');
        const allowIdx = dockerignore.indexOf('!integrations/hermes-skill/corefeed-news/SKILL.md');
        assert.ok(mdIdx >= 0 && allowIdx > mdIdx, '.dockerignore must re-include SKILL.md after *.md');
        assert.ok(dockerignore.includes('config/voices'), '.dockerignore should exclude TTS voice samples');

        const skillRes = await fetch(`${baseUrl}/api/ai/hermes-skill/SKILL.md`);
        assert.equal(skillRes.status, 200);
        const skillText = await skillRes.text();
        assert.ok(skillText.includes('corefeed-news'));
    });
});
