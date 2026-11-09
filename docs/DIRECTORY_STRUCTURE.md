# 项目目录结构说明 (CoreFeed v2.0)

```text
CoreFeed/
├── server.js                      # 应用主入口 (Express + Socket.IO + 启动同步编排)
├── package.json                   # 项目依赖与脚本定义
├── Dockerfile                     # Docker 容器镜像构建配置 (Asia/Shanghai 时区)
├── docker-compose.yml             # Docker Compose 编排配置
├── deploy-router.sh               # OpenWrt / iStoreOS / Linux 软路由一键部署与秒级热更新脚本
├── start-local.bat                # Windows 本地一键启动脚本
├── ecosystem.config.js            # PM2 生产环境进程配置
├── config/
│   ├── index.js                   # 统一配置中心 (支持 .env 与 data/settings.json 热更新)
│   └── global_sources.js          # 全球 37 大中英权威信源矩阵与权重定义 (v2.5)
├── services/
│   ├── news_agent_service.js      # 两阶段渐进式采集、配图补全与编译编排中枢
│   ├── agent_tools.js             # 信源采集与首图抓取工具集 (RSS、Google News 域名代理、Jina、og:image)
│   ├── ai_service.js              # 跨源事件聚类、规则预分类、JSON 批量编译与免密钥中文直译兜底
│   ├── news_service.js            # 新闻清洗过滤与本地 JSON 持久化读写
│   └── state_manager.js           # 集中式内存状态管理与 Socket.IO 实时分发
├── scripts/
│   ├── ag-harvest.js              # Stage 1：全球信源并发采集与候选池导出 CLI
│   ├── ag-publish.js              # Stage 2：并查集二次聚类、引注渲染与 GitHub 快照发布 CLI
│   └── ag-auto-update.js          # 全自动多客户端协同更新与常驻定时守护进程 (--daemon / --status)
├── routes/
│   └── api.js                     # 核心 RESTful API 路由定义
├── middleware/
│   └── error_handler.js           # 全局错误处理、404 与速率限制中间件
├── utils/
│   ├── github_sync.js             # GitHub ag-snapshot 分支发布 (Git Plumbing)、冷却检查与 ETag 同步器
│   ├── schedule_manager.js        # 定时调度器 (默认 08:00, 12:30, 19:30 北京时间 + 60m 快照轮询)
│   ├── rate_limiter.js            # LLM API 令牌桶限流器
│   ├── network_config.js          # 全局 HTTP Keep-Alive 连接池配置
│   ├── logger.js                  # 统一结构化日志与指标收集器
│   └── helpers.js                 # 通用 JSON 读写、HTML 清洗与内存缓存工具
├── views/
│   └── index.ejs                  # 瑞士纸媒报头与 12 列不对称 Bento 网格主视图模板 (SSR + Hydration)
├── public/
│   ├── css/style.css              # Swiss Editorial & Asymmetric Bento 设计系统样式表
│   ├── js/main.js                 # 前端控制器、多维筛选与实时渐进渲染
│   └── images/logo.png            # 品牌 Logo
└── tests/
    ├── ag_pipeline.test.js        # 发布接口、CLI 流水线与方案 2B 协同端到端测试套件 (15 项测试)
    └── deploy_router.test.js      # 软路由一键部署与热更新脚本端到端测试套件 (4 项测试)
```
