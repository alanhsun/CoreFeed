/**
 * CoreFeed v3.0 — 欧美社媒热议 (Western Social Pulse) 视图、期次懒加载与筛选模块 (public/js/modules/social_pulse.js)
 */

export const socialPulseMethods = {
    async fetchLatestPulse() {
        try {
            const res = await fetch('/api/pulse');
            const data = await res.json();
            if (data && data.success && data.socialPulse) {
                this.socialPulse = data.socialPulse;
                if (!this.selectedPulseKey || !(this.socialPulse.issues || []).some(it => it.key === this.selectedPulseKey)) {
                    this.selectedPulseKey = this.socialPulse.latestKey || (this.socialPulse.issues?.[0]?.key || '');
                }
                this.renderSocialPulse();
            }
        } catch (_) {}
    },

    getActivePulseIssue() {
        const issues = Array.isArray(this.socialPulse?.issues) ? this.socialPulse.issues : [];
        if (issues.length === 0) return null;
        return issues.find(it => it.key === this.selectedPulseKey) ||
            issues.find(it => it.key === this.socialPulse?.latestKey) ||
            issues[0];
    },

    async selectPulseIssue(issueKey) {
        const cleanKey = String(issueKey || '').trim();
        this.selectedPulseKey = cleanKey;
        this.selectedPulseRegion = '全部';
        this.selectedPulseLang = '全部';
        this.selectedPulsePlatform = '全部';
        this.selectedPulseCategory = '全部';

        const issues = Array.isArray(this.socialPulse?.issues) ? this.socialPulse.issues : [];
        const target = issues.find(it => it.key === cleanKey);
        if (target && (!Array.isArray(target.clusters) || target._summaryOnly)) {
            try {
                const res = await fetch(`/api/pulse?key=${encodeURIComponent(cleanKey)}`);
                const data = await res.json();
                if (data && data.success && data.selectedIssue && Array.isArray(data.selectedIssue.clusters)) {
                    const idx = issues.findIndex(it => it.key === cleanKey);
                    if (idx !== -1) {
                        issues[idx] = {
                            ...data.selectedIssue,
                            clusterCount: data.selectedIssue.clusters.length
                        };
                    }
                }
            } catch (_) {
                // Keep existing stub on network failure
            }
        }
        this.renderSocialPulse();
    },

    setPulseRegionFilter(region) {
        this.selectedPulseRegion = region;
        this.renderSocialPulse();
    },

    setPulseLangFilter(lang) {
        this.selectedPulseLang = lang;
        this.renderSocialPulse();
    },

    setPulsePlatformFilter(platform) {
        this.selectedPulsePlatform = platform;
        this.renderSocialPulse();
    },

    setPulseCategoryFilter(category) {
        this.selectedPulseCategory = category;
        this.renderSocialPulse();
    },

    applyPulseFilters() {
        const inputEl = document.getElementById('pulseSearchInput');
        const clearBtn = document.getElementById('btnClearPulseSearch');
        if (clearBtn && inputEl) {
            clearBtn.classList.toggle('hidden', !inputEl.value.trim());
        }
        this.renderSocialPulse();
    },

    clearPulseSearch() {
        const inputEl = document.getElementById('pulseSearchInput');
        if (inputEl) {
            inputEl.value = '';
        }
        this.applyPulseFilters();
    },

    formatPulseLangLabel(code) {
        const map = {
            en: 'EN 英语',
            de: 'DE 德语',
            fr: 'FR 法语',
            es: 'ES 西语',
            it: 'IT 意语',
            nl: 'NL 荷语',
            pl: 'PL 波兰语',
            pt: 'PT 葡语',
            sv: 'SV 瑞典语'
        };
        const norm = String(code || '').toLowerCase();
        return map[norm] || norm.toUpperCase();
    },

    renderSocialPulse() {
        const mountEl = document.getElementById('pulseSection');
        const countBadge = document.getElementById('tabPulseCount');
        const selectEl = document.getElementById('pulseIssueSelect');
        if (!mountEl) return;

        const issues = Array.isArray(this.socialPulse?.issues) ? this.socialPulse.issues : [];
        const issue = this.getActivePulseIssue();

        if (selectEl) {
            if (issues.length === 0) {
                selectEl.innerHTML = `<option value="">暂无已同步期次</option>`;
            } else {
                selectEl.innerHTML = issues.map(iss => {
                    const modeLabel = iss.mode === 'topic' ? `专题 · ${iss.slug || '深挖'}` : '全量日报';
                    const sel = issue && iss.key === issue.key ? 'selected' : '';
                    const cLen = Array.isArray(iss.clusters) ? iss.clusters.length : (Number(iss.clusterCount) || 0);
                    return `<option value="${this.escapeHtml(iss.key)}" ${sel}>${this.escapeHtml(iss.date)} · ${this.escapeHtml(modeLabel)} (${cLen} 簇)</option>`;
                }).join('');
            }
        }

        if (!issue) {
            if (countBadge) {
                countBadge.textContent = '';
                countBadge.classList.add('hidden');
            }
            mountEl.innerHTML = `
                <div class="kami-card py-14 text-center space-y-3">
                    <div class="kami-tag mx-auto">欧美社媒热议</div>
                    <h3 class="text-xl font-bold" style="color: var(--text-primary);">当前暂无已同步的欧美社媒热议日报</h3>
                    <p class="text-sm max-w-md mx-auto" style="color: var(--text-muted);">每日早间 07:15 自动采集精编过去 24 小时美欧 X、Threads、Reddit 热门讨论并随快照同步；也可点击右上角「同步最新」立即拉取。</p>
                </div>
            `;
            return;
        }

        const clusters = Array.isArray(issue.clusters) ? issue.clusters : [];
        if (countBadge) {
            countBadge.textContent = String(clusters.length);
            countBadge.classList.remove('hidden');
        }

        const usCount = clusters.filter(c => c.region === 'US').length;
        const euCount = clusters.filter(c => c.region === 'EU').length;
        const allLangs = [...new Set(clusters.flatMap(c => Array.isArray(c.languages) ? c.languages : ['en']))];
        const allCategories = [...new Set(clusters.map(c => c.category || '社会与文化'))];

        if (this.selectedPulseLang !== '全部' && !allLangs.includes(this.selectedPulseLang)) {
            this.selectedPulseLang = '全部';
        }
        if (this.selectedPulseCategory !== '全部' && !allCategories.includes(this.selectedPulseCategory)) {
            this.selectedPulseCategory = '全部';
        }

        const keyword = (document.getElementById('pulseSearchInput')?.value || '').trim().toLowerCase();
        const filteredClusters = clusters.filter(cl => {
            if (this.selectedPulseRegion !== '全部' && cl.region !== this.selectedPulseRegion) {
                return false;
            }
            if (this.selectedPulseLang !== '全部' && !(cl.languages || []).includes(this.selectedPulseLang)) {
                return false;
            }
            if (this.selectedPulsePlatform !== '全部' && !(cl.platforms || []).includes(this.selectedPulsePlatform)) {
                return false;
            }
            if (this.selectedPulseCategory !== '全部' && cl.category !== this.selectedPulseCategory) {
                return false;
            }
            if (keyword) {
                const quoteHay = (cl.featured_quotes || [])
                    .map(q => `${q.community_or_handle || ''} ${q.quote_zh || ''} ${q.quote_original || ''}`)
                    .join(' ');
                const campHay = (cl.camps || [])
                    .map(cp => `${cp.label || ''} ${cp.summary || ''}`)
                    .join(' ');
                const hay = `${cl.title_zh || ''} ${cl.hook_one_liner || ''} ${cl.trigger_and_context || ''} ${campHay} ${quoteHay}`.toLowerCase();
                if (!hay.includes(keyword)) return false;
            }
            return true;
        });

        const mood = issue.executive_summary?.platform_mood || {};
        const moodPlatforms = ['X', 'Threads', 'Reddit'].filter(p => mood[p]);
        const moodGridHtml = moodPlatforms.length > 0 ? `
            <div class="pulse-mood-grid">
                ${moodPlatforms.map(plat => `
                    <div class="pulse-mood-cell">
                        <div class="pulse-mood-label">${this.escapeHtml(plat)} 平台切面</div>
                        <p class="pulse-mood-copy">${this.escapeHtml(mood[plat])}</p>
                    </div>
                `).join('')}
            </div>
        ` : '';

        const modeDescriptor = issue.mode === 'topic'
            ? `特定议题深挖 · ${issue.slug || ''}`
            : `过去 ${issue.window_hours || 24} 小时全量日报`;

        const hasPulseAudio = Boolean(this.audioBroadcast?.tracks?.pulse);
        const leadSheetHtml = `
            <article class="kami-card pulse-lead-sheet">
                <div class="pulse-lead-eyebrow">
                    <span>${this.escapeHtml(issue.date)} · ${this.escapeHtml(modeDescriptor)}</span>
                    <span class="flex flex-wrap items-center gap-3">
                        <span>美国 ${usCount} 簇 / 欧洲 ${euCount} 簇 · 语种 ${this.escapeHtml(allLangs.map(l => l.toUpperCase()).join(' · '))}</span>
                        ${hasPulseAudio ? `
                            <button type="button" onclick="app.playBroadcastTrack('pulse', 0)" class="btn-source-link">
                                <i class="fa-solid fa-headphones text-[11px]" aria-hidden="true"></i>
                                <span>收听早班车播报</span>
                            </button>
                        ` : ''}
                    </span>
                </div>
                <h2 class="pulse-lead-headline">${this.escapeHtml(issue.headline || '')}</h2>
                ${issue.executive_summary?.overview ? `<p class="pulse-lead-overview">${this.escapeHtml(issue.executive_summary.overview)}</p>` : ''}
                ${moodGridHtml}
            </article>
        `;

        const comparisons = Array.isArray(issue.transatlantic_comparisons) ? issue.transatlantic_comparisons : [];
        const comparisonsHtml = comparisons.length > 0 ? `
            <section aria-label="跨大西洋同题温差对比">
                <div class="pulse-section-header">
                    <h3 class="pulse-section-title">跨大西洋同题温差对比</h3>
                    <span class="pulse-section-sub">美欧制度坐标与利益体感对照 · 共 ${comparisons.length} 组</span>
                </div>
                <div class="pulse-comp-grid">
                    ${comparisons.map((comp, idx) => `
                        <article class="pulse-comp-card">
                            <div class="pulse-comp-top">
                                <div class="card-meta-left">
                                    <span class="card-index-num">${String(idx + 1).padStart(2, '0')}</span>
                                    <span class="card-meta-sep">/</span>
                                    <span class="card-source-name">美欧同题对照</span>
                                </div>
                                <h4 class="pulse-comp-topic">${this.escapeHtml(comp.topic || '')}</h4>
                                <div class="pulse-comp-angles">
                                    <div class="pulse-angle-block">
                                        <span class="pulse-angle-tag">美国 US</span>${this.escapeHtml(comp.us_angle || '')}
                                    </div>
                                    <div class="pulse-angle-block">
                                        <span class="pulse-angle-tag">欧洲 EU</span>${this.escapeHtml(comp.eu_angle || '')}
                                    </div>
                                </div>
                            </div>
                            <div class="pulse-comp-verdict">
                                <strong>破题判断</strong>${this.escapeHtml(comp.verdict || '')}
                            </div>
                        </article>
                    `).join('')}
                </div>
            </section>
        ` : '';

        const regionOptions = [
            { key: '全部', label: '全部视角', count: clusters.length },
            { key: 'US', label: '美国舆论场', count: usCount },
            { key: 'EU', label: '欧洲多语种', count: euCount }
        ];
        const globalCount = clusters.filter(c => c.region === 'GLOBAL').length;
        if (globalCount > 0) {
            regionOptions.push({ key: 'GLOBAL', label: '跨洋联动', count: globalCount });
        }

        const filterDeckHtml = `
            <div class="taste-filter-deck space-y-2.5">
                <div class="flex flex-wrap items-center gap-2">
                    <span class="filter-row-label">区域</span>
                    ${regionOptions.map(opt => `
                        <button type="button" data-pulse-region="${this.escapeHtml(opt.key)}" class="btn-chip ${this.selectedPulseRegion === opt.key ? 'active' : ''}">
                            <span>${this.escapeHtml(opt.label)}</span><span class="chip-count">(${opt.count})</span>
                        </button>
                    `).join('')}
                    <span class="filter-row-label" style="margin-left: 8px;">语种</span>
                    <button type="button" data-pulse-lang="全部" class="btn-chip ${this.selectedPulseLang === '全部' ? 'active' : ''}"><span>全部语种</span></button>
                    ${allLangs.map(lc => `
                        <button type="button" data-pulse-lang="${this.escapeHtml(lc)}" class="btn-chip ${this.selectedPulseLang === lc ? 'active' : ''}">
                            <span>${this.escapeHtml(this.formatPulseLangLabel(lc))}</span>
                        </button>
                    `).join('')}
                </div>
                <div class="flex flex-wrap items-center gap-2 pt-2.5" style="border-top: 1px solid var(--border-subtle);">
                    <span class="filter-row-label">平台</span>
                    ${['全部', 'X', 'Threads', 'Reddit'].map(plat => `
                        <button type="button" data-pulse-platform="${this.escapeHtml(plat)}" class="btn-chip ${this.selectedPulsePlatform === plat ? 'active' : ''}">
                            <span>${plat === '全部' ? '全部平台' : plat}</span>
                        </button>
                    `).join('')}
                    <span class="filter-row-label" style="margin-left: 8px;">领域</span>
                    <button type="button" data-pulse-category="全部" class="btn-chip ${this.selectedPulseCategory === '全部' ? 'active' : ''}"><span>全部领域</span></button>
                    ${allCategories.map(cat => `
                        <button type="button" data-pulse-category="${this.escapeHtml(cat)}" class="btn-chip ${this.selectedPulseCategory === cat ? 'active' : ''}">
                            <span>${this.escapeHtml(cat)}</span>
                        </button>
                    `).join('')}
                </div>
            </div>
        `;

        const clustersBodyHtml = filteredClusters.length === 0 ? `
            <div class="kami-card py-12 text-center space-y-2">
                <div class="kami-tag mx-auto">无匹配议题</div>
                <p class="text-sm" style="color: var(--text-muted);">当前筛选条件下暂无匹配的社媒热议簇，请重置筛选条件或清空关键词。</p>
            </div>
        ` : `
            <div class="pulse-clusters-grid">
                ${filteredClusters.map((cl, idx) => this.renderPulseClusterCardHtml(cl, idx)).join('')}
            </div>
        `;

        mountEl.innerHTML = leadSheetHtml + comparisonsHtml + filterDeckHtml + clustersBodyHtml;
    },

    renderPulseClusterCardHtml(cl, idx) {
        const indexNum = String(idx + 1).padStart(2, '0');
        const regionLabel = cl.region === 'US' ? '美国 US' : (cl.region === 'EU' ? '欧洲 EU' : '全球');
        const countryStr = Array.isArray(cl.countries) && cl.countries.length > 0 ? cl.countries.join('/') : cl.region;
        const langStr = Array.isArray(cl.languages) && cl.languages.length > 0
            ? cl.languages.map(l => String(l).toUpperCase()).join('/')
            : 'EN';
        const platforms = Array.isArray(cl.platforms) ? cl.platforms : [];
        const camps = Array.isArray(cl.camps) ? cl.camps : [];
        const vibes = (cl.platform_vibes && typeof cl.platform_vibes === 'object') ? cl.platform_vibes : {};
        const quotes = Array.isArray(cl.featured_quotes) ? cl.featured_quotes : [];

        const campSegments = camps.map((cp, cIdx) => {
            const m = String(cp.share_estimate || '').match(/(\d{1,3})/);
            const pct = cp.share_percent != null ? cp.share_percent : (m ? parseInt(m[1], 10) : Math.round(100 / Math.max(1, camps.length)));
            return { ...cp, pct: Math.max(4, pct), colorIdx: cIdx % 4 };
        });

        const spectrumHtml = campSegments.length > 0 ? `
            <div class="pulse-camps-box">
                <div class="pulse-spectrum-bar" aria-hidden="true">
                    ${campSegments.map(seg => `<div class="pulse-spectrum-seg--${seg.colorIdx}" style="width: ${seg.pct}%;"></div>`).join('')}
                </div>
                <ul class="pulse-camps-list">
                    ${campSegments.map(seg => `
                        <li class="pulse-camp-item">
                            <span class="pulse-camp-head">
                                <span class="pulse-camp-dot pulse-spectrum-seg--${seg.colorIdx}"></span>
                                <span class="pulse-camp-label">${this.escapeHtml(seg.label || '')}</span>
                                ${seg.share_estimate ? `<span class="pulse-camp-share">${this.escapeHtml(seg.share_estimate)}</span>` : ''}
                            </span>
                            <span>${this.escapeHtml(seg.summary || '')}</span>
                        </li>
                    `).join('')}
                </ul>
            </div>
        ` : '';

        const vibeEntries = ['X', 'Threads', 'Reddit'].filter(p => vibes[p]);
        const vibesHtml = vibeEntries.length > 0 ? `
            <div class="pulse-vibes-strip">
                ${vibeEntries.map(p => `<div class="pulse-vibe-row"><strong>${this.escapeHtml(p)}</strong>${this.escapeHtml(vibes[p])}</div>`).join('')}
            </div>
        ` : '';

        const quotesHtml = quotes.length > 0 ? `
            <div class="pulse-quotes-stack">
                ${quotes.map(q => {
                    const qLang = String(q.language || 'en').toLowerCase();
                    const safeSourceUrl = this.safeHttpUrl(q.source_url, '');
                    return `
                        <div class="pulse-quote-card">
                            <div class="pulse-quote-meta">
                                <span class="pulse-quote-author">
                                    <span class="pulse-plat-pill">${this.escapeHtml(q.platform || 'Reddit')}</span>
                                    <span>${this.escapeHtml(q.community_or_handle || '')}</span>
                                    <span class="pulse-plat-pill">${this.escapeHtml(qLang.toUpperCase())}</span>
                                    ${q.metrics ? `<span>· ${this.escapeHtml(q.metrics)}</span>` : ''}
                                </span>
                                ${safeSourceUrl ? `
                                    <a href="${this.escapeHtml(safeSourceUrl)}" target="_blank" rel="noopener noreferrer" class="btn-source-link">
                                        <span>原帖</span><span aria-hidden="true">↗</span>
                                    </a>
                                ` : ''}
                            </div>
                            <blockquote class="pulse-quote-zh">“${this.escapeHtml(q.quote_zh || '')}”</blockquote>
                            ${q.quote_original ? `
                                <details class="pulse-orig-details">
                                    <summary class="pulse-orig-summary">展开外文原帖对照 (${this.escapeHtml(qLang.toUpperCase())})</summary>
                                    <p class="pulse-orig-text" lang="${this.escapeHtml(qLang)}">${this.escapeHtml(q.quote_original)}</p>
                                </details>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        ` : '';

        return `
            <article class="pulse-cluster-card pulse-span-6">
                <div class="card-meta-header">
                    <div class="card-meta-left">
                        <span class="card-index-num">${indexNum}</span>
                        <span class="card-meta-sep">/</span>
                        <span class="card-source-name">${this.escapeHtml(regionLabel)} · ${this.escapeHtml(countryStr)} · ${this.escapeHtml(langStr)}</span>
                    </div>
                    <div class="pulse-badge-row">
                        <span class="card-taxonomy-pill">${this.escapeHtml(cl.category || '社会与文化')}</span>
                        <span class="pulse-heat-pill">热度 ${Number(cl.heat_score) || 80}</span>
                    </div>
                </div>

                <div class="pulse-cluster-body">
                    <div class="pulse-badge-row">
                        ${cl.is_followup ? `<span class="pulse-followup-pill">舆情续集</span>` : ''}
                        ${platforms.map(p => `<span class="pulse-plat-pill">${this.escapeHtml(p)}</span>`).join('')}
                    </div>

                    ${cl.is_followup && cl.followup_note ? `
                        <div class="kami-callout">
                            <div class="kami-callout-title">跨日演进增量</div>
                            <div class="text-xs" style="color: var(--text-body);">${this.escapeHtml(cl.followup_note)}</div>
                        </div>
                    ` : ''}

                    <h3 class="pulse-cluster-title">${this.escapeHtml(cl.title_zh || '')}</h3>
                    ${cl.hook_one_liner ? `<p class="pulse-cluster-hook">${this.escapeHtml(cl.hook_one_liner)}</p>` : ''}
                    ${cl.trigger_and_context ? `<p class="pulse-cluster-context">${this.escapeHtml(cl.trigger_and_context)}</p>` : ''}

                    ${spectrumHtml}
                    ${vibesHtml}
                    ${quotesHtml}
                </div>
            </article>
        `;
    }
};
