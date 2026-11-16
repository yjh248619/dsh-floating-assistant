# 悬浮助手 — DSH 页内交互 / 问问承载 接口契约 v1

本文件由 Lead 维护，host / client / companion 三方按此实现，不要单方面改契约（有异议先发消息给 lead）。

## 1. 目标（本轮范围）

1. **DSH 页内选区浮出条**：在 DSH Web GUI 的聊天区/任务区选中文本后，就近浮出一个小工具条：`解释 | 总结 | 翻译 | 问问`（前三个是快捷动作，第四打开提问框），支持 `Alt+Q` 打开提问框。
2. **侧卡（问问的第三个承载面）**：点问询动作或快捷动作后，答案在右侧浮动卡片里流式显示；卡片可关闭、复制、继续追问、改问；不污染主会话。
3. **结果操作**：答案支持复制、代码块单独复制、插入到 DSH 输入框（不自动发送）、定位回原文（滚动到选区并高亮）。
4. **问问的三个承载面**：`侧卡`（默认，在 DSH 内划词）、`当前对话`（把引用块填进输入框，不发送）、`外部 Agent`（companion 负责，Claude/Codex 桌面注入）。
5. **问问的舍弃项**（已与用户确认）：不再自动新建 DSH 会话；不再自动附带"上文"；外部 Agent 注入失败不再静默回退 DSH。

## 2. Host 侧新增路由（`lib/index.js`，前缀 `/api/dsh-floating-assistant`）

所有路由都是 POST + JSON，响应必须是 `text/event-stream`（与现有 `/run` 相同写法）。

### POST `/ask/side`
请求：
```json
{ "question": "用户输入的问题（可为空）", "text": "选中的文本", "context": "可选", "locale": "zh" }
```
- `question` 为空时，默认问法："解释这段文字，并列出关键概念。"
- 宿主把它当作**独立子代理式**的一轮问答：用自己的会话状态（内存 map），**不写入 DSH 会话列表**，不污染主对话。
- SSE 事件：
  - `{"type":"session","sessionId":"..."}`（必须最先发）
  - `{"type":"delta","text":"..."}`
  - `{"type":"done","text":"完整答案"}`
  - `{"type":"error","message":"..."}`（出错时替代 done）

### POST `/ask/side/followup`
请求：`{ "sessionId": "...", "question": "继续追问的内容" }`
- 复用该 sessionId 的上下文（把之前的选区+问答历史带上），SSE 事件同上（也要再发一次 `session`，值不变）。
- 未知/过期 sessionId → 发 `error`，message 为 `session expired`。

会话存储：内存 Map，最多 20 个会话，30 分钟 TTL，超出淘汰最旧。历史只保留最近 12 轮。

### POST `/ask/side/close`
请求：`{ "sessionId": "..." }` → `{ "ok": true }`，释放该会话。

### 既有路由保持不变
`/run`、`/stop`、`/handoff`、`/settings`、`/system/*` 的行为不变；companion 与本契约无关的部分不要动。

## 3. Client 侧 UI 契约（`lib/client.js`）

### 3.1 DOM / 类名（避免与宿主样式冲突，全部用 `dst-` 前缀）
- 浮出条：`<div class="dst-float" data-dst-role="float">`，内含 4 个按钮（`data-dst-action="explain|summarize|translate|ask"`）。
- 侧卡：`<aside class="dst-card" data-dst-role="card">`，宽 380px，右侧可拖动位置不重要，固定右上角即可；内含标题、模型/状态行、答案区、页脚（复制 / 继续追问 / 关闭）。
  - 答案区：`<div class="dst-card-answer" data-dst-role="answer">`，流式文本用 `MarkdownText` 渲染（`primitives.MarkdownText`）。
  - 追问输入：`<textarea class="dst-card-input" data-dst-role="input">` + 发送按钮。
- 结果操作按钮：`data-dst-result="copy|copy-code|insert|locate"`。
- 高亮原文：给原选区所在元素加 `.dst-locate-hl`（2 秒后移除）。

