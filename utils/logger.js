const chalk = require('chalk');

/**
 * 统一日志管理器 V2
 * 实现了标准化的日志格式和接口
 */
class Logger {
    constructor() {
        this.logLevel = process.env.LOG_LEVEL || 'info';
        this.logLevels = {
            error: 0,
            warn: 1,
            success: 2,
            info: 3,
            debug: 4
        };
    }

    /**
     * 检查日志级别是否应该输出
     * @param {string} level - 要检查的日志级别
     * @returns {boolean} 是否应该输出
     */
    shouldLog(level) {
        return this.logLevels[level] <= this.logLevels[this.logLevel];
    }

    /**
     * 格式化控制台日志消息
     * 格式: [模块] [级别] 操作描述 - { 详情 }
     * @param {string} level - 日志级别 (info, warn, error, etc.)
     * @param {string} module - 服务模块 (e.g., 'AI', 'NEWS', 'SERVER')
     * @param {string} action - 操作描述 (e.g., 'Initializing service', 'Request failed')
     * @param {Object|string|null} details - 附加的结构化数据或信息
     * @returns {string} 格式化后的日志字符串
     */
    formatMessage(level, module, action, details = null) {
        const levelColors = {
            error: chalk.red.bold,
            warn: chalk.yellow.bold,
            info: chalk.cyan.bold,
            success: chalk.green.bold,
            debug: chalk.gray.bold
        };

        const moduleColor = chalk.magenta.bold;
        const actionColor = chalk.white;
        const detailsColor = chalk.gray;

        const levelStr = `[${level.toUpperCase()}]`.padEnd(9, ' ');
        const moduleStr = `[${module.toUpperCase()}]`.padEnd(12, ' ');
        const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });

        let message = `${chalk.gray(`[${timestamp}] `)}${moduleColor(moduleStr)}${levelColors[level](levelStr)}${actionColor(action)}`;

        if (details) {
            let detailsStr;
            if (typeof details === 'object') {
                // 对Error对象特殊处理
                if (details instanceof Error) {
                    detailsStr = details.message;
                } else {
                    detailsStr = JSON.stringify(details);
                }
            } else {
                detailsStr = details;
            }
            message += ` - ${detailsColor(detailsStr)}`;
        }

        return message;
    }

    /**
     * 通用日志方法
     * @param {string} level - 日志级别
     * @param {string} module - 服务模块
     * @param {string} action - 操作描述
     * @param {Object|string|null} details - 附加信息
     */
    log(level, module, action, details = null) {
        if (!this.shouldLog(level)) return;

        const message = this.formatMessage(level, module, action, details);

        switch (level) {
            case 'error':
                console.error(message);
                break;
            case 'warn':
                console.warn(message);
                break;
            default:
                console.log(message);
        }
    }

    /**
     * 增强的错误日志 - 提供详细的错误分析
     * @param {string} module - 服务模块
     * @param {string} action - 操作描述
     * @param {Error|string|Object} error - 错误对象或错误信息
     * @param {Object} context - 额外的上下文信息（如请求参数、状态等）
     */
    errorDetailed(module, action, error, context = {}) {
        const errorTypes = {
            'NETWORK': '🌐 网络错误',
            'API': '🔌 API错误',
            'TIMEOUT': '⏱️ 超时错误',
            'AUTH': '🔐 认证错误',
            'VALIDATION': '✅ 验证错误',
            'SYSTEM': '⚙️ 系统错误',
            'UNKNOWN': '❓ 未知错误'
        };

        let errorType = 'UNKNOWN';
        let errorMessage = '';
        let stackTrace = '';

        if (error instanceof Error) {
            errorMessage = error.message;
            stackTrace = error.stack;

            // 根据错误消息识别错误类型
            if (errorMessage.includes('timeout') || errorMessage.includes('TIMEOUT')) {
                errorType = 'TIMEOUT';
            } else if (errorMessage.includes('401') || errorMessage.includes('403') || errorMessage.includes('Unauthorized')) {
                errorType = 'AUTH';
            } else if (errorMessage.includes('fetch') || errorMessage.includes('network') || errorMessage.includes('ECONNREFUSED')) {
                errorType = 'NETWORK';
            } else if (errorMessage.includes('API') || errorMessage.includes('rate limit')) {
                errorType = 'API';
            }
        } else if (typeof error === 'string') {
            errorMessage = error;
        } else if (error && error.message) {
            errorMessage = error.message;
        }

        console.error(`\n${chalk.red.bold('═'.repeat(80))}`);
        console.error(`${chalk.red.bold('  [错误详情] ')} ${chalk.white.bold(action)}`);
        console.error(chalk.red.bold('─'.repeat(80)));
        console.error(`${chalk.yellow('📍 模块:     ')} ${chalk.cyan.bold(module)}`);
        console.error(`${chalk.yellow('🔴 错误类型: ')} ${errorTypes[errorType]} (${errorType})`);
        console.error(`${chalk.yellow('📝 错误信息: ')} ${chalk.white(errorMessage)}`);

        if (context && Object.keys(context).length > 0) {
            console.error(chalk.yellow('\n📋 上下文信息:'));
            console.error(chalk.gray(JSON.stringify(context, null, 2)));
        }

        if (stackTrace) {
            console.error(chalk.yellow('\n📜 堆栈跟踪:'));
            console.error(chalk.gray(stackTrace));
        }

        // 提供解决方案建议
        console.error(chalk.yellow('\n💡 建议解决方案:'));
        const solutions = this.getSolutions(errorType, errorMessage);
        solutions.forEach((solution, idx) => {
            console.error(`${chalk.green(`   ${idx + 1}.`)} ${chalk.white(solution)}`);
        });

        console.error(chalk.red.bold('═'.repeat(80)) + '\n');
    }

    /**
     * 根据错误类型提供解决方案建议
     */
    getSolutions(errorType, errorMessage) {
        const solutions = {
            'NETWORK': [
                '检查网络连接是否正常',
                '验证防火墙设置，确保允许访问目标服务器',
                '尝试使用 ping 命令测试网络连通性',
                '检查代理设置（如适用）'
            ],
            'API': [
                '验证API密钥是否正确且未过期',
                '检查API配额是否已用完',
                '确认请求参数格式正确',
                '查看API文档确认端点URL正确'
            ],
            'TIMEOUT': [
                '增加超时时间设置',
                '检查网络延迟是否过高',
                '优化请求内容大小',
                '检查目标服务器响应速度'
            ],
            'AUTH': [
                '验证用户名和密码是否正确',
                '确认API密钥权限充足',
                '检查令牌是否过期',
                '验证访问权限配置'
            ],
            'VALIDATION': [
                '检查输入参数是否符合要求',
                '验证数据格式和类型',
                '确认必填字段已提供',
                '查看详细的验证错误消息'
            ],
            'SYSTEM': [
                '检查系统资源是否充足（内存、磁盘空间）',
                '验证配置文件是否正确',
                '查看系统日志获取更多信息',
                '尝试重启相关服务'
            ],
            'UNKNOWN': [
                '查看详细错误消息和堆栈跟踪',
                '检查最近的代码更改',
                '在测试环境中复现问题',
                '搜索相关错误信息'
            ]
        };

        return solutions[errorType] || solutions['UNKNOWN'];
    }

    /**
     * 任务步骤日志 - 显示多步骤任务的进度
     * @param {string} module - 服务模块
     * @param {number} stepIndex - 当前步骤索引
     * @param {number} totalSteps - 总步骤数
     * @param {string} stepName - 当前步骤名称
     * @param {string} status - 状态 (running|success|error|warning)
     * @param {Object} details - 附加信息
     */
    taskStep(module, stepIndex, totalSteps, stepName, status = 'running', details = null) {
        if (!this.shouldLog('info')) return;

        const stepIcons = {
            'running': '🔄',
            'success': '✅',
            'error': '❌',
            'warning': '⚠️',
            'waiting': '⏳'
        };

        const statusColors = {
            'running': chalk.blue,
            'success': chalk.green,
            'error': chalk.red,
            'warning': chalk.yellow,
            'waiting': chalk.gray
        };

        const icon = stepIcons[status] || '❓';
        const color = statusColors[status] || chalk.white;
        const stepNumber = `[${stepIndex}/${totalSteps}]`;
        const stepText = color(`${icon} 步骤 ${stepNumber}: ${stepName}`);

        console.log(`\n${chalk.cyan(`[${module.toUpperCase()}]`)} ${stepText}`);

        if (details) {
            if (typeof details === 'object') {
                console.log(chalk.gray(`   ${JSON.stringify(details, null, 2).split('\n').join('\n   ')}`));
            } else {
                console.log(chalk.gray(`   ${details}`));
            }
        }
    }

    /**
     * 任务进度条 - 改进版
     * @param {string} module - 服务模块
     * @param {number} current - 当前进度
     * @param {number} total - 总进度
     * @param {string} taskName - 任务名称
     * @param {Object} extra - 额外信息
     */
    progressEnhanced(module, current, total, taskName, extra = {}) {
        if (!this.shouldLog('info')) return;

        const percentage = Math.round((current / total) * 100);
        const barLength = 30;
        const filledLength = Math.round((percentage / 100) * barLength);
        const bar = '█'.repeat(filledLength) + '░'.repeat(barLength - filledLength);

        let extraStr = '';
        if (extra.status) {
            const statusIcon = {
                'running': '🔄',
                'success': '✅',
                'error': '❌',
                'waiting': '⏳'
            };
            extraStr = ` ${statusIcon[extra.status] || ''} ${extra.status || ''}`;
        }

        if (extra.info) {
            extraStr += ` ${extra.info}`;
        }

        const progressLine = `${chalk.cyan(`[${module.toUpperCase()}]`)} ${chalk.yellow('进度:')} [${bar}] ${chalk.green.bold(percentage + '%')} (${current}/${total})${extraStr}`;
        const taskLine = `${chalk.white.bold(`   📋 ${taskName}`)}`;

        process.stdout.write(`\r${progressLine}`);
        console.log(`\n${taskLine}`);

        if (current === total) {
            console.log(chalk.green.bold('   ✨ 任务完成！\n'));
        }
    }

    /**
     * 错误日志
     */
    error(module, action, details = null) {
        this.log('error', module, action, details);
    }

    /**
     * 警告日志
     */
    warn(module, action, details = null) {
        this.log('warn', module, action, details);
    }

    /**
     * 信息日志
     */
    info(module, action, details = null) {
        this.log('info', module, action, details);
    }

    /**
     * 成功日志
     */
    success(module, action, details = null) {
        this.log('success', module, action, details);
    }

    /**
     * 调试日志
     */
    debug(module, action, details = null) {
        this.log('debug', module, action, details);
    }

    /**
     * 服务器启动日志 (特殊格式)
     */
    startup(port, host) {
        console.log(chalk.green.bold('\n🚀 新闻聚合服务已启动'));
        console.log(chalk.white(`   - 本地访问:   http://localhost:${port}`));
        console.log(chalk.white(`   - 网络访问:   http://${host}:${port}`));
        console.log(chalk.cyan(`   - 启动时间:   ${new Date().toLocaleString('zh-CN', { hour12: false })}`));
        console.log(chalk.gray('----------------------------------------------------\n'));
    }

    /**
     * 任务进度日志 (特殊格式)
     */
    progress(module, current, total, action = '') {
        if (!this.shouldLog('info')) return;

        const percentage = Math.round((current / total) * 100);
        const progressBar = '█'.repeat(Math.floor(percentage / 4)) + '░'.repeat(25 - Math.floor(percentage / 4));
        const progressMessage = `[${module.toUpperCase()}] [进度] [${progressBar}] ${percentage}% (${current}/${total}) ${action}`;
        
        process.stdout.write(`\r${chalk.yellow(progressMessage)}`);
        if (current === total) {
            process.stdout.write('\n'); // 换行
        }
    }
}

// 为了兼容旧的chalk依赖，我们需要检查并安装它
// 这里我们假设它已经存在或将被添加

const logger = new Logger();

module.exports = logger;
