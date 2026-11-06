/**
 * 聚核 CoreFeed v2.0 · 全球知名信源实时聚合与深读前端控制器
 */
class CoreFeedApp {
    constructor() {
        const init = window.__INITIAL_STATE__ || {};
        this.news = Array.isArray(init.news) ? init.news : [];
        this.totalNews = init.totalNews || this.news.length;
        this.lastUpdated = init.lastUpdated || null;
        this.summaryArticle = init.summaryArticle || null;
        this.sourceMatrix = Array.isArray(init.sourceMatrix) ? init.sourceMatrix : [];
        this.customSourcesDraft = [];
        this.collectionPhase = 'idle';

        this.selectedRegion = '全部';
        this.selectedCategory = '全部';
        this.activeTab = 'feed';
        this.socket = null;

        this.initTheme();
        this.initSocket();
        this.renderFilters();
        this.renderNewsGrid();
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

        const dot = document.getElementById('socketStatusDot');

        this.socket.on('connect', () => {
            if (dot) dot.style.background = 'var(--brand)';
        });

        this.socket.on('disconnect', () => {
            if (dot) dot.style.background = 'var(--stone)';
        });

        this.socket.on('connected', (data) => {
            if (data.collectionPhase) {
                this.collectionPhase = data.collectionPhase;
            }
            if (Array.isArray(data.recentLogs)) {
                data.recentLogs.forEach(log => this.appendAgentLog(log));
            }
            if (data.isUpdating && data.progress) {
                this.updatePipelineUI(data.progress);
            }
        });

        this.socket.on('agent-event', (entry) => {
            this.appendAgentLog(entry);
        });

        this.socket.on('update-progress', (progress) => {
            this.updatePipelineUI(progress);
        });

        // 两阶段渐进式核心：当第一阶段去重完成或每批 AI 编译完成时，实时拉取最新快照刷新卡片
        this.socket.on('news-updated', (payload) => {
            if (payload && payload.phase) {
                this.collectionPhase = payload.phase;
            }
            this.fetchLatestNews();
        });

        this.socket.on('summary-completed', (payload) => {
            if (payload && payload.article) {
                this.summaryArticle = payload.article;
                this.renderSummaryArticle(payload.article);
            }
        });
    }

    appendAgentLog(entry) {
        const drawer = document.getElementById('agentLogDrawer');
        if (!drawer || !entry) return;
        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const line = document.createElement('div');
        line.innerHTML = `<span style="color: var(--stone);">[${time}]</span> <span style="color: var(--brand); font-weight: 500;">[${this.escapeHtml(entry.agent || 'Agent')}]</span> <span style="color: var(--dark-warm);">${this.escapeHtml(entry.message || '')}</span>`;
        drawer.appendChild(line);
        drawer.scrollTop = drawer.scrollHeight;
    }

    toggleAgentLogDrawer() {
        const drawer = document.getElementById('agentLogDrawer');
        if (drawer) drawer.classList.toggle('hidden');
    }

