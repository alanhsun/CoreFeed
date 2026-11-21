/**
 * CoreFeed v3.0 — 全文中文译文阅读器弹窗与排版模块 (public/js/modules/reader_modal.js)
 */

export const readerModalMethods = {
    setReaderFontSize(mode) {
        this.readerFontSize = mode === 'large' ? 'large' : 'standard';
        try {
            localStorage.setItem('corefeed_reader_size', this.readerFontSize);
        } catch (_) {}
        this.applyReaderFontSize();
    },

    applyReaderFontSize() {
        const dialog = document.getElementById('fullTextDialog');
        const stdBtn = document.getElementById('btnReaderSizeStd');
        const lgBtn = document.getElementById('btnReaderSizeLg');
        const isLarge = this.readerFontSize === 'large';

        if (dialog) {
            dialog.classList.toggle('is-large-text', isLarge);
        }
        if (stdBtn) {
            stdBtn.classList.toggle('is-active', !isLarge);
            stdBtn.setAttribute('aria-pressed', !isLarge ? 'true' : 'false');
        }
        if (lgBtn) {
            lgBtn.classList.toggle('is-active', isLarge);
            lgBtn.setAttribute('aria-pressed', isLarge ? 'true' : 'false');
        }
    },

    splitLongChineseParagraph(rawText) {
        const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
        if (!clean) return [];
        if (clean.length <= 210 || /^#{1,4}\s+/.test(clean) || /^>\s+/.test(clean)) {
            return [clean];
        }

        const chunks = [];
        let buffer = '';
        let quoteDepth = 0;

        for (let i = 0; i < clean.length; i++) {
            const ch = clean[i];
            buffer += ch;

            if (ch === '“' || ch === '「' || ch === '『') {
                quoteDepth++;
            } else if (ch === '”' || ch === '」' || ch === '』') {
                quoteDepth = Math.max(0, quoteDepth - 1);
            }

            const isSentenceEnd = ch === '。' || ch === '！' || ch === '？';
            if (isSentenceEnd && quoteDepth === 0) {
                while (i + 1 < clean.length && /^[”’」』）)\]】]/.test(clean[i + 1])) {
                    buffer += clean[++i];
                }
                const remaining = clean.length - (i + 1);
                if (buffer.trim().length >= 105 && remaining >= 65) {
                    chunks.push(buffer.trim());
                    buffer = '';
                }
            }
        }

        if (buffer.trim()) {
            if (chunks.length > 0 && buffer.trim().length < 45) {
                chunks[chunks.length - 1] += buffer.trim();
            } else {
                chunks.push(buffer.trim());
            }
        }

        return chunks.length > 0 ? chunks : [clean];
    },

    normalizeReadableParagraphs(rawList) {
        if (!Array.isArray(rawList)) return [];
        const result = [];
        for (const entry of rawList) {
            const lines = String(entry || '')
                .split(/\n+/)
                .map(s => s.trim())
                .filter(Boolean);
            for (const line of lines) {
                const splitParts = this.splitLongChineseParagraph(line);
                for (const part of splitParts) {
                    if (result.length === 0 || result[result.length - 1] !== part) {
                        result.push(part);
                    }
                }
            }
        }
        return result;
    },

    formatTranslatedParagraphHtml(rawPara, index) {
        const trimmed = String(rawPara || '').trim();
        if (!trimmed) return '';

        if (/^#{1,4}\s+/.test(trimmed)) {
            const headingText = trimmed.replace(/^#{1,4}\s+/, '').trim();
            return `<h4 class="fulltext-subhead">${this.escapeHtml(headingText)}</h4>`;
        }

        if (/^>\s+/.test(trimmed)) {
            const quoteText = trimmed.replace(/^>\s+/, '').trim();
            return `<blockquote class="fulltext-blockquote">${this.escapeHtml(quoteText)}</blockquote>`;
        }

        const leadClass = index === 0 ? ' fulltext-para--lead' : '';
        const kickerMatch = trimmed.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,6})[：:]\s*(.{12,})$/);
        if (kickerMatch) {
            const [, kicker, body] = kickerMatch;
            return `<p class="fulltext-para${leadClass}"><span class="fulltext-kicker">${this.escapeHtml(kicker)}</span>${this.escapeHtml(body)}</p>`;
        }

        return `<p class="fulltext-para${leadClass}">${this.escapeHtml(trimmed)}</p>`;
    },

    openFullTextModal(url) {
        const modal = document.getElementById('fullTextModal');
        if (!modal) return;

        const wasHidden = modal.classList.contains('hidden');
        this.currentFullTextUrl = url;
        this.pauseHeroCarousel();
        this.applyReaderFontSize();
        modal.classList.remove('hidden');

        const article = this.news.find(item => item.url === url) || null;
        const title = article ? (article.translatedTitle || article.title || '无标题') : '无标题';
        const originalTitle = article && article.translatedTitle && article.translatedTitle !== article.title
            ? article.title
            : '';
        const sourceName = article?.source?.name || 'Global Media';
        const region = article?.region || '国际';
        const category = article?.category || '国际';
        const summary = article ? (article.summary || article.translatedDescription || article.description || '') : '';
        const keyPoints = Array.isArray(article?.keyPoints) ? article.keyPoints : [];

        const titleEl = document.getElementById('fullTextTitle');
        const origTitleEl = document.getElementById('fullTextOriginalTitle');
        const badgeEl = document.getElementById('fullTextSourceBadge');
        const statsEl = document.getElementById('fullTextArticleStats');
        const statusEl = document.getElementById('fullTextStatusMeta');
        const linkEl = document.getElementById('fullTextOriginalLink');
        const bodyEl = document.getElementById('fullTextBody');

        if (titleEl) titleEl.textContent = title;
        if (origTitleEl) {
            if (originalTitle) {
                origTitleEl.textContent = originalTitle;
                origTitleEl.classList.remove('hidden');
            } else {
                origTitleEl.textContent = '';
                origTitleEl.classList.add('hidden');
            }
        }
        if (badgeEl) {
            const taxonomy = category && category !== region ? `${region} / ${category}` : region;
            badgeEl.textContent = `${sourceName} · ${taxonomy}`;
        }
        if (linkEl) {
            linkEl.href = this.safeHttpUrl(url, '#');
        }
        if (bodyEl) {
            bodyEl.scrollTop = 0;
        }

        const rawTranslatedList = Array.isArray(article?.translatedParagraphs) && article.translatedParagraphs.length > 0
            ? article.translatedParagraphs
            : (article?.translatedContent
                ? String(article.translatedContent).split(/\n+/).map(p => p.trim()).filter(Boolean)
                : []);
        const readableParas = this.normalizeReadableParagraphs(rawTranslatedList);

        const origParas = Array.isArray(article?.originalParagraphs) && article.originalParagraphs.length > 0
            ? article.originalParagraphs.map(p => String(p).trim()).filter(Boolean)
            : (article?.fullText || article?.content
                ? String(article.fullText || article.content).split(/\n+/).map(p => p.trim()).filter(p => p.length >= 15)
                : []);

        const isLegacySummaryOnly =
            readableParas.length === 0 ||
            (readableParas.length === 1 &&
                summary &&
                readableParas[0] === summary.trim() &&
                origParas.length <= 1);

        const charCount = readableParas.join('').replace(/\s+/g, '').length;
        const readMin = Math.max(1, Math.round(charCount / 420));
        let pubStr = '';
        if (article?.publishedAt) {
            const d = new Date(article.publishedAt);
            if (!isNaN(d.getTime())) {
                pubStr = d.toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                    timeZone: 'Asia/Shanghai'
                });
            }
        }

        if (statsEl) {
            const statParts = [];
            if (pubStr) statParts.push(`发布于 ${pubStr}`);
            if (!isLegacySummaryOnly && charCount > 0) {
                statParts.push(`译文约 ${charCount} 字 / 预计阅读 ${readMin} 分钟`);
            }
            if (statParts.length > 0) {
                statsEl.textContent = statParts.join(' · ');
                statsEl.classList.remove('hidden');
            } else {
                statsEl.textContent = '';
                statsEl.classList.add('hidden');
            }
        }

        this.renderFullTextModalContent({
            summary,
            keyPoints,
            translatedParagraphs: isLegacySummaryOnly ? [] : readableParas,
            originalParagraphs: origParas,
            originalLanguage: article?.source?.language || 'en',
            isLegacySummaryOnly
        });

        if (statusEl) {
            statusEl.textContent = isLegacySummaryOnly
                ? '本地快照尚未包含预译正文 · 点击同步最新即可获取'
                : `共 ${readableParas.length} 段 · 已于采编阶段完成全文精译并随 GitHub 快照同步`;
        }

        if (wasHidden && this.modalFocus) {
            this.modalFocus.activate(modal, '#btnCloseFullText');
        }
    },

    async syncSnapshotForModal() {
        const targetUrl = this.currentFullTextUrl;
        await this.syncFromGitHub({ force: true });
        const modal = document.getElementById('fullTextModal');
        if (targetUrl && modal && !modal.classList.contains('hidden')) {
            this.openFullTextModal(targetUrl);
        }
    },

    renderFullTextModalContent(data = {}) {
        const mountEl = document.getElementById('fullTextContentMount') || document.getElementById('fullTextBody');
        if (!mountEl) return;

        const summary = data.summary || '';
        const keyPoints = Array.isArray(data.keyPoints) ? data.keyPoints.filter(Boolean) : [];
        const translatedParagraphs = Array.isArray(data.translatedParagraphs) ? data.translatedParagraphs : [];
        const originalParagraphs = Array.isArray(data.originalParagraphs) ? data.originalParagraphs : [];
        const isLegacySummaryOnly = Boolean(data.isLegacySummaryOnly);

        let deckHtml = '';
        if (translatedParagraphs.length > 0) {
            if (keyPoints.length > 0) {
                deckHtml = `
                    <aside class="fulltext-deck" aria-label="要点速览">
                        <div class="fulltext-section-label">要点速览</div>
                        <ul class="fulltext-deck-points">
                            ${keyPoints.map(kp => `<li class="fulltext-deck-item">${this.escapeHtml(kp)}</li>`).join('')}
                        </ul>
                    </aside>
                `;
            } else if (summary && summary !== translatedParagraphs[0]) {
                deckHtml = `
                    <aside class="fulltext-deck" aria-label="核心提要">
                        <div class="fulltext-section-label">核心提要</div>
                        <p class="fulltext-lead-summary">${this.escapeHtml(summary)}</p>
                    </aside>
                `;
            }
        } else if (summary || keyPoints.length > 0) {
            deckHtml = `
                <aside class="fulltext-deck" aria-label="核心导读摘要">
                    <div class="fulltext-section-label">核心导读摘要</div>
                    ${summary ? `<p class="fulltext-lead-summary">${this.escapeHtml(summary)}</p>` : ''}
                    ${keyPoints.length > 0 ? `
                        <ul class="fulltext-deck-points" style="margin-top: 12px;">
                            ${keyPoints.map(kp => `<li class="fulltext-deck-item">${this.escapeHtml(kp)}</li>`).join('')}
                        </ul>
                    ` : ''}
                </aside>
            `;
        }

        const zhParagraphsHtml = translatedParagraphs.length > 0 ? `
            <section class="fulltext-prose" aria-label="中文全文译文">
                ${translatedParagraphs.map((p, idx) => this.formatTranslatedParagraphHtml(p, idx)).join('')}
            </section>
        ` : '';

        const legacySyncHtml = isLegacySummaryOnly ? `
            <div class="fulltext-sync-callout">
                <div class="fulltext-sync-copy">
                    <strong>当前本地条目来自旧版快照缓存</strong>
                    <span>全文中文译文已在采编阶段预生成并发布至 GitHub 快照，同步后即可离线秒开阅读。</span>
                </div>
                <button type="button" onclick="app.syncSnapshotForModal()" class="btn-primary py-2 px-4 text-xs flex-shrink-0">
                    <i class="fa-solid fa-rotate text-xs"></i>
                    <span>同步最新快照</span>
                </button>
            </div>
        ` : '';

        const origLang = (data.originalLanguage && typeof data.originalLanguage === 'string')
            ? data.originalLanguage.trim()
            : 'en';
        const origParagraphsHtml = originalParagraphs.length > 0 ? `
            <details class="fulltext-orig-details">
                <summary class="fulltext-orig-summary">查看外媒原文对照（共 ${originalParagraphs.length} 段）</summary>
                <div class="fulltext-orig-body" lang="${this.escapeHtml(origLang)}">
                    ${originalParagraphs.map(p => `<p>${this.escapeHtml(p)}</p>`).join('')}
                </div>
            </details>
        ` : '';

        mountEl.innerHTML = deckHtml + zhParagraphsHtml + legacySyncHtml + origParagraphsHtml;
    },

    closeFullTextModal() {
        const modal = document.getElementById('fullTextModal');
        if (!modal || modal.classList.contains('hidden')) return;
        modal.classList.add('hidden');
        this.currentFullTextUrl = null;
        if (this.modalFocus) {
            this.modalFocus.deactivate(modal);
        }
        this.resumeHeroCarousel();
    }
};
