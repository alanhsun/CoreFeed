const EventEmitter = require('events');
const logger = require('../utils/logger');
const { writeJsonFile, readJsonFile } = require('../utils/helpers');
const config = require('../config');

/**
 * 状态管理服务
 * 替代全局变量，提供统一的状态管理和事件通知
 */
class StateManager extends EventEmitter {
    constructor() {
        super();
        this.state = {
            newsData: [],
            allEnhancedNews: [],
            summaryArticle: null,
            sourceStats: [],
            lastUpdated: null,
            lastPublishedBy: null,
            isUpdating: false,
            collectionPhase: 'idle', // idle | collecting | collected | compiling | completed
            updateProgress: {
                stage: '',
                current: 0,
                total: 0,
                message: ''
            },
            aiConfig: null
        };

        // 设置最大监听器数量
        this.setMaxListeners(50);

        logger.info('STATE', '状态管理器初始化完成');
    }

    /**
     * 获取状态值
     * @param {string} key - 状态键名
     * @returns {*} 状态值
     */
    get(key) {
        if (key) {
            return this.state[key];
        }
        return { ...this.state }; // 返回状态副本
    }

    /**
     * 设置状态值
     * @param {string} key - 状态键名
     * @param {*} value - 状态值
     * @param {boolean} emit - 是否发送事件
     */
    set(key, value, emit = true) {
        const oldValue = this.state[key];
        this.state[key] = value;
        
        if (emit) {
            this.emit('state-changed', { key, value, oldValue });
            this.emit(`${key}-changed`, { value, oldValue });
        }
        
        logger.debug('STATE', `状态更新: ${key}`, { 
            hasValue: value !== null && value !== undefined,
            type: typeof value 
        });
    }

    /**
     * 批量设置状态
     * @param {Object} updates - 状态更新对象
     * @param {boolean} emit - 是否发送事件
     */
    setBatch(updates, emit = true) {
        const changes = [];
        
        for (const [key, value] of Object.entries(updates)) {
            const oldValue = this.state[key];
            this.state[key] = value;
            changes.push({ key, value, oldValue });
        }
        
        if (emit) {
            this.emit('state-batch-changed', changes);
            changes.forEach(({ key, value, oldValue }) => {
                this.emit(`${key}-changed`, { value, oldValue });
            });
        }
        
        logger.debug('STATE', `批量状态更新`, { count: changes.length });
    }

    /**
     * 更新新闻数据
     * @param {Array} newsData - 新闻数据
     * @param {Array} allEnhanced - 所有增强新闻
     */
    updateNewsData(newsData, allEnhanced = null) {
        this.setBatch({
            newsData: newsData || [],
            allEnhancedNews: allEnhanced || this.state.allEnhancedNews,
            lastUpdated: new Date()
        });
        
        logger.info('STATE', `新闻数据更新`, { 
            displayCount: newsData?.length || 0,
            totalCount: (allEnhanced || this.state.allEnhancedNews)?.length || 0
        });
    }

    /**
     * 更新摘要文章
     * @param {Object} summaryArticle - 摘要文章
     */
    updateSummaryArticle(summaryArticle) {
        this.set('summaryArticle', summaryArticle);
        logger.info('STATE', '摘要文章更新完成');
    }

    /**
     * 更新AI配置
     * @param {Object} aiConfig - AI配置信息
     */
    updateAiConfig(aiConfig) {
        this.set('aiConfig', aiConfig);
        logger.info('STATE', 'AI配置更新完成');
    }

    /**
     * 设置更新状态
     * @param {boolean} isUpdating - 是否正在更新
     * @param {Object} progress - 进度信息
     */
    setUpdateStatus(isUpdating, progress = null) {
        const updates = { isUpdating };

        if (progress) {
            updates.updateProgress = {
                ...this.state.updateProgress,
                ...progress
            };
        }

        this.setBatch(updates);
    }

    /**
     * 更新进度
     * @param {string} stage - 当前阶段
     * @param {number} current - 当前进度
     * @param {number} total - 总数
     * @param {string} message - 进度消息
     */
    updateProgress(stage, current = 0, total = 0, message = '') {
        this.set('updateProgress', {
            stage,
            current,
            total,
            message,
            percentage: total > 0 ? Math.round((current / total) * 100) : 0
        });
    }

    /**
     * 重置状态
     * @param {Array} keys - 要重置的键名数组，不传则重置所有
     */
    reset(keys = null) {
        if (keys) {
            const updates = {};
            keys.forEach(key => {
                if (key === 'newsData' || key === 'allEnhancedNews') {
                    updates[key] = [];
                } else {
                    updates[key] = null;
                }
            });
            this.setBatch(updates);
        } else {
            this.state = {
                newsData: [],
                allEnhancedNews: [],
                summaryArticle: null,
                sourceStats: [],
                lastUpdated: null,
                lastPublishedBy: null,
                isUpdating: false,
                collectionPhase: 'idle',
                updateProgress: {
                    stage: '',
                    current: 0,
                    total: 0,
                    message: ''
                }
            };
            this.emit('state-reset');
        }
        
        logger.info('STATE', '状态重置完成', { keys: keys || 'all' });
    }

    /**
     * 持久化状态到文件
     * @param {string} filePath - 文件路径
     */
    async saveToFile(filePath = null) {
        try {
            const hasValidData = this.state.newsData && this.state.newsData.length > 0;
            if (!hasValidData) {
                return;
            }
            
            const saveData = {
                ...this.state,
                isUpdating: false,
                savedAt: new Date().toISOString(),
                version: '2.0'
            };
            
            const targetPath = filePath || config.storage.stateFile || 'data/state.json';
            await writeJsonFile(targetPath, saveData);
            
            logger.debug('STATE', '状态保存成功', { 
                path: targetPath,
                newsCount: this.state.newsData?.length || 0,
                lastUpdated: this.state.lastUpdated
            });
        } catch (error) {
            logger.error('STATE', '状态保存失败', error.message);
        }
    }

    /**
     * 从文件加载状态
     * @param {string} filePath - 文件路径
     */
    async loadFromFile(filePath = null) {
        try {
            const targetPath = filePath || config.storage.stateFile || 'data/state.json';
            const data = await readJsonFile(targetPath);
            
            if (data && data.version) {
                // 移除元数据
                const { savedAt, version, ...stateData } = data;
                
                // 验证数据结构
                const validKeys = Object.keys(this.state);
                const filteredState = {};
                
                validKeys.forEach(key => {
                    if (stateData.hasOwnProperty(key)) {
                        filteredState[key] = stateData[key];
                    }
                });
                
                this.state = { ...this.state, ...filteredState };
                this.emit('state-loaded', { path: targetPath, savedAt });
                
                logger.info('STATE', '状态加载成功', { 
                    path: targetPath, 
                    savedAt,
                    keys: Object.keys(filteredState).length
                });
            }
        } catch (error) {
            logger.warn('STATE', '状态加载失败，使用默认状态', error.message);
        }
    }

    /**
     * 获取状态统计信息
     */
    getStats() {
        return {
            newsCount: this.state.newsData?.length || 0,
            allEnhancedCount: this.state.allEnhancedNews?.length || 0,
            hasSummary: !!this.state.summaryArticle,
            lastUpdated: this.state.lastUpdated,
            lastPublishedBy: this.state.lastPublishedBy || null,
            isUpdating: this.state.isUpdating,
            collectionPhase: this.state.collectionPhase,
            progress: this.state.updateProgress
        };
    }
}

// 创建单例实例
const stateManager = new StateManager();

module.exports = stateManager;