    updatePipelineUI(progress = {}) {
        const container = document.getElementById('liveProgressContainer');
        const bar = document.getElementById('liveProgressBar');
        const text = document.getElementById('liveProgressText');
        const pctLabel = document.getElementById('liveProgressPercent');

        const pct = Math.min(100, Math.max(0, Number(progress.percentage || 0)));
        const stage = String(progress.stage || '').toLowerCase();

        if (container && bar && text && pctLabel) {
            container.classList.remove('hidden');
            bar.style.width = `${pct}%`;
            text.textContent = progress.message || '正在执行采集与编译任务...';
            pctLabel.textContent = `${pct}%`;

            if (pct >= 100 || stage === 'completed') {
                setTimeout(() => {
                    container.classList.add('hidden');
                }, 3500);
            }
        }

        const nodes = {
            scout: document.getElementById('node-scout'),
            curate: document.getElementById('node-curate'),
            compile: document.getElementById('node-compile'),
            summary: document.getElementById('node-summary')
        };

        Object.values(nodes).forEach(el => {
            if (el) el.classList.remove('active', 'done');
        });

        if (stage.includes('scout')) {
            nodes.scout?.classList.add('active');
        } else if (stage.includes('curate')) {
            nodes.scout?.classList.add('done');
            nodes.curate?.classList.add('active');
        } else if (stage.includes('deep_read') || stage.includes('compile')) {
            nodes.scout?.classList.add('done');
            nodes.curate?.classList.add('done');
            nodes.compile?.classList.add('active');
        } else if (stage.includes('summary')) {
            nodes.scout?.classList.add('done');
            nodes.curate?.classList.add('done');
            nodes.compile?.classList.add('done');
            nodes.summary?.classList.add('active');
        } else if (stage === 'completed') {
            Object.values(nodes).forEach(el => el?.classList.add('done'));
        }
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
        let multiSourceCount = 0;

        this.news.forEach(item => {
            const r = item.region || '国际';
            const c = item.category || '国际';
            const s = item.source?.name || 'Global Media';
            regionCounts[r] = (regionCounts[r] || 0) + 1;
            categoryCounts[c] = (categoryCounts[c] || 0) + 1;
            sourceCounts[s] = (sourceCounts[s] || 0) + 1;
            if ((item.sourceCount || 1) > 1 || (Array.isArray(item.relatedSources) && item.relatedSources.length > 0)) {
                multiSourceCount++;
            }
        });

        const multiLabel = document.getElementById('multiSourceCountLabel');
        if (multiLabel) {
            multiLabel.textContent = multiSourceCount;
        }

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

        document.getElementById('displayedCountLabel').textContent = filtered.length;
        document.getElementById('totalPoolCountLabel').textContent = Math.max(this.totalNews, this.news.length);

        const loadMoreBtn = document.getElementById('loadMoreContainer');
        if (loadMoreBtn) {
            loadMoreBtn.classList.toggle('hidden', this.news.length >= this.totalNews);
        }

        if (filtered.length === 0) {
            grid.innerHTML = `
                <div class="col-span-full kami-card py-14 text-center space-y-3">
                    <div class="kami-tag mx-auto">暂无匹配新闻</div>
                    <h3 class="text-xl font-bold" style="color: var(--near-black);">当前筛选条件下暂无新闻条目</h3>
                    <p class="text-sm max-w-md mx-auto" style="color: var(--stone);">点击右上角「立即采集全球新闻」按钮，并发采集路透社、BBC、纽约时报、彭博社、南华早报等全球知名媒体。</p>
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

    // ==================== 5. 全球新闻采集、加载与全文深读 ====================

    /**
     * 触发两阶段渐进式全球知名信源巡检
     */
    async triggerAgentPatrol() {
        const btn = document.getElementById('btnRunPatrol');
        const icon = document.getElementById('patrolBtnIcon');
        const text = document.getElementById('patrolBtnText');
        const categoryFilter = document.getElementById('patrolCategorySelect')?.value || 'all';

        if (btn) btn.disabled = true;
        if (icon) icon.className = 'fa-solid fa-spinner fa-spin text-xs';
        if (text) text.textContent = '采集与编译中...';

        this.collectionPhase = 'collecting';
        this.toast('已启动两阶段渐进式采集：几秒内将先行展示最新外媒报道，随后后台自动执行全文深读与中文编译...', 'info');
        this.updatePipelineUI({ stage: 'scout', percentage: 5, message: '正在并发连接全球知名媒体矩阵...' });

        try {
            const res = await fetch('/api/agent/patrol', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    categoryFilter,
                    generateSummary: true
                })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.message || '采集请求失败');
            }

            this.collectionPhase = 'completed';
            this.news = data.news || [];
            this.totalNews = data.totalEnhancedCount || this.news.length;
            this.lastUpdated = data.lastUpdated;
            if (data.summaryArticle) {
                this.summaryArticle = data.summaryArticle;
                this.renderSummaryArticle(data.summaryArticle);
            }

            if (this.lastUpdated) {
                document.getElementById('lastUpdatedLabel').textContent = new Date(this.lastUpdated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
            }

            this.renderFilters();
            this.renderNewsGrid();
            this.toast(`全球新闻采集与编译全部完成！共展示 ${this.news.length} 条精选新闻（耗时 ${data.elapsedSeconds || ''}s）`, 'success');
        } catch (err) {
            this.collectionPhase = 'idle';
            this.toast(`采集提示: ${err.message}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
            if (icon) icon.className = 'fa-solid fa-satellite-dish text-xs';
            if (text) text.textContent = '立即采集全球新闻';
        }
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
                    document.getElementById('lastUpdatedLabel').textContent = new Date(data.lastUpdated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
                }
                this.renderFilters();
                this.renderNewsGrid();
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
            metaEl.textContent = `生成时间：${new Date(article.generatedAt || Date.now()).toLocaleString('zh-CN')} · 涵盖 ${(article.regions || []).join('、')} · 共 ${article.wordCount || 0} 字`;
        }
        if (bodyEl) {
            bodyEl.innerHTML = article.htmlContent || '';
        }
    }

    async generateSummary() {
        const btn = document.getElementById('btnGenSummary');
        if (btn) btn.disabled = true;
        this.toast('主编 Agent 正在统筹撰写《全球要闻深度综述》...', 'info');

        try {
            const res = await fetch('/api/generate-summary', { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '生成综述失败');
            this.summaryArticle = data.article;
            this.renderSummaryArticle(data.article);
            this.toast('《全球要闻深度综述》已生成！', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ==================== 7. 全球知名信源矩阵管理 ====================

    async openSourceMatrixModal() {
        const modal = document.getElementById('sourceMatrixModal');
        if (!modal) return;
        modal.classList.remove('hidden');

        try {
            const res = await fetch('/api/sources/matrix');
            const data = await res.json();
            if (data && data.success) {
                this.sourceMatrix = data.sources;
                this.customSourcesDraft = this.sourceMatrix.filter(s => s.isCustom);
                this.renderSourceMatrixList();
            }
        } catch (err) {
            this.toast('加载信源矩阵失败: ' + err.message, 'error');
        }
    }

    closeSourceMatrixModal() {
        document.getElementById('sourceMatrixModal')?.classList.add('hidden');
    }

    renderSourceMatrixList() {
        const container = document.getElementById('sourceMatrixList');
        if (!container) return;

        const categoryLabels = {
            wire: '国际顶级通讯社与全球门户',
            western: '欧美权威大报',
            asiapacific: '亚太与大中华区名媒',
            finance: '全球财经与商业',
            tech: '前沿科技媒体',
            custom: '自定义国际信源'
        };

        container.innerHTML = this.sourceMatrix.map((src) => {
            const badge = categoryLabels[src.category] || '国际信源';
            const stat = src.lastStat;
            const statHtml = stat
                ? `<span class="text-[11px]" style="color: ${stat.status === 'ok' ? 'var(--brand)' : 'var(--stone)'}; font-variant-numeric: tabular-nums;">上次采集：${stat.count} 条 (${stat.durationMs}ms)</span>`
                : `<span class="text-[11px]" style="color: var(--stone); font-variant-numeric: tabular-nums;">权威指数：${src.authority || 85}</span>`;

            return `
                <div class="p-3.5 rounded-lg flex items-start justify-between gap-3" style="background: var(--ivory); border: 1px solid var(--border);">
                    <label class="flex items-start gap-2.5 cursor-pointer flex-1 min-w-0">
                        <input type="checkbox" data-source-id="${this.escapeHtml(src.id)}" class="source-toggle mt-1 accent-[#1B365D]" ${src.enabled ? 'checked' : ''}>
                        <div class="min-w-0">
                            <div class="font-medium text-xs sm:text-sm truncate" style="color: var(--near-black);">${this.escapeHtml(src.name)}</div>
                            <div class="text-[11px] truncate" style="color: var(--stone);">${this.escapeHtml(badge)} · ${this.escapeHtml(src.domain || src.rssUrl || '')}</div>
                            <div class="text-[11px] mt-0.5 line-clamp-1" style="color: var(--olive);">${this.escapeHtml(src.description || '')}</div>
                            ${statHtml}
                        </div>
                    </label>
                    <div class="flex flex-col items-end gap-1">
                        <span class="text-[10px]" style="color: var(--stone);">单次条数</span>
                        <input type="number" min="1" max="20" value="${src.maxArticles || 5}" data-source-max="${this.escapeHtml(src.id)}"
                            class="kami-input w-14 px-2 py-1 text-xs text-center" style="font-variant-numeric: tabular-nums;">
                    </div>
                </div>
            `;
        }).join('');
    }

    toggleAllSources(enable) {
        document.querySelectorAll('.source-toggle').forEach(chk => {
            chk.checked = Boolean(enable);
        });
    }

    addCustomSource() {
        const name = (document.getElementById('newSourceName')?.value || '').trim();
        const domain = (document.getElementById('newSourceDomain')?.value || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const rssUrl = (document.getElementById('newSourceRss')?.value || '').trim();

        if (!name || (!domain && !rssUrl)) {
            this.toast('请填写媒体名称，以及域名或 RSS 地址', 'warning');
            return;
        }

        const newSrc = {
            id: `custom-${Date.now()}`,
            name,
            category: 'custom',
            region: '国际',
            authority: 85,
            enabled: true,
            maxArticles: 5,
            strategy: rssUrl ? 'rss' : 'gnews_proxy',
            domain: domain || (rssUrl ? new URL(rssUrl).hostname : ''),
            url: domain ? `https://${domain}` : rssUrl,
            rssUrl: rssUrl || `https://news.google.com/rss/search?q=site:${encodeURIComponent(domain)}+when:2d&hl=en-US&gl=US&ceid=US:en`,
            description: '用户自定义添加的国际媒体源',
            isCustom: true
        };

        this.sourceMatrix.push(newSrc);
        this.customSourcesDraft.push(newSrc);
        this.renderSourceMatrixList();
        this.toast(`已添加信源「${name}」，请点击右下角保存配置`, 'info');
    }

    async saveSourceMatrix() {
        const overrides = {};
        document.querySelectorAll('.source-toggle').forEach(chk => {
            const id = chk.getAttribute('data-source-id');
            const maxInput = document.querySelector(`[data-source-max="${id}"]`);
            overrides[id] = {
                enabled: chk.checked,
                maxArticles: maxInput ? parseInt(maxInput.value, 10) || 5 : 5
            };
        });

        const updatedCustoms = this.customSourcesDraft.map(c => ({
            ...c,
            enabled: overrides[c.id]?.enabled ?? c.enabled,
            maxArticles: overrides[c.id]?.maxArticles ?? c.maxArticles
        }));

        try {
            const res = await fetch('/api/sources/matrix', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    overrides,
                    customSources: updatedCustoms
                })
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '保存失败');

            document.getElementById('enabledSourcesCount').textContent = data.enabledCount;
            this.closeSourceMatrixModal();
            this.toast(`信源矩阵已保存（当前启用 ${data.enabledCount} 个全球信源）`, 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }

    // ==================== 8. 系统与 AI 设置弹窗 ====================

    async openSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        modal.classList.remove('hidden');

        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data && data.success && data.config) {
                const { ai, agent, schedule } = data.config;
                document.getElementById('cfgAiBaseUrl').value = ai?.baseUrl || '';
                document.getElementById('cfgAiModel').value = ai?.model || '';
                document.getElementById('cfgMaxCurated').value = agent?.maxCuratedArticles || 30;
                document.getElementById('cfgDeepReadCount').value = agent?.deepReadTopCount ?? 8;
                document.getElementById('cfgFreshnessHours').value = agent?.freshnessHours || 48;
                document.getElementById('cfgUpdateTimes').value = (schedule?.updateTimes || []).join(',');
            }
        } catch (_) {}
    }

    closeSettingsModal() {
        document.getElementById('settingsModal')?.classList.add('hidden');
    }

    async saveSettings() {
        const baseUrl = document.getElementById('cfgAiBaseUrl')?.value.trim();
        const model = document.getElementById('cfgAiModel')?.value.trim();
        const apiKey = document.getElementById('cfgAiApiKey')?.value.trim();
        const maxCurated = parseInt(document.getElementById('cfgMaxCurated')?.value, 10) || 30;
        const deepReadCount = parseInt(document.getElementById('cfgDeepReadCount')?.value, 10) || 8;
        const freshnessHours = parseInt(document.getElementById('cfgFreshnessHours')?.value, 10) || 48;
        const updateTimes = document.getElementById('cfgUpdateTimes')?.value.trim();

        const payload = {
            AI_BASE_URL: baseUrl,
            AI_MODEL: model,
            AGENT_MAX_CURATED_ARTICLES: maxCurated,
            AGENT_DEEP_READ_COUNT: deepReadCount,
            AGENT_FRESHNESS_HOURS: freshnessHours,
            UPDATE_TIMES: updateTimes
        };
        if (apiKey && !apiKey.startsWith('***')) {
            payload.AI_API_KEY = apiKey;
        }

        try {
            const res = await fetch('/api/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '保存失败');

            if (model) {
                const badge = document.getElementById('aiModelBadge');
                if (badge) badge.textContent = model;
            }
            this.closeSettingsModal();
            this.toast('系统与采集配置已保存并立即生效！', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new CoreFeedApp();
});
