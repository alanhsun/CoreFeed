# 聚核 (CoreFeed) 新闻聚合器 📰🤖

一个基于Node.js的现代化智能新闻聚合网站，集成AI翻译、智能摘要、音频生成和分页加载功能。

![项目状态](https://img.shields.io/badge/状态-稳定版本-brightgreen)
![Node.js版本](https://img.shields.io/badge/Node.js-18%2B-brightgreen)
![许可证](https://img.shields.io/badge/许可证-MIT-blue)
![版本](https://img.shields.io/badge/版本-v1.3.0-blue)

## 功能特点 ✨

### 核心功能
- 🌍 **多源新闻聚合**: 从NewsAPI、Gnews、RSS等多个源获取新闻
- 🔗 **第三方API集成**: 提供聚合数据接口，支持跨域调用
- 🤖 **AI智能翻译**: 使用OpenRouter大模型自动翻译新闻内容
- 📝 **智能总结**: 使用OpenRouter大模型生成简洁的中文摘要
- 🧠 **AI智能去重**: 使用AI技术识别和去除重复新闻
- 🌐 **地区识别**: 智能识别新闻所属地区（支持AI分析与规则匹配）
- ⏰ **灵活定时更新**: 支持多时间点自动更新新闻
- 📄 **分页加载**: 智能分页显示，支持"加载更多"功能
- 🎧 **AI音频生成**: 使用自建 OpenAI-Edge-TTS 服务将新闻转换为音频
- 📚 **EPUB电子书**: 自动生成新闻摘要的电子书
- 📧 **邮件发送**: 支持将新闻摘要通过邮件发送到Kindle

### 用户体验
- 📱 **响应式设计**: 完美适配桌面、平板和移动设备
- 🎨 **现代化UI**: 玻璃拟态效果和渐变背景设计
- ⚡ **实时进度**: WebSocket实时显示处理进度
- 🌙 **深色模式**: 支持明暗主题切换
- 🎧 **音频播放器**: 内置完整的音频播放控制
- 🔄 **智能加载**: 按需加载更多新闻，优化页面性能
- ⚙️ **可视化配置**: 内置设置面板，支持实时配置管理

## 技术栈 🛠️

### 后端技术
- **运行环境**: Node.js 18+
- **Web框架**: Express.js 4.18+
- **实时通信**: Socket.IO 4.8+
- **定时任务**: node-cron 3.0+
- **进程管理**: PM2 5.3+
- **容器化**: Docker + Docker Compose

### 前端技术
- **模板引擎**: EJS 3.1+
- **CSS框架**: Tailwind CSS 3.0+ + 自定义CSS
- **图标库**: Font Awesome 6.0+
- **JavaScript**: 原生ES6+

### 外部API服务
- **新闻数据**: [NewsAPI](https://newsapi.org/) + [Gnews](https://gnews.io/) + RSS源
- **AI服务**: [OpenRouter](https://openrouter.ai/) (用于翻译、摘要、去重等)
- **语音合成**: 自建 [OpenAI-Edge-TTS](https://github.com/travisvn/openai-edge-tts) 服务（可配置端点）

## 快速开始 🚀

### 系统要求
- Node.js 18.0 或更高版本
- npm 8.0 或更高版本
- 稳定的网络连接

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制环境变量模板并填入你的API密钥：

```bash
cp .env.example .env
```

编辑 `.env` 文件：

```env
# 服务器配置
PORT=3120

# NewsAPI配置
NEWS_API_KEY=你的NewsAPI密钥
NEWS_API_ENABLED=true
# 每次从News API获取的文章数量
NEWS_API_MAX_ARTICLES=20

# Gnews API配置
GNEWS_API_KEY=你的Gnews密钥
GNEWS_ENABLED=false
GNEWS_MAX_ARTICLES=10

# OpenAI/OpenRouter 兼容AI配置
AI_BASE_URL=https://openrouter.ai/api/v1
AI_API_KEY=your_openrouter_api_key_here
AI_MODEL=openai/gpt-4o-mini
OPENROUTER_SITE_URL=http://localhost:3120
OPENROUTER_APP_NAME=News Aggregator

# TTS（OpenAI-Edge-TTS）配置
# 自建TTS服务地址
TTS_BASE_URL=http://10.10.10.80:5050/v1/audio/speech
# 模型（默认）
TTS_MODEL=tts-1
# 输出格式
TTS_FORMAT=mp3
# 主持人音色
TTS_HOST_VOICE=zh-CN-XiaoxiaoNeural
# 嘉宾音色
TTS_GUEST_VOICE=zh-CN-YunyangNeural
# 如服务需要鉴权，这里设置Bearer Token（可留空）
TTS_API_KEY=

# RSS新闻源（支持两种格式）
# 格式1：简单URL格式（逗号分隔）
# RSS_SOURCES=https://timesofindia.indiatimes.com/rssfeeds/296589292.cms,https://feeds.bbci.co.uk/news/world/rss.xml
# 格式2：自定义名称格式（名称|URL，逗号分隔）
RSS_SOURCES=印度时报|https://timesofindia.indiatimes.com/rssfeeds/296589292.cms,BBC世界新闻|https://feeds.bbci.co.uk/news/world/rss.xml

# 默认每个新闻源获取的文章数量
MAX_ARTICLES_PER_SOURCE=5

# 为每个新闻源单独设置获取数量（可选）
# 格式：源名称:数量,源名称:数量
# 对于NewsAPI源，使用源ID（如bbc-news,cnn等）
# 对于RSS源，使用自定义名称（如印度时报,BBC世界新闻等）
# 示例：
# SOURCE_ARTICLE_COUNTS=bbc-news:10,cnn:8,印度时报:12,BBC世界新闻:15
SOURCE_ARTICLE_COUNTS=

# SMTP邮件配置
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@gmail.com
SMTP_PASS=your_app_password_here
SMTP_FROM_NAME=聚核 (CoreFeed)
SMTP_FROM_EMAIL=your_email@gmail.com

# 默认收件人邮箱（用于摘要报告）
DEFAULT_RECIPIENT_EMAIL=recipient@example.com

# 新闻更新定时配置
# 是否启用自动更新
AUTO_UPDATE_ENABLED=true
# 更新频率（daily, weekly等）
UPDATE_FREQUENCY=daily
# 新闻更新间隔（cron格式）
NEWS_UPDATE_INTERVAL=0 */2 * * *
# 更新时间列表（逗号分隔，如：08:00,20:00）
UPDATE_TIMES=08:00
# 禁用的新闻源（逗号分隔）
DISABLED_SOURCES=

# 网络配置
# 网络请求超时时间（毫秒）
NETWORK_TIMEOUT=30000
# 网络请求重试次数
NETWORK_RETRIES=5
# 重试间隔时间（毫秒）
NETWORK_RETRY_DELAY=2000
# 保持连接活跃
NETWORK_KEEP_ALIVE=true
# 最大并发连接数
NETWORK_MAX_SOCKETS=50

# Socket.IO配置
# Socket.IO ping超时时间（毫秒）
SOCKETIO_PING_TIMEOUT=60000
# Socket.IO ping间隔时间（毫秒）
SOCKETIO_PING_INTERVAL=25000
# Socket.IO连接超时时间（毫秒）
SOCKETIO_CONNECT_TIMEOUT=45000
# Socket.IO最大缓冲区大小（字节）
SOCKETIO_MAX_BUFFER_SIZE=1000000
```

### 3. 获取API密钥 🔑

#### NewsAPI（必需）
1. 访问 [NewsAPI官网](https://newsapi.org/)
2. 注册免费账户获取API密钥
3. 免费版每天1000次请求
4. 配置 `NEWS_API_KEY` 和 `NEWS_API_MAX_ARTICLES`

#### Gnews（可选）
1. 访问 [Gnews官网](https://gnews.io/)
2. 注册免费账户获取API密钥
3. 免费版每天100次请求
4. 设置 `GNEWS_ENABLED=true` 启用

#### OpenRouter AI (必需)
1. 访问 [OpenRouter官网](https://openrouter.ai/)
2. 使用Google或邮箱账户登录
3. 在[Keys页面](https://openrouter.ai/keys)创建一个新的Key
4. 将获取的Key配置到 `.env` 文件的 `OPENROUTER_API_KEY`
5. 将你的应用URL（如 `http://localhost:3120`）配置到 `OPENROUTER_SITE_URL`



#### RSS新闻源配置
- 支持两种格式：
  - 简单URL格式：`https://example.com/rss.xml,https://example2.com/feed.xml`
  - 自定义名称格式：`新闻源1|https://example.com/rss.xml,新闻源2|https://example2.com/feed.xml`
- 可通过 `SOURCE_ARTICLE_COUNTS` 为每个源单独设置获取数量

#### 网页抓取配置（用于没有RSS源的网站）
- `WEB_SCRAPING_ENABLED`: 是否启用网页抓取功能（默认false）
- `WEB_SCRAPING_SOURCES`: 网页抓取源配置
  - 简单URL格式：`https://apnews.com/world-news,https://www.bbc.com/news`
  - 自定义名称格式：`AP News|https://apnews.com/world-news,BBC News|https://www.bbc.com/news`
- `WEB_SCRAPING_MAX_ARTICLES`: 每个源的最大文章数量（默认10）
- `WEB_SCRAPING_TIMEOUT`: 请求超时时间（默认30秒）
- `WEB_SCRAPING_DELAY`: 请求间隔时间（默认1秒，避免被反爬虫）
- `WEB_SCRAPING_USER_AGENT`: 浏览器用户代理字符串
- 支持的网站：AP News、BBC、NHK World、Channel News Asia 等主流新闻网站
- 自动提取文章标题、内容、发布时间和图片

#### 网络和性能配置
- `NETWORK_TIMEOUT`: 网络请求超时时间（默认30秒）
- `NETWORK_RETRIES`: 失败重试次数（默认5次）
- `NETWORK_MAX_SOCKETS`: 最大并发连接数（默认50）
- Socket.IO相关配置用于实时通信优化

### 4. 运行项目

```bash
# 开发模式
npm run dev

# 生产模式
npm start

# 使用Docker（推荐生产环境）
npm run compose:up
```

访问 `http://localhost:3120` 查看应用。

## 项目结构 📁

```
news-aggregator/
├── server.js              # 主服务器文件
├── package.json           # 项目配置和依赖
├── .env.example          # 环境变量模板
├── .gitignore            # Git忽略文件
├── README.md             # 项目说明

├── docker-compose.yml    # Docker Compose配置
├── Dockerfile            # Docker镜像配置
├── config/               # 配置文件
│   └── index.js          # 应用配置管理
├── data/                 # 数据存储目录
│   ├── epub/             # EPUB文件目录
│   ├── podcast/          # 音频文件目录
│   ├── news.json         # 新闻数据缓存
│   └── summary.json      # 摘要数据缓存
├── routes/               # API路由
│   └── api.js            # RESTful API定义
├── services/             # 业务服务
│   ├── newsService.js    # 新闻获取服务
│   ├── aiService.js      # AI翻译和摘要服务
│   └── audioService.js   # 音频生成服务
├── utils/                # 工具函数
│   ├── helpers.js        # 通用辅助函数
│   ├── logger.js         # 日志工具
│   ├── healthCheck.js    # 健康检查
│   ├── networkConfig.js  # 网络配置
│   ├── scheduleManager.js # 定时任务管理
│   └── performanceOptimizer.js # 性能优化
├── views/                # EJS模板
│   └── index.ejs         # 主页模板
├── public/               # 静态资源
│   ├── css/
│   │   └── style.css     # 自定义样式
│   └── js/
│       ├── main.js       # 前端JavaScript
│       └── settings-manager.js # 设置管理
├── logs/                 # 日志目录
└── backups/              # 备份目录
```

## API接口 📡

### 新闻相关
```http
GET /api/news              # 获取新闻数据（前30条）
GET /api/news/more         # 获取更多新闻数据
POST /api/refresh          # 手动刷新新闻
```

### AI功能
```http
POST /api/generate-summary # 生成AI摘要文章
POST /api/generate-podcast # 生成音频对话
```

### 文件生成
```http
POST /api/generate-epub    # 生成EPUB电子书
POST /api/send-email       # 发送邮件到Kindle
```

### 配置管理
```http
GET /api/config            # 获取当前配置
POST /api/config           # 更新配置
GET /api/schedule/config   # 获取定时任务配置
POST /api/schedule/config  # 更新定时任务配置
```

### 系统监控
```http
GET /api/health            # 基础健康检查
GET /api/health/detailed   # 详细健康检查
```

### 聚合数据接口 (第三方集成)
```http
GET /api/latest-data       # 获取完整的新闻、摘要和音频信息
```

## 语音合成（TTS）

本项目已切换为使用自建 OpenAI-Edge-TTS 服务进行语音合成，替代原 Google TTS。你可以在 .env 中配置服务端点与默认音色。

- 服务端点：通过 TTS_BASE_URL 配置，例如：
  - http://10.10.10.80:5050/v1/audio/speech
- 默认音色：
  - 主持人（A/张明）：TTS_HOST_VOICE（默认 zh-CN-XiaoxiaoNeural）
  - 嘉宾（B/李华）：TTS_GUEST_VOICE（默认 zh-CN-YunyangNeural）
- 可选鉴权：
  - 如你的自建服务启用了鉴权，可设置 TTS_API_KEY，它将以 Authorization: Bearer xxx 发送

运行机制
- 服务位置：services/audioService.js
- 实现方式：使用 axios 调用 TTS_BASE_URL，传参包含 model、voice、input、response_format，返回音频二进制并保存为 .mp3
- 片段合并：优先使用 ffmpeg（可通过 USE_FFMPEG/FFMPEG_PATH 配置），失败则回退到简单拼接

快速验证
1) 配置 .env 中的 TTS_* 变量
2) 启动服务后调用：
   - POST /api/generate-podcast（或执行新闻刷新流程触发自动生成）
   - 可选：POST /api/generate-podcast?demo=1（仅测TTS，绕过AI脚本生成）
3) 在 data/podcast 下查看生成的 segment_*.mp3 及 podcast_complete.mp3
4) GET /api/status 中的 ttsConfigured 应为 true

常见问题
- 404/连接失败：检查 TTS_BASE_URL 是否可达，端口与路径是否正确
- 鉴权失败：服务若启用鉴权，请设置 TTS_API_KEY
- 声音不符合预期：调整 TTS_HOST_VOICE / TTS_GUEST_VOICE
- 合并失败：检查是否安装 ffmpeg，或设置 USE_FFMPEG=false 使用回退合并

## 部署 🚀

### Docker部署

```bash
# 构建镜像
npm run docker:build

# 运行容器
npm run docker:run

# 使用Docker Compose
npm run compose:up
```

### Docker部署（推荐生产环境）

```bash
# 使用Docker Compose启动服务
npm run compose:up

# 停止服务
npm run compose:down

# 查看日志
npm run compose:logs
```

## 常用命令 📋

### 开发和调试
```bash
# 开发模式（自动重启）
npm run dev

# 生产模式
npm run prod

# 健康检查
npm run health
```

### PM2进程管理
```bash
# 启动服务
npm run pm2:start

# 重启服务
npm run pm2:restart

# 停止服务
npm run pm2:stop

# 查看日志
npm run pm2:logs

# 监控面板
npm run pm2:monit
```

### Docker容器管理
```bash
# 构建镜像
npm run docker:build

# 运行容器
npm run docker:run

# 停止容器
npm run docker:stop

# 查看日志
npm run docker:logs
```

### Docker部署
```bash
# 构建镜像
npm run docker:build

# 运行容器
npm run docker:run

# 停止容器
npm run docker:stop

# 查看日志
npm run docker:logs
```

### Docker Compose
```bash
# 启动服务
npm run compose:up

# 停止服务
npm run compose:down

# 查看日志
npm run compose:logs
```

### 维护工具
```bash
# 创建备份
npm run backup

# 清理重装
npm run clean

# 自动更新
npm run update

# 强制更新
npm run update:force
```

## 功能特色 🌟

### 智能新闻处理
- **多源聚合**: 支持NewsAPI、Gnews、RSS等多种新闻源
- **AI去重**: 使用大模型智能识别和去除重复新闻
- **智能翻译**: 自动翻译外文新闻为中文
- **地区识别**: 自动识别新闻所属地区和分类

### 高级功能
- **分页加载**: 首页显示30条新闻，支持"加载更多"功能
- **实时配置**: 可视化配置界面，支持实时修改设置
- **定时任务**: 支持多时间点自动更新新闻
- **音频生成**: AI生成新闻对话音频
- **电子书**: 自动生成EPUB格式的新闻摘要

### 性能优化
- **缓存机制**: 本地缓存新闻数据，提高访问速度
- **异步处理**: 后台异步处理AI任务，不阻塞用户操作
- **错误恢复**: 完善的错误处理和重试机制
- **健康监控**: 内置健康检查和性能监控

## 许可证 📄

MIT License - 详见 [LICENSE](LICENSE) 文件

## 作者 👨‍💻

Alan Sun

## 贡献 🤝

欢迎提交Issue和Pull Request！

## 更新日志 📝

### v1.3.0 (Current)
- 🚀 **第三方API集成**: 新增 `/api/latest-data` 聚合接口，支持一站式获取所有数据
- 🌐 **CORS支持**: 启用跨域资源共享，允许外部程序直接调用API
- 💾 **持久化配置**: 在Docker环境中引入 `data/settings.json`，解决重启后配置丢失问题
- 🗺️ **地区识别增强**: 结合AI分析与规则匹配，显著提高新闻地区分类准确性

### v1.2.0 (2025-01-25)
- ✨ 新增"加载更多新闻"功能
- 🧠 集成AI智能去重功能
- ⚙️ 添加可视化配置管理界面
- 📄 优化新闻分页显示逻辑
- 🔧 完善定时任务配置
- 🐛 修复多项已知问题

### v1.1.0
- 🌍 添加Gnews API支持
- 📡 增强RSS源处理
- 🎧 改进音频生成功能
- 📚 优化EPUB生成

### v1.0.0
- 🎉 首次发布
- 🌍 基础新闻聚合功能
- 🤖 AI翻译和摘要
- 🎧 音频生成功能

---

**注意**: 请确保在使用前正确配置所有API密钥，并遵守各API服务的使用条款。