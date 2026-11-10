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
        this.collectionPhase = 'idle';
        this.isSyncingGithub = false;

        this.selectedRegion = '全部';
        this.selectedCategory = '全部';
        this.activeTab = 'feed';
        this.socket = null;
        this.fullTextClientCache = new Map();
        this.activeFullTextRequestId = 0;

        this.initTheme();
        this.initKeyboardShortcuts();
        this.initSocket();
        this.renderFilters();
        this.renderNewsGrid();
        this.renderStatusBar();
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

        this.socket.on('schedule-updated', (payload) => {
            if (payload) {
                this.schedule = { ...(this.schedule || {}), ...payload };
                this.renderStatusBar();
            }
        });

        this.socket.on('news-update-completed', () => {
            this.fetchLatestNews();
            this.fetchLatestSummary();
            this.fetchStatus();
        });
    }

    // ==================== 3. 选项卡与多维筛选 ====================
    switchTab(tabName) {
        const normalized = tabName === 'news' ? 'feed' : tabName;
        this.activeTab = normalized;
        const tabs = ['feed', 'summary'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tabBtn-${t}`);
            const panel = document.getElementById(`tabPanel-${t}`);
            if (btn) {
                btn.classList.toggle('active', t === normalized);
            }
            if (panel) {
                panel.classList.toggle('hidden', t !== normalized);
            }
        });

        const searchWrapper = document.getElementById('feedSearchWrapper');
        if (searchWrapper) {
            searchWrapper.classList.toggle('hidden', normalized !== 'feed');
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
                return `<button type="button" onclick="app.setRegionFilter('${this.escapeHtml(r)}')" class="btn-chip ${active ? 'active' : ''}"><span>${this.escapeHtml(r)}</span><span class="chip-count">(${regionCounts[r]})</span></button>`;
            }).join('');

        const categories = Object.keys(categoryCounts);
        categoryBar.innerHTML = `<span class="filter-row-label">领域</span>` +
            categories.map(c => {
                const active = this.selectedCategory === c;
                return `<button type="button" onclick="app.setCategoryFilter('${this.escapeHtml(c)}')" class="btn-chip ${active ? 'active' : ''}"><span>${this.escapeHtml(c)}</span><span class="chip-count">(${categoryCounts[c]})</span></button>`;
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
        const imageUrl = item.urlToImage || '';

        const relatedSources = Array.isArray(item.relatedSources) ? item.relatedSources : [];
        const hasMultiSources = relatedSources.length > 0;
        const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];
        const isCompiling = (this.collectionPhase === 'collected' || this.collectionPhase === 'compiling') && !item.aiCompiled;

        const relatedLinksHtml = relatedSources.map(r => {
            if (r.url) {
                return `<a href="${this.escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline font-medium" title="${this.escapeHtml(r.title || r.name)}">${this.escapeHtml(r.name)}</a>`;
            }
            return `<span>${this.escapeHtml(r.name)}</span>`;
        }).join('、');

        const metaBadgeText = category && category !== region ? `${region} · ${category}` : region;
        const isRemoteHttp = /^https?:\/\//i.test(imageUrl);
        const displayImgSrc = isRemoteHttp ? `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;
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
                         onclick="app.handleCardBodyClick(event, '${encodeURIComponent(item.url || '')}')"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.handleCardBodyClick(event, '${encodeURIComponent(item.url || '')}');}">
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
                    <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"
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
        const imageUrl = item.urlToImage || '';

        const relatedSources = Array.isArray(item.relatedSources) ? item.relatedSources : [];
        const hasMultiSources = relatedSources.length > 0;
        const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];
        const isCompiling = (this.collectionPhase === 'collected' || this.collectionPhase === 'compiling') && !item.aiCompiled;

        const relatedLinksHtml = relatedSources.map(r => {
            if (r.url) {
                return `<a href="${this.escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline font-medium" title="${this.escapeHtml(r.title || r.name)}">${this.escapeHtml(r.name)}</a>`;
            }
            return `<span>${this.escapeHtml(r.name)}</span>`;
        }).join('、');

        const metaBadgeText = category && category !== region ? `${region} · ${category}` : region;
        const isRemoteHttp = /^https?:\/\//i.test(imageUrl);
        const displayImgSrc = isRemoteHttp ? `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;

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
                         onclick="app.handleCardBodyClick(event, '${encodeURIComponent(item.url || '')}')"
                         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();app.handleCardBodyClick(event, '${encodeURIComponent(item.url || '')}');}">
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
                        <span class="card-translate-hint">全文翻译</span>
                    </div>
                    <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"
                        class="btn-source-link">
                        <span>原文</span>
                        <span aria-hidden="true">↗</span>
                    </a>
                </div>
            </article>
        `;
    }

    handleCardBodyClick(event, encodedUrl) {
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
        try {
            url = decodeURIComponent(encodedUrl || '');
        } catch (_) {
            url = encodedUrl || '';
        }
        if (!url) return;
        this.openFullTextModal(url);
    }

    async openFullTextModal(url) {
        const modal = document.getElementById('fullTextModal');
        if (!modal) return;

        this.pauseHeroCarousel();
        modal.classList.remove('hidden');

        const article = this.news.find(item => item.url === url) || null;
        const title = article ? (article.translatedTitle || article.title || '无标题') : '正在读取文章标题...';
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
            badgeEl.textContent = `${sourceName} · ${region}${category && category !== region ? ' / ' + category : ''}`;
        }
        if (linkEl) {
            linkEl.href = url || '#';
        }

        // 优先直接展示新闻抓取/编译阶段已预译并随 GitHub 快照 (ag-snapshot/latest.json) 同步下发的全文中文译文
        const pretranslatedParas = Array.isArray(article?.translatedParagraphs) && article.translatedParagraphs.length > 0
            ? article.translatedParagraphs
            : (article?.translatedContent
                ? String(article.translatedContent).split(/\n+/).map(p => p.trim()).filter(Boolean)
                : null);

        if (pretranslatedParas && pretranslatedParas.length > 0) {
            const origParas = Array.isArray(article?.originalParagraphs) && article.originalParagraphs.length > 0
                ? article.originalParagraphs
                : (article?.fullText || article?.content
                    ? String(article.fullText || article.content).split(/\n+/).map(p => p.trim()).filter(p => p.length >= 10)
                    : []);
            if (bodyEl) bodyEl.scrollTop = 0;
            this.renderFullTextModalContent(
                {
                    summary,
                    keyPoints,
                    translatedParagraphs: pretranslatedParas,
                    originalParagraphs: origParas
                },
                { summary, keyPoints }
            );
            if (statusEl) {
                statusEl.textContent = `全文共 ${pretranslatedParas.length} 段 · 已于采编阶段完成全文精译并随 GitHub 快照同步`;
            }
            return;
        }

        if (this.fullTextClientCache.has(url)) {
            const cachedData = this.fullTextClientCache.get(url);
            this.renderFullTextModalContent(cachedData, { summary, keyPoints });
            if (statusEl) {
                statusEl.textContent = `全文共 ${cachedData.paragraphCount || (cachedData.translatedParagraphs || []).length} 段 · 已完成外媒全文中文精译`;
            }
            return;
        }

        const reqId = ++this.activeFullTextRequestId;
        if (statusEl) {
            statusEl.textContent = '正在实时抓取外媒原文并逐段翻译为中文...';
        }

        if (bodyEl) {
            bodyEl.scrollTop = 0;
            bodyEl.innerHTML = `
                ${(summary || keyPoints.length > 0) ? `
                    <div class="fulltext-lead-box">
                        <div class="fulltext-section-label">核心导读摘要</div>
                        ${summary ? `<p class="fulltext-lead-summary">${this.escapeHtml(summary)}</p>` : ''}
                        ${keyPoints.length > 0 ? `
                            <ul class="card-keypoints" style="margin-top: 10px;">
                                ${keyPoints.map(kp => `<li class="card-keypoint-item">${this.escapeHtml(kp)}</li>`).join('')}
                            </ul>
                        ` : ''}
                    </div>
                ` : ''}
                <div class="fulltext-loading-state">
                    <i class="fa-solid fa-spinner fa-spin" style="color: var(--accent);"></i>
                    <span>正在连接外媒信源提取正文并翻译全文段落，请稍候...</span>
                </div>
            `;
        }

        try {
            const res = await fetch('/api/news/translate-fulltext', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Requested-With': 'CoreFeed-WebUI'
                },
                body: JSON.stringify({
                    url,
                    title: article?.title || '',
                    translatedTitle: article?.translatedTitle || '',
                    sourceName,
                    existingSummary: summary
                })
            });
            const data = await res.json();
            if (reqId !== this.activeFullTextRequestId) return;

            if (!res.ok || !data.success) {
                throw new Error(data.message || '抓取或翻译外媒全文失败');
            }

            this.fullTextClientCache.set(url, data);
            this.renderFullTextModalContent(data, { summary, keyPoints });
            if (statusEl) {
                const pCount = data.paragraphCount || (data.translatedParagraphs || []).length;
                statusEl.textContent = data.fallbackUsed
                    ? '外媒正文受阅读墙限制 · 已展示完整精编中文译文'
                    : `全文共 ${pCount} 段 · 已完成外媒全文中文精译`;
            }
        } catch (err) {
            if (reqId !== this.activeFullTextRequestId) return;
            if (statusEl) {
                statusEl.textContent = '外媒全文抓取受限 · 已展示本地完整中文精编导读';
            }
            if (bodyEl) {
                bodyEl.innerHTML = `
                    ${(summary || keyPoints.length > 0) ? `
                        <div class="fulltext-lead-box">
                            <div class="fulltext-section-label">中文精编导读</div>
                            ${summary ? `<p class="fulltext-lead-summary">${this.escapeHtml(summary)}</p>` : ''}
                            ${keyPoints.length > 0 ? `
                                <ul class="card-keypoints" style="margin-top: 10px;">
                                    ${keyPoints.map(kp => `<li class="card-keypoint-item">${this.escapeHtml(kp)}</li>`).join('')}
                                </ul>
                            ` : ''}
                        </div>
                    ` : ''}
                    <div class="fulltext-notice-box">
                        <span>未能直接提取该外媒页面的完整长文（${this.escapeHtml(err.message)}），可点击右下角「查看外媒原文 ↗」直接访问原网站。</span>
                    </div>
                `;
            }
        }
    }

    renderFullTextModalContent(data, fallback = {}) {
        const bodyEl = document.getElementById('fullTextBody');
        if (!bodyEl) return;

        const summary = data.summary || fallback.summary || '';
        const keyPoints = Array.isArray(data.keyPoints) && data.keyPoints.length > 0
            ? data.keyPoints
            : (Array.isArray(fallback.keyPoints) ? fallback.keyPoints : []);
        const translatedParagraphs = Array.isArray(data.translatedParagraphs) ? data.translatedParagraphs : [];
        const originalParagraphs = Array.isArray(data.originalParagraphs) ? data.originalParagraphs : [];

        const leadHtml = (summary || keyPoints.length > 0) ? `
            <div class="fulltext-lead-box">
                <div class="fulltext-section-label">核心导读摘要</div>
                ${summary ? `<p class="fulltext-lead-summary">${this.escapeHtml(summary)}</p>` : ''}
                ${keyPoints.length > 0 ? `
                    <ul class="card-keypoints" style="margin-top: 10px;">
                        ${keyPoints.map(kp => `<li class="card-keypoint-item">${this.escapeHtml(kp)}</li>`).join('')}
                    </ul>
                ` : ''}
            </div>
        ` : '';

        const zhParagraphsHtml = translatedParagraphs.length > 0 ? `
            <div class="fulltext-zh-section summary-content">
                <div class="fulltext-section-label">原文全文中文译文</div>
                ${translatedParagraphs.map(p => `<p class="summary-paragraph">${this.escapeHtml(p)}</p>`).join('')}
            </div>
        ` : '';

        const origParagraphsHtml = originalParagraphs.length > 0 ? `
            <details class="fulltext-orig-details">
                <summary class="fulltext-orig-summary">展开查看外媒英文原文段落 (${originalParagraphs.length} 段)</summary>
                <div class="fulltext-orig-body">
                    ${originalParagraphs.map(p => `<p>${this.escapeHtml(p)}</p>`).join('')}
                </div>
            </details>
        ` : '';

        bodyEl.innerHTML = leadHtml + zhParagraphsHtml + origParagraphsHtml;
    }

    closeFullTextModal() {
        const modal = document.getElementById('fullTextModal');
        if (!modal || modal.classList.contains('hidden')) return;
        modal.classList.add('hidden');
        this.activeFullTextRequestId++;
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
            this.renderStatusBar();
            this.renderModalSyncStatus();
        } catch (_) {}
    }

    updateHeaderTimestamp(isoStr = this.lastUpdated) {
        if (isoStr) {
            this.lastUpdated = isoStr;
        }
        const updatedEl = document.getElementById('lastUpdatedText') || document.getElementById('lastUpdatedLabel') || document.getElementById('lastUpdateTime');
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
            bodyEl.innerHTML = article.htmlContent || '';
        }
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
