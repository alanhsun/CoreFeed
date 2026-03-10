// 主要的JavaScript功能

// Socket.IO连接配置
const socket = io({
    transports: ['websocket', 'polling'],
    timeout: 20000,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    maxReconnectionAttempts: 10,
    forceNew: false
});

// 深色模式状态
let isDarkMode = localStorage.getItem('darkMode') === 'true';
// 深色模式初始化

// 初始化深色模式
function initTheme() {
    const body = document.body;
    const themeIcon = document.getElementById('themeIcon');
    const themeText = document.getElementById('themeText');
    
    if (isDarkMode) {
        body.setAttribute('data-theme', 'dark');
        if (themeIcon) themeIcon.className = 'fas fa-sun group-hover:scale-110 transition-all duration-300';
        if (themeText) themeText.textContent = '浅色';
    } else {
        body.removeAttribute('data-theme');
        if (themeIcon) themeIcon.className = 'fas fa-moon group-hover:scale-110 transition-all duration-300';
        if (themeText) themeText.textContent = '深色';
    }
}

// 切换深色模式
function toggleTheme() {
    isDarkMode = !isDarkMode;
    localStorage.setItem('darkMode', isDarkMode.toString());
    // 深色模式切换
    initTheme();
    
    // 添加切换动画效果
    document.body.style.transition = 'background-color 0.3s ease, color 0.3s ease';
    setTimeout(() => {
        document.body.style.transition = '';
    }, 300);
    
    // 强制重绘以确保样式更新
    document.body.offsetHeight;
}

// Socket.IO连接状态监听（仅控制台日志）
socket.on('connect', () => {
    // WebSocket连接成功
});

socket.on('disconnect', (reason) => {
    // WebSocket连接断开
});

// 标记是否是服务重启导致的断开连接
let isServiceRestarting = false;

socket.on('reconnect', (attemptNumber) => {
    // WebSocket重新连接成功
    
    // 如果是服务重启导致的重连，显示特殊提示
    if (isServiceRestarting) {
// toastManager.show('服务重启完成，连接已恢复。如需查看最新状态请手动刷新页面', 'success', { duration: 5000 });
        
        // 不再自动重新加载页面数据
        // setTimeout(() => {
        //     location.reload();
        // }, 1000);
        
        isServiceRestarting = false;
    }
});

socket.on('reconnect_attempt', (attemptNumber) => {
    // 正在尝试重新连接
});

socket.on('reconnect_error', (error) => {
    // 重连失败
});

socket.on('reconnect_failed', () => {
    // 重连失败，已达到最大尝试次数
});

socket.on('connect_error', (error) => {
    // WebSocket连接错误
});

// 处理服务器发送的连接确认
socket.on('connected', (data) => {
    // 收到服务器连接确认
});

// 处理配置更新通知
socket.on('config-updated', (data) => {
    // 收到配置更新通知
    // 不需要重新加载配置，因为前端的sourceManagerData已经是最新的
    // 这避免了用户刚添加源后被服务器配置覆盖的问题
    // 移除重复的toast通知，因为saveSources函数已经显示了成功消息
    // toastManager.show(data.message || '配置已更新', 'success');
});

// 处理配置重载错误通知
socket.on('config-reload-error', (data) => {
    // 配置重载错误
    toastManager.show(data.message || '配置重载失败', 'error');
});

// 处理定时任务配置更新通知
socket.on('schedule-config-updated', (data) => {
    // 收到定时任务配置更新通知
    // 移除重复的toast通知，因为saveScheduleConfigWithTimes函数已经显示了成功消息
    // toastManager.show(data.message || '定时任务配置已更新', 'success');
    
    // 重新加载配置并更新UI显示
    loadScheduleConfiguration().then(config => {
        updateScheduleConfigDisplay(config);
    }).catch(error => {
        console.error('重新加载定时任务配置失败:', error);
    });
});

// 处理定时任务配置重载错误通知
socket.on('schedule-config-reload-error', (data) => {
    // 定时任务配置重载错误
    toastManager.show(data.message || '定时任务配置重载失败', 'error');
});

// 定期发送心跳检测
setInterval(() => {
    if (socket.connected) {
        socket.emit('ping');
    }
}, 30000);

// 定期检查页面版本（降低频率，避免频繁提示）
let versionCheckCount = 0;
setInterval(() => {
    versionCheckCount++;
    // 只在前3次检查时提示版本更新，之后静默检查
    if (versionCheckCount <= 3) {
        checkPageVersion();
    } else {
        // 静默检查版本，不显示提示
        checkPageVersionSilent();
    }
}, 300000); // 改为每5分钟检查一次

// 页面加载完成后检查版本
document.addEventListener('DOMContentLoaded', () => {
    // 延迟5秒后进行首次版本检查
    setTimeout(() => {
        checkPageVersion();
    }, 5000);
});

// 处理心跳响应
socket.on('pong', () => {
    // 收到心跳响应
});

// 进度更新功能已移除，使用简单Toast通知代替

// 监听新闻更新完成
socket.on('news-updated', (data) => {
    // 收到新闻更新完成事件
    // 重置状态
    updateSummaryStatus('正在生成...');
    updatePodcastStatus('正在生成...');
    currentSummaryData = null;
    currentPodcast = null;
    // 不立即刷新页面，等待所有生成完成
});

// 监听所有生成完成
socket.on('all-generation-completed', (data) => {
    // 显示完成提示，但不自动刷新页面
    // toastManager.show('所有内容生成完成！点击刷新按钮查看最新内容', 'success', { duration: 5000 });
    // setTimeout(() => {
    //     window.location.reload();
    // }, 1500); // 显示完成状态1.5秒后刷新页面
});

// 监听摘要生成进度
socket.on('summary-progress', (data) => {
    updateSummaryProgress(data);
});

// 监听音频生成进度
socket.on('podcast-progress', (data) => {
    updatePodcastProgress(data);
});

// 监听缓存刷新完成事件
    socket.on('cache-refreshed', (data) => {
        if (data.success) {
            // 更新页面版本号
            const versionMeta = document.querySelector('meta[name="app-version"]');
            if (versionMeta && data.newVersion) {
                versionMeta.setAttribute('content', data.newVersion);
                console.log('页面版本号已更新:', data.newVersion);
            }
            
            // 显示缓存刷新成功提示
            toastManager.show('缓存已刷新，数据已更新', 'success', { duration: 3000 });
            
            // 重新检查是否有更多新闻
            setTimeout(() => {
                checkAndShowLoadMoreButton();
            }, 1000);
        }
    });

    // 监听音频生成完成
    socket.on('podcast-completed', (data) => {
        setTimeout(() => {
            const modal = document.getElementById('podcastModal');
            modal.classList.add('hidden');
            currentPodcast = data.podcast;
            updatePodcastStatus('已完成');
            openPodcastPlayer();
    }, 1000);
});

// 监听音频生成错误
socket.on('podcast-error', (data) => {
    const modal = document.getElementById('podcastModal');
    modal.classList.add('hidden');
    toastManager.show('音频生成失败: ' + data.error, 'error');
});

// 监听摘要生成完成
socket.on('summary-completed', (data) => {
    setTimeout(() => {
        // 更新数据和状态
        currentSummaryData = data.article;
        updateSummaryStatus('已完成');
        hideSummaryLoading();
    }, 1000);
});

// 监听摘要生成错误
socket.on('summary-error', (data) => {
    hideSummaryLoading();
    toastManager.show('摘要生成失败: ' + data.error, 'error');
});







// 简化的加载管理器 - 仅用于摘要和音频生成
class LoadingManager {
    constructor() {
        this.overlay = null;
        this.isVisible = false;
        this.init();
    }

