/**
 * 聚核 CoreFeed v2.0 · 前端交互与实时状态同步控制器
 *
 * 核心职责：
 *   1. 承接 SSR 首屏状态 (window.__INITIAL_STATE__) 并建立 Socket.IO 实时增量同步
 *   2. 12 列不对称 Swiss Editorial Bento 网格动态渲染与多维筛选（地区/领域/信源/关键词）
 *   3. 一键触发 GitHub 快照拉取 (POST /api/agent/pull-github) 与 60 秒轻量状态遥测轮询
 *   4. 极简系统设置弹窗 (GET/POST /api/config) 与深浅色主题切换
 */
class CoreFeedApp {
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

    // ==================== 1. 主题、快捷键与通知 ====================
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
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    safeHttpUrl(rawUrl, fallback = '') {
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

    safeAssetUrl(rawUrl, fallback = '') {
        if (typeof rawUrl !== 'string') return fallback;
        const trimmed = rawUrl.trim();
        if (!trimmed) return fallback;
        if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
            return trimmed;
        }
        return this.safeHttpUrl(trimmed, fallback);
    }

    sanitizeSummaryHtml(rawHtml = '') {
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
                            const safe = this.safeHttpUrl(attr.value, '');
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
            if (payload && payload.audioBroadcast) {
                this.audioBroadcast = payload.audioBroadcast;
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

    // ==================== 4. 渲染 Top-3 轮播大卡 + 小卡片全球新闻网格 ====================
    startHeroCarousel() {
        this.stopHeroCarousel();
        if (this.heroSlideCount <= 1) return;
        if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return;
        }
        this.heroCarouselTimer = setInterval(() => {
            if (!this.heroCarouselPaused && this.activeTab === 'feed') {
                this.nextHeroSlide(false);
            }
        }, 6500);
    }

    stopHeroCarousel() {
        if (this.heroCarouselTimer) {
            clearInterval(this.heroCarouselTimer);
            this.heroCarouselTimer = null;
        }
    }

    pauseHeroCarousel() {
        this.heroCarouselPaused = true;
    }

    resumeHeroCarousel() {
        this.heroCarouselPaused = false;
    }

    goToHeroSlide(targetIdx, manual = true) {
        if (this.heroSlideCount <= 1) return;
        const normalized = ((targetIdx % this.heroSlideCount) + this.heroSlideCount) % this.heroSlideCount;
        this.heroSlideIndex = normalized;

        const carousel = document.getElementById('heroCarousel');
        if (!carousel) return;

        const slides = carousel.querySelectorAll('.hero-carousel-slide');
        slides.forEach((slide, idx) => {
            const active = idx === normalized;
            slide.classList.toggle('is-active', active);
            slide.setAttribute('aria-hidden', active ? 'false' : 'true');
        });

        const dockItems = carousel.querySelectorAll('.hero-dock-item');
        dockItems.forEach((btn, idx) => {
            const active = idx === normalized;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-selected', active ? 'true' : 'false');
        });

        if (manual) {
            this.startHeroCarousel();
        }
    }

    nextHeroSlide(manual = true) {
        this.goToHeroSlide(this.heroSlideIndex + 1, manual);
    }

    prevHeroSlide(manual = true) {
        this.goToHeroSlide(this.heroSlideIndex - 1, manual);
    }

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

    renderHeroCarouselHtml(heroItems) {
        const totalHero = heroItems.length;
        const slidesHtml = heroItems.map((item, slideIdx) => this.renderHeroSlideHtml(item, slideIdx, totalHero)).join('');
        const dockHtml = totalHero > 1 ? `
            <div class="hero-carousel-dock" role="tablist" aria-label="切换前三位重点要闻">
                ${heroItems.map((hItem, hIdx) => {
                    const hNum = String(hIdx + 1).padStart(2, '0');
                    const hTitle = hItem.translatedTitle || hItem.title || '无标题';
                    const hSource = hItem.source?.name || 'Global Media';
                    const active = hIdx === 0;
                    return `
                        <button type="button"
                                role="tab"
                                aria-selected="${active ? 'true' : 'false'}"
                                data-dock-index="${hIdx}"
                                onclick="app.goToHeroSlide(${hIdx})"
                                class="hero-dock-item ${active ? 'is-active' : ''}">
                            <div class="hero-dock-meta">
                                <span class="hero-dock-num">${hNum}</span>
                                <span class="card-meta-sep">/</span>
                                <span class="hero-dock-source">${this.escapeHtml(hSource)}</span>
                            </div>
                            <div class="hero-dock-title line-clamp-1">${this.escapeHtml(hTitle)}</div>
                        </button>
                    `;
                }).join('')}
            </div>
        ` : '';

        return `
            <section id="heroCarousel"
                     class="news-card news-card--lead hero-carousel bento-span-12"
                     aria-roledescription="carousel"
                     aria-label="重点要闻轮播"
                     onmouseenter="app.pauseHeroCarousel()"
                     onmouseleave="app.resumeHeroCarousel()">
                <div class="hero-carousel-track">
                    ${slidesHtml}
                </div>
                ${dockHtml}
            </section>
        `;
    }

    renderHeroSlideHtml(item, slideIdx, totalHero) {
        const indexNum = String(slideIdx + 1).padStart(2, '0');
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
        const active = slideIdx === 0;

        return `
            <article class="hero-carousel-slide ${active ? 'is-active' : ''}"
                     data-slide-index="${slideIdx}"
                     aria-hidden="${active ? 'false' : 'true'}">
                <div class="hero-slide-top">
                    <div class="card-meta-header">
                        <div class="card-meta-left">
                            <span class="card-index-num">${indexNum}</span>
                            <span class="card-meta-sep">/</span>
                            <span class="card-source-name" title="${this.escapeHtml(sourceName)}">${this.escapeHtml(sourceName)}</span>
                        </div>
                        <div class="hero-meta-right">
                            <span class="card-taxonomy-pill">${this.escapeHtml(metaBadgeText)}</span>
                            ${totalHero > 1 ? `
                                <div class="hero-step-controls" role="group" aria-label="切换重点要闻">
                                    <button type="button" class="hero-step-btn" onclick="app.prevHeroSlide()" aria-label="上一条要闻" title="上一条要闻">
                                        <i class="fa-solid fa-chevron-left" aria-hidden="true"></i>
                                    </button>
                                    <span class="hero-step-counter tabular-nums">${slideIdx + 1} / ${totalHero}</span>
                                    <button type="button" class="hero-step-btn" onclick="app.nextHeroSlide()" aria-label="下一条要闻" title="下一条要闻">
                                        <i class="fa-solid fa-chevron-right" aria-hidden="true"></i>
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    </div>

                    <div class="lead-bento-inner has-media card-body-trigger"
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
                        <span class="card-meta-sep">·</span>
                        <span class="card-translate-hint">点击卡片看全文翻译</span>
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

    setReaderFontSize(mode) {
        this.readerFontSize = mode === 'large' ? 'large' : 'standard';
        try {
            localStorage.setItem('corefeed_reader_size', this.readerFontSize);
        } catch (_) {}
        this.applyReaderFontSize();
    }

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
    }

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
    }

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
    }

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
    }

    openFullTextModal(url) {
        const modal = document.getElementById('fullTextModal');
        if (!modal) return;

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
    }

    async syncSnapshotForModal() {
        const targetUrl = this.currentFullTextUrl;
        await this.syncFromGitHub({ force: true });
        const modal = document.getElementById('fullTextModal');
        if (targetUrl && modal && !modal.classList.contains('hidden')) {
            this.openFullTextModal(targetUrl);
        }
    }

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
    }

    closeFullTextModal() {
        const modal = document.getElementById('fullTextModal');
        if (!modal || modal.classList.contains('hidden')) return;
        modal.classList.add('hidden');
        this.currentFullTextUrl = null;
        this.resumeHeroCarousel();
    }

    formatRelativeTime(dateInput) {
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

    // ==================== 6.5 欧美社媒热议 (Western Social Pulse) ====================

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
    }

    getActivePulseIssue() {
        const issues = Array.isArray(this.socialPulse?.issues) ? this.socialPulse.issues : [];
        if (issues.length === 0) return null;
        return issues.find(it => it.key === this.selectedPulseKey) ||
            issues.find(it => it.key === this.socialPulse?.latestKey) ||
            issues[0];
    }

    selectPulseIssue(issueKey) {
        this.selectedPulseKey = String(issueKey || '').trim();
        this.selectedPulseRegion = '全部';
        this.selectedPulseLang = '全部';
        this.selectedPulsePlatform = '全部';
        this.selectedPulseCategory = '全部';
        this.renderSocialPulse();
    }

    setPulseRegionFilter(region) {
        this.selectedPulseRegion = region;
        this.renderSocialPulse();
    }

    setPulseLangFilter(lang) {
        this.selectedPulseLang = lang;
        this.renderSocialPulse();
    }

    setPulsePlatformFilter(platform) {
        this.selectedPulsePlatform = platform;
        this.renderSocialPulse();
    }

    setPulseCategoryFilter(category) {
        this.selectedPulseCategory = category;
        this.renderSocialPulse();
    }

    applyPulseFilters() {
        const inputEl = document.getElementById('pulseSearchInput');
        const clearBtn = document.getElementById('btnClearPulseSearch');
        if (clearBtn && inputEl) {
            clearBtn.classList.toggle('hidden', !inputEl.value.trim());
        }
        this.renderSocialPulse();
    }

    clearPulseSearch() {
        const inputEl = document.getElementById('pulseSearchInput');
        if (inputEl) {
            inputEl.value = '';
        }
        this.applyPulseFilters();
    }

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
    }

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
                    const cLen = Array.isArray(iss.clusters) ? iss.clusters.length : 0;
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
    }

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

    // ==================== 6.8 双主播语音播报播放器 (Qwen3-TTS 1.7B) ====================

    formatAudioClock(secInput) {
        const total = Math.max(0, Math.round(Number(secInput) || 0));
        const mins = Math.floor(total / 60);
        const secs = total % 60;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    formatAudioAriaTime(curSec, durSec) {
        const c = Math.max(0, Math.round(Number(curSec) || 0));
        const d = Math.max(0, Math.round(Number(durSec) || 0));
        const cm = Math.floor(c / 60);
        const cs = c % 60;
        const dm = Math.floor(d / 60);
        const ds = d % 60;
        return d > 0
            ? `已播放 ${cm} 分 ${cs} 秒，共 ${dm} 分 ${ds} 秒`
            : `已播放 ${cm} 分 ${cs} 秒`;
    }

    syncBroadcastSliderVars() {
        const slider = document.getElementById('broadcastSeekSlider');
        if (!slider) return;
        const minVal = parseFloat(slider.min || '0') || 0;
        const maxVal = Math.max(0.1, parseFloat(slider.max || '100') || 100);
        const curVal = Math.min(maxVal, Math.max(minVal, parseFloat(slider.value || '0') || 0));
        slider.style.setProperty('--attr-min', String(minVal));
        slider.style.setProperty('--attr-max', String(maxVal));
        slider.style.setProperty('--control-value', String(curVal));
        slider.setAttribute('aria-valuetext', this.formatAudioAriaTime(curVal, maxVal));
    }

    initBroadcastPlayer() {
        const audio = document.getElementById('broadcastAudioEl');
        const slider = document.getElementById('broadcastSeekSlider');
        const toolbar = document.getElementById('broadcastAuxToolbar');

        // Roving-tabindex fallback for role="toolbar" only when native focusgroup is unsupported
        if (toolbar && typeof HTMLElement !== 'undefined' && !('focusGroup' in HTMLElement.prototype)) {
            const getItems = () => Array.from(toolbar.querySelectorAll('button, a[href]'));
            const initItems = getItems();
            initItems.forEach((el, i) => {
                el.tabIndex = i === 0 ? 0 : -1;
            });
            toolbar.addEventListener('focusin', ({ target }) => {
                const items = getItems();
                if (items.includes(target)) {
                    items.forEach((el) => {
                        el.tabIndex = el === target ? 0 : -1;
                    });
                }
            });
            toolbar.addEventListener('keydown', (e) => {
                const rtl = getComputedStyle(toolbar).direction === 'rtl';
                const steps = {
                    ArrowRight: rtl ? -1 : 1,
                    ArrowLeft: rtl ? 1 : -1
                };
                const items = getItems();
                if (items.length === 0) return;
                const curIdx = Math.max(0, items.indexOf(document.activeElement));
                let nextIdx = -1;
                if (e.key in steps) {
                    nextIdx = (curIdx + steps[e.key] + items.length) % items.length;
                } else if (e.key === 'Home') {
                    nextIdx = 0;
                } else if (e.key === 'End') {
                    nextIdx = items.length - 1;
                }
                if (nextIdx >= 0) {
                    e.preventDefault();
                    items[nextIdx].focus();
                }
            });
        }

        if (slider) {
            this.syncBroadcastSliderVars();
            slider.addEventListener('input', () => {
                this.isScrubbingAudio = true;
                const curEl = document.getElementById('broadcastCurrentTime');
                if (curEl) curEl.textContent = this.formatAudioClock(slider.value);
                this.syncBroadcastSliderVars();
            });
            slider.addEventListener('change', () => {
                if (audio) {
                    const targetTime = parseFloat(slider.value || '0') || 0;
                    if (audio.readyState >= 1) {
                        audio.currentTime = targetTime;
                    } else {
                        this.pendingChapterStartSec = targetTime;
                    }
                }
                this.isScrubbingAudio = false;
                this.syncBroadcastSliderVars();
            });
        }

        if (!audio) return;
        audio.playbackRate = this.playbackSpeed;
        this.updateBroadcastSpeedUi();

        audio.addEventListener('loadedmetadata', () => {
            const dur = Number.isFinite(audio.duration) && audio.duration > 0
                ? audio.duration
                : (this.getActiveAudioTrackMeta()?.durationSec || 0);
            if (slider && dur > 0) {
                slider.max = String(dur);
            }
            const totEl = document.getElementById('broadcastTotalTime');
            if (totEl && dur > 0) {
                totEl.textContent = this.formatAudioClock(dur);
            }
            audio.playbackRate = this.playbackSpeed;
            if (this.pendingChapterStartSec !== null) {
                const jumpTo = this.pendingChapterStartSec;
                this.pendingChapterStartSec = null;
                audio.currentTime = Math.max(0, Math.min(dur || jumpTo, jumpTo));
            }
            this.syncBroadcastSliderVars();
        });

        audio.addEventListener('timeupdate', () => {
            if (this.isScrubbingAudio) return;
            const cur = audio.currentTime || 0;
            const dur = (Number.isFinite(audio.duration) && audio.duration > 0)
                ? audio.duration
                : (this.getActiveAudioTrackMeta()?.durationSec || 100);
            if (slider) {
                slider.max = String(dur);
                slider.value = String(cur);
                this.syncBroadcastSliderVars();
            }
            const curEl = document.getElementById('broadcastCurrentTime');
            if (curEl) curEl.textContent = this.formatAudioClock(cur);
            this.syncActiveChapterUi(cur);
        });

        audio.addEventListener('play', () => {
            this.syncPlayStateUi(true);
            this.updateMediaSessionMetadata();
        });

        audio.addEventListener('pause', () => {
            this.syncPlayStateUi(false);
        });

        audio.addEventListener('ended', () => {
            this.syncPlayStateUi(false);
            const curEl = document.getElementById('broadcastCurrentTime');
            if (curEl) curEl.textContent = '00:00';
            if (slider) {
                slider.value = '0';
                this.syncBroadcastSliderVars();
            }
            this.syncActiveChapterUi(0);
        });

        audio.addEventListener('volumechange', () => {
            const muteBtn = document.getElementById('btnBroadcastMute');
            const muteIcon = document.getElementById('iconBroadcastMute');
            const isMuted = Boolean(audio.muted || audio.volume === 0);
            if (muteBtn) muteBtn.setAttribute('aria-pressed', isMuted ? 'true' : 'false');
            if (muteIcon) muteIcon.className = isMuted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
        });

        if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
            try {
                navigator.mediaSession.setActionHandler('play', () => this.toggleBroadcastPlay(true));
                navigator.mediaSession.setActionHandler('pause', () => this.toggleBroadcastPlay(false));
                navigator.mediaSession.setActionHandler('seekbackward', (d) => this.seekBroadcastRelative(-(d?.seekOffset || 15)));
                navigator.mediaSession.setActionHandler('seekforward', (d) => this.seekBroadcastRelative(d?.seekOffset || 15));
                navigator.mediaSession.setActionHandler('seekto', (d) => {
                    if (typeof d?.seekTime === 'number' && audio) {
                        audio.currentTime = Math.max(0, d.seekTime);
                    }
                });
            } catch (_) {}
        }
    }

    getActiveAudioTrackMeta() {
        const tracks = this.audioBroadcast?.tracks || {};
        if (tracks[this.activeAudioTrack]) return tracks[this.activeAudioTrack];
        if (tracks.news) {
            this.activeAudioTrack = 'news';
            return tracks.news;
        }
        if (tracks.pulse) {
            this.activeAudioTrack = 'pulse';
            return tracks.pulse;
        }
        return null;
    }

    async fetchLatestAudio() {
        try {
            const res = await fetch('/api/audio');
            const data = await res.json();
            if (data && data.success && data.audioBroadcast) {
                this.audioBroadcast = data.audioBroadcast;
                this.renderBroadcastPlayer({ preservePlayback: true });
                this.renderSocialPulse();
            }
        } catch (_) {}
    }

    syncPlayStateUi(isPlaying) {
        const deck = document.getElementById('broadcastPlayerDeck');
        const btn = document.getElementById('btnBroadcastPlay');
        const icon = document.getElementById('iconBroadcastPlay');
        if (deck) deck.classList.toggle('is-playing', Boolean(isPlaying));
        if (btn) btn.setAttribute('aria-label', isPlaying ? '暂停语音播报' : '播放本期语音播报');
        if (icon) icon.className = isPlaying ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        if (!isPlaying) {
            const speakerEl = document.getElementById('broadcastActiveSpeaker');
            if (speakerEl) speakerEl.textContent = '林远 & Serena · 双主播交替播报';
        }
    }

    syncActiveChapterUi(currentSec) {
        const track = this.getActiveAudioTrackMeta();
        const chapters = Array.isArray(track?.chapters) ? track.chapters : [];
        if (chapters.length === 0) return;

        let activeIdx = 0;
        for (let i = 0; i < chapters.length; i++) {
            if (currentSec + 0.15 >= (Number(chapters[i].startSec) || 0)) {
                activeIdx = i;
            }
        }

        const chips = document.querySelectorAll('#broadcastChaptersBar .broadcast-chapter-chip');
        chips.forEach((chip, idx) => {
            if (idx === activeIdx) {
                chip.setAttribute('aria-current', 'step');
            } else {
                chip.removeAttribute('aria-current');
            }
        });

        const audio = document.getElementById('broadcastAudioEl');
        const speakerEl = document.getElementById('broadcastActiveSpeaker');
        const activeCh = chapters[activeIdx];
        if (speakerEl && activeCh && audio && !audio.paused) {
            speakerEl.textContent = `正在播报 · ${activeCh.speakerLabel || activeCh.speaker} · ${activeCh.title}`;
        }
    }

    renderBroadcastPlayer(opts = {}) {
        const deck = document.getElementById('broadcastPlayerDeck');
        const summaryQuickBtn = document.getElementById('btnSummaryListenQuick');
        const tracks = this.audioBroadcast?.tracks || {};
        const trackMeta = this.getActiveAudioTrackMeta();

        if (summaryQuickBtn) {
            summaryQuickBtn.classList.toggle('hidden', !tracks.news);
        }

        if (!deck) return;
        if (!trackMeta) {
            deck.classList.add('hidden');
            return;
        }
        deck.classList.remove('hidden');

        ['news', 'pulse'].forEach((tk) => {
            const pill = document.getElementById(`btnTrack-${tk}`);
            const durSpan = document.getElementById(`trackDur-${tk}`);
            const meta = tracks[tk] || null;
            if (!pill) return;
            pill.classList.toggle('hidden', !meta);
            if (meta) {
                pill.removeAttribute('aria-disabled');
                pill.setAttribute('aria-pressed', this.activeAudioTrack === tk ? 'true' : 'false');
                if (durSpan) durSpan.textContent = this.formatAudioClock(meta.durationSec);
            } else {
                pill.setAttribute('aria-disabled', 'true');
                pill.setAttribute('aria-pressed', 'false');
            }
        });

        const titleEl = document.getElementById('broadcastTitle');
        const subEl = document.getElementById('broadcastSubtitle');
        const totEl = document.getElementById('broadcastTotalTime');
        const dlLink = document.getElementById('linkBroadcastDownload');
        const audio = document.getElementById('broadcastAudioEl');
        const slider = document.getElementById('broadcastSeekSlider');

        if (titleEl) titleEl.textContent = trackMeta.title || '聚核双主播语音播报';
        if (subEl) subEl.textContent = trackMeta.subtitle || '';
        if (totEl) totEl.textContent = this.formatAudioClock(trackMeta.durationSec);
        if (dlLink) {
            dlLink.href = this.safeAssetUrl(trackMeta.audioUrl, '#');
            dlLink.setAttribute('download', trackMeta.fileName || `briefing-${trackMeta.track}.mp3`);
        }

        if (audio) {
            const currentAttrSrc = audio.getAttribute('src') || '';
            const nextSrc = trackMeta.audioUrl || '';
            const isSameSrc = currentAttrSrc === nextSrc;
            if (!isSameSrc && (!opts.preservePlayback || audio.paused)) {
                audio.setAttribute('src', nextSrc);
                audio.load();
                const curEl = document.getElementById('broadcastCurrentTime');
                if (curEl) curEl.textContent = '00:00';
                if (slider) {
                    slider.max = String(trackMeta.durationSec || 100);
                    slider.value = '0';
                    this.syncBroadcastSliderVars();
                }
                this.syncPlayStateUi(false);
            } else if (slider && audio.paused && !isSameSrc) {
                slider.max = String(trackMeta.durationSec || 100);
                this.syncBroadcastSliderVars();
            } else if (slider && (!audio.duration || isNaN(audio.duration))) {
                slider.max = String(trackMeta.durationSec || 100);
                this.syncBroadcastSliderVars();
            }
        }

        const chapters = Array.isArray(trackMeta.chapters) ? trackMeta.chapters : [];
        const chaptersBar = document.getElementById('broadcastChaptersBar');
        if (chaptersBar) {
            if (chapters.length === 0) {
                chaptersBar.classList.add('hidden');
                chaptersBar.innerHTML = '';
            } else {
                chaptersBar.classList.remove('hidden');
                chaptersBar.innerHTML = chapters.map((ch, idx) => {
                    const num = String(ch.index || (idx + 1)).padStart(2, '0');
                    const hostShort = ch.speaker === 'Lin_Yuan' ? '林远' : (ch.speaker === 'Uncle_Fu' ? '傅老师' : 'Serena');
                    return `
                        <button type="button"
                                data-chapter-idx="${idx}"
                                onclick="app.seekBroadcastToChapter(${idx})"
                                class="broadcast-chapter-chip"
                                ${idx === 0 ? 'aria-current="step"' : ''}>
                            <span class="broadcast-chapter-num tabular-nums">${this.escapeHtml(num)}</span>
                            <span>${this.escapeHtml(ch.title || '')}</span>
                            <span class="broadcast-chapter-host">${this.escapeHtml(hostShort)}</span>
                            <span class="broadcast-chapter-time tabular-nums">${this.formatAudioClock(ch.startSec)}</span>
                        </button>
                    `;
                }).join('');
            }
        }

        const transcriptBody = document.getElementById('broadcastTranscriptBody');
        if (transcriptBody) {
            transcriptBody.innerHTML = chapters.map((ch, idx) => `
                <div class="broadcast-script-turn">
                    <div class="broadcast-script-head">
                        <button type="button" onclick="app.seekBroadcastToChapter(${idx})" class="broadcast-script-seek tabular-nums">
                            ${this.formatAudioClock(ch.startSec)}
                        </button>
                        <strong class="broadcast-script-speaker">${this.escapeHtml(ch.speakerLabel || ch.speaker || '')}</strong>
                        <span class="broadcast-script-ch-title">${this.escapeHtml(ch.title || '')}</span>
                    </div>
                    <p class="broadcast-script-text">${this.escapeHtml(ch.text || '')}</p>
                </div>
            `).join('');
        }
    }

    selectBroadcastTrack(trackKey, autoPlay = false) {
        const pill = document.getElementById(`btnTrack-${trackKey}`);
        if (pill && pill.getAttribute('aria-disabled') === 'true') {
            return;
        }
        const tracks = this.audioBroadcast?.tracks || {};
        if (!tracks[trackKey]) return;

        const audio = document.getElementById('broadcastAudioEl');
        const wasPlaying = Boolean(audio && !audio.paused);
        if (this.activeAudioTrack !== trackKey) {
            if (audio) audio.pause();
            this.activeAudioTrack = trackKey;
            this.renderBroadcastPlayer({ preservePlayback: false });
        }
        if (autoPlay || wasPlaying) {
            this.toggleBroadcastPlay(true);
        }
    }

    playBroadcastTrack(trackKey, chapterIndex = 0) {
        const tracks = this.audioBroadcast?.tracks || {};
        if (!tracks[trackKey]) {
            this.toast('当前频道播音尚未同步', 'warning');
            return;
        }
        if (this.activeAudioTrack !== trackKey) {
            const audio = document.getElementById('broadcastAudioEl');
            if (audio) audio.pause();
            this.activeAudioTrack = trackKey;
            this.renderBroadcastPlayer({ preservePlayback: false });
        }
        const deck = document.getElementById('broadcastPlayerDeck');
        if (deck && typeof deck.scrollIntoView === 'function') {
            deck.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        this.seekBroadcastToChapter(chapterIndex, true);
    }

    async toggleBroadcastPlay(forceState = null) {
        const audio = document.getElementById('broadcastAudioEl');
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!audio || !trackMeta) return;

        const shouldPlay = forceState !== null ? Boolean(forceState) : audio.paused;
        if (!shouldPlay) {
            audio.pause();
            return;
        }

        if (!audio.getAttribute('src') && trackMeta.audioUrl) {
            audio.setAttribute('src', trackMeta.audioUrl);
            audio.load();
        }
        audio.playbackRate = this.playbackSpeed;
        try {
            await audio.play();
        } catch (err) {
            this.toast(`音频播放未能启动: ${err.message || '请检查网络连接'}`, 'error');
        }
    }

    seekBroadcastRelative(deltaSec) {
        const audio = document.getElementById('broadcastAudioEl');
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!audio || !trackMeta) return;
        const maxDur = (Number.isFinite(audio.duration) && audio.duration > 0)
            ? audio.duration
            : (trackMeta.durationSec || 0);
        const nextTime = Math.max(0, Math.min(maxDur || Infinity, (audio.currentTime || 0) + Number(deltaSec || 0)));
        if (audio.readyState >= 1) {
            audio.currentTime = nextTime;
        } else {
            this.pendingChapterStartSec = nextTime;
        }
        const slider = document.getElementById('broadcastSeekSlider');
        if (slider) {
            slider.value = String(nextTime);
            this.syncBroadcastSliderVars();
        }
        const curEl = document.getElementById('broadcastCurrentTime');
        if (curEl) curEl.textContent = this.formatAudioClock(nextTime);
    }

    seekBroadcastToChapter(chapterIdx, autoPlay = true) {
        const trackMeta = this.getActiveAudioTrackMeta();
        const audio = document.getElementById('broadcastAudioEl');
        const chapters = Array.isArray(trackMeta?.chapters) ? trackMeta.chapters : [];
        const ch = chapters[chapterIdx];
        if (!audio || !trackMeta) return;

        const targetSec = ch ? Math.max(0, Number(ch.startSec) || 0) : 0;
        if (audio.readyState >= 1) {
            audio.currentTime = targetSec;
        } else {
            this.pendingChapterStartSec = targetSec;
        }
        const slider = document.getElementById('broadcastSeekSlider');
        if (slider) {
            slider.value = String(targetSec);
            this.syncBroadcastSliderVars();
        }
        const curEl = document.getElementById('broadcastCurrentTime');
        if (curEl) curEl.textContent = this.formatAudioClock(targetSec);
        this.syncActiveChapterUi(targetSec);

        if (autoPlay) {
            this.toggleBroadcastPlay(true);
        }
    }

    updateBroadcastSpeedUi() {
        const btn = document.getElementById('btnBroadcastSpeed');
        if (!btn) return;
        const label = Number.isInteger(this.playbackSpeed) ? `${this.playbackSpeed.toFixed(1)}×` : `${this.playbackSpeed}×`;
        btn.textContent = label;
        btn.setAttribute('aria-label', `切换播放倍速，当前 ${this.playbackSpeed} 倍速`);
    }

    cycleBroadcastSpeed() {
        const idx = this.playbackSpeeds.indexOf(this.playbackSpeed);
        const nextSpeed = this.playbackSpeeds[(idx + 1) % this.playbackSpeeds.length];
        this.playbackSpeed = nextSpeed;
        try {
            localStorage.setItem('corefeed_audio_speed', String(nextSpeed));
        } catch (_) {}

        const audio = document.getElementById('broadcastAudioEl');
        if (audio) {
            audio.playbackRate = nextSpeed;
        }
        this.updateBroadcastSpeedUi();
        const live = document.getElementById('broadcastLiveStatus');
        if (live) {
            live.textContent = `播放倍速已切换为 ${nextSpeed} 倍速`;
        }
    }

    toggleBroadcastMute() {
        const audio = document.getElementById('broadcastAudioEl');
        if (!audio) return;
        audio.muted = !audio.muted;
    }

    updateMediaSessionMetadata() {
        if (typeof navigator === 'undefined' || !('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
            return;
        }
        const trackMeta = this.getActiveAudioTrackMeta();
        if (!trackMeta) return;
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: trackMeta.title || '聚核双主播播报',
                artist: '林远 & Serena · CoreFeed 聚核电台',
                album: trackMeta.label || 'CoreFeed 全球要闻深度聚合',
                artwork: [
                    { src: '/images/logo.png', sizes: '192x192', type: 'image/png' }
                ]
            });
        } catch (_) {}
    }

    // ==================== 7. 极简系统设置弹窗 ====================

    async openSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        modal.classList.remove('hidden');

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
        document.getElementById('settingsModal')?.classList.add('hidden');
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
                headers: { 'Content-Type': 'application/json' },
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

window.addEventListener('DOMContentLoaded', () => {
    window.app = new CoreFeedApp();
});
