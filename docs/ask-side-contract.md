# 悬浮助手 — 问一问承载 接口契约 v2

> v2（2026-11-19）把「问一问」从「注入外部 Agent 输入框」改成「DSH 置顶卡里连续提问」。
> v1 的 `外部 Agent` 承载面已删除；`/ask/side`、`/ask/side/followup`、`/ask/side/close`
> 的既有语义保持不变，只新增可选字段。

## 1. 目标

1. 在任意 Windows 应用里划词 → 菜单「问一问」→ 在选区旁开一张 DSH 置顶卡。
2. 卡片里可以**自由输入问题**，答案流式显示；Enter 提交、Esc 收起（原生输入条是单行 EDIT）。
3. 答完可以**继续追问**：同一张卡、同一个 `sessionId`，上下文连续（宿主保留最近 12 轮 / 30 分钟）。
4. 不再往 Claude / Codex / 任何外部应用输入框里注入文本；不再依赖 UIA 命中对方 composer。
5. DSH 页内划词仍走侧卡；右侧文档预览（docx / PDF / Markdown / 代码）划词也进同一条链路。
6. 与 `dsh-quote-annotate-pro` 的关系：吸收「编号引用块 + 出处 + 点回原文」的交互语言，
   不把它作为依赖；两个插件同时安装时，同一选区只允许一个气泡。

## 2. Host 路由（前缀 `/api/dsh-floating-assistant`）

### POST `/ask/side`
请求：
```json
{
  "question": "用户输入的问题（可为空）",
  "text": "选中的文本",
  "context": "可选，选区所在段落",
  "locale": "zh",
  "mode": "quick | deep",
  "source": {
    "origin": "page | doc | external",
    "app": "Codex",
    "title": "窗口标题",
    "path": "docs/a.docx",
    "line": 12,
    "page": 3,
    "sheet": "Sheet1!A1:C3"
  },
  "material": {
    "window": { "app": "Codex", "title": "main.ts", "text": "窗口文本", "chars": 3200, "truncated": false },
    "files": [{ "path": "src/a.ts", "from": 12, "to": 48, "text": "文件片段", "chars": 3000, "truncated": false }],
    "omitted": [{ "kind": "window", "reason": "denied" }]
  }
}
```
- `question` 为空时用默认问法（中文「解释这段文字，并列出关键概念。」）。
- `mode` 可选，默认 `quick`；只影响首问带哪些材料。
- `material` 可选，只随首问进 prompt；服务端白名单收敛、按模式裁剪，材料正文不进 `session.messages`。
  - 快速总计 ≤8000 字符（窗口 ≤2000）；深度总计 ≤12000（窗口 ≤4000、单文件 ≤3000、≤2 文件）。
  - 超限按 文件 → 窗口 → 只留选区 丢弃，丢弃项写入 `omitted`。
- `source` 可选，服务端只保留白名单字段（字符串 ≤512 字符，line/page/turn 为非负整数）。
- SSE 事件：
  - `{"type":"session","sessionId":"ask-...","source":{...},"mode":"quick"}`（必须最先发）
  - `{"type":"context","mode":"quick","window":{...},"files":[...],"omitted":[...],"chars":0}`（紧随 session；只回摘要，不回正文）
  - `{"type":"delta","text":"..."}`
  - `{"type":"done","text":"完整答案"}`
  - `{"type":"error","message":"..."}`

### POST `/ask/side/followup`
请求：`{ "sessionId": "...", "question": "继续追问的内容" }`
- 复用该 sessionId 的历史；SSE 事件同上，`session` 会再发一次（值不变，带 source）。
- 未知/过期 sessionId → `error`，message 为 `session expired`；客户端应清掉本地 sessionId，下一次按首问处理。

### POST `/ask/side/close`
请求：`{ "sessionId": "..." }` → `{ "ok": true }`，释放该会话（关闭卡片时调用）。

### 既有路由
`/run`、`/stop`、`/handoff`、`/settings`、`/system/*` 行为不变。`/handoff` 仍可用于
「把整条线程带进 DSH 会话」，但问一问的默认路径不再经过它。

## 3. Companion（`companion/main.mjs`）

### 3.1 菜单点「问一问」
1. 先 `openPanel(record, 'ask', selection, 'reading')`：卡片立即出现，避免「点了没反应」。
2. 用 `resolveSelection()` 取词（UIA 优先，读不到走一次剪贴板兜底；有 `ocrRect` 再 OCR）。
3. 取不到文字 → 卡片进入 `error`，显示「未能读取选中的文字，请重新划词后再试」；
   同时 `state.lastAsk.stage = 'read-selection-failed'`。
4. 取到文字 → 卡片显示编号引用块（`① 原文`）+ 打开输入条 `askbar`。

### 3.2 输入框（`companion/native/askbar.mjs`）
- 贴在卡片正文底部、页脚上方的简洁输入条：宽度随卡片（约 40 DIP 高），不是独立大面板。
- 中间是系统 `EDIT`（白底无黑框），右侧是「深度」开关；Enter 提交、Esc 取消。
- 首问预填默认问法并全选；追问时为空。
- **正文让位**：输入条开着时卡片带 `askInput: true`，`panelLayout` 让出
  `PANEL.askHeight + PANEL.askGap`（40 + 8 DIP），正文最后两行不会被白条压住。
