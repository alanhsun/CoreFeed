/**
 * 设置管理器 - 统一管理新闻源和定时任务配置
 * 重构后的代码，提供更清晰的逻辑和更好的用户体验
 */

class SettingsManager {
    constructor() {
        this.data = {
            apiSources: [],
            rssSources: [],
            settings: {
                newsApiKey: '',
                newsApiEnabled: false,
                newsApiMaxArticles: 20,
                updateInterval: 60,
                maxArticlesPerSource: 5
            },
            gnews: {
                apiKey: '',
                enabled: false,
                category: 'general',
                language: 'en',
                country: 'us',
                maxArticles: 10
            },
            aiConfig: {
                apiKey: '',
                baseUrl: 'https://api.minimaxi.com/v1',
                model: 'MiniMax-M2.5',
                rateLimitRpm: 60,
                rateLimitBurst: 10
            },
            schedule: {
                autoUpdateEnabled: false,
                updateTimes: ['06:00'],
                updateFrequency: 'daily',
                nextExecution: null,
                isRunning: false
            },
            filter: {
                keywordFilterEnabled: false,
                keywords: [],
                filterTitle: true,
                filterContent: true,
                filterSource: false
            }
        };

        this.isLoading = false;
        this.hasUnsavedChanges = false;
        this.currentTab = 'api';

        this.init();
    }
    
    /**
     * 初始化设置管理器
     */
    async init() {
        try {
            await this.loadConfiguration();
            this.bindEvents();
            this.setupSocketListeners();
        } catch (error) {
            // 前端错误日志保持简洁
        // 设置管理器初始化失败
            toastManager.show('设置管理器初始化失败', 'error');
        }
    }
    
    /**
     * 加载配置数据
     */
    async loadConfiguration() {
        this.isLoading = true;

        try {
            // 并行加载源配置、定时任务配置和AI配置
            const [sourcesResponse, scheduleResponse, aiResponse] = await Promise.all([
                fetch('/api/sources/config', { cache: 'no-cache' }),
                fetch('/api/schedule/config', { cache: 'no-cache' }),
                fetch('/api/ai/config', { cache: 'no-cache' })
            ]);

            // 处理源配置
            if (sourcesResponse.ok) {
                const sourcesData = await sourcesResponse.json();
                this.data.apiSources = sourcesData.apiSources || [];
                this.data.rssSources = sourcesData.rssSources || [];
                this.data.settings = { ...this.data.settings, ...sourcesData.settings };
                this.data.gnews = { ...this.data.gnews, ...sourcesData.gnews };
                this.data.webScraping = { ...this.data.webScraping, ...sourcesData.webScraping };
                this.data.filter = { ...this.data.filter, ...sourcesData.filter };
            } else {
                // 加载源配置失败
            }

            // 处理定时任务配置
            if (scheduleResponse.ok) {
                const scheduleData = await scheduleResponse.json();
                const config = scheduleData.config || scheduleData;
                this.data.schedule = {
                    autoUpdateEnabled: Boolean(config.autoUpdateEnabled),
                    updateTimes: config.updateTimes || ['06:00'],
                    updateFrequency: 'daily',
                    nextExecution: config.nextExecution || null,
                    isRunning: config.isRunning || false
                };
            } else {
                // 加载定时任务配置失败
            }

            // 处理AI配置
            if (aiResponse.ok) {
                const aiData = await aiResponse.json();
                if (aiData.aiConfig) {
                    this.data.aiConfig = { ...this.data.aiConfig, ...aiData.aiConfig };
                }
            } else {
                // 加载AI配置失败
            }

            this.hasUnsavedChanges = false;

            // 加载完成后立即更新界面显示
            this.updateAllDisplays();

        } catch (error) {
            // 加载配置时出错
            toastManager.show('加载配置失败: ' + error.message, 'error');
        } finally {
            this.isLoading = false;
        }
    }
    
    /**
     * 更新所有界面显示
     */
    updateAllDisplays() {
        // 延迟执行以确保DOM元素已准备好
        setTimeout(() => {
            this.isLoadingConfig = true;
            
            // 更新News API Key显示
            this.loadNewsApiKey();
            
            // 更新Gnews配置显示
            this.loadGnewsConfig();
            
            // 更新网页抓取配置显示
            this.loadWebScrapingConfig();
            
            // 更新定时任务显示
            this.updateScheduleDisplay();
            
            // 如果当前标签页已打开，更新对应的源列表
            if (this.currentTab === 'api') {
                this.renderApiSources();
            } else if (this.currentTab === 'rss') {
                this.renderRssSources();
            }
            
            this.isLoadingConfig = false;
        }, 100);
    }
    
    /**
     * 绑定事件监听器
     */
    bindEvents() {
        // 监听表单变化
        document.addEventListener('input', (e) => {
            if (e.target.closest('#sourceManagerModal')) {
                // 排除程序化设置的事件（避免在加载配置时触发markAsChanged）
                if (!this.isLoadingConfig) {
                    this.markAsChanged();
                    // 实时更新网页抓取源的maxArticles值
                    this.updateWebScrapingMaxArticles(e.target);
                }
            }
        });
        
        // 监听页面离开事件 - 已禁用未保存更改提示
        // window.addEventListener('beforeunload', (e) => {
        //     if (this.hasUnsavedChanges) {
        //         e.preventDefault();
        //         e.returnValue = '您有未保存的更改，确定要离开吗？';
        //     }
        // });
    }
    
    /**
     * 实时更新网页抓取源的maxArticles值
     */
    updateWebScrapingMaxArticles(target) {
        if (!this.data.webScraping || !this.data.webScraping.sources) {
            return;
        }
        
        // 如果正在加载配置，跳过更新
        if (this.isLoadingConfig) {
            return;
        }
        
        const value = parseInt(target.value) || 0;
        
        switch (target.id) {
            case 'apNewsMaxArticles':
                if (this.data.webScraping.sources.apNews) {
                    this.data.webScraping.sources.apNews.maxArticles = value;
                }
                break;

            case 'japanTodayMaxArticles':
                if (this.data.webScraping.sources.japanToday) {
                    this.data.webScraping.sources.japanToday.maxArticles = value;
                }
                break;

            case 'foxNewsMaxArticles':
                if (this.data.webScraping.sources.foxNews) {
                    this.data.webScraping.sources.foxNews.maxArticles = value;
                }
                break;
            case 'alJazeeraMaxArticles':
                if (this.data.webScraping.sources.alJazeera) {
                    this.data.webScraping.sources.alJazeera.maxArticles = value;
                }
                break;
            case 'channelNewsAsiaMaxArticles':
                if (this.data.webScraping.sources.channelNewsAsia) {
                    this.data.webScraping.sources.channelNewsAsia.maxArticles = value;
                }
                break;
            case 'taipeiTimesMaxArticles':
                if (this.data.webScraping.sources.taipeiTimes) {
                    this.data.webScraping.sources.taipeiTimes.maxArticles = value;
                }
                break;
            case 'nhkWorldMaxArticles':
                if (this.data.webScraping.sources.nhkWorld) {
                    this.data.webScraping.sources.nhkWorld.maxArticles = value;
                }
                break;
        }
        
        // 标记配置已更改
        this.markAsChanged();
    }
    
