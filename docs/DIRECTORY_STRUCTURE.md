# 项目目录结构说明

本文档详细说明了 News Aggregator 项目的目录结构、文件组织方式及命名规范。

## 目录结构概览

```text
.
├── config/                 # 配置文件
├── data/                   # 数据存储（JSON文件）
├── docs/                   # 项目文档
├── logs/                   # 运行日志
├── middleware/             # Express中间件
├── public/                 # 静态资源（前端）
├── routes/                 # API路由定义
├── scripts/                # 运维脚本
├── services/               # 核心业务逻辑
│   └── scrapers/           # 新闻爬虫模块
├── utils/                  # 工具函数与类库
├── views/                  # EJS视图模板
└── server.js               # 应用入口文件
```

## 详细说明

### 1. 核心目录

- **config/**: 存放项目的所有配置逻辑。
  - `index.js`: 主配置文件，负责加载环境变量和 `data/settings.json`。
  - `sources.json`: 爬虫源配置模板。

- **services/**: 业务逻辑层，包含所有核心服务。
  - `news_service.js`: 新闻获取与处理服务。
  - `ai_service.js`: AI 摘要与翻译服务。
  - `audio_service.js`: 语音合成与播客生成服务。
  - `state_manager.js`: 全局状态管理服务。
  - `web_scraping_service.js`: 网页爬虫服务协调器。
  - `scrapers/`: 具体的新闻源爬虫实现（如 `ap_news_scraper.js`）。

- **utils/**: 通用工具库。
  - `helpers.js`: 通用辅助函数（文件读写、格式化等）。
  - `logger.js`: 日志记录器。
  - `rate_limiter.js`: 速率限制器。
  - `schedule_manager.js`: 定时任务管理。

- **routes/**: API 路由定义。
  - `api.js`: 定义所有 `/api/*` 接口。

- **middleware/**: Express 中间件。
  - `error_handler.js`: 全局错误处理。

### 2. 前端与资源

- **views/**: 服务端渲染模板。
  - `index.ejs`: 主页模板。

- **public/**: 静态资源文件。
  - `css/`: 样式表。
  - `js/`: 前端脚本。

### 3. 数据与日志

- **data/**: 运行时数据存储（需持久化）。
  - `news.json`: 缓存的新闻数据。
  - `settings.json`: 用户动态配置。
  - `state.json`: 应用运行状态。

- **logs/**: 应用运行日志。

## 命名规范

- **文件命名**: 统一使用 `snake_case`（小写字母加下划线），例如 `news_service.js`。
- **类名**: 使用 `PascalCase`（大驼峰），例如 `NewsService`。
- **变量/函数**: 使用 `camelCase`（小驼峰），例如 `fetchNews`。

## 开发规范

1. **模块引用**: 优先使用 `services/index.js` 和 `utils/index.js` 进行模块导入。
2. **配置读取**: 禁止直接读取 `process.env`，必须通过 `config` 模块获取配置。
3. **路径引用**: 使用 `path.join` 处理文件路径，确保跨平台兼容性。