- **跟随卡片**：输入条是一扇独立 topmost 窗，卡片拖动/改大小时走 `place()` 重排；
  折叠 / 最小化到任务栏 / 藏窗 / 关窗一律先收起它并回收预留带。
- **按 DPI 排布**：字体与子控件按显示器缩放算（125% 下不再字贴顶、深度框偏小）。
- **常驻 + 单例**：输入条全局只有一个，归属"当前这张卡"；点到别处（丢焦点）**不**自动收起，一直停在卡片正文底部；只有 Enter 提交、
  Esc、关卡片、折叠 / 最小化到任务栏 / 藏窗时才收起。
- koffi/GDI 不可用时退回默认问法，保证仍有反应。

### 3.2.1 P0 材料边界（L2）
- 深度首问前，用 UIA `windowText()` 把「当前选区所在的 TextPattern」扩到 Document 范围；
  不截图、不 OCR、不枚举子窗口、不读 ValuePattern。
- 读不到/超时/无 TextPattern → `omitted:[{kind:'window',reason:'unavailable'}]`，卡片出处行显示
  「窗口读不到」（被预算整块丢掉时是「窗口太大没带」），照常回答；不静默降级。
- 材料口径：`window.chars` / `files[].chars` 是**读到多少字**（可能大于实际送出的文本），`textChars` 是**送进 prompt 的字数**；`truncated` 表示"读到或送出的量比原文少"，两者都由宿主裁剪后判定；客户端上报的 `chars` 只在它自己声明截断、或我们这层真裁过时才采信。
- 只把 UIA 文本作为材料；宿主裁剪后会用 `context` 事件回一份权威摘要（`materialSummary`），卡片上窗口写「窗口 N 字（被裁过就写 送审/原文）」、文件只写一句「已添加文件」（不摆文件名与字数，**读到与否在卡片上不区分**，未读原因只进 prompt 与 `/status`）；本地阶段只显示基名（和「深度」），不画任何数字；真的超出预算时，`omitted` 会作为「以下材料没能读取」一节进 prompt。
- L3 只接受**用户显式选中**的文件（卡片上的「文件」按钮 → 系统文件对话框）；标题/工作区猜测一律不参与路径。
- **"根"这一层现在真的生效了**：选中文件后 `confirmPick` 把该文件真实路径的**所在目录**记成这张卡的根
  （`record.fileRoots`，只活在内存里）；每次读文件先过 `resolveWithinRoots`——空串/相对路径/UNC、敏感名单、
  扩展名、必须落在根内，判据跑在 `realpath` **之后**（否则符号链接指到 `C:\Windows` 之类的地方，按名字看
  完全无害）。不通过就进 `omitted`，原因同时进 prompt 与 `/status`。
- 另有 `decodeText` 的二进制魔数/编码闸，`readFileSlice` 的 256KB / 400 行 / 8000 字上限。
  P0 先做 DSH 文档预览 / 手动选文件；Codex/终端只 L2，P1 再给文件夹选择。

### 3.3 连续追问
- 首问：`POST /ask/side`，收到 `session` 后把 `record.askSessionId` 存住。
- 追问：卡片标题栏「问」按钮或输入条再次提交 → `POST /ask/side/followup` 带同一个 sessionId。
- 卡片只显示「当前一轮」的问题与答案，历史留在宿主 `askSessions` 里；`问 N` 画在**正文的问题行**上（不是标题栏）。
- 关闭卡片 → `POST /ask/side/close`。

### 3.4 明确不做
- 不调用 `fillAgentComposer()`，不 focus DSH 窗口，不写对方剪贴板。
- 不再因为「Codex 没有可见顶层窗」而退回 handoff；出处只影响卡片标签。

## 4. Client（`lib/client.js`）

- 页内选区 `readSelection()` 增加 `sourceMeta`：
  - 普通会话：`{ origin: 'page' }`；
  - 右侧文档预览：`{ origin: 'doc', path, line?, page? }`，只认
    `[data-slot="sidebar.right.tab.document"]`、`[data-textpreview-path]`、
    `[data-textpreview-url]`、`[data-textpreview-line]`、`[data-pdf-page]`。
- 侧卡首问 payload 带上 `source: current.sourceMeta`；追问沿用宿主会话，不重发 source。
- 问一问的视觉：编号引用块 + 出处行 + 问题行 + 流式答案；不复制 quote-pro 的
  批注编辑（位置行锁定、语音、跨轮重排、`Annotation N` 协议）。

## 5. 验收

- `node --check`：`lib/index.js`、`lib/client.js`、`companion/main.mjs`、
  `companion/native/askbar.mjs`、`companion/native/ui.mjs` 全通过。
- `npm test` 73 项全通过（gesture / policy / material / materials-read / ask-label / selection 六个文件）。
- 手工（用户点）：
  1. Codex / 记事本里划词 → 问一问 → 输入条可打中文 → 卡片出答案；
  2. 同一张卡继续问 2 轮 → 答案连续、标题栏轮次递增；
  3. 关闭卡片 → `/status.lastAsk.stage` 有记录，Codex 输入框内容不变；
  4. DSH 页内划词 → 侧卡仍可连续追问；
  5. 右侧 docx / PDF / Markdown / 代码划词 → 卡片出处带路径，追问正常。
