/**
 * CoreFeed v3.0 — 前端输出转义、URL 白名单与时间格式化工具 (public/js/modules/sanitize.js)
 */

export function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function safeHttpUrl(rawUrl, fallback = '') {
    if (typeof rawUrl !== 'string') return fallback;
    const trimmed = rawUrl.trim();
    if (!trimmed) return fallback;
    try {
        const parsed = new URL(trimmed);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? trimmed : fallback;
    } catch (_) {
        return fallback;
    }
}

export function safeAssetUrl(rawUrl, fallback = '') {
    if (typeof rawUrl !== 'string') return fallback;
    const trimmed = rawUrl.trim();
    if (!trimmed) return fallback;
    if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
        return trimmed;
    }
    return safeHttpUrl(trimmed, fallback);
}

export function sanitizeSummaryHtml(rawHtml = '') {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(rawHtml || '');
    const ALLOWED_TAGS = new Set(['H3', 'H4', 'P', 'STRONG', 'EM', 'B', 'I', 'BR', 'A', 'SPAN', 'UL', 'OL', 'LI', 'DIV']);
    const ALLOWED_ATTRS = new Set(['class', 'title', 'data-news-index', 'target', 'rel', 'href']);

    const cleanNode = (node) => {
        const children = Array.from(node.childNodes || []);
        for (const child of children) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                const tag = child.tagName.toUpperCase();
                if (!ALLOWED_TAGS.has(tag)) {
                    child.remove();
                    continue;
                }
                for (const attr of Array.from(child.attributes)) {
                    const name = attr.name.toLowerCase();
                    if (!ALLOWED_ATTRS.has(name)) {
                        child.removeAttribute(attr.name);
                        continue;
                    }
                    if (name === 'href') {
                        const safe = safeHttpUrl(attr.value, '');
                        if (!safe) {
                            child.removeAttribute('href');
                        } else {
                            child.setAttribute('href', safe);
                            child.setAttribute('rel', 'noopener noreferrer');
                        }
                    }
                }
                cleanNode(child);
            } else if (child.nodeType !== Node.TEXT_NODE) {
                child.remove();
            }
        }
    };

    cleanNode(tpl.content);
    return tpl.innerHTML;
}

export function formatRelativeTime(dateInput) {
    try {
        const d = new Date(dateInput);
        if (isNaN(d.getTime())) return '';
        const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
        if (diffMin < 5) return '刚刚';
        if (diffMin < 60) return `${diffMin} 分钟前`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr} 小时前`;
        return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch (_) {
        return '';
    }
}