    init() {
        // 创建简化的加载覆盖层
        this.overlay = document.createElement('div');
        this.overlay.className = 'loading-overlay';
        this.overlay.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner"></div>
                <div class="loading-title">加载中...</div>
                <div class="loading-message">请稍候</div>
                <div class="loading-progress" style="display: none;">
                    <div class="progress-detail">
                        <span class="progress-stage">准备中</span>
                        <span class="progress-percentage">0%</span>
                    </div>
                    <div class="progress-container">
                        <div class="progress-bar" style="width: 0%;"></div>
                    </div>
                    <div class="progress-text">正在初始化...</div>
                </div>
            </div>
        `;
        document.body.appendChild(this.overlay);
    }

    show(title = '加载中...', message = '请稍候') {
        const titleEl = this.overlay.querySelector('.loading-title');
        const messageEl = this.overlay.querySelector('.loading-message');
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        
        this.overlay.classList.add('show');
        this.isVisible = true;
    }

    hide() {
        this.overlay.classList.remove('show');
        this.isVisible = false;
        
        // 重置进度
        setTimeout(() => {
            this.updateProgress(0, '正在初始化...', '准备中');
        }, 300);
    }

    updateProgress(progress, detail = '', stage = '') {
        const progressContainer = this.overlay.querySelector('.loading-progress');
        const progressBar = this.overlay.querySelector('.progress-bar');
        const progressText = this.overlay.querySelector('.progress-text');
        const progressStage = this.overlay.querySelector('.progress-stage');
        const progressPercentage = this.overlay.querySelector('.progress-percentage');
        
        if (progress > 0 || detail || stage) {
            progressContainer.style.display = 'block';
            
            // 更新进度条
            if (progress > 0) {
                progressBar.style.width = progress + '%';
                progressPercentage.textContent = `${progress}%`;
            }
            
            // 更新阶段信息
            if (stage) {
                progressStage.textContent = stage;
            }
            
            // 更新详细信息
            if (detail) {
                progressText.textContent = detail;
            } else if (progress > 0) {
                progressText.textContent = `进度: ${progress}%`;
            }
        } else {
            progressContainer.style.display = 'none';
        }
    }

    updateContent(title, message, progress = null, detail = '', stage = '') {
        const titleEl = this.overlay.querySelector('.loading-title');
        const messageEl = this.overlay.querySelector('.loading-message');
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        
        if (progress !== null || detail || stage) {
            const stageText = stage || title.replace(/[📡🔍🌐💾📝🎵🎙️✅⏳]/g, '').trim();
            this.updateProgress(progress, detail, stageText);
        }
    }
}

// 全局加载管理器实例
let loadingManager = null;

// 确保在DOM加载完成后初始化LoadingManager
function initLoadingManager() {
    if (!loadingManager) {
        loadingManager = new LoadingManager();
    }
    return loadingManager;
}

// updateProgress函数已移除 - 不再需要复杂的进度显示

// 加载更多新闻功能
function loadMoreNews() {
    const loadMoreBtn = document.getElementById('loadMoreBtn');
    const remainingCount = document.getElementById('remainingCount');
    
    // 禁用按钮并显示加载状态
    loadMoreBtn.disabled = true;
    loadMoreBtn.innerHTML = '<i class="fas fa-spinner fa-spin text-lg"></i><span>加载中...</span>';
    
    fetch('/api/news/more', { cache: 'no-cache' })
        .then(response => response.json())
        .then(data => {
            if (data.success && data.news.length > 0) {
                // 添加新闻到页面
                appendNewsToContainer(data.news);
                
                // 更新按钮状态
                if (data.news.length < data.allTotal - getCurrentNewsCount()) {
                    // 还有更多新闻
                    const remaining = data.allTotal - getCurrentNewsCount() - data.news.length;
                    remainingCount.textContent = `(${remaining})`;
                    loadMoreBtn.disabled = false;
                    loadMoreBtn.innerHTML = '<i class="fas fa-plus-circle text-lg"></i><span>加载更多新闻</span><span id="remainingCount" class="bg-white/20 px-2 py-1 rounded-full text-sm font-medium">('+remaining+')</span>';
                } else {
                    // 没有更多新闻了
                    document.getElementById('loadMoreContainer').style.display = 'none';
                }
                
                toastManager.show(`成功加载 ${data.news.length} 条新闻`, 'success');
            } else {
                // 没有更多新闻
                document.getElementById('loadMoreContainer').style.display = 'none';
                toastManager.show('没有更多新闻了', 'info');
            }
        })
        .catch(error => {
            console.error('加载更多新闻失败:', error);
            toastManager.show('加载失败，请稍后重试', 'error');
            
            // 恢复按钮状态
            loadMoreBtn.disabled = false;
            loadMoreBtn.innerHTML = '<i class="fas fa-plus-circle text-lg"></i><span>加载更多新闻</span><span id="remainingCount" class="bg-white/20 px-2 py-1 rounded-full text-sm font-medium"></span>';
        });
}

// 获取当前页面显示的新闻数量
function getCurrentNewsCount() {
    const newsContainer = document.getElementById('news-container');
    return newsContainer.querySelectorAll('.card').length;
}

// 将新闻添加到容器中
function appendNewsToContainer(newsArray) {
    const newsContainer = document.getElementById('news-container');
    
    newsArray.forEach((article, index) => {
        const newsCard = createNewsCard(article, getCurrentNewsCount() + index);
        newsContainer.appendChild(newsCard);
    });
}

// 创建新闻卡片元素
function createNewsCard(article, index) {
    const cardDiv = document.createElement('div');
    cardDiv.className = 'card group cursor-pointer hover-glow animate-fade-in-up';
    cardDiv.style.animationDelay = `${(index % 10) * 0.1}s`;
    cardDiv.setAttribute('data-url', article.url || '');
    cardDiv.onclick = function() { openNewsUrl(this); };
    
    const imageHtml = article.urlToImage ? 
        `<div class="card__image relative overflow-hidden">
            <img src="${article.urlToImage}" class="w-full h-48 object-cover group-hover:scale-110 transition-transform duration-700" alt="新闻图片">
            <div class="absolute inset-0 bg-gradient-to-t from-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>
            <div class="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity duration-300">
                <div class="w-8 h-8 bg-white/20 backdrop-blur-sm rounded-full flex items-center justify-center">
                    <i class="fas fa-external-link-alt text-white text-xs"></i>
                </div>
            </div>
        </div>` :
        `<div class="card__image w-full h-48 bg-gradient-to-br from-blue-100 to-purple-100 flex items-center justify-center relative overflow-hidden">
            <div class="text-center z-10">
                <i class="fas fa-newspaper text-4xl text-blue-400 mb-2"></i>
                <p class="text-blue-600 text-sm font-medium">新闻资讯</p>
            </div>
            <div class="absolute inset-0 bg-gradient-to-br from-blue-200/50 to-purple-200/50"></div>
        </div>`;
    
    cardDiv.innerHTML = `
        ${imageHtml}
        <div class="card__content p-6 flex flex-col h-full">
            <div class="mb-4">
                <div class="flex items-center space-x-2 mb-3">
                    <span class="news-tag news-tag--source hover-scale">
                        <i class="fas fa-building mr-1 text-xs"></i>
                        ${article.source.name}
                    </span>
                    ${article.region ? `<span class="news-tag news-tag--region hover-scale">
                        <i class="fas fa-map-marker-alt mr-1"></i>
                        ${article.region}
                    </span>` : ''}
                </div>
                <div class="text-sm flex items-center rounded-full px-3 py-1 w-fit backdrop-blur-sm" style="color: var(--text-secondary); background: var(--bg-glass);">
                    <i class="fas fa-clock mr-2 animate-pulse" style="color: var(--accent-color);"></i>
                    ${new Date(article.publishedAt).toLocaleString('zh-CN', { 
                        timeZone: 'Asia/Shanghai',
                        year: 'numeric',
                        month: '2-digit',
                        day: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: false
                    })}
                </div>
            </div>
            
            <h3 class="card__title text-lg font-bold mb-3 line-clamp-2 group-hover:text-blue-600 transition-all duration-300" style="color: var(--text-primary);">
                ${article.translatedTitle || article.title}
            </h3>
            
            <div class="rounded-lg p-3 mb-3 backdrop-blur-sm" style="background: var(--bg-glass); border: 1px solid var(--border-color);">
                <p class="text-xs" style="color: var(--text-secondary);">
                    <strong style="color: var(--text-primary);">原标题:</strong> ${article.title}
                </p>
            </div>
            
            <p class="card__description flex-grow mb-6 line-clamp-3 leading-relaxed" style="color: var(--text-secondary);">
                ${article.summary || article.translatedDescription || article.description}
            </p>
            
            <div class="mt-auto pt-4" style="border-top: 1px solid var(--border-color);">
                <div class="btn btn--primary btn--sm flex items-center justify-center space-x-2 w-full">
                    <span>阅读原文</span>
                    <i class="fas fa-external-link-alt"></i>
                </div>
            </div>
        </div>
    `;
    
    return cardDiv;
}



// 检查页面版本
function checkPageVersion() {
    fetch('/api/version')
    .then(response => response.json())
    .then(data => {
        const currentVersion = document.querySelector('meta[name="app-version"]')?.content;
        
        // 添加调试信息
        console.log('版本检查:', {
            currentVersion: currentVersion,
            serverVersion: data.version,
            timestamp: data.timestamp
        });
        
        if (currentVersion && data.version && currentVersion !== data.version) {
            // 检查是否刚刚进行过缓存刷新或版本提示
            const lastCacheRefresh = sessionStorage.getItem('lastCacheRefresh');
            const lastVersionPrompt = sessionStorage.getItem('lastVersionPrompt');
            const now = Date.now();
            
            // 如果在过去30秒内进行过缓存刷新，则不显示版本提示
            if (lastCacheRefresh && (now - parseInt(lastCacheRefresh)) < 30000) {
                console.log('跳过版本提示：刚刚进行过缓存刷新');
                return;
            }
            
            // 如果在过去10分钟内已经提示过版本更新，则不再重复提示
            if (lastVersionPrompt && (now - parseInt(lastVersionPrompt)) < 600000) {
                console.log('跳过版本提示：最近已经提示过');
                return;
            }
            
            // 记录本次版本提示时间
            sessionStorage.setItem('lastVersionPrompt', now.toString());
            
            // 版本不匹配，自动刷新新闻数据并提示用户
            console.log('检测到版本更新，自动刷新新闻数据');
            
            // 自动刷新新闻数据
            refreshNewsData().then(() => {
                // 更新页面版本号
                const versionMeta = document.querySelector('meta[name="app-version"]');
                if (versionMeta) {
                    versionMeta.setAttribute('content', data.version);
                }
                
                // 显示更新完成提示
                toastManager.show('检测到新版本，新闻数据已自动更新', 'success', {
                    duration: 5000
                });
            }).catch(error => {
                console.error('自动刷新新闻数据失败:', error);
                // 如果自动刷新失败，仍然提示用户手动刷新
                toastManager.show('检测到新版本，建议刷新页面获取最新内容', 'info', {
                    duration: 8000,
                    action: {
                        text: '立即刷新',
                        callback: () => window.location.reload(true)
                    }
                });
            });
        }
    })
    .catch(error => {
        console.error('检查版本失败:', error);
    });
}

// 静默检查页面版本（不显示提示）
function checkPageVersionSilent() {
    fetch('/api/version')
    .then(response => response.json())
    .then(data => {
        const currentVersion = document.querySelector('meta[name="app-version"]')?.content;
        
        // 只记录日志，不显示提示
        console.log('静默版本检查:', {
            currentVersion: currentVersion,
            serverVersion: data.version,
            timestamp: data.timestamp
        });
        
        // 如果版本不同，更新meta标签但不提示用户
        if (currentVersion && data.version && currentVersion !== data.version) {
            const versionMeta = document.querySelector('meta[name="app-version"]');
            if (versionMeta) {
                versionMeta.setAttribute('content', data.version);
                console.log('静默更新页面版本号:', data.version);
            }
        }
    })
    .catch(error => {
        console.error('静默检查版本失败:', error);
    });
}

// 刷新新闻数据（不显示确认提示，用于自动刷新）
function refreshNewsData() {
    return fetch('/api/news', { cache: 'no-cache' })
    .then(response => response.json())
    .then(data => {
        if (data.news && data.news.length > 0) {
            // 更新新闻列表
            updateNewsDisplay(data.news);
            
            // 更新"加载更多"按钮状态
            checkAndShowLoadMoreButton();
            
            console.log('新闻数据已更新:', data.news.length + '条新闻');
            return data;
        } else {
            throw new Error('获取到的新闻数据为空');
        }
    });
}

// 更新新闻显示
function updateNewsDisplay(newsData) {
    const newsContainer = document.getElementById('news-container');
    if (!newsContainer) return;
    
    // 完全清空新闻容器，不保留任何元素
    newsContainer.innerHTML = '';
    
    // 添加新的新闻项
    newsData.forEach((article, index) => {
        const newsItem = createNewsCard(article, index);
        newsContainer.appendChild(newsItem);
    });
}

// 手动获取新闻功能
function refreshNews() {
    // 显示确认提示
    const confirmMessage = '手动获取新闻将会：\n\n' +
        '⏱️ 需要较长时间（通常2-5分钟）\n' +
        '🤖 消耗AI额度进行智能翻译和处理\n' +
        '🌐 获取最新的全球新闻资讯\n\n' +
        '确定要继续获取吗？';
    
    if (!confirm(confirmMessage)) {
        return; // 用户取消，直接返回
    }
    
    // 发起刷新请求
    fetch('/api/refresh', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // 显示简单提示，告知用户5分钟后刷新
            toastManager.show('新闻更新已开始，请在5分钟后刷新网站查看最新内容', 'success', { duration: 3000 }); // 缩短通知时间
        } else {
            toastManager.show('启动更新失败，请稍后重试', 'error');
        }
    })
    .catch(error => {
        console.error('获取新闻失败:', error);
        toastManager.show('网络错误，请检查连接', 'error');
    });
}

// 生成摘要功能
function generateSummary() {
    // 显示加载状态
    initLoadingManager().show('正在生成摘要', 'AI正在分析新闻内容，生成综合摘要...', 0);
    
    fetch('/api/generate-summary', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (!data.success) {
            initLoadingManager().hide();
            toastManager.show('启动摘要生成失败，请稍后重试', 'error');
        }
        // 如果成功，进度更新将通过Socket.IO处理
    })
    .catch(error => {
        console.error('生成摘要失败:', error);
        initLoadingManager().hide();
        toastManager.show('网络错误，请检查连接', 'error');
    });
}

// 更新摘要生成进度
function updateSummaryProgress(data) {
    let title, message, detail = '';
    
    // 根据阶段设置标题和消息
    switch(data.stage) {
        case 'analyzing':
            title = '分析新闻内容';
            message = data.message || '正在分析新闻内容...';
            break;
        case 'grouping':
            title = '按地区分组';
            message = data.message || '正在按地区分组新闻...';
            break;
        case 'summarizing':
            title = '生成摘要内容';
            message = data.message || '正在生成摘要内容...';
            if (data.current && data.total) {
                detail = `${data.current}/${data.total}`;
            }
            break;
        case 'formatting':
            title = '格式化文章';
            message = data.message || '正在格式化文章...';
            break;
        case 'completed':
            title = '摘要生成完成';
            message = '摘要已成功生成';
            setTimeout(() => {
                initLoadingManager().hide();
            }, 1500);
            break;
        default:
            title = '生成摘要';
            message = data.message || '正在处理...';
    }
    
    initLoadingManager().updateContent(title, message, data.progress, detail);
}

// 隐藏摘要加载界面
function hideSummaryLoading() {
    initLoadingManager().hide();
}

// 显示摘要模态框
function showSummaryModal(article) {
    const modal = document.getElementById('summaryModal');
    const content = document.getElementById('summaryContent');
    const time = document.getElementById('summaryTime');
    const newsCount = document.getElementById('summaryNewsCount');
    
    // 处理摘要内容（链接已经嵌入到每条摘要的句末）
    let formattedContent = article.content;
    
    // 将换行符转换为HTML换行标签，并处理Markdown格式
    formattedContent = formattedContent
        .replace(/\*\*(.*?)\*\*/g, '<strong style="color: var(--text-primary); font-weight: 600;">$1</strong>') // 处理粗体
        .replace(/\n/g, '<br>')
        .replace(/<br><br>/g, '<br><br>'); // 保持段落间距
    
    content.innerHTML = formattedContent;
    
    // 设置CSS样式确保换行正确显示
    content.style.whiteSpace = 'pre-wrap';
    content.style.lineHeight = '1.8';
    
    time.textContent = new Date(article.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    newsCount.textContent = `${article.newsCount} 条新闻`;
    
    // 显示模态框
    modal.classList.remove('hidden');
    
    // 添加点击外部区域关闭模态框的事件监听器
    setTimeout(() => {
        modal.addEventListener('click', handleSummaryModalOutsideClick);
    }, 100);
    
    // 存储文章数据供其他功能使用
    window.currentSummaryArticle = article;
}

// 转义正则表达式特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 关闭摘要模态框
function closeSummaryModal() {
    const modal = document.getElementById('summaryModal');
    modal.classList.add('hidden');
    
    // 移除点击外部区域的事件监听器
    modal.removeEventListener('click', handleSummaryModalOutsideClick);
}

// 处理点击摘要模态框外部区域的函数
function handleSummaryModalOutsideClick(event) {
    const modal = document.getElementById('summaryModal');
    const modalContent = modal.querySelector('.rounded-3xl');
    
    // 如果点击的是模态框背景（不是内容区域），则关闭模态框
    if (event.target === modal || !modalContent.contains(event.target)) {
        closeSummaryModal();
    }
}

// 复制摘要内容
function copySummary() {
    if (!window.currentSummaryArticle) {
        toastManager.show('没有可复制的摘要内容', 'warning');
        return;
    }
    
    // 创建纯文本版本
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = window.currentSummaryArticle.content;
    const textContent = tempDiv.textContent || tempDiv.innerText || '';
    
    navigator.clipboard.writeText(textContent).then(() => {
        // toastManager.show('摘要内容已复制到剪贴板', 'success'); // 减少不必要的通知
    }).catch(err => {
        console.error('复制失败:', err);
        toastManager.show('复制失败，请手动选择复制', 'error');
    });
}

// 获取北京时间的日期字符串
function getBeijingDateString() {
    // 优先使用全局的lastUpdated时间，如果没有则使用当前时间
    let referenceTime;
    if (window.globalLastUpdated && window.globalLastUpdated !== 'undefined') {
        referenceTime = new Date(window.globalLastUpdated);
    } else {
        referenceTime = new Date();
    }
    
    // 转换为北京时间
    const beijingTime = new Date(referenceTime.getTime() + (8 * 60 * 60 * 1000));
    return beijingTime.toISOString().split('T')[0];
}

// 下载摘要文章
function downloadSummary() {
    if (!window.currentSummaryArticle) {
        toastManager.show('没有可下载的摘要内容', 'warning');
        return;
    }
    
    const article = window.currentSummaryArticle;
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = article.content;
    const textContent = tempDiv.textContent || tempDiv.innerText || '';
    
    const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `新闻摘要_${getBeijingDateString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // toastManager.show('摘要文章已下载', 'success'); // 减少不必要的通知
}


// 显示提示信息
// 现代化Toast通知系统
class ToastManager {
    constructor() {
        this.container = null;
        this.toasts = new Map();
        this.init();
    }

    init() {
        // 创建Toast容器
        this.container = document.createElement('div');
        this.container.className = 'toast-container';
        document.body.appendChild(this.container);
    }

    show(message, type = 'info', options = {}) {
        const {
            title = this.getDefaultTitle(type),
            duration = 5000,
            closable = true,
            showProgress = true
        } = options;

        const toastId = Date.now() + Math.random();
        const toast = this.createToast(toastId, message, type, title, closable, showProgress);
        
        this.container.appendChild(toast);
        this.toasts.set(toastId, toast);

        // 显示动画
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // 进度条动画
        if (showProgress && duration > 0) {
            const progressBar = toast.querySelector('.toast__progress');
            if (progressBar) {
                progressBar.style.width = '100%';
                progressBar.style.transitionDuration = duration + 'ms';
                requestAnimationFrame(() => {
                    progressBar.style.width = '0%';
                });
            }
        }

        // 自动关闭
        if (duration > 0) {
            setTimeout(() => {
                this.hide(toastId);
            }, duration);
        }

        return toastId;
    }

    createToast(id, message, type, title, closable, showProgress) {
        const toast = document.createElement('div');
        toast.className = `toast toast--${type}`;
        toast.dataset.toastId = id;

        const icon = this.getIcon(type);
        
        toast.innerHTML = `
            <div class="toast__header">
                <div class="toast__title">
                    <i class="${icon}"></i>
                    ${title}
                </div>
                ${closable ? '<button class="toast__close" onclick="toastManager.hide(' + id + ')"><i class="fas fa-times"></i></button>' : ''}
            </div>
            <div class="toast__message">${message}</div>
            ${showProgress ? '<div class="toast__progress"></div>' : ''}
        `;

        return toast;
    }

    hide(toastId) {
        const toast = this.toasts.get(toastId);
        if (toast) {
            toast.classList.add('hide');
            setTimeout(() => {
                if (toast.parentNode) {
                    toast.parentNode.removeChild(toast);
                }
                this.toasts.delete(toastId);
            }, 300);
        }
    }

    getDefaultTitle(type) {
        const titles = {
            success: '成功',
            error: '错误',
            warning: '警告',
            info: '提示'
        };
        return titles[type] || '通知';
    }

    getIcon(type) {
        const icons = {
            success: 'fas fa-check-circle',
            error: 'fas fa-exclamation-triangle',
            warning: 'fas fa-exclamation-circle',
            info: 'fas fa-info-circle'
        };
        return icons[type] || 'fas fa-bell';
    }

    // 便捷方法
    success(message, options = {}) {
        return this.show(message, 'success', options);
    }

    error(message, options = {}) {
        return this.show(message, 'error', { ...options, duration: 8000 });
    }

    warning(message, options = {}) {
        return this.show(message, 'warning', options);
    }

    info(message, options = {}) {
        return this.show(message, 'info', options);
    }

    // 清除所有Toast
    clear() {
        this.toasts.forEach((toast, id) => {
            this.hide(id);
        });
    }
}

// 全局Toast管理器实例
const toastManager = new ToastManager();

// 兼容旧的showAlert函数
function showAlert(message, type = 'info', options = {}) {
    // 类型映射
    const typeMap = {
        'danger': 'error',
        'success': 'success',
        'warning': 'warning',
        'info': 'info'
    };
    
    const mappedType = typeMap[type] || type;
    return toastManager.show(message, mappedType, options);
}

// 打开新闻链接
function openNewsUrl(element) {
    const url = element.getAttribute('data-url');
    if (url && url.trim() !== '') {
        window.open(url, '_blank');
    } else {
        toastManager.show('该新闻暂无原文链接', 'warning');
    }
}

// 图片加载错误处理
function handleImageError(img) {
    img.style.display = 'none';
    
    // 创建占位符
    const placeholder = document.createElement('div');
    placeholder.className = 'card-img-top d-flex align-items-center justify-content-center bg-light';
    placeholder.style.height = '200px';
    placeholder.innerHTML = '<i class="fas fa-image fa-3x text-muted"></i>';
    
    // 替换图片
    img.parentNode.insertBefore(placeholder, img);
}

// 页面加载完成后的初始化
document.addEventListener('DOMContentLoaded', function() {
    // 初始化深色模式
    // 页面加载完成，初始化深色模式
    initTheme();
    
    // 添加深色模式切换按钮事件监听器
    const themeToggle = document.getElementById('themeToggle');
    if (themeToggle) {
        // 找到深色模式切换按钮，绑定事件
        themeToggle.addEventListener('click', function(e) {
            e.preventDefault();
            // 深色模式按钮被点击
            toggleTheme();
        });
    } else {
        console.error('未找到深色模式切换按钮 #themeToggle');
    }
    
    // 为所有新闻图片添加错误处理
    const newsImages = document.querySelectorAll('.news-image');
    newsImages.forEach(img => {
        img.addEventListener('error', () => handleImageError(img));
    });
    
    // 添加新闻卡片的动画延迟
    const newsCards = document.querySelectorAll('.news-card');
    newsCards.forEach((card, index) => {
        card.style.animationDelay = `${index * 0.1}s`;
    });
    
    // 添加键盘快捷键支持
    document.addEventListener('keydown', function(e) {
        // Ctrl+R 或 F5 手动获取新闻
        if ((e.ctrlKey && e.key === 'r') || e.key === 'F5') {
            e.preventDefault();
            refreshNews();
        }
        // Ctrl+D 切换深色模式
        if (e.ctrlKey && e.key === 'd') {
            e.preventDefault();
            toggleTheme();
        }
    });
    
    // 检查是否有新闻数据，如果没有则显示提示
    const newsContainer = document.getElementById('news-container');
    if (newsContainer && newsContainer.children.length === 1) {
        const emptyState = newsContainer.querySelector('.text-center');
        if (emptyState) {
            // 自动尝试获取新闻功能已禁用
            // setTimeout(() => {
            //     toastManager.show('正在自动获取最新新闻...', 'info');
            //     refreshNews();
            // }, 2000);
        }
    }
    
    // 初始化主页面状态显示
    initializeMainPageStatus();
    
    // WebSocket重连机制
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    
    socket.on('disconnect', () => {
        if (reconnectAttempts < maxReconnectAttempts) {
            reconnectAttempts++;
            setTimeout(() => {
                // 尝试重连
                socket.connect();
            }, 2000 * reconnectAttempts); // 递增延迟
        }
    });
    
    socket.on('connect', () => {
        reconnectAttempts = 0; // 重置重连计数
    });
});

// 初始化主页面状态显示
function initializeMainPageStatus() {
    // 检查音频状态
    fetch('/api/podcast/info', { cache: 'no-cache' })
        .then(response => response.json())
        .then(data => {
            if (data.success && data.podcast) {
                currentPodcast = data.podcast;
                updatePodcastStatus('已完成');
            } else {
                updatePodcastStatus('等待生成中...');
            }
        })
        .catch(() => {
            updatePodcastStatus('等待生成中...');
        });
    
    // 检查摘要状态
    fetch('/api/summary/latest', { cache: 'no-cache' })
        .then(response => response.json())
        .then(data => {
            if (data.success && data.article) {
                currentSummaryData = data.article;
                updateSummaryStatus('已完成');
            } else {
                updateSummaryStatus('等待生成中...');
            }
        })
        .catch(() => {
            updateSummaryStatus('等待生成中...');
        });
}

// 平滑滚动到顶部
function scrollToTop() {
    window.scrollTo({
        top: 0,
        behavior: 'smooth'
    });
}

// 监听滚动事件，显示返回顶部按钮
window.addEventListener('scroll', function() {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop;
    
    // 如果滚动超过300px，显示返回顶部按钮
    if (scrollTop > 300) {
        if (!document.getElementById('backToTop')) {
            const backToTopBtn = document.createElement('button');
            backToTopBtn.id = 'backToTop';
            backToTopBtn.className = 'btn btn-primary position-fixed';
            backToTopBtn.style.cssText = `
                bottom: 20px;
                right: 20px;
                z-index: 1000;
                border-radius: 50%;
                width: 50px;
                height: 50px;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            `;
            backToTopBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
            backToTopBtn.onclick = scrollToTop;
            document.body.appendChild(backToTopBtn);
        }
    } else {
        const backToTopBtn = document.getElementById('backToTop');
        if (backToTopBtn) {
            backToTopBtn.remove();
        }
    }
});

// 新闻卡片点击统计（可选功能）
function trackNewsClick(url, title) {
    // 这里可以添加点击统计逻辑
    // 新闻点击事件
}

// 为外部链接添加点击跟踪
document.addEventListener('click', function(e) {
    if (e.target.closest('a[href^="http"]')) {
        const link = e.target.closest('a');
        const card = link.closest('.news-card');
        if (card) {
            const title = card.querySelector('.card-title')?.textContent;
            trackNewsClick(link.href, title);
        }
    }
});

// EPUB生成功能
function generateEpub() {
    if (!window.currentSummaryArticle) {
        toastManager.show('请先生成摘要文章', 'warning');
        return;
    }
    
    const generateBtn = document.querySelector('#summaryModal .btn-success');
    const originalText = generateBtn.textContent;
    generateBtn.disabled = true;
    generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin me-2"></i>生成中...';
    
    fetch('/api/generate-epub', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            title: `新闻摘要_${getBeijingDateString()}`,
            content: window.currentSummaryArticle.content,
            generatedAt: window.currentSummaryArticle.generatedAt,
            newsCount: window.currentSummaryArticle.newsCount
        })
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // toastManager.show('EPUB文件生成成功！', 'success'); // 减少不必要的通知
            // 自动下载EPUB文件
            const downloadUrl = `/api/download-epub/${data.filename}`;
            const a = document.createElement('a');
            a.href = downloadUrl;
            a.download = data.filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } else {
            toastManager.show(`EPUB生成失败: ${data.error}`, 'error');
        }
    })
    .catch(error => {
        console.error('EPUB生成错误:', error);
        toastManager.show('EPUB生成失败，请稍后重试', 'error');
    })
    .finally(() => {
        generateBtn.disabled = false;
        generateBtn.textContent = originalText;
    });
}

