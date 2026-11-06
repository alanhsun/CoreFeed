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

### 1. ⚡ 两阶段渐进式采集与展示流水线 (`services/news_agent_service.js`)
- **阶段一：秒级采集、跨源聚类与首屏直出**
  - **并发信源采集 (`Scout`)**：并发巡检内置的 **29 个全球知名权威信源矩阵**（涵盖 Reuters、AP、BBC World、NYT、Bloomberg、WSJ、FT、The Guardian、DER SPIEGEL、Al Jazeera、南华早报 SCMP、CNA、NHK World、Nikkei Asia、韩联社 Yonhap、TechCrunch、Ars Technica 等），支持按信源类别定向采集。
  - **三级自适应防屏蔽降级 (`services/agent_tools.js`)**：官方 RSS 优先 → **Google News 站点定向代理 (`site:domain`)** 自动突破 Cloudflare/SPA 反爬 → **Jina Reader (`r.jina.ai`)** 列表抽取。
  - **跨信源事件聚类与即时展示 (`Curator`)**：自动合并同一事件来自多家媒体的同题报道（生成可点击跳转的 `relatedSources` 交叉印证列表），通过规则引擎秒级预判地区与版面分类，**无需等待漫长的 AI 编译即可立即推送前端首屏展示**（即使未配置 AI 密钥也可作为纯净的全球多源新闻聚合器使用）。
- **阶段二：后台全文穿透深读与分批增量中文编译**
  - **双引擎全文提取 (`Deep-Reader`)**：使用 `r.jina.ai` 与本地 Cheerio Readability 自动提取重点新闻正文。
  - **分批增量中文编译 (`Compiler`)**：以结构化 JSON 批处理生成中文标题、百字客观摘要、地域/领域标签与核心要点；每完成一批（8 条），立即通过 WebSocket 增量刷新页面卡片。
  - **今日要闻深度综述 (`Chief Editor`)**：统筹当日精选全球新闻生成带可点击 `[媒体名]` 原文引注的《全球要闻深度综述》。

### 2. 📖 单篇外媒即时全文深读 (`/api/agent/deep-read`)
- 点击任意新闻卡片底部的「全文深读」，即时穿透抓取外媒原文正文，并输出「核心导读 + 全文核心内容精译 + 背景与深层解读」及原文对照。

---

## 项目结构 📁

```text
CoreFeed/
├── server.js                      # Express + Socket.IO 主服务入口
├── config/
│   ├── index.js                   # 动态配置管理 (支持 .env 与 data/settings.json 热更新)
│   └── global_sources.js          # 全球知名信源矩阵定义与权威度权重
├── services/
│   ├── news_agent_service.js      # 两阶段渐进式采集、编译与单篇深读中枢
│   ├── agent_tools.js             # 采集与正文抽取工具集 (RSS / GoogleNews代理 / Jina / Cheerio)
│   ├── ai_service.js              # 事件聚类、规则预分类、结构化批量编译与综述生成
│   ├── news_service.js            # 基础新闻源接口与本地 JSON 持久化
│   └── state_manager.js           # 集中式状态管理与实时事件广播
├── routes/
│   └── api.js                     # RESTful API 路由
├── utils/
│   ├── schedule_manager.js        # Cron 多时间点自动采集调度器
│   ├── rate_limiter.js            # 令牌桶 API 速率限制器
│   ├── network_config.js          # 全局 HTTP Keep-Alive 连接池配置
│   ├── logger.js                  # 彩色结构化日志与指标统计
│   └── helpers.js                 # 通用工具与内存缓存
├── views/
│   └── index.ejs                  # Kami (紙) 风格响应式新闻阅读器视图
└── public/
    ├── css/style.css              # Kami 宣纸/墨夜双主题排版样式
    └── js/main.js                 # 前端控制器、多维筛选与 WebSocket 渐进式刷新
```

---

## 核心 API 接口 📡

```http
POST /api/agent/patrol             # 触发两阶段全球知名信源采集与渐进式编译
POST /api/agent/deep-read          # 对指定外媒 URL 执行 Jina/Cheerio 全文提取与中文深读
GET  /api/agent/status             # 获取采集引擎实时状态、阶段、日志与信源统计
GET  /api/sources/matrix           # 获取全球知名信源矩阵列表
POST /api/sources/matrix           # 更新信源启用状态、条数限制或新增自定义信源
GET  /api/news                     # 获取新闻列表（支持 region / category / source / q 过滤）
GET  /api/news/more?offset=30      # 分页加载更多已采集新闻
POST /api/refresh                  # 手动刷新新闻
GET  /api/summary                  # 获取今日《全球要闻深度综述》
POST /api/generate-summary         # 重新生成《全球要闻深度综述》
GET  /api/latest-data              # 第三方一站式获取最新新闻与综述数据
GET  /api/health                   # 健康检查
```

---

## 快速启动 🚀

```bash
# 1. 安装依赖
npm install

# 2. 启动服务 (默认端口 3120)
npm start

# 或开发模式启动
npm run dev
```

访问 `http://localhost:3120` 即可打开 **聚核 CoreFeed v2.0**。
