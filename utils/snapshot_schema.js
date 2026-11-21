/**
 * 聚核 CoreFeed v3.0 — ag-snapshot 瘦身契约与分域序列化工具 (utils/snapshot_schema.js)
 *
 * 核心职责：
 *   1. 定义 Schema v3.0 精简文章/综述规范 (`stripArticleForSnapshot`, `stripSummaryForSnapshot`)，
 *      消除 `allEnhancedNews`、`content`、`fullText`、`translatedContent`、`translatedDescription`、
 *      `summary`、`htmlContent` 等重复冗余字段与缩进空白；
 *   2. 将发布快照确定性拆分为独立域文件 (`manifest.json` + `news.json` + `pulse.json` + `audio.json`)，
 *      保证仅更新 pulse 时 `news.json` SHA-256 严格不变、仅更新 news 时 `pulse.json` SHA-256 严格不变；
 *   3. 提供统一的同目录文件 URL 推导 (`deriveSiblingFileUrl`) 与分域快照重组 (`reassembleCombinedSnapshot`)。
 */
const crypto = require('crypto');
const { normalizeRegion, normalizeCategory, createSummaryArticleObject } = require('./editorial_formatter');
const { normalizeSocialPulseBundle } = require('../services/social_pulse_service');
const { normalizeAudioBroadcastBundle } = require('../services/audio_broadcast_service');

const SNAPSHOT_SCHEMA_VERSION = '3.0';
const DEFAULT_SNAPSHOT_URL = 'https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/manifest.json';

