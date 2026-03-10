const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const config = require('../config');
const { retryAsync, delay, ensureDirectoryExists } = require('../utils/helpers');
const logger = require('../utils/logger');
const FtpService = require('./ftp_service');

const execAsync = util.promisify(exec);

/**
 * 音频服务类 - 处理语音合成和音频处理
 */
class AudioService {
    constructor(io = null, stateManager = null) {
        this.io = io;
        this.stateManager = stateManager;
        this.ttsEndpoint = (config.tts && config.tts.baseUrl) ? config.tts.baseUrl : 'http://10.10.10.80:5050/v1/audio/speech';
        this.ttsModel = (config.tts && config.tts.model) ? config.tts.model : 'tts-1';
        this.ttsFormat = (config.tts && config.tts.format) ? config.tts.format : 'mp3';
        this.ttsApiKey = (config.tts && config.tts.apiKey) ? config.tts.apiKey : null;
        this.ttsReady = false; // 初始化为false，等待验证
        this.ftpService = new FtpService(); // 初始化FTP服务
        // 注意：initializeTTSClient现在是异步的，需要在外部调用
    }

    /**
     * 初始化TTS客户端并验证服务可用性
     */
    async initializeTTSClient() {
        try {
            // 测试TTS服务是否可用
            const testPayload = {
                model: this.ttsModel || 'tts-1',
                voice: config.tts?.hostVoice || 'zh-CN-XiaoxiaoNeural',
                input: '测试音频合成服务',
                response_format: this.ttsFormat || 'mp3'
            };

            const headers = {};
            if (this.ttsApiKey) {
                headers['Authorization'] = `Bearer ${this.ttsApiKey}`;
            }

            // 发送测试请求验证服务可用性
            await axios.post(this.ttsEndpoint, testPayload, { 
                responseType: 'arraybuffer', 
                timeout: 10000, 
                headers 
            });

            this.ttsReady = true;
            logger.success('AUDIO', `TTS服务验证成功: ${this.ttsEndpoint}`);
        } catch (error) {
            logger.error('AUDIO', 'TTS服务初始化失败', {
                endpoint: this.ttsEndpoint,
                error: error.message,
                code: error.code
            });
            this.ttsReady = false;
            throw new Error(`TTS服务不可用: ${error.message}`);
        }
    }

    /**
     * 初始化TTS服务（initializeTTSClient的别名）
     */
    async initializeTTS() {
        return this.initializeTTSClient();
    }

    /**
     * 设置Socket.IO实例
     * @param {Object} io - Socket.IO实例
     */
    setSocketIO(io) {
        this.io = io;
    }

    /**
     * 设置状态管理器
     * @param {Object} stateManager - 状态管理器实例
     */
    setStateManager(stateManager) {
        this.stateManager = stateManager;
    }

    /**
     * 测试FTP连接
     * @returns {Promise<Object>} 测试结果
     */
    async testFtpConnection() {
        return await this.ftpService.testConnection();
    }

    /**
     * 获取FTP配置信息
     * @returns {Object} FTP配置信息
     */
    getFtpConfig() {
        return this.ftpService.getConfig();
    }

    /**
     * 发送播客进度更新
     * @param {Object} progressData - 进度数据
     */
    emitPodcastProgress(progressData) {
        if (this.io) {
            this.io.emit('podcast-progress', progressData);
        }
    }

