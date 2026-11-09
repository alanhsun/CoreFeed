module.exports = {
  apps: [{
    name: 'corefeed',
    script: 'server.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '1G',
    
    // 日志配置
    log_file: './logs/pm2-combined.log',
    out_file: './logs/pm2-out.log',
    error_file: './logs/pm2-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    time: true,
    
    // 日志格式配置
    log_type: 'json',
    merge_logs: true,
    log_rotate: {
      max_size: '10M',
      retain: 7,
      compress: true,
      date_format: 'YYYY-MM-DD'
    },
    
    // 环境变量
    env: {
      NODE_ENV: 'development',
      PORT: 3120
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3120
    },
    
    // 进程管理
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 4000,
    kill_timeout: 5000
  }, {
    name: 'corefeed-ag-daemon',
    script: 'scripts/ag-auto-update.js',
    args: '--daemon',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    max_memory_restart: '512M',

    // 日志配置
    log_file: './logs/ag-daemon-combined.log',
    out_file: './logs/ag-daemon-out.log',
    error_file: './logs/ag-daemon-err.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    time: true,

    // 环境变量
    env: {
      NODE_ENV: 'production',
      SCHEDULE_TIMEZONE: 'Asia/Shanghai',
      UPDATE_TIMES: '08:00,12:30,19:30'
    },
    env_production: {
      NODE_ENV: 'production',
      SCHEDULE_TIMEZONE: 'Asia/Shanghai',
      UPDATE_TIMES: '08:00,12:30,19:30'
    },

    // 进程管理
    min_uptime: '10s',
    max_restarts: 10,
    restart_delay: 5000,
    kill_timeout: 5000
  }]
};