function computeSha256(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 确定性段落切分（供 ag-harvest 编号段落与 ag-publish keepParagraphs 还原共用）
 */
function splitCandidateParagraphs(rawText = '', language = 'en') {
    const str = String(rawText || '').replace(/\r\n/g, '\n').trim();
    if (!str) return [];
    const isCjk = ['ja', 'ko', 'zh'].includes(String(language || '').toLowerCase());
    const minLen = isCjk ? 8 : 12;
    const paras = str
        .split(/\n+/)
        .map(p => p.replace(/[ \t]+/g, ' ').trim())
        .filter(p => p.length >= minLen);
    if (paras.length > 0) return paras;
    const single = str.replace(/[ \t]+/g, ' ').trim();
    return single ? [single] : [];
}

/**
 * 从任意快照 URL（raw.githubusercontent.com / api.github.com Contents API / ghfast.top 代理 / 局域网 mock URL）
 * 推导出同分支目录下的兄弟文件 URL（如 manifest.json / news.json / pulse.json / audio.json）
 */
function deriveSiblingFileUrl(snapshotUrl, targetFileName) {
    let cleanUrl = String(snapshotUrl || '').trim();
    const file = String(targetFileName || '').replace(/^\/+/, '').trim();
    if (!cleanUrl || !file) return '';

    const proxyUnwrap = cleanUrl.match(/^https:\/\/ghfast\.top\/(https:\/\/.+)$/i);
    if (proxyUnwrap) {
        cleanUrl = proxyUnwrap[1];
    }

    const apiMatch = cleanUrl.match(
        /^https:\/\/api\.github\.com\/repos\/([^/?#]+)\/([^/?#]+)\/contents\/([^?#]*)(?:\?([^#]*))?$/i
    );
    if (apiMatch) {
        const [, owner, repo, relPath, qs = ''] = apiMatch;
        const params = new URLSearchParams(qs);
        const branch = (params.get('ref') || 'ag-snapshot').trim();
        const dirPart = relPath.includes('/') ? relPath.replace(/\/[^/]+$/, '') : '';
        return dirPart
            ? `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${dirPart}/${file}`
            : `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(branch)}/${file}`;
    }

    const withoutQuery = cleanUrl.split('?')[0].split('#')[0];
    if (/\/$/.test(withoutQuery)) {
        return `${withoutQuery}${file}`;
    }
    const lastSlash = withoutQuery.lastIndexOf('/');
    if (lastSlash === -1) return file;
    return `${withoutQuery.slice(0, lastSlash + 1)}${file}`;
}

function slimSourceObject(rawSource, fallbackName = 'Global Media') {
    if (rawSource && typeof rawSource === 'object') {
        const out = {
            id: String(rawSource.id || 'external').trim(),
            name: String(rawSource.name || fallbackName).trim() || fallbackName
        };
        if (rawSource.authority !== undefined && rawSource.authority !== null) {
            out.authority = Number(rawSource.authority);
        }
        if (rawSource.language) {
            out.language = String(rawSource.language).trim().toLowerCase();
        }
        if (rawSource.paywall) {
            out.paywall = String(rawSource.paywall).trim().toLowerCase();
        }
        if (rawSource.strategy) {
            out.strategy = String(rawSource.strategy).trim();
        }
        return out;
    }
    return {
        id: 'external',
        name: String(rawSource || fallbackName).trim() || fallbackName
    };
}

function slimRelatedSources(relatedSources) {
    if (!Array.isArray(relatedSources) || relatedSources.length === 0) return [];
    return relatedSources
        .filter(Boolean)
        .map((rs) => ({
            name: String(rs.name || 'Global Media').trim(),
            url: String(rs.url || '').trim(),
            ...(rs.title ? { title: String(rs.title).trim() } : {}),
            ...(rs.publishedAt ? { publishedAt: String(rs.publishedAt).trim() } : {})
        }))
        .filter((rs) => rs.url || rs.name);
}

/**
 * 将单篇新闻精简为 Schema v3.0 权威结构（彻底移除 fullText / content / translatedContent / translatedDescription / description 重复字段）
 */
function stripArticleForSnapshot(item, idx = 0, fallbackIso = null) {
    if (!item || typeof item !== 'object') return null;

    const rawTitle = String(item.title || item.translatedTitle || `News #${idx + 1}`).trim();
    const zhTitle = String(item.translatedTitle || rawTitle).trim();
    const zhSummary = String(
        item.summary || item.translatedDescription || item.description || rawTitle
    ).trim();

    const rawFullFallback = String(item.fullText || item.content || item.description || '').trim();
    const originalParagraphs = Array.isArray(item.originalParagraphs) && item.originalParagraphs.length > 0
        ? item.originalParagraphs.map(p => String(p).trim()).filter(Boolean)
        : (rawFullFallback
            ? rawFullFallback.split(/\n+/).map(p => p.trim()).filter(p => p.length >= 10)
            : []);

    const translatedParagraphs = Array.isArray(item.translatedParagraphs) && item.translatedParagraphs.length > 0
        ? item.translatedParagraphs.map(p => String(p).trim()).filter(Boolean)
        : (item.translatedContent
            ? String(item.translatedContent).split(/\n+/).map(p => p.trim()).filter(Boolean)
            : (zhSummary ? [zhSummary] : []));

    const keyPoints = Array.isArray(item.keyPoints)
        ? item.keyPoints.map(k => String(k).trim()).filter(Boolean)
        : [];
    const relatedSources = slimRelatedSources(item.relatedSources);
    const sourceCount = Math.max(Number(item.sourceCount) || 0, 1 + relatedSources.length);
    const effectiveIso = fallbackIso || new Date().toISOString();

    return {
        id: String(item.id || `ag-${idx + 1}`).trim(),
        title: rawTitle,
        translatedTitle: zhTitle,
        summary: zhSummary,
        originalParagraphs,
        translatedParagraphs,
        keyPoints,
        url: String(item.url || '').trim(),
        urlToImage: item.urlToImage || null,
        publishedAt: item.publishedAt || effectiveIso,
        processedAt: item.processedAt || effectiveIso,
        region: normalizeRegion(item.region, '国际'),
        category: normalizeCategory(item.category, '国际'),
        aiCompiled: item.aiCompiled !== undefined ? Boolean(item.aiCompiled) : true,
        qualityScore: Number(item.qualityScore) || 88,
        source: slimSourceObject(item.source, item.sourceName || 'Global Media'),
        relatedSources,
        sourceCount
    };
}

/**
 * 精简今日深度综述对象（剔除在服务端强制重建的 htmlContent）
 */
function stripSummaryForSnapshot(rawSummary, newsList = [], publishedAtIso = null) {
    if (!rawSummary) return null;

    const ts = publishedAtIso ? new Date(publishedAtIso) : new Date();
    const validTs = isNaN(ts.getTime()) ? new Date() : ts;
    const nowIso = validTs.toISOString();
    const currentDate = validTs.toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        weekday: 'long',
        timeZone: 'Asia/Shanghai'
    });

    if (typeof rawSummary === 'string') {
        const md = rawSummary.trim();
        if (!md) return null;
        const firstLine = md.split('\n').map(l => l.trim()).find(Boolean) || '';
        const mdWithTitle = /^(#{2,4}\s|【)/.test(firstLine)
            ? `${currentDate} 全球要闻深度综述\n\n${md}`
            : md;
        const created = createSummaryArticleObject(mdWithTitle, newsList, currentDate);
        return {
            title: created.title,
            content: created.content,
            newsCount: created.newsCount || newsList.length,
            regions: created.regions || [],
            generatedAt: created.generatedAt || nowIso,
            summary: created.summary || '',
            wordCount: created.wordCount || created.content.length
        };
    }

    if (typeof rawSummary !== 'object') return null;
    const content = String(rawSummary.content || rawSummary.markdown || '').trim();
    if (!content) return null;

    const plainForSummary = content.replace(/\[NEWS_\d+\]/g, '').replace(/#+\s*/g, '').trim();
    return {
        title: String(rawSummary.title || `${currentDate} 全球要闻深度综述`).trim(),
        content,
        newsCount: Number(rawSummary.newsCount) || newsList.length,
        regions: Array.isArray(rawSummary.regions) && rawSummary.regions.length > 0
            ? rawSummary.regions
            : [...new Set(newsList.map(n => n.region || '国际'))],
        generatedAt: rawSummary.generatedAt || nowIso,
        summary: String(rawSummary.summary || plainForSummary.slice(0, 160)).trim(),
        wordCount: Number(rawSummary.wordCount) || content.length
    };
}

/**
 * 构建 ag-snapshot v3.0 分域文件与 manifest.json（彻底移除冗余的 latest.json）
 *
 * 不变量：
 *   - `news.json` 仅由新闻/综述/信源统计决定，与 `socialPulse` / `audioBroadcast` 完全解耦；
 *   - `pulse.json` 仅由 `socialPulse` 决定，与 `news` / `audioBroadcast` 完全解耦；
 *   - `audio.json` 仅由 `audioBroadcast` 决定。
 */
function buildSnapshotArtifacts(snapshotPayload, options = {}) {
    if (!snapshotPayload || typeof snapshotPayload !== 'object') {
        throw new Error('snapshotPayload 必须是非空对象');
    }

    const rawNews = Array.isArray(snapshotPayload.news)
        ? snapshotPayload.news
        : (Array.isArray(snapshotPayload.articles) ? snapshotPayload.articles : []);
    if (rawNews.length === 0) {
        throw new Error('snapshotPayload.news 不能为空数组');
    }

    const publishedAt = snapshotPayload.publishedAt || snapshotPayload.lastUpdated || new Date().toISOString();
    const lastUpdated = snapshotPayload.lastUpdated || publishedAt;
    const publishedBy = String(
        options.publishedBy ||
        options.clientId ||
        snapshotPayload.publishedBy ||
        snapshotPayload.clientId ||
        'antigravity-client'
    ).trim();
    const clientId = String(options.clientId || snapshotPayload.clientId || publishedBy).trim();
    const editionId = String(snapshotPayload.editionId || '').trim() || null;
    const harvestId = String(snapshotPayload.harvestId || '').trim() || null;
    const sourceStats = Array.isArray(snapshotPayload.sourceStats) ? snapshotPayload.sourceStats : [];

    const slimNews = rawNews
        .map((item, idx) => stripArticleForSnapshot(item, idx, publishedAt))
        .filter(Boolean);
    if (slimNews.length === 0) {
        throw new Error('snapshotPayload.news 不包含有效文章对象');
    }

    // 仅当存在超出 news 的分页扩展条目时才以 extraPoolNews 增量保存，消除 allEnhancedNews 100% 重复
    const rawPool = Array.isArray(snapshotPayload.allEnhancedNews)
        ? snapshotPayload.allEnhancedNews
        : (Array.isArray(snapshotPayload.extraPoolNews) ? [...rawNews, ...snapshotPayload.extraPoolNews] : null);
    let extraPoolNews = [];
    if (Array.isArray(rawPool) && rawPool.length > slimNews.length) {
        const primaryIds = new Set(slimNews.map(a => a.id));
        const primaryUrls = new Set(slimNews.map(a => a.url).filter(Boolean));
        extraPoolNews = rawPool
            .map((item, idx) => stripArticleForSnapshot(item, idx, publishedAt))
            .filter(Boolean)
            .filter(a => !primaryIds.has(a.id) && (!a.url || !primaryUrls.has(a.url)));
    }

    const rawSummary = snapshotPayload.summaryArticle || snapshotPayload.summary || snapshotPayload.summaryMarkdown || null;
    const slimSummary = stripSummaryForSnapshot(rawSummary, slimNews, publishedAt);

    const newsPayload = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ...(editionId ? { editionId } : {}),
        ...(harvestId ? { harvestId } : {}),
        publishedAt,
        lastUpdated,
        publishedBy,
        clientId,
        sourceCount: Number(snapshotPayload.sourceCount) || sourceStats.length,
        articleCount: slimNews.length,
        displayedCount: slimNews.length,
        totalPoolCount: slimNews.length + extraPoolNews.length,
        news: slimNews,
        ...(extraPoolNews.length > 0 ? { extraPoolNews } : {}),
        ...(slimSummary ? { summaryArticle: slimSummary } : {}),
        sourceStats
    };
    const newsJson = JSON.stringify(newsPayload) + '\n';
    const newsSha256 = computeSha256(newsJson);
    const newsBytes = Buffer.byteLength(newsJson, 'utf8');

    let pulsePayload = null;
    let pulseJson = null;
    let pulseSha256 = null;
    let pulseBytes = 0;
    if (snapshotPayload.socialPulse && typeof snapshotPayload.socialPulse === 'object') {
        const normalizedPulse = normalizeSocialPulseBundle(snapshotPayload.socialPulse, {
            updatedAt: snapshotPayload.socialPulseUpdatedAt || snapshotPayload.socialPulse.updatedAt
        });
        if (normalizedPulse && Array.isArray(normalizedPulse.issues) && normalizedPulse.issues.length > 0) {
            pulsePayload = normalizedPulse;
            pulseJson = JSON.stringify(pulsePayload) + '\n';
            pulseSha256 = computeSha256(pulseJson);
            pulseBytes = Buffer.byteLength(pulseJson, 'utf8');
        }
    }

    let audioPayload = null;
    let audioJson = null;
    let audioSha256 = null;
    let audioBytes = 0;
    if (snapshotPayload.audioBroadcast && typeof snapshotPayload.audioBroadcast === 'object') {
        const normalizedAudio = normalizeAudioBroadcastBundle(snapshotPayload.audioBroadcast, {
            updatedAt: snapshotPayload.audioBroadcastUpdatedAt || snapshotPayload.audioBroadcast.updatedAt,
            snapshotUrl: options.snapshotUrl || null
        });
        if (normalizedAudio && normalizedAudio.trackCount > 0) {
            audioPayload = normalizedAudio;
            audioJson = JSON.stringify(audioPayload) + '\n';
            audioSha256 = computeSha256(audioJson);
            audioBytes = Buffer.byteLength(audioJson, 'utf8');
        }
    }

    const audioTracksSummary = {};
    if (audioPayload && audioPayload.tracks) {
        for (const [tk, tr] of Object.entries(audioPayload.tracks)) {
            audioTracksSummary[tk] = {
                file: tr.fileName,
                sha256: tr.sha256 || null,
                sizeBytes: tr.sizeBytes || 0,
                durationSec: tr.durationSec || 0,
                ...(tr.editionId ? { editionId: tr.editionId } : {}),
                ...(tr.issueKey ? { issueKey: tr.issueKey } : {})
            };
        }
    }

    const manifestPayload = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        publishedAt,
        lastUpdated,
        publishedBy,
        clientId,
        ...(editionId ? { editionId } : {}),
        ...(harvestId ? { harvestId } : {}),
        domains: {
            news: {
                file: 'news.json',
                sha256: newsSha256,
                bytes: newsBytes,
                ...(editionId ? { editionId } : {}),
                publishedAt,
                articleCount: slimNews.length,
                totalPoolCount: slimNews.length + extraPoolNews.length
            },
            pulse: pulsePayload
                ? {
                    file: 'pulse.json',
                    sha256: pulseSha256,
                    bytes: pulseBytes,
                    latestKey: pulsePayload.latestKey,
                    issueCount: pulsePayload.issueCount,
                    updatedAt: pulsePayload.updatedAt
                }
                : null,
            audio: audioPayload
                ? {
                    file: 'audio.json',
                    sha256: audioSha256,
                    bytes: audioBytes,
                    updatedAt: audioPayload.updatedAt,
                    trackCount: audioPayload.trackCount,
                    tracks: audioTracksSummary
                }
                : null
        }
    };
    const manifestJson = JSON.stringify(manifestPayload) + '\n';
    const manifestSha256 = computeSha256(manifestJson);
    const manifestBytes = Buffer.byteLength(manifestJson, 'utf8');

    const combinedForBriefing = reassembleCombinedSnapshot({
        manifest: manifestPayload,
        newsDomain: newsPayload,
        pulseDomain: pulsePayload,
        audioDomain: audioPayload
    });

    return {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        publishedAt,
        lastUpdated,
        publishedBy,
        clientId,
        editionId,
        harvestId,
        manifestPayload,
        manifestJson,
        manifestSha256,
        newsPayload,
        newsJson,
        newsSha256,
        pulsePayload,
        pulseJson,
        pulseSha256,
        audioPayload,
        audioJson,
        audioSha256,
        combinedPayload: combinedForBriefing,
        sizes: {
            manifest: manifestBytes,
            news: newsBytes,
            pulse: pulseBytes,
            audio: audioBytes,
            totalJson: manifestBytes + newsBytes + pulseBytes + audioBytes
        }
    };
}

/**
 * 将分域文件 (`manifest` + `news.json` + `pulse.json` + `audio.json`) 组装为内存统一快照对象
 */
function reassembleCombinedSnapshot({ manifest = null, newsDomain = null, pulseDomain = null, audioDomain = null } = {}) {
    if (!newsDomain || typeof newsDomain !== 'object') return null;

    const newsList = Array.isArray(newsDomain.news) ? newsDomain.news : [];
    const extraPool = Array.isArray(newsDomain.extraPoolNews) ? newsDomain.extraPoolNews : [];
    const combined = {
        version: SNAPSHOT_SCHEMA_VERSION,
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        ...(newsDomain.editionId || manifest?.editionId ? { editionId: newsDomain.editionId || manifest.editionId } : {}),
        ...(newsDomain.harvestId || manifest?.harvestId ? { harvestId: newsDomain.harvestId || manifest.harvestId } : {}),
        publishedAt: newsDomain.publishedAt || manifest?.publishedAt || newsDomain.lastUpdated || new Date().toISOString(),
        lastUpdated: newsDomain.lastUpdated || newsDomain.publishedAt || manifest?.lastUpdated || new Date().toISOString(),
        publishedBy: newsDomain.publishedBy || manifest?.publishedBy || null,
        clientId: newsDomain.clientId || manifest?.clientId || newsDomain.publishedBy || null,
        sourceCount: Number(newsDomain.sourceCount) || (Array.isArray(newsDomain.sourceStats) ? newsDomain.sourceStats.length : 0),
        articleCount: newsList.length,
        displayedCount: newsList.length,
        totalPoolCount: Number(newsDomain.totalPoolCount) || (newsList.length + extraPool.length),
        news: newsList,
        ...(extraPool.length > 0 ? { extraPoolNews: extraPool } : {}),
        ...(newsDomain.summaryArticle ? { summaryArticle: newsDomain.summaryArticle } : {}),
        sourceStats: Array.isArray(newsDomain.sourceStats) ? newsDomain.sourceStats : []
    };

    if (pulseDomain && typeof pulseDomain === 'object') {
        combined.socialPulse = pulseDomain;
        combined.socialPulseUpdatedAt = pulseDomain.updatedAt || manifest?.domains?.pulse?.updatedAt || null;
    }

    if (audioDomain && typeof audioDomain === 'object') {
        combined.audioBroadcast = audioDomain;
        combined.audioBroadcastUpdatedAt = audioDomain.updatedAt || manifest?.domains?.audio?.updatedAt || null;
    }

    if (manifest) {
        combined.manifest = manifest;
    }

    return combined;
}

module.exports = {
    SNAPSHOT_SCHEMA_VERSION,
    DEFAULT_SNAPSHOT_URL,
    computeSha256,
    splitCandidateParagraphs,
    deriveSiblingFileUrl,
    stripArticleForSnapshot,
    stripSummaryForSnapshot,
    buildSnapshotArtifacts,
    reassembleCombinedSnapshot
};
