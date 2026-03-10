const express = require('express');
const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const nodemailer = require('nodemailer');
const EPub = require('epub-gen');
const config = require('../config');
const { writeJsonFile, readJsonFile, formatFileSize } = require('../utils/helpers');
const logger = require('../utils/logger');

const router = express.Router();

/**
 * 初始化API路由
 * @param {Object} services - 服务对象集合
 * @param {Object} io - Socket.IO实例
 * @param {Object} stateManager - 状态管理器实例
 * @returns {Object} Express路由器
 */
function initializeApiRoutes(services, io, stateManager) {
    const { newsService, aiService, audioService } = services;
    
    // 全局变量存储（向后兼容）
    let newsData = [];
    let allEnhancedNews = []; // 存储所有已翻译的新闻
    let lastUpdated = null;
    let summaryArticle = null;
    let podcastInfo = null;
    
    // 启动时加载已有的摘要数据
    (async () => {
        try {
            const loadedSummary = await loadSummaryData();
            if (loadedSummary) {
                summaryArticle = loadedSummary;
                if (stateManager) {
                    stateManager.set('summaryArticle', loadedSummary);
                } else {
                    global.summaryArticle = loadedSummary;
                }
                logger.success('API', '已加载历史摘要数据');
            } else {
                logger.info('API', '未找到历史摘要数据');
            }
        } catch (error) {
            logger.error('API', '加载历史摘要数据失败', error.message);
        }
    })();

    /**
     * 保存摘要数据到文件
     * @param {Object} summary - 摘要数据
     */
    async function saveSummaryData(summary) {
        try {
            const summaryData = {
                article: summary,
                savedAt: new Date().toISOString(),
                version: '1.0'
            };
            await writeJsonFile(config.storage.summaryFile, summaryData);
            logger.success('API', '摘要数据已保存', { file: config.storage.summaryFile });
        } catch (error) {
            logger.error('API', '保存摘要数据失败', error.message);
        }
    }

    /**
     * 从文件加载摘要数据
     * @returns {Object|null} 摘要数据
     */
    async function loadSummaryData() {
        try {
            const summaryData = await readJsonFile(config.storage.summaryFile);
            if (summaryData && summaryData.article) {
                logger.info('API', '已加载摘要数据', { savedAt: summaryData.savedAt });
                return summaryData.article;
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                logger.error('API', '加载摘要数据失败', error.message);
            }
        }
        return null;
    }

    /**
     * 创建邮件传输器
     */
    function createMailTransporter() {
        return nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.secure,
            auth: {
                user: config.smtp.user,
                pass: config.smtp.pass
            }
        });
    }

    /**
     * 生成EPUB文件
     * @param {Object} article - 摘要文章对象
     * @returns {Promise<Object>} EPUB文件信息
     */
    async function generateEpubFile(article) {
        try {
            const epubDir = config.storage.epubDir;
            await fsPromises.mkdir(epubDir, { recursive: true });
            
            // 获取参考时间（优先使用stateManager中的lastUpdated，否则使用当前时间）
            let referenceTime;
            try {
                const lastUpdated = stateManager ? stateManager.get('lastUpdated') : null;
                referenceTime = lastUpdated ? new Date(lastUpdated) : new Date();
            } catch (error) {
                referenceTime = new Date();
            }
            const currentDate = referenceTime.toLocaleDateString('zh-CN').replace(/\//g, '-');
            const filename = `全球新闻摘要_${currentDate}.epub`;
            const epubPath = path.join(epubDir, filename);
            
            const epubOptions = {
                title: article.title,
                author: '聚核 (CoreFeed)',
                publisher: '聚核 (CoreFeed)',
                description: `${article.newsCount}条新闻的AI智能摘要，涵盖${article.regions.join('、')}等地区的重要资讯`,
                cover: null,
                lang: 'zh-CN',
                tocTitle: '目录',
                appendChapterTitles: true,
                customOpfTemplatePath: null,
                customNcxTocTemplatePath: null,
                customHtmlTocTemplatePath: null,
                content: [
                    {
                        title: '新闻摘要概览',
                        data: `
                            <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; line-height: 1.8; color: #333;">
                                <h2 style="color: #2563eb; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px;">📊 本期摘要概览</h2>
                                <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #3b82f6;">
                                    <p><strong>📈 新闻数量:</strong> ${article.newsCount} 条</p>
                                    <p><strong>🌍 涵盖地区:</strong> ${article.regions.join('、')} 等</p>
                                    <p><strong>⏰ 生成时间:</strong> ${new Date(article.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
                                    <p><strong>📝 字数统计:</strong> ${article.wordCount} 字</p>
                                </div>
                            </div>
                        `
                    },
                    {
                        title: article.title,
                        data: `
                            <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; line-height: 1.8; color: #333;">
                                ${article.htmlContent}
                            </div>
                        `
                    }
                ],
                css: `
                    body {
                        font-family: 'Microsoft YaHei', 'PingFang SC', 'Hiragino Sans GB', Arial, sans-serif;
                        line-height: 1.8;
                        color: #333;
                        margin: 0;
                        padding: 20px;
                        background-color: #fff;
                    }
                    h1, h2, h3, h4, h5, h6 {
                        color: #1e40af;
                        margin-top: 1.2em;
                        margin-bottom: 0.6em;
                        font-weight: 600;
                    }
                    h1 { font-size: 1.4em; }
                    h2 { font-size: 1.2em; }
                    h3 { font-size: 1.05em; }
                    p {
                        margin-bottom: 1em;
                        text-align: justify;
                        text-indent: 2em;
                    }
                    .highlight {
                        background-color: #fef3c7;
                        padding: 2px 4px;
                        border-radius: 3px;
                    }
                    .quote {
                        border-left: 4px solid #3b82f6;
                        padding-left: 1em;
                        margin: 1em 0;
                        font-style: italic;
                        color: #6b7280;
                    }
                    @media (max-width: 600px) {
                        body {
                            padding: 10px;
                            font-size: 14px;
                        }
                        h1 { font-size: 1.2em; }
                        h2 { font-size: 1.05em; }
                        h3 { font-size: 0.95em; }
                    }
                `
            };
            
            await new EPub(epubOptions, epubPath).promise;
            
            const stats = await fsPromises.stat(epubPath);
            
            return {
                filename: filename,
                path: epubPath,
                size: stats.size,
                sizeFormatted: formatFileSize(stats.size),
                createdAt: referenceTime.toISOString()
            };
            
        } catch (error) {
            logger.error('API', '生成EPUB文件失败', error.message);
            throw error;
        }
    }

    /**
     * 发送邮件到Kindle
     * @param {string} recipientEmail - 收件人邮箱
     * @param {Object} summaryArticle - 摘要文章
     * @param {string} epubPath - EPUB文件路径
     * @returns {Promise<Object>} 发送结果
     */
    async function sendEmailWithEpub(recipientEmail, summaryArticle, epubPath) {
        try {
            const transporter = createMailTransporter();
            
            // 获取参考时间（优先使用stateManager中的lastUpdated，否则使用当前时间）
            let referenceTime;
            try {
                const lastUpdated = stateManager ? stateManager.get('lastUpdated') : null;
                referenceTime = lastUpdated ? new Date(lastUpdated) : new Date();
            } catch (error) {
                referenceTime = new Date();
            }
            const currentDate = referenceTime.toLocaleDateString('zh-CN', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });

            const mailOptions = {
                from: `"${config.smtp.fromName}" <${config.smtp.fromEmail}>`,
                to: recipientEmail,
                subject: `${currentDate} 全球新闻摘要 - 聚核 (CoreFeed)`,
                html: `
                    <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9fafb;">
                        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; border-radius: 10px; text-align: center; margin-bottom: 30px;">
                            <h1 style="color: white; margin: 0; font-size: 28px;">📰 全球新闻摘要</h1>
                            <p style="color: #e2e8f0; margin: 10px 0 0 0; font-size: 16px;">${currentDate}</p>
                        </div>
                        
                        <div style="background: white; padding: 30px; border-radius: 10px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);">
                            <h2 style="color: #2563eb; margin-top: 0;">📊 本期摘要概览</h2>
                            <div style="background: #f3f4f6; padding: 20px; border-radius: 8px; margin: 20px 0;">
                                <p style="margin: 5px 0;"><strong>📈 新闻数量:</strong> ${summaryArticle.newsCount} 条</p>
                                <p style="margin: 5px 0;"><strong>🌍 涵盖地区:</strong> ${summaryArticle.regions.join('、')} 等</p>
                                <p style="margin: 5px 0;"><strong>⏰ 生成时间:</strong> ${new Date(summaryArticle.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
                            </div>
                            
                            <h3 style="color: #1e40af;">📎 附件说明</h3>
                            <p style="color: #6b7280; line-height: 1.6;">本邮件附带完整的新闻摘要EPUB电子书文件，您可以在任何支持EPUB格式的阅读器中打开，包括：</p>
                            <ul style="color: #6b7280; line-height: 1.6;">
                                <li>📱 手机：Apple Books、Google Play Books、FBReader</li>
                                <li>💻 电脑：Adobe Digital Editions、Calibre</li>
                                <li>📖 电子书阅读器：Kindle、Kobo 等</li>
                            </ul>
                            
                            <div style="background: #dbeafe; border: 1px solid #93c5fd; padding: 15px; border-radius: 8px; margin: 20px 0;">
                                <p style="margin: 0; color: #1e40af;"><strong>💡 提示:</strong> EPUB格式支持自适应排版，可根据您的设备屏幕大小自动调整文字布局，提供最佳阅读体验。</p>
                            </div>
                            
                            <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 30px 0;">
                            
                            <div style="text-align: center; color: #6b7280; font-size: 14px;">
                                <p>本邮件由 <strong>聚核 (CoreFeed)</strong> 自动发送</p>
                                <p>基于AI技术聚合全球优质新闻源，为您提供精准的新闻摘要服务</p>
                            </div>
                        </div>
                    </div>
                `,
                attachments: [
                    {
                        filename: path.basename(epubPath),
                        path: epubPath,
                        contentType: 'application/epub+zip'
                    }
                ]
            };

            const info = await transporter.sendMail(mailOptions);
            logger.success('API', '发送到Kindle成功', { messageId: info.messageId });
            
            return {
                success: true,
                messageId: info.messageId,
                recipient: recipientEmail
            };

        } catch (error) {
            logger.error('API', '发送到Kindle失败', error.message);
            throw error;
        }
    }

    // ==================== 路由定义 ====================

    // 获取新闻数据
    router.get('/news', async (req, res) => {
        try {
            // 简化版本管理：使用时间戳作为版本标识
            const currentTimestamp = Date.now();
            const cacheVersion = Math.floor(currentTimestamp / (5 * 60 * 1000)); // 每5分钟更新一次版本
            
            const currentNewsData = stateManager ? stateManager.get('newsData') || newsData : newsData;
            const currentLastUpdated = stateManager ? stateManager.get('lastUpdated') || lastUpdated : lastUpdated;
            const allNews = stateManager ? 
                stateManager.get('allEnhancedNews') || allEnhancedNews || (global.allEnhancedNews || []) :
                allEnhancedNews.length > 0 ? allEnhancedNews : (global.allEnhancedNews || []);
            
            // 优化缓存控制头
            res.set({
                'Cache-Control': 'no-cache, must-revalidate, max-age=300',
                'Pragma': 'no-cache',
                'Expires': '0',
                'ETag': `"${cacheVersion}"`,
                'Last-Modified': new Date().toUTCString(),
                'X-Data-Version': cacheVersion.toString(),
                'X-Timestamp': new Date().toISOString()
            });
            
            res.json({
                news: currentNewsData,
                lastUpdated: currentLastUpdated,
                total: currentNewsData.length,
                hasMore: allNews.length > currentNewsData.length,
                version: cacheVersion.toString(),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('API', '获取新闻数据失败', error.message);
            res.status(500).json({
                error: '获取新闻数据失败',
                message: error.message
            });
        }
    });

    // 加载更多新闻
    router.get('/news/more', (req, res) => {
        const currentNewsData = stateManager ? stateManager.get('newsData') || newsData : newsData;
        const allNews = stateManager ? 
            stateManager.get('allEnhancedNews') || allEnhancedNews || (global.allEnhancedNews || []) :
            allEnhancedNews.length > 0 ? allEnhancedNews : (global.allEnhancedNews || []);
        const currentCount = currentNewsData.length;
        const remainingNews = allNews.slice(currentCount);
        
        res.json({
            success: true,
            news: remainingNews,
            total: remainingNews.length,
            allTotal: allNews.length
        });
    });

    // 刷新新闻
    router.post('/refresh', async (req, res) => {
        try {
            // 立即返回响应，避免超时
            res.json({ success: true, message: '开始更新新闻' });
            
            // 异步执行新闻获取（使用优化流程）
            // 1. 获取增量更新的新闻数据（只获取新新闻）
            const articles = await newsService.fetchIncrementalNews();
            
            // 如果没有新新闻，直接返回现有数据
            if (articles.length === 0) {
                logger.info('API', '没有发现新新闻，跳过处理');
                
                // 获取现有数据
                const existingNewsData = stateManager ? stateManager.get('newsData') || [] : newsData;
                const existingEnhancedNews = stateManager ? stateManager.get('allEnhancedNews') || [] : allEnhancedNews;
                
                // 发送完成通知
                io.emit('news-updated', {
                    success: true,
                    total: existingNewsData.length,
                    lastUpdated: stateManager ? stateManager.get('lastUpdated') || new Date() : lastUpdated,
                    message: '没有新新闻，使用现有数据'
                });
                
                return;
            }
            
            logger.info('API', `发现 ${articles.length} 条新新闻，开始处理`);
            
            // 2. AI智能去重（在翻译之前进行，节省tokens）
            let dedupedArticles = articles;
            if (articles.length > 1) {
                try {
                    dedupedArticles = await aiService.removeDuplicateNewsWithAI(articles);
                    logger.info('API', `AI deduplicated articles, ${dedupedArticles.length} remaining.`);
                } catch (error) {
                    logger.error('手动刷新 - AI去重失败，继续使用原始数据', { error: error.message });
                }
            }
            
            // 3. AI增强处理（翻译等）- 只处理新新闻
            const enhancedArticles = await aiService.enhanceNewsArticles(dedupedArticles);
            
            // 4. 合并新新闻到现有数据中（并再次去重）
            const existingEnhancedNews = stateManager ? stateManager.get('allEnhancedNews') || [] : allEnhancedNews;
            
            // 合并后再次去重（防止翻译后的新闻与旧新闻重复）
            const mergedEnhancedNews = [...enhancedArticles, ...existingEnhancedNews];
            
            // 使用标题去重（优先使用翻译后的标题）
            const seenTitles = new Set();
            const dedupedMergedNews = mergedEnhancedNews.filter(article => {
                const titleForCheck = (article.translatedTitle || article.title || '').trim().toLowerCase();
                if (!titleForCheck) return false;
                
                // 标准化标题：移除来源后缀和标点
                const normalizedTitle = titleForCheck
                    .replace(/\s*[-|—]\s*[A-Za-z0-9 .,&()]+$/g, '') // 移除来源后缀
                    .replace(/[^\u4e00-\u9fa5a-zA-Z0-9\s]/g, ' ') // 移除标点
                    .replace(/\s+/g, ' ') // 归一空白
                    .trim();
                
                if (seenTitles.has(normalizedTitle)) {
                    return false; // 重复，过滤掉
                }
                
                seenTitles.add(normalizedTitle);
                return true;
            });
            
            logger.debug('API', `合并去重: ${mergedEnhancedNews.length}条 → ${dedupedMergedNews.length}条`);
            
            // 5. 按发布时间排序（最新的在前面）
            dedupedMergedNews.sort((a, b) => {
                const dateA = new Date(a.publishedAt || 0);
                const dateB = new Date(b.publishedAt || 0);
                return dateB - dateA;
            });
            
            // 6. 限制总新闻数量为30条
            const finalArticles = dedupedMergedNews.slice(0, 30);
            
            // 7. 保存所有已翻译的新闻
            if (stateManager) {
                stateManager.set('allEnhancedNews', dedupedMergedNews);
            } else {
                allEnhancedNews = dedupedMergedNews;
            }
            logger.info('API', `新增 ${enhancedArticles.length} 条新闻，合并后总数: ${dedupedMergedNews.length}，显示: ${finalArticles.length} 条`);
            
            // 8. 更新数据
            if (stateManager) {
                stateManager.set('newsData', finalArticles);
                stateManager.set('lastUpdated', new Date());
            } else {
                newsData = finalArticles;
                lastUpdated = new Date();
            }
            newsService.setNewsData(finalArticles);
            newsService.setLastUpdated(new Date());
            
            // 保存到本地
            io.emit('progress', {
                stage: 'saving',
                message: '正在保存新闻数据...',
                progress: 40
            });
            
            await newsService.saveLocalData(finalArticles);
            
            // 发送新闻更新完成通知
            const currentNewsData = stateManager ? stateManager.get('newsData') || finalArticles : finalArticles;
            const currentLastUpdated = stateManager ? stateManager.get('lastUpdated') || new Date() : new Date();
            io.emit('news-updated', {
                success: true,
                total: currentNewsData.length,
                lastUpdated: currentLastUpdated
            });
            
            // 自动生成摘要文章（独立处理）
            let summaryGenerated = false;
            try {
                io.emit('progress', {
                    stage: 'generating-summary',
                    message: '正在生成文字摘要...',
                    progress: 60
                });
                
                const currentNewsData = stateManager ? stateManager.get('newsData') || finalArticles : finalArticles;
                summaryArticle = await aiService.generateNewsSummaryArticle(currentNewsData);
                
                if (stateManager) {
                    stateManager.set('summaryArticle', summaryArticle);
                } else {
                    global.summaryArticle = summaryArticle;
                }
                
                // 保存摘要数据到文件
                await saveSummaryData(summaryArticle);
                
                io.emit('summary-completed', {
                    success: true,
                    article: summaryArticle
                });
                
                summaryGenerated = true;
                logger.success('API', '摘要文章生成成功');
                
            } catch (error) {
                logger.error('API', '生成摘要文章失败', error.message);
                io.emit('summary-error', {
                    success: false,
                    error: error.message
                });
            }
            
            // 自动生成音频（独立处理，不依赖摘要生成）
            let podcastGenerated = false;
            
            // 生成播报脚本
            try {
                io.emit('progress', {
                    stage: 'generating-podcast',
                    message: '正在生成音频对话脚本...',
                    progress: 70
                });
                
                // 使用当前新闻数据生成对话脚本
                const currentNewsData = stateManager ? stateManager.get('newsData') || finalArticles : finalArticles;
                const script = await aiService.generatePodcastScript(currentNewsData);
                
                // 保存脚本数据
                if (stateManager) {
                    stateManager.set('podcastScript', script);
                }
                
                logger.success('API', '播报脚本生成成功');
                
                // 生成音频
                io.emit('progress', {
                    stage: 'generating-podcast',
                    message: '正在生成音频...',
                    progress: 80
                });
                
                // 生成音频
                const podcastResult = await audioService.generatePodcastAudio(script);
                
                if (stateManager) {
                    stateManager.set('podcastInfo', podcastResult);
                } else {
                    podcastInfo = podcastResult;
                    global.podcastInfo = podcastInfo;
                }
                
                // 发送音频完成通知
                io.emit('podcast-completed', {
                    success: true,
                    podcast: podcastResult
                });
                
                podcastGenerated = true;
                logger.success('API', '音频生成成功');
                
            } catch (error) {
                logger.error('API', '播报生成失败', error.message);
                io.emit('podcast-error', {
                    success: false,
                    error: '播报生成失败: ' + error.message
                });
            }
            
            // 发送最终完成进度通知
            let completionMessage = '全部内容生成完成！';
            if (!summaryGenerated && !podcastGenerated) {
                completionMessage = '新闻更新完成，但摘要和音频生成均失败';
            } else if (!summaryGenerated) {
                completionMessage = '新闻更新完成，音频生成成功，但摘要生成失败';
            } else if (!podcastGenerated) {
                completionMessage = '新闻更新完成，摘要生成成功，但音频生成失败';
            }
            
            io.emit('progress', {
                stage: 'completed',
                message: completionMessage,
                progress: 100
            });
            
        } catch (error) {
            logger.error('API', '刷新新闻失败', error.message);
            io.emit('news-updated', {
                success: false,
                error: error.message
            });
        }
    });

    // 版本检查端点
    router.get('/version', (req, res) => {
        try {
            const currentTimestamp = Date.now();
            const cacheVersion = Math.floor(currentTimestamp / (5 * 60 * 1000)); // 每5分钟更新一次版本
            res.json({
                version: cacheVersion.toString(),
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            logger.error('VERSION', '获取版本信息失败', error.message);
            res.status(500).json({
                error: '获取版本信息失败',
                message: error.message
            });
        }
    });

    // 缓存刷新端点
    router.post('/cache/refresh', async (req, res) => {
        try {
            // 清理服务器端状态缓存
            if (stateManager) {
                // 重新加载本地数据
                await newsService.loadLocalData();
                const newsData = newsService.getNewsData();
                const lastUpdated = newsService.getLastUpdated();
                
                if (newsData && newsData.length > 0) {
                    stateManager.updateNewsData(newsData);
                    if (lastUpdated) {
                        stateManager.set('lastUpdated', lastUpdated);
                    }
                }
                
                logger.info('CACHE', '服务器端缓存已刷新', {
                    newsCount: newsData?.length || 0
                });
            }
            
            // 生成新的版本号用于客户端缓存破坏
            const currentTimestamp = Date.now();
            const newVersion = Math.floor(currentTimestamp / (5 * 60 * 1000)); // 每5分钟更新一次版本
            
            res.json({ 
                success: true, 
                message: '缓存刷新成功',
                newVersion: newVersion,
                timestamp: new Date().toISOString()
            });
            
            // 通知所有客户端刷新
            io.emit('cache-refreshed', {
                success: true,
                newVersion: newVersion,
                timestamp: new Date().toISOString()
            });
            
        } catch (error) {
            logger.error('CACHE', '缓存刷新失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '缓存刷新失败: ' + error.message 
            });
        }
    });

    // 生成新闻摘要文章
    router.post('/generate-summary', async (req, res) => {
        try {
            const currentNewsData = stateManager ? stateManager.get('newsData') || newsData : newsData;
            if (!currentNewsData || currentNewsData.length === 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: '暂无新闻数据，请先刷新新闻' 
                });
            }
            
            // 立即返回响应，避免超时
            res.json({ success: true, message: '开始生成新闻摘要文章' });
            
            // 异步生成摘要
            try {
                summaryArticle = await aiService.generateNewsSummaryArticle(currentNewsData);
                
                if (stateManager) {
                    stateManager.set('summaryArticle', summaryArticle);
                } else {
                    global.summaryArticle = summaryArticle;
                }
                
                // 保存摘要数据到文件
                await saveSummaryData(summaryArticle);
                
                // 发送完成通知
                io.emit('summary-completed', {
                    success: true,
                    article: summaryArticle
                });
                
            } catch (error) {
                logger.error('API', '生成摘要失败', error.message);
                io.emit('summary-error', {
                    success: false,
                    error: error.message
                });
            }
            
        } catch (error) {
            logger.error('API', '生成摘要文章失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '生成摘要文章失败: ' + error.message 
            });
        }
    });

    // 获取摘要文章
    router.get('/summary-article', (req, res) => {
        const currentSummaryArticle = stateManager ? 
            stateManager.get('summaryArticle') || summaryArticle || global.summaryArticle || null :
            summaryArticle || global.summaryArticle || null;
        
        res.json({
            success: true,
            article: currentSummaryArticle
        });
    });



    // 生成EPUB文件
    router.post('/generate-epub', async (req, res) => {
        try {
            const currentSummary = stateManager ? 
                stateManager.get('summaryArticle') || summaryArticle || global.summaryArticle :
                summaryArticle || global.summaryArticle;
            if (!currentSummary) {
                return res.status(400).json({ 
                    success: false, 
                    message: '暂无摘要文章，请先生成摘要' 
                });
            }

            const epubResult = await generateEpubFile(currentSummary);
            
            res.json({
                success: true,
                message: 'EPUB文件生成成功',
                epub: epubResult
            });
            
        } catch (error) {
            logger.error('API', '生成EPUB文件失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '生成EPUB文件失败: ' + error.message 
            });
        }
    });

    // 第一套接口已删除，使用下面的第二套接口

    // 第一套POST接口已删除，使用下面的第二套接口

    // 辅助函数：从URL提取域名
    function extractDomainName(url) {
        try {
            const domain = new URL(url).hostname;
            return domain.replace('www.', '').replace(/\..+$/, '').replace(/^./, str => str.toUpperCase());
        } catch {
            return url || 'RSS Source';
        }
    }

    // 下载EPUB文件
    router.get('/download-epub/:filename', async (req, res) => {
        try {
            const filename = req.params.filename;
            const filePath = path.join(process.cwd(), config.storage.epubDir, filename);
            
            // 检查文件是否存在
            try {
                await fsPromises.access(filePath);
            } catch (error) {
                return res.status(404).json({ 
                    success: false, 
                    message: '文件不存在' 
                });
            }
            
            // 设置响应头
            res.setHeader('Content-Type', 'application/epub+zip');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            
            // 发送文件
            res.sendFile(filePath);
            
        } catch (error) {
            logger.error('API', '下载EPUB文件失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '下载文件失败: ' + error.message 
            });
        }
    });

    // 发送邮件到Kindle
    router.post('/send-email', async (req, res) => {
        try {
            if (!config.smtp.defaultRecipient) {
                return res.status(400).json({ 
                    success: false, 
                    message: '未配置默认收件人邮箱，请在配置文件中设置' 
                });
            }
            
            const currentSummary = stateManager ? 
                stateManager.get('summaryArticle') || summaryArticle || global.summaryArticle :
                summaryArticle || global.summaryArticle;
            if (!currentSummary) {
                return res.status(400).json({ 
                    success: false, 
                    message: '暂无摘要文章，请先生成摘要' 
                });
            }
            
            // 生成EPUB文件
            const epubResult = await generateEpubFile(currentSummary);
            
            // 发送到Kindle预设地址
            const emailResult = await sendEmailWithEpub(config.smtp.defaultRecipient, currentSummary, epubResult.path);
            
            res.json({
                success: true,
                message: `已发送到Kindle邮箱 ${config.smtp.defaultRecipient}`,
                email: emailResult,
                epub: epubResult
            });
            
        } catch (error) {
            logger.error('API', '发送到Kindle失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '发送到Kindle失败: ' + error.message 
            });
        }
    });

    // 测试SMTP配置
    router.post('/test-smtp', async (req, res) => {
        try {
            const transporter = createMailTransporter();
            
            // 验证SMTP连接
            await transporter.verify();
            
            res.json({
                success: true,
                message: 'SMTP配置正确，Kindle推送服务可用'
            });
            
        } catch (error) {
            logger.error('API', 'SMTP测试失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: 'SMTP配置错误: ' + error.message 
            });
        }
    });

    // 生成音频
    router.post('/generate-podcast', async (req, res) => {
        try {
            const currentNewsData = stateManager ? stateManager.get('newsData') || newsData : newsData;
            const isDemo = (req.query && (req.query.demo === '1' || req.query.demo === 'true'));
            if (!isDemo && (!currentNewsData || currentNewsData.length === 0)) {
                return res.status(400).json({ 
                    success: false, 
                    message: '暂无新闻数据，请先刷新新闻' 
                });
            }
            
            // 立即返回响应，避免超时
            res.json({ success: true, message: isDemo ? '以演示模式生成音频，请稍候...' : '开始生成音频，请稍候...' });
            
            // 异步生成音频
            try {
                // 发送开始生成音频的进度
                io.emit('podcast-progress', {
                    stage: 'script',
                    message: isDemo ? '演示模式：使用内置脚本' : '正在生成音频对话脚本...',
                    progress: 10
                });
                
                // 生成对话脚本或使用演示脚本
                let script;
                if (isDemo) {
                    const dateStr = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
                    script = `[A] 大家好，今天是${dateStr}，这是一个TTS演示脚本。
[B] 我是李华，下面为您带来两条示例新闻。
[A] 示例新闻一：全球科技公司持续发布新品，推进人工智能落地应用。
[B] 示例新闻二：多国加强经济合作，促进区域贸易与投资增长。
[B] 以上就是今天的演示播报，感谢收听！`;
                } else {
                    script = await aiService.generatePodcastScript(currentNewsData);
                }
                
                // 发送脚本生成完成的进度
                io.emit('podcast-progress', {
                    stage: 'audio',
                    message: '正在生成音频...',
                    progress: 30
                });
                
                // 生成音频（已包含所有新闻内容）
                const podcastResult = await audioService.generatePodcastAudio(script);
                
                if (stateManager) {
                    stateManager.set('podcastInfo', podcastResult);
                } else {
                    podcastInfo = podcastResult;
                    global.podcastInfo = podcastInfo;
                }
                
                // 发送完成的进度
                io.emit('podcast-progress', {
                    stage: 'completed',
                    message: isDemo ? '演示音频生成完成。' : '音频生成完成！音频已覆盖所有新闻内容。',
                    progress: 100,
                    podcast: podcastResult
                });
                
                logger.success('API', isDemo ? '演示音频生成完成' : '音频和新闻音频生成完成');
                
            } catch (error) {
                logger.error('API', '音频生成过程失败', error.message);
                
                // 发送错误进度
                io.emit('podcast-progress', {
                    stage: 'error',
                    message: '音频生成失败: ' + error.message,
                    progress: 0
                });
            }
            
        } catch (error) {
            logger.error('API', '生成音频失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '生成音频失败: ' + error.message 
            });
        }
    });

    // 获取音频信息
    router.get('/podcast', async (req, res) => {
        try {
            // 优先从audioService获取音频信息，确保数据一致性
            let currentPodcast = await audioService.getPodcastInfo();
            if (!currentPodcast) {
                currentPodcast = stateManager ? 
                    stateManager.get('podcastInfo') || podcastInfo || global.podcastInfo || null :
                    podcastInfo || global.podcastInfo || null;
            }
            
            res.json({
                success: true,
                podcast: currentPodcast
            });
        } catch (error) {
            res.json({
                success: false,
                message: '获取音频信息失败: ' + error.message
            });
        }
    });

    // 获取音频信息（用于状态检查）
    router.get('/podcast/info', async (req, res) => {
        try {
            const info = await audioService.getPodcastInfo();
            if (info) {
                res.json({
                    success: true,
                    podcast: info
                });
            } else {
                res.json({
                    success: false,
                    message: '音频信息不存在'
                });
            }
        } catch (error) {
            res.json({
                success: false,
                message: '获取音频信息失败: ' + error.message
            });
        }
    });

    // 获取最新摘要（用于状态检查）
    router.get('/summary/latest', (req, res) => {
        const currentSummary = stateManager ? 
            stateManager.get('summaryArticle') || summaryArticle || global.summaryArticle :
            summaryArticle || global.summaryArticle;
        if (currentSummary) {
            res.json({
                success: true,
                article: currentSummary
            });
        } else {
            res.json({
                success: false,
                message: '摘要不存在'
            });
        }
    });

    // 下载音频片段
    router.get('/podcast/audio/:filename', async (req, res) => {
        try {
            const filename = req.params.filename;
            const filePath = path.join(config.storage.podcastDir, filename);
            
            // 检查文件是否存在
            const exists = await audioService.checkAudioFileExists(filePath);
            if (!exists) {
                return res.status(404).json({ 
                    success: false, 
                    message: '音频文件不存在' 
                });
            }
            
            // 设置响应头
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
            
            // 发送文件
            res.sendFile(filePath);
            
        } catch (error) {
            logger.error('API', '下载音频失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '下载音频失败: ' + error.message 
            });
        }
    });

    // 下载完整音频
    router.get('/podcast/complete', async (req, res) => {
        try {
            // 优先从audioService获取音频信息，确保数据一致性
            let currentPodcast = await audioService.getPodcastInfo();
            if (!currentPodcast) {
                currentPodcast = stateManager ? 
                    stateManager.get('podcastInfo') || podcastInfo || global.podcastInfo :
                    podcastInfo || global.podcastInfo;
            }
            
            if (!currentPodcast || !currentPodcast.mergedAudioPath) {
                return res.status(404).json({ 
                    success: false, 
                    message: '完整音频不存在，请先生成音频' 
                });
            }
            
            // 检查文件是否存在
            const exists = await audioService.checkAudioFileExists(currentPodcast.mergedAudioPath);
            if (!exists) {
                return res.status(404).json({ 
                    success: false, 
                    message: '音频文件不存在' 
                });
            }
            
            // 设置响应头（使用北京时间）
            const now = new Date();
            const beijingTime = new Date(now.getTime() + (8 * 60 * 60 * 1000));
            const filename = `AI新闻音频_${beijingTime.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-')}.mp3`;
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
            
            // 发送文件
            res.sendFile(currentPodcast.mergedAudioPath);
            
        } catch (error) {
            logger.error('API', '下载完整音频失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '下载音频失败: ' + error.message 
            });
        }
    });

    // 获取源配置
    router.get('/sources/config', async (req, res) => {
        try {
            // 从配置中读取当前的源设置
            const apiSources = [];
            const rssSources = [];
            
            // 读取禁用源列表
            const disabledSources = new Set();
            if (config.news.disabledSources && config.news.disabledSources.length > 0) {
                config.news.disabledSources.forEach(source => {
                    if (source.trim()) {
                        disabledSources.add(source.trim());
                    }
                });
            }
            
            // 解析API源
            if (config.news.sources && config.news.sources.length > 0) {
                config.news.sources.forEach(source => {
                    if (source.includes('|')) {
                        const [name, id] = source.split('|').map(s => s.trim());
                        // 检查是否有特定的文章数量配置
                        const maxArticles = config.news.sourceArticleCountsMap[name] || config.news.sourceArticleCountsMap[id] || config.news.maxArticlesPerSource;
                        const enabled = !disabledSources.has(name) && !disabledSources.has(id);
                        apiSources.push({ id, name, enabled, maxArticles });
                    } else {
                        const maxArticles = config.news.sourceArticleCountsMap[source] || config.news.maxArticlesPerSource;
                        const enabled = !disabledSources.has(source);
                        apiSources.push({ id: source, name: source, enabled, maxArticles });
                    }
                });
            }
            
            // 解析RSS源
            if (config.news.rssSources && typeof config.news.rssSources === 'string' && config.news.rssSources.trim()) {
                const rssSourcesArray = config.news.rssSources.split(',').map(s => s.trim()).filter(s => s);
                rssSourcesArray.forEach(source => {
                    if (source.includes('|')) {
                        const [name, url] = source.split('|').map(s => s.trim());
                        const maxArticles = config.news.sourceArticleCountsMap[name] || config.news.maxArticlesPerSource;
                        const enabled = !disabledSources.has(name);
                        rssSources.push({ url, name, enabled, maxArticles });
                    } else {
                        const domainName = extractDomainName(source);
                        const maxArticles = config.news.sourceArticleCountsMap[domainName] || config.news.maxArticlesPerSource;
                        const enabled = !disabledSources.has(domainName);
                        rssSources.push({ url: source, name: domainName, enabled, maxArticles });
                    }
                });
            }
            
            // 解析网页抓取配置
            let webScrapingConfig = {
                enabled: config.webScraping?.enabled || false,
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
            
            // 尝试从sources.json文件读取保存的配置
            try {
                const sourcesConfig = await readJsonFile(config.storage.sourcesFile);
                if (sourcesConfig && sourcesConfig.webScraping) {
                    webScrapingConfig = {
                        enabled: sourcesConfig.webScraping.enabled || false,
                        sources: {
                            ...webScrapingConfig.sources,
                            ...sourcesConfig.webScraping.sources
                        }
                    };
                }
            } catch (error) {
                // 如果读取失败，使用默认配置
                logger.warn('读取sources.json失败，使用默认配置', { error: error.message });
            }
            
            // 从环境变量解析网页抓取源配置
            if (config.news.webScrapingSources) {
                const sources = config.news.webScrapingSources.split(',').map(s => s.trim()).filter(s => s);
                sources.forEach(source => {
                    if (source.includes('apnews.com')) {
                        webScrapingConfig.sources.apNews.enabled = !disabledSources.has('AP News') && !disabledSources.has('apnews.com');
                        webScrapingConfig.sources.apNews.maxArticles = config.news.sourceArticleCountsMap['AP News'] || config.news.sourceArticleCountsMap['apnews.com'] || 5;


                    } else if (source.includes('japantoday.com')) {
                        webScrapingConfig.sources.japanToday.enabled = !disabledSources.has('Japan Today') && !disabledSources.has('japantoday.com');
                        webScrapingConfig.sources.japanToday.maxArticles = config.news.sourceArticleCountsMap['Japan Today'] || config.news.sourceArticleCountsMap['japantoday.com'] || 5;
                    } else if (source.includes('foxnews.com')) {
                        webScrapingConfig.sources.foxNews.enabled = !disabledSources.has('Fox News') && !disabledSources.has('foxnews.com');
                        webScrapingConfig.sources.foxNews.maxArticles = config.news.sourceArticleCountsMap['Fox News'] || config.news.sourceArticleCountsMap['foxnews.com'] || 5;
                    } else if (source.includes('aljazeera.com')) {
                        webScrapingConfig.sources.alJazeera.enabled = !disabledSources.has('Al Jazeera') && !disabledSources.has('aljazeera.com');
                        webScrapingConfig.sources.alJazeera.maxArticles = config.news.sourceArticleCountsMap['Al Jazeera'] || config.news.sourceArticleCountsMap['aljazeera.com'] || 5;
                    } else if (source.includes('channelnewsasia.com')) {
                        webScrapingConfig.sources.channelNewsAsia.enabled = !disabledSources.has('Channel News Asia') && !disabledSources.has('channelnewsasia.com');
                        webScrapingConfig.sources.channelNewsAsia.maxArticles = config.news.sourceArticleCountsMap['Channel News Asia'] || config.news.sourceArticleCountsMap['channelnewsasia.com'] || 5;
                    } else if (source.includes('taipeitimes.com')) {
                        webScrapingConfig.sources.taipeiTimes.enabled = !disabledSources.has('Taipei Times') && !disabledSources.has('taipeitimes.com');
                        webScrapingConfig.sources.taipeiTimes.maxArticles = config.news.sourceArticleCountsMap['Taipei Times'] || config.news.sourceArticleCountsMap['taipeitimes.com'] || 5;
                    } else if (source.includes('nhk.or.jp')) {
                        webScrapingConfig.sources.nhkWorld.enabled = !disabledSources.has('NHK World') && !disabledSources.has('nhk.or.jp');
                        webScrapingConfig.sources.nhkWorld.maxArticles = config.news.sourceArticleCountsMap['NHK World'] || config.news.sourceArticleCountsMap['nhk.or.jp'] || 5;
                    }
                });
                webScrapingConfig.enabled = config.webScraping?.enabled || false;
            }

            res.json({
                apiSources,
                rssSources,
                settings: {
                    newsApiKey: config.news.apiKey || '',
                    newsApiMaxArticles: config.news.newsApiMaxArticles || 20
                },
                gnews: {
                    apiKey: config.gnews?.apiKey || '',
                    enabled: config.gnews?.enabled || false,
                    category: config.gnews?.category || 'general',
                    language: config.gnews?.language || 'en',
                    country: config.gnews?.country || 'us',
                    maxArticles: config.gnews?.maxArticles || 10
                },
                webScraping: webScrapingConfig,
                filter: {
                    enabled: config.filter?.enabled || false,
                    keywords: config.filter?.keywords || [],
                    filterTitle: config.filter?.filterTitle !== false,
                    filterContent: config.filter?.filterContent !== false,
                    filterSource: config.filter?.filterSource !== false
                }
            });
        } catch (error) {
            logger.error('获取源配置失败', { error: error.message });
            res.status(500).json({ error: '获取配置失败: ' + error.message });
        }
    });
    
    // 保存源配置
    router.post('/sources/config', async (req, res) => {
        try {
            const { apiSources, rssSources, settings } = req.body;
            
            // 构建新的配置
            const newConfig = {};
            const sourceArticleCounts = [];
            
            // 处理API源
            const disabledApiSources = [];
            if (apiSources && apiSources.length > 0) {
                const allApiSources = apiSources.map(source => {
                    // 收集每个源的文章数量配置
                    if (source.maxArticles && source.maxArticles !== config.news.maxArticlesPerSource) {
                        const sourceName = source.name && source.name !== source.id ? source.name : source.id;
                        sourceArticleCounts.push(`${sourceName}:${source.maxArticles}`);
                    }
                    // 收集禁用的源
                    if (!source.enabled) {
                        const sourceName = source.name && source.name !== source.id ? source.name : source.id;
                        disabledApiSources.push(sourceName);
                    }
                    return source.name && source.name !== source.id ? `${source.name}|${source.id}` : source.id;
                });
                newConfig.NEWS_SOURCES = allApiSources.join(',');
            } else {
                newConfig.NEWS_SOURCES = '';
            }
            
            // 处理RSS源
            const disabledRssSources = [];
            if (rssSources && rssSources.length > 0) {
                const allRssSources = rssSources.map(source => {
                    // 收集每个源的文章数量配置
                    if (source.maxArticles && source.maxArticles !== config.news.maxArticlesPerSource) {
                        const sourceName = source.name && source.name !== extractDomainName(source.url) ? source.name : extractDomainName(source.url);
                        sourceArticleCounts.push(`${sourceName}:${source.maxArticles}`);
                    }
                    // 收集禁用的源
                    if (!source.enabled) {
                        const sourceName = source.name && source.name !== extractDomainName(source.url) ? source.name : extractDomainName(source.url);
                        disabledRssSources.push(sourceName);
                    }
                    return source.name && source.name !== extractDomainName(source.url) ? `${source.name}|${source.url}` : source.url;
                });
                newConfig.RSS_SOURCES = allRssSources.join(',');
            } else {
                newConfig.RSS_SOURCES = '';
            }
            
            // 保存禁用的源（先初始化）
            const allDisabledSources = [...disabledApiSources, ...disabledRssSources];
            
            // 处理设置
            if (settings) {
                if (settings.newsApiKey !== undefined) {
                    newConfig.NEWS_API_KEY = settings.newsApiKey;
                }
                if (settings.newsApiEnabled !== undefined) {
                    newConfig.NEWS_API_ENABLED = settings.newsApiEnabled;
                }
                if (settings.newsApiMaxArticles !== undefined) {
                    newConfig.NEWS_API_MAX_ARTICLES = settings.newsApiMaxArticles;
                }
            }
            
            // 处理Gnews配置
            if (req.body.gnews) {
                const gnews = req.body.gnews;
                if (gnews.apiKey !== undefined) {
                    newConfig.GNEWS_API_KEY = gnews.apiKey;
                }
                if (gnews.enabled !== undefined) {
                    newConfig.GNEWS_ENABLED = gnews.enabled;
                }
                if (gnews.category !== undefined) {
                    newConfig.GNEWS_CATEGORY = gnews.category;
                }
                if (gnews.language !== undefined) {
                    newConfig.GNEWS_LANGUAGE = gnews.language;
                }
                if (gnews.country !== undefined) {
                    newConfig.GNEWS_COUNTRY = gnews.country;
                }
                if (gnews.maxArticles !== undefined) {
                    newConfig.GNEWS_MAX_ARTICLES = gnews.maxArticles;
                }
            }
            
            // 处理网页抓取配置
            if (req.body.webScraping) {
                const webScraping = req.body.webScraping;
                if (webScraping.enabled !== undefined) {
                    newConfig.WEB_SCRAPING_ENABLED = webScraping.enabled;
                }
                
                // 构建网页抓取源配置
                const webScrapingSources = [];
                if (webScraping.sources) {
                    if (webScraping.sources.apNews && webScraping.sources.apNews.enabled) {
                        webScrapingSources.push('AP News|https://apnews.com/hub/world-news');
                        // 添加到文章数量配置
                        logger.debug('AP News maxArticles配置检查', { 
                maxArticles: webScraping.sources.apNews.maxArticles,
                type: typeof webScraping.sources.apNews.maxArticles,
                defaultValue: config.news.maxArticlesPerSource,
                defaultType: typeof config.news.maxArticlesPerSource
            });
                        logger.debug('AP News配置比较结果', { 
                comparison: webScraping.sources.apNews.maxArticles !== config.news.maxArticlesPerSource
            });
                        logger.debug('AP News布尔检查', { 
                booleanCheck: !!webScraping.sources.apNews.maxArticles
            });
                        if (webScraping.sources.apNews.maxArticles && webScraping.sources.apNews.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`AP News:${webScraping.sources.apNews.maxArticles}`);
                            logger.debug('添加AP News到sourceArticleCounts', { 
                    source: 'AP News',
                    maxArticles: webScraping.sources.apNews.maxArticles
                });
                        } else {
                            logger.debug('AP News maxArticles未添加', { 
                    value: webScraping.sources.apNews.maxArticles
                });
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('AP News');
                    }
                    


                    // 处理Japan Today配置
                    if (webScraping.sources.japanToday && webScraping.sources.japanToday.enabled) {
                        webScrapingSources.push('Japan Today|https://japantoday.com/');
                        // 添加到文章数量配置
                        if (webScraping.sources.japanToday.maxArticles && webScraping.sources.japanToday.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`Japan Today:${webScraping.sources.japanToday.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('Japan Today');
                    }
                    
                    // 处理Fox News配置
                    if (webScraping.sources.foxNews && webScraping.sources.foxNews.enabled) {
                        webScrapingSources.push('Fox News|https://www.foxnews.com/world');
                        // 添加到文章数量配置
                        if (webScraping.sources.foxNews.maxArticles && webScraping.sources.foxNews.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`Fox News:${webScraping.sources.foxNews.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('Fox News');
                    }
                    
                    // 处理Al Jazeera配置
                    if (webScraping.sources.alJazeera && webScraping.sources.alJazeera.enabled) {
                        webScrapingSources.push('Al Jazeera|https://www.aljazeera.com/news/');
                        // 添加到文章数量配置
                        if (webScraping.sources.alJazeera.maxArticles && webScraping.sources.alJazeera.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`Al Jazeera:${webScraping.sources.alJazeera.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('Al Jazeera');
                    }
                    
                    // 处理Channel News Asia配置
                    if (webScraping.sources.channelNewsAsia && webScraping.sources.channelNewsAsia.enabled) {
                        webScrapingSources.push('Channel News Asia|https://www.channelnewsasia.com/us');
                        // 添加到文章数量配置
                        if (webScraping.sources.channelNewsAsia.maxArticles && webScraping.sources.channelNewsAsia.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`Channel News Asia:${webScraping.sources.channelNewsAsia.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('Channel News Asia');
                    }
                    
                    // 处理Taipei Times配置
                    if (webScraping.sources.taipeiTimes && webScraping.sources.taipeiTimes.enabled) {
                        webScrapingSources.push('Taipei Times|https://www.taipeitimes.com/News/front');
                        // 添加到文章数量配置
                        if (webScraping.sources.taipeiTimes.maxArticles && webScraping.sources.taipeiTimes.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`Taipei Times:${webScraping.sources.taipeiTimes.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('Taipei Times');
                    }
                    
                    // 处理NHK World配置
                    if (webScraping.sources.nhkWorld && webScraping.sources.nhkWorld.enabled) {
                        webScrapingSources.push('NHK World|https://www3.nhk.or.jp/nhkworld/en/news/list/');
                        // 添加到文章数量配置
                        if (webScraping.sources.nhkWorld.maxArticles && webScraping.sources.nhkWorld.maxArticles !== config.news.maxArticlesPerSource) {
                            sourceArticleCounts.push(`NHK World:${webScraping.sources.nhkWorld.maxArticles}`);
                        }
                    } else {
                        // 如果禁用，添加到禁用源列表
                        allDisabledSources.push('NHK World');
                    }
                    

                }
                
                newConfig.WEB_SCRAPING_SOURCES = webScrapingSources.join(',');
                
                // 更新禁用源列表
                newConfig.DISABLED_SOURCES = allDisabledSources.join(',');
            }
            
            // 保存每个源的文章数量配置（在所有源处理完成后）
            logger.debug('最终sourceArticleCounts数组', { sourceArticleCounts });
            newConfig.SOURCE_ARTICLE_COUNTS = sourceArticleCounts.join(',');
            logger.debug('最终SOURCE_ARTICLE_COUNTS', { value: newConfig.SOURCE_ARTICLE_COUNTS });
            
            // 如果没有处理webScraping，确保DISABLED_SOURCES被设置
            if (!req.body.webScraping) {
                newConfig.DISABLED_SOURCES = allDisabledSources.join(',');
            }
            
            // 处理关键词过滤配置
            if (req.body.filter) {
                const filter = req.body.filter;
                if (filter.enabled !== undefined) {
                    newConfig.FILTER_ENABLED = filter.enabled;
                }
                if (filter.keywords !== undefined) {
                    newConfig.FILTER_KEYWORDS = Array.isArray(filter.keywords) ? filter.keywords.join(',') : '';
                }
                if (filter.filterTitle !== undefined) {
                    newConfig.FILTER_TITLE = filter.filterTitle;
                }
                if (filter.filterContent !== undefined) {
                    newConfig.FILTER_CONTENT = filter.filterContent;
                }
                if (filter.filterSource !== undefined) {
                    newConfig.FILTER_SOURCE = filter.filterSource;
                }
            }
            
            // 确保保留现有的NEWS_API_KEY（如果没有在settings中明确设置）
            if (!newConfig.hasOwnProperty('NEWS_API_KEY') && config.news.apiKey) {
                newConfig.NEWS_API_KEY = config.news.apiKey;
            }
            
            // 保存配置到持久化文件
            const settingsPath = path.join(config.storage.dataDir, 'settings.json');
            let currentSettings = {};
            try {
                if (fs.existsSync(settingsPath)) {
                    currentSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
                }
            } catch (e) {
                logger.warn('读取现有settings.json失败，将创建新文件');
            }

            const updatedSettings = { ...currentSettings, ...newConfig };
            
            try {
                await fsPromises.writeFile(settingsPath, JSON.stringify(updatedSettings, null, 2));
                logger.info('配置已保存到 settings.json', { keys: Object.keys(newConfig) });
            } catch (e) {
                logger.error('保存 settings.json 失败', e);
                // 不中断流程，继续尝试更新 .env (虽然在docker中可能无效)
            }

            // 更新.env文件
            const envPath = path.join(process.cwd(), '.env');
            let envContent = '';
            
            try {
                envContent = fs.readFileSync(envPath, 'utf8');
            } catch (error) {
                logger.info('.env文件不存在，将创建新文件');
            }
            
            const envLines = envContent.split('\n');
            const updatedLines = [];
            const processedKeys = new Set();
            
            // 更新现有配置
            for (const line of envLines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                    updatedLines.push(line);
                    continue;
                }
                
                const equalIndex = trimmedLine.indexOf('=');
                if (equalIndex === -1) {
                    updatedLines.push(line);
                    continue;
                }
                
                const key = trimmedLine.substring(0, equalIndex).trim();
                if (newConfig.hasOwnProperty(key)) {
                    // 只有当这个key还没有被处理过时才添加
                    if (!processedKeys.has(key)) {
                        // 确保值不为undefined或null
                        const value = newConfig[key] !== undefined && newConfig[key] !== null ? newConfig[key] : '';
                        updatedLines.push(`${key}=${value}`);
                        processedKeys.add(key);
                    }
                    // 如果已经处理过，跳过这一行（避免重复）
                } else {
                    updatedLines.push(line);
                }
            }
            
            // 添加新的配置项
            for (const [key, value] of Object.entries(newConfig)) {
                if (!processedKeys.has(key)) {
                    // 确保值不为undefined或null
                    const safeValue = value !== undefined && value !== null ? value : '';
                    updatedLines.push(`${key}=${safeValue}`);
                }
            }
            
            // 写入.env文件
            try {
                const newContent = updatedLines.join('\n');
                fs.writeFileSync(envPath, newContent);
                logger.info('.env文件保存成功', { fileSize: newContent.length });
                
                // 强制刷新文件系统缓存
                fs.fsyncSync(fs.openSync(envPath, 'r+'));
                logger.info('.env文件已同步到磁盘');
                
            } catch (writeError) {
                logger.error('写入.env文件失败', { error: writeError.message });
                throw new Error('写入.env文件失败: ' + writeError.message);
            }
            
            // 同时保存sources.json文件
            if (req.body.webScraping) {
                try {
                    const sourcesData = {
                        webScraping: req.body.webScraping
                    };
                    await writeJsonFile(config.storage.sourcesFile, sourcesData);
                    logger.info('sources.json文件保存成功');
                } catch (sourcesError) {
                    logger.error('写入sources.json文件失败', { error: sourcesError.message });
                    // 不抛出错误，因为.env文件已经保存成功
                    logger.warn('sources.json保存失败，但.env文件已保存');
                }
            }
            
            // 同步重新加载配置
            logger.info('源配置已更新，正在重新加载配置...');
            
            try {
                // 手动更新process.env中的值
                for (const [key, value] of Object.entries(newConfig)) {
                    process.env[key] = value;
                }
                
                // 清除require缓存，重新加载配置
                delete require.cache[require.resolve('../config')];
                const newConfigModule = require('../config');
                
                // 更新全局配置引用
                Object.assign(config, newConfigModule);
                
                logger.info('配置验证通过');
                logger.info('源配置重新加载完成');
                
                // 发送配置保存成功响应（在配置重新加载完成后）
                res.json({ success: true, message: '配置保存成功，正在重新加载配置...' });
                
                // 通过Socket.IO通知前端配置已更新
                io.emit('config-updated', {
                    message: '源配置已保存并重新加载',
                    timestamp: new Date().toISOString()
                });
                
            } catch (error) {
                logger.error('重新加载源配置失败', { error: error.message });
                
                // 通知前端配置重载失败
                io.emit('config-reload-error', {
                    message: '源配置重新加载失败: ' + error.message,
                    timestamp: new Date().toISOString()
                });
                
                // 如果配置重新加载失败，仍然发送成功响应（因为文件已保存）
                res.json({ success: true, message: '配置保存成功，但重新加载失败，请重启服务器' });
            }
            
        } catch (error) {
            logger.error('保存源配置时出错', { error: error.message });
            res.status(500).json({ error: '保存源配置失败: ' + error.message });
        }
    });

    // 获取系统状态
    router.get('/status', async (req, res) => {
        try {
            const audioStats = await audioService.getAudioDirectoryStats();
            
            res.json({
                success: true,
                status: {
                    news: {
                        total: newsData.length,
                        lastUpdated: lastUpdated
                    },
                    summary: {
                        exists: !!(summaryArticle || global.summaryArticle),
                        generatedAt: (summaryArticle || global.summaryArticle)?.generatedAt
                    },
                    podcast: {
                        exists: !!(podcastInfo || global.podcastInfo),
                        createdAt: (podcastInfo || global.podcastInfo)?.createdAt
                    },
                    audio: audioStats,
                    config: {
                        newsApiConfigured: !!config.news.apiKey,
                        aiConfigured: !!(config.minimax && config.minimax.apiKey),
                        ttsConfigured: !!(config.tts && config.tts.baseUrl),
                        smtpConfigured: !!config.smtp.host
                    }
                }
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: '获取系统状态失败: ' + error.message
            });
        }
    });

    // 获取定时任务配置
    router.get('/schedule/config', (req, res) => {
        try {
            const scheduleManager = req.app.locals.services?.scheduleManager;
            if (!scheduleManager) {
                return res.status(500).json({ error: '定时任务管理器未初始化' });
            }

            // 直接从.env文件读取最新配置，避免config对象缓存问题
            const envPath = path.join(process.cwd(), '.env');
            let autoUpdateEnabled = false;
            let updateTimes = ['08:00'];
            
            try {
                const envContent = fs.readFileSync(envPath, 'utf8');
                const envLines = envContent.split('\n');
                
                for (const line of envLines) {
                    const trimmedLine = line.trim();
                    if (!trimmedLine || trimmedLine.startsWith('#')) continue;
                    
                    const equalIndex = trimmedLine.indexOf('=');
                    if (equalIndex === -1) continue;
                    
                    const key = trimmedLine.substring(0, equalIndex).trim();
                    const value = trimmedLine.substring(equalIndex + 1).trim();
                    
                    if (key === 'AUTO_UPDATE_ENABLED') {
                        autoUpdateEnabled = value === 'true' || value === '1';
                    } else if (key === 'UPDATE_TIMES' && value) {
                        updateTimes = value.split(',').map(time => time.trim()).filter(time => time);
                        if (updateTimes.length === 0) {
                            updateTimes = ['08:00'];
                        }
                    } else if (key === 'UPDATE_TIME' && value && updateTimes.length === 1 && updateTimes[0] === '08:00') {
                        // 向后兼容：如果没有UPDATE_TIMES但有UPDATE_TIME，使用UPDATE_TIME
                        updateTimes = [value];
                    }
                }
            } catch (envError) {
                if (envError.code === 'ENOENT') {
                    logger.info('.env文件不存在，使用默认配置');
                } else {
                    logger.warn('读取.env文件失败，使用默认配置', { error: envError.message });
                }
                // 如果读取.env失败，回退到config对象
                autoUpdateEnabled = config.news.autoUpdateEnabled || false;
                if (config.news.updateTimes && config.news.updateTimes.length > 0) {
                    updateTimes = Array.isArray(config.news.updateTimes) ? config.news.updateTimes : [config.news.updateTimes];
                } else if (config.news.updateTime) {
                    updateTimes = [config.news.updateTime];
                }
            }

            res.json({
                success: true,
                config: {
                    autoUpdateEnabled: autoUpdateEnabled,
                    updateFrequency: 'daily',
                    updateTimes: updateTimes,
                    nextExecution: scheduleManager.getNextExecutionTime ? scheduleManager.getNextExecutionTime() : null,
                    isRunning: scheduleManager.isRunning
                }
            });
        } catch (error) {
            logger.error('获取定时任务配置失败', { error: error.message });
            res.status(500).json({ error: '获取定时任务配置失败: ' + error.message });
        }
    });

    // 保存定时任务配置
    router.post('/schedule/config', async (req, res) => {
        try {
            const { autoUpdateEnabled, updateTimes } = req.body;
            const scheduleManager = req.app.locals.services?.scheduleManager;
            
            if (!scheduleManager) {
                return res.status(500).json({ error: '定时任务管理器未初始化' });
            }

            // 验证更新时间格式
            if (updateTimes && Array.isArray(updateTimes)) {
                const timeRegex = /^([01]?[0-9]|2[0-3]):[0-5][0-9]$/;
                for (const time of updateTimes) {
                    if (!timeRegex.test(time)) {
                        return res.status(400).json({ error: `无效的时间格式: ${time}` });
                    }
                }
            }

            // 构建新的配置
            const newConfig = {};
            
            if (autoUpdateEnabled !== undefined) {
                newConfig.AUTO_UPDATE_ENABLED = autoUpdateEnabled.toString();
            }
            if (updateTimes !== undefined) {
                newConfig.UPDATE_TIMES = Array.isArray(updateTimes) ? updateTimes.join(',') : updateTimes;
            }
            newConfig.UPDATE_FREQUENCY = 'daily';
            
            // 确保保留现有的重要配置
            if (config.news.apiKey) {
                newConfig.NEWS_API_KEY = config.news.apiKey;
            }
            if (config.news.sources && config.news.sources.length > 0) {
                newConfig.NEWS_SOURCES = config.news.sources.join(',');
            }
            if (config.news.rssSources) {
                if (typeof config.news.rssSources === 'string') {
                    newConfig.RSS_SOURCES = config.news.rssSources;
                } else if (Array.isArray(config.news.rssSources) && config.news.rssSources.length > 0) {
                    newConfig.RSS_SOURCES = config.news.rssSources.join(',');
                }
            }
            if (config.news.disabledSources && config.news.disabledSources.length > 0) {
                newConfig.DISABLED_SOURCES = config.news.disabledSources.join(',');
            }
            if (config.news.sourceArticleCountsMap) {
                const counts = Object.entries(config.news.sourceArticleCountsMap)
                    .map(([source, count]) => `${source}:${count}`)
                    .join(',');
                if (counts) {
                    newConfig.SOURCE_ARTICLE_COUNTS = counts;
                }
            }

            // 更新.env文件
            const envPath = path.join(process.cwd(), '.env');
            let envContent = '';
            
            try {
                envContent = fs.readFileSync(envPath, 'utf8');
            } catch (error) {
                logger.info('.env文件不存在，将创建新文件');
            }

            const envLines = envContent.split('\n');
            const updatedLines = [];
            const processedKeys = new Set();

            // 更新现有配置
            for (const line of envLines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                    updatedLines.push(line);
                    continue;
                }
                
                const equalIndex = trimmedLine.indexOf('=');
                if (equalIndex === -1) {
                    updatedLines.push(line);
                    continue;
                }
                
                const key = trimmedLine.substring(0, equalIndex).trim();
                if (newConfig.hasOwnProperty(key)) {
                    // 确保值不为undefined或null
                    const value = newConfig[key] !== undefined && newConfig[key] !== null ? newConfig[key] : '';
                    updatedLines.push(`${key}=${value}`);
                    processedKeys.add(key);
                } else {
                    updatedLines.push(line);
                }
            }

            // 添加新的配置项
            for (const [key, value] of Object.entries(newConfig)) {
                if (!processedKeys.has(key)) {
                    // 确保值不为undefined或null
                    const safeValue = value !== undefined && value !== null ? value : '';
                    updatedLines.push(`${key}=${safeValue}`);
                }
            }

            // 写入.env文件
            try {
                const newContent = updatedLines.join('\n');
                fs.writeFileSync(envPath, newContent);
                logger.info('定时任务配置.env文件保存成功', { fileSize: newContent.length });
                
                // 强制刷新文件系统缓存
                fs.fsyncSync(fs.openSync(envPath, 'r+'));
                logger.info('定时任务配置.env文件已同步到磁盘');
                
            } catch (writeError) {
                logger.error('写入定时任务配置.env文件失败', { error: writeError.message });
                throw new Error('写入.env文件失败: ' + writeError.message);
            }

            // 发送配置保存成功响应
            res.json({ success: true, message: '定时任务配置已更新' });

            // 异步重新加载配置，不重启服务器
            setTimeout(() => {
                logger.info('定时任务配置已更新，正在重新加载配置...');
                
                try {
                    // 清除require缓存，重新加载配置
                    delete require.cache[require.resolve('../config')];
                    const newConfigModule = require('../config');
                    
                    // 更新全局配置引用
                    Object.assign(config, newConfigModule);
                    
                    // 通过Socket.IO通知前端配置已更新
                    io.emit('schedule-config-updated', {
                        message: '定时任务配置已保存并重新加载',
                        timestamp: new Date().toISOString()
                    });
                    
                    logger.info('定时任务配置重新加载完成');
                    
                } catch (error) {
                    logger.error('重新加载定时任务配置失败', { error: error.message });
                    
                    // 通知前端配置重载失败
                    io.emit('schedule-config-reload-error', {
                        message: '定时任务配置重新加载失败: ' + error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }, 500);
            
        } catch (error) {
            logger.error('保存定时任务配置时出错', { error: error.message });
            res.status(500).json({ error: '保存定时任务配置失败: ' + error.message });
        }
    });

    // 手动触发定时任务
    router.post('/schedule/trigger', async (req, res) => {
        try {
            const scheduleManager = req.app.locals.services?.scheduleManager;

            if (!scheduleManager) {
                return res.status(500).json({ error: '定时任务管理器未初始化' });
            }

            // 手动执行更新任务
            scheduleManager.executeUpdate();

            res.json({
                success: true,
                message: '定时任务已手动触发，正在执行新闻更新...'
            });

        } catch (error) {
            logger.error('手动触发定时任务失败', { error: error.message });
            res.status(500).json({ error: '手动触发定时任务失败: ' + error.message });
        }
    });

    // 获取AI配置
    router.get('/ai/config', (req, res) => {
        try {
            res.json({
                success: true,
                aiConfig: {
                    apiKey: config.minimax.apiKey || '',
                    baseUrl: config.minimax.baseUrl || 'https://api.minimaxi.com/v1',
                    model: config.minimax.model || 'MiniMax-M2.5',
                    rateLimitRpm: config.minimax.rateLimitRpm || 60,
                    rateLimitBurst: config.minimax.rateLimitBurst || 10
                }
            });
        } catch (error) {
            logger.error('获取AI配置失败', { error: error.message });
            res.status(500).json({ error: '获取AI配置失败: ' + error.message });
        }
    });

    // 保存AI配置
    router.post('/ai/config', async (req, res) => {
        try {
            const { apiKey, baseUrl, model, rateLimitRpm, rateLimitBurst } = req.body;

            // 验证必需参数
            if (!apiKey) {
                return res.status(400).json({ error: 'API Key是必需的' });
            }
            if (!baseUrl) {
                return res.status(400).json({ error: 'Base URL是必需的' });
            }
            if (!model) {
                return res.status(400).json({ error: '模型名称是必需的' });
            }

            // 构建新的配置
            const newConfig = {
                AI_API_KEY: apiKey,
                AI_BASE_URL: baseUrl,
                AI_MODEL: model,
                AI_RATE_LIMIT_RPM: rateLimitRpm || 60,
                AI_RATE_LIMIT_BURST: rateLimitBurst || 10
            };

            // 保留现有配置
            if (config.news.apiKey) {
                newConfig.NEWS_API_KEY = config.news.apiKey;
            }
            if (config.news.sources && config.news.sources.length > 0) {
                newConfig.NEWS_SOURCES = config.news.sources.join(',');
            }
            if (config.news.rssSources) {
                if (typeof config.news.rssSources === 'string') {
                    newConfig.RSS_SOURCES = config.news.rssSources;
                } else if (Array.isArray(config.news.rssSources) && config.news.rssSources.length > 0) {
                    newConfig.RSS_SOURCES = config.news.rssSources.join(',');
                }
            }
            if (config.news.disabledSources && config.news.disabledSources.length > 0) {
                newConfig.DISABLED_SOURCES = config.news.disabledSources.join(',');
            }

            // 更新.env文件
            const envPath = path.join(process.cwd(), '.env');
            let envContent = '';

            try {
                envContent = fs.readFileSync(envPath, 'utf8');
            } catch (error) {
                logger.info('.env文件不存在，将创建新文件');
            }

            const envLines = envContent.split('\n');
            const updatedLines = [];
            const processedKeys = new Set();

            // 更新现有配置
            for (const line of envLines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith('#')) {
                    updatedLines.push(line);
                    continue;
                }

                const equalIndex = trimmedLine.indexOf('=');
                if (equalIndex === -1) {
                    updatedLines.push(line);
                    continue;
                }

                const key = trimmedLine.substring(0, equalIndex).trim();
                if (newConfig.hasOwnProperty(key)) {
                    // 确保值不为undefined或null
                    const value = newConfig[key] !== undefined && newConfig[key] !== null ? newConfig[key] : '';
                    updatedLines.push(`${key}=${value}`);
                    processedKeys.add(key);
                } else {
                    updatedLines.push(line);
                }
            }

            // 添加新的配置项
            for (const [key, value] of Object.entries(newConfig)) {
                if (!processedKeys.has(key)) {
                    // 确保值不为undefined或null
                    const safeValue = value !== undefined && value !== null ? value : '';
                    updatedLines.push(`${key}=${safeValue}`);
                }
            }

            // 写入.env文件
            try {
                const newContent = updatedLines.join('\n');
                fs.writeFileSync(envPath, newContent);
                logger.info('AI配置.env文件保存成功', { fileSize: newContent.length });

                // 强制刷新文件系统缓存
                fs.fsyncSync(fs.openSync(envPath, 'r+'));
                logger.info('AI配置.env文件已同步到磁盘');

            } catch (writeError) {
                logger.error('写入AI配置.env文件失败', { error: writeError.message });
                throw new Error('写入.env文件失败: ' + writeError.message);
            }

            // 发送配置保存成功响应
            res.json({ success: true, message: 'AI配置已更新' });

            // 异步重新加载配置，不重启服务器
            setTimeout(() => {
                logger.info('AI配置已更新，正在重新加载配置...');

                try {
                    // 清除require缓存，重新加载配置
                    delete require.cache[require.resolve('../config')];
                    const newConfigModule = require('../config');

                    // 更新全局配置引用
                    Object.assign(config, newConfigModule);

                    // 通过Socket.IO通知前端配置已更新
                    io.emit('ai-config-updated', {
                        message: 'AI配置已保存并重新加载',
                        timestamp: new Date().toISOString()
                    });

                    logger.info('AI配置重新加载完成');

                } catch (error) {
                    logger.error('重新加载AI配置失败', { error: error.message });

                    // 通知前端配置重载失败
                    io.emit('ai-config-reload-error', {
                        message: 'AI配置重新加载失败: ' + error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }, 500);

        } catch (error) {
            logger.error('保存AI配置时出错', { error: error.message });
            res.status(500).json({ error: '保存AI配置失败: ' + error.message });
        }
    });

    // 健康检查端点
    router.get('/health', (req, res) => {
        res.json({
            success: true,
            status: 'ok',
            timestamp: new Date().toISOString()
        });
    });

    // 检查.env文件内容的端点
    router.get('/env-check', (req, res) => {
        try {
            const envPath = path.join(process.cwd(), '.env');
            const envContent = fs.readFileSync(envPath, 'utf8');
            const envLines = envContent.split('\n');
            
            const envData = {};
            envLines.forEach(line => {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    const [key, ...valueParts] = trimmedLine.split('=');
                    if (key) {
                        envData[key] = valueParts.join('=');
                    }
                }
            });
            
            res.json({
                success: true,
                fileSize: envContent.length,
                lineCount: envLines.length,
                envData: envData,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: '读取.env文件失败: ' + error.message
            });
         }
     });

    // 数据初始化函数
    async function initializeData() {
        try {
            // 加载本地新闻数据
            const localData = await readJsonFile(path.join(process.cwd(), config.storage.newsDataPath));
            if (localData && localData.news) {
                newsData = localData.news;
                lastUpdated = localData.lastUpdated ? new Date(localData.lastUpdated) : null;
                newsService.setNewsData(newsData);
                newsService.setLastUpdated(lastUpdated);
                logger.info('已加载本地新闻数据', `共${newsData.length}条`);
            }
        } catch (error) {
            logger.info('没有找到本地新闻数据，将在首次刷新时获取');
        }
    }

    // 获取聚合的最新数据（专为第三方程序设计）
    router.get('/latest-data', async (req, res) => {
        try {
            // 1. 获取新闻数据
            const currentNewsData = stateManager ? stateManager.get('newsData') || newsData : newsData;
            const currentLastUpdated = stateManager ? stateManager.get('lastUpdated') || lastUpdated : lastUpdated;
            
            // 2. 获取摘要数据
            const currentSummary = stateManager ? 
                stateManager.get('summaryArticle') || summaryArticle || global.summaryArticle :
                summaryArticle || global.summaryArticle;
                
            // 3. 获取音频数据
            let currentPodcast = await audioService.getPodcastInfo();
            if (!currentPodcast) {
                currentPodcast = stateManager ? 
                    stateManager.get('podcastInfo') || podcastInfo || global.podcastInfo :
                    podcastInfo || global.podcastInfo;
            }
            
            // 构造完整的响应对象
            const responseData = {
                meta: {
                    timestamp: new Date().toISOString(),
                    version: '1.0',
                    serverTime: new Date().toISOString()
                },
                news: {
                    count: currentNewsData.length,
                    lastUpdated: currentLastUpdated,
                    items: currentNewsData.map(item => ({
                        id: item.url, // 使用URL作为ID
                        title: item.translatedTitle || item.title,
                        originalTitle: item.title,
                        description: item.description,
                        region: item.region || '国际', // 包含地域信息
                        source: item.source?.name,
                        publishedAt: item.publishedAt,
                        url: item.url
                    }))
                },
                summary: currentSummary ? {
                    available: true,
                    title: currentSummary.title,
                    generatedAt: currentSummary.generatedAt,
                    content: currentSummary.htmlContent, // HTML格式内容
                    wordCount: currentSummary.wordCount,
                    regions: currentSummary.regions
                } : { available: false },
                podcast: currentPodcast ? {
                    available: true,
                    duration: currentPodcast.duration,
                    size: currentPodcast.sizeFormatted,
                    createdAt: currentPodcast.createdAt,
                    downloadUrl: `/api/podcast/complete` // 相对路径，客户端需拼接域名
                } : { available: false }
            };
            
            res.json({
                success: true,
                data: responseData
            });
            
        } catch (error) {
            logger.error('API', '获取聚合数据失败', error.message);
            res.status(500).json({ 
                success: false, 
                message: '获取数据失败: ' + error.message 
            });
        }
    });

    // 初始化数据
    initializeData();

    return router;
}

module.exports = initializeApiRoutes;