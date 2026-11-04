# 项目目录结构说明 (CoreFeed v2.0)

```text
news_aggregator/
├── server.js                      # 应用主入口 (Express + Socket.IO)
├── package.json                   # 项目依赖与脚本定义
├── Dockerfile                     # Docker 容器镜像构建配置
├── docker-compose.yml             # Docker Compose 编排配置
├── ecosystem.config.js            # PM2 生产环境进程配置
├── .env.example                   # 环境变量配置模板
├── config/
│   ├── index.js                   # 统一配置中心 (支持 data/settings.json 热更新)
│   └── global_sources.js          # 全球知名信源矩阵 (30+ 国际权威媒体与降级策略)
├── services/
│   ├── index.js                   # 服务导出索引
│   ├── news_agent_service.js      # 多 Agent 协同中枢 (全球巡检、专题调查、单篇深读)
│   ├── agent_tools.js             # Agent 工具层 (RSS、Google News 域名代理、Jina 全文抽取)
│   ├── ai_service.js              # 大模型推理、跨源事件聚类、JSON 批量编译与 Tool-Use
│   ├── news_service.js            # 新闻源兼容接口与本地缓存读写
│   ├── epub_email_service.js      # EPUB 电子书打包与 Kindle 邮件推送
│   ├── audio_service.js           # TTS 语音合成与 FFmpeg 音频合并
│   ├── ftp_service.js             # FTP 音频文件上传服务
│   └── state_manager.js           # 内存状态管理与事件分发
├── routes/
│   └── api.js                     # RESTful API 路由定义
├── middleware/
│   └── error_handler.js           # 全局错误处理与速率限制中间件
├── utils/
│   ├── index.js                   # 工具函数导出索引
│   ├── schedule_manager.js        # 定时巡检任务调度器
│   ├── rate_limiter.js            # LLM API 令牌桶限流器
│   ├── network_config.js          # HTTP 连接池配置
│   ├── logger.js                  # 统一日志与指标收集器
│   └── helpers.js                 # 通用辅助工具与内存缓存
├── views/
│   └── index.ejs                  # 聚核 v2.0 响应式 Web 控制台
├── public/
│   ├── css/style.css              # 自定义主题与玻璃拟态样式
│   ├── js/main.js                 # 前端控制器与实时遥测交互
│   └── images/logo.png            # 品牌 Logo
└── scripts/
    └── start.bat                  # Windows 一键启动脚本
```
