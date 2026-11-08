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

### 2. 🤖 Antigravity 多客户端自动化采编发流水线 (Path A & 方案 2B 默认工作流)
- 支持将信源采集、深度中文精编、GitHub 快照中枢同步与站点发布解耦，提供开箱即用的多客户端协同工具链：
  - **`npm run ag:harvest` (`scripts/ag-harvest.js`)**：并发采集全球 30 大信源、跨源去重、抽取首图与正文，输出候选包 `data/ag_candidates.json`。
  - **`npm run ag:publish` (`scripts/ag-publish.js`)**：读取编译产物 `data/ag_compiled.json`，执行并查集（Union-Find）二次语义合并、渲染 `[NEWS_k]` 引注锚点，**默认同步推送至 GitHub `ag-snapshot/latest.json` 分支**（`GITHUB_PUSH_ENABLED=true`，写入 `publishedBy` 客户端标识），并通过 `POST /api/agent/publish` 推送到目标站点实时落盘与全站广播。
  - **`npm run ag:auto` (`scripts/ag-auto-update.js`)**：一键全自动闭环编排（**30 分钟多客户端远端快照冷却预检** → `Harvest` → `AI/Fallback Compile` → **默认推送 `ag-snapshot/latest.json` 及目标站点** → `/api/health` 在线健康核验）。

### 3. ⏰ 每天早、中、晚三次全自动更新机制 (`08:00, 12:30, 19:30` 北京时间)
- 内置 `ScheduleManager` (`utils/schedule_manager.js`) 与外部定时任务双保险，默认锁定 `Asia/Shanghai` 时区，每天在 **早 (`08:00`)、中 (`12:30`)、晚 (`19:30`)** 三个黄金时段全自动采集、整理并更新网站新闻。
- 内置 **多客户端 30 分钟冷却窗口防冲突与 60 分钟轻量级 ETag 兜底同步**：任意客户端完成发布后，其他客户端在冷却窗口内自动拉取复用最新快照，软路由按每日三次定时点与每 60 分钟轻量级轮询自动同步，避免多端重复采集覆盖与频繁检测。

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
│   ├── ag-publish.js              # Path A 阶段二：并查集二次聚类、引注渲染与默认 GitHub 快照发布 CLI
│   └── ag-auto-update.js          # Path A/2B 全自动多客户端协同更新脚本 (冷却预检->采集->编译->发布->核验)
├── routes/
│   └── api.js                     # RESTful API 路由 (/api/agent/publish, /api/agent/pull-github, /api/schedule/* 等)
├── middleware/
│   └── error_handler.js           # 全局错误处理、异步包装与 API 速率限制中间件
├── utils/
│   ├── github_sync.js             # GitHub 独立快照分支发布 (Plumbing)、多客户端冷却检查与 ETag 同步器
│   ├── schedule_manager.js        # Cron 多时间点自动采集调度器 (08:00, 12:30, 19:30 + 60 分钟快照兜底轮询)
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
    ├── ag_pipeline.test.js        # Path A 接口、CLI 与方案 2B 多客户端协同端到端测试套件 (12/12)
    └── deploy_router.test.js      # 软路由一键部署与热更新脚本端到端自动化测试套件 (4/4)
