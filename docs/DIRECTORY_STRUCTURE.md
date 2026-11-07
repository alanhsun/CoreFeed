# 项目目录结构说明 (CoreFeed v2.0)

```text
CoreFeed/
├── server.js                      # 应用主入口 (Express + Socket.IO)
├── package.json                   # 项目依赖与脚本定义
├── Dockerfile                     # Docker 容器镜像构建配置 (Asia/Shanghai 时区)
├── docker-compose.yml             # Docker Compose 编排配置
├── deploy-router.sh               # OpenWrt / iStoreOS / Linux 软路由一键部署与热更新脚本
├── start-local.bat                # Windows 本地一键启动脚本
├── ecosystem.config.js            # PM2 生产环境进程配置
├── config/
│   ├── index.js                   # 统一配置中心 (支持 data/settings.json 热更新)
│   └── global_sources.js          # 全球知名信源矩阵 (30 家国际权威媒体与降级策略 v2.2)
├── services/
│   ├── index.js                   # 服务导出索引
│   ├── news_agent_service.js      # 两阶段渐进式采集、编译与单篇深读中枢
│   ├── agent_tools.js             # 采集与正文抽取工具层 (RSS、Google News 域名代理、Jina、Cheerio)
│   ├── ai_service.js              # 跨源事件聚类、规则预分类、JSON 批量编译与免密钥翻译兜底
│   ├── news_service.js            # 新闻源兼容接口与本地缓存读写
│   └── state_manager.js           # 内存状态管理与事件分发
├── scripts/
│   ├── ag-harvest.js              # Path A 阶段一：全球信源并发采集与正文提取 CLI
│   ├── ag-publish.js              # Path A 阶段二：并查集二次聚类、引注渲染与远程发布 CLI
│   └── ag-auto-update.js          # Path A 全自动四阶段闭环更新脚本 (08:00/12:30/19:30)
├── routes/
│   └── api.js                     # RESTful API 路由定义 (/api/agent/publish, /api/schedule/* 等)
├── middleware/
│   └── error_handler.js           # 全局错误处理与速率限制中间件
├── utils/
│   ├── index.js                   # 工具函数导出索引
│   ├── schedule_manager.js        # 定时采集任务调度器 (默认 08:00, 12:30, 19:30 北京时间)
│   ├── rate_limiter.js            # LLM API 令牌桶限流器
│   ├── network_config.js          # HTTP 连接池配置
│   ├── logger.js                  # 统一日志与指标收集器
│   └── helpers.js                 # 通用辅助工具与内存缓存
├── views/
│   └── index.ejs                  # 聚核 v2.0 响应式新闻阅读器视图
├── public/
│   ├── css/style.css              # Kami 纸感排版与深浅色主题样式
│   ├── js/main.js                 # 前端控制器、多维筛选与实时渐进渲染
│   └── images/logo.png            # 品牌 Logo
└── tests/
    └── ag_pipeline.test.js        # Path A 发布接口与 CLI 流水线端到端测试套件
```