    /**
     * 设置Socket监听器
     */
    setupSocketListeners() {
        // 监听配置更新通知
        socket.on('config-updated', (data) => {
            // 收到配置更新通知
            // 配置已保存，重置未保存标记
            this.hasUnsavedChanges = false;
        });
        
        // 监听定时任务配置更新
        socket.on('schedule-config-updated', (data) => {
            // 收到定时任务配置更新通知
            if (data.config) {
                this.data.schedule = { ...this.data.schedule, ...data.config };
                this.updateScheduleDisplay();
            }
            this.hasUnsavedChanges = false;
        });
        
        // 监听错误通知
        socket.on('config-reload-error', (data) => {
            toastManager.show(data.message || '配置重载失败', 'error');
        });
        
        socket.on('schedule-config-reload-error', (data) => {
            toastManager.show(data.message || '定时任务配置重载失败', 'error');
        });
    }
    
    /**
     * 标记为已更改
     */
    markAsChanged() {
        this.hasUnsavedChanges = true;
        this.updateSaveButtonState();
    }
    
    /**
     * 更新保存按钮状态
     */
    updateSaveButtonState() {
        const saveButton = document.querySelector('[onclick="saveSources()"]');
        if (saveButton) {
            if (this.hasUnsavedChanges) {
                saveButton.classList.add('btn-warning');
                saveButton.classList.remove('btn-primary');
                // 保持按钮文本为"保存配置"，只改变样式
                saveButton.innerHTML = '<i class="fas fa-save"></i><span>保存配置</span>';
            } else {
                saveButton.classList.remove('btn-warning');
                saveButton.classList.add('btn-primary');
                saveButton.innerHTML = '<i class="fas fa-save"></i><span>保存配置</span>';
            }
        }
    }
    
    /**
     * 打开设置管理器
     */
    async open() {
        const modal = document.getElementById('sourceManagerModal');
        modal.classList.remove('hidden');
        
        // 重新加载配置以确保数据最新
        await this.loadConfiguration();
        
        // 默认显示API源标签页
        this.switchTab('api');
    }
    
    /**
     * 关闭设置管理器
     */
    close() {
        // 已禁用未保存更改提示
        // if (this.hasUnsavedChanges) {
        //     if (!confirm('您有未保存的更改，确定要关闭吗？')) {
        //         return;
        //     }
        // }
        
        const modal = document.getElementById('sourceManagerModal');
        modal.classList.add('hidden');
        this.hideAllAddForms();
    }
    