// 发送到Kindle功能（直接发送到预设邮箱）
function sendEmail() {
    if (!currentSummaryData) {
        toastManager.show('暂无摘要文章，请先生成摘要', 'warning');
        return;
    }
    
    // 确保window.currentSummaryArticle与currentSummaryData同步
    if (!window.currentSummaryArticle) {
        window.currentSummaryArticle = currentSummaryData;
    }
    
    const sendBtn = document.querySelector('#summaryModal button[onclick="sendEmail()"]');
    const originalText = sendBtn.innerHTML;
    sendBtn.disabled = true;
    sendBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 发送中...';
    
    fetch('/api/send-email', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            toastManager.show(data.message || '摘要已成功发送到Kindle邮箱', 'success');
        } else {
            toastManager.show(`发送到Kindle失败: ${data.message}`, 'error');
        }
    })
    .catch(error => {
        console.error('发送到Kindle错误:', error);
        toastManager.show('发送到Kindle失败，请稍后重试', 'error');
    })
    .finally(() => {
        sendBtn.disabled = false;
        sendBtn.innerHTML = originalText;
    });
}

// 测试SMTP配置
function testSmtpConfig() {
    fetch('/api/test-smtp', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            // toastManager.show('SMTP配置测试成功！', 'success'); // 减少不必要的通知
        } else {
            toastManager.show(`SMTP配置测试失败: ${data.error}`, 'error');
        }
    })
    .catch(error => {
        console.error('SMTP测试错误:', error);
        toastManager.show('SMTP测试失败，请检查网络连接', 'error');
    });
}

