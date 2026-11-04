/**
 * 聚核 CoreFeed v2.0 · 全球知名信源 Agent 情报中心前端控制器
 */
class CoreFeedApp {
    constructor() {
        const init = window.__INITIAL_STATE__ || {};
        this.news = Array.isArray(init.news) ? init.news : [];
        this.totalNews = init.totalNews || this.news.length;
        this.lastUpdated = init.lastUpdated || null;
        this.summaryArticle = init.summaryArticle || null;
        this.podcastInfo = init.podcastInfo || null;
        this.sourceMatrix = Array.isArray(init.sourceMatrix) ? init.sourceMatrix : [];
        this.customSourcesDraft = [];

        this.selectedRegion = '全部';
        this.selectedCategory = '全部';
        this.activeTab = 'feed';
        this.socket = null;

        this.initTheme();
        this.initSocket();
        this.renderFilters();
        this.renderNewsGrid();
        this.loadLatestResearchIfAny();
    }

    // ==================== 1. 主题与通知 ====================
    initTheme() {
        const saved = localStorage.getItem('corefeed_theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (saved === 'dark' || (!saved && prefersDark)) {
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
        icon.className = isDark ? 'fa-solid fa-sun text-amber-400' : 'fa-solid fa-moon text-slate-600';
    }

    toast(message, type = 'info') {
        const container = document.getElementById('toastContainer');
        if (!container) return;

        const colors = {
            info: 'bg-blue-600 text-white',
            success: 'bg-emerald-600 text-white',
            warning: 'bg-amber-500 text-white',
            error: 'bg-rose-600 text-white'
        };
        const icons = {
            info: 'fa-circle-info',
            success: 'fa-circle-check',
            warning: 'fa-triangle-exclamation',
            error: 'fa-circle-xmark'
        };

        const el = document.createElement('div');
        el.className = `flex items-center gap-2.5 px-4 py-3 rounded-xl shadow-lg text-xs sm:text-sm font-medium transition-all ${colors[type] || colors.info}`;
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

    // ==================== 2. WebSocket 实时遥测 ====================
    initSocket() {
        if (typeof io === 'undefined') return;
        this.socket = io();

        const dot = document.getElementById('socketStatusDot');

        this.socket.on('connect', () => {
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-emerald-500 animate-pulse';
        });

        this.socket.on('disconnect', () => {
            if (dot) dot.className = 'w-2 h-2 rounded-full bg-rose-500';
        });

        this.socket.on('connected', (data) => {
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

        this.socket.on('news-updated', () => {
            this.fetchLatestNews();
        });

        this.socket.on('summary-completed', (payload) => {
            if (payload && payload.article) {
                this.summaryArticle = payload.article;
                this.renderSummaryArticle(payload.article);
            }
        });

        this.socket.on('podcast-completed', (payload) => {
            const info = payload.podcast || payload.info;
            if (info) {
                this.podcastInfo = info;
                this.renderPodcastInfo(info);
                this.toast('AI 双主播播客音频已合成完成！', 'success');
            }
        });

        this.socket.on('podcast-progress', (data) => {
            if (data && data.message) {
                this.updatePipelineUI({
                    stage: 'podcast',
                    message: data.message,
                    percentage: data.progress || 50
                });
            }
        });
    }

    appendAgentLog(entry) {
        const drawer = document.getElementById('agentLogDrawer');
        if (!drawer || !entry) return;
        const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '';
        const line = document.createElement('div');
        line.innerHTML = `<span class="text-slate-500">[${time}]</span> <span class="text-cyan-400 font-semibold">[${this.escapeHtml(entry.agent || 'Agent')}]</span> <span>${this.escapeHtml(entry.message || '')}</span>`;
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
            text.textContent = progress.message || 'Agent 正在执行任务...';
            pctLabel.textContent = `${pct}%`;

            if (pct >= 100 || stage === 'completed' || stage === 'research_completed') {
                setTimeout(() => {
                    container.classList.add('hidden');
                }, 3500);
            }
        }

        // 高亮流水线节点
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

    // ==================== 3. 选项卡与筛选 ====================
    switchTab(tabName) {
        this.activeTab = tabName;
        const tabs = ['feed', 'summary', 'research', 'podcast'];
        tabs.forEach(t => {
            const btn = document.getElementById(`tabBtn-${t}`);
            const panel = document.getElementById(`tabPanel-${t}`);
            if (btn) {
                if (t === tabName) {
                    btn.className = 'tab-btn px-4 py-2 rounded-xl text-sm font-semibold bg-blue-600 text-white shadow-sm transition-all';
                } else {
                    btn.className = 'tab-btn px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-all';
                }
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
        if (!regionBar || !categoryBar) return;

        // 统计可用地区与分类
        const regionCounts = { '全部': this.news.length };
        const categoryCounts = { '全部': this.news.length };

        this.news.forEach(item => {
            const r = item.region || '国际';
            const c = item.category || '国际';
            regionCounts[r] = (regionCounts[r] || 0) + 1;
            categoryCounts[c] = (categoryCounts[c] || 0) + 1;
        });

        const regions = Object.keys(regionCounts);
        regionBar.innerHTML = `<span class="text-xs text-slate-400 mr-1"><i class="fa-solid fa-earth-americas mr-1"></i>地区:</span>` +
            regions.map(r => {
                const active = this.selectedRegion === r;
                const cls = active
                    ? 'bg-blue-600 text-white font-semibold'
                    : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-blue-500';
                return `<button onclick="app.setRegionFilter('${r}')" class="px-2.5 py-1 rounded-lg text-xs transition ${cls}">${this.escapeHtml(r)} <span class="opacity-75">(${regionCounts[r]})</span></button>`;
            }).join('');

        const categories = Object.keys(categoryCounts);
        if (categories.length > 2) {
            categoryBar.innerHTML = `<span class="text-xs text-slate-400 mr-1"><i class="fa-solid fa-tag mr-1"></i>领域:</span>` +
                categories.map(c => {
                    const active = this.selectedCategory === c;
                    const cls = active
                        ? 'bg-indigo-600 text-white font-semibold'
                        : 'bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-700 hover:border-indigo-500';
                    return `<button onclick="app.setCategoryFilter('${c}')" class="px-2.5 py-1 rounded-lg text-xs transition ${cls}">${this.escapeHtml(c)}</button>`;
                }).join('');
        } else {
            categoryBar.innerHTML = '';
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

    // ==================== 4. 渲染全球情报卡片网格 ====================
    renderNewsGrid() {
        const grid = document.getElementById('newsGrid');
        if (!grid) return;

        const keyword = (document.getElementById('localFilterInput')?.value || '').trim().toLowerCase();

        const filtered = this.news.filter(item => {
            if (this.selectedRegion !== '全部' && (item.region || '国际') !== this.selectedRegion) {
                return false;
            }
            if (this.selectedCategory !== '全部' && (item.category || '国际') !== this.selectedCategory) {
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
                <div class="col-span-full glass-panel rounded-2xl p-12 text-center space-y-3">
                    <i class="fa-solid fa-satellite-dish text-4xl text-blue-500"></i>
                    <h3 class="text-base font-bold">当前筛选条件下暂无新闻情报</h3>
                    <p class="text-xs text-slate-500 max-w-md mx-auto">点击右上角「Agent 全球巡检」按钮，派遣多 Agent 并发采集路透社、BBC、纽约时报、彭博社、南华早报等全球权威信源。</p>
                </div>
            `;
            return;
        }

        grid.innerHTML = filtered.map((item, idx) => this.renderSingleCardHtml(item, idx)).join('');
    }

    renderSingleCardHtml(item, idx) {
        const title = item.translatedTitle || item.title || '无标题';
        const originalTitle = item.translatedTitle && item.translatedTitle !== item.title ? item.title : '';
        const summary = item.summary || item.translatedDescription || item.description || '';
        const sourceName = item.source?.name || 'Global Media';
        const region = item.region || '国际';
        const category = item.category || '';
        const timeStr = item.publishedAt ? this.formatRelativeTime(item.publishedAt) : '';

        const relatedSources = Array.isArray(item.relatedSources) ? item.relatedSources : [];
        const hasMultiSources = relatedSources.length > 0;
        const keyPoints = Array.isArray(item.keyPoints) ? item.keyPoints : [];

        const encodedUrl = encodeURIComponent(item.url || '');
        const encodedTitle = encodeURIComponent(title);
        const encodedSource = encodeURIComponent(sourceName);
        const encodedSummary = encodeURIComponent(summary);

        return `
            <article class="news-card rounded-2xl p-5 flex flex-col justify-between space-y-3">
                <div class="space-y-2.5">
                    <!-- 顶部元信息：媒体名称 + 地区/分类 + 时间 -->
                    <div class="flex items-center justify-between gap-2 text-xs">
                        <div class="flex flex-wrap items-center gap-1.5 min-w-0">
                            <span class="px-2 py-0.5 rounded-md font-bold bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300 border border-blue-200/60 dark:border-blue-800/60 truncate max-w-[160px]">
                                ${this.escapeHtml(sourceName)}
                            </span>
                            <span class="px-2 py-0.5 rounded-md font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                                ${this.escapeHtml(region)}
                            </span>
                            ${category && category !== region ? `<span class="px-2 py-0.5 rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300">${this.escapeHtml(category)}</span>` : ''}
                        </div>
                        <span class="text-[11px] text-slate-400 whitespace-nowrap">${this.escapeHtml(timeStr)}</span>
                    </div>

                    <!-- 多信源交叉验证标识 -->
                    ${hasMultiSources ? `
                        <div class="px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/50 text-[11px] text-amber-800 dark:text-amber-300 flex items-center justify-between">
                            <span><i class="fa-solid fa-fire-flame-curved mr-1"></i><strong>${relatedSources.length + 1} 家权威外媒交叉印证</strong></span>
                            <span class="truncate max-w-[160px] opacity-80">+ ${this.escapeHtml(relatedSources.map(r => r.name).join(', '))}</span>
                        </div>
                    ` : ''}

                    <!-- 中文编译主标题与外媒原标题 -->
                    <div>
                        <h3 class="text-base font-bold leading-snug text-slate-900 dark:text-slate-100 hover:text-blue-600 dark:hover:text-blue-400 transition">
                            <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(title)}</a>
                        </h3>
                        ${originalTitle ? `<p class="text-[11px] text-slate-400 dark:text-slate-500 mt-1 line-clamp-1" title="${this.escapeHtml(originalTitle)}">${this.escapeHtml(originalTitle)}</p>` : ''}
                    </div>

                    <!-- 深度中文摘要 -->
                    <p class="text-xs sm:text-sm text-slate-600 dark:text-slate-300 leading-relaxed line-clamp-4">
                        ${this.escapeHtml(summary)}
                    </p>

                    <!-- 核心要点标签 -->
                    ${keyPoints.length > 0 ? `
                        <div class="pt-1 flex flex-wrap gap-1">
                            ${keyPoints.map(kp => `<span class="text-[11px] px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800/90 text-slate-600 dark:text-slate-400">• ${this.escapeHtml(kp)}</span>`).join('')}
                        </div>
                    ` : ''}
                </div>

                <!-- 卡片底部操作栏：Agent 全文深读 & 原文跳转 -->
                <div class="pt-3 border-t border-slate-100 dark:border-slate-800/80 flex items-center justify-between gap-2 text-xs">
                    <button onclick="app.openDeepRead('${encodedUrl}', '${encodedTitle}', '${encodedSource}', '${encodedSummary}')"
                        class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold text-blue-600 dark:text-blue-400 bg-blue-50/80 dark:bg-blue-950/50 hover:bg-blue-100 dark:hover:bg-blue-900/60 transition cursor-pointer">
                        <i class="fa-solid fa-book-open-reader"></i>
                        <span>Agent 全文深读</span>
                    </button>
                    <a href="${this.escapeHtml(item.url || '#')}" target="_blank" rel="noopener noreferrer"
                        class="inline-flex items-center gap-1 text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 transition">
                        <span>访问源站</span>
                        <i class="fa-solid fa-arrow-up-right-from-square text-[10px]"></i>
                    </a>
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
            if (diffMin < 60) return `${diffMin}分钟前`;
            const diffHr = Math.floor(diffMin / 60);
            if (diffHr < 24) return `${diffHr}小时前`;
            return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        } catch (_) {
            return '';
        }
    }

    // ==================== 5. Agent 核心交互动作 ====================

    /**
     * 触发多 Agent 全球知名信源巡检
     */
    async triggerAgentPatrol() {
        const btn = document.getElementById('btnRunPatrol');
        const icon = document.getElementById('patrolBtnIcon');
        const text = document.getElementById('patrolBtnText');

        if (btn) btn.disabled = true;
        if (icon) icon.className = 'fa-solid fa-spinner fa-spin';
        if (text) text.textContent = 'Agent 巡检整合中...';

        this.toast('已启动多 Agent 全球知名信源巡检，请留意实时流水线进度...', 'info');
        this.updatePipelineUI({ stage: 'scout', percentage: 5, message: 'Scout Agent 正在连接全球知名媒体矩阵...' });

        try {
            const res = await fetch('/api/agent/patrol', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ generateSummary: true })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.message || '巡检请求失败');
            }

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
            this.toast(`全球巡检完成！成功编译整合 ${this.news.length} 条权威情报（耗时 ${data.elapsedSeconds || ''}s）`, 'success');
        } catch (err) {
            this.toast(`Agent 巡检提示: ${err.message}`, 'error');
        } finally {
            if (btn) btn.disabled = false;
            if (icon) icon.className = 'fa-solid fa-satellite-dish';
            if (text) text.textContent = 'Agent 全球巡检';
        }
    }

    async fetchLatestNews() {
        try {
            const res = await fetch('/api/news');
            const data = await res.json();
            if (data && data.success && Array.isArray(data.news)) {
                this.news = data.news;
                this.totalNews = data.total || this.news.length;
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
     * 快速填充专题并触发 Agent 专题调查
     */
    quickTopic(topicText) {
        const input = document.getElementById('topicResearchInput');
        if (input) {
            input.value = topicText;
            this.runTopicResearch();
        }
    }

    /**
     * 派遣 Research Agent 围绕特定主题搜集全球信源并生成对比报告
     */
    async runTopicResearch() {
        const input = document.getElementById('topicResearchInput');
        const btn = document.getElementById('btnTopicResearch');
        const authoritativeOnly = document.getElementById('chkAuthoritativeOnly')?.checked || false;

        const topic = (input?.value || '').trim();
        if (!topic) {
            this.toast('请先输入您想让 Agent 搜集整合的全球新闻主题或关键词', 'warning');
            input?.focus();
            return;
        }

        if (btn) {
            btn.disabled = true;
            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i><span>Agent 正在跨源检索深读...</span>`;
        }

        this.switchTab('research');
        const container = document.getElementById('researchReportContainer');
        if (container) {
            container.innerHTML = `
                <div class="py-12 text-center space-y-3">
                    <i class="fa-solid fa-compass-drafting fa-spin text-4xl text-indigo-600"></i>
                    <h3 class="text-base font-bold">Research Agent 正在全球权威信源中搜集「${this.escapeHtml(topic)}」...</h3>
                    <p class="text-xs text-slate-500">正在执行：多语种检索词规划 → 全球名媒检索 → Jina Reader 全文深读 → 跨信源观点比对合成</p>
                </div>
            `;
        }

        try {
            const res = await fetch('/api/agent/research', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ topic, authoritativeOnly, maxArticles: 12 })
            });
            const data = await res.json();

            if (!res.ok || !data.success) {
                throw new Error(data.message || '专题搜集未找到结果');
            }

            this.renderResearchReport(data);
            this.toast(`专题「${topic}」多信源深度整合报告已生成！`, 'success');
        } catch (err) {
            if (container) {
                container.innerHTML = `
                    <div class="py-10 text-center text-rose-500 space-y-2">
                        <i class="fa-solid fa-circle-exclamation text-3xl"></i>
                        <p class="font-semibold">${this.escapeHtml(err.message)}</p>
                    </div>
                `;
            }
            this.toast(err.message, 'error');
        } finally {
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = `<i class="fa-solid fa-wand-magic-sparkles"></i><span>派遣 Agent 搜集整合</span>`;
            }
        }
    }

    async loadLatestResearchIfAny() {
        try {
            const res = await fetch('/api/agent/research/latest');
            const data = await res.json();
            if (data && data.success && data.report && data.report.topic) {
                this.renderResearchReport(data.report);
            }
        } catch (_) {}
    }

    renderResearchReport(report) {
        const container = document.getElementById('researchReportContainer');
        if (!container || !report) return;

        const sources = Array.isArray(report.sourcesCovered) ? report.sourcesCovered : [];
        const articles = Array.isArray(report.articles) ? report.articles : [];

        container.innerHTML = `
            <div class="space-y-6">
                <div class="pb-4 border-b border-slate-200 dark:border-slate-800 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2">
                            <span class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300">
                                Agent 全球多信源专题卷宗
                            </span>
                            <span class="text-xs text-slate-400">检索词: ${this.escapeHtml(report.englishQuery || report.topic)}</span>
                        </div>
                        <h2 class="text-xl sm:text-2xl font-bold mt-1.5">「${this.escapeHtml(report.topic)}」全球知名信源整合报告</h2>
                        <p class="text-xs text-slate-500 mt-1">
                            生成时间: ${new Date(report.generatedAt || Date.now()).toLocaleString('zh-CN')} · 覆盖 ${sources.length} 家国际媒体 (${this.escapeHtml(sources.slice(0, 8).join('、'))})
                        </p>
                    </div>
                </div>

                <!-- 深度对比报告正文 -->
                <div class="summary-content prose dark:prose-invert max-w-none">
                    ${report.reportHtml || ''}
                </div>

                <!-- 支撑该专题报告的外媒情报卡片 -->
                <div class="pt-6 border-t border-slate-200 dark:border-slate-800 space-y-3">
                    <h3 class="text-sm font-bold uppercase tracking-wider text-slate-500">
                        📚 本次专题采集的全球知名信源报道 (${articles.length} 篇)
                    </h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        ${articles.map((a, idx) => this.renderSingleCardHtml(a, idx)).join('')}
                    </div>
                </div>
            </div>
        `;
    }

    /**
     * 打开单篇外媒报道的 Jina Reader + Agent 全文深读弹窗
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

        bodyEl.innerHTML = `
            <div class="py-12 text-center space-y-3">
                <i class="fa-solid fa-book-open-reader fa-beat-fade text-3xl text-blue-600"></i>
                <div class="font-semibold">Deep-Reader Agent 正在通过 Jina Reader 提取 [${this.escapeHtml(sourceName)}] 原文并精译...</div>
                <p class="text-xs text-slate-400">正在穿透页面排版，提取核心段落、数据与背景脉络</p>
            </div>
        `;

        try {
            const res = await fetch('/api/agent/deep-read', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, title, sourceName, existingSummary })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
                throw new Error(data.message || '全文深读失败');
            }

            bodyEl.innerHTML = `
                <div class="space-y-4">
                    <div class="summary-content">
                        ${data.analysisHtml || ''}
                    </div>
                    <details class="p-3 rounded-xl bg-slate-50 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 text-xs">
                        <summary class="cursor-pointer font-semibold text-slate-500">查看抓取到的外媒原文摘录 (提取方式: ${this.escapeHtml(data.extractionMethod || 'auto')})</summary>
                        <pre class="mt-2 whitespace-pre-wrap font-sans text-slate-600 dark:text-slate-300 max-h-60 overflow-y-auto">${this.escapeHtml(data.fullText || '')}</pre>
                    </details>
                </div>
            `;
        } catch (err) {
            bodyEl.innerHTML = `<div class="p-6 text-center text-rose-500">深读失败: ${this.escapeHtml(err.message)}</div>`;
        }
    }

    closeDeepReadModal() {
        document.getElementById('deepReadModal')?.classList.add('hidden');
    }

    // ==================== 6. 主编综述、EPUB 与 Kindle ====================

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

    async exportEpub() {
        try {
            this.toast('正在生成自适应排版 EPUB 电子书...', 'info');
            const res = await fetch('/api/generate-epub', { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '生成 EPUB 失败');

            window.location.href = data.downloadUrl;
            this.toast(`EPUB 电子书 (${data.epub.filename}) 已开始下载`, 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }

    async sendToKindle() {
        try {
            this.toast('正在打包 EPUB 简报并发送至 Kindle / 默认邮箱...', 'info');
            const res = await fetch('/api/send-email', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '发送邮件失败');
            this.toast(data.message || '成功推送至 Kindle！', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }

    // ==================== 7. AI 播客合成 ====================

    async generatePodcast(isDemo = false) {
        const btn = document.getElementById('btnGenPodcast');
        if (btn) btn.disabled = true;
        this.toast(isDemo ? '正在执行 TTS 语音快速测试...' : '正在编写双主播脚本并合成 MP3 音频...', 'info');

        try {
            const res = await fetch(`/api/generate-podcast${isDemo ? '?demo=1' : ''}`, { method: 'POST' });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.message || '合成播客失败');

            const info = data.podcast || data.info;
            this.renderPodcastInfo(info);
            this.toast('播客音频合成完毕！', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    renderPodcastInfo(info) {
        if (!info) return;
        const titleEl = document.getElementById('podcastTitleLabel');
        const metaEl = document.getElementById('podcastMetaLabel');
        const player = document.getElementById('podcastAudioPlayer');
        const scriptBox = document.getElementById('podcastScriptBox');
        const scriptWrapper = document.getElementById('podcastScriptWrapper');

        if (titleEl) titleEl.textContent = info.title || 'AI 全球新闻联播';
        if (metaEl) {
            const ftpStatus = info.ftp?.uploaded ? ' · 已同步上传至 FTP' : '';
            metaEl.textContent = `预估时长: ${info.duration || 0} 秒 · 片段数: ${info.stats?.totalSegments || 0}${ftpStatus}`;
        }
        if (player) {
            player.src = `/api/podcast/complete?t=${Date.now()}`;
            player.load();
        }
        if (scriptBox && info.script) {
            scriptBox.textContent = info.script;
            scriptWrapper?.classList.remove('hidden');
        }
    }

    // ==================== 8. 全球知名信源矩阵管理 ====================

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
            wire: '🌐 国际顶级通讯社与全球门户',
            western: '🏛️ 欧美权威大报',
            asiapacific: '🌏 亚太与大中华区名媒',
            finance: '💹 全球财经与商业',
            tech: '🔬 前沿科技媒体',
            custom: '⭐ 自定义国际信源'
        };

        container.innerHTML = this.sourceMatrix.map((src, idx) => {
            const badge = categoryLabels[src.category] || '国际信源';
            const stat = src.lastStat;
            const statHtml = stat
                ? `<span class="text-[11px] ${stat.status === 'ok' ? 'text-emerald-600' : 'text-amber-500'}">上次采集: ${stat.count}条 (${stat.durationMs}ms)</span>`
                : `<span class="text-[11px] text-slate-400">权威度: ${src.authority || 85}</span>`;

            return `
                <div class="p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex items-start justify-between gap-3 bg-white dark:bg-slate-900">
                    <label class="flex items-start gap-2.5 cursor-pointer flex-1 min-w-0">
                        <input type="checkbox" data-source-id="${this.escapeHtml(src.id)}" class="source-toggle mt-1 rounded text-blue-600" ${src.enabled ? 'checked' : ''}>
                        <div class="min-w-0">
                            <div class="font-bold text-xs sm:text-sm truncate">${this.escapeHtml(src.name)}</div>
                            <div class="text-[11px] text-slate-400 truncate">${this.escapeHtml(badge)} · ${this.escapeHtml(src.domain || src.rssUrl || '')}</div>
                            <div class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 line-clamp-1">${this.escapeHtml(src.description || '')}</div>
                            ${statHtml}
                        </div>
                    </label>
                    <div class="flex flex-col items-end gap-1">
                        <span class="text-[10px] text-slate-400">单次条数</span>
                        <input type="number" min="1" max="20" value="${src.maxArticles || 5}" data-source-max="${this.escapeHtml(src.id)}"
                            class="w-14 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs text-center">
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

    // ==================== 9. 系统与 AI 设置弹窗 ====================

    async openSettingsModal() {
        const modal = document.getElementById('settingsModal');
        if (!modal) return;
        modal.classList.remove('hidden');

        try {
            const res = await fetch('/api/config');
            const data = await res.json();
            if (data && data.success && data.config) {
                const { ai, agent, smtp, schedule } = data.config;
                document.getElementById('cfgAiBaseUrl').value = ai?.baseUrl || '';
                document.getElementById('cfgAiModel').value = ai?.model || '';
                document.getElementById('cfgMaxCurated').value = agent?.maxCuratedArticles || 30;
                document.getElementById('cfgDeepReadCount').value = agent?.deepReadTopCount ?? 8;
                document.getElementById('cfgFreshnessHours').value = agent?.freshnessHours || 48;
                document.getElementById('cfgUpdateTimes').value = (schedule?.updateTimes || []).join(',');
                document.getElementById('cfgRecipientEmail').value = smtp?.defaultRecipient || '';
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
        const recipient = document.getElementById('cfgRecipientEmail')?.value.trim();

        const payload = {
            AI_BASE_URL: baseUrl,
            AI_MODEL: model,
            AGENT_MAX_CURATED_ARTICLES: maxCurated,
            AGENT_DEEP_READ_COUNT: deepReadCount,
            AGENT_FRESHNESS_HOURS: freshnessHours,
            UPDATE_TIMES: updateTimes,
            DEFAULT_RECIPIENT_EMAIL: recipient
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
            this.toast('系统与 Agent 配置已保存并立即生效！', 'success');
        } catch (err) {
            this.toast(err.message, 'error');
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new CoreFeedApp();
});
