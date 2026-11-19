#!/usr/bin/env node
/**
 * CoreFeed v2.0 — Qwen3-TTS 1.7B 双主播语音播报合成与热同步 CLI 包装器 (scripts/ag-tts.js)
 *
 * 用法：
 *   node scripts/ag-tts.js --mode=news         # 为当前最新全球要闻生成双主播播报 (data/audio/briefing-news.mp3)
 *   node scripts/ag-tts.js --mode=pulse        # 为当前最新欧美社媒热议生成双主播播报 (data/audio/briefing-pulse.mp3)
 *   node scripts/ag-tts.js --mode=both         # 单次拉起 Colab L4 一次性合成要闻 + 社媒两条播报音轨
 *   node scripts/ag-tts.js --dry-run-script    # 仅预览双主播口播分幕文稿 JSON（不拉起 Colab）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config();
const axios = require('axios');
const https = require('https');
const config = require('../config');
const logger = require('../utils/logger');
const stateManager = require('../services/state_manager');
const { AudioBroadcastService } = require('../services/audio_broadcast_service');

const httpsAgentIgnoreTls = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

function resolveColabPython() {
    if (process.env.QWEN3_COLAB_PYTHON && fs.existsSync(process.env.QWEN3_COLAB_PYTHON)) {
        return process.env.QWEN3_COLAB_PYTHON;
    }
    const winDefault = 'c:\\Users\\alan\\Documents\\antigravity\\Google_Colab\\.venv\\Scripts\\python.exe';
    if (fs.existsSync(winDefault)) {
        return winDefault;
    }
    return process.platform === 'win32' ? 'python' : 'python3';
}

function parseTtsCliArgs(argv = process.argv.slice(2)) {
    const eqVal = (a) => a.slice(a.indexOf('=') + 1);
    const opts = {
        mode: 'news',
        gpu: 'L4',
        speed: '1.03',
        maxHeadlines: '10',
        dryRunScript: false,
        allowFailure: false,
        localOnly: false,
        target: process.env.COREFEED_SITE_URL || config.agent?.siteUrl || `http://localhost:${config.server?.port || 3120}`,
        secret: process.env.PUBLISH_SECRET || process.env.PUBLISH_API_KEY || config.agent?.publishSecret || '',
        baseUrl: '',
        apiKey: '',
        dataDir: config.storage?.dataDir || path.join(__dirname, '..', 'data'),
        pulseFile: ''
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--mode' && argv[i + 1]) {
            opts.mode = argv[++i];
        } else if (arg.startsWith('--mode=')) {
            opts.mode = eqVal(arg);
        } else if (arg === '--gpu' && argv[i + 1]) {
            opts.gpu = argv[++i];
        } else if (arg.startsWith('--gpu=')) {
            opts.gpu = eqVal(arg);
        } else if (arg === '--speed' && argv[i + 1]) {
            opts.speed = argv[++i];
        } else if (arg.startsWith('--speed=')) {
            opts.speed = eqVal(arg);
        } else if (arg === '--max-headlines' && argv[i + 1]) {
            opts.maxHeadlines = argv[++i];
        } else if (arg.startsWith('--max-headlines=')) {
            opts.maxHeadlines = eqVal(arg);
        } else if (arg === '--dry-run-script') {
            opts.dryRunScript = true;
        } else if (arg === '--allow-failure') {
            opts.allowFailure = true;
        } else if (arg === '--local-only') {
            opts.localOnly = true;
        } else if ((arg === '--target' || arg === '--site') && argv[i + 1]) {
            opts.target = argv[++i];
        } else if (arg.startsWith('--target=') || arg.startsWith('--site=')) {
            opts.target = eqVal(arg);
        } else if (arg === '--secret' && argv[i + 1] !== undefined) {
            opts.secret = argv[++i];
        } else if (arg.startsWith('--secret=')) {
            opts.secret = eqVal(arg);
        } else if (arg === '--base-url' && argv[i + 1]) {
            opts.baseUrl = argv[++i];
        } else if (arg.startsWith('--base-url=')) {
            opts.baseUrl = eqVal(arg);
        } else if (arg === '--api-key' && argv[i + 1]) {
            opts.apiKey = argv[++i];
        } else if (arg.startsWith('--api-key=')) {
            opts.apiKey = eqVal(arg);
        } else if (arg === '--data-dir' && argv[i + 1]) {
            opts.dataDir = path.resolve(argv[++i]);
        } else if (arg.startsWith('--data-dir=')) {
            opts.dataDir = path.resolve(eqVal(arg));
        } else if (arg === '--pulse-file' && argv[i + 1]) {
            opts.pulseFile = path.resolve(argv[++i]);
        } else if (arg.startsWith('--pulse-file=')) {
            opts.pulseFile = path.resolve(eqVal(arg));
        }
    }
    return opts;
}

async function runTtsSynthesis(customOptions = {}) {
    const opts = { ...parseTtsCliArgs([]), ...customOptions };
    const pyBin = resolveColabPython();
    const pyScript = path.join(__dirname, 'ag-generate-tts.py');

    const pyArgs = [
        '-u',
        pyScript,
        '--mode',
        String(opts.mode || 'news'),
        '--gpu',
        String(opts.gpu || 'L4'),
        '--speed',
        String(opts.speed || '1.03'),
        '--max-headlines',
        String(opts.maxHeadlines || '10'),
        '--data-dir',
        path.resolve(opts.dataDir)
    ];

    if (opts.pulseFile) {
        pyArgs.push('--pulse-file', path.resolve(opts.pulseFile));
    }
    if (opts.baseUrl) {
        pyArgs.push('--base-url', String(opts.baseUrl));
    }
    if (opts.apiKey) {
        pyArgs.push('--api-key', String(opts.apiKey));
    }
    if (opts.dryRunScript) {
        pyArgs.push('--dry-run-script');
    }

    const res = spawnSync(pyBin, pyArgs, {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'inherit',
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
    });

    if (res.status !== 0) {
        const msg = `Qwen3-TTS 语音合成脚本退出码异常 (code=${res.status})`;
        if (opts.allowFailure) {
            logger.warn('AG-TTS', `${msg}，已设置 --allow-failure，跳过语音阻断继续后续发布`);
            return { success: false, skippedOnFailure: true, exitCode: res.status };
        }
        throw new Error(msg);
    }

    if (opts.dryRunScript) {
        return { success: true, dryRun: true };
    }

    await stateManager.loadFromFile();
    const audioSvc = new AudioBroadcastService(null, stateManager);
    const bundle = await audioSvc.loadLocalBundle();
    if (bundle) {
        stateManager.updateAudioBroadcast(bundle, false);
        await stateManager.saveToFile();
    }

    if (!opts.localOnly && opts.target && bundle) {
        const cleanTarget = opts.target.replace(/\/+$/, '');
        const publishAudioUrl = `${cleanTarget}/api/agent/publish-audio`;
        const headers = { 'Content-Type': 'application/json' };
        if (opts.secret) {
            headers['Authorization'] = `Bearer ${opts.secret}`;
            headers['X-Publish-Secret'] = opts.secret;
            headers['x-api-key'] = opts.secret;
        }
        let isLocalTarget = false;
        try {
            const host = new URL(publishAudioUrl).hostname.toLowerCase();
            isLocalTarget =
                host === 'localhost' ||
                host === '127.0.0.1' ||
                host === '::1' ||
                host.startsWith('192.168.') ||
                host.startsWith('10.');
        } catch (_) {}

        const targetTracks = opts.mode === 'both' ? ['news', 'pulse'] : [opts.mode];
        for (const tk of targetTracks) {
            const trackMeta = bundle.tracks?.[tk];
            const audioPath = audioSvc.getTrackAudioPath(tk);
            if (!trackMeta || !audioPath || !fs.existsSync(audioPath)) continue;
            try {
                await axios.post(
                    publishAudioUrl,
                    {
                        track: tk,
                        trackMeta,
                        audioBase64: fs.readFileSync(audioPath).toString('base64')
                    },
                    {
                        headers,
                        timeout: 30000,
                        maxBodyLength: 50 * 1024 * 1024,
                        httpsAgent: httpsAgentIgnoreTls,
                        ...(isLocalTarget ? { proxy: false } : {})
                    }
                );
                logger.success('AG-TTS', `已实时热推 ${tk} 语音播报至 ${publishAudioUrl}`);
            } catch (_) {
                // Ignore if local web server is not running; ag-publish / ag-sync-pulse pushes to GitHub ag-snapshot
            }
        }
    }

    return {
        success: true,
        audioBroadcast: bundle
    };
}

if (require.main === module) {
    const cliOpts = parseTtsCliArgs(process.argv.slice(2));
    runTtsSynthesis(cliOpts)
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[AG-TTS] 合成失败:', err.message);
            process.exit(1);
        });
}

module.exports = {
    parseTtsCliArgs,
    runTtsSynthesis,
    resolveColabPython
};
