/**
 * CoreFeed v3.0 — `deploy-router.sh` 软路由一键部署与秒级热更新脚本端到端自动化测试套件
 *
 * 覆盖范围 (7 项端到端测试)：
 *   1. POSIX Shell 语法校验 (`sh -n` / `dash -n`)（含 `docker-entrypoint.sh`）与 Windows PowerShell 免转义一键 SSH 命令契约验证
 *   2. 全新安装 / `.env.example` 默认占位符被旧容器真实环境变量覆盖 + `--rebuild` 镜像构建 + `/api/health` & `/api/schedule/config` 实时激活
 *   3. 已有 `.env` 自定义非空配置保留 + 空字段自动回填 + 特殊字符安全写入 + 旧版 `06:00,16:30` 与 `data/settings.json` 升级同步
 *   4. 首次部署（无历史容器、`docker inspect` 返回非零退出码）容错与默认配置初始化验证
 *   5. 健康检查失败自动回滚（`docker logs` → `docker rm -f corefeed` → `docker rename corefeed-prev corefeed` → `docker start corefeed`）
 *   6. 依赖清单 (`package-lock.json`) SHA-256 变更自动触发 `docker build`（不传 `--rebuild`），未变更时跳过重建 + 清理已删旧源码文件
 *   7. 自定义 `UPDATE_TIMES` 与 `COREFEED_REPO` 完整保留不被覆写，且 `--reset-schedule` 显式重置回默认调度
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ROOT_DIR = path.resolve(__dirname, '..');
const DEPLOY_SCRIPT = path.join(ROOT_DIR, 'deploy-router.sh');
const ENTRYPOINT_SCRIPT = path.join(ROOT_DIR, 'docker-entrypoint.sh');
const README_PATH = path.join(ROOT_DIR, 'README.md');
const ENV_EXAMPLE_PATH = path.join(ROOT_DIR, '.env.example');

function parseDotEnvFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eqIdx = rawLine.indexOf('=');
        if (eqIdx === -1) continue;
        const key = rawLine.slice(0, eqIdx).trim();
        const val = rawLine.slice(eqIdx + 1);
        result[key] = val;
    }
    return result;
}

describe('CoreFeed v3.0 — deploy-router.sh End-to-End Tests', () => {
    let workspaceDir = '';
    let fixtureTarballPath = '';
    let fixtureTarballV2Path = '';
    let mockServer = null;
    let mockServerPort = 0;
    let schedulePostRequests = [];
    let mockHealthStatusCode = 200;

    async function buildFixtureTarball(name, { lockfileContent, extraPublicFile = null }) {
        const buildDir = path.join(workspaceDir, `tarball-build-${name}`);
        const repoFolder = path.join(buildDir, 'CoreFeed-main');
        fs.mkdirSync(path.join(repoFolder, 'scripts'), { recursive: true });
        fs.mkdirSync(path.join(repoFolder, 'public', 'js'), { recursive: true });
        fs.copyFileSync(ENV_EXAMPLE_PATH, path.join(repoFolder, '.env.example'));
        fs.writeFileSync(path.join(repoFolder, '.dockerignore'), 'node_modules\ndata\nlogs\n', 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'server.js'), '// mock server.js\n', 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'package.json'), '{"name":"corefeed","version":"3.0.0"}\n', 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'package-lock.json'), lockfileContent, 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'public', 'js', 'main.js'), '// fresh main.js\n', 'utf8');
        if (extraPublicFile) {
            fs.writeFileSync(path.join(repoFolder, 'public', 'js', extraPublicFile), '// extra\n', 'utf8');
        }
        const tarballPath = path.join(workspaceDir, `${name}.tar.gz`);
        await execFileAsync('tar', ['-czf', tarballPath, '-C', buildDir, 'CoreFeed-main']);
        return tarballPath;
    }

    before(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-deploy-test-'));

        fixtureTarballPath = await buildFixtureTarball('CoreFeed-main', {
            lockfileContent: '{"name":"corefeed","lockfileVersion":3,"packages":{"":{"version":"3.0.0"}}}\n'
        });
        fixtureTarballV2Path = await buildFixtureTarball('CoreFeed-main-v2', {
            lockfileContent: '{"name":"corefeed","lockfileVersion":3,"packages":{"":{"version":"3.0.1"}}}\n'
        });

        // Start local HTTP server to serve tarballs, /api/health, /api/schedule/config, and /api/agent/pull-github
        mockServer = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/CoreFeed-main.tar.gz') {
                res.writeHead(200, { 'Content-Type': 'application/gzip' });
                fs.createReadStream(fixtureTarballPath).pipe(res);
                return;
            }
            if (req.method === 'GET' && req.url === '/CoreFeed-main-v2.tar.gz') {
                res.writeHead(200, { 'Content-Type': 'application/gzip' });
                fs.createReadStream(fixtureTarballV2Path).pipe(res);
                return;
            }
            if (req.method === 'GET' && req.url === '/api/health') {
                res.writeHead(mockHealthStatusCode, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(
                    mockHealthStatusCode === 200
                        ? { status: 'healthy', version: '3.0.0' }
                        : { status: 'unhealthy' }
                ));
                return;
            }
            if (req.method === 'POST' && req.url === '/api/schedule/config') {
                let rawBody = '';
                req.on('data', (chunk) => {
                    rawBody += chunk.toString();
                });
                req.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = JSON.parse(rawBody);
                    } catch (_) {
                        parsed = rawBody;
                    }
                    schedulePostRequests.push({
                        method: req.method,
                        url: req.url,
                        headers: req.headers,
                        body: parsed
                    });
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, scheduleTimes: ['08:00', '12:30', '19:30'] }));
                });
                return;
            }
            if (req.method === 'POST' && req.url === '/api/agent/pull-github') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, skipped: true }));
                return;
            }
            res.writeHead(404);
            res.end('Not found');
        });

        await new Promise((resolve, reject) => {
            mockServer.listen(0, '127.0.0.1', (err) => {
                if (err) return reject(err);
                mockServerPort = mockServer.address().port;
                resolve();
            });
        });
    });

    after(async () => {
        if (mockServer) {
            await new Promise((resolve) => mockServer.close(() => resolve()));
        }
        if (workspaceDir && fs.existsSync(workspaceDir)) {
            fs.rmSync(workspaceDir, { recursive: true, force: true });
        }
    });

    function createMockDocker(binDir, logFile, options = {}) {
        const inspectExitCode = options.inspectExitCode ?? 0;
        const imageExists = options.imageExists ?? true;
        const containerEnvLines = options.containerEnvLines ?? [
            'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
            'NODE_ENV=production',
            'PUBLISH_SECRET=sec-888',
            'GITHUB_SNAPSHOT_URL=https://mirror.example.com/ag-snapshot/latest.json',
            'UPDATE_TIMES=06:00,16:30'
        ];

        const envPayloadFile = path.join(binDir, 'container_env.txt');
        fs.writeFileSync(envPayloadFile, containerEnvLines.join('\n') + '\n', 'utf8');

        const dockerScriptPath = path.join(binDir, 'docker');
        const scriptContent = `#!/bin/sh
printf '%s\\n' "$*" >> "${logFile}"
if [ "$1" = "inspect" ]; then
  if [ "${inspectExitCode}" != "0" ]; then
    exit ${inspectExitCode}
  fi
  cat "${envPayloadFile}"
  exit 0
fi
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then
  if [ "${imageExists ? '1' : '0'}" = "1" ]; then
    exit 0
  else
    exit 1
  fi
fi
exit 0
`;
        fs.writeFileSync(dockerScriptPath, scriptContent, { mode: 0o755 });
    }

    it('1. POSIX syntax check (sh -n & dash -n) on deploy-router.sh & docker-entrypoint.sh and PowerShell-safe SSH contract', async () => {
        await execFileAsync('sh', ['-n', DEPLOY_SCRIPT]);
        await execFileAsync('dash', ['-n', DEPLOY_SCRIPT]);
        await execFileAsync('sh', ['-n', ENTRYPOINT_SCRIPT]);
        await execFileAsync('dash', ['-n', ENTRYPOINT_SCRIPT]);

        const scriptText = fs.readFileSync(DEPLOY_SCRIPT, 'utf8');
        const readmeText = fs.readFileSync(README_PATH, 'utf8');

        const expectedSshCommand = 'ssh root@<YOUR_SERVER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"';
        assert.ok(
            scriptText.includes(expectedSshCommand),
            'deploy-router.sh header must document the PowerShell-safe one-click SSH command'
        );
        assert.ok(
            readmeText.includes(expectedSshCommand),
            'README.md must document the PowerShell-safe one-click SSH command'
        );

        const innerRemoteCmd = expectedSshCommand.match(/"([^"]+)"/)[1];
        assert.equal(innerRemoteCmd.includes('"'), false, 'Remote SSH command must not contain nested double quotes');
        assert.equal(innerRemoteCmd.includes("'"), false, 'Remote SSH command must not contain single quotes');
        assert.equal(innerRemoteCmd.includes(','), false, 'Remote SSH command must not contain commas that break PowerShell');
        assert.equal(innerRemoteCmd.includes('$'), false, 'Remote SSH command must not contain $ variables/subshells');
        assert.equal(innerRemoteCmd.includes('\\'), false, 'Remote SSH command must not contain backslashes');
    });

    it('2. Fresh install overrides .env.example placeholders from running container, builds image on --rebuild, and posts /api/schedule/config', async () => {
        mockHealthStatusCode = 200;
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case2');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(binDir, { recursive: true });

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: [
                'PUBLISH_SECRET=sec-888',
                'GITHUB_SNAPSHOT_URL=https://mirror.example.com/ag-snapshot/latest.json',
                'UPDATE_TIMES=06:00,16:30'
            ]
        });

        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT, '--rebuild'], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '3',
                WAIT_INTERVAL: '0'
            }
        });

        // Verify docker inspect happened BEFORE container rename/removal and build ran on --rebuild
        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        const inspectIdx = dockerCommands.findIndex((line) => line.startsWith('inspect corefeed'));
        const renameIdx = dockerCommands.findIndex((line) => line === 'rename corefeed corefeed-prev');
        const rmPrevIdx = dockerCommands.findIndex((line) => line === 'rm -f corefeed-prev');
        const buildIdx = dockerCommands.findIndex((line) => line.startsWith('build -t corefeed:2.0'));
        const runIdx = dockerCommands.findIndex((line) => line.startsWith('run -d --name corefeed'));

        assert.ok(inspectIdx !== -1, 'docker inspect corefeed should be executed');
        assert.ok(renameIdx !== -1, 'prior container should be renamed to corefeed-prev before starting new container');
        assert.ok(rmPrevIdx !== -1, 'corefeed-prev should be cleaned up after health check succeeds');
        assert.ok(inspectIdx < renameIdx && renameIdx < runIdx && runIdx < rmPrevIdx, 'lifecycle order must be inspect -> rename -> run -> rm prev');
        assert.ok(buildIdx !== -1, 'docker build should run when --rebuild is passed');

        // Verify .env values
        const envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.AI_API_KEY, undefined);
        assert.equal(envMap.AI_BASE_URL, undefined);
        assert.equal(envMap.AI_MODEL, undefined);
        assert.equal(envMap.PUBLISH_SECRET, 'sec-888');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://mirror.example.com/ag-snapshot/latest.json');

        // Verify data/settings.json & .deps.sha256 were created/synced
        const settings = JSON.parse(fs.readFileSync(path.join(remoteDir, 'data', 'settings.json'), 'utf8'));
        assert.equal(settings.AUTO_UPDATE_ENABLED, true);
        assert.equal(settings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.deepEqual(settings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(settings.timezone, 'Asia/Shanghai');
        assert.equal(settings.GITHUB_SYNC_ENABLED, true);
        assert.equal(settings.GITHUB_SYNC_INTERVAL_MINUTES, 60);
        assert.equal(settings.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json');
        assert.ok(fs.existsSync(path.join(remoteDir, 'data', '.deps.sha256')), 'data/.deps.sha256 should be persisted after build');

        // Verify live POST /api/schedule/config was called
        assert.equal(schedulePostRequests.length, 1);
        assert.deepEqual(schedulePostRequests[0].body, {
            enabled: true,
            updateTimes: '08:00,12:30,19:30'
        });
    });

    it('3. Existing .env preserves non-empty custom values, backfills empty keys with special chars, and upgrades legacy 06:00,16:30 schedule', async () => {
        mockHealthStatusCode = 200;
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case3');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(path.join(remoteDir, 'data'), { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(
            path.join(remoteDir, '.env'),
            [
                'PORT=3120',
                'PUBLISH_SECRET=',
                'GITHUB_SNAPSHOT_URL=https://custom.mirror.example/ag-snapshot/latest.json',
                'GITHUB_SYNC_INTERVAL_MINUTES=5',
                'AUTO_UPDATE_ENABLED=false',
                'UPDATE_TIMES=06:00,16:30',
                'SCHEDULE_TIMEZONE=UTC'
            ].join('\n') + '\n',
            'utf8'
        );

        fs.writeFileSync(
            path.join(remoteDir, 'data', 'settings.json'),
            JSON.stringify({
                CLIENT_ID: 'keep-router-node-id',
                AUTO_UPDATE_ENABLED: false,
                UPDATE_TIMES: '06:00,16:30',
                scheduleTimes: ['06:00', '16:30'],
                GITHUB_SYNC_INTERVAL_MINUTES: 15,
                timezone: 'UTC'
            }, null, 2),
            'utf8'
        );

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: [
                'GITHUB_SNAPSHOT_URL=https://container.override.example/latest.json?x=1&y=2',
                'PUBLISH_API_KEY=pub-sec/key&999|xyz=1?abc'
            ]
        });

        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '3',
                WAIT_INTERVAL: '0'
            }
        });

        const envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://custom.mirror.example/ag-snapshot/latest.json');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        assert.equal(envMap.PUBLISH_SECRET, 'pub-sec/key&999|xyz=1?abc');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');

        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.equal(
            dockerCommands.some((line) => line.startsWith('build -t')),
            false,
            'Hot update without --rebuild should skip docker build when image exists'
        );

        const settings = JSON.parse(fs.readFileSync(path.join(remoteDir, 'data', 'settings.json'), 'utf8'));
        assert.equal(settings.CLIENT_ID, 'keep-router-node-id');
        assert.equal(settings.AUTO_UPDATE_ENABLED, true);
        assert.equal(settings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.deepEqual(settings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(settings.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(settings.GITHUB_SYNC_INTERVAL_MINUTES, 60);
        assert.equal(settings.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json');
        assert.equal(schedulePostRequests.length, 1);
    });

    it('4. First-time deployment succeeds cleanly when no prior container exists (docker inspect exits 1)', async () => {
        mockHealthStatusCode = 200;
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case4');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(binDir, { recursive: true });

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 1,
            imageExists: false,
            containerEnvLines: []
        });

        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '3',
                WAIT_INTERVAL: '0'
            }
        });

        const envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json');

        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.ok(
            dockerCommands.some((line) => line.startsWith('build -t corefeed:2.0')),
            'docker build should run automatically when image does not exist yet'
        );
        assert.equal(schedulePostRequests.length, 1);
    });

    it('5. Health check failure triggers automatic rollback to previous container and exits non-zero', async () => {
        mockHealthStatusCode = 500;
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case5');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(binDir, { recursive: true });

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: ['PUBLISH_SECRET=sec-rollback']
        });

        let failedError = null;
        try {
            await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
                env: {
                    ...process.env,
                    PATH: `${binDir}:${process.env.PATH}`,
                    REMOTE_DIR: remoteDir,
                    TMP_DIR: tmpDir,
                    APP_PORT: String(mockServerPort),
                    TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                    WAIT_RETRIES: '2',
                    WAIT_INTERVAL: '0'
                }
            });
        } catch (err) {
            failedError = err;
        } finally {
            mockHealthStatusCode = 200;
        }

        assert.ok(failedError, 'deploy-router.sh must exit non-zero when health check fails');
        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.ok(dockerCommands.includes('rename corefeed corefeed-prev'), 'Must preserve old container as corefeed-prev');
        assert.ok(dockerCommands.some((line) => line.startsWith('logs --tail 30 corefeed')), 'Must print failed container logs');
        assert.ok(dockerCommands.includes('rm -f corefeed'), 'Must remove unhealthy new container');
        assert.ok(dockerCommands.includes('rename corefeed-prev corefeed'), 'Must rename corefeed-prev back to corefeed');
        assert.ok(dockerCommands.includes('start corefeed'), 'Must restart rolled-back corefeed container');
        assert.equal(schedulePostRequests.length, 0, 'Must not post schedule config after failed startup');
    });

    it('6. Lockfile SHA-256 change auto-triggers docker build without --rebuild, skips on unchanged lockfile, and cleans deleted code files', async () => {
        mockHealthStatusCode = 200;
        const caseDir = path.join(workspaceDir, 'case6');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(path.join(remoteDir, 'public', 'js'), { recursive: true });
        fs.mkdirSync(path.join(remoteDir, 'data'), { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        // Plant a stale legacy JS file in public/js and a persistent user data file in data/
        const staleFile = path.join(remoteDir, 'public', 'js', 'obsolete_legacy.js');
        const userDataFile = path.join(remoteDir, 'data', 'keep_me.json');
        fs.writeFileSync(staleFile, '// stale\n', 'utf8');
        fs.writeFileSync(userDataFile, '{"ok":true}\n', 'utf8');

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: []
        });

        // Run 1: establishes baseline .deps.sha256 without rebuilding (image exists)
        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '2',
                WAIT_INTERVAL: '0'
            }
        });

        assert.equal(fs.existsSync(staleFile), false, 'Deleted legacy code files in public/ must be cleaned up');
        assert.equal(fs.existsSync(userDataFile), true, 'User files in data/ must NEVER be deleted');
        const hash1 = fs.readFileSync(path.join(remoteDir, 'data', '.deps.sha256'), 'utf8').trim();
        assert.ok(hash1.length >= 8);

        // Run 2: tarball v2 changes package-lock.json -> MUST auto-trigger docker build without --rebuild
        fs.writeFileSync(dockerLog, '', 'utf8');
        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main-v2.tar.gz`,
                WAIT_RETRIES: '2',
                WAIT_INTERVAL: '0'
            }
        });

        const run2Cmds = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.ok(
            run2Cmds.some((line) => line.startsWith('build -t corefeed:2.0')),
            'Changing package-lock.json must automatically trigger docker build without --rebuild'
        );
        const hash2 = fs.readFileSync(path.join(remoteDir, 'data', '.deps.sha256'), 'utf8').trim();
        assert.notEqual(hash2, hash1, 'data/.deps.sha256 must update to new lockfile hash');

        // Run 3: same v2 tarball again -> MUST skip docker build
        fs.writeFileSync(dockerLog, '', 'utf8');
        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main-v2.tar.gz`,
                WAIT_RETRIES: '2',
                WAIT_INTERVAL: '0'
            }
        });

        const run3Cmds = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.equal(
            run3Cmds.some((line) => line.startsWith('build -t')),
            false,
            'Unchanged lockfile on subsequent run must skip docker build'
        );
    });

    it('7. Custom UPDATE_TIMES & COREFEED_REPO are preserved across hot updates, while --reset-schedule resets defaults', async () => {
        mockHealthStatusCode = 200;
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case7');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(path.join(remoteDir, 'data'), { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        fs.writeFileSync(
            path.join(remoteDir, '.env'),
            [
                'PORT=3120',
                'AUTO_UPDATE_ENABLED=false',
                'UPDATE_TIMES=07:30,13:00,20:00',
                'SCHEDULE_TIMEZONE=UTC'
            ].join('\n') + '\n',
            'utf8'
        );

        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: []
        });

        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                COREFEED_REPO: 'forkuser/CoreFeed',
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '2',
                WAIT_INTERVAL: '0'
            }
        });

        let envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.UPDATE_TIMES, '07:30,13:00,20:00', 'Custom UPDATE_TIMES must be preserved');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'false', 'Custom AUTO_UPDATE_ENABLED must be preserved');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'UTC', 'Custom SCHEDULE_TIMEZONE must be preserved');
        assert.equal(envMap.COREFEED_REPO, 'forkuser/CoreFeed', 'Custom COREFEED_REPO must be persisted');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/forkuser/CoreFeed/ag-snapshot/manifest.json');
        assert.deepEqual(schedulePostRequests[0].body, {
            enabled: false,
            updateTimes: '07:30,13:00,20:00'
        });

        // Passing --reset-schedule resets schedule to 08:00,12:30,19:30 Asia/Shanghai enabled=true
        schedulePostRequests = [];
        await execFileAsync('/bin/sh', [DEPLOY_SCRIPT, '--reset-schedule'], {
            env: {
                ...process.env,
                PATH: `${binDir}:${process.env.PATH}`,
                REMOTE_DIR: remoteDir,
                TMP_DIR: tmpDir,
                APP_PORT: String(mockServerPort),
                COREFEED_REPO: 'forkuser/CoreFeed',
                TARBALL_URL: `http://127.0.0.1:${mockServerPort}/CoreFeed-main.tar.gz`,
                WAIT_RETRIES: '2',
                WAIT_INTERVAL: '0'
            }
        });

        envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.deepEqual(schedulePostRequests[0].body, {
            enabled: true,
            updateTimes: '08:00,12:30,19:30'
        });
    });
});
