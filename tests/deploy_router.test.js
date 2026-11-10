/**
 * CoreFeed v2.0 — `deploy-router.sh` 软路由一键部署与秒级热更新脚本端到端自动化测试套件
 *
 * 覆盖范围 (4 项端到端测试)：
 *   1. POSIX Shell 语法校验 (`sh -n` / `dash -n`) 与 Windows PowerShell 免转义一键 SSH 命令契约验证
 *   2. 全新安装 / `.env.example` 默认占位符被旧容器真实环境变量覆盖 + `--rebuild` 镜像构建 + `/api/schedule/config` 实时激活
 *   3. 已有 `.env` 自定义非空配置保留 + 空字段自动回填 + 特殊字符 (`/`, `&`, `|`, `=`, `?`) 安全写入 + 旧版 `data/settings.json` 升级同步
 *   4. 首次部署（无历史容器、`docker inspect` 返回非零退出码）容错与默认配置初始化验证
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

describe('CoreFeed v2.0 — deploy-router.sh End-to-End Tests', () => {
    let workspaceDir = '';
    let fixtureTarballPath = '';
    let mockServer = null;
    let mockServerPort = 0;
    let schedulePostRequests = [];

    before(async () => {
        workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'corefeed-deploy-test-'));

        // Build a realistic CoreFeed-main.tar.gz fixture
        const tarballBuildDir = path.join(workspaceDir, 'tarball-build');
        const repoFolder = path.join(tarballBuildDir, 'CoreFeed-main');
        fs.mkdirSync(path.join(repoFolder, 'scripts'), { recursive: true });
        fs.copyFileSync(ENV_EXAMPLE_PATH, path.join(repoFolder, '.env.example'));
        fs.writeFileSync(path.join(repoFolder, '.dockerignore'), 'node_modules\ndata\nlogs\n', 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'server.js'), '// mock server.js\n', 'utf8');
        fs.writeFileSync(path.join(repoFolder, 'package.json'), '{"name":"corefeed","version":"2.0.0"}\n', 'utf8');

        fixtureTarballPath = path.join(workspaceDir, 'CoreFeed-main.tar.gz');
        await execFileAsync('tar', ['-czf', fixtureTarballPath, '-C', tarballBuildDir, 'CoreFeed-main']);

        // Start local HTTP server to serve tarball and receive POST /api/schedule/config
        mockServer = http.createServer((req, res) => {
            if (req.method === 'GET' && req.url === '/CoreFeed-main.tar.gz') {
                res.writeHead(200, { 'Content-Type': 'application/gzip' });
                fs.createReadStream(fixtureTarballPath).pipe(res);
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
            'AI_BASE_URL=https://api.example-llm.com/v1',
            'AI_API_KEY=sk-live-router-key',
            'AI_MODEL=custom-llm-v1',
            'PUBLISH_SECRET=sec-888',
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

    it('1. POSIX syntax check (sh -n & dash -n) and PowerShell-safe one-click SSH command contract', async () => {
        await execFileAsync('sh', ['-n', DEPLOY_SCRIPT]);
        await execFileAsync('dash', ['-n', DEPLOY_SCRIPT]);

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
                'AI_BASE_URL=https://api.example-llm.com/v1',
                'AI_API_KEY=sk-live-router-key',
                'AI_MODEL=custom-llm-v1',
                'PUBLISH_SECRET=sec-888',
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

        // Verify docker inspect happened BEFORE docker rm -f
        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        const inspectIdx = dockerCommands.findIndex((line) => line.startsWith('inspect corefeed'));
        const rmIdx = dockerCommands.findIndex((line) => line.startsWith('rm -f corefeed'));
        const buildIdx = dockerCommands.findIndex((line) => line.startsWith('build -t corefeed:2.0'));
        const runIdx = dockerCommands.findIndex((line) => line.startsWith('run -d --name corefeed'));

        assert.ok(inspectIdx !== -1, 'docker inspect corefeed should be executed');
        assert.ok(rmIdx !== -1, 'docker rm -f corefeed should be executed');
        assert.ok(inspectIdx < rmIdx, 'docker inspect must run BEFORE docker rm -f');
        assert.ok(buildIdx !== -1, 'docker build should run when --rebuild is passed');
        assert.ok(runIdx !== -1, 'docker run -d should be executed');

        // Verify .env values (container values must override .env.example stock placeholders)
        const envMap = parseDotEnvFile(path.join(remoteDir, '.env'));
        assert.equal(envMap.AI_BASE_URL, 'https://api.example-llm.com/v1');
        assert.equal(envMap.AI_API_KEY, 'sk-live-router-key');
        assert.equal(envMap.AI_MODEL, 'custom-llm-v1');
        assert.equal(envMap.PUBLISH_SECRET, 'sec-888');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json');

        // Verify data/settings.json was created/synced
        const settings = JSON.parse(fs.readFileSync(path.join(remoteDir, 'data', 'settings.json'), 'utf8'));
        assert.equal(settings.AUTO_UPDATE_ENABLED, true);
        assert.equal(settings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.deepEqual(settings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(settings.timezone, 'Asia/Shanghai');
        assert.equal(settings.GITHUB_SYNC_ENABLED, true);
        assert.equal(settings.GITHUB_SYNC_INTERVAL_MINUTES, 60);
        assert.equal(settings.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json');

        // Verify live POST /api/schedule/config was called
        assert.equal(schedulePostRequests.length, 1);
        assert.deepEqual(schedulePostRequests[0].body, {
            enabled: true,
            updateTimes: '08:00,12:30,19:30'
        });
    });

    it('3. Existing .env preserves non-empty custom values, backfills empty keys with special chars, and upgrades legacy data/settings.json', async () => {
        schedulePostRequests = [];
        const caseDir = path.join(workspaceDir, 'case3');
        const remoteDir = path.join(caseDir, 'opt-corefeed');
        const tmpDir = path.join(caseDir, 'tmp');
        const binDir = path.join(caseDir, 'bin');
        const dockerLog = path.join(caseDir, 'docker.log');
        fs.mkdirSync(path.join(remoteDir, 'data'), { recursive: true });
        fs.mkdirSync(binDir, { recursive: true });

        // Pre-populate .env with custom AI_BASE_URL, AI_MODEL & GITHUB_SNAPSHOT_URL, empty AI_API_KEY & PUBLISH_SECRET, and legacy UPDATE_TIMES
        fs.writeFileSync(
            path.join(remoteDir, '.env'),
            [
                'PORT=3120',
                'AI_BASE_URL=https://custom.user.ai/v1',
                'AI_API_KEY=',
                'AI_MODEL=user-custom-model',
                'PUBLISH_SECRET=',
                'GITHUB_SNAPSHOT_URL=https://custom.mirror.example/ag-snapshot/latest.json',
                'GITHUB_SYNC_INTERVAL_MINUTES=5',
                'AUTO_UPDATE_ENABLED=false',
                'UPDATE_TIMES=06:00,16:30',
                'SCHEDULE_TIMEZONE=UTC'
            ].join('\n') + '\n',
            'utf8'
        );

        // Pre-populate legacy data/settings.json with user-saved AI_API_KEY and old 2x schedule
        fs.writeFileSync(
            path.join(remoteDir, 'data', 'settings.json'),
            JSON.stringify({
                AI_API_KEY: 'keep-me-in-settings',
                AUTO_UPDATE_ENABLED: false,
                UPDATE_TIMES: '06:00,16:30',
                scheduleTimes: ['06:00', '16:30'],
                GITHUB_SYNC_INTERVAL_MINUTES: 15,
                timezone: 'UTC'
            }, null, 2),
            'utf8'
        );

        // Container env has special characters (/, &, |, =, ?) and PUBLISH_API_KEY fallback
        createMockDocker(binDir, dockerLog, {
            inspectExitCode: 0,
            imageExists: true,
            containerEnvLines: [
                'AI_BASE_URL=https://api.example-llm.com/v1?x=1&y=2',
                'AI_API_KEY=sk-special/key&123|456=789?abc',
                'AI_MODEL=custom-llm-v1',
                'PUBLISH_API_KEY=pub-sec&999|xyz=1'
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
        // Non-empty custom values in .env must be preserved
        assert.equal(envMap.AI_BASE_URL, 'https://custom.user.ai/v1');
        assert.equal(envMap.AI_MODEL, 'user-custom-model');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://custom.mirror.example/ag-snapshot/latest.json');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        // Empty keys in .env must be backfilled verbatim without sed escaping corruption
        assert.equal(envMap.AI_API_KEY, 'sk-special/key&123|456=789?abc');
        assert.equal(envMap.PUBLISH_SECRET, 'pub-sec&999|xyz=1');
        // Schedule keys must be enforced to 3x daily Asia/Shanghai
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');

        // Verify hot-update skipped docker build since imageExists=true and no --rebuild flag
        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.equal(
            dockerCommands.some((line) => line.startsWith('build -t')),
            false,
            'Hot update without --rebuild should skip docker build when image exists'
        );

        // Verify data/settings.json preserved AI_API_KEY and updated schedule to 08:00,12:30,19:30
        const settings = JSON.parse(fs.readFileSync(path.join(remoteDir, 'data', 'settings.json'), 'utf8'));
        assert.equal(settings.AI_API_KEY, 'keep-me-in-settings');
        assert.equal(settings.AUTO_UPDATE_ENABLED, true);
        assert.equal(settings.enabled, true);
        assert.equal(settings.scheduleEnabled, true);
        assert.equal(settings.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(settings.updateTimes, '08:00,12:30,19:30');
        assert.deepEqual(settings.scheduleTimes, ['08:00', '12:30', '19:30']);
        assert.equal(settings.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(settings.timezone, 'Asia/Shanghai');
        assert.equal(settings.GITHUB_SYNC_ENABLED, true);
        assert.equal(settings.GITHUB_SYNC_INTERVAL_MINUTES, 60);
        assert.equal(settings.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json');

        assert.equal(schedulePostRequests.length, 1);
    });

    it('4. First-time deployment succeeds cleanly when no prior container exists (docker inspect exits 1)', async () => {
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
        assert.equal(envMap.AI_BASE_URL, 'https://api.openai.com/v1');
        assert.equal(envMap.AI_MODEL, 'gpt-4o-mini');
        assert.equal(envMap.AUTO_UPDATE_ENABLED, 'true');
        assert.equal(envMap.UPDATE_TIMES, '08:00,12:30,19:30');
        assert.equal(envMap.SCHEDULE_TIMEZONE, 'Asia/Shanghai');
        assert.equal(envMap.GITHUB_SYNC_ENABLED, 'true');
        assert.equal(envMap.GITHUB_SYNC_INTERVAL_MINUTES, '60');
        assert.equal(envMap.GITHUB_SNAPSHOT_URL, 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json');

        const dockerCommands = fs.readFileSync(dockerLog, 'utf8').trim().split('\n');
        assert.ok(
            dockerCommands.some((line) => line.startsWith('build -t corefeed:2.0')),
            'docker build should run automatically when image does not exist yet'
        );
        assert.equal(schedulePostRequests.length, 1);
    });
});
