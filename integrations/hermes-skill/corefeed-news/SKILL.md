---
name: corefeed-news
description: 直接读取 CoreFeed（聚核）已精编完成的全球权威外媒中文要闻、分类快讯、单篇全文译文与《全球要闻深度综述》，并支持通过 open-xiaoai-bridge 控制小爱音箱分段语音播报。当用户询问今日新闻、国际要闻、科技/财经/地缘动态、查看某条新闻详情，或要求“用小爱播报新闻”、“朗读今日要闻”、“停止播报”时触发。
---

# CoreFeed 全球要闻直读与小爱音箱语音播报技能 (`corefeed-news`)

本技能直接读取 **CoreFeed（聚核）** 已经由大模型选稿、跨源核实并精译好的结构化中文数据（**不重新抓取原始外网网页，毫秒级响应**）：
- **数据源优先级**：优先直连局域网 CoreFeed 服务（`COREFEED_BASE_URL`，如 `http://192.168.x.x:3120`），若内网服务未启动或不可达，自动无缝回退读取 GitHub `ag-snapshot` 分支上的精简快照。
- **小爱音箱桥接**：对接 `open-xiaoai-bridge` HTTP API（`OPENXIAOAI_BASE_URL`，默认 `:9092`），自动去除 Markdown 与 `[NEWS_k]` 角标、提取中文媒体简称、按自然句切分为 ≤240 字短段，并采用阻塞模式顺序播报（优先豆包 TTS，未配置时自动回退小爱原生 TTS）。

---

## 环境配置（`~/.hermes/.env`）

建议在 `~/.hermes/.env` 中配置以下两项（未配置时也会自动探测本机默认端口及已安装的 `xiaoai-tts` 配置）：

```bash
# CoreFeed 软路由 / 服务端内网地址（不可达时自动回退 GitHub ag-snapshot 快照）
COREFEED_BASE_URL="http://192.168.1.2:3120"

# open-xiaoai-bridge HTTP API 地址
OPENXIAOAI_BASE_URL="http://192.168.1.5:9092"

# 可选：指定豆包音色 ID（如 zh_female_vv_uranus_bigtts 或复刻音色 S_xxx）与默认引擎 (auto / doubao / xiaoai)
# COREFEED_TTS_ENGINE="auto"
# COREFEED_TTS_SPEAKER="zh_female_vv_uranus_bigtts"
```

---

## 交互路由准则（严格区分文字回复与音箱朗读）

收到用户的新闻相关指令时，请严格按以下 4 种场景选择命令：

### 场景 1：普通文字查新闻（未要求朗读，且非音箱语音提问）
> 典型指令：「今天有什么新闻？」「查一下今天的科技/财经要闻」「中东最近有什么动态？」「详细看看第 3 条新闻」

- **操作**：只调用 `query` 子命令读取精编结果，整理后**仅以文字形式回复用户，严禁触发小爱音箱发声**。
- **常用命令**：
  ```bash
  # 综合读取今日《全球要闻深度综述》+ 前 8 条精选要闻
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --limit 8

  # 按领域或地区筛选（领域：政经/外交/科技/财经/军事/社会/能源/国际；地区：中国/美国/欧洲/日本/韩国/东南亚/中东/国际等）
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --category 科技 --limit 6
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --region 美国 --category 财经

  # 按关键词检索（匹配中英标题、导语、三大看点及全文译文）
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --keyword 芯片

  # 仅读取《今日全球要闻深度综述》
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --mode summary

  # 展开查看某一条新闻的完整中文精译全文（例如第 3 条）
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --index 3
  ```

---

### 场景 2：明确要求小爱音箱朗读 / 播报（或 `open-xiaoai-bridge` 自主 Skill 播报模式）
> 典型指令：
> - 用户在聊天中说：「用小爱播报一下今天的新闻」「让音箱读一下前 5 条科技新闻」「把第 2 条新闻读给我听」「播报今日深度综述」
> - 或消息末尾带有 `open-xiaoai-bridge` 的 `rule_prompt_for_skill` 提示（例如：「注意：这条消息是主人通过小爱音箱发送的，他看不到你回复的文字，调用 skill 播报出来」）

- **操作**：直接调用 `speak` 子命令。脚本会自动将新闻清洗为口语化播报稿、切分为 ≤240 字的自然句分段，并通过 `OPENXIAOAI_BASE_URL` 逐段阻塞播报（用户中途喊「小爱同学」打断时会自动停止后续分段）。在聊天渠道中，可同时把脚本回显的文字要点简洁反馈给用户。
- **常用命令**：
  ```bash
  # 播报最新前 5 条全球精选要闻（默认精炼播报 5 条，时长适中）
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --limit 5

  # 按指定分类、地区或关键词播报
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --category 科技 --limit 5
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --keyword 美联储 --limit 3

  # 完整播报当日《全球要闻深度综述》（自动分段顺序朗读）
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --mode summary

  # 朗读指定序号（如第 2 条）的单篇完整中文译文
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --index 2

  # 可选：指定豆包音色或强制使用小爱原生 TTS
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --limit 5 --speaker zh_female_vv_uranus_bigtts
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py speak --limit 5 --engine xiaoai
  ```

---

### 场景 3：小爱音箱自动 TTS 回复模式（`open-xiaoai-bridge` 连续对话 / 自动播放回复）
> 识别特征：消息末尾包含 `open-xiaoai-bridge` 的 `rule_prompt`（例如：「注意：将结果处理成纯文字版，不要返回任何 markdown 格式……并将字数控制在 300 字以内」），**且没有要求主动调用 skill 播报**（此时桥接器会自动将你的文字回复转成语音播放）。

- **操作**：调用 `query --oral` 获取单段 ≤280 字的纯口语播报稿，**直接输出纯文字作为最终回复**，不要再调用 `speak`（否则桥接器自动 TTS 会导致重复播报两遍）：
  ```bash
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --oral --max-chars 280
  python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py query --category 科技 --oral --max-chars 280
  ```

---

### 场景 4：打断停止播报与连通性自检

```bash
# 立即打断小爱音箱正在进行的播报（「别读了」「停止播报」）
python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py stop

# 检查 CoreFeed 局域网接口、GitHub 快照回退及 open-xiaoai-bridge 在线状态
python3 ~/.hermes/skills/corefeed-news/scripts/corefeed_cli.py status
```

---

## 回复排版与播报礼仪提示

1. **忠于精编事实**：直接基于 `corefeed_cli.py` 返回的已核实中文标题、导语、三大看点与译文作答，附上更新时间与权威外媒信源，不要凭空编造未出现在快照中的新闻。
2. **序号保留一致**：向用户展示要闻列表时保留 `[1] [2] [3]` 原始序号，方便用户紧接着追问「展开讲讲第 3 条」或「让小爱把第 3 条读一下」（直接传 `--index 3` 即可精准定位）。
