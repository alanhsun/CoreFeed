---
name: corefeed-editor
description: 使用 Antigravity 客户端内置大模型全流程执行全球外媒选稿裁剪、跨源同题合并、正文提纯、全文中文精译、标题导语要点精编与《全球要闻深度综述》创作，并发布至 GitHub ag-snapshot 分支。当用户要求更新、采集、编译或发布 CoreFeed 新闻时触发（或输入 /corefeed-editor）。
---

# CoreFeed 全球要闻全流程大模型总编工作流 (`/corefeed-editor`)

本技能将 CoreFeed 的**选稿裁剪、同题合并、正文提取、全文中文精译、精编标题、导语撰写、要点提炼与《全球要闻深度综述》创作** 100% 交由当前 Antigravity 客户端内置大模型直接执笔，不依赖任何外部 `AI_API_KEY`、不使用任何机器翻译接口或硬编码规则模板。

---

## 执行步骤（严格按序执行）

### Step 1：纯网络拉取全球 37 家权威外媒原始素材 (`ag:harvest`)

在项目根目录执行原始网络搬运命令：

```bash
node scripts/ag-harvest.js --check-cooldown
```

- 若输出 `"cooldownSkipped": true` 且用户未明确要求强制刷新，告知用户远端快照刚在 30 分钟内更新过；若用户要求强制更新，改用 `node scripts/ag-harvest.js --force`。
- 采集完成后，`data/ag_candidates.json` 包含：
  - `briefIndex`：全部原始条目的轻量索引（`index`、`id`、`sourceName`、`sourceAuthority`、`publishedAt`、`title`、`rssExcerpt`、`hasImage`、`rawTextChars`、`url`）。
  - `fullCandidates`：包含原始网页抓取文本 `fullText` 与题图 `urlToImage` 的完整候选数组。

---

### Step 2：大模型全景审阅、选稿裁剪与跨源同题合并

1. 读取 `data/ag_candidates.json` 顶部的 `briefIndex`（全景浏览所有外媒原始报道）。
2. **完全由你（内置大模型）以资深国际新闻总编标准进行选稿裁剪**：
   - 从原始池中甄选出 **20 ~ 30 个最具全球政经、外交、科技、财经、能源或社会影响力**的独立新闻事件，按重要性从高到低排序（前 3 条将进入网站首页焦点轮播 Hero Carousel，优先挑选重大且 `hasImage: true` 的事件）。
   - **剔除噪音**：过滤广告软文、订阅引导页、纯观点水文、赛事娱乐花边及无实质内容的残缺条目。
   - **跨源同题合并**：识别多家外媒报道同一事件的情况（例如 Reuters、BBC、FT 均报道同一央行决议），选定正文最详实、信源最权威的一篇作为主条目（`candidateIndex`），将其余同题报道的 1-based 序号填入该条目的 `mergedIndices` 数组（发布器会自动将其合并为前端卡片的「多源交叉核实」链接）。

---

### Step 3：大模型正文提纯、全文逐段精译与结构化精编

按选定的 `candidateIndex` 分批读取原始外文正文（每批建议 6 ~ 8 篇，确保逐篇精读不遗漏；若当前环境支持 `invoke_subagent` 的 `self` 子智能体，也可将 20~30 篇拆分为 3~4 组并行交由子智能体完成单篇正文提纯与全文精译，再由主智能体统稿）：

```bash
node scripts/ag-harvest.js --inspect 1,4,7,11,15,19
```

对每一篇入选报道，**完全由大模型直接完成以下全部提取与编译工作**（严禁编写脚本调第三方免费翻译接口或用截断规则凑数）：

1. **正文提取与去噪 (`originalParagraphs`)**：
   - 从 `rawText` 中识别并剔除残余的网页导航菜单、Cookie 弹窗文案、"Read more / Related articles" 推荐链接、版权声明与记者推广签名，保留干净的原始外文自然段数组 `originalParagraphs`。
2. **全文中文精译 (`translatedParagraphs`)**：
   - 将提纯后的外文正文**逐段完整精译为准确、流畅、地道的专业中文新闻译文**（保留关键数据、引语、机构与人名标准译名，严禁把多段长文压缩成一两句梗概）。
   - 每个元素对应一个自然段，供网站离线全文阅读器直接展示中英对照。
