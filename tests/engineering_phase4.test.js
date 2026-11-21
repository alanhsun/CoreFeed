/**
 * CoreFeed v3.0 — Phase 4 工程化、依赖归零、架构解耦与部署可靠性自动化测试套件
 *
 * 覆盖范围 (4 项核心契约测试)：
 *   1. node-cron v4 ScheduleManager 任意时区调度与统一 APP_VERSION 单一版本源校验
 *   2. 后端发布解耦、软路由零冗余懒加载 (cheerio/rss-parser/agent_tools 不加载) 与 COREFEED_REPO Fork 推导
 *   3. 前端原生 ES Modules (6 模块 + main.js)、ModalFocusController 焦点陷阱实测、ARIA 契约与轮播触摸/暂停交互
 *   4. Dockerfile 非 root 降权入口、docker-compose 安全加固与 CI 质量门禁契约验证
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { pathToFileURL } = require('node:url');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

process.env.NODE_ENV = 'test';
process.env.GITHUB_SYNC_ENABLED = 'false';
process.env.AUTO_UPDATE_ENABLED = 'false';

const ROOT_DIR = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const ScheduleManager = require('../utils/schedule_manager');
const stateManager = require('../services/state_manager');
const { server, services } = require('../server');

function rawHttpGet(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { headers }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
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

describe('CoreFeed v3.0 — Phase 4 Engineering, Decoupling & Reliability Tests', () => {
    let testServer;
    let baseUrl;
    let prevNewsSnapshot = null;

    before(async () => {
        prevNewsSnapshot = stateManager.get('newsData');
        if (!Array.isArray(prevNewsSnapshot) || prevNewsSnapshot.length < 2) {
            const seedNews = [
                {
                    id: 'p4-news-1',
                    title: 'Phase 4 Lead Story One',
                    translatedTitle: '阶段四测试头条要闻一：全球央行维持利率观望窗口',
                    summary: '用于验证 SSR 轮播暂停按钮与 ES Modules 加载的测试条目。',
                    url: 'https://example.com/phase4-1',
                    source: { name: 'Reuters', language: 'en' },
                    region: '国际',
                    category: '经济',
                    publishedAt: new Date().toISOString()
                },
                {
                    id: 'p4-news-2',
                    title: 'Phase 4 Lead Story Two',
                    translatedTitle: '阶段四测试头条要闻二：欧洲能源电网互联加速推进',
                    summary: '第二条测试要闻，用于确保 SSR 轮播渲染多条控制栏与暂停切换按钮。',
                    url: 'https://example.com/phase4-2',
                    source: { name: 'BBC News', language: 'en' },
                    region: '欧洲',
                    category: '能源',
                    publishedAt: new Date().toISOString()
                }
            ];
            services.newsService.setNewsData(seedNews, seedNews);
            stateManager.updateNewsData(seedNews, seedNews);
        }
        testServer = server.listen(0, '127.0.0.1');
        await new Promise((resolve) => testServer.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${testServer.address().port}`;
    });

    after(async () => {
        if (Array.isArray(prevNewsSnapshot)) {
            services.newsService.setNewsData(prevNewsSnapshot, prevNewsSnapshot);
            stateManager.updateNewsData(prevNewsSnapshot, prevNewsSnapshot);
        }
        if (testServer) {
            await new Promise((resolve) => testServer.close(resolve));
        }
    });

    it('1. node-cron v4 ScheduleManager supports arbitrary timezones & APP_VERSION is unified across server, API, and SSR', async () => {
        assert.match(String(pkg.dependencies['node-cron'] || ''), /^\^?4\./, 'node-cron must be upgraded to v4.x');
        assert.match(String(pkg.engines?.node || ''), />=20/, 'engines.node must require >=20.0.0');

        const sched = new ScheduleManager(null, null, stateManager, null, { pullAndApply: async () => ({ applied: false }) });
        try {
            // Active tasks across multiple timezones using node-cron v4 native getNextRun()
            for (const tz of ['Asia/Shanghai', 'UTC', 'America/New_York']) {
                sched.start({ enabled: true, updateTimes: ['08:00', '19:30'], timezone: tz, allowPeriodicInTest: false });
                assert.equal(sched.currentTasks.length, 2, `Should schedule 2 tasks in ${tz}`);
                assert.equal(sched.currentTasks[0].timezone, tz);
                assert.equal(typeof sched.currentTasks[0].task.getNextRun, 'function', 'node-cron v4 task must expose getNextRun()');
                const nextRunStr = sched.getNextExecutionTime();
                const nextRun = new Date(nextRunStr);
                assert.equal(typeof nextRunStr, 'string', `getNextExecutionTime() must return ISO string for ${tz}`);
                assert.ok(!Number.isNaN(nextRun.getTime()), `getNextExecutionTime() must parse to valid Date for ${tz}`);
                assert.ok(nextRun.getTime() > Date.now() - 1000, `Next run in ${tz} must be in the future`);
            }

            // Stopped fallback _computeNextRunInTimezone() must honor arbitrary non-UTC+8 timezones
            const fixedNow = new Date('2026-06-15T10:00:00.000Z');
            const nextUtc = sched._computeNextRunInTimezone('12:30', 'UTC', fixedNow);
            assert.equal(nextUtc.toISOString(), '2026-06-15T12:30:00.000Z');

            const nextShanghai = sched._computeNextRunInTimezone('19:30', 'Asia/Shanghai', fixedNow);
            // 19:30 Asia/Shanghai (UTC+8) = 11:30 UTC same day
            assert.equal(nextShanghai.toISOString(), '2026-06-15T11:30:00.000Z');

            const nextNewYork = sched._computeNextRunInTimezone('08:00', 'America/New_York', fixedNow);
            // 2026-06-15 is EDT (UTC-4): 08:00 EDT = 12:00 UTC same day
            assert.equal(nextNewYork.toISOString(), '2026-06-15T12:00:00.000Z');
        } finally {
            sched.stop();
            assert.equal(sched.currentTasks.length, 0);
        }

        // Verify /api/health and SSR assets all derive from package.json version
        const healthRes = await rawHttpGet(`${baseUrl}/api/health`);
        assert.equal(healthRes.statusCode, 200);
        const healthJson = JSON.parse(healthRes.body.toString('utf8'));
        assert.equal(healthJson.version, pkg.version, '/api/health version must match package.json');

        const homeRes = await rawHttpGet(`${baseUrl}/`, { 'Accept-Encoding': 'identity' });
        assert.equal(homeRes.statusCode, 200);
        const html = homeRes.body.toString('utf8');
        for (const expectedAsset of [
            `/css/utilities.css?v=${pkg.version}`,
            `/css/icons.css?v=${pkg.version}`,
            `/css/style.css?v=${pkg.version}`,
            `/images/logo.png?v=${pkg.version}`,
            `/js/main.js?v=${pkg.version}`
        ]) {
            assert.ok(html.includes(expectedAsset), `SSR HTML must reference unified assetVersion: ${expectedAsset}`);
        }
    });

    it('2. Backend decoupling, soft-router lazy loading (zero cheerio/rss-parser on boot), and COREFEED_REPO forkability', async () => {
        // Export parity between utils/snapshot_publisher.js and utils/github_sync.js
        const publisher = require('../utils/snapshot_publisher');
        const githubSync = require('../utils/github_sync');
        assert.equal(typeof publisher.readGitRefJson, 'function');
        assert.equal(typeof publisher.readSnapshotFromGitRef, 'function');
        for (const fnName of [
            'resolveRemoteBranchSha',
            'fetchRemoteSnapshotViaGit',
            'publishSnapshotToGitHub',
            'checkRemoteSnapshotCooldown'
        ]) {
            assert.equal(typeof publisher[fnName], 'function', `snapshot_publisher must export ${fnName}`);
            assert.equal(githubSync[fnName], publisher[fnName], `github_sync must re-export ${fnName} from snapshot_publisher`);
        }

        // Shared editorial text cleaner
        const { stripNewsCitationsAndMarkdown } = require('../utils/editorial_formatter');
        assert.equal(
            stripNewsCitationsAndMarkdown('### 标题\n**重要进展** [NEWS_1][NEWS_2] 已于今日公布。'),
            '标题 重要进展 已于今日公布。'
        );

        // Soft-router boot lazy-loading check in clean subprocess: requiring news_agent_service MUST NOT load agent_tools / cheerio / rss-parser
        const { stdout: cacheOut } = await execFileAsync(process.execPath, [
            '-e',
            `
            require('./services/news_agent_service');
            const loaded = Object.keys(require.cache);
            const bad = loaded.filter(p => /agent_tools\\.js$|node_modules[\\\\/](cheerio|rss-parser)[\\\\/]/.test(p));
            console.log(JSON.stringify({ badCount: bad.length, bad }));
            `
        ], { cwd: ROOT_DIR });
        const cacheReport = JSON.parse(cacheOut.trim());
        assert.equal(cacheReport.badCount, 0, `Soft-router boot must not eagerly load scraper modules: ${JSON.stringify(cacheReport.bad)}`);

        // COREFEED_REPO dynamic derivation across Node modules & Python CLI
        const forkEnv = {
            ...process.env,
            COREFEED_REPO: 'forkuser/MyCoreFeed',
            AG_GITHUB_BRANCH: 'custom-snap',
            GITHUB_SNAPSHOT_URL: '',
            COREFEED_SNAPSHOT_URL: ''
        };
        const { stdout: nodeForkOut } = await execFileAsync(process.execPath, [
            '-e',
            `
            const cfg = require('./config');
            const schema = require('./utils/snapshot_schema');
            const { GitHubSyncManager } = require('./utils/github_sync');
            const { resolveSnapshotRawDirUrl } = require('./services/audio_broadcast_service');
            const ghMgr = new GitHubSyncManager();
            console.log(JSON.stringify({
                repo: cfg.repo,
                cfgUrl: cfg.githubSync.snapshotUrl,
                schemaUrl: schema.buildDefaultSnapshotUrl(),
                resolvedUrl: ghMgr.resolveTargetSnapshotUrl(),
                audioBase: resolveSnapshotRawDirUrl()
            }));
            `
        ], { cwd: ROOT_DIR, env: forkEnv });
        const forkParsed = JSON.parse(nodeForkOut.trim());
        assert.equal(forkParsed.repo, 'forkuser/MyCoreFeed');
        assert.equal(forkParsed.cfgUrl, 'https://raw.githubusercontent.com/forkuser/MyCoreFeed/custom-snap/manifest.json');
        assert.equal(forkParsed.schemaUrl, 'https://raw.githubusercontent.com/forkuser/MyCoreFeed/custom-snap/manifest.json');
        assert.equal(forkParsed.resolvedUrl, 'https://raw.githubusercontent.com/forkuser/MyCoreFeed/custom-snap/manifest.json');
        assert.equal(forkParsed.audioBase, 'https://raw.githubusercontent.com/forkuser/MyCoreFeed/custom-snap');

        const { stdout: pyForkOut } = await execFileAsync('python3', [
            '-c',
            `
import importlib.util, json
spec = importlib.util.spec_from_file_location("corefeed_cli", "integrations/hermes-skill/corefeed-news/scripts/corefeed_cli.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(json.dumps({"snapshot_base": mod.DEFAULT_GITHUB_SNAPSHOT_BASE}))
            `
        ], { cwd: ROOT_DIR, env: forkEnv });
        const pyForkParsed = JSON.parse(pyForkOut.trim());
        assert.equal(pyForkParsed.snapshot_base, 'https://raw.githubusercontent.com/forkuser/MyCoreFeed/custom-snap');
    });

    it('3. Frontend native ES Modules, ARIA modal focus trap behavior, and Hero carousel pause/touch enhancements', async () => {
        // SSR HTML loads native ES module and includes ARIA dialog + hero pause button
        const homeRes = await rawHttpGet(`${baseUrl}/`, { 'Accept-Encoding': 'identity' });
        assert.equal(homeRes.statusCode, 200);
        const html = homeRes.body.toString('utf8');
        assert.ok(html.includes(`<script type="module" src="/js/main.js?v=${pkg.version}"></script>`), 'index.ejs must load main.js as type="module"');
        assert.ok(html.includes('id="settingsForm"') && html.includes('role="dialog"') && html.includes('aria-labelledby="settingsModalTitle"'), '#settingsForm must have ARIA dialog attributes');
        assert.ok(html.includes('id="fullTextDialog"') && html.includes('aria-labelledby="fullTextTitle"'), '#fullTextDialog must have ARIA dialog attributes');
        assert.ok(html.includes('hero-pause-btn') && html.includes('app.toggleHeroCarouselPause()'), 'SSR hero carousel must render explicit pause button');

        // All 6 ES modules are served cleanly over HTTP
        const expectedModules = [
            'sanitize.js',
            'modal_a11y.js',
            'hero_carousel.js',
            'reader_modal.js',
            'social_pulse.js',
            'audio_player.js'
        ];
        for (const modName of expectedModules) {
            const res = await rawHttpGet(`${baseUrl}/js/modules/${modName}`, { 'Accept-Encoding': 'gzip' });
            assert.equal(res.statusCode, 200, `/js/modules/${modName} must return HTTP 200`);
            assert.match(String(res.headers['content-type'] || ''), /javascript/i, `/js/modules/${modName} must serve JS MIME type`);
            const rawText = res.headers['content-encoding'] === 'gzip'
                ? zlib.gunzipSync(res.body).toString('utf8')
                : res.body.toString('utf8');
            assert.ok(rawText.includes('export '), `/js/modules/${modName} must be a valid ES module`);
        }

        // Behavioral unit test of sanitize.js & modal_a11y.js via native Node dynamic import()
        const sanitizeMod = await import(pathToFileURL(path.join(ROOT_DIR, 'public', 'js', 'modules', 'sanitize.js')).href);
        assert.equal(sanitizeMod.escapeHtml('<img src="x" onerror=\'1\'>'), '&lt;img src=&quot;x&quot; onerror=&#39;1&#39;&gt;');
        assert.equal(sanitizeMod.safeHttpUrl('javascript:alert(1)', '#'), '#');
        assert.equal(sanitizeMod.safeHttpUrl('https://reuters.com/world', '#'), 'https://reuters.com/world');
        assert.equal(sanitizeMod.safeAssetUrl('/api/audio/news.mp3', '#'), '/api/audio/news.mp3');
        assert.equal(sanitizeMod.safeAssetUrl('//evil.example/a.mp3', '#'), '#');

        const { ModalFocusController } = await import(pathToFileURL(path.join(ROOT_DIR, 'public', 'js', 'modules', 'modal_a11y.js')).href);

        // Lightweight DOM harness to verify Tab/Shift+Tab focus trap and focus restoration
        class FakeHTMLElement {
            constructor(id) {
                this.id = id;
                this.disabled = false;
                this.listeners = {};
                this.classList = {
                    _set: new Set(),
                    contains: (c) => this.classList._set.has(c),
                    add: (c) => this.classList._set.add(c),
                    remove: (c) => this.classList._set.delete(c)
                };
            }
            focus() {
                global.document.activeElement = this;
                this.focusCount = (this.focusCount || 0) + 1;
            }
            closest() { return null; }
            hasAttribute() { return false; }
            addEventListener(type, fn) { this.listeners[type] = fn; }
            removeEventListener(type, fn) { if (this.listeners[type] === fn) delete this.listeners[type]; }
        }

        const prevGlobals = {
            HTMLElement: global.HTMLElement,
            document: global.document,
            window: global.window,
            requestAnimationFrame: global.requestAnimationFrame
        };
        try {
            global.HTMLElement = FakeHTMLElement;
            const triggerBtn = new FakeHTMLElement('btnSettings');
            const firstInput = new FakeHTMLElement('cfgAutoUpdateEnabled');
            const lastBtn = new FakeHTMLElement('btnSaveSettings');
            const modalEl = new FakeHTMLElement('settingsModal');
            modalEl.querySelectorAll = () => [firstInput, lastBtn];
            modalEl.querySelector = (sel) => (sel === '#cfgAutoUpdateEnabled' ? firstInput : null);
            modalEl.contains = (el) => el === firstInput || el === lastBtn || el === modalEl;

            global.document = {
                activeElement: triggerBtn,
                contains: () => true
            };
            global.window = {};
            global.requestAnimationFrame = (cb) => cb();

            const focusCtrl = new ModalFocusController();
            focusCtrl.activate(modalEl, '#cfgAutoUpdateEnabled');
            assert.equal(global.document.activeElement, firstInput, 'activate() should focus initial element');

            // Shift+Tab from first element wraps to last element
            let prevented = false;
            modalEl.listeners.keydown({ key: 'Tab', shiftKey: true, preventDefault: () => { prevented = true; } });
            assert.equal(prevented, true);
            assert.equal(global.document.activeElement, lastBtn, 'Shift+Tab on first focusable must wrap to last');

            // Tab from last element wraps to first element
            prevented = false;
            modalEl.listeners.keydown({ key: 'Tab', shiftKey: false, preventDefault: () => { prevented = true; } });
            assert.equal(prevented, true);
            assert.equal(global.document.activeElement, firstInput, 'Tab on last focusable must wrap to first');

            // Deactivating restores focus to original trigger button and detaches listener
            focusCtrl.deactivate(modalEl);
            assert.equal(global.document.activeElement, triggerBtn, 'deactivate() must restore focus to triggering element');
            assert.equal(modalEl.listeners.keydown, undefined, 'deactivate() must remove keydown listener');
        } finally {
            global.HTMLElement = prevGlobals.HTMLElement;
            global.document = prevGlobals.document;
            global.window = prevGlobals.window;
            global.requestAnimationFrame = prevGlobals.requestAnimationFrame;
        }

        const heroSrc = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'modules', 'hero_carousel.js'), 'utf8');
        assert.ok(heroSrc.includes('initHeroTouchGestures') && heroSrc.includes("'touchstart'") && heroSrc.includes("'touchend'"));
        assert.ok(heroSrc.includes('toggleHeroCarouselPause') && heroSrc.includes('heroCarouselUserPaused'));
    });

    it('4. Docker non-root hardening, docker-compose security, ESLint config, and CI workflow reuse contracts', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT_DIR, 'Dockerfile'), 'utf8');
        const entrypoint = fs.readFileSync(path.join(ROOT_DIR, 'docker-entrypoint.sh'), 'utf8');
        const compose = fs.readFileSync(path.join(ROOT_DIR, 'docker-compose.yml'), 'utf8');
        const testWorkflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'test.yml'), 'utf8');
        const dockerWorkflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'docker-publish.yml'), 'utf8');
        const eslintConfig = fs.readFileSync(path.join(ROOT_DIR, 'eslint.config.mjs'), 'utf8');

        // Dockerfile & entrypoint
        assert.ok(dockerfile.includes('FROM node:22-alpine3.21'), 'Dockerfile must pin node:22-alpine3.21');
        assert.ok(dockerfile.includes('su-exec'), 'Dockerfile must install su-exec');
        assert.ok(dockerfile.includes('COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh'));
        assert.ok(dockerfile.includes('ENTRYPOINT ["docker-entrypoint.sh"]'));
        assert.ok(dockerfile.includes('CMD ["node", "server.js"]'));
        assert.ok(dockerfile.includes('chown -R node:node /app'));
        assert.ok(entrypoint.includes('exec su-exec node dumb-init -- "$@"'));
        assert.ok(entrypoint.includes('chown -R node:node /app/data /app/logs'));

        // docker-compose
        assert.ok(compose.includes('no-new-privileges:true'), 'docker-compose.yml must set no-new-privileges:true');
        assert.ok(compose.includes('COREFEED_REPO'), 'docker-compose.yml must pass through COREFEED_REPO');

        // ESLint config
        assert.ok(eslintConfig.includes("sourceType: 'commonjs'") && eslintConfig.includes("sourceType: 'module'"));
        assert.ok(eslintConfig.includes("'no-undef': 'error'"));

        // CI workflows
        assert.ok(testWorkflow.includes('workflow_call:'), 'test.yml must support workflow_call reuse');
        assert.ok(testWorkflow.includes('npm run lint'));
        assert.ok(testWorkflow.includes('npm run check:security'));
        assert.ok(testWorkflow.includes('shellcheck -S warning'));
        assert.ok(testWorkflow.includes('scripts/ag-generate-tts.py'));

        assert.ok(dockerWorkflow.includes('uses: ./.github/workflows/test.yml'), 'docker-publish.yml must reuse test.yml');
        assert.ok(dockerWorkflow.includes('/api/health') && dockerWorkflow.includes('NODE_UID') && dockerWorkflow.includes('SKILL.md'));
    });
});
