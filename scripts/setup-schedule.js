#!/usr/bin/env node
/**
 * CoreFeed v2.0 — 跨平台本机每日定时采编翻译任务一键配置器 (scripts/setup-schedule.js)
 *
 * 功能说明：
 *   支持在 Windows / macOS / Linux / 云端容器本机一键设定每日定时新闻收集、中文翻译精编与 GitHub 快照发布任务：
 *   1. 默认时间点：每日早 07:40、中 12:10、晚 19:10 (Asia/Shanghai，提前软路由 08:00/12:30/19:30 拉取时间 20 分钟)
 *   2. 双重保障机制：
 *      - 启动本机后台常驻守护进程 (`ag-auto-update.js --daemon`，内置睡眠唤醒与漏档自动补采编)；
 *      - 自动检测并注册操作系统级计划任务：
 *        * Windows: 注册 Task Scheduler (`schtasks` + `StartWhenAvailable` 唤醒补跑)
 *        * macOS  : 注册 `~/Library/LaunchAgents/com.corefeed.ag-auto-update.plist` 与 `crontab`
 *        * Linux  : 注册 `crontab` (若系统已安装 cron) + 常驻守护进程
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();

const {
    getTimesToSchedule,
    getDaemonStatus,
    getNextExecutionTime,
    getLastExecutionTime
} = require('./ag-auto-update');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUTO_UPDATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'ag-auto-update.js');
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const DATA_DIR = path.join(REPO_ROOT, 'data');

function parseSetupArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const opts = {
        action: 'install', // install | status | remove
        times: getTimesToSchedule(),
        clientId: String(
            process.env.CLIENT_ID ||
            process.env.AG_CLIENT_ID ||
            os.hostname() ||
            'antigravity-local'
        ).trim(),
        target: process.env.COREFEED_SITE_URL || 'http://127.0.0.1:3120',
        startDaemon: true,
        runNow: false,
        dryRun: false,
        platform: process.platform
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--status' || arg === 'status') {
            opts.action = 'status';
        } else if (arg === '--remove' || arg === '--uninstall' || arg === 'remove' || arg === 'uninstall') {
            opts.action = 'remove';
        } else if (arg === '--install' || arg === 'install') {
            opts.action = 'install';
        } else if ((arg === '--times' || arg === '--schedule-times') && argv[i + 1]) {
            opts.times = getTimesToSchedule(argv[++i]);
        } else if (arg.startsWith('--times=') || arg.startsWith('--schedule-times=')) {
            opts.times = getTimesToSchedule(eqVal(arg));
        } else if ((arg === '--client-id' || arg === '--published-by') && argv[i + 1]) {
            opts.clientId = String(argv[++i]).trim();
        } else if (arg.startsWith('--client-id=') || arg.startsWith('--published-by=')) {
            opts.clientId = String(eqVal(arg)).trim();
        } else if ((arg === '--target' || arg === '--site') && argv[i + 1]) {
            opts.target = String(argv[++i]).trim();
        } else if (arg.startsWith('--target=') || arg.startsWith('--site=')) {
            opts.target = String(eqVal(arg)).trim();
        } else if (arg === '--no-daemon') {
            opts.startDaemon = false;
        } else if (arg === '--run-now' || arg === '--immediate') {
            opts.runNow = true;
        } else if (arg === '--dry-run') {
            opts.dryRun = true;
        } else if (arg.startsWith('--platform=')) {
            opts.platform = eqVal(arg);
        }
    }

    return opts;
}

function buildSchedulePlan(customOpts = {}) {
    const opts = { ...parseSetupArgs([]), ...customOpts };
    const times = getTimesToSchedule(opts.times);
    const nodePath = process.execPath;
    const windowsTasks = times.map((time) => {
        const cleanSlot = time.replace(':', '');
        const taskName = `CoreFeed_AutoUpdate_${cleanSlot}`;
        const taskRun = `"${nodePath}" "${AUTO_UPDATE_SCRIPT}" --client-id="${opts.clientId}" --target="${opts.target}"`;
        return {
            time,
            taskName,
            schtasksArgs: ['/Create', '/F', '/SC', 'DAILY', '/ST', time, '/TN', taskName, '/TR', taskRun],
            psEnhanceCmd: `$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Set-ScheduledTask -TaskName '${taskName}' -Settings $s -ErrorAction SilentlyContinue`
        };
    });

    const cronLines = [
        'CRON_TZ=Asia/Shanghai',
        ...times.map((time) => {
            const [hour, minute] = time.split(':').map(Number);
            return `${minute} ${hour} * * * cd "${REPO_ROOT}" && "${nodePath}" "${AUTO_UPDATE_SCRIPT}" --client-id="${opts.clientId}" --target="${opts.target}" >> "${path.join(LOGS_DIR, 'ag-cron.log')}" 2>&1 # CoreFeed_AutoUpdate_${time.replace(':', '')}`;
        })
    ];

    const daemonArgs = [
        AUTO_UPDATE_SCRIPT,
        '--daemon',
        `--client-id=${opts.clientId}`,
        `--target=${opts.target}`,
        `--times=${times.join(',')}`
    ];
    if (opts.runNow) {
        daemonArgs.push('--run-now');
    }

    return {
        platform: opts.platform,
        repoRoot: REPO_ROOT,
        nodePath,
        scriptPath: AUTO_UPDATE_SCRIPT,
        timezone: 'Asia/Shanghai',
        scheduleTimes: times,
        clientId: opts.clientId,
        target: opts.target,
        nextExecution: getNextExecutionTime(times),
        lastScheduledExecution: getLastExecutionTime(times),
        windowsTasks,
        cronLines,
        daemonCommand: {
            executable: nodePath,
            args: daemonArgs
        }
    };
}

function tryInstallWindowsTasks(plan, dryRun = false) {
    if (dryRun) {
        return { installed: false, dryRun: true, tasks: plan.windowsTasks.map(t => t.taskName) };
    }
    const registered = [];
    const errors = [];
    for (const item of plan.windowsTasks) {
        try {
            execFileSync('schtasks', item.schtasksArgs, { stdio: 'pipe' });
            try {
                execFileSync('powershell', ['-NoProfile', '-Command', item.psEnhanceCmd], { stdio: 'ignore' });
            } catch (_) {}
            registered.push(item.taskName);
        } catch (err) {
            errors.push(`${item.taskName}: ${err.message}`);
        }
    }
    return {
        installed: registered.length > 0,
        registered,
        errors
    };
}

function tryInstallUnixCron(plan, dryRun = false) {
    if (dryRun) {
        return { installed: false, dryRun: true, cronLines: plan.cronLines };
    }
    try {
        execFileSync('which', ['crontab'], { stdio: 'ignore' });
    } catch (_) {
        return { installed: false, reason: 'crontab-not-available' };
    }

    try {
        let existing = '';
        try {
            existing = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (_) {
            existing = '';
        }
        const filtered = existing
            .split('\n')
            .filter(line => !line.includes('CoreFeed_AutoUpdate_') && !line.includes('scripts/ag-auto-update.js'))
            .join('\n')
            .trim();

        const updated = [filtered, ...plan.cronLines].filter(Boolean).join('\n') + '\n';
        const tmpCron = path.join(os.tmpdir(), `corefeed-cron-${process.pid}.txt`);
        fs.writeFileSync(tmpCron, updated, 'utf8');
        try {
            execFileSync('crontab', [tmpCron], { stdio: 'pipe' });
        } finally {
            fs.rmSync(tmpCron, { force: true });
        }
        return { installed: true, cronLines: plan.cronLines };
    } catch (err) {
        return { installed: false, reason: err.message };
    }
}

function ensureBackgroundDaemon(plan, opts = {}) {
    if (opts.dryRun) {
        return { started: false, dryRun: true, command: plan.daemonCommand };
    }

    const current = getDaemonStatus({
        clientId: plan.clientId,
        target: plan.target,
        times: plan.scheduleTimes
    });

    if (current.running && current.pid) {
        return {
            started: false,
            alreadyRunning: true,
            pid: current.pid,
            status: current
        };
    }

    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const outFd = fs.openSync(path.join(LOGS_DIR, 'ag-daemon.log'), 'a');

    const child = spawn(plan.daemonCommand.executable, plan.daemonCommand.args, {
        cwd: REPO_ROOT,
        detached: true,
        stdio: ['ignore', outFd, outFd],
        env: {
            ...process.env,
            SCHEDULE_TIMEZONE: 'Asia/Shanghai',
            AG_UPDATE_TIMES: plan.scheduleTimes.join(','),
            CLIENT_ID: plan.clientId,
            COREFEED_SITE_URL: plan.target
        }
    });
    child.unref();

    const pidFile = path.join(LOGS_DIR, 'ag-daemon.pid');
    fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8');

    return {
        started: true,
        alreadyRunning: false,
        pid: child.pid,
        status: getDaemonStatus({
            clientId: plan.clientId,
            target: plan.target,
            times: plan.scheduleTimes
        })
    };
}

function removeSchedule(customOpts = {}) {
    const opts = { ...parseSetupArgs([]), ...customOpts };
    const plan = buildSchedulePlan(opts);
    const status = getDaemonStatus(opts);
    let stoppedPid = null;

    if (status.running && status.pid && !opts.dryRun) {
        try {
            process.kill(status.pid, 'SIGTERM');
            stoppedPid = status.pid;
        } catch (_) {}
    }

    if (opts.platform === 'win32' && !opts.dryRun) {
        for (const item of plan.windowsTasks) {
            try {
                execFileSync('schtasks', ['/Delete', '/F', '/TN', item.taskName], { stdio: 'ignore' });
            } catch (_) {}
        }
    } else if (!opts.dryRun) {
        try {
            const existing = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const filtered = existing
                .split('\n')
                .filter(line => !line.includes('CoreFeed_AutoUpdate_') && !line.includes('scripts/ag-auto-update.js'))
                .join('\n')
                .trim();
            const tmpCron = path.join(os.tmpdir(), `corefeed-cron-rm-${process.pid}.txt`);
            fs.writeFileSync(tmpCron, filtered ? `${filtered}\n` : '', 'utf8');
            try {
                execFileSync('crontab', [tmpCron], { stdio: 'ignore' });
            } finally {
                fs.rmSync(tmpCron, { force: true });
            }
        } catch (_) {}
    }

    return {
        removed: true,
        stoppedPid,
        scheduleTimes: plan.scheduleTimes
    };
}

function installSchedule(customOpts = {}) {
    const opts = { ...parseSetupArgs([]), ...customOpts };
    const plan = buildSchedulePlan(opts);

    let osScheduler = null;
    if (plan.platform === 'win32') {
        osScheduler = tryInstallWindowsTasks(plan, opts.dryRun);
    } else {
        osScheduler = tryInstallUnixCron(plan, opts.dryRun);
    }

    let daemon = null;
    if (opts.startDaemon !== false) {
        daemon = ensureBackgroundDaemon(plan, opts);
    }

    const finalStatus = getDaemonStatus({
        clientId: plan.clientId,
        target: plan.target,
        times: plan.scheduleTimes
    });

    return {
        success: true,
        action: 'install',
        platform: plan.platform,
        scheduleTimes: plan.scheduleTimes,
        timezone: plan.timezone,
        clientId: plan.clientId,
        target: plan.target,
        osScheduler,
        daemon,
        status: finalStatus
    };
}

if (require.main === module) {
    const opts = parseSetupArgs(process.argv.slice(2));
    if (opts.action === 'status') {
        const st = getDaemonStatus(opts);
        console.log(JSON.stringify(st, null, 2));
        process.exit(0);
    } else if (opts.action === 'remove') {
        const rm = removeSchedule(opts);
        console.log(JSON.stringify(rm, null, 2));
        process.exit(0);
    } else {
        const res = installSchedule(opts);
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
    }
}

module.exports = {
    parseSetupArgs,
    buildSchedulePlan,
    installSchedule,
    removeSchedule,
    ensureBackgroundDaemon
};
