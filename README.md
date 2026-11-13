<div align="center">
  <img src="public/images/logo.png" alt="CoreFeed Logo" width="88" height="88" />
  <h1>CoreFeed · 聚核</h1>
  <p><strong>全球权威外媒深度聚合 · Antigravity 内置大模型全流程精编 · 自托管双语阅读器</strong></p>
</div>

---

## 简介

**CoreFeed（聚核）** 是一款采用「**本机 Antigravity 大模型采编 + GitHub 快照分支中转 + 软路由轻量阅读**」架构的全球要闻阅读系统：

- **纯网络原始搬运 (`ag:harvest`)**：并发拉取内置 **37 家国际权威媒体**（Reuters、AP、Bloomberg、FT、WSJ、NYT、BBC、The Economist、SCMP、CNA、NHK、TechCrunch、Ars Technica、Nature 等），支持官方 RSS、Google News 域名代理与 Jina Reader 多级降级抓取，提取原网页外文文本与高清配图 URL。
- **100% Antigravity 内置大模型执笔 (`/corefeed-editor`)**：**无需配置任何外部 `AI_API_KEY`，不使用任何免费机器翻译或规则拼接模板**。选稿裁剪、跨源同题合并、正文去噪提取、全文逐段中文精译、精编标题、百字导语、三条核心看点及当日《全球要闻深度综述》全部由本机 Antigravity 客户端内置大模型直接完成。
- **GitHub 孤儿分支零污染中转 (`ag:publish`)**：通过 Git Plumbing 底层命令将精编快照推送至独立孤儿分支 `ag-snapshot/latest.json`，不触碰 `main` 分支工作区与提交历史；内网软路由无需公网 IP 或任何密钥，即可定时（`08:00 / 12:30 / 19:30`）、每 60 分钟 ETag 轮询或网页端一键拉取同步。
- **Swiss Editorial 沉浸阅读界面**：Top-3 焦点轮播 + 12 栏 Bento 网格 SSR 首屏直出，内置外媒图片防盗链缓存代理（`/api/image-proxy`）与离线秒开的全文中英对照阅读器。

---

## 快速使用指南

### 1. 本机 Antigravity 客户端（采编与发布端）

在本机用 Antigravity 打开本项目仓库后，只需在对话框输入斜杠命令：

```text
/corefeed-editor
```

（或直接发送「更新并发布今日新闻」），Antigravity 客户端内置大模型即会自动执行：
1. `npm run ag:harvest` — 拉取 37 家权威外媒最新原始素材至 `data/ag_candidates.json`；
2. **内置大模型全流程精编** — 完成选稿裁剪、跨源事件合并、正文提纯、全文中文精译、标题/导语/要点精编与《全球要闻深度综述》，生成 `data/ag_compiled.json`；
3. `npm run ag:publish` — 严格校验全中文精编契约并推送快照至 GitHub `ag-snapshot/latest.json`。

### 2. 软路由 / Linux Docker 服务端（只读同步与阅读端）

支持通过 SSH 一键部署至 OpenWrt / iStoreOS / Debian / Ubuntu 等 Docker 环境（将 `<YOUR_SERVER_IP>` 替换为实际 IP）：

```bash
ssh root@<YOUR_SERVER_IP> "wget -qO /tmp/deploy-router.sh https://raw.githubusercontent.com/alanhsun/CoreFeed/main/deploy-router.sh && sh /tmp/deploy-router.sh --rebuild && rm -f /tmp/deploy-router.sh"
```

首次部署后，日常代码秒级热更新仅需执行：

```bash
ssh root@<YOUR_SERVER_IP> "sh /opt/corefeed/deploy-router.sh"
```

---

## 常用命令

| 命令 | 说明 |
| :--- | :--- |
| `/corefeed-editor` | 在 Antigravity 客户端内触发内置大模型全流程选稿、精译、综述撰写与快照发布 |
| `npm run ag:harvest` | 纯网络拉取 37 家全球外媒原始 RSS、网页文本与配图 URL（输出 `data/ag_candidates.json`） |
| `npm run ag:publish` | 校验 `data/ag_compiled.json` 大模型精编产物并发布至 GitHub `ag-snapshot` 分支 |
| `npm start` | 启动 CoreFeed Web 阅读服务端（默认端口 `3120`） |
| `npm test` | 运行全量端到端自动化测试套件 |

---

## 核心配置 (`.env`)

完整配置项参见 [`.env.example`](.env.example)，常用参数如下：

| 变量名 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3120` | Web 阅读服务监听端口 |
| `GITHUB_SYNC_ENABLED` | `true` | 服务端是否自动从 GitHub `ag-snapshot` 分支同步最新精编快照 |
| `GITHUB_SNAPSHOT_URL` | `https://raw.githubusercontent.com/alanhsun/CoreFeed/ag-snapshot/latest.json` | 远程精编快照 Raw 地址 |
| `UPDATE_TIMES` | `08:00,12:30,19:30` | 软路由服务端每日自动同步快照时间点（`Asia/Shanghai`） |
| `PUBLISH_SECRET` | 空 | 跨节点直推 `/api/agent/publish` 接口鉴权密钥（可选） |

---

## 目录结构

```text
CoreFeed/
├── .agents/skills/corefeed-editor/ # Antigravity 客户端内置大模型全流程采编 Skill (/corefeed-editor)
├── config/                         # 全局动态配置与 37 家国际权威信源矩阵
├── middleware/                     # 全局异常处理与生产环境速率限制
├── public/                         # 品牌图标、Swiss Editorial 样式表与前端交互控制器
├── routes/                         # RESTful API、快照同步与外媒图片防盗链代理
├── scripts/                        # 纯网络原始采集 (ag-harvest) 与严格快照发布 (ag-publish)
├── services/                       # 多源网络抓取工具集、基础时效过滤与内存状态管理
├── tests/                          # 采编发布流水线与软路由部署脚本端到端测试
├── utils/                          # GitHub Git Plumbing 快照同步、纯数据格式化与定时轮询器
├── views/                          # 响应式新闻阅读器 SSR 模板 (index.ejs)
├── deploy-router.sh                # 软路由 / Linux Docker 一键部署与秒级热更新脚本
└── server.js                       # Express + Socket.IO 主服务入口
```
