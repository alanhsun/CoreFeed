/**
 * 聚核 CoreFeed v2.0 — 统一结构化日志输出工具 (utils/logger.js)
 */
const chalk = require('chalk');

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
     */
    shouldLog(level) {
        return this.logLevels[level] <= this.logLevels[this.logLevel];
    }

    /**
     * 格式化控制台日志消息
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

    error(module, action, details = null) {
        this.log('error', module, action, details);
    }

    warn(module, action, details = null) {
        this.log('warn', module, action, details);
    }

    info(module, action, details = null) {
        this.log('info', module, action, details);
    }

    success(module, action, details = null) {
        this.log('success', module, action, details);
    }

    debug(module, action, details = null) {
        this.log('debug', module, action, details);
    }

    /**
     * 服务器启动横幅日志
     */
    startup(port, host) {
        console.log(chalk.green.bold('\n🚀 聚核 CoreFeed 新闻聚合服务已启动'));
        console.log(chalk.white(`   - 本地访问:   http://localhost:${port}`));
        console.log(chalk.white(`   - 网络访问:   http://${host}:${port}`));
        console.log(chalk.cyan(`   - 启动时间:   ${new Date().toLocaleString('zh-CN', { hour12: false })}`));
        console.log(chalk.gray('----------------------------------------------------\n'));
    }
}

const logger = new Logger();

module.exports = logger;
