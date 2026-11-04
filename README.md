<div align="center">
  <img src="public/images/logo.png" alt="CoreFeed Logo" width="130" style="border-radius: 20px;" />
  <h1>聚核 (CoreFeed v2.0) · 全球知名信源 Agent 情报中心 📰🤖</h1>
  <p>基于多 Agent 协作架构（Scout + Curator + Deep-Reader + Chief Editor）构建的全球权威新闻搜集、全文深读、交叉验证与多端分发平台。</p>
</div>

![版本](https://img.shields.io/badge/版本-v2.0.0-blue)
![架构](https://img.shields.io/badge/Engine-Multi--Agent-indigo)
![Node.js](https://img.shields.io/badge/Node.js-18%2B-brightgreen)
![许可证](https://img.shields.io/badge/许可证-MIT-blue)

## 核心升级亮点 (v2.0) ✨

### 1. 🕵️‍♂️ 四阶段多 Agent 协同引擎 (`services/news_agent_service.js`)
- **Scout Agent (全球信源巡检员)**: 并发巡检内置的 **26+ 全球知名权威信源矩阵**（涵盖路透社 Reuters、美联社 AP、BBC World、纽约时报 NYT、彭博社 Bloomberg、华尔街日报 WSJ、金融时报 FT、英国卫报 Guardian、德国明镜周刊、半岛电视台 Al Jazeera、南华早报 SCMP、新加坡亚洲新闻台 CNA、NHK World、日经亚洲 Nikkei、韩联社 Yonhap、TechCrunch 等）。
  - **三级自适应防屏蔽降级**: 官方 RSS 优先 → **Google News 站点定向代理 (`site:domain`)** 自动突破 Cloudflare/SPA 反爬 → **Jina Reader (`r.jina.ai`)** 网页解析。
- **Curator Agent (聚类甄选总编)**: 对多源采集的新闻执行跨媒体事件聚类，将同一事件来自不同名媒的报道合并为 **多信源交叉印证卡片 (`relatedSources`)**，并根据媒体权威度、时效性与交叉热度精选 Top 30。
- **Deep-Reader & Compiler Agent (全文深读与编译员)**: 调用 `r.jina.ai` 与本地 Cheerio Readability 正文抽取器对重点报道进行全文穿透深读，再通过单次结构化 JSON 批处理完成中文标题编译、百字客观摘要、地域与领域分类、核心要点提取（相比旧版逐条请求节省 85% API 调用）。
- **Chief Editor & Investigator Agent (主编与专题调查员)**:
  - 自动统筹当日全球新闻撰写《全球要闻深度综述》（带可点击的信源原文引用链接）。
  - **按需专题调查 (`/api/agent/research`)**: 输入任意国际热点或行业主题，Agent 自动规划中英文检索词、跨源检索全球名媒、深读原文并生成《多信源观点对比报告》。
  - **单篇外媒即时精读 (`/api/agent/deep-read`)**: 在前端点击任意卡片的「Agent 全文深读」，即时抓取外媒全文并输出结构化中文精译与背景解读。

### 2. 📡 完整保留并强化下游分发链路
- **第三方聚合接口 (`GET /api/latest-data`)**: 一站式返回精选新闻（含跨信源印证列表）、深度综述 HTML 与播客音频信息。
- **AI 双主播播客工作台 (`services/audio_service.js` + `services/ftp_service.js`)**: 自动编写 `[A]` / `[B]` 双人对话脚本，调用 OpenAI-Edge-TTS 合成并合并 MP3，自动上传至 FTP 服务器。
- **EPUB 电子书与 Kindle 邮件推送 (`services/epub_email_service.js`)**: 自动将今日综述与情报卡片打包为自适应排版的 EPUB 电子书并推送至 Kindle。

---

## 项目结构 📁

```text
news_aggregator/
├── server.js                      # Express + Socket.IO 主服务入口
├── config/
│   ├── index.js                   # 动态配置管理 (支持 .env 与 data/settings.json 热更新)
│   └── global_sources.js          # 全球知名信源矩阵定义与权威度权重
├── services/
│   ├── news_agent_service.js      # 多 Agent 协同中枢 (巡检 / 专题调查 / 单篇深读)
│   ├── agent_tools.js             # Agent 工具集 (RSS / GoogleNews代理 / Jina全文提取 / 全网检索)
│   ├── ai_service.js              # LLM 推理、结构化批量编译、事件聚类与 Tool-Use 循环
│   ├── news_service.js            # 基础新闻源兼容层与本地持久化
│   ├── audio_service.js           # OpenAI-Edge-TTS 语音合成与 FFmpeg 合并
│   ├── ftp_service.js             # 播客音频 FTP 自动上传服务
│   ├── epub_email_service.js      # EPUB 电子书生成与 Kindle/SMTP 邮件发送
│   └── state_manager.js           # 集中式状态管理与事件广播
├── routes/
│   └── api.js                     # RESTful API 路由 (含 Agent 接口与兼容接口)
├── utils/
│   ├── schedule_manager.js        # Cron 多时间点自动巡检调度器
│   ├── rate_limiter.js            # 令牌桶 API 速率限制器
│   ├── logger.js                  # 彩色结构化日志与指标统计
│   └── helpers.js                 # 通用工具与内存缓存
├── views/
│   └── index.ejs                  # 聚核 v2.0 响应式控制台视图
└── public/
    ├── css/style.css              # Glassmorphism 与深浅色主题样式
    └── js/main.js                 # 前端交互、实时遥测与弹窗管理
```

---

## 核心 API 接口 📡

### Agent 专属接口
```http
POST /api/agent/patrol             # 触发多 Agent 全球知名信源巡检与编译整合
POST /api/agent/research           # 派遣 Agent 按主题搜集全球外媒并生成对比报告
GET  /api/agent/research/latest    # 获取最近一次专题调查报告
POST /api/agent/deep-read          # 对指定外媒 URL 执行 Jina 全文深读与中文解读
GET  /api/agent/status             # 获取 Agent 实时状态、日志与信源统计
GET  /api/sources/matrix           # 获取全球知名信源矩阵列表
POST /api/sources/matrix           # 更新信源启用状态、条数限制或新增自定义信源
```

### 标准与第三方集成接口
```http
GET  /api/latest-data              # 第三方一站式获取最新新闻、综述与播客数据
GET  /api/news                     # 获取当前新闻列表（支持 region / category / q 过滤）
GET  /api/news/more?offset=30      # 分页加载更多已编译新闻
POST /api/refresh                  # 手动刷新（调用多 Agent 巡检流水线）
POST /api/generate-summary         # 重新生成《全球要闻深度综述》
POST /api/generate-podcast         # 生成 AI 双主播播客并上传 FTP
POST /api/generate-epub            # 生成 EPUB 电子书
POST /api/send-email               # 发送 EPUB 简报至 Kindle 邮箱
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

访问 `http://localhost:3120` 即可打开 **聚核 CoreFeed v2.0 · 全球知名信源 Agent 情报中心**。