    /**
     * 切换标签页
     */
    switchTab(tabName) {
        this.currentTab = tabName;

        // 更新标签页状态
        document.querySelectorAll('.source-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.getElementById(tabName + 'Tab').classList.add('active');

        // 显示对应内容
        document.querySelectorAll('.source-content').forEach(content => {
            content.classList.add('hidden');
        });

        switch (tabName) {
            case 'api':
                document.getElementById('apiSourcesContent').classList.remove('hidden');
                this.isLoadingConfig = true;
                this.renderApiSources();
                this.loadNewsApiKey();
                this.loadGnewsConfig();
                this.loadWebScrapingConfig();
                this.isLoadingConfig = false;
                break;
            case 'rss':
                document.getElementById('rssSourcesContent').classList.remove('hidden');
                this.renderRssSources();
                break;
            case 'ai':
                document.getElementById('aiModelContent').classList.remove('hidden');
                this.loadAiConfig();
                break;
            case 'settings':
                document.getElementById('settingsContent').classList.remove('hidden');
                this.renderScheduleSettings();
                break;
            case 'filter':
                document.getElementById('filterContent').classList.remove('hidden');
                this.renderFilterSettings();
                break;
        }

        this.hideAllAddForms();
    }
    
    /**
     * 加载News API Key到输入框
     */
    loadNewsApiKey() {
        this.isLoadingConfig = true;
        
        const input = document.getElementById('newsApiKey');
        const enabledInput = document.getElementById('newsApiEnabled');
        
        if (input) {
            input.value = this.data.settings.newsApiKey || '';
        }
        if (enabledInput) {
            enabledInput.checked = this.data.settings.newsApiEnabled === true;
        }
        
        this.isLoadingConfig = false;
    }
    
    /**
     * 加载Gnews配置到输入框
     */
    loadGnewsConfig() {
        this.isLoadingConfig = true;

        const apiKeyInput = document.getElementById('gnewsApiKey');
        const enabledInput = document.getElementById('gnewsEnabled');
        const maxArticlesInput = document.getElementById('gnewsMaxArticles');

        if (apiKeyInput) {
            apiKeyInput.value = this.data.gnews.apiKey || '';
        }
        if (enabledInput) {
            enabledInput.checked = this.data.gnews.enabled || false;
        }
        if (maxArticlesInput) {
            maxArticlesInput.value = this.data.gnews.maxArticles || 10;
        }

        // 加载News API最大文章数
        const newsApiMaxArticlesInput = document.getElementById('newsApiMaxArticles');
        if (newsApiMaxArticlesInput) {
            newsApiMaxArticlesInput.value = this.data.settings.newsApiMaxArticles || 20;
        }

        this.isLoadingConfig = false;
    }

    /**
     * 加载AI配置到输入框
     */
    loadAiConfig() {
        this.isLoadingConfig = true;

        const apiKeyInput = document.getElementById('aiApiKey');
        const baseUrlInput = document.getElementById('aiBaseUrl');
        const modelInput = document.getElementById('aiModel');
        const rateLimitRpmInput = document.getElementById('aiRateLimitRpm');
        const rateLimitBurstInput = document.getElementById('aiRateLimitBurst');

        if (apiKeyInput) {
            apiKeyInput.value = this.data.aiConfig.apiKey || '';
        }
        if (baseUrlInput) {
            baseUrlInput.value = this.data.aiConfig.baseUrl || 'https://api.minimaxi.com/v1';
        }
        if (modelInput) {
            modelInput.value = this.data.aiConfig.model || 'MiniMax-M2.5';
        }
        if (rateLimitRpmInput) {
            rateLimitRpmInput.value = this.data.aiConfig.rateLimitRpm || 60;
        }
        if (rateLimitBurstInput) {
            rateLimitBurstInput.value = this.data.aiConfig.rateLimitBurst || 10;
        }

        this.isLoadingConfig = false;
    }

    /**
     * 应用AI模板
     */
    applyAiTemplate(templateName) {
        const templates = {
            minimax: {
                baseUrl: 'https://api.minimaxi.com/v1',
                model: 'MiniMax-M2.5',
                rateLimitRpm: 60,
                rateLimitBurst: 10
            }
        };

        const template = templates[templateName];
        if (!template) return;

        this.data.aiConfig.baseUrl = template.baseUrl;
        this.data.aiConfig.model = template.model;
        this.data.aiConfig.rateLimitRpm = template.rateLimitRpm;
        this.data.aiConfig.rateLimitBurst = template.rateLimitBurst;

        // 更新输入框
        const baseUrlInput = document.getElementById('aiBaseUrl');
        const modelInput = document.getElementById('aiModel');
        const rateLimitRpmInput = document.getElementById('aiRateLimitRpm');
        const rateLimitBurstInput = document.getElementById('aiRateLimitBurst');

        if (baseUrlInput) baseUrlInput.value = template.baseUrl;
        if (modelInput) modelInput.value = template.model;
        if (rateLimitRpmInput) rateLimitRpmInput.value = template.rateLimitRpm;
        if (rateLimitBurstInput) rateLimitBurstInput.value = template.rateLimitBurst;

        this.markAsChanged();
        toastManager.show('已应用' + templateName + '模板', 'success');
    }

    /**
     * 加载网页抓取配置到输入框
     */
    loadWebScrapingConfig() {
        this.isLoadingConfig = true;
        
        const webScrapingEnabledInput = document.getElementById('webScrapingEnabled');
        const apNewsEnabledInput = document.getElementById('apNewsEnabled');
        const apNewsMaxArticlesInput = document.getElementById('apNewsMaxArticles');

        const japanTodayEnabledInput = document.getElementById('japanTodayEnabled');
        const japanTodayMaxArticlesInput = document.getElementById('japanTodayMaxArticles');
        const foxNewsEnabledInput = document.getElementById('foxNewsEnabled');
        const foxNewsMaxArticlesInput = document.getElementById('foxNewsMaxArticles');
        const alJazeeraEnabledInput = document.getElementById('alJazeeraEnabled');
        const alJazeeraMaxArticlesInput = document.getElementById('alJazeeraMaxArticles');
        const channelNewsAsiaEnabledInput = document.getElementById('channelNewsAsiaEnabled');
        const channelNewsAsiaMaxArticlesInput = document.getElementById('channelNewsAsiaMaxArticles');
        const taipeiTimesEnabledInput = document.getElementById('taipeiTimesEnabled');
        const taipeiTimesMaxArticlesInput = document.getElementById('taipeiTimesMaxArticles');
        const nhkWorldEnabledInput = document.getElementById('nhkWorldEnabled');
        const nhkWorldMaxArticlesInput = document.getElementById('nhkWorldMaxArticles');

        
        // 初始化默认配置如果不存在
        if (!this.data.webScraping) {
            this.data.webScraping = {
                enabled: false,
                sources: {
                    apNews: { enabled: false, maxArticles: 5 },

                    japanToday: { enabled: false, maxArticles: 5 },
                    foxNews: { enabled: false, maxArticles: 5 },
                    alJazeera: { enabled: false, maxArticles: 5 },
                    channelNewsAsia: { enabled: false, maxArticles: 5 },
                    taipeiTimes: { enabled: false, maxArticles: 5 },
                    nhkWorld: { enabled: false, maxArticles: 5 }
                }
            };
        }
        
        if (webScrapingEnabledInput) {
            webScrapingEnabledInput.checked = this.data.webScraping.enabled || false;
        }
        if (apNewsEnabledInput) {
            apNewsEnabledInput.checked = this.data.webScraping.sources?.apNews?.enabled || false;
        }
        if (apNewsMaxArticlesInput) {
            apNewsMaxArticlesInput.value = this.data.webScraping.sources?.apNews?.maxArticles || 5;
        }

        
        if (japanTodayEnabledInput) {
            japanTodayEnabledInput.checked = this.data.webScraping.sources?.japanToday?.enabled || false;
        }
        if (japanTodayMaxArticlesInput) {
            japanTodayMaxArticlesInput.value = this.data.webScraping.sources?.japanToday?.maxArticles || 5;
        }

        if (foxNewsEnabledInput) {
            foxNewsEnabledInput.checked = this.data.webScraping.sources?.foxNews?.enabled || false;
        }
        if (foxNewsMaxArticlesInput) {
            foxNewsMaxArticlesInput.value = this.data.webScraping.sources?.foxNews?.maxArticles || 5;
        }
        if (alJazeeraEnabledInput) {
            alJazeeraEnabledInput.checked = this.data.webScraping.sources?.alJazeera?.enabled || false;
        }
        if (alJazeeraMaxArticlesInput) {
            alJazeeraMaxArticlesInput.value = this.data.webScraping.sources?.alJazeera?.maxArticles || 5;
        }
        if (channelNewsAsiaEnabledInput) {
            channelNewsAsiaEnabledInput.checked = this.data.webScraping.sources?.channelNewsAsia?.enabled || false;
        }
        if (channelNewsAsiaMaxArticlesInput) {
            channelNewsAsiaMaxArticlesInput.value = this.data.webScraping.sources?.channelNewsAsia?.maxArticles || 5;
        }
        if (taipeiTimesEnabledInput) {
            taipeiTimesEnabledInput.checked = this.data.webScraping.sources?.taipeiTimes?.enabled || false;
        }
        if (taipeiTimesMaxArticlesInput) {
            taipeiTimesMaxArticlesInput.value = this.data.webScraping.sources?.taipeiTimes?.maxArticles || 5;
        }
        if (nhkWorldEnabledInput) {
            nhkWorldEnabledInput.checked = this.data.webScraping.sources?.nhkWorld?.enabled || false;
        }
        if (nhkWorldMaxArticlesInput) {
            nhkWorldMaxArticlesInput.value = this.data.webScraping.sources?.nhkWorld?.maxArticles || 5;
        }

        
        this.isLoadingConfig = false;
    }
    
    /**
     * 渲染API源列表
     */
    renderApiSources() {
        const container = document.getElementById('apiSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        if (this.data.apiSources.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-globe"></i>
                    <h4>暂无API源</h4>
                    <p>点击上方"添加源"按钮来添加您的第一个News API源</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.data.apiSources.map((source, index) => `
            <div class="source-item">
                <div class="source-item-info">
                    <div class="source-item-name">${this.escapeHtml(source.name)}</div>
                    <div class="source-item-url">${this.escapeHtml(source.id)}</div>
                    <div class="source-item-meta">每次获取: ${source.maxArticles || 10} 篇</div>
                </div>
                <div class="source-item-actions">
                    <button class="source-item-toggle ${source.enabled ? 'active' : ''}" 
                            onclick="settingsManager.toggleApiSource(${index})" 
                            title="${source.enabled ? '禁用' : '启用'}">
                    </button>
                    <button class="btn-secondary btn-sm" onclick="settingsManager.editApiSource(${index})" title="编辑">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-secondary btn-sm" onclick="settingsManager.deleteApiSource(${index})" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * 渲染RSS源列表
     */
    renderRssSources() {
        const container = document.getElementById('rssSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        if (this.data.rssSources.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-rss"></i>
                    <h4>暂无RSS源</h4>
                    <p>点击上方"添加源"按钮来添加您的第一个RSS源</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.data.rssSources.map((source, index) => `
            <div class="source-item">
                <div class="source-item-info">
                    <div class="source-item-name">${this.escapeHtml(source.name)}</div>
                    <div class="source-item-url">${this.escapeHtml(source.url)}</div>
                    <div class="source-item-meta">每次获取: ${source.maxArticles || 10} 篇</div>
                </div>
                <div class="source-item-actions">
                    <button class="source-item-toggle ${source.enabled ? 'active' : ''}" 
                            onclick="settingsManager.toggleRssSource(${index})" 
                            title="${source.enabled ? '禁用' : '启用'}">
                    </button>
                    <button class="btn-secondary btn-sm" onclick="settingsManager.editRssSource(${index})" title="编辑">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-secondary btn-sm" onclick="settingsManager.deleteRssSource(${index})" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * 渲染定时任务设置
     */
    renderScheduleSettings() {
        this.updateScheduleDisplay();
    }
    
    /**
     * 更新定时任务显示
     */
    updateScheduleDisplay() {
        const autoUpdateEnabled = document.getElementById('autoUpdateEnabled');
        const nextExecutionTime = document.getElementById('nextExecutionTime');
        
        if (autoUpdateEnabled) {
            autoUpdateEnabled.checked = this.data.schedule.autoUpdateEnabled;
        }
        
        // 渲染更新时间列表
        this.renderUpdateTimesList();
        
        // 更新下次执行时间显示
        if (nextExecutionTime && this.data.schedule.nextExecution) {
            try {
                const nextTime = new Date(this.data.schedule.nextExecution);
                if (isNaN(nextTime.getTime()) || this.data.schedule.nextExecution === '无法计算') {
                    nextExecutionTime.textContent = '无法计算';
                } else {
                    nextExecutionTime.textContent = nextTime.toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit'
                    });
                }
            } catch (error) {
                nextExecutionTime.textContent = '无法计算';
            }
        } else if (nextExecutionTime) {
            nextExecutionTime.textContent = '未设置';
        }
    }
    
    /**
     * 渲染更新时间列表
     */
    renderUpdateTimesList() {
        const container = document.getElementById('updateTimesList');
        if (!container) return;
        
        const times = this.data.schedule.updateTimes || [];
        
        if (times.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-clock"></i>
                    <h4>暂无更新时间</h4>
                    <p>点击上方"添加时间"按钮来设置每日自动更新时间</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = times.map((time, index) => `
            <div class="source-item">
                <div class="source-item-info">
                    <div class="source-item-name">
                        <i class="fas fa-clock mr-2" style="color: var(--color-primary);"></i>
                        ${time}
                    </div>
                    <div class="source-item-meta">北京时间 • 每日执行</div>
                </div>
                <div class="source-item-actions">
                    <input type="time" value="${time}" onchange="settingsManager.updateTime(${index}, this.value)" 
                           class="time-input mr-2" title="修改时间">
                    <button class="btn-secondary btn-sm" onclick="settingsManager.removeUpdateTime(${index})" title="删除">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    /**
     * HTML转义
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * 隐藏所有添加表单
     */
    hideAllAddForms() {
        document.querySelectorAll('.add-source-form, .edit-source-form').forEach(form => {
            form.remove();
        });
    }
    
    // API源管理方法
    addApiSource() {
        const container = document.getElementById('apiSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        this.hideAllAddForms();
        
        const formHtml = `
            <div class="add-source-form show">
                <div class="form-group">
                    <label>源ID</label>
                    <input type="text" id="newApiSourceId" placeholder="例如: bbc-news" required>
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input type="text" id="newApiSourceName" placeholder="例如: BBC News" required>
                </div>
                <div class="form-group">
                    <label>每次获取文章数</label>
                    <input type="number" id="newApiSourceMaxArticles" value="10" min="1" max="100" placeholder="10">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-secondary btn-sm" onclick="settingsManager.hideAllAddForms()">
                        <i class="fas fa-times mr-1"></i>取消
                    </button>
                    <button type="button" class="btn-primary btn-sm" onclick="settingsManager.saveApiSource()">
                        <i class="fas fa-plus mr-1"></i>添加
                    </button>
                </div>
            </div>
        `;
        
        container.insertAdjacentHTML('afterbegin', formHtml);
    }
    
    saveApiSource() {
        const id = document.getElementById('newApiSourceId').value.trim();
        const name = document.getElementById('newApiSourceName').value.trim();
        const maxArticles = parseInt(document.getElementById('newApiSourceMaxArticles').value) || 10;
        
        if (!id || !name) {
            toastManager.show('请填写所有必填字段', 'warning');
            return;
        }
        
        if (maxArticles < 1 || maxArticles > 100) {
            toastManager.show('每次获取文章数必须在1-100之间', 'warning');
            return;
        }
        
        // 检查是否已存在
        if (this.data.apiSources.some(source => source.id === id)) {
            toastManager.show('该源ID已存在', 'warning');
            return;
        }
        
        this.data.apiSources.push({
            id: id,
            name: name,
            maxArticles: maxArticles,
            enabled: true
        });
        
        this.hideAllAddForms();
        this.renderApiSources();
        this.markAsChanged();
        // toastManager.show('API源添加成功', 'success'); // 减少不必要的通知
    }
    
    toggleApiSource(index) {
        this.data.apiSources[index].enabled = !this.data.apiSources[index].enabled;
        this.renderApiSources();
        this.markAsChanged();
        
        const status = this.data.apiSources[index].enabled ? '启用' : '禁用';
        // toastManager.show(`API源已${status}`, 'success'); // 减少不必要的通知
    }
    
    deleteApiSource(index) {
        if (confirm('确定要删除这个API源吗？')) {
            const source = this.data.apiSources[index];
            this.data.apiSources.splice(index, 1);
            this.renderApiSources();
            this.markAsChanged();
            // toastManager.show(`已删除API源: ${source.name}`, 'success'); // 减少不必要的通知
        }
    }
    
    editApiSource(index) {
        const source = this.data.apiSources[index];
        const container = document.getElementById('apiSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        this.hideAllAddForms();
        
        const formHtml = `
            <div class="edit-source-form show" data-index="${index}">
                <div class="form-group">
                    <label>源ID</label>
                    <input type="text" id="editApiSourceId" value="${this.escapeHtml(source.id)}" placeholder="例如: bbc-news" required>
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input type="text" id="editApiSourceName" value="${this.escapeHtml(source.name)}" placeholder="例如: BBC News" required>
                </div>
                <div class="form-group">
                    <label>每次获取文章数</label>
                    <input type="number" id="editApiSourceMaxArticles" value="${source.maxArticles || 10}" min="1" max="100" placeholder="10">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-secondary btn-sm" onclick="settingsManager.hideAllAddForms()">
                        <i class="fas fa-times mr-1"></i>取消
                    </button>
                    <button type="button" class="btn-primary btn-sm" onclick="settingsManager.saveEditApiSource(${index})">
                        <i class="fas fa-save mr-1"></i>保存
                    </button>
                </div>
            </div>
        `;
        
        const sourceItems = container.querySelectorAll('.source-item');
        if (sourceItems[index]) {
            sourceItems[index].insertAdjacentHTML('afterend', formHtml);
        }
    }
    
    saveEditApiSource(index) {
        const id = document.getElementById('editApiSourceId').value.trim();
        const name = document.getElementById('editApiSourceName').value.trim();
        const maxArticles = parseInt(document.getElementById('editApiSourceMaxArticles').value) || 10;
        
        if (!id || !name) {
            toastManager.show('请填写所有必填字段', 'warning');
            return;
        }
        
        if (maxArticles < 1 || maxArticles > 100) {
            toastManager.show('每次获取文章数必须在1-100之间', 'warning');
            return;
        }
        
        // 检查ID是否与其他源重复（排除当前编辑的源）
        const isDuplicate = this.data.apiSources.some((source, idx) => 
            idx !== index && source.id === id
        );
        
        if (isDuplicate) {
            toastManager.show('该源ID已存在', 'warning');
            return;
        }
        
        this.data.apiSources[index].id = id;
        this.data.apiSources[index].name = name;
        this.data.apiSources[index].maxArticles = maxArticles;
        
        this.hideAllAddForms();
        this.renderApiSources();
        this.markAsChanged();
        // toastManager.show('API源已更新', 'success'); // 减少不必要的通知
    }
    
    // RSS源管理方法
    addRssSource() {
        const container = document.getElementById('rssSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        this.hideAllAddForms();
        
        const formHtml = `
            <div class="add-source-form show">
                <div class="form-group">
                    <label>RSS URL</label>
                    <input type="url" id="newRssSourceUrl" placeholder="https://example.com/rss.xml" required>
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input type="text" id="newRssSourceName" placeholder="例如: 示例新闻RSS" required>
                </div>
                <div class="form-group">
                    <label>每次获取文章数</label>
                    <input type="number" id="newRssSourceMaxArticles" value="10" min="1" max="100" placeholder="10">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-secondary btn-sm" onclick="settingsManager.hideAllAddForms()">
                        <i class="fas fa-times mr-1"></i>取消
                    </button>
                    <button type="button" class="btn-primary btn-sm" onclick="settingsManager.saveRssSource()">
                        <i class="fas fa-plus mr-1"></i>添加
                    </button>
                </div>
            </div>
        `;
        
        container.insertAdjacentHTML('afterbegin', formHtml);
    }
    
    saveRssSource() {
        const url = document.getElementById('newRssSourceUrl').value.trim();
        const name = document.getElementById('newRssSourceName').value.trim();
        const maxArticles = parseInt(document.getElementById('newRssSourceMaxArticles').value) || 10;
        
        if (!url || !name) {
            toastManager.show('请填写所有必填字段', 'warning');
            return;
        }
        
        if (maxArticles < 1 || maxArticles > 100) {
            toastManager.show('每次获取文章数必须在1-100之间', 'warning');
            return;
        }
        
        // 检查是否已存在
        if (this.data.rssSources.some(source => source.url === url)) {
            toastManager.show('该RSS URL已存在', 'warning');
            return;
        }
        
        this.data.rssSources.push({
            url: url,
            name: name,
            maxArticles: maxArticles,
            enabled: true
        });
        
        this.hideAllAddForms();
        this.renderRssSources();
        this.markAsChanged();
        // toastManager.show('RSS源添加成功', 'success'); // 减少不必要的通知
    }
    
    toggleRssSource(index) {
        this.data.rssSources[index].enabled = !this.data.rssSources[index].enabled;
        this.renderRssSources();
        this.markAsChanged();
        
        const status = this.data.rssSources[index].enabled ? '启用' : '禁用';
        // toastManager.show(`RSS源已${status}`, 'success'); // 减少不必要的通知
    }
    
    deleteRssSource(index) {
        if (confirm('确定要删除这个RSS源吗？')) {
            const source = this.data.rssSources[index];
            this.data.rssSources.splice(index, 1);
            this.renderRssSources();
            this.markAsChanged();
            // toastManager.show(`已删除RSS源: ${source.name}`, 'success'); // 减少不必要的通知
        }
    }
    
    editRssSource(index) {
        const source = this.data.rssSources[index];
        const container = document.getElementById('rssSourcesList');
        
        // 如果容器不存在（在简化UI中），直接返回
        if (!container) {
            return;
        }
        
        this.hideAllAddForms();
        
        const formHtml = `
            <div class="edit-source-form show" data-index="${index}">
                <div class="form-group">
                    <label>RSS URL</label>
                    <input type="url" id="editRssSourceUrl" value="${this.escapeHtml(source.url)}" placeholder="https://example.com/rss.xml" required>
                </div>
                <div class="form-group">
                    <label>显示名称</label>
                    <input type="text" id="editRssSourceName" value="${this.escapeHtml(source.name)}" placeholder="例如: 示例新闻RSS" required>
                </div>
                <div class="form-group">
                    <label>每次获取文章数</label>
                    <input type="number" id="editRssSourceMaxArticles" value="${source.maxArticles || 10}" min="1" max="100" placeholder="10">
                </div>
                <div class="form-actions">
                    <button type="button" class="btn-secondary btn-sm" onclick="settingsManager.hideAllAddForms()">
                        <i class="fas fa-times mr-1"></i>取消
                    </button>
                    <button type="button" class="btn-primary btn-sm" onclick="settingsManager.saveEditRssSource(${index})">
                        <i class="fas fa-save mr-1"></i>保存
                    </button>
                </div>
            </div>
        `;
        
        const sourceItems = container.querySelectorAll('.source-item');
        if (sourceItems[index]) {
            sourceItems[index].insertAdjacentHTML('afterend', formHtml);
        }
    }
    
    saveEditRssSource(index) {
        const url = document.getElementById('editRssSourceUrl').value.trim();
        const name = document.getElementById('editRssSourceName').value.trim();
        const maxArticles = parseInt(document.getElementById('editRssSourceMaxArticles').value) || 10;
        
        if (!url || !name) {
            toastManager.show('请填写所有必填字段', 'warning');
            return;
        }
        
        if (maxArticles < 1 || maxArticles > 100) {
            toastManager.show('每次获取文章数必须在1-100之间', 'warning');
            return;
        }
        
        // 检查URL是否与其他源重复（排除当前编辑的源）
        const isDuplicate = this.data.rssSources.some((source, idx) => 
            idx !== index && source.url === url
        );
        
        if (isDuplicate) {
            toastManager.show('该RSS URL已存在', 'warning');
            return;
        }
        
        this.data.rssSources[index].url = url;
        this.data.rssSources[index].name = name;
        this.data.rssSources[index].maxArticles = maxArticles;
        
        this.hideAllAddForms();
        this.renderRssSources();
        this.markAsChanged();
        // toastManager.show('RSS源已更新', 'success'); // 减少不必要的通知
    }
    
    // 定时任务管理方法
    toggleAutoUpdate() {
        this.data.schedule.autoUpdateEnabled = !this.data.schedule.autoUpdateEnabled;
        this.markAsChanged();
    }
    
    addUpdateTime() {
        const newTime = '06:00';
        this.data.schedule.updateTimes.push(newTime);
        this.renderUpdateTimesList();
        this.markAsChanged();
    }
    
    updateTime(index, newTime) {
        if (newTime && /^\d{2}:\d{2}$/.test(newTime)) {
            this.data.schedule.updateTimes[index] = newTime;
            this.markAsChanged();
        }
    }
    
    removeUpdateTime(index) {
        if (confirm('确定要删除这个更新时间吗？')) {
            this.data.schedule.updateTimes.splice(index, 1);
            this.renderUpdateTimesList();
            this.markAsChanged();
        }
    }
    
    // 关键词过滤管理方法
    renderFilterSettings() {
        // 加载过滤设置
        const keywordFilterEnabledInput = document.getElementById('keywordFilterEnabled');
        const filterTitleInput = document.getElementById('filterTitle');
        const filterContentInput = document.getElementById('filterContent');
        const filterSourceInput = document.getElementById('filterSource');
        
        if (keywordFilterEnabledInput) {
            keywordFilterEnabledInput.checked = this.data.filter.keywordFilterEnabled || false;
        }
        if (filterTitleInput) {
            filterTitleInput.checked = this.data.filter.filterTitle !== false;
        }
        if (filterContentInput) {
            filterContentInput.checked = this.data.filter.filterContent !== false;
        }
        if (filterSourceInput) {
            filterSourceInput.checked = this.data.filter.filterSource || false;
        }
        
        this.renderKeywordsList();
    }
    
    renderKeywordsList() {
        const container = document.getElementById('keywordsList');
        if (!container) return;
        
        if (!this.data.filter.keywords || this.data.filter.keywords.length === 0) {
            container.innerHTML = `
                <div class="text-center py-4" style="color: var(--text-secondary);">
                    <i class="fas fa-filter text-2xl mb-2 opacity-50"></i>
                    <p class="text-sm">暂无屏蔽关键词</p>
                </div>
            `;
            return;
        }
        
        container.innerHTML = this.data.filter.keywords.map((keyword, index) => `
            <div class="flex items-center justify-between p-3 rounded-lg" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">
                <span class="text-sm" style="color: var(--text-primary);">${this.escapeHtml(keyword)}</span>
                <button onclick="settingsManager.removeKeyword(${index})" class="btn-secondary btn-sm" title="删除关键词">
                    <i class="fas fa-times"></i>
                </button>
            </div>
        `).join('');
    }
    
    toggleKeywordFilter() {
        this.data.filter.keywordFilterEnabled = !this.data.filter.keywordFilterEnabled;
        this.markAsChanged();
    }
    
    addKeyword() {
        const input = document.getElementById('newKeywordInput');
        if (!input) return;
        
        const keyword = input.value.trim();
        if (!keyword) {
            toastManager.show('请输入关键词', 'warning');
            return;
        }
        
        if (this.data.filter.keywords.includes(keyword)) {
            toastManager.show('该关键词已存在', 'warning');
            return;
        }
        
        this.data.filter.keywords.push(keyword);
        input.value = '';
        this.renderKeywordsList();
        this.markAsChanged();
    }
    
    removeKeyword(index) {
        if (confirm('确定要删除这个关键词吗？')) {
            this.data.filter.keywords.splice(index, 1);
            this.renderKeywordsList();
            this.markAsChanged();
        }
    }
    
    // 网页抓取源管理方法
    toggleWebScraping() {
        const webScrapingEnabled = document.getElementById('webScrapingEnabled');
        if (webScrapingEnabled) {
            // 初始化网页抓取配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: false,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },



                    }
                };
            }
            
            this.data.webScraping.enabled = webScrapingEnabled.checked;
            this.markAsChanged();
            
            // 如果禁用网页抓取，同时禁用所有子源
            if (!webScrapingEnabled.checked) {
                const apNewsEnabled = document.getElementById('apNewsEnabled');
                
                if (apNewsEnabled) apNewsEnabled.checked = false;
                this.data.webScraping.sources.apNews.enabled = false;
            }
        }
    }
    
    toggleApNews() {
        const apNewsEnabled = document.getElementById('apNewsEnabled');
        const apNewsMaxArticles = document.getElementById('apNewsMaxArticles');
        
        if (apNewsEnabled) {
            // 初始化配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },



                    }
                };
            }
            
            this.data.webScraping.sources.apNews.enabled = apNewsEnabled.checked;
            if (apNewsMaxArticles) {
                this.data.webScraping.sources.apNews.maxArticles = parseInt(apNewsMaxArticles.value) || 5;
            }
            
            // 如果启用了AP News，确保网页抓取总开关也开启
            if (apNewsEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }
    

    

    

    
    toggleJapanToday() {
        const japanTodayEnabled = document.getElementById('japanTodayEnabled');
        const japanTodayMaxArticles = document.getElementById('japanTodayMaxArticles');
        
        if (japanTodayEnabled) {
            // 初始化配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },

                        japanToday: { enabled: false, maxArticles: 5 },
                        foxNews: { enabled: false, maxArticles: 5 },
                        alJazeera: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            // 确保sources对象存在
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    apNews: { enabled: false, maxArticles: 5 },

                    japanToday: { enabled: false, maxArticles: 5 },
                    foxNews: { enabled: false, maxArticles: 5 },
                    alJazeera: { enabled: false, maxArticles: 5 }
                };
            }
            
            // 确保japanToday对象存在
            if (!this.data.webScraping.sources.japanToday) {
                this.data.webScraping.sources.japanToday = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.japanToday.enabled = japanTodayEnabled.checked;
            if (japanTodayMaxArticles) {
                this.data.webScraping.sources.japanToday.maxArticles = parseInt(japanTodayMaxArticles.value) || 5;
            }
            
            // 如果启用了Japan Today，确保网页抓取总开关也开启
            if (japanTodayEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }
    
    toggleFoxNews() {
        const foxNewsEnabled = document.getElementById('foxNewsEnabled');
        const foxNewsMaxArticles = document.getElementById('foxNewsMaxArticles');
        
        if (foxNewsEnabled) {
            // 初始化配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },

                        japanToday: { enabled: false, maxArticles: 5 },
                        foxNews: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            // 确保sources对象存在
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    apNews: { enabled: false, maxArticles: 5 },


                    japanToday: { enabled: false, maxArticles: 5 },
                    foxNews: { enabled: false, maxArticles: 5 }
                };
            }
            
            // 确保foxNews对象存在
            if (!this.data.webScraping.sources.foxNews) {
                this.data.webScraping.sources.foxNews = { enabled: false, maxArticles: 5 };
            }
            if (!this.data.webScraping.sources.alJazeera) {
                this.data.webScraping.sources.alJazeera = { enabled: false, maxArticles: 5 };
            }
            if (!this.data.webScraping.sources.alJazeera) {
                this.data.webScraping.sources.alJazeera = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.foxNews.enabled = foxNewsEnabled.checked;
            if (foxNewsMaxArticles) {
                this.data.webScraping.sources.foxNews.maxArticles = parseInt(foxNewsMaxArticles.value) || 5;
            }
            
            // 如果启用了Fox News，确保网页抓取总开关也开启
            if (foxNewsEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }
    
    toggleAlJazeera() {
        const alJazeeraEnabled = document.getElementById('alJazeeraEnabled');
        const alJazeeraMaxArticles = document.getElementById('alJazeeraMaxArticles');
        
        if (alJazeeraEnabled) {
            // 初始化配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },


                        japanToday: { enabled: false, maxArticles: 5 },
                        foxNews: { enabled: false, maxArticles: 5 },
                        alJazeera: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            // 确保sources对象存在
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    apNews: { enabled: false, maxArticles: 5 },


                    japanToday: { enabled: false, maxArticles: 5 },
                    foxNews: { enabled: false, maxArticles: 5 },
                    alJazeera: { enabled: false, maxArticles: 5 }
                };
            }
            
            // 确保alJazeera对象存在
            if (!this.data.webScraping.sources.alJazeera) {
                this.data.webScraping.sources.alJazeera = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.alJazeera.enabled = alJazeeraEnabled.checked;
            if (alJazeeraMaxArticles) {
                this.data.webScraping.sources.alJazeera.maxArticles = parseInt(alJazeeraMaxArticles.value) || 5;
            }
            
            // 如果启用了Al Jazeera，确保网页抓取总开关也开启
            if (alJazeeraEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }

    toggleChannelNewsAsia() {
        const channelNewsAsiaEnabled = document.getElementById('channelNewsAsiaEnabled');
        const channelNewsAsiaMaxArticles = document.getElementById('channelNewsAsiaMaxArticles');
        
        if (channelNewsAsiaEnabled) {
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        channelNewsAsia: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    channelNewsAsia: { enabled: false, maxArticles: 5 }
                };
            }
            
            if (!this.data.webScraping.sources.channelNewsAsia) {
                this.data.webScraping.sources.channelNewsAsia = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.channelNewsAsia.enabled = channelNewsAsiaEnabled.checked;
            if (channelNewsAsiaMaxArticles) {
                this.data.webScraping.sources.channelNewsAsia.maxArticles = parseInt(channelNewsAsiaMaxArticles.value) || 5;
            }
            
            if (channelNewsAsiaEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }

    toggleTaipeiTimes() {
        const taipeiTimesEnabled = document.getElementById('taipeiTimesEnabled');
        const taipeiTimesMaxArticles = document.getElementById('taipeiTimesMaxArticles');
        
        if (taipeiTimesEnabled) {
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        taipeiTimes: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    taipeiTimes: { enabled: false, maxArticles: 5 }
                };
            }
            
            if (!this.data.webScraping.sources.taipeiTimes) {
                this.data.webScraping.sources.taipeiTimes = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.taipeiTimes.enabled = taipeiTimesEnabled.checked;
            if (taipeiTimesMaxArticles) {
                this.data.webScraping.sources.taipeiTimes.maxArticles = parseInt(taipeiTimesMaxArticles.value) || 5;
            }
            
            if (taipeiTimesEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }

    toggleNhkWorld() {
        const nhkWorldEnabled = document.getElementById('nhkWorldEnabled');
        const nhkWorldMaxArticles = document.getElementById('nhkWorldMaxArticles');
        
        if (nhkWorldEnabled) {
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: true,
                    sources: {
                        nhkWorld: { enabled: false, maxArticles: 5 }
                    }
                };
            }
            
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    nhkWorld: { enabled: false, maxArticles: 5 }
                };
            }
            
            if (!this.data.webScraping.sources.nhkWorld) {
                this.data.webScraping.sources.nhkWorld = { enabled: false, maxArticles: 5 };
            }
            
            this.data.webScraping.sources.nhkWorld.enabled = nhkWorldEnabled.checked;
            if (nhkWorldMaxArticles) {
                this.data.webScraping.sources.nhkWorld.maxArticles = parseInt(nhkWorldMaxArticles.value) || 5;
            }
            
            if (nhkWorldEnabled.checked) {
                const webScrapingEnabled = document.getElementById('webScrapingEnabled');
                if (webScrapingEnabled && !webScrapingEnabled.checked) {
                    webScrapingEnabled.checked = true;
                    this.data.webScraping.enabled = true;
                }
            }
            
            this.markAsChanged();
        }
    }


    /**
     * 重置配置
     */
    async reset() {
        if (confirm('确定要重置所有配置吗？这将恢复默认设置。')) {
            await this.loadConfiguration();
            this.switchTab('api');
            // toastManager.show('配置已重置', 'info'); // 减少不必要的通知
        }
    }
    
    /**
     * 保存所有配置
     */
    async save() {
        if (this.isLoading) {
            toastManager.show('正在处理中，请稍候...', 'warning');
            return;
        }
        
        this.isLoading = true;
        
        try {
            // 更新News API Key和配置
            const newsApiKeyInput = document.getElementById('newsApiKey');
            const newsApiEnabledInput = document.getElementById('newsApiEnabled');
            const newsApiMaxArticlesInput = document.getElementById('newsApiMaxArticles');
            
            if (newsApiKeyInput) {
                this.data.settings.newsApiKey = newsApiKeyInput.value.trim();
            }
            if (newsApiEnabledInput) {
                this.data.settings.newsApiEnabled = newsApiEnabledInput.checked;
            }
            if (newsApiMaxArticlesInput) {
                this.data.settings.newsApiMaxArticles = parseInt(newsApiMaxArticlesInput.value) || 20;
            }
            
            // 更新Gnews配置（简化版）
            const gnewsApiKeyInput = document.getElementById('gnewsApiKey');
            const gnewsEnabledInput = document.getElementById('gnewsEnabled');
            const gnewsMaxArticlesInput = document.getElementById('gnewsMaxArticles');

            if (gnewsApiKeyInput) {
                this.data.gnews.apiKey = gnewsApiKeyInput.value.trim();
            }
            if (gnewsEnabledInput) {
                this.data.gnews.enabled = gnewsEnabledInput.checked;
            }
            if (gnewsMaxArticlesInput) {
                this.data.gnews.maxArticles = parseInt(gnewsMaxArticlesInput.value) || 10;
            }

            // 更新AI配置
            const aiApiKeyInput = document.getElementById('aiApiKey');
            const aiBaseUrlInput = document.getElementById('aiBaseUrl');
            const aiModelInput = document.getElementById('aiModel');
            const aiRateLimitRpmInput = document.getElementById('aiRateLimitRpm');
            const aiRateLimitBurstInput = document.getElementById('aiRateLimitBurst');

            if (aiApiKeyInput) {
                this.data.aiConfig.apiKey = aiApiKeyInput.value.trim();
            }
            if (aiBaseUrlInput) {
                this.data.aiConfig.baseUrl = aiBaseUrlInput.value.trim();
            }
            if (aiModelInput) {
                this.data.aiConfig.model = aiModelInput.value.trim();
            }
            if (aiRateLimitRpmInput) {
                this.data.aiConfig.rateLimitRpm = parseInt(aiRateLimitRpmInput.value) || 60;
            }
            if (aiRateLimitBurstInput) {
                this.data.aiConfig.rateLimitBurst = parseInt(aiRateLimitBurstInput.value) || 10;
            }

            // 更新过滤设置
            const keywordFilterEnabledInput = document.getElementById('keywordFilterEnabled');
            const filterTitleInput = document.getElementById('filterTitle');
            const filterContentInput = document.getElementById('filterContent');
            const filterSourceInput = document.getElementById('filterSource');

            if (keywordFilterEnabledInput) {
                this.data.filter.keywordFilterEnabled = keywordFilterEnabledInput.checked;
            }
            if (filterTitleInput) {
                this.data.filter.filterTitle = filterTitleInput.checked;
            }
            if (filterContentInput) {
                this.data.filter.filterContent = filterContentInput.checked;
            }
            if (filterSourceInput) {
                this.data.filter.filterSource = filterSourceInput.checked;
            }

            // 更新网页抓取设置
            const webScrapingEnabledInput = document.getElementById('webScrapingEnabled');
            const apNewsEnabledInput = document.getElementById('apNewsEnabled');

            const japanTodayEnabledInput = document.getElementById('japanTodayEnabled');
            const japanTodayMaxArticlesInput = document.getElementById('japanTodayMaxArticles');
            const foxNewsEnabledInput = document.getElementById('foxNewsEnabled');
            const foxNewsMaxArticlesInput = document.getElementById('foxNewsMaxArticles');
            const alJazeeraEnabledInput = document.getElementById('alJazeeraEnabled');
            const alJazeeraMaxArticlesInput = document.getElementById('alJazeeraMaxArticles');


            // 初始化网页抓取配置如果不存在
            if (!this.data.webScraping) {
                this.data.webScraping = {
                    enabled: false,
                    sources: {
                        apNews: { enabled: false, maxArticles: 5 },


                        japanToday: { enabled: false, maxArticles: 5 },
                        foxNews: { enabled: false, maxArticles: 5 },
                        alJazeera: { enabled: false, maxArticles: 5 }
                    }
                };
            }

            // 确保sources对象存在
            if (!this.data.webScraping.sources) {
                this.data.webScraping.sources = {
                    apNews: { enabled: false, maxArticles: 5 },


                    japanToday: { enabled: false, maxArticles: 5 },
                    foxNews: { enabled: false, maxArticles: 5 },
                    alJazeera: { enabled: false, maxArticles: 5 }
                };
            }

            // 确保每个抓取器对象存在
            if (!this.data.webScraping.sources.apNews) {
                this.data.webScraping.sources.apNews = { enabled: false, maxArticles: 5 };
            }

            if (!this.data.webScraping.sources.japanToday) {
                this.data.webScraping.sources.japanToday = { enabled: false, maxArticles: 5 };
            }
            if (!this.data.webScraping.sources.foxNews) {
                this.data.webScraping.sources.foxNews = { enabled: false, maxArticles: 5 };
            }


            if (webScrapingEnabledInput) {
                this.data.webScraping.enabled = webScrapingEnabledInput.checked;
            }

            // 只更新启用状态，maxArticles值已通过updateWebScrapingMaxArticles实时更新到内存
            if (apNewsEnabledInput) {
                this.data.webScraping.sources.apNews.enabled = apNewsEnabledInput.checked;
            }

            if (japanTodayEnabledInput) {
                this.data.webScraping.sources.japanToday.enabled = japanTodayEnabledInput.checked;
            }
            if (foxNewsEnabledInput) {
                this.data.webScraping.sources.foxNews.enabled = foxNewsEnabledInput.checked;
            }
            if (alJazeeraEnabledInput) {
                this.data.webScraping.sources.alJazeera.enabled = alJazeeraEnabledInput.checked;
            }


            // 移除强制设置默认值，保持用户配置或现有值
            // this.data.gnews.category = 'general';
            // this.data.gnews.language = 'en';
            // this.data.gnews.country = 'us';

            // 验证配置
            if (this.data.schedule.autoUpdateEnabled && this.data.schedule.updateTimes.length === 0) {
                toastManager.show('启用自动更新时，至少需要设置一个更新时间', 'warning');
                this.isLoading = false;
                return;
            }

            // 并行保存配置
            const [sourcesResponse, scheduleResponse, aiResponse] = await Promise.all([
                fetch('/api/sources/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        apiSources: this.data.apiSources,
                        rssSources: this.data.rssSources,
                        settings: this.data.settings,
                        gnews: this.data.gnews,
                        filter: this.data.filter,
                        webScraping: this.data.webScraping
                    })
                }),
                fetch('/api/schedule/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        autoUpdateEnabled: this.data.schedule.autoUpdateEnabled,
                        updateFrequency: 'daily',
                        updateTimes: this.data.schedule.updateTimes
                    })
                }),
                fetch('/api/ai/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(this.data.aiConfig)
                })
            ]);

            // 检查响应
            if (!sourcesResponse.ok) {
                const error = await sourcesResponse.text();
                throw new Error('保存新闻源配置失败: ' + error);
            }

            if (!scheduleResponse.ok) {
                const error = await scheduleResponse.text();
                throw new Error('保存定时任务配置失败: ' + error);
            }

            if (!aiResponse.ok) {
                const error = await aiResponse.text();
                throw new Error('保存AI配置失败: ' + error);
            }

            // 保存成功
            this.hasUnsavedChanges = false;
            this.updateSaveButtonState();
            // toastManager.show('配置保存成功', 'success'); // 减少不必要的通知，保留错误提示
            this.close();
            
        } catch (error) {
            console.error('保存配置时出错:', error);
            toastManager.show(error.message || '保存配置时出错', 'error');
        } finally {
            this.isLoading = false;
        }
    }
}

// 创建全局实例
const settingsManager = new SettingsManager();

// 兼容性函数 - 保持与现有代码的兼容性
function openSourceManager() {
    settingsManager.open();
}

function closeSourceManager() {
    settingsManager.close();
}

function switchSourceTab(tabName) {
    settingsManager.switchTab(tabName);
}

function addApiSource() {
    settingsManager.addApiSource();
}

function addRssSource() {
    settingsManager.addRssSource();
}

function resetSources() {
    settingsManager.reset();
}

function saveSources() {
    settingsManager.save();
}

function toggleAutoUpdate() {
    settingsManager.toggleAutoUpdate();
}

function addUpdateTime() {
    settingsManager.addUpdateTime();
}

// 导出设置管理器
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SettingsManager;
}

// 全局函数 - 用于AI模板应用
function applyAiTemplate(templateName) {
    settingsManager.applyAiTemplate(templateName);
}