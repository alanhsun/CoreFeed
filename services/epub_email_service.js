const path = require('path');
const fsPromises = require('fs').promises;
const nodemailer = require('nodemailer');
const EPub = require('epub-gen');
const config = require('../config');
const { formatFileSize } = require('../utils/helpers');
const logger = require('../utils/logger');

/**
 * EPUB 电子书生成与 Kindle 邮件推送服务 (Kami 紙感排版规范)
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

        const kamiFontStack = `"TsangerJinKai02", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", "STSong", Georgia, serif`;

        // 附加精选情报卡片章节（如果有 newsList）
        const chapters = [
            {
                title: '本期情报概览',
                data: `
                    <div style="font-family: ${kamiFontStack}; line-height: 1.58; color: #141413;">
                        <h2 style="color: #141413; font-weight: 500; border-bottom: 1px solid #e8e6dc; padding-bottom: 10px;">聚核 CoreFeed · 全球知名信源情报简报</h2>
                        <div style="background: #faf9f5; padding: 18px 20px; border-radius: 6px; margin: 16px 0;">
                            <p style="margin: 6px 0;"><strong style="color: #1B365D; font-weight: 500;">精选情报数：</strong> ${article.newsCount || newsList.length || 30} 条</p>
                            <p style="margin: 6px 0;"><strong style="color: #1B365D; font-weight: 500;">覆盖地区：</strong> ${regions.join('、')}</p>
                            <p style="margin: 6px 0;"><strong style="color: #1B365D; font-weight: 500;">生成时间：</strong> ${new Date(article.generatedAt || Date.now()).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</p>
                            <p style="margin: 6px 0;"><strong style="color: #1B365D; font-weight: 500;">综述字数：</strong> ${article.wordCount || (article.content || '').length} 字</p>
                        </div>
                    </div>
                `
            },
            {
                title: article.title || `${currentDate} 全球要闻深度综述`,
                data: `
                    <div style="font-family: ${kamiFontStack}; line-height: 1.58; color: #141413;">
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
                    <div style="margin-bottom: 18px; padding-bottom: 14px; border-bottom: 1px solid #e5e3d8;">
                        <h3 style="margin: 0 0 6px 0; font-weight: 500; color: #141413;">${idx + 1}. 【${region}】${title}</h3>
                        <p style="margin: 0 0 6px 0; font-size: 0.9em; color: #1B365D;">信源：${src}</p>
                        <p style="margin: 0; color: #3d3d3a; text-indent: 0;">${summary}</p>
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
            publisher: '聚核 (CoreFeed · Kami Edition)',
            description: `${article.newsCount || 30}条全球权威信源的Agent深度整合简报`,
            lang: 'zh-CN',
            tocTitle: '目录',
            appendChapterTitles: true,
            content: chapters,
            css: `
                body { font-family: ${kamiFontStack}; background: #f5f4ed; line-height: 1.58; color: #141413; padding: 16px; }
                h1, h2, h3 { font-weight: 500; color: #141413; margin-top: 1.4em; margin-bottom: 0.5em; }
                p { margin-bottom: 1em; color: #3d3d3a; text-align: left; }
                a { color: #1B365D; text-decoration: none; }
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
     * 发送 EPUB 附件邮件到 Kindle 或指定邮箱 (Kami Parchment 样式)
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
        const kamiFontStack = `"TsangerJinKai02", "Source Han Serif SC", "Noto Serif CJK SC", "Songti SC", Georgia, serif`;

        const mailOptions = {
            from: `"${config.smtp.fromName}" <${config.smtp.fromEmail || config.smtp.user}>`,
            to: targetEmail,
            subject: `${currentDate} 全球新闻深度综述 - 聚核 (CoreFeed)`,
            html: `
                <div style="font-family: ${kamiFontStack}; max-width: 640px; margin: 0 auto; padding: 36px 28px; background-color: #f5f4ed; color: #141413;">
                    <div style="padding-bottom: 20px; border-bottom: 1px solid #e8e6dc; margin-bottom: 24px;">
                        <div style="display: inline-block; background: #E4ECF5; color: #1B365D; font-size: 12px; font-weight: 500; padding: 2px 8px; border-radius: 3px; margin-bottom: 10px;">紙 · KAMI EDITION</div>
                        <h1 style="color: #141413; font-weight: 500; margin: 0; font-size: 26px;">聚核 · CoreFeed 全球知名信源简报</h1>
                        <p style="color: #6b6a64; margin: 8px 0 0 0; font-size: 14px;">${currentDate}</p>
                    </div>
                    <div style="background: #faf9f5; padding: 24px; border-radius: 6px;">
                        <h2 style="color: #141413; font-weight: 500; font-size: 18px; margin-top: 0;">本期情报概览</h2>
                        <p style="color: #3d3d3a; margin: 8px 0;"><strong style="color: #1B365D; font-weight: 500;">精选情报数：</strong> ${summaryArticle.newsCount || 30} 条</p>
                        <p style="color: #3d3d3a; margin: 8px 0;"><strong style="color: #1B365D; font-weight: 500;">覆盖地区：</strong> ${regions.join('、')}</p>
                        <p style="color: #3d3d3a; margin: 8px 0;"><strong style="color: #1B365D; font-weight: 500;">随信附件：</strong> 已附上 Kami 纸感排版 EPUB 电子书 (${path.basename(epubPath)})，可直接在 Kindle 或阅读器中打开。</p>
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
