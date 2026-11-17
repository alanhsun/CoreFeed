/**
 * 聚核 CoreFeed v2.0 — 欧美社媒热议 (Western Social Pulse) 聚合与标准化服务
 *
 * 核心职责：
 *   1. 标准化 `daily`（每日全量欧美热议日报）与 `topic`（特定议题跨平台深挖）结构化 JSON
 *   2. 在采编端自动扫描本机 `欧美社媒热议/data/{digests,topics}/*.json` 并与 `CoreFeed/data/social_pulse.json` 合并去重
 *   3. 在自托管服务端（软路由 / Docker）零外部目录依赖地从 `data/social_pulse.json` 与 `ag-snapshot/latest.json` 读写展示
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');
const { readJsonFile, writeJsonFile } = require('../utils/helpers');

const DEFAULT_MAX_ISSUES = 14;
const ALLOWED_SOCIAL_HOSTS = new Set([
    'x.com',
    'twitter.com',
    'threads.com',
    'threads.net',
    'reddit.com',
    'old.reddit.com'
]);

function getDefaultExternalPulseDir() {
    if (process.env.SOCIAL_PULSE_WORKSPACE && String(process.env.SOCIAL_PULSE_WORKSPACE).trim()) {
        return path.resolve(String(process.env.SOCIAL_PULSE_WORKSPACE).trim());
    }
    if (config.socialPulse?.workspaceDir) {
        return path.resolve(config.socialPulse.workspaceDir);
    }
    const home = process.env.USERPROFILE || process.env.HOME || '';
    if (home) {
        const winDefault = path.join(home, 'Documents', 'antigravity', '欧美社媒热议');
        if (fs.existsSync(winDefault)) {
            return winDefault;
        }
    }
    return null;
}

function sanitizeSocialUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (!trimmed.startsWith('https://')) return '';
    try {
        const parsed = new URL(trimmed);
        let host = (parsed.hostname || '').toLowerCase();
        for (const prefix of ['www.', 'm.', 'mobile.', 'old.', 'np.', 'new.']) {
            if (host.startsWith(prefix) && host.split('.').length >= 3) {
                host = host.slice(prefix.length);
                break;
            }
        }
        if (!ALLOWED_SOCIAL_HOSTS.has(host) && !ALLOWED_SOCIAL_HOSTS.has(parsed.hostname.toLowerCase())) {
            return '';
        }
        return parsed.toString();
    } catch (_) {
        return '';
    }
}

function buildIssueKey(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.key === 'string' && raw.key.trim()) {
        return raw.key.trim();
    }
    const mode = raw.mode === 'topic' ? 'topic' : 'daily';
    const date = String(raw.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    if (mode === 'topic') {
        const slug = String(raw.slug || 'topic').trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
        return `topic:${date}:${slug}`;
    }
    return `daily:${date}`;
}

function normalizeQuote(q) {
    if (!q || typeof q !== 'object') return null;
    const platform = ['X', 'Threads', 'Reddit'].includes(q.platform) ? q.platform : 'Reddit';
    const quoteZh = String(q.quote_zh || q.quoteZh || '').trim();
    const quoteOriginal = String(q.quote_original || q.quoteOriginal || '').trim();
    const sourceUrl = sanitizeSocialUrl(q.source_url || q.sourceUrl || '');
    if (!quoteZh && !quoteOriginal) return null;
    return {
        platform,
        community_or_handle: String(q.community_or_handle || q.handle || platform).trim(),
        language: String(q.language || 'en').trim().toLowerCase(),
        metrics: String(q.metrics || '').trim(),
        quote_zh: quoteZh,
        quote_original: quoteOriginal,
        source_url: sourceUrl
    };
}

function normalizeCamp(c) {
    if (!c || typeof c !== 'object') return null;
    const label = String(c.label || '').trim();
    const summary = String(c.summary || '').trim();
    if (!label && !summary) return null;
    const shareStr = String(c.share_estimate || c.shareEstimate || '').trim();
    const pctMatch = shareStr.match(/(\d{1,3})\s*%/);
    const sharePercent = pctMatch ? Math.min(100, Math.max(0, parseInt(pctMatch[1], 10))) : null;
    return {
        label: label || '观点阵营',
        share_estimate: shareStr || '',
        share_percent: sharePercent,
        summary
    };
}

function normalizeCluster(cl, idx) {
    if (!cl || typeof cl !== 'object') return null;
    const titleZh = String(cl.title_zh || cl.titleZh || '').trim();
    if (!titleZh) return null;

    const region = ['US', 'EU', 'GLOBAL'].includes(cl.region) ? cl.region : 'GLOBAL';
    const countries = Array.isArray(cl.countries)
        ? cl.countries.map(c => String(c).trim()).filter(Boolean)
        : (region === 'US' ? ['US'] : ['EU']);
    const languages = Array.isArray(cl.languages)
        ? cl.languages.map(l => String(l).trim().toLowerCase()).filter(Boolean)
        : ['en'];
    const platforms = Array.isArray(cl.platforms)
        ? cl.platforms.filter(p => ['X', 'Threads', 'Reddit'].includes(p))
        : [];
    const rawVibes = (cl.platform_vibes && typeof cl.platform_vibes === 'object') ? cl.platform_vibes : {};
    const platformVibes = {};
    for (const plat of ['X', 'Threads', 'Reddit']) {
        const val = rawVibes[plat] || rawVibes[plat.toLowerCase()];
        if (typeof val === 'string' && val.trim()) {
            platformVibes[plat] = val.trim();
        }
    }

    const camps = Array.isArray(cl.camps) ? cl.camps.map(normalizeCamp).filter(Boolean) : [];
    const quotes = Array.isArray(cl.featured_quotes) ? cl.featured_quotes.map(normalizeQuote).filter(Boolean) : [];

    return {
        id: String(cl.id || `cluster-${idx + 1}`).trim(),
        region,
        countries,
        languages,
        category: String(cl.category || '社会与文化').trim(),
        platforms: platforms.length > 0 ? platforms : Object.keys(platformVibes),
        heat_score: Math.min(100, Math.max(1, parseInt(cl.heat_score, 10) || 80)),
        is_followup: Boolean(cl.is_followup),
        followup_note: cl.is_followup && cl.followup_note ? String(cl.followup_note).trim() : null,
        title_zh: titleZh,
        hook_one_liner: String(cl.hook_one_liner || '').trim(),
        trigger_and_context: String(cl.trigger_and_context || '').trim(),
        camps,
        platform_vibes: platformVibes,
        featured_quotes: quotes
    };
}

function normalizePulseIssue(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const key = buildIssueKey(raw);
    if (!key) return null;

    const mode = raw.mode === 'topic' ? 'topic' : 'daily';
    const headline = String(raw.headline || '').trim();
    const clusters = Array.isArray(raw.clusters)
        ? raw.clusters.map((c, idx) => normalizeCluster(c, idx)).filter(Boolean)
        : [];

    if (!headline || clusters.length === 0) {
        return null;
    }

    const execRaw = (raw.executive_summary && typeof raw.executive_summary === 'object')
        ? raw.executive_summary
        : {};
    const moodRaw = (execRaw.platform_mood && typeof execRaw.platform_mood === 'object')
        ? execRaw.platform_mood
        : {};
    const platformMood = {};
    for (const plat of ['X', 'Threads', 'Reddit']) {
        const mv = moodRaw[plat] || moodRaw[plat.toLowerCase()];
        if (typeof mv === 'string' && mv.trim()) {
            platformMood[plat] = mv.trim();
        }
    }

    const comparisons = Array.isArray(raw.transatlantic_comparisons)
        ? raw.transatlantic_comparisons
            .filter(c => c && typeof c === 'object' && (c.topic || c.verdict))
            .map(c => ({
                topic: String(c.topic || '').trim(),
                us_angle: String(c.us_angle || '').trim(),
                eu_angle: String(c.eu_angle || '').trim(),
                verdict: String(c.verdict || '').trim()
            }))
        : [];

    return {
        schema_version: String(raw.schema_version || '1.0'),
        key,
        mode,
        date: String(raw.date).trim(),
        slug: mode === 'topic' ? String(raw.slug || '').trim() : null,
        query: mode === 'topic' ? String(raw.query || '').trim() : null,
        generated_at: String(raw.generated_at || new Date().toISOString()).trim(),
        window_hours: parseInt(raw.window_hours, 10) || 24,
        headline,
        executive_summary: {
            overview: String(execRaw.overview || '').trim(),
            platform_mood: platformMood
        },
        transatlantic_comparisons: comparisons,
        clusters
    };
}

function comparePulseIssuesDesc(a, b) {
    if (a.date !== b.date) {
        return b.date.localeCompare(a.date);
    }
    if (a.mode !== b.mode) {
        return a.mode === 'daily' ? -1 : 1;
    }
    const ta = new Date(a.generated_at || 0).getTime() || 0;
    const tb = new Date(b.generated_at || 0).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return String(b.key).localeCompare(String(a.key));
}

function normalizeSocialPulseBundle(bundleInput, options = {}) {
    if (!bundleInput || typeof bundleInput !== 'object') {
        return null;
    }
    const maxIssues = Math.max(1, parseInt(options.maxIssues, 10) || config.socialPulse?.maxIssues || DEFAULT_MAX_ISSUES);

    let rawList = [];
    if (Array.isArray(bundleInput.issues)) {
        rawList = bundleInput.issues;
    } else if (Array.isArray(bundleInput)) {
        rawList = bundleInput;
    } else if (bundleInput.clusters && bundleInput.date) {
        rawList = [bundleInput];
    }

    const byKey = new Map();
    for (const item of rawList) {
        const norm = normalizePulseIssue(item);
        if (!norm) continue;
        const prev = byKey.get(norm.key);
        if (!prev) {
            byKey.set(norm.key, norm);
        } else {
            const prevMs = new Date(prev.generated_at || 0).getTime() || 0;
            const curMs = new Date(norm.generated_at || 0).getTime() || 0;
            if (curMs >= prevMs) {
                byKey.set(norm.key, norm);
            }
        }
    }

    const sorted = Array.from(byKey.values()).sort(comparePulseIssuesDesc).slice(0, maxIssues);
    if (sorted.length === 0) {
        return null;
    }

    const preferredDaily = sorted.find(it => it.mode === 'daily');
    const latestKey = (bundleInput.latestKey && sorted.some(it => it.key === bundleInput.latestKey))
        ? bundleInput.latestKey
        : (preferredDaily ? preferredDaily.key : sorted[0].key);

    const latestGeneratedMs = sorted.reduce((acc, it) => {
        const ms = new Date(it.generated_at || 0).getTime() || 0;
        return ms > acc ? ms : acc;
    }, 0);
    const updatedAt = String(
        options.updatedAt ||
        bundleInput.updatedAt ||
        (latestGeneratedMs > 0 ? new Date(latestGeneratedMs).toISOString() : new Date().toISOString())
    ).trim();

    return {
        version: '1.0',
        updatedAt,
        latestKey,
        issueCount: sorted.length,
        issues: sorted
    };
}

function scanExternalPulseIssues(workspaceDir) {
    if (!workspaceDir || !fs.existsSync(workspaceDir)) {
        return [];
    }
    const collected = [];
    for (const sub of [path.join('data', 'digests'), path.join('data', 'topics')]) {
        const folder = path.join(workspaceDir, sub);
        if (!fs.existsSync(folder)) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(folder).filter(f => f.endsWith('.json')).sort();
        } catch (_) {
            continue;
        }
        for (const fn of entries) {
            const fullPath = path.join(folder, fn);
            try {
                const parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
                const norm = normalizePulseIssue(parsed);
                if (norm) {
                    collected.push(norm);
                }
            } catch (err) {
                logger.warn('SOCIAL-PULSE', `跳过无法解析的社媒归档文件 ${fullPath}: ${err.message}`);
            }
        }
    }
    return collected;
}

class SocialPulseService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
    }

    getStoragePath() {
        return config.storage?.socialPulseFile || path.join(config.storage?.dataDir || path.join(__dirname, '..', 'data'), 'social_pulse.json');
    }

    async loadLocalBundle() {
        const filePath = this.getStoragePath();
        const saved = await readJsonFile(filePath, null);
        return normalizeSocialPulseBundle(saved);
    }

    async saveBundle(bundle, options = {}) {
        const normalized = normalizeSocialPulseBundle(bundle, options);
        if (!normalized) return null;

        const filePath = this.getStoragePath();
        await writeJsonFile(filePath, normalized);

        if (this.stateManager) {
            if (typeof this.stateManager.updateSocialPulse === 'function') {
                this.stateManager.updateSocialPulse(normalized, options.emit !== false);
            } else {
                this.stateManager.set('socialPulse', normalized, options.emit !== false);
            }
        }
        return normalized;
    }

    /**
     * 从本机 `欧美社媒热议` 目录（及可选单文件）读取全部归档，与本地 `data/social_pulse.json` 合并落盘
     */
    async syncFromExternalWorkspace(options = {}) {
        const sourceDir = options.sourceDir !== undefined
            ? (options.sourceDir ? path.resolve(options.sourceDir) : null)
            : getDefaultExternalPulseDir();
        const extraFiles = Array.isArray(options.files)
            ? options.files
            : (options.file ? [options.file] : []);
        const maxIssues = options.maxIssues || config.socialPulse?.maxIssues || DEFAULT_MAX_ISSUES;

        const existing = await this.loadLocalBundle();
        const mergedInput = [...(existing?.issues || [])];
        const prevMap = new Map((existing?.issues || []).map(i => [i.key, JSON.stringify(i)]));

        if (sourceDir) {
            const scanned = scanExternalPulseIssues(sourceDir);
            mergedInput.push(...scanned);
        }

        for (const f of extraFiles) {
            if (!f) continue;
            const fullPath = path.resolve(f);
            if (!fs.existsSync(fullPath)) {
                throw new Error(`指定的社媒精编文件不存在: ${fullPath}`);
            }
            const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
            if (Array.isArray(raw.issues)) {
                mergedInput.push(...raw.issues);
            } else {
                mergedInput.push(raw);
            }
        }

        if (mergedInput.length === 0) {
            return existing || null;
        }

        const candidateBundle = normalizeSocialPulseBundle(
            { issues: mergedInput },
            {
                maxIssues,
                updatedAt: existing?.updatedAt || new Date().toISOString()
            }
        );
        if (!candidateBundle) {
            return existing || null;
        }

        const hasChanges =
            !existing ||
            existing.issues.length !== candidateBundle.issues.length ||
            candidateBundle.issues.some(it => prevMap.get(it.key) !== JSON.stringify(it));

        const finalUpdatedAt = options.bumpTimestamp || hasChanges
            ? new Date().toISOString()
            : (existing.updatedAt || candidateBundle.updatedAt);

        return await this.saveBundle(
            {
                ...candidateBundle,
                latestKey: options.latestKey || undefined,
                updatedAt: finalUpdatedAt
            },
            {
                maxIssues,
                updatedAt: finalUpdatedAt,
                emit: options.emit !== false
            }
        );
    }
}

module.exports = {
    SocialPulseService,
    normalizePulseIssue,
    normalizeSocialPulseBundle,
    scanExternalPulseIssues,
    getDefaultExternalPulseDir,
    sanitizeSocialUrl
};