// ==================== 音频功能 ====================

// 音频相关变量
let currentPodcast = null;
let currentAudio = null;
let currentSegmentIndex = 0;
let isPlaying = false;

// 生成音频
function generatePodcast() {
    const modal = document.getElementById('podcastModal');
    const progressBar = document.getElementById('podcastProgressBar');
    const progressPercent = document.getElementById('podcastProgressPercent');
    const title = document.getElementById('podcastTitle');
    const message = document.getElementById('podcastMessage');
    const icon = document.getElementById('podcastIcon');
    
    // 重置进度显示
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    title.textContent = '正在生成音频';
    message.textContent = 'AI正在为您生成音频对话脚本...';
    icon.className = 'fas fa-microphone text-white text-lg';
    
    // 显示加载模态框
    modal.classList.remove('hidden');
    
    fetch('/api/generate-podcast', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    })
    .then(response => response.json())
    .then(data => {
        if (!data.success) {
            modal.classList.add('hidden');
            toastManager.show('启动音频生成失败，请稍后重试', 'error');
        }
        // 如果成功，进度更新将通过Socket.IO处理
    })
    .catch(error => {
        console.error('生成音频失败:', error);
        modal.classList.add('hidden');
        toastManager.show('网络错误，请检查连接', 'error');
    });
}

// 更新音频生成进度
function updatePodcastProgress(data) {
    const modal = document.getElementById('podcastModal');
    const title = document.getElementById('podcastTitle');
    const message = document.getElementById('podcastMessage');
    const progressBar = document.getElementById('podcastProgressBar');
    const progressPercent = document.getElementById('podcastProgressPercent');
    const progressDetail = document.getElementById('podcastProgressDetail');
    const icon = document.getElementById('podcastIcon');
    
    // 更新进度条
    progressBar.style.width = data.progress + '%';
    progressPercent.textContent = data.progress + '%';
    
    // 更新消息
    message.textContent = data.message;
    
    // 更新详细进度信息
    if (data.detail) {
        progressDetail.textContent = data.detail;
    } else if (data.current && data.total) {
        progressDetail.textContent = `${data.current}/${data.total}`;
    } else {
        progressDetail.textContent = '';
    }
    
    // 根据阶段更新标题和图标
    switch(data.stage) {
        case 'script':
            title.textContent = '生成对话脚本';
            icon.className = 'fas fa-edit text-white text-lg';
            break;
        case 'audio':
            title.textContent = '生成语音音频';
            icon.className = 'fas fa-volume-up text-white text-lg';
            break;
        case 'completed':
            title.textContent = '音频生成完成';
            icon.className = 'fas fa-check text-white text-lg';
            progressBar.classList.add('bg-green-500');
            
            // 存储音频数据
            currentPodcast = data.podcast;
            
            // 3秒后关闭进度模态框并打开播放器
            setTimeout(() => {
                modal.classList.add('hidden');
                openPodcastPlayer();
            }, 3000);
            break;
        case 'error':
            title.textContent = '音频生成失败';
            icon.className = 'fas fa-exclamation-triangle text-white text-lg';
            progressBar.classList.add('bg-red-500');
            setTimeout(() => {
                modal.classList.add('hidden');
                toastManager.show('音频生成失败，请稍后重试', 'error');
            }, 3000);
            break;
    }
}

// 打开音频播放器
function openPodcastPlayer() {
    if (!currentPodcast) {
        // 尝试从服务器获取音频数据
        fetch('/api/podcast', { cache: 'no-cache' })
            .then(response => response.json())
            .then(data => {
                if (data.success && data.podcast) {
                    currentPodcast = data.podcast;
                    displayPodcastPlayer();
                } else {
                    // 静默处理，避免重复提示
                }
            })
            .catch(error => {
                console.error('获取音频数据失败:', error);
                // 静默处理错误
            });
        return;
    }
    
    displayPodcastPlayer();
}

