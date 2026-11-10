<div align="center">
  <img src="public/images/logo.png" alt="CoreFeed Logo" width="130" style="border-radius: 20px;" />
  <h1>聚核 (CoreFeed v2.0) · 全球权威要闻深度聚合与态势综述平台</h1>
  <p>专注于全球 37 大中英权威媒体并发采集、跨信源交叉印证、Antigravity 多客户端协同精编与 GitHub 快照中枢同步的瑞士纸媒风格新闻聚合平台。</p>
</div>

![版本](https://img.shields.io/badge/版本-v2.0.0-blue)
![架构](https://img.shields.io/badge/Architecture-Plan%202B%20GitHub%20Snapshot%20Hub-indigo)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)
![许可证](https://img.shields.io/badge/许可证-MIT-blue)

## 核心特性

### 1. 方案 2B 多客户端协同架构：Antigravity 客户端采编 + GitHub `ag-snapshot` 唯一事实源
- **全球 37 大中英权威信源矩阵 (`config/global_sources.js` v2.5)**：
  - 覆盖国际主流通讯社与深度媒体（Reuters、AP、BBC、NYT、WSJ、Bloomberg、FT、The Guardian、Al Jazeera、SCMP、CNA、NHK World、Nikkei Asia、Yonhap、TechCrunch、Ars Technica、The Verge 等）及权威中文信源（新华网、中国新闻网、澎湃新闻、界面新闻、36氪、IT之家、联合早报等）。
  - **三级自适应防屏蔽采集 (`services/agent_tools.js`)**：官方直连 RSS 优先 → Google News 站点定向代理 (`site:domain`) 自动突破反爬限制 → Jina Reader (`r.jina.ai`) 列表兜底。
- **跨信源事件聚类与中文精编 (`services/ai_service.js`)**：
  - 自动合并同一事件来自多家媒体的报道，生成可点击跳转的 `relatedSources` 多源印证标签。
  - 结构化生成中文精编标题、客观摘要、2–3 条核心事实要点 (`keyPoints`)、地区与领域分类，并统筹撰写带可点击 `[NEWS_k]` / `[媒体名]` 原文引注的《全球要闻深度综述》。
- **方案 2B 软路由防回退保护 (`utils/github_sync.js` & `utils/schedule_manager.js`)**：
  - 软路由端默认开启 `GITHUB_SYNC_ENABLED=true`，仅从 GitHub `ag-snapshot/latest.json` 同步已编译完成的中文快照；支持 `ETag` (`304 Not Modified`) 零流量轮询与英文污染自愈检测，绝不因本地缺少 AI Key 回退抓取英文 RSS 覆盖页面。

### 2. Antigravity 多客户端自动化采编发流水线 (`scripts/`)
- **`npm run ag:harvest` (`scripts/ag-harvest.js`)**：并发采集全球 37 大信源、跨源去重、补全缺失 `og:image` 高清配图，输出候选池 `data/ag_candidates.json`。
- **`npm run ag:publish` (`scripts/ag-publish.js`)**：读取编译结果 `data/ag_compiled.json`，执行并查集（Union-Find）二次语义合并、渲染 `[NEWS_k]` 引注锚点，默认通过 Git Plumbing 无感推送至 GitHub `ag-snapshot/latest.json` 独立孤儿分支，并支持向目标站点 `POST /api/agent/publish` 实时推送。
- **`npm run ag:auto` (`scripts/ag-auto-update.js`)**：端到端四阶段闭环编排（**30 分钟多客户端冷却预检** → `Harvest` → `AI/Fallback Compile` → **推送 `ag-snapshot/latest.json` 及目标站点** → `/api/health` 在线健康核验）。
- **`npm run ag:daemon` / `npm run ag:status` (`scripts/ag-auto-update.js --daemon` / `--status`)**：本机后台常驻定时采编守护进程（严格按 `Asia/Shanghai` 北京时间每日 `07:40, 12:10, 19:10` 提前软路由拉取时间点 20 分钟自动执行全流程采编、100% 纯正中文编译并推送到 `origin/ag-snapshot/latest.json`，确保软路由在 `08:00, 12:30, 19:30` 准点拉取时最新中文快照已就绪）及运行状态/PID/下次执行时间查询工具。

### 3. 瑞士纸媒风 12 列不对称 Bento 网格阅读体验 (`views/index.ejs` & `public/css/style.css`)
- 采用温暖宣纸白 (`#F6F5F1`) 与深曜石碳黑 (`#090A0C`) 双主题，搭配国际朱砂红 (`#C83214`) 单一高纯度视觉强调色与 1px 裸露分割线。
- 12 列不对称 Bento Grid 自动识别头条焦点 (`Lead`)、次要重点 (`Secondary`) 与高密度简讯 (`Compact`)，卡片底栏保留发布时间 (`.card-timestamp`) 与「原文 ↗」直达外链 (`.btn-source-link`)。

---

## 方案 2B 架构拓扑

```text
[37 Global Authoritative Sources (RSS / Google News Proxy)]
                       │
                       ▼  1. npm run ag:harvest (Client Pre-Fetch Cron: 07:40, 12:10, 19:10 CST / 23:40, 04:10, 11:10 UTC)
          [data/ag_candidates.json]
                       │
                       ▼  2. Antigravity LLM Compilation (Title / Summary / KeyPoints / Briefing)
           [data/ag_compiled.json]
                       │
                       ▼  3. npm run ag:publish (Union-Find Merge + [NEWS_k] Citations + Git Plumbing)
   ┌───────────────────┴───────────────────┐
   ▼ (Git Orphan Commit)                   ▼ (Optional LAN HTTP Push)
[GitHub origin/ag-snapshot/latest.json]  [POST /api/agent/publish]
   │
   ▼  4. Startup / 08:00, 12:30, 19:30 Router Pull Cron / 60m ETag Polling / Web UI "同步最新"
[OpenWrt / iStoreOS Router (:3120) — Swiss Editorial Bento UI (v2.5.4)]
```

---

## 项目结构

```text
CoreFeed/
├── server.js                      # Express + Socket.IO 主服务入口与启动恢复编排
├── Dockerfile                     # Docker 容器镜像构建配置 (内置 Asia/Shanghai 时区)
├── docker-compose.yml             # Docker Compose 编排配置
├── deploy-router.sh               # OpenWrt / iStoreOS / Linux 软路由一键部署与秒级热更新脚本
├── start-local.bat                # Windows 本地一键启动脚本
├── config/
│   ├── index.js                   # 动态配置管理 (支持 .env 与 data/settings.json 热更新)
│   └── global_sources.js          # 全球 37 大中英权威信源矩阵定义与权威度权重 (v2.5)
├── services/
│   ├── news_agent_service.js      # 两阶段渐进式采集、配图富化与编译编排中枢
│   ├── agent_tools.js             # 信源采集与首图抓取工具集 (RSS / GoogleNews代理 / Jina / og:image)
│   ├── ai_service.js              # 跨源聚类、规则分类、结构化批量编译与免密钥中文直译兜底
│   ├── news_service.js            # 新闻条目清洗、过滤与本地 JSON 持久化
│   └── state_manager.js           # 集中式内存状态管理与 Socket.IO 实时广播
├── scripts/
│   ├── ag-harvest.js              # Stage 1：全球信源并发采集与候选池导出 CLI
│   ├── ag-publish.js              # Stage 2：并查集二次聚类、引注渲染与 GitHub 快照发布 CLI
│   └── ag-auto-update.js          # 全自动多客户端协同更新与常驻守护进程 (默认 07:40, 12:10, 19:10 提前 20m 采编)
├── routes/
│   └── api.js                     # 核心 RESTful API 路由
├── middleware/
│   └── error_handler.js           # 全局错误处理、404 与 API 速率限制中间件
├── utils/
│   ├── github_sync.js             # GitHub ag-snapshot 分支发布 (Git Plumbing)、冷却预检与 ETag 同步器
│   ├── schedule_manager.js        # 服务端/软路由每日定时拉取调度器 (08:00, 12:30, 19:30 + 60 分钟快照轮询)
│   ├── rate_limiter.js            # 令牌桶 API 速率限制器
│   ├── network_config.js          # 全局 HTTP Keep-Alive 连接池配置
│   ├── logger.js                  # 彩色结构化日志与运行指标统计
│   └── helpers.js                 # 通用 JSON 读写、HTML 清洗与内存缓存工具
├── views/
│   └── index.ejs                  # 瑞士纸媒报头与 12 列不对称 Bento 网格主视图模板 (SSR + Hydration)
├── public/
│   ├── css/style.css              # Swiss Editorial & Asymmetric Bento 设计系统样式表
│   └── js/main.js                 # 前端状态水合、Bento 动态渲染、多维筛选与实时同步控制器
└── tests/
    ├── ag_pipeline.test.js        # 发布接口、CLI 流水线与方案 2B 协同端到端测试套件 (15 项测试)
    └── deploy_router.test.js      # 软路由一键部署与热更新脚本端到端测试套件 (4 项测试)
```

---

## 每日更新指南：多客户端协同与软路由 (`10.10.20.10:3120`) 自动同步

系统以 **方案 2B（GitHub `ag-snapshot/latest.json` 作为多客户端统一中枢与唯一事实源）** 为默认主工作流，同时支持局域网 HTTP 秒级直推：

1. **客户端默认推送 GitHub (`GITHUB_PUSH_ENABLED=true`)**：
   - 在任意 Antigravity 客户端执行 `npm run ag:auto` 或 `npm run ag:publish`，脚本通过 Git 底层 Plumbing 命令自动将精编完成的快照写入 `ag-snapshot` 独立孤儿分支的 `latest.json`，全程不触碰 `main` 分支工作区。
   - 快照内自动记录 `publishedBy` / `clientId` 标识；如需仅更新本地而不推送 GitHub，可附加 `--no-github`。
2. **多客户端 30 分钟冷却防冲突 (`GITHUB_COOLDOWN_MINUTES=30`)**：
   - 当客户端执行 `ag-auto-update.js` 时，会先检查远端 `ag-snapshot/latest.json` 的 `publishedAt`：若 30 分钟内已被其他客户端更新且未传 `--force`，自动拉取复用远端快照并跳过重复采集。
3. **软路由 (`10.10.20.10:3120`) 自动同步与一键拉取**：
   - 软路由在容器启动、每日 `08:00, 12:30, 19:30`（北京时间）定时点及后台每 60 分钟轻量轮询时自动拉取 `ag-snapshot/latest.json`（由于客户端提前 20 分钟在 `07:40, 12:10, 19:10` 完成采编并推送到 GitHub，软路由在准点拉取时最新一期中文精编快照刚好已经就绪）。
   - 也可点击网页右上角「同步最新」按钮，或执行以下命令立即触发拉取：
     ```bash
     curl -X POST http://10.10.20.10:3120/api/agent/pull-github -H "X-Requested-With: CoreFeed-WebUI"
     ```

### 局域网直推常用命令
```powershell
# 一键执行：多客户端冷却预检 -> 采集 -> 编译 -> 同步推送至 GitHub ag-snapshot 与本地/目标站点
npm run ag:auto

# 强制忽略 30 分钟冷却窗口立即重新采编并发布至软路由：
node scripts/ag-auto-update.js --force --client-id=alan-windows-pc --site http://10.10.20.10:3120

# 仅将已编译的 data/ag_compiled.json 推送至 GitHub ag-snapshot 及软路由：
node scripts/ag-publish.js --site http://10.10.20.10:3120 --file data/ag_compiled.json
```

### 本机与多平台定时任务配置（每日早 07:40、中 12:10、晚 19:10 提前 20 分钟自动采集与推送）

无论在云端 Antigravity 容器还是本地 Windows / macOS / Linux 电脑上，均可按以下任一方式（或双重保障组合）配置每天早 `07:40`、中 `12:10`、晚 `19:10`（北京时间 `Asia/Shanghai`，提前软路由 `08:00, 12:30, 19:30` 拉取时间 20 分钟）自动新闻收集、中文精编与 GitHub `ag-snapshot` 推送：

#### 1) 方式 A：本机常驻定时守护进程（跨平台通用，开箱即用）
```bash
# 直接在前台或 nohup 后台启动内置 Asia/Shanghai 时区的定时采编守护进程 (07:40, 12:10, 19:10)
npm run ag:daemon

# 或在 Linux / 云端容器中使用 nohup 后台常驻运行（自动记录 PID 至 logs/ag-daemon.pid 及状态至 data/ag_daemon_status.json）
nohup node scripts/ag-auto-update.js --daemon --client-id=antigravity-cloud-vm --target=http://127.0.0.1:3120 > logs/ag-daemon.log 2>&1 &

# 随时查看守护进程在线状态、PID、下次触发时间 (北京时间 & UTC) 及最近一次快照发布信息
npm run ag:status

# 若已安装 PM2，也可一键将定时采编守护进程纳入 PM2 生产环境托管
npm run pm2:daemon
```

#### 2) 方式 B：Antigravity 客户端内置 `schedule` 定时唤醒任务
在 Antigravity 对话中可通过内置 `schedule` 工具（设置 `IsDaemon=true`）注册每日早、中、晚提前 20 分钟的常驻 Cron 任务：

| 档期（提前 20 分钟预采编） | 北京时间 (`Asia/Shanghai`, `UTC+8`) | UTC 时间 (`Etc/UTC`, `UTC+0`) | 美西时间 (`America/Los_Angeles`, `UTC-8`) |
|---|---|---|---|
| **早间档 (07:40 CST → 供 08:00 拉取)** | `40 7 * * *` | `40 23 * * *` (`23:40 UTC`) | `40 15 * * *` (`15:40 PST`) |
| **午间档 (12:10 CST → 供 12:30 拉取)** | `10 12 * * *` | `10 4 * * *` (`04:10 UTC`) | `10 20 * * *` (`20:10 PST`) |
| **晚间档 (19:10 CST → 供 19:30 拉取)** | `10 19 * * *` | `10 11 * * *` (`11:10 UTC`) | `10 3 * * *` (`03:10 PST`) |

标准定时唤醒 Prompt 模板：
> 在 `/home/antigravity/alanhsun/CoreFeed` 执行定时新闻收集与中文精编发布：运行 `npm run ag:harvest` 采集候选集，将 `data/ag_candidates.json` 全部候选新闻深度编译为 100% 纯正中文（`<=32` 字标题、`80-130` 字摘要、3 条核心要点、同事件 `duplicateGroups` 及带 `[NEWS_k]` 引注的《今日全球要闻深度综述》）写入 `data/ag_compiled.json`，随后运行 `node scripts/ag-publish.js --github --force` 推送至 `origin/ag-snapshot` (`latest.json`) 并同步更新本地 `:3120` 服务（或直接执行 `node scripts/ag-auto-update.js --force`）。

#### 3) 方式 C：本地电脑操作系统定时任务（Windows 任务计划程序 / macOS & Linux Crontab）
- **Windows PowerShell（一键注册早 07:40、中 12:10、晚 19:10 三个提前 20 分钟预采编计划任务）**：
  ```powershell
  $RepoDir = "C:\path\to\CoreFeed"
  schtasks /Create /F /SC DAILY /ST 07:40 /TN "CoreFeed_Morning_0740" /TR "cmd /c cd /d `"$RepoDir`" && npm run ag:auto"
  schtasks /Create /F /SC DAILY /ST 12:10 /TN "CoreFeed_Midday_1210"  /TR "cmd /c cd /d `"$RepoDir`" && npm run ag:auto"
  schtasks /Create /F /SC DAILY /ST 19:10 /TN "CoreFeed_Evening_1910" /TR "cmd /c cd /d `"$RepoDir`" && npm run ag:auto"
  ```
- **macOS / Linux (`crontab -e`)**：
  ```cron
  CRON_TZ=Asia/Shanghai
  40 7 * * * cd /path/to/CoreFeed && /usr/bin/env node scripts/ag-auto-update.js >> logs/ag-cron.log 2>&1
  10 12 * * * cd /path/to/CoreFeed && /usr/bin/env node scripts/ag-auto-update.js >> logs/ag-cron.log 2>&1
  10 19 * * * cd /path/to/CoreFeed && /usr/bin/env node scripts/ag-auto-update.js >> logs/ag-cron.log 2>&1
  ```

---

## 核心环境变量参考 (`.env`)

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3120` | Web 服务监听端口 |
| `GITHUB_SYNC_ENABLED` | `true` | 是否开启从 GitHub `ag-snapshot` 分支自动拉取精编快照 |
| `GITHUB_SNAPSHOT_URL` | `https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json` | GitHub 精编快照 Raw 地址 |
| `GITHUB_SYNC_INTERVAL_MINUTES` | `60` | 后台轻量 ETag (`304 Not Modified`) 轮询间隔（分钟） |
| `GITHUB_PUSH_ENABLED` | `true` | 客户端执行 `ag:publish` / `ag:auto` 时是否默认推送到 `ag-snapshot` 分支 |
| `GITHUB_COOLDOWN_MINUTES` | `30` | 多客户端协同防冲突冷却窗口（分钟） |
| `CLIENT_ID` | `os.hostname()` | 当前发布客户端标识（写入快照 `publishedBy` 字段） |
| `AUTO_UPDATE_ENABLED` | `true` | 是否启用每日早中晚三次自动同步调度 |
| `UPDATE_TIMES` | `08:00,12:30,19:30` | 服务端/软路由每日定时拉取快照时间点（北京时间 `Asia/Shanghai`） |
| `AG_UPDATE_TIMES` | `07:40,12:10,19:10` | Antigravity 客户端守护进程每日提前 20 分钟自动采编并推送 GitHub 的时间点（北京时间 `Asia/Shanghai`） |
| `PUBLISH_SECRET` | 空 | `POST /api/agent/publish` 与外部同步接口可选鉴权密钥 |
| `COREFEED_SITE_URL` | `http://localhost:3120` | CLI 发布推送的目标站点地址 |
| `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | OpenAI 兼容端点 | 单机巡检编译可选 LLM 配置（无密钥自动降级免密钥中文直译） |

---

## 核心 API 接口

```http
GET  /api/news                     # 获取新闻列表（支持 region / category / source / q 过滤）
GET  /api/news/more?offset=30      # 分页加载更多已采集新闻
POST /api/refresh                  # 触发刷新（方案 2B 优先同步 GitHub 最新快照）
GET  /api/summary                  # 获取今日《全球要闻深度综述》
POST /api/generate-summary         # 重新生成《全球要闻深度综述》
POST /api/agent/patrol             # 触发两阶段全球知名信源采集与渐进式编译
POST /api/agent/publish            # 接收预编译新闻与综述快照、持久化并全站广播 (支持 Bearer / X-Publish-Secret)
POST /api/agent/pull-github        # 从 GitHub ag-snapshot 分支拉取最新精编快照并应用落盘
GET  /api/agent/sync-status        # 获取 GitHub 快照中转同步状态、ETag 与发布客户端标识
GET  /api/agent/status             # 获取采集引擎实时阶段、日志与信源统计
GET  /api/sources/matrix           # 获取全球 37 大权威信源矩阵列表
POST /api/sources/matrix           # 更新信源启用状态、条数限制或新增自定义信源
GET  /api/schedule/status          # 获取每日定时调度状态与下次执行时间
POST /api/schedule/config          # 动态更新每日自动同步时间点 (如 08:00,12:30,19:30) 与开关
GET  /api/config                   # 获取系统运行配置与同步遥测
POST /api/config                   # 保存系统设置并热重载调度器
GET  /api/image-proxy              # 外媒新闻配图防盗链与 SSRF 安全代理
GET  /api/latest-data              # 第三方一站式获取最新新闻与综述数据
GET  /api/status                   # 获取服务综合状态与内存/运行时间指标
GET  /api/health                   # 容器与负载均衡健康检查
```

---

## 快速启动与部署

### 1. 本地启动
```bash
npm install
cp .env.example .env
npm start
```

### 2. 运行端到端自动化测试套件 (19/19 测试用例)
```bash
npm test
```

### 3. OpenWrt / iStoreOS / Linux 软路由一键部署与热更新
```bash
# 方式 A：软路由远程一键更新与部署（完全兼容 Windows PowerShell / CMD / Linux 终端，请将 <YOUR_ROUTER_IP> 替换为软路由 IP）
ssh root@<YOUR_ROUTER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"

# 首次安装后，日常秒级热更新代码只需执行：
ssh root@<YOUR_ROUTER_IP> "sh /opt/corefeed/deploy-router.sh"

# 方式 B：使用 Docker Compose 启动
docker-compose up -d --build
```

访问 `http://localhost:3120`（或 `http://<YOUR_ROUTER_IP>:3120`）即可打开 **聚核 CoreFeed v2.0**。
