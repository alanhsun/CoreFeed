/**
 * 聚核 CoreFeed v2.0 · 全球知名信源实时聚合与深读前端控制器
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
        this.sourceMatrix = Array.isArray(init.sourceMatrix) ? init.sourceMatrix : [];
        this.customSourcesDraft = [];
        this.collectionPhase = 'idle';
        this.isSyncingGithub = false;

        this.selectedRegion = '全部';
        this.selectedCategory = '全部';
        this.activeTab = 'feed';
        this.socket = null;

        this.initTheme();
        this.initSocket();
        this.renderFilters();
        this.renderNewsGrid();
        this.renderStatusBar();
        this.fetchStatus();

        // 每 60 秒轻量刷新一次顶栏状态与同步遥测
        this.statusPollTimer = setInterval(() => this.fetchStatus(), 60 * 1000);
    }

    // ==================== 1. 主题与通知 ====================
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

    toast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const icons = {
            info: 'fa-circle-info',
            success: 'fa-circle-check',
            warning: 'fa-triangle-exclamation',
            error: 'fa-circle-xmark'
        };

        const el = document.createElement('div');
        el.className = 'flex items-center gap-2.5 px-4 py-3 rounded-lg text-xs sm:text-sm transition-all';
        el.style.background = type === 'error' ? '#3d3d3a' : 'var(--brand)';
        el.style.color = '#faf9f5';
        el.style.border = '1px solid var(--line)';
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

        // GitHub 快照同步或发布更新完成：实时拉取最新快照与状态刷新卡片
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
        this.activeTab = tabName;
        const tabs = ['feed', 'summary'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tabBtn-${t}`);
            const panel = document.getElementById(`tabPanel-${t}`);
            if (btn) {
                btn.classList.toggle('active', t === tabName);
            }
            if (panel) {
                panel.classList.toggle('hidden', t !== tabName);
            }
        });

        const searchWrapper = document.getElementById('feedSearchWrapper');
        if (searchWrapper) {
            searchWrapper.classList.toggle('hidden', tabName !== 'feed');
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

        // 如果当前选中的筛选值在新数据中不存在，自动回退到“全部”
        if (this.selectedRegion !== '全部' && !regionCounts[this.selectedRegion]) {
            this.selectedRegion = '全部';
        }
        if (this.selectedCategory !== '全部' && !categoryCounts[this.selectedCategory]) {
            this.selectedCategory = '全部';
        }

        const regions = Object.keys(regionCounts);
        regionBar.innerHTML = `<span class="text-sm font-semibold mr-1" style="color: var(--stone);">地区：</span>` +
            regions.map(r => {
                const active = this.selectedRegion === r;
                return `<button onclick="app.setRegionFilter('${this.escapeHtml(r)}')" class="btn-chip ${active ? 'active' : ''}">${this.escapeHtml(r)} <span style="opacity: 0.8;">(${regionCounts[r]})</span></button>`;
            }).join('');

        const categories = Object.keys(categoryCounts);
        categoryBar.innerHTML = `<span class="text-sm font-semibold mr-1" style="color: var(--stone);">领域：</span>` +
            categories.map(c => {
                const active = this.selectedCategory === c;
                return `<button onclick="app.setCategoryFilter('${this.escapeHtml(c)}')" class="btn-chip ${active ? 'active' : ''}">${this.escapeHtml(c)} <span style="opacity: 0.8;">(${categoryCounts[c]})</span></button>`;
            }).join('');

        // 更新媒体来源下拉筛选框
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
        this.renderNewsGrid();
    }

    // ==================== 4. 渲染全球新闻卡片网格 ====================
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

        const displayedEl = document.getElementById('displayedCountLabel');
        if (displayedEl) displayedEl.textContent = filtered.length;
        const totalPoolEl = document.getElementById('totalPoolCountLabel');
        if (totalPoolEl) totalPoolEl.textContent = Math.max(this.totalNews, this.news.length);

        const loadMoreBtn = document.getElementById('loadMoreContainer');
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', this.news.length >= this.totalNews);
        }

        if (filtered.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full kami-card py-14 text-center space-y-3">
                    <div class="kami-tag mx-auto">暂无匹配新闻</div>
                    <h3 class="text-xl font-bold" style="color: var(--near-black);">当前筛选条件下暂无新闻条目</h3>
                    <p class="text-sm max-w-md mx-auto" style="color: var(--stone);">可尝试切换筛选条件，或点击右上角「同步最新」拉取最新一期全球权威媒体精编要闻。</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = filtered.map((item, idx) => this.renderSingleCardHtml(item, idx)).join('');
    }

    getCategoryIconClass(category) {
        const map = {
            '科技': 'fa-microchip',
            '财经': 'fa-chart-line',
            '军事': 'fa-shield-halved',
            '政经': 'fa-landmark',
            '外交': 'fa-handshake',
            '能源': 'fa-bolt',
            '社会': 'fa-users'
        };
        return map[category] || 'fa-earth-americas';
    }

    renderSingleCardHtml(item, idx) {
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

        const encodedUrl = encodeURIComponent(item.url || '');
        const encodedTitle = encodeURIComponent(title);
        const encodedSource = encodeURIComponent(sourceName);
        const encodedSummary = encodeURIComponent(summary);

        const relatedLinksHtml = relatedSources.map(r => {
            if (r.url) {
                return `<a href="${this.escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="hover:underline font-medium" title="${this.escapeHtml(r.title || r.name)}">${this.escapeHtml(r.name)}</a>`;
            }
            return `<span>${this.escapeHtml(r.name)}</span>`;
        }).join('、');

        const catIcon = this.getCategoryIconClass(category);
        const metaBadgeText = category && category !== region ? `${region} · ${category}` : region;
        const isRemoteHttp = /^https?:\/\//i.test(imageUrl);
        const displayImgSrc = isRemoteHttp ? `/api/image-proxy?url=${encodeURIComponent(imageUrl)}` : imageUrl;

        return `
            <article class="news-card">
                <div>
                    <!-- 顶部新闻标题图区域 (优先通过服务端防盗链代理加载 + 原图直连回退 + 智能分类视觉封面兜底) -->
                    <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"
                       class="card-cover block ${imageUrl ? '' : 'is-fallback'}" data-cat="${this.escapeHtml(category)}">
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
                            <i class="fa-solid ${catIcon} text-3xl mb-2 opacity-80"></i>
                            <div class="text-sm font-bold tracking-wide opacity-95">${this.escapeHtml(sourceName)}</div>
                            <div class="text-xs opacity-75 mt-0.5">${this.escapeHtml(metaBadgeText)}</div>
                        </div>
                        <div class="card-cover-badges">
                            <span class="cover-pill-source" title="${this.escapeHtml(sourceName)}">
                                ${this.escapeHtml(sourceName)}
                            </span>
                            <span class="cover-pill-meta">
                                ${this.escapeHtml(metaBadgeText)}
                            </span>
                        </div>
                    </a>

                    <!-- 卡片主体内容 -->
                    <div class="card-body">
                        <!-- 多信源交叉验证提示 -->
                        ${hasMultiSources ? `
                            <div class="kami-callout flex flex-col gap-0.5">
                                <div class="font-bold">🔥 ${relatedSources.length + 1} 家权威外媒交叉印证</div>
                                <div class="truncate text-xs" style="color: var(--olive);">同题报道：${relatedLinksHtml}</div>
                            </div>
                        ` : ''}

                        ${isCompiling ? `
                            <div>
                                <span class="kami-tag">⚡ 后台深度精编中...</span>
                            </div>
                        ` : ''}

                        <!-- 中文大号加粗主标题 + 外媒英文原标题对照 -->
                        <div>
                            <h3 class="card-title">
                                <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(title)}</a>
                            </h3>
                            ${originalTitle ? `<p class="card-subtitle-en line-clamp-1" title="${this.escapeHtml(originalTitle)}">${this.escapeHtml(originalTitle)}</p>` : ''}
                        </div>

                        <!-- 舒适大字号中文摘要 -->
                        <p class="card-summary line-clamp-4">
                            ${this.escapeHtml(summary)}
                        </p>

                        <!-- 核心要点标签 -->
                        ${keyPoints.length > 0 ? `
                            <div class="pt-1 flex flex-wrap gap-1.5">
                                ${keyPoints.map(kp => `<span class="kami-tag-neutral">• ${this.escapeHtml(kp)}</span>`).join('')}
                            </div>
                        ` : ''}
                    </div>
                </div>

                <!-- 卡片底部操作栏 -->
                <div class="card-footer">
                    <button onclick="app.openDeepRead('${encodedUrl}', '${encodedTitle}', '${encodedSource}', '${encodedSummary}')"
                        class="inline-flex items-center gap-1.5 font-semibold hover:underline cursor-pointer" style="color: var(--brand);">
                        <i class="fa-solid fa-book-open-reader text-xs"></i>
                        <span>全文深读</span>
                    </button>
                    <div class="flex items-center gap-3">
                        <span class="text-xs" style="color: var(--stone);">${this.escapeHtml(timeStr)}</span>
                        <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"
                            class="inline-flex items-center gap-1 font-medium hover:underline" style="color: var(--olive);">
                            <span>原文</span>
                            <span>↗</span>
                        </a>
                    </div>
                </div>
            </article>
        `;
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

    // ==================== 5. 全球新闻采集、GitHub 快照同步、加载与全文深读 ====================

    /**
     * 拉取后端实时状态 (/api/status) 并更新顶部状态栏、发布端标识与定时信息
     */
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

    /**
     * 更新报头最后更新时间（简明、克制格式，如 "更新于 12:30" 或 "更新于 11-08 12:30"）
     */
    updateHeaderTimestamp(isoStr = this.lastUpdated) {
        if (isoStr) {
            this.lastUpdated = isoStr;
        }
        const updatedEl = document.getElementById('lastUpdatedLabel') || document.getElementById('lastUpdateTime');
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

    /**
     * 更新「系统设置」弹窗内的简洁同步状态展示
     */
    renderModalSyncStatus() {
        const gh = this.githubSync || {};
        const statusEl = document.getElementById('modalSyncStatusText') || document.getElementById('cfgSyncStatusText');
        const syncedAtEl = document.getElementById('modalSyncLastTime') || document.getElementById('cfgLastSyncedAt');

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

    /**
     * 一键从 GitHub 快照分支 (ag-snapshot/latest.json) 同步最新一期新闻与综述
     */
    async syncFromGitHub(options = {}) {
        if (this.isSyncingGithub) return;
        this.isSyncingGithub = true;

        const headerBtn = document.getElementById('syncGithubBtn') || document.getElementById('btnSyncGithub');
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
                    force: options.force !== undefined ? Boolean(options.force) : false,
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

    /**
     * 打开单篇外媒报道的全文深读弹窗（即时呈现核心导读，并发拉取多段全文精译与深度解读）
     */
    async openDeepRead(encodedUrl, encodedTitle, encodedSource, encodedSummary) {
        const url = decodeURIComponent(encodedUrl || '');
        const title = decodeURIComponent(encodedTitle || '');
        const sourceName = decodeURIComponent(encodedSource || '');
        const existingSummary = decodeURIComponent(encodedSummary || '');

        const modal = document.getElementById('deepReadModal');
        const titleEl = document.getElementById('deepReadTitle');
        const sourceEl = document.getElementById('deepReadSourceBadge');
        const bodyEl = document.getElementById('deepReadBody');
        const linkEl = document.getElementById('deepReadOriginalLink');

        if (!modal || !bodyEl) return;

        modal.classList.remove('hidden');
        if (titleEl) titleEl.textContent = title;
        if (sourceEl) sourceEl.textContent = sourceName;
        if (linkEl) linkEl.href = url;

        const matchedItem = (this.news || []).find(item => item && (item.url === url || item.translatedTitle === title || item.title === title));
        const keyPoints = Array.isArray(matchedItem?.keyPoints) ? matchedItem.keyPoints : [];

        const instantLeadHtml = existingSummary ? `
            <div class="summary-content mb-5">
                <h3 class="summary-section-title">核心导读</h3>
                <p class="summary-paragraph">${this.escapeHtml(existingSummary)}</p>
                ${keyPoints.length > 0 ? `<ul class="summary-list">${keyPoints.map(kp => `<li>${this.escapeHtml(kp)}</li>`).join('')}</ul>` : ''}
            </div>
        ` : '';

        bodyEl.innerHTML = `
            ${instantLeadHtml}
            <div class="p-5 rounded-xl border flex items-center gap-3.5" style="background: var(--bg-subtle); border-color: var(--border-subtle);">
                <i class="fa-solid fa-spinner fa-spin text-lg" style="color: var(--brand);"></i>
                <div>
                    <div class="text-sm font-semibold" style="color: var(--text-primary);">正在实时提取 [${this.escapeHtml(sourceName)}] 报道全文并执行中文精译...</div>
                    <div class="text-xs mt-0.5" style="color: var(--text-muted);">正在抽取原文完整段落、关键引语与背景脉络（通常需 2–8 秒）</div>
                </div>
            </div>
        `;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 22000);

        try {
            const res = await fetch('/api/agent/deep-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, title, sourceName, existingSummary }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '全文深读请求失败');
            }

            bodyEl.innerHTML = `
                <div class="space-y-6">
                    <div class="summary-content">
                        ${data.analysisHtml || instantLeadHtml}
                    </div>
                    <details class="kami-code-block text-xs">
                        <summary class="cursor-pointer font-medium" style="color: var(--text-secondary);">查看抓取到的外媒原文摘录 (提取引擎: ${this.escapeHtml(data.extractionMethod || 'readability')})</summary>
                        <pre class="mt-3 whitespace-pre-wrap max-h-60 overflow-y-auto" style="font-family: var(--sans); color: var(--text-secondary);">${this.escapeHtml(data.fullText || '')}</pre>
                    </details>
                </div>
            `;
        } catch (err) {
            clearTimeout(timeoutId);
            const errMsg = err.name === 'AbortError' ? '外媒原站响应超时，已为您展示核心编译摘要' : err.message;
            bodyEl.innerHTML = `
                ${instantLeadHtml}
                <div class="p-4 rounded-lg text-xs" style="background: var(--bg-subtle); color: var(--text-secondary);">
                    提示：${this.escapeHtml(errMsg)}。您可以点击右下角“阅读外媒原文”直接访问原报道页面。
                </div>
            `;
        }
    }

    closeDeepReadModal() {
        document.getElementById('deepReadModal')?.classList.add('hidden');
    }

    // ==================== 6. 今日要闻深度综述 ====================

    renderSummaryArticle(article) {
        if (!article) return;
        const titleEl = document.getElementById('summaryTitle');
        const metaEl = document.getElementById('summaryMeta');
        const bodyEl = document.getElementById('summaryBody');

        if (titleEl) titleEl.textContent = article.title || '今日全球要闻深度综述';
        if (metaEl) {
            metaEl.textContent = `生成时间：${new Date(article.generatedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · 涵盖 ${(article.regions || []).join('、')} · 共 ${article.wordCount || 0} 字`;
        }
        if (bodyEl) {
            bodyEl.innerHTML = article.htmlContent || '';
        }
    }

    // ==================== 7. 极简系统设置弹窗 ====================

    openSettings() {
        return this.openSettingsModal();
    }

    closeSettings() {
        return this.closeSettingsModal();
    }

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
                const { agent = {}, schedule = {}, githubSync = {} } = cfg;

                const syncEnabled = cfg.GITHUB_SYNC_ENABLED ?? githubSync.enabled ?? agent.githubSyncEnabled ?? true;
                const syncInterval = cfg.GITHUB_SYNC_INTERVAL_MINUTES ?? githubSync.intervalMinutes ?? agent.githubSyncIntervalMinutes ?? 60;

                const syncEnabledEl = document.getElementById('cfgGithubSyncEnabled');
                if (syncEnabledEl) syncEnabledEl.checked = Boolean(syncEnabled);

                const syncIntervalEl = document.getElementById('cfgGithubSyncInterval');
                if (syncIntervalEl) syncIntervalEl.value = syncInterval;

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
        const syncEnabledEl = document.getElementById('cfgGithubSyncEnabled');
        const githubSyncEnabled = syncEnabledEl ? Boolean(syncEnabledEl.checked) : true;

        const githubSyncInterval = Math.max(
            1,
            parseInt(document.getElementById('cfgGithubSyncInterval')?.value, 10) || 60
        );

        const autoUpdateEl = document.getElementById('cfgAutoUpdateEnabled');
        const autoUpdateEnabled = autoUpdateEl ? Boolean(autoUpdateEl.checked) : true;

        const rawUpdateTimes = (document.getElementById('cfgUpdateTimes')?.value || '08:00, 12:30, 19:30').trim();
        const updateTimes = rawUpdateTimes
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .join(',') || '08:00,12:30,19:30';

        const payload = {
            GITHUB_SYNC_ENABLED: githubSyncEnabled,
            GITHUB_SYNC_INTERVAL_MINUTES: githubSyncInterval,
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