    /**
     * 合成单个音频片段
     * @param {string} text - 要合成的文本
     * @param {Object} voiceConfig - 语音配置
     * @param {string} outputPath - 输出文件路径
     * @returns {Promise<string>} 音频文件路径
     */
    async synthesizeSpeech(text, voiceConfig, outputPath) {
        if (!this.ttsReady) {
            throw new Error('TTS服务未就绪');
        }

        if (!text || text.trim() === '') {
            throw new Error('文本内容为空');
        }

        try {
            const payload = {
                model: this.ttsModel || 'tts-1',
                voice: voiceConfig.name || (config.tts?.hostVoice || 'zh-CN-XiaoxiaoNeural'),
                input: text.trim(),
                response_format: this.ttsFormat || 'mp3'
            };

            const headers = {};
            if (this.ttsApiKey) {
                headers['Authorization'] = `Bearer ${this.ttsApiKey}`;
            }

            const response = await retryAsync(
                () => axios.post(this.ttsEndpoint, payload, { responseType: 'arraybuffer', timeout: 60000, headers }),
                3,
                1000,
                'TTS'
            );

            const audioBuffer = response?.data;
            if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error('TTS服务返回空音频');
            }

            // 确保输出目录存在
            await ensureDirectoryExists(path.dirname(outputPath));

            // 保存音频文件
            await fs.writeFile(outputPath, audioBuffer);

            logger.debug('AUDIO', `音频片段生成成功: ${path.basename(outputPath)}`);
            return outputPath;

        } catch (error) {
            logger.error('AUDIO', `音频合成失败`, `${text.substring(0, 50)}...`);
            throw error;
        }
    }

    /**
     * 解析播客脚本（鲁棒解析）
     * - 支持 [A]/[B]、[张明]/[李华]、A: / B:、【A】/【B】、主持人A: / 主持人B: 等格式
     * - 若无说话人标记，则继承上一位说话人
     * - 忽略分隔线、空行
     */
    parseScript(script) {
        if (!script || typeof script !== 'string') return [];
        // 统一标点
        const normalized = script
            .replace(/【/g, '[')
            .replace(/】/g, ']')
            .replace(/：/g, ':');

        const lines = normalized.split('\n').map(l => l.trim()).filter(Boolean);
        const segments = [];
        let currentSpeaker = null; // { speaker, isHost }

        const tryExtract = (line) => {
            // 匹配多种说话人标记
            const patterns = [
                { re: /^\[A\]\s*(.*)$/i, speaker: '播音员A', isHost: true },
                { re: /^\[B\]\s*(.*)$/i, speaker: '播音员B', isHost: false },
                { re: /^\[张明\]\s*(.*)$/i, speaker: '张明', isHost: true },
                { re: /^\[李华\]\s*(.*)$/i, speaker: '李华', isHost: false },
                { re: /^A:\s*(.*)$/i, speaker: '播音员A', isHost: true },
                { re: /^B:\s*(.*)$/i, speaker: '播音员B', isHost: false },
                { re: /^主持人A:\s*(.*)$/i, speaker: '播音员A', isHost: true },
                { re: /^主持人B:\s*(.*)$/i, speaker: '播音员B', isHost: false }
            ];
            for (const p of patterns) {
                const m = line.match(p.re);
                if (m) {
                    return { text: (m[1] || '').trim(), speaker: p.speaker, isHost: p.isHost };
                }
            }
            return null;
        };

        for (const line of lines) {
            // 忽略分隔线
            if (/^[-=~]{3,}$/.test(line)) continue;

            const extracted = tryExtract(line);
            if (extracted) {
                currentSpeaker = { speaker: extracted.speaker, isHost: extracted.isHost };
                if (extracted.text) {
                    segments.push({ speaker: extracted.speaker, isHost: extracted.isHost, text: extracted.text });
                }
            } else {
                // 无标记，继承上一位说话人，如果没有则暂存为A/B交替
                if (currentSpeaker) {
                    segments.push({ speaker: currentSpeaker.speaker, isHost: currentSpeaker.isHost, text: line });
                } else {
                    // 初始未指定说话人时按句子拆分并交替分配
                    const sentences = line.split(/[\u3002\uff01\uff1f!?]+/).map(s => s.trim()).filter(Boolean);
                    sentences.forEach((s, idx) => {
                        const isHost = (segments.length + idx) % 2 === 0;
                        segments.push({ speaker: isHost ? '播音员A' : '播音员B', isHost, text: s });
                    });
                }
            }
        }

        return segments;
    }

    /**
     * 获取语音配置
     * @param {boolean} isHost - 是否为主持人
     * @returns {Object} 语音配置
     */
    getVoiceConfig(isHost) {
        return {
            // OpenAI-Edge-TTS 使用 Azure 风格的音色名称
            name: isHost ? (config.tts?.hostVoice || 'zh-CN-XiaoxiaoNeural') : (config.tts?.guestVoice || 'zh-CN-YunyangNeural'),
            audioEncoding: 'MP3',
            speakingRate: config.audio.speakingRate || 1.0,
            pitch: config.audio.pitch || 0.0,
            volumeGainDb: config.audio.volumeGainDb || 0.0
        };
    }

    /**
     * 生成播客音频片段
     * @param {Array} segments - 脚本段落数组
     * @param {string} audioDir - 音频输出目录
     * @returns {Promise<Array>} 音频片段信息数组
     */
    async generateAudioSegments(segments, audioDir) {
        const audioSegments = [];
        
        // 确保音频目录存在
        await ensureDirectoryExists(audioDir);
        
        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            
            try {
                logger.progress('AUDIO', i + 1, segments.length, `生成音频片段`);
                
                // 发送进度更新
                this.emitPodcastProgress({
                    stage: 'audio',
                    message: `正在生成音频片段 ${i + 1}/${segments.length}`,
                    progress: 30 + Math.floor((i / segments.length) * 60),
                    current: i + 1,
                    total: segments.length,
                    detail: `音频片段: ${segment.text.substring(0, 30)}${segment.text.length > 30 ? '...' : ''}`
                });
                
                // 获取语音配置
                const voiceConfig = this.getVoiceConfig(segment.isHost);
                
                // 生成音频文件路径
                const segmentPath = path.join(audioDir, `segment_${i.toString().padStart(3, '0')}.mp3`);
                
                // 合成音频
                await this.synthesizeSpeech(segment.text, voiceConfig, segmentPath);
                
                audioSegments.push({
                    index: i,
                    speaker: segment.speaker,
                    text: segment.text,
                    audioPath: segmentPath,
                    duration: this.estimateAudioDuration(segment.text) // 估算时长
                });
                
                logger.debug('AUDIO', `音频片段${i + 1}生成成功`);
                
                // 添加短暂延迟避免API限制
                if (i < segments.length - 1) {
                    await delay(config.audio.synthesisDelay || 200);
                }
                
            } catch (error) {
                logger.error('AUDIO', `生成音频片段${i + 1}失败`, error.message);
                
                // 如果是API认证错误，直接抛出
                if (error.message.includes('API key') || 
                    error.message.includes('authentication') || 
                    error.message.includes('permission')) {
                    throw new Error(`TTS服务认证失败: ${error.message}`);
                }
                
                // 其他错误继续处理下一个片段，但记录警告
                logger.warn('AUDIO', '跳过该音频片段，继续处理下一个');
            }
        }
        
        logger.success('AUDIO', `音频生成完成，共 ${audioSegments.length} 个片段`);
        return audioSegments;
    }

    /**
     * 估算音频时长（秒）
     * @param {string} text - 文本内容
     * @returns {number} 估算时长
     */
    estimateAudioDuration(text) {
        // 中文大约每分钟200-250字，这里按每秒4字计算
        const charsPerSecond = 4;
        return Math.ceil(text.length / charsPerSecond);
    }

    /**
     * 检查ffmpeg是否可用
     * @returns {Promise<boolean>} ffmpeg是否可用
     */
    async checkFFmpegAvailability() {
        try {
            const ffmpegPath = config.audio.ffmpegPath || 'ffmpeg';
            await execAsync(`${ffmpegPath} -version`, { timeout: 5000 });
            return true;
        } catch (error) {
            logger.warn('AUDIO', 'ffmpeg不可用', error.message);
            return false;
        }
    }

    /**
     * 使用ffmpeg合并音频文件
     * @param {Array} audioSegments - 音频片段数组
     * @param {string} audioDir - 音频目录
     * @returns {Promise<string|null>} 合并后的音频文件路径
     */
    async mergeAudioWithFFmpeg(audioSegments, audioDir) {
        try {
            // 创建临时文件列表
            const fileListPath = path.join(audioDir, 'filelist.txt');
            const fileListContent = audioSegments
                .sort((a, b) => a.index - b.index)
                .map(segment => `file '${path.basename(segment.audioPath)}'`)
                .join('\n');
            
            await fs.writeFile(fileListPath, fileListContent, 'utf8');
            
            // 合并后的文件路径
            const mergedPath = path.join(audioDir, 'podcast_complete.mp3');
            
            // 使用ffmpeg合并音频
            const ffmpegPath = config.audio.ffmpegPath || 'ffmpeg';
            const ffmpegCommand = `"${ffmpegPath}" -f concat -safe 0 -i "${fileListPath}" -c copy "${mergedPath}" -y`;
            await execAsync(ffmpegCommand, { cwd: audioDir, timeout: 60000 });
            
            logger.success('AUDIO', '使用ffmpeg成功合并音频');
            
            // 清理临时文件
            try {
                await fs.unlink(fileListPath);
            } catch (error) {
                // 忽略清理错误
            }
            
            return mergedPath;
            
        } catch (error) {
            logger.error('AUDIO', 'ffmpeg合并失败', {
                error: error.message,
                command: error.cmd || 'ffmpeg命令',
                code: error.code || 'unknown'
            });
            throw error;
        }
    }

    /**
     * 简单合并音频文件（当ffmpeg不可用时）
     * @param {Array} audioSegments - 音频片段数组
     * @param {string} audioDir - 音频目录
     * @returns {Promise<string>} 合并后的音频文件路径
     */
    async mergeAudioSimple(audioSegments, audioDir) {
        try {
            logger.info('AUDIO', '使用简单方式合并音频文件');
            
            const mergedPath = path.join(audioDir, 'podcast_complete.mp3');
            const mergedBuffer = [];
            
            for (const segment of audioSegments.sort((a, b) => a.index - b.index)) {
                const audioData = await fs.readFile(segment.audioPath);
                mergedBuffer.push(audioData);
            }
            
            await fs.writeFile(mergedPath, Buffer.concat(mergedBuffer));
            logger.success('AUDIO', '使用简单方式成功合并音频');
            
            return mergedPath;
            
        } catch (error) {
            logger.error('AUDIO', '简单合并失败', error.message);
            throw error;
        }
    }

    /**
     * 合并音频片段
     * @param {Array} audioSegments - 音频片段数组
     * @param {string} audioDir - 音频目录
     * @returns {Promise<string|null>} 合并后的音频文件路径
     */
    async mergeAudioSegments(audioSegments, audioDir) {
        if (!audioSegments || audioSegments.length === 0) {
            return null;
        }

        try {
            // 首先检查是否启用ffmpeg并且ffmpeg可用
            if (config.audio.useFFmpeg !== false) {
                const ffmpegAvailable = await this.checkFFmpegAvailability();
                if (ffmpegAvailable) {
                    try {
                        return await this.mergeAudioWithFFmpeg(audioSegments, audioDir);
                    } catch (ffmpegError) {
                        logger.warn('AUDIO', 'ffmpeg合并失败，尝试简单合并方式', ffmpegError.message);
                    }
                } else {
                    logger.info('AUDIO', 'ffmpeg不可用，使用简单合并方式');
                }
            } else {
                logger.info('AUDIO', 'ffmpeg已禁用，使用简单合并方式');
            }
            
            // 如果ffmpeg不可用或失败，使用简单合并
            return await this.mergeAudioSimple(audioSegments, audioDir);
            
        } catch (error) {
            logger.error('AUDIO', '合并音频失败', error.message);
            return null;
        }
    }

    /**
     * 生成播客音频
     * @param {string} script - 播客脚本
     * @returns {Promise<Object>} 播客信息对象
     */
    async generatePodcastAudio(script) {
        try {
            if (!this.ttsReady) {
                logger.warn('AUDIO', 'TTS服务未就绪，尝试重新初始化');
                await this.initializeTTS();
                if (!this.ttsReady) {
                    throw new Error('TTS服务初始化失败，无法生成播客音频');
                }
            }

            logger.info('AUDIO', '正在生成音频...');
            
            // 发送开始进度
            this.emitPodcastProgress({
                stage: 'starting',
                message: '开始音频生成流程...',
                progress: 5
            });
            
            // 解析对话脚本
            let segments = this.parseScript(script);
            const initialSegmentCount = segments ? segments.length : 0;
            
            // 回退策略：当脚本没有[A]/[B]/[张明]/[李华]标记时，自动按句子切分并交替分配A/B角色
            if (!segments || segments.length === 0) {
                logger.info('AUDIO', '未检测到说话人标记，启用回退分段策略（自动切句并交替分配声线）');
                const sentences = (script || '')
                    .split(/[\u3002\uff01\uff1f!?\r\n]+/)
                    .map(s => s.replace(/[\r\n]+/g, ' ').trim())
                    .filter(s => s.length > 0);
                
                segments = sentences.map((s, idx) => ({
                    speaker: idx % 2 === 0 ? '播音员A' : '播音员B',
                    text: s,
                    isHost: idx % 2 === 0
                }));
            }

            // 鲁棒性增强：若只有开头/结尾两段或段落过少，则基于编号/句子再次切分
            if (segments.length <= 3) {
                logger.info('AUDIO', '检测到段落过少，尝试基于编号/句子进行二次切分');
                const lines = (script || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
                // 优先匹配形如“1. ……”/“1、……”/“1) ……”的编号条目
                let numberedItems = lines
                    .map(l => {
                        const m = l.match(/^(\d+)[\.|、|\)]\s*(.+)$/);
                        return m ? m[2].trim() : null;
                    })
                    .filter(Boolean);
                if (numberedItems.length < 4) {
                    // 退化为按句子切分，并过滤明显的开场/结尾句
                    numberedItems = (script || '')
                        .split(/[\u3002\uff01\uff1f!?]+/)
                        .map(s => s.trim())
                        .filter(s => s.length >= 8 && !/以上就是今天的.*(播报|新闻)/.test(s) && !/今天是/.test(s));
                }
                if (numberedItems.length >= 4) {
                    segments = numberedItems.map((s, idx) => ({
                        speaker: idx % 2 === 0 ? '播音员A' : '播音员B',
                        text: s,
                        isHost: idx % 2 === 0
                    }));
                }
            }
            
            if (segments.length === 0) {
                throw new Error('脚本解析失败，没有找到有效的对话段落');
            }
            
            // 确保音频目录存在
            const audioDir = config.storage.podcastDir;
            await ensureDirectoryExists(audioDir);
            
            // 清理旧的音频文件，避免目录臃肿
            logger.info('AUDIO', '清理旧音频文件...');
            await this.cleanupOldAudioFiles();
            
            // 发送清理完成进度
            this.emitPodcastProgress({
                stage: 'cleanup',
                message: '旧文件清理完成，开始生成新音频...',
                progress: 10
            });
            
            // 生成音频片段
            const audioSegments = await this.generateAudioSegments(segments, audioDir);

            // 诊断日志：若生成的段落数量极少，输出脚本片段用于排查
            if (audioSegments.length <= 3) {
                logger.warn('AUDIO', '生成的音频片段数量过少，疑似脚本未正确分段', {
                    initialSegmentCount,
                    finalSegmentCount: audioSegments.length,
                    scriptPreview: (script || '').substring(0, 200)
                });
            }
            
            if (audioSegments.length === 0) {
                throw new Error('没有成功生成任何音频片段');
            }
            
            // 发送合并进度
            this.emitPodcastProgress({
                stage: 'merging',
                message: '正在合并音频片段...',
                progress: 90
            });
            
            // 合并所有音频片段
            const mergedAudioPath = await this.mergeAudioSegments(audioSegments, audioDir);
            
            // 计算总时长
            const totalDuration = audioSegments.reduce((sum, segment) => sum + segment.duration, 0);
            
            // 生成播客信息（使用北京时间）
            const now = new Date();
            const podcastInfo = {
                title: `AI新闻播客 - ${now.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
                description: '由AI生成的新闻播客，包含当日重要新闻的分条播报',
                duration: totalDuration,
                segments: audioSegments,
                script: script,
                mergedAudioPath: mergedAudioPath,
                audioDir: audioDir,
                createdAt: now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T') + '.000Z',
                stats: {
                    totalSegments: audioSegments.length,
                    totalDuration: totalDuration,
                    speakers: [...new Set(audioSegments.map(s => s.speaker))]
                }
            };
            
            // 保存播客信息
            const podcastInfoPath = path.join(audioDir, 'podcast_info.json');
            await fs.writeFile(podcastInfoPath, JSON.stringify(podcastInfo, null, 2), 'utf8');
            
            // 发送完成进度
            this.emitPodcastProgress({
                stage: 'completed',
                message: '音频生成完成',
                progress: 100
            });

            // 上传到FTP服务器
            logger.info('AUDIO', '开始上传到FTP服务器...');
            this.emitPodcastProgress({
                stage: 'uploading',
                message: '正在上传到FTP服务器...',
                progress: 95
            });

            let ftpResult = null;
            try {
                ftpResult = await this.ftpService.uploadAudioFile(mergedAudioPath);

                if (ftpResult.success) {
                    logger.success('AUDIO', 'FTP上传成功', {
                        remotePath: ftpResult.remotePath,
                        filename: ftpResult.filename,
                        fileSize: ftpResult.fileSize
                    });

                    // 将FTP信息添加到podcastInfo中
                    podcastInfo.ftp = {
                        uploaded: true,
                        remotePath: ftpResult.remotePath,
                        filename: ftpResult.filename,
                        uploadedAt: ftpResult.uploadedAt,
                        fileSize: ftpResult.fileSize
                    };

                    this.emitPodcastProgress({
                        stage: 'uploaded',
                        message: 'FTP上传完成',
                        progress: 100
                    });
                } else if (!ftpResult.skipped) {
                    logger.warn('AUDIO', 'FTP上传失败，但音频生成已完成', {
                        error: ftpResult.error
                    });

                    podcastInfo.ftp = {
                        uploaded: false,
                        error: ftpResult.error
                    };
                }
            } catch (ftpError) {
                logger.error('AUDIO', 'FTP上传过程出错', ftpError.message);
                podcastInfo.ftp = {
                    uploaded: false,
                    error: ftpError.message
                };
            }

            logger.success('AUDIO', '音频生成流程完成');
            return podcastInfo;
            
        } catch (error) {
            logger.error('AUDIO', '生成音频失败', error.message);
            
            // 发送错误进度
            this.emitPodcastProgress({
                stage: 'error',
                message: `音频生成失败: ${error.message}`,
                progress: 0,
                error: error.message
            });
            
            throw error;
        }
    }

    /**
     * 获取音频信息
     * @returns {Promise<Object|null>} 音频信息
     */
    async getPodcastInfo() {
        try {
            const podcastInfoPath = path.join(config.storage.podcastDir, 'podcast_info.json');
            const data = await fs.readFile(podcastInfoPath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }

    /**
     * 检查音频文件是否存在
     * @param {string} filePath - 文件路径
     * @returns {Promise<boolean>} 文件是否存在
     */
    async checkAudioFileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch (error) {
            return false;
        }
    }

    /**
     * 获取音频文件信息
     * @param {string} filePath - 文件路径
     * @returns {Promise<Object|null>} 文件信息
     */
    async getAudioFileInfo(filePath) {
        try {
            const stats = await fs.stat(filePath);
            return {
                size: stats.size,
                created: stats.birthtime,
                modified: stats.mtime,
                exists: true
            };
        } catch (error) {
            return null;
        }
    }

    /**
     * 清理旧的音频文件
     * @param {number} maxAge - 最大保留时间（毫秒）
     * @returns {Promise<number>} 清理的文件数量
     */
    async cleanupOldAudioFiles(maxAge = 7 * 24 * 60 * 60 * 1000) { // 默认7天
        try {
            const audioDir = config.storage.podcastDir;
            const files = await fs.readdir(audioDir);
            let cleanedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(audioDir, file);
                
                // 清理所有音频片段文件（segment_xxx.mp3）和临时文件
                if (file.match(/^segment_\d{3}\.mp3$/) || 
                    file === 'filelist.txt' || 
                    file === 'podcast_complete.mp3') {
                    try {
                        await fs.unlink(filePath);
                        cleanedCount++;
                        logger.debug('AUDIO', `清理音频文件: ${file}`);
                    } catch (unlinkError) {
                        // 忽略删除失败的文件（可能正在使用中）
                        logger.debug('AUDIO', `无法删除文件: ${file}`);
                    }
                } else {
                    // 对于其他文件，按时间清理
                    try {
                        const stats = await fs.stat(filePath);
                        const now = Date.now();
                        
                        if (now - stats.mtime.getTime() > maxAge) {
                            await fs.unlink(filePath);
                            cleanedCount++;
                            logger.debug('AUDIO', `清理过期文件: ${file}`);
                        }
                    } catch (statError) {
                        // 忽略无法访问的文件
                    }
                }
            }
            
            if (cleanedCount > 0) {
                logger.info('AUDIO', `清理完成，共清理 ${cleanedCount} 个文件`);
            }
            return cleanedCount;
            
        } catch (error) {
            logger.error('AUDIO', '清理音频文件失败', error.message);
            return 0;
        }
    }



    /**
     * 获取音频目录统计信息
     * @returns {Promise<Object>} 统计信息
     */
    async getAudioDirectoryStats() {
        try {
            const audioDir = config.storage.podcastDir;
            const files = await fs.readdir(audioDir);
            
            let totalSize = 0;
            let audioFiles = 0;
            let otherFiles = 0;
            
            for (const file of files) {
                const filePath = path.join(audioDir, file);
                const stats = await fs.stat(filePath);
                
                totalSize += stats.size;
                
                if (file.endsWith('.mp3') || file.endsWith('.wav')) {
                    audioFiles++;
                } else {
                    otherFiles++;
                }
            }
            
            return {
                totalFiles: files.length,
                audioFiles,
                otherFiles,
                totalSize,
                totalSizeMB: Math.round(totalSize / 1024 / 1024 * 100) / 100
            };
            
        } catch (error) {
            logger.error('AUDIO', '获取音频目录统计失败', error.message);
            return {
                totalFiles: 0,
                audioFiles: 0,
                otherFiles: 0,
                totalSize: 0,
                totalSizeMB: 0
            };
        }
    }
}

module.exports = AudioService;