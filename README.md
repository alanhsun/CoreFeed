<div align="center">
  <img src="public/images/logo.png" alt="CoreFeed Logo" width="130" style="border-radius: 20px;" />
  <h1>聚核 (CoreFeed v2.0) · 全球知名信源实时聚合与深读平台 📰</h1>
  <p>专注于全球权威新闻并发采集、跨信源交叉印证、Jina 全文穿透深读与两阶段渐进式中文编译的轻量化新闻阅读平台。</p>
</div>

![版本](https://img.shields.io/badge/版本-v2.0.0-blue)
![架构](https://img.shields.io/badge/Engine-Two--Stage%20Progressive-indigo)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)
![许可证](https://img.shields.io/badge/许可证-MIT-blue)

## 核心特性 ✨

### 1. ⚡ 双模式全自动架构：内置两阶段渐进引擎 + Antigravity 客户端流水线 (Path A)
- **阶段一：秒级采集、跨源聚类与首屏直出 (`Scout` & `Curator`)**
  - **并发信源采集 (`Scout`)**：并发巡检内置的 **30 个全球知名权威信源矩阵**（`config/global_sources.js` v2.2，涵盖 Reuters、AP、BBC World、NYT、Bloomberg、WSJ、FT、The Guardian、DER SPIEGEL、Al Jazeera、南华早报 SCMP、CNA、NHK World、Nikkei Asia、韩联社 Yonhap、TechCrunch、Ars Technica 等），支持按信源类别定向采集。
  - **三级自适应防屏蔽降级 (`services/agent_tools.js`)**：官方 RSS 优先 → **Google News 站点定向代理 (`site:domain`)** 自动突破 Cloudflare/SPA 反爬 → **Jina Reader (`r.jina.ai`)** 列表抽取。
  - **跨信源事件聚类与即时展示 (`Curator`)**：自动合并同一事件来自多家媒体的同题报道（生成可点击跳转的 `relatedSources` 交叉印证列表），通过规则引擎秒级预判地区与版面分类，**无需等待漫长的 AI 编译即可立即推送前端首屏展示**（即使未配置 AI 密钥也可自动启用免密钥中文直译与结构化综述兜底）。
- **阶段二：后台全文穿透深读与分批增量中文编译 (`Deep-Reader` & `Compiler`)**
  - **双引擎全文提取 (`Deep-Reader`)**：使用 `r.jina.ai` 与本地 Cheerio Readability 自动提取重点新闻正文与高光配图。
  - **分批增量中文编译 (`Compiler`)**：以结构化 JSON 批处理生成中文标题、百字客观摘要、地域/领域标签与核心要点；每完成一批（8 条），立即通过 WebSocket 增量刷新页面卡片。
  - **今日要闻深度综述 (`Chief Editor`)**：统筹当日精选全球新闻生成带可点击 `[NEWS_k]` / `[媒体名]` 原文引注的《全球要闻深度综述》。

### 2. 🤖 Antigravity 客户端自动化采编发流水线 (Path A)
- 支持将信源采集、深度中文精编与站点发布解耦，提供完整的命令行工具链与外部发布接口：
  - **`npm run ag:harvest` (`scripts/ag-harvest.js`)**：并发采集全球 30 大信源、跨源去重、抽取首图与正文，输出候选包 `data/ag_candidates.json`。
  - **`npm run ag:publish` (`scripts/ag-publish.js`)**：读取编译产物 `data/ag_compiled.json`，执行并查集（Union-Find）二次语义合并、渲染 `[NEWS_k]` 引注锚点，并通过 `POST /api/agent/publish` 推送到目标站点实时落盘并触发 WebSocket 全站广播。
  - **`npm run ag:auto` (`scripts/ag-auto-update.js`)**：一键全自动四阶段闭环编排（`Harvest` → `AI/Fallback Compile` → `Publish` → `/api/health` 在线健康核验）。

### 3. ⏰ 每天早、中、晚三次全自动更新机制 (`08:00, 12:30, 19:30` 北京时间)
- 内置 `ScheduleManager` (`utils/schedule_manager.js`) 与外部定时任务双保险，默认锁定 `Asia/Shanghai` 时区，每天在 **早 (`08:00`)、中 (`12:30`)、晚 (`19:30`)** 三个黄金时段全自动采集、整理并更新网站新闻。
- 内置 **10 分钟新鲜度防重守卫**：若外部流水线刚完成推送发布，内置调度器会自动跳过同一窗口期内的重复巡检。

### 4. 📖 单篇外媒即时全文深读 (`/api/agent/deep-read`)
- 点击任意新闻卡片底部的「全文深读」，即时穿透抓取外媒原文正文，并输出「核心导读 + 全文核心内容精译 + 背景与深层解读」及原文对照。

---

## 项目结构 📁

```text
CoreFeed/
├── server.js                      # Express + Socket.IO 主服务入口
├── Dockerfile                     # Docker 容器镜像构建配置 (内置 Asia/Shanghai 时区)
├── docker-compose.yml             # Docker Compose 编排配置
├── deploy-router.sh               # OpenWrt / iStoreOS / Linux 软路由一键部署与热更新脚本
├── start-local.bat                # Windows 本地一键启动脚本
├── config/
│   ├── index.js                   # 动态配置管理 (支持 .env 与 data/settings.json 热更新)
│   └── global_sources.js          # 全球 30 大权威信源矩阵定义与权威度权重 (v2.2)
├── services/
│   ├── news_agent_service.js      # 两阶段渐进式采集、编译与单篇深读中枢
│   ├── agent_tools.js             # 采集与正文抽取工具集 (RSS / GoogleNews代理 / Jina / Cheerio)
│   ├── ai_service.js              # 事件聚类、规则预分类、结构化批量编译与免密钥翻译兜底
│   ├── news_service.js            # 基础新闻源接口与本地 JSON 持久化
│   └── state_manager.js           # 集中式状态管理与实时事件广播
├── scripts/
│   ├── ag-harvest.js              # Path A 阶段一：全球信源并发采集与正文提取 CLI
│   ├── ag-publish.js              # Path A 阶段二：并查集二次聚类、引注渲染与远程发布 CLI
│   └── ag-auto-update.js          # Path A 全自动四阶段闭环更新脚本 (采集->编译->发布->核验)
├── routes/
│   └── api.js                     # RESTful API 路由 (/api/agent/publish, /api/schedule/* 等)
├── middleware/
│   └── error_handler.js           # 全局错误处理、异步包装与 API 速率限制中间件
├── utils/
│   ├── schedule_manager.js        # Cron 多时间点自动采集调度器 (默认 08:00, 12:30, 19:30)
│   ├── rate_limiter.js            # 令牌桶 API 速率限制器
│   ├── network_config.js          # 全局 HTTP Keep-Alive 连接池配置
│   ├── logger.js                  # 彩色结构化日志与指标统计
│   └── helpers.js                 # 通用工具与内存缓存
├── views/
│   └── index.ejs                  # Kami (紙) 风格响应式新闻阅读器视图
├── public/
│   ├── css/style.css              # Kami 宣纸/墨夜双主题排版样式
│   └── js/main.js                 # 前端控制器、多维筛选与 WebSocket 渐进式刷新
└── tests/
    └── ag_pipeline.test.js        # Path A 接口与 CLI 流水线端到端自动化测试套件 (7/7)
```

---

## 核心 API 接口 📡

```http
POST /api/agent/patrol             # 触发两阶段全球知名信源采集与渐进式编译
POST /api/agent/publish            # 接收外部预编译新闻与综述数据、持久化并全站广播 (支持 Bearer/X-Publish-Secret)
POST /api/agent/deep-read          # 对指定外媒 URL 执行 Jina/Cheerio 全文提取与中文深读
GET  /api/agent/status             # 获取采集引擎实时状态、阶段、日志与信源统计
GET  /api/schedule/status          # 获取定时自动更新配置、运行状态与下次触发时间
POST /api/schedule/config          # 动态更新每日自动巡检时间点 (如 08:00,12:30,19:30) 与开关
GET  /api/sources/matrix           # 获取全球 30 大知名信源矩阵列表
POST /api/sources/matrix           # 更新信源启用状态、条数限制或新增自定义信源
GET  /api/news                     # 获取新闻列表（支持 region / category / source / q 过滤）
GET  /api/news/more?offset=30      # 分页加载更多已采集新闻
POST /api/refresh                  # 手动刷新新闻
GET  /api/summary                  # 获取今日《全球要闻深度综述》
POST /api/generate-summary         # 重新生成《全球要闻深度综述》
GET  /api/image-proxy              # 外媒新闻配图防盗链与 SSRF 安全代理
GET  /api/latest-data              # 第三方一站式获取最新新闻与综述数据
GET  /api/health                   # 服务健康检查
```

---

## 快速启动与部署 🚀

### 1. 本地启动
```bash
# 1. 安装依赖并初始化环境变量
npm install
cp .env.example .env

# 2. 启动服务 (默认端口 3120)
npm start

# 或开发模式热重载启动
npm run dev
```

### 2. Antigravity 自动化采编发 CLI 与测试
```bash
# 执行全自动四阶段闭环更新 (采集 -> 编译 -> 发布 -> 健康检查)
npm run ag:auto

# 分步执行：仅采集候选池 / 仅发布已编译结果
npm run ag:harvest
npm run ag:publish

# 运行端到端自动化测试套件 (7/7 测试用例)
npm test
```

### 3. Docker / 软路由部署
```bash
# 使用 Docker Compose 启动
docker-compose up -d --build
```

访问 `http://localhost:3120` 即可打开 **聚核 CoreFeed v2.0**。
