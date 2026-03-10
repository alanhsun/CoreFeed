const ftp = require('basic-ftp');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * FTP服务类 - 处理文件上传到FTP服务器
 */
class FtpService {
    constructor() {
        this.ftpConfig = config.ftp || {};
        this.client = new ftp.Client(30000); // 30秒超时
        this.client.verbose = false;
    }

    /**
     * 上传音频文件到FTP服务器
     * @param {string} localFilePath - 本地音频文件路径
     * @param {string} remoteFileName - 远程文件名（可选，默认使用配置中的文件名）
     * @returns {Promise<Object>} 上传结果
     */
    async uploadAudioFile(localFilePath, remoteFileName = null) {
        try {
            // 检查FTP是否启用
            if (!this.ftpConfig.enabled) {
                logger.taskStep('FTP', 1, 1, 'FTP上传检查', 'warning', {
                    reason: 'FTP上传已禁用',
                    action: '跳过上传'
                });
                return {
                    success: false,
                    skipped: true,
                    reason: 'FTP upload is disabled'
                };
            }

            // 步骤1: 检查文件
            logger.taskStep('FTP', 1, 5, '检查本地音频文件', 'running', {
                filePath: localFilePath
            });

            // 检查本地文件是否存在
            try {
                await fs.access(localFilePath);
            } catch (error) {
                const fileError = new Error(`本地文件不存在: ${localFilePath}`);
                logger.taskStep('FTP', 1, 5, '检查本地音频文件', 'error', {
                    error: error.message
                });
                logger.errorDetailed('FTP', '文件检查失败', fileError, {
                    localFilePath,
                    exists: false
                });
                throw fileError;
            }

            // 获取文件信息
            const stats = await fs.stat(localFilePath);
            const fileSizeInMB = (stats.size / (1024 * 1024)).toFixed(2);

            logger.taskStep('FTP', 1, 5, '检查本地音频文件', 'success', {
                fileSize: `${fileSizeInMB} MB`,
                lastModified: stats.mtime
            });

            // 步骤2: 连接FTP服务器
            logger.taskStep('FTP', 2, 5, '连接FTP服务器', 'running', {
                host: this.ftpConfig.host,
                port: this.ftpConfig.port,
                username: this.ftpConfig.username
            });

            await this.connect();

            logger.taskStep('FTP', 2, 5, '连接FTP服务器', 'success', {
                host: this.ftpConfig.host,
                port: this.ftpConfig.port
            });

            // 步骤3: 上传文件
            const remoteFile = remoteFileName || this.ftpConfig.filename;
            const remotePath = `/${remoteFile}`;

            logger.taskStep('FTP', 3, 5, '上传音频文件', 'running', {
                localFile: localFilePath,
                remotePath: remotePath,
                fileSize: `${fileSizeInMB} MB`
            });

            await this.client.uploadFrom(localFilePath, remotePath);

            logger.taskStep('FTP', 3, 5, '上传音频文件', 'success', {
                remotePath: remotePath,
                fileSize: `${fileSizeInMB} MB`
            });

            // 步骤4: 关闭连接
            logger.taskStep('FTP', 4, 5, '关闭FTP连接', 'running');
            await this.close();
            logger.taskStep('FTP', 4, 5, '关闭FTP连接', 'success');

            // 步骤5: 完成
            logger.taskStep('FTP', 5, 5, 'FTP上传完成', 'success', {
                remotePath: remotePath,
                filename: remoteFile,
                fileSize: stats.size
            });

            logger.success('FTP', `✅ 音频文件上传成功`, {
                remotePath: remotePath,
                fileSize: `${fileSizeInMB} MB`,
                filename: remoteFile,
                uploadTime: new Date().toISOString()
            });

            return {
                success: true,
                remotePath: remotePath,
                filename: remoteFile,
                fileSize: stats.size,
                uploadedAt: new Date().toISOString()
            };

        } catch (error) {
            logger.taskStep('FTP', 5, 5, 'FTP上传失败', 'error', {
                error: error.message
            });

            logger.errorDetailed('FTP', '音频文件上传失败', error, {
                localFilePath,
                remoteFileName: remoteFileName || this.ftpConfig.filename,
                ftpConfig: {
                    host: this.ftpConfig.host,
                    port: this.ftpConfig.port,
                    username: this.ftpConfig.username
                }
            });

            // 确保连接被关闭
            try {
                await this.close();
            } catch (closeError) {
                logger.debug('FTP', '关闭连接时出现警告', closeError.message);
            }

            return {
                success: false,
                error: error.message,
                localFile: localFilePath,
                remoteFile: remoteFileName || this.ftpConfig.filename
            };
        }
    }