// 显示音频播放器
function displayPodcastPlayer() {
    const modal = document.getElementById('podcastPlayerModal');
    const title = document.getElementById('podcastPlayerTitle');
    const meta = document.getElementById('podcastPlayerMeta');
    const time = document.getElementById('podcastTime');
    const segments = document.getElementById('podcastSegments');
    const scriptContainer = document.getElementById('podcastScript');
    
    // 设置音频信息
    title.textContent = currentPodcast.title;
    meta.textContent = currentPodcast.description;
    time.textContent = new Date(currentPodcast.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    segments.textContent = `${currentPodcast.segments.length} 个音频片段`;
    
    // 显示对话脚本
    displayPodcastScript(scriptContainer);
    
    // 重置播放状态
    currentSegmentIndex = 0;
    isPlaying = false;
    updatePlayButton();
    
    // 显示模态框
    modal.classList.remove('hidden');
}

// 显示音频信息（主页面版本）
function displayPodcastInfo() {
    const time = document.getElementById('podcastTime');
    const segments = document.getElementById('podcastSegments');
    const scriptContainer = document.getElementById('podcastScript');
    
    if (time) time.textContent = new Date(currentPodcast.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    if (segments) segments.textContent = `${currentPodcast.segments.length} 个音频片段`;
    
    // 显示对话脚本
    if (scriptContainer) {
        displayPodcastScript(scriptContainer);
    }
}

// 显示音频脚本
function displayPodcastScript(container) {
    const lines = currentPodcast.script.split('\n').filter(line => line.trim());
    container.innerHTML = '';
    
    lines.forEach((line, index) => {
        // 支持新的[A]和[B]格式，以及旧的[主持人]和[分析师]格式
        if (line.includes('[A]') || line.includes('[B]') || line.includes('[主持人]') || line.includes('[分析师]')) {
            let isHost, text, speakerName, speakerIcon;
            
            if (line.includes('[A]')) {
                isHost = true;
                text = line.replace(/\[A\]\s*/, '').trim();
                speakerName = '播音员A';
                speakerIcon = 'A';
            } else if (line.includes('[B]')) {
                isHost = false;
                text = line.replace(/\[B\]\s*/, '').trim();
                speakerName = '播音员B';
                speakerIcon = 'B';
            } else if (line.includes('[主持人]')) {
                isHost = true;
                text = line.replace(/\[主持人\]\s*/, '').trim();
                speakerName = '主持人 张明';
                speakerIcon = '主';
            } else if (line.includes('[分析师]')) {
                isHost = false;
                text = line.replace(/\[分析师\]\s*/, '').trim();
                speakerName = '分析师 李华';
                speakerIcon = '析';
            }
            
            if (text && text.length > 0) {
                const scriptItem = document.createElement('div');
                scriptItem.className = `p-4 rounded-lg transition-all duration-300 ${isHost ? 'bg-blue-50' : 'bg-purple-50'}`;
                scriptItem.style.background = isHost ? 'var(--bg-secondary)' : 'var(--bg-primary)';
                scriptItem.setAttribute('data-segment-index', index);
                scriptItem.innerHTML = `
                    <div class="flex items-start space-x-3">
                        <div class="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold ${
                            isHost ? 'bg-blue-500' : 'bg-purple-500'
                        }">
                            ${speakerIcon}
                        </div>
                        <div class="flex-1">
                            <div class="text-sm font-medium mb-2" style="color: var(--text-secondary);">
                                ${speakerName}
                            </div>
                            <div class="script-text leading-relaxed" style="color: var(--text-primary);">
                                ${text}
                            </div>
                        </div>
                    </div>
                `;
                container.appendChild(scriptItem);
            }
        }
    });
}

// 关闭音频播放器
function closePodcastPlayer() {
    const modal = document.getElementById('podcastPlayerModal');
    modal.classList.add('hidden');
    
    // 停止播放
    if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
    }
    isPlaying = false;
    updatePlayButton();
}

// 播放/暂停控制
function togglePlayPause() {
    if (!currentPodcast) {
        // 尝试从服务器获取音频数据
        fetch('/api/podcast', { cache: 'no-cache' })
            .then(response => response.json())
            .then(data => {
                if (data.success && data.podcast) {
                    currentPodcast = data.podcast;
                    // 显示音频信息和脚本
                    displayPodcastInfo();
                    // 开始播放
                    if (currentPodcast.segments && currentPodcast.segments.length > 0) {
                        playAudio();
                    } else {
                        // toastManager.show('暂无音频数据', 'warning'); // 减少不必要的通知
                    }
                } else {
                    // 静默处理，避免重复提示
                }
            })
            .catch(error => {
                console.error('获取音频数据失败:', error);
                // 静默处理错误
            });
        return;
    }
    
    if (!currentPodcast.segments || !currentPodcast.segments.length) {
        return;
    }
    
    if (isPlaying) {
        pauseAudio();
    } else {
        playAudio();
    }
}

// 播放音频
function playAudio() {
    if (currentSegmentIndex >= currentPodcast.segments.length) {
        // toastManager.show('音频已播放完毕', 'info'); // 减少不必要的通知
        return;
    }
    
    const segment = currentPodcast.segments[currentSegmentIndex];
    const audioUrl = `/api/podcast/audio/segment_${segment.index.toString().padStart(3, '0')}.mp3`;
    
    if (currentAudio) {
        currentAudio.pause();
    }
    
    currentAudio = new Audio(audioUrl);
    
    // 应用保存的音量和倍速设置
    const savedVolume = localStorage.getItem('podcastVolume');
    if (savedVolume) {
        currentAudio.volume = savedVolume / 100;
    }
    
    const savedPlaybackRate = localStorage.getItem('podcastPlaybackRate');
    if (savedPlaybackRate) {
        currentAudio.playbackRate = parseFloat(savedPlaybackRate);
    }
    
    currentAudio.addEventListener('loadstart', () => {
        updateCurrentSegmentDisplay(segment);
    });
    
    currentAudio.addEventListener('canplay', () => {
        currentAudio.play();
        isPlaying = true;
        updatePlayButton();
    });
    
    currentAudio.addEventListener('ended', () => {
        nextSegment();
    });
    
    currentAudio.addEventListener('error', (e) => {
        console.error('音频播放错误:', e);
        toastManager.show('音频播放失败', 'error');
        isPlaying = false;
        updatePlayButton();
    });
    
    currentAudio.addEventListener('timeupdate', updateAudioProgress);
}

// 暂停音频
function pauseAudio() {
    if (currentAudio) {
        currentAudio.pause();
    }
    isPlaying = false;
    updatePlayButton();
}

// 更新播放按钮
function updatePlayButton() {
    const playPauseIcon = document.getElementById('playPauseIcon');
    if (isPlaying) {
        playPauseIcon.className = 'fas fa-pause';
    } else {
        playPauseIcon.className = 'fas fa-play';
    }
}

// 更新当前片段显示
function updateCurrentSegmentDisplay(segment) {
    const currentSegmentText = document.getElementById('currentSegmentText');
    const currentSpeaker = document.getElementById('currentSpeaker');
    const scriptContainer = document.getElementById('podcastScript');
    
    // 更新播放器顶部显示
    currentSegmentText.textContent = segment.text.length > 80 ? segment.text.substring(0, 80) + '...' : segment.text;
    currentSpeaker.textContent = segment.speaker;
    
    // 高亮当前播放的字幕
    if (scriptContainer) {
        // 移除之前的高亮
        const previousHighlight = scriptContainer.querySelector('.current-playing');
        if (previousHighlight) {
            previousHighlight.classList.remove('current-playing');
            previousHighlight.style.background = previousHighlight.classList.contains('bg-blue-50') ? 'var(--bg-secondary)' : 'var(--bg-primary)';
            previousHighlight.style.border = 'none';
            previousHighlight.style.transform = 'scale(1)';
        }
        
        // 查找并高亮当前片段
        const scriptItems = scriptContainer.querySelectorAll('div[data-segment-index]');
        if (scriptItems[currentSegmentIndex]) {
            const currentItem = scriptItems[currentSegmentIndex];
            currentItem.classList.add('current-playing');
            currentItem.style.background = 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), rgba(147, 51, 234, 0.1))';
            currentItem.style.border = '2px solid rgba(59, 130, 246, 0.3)';
            currentItem.style.transform = 'scale(1.02)';
            
            // 自动滚动到当前播放的字幕
            currentItem.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }
}

// 更新音频进度
function updateAudioProgress() {
    if (!currentAudio || !currentPodcast) return;
    
    const currentSegmentTime = currentAudio.currentTime;
    const currentSegmentDuration = currentAudio.duration;
    
    if (currentSegmentDuration) {
        // 计算整个音频的总时长和当前播放时间
        const totalPodcastTime = calculateTotalPodcastTime();
        const currentPodcastTime = calculateCurrentPodcastTime(currentSegmentTime);
        
        // 计算整体进度百分比
        const progress = totalPodcastTime > 0 ? (currentPodcastTime / totalPodcastTime) * 100 : 0;
        const progressBar = document.getElementById('audioProgressBar');
        progressBar.style.width = progress + '%';
        
        // 更新时间显示
        const currentTimeElement = document.getElementById('currentTime');
        const totalTimeElement = document.getElementById('totalTime');
        
        currentTimeElement.textContent = formatTime(currentPodcastTime);
        totalTimeElement.textContent = formatTime(totalPodcastTime);
    }
}

// 计算整个音频的总时长
function calculateTotalPodcastTime() {
    if (!currentPodcast || !currentPodcast.segments) return 0;
    
    // 使用估算总时长（每个字符约0.15秒）
    let totalChars = 0;
    currentPodcast.segments.forEach(segment => {
        totalChars += segment.text.length;
    });
    return totalChars * 0.15;
}

// 计算当前音频播放时间
function calculateCurrentPodcastTime(currentSegmentTime) {
    if (!currentPodcast || !currentPodcast.segments) return 0;
    
    let totalTime = 0;
    
    // 累加之前片段的时长
    for (let i = 0; i < currentSegmentIndex; i++) {
        const segment = currentPodcast.segments[i];
        // 估算片段时长（每个字符约0.15秒）
        totalTime += segment.text.length * 0.15;
    }
    
    // 加上当前片段的播放时间（按比例计算）
    if (currentAudio && currentAudio.duration > 0) {
        const currentSegment = currentPodcast.segments[currentSegmentIndex];
        if (currentSegment) {
            const estimatedSegmentDuration = currentSegment.text.length * 0.15;
            const actualProgress = currentSegmentTime / currentAudio.duration;
            totalTime += actualProgress * estimatedSegmentDuration;
        }
    } else {
        totalTime += currentSegmentTime;
    }
    
    return totalTime;
}

// 格式化时间
function formatTime(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
}

// 上一个片段
function previousSegment() {
    if (currentSegmentIndex > 0) {
        currentSegmentIndex--;
        if (isPlaying) {
            playAudio();
        }
    }
}

