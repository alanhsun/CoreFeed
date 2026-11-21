/**
 * 聚核 CoreFeed v3.0 · 前端主控制器与模块化编排入口 (Native ES Modules)
 *
 * 核心职责：
 *   1. 承接 SSR 首屏状态 (window.__INITIAL_STATE__) 并建立 Socket.IO 实时增量同步
 *   2. 12 列不对称 Swiss Editorial Bento 网格动态渲染与多维筛选（地区/领域/信源/关键词）
 *   3. 一键触发 GitHub 快照拉取 (POST /api/agent/pull-github) 与 60 秒轻量状态遥测轮询
 *   4. 组合轮播、全文阅读器、欧美社媒热议、双主播电台与弹窗无障碍焦点陷阱等独立模块
 */
import {
    escapeHtml,
    safeHttpUrl,
    safeAssetUrl,
    sanitizeSummaryHtml,
    formatRelativeTime
} from './modules/sanitize.js';
import { ModalFocusController } from './modules/modal_a11y.js';
import { heroCarouselMethods } from './modules/hero_carousel.js';
import { readerModalMethods } from './modules/reader_modal.js';
import { socialPulseMethods } from './modules/social_pulse.js';
import { audioPlayerMethods } from './modules/audio_player.js';

export class CoreFeedApp {
    constructor() {
        const init = window.__INITIAL_STATE__ || {};
        this.news = Array.isArray(init.news) ? init.news : [];
        this.totalNews = init.totalNews || this.news.length;
        this.lastUpdated = init.lastUpdated || null;
        this.lastPublishedBy = init.lastPublishedBy || init.githubSync?.publishedBy || null;
        this.githubSync = init.githubSync || null;
        this.schedule = init.schedule || null;
        this.clientId = init.clientId || init.githubSync?.clientId || '';
        this.summaryArticle = init.summaryArticle || null;
        this.socialPulse = init.socialPulse || null;
        this.audioBroadcast = init.audioBroadcast || null;
        this.activeAudioTrack = init.audioBroadcast?.defaultTrack || (init.audioBroadcast?.tracks?.news ? 'news' : 'pulse');
        this.playbackSpeeds = [1.0, 1.25, 1.5, 0.9];
        const savedSpeed = parseFloat(localStorage.getItem('corefeed_audio_speed') || '1.0');
        this.playbackSpeed = this.playbackSpeeds.includes(savedSpeed) ? savedSpeed : 1.0;
        this.isScrubbingAudio = false;
        this.pendingChapterStartSec = null;
        this.selectedPulseKey = init.socialPulse?.latestKey || (init.socialPulse?.issues?.[0]?.key || '');
        this.selectedPulseRegion = '全部';
        this.selectedPulseLang = '全部';
        this.selectedPulsePlatform = '全部';
        this.selectedPulseCategory = '全部';
        this.collectionPhase = 'idle';
        this.isSyncingGithub = false;

        this.selectedRegion = '全部';
        this.selectedCategory = '全部';
        this.activeTab = 'feed';
        this.socket = null;
        this.currentFullTextUrl = null;
        this.readerFontSize = localStorage.getItem('corefeed_reader_size') === 'large' ? 'large' : 'standard';

        // 轮播与弹窗无障碍状态
        this.heroSlideIndex = 0;
        this.heroSlideCount = 0;
        this.heroCarouselTimer = null;
        this.heroCarouselPaused = false;
        this.heroCarouselUserPaused = false;
        this.modalFocus = new ModalFocusController();

        this.initTheme();
        this.applyReaderFontSize();
        this.initKeyboardShortcuts();
        this.initDelegatedInteractions();
        this.initTablistEnhancements();
        this.initBroadcastPlayer();
        this.initSocket();
        this.renderFilters();
        this.renderNewsGrid();
        this.renderSocialPulse();
        this.renderBroadcastPlayer({ preservePlayback: true });
        this.renderStatusBar();
        this.initInitialTabFromUrl();
        this.fetchStatus();

        // 每 60 秒轻量刷新一次顶栏状态与同步遥测
        this.statusPollTimer = setInterval(() => this.fetchStatus(), 60 * 1000);
    }

    // ==================== 1. 主题、快捷键、事件委托与输出净化 ====================
    initTheme() {
        const saved = localStorage.getItem('corefeed_theme');
        if (saved === 'dark') {
            document.documentElement.classList.add('dark');
        }
        this.updateThemeIcon();
    }

    toggleTheme() {
        document.documentElement.classList.toggle('dark');
        const isDark = document.documentElement.classList.contains('dark');
        localStorage.setItem('corefeed_theme', isDark ? 'dark' : 'light');
        this.updateThemeIcon();
    }

    updateThemeIcon() {
        const icon = document.getElementById('themeIcon');
        if (!icon) return;
        const isDark = document.documentElement.classList.contains('dark');
        icon.className = isDark ? 'fa-solid fa-sun text-xs' : 'fa-solid fa-moon text-xs';
    }

