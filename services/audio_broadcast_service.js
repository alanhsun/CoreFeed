/**
 * 聚核 CoreFeed v2.0 — 双主播语音播报 (Qwen3-TTS 1.7B) 元数据管理与跨网段音频缓存服务
 *
 * 核心职责：
 *   1. 标准化 `news`（全球要闻双主播精播）与 `pulse`（欧美社媒早班车双主播观察）双音轨元数据及章节时间轴
 *   2. 管理本地 `data/audio_broadcast.json` 与 `data/audio/briefing-{news,pulse}.mp3` 原子读写与 SHA-256 校验
 *   3. 在自托管服务端（软路由 / Docker）从 GitHub `ag-snapshot` 分支（含多镜像回退）自动拉取并缓存 MP3 音频文件，
 *      以便前端 `<audio>` 通过本机 `/api/audio/:track` 获得原生 HTTP Range (`206 Partial Content`) 拖拽定位体验
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');

const VALID_TRACK_KEYS = ['news', 'pulse'];
const TRACK_SNAPSHOT_FILENAMES = {
    news: 'briefing-news.mp3',
    pulse: 'briefing-pulse.mp3'
};
const TRACK_DEFAULT_LABELS = {
    news: '全球要闻播报',
    pulse: '欧美社媒早班车'
};

const audioFetchHttpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function computeBufferSha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function computeFileSha256(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

function resolveSnapshotRawDirUrl(customSnapshotUrl = null) {
    const snapUrl = String(
        customSnapshotUrl ||
        process.env.GITHUB_SNAPSHOT_URL ||
        config.githubSync?.snapshotUrl ||
        config.agent?.githubSnapshotUrl ||
        'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json'
    ).trim();
    if (!snapUrl) return '';
    return snapUrl.replace(/\/[^/?#]+(?:\?.*)?$/, '');
}

function buildAudioMirrorCandidates(rawFileUrl) {
    const cleanUrl = String(rawFileUrl || '').trim();
    if (!cleanUrl) return [];
    const candidates = [];

    const ghRawMatch = cleanUrl.match(
        /^https:\/\/raw\.githubusercontent\.com\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^?#]+)$/
    );
    if (ghRawMatch) {
        const [, owner, repo, branch, filePath] = ghRawMatch;
        candidates.push({ url: cleanUrl, headers: {} });
        candidates.push({ url: `https://ghfast.top/${cleanUrl}`, headers: {} });
        candidates.push({
            url: `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
            headers: { Accept: 'application/vnd.github.v3.raw' }
        });
    } else {
        candidates.push({ url: cleanUrl, headers: {} });
    }
    return candidates;
}

function normalizeChapter(rawCh, idx) {
    if (!rawCh || typeof rawCh !== 'object') return null;
    const title = String(rawCh.title || `第 ${idx + 1} 节`).trim();
    const text = String(rawCh.text || '').trim();
    if (!title && !text) return null;

    const speaker = String(rawCh.speaker || 'Serena').trim();
    const defaultSpeakerLabel = speaker === 'Lin_Yuan'
        ? '林远 · 深度评论'
        : (speaker === 'Uncle_Fu' ? '傅老师 · 深度评论' : `${speaker} · 要闻主播`);
    const startSec = Math.max(0, Number(Number(rawCh.startSec || 0).toFixed(2)) || 0);
    const durationSec = Math.max(0, Number(Number(rawCh.durationSec || 0).toFixed(2)) || 0);

    return {
        index: Number(rawCh.index) || idx + 1,
        id: String(rawCh.id || `ch-${idx + 1}`).trim(),
        title,
        speaker,
        speakerLabel: String(rawCh.speakerLabel || defaultSpeakerLabel).trim(),
        startSec,
        durationSec,
        text
    };
}

function normalizeVoiceEntry(v) {
    if (!v || typeof v !== 'object') return null;
    const id = String(v.id || '').trim();
    const name = String(v.name || id).trim();
    if (!id && !name) return null;
    return {
        id: id || name,
        name: name || id,
        role: String(v.role || '').trim()
    };
}

function normalizeAudioTrack(rawTrack, trackKey, options = {}) {
    if (!rawTrack || typeof rawTrack !== 'object') return null;
    const key = VALID_TRACK_KEYS.includes(trackKey)
        ? trackKey
        : (VALID_TRACK_KEYS.includes(rawTrack.track) ? rawTrack.track : null);
    if (!key) return null;

    const durationSec = Number(rawTrack.durationSec || 0);
    const sizeBytes = Math.max(0, parseInt(rawTrack.sizeBytes, 10) || 0);
    const title = String(rawTrack.title || '').trim();
    if (!title || (durationSec <= 0 && sizeBytes <= 0)) {
        return null;
    }

    const fileName = TRACK_SNAPSHOT_FILENAMES[key];
    const sha256 = String(rawTrack.sha256 || '').trim().toLowerCase();
    const generatedAt = String(rawTrack.generatedAt || new Date().toISOString()).trim();
    const versionToken = sha256 ? sha256.slice(0, 10) : String(new Date(generatedAt).getTime() || Date.now());
    const rawDirUrl = resolveSnapshotRawDirUrl(options.snapshotUrl);

    const chapters = Array.isArray(rawTrack.chapters)
        ? rawTrack.chapters.map((c, i) => normalizeChapter(c, i)).filter(Boolean)
        : [];
    const voices = Array.isArray(rawTrack.voices) && rawTrack.voices.length > 0
        ? rawTrack.voices.map(normalizeVoiceEntry).filter(Boolean)
        : [
            { id: 'Lin_Yuan', name: '林远', role: '深度综述评论' },
            { id: 'Serena', name: 'Serena', role: '重点要闻主播' }
        ];

    return {
        track: key,
        label: String(rawTrack.label || TRACK_DEFAULT_LABELS[key]).trim(),
        title,
        subtitle: String(rawTrack.subtitle || '林远 & Serena 双主播交替播报').trim(),
        issueKey: rawTrack.issueKey ? String(rawTrack.issueKey).trim() : null,
        editionTimestamp: rawTrack.editionTimestamp ? String(rawTrack.editionTimestamp).trim() : null,
        generatedAt,
        fileName,
        audioUrl: `/api/audio/${key}.mp3?v=${encodeURIComponent(versionToken)}`,
        rawUrl: String(rawTrack.rawUrl || (rawDirUrl ? `${rawDirUrl}/${fileName}` : '')).trim(),
        sha256,
        format: String(rawTrack.format || 'mp3').toLowerCase(),
        mimeType: String(rawTrack.mimeType || 'audio/mpeg').trim(),
        sampleRate: parseInt(rawTrack.sampleRate, 10) || 24000,
        bitrateKbps: parseInt(rawTrack.bitrateKbps, 10) || 80,
        sizeBytes,
        durationSec: Number(durationSec.toFixed(2)),
        model: String(rawTrack.model || 'Qwen3-TTS-12Hz-1.7B-CustomVoice (BF16)').trim(),
        voices,
        chapters
    };
}

function normalizeAudioBroadcastBundle(rawInput, options = {}) {
    if (!rawInput || typeof rawInput !== 'object') return null;

    const rawTracksObj = (rawInput.tracks && typeof rawInput.tracks === 'object')
        ? rawInput.tracks
        : (VALID_TRACK_KEYS.includes(rawInput.track) ? { [rawInput.track]: rawInput } : {});

    const tracks = {};
    for (const key of VALID_TRACK_KEYS) {
        if (rawTracksObj[key]) {
            const norm = normalizeAudioTrack(rawTracksObj[key], key, options);
            if (norm) {
                tracks[key] = norm;
            }
        }
    }

    const availableKeys = Object.keys(tracks);
    if (availableKeys.length === 0) {
        return null;
    }

    const latestMs = availableKeys.reduce((acc, k) => {
        const ms = new Date(tracks[k].generatedAt || 0).getTime() || 0;
        return ms > acc ? ms : acc;
    }, 0);

    const updatedAt = String(
        options.updatedAt ||
        rawInput.updatedAt ||
        (latestMs > 0 ? new Date(latestMs).toISOString() : new Date().toISOString())
    ).trim();

    const defaultTrack = tracks.news ? 'news' : availableKeys[0];

    return {
        version: '1.0',
        updatedAt,
        defaultTrack,
        trackCount: availableKeys.length,
        tracks
    };
}

class AudioBroadcastService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this._inflightDownloads = new Map();
    }

    getMetadataPath() {
        return config.storage?.audioBroadcastFile ||
            path.join(config.storage?.dataDir || path.join(__dirname, '..', 'data'), 'audio_broadcast.json');
    }

    getAudioDir() {
        return config.storage?.audioDir ||
            path.join(config.storage?.dataDir || path.join(__dirname, '..', 'data'), 'audio');
    }

    getTrackAudioPath(trackKey) {
        const cleanKey = String(trackKey || '').replace(/\.mp3$/i, '').trim().toLowerCase();
        if (!VALID_TRACK_KEYS.includes(cleanKey)) return null;
        return path.join(this.getAudioDir(), TRACK_SNAPSHOT_FILENAMES[cleanKey]);
    }

    async loadLocalBundle(options = {}) {
        const saved = await readJsonFile(this.getMetadataPath(), null);
        return normalizeAudioBroadcastBundle(saved, options);
    }

    async saveBundle(bundleInput, options = {}) {
        const normalized = normalizeAudioBroadcastBundle(bundleInput, options);
        if (!normalized) return null;

        await writeJsonFile(this.getMetadataPath(), normalized);

        if (this.stateManager) {
            if (typeof this.stateManager.updateAudioBroadcast === 'function') {
                this.stateManager.updateAudioBroadcast(normalized, options.emit !== false);
            } else {
                this.stateManager.set('audioBroadcast', normalized, options.emit !== false);
            }
        }
        return normalized;
    }

    /**
     * 将单条新合成音轨无损合入本地 `data/audio_broadcast.json`（保留另一条音轨）
     */
    async mergeTrack(trackKey, trackPayload, audioBuffer = null, options = {}) {
        const cleanKey = String(trackKey || '').replace(/\.mp3$/i, '').trim().toLowerCase();
        if (!VALID_TRACK_KEYS.includes(cleanKey)) {
            throw new Error(`不支持的语音播报音轨类型: ${trackKey}`);
        }

        const existing = (this.stateManager && this.stateManager.get('audioBroadcast')) ||
            (await this.loadLocalBundle(options)) ||
            { tracks: {} };

        const audioPath = this.getTrackAudioPath(cleanKey);
        fs.mkdirSync(path.dirname(audioPath), { recursive: true });

        let finalSha = String(trackPayload?.sha256 || '').trim().toLowerCase();
        let finalSize = parseInt(trackPayload?.sizeBytes, 10) || 0;

        if (Buffer.isBuffer(audioBuffer) && audioBuffer.length > 0) {
            const tmpPath = `${audioPath}.tmp.${process.pid}.${Date.now()}`;
            fs.writeFileSync(tmpPath, audioBuffer);
            fs.renameSync(tmpPath, audioPath);
            finalSha = computeBufferSha256(audioBuffer);
            finalSize = audioBuffer.length;
        } else if (fs.existsSync(audioPath)) {
            const stat = fs.statSync(audioPath);
            finalSize = stat.size;
            if (!finalSha) {
                finalSha = computeFileSha256(audioPath) || '';
            }
        }

        const mergedRaw = {
            version: '1.0',
            updatedAt: new Date().toISOString(),
            tracks: {
                ...(existing.tracks || {}),
                [cleanKey]: {
                    ...trackPayload,
                    track: cleanKey,
                    sha256: finalSha,
                    sizeBytes: finalSize || trackPayload?.sizeBytes || 0
                }
            }
        };

        return await this.saveBundle(mergedRaw, options);
    }

    isLocalAudioFresh(trackMeta, localFilePath) {
        if (!trackMeta || !localFilePath || !fs.existsSync(localFilePath)) {
            return false;
        }
        try {
            const stat = fs.statSync(localFilePath);
            if (stat.size < 128) return false;
            if (trackMeta.sha256) {
                const diskSha = computeFileSha256(localFilePath);
                return diskSha === trackMeta.sha256.toLowerCase();
            }
            if (trackMeta.sizeBytes > 0) {
                return stat.size === trackMeta.sizeBytes;
            }
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * 确保指定音轨的 MP3 已缓存在本地 `data/audio/briefing-<track>.mp3`；
     * 若在软路由端本地缺失或哈希已过期，则自动从远端快照同目录拉取并原子落盘。
     */
    async ensureLocalAudioFile(trackKey, options = {}) {
        const cleanKey = String(trackKey || '').replace(/\.mp3$/i, '').trim().toLowerCase();
        if (!VALID_TRACK_KEYS.includes(cleanKey)) return null;

        const bundle = options.bundle ||
            (this.stateManager && this.stateManager.get('audioBroadcast')) ||
            (await this.loadLocalBundle(options));
        const trackMeta = bundle?.tracks?.[cleanKey] || null;
        const localPath = this.getTrackAudioPath(cleanKey);

        if (!trackMeta) {
            return (localPath && fs.existsSync(localPath)) ? localPath : null;
        }

        if (this.isLocalAudioFresh(trackMeta, localPath)) {
            return localPath;
        }

        if (this._inflightDownloads.has(cleanKey)) {
            return await this._inflightDownloads.get(cleanKey);
        }

        const dlPromise = (async () => {
            const rawDirUrl = resolveSnapshotRawDirUrl(options.snapshotUrl);
            const primaryRawUrl = (options.snapshotUrl && rawDirUrl)
                ? `${rawDirUrl}/${trackMeta.fileName || TRACK_SNAPSHOT_FILENAMES[cleanKey]}`
                : (trackMeta.rawUrl || (rawDirUrl ? `${rawDirUrl}/${TRACK_SNAPSHOT_FILENAMES[cleanKey]}` : ''));

            if (!primaryRawUrl) {
                return fs.existsSync(localPath) ? localPath : null;
            }

            const candidates = buildAudioMirrorCandidates(primaryRawUrl);
            let lastErr = null;
            for (const cand of candidates) {
                const sep = cand.url.includes('?') ? '&' : '?';
                const reqUrl = `${cand.url}${sep}_t=${Date.now()}`;
                let isLocalHost = false;
                try {
                    const host = new URL(reqUrl).hostname.toLowerCase();
                    isLocalHost = host === '127.0.0.1' || host === 'localhost' || host === '::1';
                } catch (_) {}

                try {
                    const resp = await axios.get(reqUrl, {
                        responseType: 'arraybuffer',
                        timeout: 30000,
                        maxContentLength: 40 * 1024 * 1024,
                        httpsAgent: audioFetchHttpsAgent,
                        headers: {
                            'Cache-Control': 'no-cache',
                            'User-Agent': 'CoreFeed-Audio-Sync/2.0',
                            ...cand.headers
                        },
                        ...(isLocalHost ? { proxy: false } : {})
                    });
                    const buf = Buffer.from(resp.data);
                    if (!buf || buf.length < 128) {
                        throw new Error(`远端音频返回字节过小 (${buf ? buf.length : 0}B)`);
                    }
                    if (trackMeta.sha256) {
                        const actualSha = computeBufferSha256(buf);
                        if (actualSha !== trackMeta.sha256.toLowerCase()) {
                            throw new Error(`远端音频 SHA-256 不匹配 (expected=${trackMeta.sha256.slice(0, 8)}, got=${actualSha.slice(0, 8)})`);
                        }
                    }

                    fs.mkdirSync(path.dirname(localPath), { recursive: true });
                    const tmpPath = `${localPath}.tmp.${process.pid}.${Date.now()}`;
                    fs.writeFileSync(tmpPath, buf);
                    fs.renameSync(tmpPath, localPath);
                    logger.info('AUDIO-SYNC', `已同步缓存播报音频 ${cleanKey} (${Math.round(buf.length / 1024)} KiB)`);
                    return localPath;
                } catch (err) {
                    lastErr = err;
                }
            }

            if (lastErr) {
                logger.warn('AUDIO-SYNC', `拉取远端音频 ${cleanKey} 暂未成功: ${lastErr.message}`);
            }
            return fs.existsSync(localPath) ? localPath : null;
        })();

        this._inflightDownloads.set(cleanKey, dlPromise);
        try {
            return await dlPromise;
        } finally {
            this._inflightDownloads.delete(cleanKey);
        }
    }

    async syncRemoteAudioFiles(bundle, options = {}) {
        const tracks = bundle?.tracks || {};
        const synced = {};
        for (const key of Object.keys(tracks)) {
            const p = await this.ensureLocalAudioFile(key, { ...options, bundle });
            synced[key] = Boolean(p && fs.existsSync(p));
        }
        return synced;
    }
}

module.exports = {
    VALID_TRACK_KEYS,
    TRACK_SNAPSHOT_FILENAMES,
    AudioBroadcastService,
    normalizeAudioTrack,
    normalizeAudioBroadcastBundle,
    computeBufferSha256,
    computeFileSha256,
    resolveSnapshotRawDirUrl
};