// 下一个片段
function nextSegment() {
    if (currentSegmentIndex < currentPodcast.segments.length - 1) {
        currentSegmentIndex++;
        if (isPlaying) {
            playAudio();
        }
    } else {
        // 播放完毕
        isPlaying = false;
        updatePlayButton();
        // toastManager.show('音频播放完毕', 'success'); // 减少不必要的通知
    }
}

// 快退
function rewind() {
    if (currentAudio) {
        currentAudio.currentTime = Math.max(0, currentAudio.currentTime - 10);
    }
}

// 快进
function fastForward() {
    if (currentAudio) {
        currentAudio.currentTime = Math.min(currentAudio.duration, currentAudio.currentTime + 10);
    }
}

// 音频进度条点击跳转
function seekAudio(event) {
    if (!currentPodcast || !currentPodcast.segments) return;
    
    const progressBar = event.currentTarget;
    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const width = rect.width;
    const percentage = Math.max(0, Math.min(1, clickX / width));
    
    // 计算目标播放时间
    const totalPodcastTime = calculateTotalPodcastTime();
    const targetTime = percentage * totalPodcastTime;
    
    // 找到对应的片段和片段内的时间
    let accumulatedTime = 0;
    let targetSegmentIndex = 0;
    let targetSegmentTime = 0;
    
    for (let i = 0; i < currentPodcast.segments.length; i++) {
        const segment = currentPodcast.segments[i];
        const segmentDuration = segment.text.length * 0.15; // 估算片段时长
        
        if (accumulatedTime + segmentDuration >= targetTime) {
            targetSegmentIndex = i;
            targetSegmentTime = targetTime - accumulatedTime;
            break;
        }
        
        accumulatedTime += segmentDuration;
        
        // 如果是最后一个片段
        if (i === currentPodcast.segments.length - 1) {
            targetSegmentIndex = i;
            targetSegmentTime = Math.min(targetTime - accumulatedTime + segmentDuration, segmentDuration);
        }
    }
    
    // 切换到目标片段
    currentSegmentIndex = targetSegmentIndex;
    
    if (isPlaying) {
        playAudio();
        // 等待新音频加载后设置时间
        if (currentAudio) {
            const setTargetTime = () => {
                if (currentAudio && currentAudio.duration > 0) {
                    const currentSegment = currentPodcast.segments[currentSegmentIndex];
                    if (currentSegment) {
                        const estimatedDuration = currentSegment.text.length * 0.15;
                        const actualDuration = currentAudio.duration;
                        const ratio = actualDuration / estimatedDuration;
                        const actualTargetTime = Math.min(targetSegmentTime * ratio, actualDuration);
                        currentAudio.currentTime = Math.max(0, actualTargetTime);
                    }
                }
            };
            
            if (currentAudio.readyState >= 2) {
                setTargetTime();
            } else {
                currentAudio.addEventListener('canplay', setTargetTime, { once: true });
            }
        }
    } else {
        // 如果没有播放，只是更新显示
        updatePlayButton();
    }
}

