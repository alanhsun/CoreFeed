const path = require('path');
const fsPromises = require('fs').promises;
const nodemailer = require('nodemailer');
const EPub = require('epub-gen');
const config = require('../config');
const { formatFileSize } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * EPUB 电子书生成与 Kindle 邮件推送服务
 */
class EpubEmailService {
    constructor(stateManager = null) {
        this.stateManager = stateManager;
    }

    createMailTransporter() {
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
     * 生成 EPUB 电子书文件
     */
    async generateEpubFile(article, newsList = []) {
        if (!article || (!article.htmlContent && !article.content)) {
            throw new Error('摘要文章内容为空，无法生成EPUB');
        }

        const epubDir = config.storage.epubDir;
        await fsPromises.mkdir(epubDir, { recursive: true });

        let referenceTime = new Date();
        try {
            const lastUpdated = this.stateManager ? this.stateManager.get('lastUpdated') : null;
            if (lastUpdated) referenceTime = new Date(lastUpdated);
        } catch (_) {}

        const currentDate = referenceTime.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-');
        const filename = `全球新闻摘要_${currentDate}.epub`;
        const epubPath = path.join(epubDir, filename);

        const regions = Array.isArray(article.regions) && article.regions.length > 0 ? article.regions : ['全球'];
        const htmlBody = article.htmlContent || `<p>${(article.content || '').replace(/\n+/g, '</p><p>')}</p>`;

        // 附加精选情报卡片章节（如果有 newsList）
        const chapters = [
            {
                title: '本期情报概览',
                data: `
                    <div style="font-family: 'Microsoft YaHei', sans-serif; line-height: 1.8; color: #1e293b;">
                        <h2 style="color: #1d4ed8; border-bottom: 2px solid #e2e8f0; padding-bottom: 8px;">📊 全球知名信源情报简报</h2>
                        <div style="background: #f8fafc; padding: 16px; border-radius: 8px; margin: 16px 0; border-left: 4px solid #2563eb;">
                            <p><strong>📈 精选情报数:</strong> ${article.newsCount || newsList.length || 30} 条</p>
                            <p><strong>🌍 覆盖地区:</strong> ${regions.join('、')}</p>
                            <p><strong>⏰ 生成时间:</strong> ${new Date(article.generatedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
                            <p><strong>📝 综述字数:</strong> ${article.wordCount || (article.content || '').length} 字</p>
                        </div>
                    </div>
                `
            },
            {
                title: article.title || `${currentDate} 全球要闻深度综述`,
                data: `
                    <div style="font-family: 'Microsoft YaHei', sans-serif; line-height: 1.8; color: #1e293b;">
                        ${htmlBody}
                    </div>
                `
            }
        ];

        if (Array.isArray(newsList) && newsList.length > 0) {
            const cardsHtml = newsList.map((n, idx) => {
                const title = n.translatedTitle || n.title;
                const summary = n.summary || n.translatedDescription || n.description || '';
                const src = n.source?.name || '国际媒体';
                const region = n.region || '国际';
                return `
                    <div style="margin-bottom: 18px; padding-bottom: 12px; border-bottom: 1px dashed #cbd5e1;">
                        <h3 style="margin: 0 0 6px 0; color: #0f172a;">${idx + 1}. 【${region}】${title}</h3>
                        <p style="margin: 0 0 6px 0; font-size: 0.9em; color: #475569;"><strong>信源:</strong> ${src}</p>
                        <p style="margin: 0; text-indent: 0;">${summary}</p>
                    </div>
                `;
            }).join('\n');

            chapters.push({
                title: '全球知名信源精选卡片附录',
                data: `<div>${cardsHtml}</div>`
            });
        }

        const epubOptions = {
            title: article.title || `${currentDate} 全球新闻摘要`,
            author: '聚核 (CoreFeed Agent)',
            publisher: '聚核 (CoreFeed)',
            description: `${article.newsCount || 30}条全球权威信源的Agent深度整合简报`,
            lang: 'zh-CN',
            tocTitle: '目录',
            appendChapterTitles: true,
            content: chapters,
            css: `
                body { font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif; line-height: 1.8; color: #1e293b; padding: 16px; }
                h1, h2, h3 { color: #1e40af; margin-top: 1.2em; margin-bottom: 0.6em; }
                p { margin-bottom: 1em; text-align: justify; }
                a { color: #2563eb; text-decoration: none; }
            `
        };

        await new EPub(epubOptions, epubPath).promise;
        const stats = await fsPromises.stat(epubPath);

        return {
            filename,
            path: epubPath,
            size: stats.size,
            sizeFormatted: formatFileSize(stats.size),
            createdAt: referenceTime.toISOString()
        };
    }

    /**
     * 发送 EPUB 附件邮件到 Kindle 或指定邮箱
     */
    async sendEmailWithEpub(recipientEmail, summaryArticle, epubPath) {
        const targetEmail = recipientEmail || config.smtp.defaultRecipient;
        if (!targetEmail) {
            throw new Error('未指定收件人邮箱 (recipientEmail 或 DEFAULT_RECIPIENT_EMAIL)');
        }
        if (!config.smtp.host || !config.smtp.user || !config.smtp.pass) {
            throw new Error('SMTP 邮件服务配置不完整，请检查 SMTP_HOST / SMTP_USER / SMTP_PASS');
        }

        const transporter = this.createMailTransporter();
        const currentDate = new Date().toLocaleDateString('zh-CN', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: 'Asia/Shanghai'
        });

        const regions = Array.isArray(summaryArticle.regions) ? summaryArticle.regions : ['全球'];

        const mailOptions = {
            from: `"${config.smtp.fromName}" <${config.smtp.fromEmail || config.smtp.user}>`,
            to: targetEmail,
            subject: `${currentDate} 全球新闻深度综述 - 聚核 (CoreFeed)`,
            html: `
                <div style="font-family: 'Microsoft YaHei', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; background-color: #f8fafc;">
                    <div style="background: linear-gradient(135deg, #1e3a8a 0%, #3b82f6 100%); padding: 28px; border-radius: 12px; text-align: center; margin-bottom: 24px;">
                        <h1 style="color: white; margin: 0; font-size: 24px;">📰 聚核 CoreFeed · 全球知名信源简报</h1>
                        <p style="color: #dbeafe; margin: 8px 0 0 0; font-size: 15px;">${currentDate}</p>
                    </div>
                    <div style="background: white; padding: 24px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.06);">
                        <h2 style="color: #1e40af; margin-top: 0;">📊 本期情报概览</h2>
                        <p><strong>📈 精选情报数:</strong> ${summaryArticle.newsCount || 30} 条</p>
                        <p><strong>🌍 覆盖地区:</strong> ${regions.join('、')}</p>
                        <p><strong>📎 附件:</strong> 已随信附上自适应排版 EPUB 电子书 (${path.basename(epubPath)})，可直接在 Kindle 或阅读器中打开。</p>
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
        logger.success('EMAIL', `EPUB 简报已成功发送至 ${targetEmail}`, { messageId: info.messageId });

        return {
            success: true,
            messageId: info.messageId,
            recipient: targetEmail,
            filename: path.basename(epubPath)
        };
    }
}

module.exports = EpubEmailService;