    initKeyboardShortcuts() {
        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                this.closeFullTextModal();
                this.closeSettingsModal();
            }
        });
    }

    initDelegatedInteractions() {
        document.addEventListener('click', (event) => {
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;

            const regionBtn = target.closest('[data-filter-region]');
            if (regionBtn) {
                this.setRegionFilter(regionBtn.dataset.filterRegion || '全部');
                return;
            }
            const catBtn = target.closest('[data-filter-category]');
            if (catBtn) {
                this.setCategoryFilter(catBtn.dataset.filterCategory || '全部');
                return;
            }
            const pulseRegionBtn = target.closest('[data-pulse-region]');
            if (pulseRegionBtn) {
                this.setPulseRegionFilter(pulseRegionBtn.dataset.pulseRegion || '全部');
                return;
            }
            const pulseLangBtn = target.closest('[data-pulse-lang]');
            if (pulseLangBtn) {
                this.setPulseLangFilter(pulseLangBtn.dataset.pulseLang || '全部');
                return;
            }
            const pulsePlatBtn = target.closest('[data-pulse-platform]');
            if (pulsePlatBtn) {
                this.setPulsePlatformFilter(pulsePlatBtn.dataset.pulsePlatform || '全部');
                return;
            }
            const pulseCatBtn = target.closest('[data-pulse-category]');
            if (pulseCatBtn) {
                this.setPulseCategoryFilter(pulseCatBtn.dataset.pulseCategory || '全部');
                return;
            }
            const cardTrigger = target.closest('.card-body-trigger[data-card-url]');
            if (cardTrigger) {
                this.handleCardBodyClick(event, cardTrigger.dataset.cardUrl || '', true);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target;
            if (!target || typeof target.closest !== 'function') return;
            if (target.closest('a, button, input, select, textarea')) return;
            const cardTrigger = target.closest('.card-body-trigger[data-card-url]');
            if (cardTrigger) {
                event.preventDefault();
                this.handleCardBodyClick(event, cardTrigger.dataset.cardUrl || '', true);
            }
        });
    }

    toast(message, type = 'info') {
        const container = document.getElementById('toast') || document.getElementById('toastContainer');
        if (!container) return;

        const icons = {
            info: 'fa-circle-info',
            success: 'fa-circle-check',
            warning: 'fa-triangle-exclamation',
            error: 'fa-circle-xmark'
        };

        const el = document.createElement('div');
        el.className = 'flex items-center gap-2.5 px-4 py-3 rounded-md text-xs sm:text-sm transition-all';
        el.style.background = type === 'error' ? 'var(--text-primary)' : 'var(--accent)';
        el.style.color = '#FFFFFF';
        el.style.border = '1px solid var(--border-strong)';
        el.style.boxShadow = 'var(--shadow-elevated)';
        el.innerHTML = `<i class="fa-solid ${icons[type] || icons.info}"></i><span>${this.escapeHtml(message)}</span>`;
        container.appendChild(el);

        setTimeout(() => {
            el.style.opacity = '0';
            setTimeout(() => el.remove(), 300);
        }, 4200);
    }

    escapeHtml(str = '') {
        return escapeHtml(str);
    }

    safeHttpUrl(rawUrl, fallback = '') {
        return safeHttpUrl(rawUrl, fallback);
    }

    safeAssetUrl(rawUrl, fallback = '') {
        return safeAssetUrl(rawUrl, fallback);
    }

    sanitizeSummaryHtml(rawHtml = '') {
        return sanitizeSummaryHtml(rawHtml);
    }

    formatRelativeTime(dateInput) {
        return formatRelativeTime(dateInput);
    }

    // ==================== 2. WebSocket 实时渐进式同步 ====================
    initSocket() {
        if (typeof io === 'undefined') return;
        this.socket = io();

        this.socket.on('connected', (data) => {
            if (data && data.collectionPhase) {
                this.collectionPhase = data.collectionPhase;
            }
        });

        this.socket.on('news-updated', (payload) => {
            if (payload && payload.phase) {
                this.collectionPhase = payload.phase;
            }
            if (payload && payload.lastPublishedBy) {
                this.lastPublishedBy = payload.lastPublishedBy;
            }
            this.fetchLatestNews();
            this.fetchStatus();
        });

        this.socket.on('summary-completed', (payload) => {
            if (payload && payload.article) {
                this.summaryArticle = payload.article;
                this.renderSummaryArticle(payload.article);
            }
        });

        this.socket.on('pulse-updated', (payload) => {
            if (payload && payload.socialPulse) {
                this.socialPulse = payload.socialPulse;
                if (!this.selectedPulseKey || !(this.socialPulse.issues || []).some(it => it.key === this.selectedPulseKey)) {
                    this.selectedPulseKey = this.socialPulse.latestKey || (this.socialPulse.issues?.[0]?.key || '');
                }
                this.renderSocialPulse();
            } else {
                this.fetchLatestPulse();
            }
        });

        this.socket.on('audio-updated', (payload) => {
            if (payload && Object.prototype.hasOwnProperty.call(payload, 'audioBroadcast')) {
                this.audioBroadcast = payload.audioBroadcast || null;
                this.renderBroadcastPlayer({ preservePlayback: true });
                this.renderSocialPulse();
            } else {
                this.fetchLatestAudio();
            }
        });

        this.socket.on('schedule-updated', (payload) => {
            if (payload) {
                this.schedule = { ...(this.schedule || {}), ...payload };
                this.renderStatusBar();
            }
        });

        this.socket.on('news-update-completed', () => {
            this.fetchLatestNews();
            this.fetchLatestSummary();
            this.fetchLatestPulse();
            this.fetchLatestAudio();
            this.fetchStatus();
        });
    }

    initTablistEnhancements() {
        const panelsHost = document.getElementById('tabPanelsHost');
        if (panelsHost) {
            panelsHost.addEventListener('beforematch', (e) => {
                const matchedPanel = e.target && typeof e.target.closest === 'function'
                    ? e.target.closest('[role="tabpanel"]')
                    : null;
                if (matchedPanel && matchedPanel.id && matchedPanel.id.startsWith('tabPanel-')) {
                    const tabId = matchedPanel.id.replace('tabPanel-', '');
                    this.switchTab(tabId);
                }
            });
        }

        if (typeof HTMLElement !== 'undefined' && !Object.hasOwn(HTMLElement.prototype, 'focusGroup')) {
            const tablist = document.querySelector('.kami-tabs-list[role="tablist"]');
            if (tablist) {
                tablist.addEventListener('keydown', (e) => {
                    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
                    const tabBtns = Array.from(tablist.querySelectorAll('[role="tab"]'));
                    if (tabBtns.length === 0) return;
                    const curIdx = Math.max(0, tabBtns.indexOf(document.activeElement));
                    let nextIdx = curIdx;
                    if (e.key === 'ArrowRight') nextIdx = (curIdx + 1) % tabBtns.length;
                    else if (e.key === 'ArrowLeft') nextIdx = (curIdx - 1 + tabBtns.length) % tabBtns.length;
                    else if (e.key === 'Home') nextIdx = 0;
                    else if (e.key === 'End') nextIdx = tabBtns.length - 1;
                    e.preventDefault();
                    const targetBtn = tabBtns[nextIdx];
                    if (targetBtn) {
                        targetBtn.focus();
                        const tid = (targetBtn.id || '').replace('tabBtn-', '');
                        if (tid) this.switchTab(tid);
                    }
                });
            }
        }

        if (typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && !CSS.supports('animation-timeline', 'scroll()') && typeof IntersectionObserver !== 'undefined') {
            for (const scroller of document.querySelectorAll('.kami-tabs-list')) {
                const first = scroller.firstElementChild;
                const last = scroller.lastElementChild;
                if (!first || !last) continue;
                const observer = new IntersectionObserver((entries) => {
                    for (const { target, intersectionRatio } of entries) {
                        scroller.classList.toggle(target === first ? 'more-start' : 'more-end', intersectionRatio < 1);
                    }
                }, { root: scroller, threshold: 1, rootMargin: '1px' });
                observer.observe(first);
                observer.observe(last);
            }
        }
    }

    initInitialTabFromUrl() {
        const applyFromLocation = () => {
            try {
                const hash = (window.location.hash || '').replace(/^#/, '').trim().toLowerCase();
                const params = new URLSearchParams(window.location.search || '');
                const queryTab = (params.get('tab') || '').trim().toLowerCase();
                const target = queryTab || hash;
                if (['feed', 'summary', 'pulse'].includes(target)) {
                    this.switchTab(target, { skipUrlSync: true });
                }
            } catch (_) {}
        };
        applyFromLocation();
        window.addEventListener('hashchange', applyFromLocation);
    }

    // ==================== 3. 选项卡与多维筛选 ====================
    switchTab(tabName, opts = {}) {
        const normalized = tabName === 'news' ? 'feed' : (['feed', 'summary', 'pulse'].includes(tabName) ? tabName : 'feed');
        this.activeTab = normalized;
        const tabs = ['feed', 'summary', 'pulse'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tabBtn-${t}`);
            const panel = document.getElementById(`tabPanel-${t}`);
            const isSelected = t === normalized;
            if (btn) {
                btn.classList.toggle('active', isSelected);
                btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
                btn.toggleAttribute('focusgroupstart', isSelected);
                if (isSelected && typeof btn.scrollIntoView === 'function') {
                    try {
                        btn.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
                    } catch (_) {
                        btn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    }
                }
            }
            if (panel) {
                if (isSelected) {
                    panel.removeAttribute('hidden');
                    panel.classList.remove('hidden');
                } else {
                    panel.setAttribute('hidden', 'until-found');
                }
            }
        });

        const searchWrapper = document.getElementById('feedSearchWrapper');
        if (searchWrapper) {
            searchWrapper.classList.toggle('hidden', normalized !== 'feed');
        }
        const pulseToolbar = document.getElementById('pulseToolbarWrapper');
        if (pulseToolbar) {
            pulseToolbar.classList.toggle('hidden', normalized !== 'pulse');
        }

        const tabTitles = {
            feed: '聚核 CoreFeed · 全球要闻深度聚合',
            summary: '今日综述 · 聚核 CoreFeed',
            pulse: '欧美社媒热议 · 聚核 CoreFeed'
        };
        if (typeof document !== 'undefined' && tabTitles[normalized]) {
            document.title = tabTitles[normalized];
        }
        if (!opts.skipUrlSync && typeof window !== 'undefined' && window.history?.replaceState) {
            try {
                const nextHash = normalized === 'feed' ? '' : `#${normalized}`;
                const cleanBase = window.location.pathname + window.location.search;
                if (window.location.hash !== nextHash) {
                    window.history.replaceState(null, '', cleanBase + nextHash);
                }
            } catch (_) {}
        }
    }

    renderFilters() {
        const regionBar = document.getElementById('regionFilterBar');
        const categoryBar = document.getElementById('categoryFilterBar');
        const sourceSelect = document.getElementById('sourceFilterSelect');
        if (!regionBar || !categoryBar) return;

        const regionCounts = { '全部': this.news.length };
        const categoryCounts = { '全部': this.news.length };
        const sourceCounts = {};

        this.news.forEach(item => {
            const r = item.region || '国际';
            const c = item.category || '国际';
            const s = item.source?.name || 'Global Media';
            regionCounts[r] = (regionCounts[r] || 0) + 1;
            categoryCounts[c] = (categoryCounts[c] || 0) + 1;
            sourceCounts[s] = (sourceCounts[s] || 0) + 1;
        });

        if (this.selectedRegion !== '全部' && !regionCounts[this.selectedRegion]) {
            this.selectedRegion = '全部';
        }
        if (this.selectedCategory !== '全部' && !categoryCounts[this.selectedCategory]) {
            this.selectedCategory = '全部';
        }

        const regions = Object.keys(regionCounts);
        regionBar.innerHTML = `<span class="filter-row-label">地区</span>` +
            regions.map(r => {
                const active = this.selectedRegion === r;
                return `<button type="button" data-filter-region="${this.escapeHtml(r)}" class="btn-chip ${active ? 'active' : ''}"><span>${this.escapeHtml(r)}</span><span class="chip-count">(${regionCounts[r]})</span></button>`;
            }).join('');

        const categories = Object.keys(categoryCounts);
        categoryBar.innerHTML = `<span class="filter-row-label">领域</span>` +
            categories.map(c => {
                const active = this.selectedCategory === c;
                return `<button type="button" data-filter-category="${this.escapeHtml(c)}" class="btn-chip ${active ? 'active' : ''}"><span>${this.escapeHtml(c)}</span><span class="chip-count">(${categoryCounts[c]})</span></button>`;
            }).join('');

        if (sourceSelect) {
            const currentVal = sourceSelect.value || '全部';
            const sortedSources = Object.keys(sourceCounts).sort((a, b) => sourceCounts[b] - sourceCounts[a]);
            sourceSelect.innerHTML = `<option value="全部">全部媒体来源 (${this.news.length})</option>` +
                sortedSources.map(s => `<option value="${this.escapeHtml(s)}" ${currentVal === s ? 'selected' : ''}>${this.escapeHtml(s)} (${sourceCounts[s]})</option>`).join('');
        }
    }

    setRegionFilter(region) {
        this.selectedRegion = region;
        this.renderFilters();
        this.renderNewsGrid();
    }

    setCategoryFilter(category) {
        this.selectedCategory = category;
        this.renderFilters();
        this.renderNewsGrid();
    }

    applyFilters() {
        const inputEl = document.getElementById('localFilterInput');
        const clearBtn = document.getElementById('btnClearSearch');
        if (clearBtn && inputEl) {
            clearBtn.classList.toggle('hidden', !inputEl.value.trim());
        }
        this.renderNewsGrid();
    }

    clearSearch() {
        const inputEl = document.getElementById('localFilterInput');
        if (inputEl) {
            inputEl.value = '';
        }
        this.applyFilters();
    }

    // ==================== 4. 全球新闻网格与卡片渲染 ====================
    renderNewsGrid() {
        const grid = document.getElementById('newsGrid');
        if (!grid) return;

        const keyword = (document.getElementById('localFilterInput')?.value || '').trim().toLowerCase();
        const selectedSource = document.getElementById('sourceFilterSelect')?.value || '全部';

        const filtered = this.news.filter(item => {
            if (this.selectedRegion !== '全部' && (item.region || '国际') !== this.selectedRegion) {
                return false;
            }
            if (this.selectedCategory !== '全部' && (item.category || '国际') !== this.selectedCategory) {
                return false;
            }
            if (selectedSource !== '全部' && (item.source?.name || 'Global Media') !== selectedSource) {
                return false;
            }
            if (keyword) {
                const hay = `${item.translatedTitle || ''} ${item.title || ''} ${item.summary || ''} ${item.source?.name || ''}`.toLowerCase();
                if (!hay.includes(keyword)) return false;
            }
            return true;
        });

        const loadMoreBtn = document.getElementById('loadMoreContainer');
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', this.news.length >= this.totalNews);
        }

        if (filtered.length === 0) {
            this.stopHeroCarousel();
            this.heroSlideCount = 0;
            grid.innerHTML = `
                <div class="col-span-full kami-card py-14 text-center space-y-3">
                    <div class="kami-tag mx-auto">暂无匹配新闻</div>
                    <h3 class="text-xl font-bold" style="color: var(--text-primary);">当前筛选条件下暂无新闻条目</h3>
                    <p class="text-sm max-w-md mx-auto" style="color: var(--text-muted);">可尝试切换筛选条件，或点击右上角「同步最新」拉取最新一期全球权威媒体精编要闻。</p>
                </div>
            `;
            return;
        }

        const heroItems = filtered.slice(0, 3);
        const compactItems = filtered.slice(3);

        this.heroSlideIndex = 0;
        this.heroSlideCount = heroItems.length;

        const heroHtml = this.renderHeroCarouselHtml(heroItems);
        const compactHtml = compactItems.map((item, cIdx) => this.renderSingleCardHtml(item, cIdx + 3)).join('');
        grid.innerHTML = heroHtml + compactHtml;

        this.startHeroCarousel();
    }

    renderSingleCardHtml(item, idx) {
        const indexNum = String(idx + 1).padStart(2, '0');

        const title = item.translatedTitle || item.title || '无标题';
        const originalTitle = item.translatedTitle && item.translatedTitle !== item.title ? item.title : '';
        const summary = item.summary || item.translatedDescription || item.description || '';
        const sourceName = item.source?.name || 'Global Media';
        const region = item.region || '国际';
        const category = item.category || '国际';
        const timeStr = item.publishedAt ? this.formatRelativeTime(item.publishedAt) : '';
        const rawImageUrl = item.urlToImage || '';
        const imageUrl = this.safeAssetUrl(rawImageUrl, '');

        const relatedSources = Array.isArray(item.relatedSources) ? item.relatedSources : [];
        const hasMultiSources = relatedSources.length > 0;
        const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];
        const isCompiling = (this.collectionPhase === 'collected' || this.collectionPhase === 'compiling') && !item.aiCompiled;

        const relatedLinksHtml = relatedSources.map(r => {
            const safeRelUrl = this.safeHttpUrl(r.url, '');
            if (safeRelUrl) {
                return `<a href="${this.escapeHtml(safeRelUrl)}" target="_blank" rel="noopener noreferrer" class="hover:underline font-medium" title="${this.escapeHtml(r.title || r.name)}">${this.escapeHtml(r.name)}</a>`;
            }
            return `<span>${this.escapeHtml(r.name)}</span>`;
        }).join('、');

        const metaBadgeText = category && category !== region ? `${region} · ${category}` : region;
        const isRemoteHttp = /^https?:\/\//i.test(imageUrl);
        const displayImgSrc = isRemoteHttp ? `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;
        const safeItemUrl = this.safeHttpUrl(item.url, '#');

        return `
            <article class="news-card news-card--compact bento-span-4">
                <div>
                    <div class="card-meta-header">
                        <div class="card-meta-left">
                            <span class="card-index-num">${indexNum}</span>
                            <span class="card-meta-sep">/</span>
                            <span class="card-source-name" title="${this.escapeHtml(sourceName)}">${this.escapeHtml(sourceName)}</span>
                        </div>
                        <span class="card-taxonomy-pill">${this.escapeHtml(metaBadgeText)}</span>
                    </div>

                    <div class="lead-bento-inner card-body-trigger"
                         role="button"
                         tabindex="0"
                         title="点击查看原文全文中文翻译"
                         data-card-url="${this.escapeHtml(item.url || '')}">
                        <div class="card-cover block ${imageUrl ? '' : 'is-fallback'}" data-cat="${this.escapeHtml(category)}">
                            ${imageUrl ? `
                                <img src="${this.escapeHtml(displayImgSrc)}"
                                     data-raw-src="${this.escapeHtml(imageUrl)}"
                                     alt="${this.escapeHtml(title)}"
                                     loading="lazy"
                                     referrerpolicy="no-referrer"
                                     class="card-cover-img"
                                     onerror="if(!this.dataset.retried && this.dataset.rawSrc && this.src !== this.dataset.rawSrc){this.dataset.retried='1';this.src=this.dataset.rawSrc;}else{this.parentElement.classList.add('is-fallback');this.remove();}" />
                            ` : ''}
                            <div class="card-cover-fallback">
                                <div class="fallback-plate-top">
                                    <span>${this.escapeHtml(region)}</span>
                                    <span>${this.escapeHtml(category)}</span>
                                </div>
                                <div class="fallback-plate-watermark">CoreFeed</div>
                                <div class="fallback-plate-bottom">
                                    <span class="fallback-plate-source">${this.escapeHtml(sourceName)}</span>
                                    <span class="fallback-plate-cat">要闻简报</span>
                                </div>
                            </div>
                        </div>

                        <div class="card-body">
                            ${hasMultiSources ? `
                                <div class="kami-callout flex flex-col gap-0.5">
                                    <div class="kami-callout-title">${relatedSources.length + 1} 家权威外媒交叉印证</div>
                                    <div class="truncate text-xs" style="color: var(--text-body);">同题报道：${relatedLinksHtml}</div>
                                </div>
                            ` : ''}

                            ${isCompiling ? `
                                <div>
                                    <span class="kami-tag">后台深度精编中</span>
                                </div>
                            ` : ''}

                            <div>
                                <h3 class="card-title">
                                    <span class="card-title-link">${this.escapeHtml(title)}</span>
                                </h3>
                                ${originalTitle ? `<p class="card-subtitle-en line-clamp-2" title="${this.escapeHtml(originalTitle)}">${this.escapeHtml(originalTitle)}</p>` : ''}
                            </div>

                            <p class="card-summary">${this.escapeHtml(summary)}</p>

                            ${keyPoints.length > 0 ? `
                                <ul class="card-keypoints">
                                    ${keyPoints.map(kp => `<li class="card-keypoint-item">${this.escapeHtml(kp)}</li>`).join('')}
                                </ul>
                            ` : ''}
                        </div>
                    </div>
                </div>

                <div class="card-footer">
                    <div class="card-footer-meta">
                        <span class="card-timestamp">${this.escapeHtml(timeStr)}</span>
                    </div>
                    <a href="${this.escapeHtml(safeItemUrl)}" target="_blank" rel="noopener noreferrer"
                        class="btn-source-link">
                        <span>原文</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </article>
        `;
    }

    handleCardBodyClick(event, rawUrl, isDecoded = false) {
        if (event && event.target && typeof event.target.closest === 'function') {
            const interactiveEl = event.target.closest('a, button');
            if (interactiveEl) {
                return;
            }
        }
        if (event) {
            event.preventDefault();
        }
        let url = '';
        if (isDecoded) {
            url = String(rawUrl || '');
        } else {
            try {
                url = decodeURIComponent(rawUrl || '');
            } catch (_) {
                url = String(rawUrl || '');
            }
        }
        if (!url) return;
        this.openFullTextModal(url);
    }

    // ==================== 5. 状态遥测、GitHub 快照同步与增量加载 ====================
    async fetchStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            if (!data || !data.success) return;

            const prevLastUpdated = this.lastUpdated;
            const prevNewsCount = this.news.length;

            if (data.lastUpdated) {
                this.lastUpdated = data.lastUpdated;
            }
            if (data.lastPublishedBy) {
                this.lastPublishedBy = data.lastPublishedBy;
            }
            if (data.githubSync) {
                this.githubSync = data.githubSync;
                if (!this.lastPublishedBy && data.githubSync.publishedBy) {
                    this.lastPublishedBy = data.githubSync.publishedBy;
                }
                if (data.githubSync.clientId) {
                    this.clientId = data.githubSync.clientId;
                }
            }
            if (data.schedule) {
                this.schedule = data.schedule;
            }
            const newsChanged = Boolean(
                (data.lastUpdated && data.lastUpdated !== prevLastUpdated) ||
                (typeof data.newsCount === 'number' && data.newsCount > 0 && data.newsCount !== prevNewsCount)
            );
            if (newsChanged) {
                this.fetchLatestNews();
                if (data.hasSummary) {
                    this.fetchLatestSummary();
                }
            }
            if (data.hasAudioBroadcast) {
                const curAudioTs = this.audioBroadcast?.updatedAt || null;
                const curTrackCount = this.audioBroadcast?.trackCount || 0;
                if (!this.audioBroadcast || curTrackCount !== (data.audioTrackCount || 0) || (data.audioUpdatedAt && data.audioUpdatedAt !== curAudioTs)) {
                    this.fetchLatestAudio();
                }
            }
            if (data.hasSocialPulse) {
                const curPulseTs = this.socialPulse?.updatedAt || null;
                if (!this.socialPulse || (data.socialPulseUpdatedAt && data.socialPulseUpdatedAt !== curPulseTs)) {
                    this.fetchLatestPulse();
                }
            }
            this.renderStatusBar();
            this.renderModalSyncStatus();
        } catch (_) {}
    }

    updateHeaderTimestamp(isoStr = this.lastUpdated) {
        if (isoStr) {
            this.lastUpdated = isoStr;
        }
        const updatedEl = document.getElementById('lastUpdateTime');
        if (!updatedEl) return;
        if (!this.lastUpdated) {
            updatedEl.textContent = '更新于 --:--';
            return;
        }
        const d = new Date(this.lastUpdated);
        if (isNaN(d.getTime())) {
            updatedEl.textContent = '更新于 --:--';
            return;
        }
        const nowStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const itemDateStr = d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
        const timePart = d.toLocaleTimeString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });
        if (nowStr === itemDateStr) {
            updatedEl.textContent = `更新于 ${timePart}`;
        } else {
            const mdPart = d.toLocaleDateString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                month: '2-digit',
                day: '2-digit'
            });
            updatedEl.textContent = `更新于 ${mdPart} ${timePart}`;
        }
    }

    renderStatusBar() {
        this.updateHeaderTimestamp(this.lastUpdated);
    }

    renderModalSyncStatus() {
        const gh = this.githubSync || {};
        const statusEl = document.getElementById('modalSyncStatusText');
        const syncedAtEl = document.getElementById('modalSyncLastTime');

        const statusMap = {
            synced: '已同步最新',
            'up-to-date': '已是最新',
            idle: '就绪',
            error: `同步异常 (${gh.lastSyncError || '未知错误'})`
        };

        if (statusEl) {
            statusEl.textContent = gh.enabled === false
                ? '自动同步已关闭'
                : (statusMap[gh.lastSyncStatus] || gh.lastSyncStatus || '就绪');
        }
        if (syncedAtEl) {
            const ts = gh.lastSyncedAt || gh.lastSyncCheckAt || this.lastUpdated;
            syncedAtEl.textContent = ts
                ? new Date(ts).toLocaleString('zh-CN', {
                    month: '2-digit',
                    day: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                    timeZone: 'Asia/Shanghai'
                })
                : '尚未同步';
        }
    }

    async syncFromGitHub(options = {}) {
        if (this.isSyncingGithub) return;
        this.isSyncingGithub = true;

        const headerBtn = document.getElementById('syncGithubBtn');
        const headerIcon = document.getElementById('syncGithubBtnIcon');
        const headerText = document.getElementById('syncGithubBtnText');

        if (headerBtn) headerBtn.disabled = true;
        if (headerIcon) headerIcon.className = 'fa-solid fa-spinner fa-spin text-xs';
        if (headerText) headerText.textContent = '同步中...';

        try {
            const res = await fetch('/api/agent/pull-github', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'CoreFeed-WebUI'
                },
                body: JSON.stringify({
                    force: options.force !== undefined ? Boolean(options.force) : true,
                    trigger: 'ui'
                })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.message || '同步最新内容失败');
            }

            if (data.publishedBy) {
                this.lastPublishedBy = data.publishedBy;
            }
            if (data.lastUpdated || data.publishedAt) {
                this.lastUpdated = data.lastUpdated || data.publishedAt;
            }

            await Promise.all([
                this.fetchLatestNews(),
                this.fetchLatestSummary(),
                this.fetchLatestPulse(),
                this.fetchLatestAudio(),
                this.fetchStatus()
            ]);

            const count = data.displayedCount || this.news.length;
            if (data.skipped) {
                this.toast(`当前已是最新内容（共 ${count} 条精选要闻）`, 'info');
            } else {
                this.toast(`已同步最新全球要闻（共 ${count} 条）`, 'success');
            }
        } catch (err) {
            this.toast(`同步失败: ${err.message}`, 'error');
            await this.fetchStatus();
        } finally {
            this.isSyncingGithub = false;
            if (headerBtn) headerBtn.disabled = false;
            if (headerIcon) headerIcon.className = 'fa-solid fa-rotate text-xs';
            if (headerText) headerText.textContent = '同步最新';
        }
    }

    async fetchLatestSummary() {
        try {
            const res = await fetch('/api/summary');
            const data = await res.json();
            if (data && data.success && data.article) {
                this.summaryArticle = data.article;
                this.renderSummaryArticle(data.article);
            }
        } catch (_) {}
    }

    async fetchLatestNews() {
        try {
            const res = await fetch('/api/news');
            const data = await res.json();
            if (data && data.success && Array.isArray(data.news)) {
                this.news = data.news;
                this.totalNews = data.total || this.news.length;
                if (data.collectionPhase) {
                    this.collectionPhase = data.collectionPhase;
                }
                if (data.lastUpdated) {
                    this.lastUpdated = data.lastUpdated;
                    this.updateHeaderTimestamp(data.lastUpdated);
                }
                if (data.lastPublishedBy) {
                    this.lastPublishedBy = data.lastPublishedBy;
                }
                this.renderFilters();
                this.renderNewsGrid();
                this.renderStatusBar();
            }
        } catch (_) {}
    }

    async loadMoreNews() {
        try {
            const res = await fetch(`/api/news/more?offset=${this.news.length}&limit=15`);
            const data = await res.json();
            if (data && data.success && Array.isArray(data.news) && data.news.length > 0) {
                this.news.push(...data.news);
                this.totalNews = data.total || this.news.length;
                this.renderFilters();
                this.renderNewsGrid();
                this.toast(`已加载额外 ${data.news.length} 条全球新闻`, 'info');
            } else {
                this.toast('已加载全部可用新闻', 'info');
            }
        } catch (err) {
            this.toast('加载更多失败: ' + err.message, 'error');
        }
    }

    // ==================== 6. 今日要闻深度综述 ====================
    renderSummaryArticle(article) {
        if (!article) return;
        const titleEl = document.getElementById('summaryTitle');
        const metaEl = document.getElementById('summaryMeta');
        const bodyEl = document.getElementById('summaryBody');

        if (titleEl) titleEl.textContent = article.title || '今日全球要闻深度综述';
        if (metaEl) {
            metaEl.textContent = `生成时间：${new Date(article.generatedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} / 涵盖 ${(article.regions || []).join('、')}（${article.wordCount || 0} 字）`;
        }
        if (bodyEl) {
            bodyEl.innerHTML = this.sanitizeSummaryHtml(article.htmlContent || '');
        }
    }

    // ==================== 7. 极简系统设置弹窗（含焦点陷阱与恢复） ====================
    async openSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        modal.classList.remove('hidden');
        this.modalFocus.activate(modal, '#cfgAutoUpdateEnabled');

        try {
            const [cfgRes, statusRes] = await Promise.all([
                fetch('/api/config'),
                fetch('/api/status')
            ]);
            const data = await cfgRes.json();
            const statusData = await statusRes.json().catch(() => ({}));

            if (statusData && statusData.success) {
                if (statusData.githubSync) this.githubSync = statusData.githubSync;
                if (statusData.lastPublishedBy) this.lastPublishedBy = statusData.lastPublishedBy;
                if (statusData.schedule) this.schedule = statusData.schedule;
            }

            if (data && data.success) {
                const cfg = data.config || data;
                const { schedule = {}, githubSync = {} } = cfg;

                if (githubSync && Object.keys(githubSync).length > 0) {
                    this.githubSync = { ...(this.githubSync || {}), ...githubSync };
                }
                this.renderModalSyncStatus();

                const autoUpdateEnabled = cfg.AUTO_UPDATE_ENABLED ?? schedule.enabled ?? true;
                const autoUpdateEl = document.getElementById('cfgAutoUpdateEnabled');
                if (autoUpdateEl) autoUpdateEl.checked = Boolean(autoUpdateEnabled);

                const updateTimesArr = schedule.updateTimes || cfg.UPDATE_TIMES || ['08:00', '12:30', '19:30'];
                const updateTimesEl = document.getElementById('cfgUpdateTimes');
                if (updateTimesEl) {
                    updateTimesEl.value = Array.isArray(updateTimesArr)
                        ? updateTimesArr.join(', ')
                        : String(updateTimesArr || '08:00, 12:30, 19:30');
                }
            }
        } catch (_) {}
    }

    closeSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal || modal.classList.contains('hidden')) return;
        modal.classList.add('hidden');
        this.modalFocus.deactivate(modal);
    }

    async saveSettings() {
        const autoUpdateEl = document.getElementById('cfgAutoUpdateEnabled');
        const autoUpdateEnabled = autoUpdateEl ? Boolean(autoUpdateEl.checked) : true;

        const rawUpdateTimes = (document.getElementById('cfgUpdateTimes')?.value || '08:00, 12:30, 19:30').trim();
        const updateTimes = rawUpdateTimes
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .join(',') || '08:00,12:30,19:30';

        const payload = {
            AUTO_UPDATE_ENABLED: autoUpdateEnabled,
            UPDATE_TIMES: updateTimes
        };

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'CoreFeed-WebUI'
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '保存失败');

            await this.fetchStatus();
            this.closeSettingsModal();
            this.toast('设置已保存并生效', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }
}

Object.assign(
    CoreFeedApp.prototype,
    heroCarouselMethods,
    readerModalMethods,
    socialPulseMethods,
    audioPlayerMethods
);

const bootApp = () => {
    if (typeof window !== 'undefined' && !window.app) {
        window.app = new CoreFeedApp();
    }
};

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', bootApp);
    } else {
        bootApp();
    }
}