### 3.2 触发规则（与 sidecard 对齐，只做必要子集）
- `selectionchange` 后 200ms 去抖；`selection.toString().trim()` 长度 ≥ 2。
- 选区位于 `input / textarea / [contenteditable]` 内 → 不出现（避免编辑干扰）。
- 选区落在插件自己的 DOM（`[data-dst-role]`、`.dst-*`）内 → 不出现。
- 同一选区（文本+近似位置）400ms 内重复 → 忽略。
- 滚动、窗口 resize、点击别处 → 隐藏浮出条；`Esc` 关闭卡片。
- 浮出条位置：选区外接矩形下方 8px，超出视口则上方；水平居中并夹在视口内。
- `Alt+Q`：对当前选区打开卡片提问框。

### 3.3 交互流程
- 点`解释/总结/翻译`：打开卡片（若已开则复用），调 `POST /run {action,text,context,locale}`（**复用现有 run 路由**），把 SSE delta 渲染进答案区；`done` 后显示结果操作。
- 点`问问`或 `Alt+Q`：打开卡片并聚焦追问输入；提交时调 `POST /ask/side`；后续追问调 `POST /ask/side/followup`。
- 卡片页脚：
  - 复制：复制答案 Markdown 文本；
  - 复制代码块：若答案含 ``` 代码块，提供下拉或依次复制第一个代码块（简化：复制全部代码块拼接）；
  - 插入输入框：把答案插入 DSH 当前会话输入框（找到可见的 `textarea`/`contenteditable`，写值并触发 `input` 事件；找不到就给 toast 提示）；
  - 定位原文：滚动到选区并高亮 2 秒。
- 关闭卡片：`POST /ask/side/close`（若是 ask 会话）+ 清 DOM。

### 3.4 与现有东西的关系
- 现有的 handoff 引用块逻辑（`quoteForInput`）保留，用于"问问"的「当前对话」承载；但**默认承载改为侧卡**。
- 设置页已有 `answerStyle / customPersona`，不要重复添加。
- 样式统一写进现有 `CSS` 模板字符串（`STYLE_TAG_ID = "dsh-floating-assistant/client.css"`），不要新建 style 标签 id。

## 4. Companion 侧（`companion/main.mjs`）

1. 菜单点「问问」且选区来自 DSH 桌面时：走 DSH handoff（现有行为）即可，但**不要再新建会话**（host/client 侧保证）；companion 不需要改 mode 逻辑。
2. 选区来自 Claude/Codex 桌面时：注入失败**不静默回退 DSH**；改为写 `state.lastAsk = {mode:'agent-failed', reason, ...}` 并尝试用 `flashFeedback('未能在 X 中输入')` 给反馈；若没有可见面板，则不回退、不打开 DSH 会话。
3. `askSelection` 传给 DSH 的 context 改为空串（不自动带上文），但保留 `selection.context` 的采集逻辑（解释/总结/翻译仍用）。
4. 不新增菜单项，不改原生面板布局。

## 5. 验收（Lead 会逐条跑）
- `node --check` 三个改动文件全部通过。
- `/ask/side` + followup 用 curl/Invoke-RestMethod 验证 SSE 事件顺序与追问上下文。
- 打开 DSH 页面（新开标签，勿动用户当前页）验证：选中→浮条→点解释→卡片流式→复制/插入/定位；`Alt+Q` 提问；追问两轮；Esc 关闭。
- companion：`/simulate {sourcePid:52456}` + `/click menu x=287,y=18`（问问）验证注入；伪造失败（改 sourcePid 为非白名单）验证不静默回退、有 lastAsk 记录。
- 不发布 npm；不改 version（Lead 统一 bump）。

## 6. 写文件范围（严禁越界）
- host：只改 `lib/index.js`。
- client：只改 `lib/client.js`。
- companion：只改 `companion/main.mjs`。
- 新增测试：`test/*.test.mjs`（各自命名，避免抢同名文件）。
- 不要改 `lib/client.js` 以外的前端文件、不要碰 `companion/native/*`、不要改 package.json / README / 版本号。