```

---

## 每日更新指南：多客户端协同与软路由 (`10.10.20.10:3120`) 自动同步 🔄

系统将 **方案 2B（以 GitHub `ag-snapshot/latest.json` 作为多客户端统一中枢与唯一事实源）** 设为全项目默认主流程，同时支持局域网 HTTP 直推：

### 🌟 默认主流程（方案 2B）：GitHub `ag-snapshot/latest.json` 多客户端统一中枢 + 软路由早中晚定时与 60 分钟轻量同步
无论你有多少个不同的 Antigravity 客户端（如云端沙箱 VM、家里或公司的 Windows 电脑、MacBook），均可通过 GitHub `ag-snapshot` 分支实现免公网 IP、防冲突的自动协同：

1. **开箱即用默认推送 GitHub (`GITHUB_PUSH_ENABLED=true`)**：
   - 任意客户端直接执行 `npm run ag:auto` 或 `npm run ag:publish`（无需额外加 `--github` 参数），脚本都会使用 Git 底层 Plumbing 命令（`hash-object` → `mktree` → `commit-tree` → `push --force`）自动将精编完成的脱敏数据包写入 GitHub `ag-snapshot` 独立孤儿分支的 `latest.json`，全程不触碰 `main` 分支工作区。
   - 快照中自动记录 `publishedBy` / `clientId`（可通过 `--client-id=<名称>` 或环境变量 `CLIENT_ID` 指定，默认取当前机器 `os.hostname()`），清晰标识当前快照由哪个客户端发布。
   - 如需在单次运行中仅更新本地而不推送 GitHub，可传入 `--no-github`（或在 `.env` 中设置 `GITHUB_PUSH_ENABLED=false`）。

2. **多客户端防冲突冷却保护 (`GITHUB_COOLDOWN_MINUTES=30`)**：
   - 当任意客户端执行 `ag-auto-update.js`（或每日 `08:00, 12:30, 19:30` 定时任务触发）时，会先检查远端 GitHub `ag-snapshot/latest.json` 的 `publishedAt` 时间戳：
     - **若在 30 分钟冷却窗口内已被其他客户端更新过**（且未传 `--force`）：当前客户端自动跳过耗时的重复采集与编译，直接拉取远端最新快照同步至本地并退出，避免多客户端互相覆盖与重复消耗资源；
     - **若远端快照已超过 30 分钟或传入了 `--force`**：当前客户端执行完整采集、中文精编与综述生成，并推送最新快照至 `ag-snapshot/latest.json`。

3. **软路由 (`10.10.20.10:3120`) 纯正方案 2B 接收端（早中晚定时拉取 + 每 60 分钟轻量兜底轮询）**：
   - 通过 `deploy-router.sh` 部署的软路由容器默认开启 `GITHUB_SYNC_ENABLED=true` 且配置 `GITHUB_SYNC_INTERVAL_MINUTES=60`。
   - 软路由在**容器启动时**、**每日 `08:00, 12:30, 19:30` 定时点**以及**后台每 60 分钟轻量级兜底轮询（支持 `If-None-Match` ETag / `304 Not Modified` 零流量比对与 `publishedAt` 校验）**自动检查 `ag-snapshot/latest.json`。
   - 任意客户端推送 GitHub 后，软路由会在定时点或兜底轮询周期内无感拉取最新快照，更新内存 `stateManager`、写入 `/opt/corefeed/data/{news,summary,state}.json`，并通过 Socket.IO 实时刷新所有打开的网页。
   - 也可随时手动触发软路由立即拉取：
     ```bash
     curl -X POST http://10.10.20.10:3120/api/agent/pull-github
     ```

---

### 补充拓扑：局域网本机直推 (`10.10.20.10:3120`) 或公网反代直推 (2A)
当本机与软路由处于同一局域网（可直接访问 `http://10.10.20.10:3120`）时，除了默认同步到 GitHub `ag-snapshot` 外，还可同时向软路由发起 HTTP 秒级直推：

```powershell
# 在本机 .env 中设置 COREFEED_SITE_URL=http://10.10.20.10:3120（或通过 --site 指定）
# 一键执行：多客户端冷却检查 -> 采集 -> 编译 -> 同步推送至 GitHub ag-snapshot 与 10.10.20.10:3120
npm run ag:auto

# 强制忽略 30 分钟冷却窗口立即重新采编并发布（携带自定义客户端标识）：
node scripts/ag-auto-update.js --force --client-id=alan-windows-pc --site http://10.10.20.10:3120

# 仅将已编译的 data/ag_compiled.json 推送至 GitHub ag-snapshot 及软路由：
node scripts/ag-publish.js --site http://10.10.20.10:3120 --file data/ag_compiled.json
```

---

## 核心 API 接口 📡

```http
POST /api/agent/patrol             # 触发两阶段全球知名信源采集与渐进式编译
POST /api/agent/publish            # 接收外部预编译新闻与综述数据、持久化并全站广播 (支持 Bearer/X-Publish-Secret)
POST /api/agent/pull-github        # 从 GitHub ag-snapshot 分支拉取最新精编快照并应用落盘 (支持 force/snapshotUrl)
GET  /api/agent/sync-status        # 获取 GitHub 快照中转同步状态、最近同步时间、ETag 与发布客户端标识 (publishedBy)
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
# 执行全自动闭环更新 (默认启用方案 2B：30m 冷却预检 -> 采集 -> 编译 -> 推送 GitHub ag-snapshot & 本地站点)
npm run ag:auto

# 强制忽略远端冷却窗口立即采编并推送 GitHub 快照分支
node scripts/ag-auto-update.js --force --client-id=my-client

# 分步执行：仅采集候选池 / 发布已编译结果 (默认推送 GitHub ag-snapshot，加 --no-github 可仅限本地)
npm run ag:harvest
npm run ag:publish

# 运行端到端自动化测试套件 (16/16 测试用例)
npm test
```

### 3. Docker / 软路由一键部署与热更新
```bash
# 方式 A：OpenWrt / iStoreOS / Linux 软路由远程一键更新与部署
# (完全兼容 Windows PowerShell / CMD / 终端，自动迁移旧容器 AI 密钥并同步每日 08:00,12:30,19:30 自动更新，请将 <YOUR_ROUTER_IP> 替换为软路由 IP)
ssh root@<YOUR_ROUTER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"

# 首次安装后，日常秒级热更新代码只需执行：
ssh root@<YOUR_ROUTER_IP> "sh /opt/corefeed/deploy-router.sh"

# 方式 B：使用 Docker Compose 启动
docker-compose up -d --build
```

访问 `http://localhost:3120`（或 `http://<YOUR_ROUTER_IP>:3120`）即可打开 **聚核 CoreFeed v2.0**。