    /**
     * 连接FTP服务器
     */
    async connect() {
        try {
            await this.client.access({
                host: this.ftpConfig.host,
                user: this.ftpConfig.username,
                password: this.ftpConfig.password,
                port: this.ftpConfig.port || 21,
                secure: this.ftpConfig.secure || false
            });

            logger.debug('FTP', 'FTP连接成功', {
                host: this.ftpConfig.host,
                port: this.ftpConfig.port,
                secure: this.ftpConfig.secure
            });

        } catch (error) {
            logger.errorDetailed('FTP', 'FTP连接失败', error, {
                host: this.ftpConfig.host,
                port: this.ftpConfig.port || 21,
                secure: this.ftpConfig.secure || false,
                username: this.ftpConfig.username,
                timeout: 30000,
                suggestions: [
                    '检查FTP服务器地址是否正确',
                    '验证用户名和密码',
                    '检查端口21是否被防火墙阻断',
                    '确认FTP服务器是否允许此IP访问'
                ]
            });
            throw error;
        }
    }

    /**
     * 关闭FTP连接
     */
    async close() {
        try {
            await this.client.close();
            logger.debug('FTP', 'FTP连接已关闭');
        } catch (error) {
            logger.warn('FTP', '关闭FTP连接时出现警告', error.message);
        }
    }

    /**
     * 测试FTP连接
     * @returns {Promise<Object>} 测试结果
     */
    async testConnection() {
        logger.taskStep('FTP', 1, 3, '测试FTP连接', 'running', {
            host: this.ftpConfig.host,
            port: this.ftpConfig.port,
            username: this.ftpConfig.username
        });

        try {
            await this.connect();

            logger.taskStep('FTP', 2, 3, '验证连接', 'success');

            await this.close();

            logger.taskStep('FTP', 3, 3, 'FTP连接测试完成', 'success');

            logger.success('FTP', '✅ FTP连接测试成功', {
                host: this.ftpConfig.host,
                username: this.ftpConfig.username
            });

            return {
                success: true,
                message: 'FTP连接测试成功',
                host: this.ftpConfig.host,
                username: this.ftpConfig.username
            };
        } catch (error) {
            logger.taskStep('FTP', 3, 3, 'FTP连接测试失败', 'error', {
                error: error.message
            });

            logger.errorDetailed('FTP', 'FTP连接测试失败', error, {
                host: this.ftpConfig.host,
                port: this.ftpConfig.port,
                username: this.ftpConfig.username,
                timeout: 30000
            });

            return {
                success: false,
                message: 'FTP连接测试失败',
                error: error.message,
                host: this.ftpConfig.host,
                username: this.ftpConfig.username
            };
        }
    }

    /**
     * 获取FTP配置信息（隐藏密码）
     * @returns {Object}  FTP配置信息
     */
    getConfig() {
        return {
            host: this.ftpConfig.host,
            username: this.ftpConfig.username,
            password: this.ftpConfig.password ? '***' + this.ftpConfig.password.slice(-2) : '',
            filename: this.ftpConfig.filename,
            port: this.ftpConfig.port,
            secure: this.ftpConfig.secure,
            enabled: this.ftpConfig.enabled
        };
    }
}

module.exports = FtpService;