3. **精编中文标题 (`translatedTitle`)**：
   - 撰写专业、克制、信息量饱满的中文新闻标题，字数控制在 **`14 ~ 32` 字**以内，去除媒体尾缀与标题党感叹号。
4. **客观中文导语 (`summary`)**：
   - 撰写一段 **`80 ~ 130` 字**的客观新闻导语，清晰交代核心主体、关键进展、背景数据与直接影响。
5. **核心看点提炼 (`keyPoints`)**：
   - 提炼严格 **`3` 条**互不重复的核心事实要点（每条 `15 ~ 36` 字，不直接照抄标题）。
6. **地域与领域精准归类 (`region` / `category`)**：
   - `region` 严格取自：`["中国", "美国", "欧洲", "日本", "韩国", "东南亚", "中东", "非洲", "拉美", "澳洲", "亚洲", "国际"]`
   - `category` 严格取自：`["政经", "外交", "科技", "财经", "军事", "社会", "能源", "国际"]`

---

### Step 4：大模型撰写当日《全球要闻深度综述》

统筹你最终选定并排序的 `1..N` 条要闻，撰写一篇 **800 ~ 1,500 字**的结构化深度综述（`summaryArticle`）：
- `title`：例如 `"2026年11月13日 全球要闻深度综述：欧美货币政策分化与AI算力格局重塑"`（结合当日核心主线拟定副标题）。
- `content`：使用 Markdown `### 板块小标题` 划分为 **3 ~ 5 个专题板块**（如全球宏观与金融市场、地缘政治与大国博弈、前沿科技与产业变革、能源转型与区域动态），深入剖析事件之间的内在关联与趋势，并在行文中自然嵌入 **`[NEWS_1]`、`[NEWS_2]` ... `[NEWS_N]`** 引用角标（注意：`k` 必须严格对应 `articles` 数组中的 1-based 最终位置序号，发布器会将其渲染为可点击跳转的互动角标）。

---

### Step 5：写入 `data/ag_compiled.json` 并发布快照 (`ag:publish`)

1. 将编译结果按如下严格 JSON 结构写入 `data/ag_compiled.json`：

```json
{
  "publishedBy": "antigravity-client",
  "articles": [
    {
      "candidateIndex": 4,
      "mergedIndices": [12, 29],
      "region": "美国",
      "category": "财经",
      "translatedTitle": "美联储宣布维持基准利率不变并释放年内审慎降息信号",
      "summary": "美联储联邦公开市场委员会结束为期两天的货币政策会议，一致决定维持联邦基金利率目标区间不变。鲍威尔在新闻发布会上指出，核心通胀回落步伐稳健但仍具黏性，未来政策路径将取决于就业与物价数据表现。",
      "keyPoints": [
        "联邦公开市场委员会全票通过维持现行基准利率区间不变",
        "鲍威尔强调政策调整取决于后续核心通胀与劳动力市场数据",
        "美债收益率与美元指数在决议公布后呈现窄幅震荡走势"
      ],
      "originalParagraphs": [
        "Clean English paragraph 1...",
        "Clean English paragraph 2..."
      ],
      "translatedParagraphs": [
        "第一段完整流畅的中文精译正文……",
        "第二段完整流畅的中文精译正文……"
      ]
    }
  ],
  "summaryArticle": {
    "title": "2026年X月X日 全球要闻深度综述：……",
    "content": "### 全球宏观与央行政策\n\n综述正文内容，通过角标关联具体报道 [NEWS_1]……"
  }
}
```

2. 执行校验与快照发布命令：

```bash
npm run ag:publish
```

- `scripts/ag-publish.js` 会严格校验每篇报道的中文标题、导语、要点、全文译文段落以及深度综述完整性（任何未翻译字段均会报错拦截），更新本地 `data/{news,summary,state}.json`，并通过 Git Plumbing 将单提交快照推送至远端 `ag-snapshot/latest.json`，供软路由自动或一键同步展示。