// 下载音频
function downloadPodcast() {
    if (!currentPodcast) {
        return;
    }
    
    // 创建下载链接
    const scriptBlob = new Blob([currentPodcast.script], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(scriptBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `音频脚本_${getBeijingDateString()}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    // 音频脚本下载完成，不显示通知
}

// 下载完整音频
function downloadCompletePodcast() {
    if (!currentPodcast) {
        // toastManager.show('暂无音频数据', 'warning'); // 减少不必要的通知
        return;
    }
    
    // 创建下载链接
    const a = document.createElement('a');
    a.href = '/api/podcast/complete';
    a.download = `AI新闻音频_${getBeijingDateString()}.mp3`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    
    // 下载开始，无需提示
}

// 分享音频
function sharePodcast() {
    if (!currentPodcast) {
        toastManager.show('暂无音频数据', 'warning');
        return;
    }
    
    const shareText = `我刚刚收听了AI生成的新闻音频：${currentPodcast.title}\n\n${currentPodcast.description}\n\n生成时间：${new Date(currentPodcast.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
    
    if (navigator.share) {
        navigator.share({
            title: currentPodcast.title,
            text: shareText,
            url: window.location.href
        }).catch(err => {/* 分享失败 */});
    } else {
        // 复制到剪贴板
        navigator.clipboard.writeText(shareText).then(() => {
            // toastManager.show('音频信息已复制到剪贴板', 'success'); // 减少不必要的通知
        }).catch(() => {
            // toastManager.show('复制失败，请手动复制', 'warning'); // 减少不必要的通知
        });
    }
}

// 主页面音频播放器相关变量
let mainAudio = null;
let isMainAudioPlaying = false;
let currentSummaryData = null;

// 主页面音频播放器控制
function toggleMainAudio() {
    // 检查音频状态而不是依赖currentPodcast变量
    const podcastStatus = document.getElementById('podcastStatus');
    if (!podcastStatus || podcastStatus.textContent !== '已完成') {
        return;
    }
    
    if (isMainAudioPlaying) {
        pauseMainAudio();
    } else {
        playMainAudio();
    }
}

// 播放主页面音频
function playMainAudio() {
    const audioUrl = '/api/podcast/complete';
    
    if (mainAudio) {
        mainAudio.pause();
    }
    
    mainAudio = new Audio(audioUrl);
    
    // 应用保存的音量和倍速设置
    const savedVolume = localStorage.getItem('podcastVolume');
    if (savedVolume) {
        mainAudio.volume = savedVolume / 100;
    }
    
    const savedPlaybackRate = localStorage.getItem('podcastPlaybackRate');
    if (savedPlaybackRate) {
        mainAudio.playbackRate = parseFloat(savedPlaybackRate);
    }
    
    mainAudio.addEventListener('loadstart', () => {
        updateMainAudioStatus('正在加载音频...');
    });
    
    mainAudio.addEventListener('canplay', () => {
        mainAudio.play();
        isMainAudioPlaying = true;
        updateMainPlayButton();
        updateMainAudioStatus('正在播放');
    });
    
    mainAudio.addEventListener('ended', () => {
        isMainAudioPlaying = false;
        updateMainPlayButton();
        updateMainAudioStatus('播放完毕');
        // toastManager.show('音频播放完毕', 'success'); // 减少不必要的通知
    });
    
    mainAudio.addEventListener('error', (e) => {
        console.error('主页面音频播放错误:', e);
        toastManager.show('音频播放失败，可能音频尚未生成完成', 'warning');
        isMainAudioPlaying = false;
        updateMainPlayButton();
        updateMainAudioStatus('播放失败');
    });
    
    mainAudio.addEventListener('timeupdate', updateMainAudioProgress);
}

// 暂停主页面音频
function pauseMainAudio() {
    if (mainAudio) {
        mainAudio.pause();
    }
    isMainAudioPlaying = false;
    updateMainPlayButton();
    updateMainAudioStatus('已暂停');
}

// 更新主页面播放按钮
function updateMainPlayButton() {
    const mainPlayIcon = document.getElementById('mainPlayIcon');
    if (isMainAudioPlaying) {
        mainPlayIcon.className = 'fas fa-pause';
    } else {
        mainPlayIcon.className = 'fas fa-play';
    }
}

// 更新主页面音频状态
function updateMainAudioStatus(status) {
    const statusElement = document.getElementById('mainAudioStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
}

// 更新主页面音频进度
function updateMainAudioProgress() {
    if (!mainAudio) return;
    
    const currentTime = mainAudio.currentTime;
    const duration = mainAudio.duration;
    
    if (duration) {
        const progress = (currentTime / duration) * 100;
        const progressBar = document.getElementById('mainAudioProgress');
        if (progressBar) {
            progressBar.style.width = progress + '%';
        }
        
        // 更新时间显示
        const timeElement = document.getElementById('mainAudioTime');
        if (timeElement) {
            timeElement.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
        }
    }
}

// 主页面音频进度条点击跳转
function seekMainAudio(event) {
    if (!mainAudio || !mainAudio.duration) return;
    
    const progressBar = event.currentTarget;
    const rect = progressBar.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const width = rect.width;
    const percentage = clickX / width;
    
    mainAudio.currentTime = percentage * mainAudio.duration;
}

// 查看摘要
function viewSummary() {
    if (!currentSummaryData) {
        return;
    }
    
    showSummaryModal(currentSummaryData);
}

// 发送到Kindle
function sendToKindle() {
    if (!currentSummaryData) {
        return;
    }
    
    sendEmail();
}

// 更新音频状态
function updatePodcastStatus(status) {
    const statusElement = document.getElementById('podcastStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
    
    // 根据状态控制音频相关按钮
    const isCompleted = status === '已完成';
    const playButton = document.getElementById('mainPlayBtn');
    const downloadButton = document.querySelector('button[onclick="downloadCompletePodcast()"]');
    
    if (playButton) {
        playButton.disabled = !isCompleted;
        playButton.style.opacity = isCompleted ? '1' : '0.5';
    }
    if (downloadButton) {
        downloadButton.disabled = !isCompleted;
        downloadButton.style.opacity = isCompleted ? '1' : '0.5';
    }
}

// 音量调整功能
// 静音状态管理
let isMuted = false;
let previousVolume = 100;

function adjustVolume(value) {
    const volumeIcon = document.getElementById('volumeIcon');
    
    // 如果不是静音状态，保存当前音量
    if (!isMuted && value > 0) {
        previousVolume = value;
    }
    
    // 更新音量图标
    if (volumeIcon) {
        if (value == 0) {
            volumeIcon.className = 'fas fa-volume-mute text-sm cursor-pointer hover:scale-110 transition-transform duration-200';
            isMuted = true;
        } else if (value < 50) {
            volumeIcon.className = 'fas fa-volume-down text-sm cursor-pointer hover:scale-110 transition-transform duration-200';
            isMuted = false;
        } else {
            volumeIcon.className = 'fas fa-volume-up text-sm cursor-pointer hover:scale-110 transition-transform duration-200';
            isMuted = false;
        }
    }
    
    // 设置当前播放音频的音量
    if (currentAudio) {
        currentAudio.volume = value / 100;
    }
    
    // 设置主音频的音量
    if (mainAudio) {
        mainAudio.volume = value / 100;
    }
    
    // 保存音量设置到本地存储
    localStorage.setItem('podcastVolume', value);
}

function toggleMute() {
    const volumeSlider = document.getElementById('volumeSlider');
    
    if (isMuted) {
        // 取消静音，恢复之前的音量
        volumeSlider.value = previousVolume;
        adjustVolume(previousVolume);
        // toastManager.show('已取消静音', 'info'); // 减少不必要的通知
    } else {
        // 静音，保存当前音量并设置为0
        previousVolume = volumeSlider.value;
        volumeSlider.value = 0;
        adjustVolume(0);
        // toastManager.show('已静音', 'info'); // 减少不必要的通知
    }
}

// 倍速播放功能
function changePlaybackRate(rate) {
    const playbackRate = parseFloat(rate);
    
    // 设置当前播放音频的播放速度
    if (currentAudio) {
        currentAudio.playbackRate = playbackRate;
    }
    
    // 设置主音频的播放速度
    if (mainAudio) {
        mainAudio.playbackRate = playbackRate;
    }
    
    // 保存倍速设置到本地存储
    localStorage.setItem('podcastPlaybackRate', rate);
    
    // 显示倍速变化提示
    // toastManager.show(`播放速度已调整为 ${rate}x`, 'info'); // 减少不必要的通知
}

// 初始化音量和倍速设置
function initializeAudioSettings() {
    // 恢复保存的音量设置
    const savedVolume = localStorage.getItem('podcastVolume');
    if (savedVolume) {
        const volumeSlider = document.getElementById('volumeSlider');
        if (volumeSlider) {
            volumeSlider.value = savedVolume;
            adjustVolume(savedVolume);
        }
    }
    
    // 恢复保存的倍速设置
    const savedPlaybackRate = localStorage.getItem('podcastPlaybackRate');
    if (savedPlaybackRate) {
        const playbackRateSelect = document.getElementById('playbackRateSelect');
        if (playbackRateSelect) {
            playbackRateSelect.value = savedPlaybackRate;
        }
    }
}

// 页面加载完成后初始化音频设置
document.addEventListener('DOMContentLoaded', function() {
    initializeAudioSettings();
});

// 更新摘要状态
function updateSummaryStatus(status) {
    const statusElement = document.getElementById('summaryStatus');
    if (statusElement) {
        statusElement.textContent = status;
    }
    
    // 根据状态控制摘要相关按钮
    const isCompleted = status === '已完成';
    const viewButton = document.querySelector('button[onclick="viewSummary()"]');
    const kindleButton = document.querySelector('button[onclick="sendToKindle()"]');
    
    if (viewButton) {
        viewButton.disabled = !isCompleted;
        viewButton.style.opacity = isCompleted ? '1' : '0.5';
    }
    if (kindleButton) {
        kindleButton.disabled = !isCompleted;
        kindleButton.style.opacity = isCompleted ? '1' : '0.5';
    }
}

// ==========================================================================
// 新闻源管理功能
// ==========================================================================

// 定时任务配置数据 - 保留用于兼容性
let scheduleConfigData = {
    autoUpdateEnabled: false,
    updateTime: '08:00',
    updateFrequency: 'daily',
    updateInterval: '0 */2 * * *',
    nextExecution: null,
    isRunning: false
};

// 兼容性函数 - 这些函数现在由settings-manager.js提供
// 保留这些声明以防止错误，但实际功能由新的设置管理器处理

// 加载定时任务配置
async function loadScheduleConfiguration() {
    try {
        const response = await fetch('/api/schedule/config', { cache: 'no-cache' });
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        
        // 从API响应中提取配置数据
        const config = data.config || data;
        
        scheduleConfigData = {
            autoUpdateEnabled: Boolean(config.autoUpdateEnabled),
            updateFrequency: 'daily',
            updateTimes: config.updateTimes || (config.updateTime ? [config.updateTime] : ['08:00']),
            nextExecution: config.nextExecution || null,
            isRunning: config.isRunning || false
        };
        
        return scheduleConfigData;
    } catch (error) {
        console.error('加载定时任务配置失败:', error);
        toastManager.show('加载定时任务配置失败: ' + error.message, 'error');
        throw error;
    }
}

// 旧的渲染函数已移至settings-manager.js

// 旧的渲染函数已移至settings-manager.js

// 旧的源管理函数已移至settings-manager.js

// 旧的源管理函数已移至settings-manager.js

// 旧的源保存函数已移至settings-manager.js

// 旧的源管理函数已移至settings-manager.js

// 编辑API源
// 旧的源编辑和保存函数已移至settings-manager.js

// 更新定时任务配置显示
function updateScheduleConfigDisplay(config) {
    const autoUpdateEnabled = document.getElementById('autoUpdateEnabled');
    const nextExecutionTime = document.getElementById('nextExecutionTime');
    
    if (autoUpdateEnabled) {
        autoUpdateEnabled.checked = config.autoUpdateEnabled;
    }
    
    // 让settings-manager.js控制更新时间列表的渲染
    // renderUpdateTimesList(config.updateTimes || []);
    
    if (nextExecutionTime && config.nextExecution) {
        // 检查nextExecution是否为有效的日期字符串
        if (config.nextExecution === '无法计算' || config.nextExecution === 'Invalid Date') {
            nextExecutionTime.textContent = '无法计算';
        } else {
            try {
                const nextTime = new Date(config.nextExecution);
                if (isNaN(nextTime.getTime())) {
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
                console.error('解析nextExecution时出错:', error, 'value:', config.nextExecution);
                nextExecutionTime.textContent = '无法计算';
            }
        }
    } else if (nextExecutionTime) {
        nextExecutionTime.textContent = '未设置';
    }
}

// 渲染更新时间列表
function renderUpdateTimesList(updateTimes) {
    const container = document.getElementById('updateTimesList');
    if (!container) {
        console.error('updateTimesList容器未找到');
        return;
    }
    
    container.innerHTML = '';
    
    if (updateTimes.length === 0) {
        container.innerHTML = `
            <div class="text-sm text-center py-4" style="color: var(--text-secondary);">
                暂无设置的更新时间，点击上方按钮添加
            </div>
        `;
        return;
    }
    
    updateTimes.forEach((time, index) => {
        const timeItem = document.createElement('div');
        timeItem.className = 'flex items-center justify-between p-3 rounded-lg';
        timeItem.style.cssText = 'background: var(--bg-primary); border: 1px solid var(--border-color);';
        
        timeItem.innerHTML = `
            <div class="flex items-center space-x-3">
                <i class="fas fa-clock" style="color: var(--text-secondary);"></i>
                <span class="text-sm font-medium" style="color: var(--text-primary);">${time}</span>
                <span class="text-xs" style="color: var(--text-secondary);">北京时间</span>
            </div>
            <button onclick="settingsManager.removeUpdateTime(${index})" class="text-red-500 hover:text-red-700 transition-colors">
                <i class="fas fa-trash-alt"></i>
            </button>
        `;
        
        container.appendChild(timeItem);
    });
}

// 添加更新时间
function addUpdateTime() {
    // 创建与API源/RSS源添加表单样式一致的模态框
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm flex items-center justify-center z-50';
    modal.innerHTML = `
        <div class="rounded-3xl p-8 max-w-md w-full mx-4 shadow-2xl border" style="background: var(--bg-primary); border-color: var(--border-color);">
            <div class="flex items-center justify-between mb-6">
                <div class="flex items-center space-x-3">
                    <div class="w-12 h-12 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl flex items-center justify-center">
                        <i class="fas fa-clock text-white text-lg"></i>
                    </div>
                    <div>
                        <h3 class="text-xl font-bold" style="color: var(--text-primary);">添加更新时间</h3>
                        <p class="text-sm" style="color: var(--text-secondary);">设置每日自动更新时间</p>
                    </div>
                </div>
                <button onclick="closeTimeModal()" class="btn-secondary close-button">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            <div class="space-y-4">
                <div>
                    <label class="block text-sm font-medium mb-2" style="color: var(--text-secondary);">更新时间 (HH:MM)</label>
                    <input type="time" id="timeInput" class="w-full px-3 py-2 rounded-lg border" style="background: var(--bg-primary); border-color: var(--border-color); color: var(--text-primary);">
                    <p class="text-xs mt-1" style="color: var(--text-secondary);">例如: 08:30 (北京时间)</p>
                </div>
            </div>
            <div class="flex items-center justify-end space-x-3 mt-6 pt-6" style="border-top: 1px solid var(--border-color);">
                <button onclick="closeTimeModal()" class="btn-secondary flex items-center space-x-2">
                    <i class="fas fa-times"></i>
                    <span>取消</span>
                </button>
                <button onclick="confirmAddTime()" class="btn-primary flex items-center space-x-2">
                    <i class="fas fa-plus"></i>
                    <span>添加</span>
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    document.getElementById('timeInput').focus();
    
    // 添加全局函数
    window.closeTimeModal = function() {
        document.body.removeChild(modal);
        delete window.closeTimeModal;
        delete window.confirmAddTime;
    };
    
    window.confirmAddTime = function() {
        const timeInput = document.getElementById('timeInput');
        const time = timeInput.value;
        
        if (!time) {
            toastManager.show('请输入时间', 'warning');
            return;
        }
        
        // 获取当前时间列表
        const currentTimes = getCurrentUpdateTimes();
        
        // 检查是否已存在
        if (currentTimes.includes(time)) {
            toastManager.show('该时间已存在', 'warning');
            return;
        }
        
        // 添加新时间并排序
        currentTimes.push(time);
        currentTimes.sort();
        
        // 更新内存中的配置数据
        if (scheduleConfigData) {
            scheduleConfigData.updateTimes = currentTimes;
        }
        
        // 重新渲染
        renderUpdateTimesList(currentTimes);
        
        // 不再立即保存，等待用户点击"保存配置"按钮
        // saveScheduleConfigWithTimes(currentTimes);
        
        // 关闭模态框
        closeTimeModal();
    };
    
    // ESC键关闭
    const handleEsc = function(event) {
        if (event.key === 'Escape') {
            closeTimeModal();
            document.removeEventListener('keydown', handleEsc);
        }
    };
    document.addEventListener('keydown', handleEsc);
}

// 移除更新时间
function removeUpdateTime(index) {
    const currentTimes = getCurrentUpdateTimes();
    if (index >= 0 && index < currentTimes.length) {
        currentTimes.splice(index, 1);
        
        // 更新内存中的配置数据
        if (scheduleConfigData) {
            scheduleConfigData.updateTimes = currentTimes;
        }
        
        renderUpdateTimesList(currentTimes);
        // 不再立即保存，等待用户点击"保存配置"按钮
        // saveScheduleConfigWithTimes(currentTimes);
    }
}

// 获取当前更新时间列表
function getCurrentUpdateTimes() {
    // 优先使用内存中的配置数据
    if (scheduleConfigData && scheduleConfigData.updateTimes && Array.isArray(scheduleConfigData.updateTimes)) {
        return scheduleConfigData.updateTimes;
    }
    
    // 如果内存中没有数据，则从DOM获取
    const container = document.getElementById('updateTimesList');
    if (!container) return [];
    
    const timeElements = container.querySelectorAll('.flex.items-center.justify-between span.font-medium');
    return Array.from(timeElements).map(el => el.textContent.trim());
}

// 保存定时任务配置
async function saveScheduleConfig() {
    const autoUpdateEnabled = document.getElementById('autoUpdateEnabled').checked;
    const updateTimes = getCurrentUpdateTimes();
    
    // 只有在启用自动更新时才检查更新时间
    if (autoUpdateEnabled && updateTimes.length === 0) {
        toastManager.show('启用自动更新时，至少需要设置一个更新时间', 'warning');
        return;
    }
    
    // 如果是关闭自动更新，即使没有更新时间也要保存配置
    // 确保updateTimes不为undefined
    const finalUpdateTimes = updateTimes || [];
    
    const config = {
        autoUpdateEnabled: autoUpdateEnabled,
        updateFrequency: 'daily',
        updateTimes: finalUpdateTimes
    };
    
    try {
        const response = await fetch('/api/schedule/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        
        if (response.ok) {
            const result = await response.json();
            // 更新本地配置数据
            scheduleConfigData.updateTimes = finalUpdateTimes;
            scheduleConfigData.autoUpdateEnabled = autoUpdateEnabled;
            // 注意：nextExecution会通过socket事件更新
            // 静默保存，不显示提示
        } else {
            const error = await response.text();
            toastManager.show('保存配置失败: ' + error, 'error');
        }
    } catch (error) {
        console.error('保存定时任务配置时出错:', error);
        toastManager.show('保存配置时出错', 'error');
    }
}

// 保存定时任务配置（带指定时间列表）
async function saveScheduleConfigWithTimes(updateTimes) {
    const autoUpdateEnabled = document.getElementById('autoUpdateEnabled').checked;
    
    if (autoUpdateEnabled && updateTimes.length === 0) {
        toastManager.show('启用自动更新时，至少需要设置一个更新时间', 'warning');
        return;
    }
    
    const config = {
        autoUpdateEnabled: autoUpdateEnabled,
        updateFrequency: 'daily',
        updateTimes: updateTimes
    };
    
    try {
        const response = await fetch('/api/schedule/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });
        
        if (response.ok) {
            const result = await response.json();
            // 更新本地配置数据
            scheduleConfigData.updateTimes = updateTimes;
            scheduleConfigData.autoUpdateEnabled = autoUpdateEnabled;
            // 注意：nextExecution会通过socket事件更新
            // toastManager.show(result.message || '定时任务配置保存成功', 'success'); // 减少不必要的通知
        } else {
            const error = await response.text();
            toastManager.show('保存定时任务配置失败: ' + error, 'error');
        }
    } catch (error) {
        console.error('保存定时任务配置时出错:', error);
        toastManager.show('保存定时任务配置时出错', 'error');
    }
}

// 手动触发更新
async function triggerManualUpdate() {
    try {
        const response = await fetch('/api/schedule/trigger', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const result = await response.json();
            // toastManager.show(result.message || '手动更新已触发', 'success'); // 减少不必要的通知
        } else {
            const error = await response.text();
            toastManager.show('触发手动更新失败: ' + error, 'error');
        }
    } catch (error) {
        console.error('触发手动更新时出错:', error);
        toastManager.show('触发手动更新时出错', 'error');
    }
}

// 处理更新频率变化
function handleUpdateFrequencyChange() {
    const updateFrequency = document.getElementById('updateFrequency');
    const customCronContainer = document.getElementById('customCronContainer');
    
    if (updateFrequency && customCronContainer) {
        customCronContainer.style.display = updateFrequency.value === 'custom' ? 'block' : 'none';
    }
}

// 切换自动更新状态
async function toggleAutoUpdate() {
    // toggleAutoUpdate function called
    // Event triggered
    
    const checkbox = document.getElementById('autoUpdateEnabled');
    if (!checkbox) {
        console.error('autoUpdateEnabled checkbox not found');
        return;
    }
    
    // 获取当前状态（change事件触发后的状态）
    const isEnabled = checkbox.checked;
    // Checkbox state changed
    // Checkbox element found
    
    // 如果要启用自动更新，检查是否有设置时间
    if (isEnabled) {
        const updateTimes = getCurrentUpdateTimes();
        // Current update times checked
        if (updateTimes.length === 0) {
            toastManager.show('启用自动更新前，请先添加至少一个更新时间', 'warning');
            checkbox.checked = false; // 恢复到关闭状态
            return;
        }
    }
    
    // 不再立即保存，等待用户点击"保存配置"按钮
    // Auto update toggle changed
}

// 检查是否有更多新闻并显示加载更多按钮
function checkAndShowLoadMoreButton() {
    fetch('/api/news', { cache: 'no-cache' })
        .then(response => response.json())
        .then(data => {
            const loadMoreContainer = document.getElementById('loadMoreContainer');
            const remainingCount = document.getElementById('remainingCount');
            
            if (data.hasMore && loadMoreContainer) {
                // 计算剩余新闻数量
                fetch('/api/news/more', { cache: 'no-cache' })
                    .then(response => response.json())
                    .then(moreData => {
                        if (moreData.success && moreData.total > 0) {
                            remainingCount.textContent = `(${moreData.total})`;
                            loadMoreContainer.style.display = 'block';
                        }
                    })
                    .catch(error => {
                        console.error('获取更多新闻信息失败:', error);
                    });
            } else if (loadMoreContainer) {
                loadMoreContainer.style.display = 'none';
            }
        })
        .catch(error => {
            console.error('检查更多新闻失败:', error);
        });
}

// 强制刷新页面数据
function forceRefreshPageData() {
    // 检查页面是否是通过刷新或直接访问加载的
    const isPageRefresh = performance.navigation.type === 1 || 
                         performance.getEntriesByType('navigation')[0]?.type === 'reload';
    
    // 检查是否在短时间内重复刷新（防止过于频繁的请求）
    const lastRefreshTime = sessionStorage.getItem('lastForceRefresh');
    const now = Date.now();
    const minRefreshInterval = 5000; // 5秒内不重复刷新
    
    if (isPageRefresh || !lastRefreshTime || (now - parseInt(lastRefreshTime)) > minRefreshInterval) {
        console.log('检测到页面刷新或首次加载，强制获取最新数据');
        
        // 记录本次刷新时间，防止过于频繁的刷新
        sessionStorage.setItem('lastForceRefresh', now.toString());
        
        // 清除可能的旧缓存标记
        sessionStorage.removeItem('lastCacheRefresh');
        
        // 强制检查版本并获取最新数据
        setTimeout(() => {
            checkPageVersion();
            checkAndShowLoadMoreButton();
        }, 1000);
        
        // 显示数据刷新提示
        setTimeout(() => {
            toastManager.show('正在获取最新数据...', 'info', { duration: 2000 });
        }, 500);
    } else {
        console.log('跳过强制刷新：距离上次刷新时间过短');
    }
}

// 页面加载完成后绑定事件监听器
document.addEventListener('DOMContentLoaded', function() {
    // DOMContentLoaded event fired
    
    // 强制刷新页面数据
    forceRefreshPageData();
    
    // 检查自动更新开关是否存在
    const autoUpdateCheckbox = document.getElementById('autoUpdateEnabled');
    // autoUpdateEnabled checkbox found
    if (autoUpdateCheckbox) {
        // Checkbox onchange attribute checked
        // Checkbox onclick attribute checked
    }
    
    // 绑定更新频率变化事件
    const updateFrequency = document.getElementById('updateFrequency');
    if (updateFrequency) {
        updateFrequency.addEventListener('change', handleUpdateFrequencyChange);
    }
    
    // 检查是否有更多新闻
    checkAndShowLoadMoreButton();
    
    // 加载定时任务配置
    loadScheduleConfiguration().then(config => {
        updateScheduleConfigDisplay(config);
        // 确保settings-manager也渲染更新时间列表
        if (typeof settingsManager !== 'undefined' && settingsManager.renderUpdateTimesList) {
            settingsManager.renderUpdateTimesList();
        }
    }).catch(error => {
        console.error('初始化定时任务配置失败:', error);
    });
});

// 点击模态框外部关闭
document.addEventListener('click', function(event) {
    const modal = document.getElementById('sourceManagerModal');
    if (event.target === modal) {
        closeSourceManager();
    }
});

// ESC键关闭模态框
document.addEventListener('keydown', function(event) {
    if (event.key === 'Escape') {
        const modal = document.getElementById('sourceManagerModal');
        if (!modal.classList.contains('hidden')) {
            closeSourceManager();
        }
    }
});

// Socket.IO事件监听器
if (typeof io !== 'undefined') {
    const socket = io();

    // 监听配置更新事件
    socket.on('server-restarting', function(data) {
        // 配置更新通知

        // 简化配置更新提示，避免过多通知
        // toastManager.show(
        //     `${data.message}，页面将自动刷新`,
        //     'info',
        //     { duration: data.countdown * 1000 + 1000 }
        // );

        // 在配置应用后尝试重新连接并刷新页面
        // 显示配置更新提示，但不自动刷新
        // toastManager.show('配置已更新，请手动刷新页面查看更改', 'info', { duration: 5000 });
        // setTimeout(() => {
        //     // 检查服务器是否重新启动
        //     checkServerAndReload();
        // }, data.countdown * 1000 + 2000);
    });

    // 监听AI配置更新事件
    socket.on('ai-config-updated', function(data) {
        // AI配置更新通知
        toastManager.show(data.message || 'AI配置已更新', 'success', { duration: 3000 });
    });

    socket.on('ai-config-reload-error', function(data) {
        // AI配置重载失败
        toastManager.show(data.message || 'AI配置重载失败', 'error');
    });

    // 监听连接断开事件
    socket.on('disconnect', function(reason) {
        // Socket连接断开
        if (reason === 'transport close' || reason === 'transport error') {
            // 显示连接断开提示，但不自动刷新
            // toastManager.show('连接已断开，如需查看最新状态请手动刷新页面', 'warning', { duration: 3000 });
            // setTimeout(() => {
            //     checkServerAndReload();
            // }, 3000);
        }
    });
}

// 检查服务器状态并重新加载页面
function checkServerAndReload() {
    let attempts = 0;
    const maxAttempts = 10;
    const checkInterval = 1000; // 1秒检查一次
    
    function checkServer() {
        attempts++;
        
        fetch('/api/health', { 
            method: 'GET',
            cache: 'no-cache'
        })
        .then(response => {
            if (response.ok) {
                // 配置已应用，服务器已就绪
                // 显示服务器就绪提示，但不自动刷新页面
                // toastManager.show('服务器已就绪，如需查看最新配置请手动刷新页面', 'success', { duration: 3000 });
                // setTimeout(() => {
                //     window.location.reload();
                // }, 500);
            } else {
                throw new Error('服务器未就绪');
            }
        })
        .catch(error => {
            if (attempts < maxAttempts) {
                // 检查服务器状态
                setTimeout(checkServer, checkInterval);
            } else {
                // 配置应用检查超时
                toastManager.show('配置已更新，请手动刷新页面', 'warning', { duration: 5000 });
            }
        });
    }
    
    checkServer();
}