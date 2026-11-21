/**
 * dsh-floating-assistant 系统级伴生进程（Node + koffi + GDI+）。
 *
 * 1. **全局划词**：轮询鼠标左右中键与光标位置识别"拖选/双击选词"，手势落下就弹菜单——
 *    **划词时一次都不碰剪贴板**；选中的文字留到用户点菜单项时才解析（UI Automation 优先，
 *    读不到才注入一次 Ctrl+C 读剪贴板兜底）。
 * 2. **两个原生浮层窗口**（都在本进程内，GDI+ 自绘，不依赖浏览器、不额外起进程）：
 *    - 划词菜单：出现在选区右下角，**有显示时限**（默认 3.6s）、任意键点到别处即消失；
 *    - 回答窗口（面板）：**只有手动关闭才会消失**，新划词不会动它；没有悬浮球、没有最小化。
 * 3. **读选区与上下文**：手势落下就用 UI Automation 一次读完"选中的文字 + 它所在的段落"
 *    （worker 线程 + 超时，全程不碰剪贴板）；点菜单项时连同上下文一起交给 agent——像知乎
 *    划词解释那样带语境，读不到就安静降级成"只有选区"、再读不到才退到剪贴板兜底。
 * 4. **跑 agent**：直接调用 DSH 插件的 /run 路由（SSE），把流式文本画到回答窗口上。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { createContextReader } from './context.mjs'
import { createGestureDetector, createLatestQueue } from './gesture.mjs'
import { isAllowedExtension, isSensitivePath, readFileSlice } from './materials/read.mjs'
import { menuDecision, panelDipSize, panelPixelSize, pickSelection, unknownFallback } from './policy.mjs'
import { captureSelection, clampSelection } from './selection.mjs'
import { createGdi } from './native/gdi.mjs'
import { captureScreenRect } from './native/capture.mjs'
import { createNativeWindow, hitTestCode } from './native/window.mjs'
import { createAskBar } from './native/askbar.mjs'
import { buildContextLabel } from './labels.mjs'
import { MODES, PANEL, menuRowAt, paintMenu, paintPanel, panelHit, panelHitZone } from './native/ui.mjs'
import { ensureMathReady } from './native/math.mjs'
import { detectAgentHostForPid } from './native/inject.mjs'
import { ocrLast, ocrScreenRect } from './native/ocr.mjs'
import { createWin32, monitorScaleForPoint, primaryWorkArea, processImage, windowPid, windowTitle, workAreaForPoint } from './win32.mjs'

const DSH_ORIGIN = process.env.DSH_SELECTION_DSH_ORIGIN ?? 'http://127.0.0.1:3080'
/**
 * 桌面壳（Electron 主进程）的 pid —— 它的窗口才是"DSH 自己的窗口"。
 *
 * 伴生进程的父进程是 harness 宿主，不是桌面壳，所以这个值要问宿主拿一次
 * （`/system/status` 里的 `desktopPid`），拿到就缓存。拿不到就退回 0：
 * 那时"问一问"一律按"别的应用"处理（开新会话），宁可保守也不往当前会话乱塞。
 */
let dshDesktopPid = 0
/** 取桌面壳 pid（只问一次；失败不重试，避免划词路径上多等）。 */
async function resolveDshDesktopPid() {
  if (dshDesktopPid !== 0) return dshDesktopPid
  try {
    const response = await fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/system/status')
    const payload = await response.json()
    dshDesktopPid = Number(payload?.desktopPid) || 0
  } catch {
    dshDesktopPid = 0
  }
  return dshDesktopPid
}
const KOFFI_HINT = process.env.DSH_SELECTION_KOFFI_HINT ?? ''
const POLL_MS = Number(process.env.DSH_SELECTION_POLL_MS ?? 40)
const HOOK_ENABLED = process.env.DSH_SELECTION_HOOK !== '0'
const MAX_TEXT = Number(process.env.DSH_SELECTION_MAX_TEXT ?? 12000)
const LOCALE = process.env.DSH_SELECTION_LOCALE === 'en' ? 'en' : 'zh'
/** 划词菜单的显示时限（毫秒）。 */
const MENU_TIMEOUT_MS = Number(process.env.DSH_SELECTION_MENU_TIMEOUT_MS ?? 3600)
/** 单次上下文读取的时间预算（毫秒）：超时就丢掉 worker，按"没有上下文"处理。 */
const CONTEXT_TIMEOUT_MS = Number(process.env.DSH_SELECTION_CONTEXT_TIMEOUT_MS ?? 1800)
/**
 * UI Automation 开关（`DSH_SELECTION_CONTEXT=0` 可关掉）。
 *
 * 注意它现在管两件事：读"选区所在的段落"与**读选区本身**。关掉之后菜单不再过滤手势
 * （一律弹），选区文字只能走剪贴板兜底——等于退回老行为，只在 UIA 明显捣乱时才用。
 */
const CONTEXT_ENABLED = process.env.DSH_SELECTION_CONTEXT !== '0'
/**
 * 取词时是否校验"这次剪贴板写入来自前台窗口"（`DSH_SELECTION_CLIPBOARD_OWNER=0` 可关掉）。
 * 关掉就退回老行为：只要剪贴板序号变了就当作取词成功——遇到取不到词的个别应用才需要关。
 */
const OWNER_CHECK = process.env.DSH_SELECTION_CLIPBOARD_OWNER !== '0'

/** 环境变量读成非负数（读不出/非法就用默认值）。 */
function envNumber(raw, fallback) {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * 手势落下后给 UIA 的决策窗口（毫秒）。
 *
 * 菜单不再等取词：老实现要先注入 Ctrl+C 读剪贴板，读到了才弹菜单——读不到就等于
 * **菜单呼不出来**（DSH 桌面端的 WebView2 窗口里注入的 Ctrl+C 拿不到剪贴板，个别
 * 外部应用也偶发同样的问题）。现在手势一落地就开始 UIA 预读，最多等这么久拿一个
 * "这一点上有没有选中文字"的结论：读到了按它办，超时/读不到就照弹（点菜单项时还有
 * 剪贴板兜底）。设成 0 = 手势一到就弹，不做任何过滤。
 */
const MENU_DECIDE_MS = envNumber(process.env.DSH_SELECTION_MENU_DECIDE_MS, 280)
/**
 * DSH 桌面窗口里的划词要不要弹**原生菜单**（默认不弹）。
 *
 * 页内客户端已经接管 DSH 的选区：选中文字浮出工具条 + 右侧侧卡流式作答。原生菜单
 * 同时弹出来会变成两套 UI；所以默认在前台进程属于 DSH 时跳过原生菜单。页内客户端
 * 万一没加载，设 `DSH_SELECTION_MENU_IN_DSH=1` 可回到旧行为。
 */
const MENU_IN_DSH = process.env.DSH_SELECTION_MENU_IN_DSH === '1'
/**
 * 菜单弹出时 UIA 预读的重试次数。
 *
 * Chromium（含 DSH 桌面端自己的 WebView2 窗口）是**被 UIA 问到才打开无障碍树**的：冷
 * 启动那一下连 TextPattern 都没有（实测：本轮第一次划词 3 次尝试全空，之后再问就正常）。
 * 预读在决策窗口超时之后仍会继续跑，所以这些重试主要是在替**点菜单项时**把树焐热。
 */
const MENU_PROBE_RETRIES = envNumber(process.env.DSH_SELECTION_MENU_PROBE_RETRIES, 3)
/**
 * 鼠标**按下**时要不要拍一张"手势之前的选区"快照（`0` 关掉）。
 *
 * 它是"这次手势到底有没有选出新东西"的唯一判据：办公套件里拖动一个**已经选中**的元素
 * （WPS/Office 的 PPT 形状、Excel 单元格）时，UIA 从头到尾都报着"这个对象被选中"——
 * 只有比较"按下时"和"松开时"读到的选区，才能把"移动元素"和"选文字"分开（见
 * policy.mjs 的 menuDecision）。代价是每次按下多一次 UIA 读取（在 worker 线程里，不挡
 * 主进程）；真遇到某个应用在按下时被 UIA 问得很贵，可以把它关掉。
 */
const PRESS_PROBE = process.env.DSH_SELECTION_PRESS_PROBE !== '0'
/**
 * 等"按下快照"的上限（毫秒）。
 *
 * 快照在按下那一刻就发出去了，正常早就回来了（这一步不花时间）；只有"按下到松开特别快"
 * 的拖拽才会真等——给它一小段时间，免得这种手势直接掉进"没拍到"那一档。再久就不值了：
 * 划词菜单是手感的一部分，不能为了一条兜底判据把它拖慢。
 */
const PRESS_WAIT_MS = envNumber(process.env.DSH_SELECTION_PRESS_WAIT_MS, 120)
/**
 * UIA 说不出话时，要不要用**剪贴板**核实一次"这次手势到底选没选中文字"（`0` 关掉）。
 *
 * 办公套件（WPS 的 Qt 版最典型）整个窗口树里都没有文档的 TextPattern——UIA 对"有没有选中
 * 文字"完全无话可说。核实办法是注入一次 Ctrl+C：真选中文字就会复制出文字；拖动一个形状/
 * 窗口则什么文字都复制不出来。代价是会短暂接管剪贴板（selection.mjs 那几条安全规则照旧：
 * 终端跳过、用户正在 Ctrl+C 就不注入、只认前台窗口自己写的那次、用完把原内容放回去）。
 *
 * 关掉之后退回老行为：拖选照弹、双击不弹（见 policy.mjs 的 unknownFallback）。
 */
const CONFIRM_BY_CLIPBOARD = process.env.DSH_SELECTION_CONFIRM !== '0'
/**
 * 剪贴板核实的单次超时（毫秒）。
 *
 * 原来固定 900ms：Chrome/PDF/Office 里 Ctrl+C 注入之后剪贴板序号常常一次都没动
 * （`writes=0`），于是"还没写"被当成"没选中文字"，菜单干脆不弹——线上样本里
 * 一半的不弹都是这一条。放宽到 1400ms，失败后还有一次重试（见 confirmByClipboard）。
 */
const CONFIRM_TIMEOUT_MS = envNumber(process.env.DSH_SELECTION_CONFIRM_TIMEOUT_MS, 1400)
/** 注入 Ctrl+C 之前的静置时间：双击第二下松手时，词选区可能还没真正生效。 */
const CONFIRM_SETTLE_MS = envNumber(process.env.DSH_SELECTION_CONFIRM_SETTLE_MS, 120)
/** 首轮核实超时（而且剪贴板完全没被写过）后的重试间隔。 */
const CONFIRM_RETRY_MS = envNumber(process.env.DSH_SELECTION_CONFIRM_RETRY_MS, 500)
/** 双击探针"快速给空"（ready 但 selectionLength=0）之后再读一次的等待时间。 */
const DOUBLE_RECHECK_MS = envNumber(process.env.DSH_SELECTION_DOUBLE_RECHECK_MS, 90)
/**
 * 点菜单项之后，用剪贴板复核选区的预算（毫秒）。
 *
 * UIA 的 TextPattern 在 Chrome/PDF 这类应用里经常只交出一部分选区（实测：拖选一整段
 * 公式文字，UIA 只给 39 个字），回答窗的「原文」于是比用户选中的短一截。Ctrl+C 拿到的
 * 是应用自己定义的完整选区，所以拖选手势上再核一次：不同就换掉，超时就保留 UIA 结果。
 */
const VERIFY_SELECTION_MS = envNumber(process.env.DSH_SELECTION_VERIFY_TIMEOUT_MS, 700)
/**
 * 点菜单项时补读 UIA 的重试次数。
 * 那时无障碍树通常已经热了，给 1 次机会挡的是"刚巧还在冷启动"；再多就只是拖延
 * 剪贴板兜底（那才是真的读不到时的出路）。
 */
const CLICK_PROBE_RETRIES = envNumber(process.env.DSH_SELECTION_CLICK_PROBE_RETRIES, 1)
/**
 * 选区文字从哪来：
 * - `auto`（默认）：UIA 优先，读不到才注入一次 Ctrl+C 读剪贴板；
 * - `uia`：只用 UIA，读不到就报错（绝不碰剪贴板）；
 * - `clipboard`：直接用剪贴板（老行为；某个应用 UIA 读得不准时的逃生舱）。
 */
const TEXT_SOURCE = ['auto', 'uia', 'clipboard'].includes(process.env.DSH_SELECTION_TEXT_SOURCE)
  ? process.env.DSH_SELECTION_TEXT_SOURCE
  : 'auto'
const GAP = 8
const VK_LBUTTON = 0x01
const VK_RBUTTON = 0x02
const VK_MBUTTON = 0x04
const VK_ESCAPE = 0x1b

const api = createWin32([KOFFI_HINT])
const gdi = api === null ? null : createGdi(api.koffi)
/**
 * 「问一问」输入条：非分层小窗 + 系统 EDIT（中文输入法可用）。
 * 建窗是懒的，这里只做能力探测；koffi/GDI 不可用时保持 null，问一问会退回预置问法。
 */
/** 所有原生窗口（含已经从记录上摘掉、但可能还活着的）：hide/close 之后据此清扫孤儿窗。 */
const nativeWindows = new Set()
let askBar = null
if (api !== null) {
  try {
    askBar = createAskBar(api, { onError: (error) => reportError('askbar', error) })
  } catch (error) {
    console.error('[floating-assistant] askbar init failed:', error)
    askBar = null
  }
}

// 给伴生进程一个独立的任务栏身份。
//
// 不设显式 AppUserModelID 时，它和 DSH Desktop 用同一个 AUMID：窗口最小化后只会并进
// DSH 图标的那个任务栏分组里——看不到独立按钮，等于"最小化到任务栏"没有入口。
// 必须在创建任何窗口之前设置（Windows 只在进程第一次建窗口时读取它）。
if (api !== null) {
  try {
    const shell32 = api.koffi.load('shell32.dll')
    const setAppId = shell32.func('int SetCurrentProcessExplicitAppUserModelID(const char16_t *appId)')
    setAppId('DeepSeek.DSH.FloatingAssistant')
  } catch (error) {
    reportError('aumid', error)
  }
}

/** 一扇回答窗口的业务状态（也是绘制输入；每个窗口一份，互不干扰）。 */
function createPanelUi() {
  return {
    mode: 'panel',
    dark: true,
    hover: -1,
    hoverButton: null,
    action: 'explain',
    source: '',
    /** 原文区的小标签：普通选区是"原文"，OCR 识别的是"原文（OCR）"。 */
    sourceLabel: '原文',
    /** 本轮用户的问题（问一问卡才有；只显示一行，完整问题在会话历史里）。 */
    question: '',
    /** 这张卡已经问到第几轮（0 = 还没问）。 */
    askTurn: 0,
    context: '',
    answer: '',
    status: 'idle',
    error: '',
    copyFeedback: '',
    scroll: 0,
    contentHeight: 0,
    viewHeight: 0,
    stopBox: null,
    /** 页脚「追问」按钮的命中区（绘制时算，面板命中读它）。 */
    askBox: null,
    /** 页脚「深度」按钮的命中区。 */
    deepBox: null,
    /** 折叠（自绘标题条）：只画顶部 48 DIP，窗口不缩、仍在屏幕上（见 toggleFold）。 */
    minimized: false,
    /** 真的缩进了 Windows 任务栏（系统 ShowWindow(SW_MINIMIZE)，点任务栏按钮回来）。 */
    taskbarMinimized: false,
  }
}

/**
 * 动作 → 任务栏按钮文案。
 *
 * 多扇窗最小化到任务栏后，任务栏上每扇窗一个按钮；写动作名（解释/总结/翻译）才分得清
 * 哪一扇是什么（都叫"悬浮助手"的话就抓瞎了）。
 */
const ACTION_TITLES = { explain: '解释', summarize: '总结', translate: '翻译', ask: '问一问' }

function panelTitle(action) {
  return '悬浮助手 · ' + (ACTION_TITLES[action] ?? '解释')
}

/**
 * 划词菜单状态。
 *
 * `selection` 是**这个菜单是为哪次选区弹的**：点菜单项时一律用它，不用当时的
 * `state.selection`——用户点下去的那一刻可能刚好又有一次划词完成了，用后者会让
 * "回答窗口里的输入内容"跟"用户看着菜单点的那段文字"对不上。
 */
const menu = { visible: false, rect: null, scale: 1, anchor: null, hover: -1, timer: null, dark: true, selection: null }

/**
 * 所有回答窗口（多窗并存）。
 *
 * 每项一个 record：`{ id, ui, panel, window, run, copyFeedbackTimer, createdAt }`。
 * 旧实现只有一个窗口，新一次划词会把上一段的内容顶掉；现在每次动作单独开一扇，
 * 用户可以左右对照着看（上限 MAX_PANELS，超出关最旧的）。
 */
const panels = []
/** 响应窗口并存上限。 */
const MAX_PANELS = Math.max(1, Math.min(8, Number(process.env.DSH_SELECTION_MAX_PANELS ?? 4) || 4))
/** 用户手动改过的窗口大小（物理像素）：新窗口沿用，省得每次重拖。 */
let preferredPanelSize = null
let panelSeq = 0
/**
 * GDI+ 必须在任何窗口第一次 paint 之前启动。
 *
 * 菜单窗是启动时就创建好的，用户第一次划词它就会 paint；如果等到"第一次新建回答窗"
 * 才 startup，菜单会画成一整块全透明——逻辑上 visible=true、能点的区域也在，但屏幕上
 * 什么都看不到（"划词不触发"）。多窗口重构时曾把这个启动挪进 createPanel，重启后
 * 正好踩中：菜单看不见 → 点不到 → 回答窗永远不创建 → GDI+ 永远不启动。
 */
let gdiReady = gdi !== null && gdi.startup() === true

const state = {
  selection: null,
  lastGesture: null,
  lastCapture: null,
  lastMenuDismiss: null,
  /** 最近一次菜单收起时，菜单绑的是哪段文字（用来识别"手势没碰到、文字也没变"的旧选区）。 */
  lastMenuSelection: '',
  /** 最近几次"弹不弹"的结论（偶发"划不出来"时看这个：/status 的 recentDecisions）。 */
  recentDecisions: [],
  /** 最近一次 UIA 探针（读到了什么）。 */
  lastProbe: null,
  /** 最近一次"按下那一刻"的选区快照摘要（判断"这次手势有没有选出新东西"要用它）。 */
  lastPressProbe: null,
  /** 最近一次"用剪贴板核实有没有选中文字"的报告（UIA 判不了时才走这一步）。 */
  lastConfirm: null,
  /** 最近一次"用剪贴板复核选区原文"的结果（UIA 只给半截时用，排障用）。 */
  lastVerify: null,
  /** 最近一次"弹不弹菜单"的结论与理由（呼不出来时看这里）。 */
  lastMenuDecision: null,
  /** 最近一次"点菜单项之后用了哪个来源的文字"。 */
  lastResolve: null,
  /** 最近一次「问一问」的判定（sourcePid / mode: card | card-failed / stage，排障用）。 */
  lastAsk: null,
  /** L2 按 exe basename 的授权表（从 host 设置加载；只记 allowed/at）。 */
  windowConsent: {},
  /** 上一次菜单**弹出**的时刻（"同一段文字过一会儿再划要能再弹"要用它）。 */
  lastMenuShownAt: 0,
  /** 每个 reason 各出现过几次（偶发不弹时一眼看出是哪条判据在拦）。 */
  reasonCounts: {},
  startedAt: Date.now(),
  errors: [],
}

/** 手势串行队列（startHook 里建；/status 汇报它的状态）。 */
let gestureQueue = null

/**
 * **按下那一刻**读到的选区（"这次手势之前，按住的地方本来就选着什么"）。
 *
 * 为什么必须在这一刻拍：拖完再读到的已经是被这次手势改过的选区了，两者一比才知道这次
 * 手势到底有没有选出新东西——办公套件里拖动一个已选中的元素（PPT 形状、Excel 单元格）时，
 * 松开那一刻探针照样读到"这个对象被选中"，跟真的拖选文字一模一样（见 policy.mjs 的
 * menuDecision 第一条判据）。双击第二下不重拍：双击要的是**这一串点击开始之前**的选区。
 *
 * `{ at, x, y, pending, result }`；`result` 是探针结果（`undefined` = 还没回来，
 * `null` = 读不到），/status 的 `pressProbe` 会把它摘出来给人看。
 */
let pressSnapshot = null

/**
 * 有没有一次手势正在等探针结论（`handleGesture` 的决策窗口）。
 *
 * 读取器同一时刻只保留最新的一次请求：决策在途时再拍按下快照，会把**这次决策的探针**
 * 顶掉（结果变成"读不到"→ 拖选照弹），菜单就可能在"随手一拖"时冒出来。所以决策期间不
 * 拍快照——那一档本来就按"没拍到"处理（少一条判据，回到改动前的行为），代价可忽略。
 */
let deciding = false

/**
 * 拍一张"按下那一刻"的选区快照（`DSH_SELECTION_PRESS_PROBE=0` 可关掉）。
 *
 * 一次读取，不重试：它只是给决策多一条判据，拍晚了/读不到都不影响原来的判定（那时按
 * null 传下去，等于回到改动前的行为）。
 *
 * @param press - 手势按下事件（`{ x, y, time, second }`，见 gesture.mjs）。
 */
/**
 * 用户还没手动拖过回答窗时，首次弹窗默认放在选区旁边。
 *
 * 优先右下方；空间不够就换上方、左侧或右上方，尽量不遮挡选中文字。
 *
 * @param {object} opts
 * @param {object} opts.workArea - 当前显示器工作区矩形。
 * @param {object|null} opts.selection - 选区锚点 `{x,y}`（松开时的坐标，物理像素）。
 * @param {number} opts.width - 回答窗宽度。
 * @param {number} opts.height - 回答窗高度。
 * @param {number} opts.gap - 与选区留多少像素空隙。
 * @returns {object} 默认位置 `{x,y}`。
 */
function placePanelBySelection({ workArea, selection, width, height, gap, occupied = [] }) {
  const clampToWork = (rect) => ({
    x: Math.min(Math.max(rect.x, workArea.left), Math.max(workArea.left, workArea.right - width)),
    y: Math.min(Math.max(rect.y, workArea.top), Math.max(workArea.top, workArea.bottom - height)),
  })
  const overlaps = (rect) => occupied.some((other) =>
    rect.x < other.x + other.width + 6 &&
    rect.x + width > other.x - 6 &&
    rect.y < other.y + other.height + 6 &&
    rect.y + height > other.y - 6
  )
  if (selection === null || selection === undefined) {
    return clampToWork({ x: workArea.right - width - 20, y: workArea.bottom - height - 20 })
  }
  const sx = selection.x
  const sy = selection.y
  // 候选位置：右下、右上、左下、左上
  const candidates = [
    { x: sx + gap, y: sy + gap },         // 右下
    { x: sx + gap, y: sy - height - gap }, // 右上
    { x: sx - width - gap, y: sy + gap },  // 左下
    { x: sx - width - gap, y: sy - height - gap }, // 左上
  ]
  // 找能完整放进工作区、且最靠左上角的候选（视觉上自然跟随阅读流）
  const fits = candidates.filter((p) =>
    p.x >= workArea.left &&
    p.x + width <= workArea.right &&
    p.y >= workArea.top &&
    p.y + height <= workArea.bottom
  )
  const fallback = { x: workArea.right - width - 20, y: workArea.bottom - height - 20 }
  const base = fits.length > 0 ? fits[0] : fallback
  if (occupied.length === 0) return base
  // 已有别的回答窗占着这块：
  // 1) 先试并排（放到所有已有窗口的左边），只要还有空间就完全不叠。
  const leftMost = Math.min(...occupied.map((rect) => rect.x))
  const besideLeft = clampToWork({ x: leftMost - width - 8, y: base.y })
  if (leftMost - width - 8 >= workArea.left && !overlaps(besideLeft)) return besideLeft
  // 2) 再试上下堆叠（放到所有已有窗口的上方）。
  const topMost = Math.min(...occupied.map((rect) => rect.y))
  const stackedUp = clampToWork({ x: base.x, y: topMost - height - 8 })
  if (topMost - height - 8 >= workArea.top && !overlaps(stackedUp)) return stackedUp
  // 3) 空间实在不够：按 24 DIP 阶梯往右下让，最多让 16 步；让不开就叠着放（标题栏仍然露出来）。
  for (let step = 1; step <= 16; step += 1) {
    const candidate = clampToWork({ x: base.x + step * 24, y: base.y + step * 24 })
    if (!overlaps(candidate)) return candidate
  }
  return clampToWork({ x: base.x + 24, y: base.y + 24 })
}

function startPressProbe(press) {
  if (contextReader === null || !PRESS_PROBE) {
    pressSnapshot = null
    return
  }
  // 双击的第二下**永远不重拍**：要的是"这一串点击开始之前"的选区——第二下按下时选中的
  // 词已经出来了，拿它当"拖之前"会把双击选词整个判成"没改动选区"（于是双击再也弹不出来）。
  if (press.second === true) return
  // 决策在途时不拍：这一拍会把这次决策的探针顶掉（见 deciding 的说明）。这一下也就没有
  // 快照了——顺手清掉旧的，免得拿上一次的形状/文字去判这一次手势。
  if (deciding) {
    pressSnapshot = null
    return
  }
  const snapshot = {
    at: Date.now(),
    x: press.x,
    y: press.y,
    /** 探针结果：`undefined` = 还没回来。 */
    result: undefined,
    pending: null,
    /**
     * 读数**到手那一刻**指针离按下点有多远（像素；`null` = 量不到）。
     *
     * 为什么要在这一刻量：按下快照是异步读的，探针发出去不等于读到的是那一刻的状态。
     * 浏览器里 UIA 首查常要 100ms 以上，一次 80px 的拖选只要 150ms——读数回来时用户早拖完
     * 了，于是"按下那一刻"读到的是**这次手势自己选出来的文字**，跟松开时一模一样，被判成
     * unchanged-selection，菜单再也不出来（见 policy.mjs 的 PRESS_SETTLE_SLOP）。
     * 指针还没动 → 读数再慢也代表按下时的状态；指针已经跑出去 → 这张快照作废。
     */
    driftPx: null,
  }
  snapshot.pending = contextReader.probe({ x: press.x, y: press.y }, { retries: 0 })
  pressSnapshot = snapshot
  void snapshot.pending
    .then((result) => {
      snapshot.driftPx = driftFrom(snapshot)
      snapshot.result = result ?? null
      state.lastPressProbe = summarizePress(snapshot)
    })
    .catch((error) => {
      snapshot.driftPx = driftFrom(snapshot)
      snapshot.result = null
      state.lastPressProbe = summarizePress(snapshot)
      reportError('press-probe', error)
    })
}

/** 指针现在离按下点有多远（像素）；量不到返回 null（当作"没量到"，仍按可信处理）。 */
function driftFrom(snapshot) {
  if (api === null || typeof api.GetCursorPos !== 'function') return null
  const point = {}
  try {
    if (!api.GetCursorPos(point)) return null
  } catch {
    return null
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
  return Math.round(Math.hypot(point.x - snapshot.x, point.y - snapshot.y))
}

/** 按下快照的摘要（/status 与 recentDecisions 用；只截一小段选区文字）。 */
function summarizePress(snapshot) {
  if (snapshot === null || snapshot === undefined) return null
  const result = snapshot.result
  const selection = typeof result?.selection === 'string' ? result.selection : ''
  return {
    at: snapshot.at,
    state: result === undefined ? 'reading' : result === null ? 'none' : 'ready',
    source: typeof result?.source === 'string' ? result.source : '',
    selectionLength: selection.length,
    /** 读数到手那一刻指针离按下点多远（像素）：太远说明这张快照拍晚了（见 driftFrom）。 */
    driftPx: Number.isFinite(snapshot.driftPx) ? snapshot.driftPx : null,
    /** 选区矩形数组（只传前 6 个，够判断"动没动"就行；null = 没读到）。 */
    rects: Array.isArray(result?.rects) ? result.rects.slice(0, 6) : null,
    /** 缩略（跟 lastMenuSelection 一样只留一小段，够看出"拖的是什么"就行）。 */
    selection: selection.slice(0, 120),
  }
}

/** 上下文读取器（worker 线程；钩子关掉或显式禁用时不建）。 */
const contextReader = api !== null && gdi !== null && CONTEXT_ENABLED
  ? createContextReader({ koffiHint: KOFFI_HINT, timeoutMs: CONTEXT_TIMEOUT_MS })
  : null

function reportError(scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  state.errors.push({ scope, message, time: Date.now() })
  if (state.errors.length > 20) state.errors.shift()
}

let themeCache = { value: true, at: 0 }
function systemDark() {
  if (Date.now() - themeCache.at < 60_000) return themeCache.value
  let dark = true
  try {
    const result = spawnSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'AppsUseLightTheme'], { encoding: 'utf8', windowsHide: true, timeout: 2000 })
    const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout ?? '')
    if (match !== null) dark = Number.parseInt(match[1], 16) === 0
  } catch {
    /* 读不到就按深色 */
  }
  themeCache = { value: dark, at: Date.now() }
  return dark
}

// ---------------------------------------------------------------- 回答窗口（可并存多扇）

/**
 * 已有窗口里找一扇"同一段文字、同一种动作"的：复用它、重新跑一遍。
 *
 * 用户要的"并存"是**不同划词之间**各自留一扇；同一段文字重复点同一个动作，
 * 再叠一扇纯属添乱。
 */
function findReusablePanel(action, text) {
  if (typeof text !== 'string' || text.trim() === '') return null
  const found = panels.find((record) =>
    record.panel.mode !== 'hidden' && panelReady(record) && record.ui.action === action && record.ui.source === text
  )
  return found ?? null
}

/** 最近显示、且此刻真正在屏幕上的一扇窗口（/status、/click 等旧接口的默认目标）。 */
function activePanel() {
  for (let i = panels.length - 1; i >= 0; i -= 1) {
    const record = panels[i]
    if (record.panel.mode !== 'hidden' && record.ui.taskbarMinimized !== true && panelReady(record)) return record
  }
  return null
}

/**
 * 一扇窗口在屏幕上的有效矩形。
 *
 * 折叠（自绘标题条）时只占顶部标题条：手势忽略区与"别叠在一起"的避让都要按这个算，
 * 否则收起来的窗口会用一整块透明区域吞掉用户下面的划词。真缩进任务栏时窗口不在屏幕上，
 * 返回 null（不参与避让，也不拦手势）。
 */
function panelScreenRect(record) {
  if (record.ui.taskbarMinimized === true) return null
  const rect = record.panel.rect
  if (rect === null) return null
  if (record.ui.minimized) {
    const header = Math.min(rect.height, Math.round(PANEL.headerHeight * record.panel.scale))
    return { ...rect, width: rect.width, height: header }
  }
  return rect
}

/**
 * 建一扇原生窗口（callbacks 闭包引用它自己的 record，互不干扰）。
 *
 * className 必须每扇唯一：窗口类注册是全局的，同名第二次注册会复用第一个实例的
 * 窗口过程——两扇窗口的点击/绘制会串到同一份状态上（[踩过]）。
 */
function createPanelWindow(record) {
  const window = createNativeWindow({
    api,
    gdi,
    className: 'DshSelMainWnd-' + record.id,
    title: '悬浮助手',
    // 缩放下限（DIP）：再小布局就没法看了
    minSize: { width: 260, height: 200 },
    initialState: record.ui,
    onPaint(painter, width, height, data, scale) {
      paintPanel(painter, width, height, data, scale)
    },
    onHitTest(x, y) {
      return hitZone(record, x, y)
    },
    onHover(x, y, data) {
      const scale = window.scale()
      if (x < 0) {
        const changed = data.hover !== -1 || data.hoverButton !== null
        data.hover = -1
        data.hoverButton = null
        return changed
      }
      const button = y / scale < 44 ? panelHit(x / scale, y / scale, data, currentPanelSize(record).width) : null
      const next = button === 'body' ? null : button
      if (next !== data.hoverButton) {
        data.hoverButton = next
        return true
      }
      return false
    },
    onMouseDown() {
      // 拖动交给标题栏（HTCAPTION），客户区一律按点击处理
      return 'click'
    },
    onDragEnd(x, y) {
      record.panel.position = { x, y }
    },
    onResized(width, height, data, byUser) {
      // 创建期（窗口是 10×10 的占位尺寸）与隐藏期都会收到 WM_SIZE，不能当作用户改过大小
      // ——踩过：把创建期的 10×10 记成"用户尺寸"，回答窗口直接以 10×10 打开。
      if (record.panel.mode === 'hidden') return
      const s = window.scale()
      if (width < 200 * s || height < 150 * s) return
      // 矩形始终跟着真实尺寸走（对外汇报、避让、输入条定位都靠它）。
      if (record.panel.rect !== null) record.panel.rect = { ...record.panel.rect, width, height }
      // 但**尺寸记忆**只认用户拖出来的那次：从任务栏还原、换缩放、程序自己 show() 都会
      // 送来 WM_SIZE，把它们记成"用户尺寸"就把卡片锁死在错的大小上（实测 150% 下还原的
      // 那一次把 316×383 记成了用户尺寸，之后每张开卡都只有那么大）。
      if (byUser !== true) {
        syncAskBar(record)
        return
      }
      // 只记 DIP：物理像素一换缩放/换屏就不成立。显示时按目标屏现算，见 applyPanelMode。
      const dip = panelDipSize({ width, height }, s)
      if (dip === null) return
      record.panel.size = dip
      preferredPanelSize = dip
      syncAskBar(record)
    },
    onMoved(x, y) {
      // 原生拖动（标题栏）之后同步位置，避免下一次重绘把窗口拉回去。
      if (record.panel.mode === 'hidden') return
      // 缩在任务栏里时系统会把窗口挪到 -32000（哨兵坐标），不能当用户拖动记下来
      if (record.ui.taskbarMinimized === true || x <= -30000 || y <= -30000) return
      record.panel.position = { x, y }
      if (record.panel.rect !== null) record.panel.rect = { ...record.panel.rect, x, y }
      syncAskBar(record)
    },
    onZOrderChanged() {
      // 点标题栏时系统会把卡片抬到最前，输入条就被盖住了（看着像"消失"，一拖又回来）。
      syncAskBar(record)
    },
    onClosed() {
      // 用户从任务栏右键关掉窗口：主进程跟着收尾，别留死记录。
      closePanel(record)
    },
    onClick(x, y, data) {
      try {
        return clickPanel(record, x / window.scale(), y / window.scale(), data)
      } catch (error) {
        reportError('click', error)
        return false
      }
    },
    onRightClick() {
      return false
    },
    onWheel(delta, data) {
      if (data.mode !== 'panel') return false
      const maxScroll = Math.max(0, data.contentHeight - data.viewHeight)
      const next = Math.min(maxScroll, Math.max(0, data.scroll - Math.sign(delta) * 60))
      if (next === data.scroll) return false
      data.scroll = next
      return true
    },
    onDpiChanged(scale, suggested) {
      // 换缩放（设置里切比例、或卡片被拖到另一块缩放不同的屏）之后必须整块重排：
      // 窗口已经按系统建议矩形换了物理尺寸（见 native/window.mjs 的 WM_DPICHANGED），
      // 但它对应的 DIP 尺寸可能和"用户/设计想要的那个"不同，位置也要按新屏再夹一次。
      // applyPanelMode 的唯一真值是 DIP，重走一遍就同时修好尺寸与位置。
      if (record.panel.mode !== 'hidden') applyPanelMode(record, record.panel.mode)
    },
    onMinimized() {
      // 系统把窗口收进任务栏：屏幕上的矩形没了，划词手势不要再避开它。
      record.ui.taskbarMinimized = true
      record.ui.hoverButton = null
      record.ui.hover = -1
    },
    onRestored() {
      // 从任务栏回来（点任务栏按钮或 API）：清标志并重画，分层窗口的内容要重新提交。
      record.ui.taskbarMinimized = false
      record.ui.hoverButton = null
      record.ui.hover = -1
      if (record.panel.mode === 'hidden') {
        refreshPanel(record)
        return
      }
      // 缩在任务栏里这段时间可能换过缩放（系统不会给最小化窗口发 WM_DPICHANGED），
      // 所以还原时按 DIP 真值重排一次，而不是把旧物理矩形原样贴回去——否则卡片会停在
      // "小一号"上（实测 125%→150% 后仍是 475×575，DIP 只剩 316×383）。
      setTimeout(() => {
        if (!panelReady(record) || record.ui.taskbarMinimized === true) return
        applyPanelMode(record, record.panel.mode)
      }, 0)
    },
    onError(error) {
      reportError('panel-window', error)
    },
  })
  if (window === null) return null
  window.create()
  window.hide()
  record.window = window
  nativeWindows.add(window)
  return window
}

/** 新建一扇回答窗口（创建后不可见，登记进 panels）。 */
function createPanel() {
  if (api === null || gdi === null || !gdiReady) return null
  panelSeq += 1
  const record = {
    id: panelSeq,
    ui: createPanelUi(),
    panel: { mode: 'hidden', rect: null, scale: 1, position: null, size: null },
    window: null,
    run: null,
    /** 这张卡当前绑的选区（继续追问时复用；关闭窗口即释放）。 */
    selection: null,
    /** 问一问的宿主会话 id；为 null 时下一次提问按首问处理。 */
    askSessionId: null,
    /** 这张卡下一次首问的模式：quick | deep。 */
    askMode: 'quick',
    /** 用户显式选择的文件（L3）；只读首 400 行，追问沿用。 */
    filePath: null,
    /** 这次选区来源的 exe basename，用于 L2 授权记忆。 */
    consentKey: '',
    copyFeedbackTimer: null,
    createdAt: Date.now(),
  }
  if (createPanelWindow(record) === null) return null
  // 任务栏按钮的文案（这扇窗缩进任务栏时用户看到的就是它）
  record.window.setTitle(panelTitle(record.ui.action))
  panels.push(record)
  if (panels.length > MAX_PANELS) {
    const oldest = panels
      .filter((item) => item !== record)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    if (oldest !== undefined) closePanel(oldest)
  }
  return record
}

/**
 * 取一扇能装下这次动作的窗口：同文同动作已有 → 复用；否则新建。
 * 建不出来（系统级划词不可用）返回 null。
 */
function panelForAction(action, selection) {
  const text = selection === null || selection === undefined ? '' : selection.text
  const reused = findReusablePanel(action, text)
  if (reused !== null) return reused
  return createPanel()
}

/** 窗口是否可用。 */
function panelReady(record) {
  return record !== null && record !== undefined && record.window !== null && record.window.isAlive()
}

/** 窗口的实际尺寸（DIP）+ 缩放。 */
function currentPanelSize(record) {
  const ready = panelReady(record)
  const fallbackScale = record === null || record === undefined ? 1 : (record.panel.scale || 1)
  const scale = ready ? record.window.scale() : fallbackScale
  // 尺寸直接问系统（bounds），不读 state 缓存：原生缩放、DPI 变化、UpdateLayeredWindow
  // 都会悄悄改窗口，缓存在那之后会小一截。命中区一偏小，卡片右侧/下侧就多出一条
  // "拉伸边"——点下去直接进系统的缩放循环，标题栏按钮（关闭/折叠）全都没反应。
  const live = ready ? record.window.bounds() : null
  const size = live ?? (ready ? record.window.size() : { width: MODES.panel.width * scale, height: MODES.panel.height * scale })
  return { scale, width: Math.max(1, size.width) / scale, height: Math.max(1, size.height) / scale }
}

/**
 * 窗口的命中区（物理 → 语义）。
 *
 * 区在 ui.mjs 的 panelHitZone 里（纯函数、可单测）：**四边 + 四角，八个方向都能
 * 用鼠标拖着改大小**。优先级是 标题栏按钮 / 页脚「停止」 > 缩放手柄 > 标题栏拖动 >
 * 客户区——上边最外面 6 DIP 是缩放手柄，再往下才轮到 HTCAPTION 拖动，两者不打架。
 */
function hitZone(record, x, y) {
  const { scale, width, height } = currentPanelSize(record)
  return panelHitZone(x / scale, y / scale, record.ui, width, height)
}

/** 标题栏上的点击（折叠 / 最小化到任务栏 / 复制 / 关闭 / 停止）。 */
function clickPanel(record, cssX, cssY, data) {
  const hit = panelHit(cssX, cssY, data, currentPanelSize(record).width)
  if (hit === 'fold') {
    toggleFold(record)
    return true
  }
  if (hit === 'min') {
    minimizeToTaskbar(record)
    return true
  }
  if (hit === 'copy') {
    void copyAnswer(record)
    return true
  }
  if (hit === 'deep') {
    openAskBarFor(record, 'deep', true)
    return true
  }
  if (hit === 'ask') {
    openAskBarFor(record)
    return true
  }
  if (hit === 'file') {
    // 选文件是异步的（对话框开着的时候宿主不能停），这里不 await。
    if (record.ui.action === 'ask') void pickFileFor(record).catch((error) => reportError('pick-file-for', error))
    return true
  }
  if (hit === 'close') {
    closePanel(record)
    return true
  }
  if (hit === 'stop') {
    void stopRun(record)
    return true
  }
  return true
}

/** 把一扇窗口的状态推给它的原生窗口并重绘。 */
function refreshPanel(record) {
  if (!panelReady(record)) return
  record.window.setState({
    mode: record.ui.mode,
    dark: record.ui.dark,
    hover: record.ui.hover,
    hoverButton: record.ui.hoverButton,
    action: record.ui.action,
    source: record.ui.source,
    sourceLabel: record.ui.sourceLabel,
    question: record.ui.question,
    askTurn: record.ui.askTurn,
    answer: record.ui.answer,
    context: record.ui.context,
    status: record.ui.status,
    error: record.ui.error,
    copyFeedback: record.ui.copyFeedback,
    scroll: record.ui.scroll,
    contentHeight: record.ui.contentHeight,
    viewHeight: record.ui.viewHeight,
    stopBox: record.ui.stopBox,
    askBox: record.ui.askBox,
    minimized: record.ui.minimized,
    taskbarMinimized: record.ui.taskbarMinimized,
    askInput: record.ui.askInput === true,
  })
}

/**
 * 显示并定位一扇窗口。
 *
 * 位置优先级：用户手动拖过的位置（这扇窗自己的）→ 跟随这次选区 → 与已有窗口
 * 错开（见 placePanelBySelection 的 occupied）。尺寸沿用用户最近一次手动改过的大小。
 */
function applyPanelMode(record, mode) {
  if (!panelReady(record)) return null
  if (mode === 'hidden') {
    hidePanel(record)
    return null
  }
  // 缩在任务栏里的窗口要显示：先还原，否则 Show/SetWindowPos 拉不回它
  if (record.ui.taskbarMinimized === true) restoreFromTaskbar(record)
  record.ui.dark = systemDark()
  const css = MODES[mode]
  const anchor = state.selection !== null ? { x: state.selection.x, y: state.selection.y } : null
  // 这扇卡要落在哪块屏上：优先它自己的位置（重新显示时它不会去别处），首次显示才跟选区。
  // 之前一律按"选区所在屏"取缩放：卡片被拖到另一块缩放不同的屏上之后，尺寸与避让都
  // 还按旧屏算，跨屏那一下会偏一截。
  const target = record.panel.position ?? anchor
  const work = target !== null ? workAreaForPoint(api, target.x, target.y) : primaryWorkArea(api)
  let scale = target !== null
    ? monitorScaleForPoint(api, target.x, target.y)
    : monitorScaleForPoint(api, (work.left + work.right) / 2, (work.top + work.bottom) / 2)
  // 尺寸的唯一真值是 DIP（用户拖过的 > 全局沿用 > 设计尺寸）；物理像素按落点那块屏现算。
  // 存物理像素的后果：换缩放后同一串数字变成另一个 DIP 尺寸——150% 下 380×460 的设计
  // 尺寸只剩 317×383，字挤在一起、右下留白（实测踩过）。
  const dipSize = record.panel.size ?? preferredPanelSize ?? { width: css.width, height: css.height }
  /** 把 DIP 尺寸落到具体矩形上：夹回工作区、按已有窗口避让。 */
  const layoutAt = (atScale, atWork) => {
    const pixels = panelPixelSize(dipSize, atScale) ?? { width: Math.round(css.width * atScale), height: Math.round(css.height * atScale) }
    const width = Math.min(Math.round(pixels.width), Math.max(240, atWork.right - atWork.left))
    const height = Math.min(Math.round(pixels.height), Math.max(180, atWork.bottom - atWork.top))
    const occupied = panels
      .filter((item) => item !== record)
      .map(panelScreenRect)
      .filter((rect) => rect !== null)
    const base = record.panel.position ?? placePanelBySelection({
      workArea: atWork,
      selection: anchor,
      width,
      height,
      gap: 12,
      occupied,
    })
    const x = Math.min(Math.max(base.x, atWork.left), Math.max(atWork.left, atWork.right - width))
    const y = Math.min(Math.max(base.y, atWork.top), Math.max(atWork.top, atWork.bottom - height))
    return { x, y, width, height, scale: atScale }
  }
  let geometry = layoutAt(scale, work)
  // 卡片最终落在另一块缩放不同的屏上：按那扇屏重算一次（尺寸与夹取都跟着变）。
  const landedX = geometry.x + geometry.width / 2
  const landedY = geometry.y + geometry.height / 2
  const landedScale = monitorScaleForPoint(api, landedX, landedY)
  if (Math.abs(landedScale - scale) > 0.01) {
    geometry = layoutAt(landedScale, workAreaForPoint(api, landedX, landedY))
    scale = landedScale
  }
  const { x, y, width, height } = geometry

  record.ui.mode = mode
  record.panel.mode = mode
  record.panel.scale = scale
  record.panel.rect = { x, y, width, height }
  record.panel.position = { x, y }
  if (mode === 'panel') record.ui.scroll = 0
  refreshPanel(record)
  record.window.show(x, y, width, height)
  return { x, y, width, height, scale, mode }
}

/** 隐藏一扇窗口（保留 record 与内容；关窗用 closePanel）。 */
function hidePanel(record) {
  closeAskBarFor(record)
  // 任务栏里还缩着一扇的话先还原再藏，不然 ShowWindow(SW_HIDE) 之后它仍记着"最小化"
  if (panelReady(record) && record.ui.taskbarMinimized === true) {
    record.window.restoreFromTaskbar()
    record.ui.taskbarMinimized = false
  }
      if (panelReady(record)) record.window.hide()
  record.panel.mode = 'hidden'
  record.ui.mode = 'hidden'
  sweepStrayWindows()
}

/** 隐藏所有窗口（/window 的 hidden 与手势之外的全局收起用）。 */
function hideAllPanels() {
  for (const record of panels) hidePanel(record)
  sweepStrayWindows()
}

/**
 * 清扫"记录已经不管、窗口却还活着"的游离窗。
 *
 * 踩过：卡片折叠/最小化之后进入 mode:'hidden' + record.window=null，但原生窗口没被销毁，
 * 屏幕上留一条点不动也关不掉的条。任何 hide/close 之后都扫一遍，宁可多关一次。
 */
function sweepStrayWindows() {
  for (const window of [...nativeWindows]) {
    const owned = panels.some((record) => record.window === window)
    if (owned) continue
    try {
      window.destroy()
    } catch (error) {
      reportError('sweep-window', error)
    }
    nativeWindows.delete(window)
  }
}

/**
 * 把所有可见窗口按当前状态重绘一遍。
 *
 * 现在最需要它的时刻是"公式渲染器刚加载完"：回答里的 LaTeX 在 MathJax 就绪前只能先画原始
 * TeX，就绪后得有人触发一次重绘才会变成排版好的公式。
 */
function refreshAllPanels() {
  for (const record of panels) {
    if (record.panel.mode === 'hidden' || record.window === null || record.ui.taskbarMinimized === true) continue
    refreshPanel(record)
  }
}

/**
 * 关掉一扇窗口：先停流，再销毁原生窗口，最后从 panels 移除。
 *
 * 「关闭」与「折叠」是两件事：关闭 = 这扇窗没了（下次动作重新开）；折叠 =
 * 还在，只是收成标题条（见 toggleFold）。最小化到任务栏见 minimizeToTaskbar。
 */
function closePanel(record) {
  abortPanelRun(record)
  closeAskBarFor(record)
  // 对话框是挂在隐形 owner 上的独立进程：卡片关掉必须把它取消，否则它会留在最上层，
  // 选完的路径也只能丢掉（曾经表现为"A 卡关了，那条对话还挂在屏幕上"）。
  if (record.picking === true) cancelFilePicker()
  const askSessionId = record.askSessionId
  record.askSessionId = null
  if (typeof askSessionId === 'string' && askSessionId !== '') {
    void fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/ask/side/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: askSessionId }),
    }).catch((error) => reportError('ask-close', error))
  }
  record.selection = null
  if (record.copyFeedbackTimer !== null) {
    clearTimeout(record.copyFeedbackTimer)
    record.copyFeedbackTimer = null
  }
  if (panelReady(record)) record.window.destroy()
  if (record.window !== null) nativeWindows.delete(record.window)
  record.window = null
  record.panel.mode = 'hidden'
  record.ui.mode = 'hidden'
  const index = panels.indexOf(record)
  if (index !== -1) panels.splice(index, 1)
}

/**
 * 折叠 / 展开（自绘标题条，窗口还在屏幕上）。
 *
 * **不改窗口尺寸**：只切换 ui.minimized 并重绘——折叠时只画顶部标题条，其余像素
 * 保持透明（分层窗口的透明像素本来就不接收鼠标），所以既能"收起来"、又不触发
 * GETMINMAXINFO 的最小高度限制，展开时也不用重新摆位置。
 */
function toggleFold(record) {
  // 折叠成标题条时输入条必须一起收：它是一扇独立窗，不会跟着折叠。
  closeAskBarFor(record)
  record.ui.minimized = record.ui.minimized !== true
  record.ui.hoverButton = null
  record.ui.hover = -1
  refreshPanel(record)
}

/**
 * 真·最小化到 Windows 任务栏。
 *
 * 与折叠的区别：窗口从屏幕上消失、任务栏多出一个按钮（系统级最小化），点按钮回来。
 * 窗口第一次最小化时才挂任务栏（见 native/window.mjs 的 setTaskbarPresence），
 * 平时仍是工具窗，不占任务栏。
 */
function minimizeToTaskbar(record) {
  if (!panelReady(record)) return false
  if (record.ui.taskbarMinimized === true) return true
  closeAskBarFor(record)
  const ok = record.window.minimizeToTaskbar() === true
  if (!ok) return false
  record.ui.taskbarMinimized = true
  record.ui.hoverButton = null
  record.ui.hover = -1
  return true
}

/** 从任务栏恢复一扇窗口（任务栏按钮点击走系统默认还原，这里给 /window 等接口用）。 */
function restoreFromTaskbar(record) {
  if (!panelReady(record)) return false
  if (record.ui.taskbarMinimized !== true) return false
  record.ui.taskbarMinimized = false
  record.ui.hoverButton = null
  record.ui.hover = -1
  const ok = record.window.restoreFromTaskbar() === true
  // 还原后把窗口放回原位：最小化期间系统会把窗口挪到 -32000，不重新 show 就会停在屏幕外
  const rect = record.panel.rect
  const good = rect !== null && rect.width > 0 && rect.height > 0 && rect.x > -30000 && rect.y > -30000
  if (good) {
    record.window.show(rect.x, rect.y, rect.width, rect.height)
  } else {
    record.panel.position = null
    record.panel.rect = null
    applyPanelMode(record, 'panel')
    return ok
  }
  refreshPanel(record)
  return ok
}

/** 停下某扇窗口正在跑的流。 */
function abortPanelRun(record) {
  if (record === null || record === undefined) return
  record.run?.abort?.()
  record.run = null
}
// ---------------------------------------------------------------- 划词菜单窗口

const menuUi = { dark: true, hover: -1 }

const menuWindow = api !== null && gdi !== null
  ? createNativeWindow({
      api,
      gdi,
      className: 'DshSelMenuWnd',
      title: '悬浮助手菜单',
      initialState: menuUi,
      onPaint(painter, width, height, data, scale) {
        paintMenu(painter, width, height, data, scale)
      },
      onHitTest() {
        // 菜单整块都要能点：返回 client（返回 caption 收不到 WM_LBUTTONDOWN）
        return 'client'
      },
      onHover(x, y, data) {
        const scale = menuWindow.scale()
        if (x < 0) {
          const changed = data.hover !== -1
          data.hover = -1
          return changed
        }
        const row = menuRowAt(x / scale, y / scale)
        if (row !== data.hover) {
          data.hover = row
          return true
        }
        return false
      },
      onClick(x, y, data) {
        const scale = menuWindow.scale()
        const row = menuRowAt(x / scale, y / scale)
        void data
        if (row >= 0) runMenuAction(menuActionOf(row))
        return true
      },
      onError(error) {
        reportError('menu-window', error)
      },
    })
  : null

// 菜单窗口在这里创建（不可见），之后按需 show / hide；回答窗口是懒创建的（openPanel 时）。
if (menuWindow !== null) {
  menuWindow.create()
  menuWindow.hide()
}

// 公式渲染（MathJax）是懒加载的：进程一起来就先拉一次，加载完成后把已经画出来的窗口重绘
// 一遍——否则第一次划词时那几百毫秒里公式只能先显示原始 TeX。加载失败也不影响文字回答。
void ensureMathReady().then((ready) => {
  if (ready) refreshAllPanels()
})

function menuReady() {
  return menuWindow !== null && menuWindow.isAlive()
}

/**
 * 把一次 UIA 探针结果写进这次选区：**选区文字**写 `selection.text`，
 * **选区所在的段落**写 `selection.context`。空结果保持原样（安静降级）。
 *
 * @param source - 这一步叫什么（uia-prefetch / uia-fresh）：只用于诊断——回答是不是
 *   "UIA 读到的"、还是退到了剪贴板，看 `lastResolve.source` 就知道。
 */
function applyProbe(selection, result, source) {
  if (result === null || result === undefined) return
  if (typeof result.selection === 'string' && result.selection.trim() !== '') {
    if (typeof selection.text !== 'string' || selection.text.trim() === '') selection.textSource = source
    selection.text = result.selection
  }
  if (typeof result.text === 'string' && result.text !== '') {
    selection.context = result.text
    selection.contextUnit = result.unit
    selection.contextState = 'ready'
  } else if (selection.contextState === 'reading') {
    selection.contextState = 'none'
  }
}

/**
 * 手势落下时的 UIA 预读：**不注入按键、不碰剪贴板**。
 *
 * 一次调用同时拿到"选中的是哪段文字"与"它所在的段落"——后者是给 agent 的上下文，
 * 前者是菜单项点下去之后真正要处理的东西。读不到就保持空串（安静降级）。
 *
 * @param selection - 这次划词的锚点对象。
 * @returns 在途的 promise（点菜单项时还要等它）。
 */
/**
 * 前台是不是 Windows 桌面/任务栏（explorer.exe）。
 *
 * UIA 只给类名（#32769 等），而 WPS PDF、部分 Office 窗口也用同样的类名——只看类名会把
 * 它们误判成桌面，导致在这些应用里划词永远不弹菜单。这里再核一次进程：只有前台真是
 * explorer.exe 才敢把"空选区"当成"没在选文字"。
 */
function foregroundIsExplorer() {
  if (api === null) return true
  try {
    const hwnd = api.GetForegroundWindow()
    if (!hwnd || hwnd === 0) return true
    const pid = Number(windowPid(api, hwnd))
    if (!Number.isFinite(pid) || pid <= 0) return true
    const image = String(processImage(api, pid) ?? '').toLowerCase()
    return image.endsWith('\\explorer.exe')
  } catch {
    return true
  }
}

/** OCR 兜底只对"内容类"应用开放：能正常选中文本的应用不该被截屏识别抢走。 */
const OCR_PROCESS_HINTS = [
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe',
  'wps.exe', 'wpspdf.exe', 'et.exe', 'acrobat.exe', 'acrord32.exe',
  'photos.exe', 'microsoft.photos.exe', 'snippingtool.exe', 'snipaste.exe',
  'imageglass.exe', 'honeyview.exe', 'code.exe',
]

/**
 * 手势框出的屏幕矩形（物理像素），给 OCR 用。
 *
 * 只认"按下点 → 松开点"的外接框；太小的框（<48px）不识别——那多半是单击/双击误判。
 */
function ocrRectForGesture(gesture, selection) {
  if (gesture === null || gesture === undefined) return null
  const at = gesture.at ?? {}
  const press = gesture.press ?? null
  const x1 = Number(press?.x ?? selection?.x)
  const y1 = Number(press?.y ?? selection?.y)
  const x2 = Number(at.x)
  const y2 = Number(at.y)
  if (![x1, y1, x2, y2].every((value) => Number.isFinite(value))) return null
  const x = Math.min(x1, x2)
  const y = Math.min(y1, y2)
  const width = Math.abs(x2 - x1)
  const height = Math.abs(y2 - y1)
  if (width < 48 || height < 48) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** 前台应用值不值得为它跑一次 OCR：内容类应用（浏览器/PDF/看图/截图）或明确复制到了非文本。 */
function foregroundAllowsOcr(confirm) {
  if (confirm !== null && Number(confirm?.writes) > 0) return true
  if (api === null) return false
  try {
    const hwnd = api.GetForegroundWindow()
    if (!hwnd || hwnd === 0) return false
    const pid = Number(windowPid(api, hwnd))
    if (!Number.isFinite(pid) || pid <= 0) return false
    const image = String(processImage(api, pid) ?? '').toLowerCase()
    const base = image.slice(image.lastIndexOf('\\') + 1)
    return OCR_PROCESS_HINTS.includes(base)
  } catch {
    return false
  }
}

/**
 * 用 Windows OCR 读回选区里的文字（截图/图片/扫描件专用）。
 *
 * @returns {{text: string, source: 'ocr'}|null}
 */
async function resolveOcrSelection(selection) {
  const rect = selection?.ocrRect
  if (rect === undefined || rect === null) return null
  const result = await ocrScreenRect(api, gdi, rect, { timeoutMs: 9000 })
  if (!result.ok || result.text.trim() === '') return null
  return { text: clampSelection(result.text, MAX_TEXT).trim(), source: 'ocr' }
}

function startProbe(selection) {
  selection.contextState = 'reading'
  if (contextReader === null) {
    selection.contextState = 'disabled'
    state.lastProbe = { state: 'disabled', at: Date.now() }
    return Promise.resolve(null)
  }
  const pending = contextReader.probe(
    { x: selection.x, y: selection.y },
    { retries: MENU_PROBE_RETRIES, press: selection.press, shell: foregroundIsExplorer() },
  )
  selection.pending = pending
  void pending
    .then((result) => {
      applyProbe(selection, result, 'uia-prefetch')
      if (result === null) {
        state.lastProbe = { state: 'none', at: Date.now(), stats: contextReader.stats() }
        return
      }
      state.lastProbe = {
        state: 'ready',
        selectionLength: typeof result.selection === 'string' ? result.selection.length : 0,
        contextLength: typeof result.text === 'string' ? result.text.length : 0,
        unit: result.unit,
        className: result.className,
        /** 这条 TextPattern 是从"点上的元素"还是"焦点元素"读到的。 */
        source: result.source,
        /** 这次手势（按下点/松开点）碰到这段选区了吗（false = 落在别处，多半是上次留下的）。 */
        atGesture: result.atGesture ?? null,
        candidates: result.candidates,
        at: Date.now(),
        stats: contextReader.stats(),
      }
    })
    .catch((error) => {
      selection.contextState = 'error'
      reportError('probe', error)
    })
  return pending
}

/** 等一个 promise 最多 ms 毫秒；超时返回字符串 'timeout'（定时器不留痕）。 */
async function waitFor(promise, ms) {
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 等一小会儿（定时器 unref：不拖住进程退出）。 */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 手势落下后等一个"弹不弹"的结论。
 *
 * **两级预算**：先在 budgetMs 内等探针（正常的探针 10–30ms 就回来了，这一级几乎用不满）；
 * 超时说明它只是**慢**（跨进程 provider、无障碍树刚被焐热、系统一时繁忙），不是没有答案
 * ——探针本身还在跑，所以再宽限一段（budgetMs 的三倍，上限 1s）等它的结论。只有宽限期
 * 也用完才按"未知"处理：拖选保留剪贴板兜底；双击没有选区证据就不弹。
 *
 * 为什么要有宽限期：跳过去直接照弹的话，用户"在别处随便一拖"刚好撞上一次慢探针，
 * 菜单又会冒出来——那正是"选中一次之后菜单甩不掉"的另一条来路。宽限期的代价只是
 * 结论晚几十毫秒（探针一回来就出菜单），而不是"菜单变慢"。
 *
 * @param previous - 上一次菜单收起时绑的那段文字（见 policy.mjs 的 menuDecision）。
 * @param pressSnapshot - "按下那一刻"那张快照（`{ at, x, y, pending, result, driftPx }`，见
 *   startPressProbe）；没拍/关掉了传 null。它只用来回答"这次手势有没有选出新东西"，
 *   其中的 `driftPx`（读数到手时指针离按下点多远）用来剔掉"拍晚了"的快照——浏览器里
 *   UIA 首查慢，拖完才回来的读数会把这次手势自己选出来的文字当成"按下就已经选着"。
 * @returns `{ open, reason }`（见 policy.mjs 的 menuDecision）。
 */
async function decideMenu(pending, budgetMs, previous, kind, pressSnapshot = null, lastShownAt = 0, point = null) {
  // `MENU_DECIDE_MS=0` 是"手势一到就弹、不做任何过滤"的逃生舱：连剪贴板核实都不要走。
  if (budgetMs <= 0) return unknownFallback(kind)
  if (contextReader === null) return menuDecision(null, previous, { kind, lastShownAt })
  // 按下快照通常早就回来了（它在按下那一刻就发出去了），这一步几乎不花时间；只给
  // PRESS_WAIT_MS 这么多宽限——超时就当没拍到（少一条判据，不拦这次划词）。
  const pressPending = pressSnapshot?.pending ?? null
  const pressResult = pressPending === null || pressPending === undefined
    ? null
    : await waitFor(pressPending, Math.min(budgetMs, PRESS_WAIT_MS))
  const pressProbe = pressResult === 'timeout' || pressResult === null || pressResult === undefined
    ? null
    : { ...pressResult, driftPx: snapshotDrift(pressSnapshot) }
  const first = await waitFor(pending, budgetMs)
  if (first !== 'timeout') {
    // 双击最常见的失败形态不是"探针慢"，而是它**很快给了一个空答复**（ready 但
    // selectionLength=0）：第二下松手时词选区还没生效。加大预算没用——探针早就回来了，
    // 得等选区落定再读一次（同一坐标，只重试一次）。
    let result = first
    if (kind === 'double' && result !== null && (result.selection ?? '') === '' && point !== null) {
      if (DOUBLE_RECHECK_MS > 0) await delay(DOUBLE_RECHECK_MS)
      const rechecked = await waitFor(contextReader.probe(point, { retries: 1, shell: foregroundIsExplorer() }), 150)
      if (rechecked !== 'timeout' && rechecked !== null) result = rechecked
    }
    return menuDecision(result, previous, { kind, pressProbe, lastShownAt })
  }
  const grace = Math.min(1000, budgetMs * 3)
  const second = await waitFor(pending, grace)
  // 宽限期也用完：还是读不到 → open 为 null（交给剪贴板核实，见 confirmByClipboard）。
  if (second === 'timeout') return menuDecision(null, previous, { kind, reason: 'timeout', lastShownAt })
  return menuDecision(second, previous, { kind, pressProbe, lastShownAt })
}

/** 快照上量到的"读数到手时指针离按下点多远"（没量到给 null，policy 那边按可信处理）。 */
function snapshotDrift(pressSnapshot) {
  const drift = Number(pressSnapshot?.driftPx)
  return Number.isFinite(drift) ? drift : null
}

/**
 * UIA 判不了（`open: null`）时，用**剪贴板**核实一次"这次手势到底有没有选中文字"。
 *
 * 为什么只能靠剪贴板：办公套件（WPS 的 Qt 版最典型）整个窗口树里都没有文档的 TextPattern
 * ——实测 WPS PPT 的 UIA 树 376 个节点里只有两个功能区长条是文本控件，UIA 对"选没选中
 * 文字"无话可说。而 Ctrl+C 是**真的会说话**的：真选中文字就会复制出文字；拖动一个形状/
 * 窗口则什么都复制不出来（这正是"选中元素并拖动也弹菜单"的判别点）。
 *
 * 代价与边界都交给 selection.mjs 那几条规则（终端跳过、用户正在按 Ctrl+C 就不注入、只认
 * 前台窗口自己写的那次、用完把用户原来的文字放回去）；拿不准就**不表态**，由调用方退回
 * 老行为（见 policy.mjs 的 unknownFallback）。
 *
 * 核实成功时顺手把文字记进这次选区：点菜单项时就不用再复制一遍了。
 *
 * @param selection - 这次划词的锚点对象（核实成功会写入 `text` / `textSource`）。
 * @returns `{ state, reason, length, ...诊断 }`；state 是 `text`（复制出文字了）/
 *   `none`（复制出来的是别的格式、确认没在选文字）/ `unknown`（两轮核实仍超时：拿不准，
 *   调用方应退回 unknownFallback）/ `skipped`（跑不起来：终端、用户正在 Ctrl+C、或关掉了核实）。
 */
async function confirmByClipboard(selection) {
  if (!CONFIRM_BY_CLIPBOARD) return { state: 'skipped', reason: 'disabled', length: 0 }
  const attempt = () =>
    captureSelection(api, {
      checkOwner: OWNER_CHECK,
      // 这次注入是我们自己发的：没复制出文字（典型：把形状/窗口复制走了）时把用户原来的
      // 文字放回去，免得他们的剪贴板被我们弄丢（见 selection.mjs 的 restoreWhenEmpty）。
      restoreWhenEmpty: true,
      textOnly: true,
      timeoutMs: CONFIRM_TIMEOUT_MS,
      onReport: (report) => {
        state.lastConfirm = report
      },
    })
  // 双击的第二下松手时词选区未必已经生效：先静置一会儿再注入 Ctrl+C。
  if (CONFIRM_SETTLE_MS > 0) await delay(CONFIRM_SETTLE_MS)
  let captured = await attempt()
  let report = state.lastConfirm
  let reason = typeof report?.reason === 'string' ? report.reason : 'timeout'
  // 首轮"超时且剪贴板一次都没被写过"再给一次机会：浏览器/PDF 里无障碍树慢一拍时，
  // Ctrl+C 可能刚好赶在选区生效之前。首轮写过内容却没文字（复制了图片/形状）就不重试了
  // ——再按一次 Ctrl+C 结局一样。
  const wroteNothing = !(Number(report?.writes) > 0)
  if (captured === null && reason === 'timeout' && wroteNothing && CONFIRM_RETRY_MS >= 0) {
    if (CONFIRM_RETRY_MS > 0) await delay(CONFIRM_RETRY_MS)
    captured = await attempt()
    report = state.lastConfirm
    reason = typeof report?.reason === 'string' ? report.reason : 'timeout'
  }
  const detail = {
    writes: Number.isFinite(Number(report?.writes)) ? Number(report.writes) : null,
    owner: typeof report?.owner === 'string' ? report.owner : null,
    elapsedMs: Number.isFinite(Number(report?.elapsedMs)) ? Number(report.elapsedMs) : null,
    injected: report?.injected === true,
    userCopyObserved: report?.userCopyObserved === true,
    foregroundClass: typeof report?.foregroundClass === 'string' ? report.foregroundClass : '',
  }
  if (captured !== null && captured.trim() !== '') {
    const text = clampSelection(captured, MAX_TEXT)
    selection.text = text
    selection.textSource = 'clipboard-confirm'
    return { state: 'text', reason: 'ok', length: text.length, formats: report?.formats ?? [], ...detail }
  }
  if (reason === 'terminal' || reason === 'user-copy') return { state: 'skipped', reason, length: 0, ...detail }
  // 重试后仍然超时：**不知道**有没有选中文字（不是"确认没有"）。以前把它折成 none，
  // 于是拖选连 unknownFallback 的兜底都被吞掉——现在单独一档，交给调用方按 kind 兜底。
  if (reason === 'timeout') return { state: 'unknown', reason, length: 0, formats: [], ...detail }
  return { state: 'none', reason, length: 0, formats: report?.formats ?? [], editor: report?.editor ?? null, ...detail }
}

/**
 * 剪贴板核实失败后再用 UIA 补读一次。
 *
 * Ctrl+C 注入经常会把无障碍树"焐热"：第一次探针读不到，按过一次 Ctrl+C 之后反而能读了。
 * 读到非空就当作"迟到的证据"（reason = selection-late）；读不到返回 null，由调用方退回
 * unknownFallback。
 *
 * @param selection - 这次划词的锚点对象（补读成功会写入 `text` / `textSource`）。
 * @returns 读到的文字（非空）或 null。
 */
async function reprobeSelection(selection) {
  if (contextReader === null) return null
  try {
    const result = await waitFor(
      contextReader.probe({ x: selection.x, y: selection.y }, { retries: 1, press: selection.press, shell: foregroundIsExplorer() }),
      220,
    )
    if (result === 'timeout' || result === null || result === undefined) return null
    applyProbe(selection, result, 'uia-late')
    const text = typeof selection.text === 'string' ? selection.text.trim() : ''
    return text === '' ? null : text
  } catch (error) {
    reportError('probe-late', error)
    return null
  }
}

/**
 * 用剪贴板复核选中的文字（只在"拖选"手势上做）。
 *
 * UIA 的 TextPattern 在 Chrome/PDF 这类应用里经常只交出选区的一部分（实测：拖选一整段
 * 公式文字，UIA 只给 39 个字），菜单和回答窗的「原文」就跟着短了。Ctrl+C 拿到的是应用
 * 自己定义的完整选区，所以以它为准：复核成功且内容不同就换掉；超时/没选区就保留 UIA
 * 结果（不阻塞、不丢词）。
 *
 * @param selection - 这次划词的锚点对象（`kind` 区分拖选/双击）。
 * @param resolved - `resolveSelection` 的结果 `{ text, source }`（可为 null）。
 * @returns `{ text, source }`；复核失败时原样返回 resolved。
 */
async function verifySelectionByClipboard(selection, resolved) {
  if (resolved === null || resolved === undefined) return resolved
  if (selection === null || selection === undefined) return resolved
  // 双击选词走 UIA 就够准（词边界由应用自己给）；只对拖选做复核，避免每次双击都注入按键。
  if (selection.kind !== 'drag') return resolved
  // 用户显式要求"只用 UIA、绝不碰剪贴板"时不做复核。
  if (TEXT_SOURCE === 'uia') return resolved
  const text = typeof resolved.text === 'string' ? resolved.text : ''
  if (text.trim() === '') return resolved
  try {
    const captured = await captureSelection(api, {
      checkOwner: OWNER_CHECK,
      restoreWhenEmpty: true,
      textOnly: true,
      timeoutMs: VERIFY_SELECTION_MS,
      onReport: (report) => {
        state.lastVerify = report
      },
    })
    const copied = typeof captured === 'string' ? captured.trim() : ''
    if (copied === '' || normalizeSelectionText(copied) === normalizeSelectionText(text)) return resolved
    state.lastVerify = {
      source: 'clipboard-verify',
      uiaLength: text.length,
      clipboardLength: copied.length,
      at: Date.now(),
    }
    return { text: copied, source: 'clipboard-verify' }
  } catch (error) {
    reportError('verify-selection', error)
    return resolved
  }
}

/** 比较两段选区文字时忽略空白差异（换行/空格由应用自己决定）。 */
function normalizeSelectionText(text) {
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * 显示划词菜单（带时限）。
 *
 * 只记「这次划在哪、到时候要处理哪段文字」：回答窗口的内容归它自己，绝不在弹菜单时被
 * 改写（踩过：这里顺手把 ui.source/answer/status 重置了，于是新划词后只要窗口重绘一次，
 * 就变成「显示新选中的文字 + 没有文本输出 + 就绪」。现在只有点解释/翻译才换内容）。
 *
 * @param selection - 这次划词的锚点对象；它的 text 可能还是空的（UIA 预读正在跑，点菜单
 *   项时才会等它）。
 */
function showMenu(selection) {
  if (!menuReady()) return null
  const x = selection.x
  const y = selection.y
  state.selection = selection
  menu.selection = selection
  menu.dark = systemDark()
  const css = MODES.menu
  const work = workAreaForPoint(api, x, y)
  const scale = monitorScaleForPoint(api, x, y)
  const width = Math.round(css.width * scale)
  const height = Math.round(css.height * scale)
  const px = Math.min(Math.max(x + GAP, work.left), Math.max(work.left, work.right - width))
  const py = Math.min(Math.max(y + GAP, work.top), Math.max(work.top, work.bottom - height))
  menu.visible = true
  menu.rect = { x: px, y: py, width, height }
  menu.scale = scale
  menu.anchor = { x, y }
  menu.hover = -1
  state.lastMenuShownAt = Date.now()
  menuWindow.setState({ dark: menu.dark, hover: -1 })
  menuWindow.show(px, py, width, height)
  if (menu.timer !== null) clearTimeout(menu.timer)
  menu.timer = setTimeout(() => {
    hideMenu('timeout')
  }, MENU_TIMEOUT_MS)
  menu.timer.unref?.()
  return menu.rect
}

/** 收起划词菜单（不影响回答窗口）。 */
function hideMenu(reason) {
  if (menu.timer !== null) {
    clearTimeout(menu.timer)
    menu.timer = null
  }
  if (menu.visible) {
    state.lastMenuDismiss = { reason, at: Date.now() }
    // 这个菜单绑的是哪段文字：菜单收起后，"手势没碰到 + 文字没变"的那次探针就是它。
    state.lastMenuSelection = typeof menu.selection?.text === 'string' ? menu.selection.text : ''
    // "最近一次菜单开关"的时刻：policy 用它区分"菜单还开着/刚看过"与"过了好一会儿又划
    // 同一段字"（STALE_REOPEN_MS 时间窗，见 policy.mjs 的 selection-reopen）。
    state.lastMenuShownAt = Date.now()
    menu.visible = false
    if (menuReady()) menuWindow.hide()
  }
  menu.rect = null
  menu.hover = -1
  menu.selection = null
}

// ---------------------------------------------------------------- 跑一轮 agent

/** 往"最近显示的那扇窗口"的页脚写一句回执（没有窗口就安静丢弃）。 */
function flashFeedback(text) {
  const record = activePanel()
  if (record !== null) setCopyFeedback(record, text)
}
async function copyAnswer(record) {
  if (record.ui.answer === '') {
    setCopyFeedback(record, '没有可复制的内容')
    return
  }
  let copied = false
  try {
    const { writeClipboardText } = await import('./win32.mjs')
    copied = writeClipboardText(api, record.ui.answer) !== false
  } catch (error) {
    reportError('copy', error)
  }
  setCopyFeedback(record, copied ? '已复制' : '复制失败')
}

/** 页脚回执（1.6s 后自动消失；每扇窗口各一个定时器）。 */
function setCopyFeedback(record, text) {
  if (record === null || record === undefined) return
  record.ui.copyFeedback = text
  refreshPanel(record)
  if (record.copyFeedbackTimer !== null) clearTimeout(record.copyFeedbackTimer)
  record.copyFeedbackTimer = setTimeout(() => {
    record.copyFeedbackTimer = null
    record.ui.copyFeedback = ''
    refreshPanel(record)
  }, text === '已复制' ? 1600 : 2400)
  record.copyFeedbackTimer.unref?.()
}

async function stopRun(record) {
  const sessionId = record.run?.sessionId
  const kind = record.run?.kind
  abortPanelRun(record)
  record.ui.status = 'done'
  refreshPanel(record)
  // 问一问的流由客户端断开即中止（宿主 res 'close' → controller.abort），不需要 /stop。
  if (kind === 'ask' || sessionId === undefined) return
  try {
    await fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
  } catch (error) {
    reportError('stop', error)
  }
}

/**
 * 把一扇回答窗口切到某一轮的初始状态并显示。
 *
 * @param record - 哪一扇窗口。
 * @param action - 解释 / 总结 / 翻译。
 * @param selection - 这次要处理哪段选区（菜单上绑的那一次）。
 * @param status - `reading`（正在读选区）/ `running` / `error`。
 * @param error - status 为 error 时的错误文案。
 */
function openPanel(record, action, selection, status, error = '') {
  abortPanelRun(record)
  record.ui.action = action
  record.window?.setTitle?.(panelTitle(action))
  record.selection = selection ?? null
  record.ui.question = ''
  record.ui.askTurn = 0
  // openPanel 只在"新开一张卡"时调用；追问不经过这里，所以这里清掉旧会话是对的。
  record.askSessionId = null
  record.filePath = null
  record.askMode = 'quick'
  record.consentKey = ''
  record.ui.source = selection === null || typeof selection.text !== 'string' ? '' : selection.text
  record.ui.sourceLabel = selection !== null && selection !== undefined && selection.textSource === 'ocr' ? '原文（OCR）' : '原文'
  record.ui.answer = ''
  record.ui.error = error
  record.ui.copyFeedback = ''
  record.ui.context = selection === null || typeof selection.context !== 'string' ? '' : selection.context
  record.ui.status = status
  record.ui.scroll = 0
  // 这扇窗口第一次显示时跟随选区放；之后沿用用户拖到的位置
  if (record.panel.mode === 'hidden') record.panel.position = null
  applyPanelMode(record, 'panel')
  refreshPanel(record)
}

/**
 * 解析"这次要处理的是哪段文字"。
 *
 * 优先级（`DSH_SELECTION_TEXT_SOURCE` 可整体改成只用某一种）：
 * 1. `selection.text` 已经有的（例如 `/simulate` 预置的文本）；
 * 2. 菜单弹出时就开始的 UIA 预读结果；
 * 3. 现补读一次 UIA（无障碍树这会儿已经热了，通常几毫秒就回来）；
 * 4. **剪贴板兜底**——注入一次 Ctrl+C 再读剪贴板。
 *
 * 第 4 条是全插件唯一会碰用户剪贴板的地方，而且只在用户**点了菜单按钮之后**、前三条
 * 都拿不到文字时才会走到：划词本身一次都不碰剪贴板。
 *
 * @param selection - 这次划词的锚点对象。
 * @returns `{ text, source }`（source 只用于诊断）：一个来源都拿不到时返回 null。
 */
async function resolveSelection(selection) {
  if (typeof selection.text === 'string' && selection.text.trim() !== '') {
    // 已经有了（/simulate 预置，或预读早于点击完成并写好了）：直接用。
    return { text: selection.text, source: selection.textSource === '' ? 'preset' : selection.textSource }
  }
  const attempts = []
  if (TEXT_SOURCE !== 'clipboard') {
    const prefetched = selection.pending === null || selection.pending === undefined ? null : await selection.pending
    applyProbe(selection, prefetched, 'uia-prefetch')
    attempts.push({ source: 'uia-prefetch', text: prefetched === null ? '' : prefetched.selection })
    if (prefetched === null && contextReader !== null) {
      const fresh = await contextReader.probe({ x: selection.x, y: selection.y }, { retries: CLICK_PROBE_RETRIES, shell: foregroundIsExplorer() })
      applyProbe(selection, fresh, 'uia-fresh')
      attempts.push({ source: 'uia-fresh', text: fresh === null ? '' : fresh.selection })
    }
  }
  const picked = pickSelection(attempts)
  if (picked !== null) return picked
  if (TEXT_SOURCE === 'uia') return null
  // 兜底：注入一次 Ctrl+C 读剪贴板（只在点了菜单按钮之后走这里）。
  const captured = await captureSelection(api, {
    checkOwner: OWNER_CHECK,
    onReport: (report) => {
      state.lastCapture = report
    },
  })
  const fallback = pickSelection([{ source: 'clipboard', text: captured === null ? '' : clampSelection(captured, MAX_TEXT) }])
  return fallback
}

/**
 * 点菜单项之后：解析选区 → 跑一轮。
 *
 * 每一轮都落在**自己那扇窗口**上：同文同动作已有窗口就复用，否则新建一扇——
 * 这样"先划一段翻译、再划另一段解释"两扇窗会同时留着。
 *
 * @param action - 解释 / 总结 / 翻译。
 * @param selection - 菜单上绑的那次选区。
 * @param isCurrent - 这次点击还是最新的吗（用户有没有紧接着又点了一次）。
 */
async function beginFromMenu(action, selection, isCurrent) {
  if (selection === null || selection === undefined) return
  state.selection = selection
  const record = panelForAction(action, selection)
  if (record === null) return
  // 先给反馈：解析最长要走一次剪贴板兜底，不能让用户"点了没反应"。
  openPanel(record, action, selection, 'reading')
  let resolved = null
  try {
    resolved = await resolveSelection(selection)
  } catch (error) {
    reportError('resolve', error)
    resolved = null
  }
  // UIA 可能只给半截：拖选手势再让剪贴板核一遍（Ctrl+C 拿到的才是应用认的完整选区）。
  if (resolved !== null) resolved = await verifySelectionByClipboard(selection, resolved)
  // 截图/扫描件没有文本层：前面都读不到时，最后让 OCR 试一次。
  if ((resolved === null || String(resolved.text ?? '').trim() === '') && selection.ocrRect !== undefined) {
    resolved = await resolveOcrSelection(selection)
  }
  state.lastResolve = {
    ok: resolved !== null,
    source: resolved === null ? '' : resolved.source,
    length: resolved === null ? 0 : resolved.text.length,
    at: Date.now(),
  }
  // 等待期间用户可能把这扇窗关了 / 又点了别的动作：这两种都不该再往里写。
  // 被后一次划词取代时，这扇卡还停在 'reading' 转圈、没人会再放它出来——直接收掉，
  // 否则屏幕上挂一张永远转圈的卡，还白占一个 maxPanels 名额。
  if (!isCurrent()) {
    if (panelReady(record)) closePanel(record)
    return
  }
  if (!panelReady(record)) return
  if (resolved === null) {
    const message = selection.ocrRect === undefined
      ? '未能读取选中的文字，请重新划词后再试'
      : '未能识别选区里的文字，请重新划词后再试'
    openPanel(record, action, selection, 'error', message)
    return
  }
  selection.text = resolved.text
  // 记录取词来源：OCR 读出来的要在面板原文标签上标出来（正常拖选的 ocrRect 只是候选框，
  // 不代表这次真的用了 OCR —— 这里只认 resolved.source）。
  if (resolved.source === 'ocr') selection.textSource = 'ocr'
  startRun(record, action, selection)
}

/** 点菜单项之后的串行队列（latest-wins）：解析选区 + 开跑。 */
let menuRunQueue = null

/**
 * 点菜单项（原生窗口的点击与 `/click` 验收端点共用）。
 *
 * 必须先取出"这个菜单绑的那次选区"再收菜单——`hideMenu` 会把 `menu.selection` 清掉。
 */
function runMenuAction(action) {
  const selection = menu.selection
  hideMenu('item-click')
  if (selection === null) return
  // 「问一问」：开一张置顶卡，由宿主 /ask/side 流式作答；不再往任何外部 Agent 注入。
  if (action === 'ask') {
    // 异步开卡：异常必须兜住并记到 lastAsk，否则 /status 里会残留上一次成功状态，
    // 排障时会被误导成"这次也成功了"。
    void askSelection(selection).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      state.lastAsk = {
        sourcePid: Number.isFinite(selection?.sourcePid) ? selection.sourcePid : null,
        mode: 'card-failed',
        stage: 'unexpected',
        reason: message,
        at: Date.now(),
      }
      reportError('ask', error)
      flashFeedback('问一问失败')
    })
    return
  }
  if (menuRunQueue === null) {
    menuRunQueue = createLatestQueue({
      run: (job, seq) => beginFromMenu(job.action, job.selection, () => menuRunQueue.isLatest(seq)),
      onError: (error) => reportError('menu-run', error),
    })
  }
  menuRunQueue.submit({ action, selection })
}

/**
 * 当前前台窗口属于哪个进程（取不到返回 0）。
 *
 * 「问一问」靠它分流：DSH 自己窗口里划的词落进**当前会话**，别的应用里划的词
 * 照旧开一条新会话。手势发生时记一次就够（点菜单时前台已经变成菜单窗口了）。
 * @returns 进程 id；读不到窗口时为 0。
 */
function foregroundPid() {
  try {
    const hwnd = api.GetForegroundWindow()
    if (hwnd === null || hwnd === undefined) return 0
    return Number(windowPid(api, hwnd)) || 0
  } catch {
    return 0
  }
}

/** 当前前台窗口的摘要（pid/标题），只给 `/status` 与分流判定留证据。 */
function probeForeground() {
  try {
    const hwnd = api.GetForegroundWindow()
    const hwndType = typeof hwnd
    if (hwnd === null || hwnd === undefined) return { pid: 0, title: '', ptr: String(hwnd), hwndType }
    const pid = Number(windowPid(api, hwnd)) || 0
    return {
      pid,
      title: pid > 0 ? windowTitle(api, hwnd) || '' : '',
      ptr: String(hwnd),
      hwndType,
    }
  } catch (error) {
    return { pid: 0, title: '', error: String(error?.message ?? error) }
  }
}

/** L2 授权表是否已从 host 设置加载过。 */
let consentLoaded = false

/** 从 host 设置加载按 exe 的 L2 授权表；失败就当空表，不阻塞提问。 */
async function loadWindowConsent() {
  if (consentLoaded) return
  consentLoaded = true
  try {
    const response = await fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/settings')
    if (!response.ok) return
    const payload = await response.json()
    const table = payload?.settings?.windowConsent
    if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
      state.windowConsent = table
    }
  } catch {
    // 设置读不到不影响问一问，只是这次不预勾深度。
  }
}

/** 这次选区来自哪个 exe（小写 basename）；读不到返回空串。 */
function consentKeyFor(record) {
  const pid = Number(record?.selection?.sourcePid)
  if (!(pid > 0) || api === null) return ''
  try {
    const image = String(processImage(api, pid) ?? '')
    const base = image.replace(/\\/g, '/').split('/').pop().toLowerCase()
    return base.slice(0, 80)
  } catch {
    return ''
  }
}

/** 用户这次在深度模式里同意读某个 exe 的窗口文本；记进 host 设置，下次预勾。 */
function rememberWindowConsent(record) {
  const key = record?.consentKey ?? ''
  if (key === '') return
  state.windowConsent = {
    ...state.windowConsent,
    [key]: { allowed: true, at: Date.now() },
  }
  void fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ windowConsent: state.windowConsent }),
  }).catch((error) => reportError('consent', error))
}

/**
 * 「问一问」：在选区旁边开一张 DSH 置顶卡，让用户就这段文字连续提问。
 *
 * 不再把 `> 引用` 注入 Claude/Codex 的输入框，也不再把原文递进 DSH 会话——问一问
 * 的答案由宿主 `/ask/side` 直接流回卡片，外部应用保持前台。选区读不到时卡片仍会
 * 出现并显示错误文案，不再出现"菜单点了没反应"。
 * @param selection - 菜单上绑的那次选区。
 */
async function askSelection(selection) {
  if (selection === null || selection === undefined) return
  state.selection = selection
  const record = panelForAction('ask', selection)
  if (record === null) return
  // 先出卡：取词最长要走一次剪贴板兜底，不能让用户"点了没反应"。
  openPanel(record, 'ask', selection, 'reading')
  const sourcePid = Number.isFinite(selection?.sourcePid) ? selection.sourcePid : 0
  state.lastAsk = {
    sourcePid: sourcePid > 0 ? sourcePid : null,
    mode: 'card',
    stage: 'read-selection',
    at: Date.now(),
  }
  let resolved = null
  try {
    resolved = await resolveSelection(selection)
  } catch (error) {
    reportError('ask-resolve', error)
    resolved = null
  }
  if ((resolved === null || String(resolved.text ?? '').trim() === '') && selection?.ocrRect !== undefined) {
    try {
      const recognized = await resolveOcrSelection(selection)
      if (recognized !== null) resolved = { text: recognized.text, source: 'ocr' }
    } catch (error) {
      reportError('ask-ocr', error)
    }
  }
  const trimmed = resolved === null ? '' : String(resolved.text ?? '').trim()
  if (trimmed === '') {
    record.ui.status = 'error'
    record.ui.error = '未能读取选中的文字，请重新划词后再试'
    state.lastAsk.stage = 'read-selection-failed'
    refreshPanel(record)
    return
  }
  selection.text = trimmed
  record.ui.source = trimmed
  const sourceMeta = askSourceFor(record)
  record.ui.sourceLabel = '① ' + (sourceMeta.app ?? (sourceMeta.origin === 'page' ? 'DSH' : '原文')) + (resolved.source === 'ocr' ? '（OCR）' : '')
  record.consentKey = consentKeyFor(record)
  await loadWindowConsent()
  record.askMode = record.consentKey !== '' && state.windowConsent[record.consentKey]?.allowed === true ? 'deep' : 'quick'
  record.ui.status = 'idle'
  record.selection = selection
  refreshPanel(record)
  state.lastAsk.stage = 'input'
  openAskBarFor(record)
}

/** 问一问输入条的默认问法（用户没改就直接回车时用）。 */
function defaultAskQuestion() {
  return LOCALE === 'en' ? 'Explain this text and list the key concepts.' : '解释这段文字，并列出关键概念。'
}

/**
 * 这次提问的出处，随 /ask/side 一起交给宿主，供卡片和 DSH 会话展示。
 * @param record - 哪张卡。
 */
function askSourceFor(record) {
  const selection = record?.selection
  const sourcePid = Number.isFinite(selection?.sourcePid) ? selection.sourcePid : 0
  const agent = api === null || sourcePid <= 0 ? null : detectAgentHostForPid(api, sourcePid)
  if (agent !== null) {
    return { origin: 'external', app: agent.label, title: agent.title }
  }
  const dshPids = [dshDesktopPid, process.ppid, process.pid].filter((pid) => pid > 0)
  if (dshPids.includes(sourcePid)) return { origin: 'page' }
  return sourcePid > 0 ? { origin: 'external', app: '其他应用' } : { origin: 'external' }
}

/**
 * 输入条在卡片里的位置：正文底部、页脚上方的预留带（与 panelLayout 的 askInset 同一套数）。
 *
 * 左右用 PANEL.padding 对齐正文，看起来是卡片正文里的一个输入框，而不是贴满全宽的白条。
 */
function placeAskBar(record) {
  const anchor = record?.selection ?? state.selection
  const work = anchor !== null && anchor !== undefined
    ? workAreaForPoint(api, anchor.x, anchor.y)
    : primaryWorkArea(api)
  // 以窗口的真实矩形为准：record.panel.rect 只是缓存，窗口被系统/DPI/UpdateLayeredWindow
  // 挪过之后它会落后，输入条就会停在旧位置（卡片已经在新位置了）。顺手把缓存修正回来。
  const live = panelReady(record) ? record.window.bounds() : null
  const rect = live ?? record?.panel?.rect ?? null
  if (live !== null && record !== null && record !== undefined) {
    record.panel.rect = { ...(record.panel.rect ?? {}), ...live }
  }
  const scale = panelReady(record) ? record.window.scale() : (record?.panel?.scale || 1)
  const height = Math.max(36, Math.round(PANEL.askHeight * scale))
  const gap = Math.round(PANEL.askGap * scale)
  const width = rect !== null && rect.width > 0
    ? Math.max(240, Math.round(rect.width - PANEL.padding * 2 * scale))
    : 360
  let x
  let y
  if (rect !== null && rect.width > 0 && rect.height > 0) {
    // 卡片正文底部、页脚上方：panelLayout 在 state.askInput 为真时让出的就是这一条，
    // 所以这里盖住的只是留白，不会再吃掉正文最后两行。
    x = rect.x + PANEL.padding * scale
    y = rect.y + rect.height - PANEL.footerHeight * scale - height - gap
    y = Math.max(rect.y + 8 * scale, y)
  } else {
    x = (anchor?.x ?? work.left) + 8
    y = (anchor?.y ?? work.top) + 18
  }
  x = Math.max(work.left + 8, Math.min(x, work.right - width - 8))
  y = Math.max(work.top + 8, Math.min(y, work.bottom - height - 8))
  return { x: Math.round(x), y: Math.round(y), width, height, scale }
}

/** 输入条开着时的兜底校位定时器（有些几何变化不走 onMoved/onResized）。 */
let askBarSyncTimer = null

/** 输入条是全局单例，记着它现在属于哪张卡：换卡时先收掉上一张的条与预留带。 */
let askBarOwner = null

/** 开始跟着卡片走：事件驱动为主，500ms 定时兜底，防止"窗口被系统挪了但我们没收到通知"。 */
function startAskBarSync(record) {
  stopAskBarSync()
  askBarSyncTimer = setInterval(() => {
    if (askBar === null || !askBar.isOpen() || !panelReady(record)) {
      stopAskBarSync()
      return
    }
    syncAskBar(record)
  }, 500)
  askBarSyncTimer.unref?.()
}

function stopAskBarSync() {
  if (askBarSyncTimer !== null) clearInterval(askBarSyncTimer)
  askBarSyncTimer = null
}

/** 卡片被拖动/改大小时，让已经打开的输入条跟着走（它是一扇独立窗，不会自己跟）。 */
function syncAskBar(record) {
  if (askBar === null || !askBar.isOpen()) return
  if (!panelReady(record)) return
  try {
    const at = placeAskBar(record)
    if (askBar.place(at) === true) state.askBarRect = at
  } catch (error) {
    reportError('askbar-place', error)
  }
}

/** 收起输入条，并让正文拿回那一块高度（折叠 / 最小化 / 藏窗 / 关窗时调用）。 */
function closeAskBarFor(record) {
  // 单例：别的卡的动作（折叠/最小化/关窗）不该把这张卡的输入条收掉。
  if (askBarOwner !== null && record !== askBarOwner) return
  stopAskBarSync()
  if (askBar !== null && askBar.isOpen()) askBar.close()
  if (askBarOwner === record) askBarOwner = null
  state.askBarRect = null
  if (record !== null && record !== undefined && record.ui.askInput === true) {
    record.ui.askInput = false
    refreshPanel(record)
  }
}

/** 打开输入条；没有输入条能力时退回默认问法，保证"点了必有反应"。 */
function openAskBarFor(record, modeOverride = null, forceFresh = false) {
  if (!panelReady(record)) return
  if (typeof record.ui.source !== 'string' || record.ui.source === '') return
  if (forceFresh) {
    // 卡片上的「深度」入口：材料只进首问，所以必须新会话；旧会话留给宿主 TTL 清掉。
    record.askSessionId = null
    record.ui.askTurn = 0
  }
  const preferredMode = modeOverride === 'deep' ? 'deep' : record.askMode
  const fresh = record.askSessionId === null
  if (askBar === null) {
    const fallbackMode = typeof record.filePath === 'string' && record.filePath !== '' ? 'deep' : preferredMode
    record.askMode = fallbackMode
    startAskRun(record, defaultAskQuestion(), fresh || fallbackMode === 'deep', fallbackMode)
    return
  }
  // 上一张卡的条还开着就先收掉（连带回收它的预留带），否则两张卡会抢同一个输入条。
  if (askBarOwner !== null && askBarOwner !== record) closeAskBarFor(askBarOwner)
  // 折叠成标题带时开条：先展开，否则条会落在标题带下方几百像素的空气里。
  if (record.ui.minimized === true) {
    record.ui.minimized = false
    refreshPanel(record)
  }
  const at = placeAskBar(record)
  // 先让卡片让出输入条那条带，再摆输入条——顺序反了会看到正文被白条压一下再缩回去。
  record.ui.askInput = true
  refreshPanel(record)
  askBarOwner = record
  try {
    askBar.open({
      x: at.x,
      y: at.y,
      width: at.width,
      height: at.height,
      scale: at.scale,
      title: '问一问',
      summary: record.ui.sourceLabel,
      text: record.ui.askTurn === 0 ? (record.ui.question || defaultAskQuestion()) : '',
      mode: preferredMode,
      onSubmit: (question, mode) => {
        const hasFile = typeof record.filePath === 'string' && record.filePath !== ''
        const effectiveMode = hasFile ? 'deep' : (mode === 'deep' ? 'deep' : 'quick')
        record.askMode = effectiveMode
        if (effectiveMode === 'deep') rememberWindowConsent(record)
        // 加了新文件就必须新会话，否则材料只存在首问、追问问不出文件内容。
        startAskRun(record, question, record.askSessionId === null || hasFile, effectiveMode)
      },
      onClose: () => {
        if (askBarOwner === record) askBarOwner = null
        stopAskBarSync()
        // Esc / 回车收起也要把预留的输入带收回去，否则正文底下永久空一块。
        if (record.ui.askInput !== true) return
        record.ui.askInput = false
        refreshPanel(record)
      },
    })
    // 排障用：/status 里能直接看到输入条在哪、开着没有（它是一扇独立窗，卡片上只留一条带）。
    state.askBarRect = at
    startAskBarSync(record)
  } catch (error) {
    state.askBarRect = null
    record.ui.askInput = false
    refreshPanel(record)
    // 建窗/输入法初始化失败也不能让"点了没反应"：退回默认问法，先把答案给出来。
    reportError('askbar-open', error)
    const fallbackMode = typeof record.filePath === 'string' && record.filePath !== '' ? 'deep' : preferredMode
    record.askMode = fallbackMode
    startAskRun(record, defaultAskQuestion(), fresh || fallbackMode === 'deep', fallbackMode)
  }
}

/** 正在开文件对话框（同一时间只允许一个）。 */
let activePicker = null
let filePickerBusy = false

/** 取消正在进行的文件选择（关卡片 / 进程退出时用），并让等待中的 Promise 收敛成空串。 */
function cancelFilePicker() {
  if (activePicker === null) return
  const { child, finish } = activePicker
  activePicker = null
  try {
    child.kill()
  } catch {
    // 已经退出
  }
  finish({ path: '', reason: 'cancelled' })
}

/**
 * 用系统文件对话框选一个文件；取消/失败返回空串。只读用户显式选中的文件。
 *
 * **必须异步**：原来用 spawnSync 跑 powershell，对话框最长能开 120 秒，这段时间 companion
 * 的整个事件循环是停的——划词、标题栏按钮、连 /status 全部没反应。改成 spawn + Promise 后，
 * 对话框开着的时候宿主照常工作，选完再继续。
 */
const PICK_HINT = {
  busy: '已有文件对话框',
  cancelled: '已取消选择',
  timeout: '文件对话框超时',
  failed: '打不开文件对话框',
  spawn: '打不开文件对话框',
}

/**
 * 从 PowerShell 的 stdout 里取路径。
 * 只认最后一行、且必须像绝对路径（盘符或 UNC）——别把警告/提示行当成文件名。
 * @returns {{path:string, reason:string}}
 */
function parsePick(out, emptyReason) {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length === 0) return { path: '', reason: emptyReason }
  const last = lines[lines.length - 1]
  const absolute = /^[A-Za-z]:\\/.test(last) || /^\\\\/.test(last)
  if (!absolute || last.includes('\uFFFD')) {
    reportError('pick-file', new Error('unexpected output: ' + last.slice(0, 120)))
    return { path: '', reason: 'failed' }
  }
  return { path: last, reason: 'ok' }
}

function pickOpenFile() {
  return new Promise((resolve) => {
    if (filePickerBusy) {
      resolve({ path: '', reason: 'busy' })
      return
    }
    const script = [
      // PowerShell 的管道输出默认按控制台代码页写（中文系统是 936/GBK），Node 按 UTF-8 解会
      // 变成 U+FFFD——路径一坏，后面 stat/read 必 ENOENT（踩过：中文路径选中后标签是乱码）。
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
      // 卡片是 topmost 的：对话框必须挂在一个 topmost 的隐形 owner 上，否则会被卡片盖住。
      '$o = New-Object System.Windows.Forms.Form',
      '$o.TopMost = $true',
      '$o.ShowInTaskbar = $false',
      '$o.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None',
      '$o.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual',
      '$o.Location = New-Object System.Drawing.Point(-32000, -32000)',
      '$o.Size = New-Object System.Drawing.Size(1, 1)',
      '$o.Show()',
      '$d = New-Object System.Windows.Forms.OpenFileDialog',
      "$d.Filter = '代码/文本|*.ts;*.tsx;*.js;*.jsx;*.mjs;*.cjs;*.py;*.go;*.rs;*.java;*.cs;*.cpp;*.c;*.h;*.json;*.md;*.txt;*.yml;*.yaml;*.toml;*.css;*.html;*.vue;*.sql;*.sh;*.ps1;*.tex;*.bib;*.csv;*.log|所有文件|*.*'",
      '$d.CheckFileExists = $true',
      'if ($d.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }',
      '$o.Close()',
    ].join('; ')
    filePickerBusy = true
    let settled = false
    let timedOut = false
    let timer = null
    let child = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      filePickerBusy = false
      if (activePicker !== null && activePicker.child === child) activePicker = null
      resolve(value)
    }
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reportError('pick-file', error)
      finish({ path: '', reason: 'spawn' })
      return
    }
    // 兜底：对话框挂着没人关（脚本卡住）也不让它永远占着。超时只 kill，等 close 再把已经
    // 写进 stdout 的路径交出去（用户可能刚好在最后一刻选完，不能把结果吞掉）。
    timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill()
      } catch {
        // 已经退出
      }
    }, 300000)
    timer.unref?.()
    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      out += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      reportError('pick-file', error)
      finish('')
    })
    child.on('close', (code) => {
      if (timedOut) {
        finish(parsePick(out, 'timeout'))
        return
      }
      if (code !== 0) {
        const tail = String(err).trim().slice(-300)
        if (tail !== '') reportError('pick-file', new Error('powershell exit ' + code + ': ' + tail))
        finish({ path: '', reason: 'failed' })
        return
      }
      finish(parsePick(out, 'cancelled'))
    })
    activePicker = { child, finish }
  })
}

/** 给卡片挂一个显式选择的文件；只更新材料标签，不立刻读。 */
async function pickFileFor(record) {
  if (!panelReady(record)) return
  if (record.picking === true) return
  if (filePickerBusy) {
    // 已经有一个对话框开着：不能静默没反应，在这张卡的页脚说一句。
    record.ui.copyFeedback = '已有文件对话框'
    refreshPanel(record)
    return
  }
  record.picking = true
  // 卡片可能在对话框期间被关掉、又被 findReusablePanel 复用；用 token 把这次选择钉在这一轮上。
  record.pickToken = (record.pickToken ?? 0) + 1
  const token = record.pickToken
  try {
    const pick = await pickOpenFile()
    state.lastPickFile = { at: Date.now(), ok: pick.reason === 'ok', reason: pick.reason, path: pick.path }
    if (pick.reason !== 'ok' || pick.path === '') {
      // 不能静默：取消/被策略拦/对话框起不来都要在卡片上说一句。
      record.ui.copyFeedback = PICK_HINT[pick.reason] ?? '没有选中文件'
      refreshPanel(record)
      return
    }
    if (!panelReady(record) || record.pickToken !== token) return
    const path = pick.path
    record.filePath = path
    // 选了文件就默认走深度；回车提交时即使复选框没勾也强制带文件。
    record.askMode = 'deep'
    record.ui.copyFeedback = ''
    const base = record.ui.sourceLabel.split(' · ')[0]
    // 卡片上不摆文件名：只说"已添加文件"，细节留给 /status 与 prompt。
    // 保留已有的窗口字数等段，只去掉旧的"已添加文件/深度"，免得选个文件就把窗口信息抹掉。
    const keep = String(record.ui.sourceLabel ?? '')
      .split(' · ')
      .slice(1)
      .filter((part) => part !== '' && part !== '已添加文件' && part !== '深度')
    record.ui.sourceLabel = [base, ...keep, '已添加文件'].join(' · ')
    record.ui.sourceBase = base
    // 版本 +1：这一轮里随后到达的 context 不再覆盖"我刚选的文件"。
    record.labelEpoch = (record.labelEpoch ?? 0) + 1
    refreshPanel(record)
  } finally {
    if (record.pickToken === token) record.picking = false
  }
}

/**
 * 深度首问前读 L2 窗口文本 + 用户选择的 L3 文件。
 * @param record - 哪张卡。
 * @returns `{ window?, files?, omitted }`
 */
async function collectAskMaterial(record) {
  const selection = record?.selection
  const omitted = []
  let window = null
  const files = []
  if (contextReader !== null && selection !== null && selection !== undefined) {
    try {
      const result = await contextReader.windowText({ x: selection.x, y: selection.y }, selection.hwnd)
      if (result === null || typeof result.text !== 'string' || result.text.trim() === '') {
        omitted.push({ kind: 'window', reason: 'unavailable' })
      } else {
        const raw = result.text.trim()
        const take = raw.slice(0, 6000)
        const source = askSourceFor(record)
        window = {
          app: source.app ?? '',
          title: source.title ?? '',
          text: take,
          chars: raw.length,
          truncated: raw.length > take.length,
        }
        if (raw.length > take.length) omitted.push({ kind: 'window', reason: 'truncated' })
      }
    } catch (error) {
      reportError('ask-material', error)
      omitted.push({ kind: 'window', reason: 'error' })
    }
  } else {
    omitted.push({ kind: 'window', reason: 'unsupported' })
  }
  // L3：只读用户在本卡里显式选择的文件；标题/工作区猜测一律不碰。
  const filePath = typeof record?.filePath === 'string' ? record.filePath : ''
  if (filePath !== '') {
    if (isSensitivePath(filePath)) {
      omitted.push({ kind: 'file', reason: 'sensitive:' + basename(filePath) })
    } else if (!isAllowedExtension(filePath)) {
      omitted.push({ kind: 'file', reason: 'extension:' + basename(filePath) })
    } else {
      try {
        const slice = await readFileSlice(filePath, 1, 400)
        if (slice.text.trim() !== '' && (slice.reason === '' || slice.reason === 'truncated')) {
          files.push({
            path: basename(filePath),
            from: slice.from,
            to: slice.to,
            text: slice.text,
            chars: slice.chars,
            truncated: slice.truncated,
          })
        } else {
          omitted.push({ kind: 'file', reason: (slice.reason || 'empty') + ':' + basename(filePath) })
        }
      } catch (error) {
        reportError('ask-file', error)
        omitted.push({ kind: 'file', reason: 'read-error:' + basename(filePath) })
      }
    }
  }
  const material = { omitted }
  if (window !== null) material.window = window
  if (files.length > 0) material.files = files
  return material
}

/**
 * 跑一轮问一问（首问或追问），把 SSE 增量画进卡片。
 *
 * 宿主侧 `/ask/side` 与 `/ask/side/followup` 共用同一个 sessionId：追问时只发问题，
 * 历史由宿主内存里的 askSessions 重放——这正是「连续提问」的内核，不另造引擎。
 *
 * @param record - 哪张卡。
 * @param question - 用户这一轮的问题。
 * @param fresh - true = 首问（新建会话）；false = 追问（带 sessionId）。
 */
/**
 * 用宿主回的权威材料摘要刷新出处行。
 *
 * 拼装本身在 labels.mjs（纯函数、有单测）；这里只管"是不是这一轮"和重绘。
 * @param record - 哪张卡。
 * @param summary - 宿主的 `materialSummary`：`{ mode, window, files, omitted, chars }`。
 * @param runToken - 发起这一轮时记下的 token。
 */
function applyContextLabel(record, summary, epochAtSend) {
  if (record === null || record === undefined || summary === null || summary === undefined) return
  // 迟到的 context 不能改标签：这一轮之后可能已经有人（例如"选文件"）写过更新的出处行了。
  // 比对"发送时的标签版本"，而不是"第几轮"——后者只挡跨轮，挡不住同一轮里后写的那次。
  if (epochAtSend !== undefined && (record.labelEpoch ?? 0) !== epochAtSend) return
  const base = String(record.ui.sourceBase ?? record.ui.sourceLabel ?? '').split(' · ')[0] || '原文'
  record.ui.sourceBase = base
  record.ui.sourceLabel = buildContextLabel(base, summary)
  record.labelEpoch = (record.labelEpoch ?? 0) + 1
  refreshPanel(record)
}

async function startAskRun(record, question, fresh, mode = 'quick') {
  if (!panelReady(record)) return
  abortPanelRun(record)
  const text = typeof question === 'string' ? question.trim() : ''
  if (text === '') return
  const deep = mode === 'deep'
  record.ui.question = text
  record.ui.askTurn = fresh ? 1 : record.ui.askTurn + 1
  record.ui.answer = ''
  record.ui.error = ''
  record.ui.copyFeedback = ''
  record.ui.status = fresh && deep ? 'reading' : 'running'
  record.ui.scroll = 0
  refreshPanel(record)
  const controller = new AbortController()
  const runState = { abort: () => controller.abort(), sessionId: record.askSessionId, kind: 'ask' }
  record.run = runState
  // 每次提问递增：迟到的 context / delta 靠它判断"是不是这一轮的"。
  const runToken = (record.runToken ?? 0) + 1
  record.runToken = runToken
  // 深度首问才读材料；追问沿用宿主会话里的材料，不重读。
  const material = fresh && deep ? await collectAskMaterial(record) : null
  if (!panelReady(record) || controller.signal.aborted) return
  if (material !== null) {
    // 本地只知道"读到了多少"，不知道宿主裁完给模型多少；这里先只写基名 + 深度，
    // 数字等宿主的 context 回来再补 —— 两套拼装会闪一下，还会出现 0.4k 这种口径。
    const base = record.ui.sourceBase ?? record.ui.sourceLabel.split(' · ')[0]
    record.ui.sourceBase = base
    record.ui.sourceLabel = deep ? `${base} · 深度` : base
    record.labelEpoch = (record.labelEpoch ?? 0) + 1
  }
  // 发出去时的标签版本：context 到达时若已被别人改过，就不覆盖。
  const labelEpochAtSend = record.labelEpoch ?? 0
  record.ui.status = 'running'
  refreshPanel(record)
  state.lastAsk = {
    sourcePid: Number.isFinite(record.selection?.sourcePid) ? record.selection.sourcePid : null,
    mode: 'card',
    stage: 'streaming',
    turn: record.ui.askTurn,
    sessionId: record.askSessionId,
    at: Date.now(),
  }

  const url = DSH_ORIGIN + '/api/dsh-floating-assistant/ask/side' + (fresh ? '' : '/followup')
  const body = fresh
    ? {
        question: text,
        text: record.ui.source,
        context: typeof record.selection?.context === 'string' ? record.selection.context : '',
        locale: LOCALE,
        source: askSourceFor(record),
        mode: record.askMode,
        ...(material === null ? {} : { material }),
      }
    : { sessionId: record.askSessionId, question: text }
  const uiState = record.ui
  void (async () => {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastPaint = Date.now()
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (payload !== '') {
            const event = JSON.parse(payload)
            if (event.type === 'session') {
              record.askSessionId = event.sessionId
              runState.sessionId = event.sessionId
            } else if (event.type === 'context') {
              // 宿主回的是**裁剪之后**的权威摘要：卡片上的字数要以它为准（本地那份是裁剪前的）。
              applyContextLabel(record, event, labelEpochAtSend)
              state.lastContext = {
                at: Date.now(),
                mode: typeof event.mode === 'string' ? event.mode : '',
                chars: Number(event.chars ?? 0),
                window: event.window === null || event.window === undefined
                  ? null
                  : { chars: Number(event.window.chars ?? 0), truncated: event.window.truncated === true },
                files: (Array.isArray(event.files) ? event.files : []).slice(0, 4).map((item) => ({
                  name: typeof item?.path === 'string' ? basename(item.path) : '',
                  chars: Number(item?.chars ?? 0),
                  truncated: item?.truncated === true,
                })),
                omitted: (Array.isArray(event.omitted) ? event.omitted : []).slice(0, 8).map((item) => String(item?.kind ?? '') + '/' + String(item?.reason ?? '')),
              }
            } else if (event.type === 'delta') {
              pending += event.text
            } else if (event.type === 'done') {
              pending = ''
              uiState.answer = event.text !== '' ? event.text : uiState.answer
              uiState.status = 'done'
              state.lastAsk = {
                sourcePid: Number.isFinite(record.selection?.sourcePid) ? record.selection.sourcePid : null,
                mode: 'card',
                stage: 'done',
                turn: uiState.askTurn,
                sessionId: record.askSessionId,
                at: Date.now(),
              }
            } else if (event.type === 'error') {
              uiState.status = 'error'
              uiState.error = event.message
              state.lastAsk = {
                sourcePid: Number.isFinite(record.selection?.sourcePid) ? record.selection.sourcePid : null,
                mode: 'card',
                stage: 'error',
                turn: uiState.askTurn,
                sessionId: record.askSessionId,
                reason: event.message,
                at: Date.now(),
              }
              if (event.message === 'session expired') record.askSessionId = null
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
        const now = Date.now()
        if (pending !== '' && now - lastPaint > 80) {
          uiState.answer += pending
          pending = ''
          lastPaint = now
          refreshPanel(record)
        }
      }
      if (pending !== '') {
        uiState.answer += pending
        refreshPanel(record)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      uiState.status = 'error'
      uiState.error = error instanceof Error ? error.message : String(error)
      refreshPanel(record)
    } finally {
      if (record.run === runState) record.run = null
      refreshPanel(record)
    }
  })()
}

/**
 * 菜单段号 → 动作。菜单从左到右是：解释、总结、翻译、问一问。
 * @param row - `menuRowAt` 给出的段号（0/1/2/3）。
 */
function menuActionOf(row) {
  if (row === 1) return 'summarize'
  if (row === 2) return 'translate'
  if (row === 3) return 'ask'
  return 'explain'
}

function startRun(record, action, selection = state.selection) {
  if (record === null || record === undefined) return
  if (selection === null || typeof selection.text !== 'string' || selection.text.trim() === '') return
  // 只有点菜单项才换内容：这里把"这次要处理什么"写进这扇回答窗口
  openPanel(record, action, selection, 'running')

  const controller = new AbortController()
  const runState = { abort: () => controller.abort(), sessionId: undefined }
  record.run = runState
  const text = selection.text
  const context = typeof selection.context === 'string' ? selection.context : ''
  const uiState = record.ui
  void (async () => {
    try {
      const response = await fetch(DSH_ORIGIN + '/api/dsh-floating-assistant/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, text, context, locale: LOCALE }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('HTTP ' + response.status)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pending = ''
      let lastPaint = Date.now()
      for (;;) {
        const { value, done } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const payload = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('')
          if (payload !== '') {
            const event = JSON.parse(payload)
            if (event.type === 'delta') pending += event.text
            else if (event.type === 'session') {
              if (record.run !== null) record.run.sessionId = event.sessionId
            } else if (event.type === 'done') {
              pending = ''
              uiState.answer = event.text !== '' ? event.text : uiState.answer
              uiState.status = 'done'
            } else if (event.type === 'error') {
              uiState.status = 'error'
              uiState.error = event.message
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
        const now = Date.now()
        if (pending !== '' && now - lastPaint > 80) {
          uiState.answer += pending
          pending = ''
          lastPaint = now
          refreshPanel(record)
        }
      }
      if (pending !== '') {
        uiState.answer += pending
        refreshPanel(record)
      }
    } catch (error) {
      if (controller.signal.aborted) return
      uiState.status = 'error'
      uiState.error = error instanceof Error ? error.message : String(error)
      refreshPanel(record)
    } finally {
      // 这轮 stream 结束就清掉 run（换成下一轮时才保留新的）；否则 /status 会一直显示 running。
      if (record.run === runState) record.run = null
      refreshPanel(record)
    }
  })()
}

// ---------------------------------------------------------------- 划词

/**
 * 点是否落在某个窗口矩形内。
 *
 * 注意：这里的矩形是 `{ x, y, width, height }`（窗口几何用的就是这套字段），
 * 而 gesture.mjs 的 pointInRect 读的是 `{ left, right, top, bottom }`。
 * 两者混用会让"点在窗口内"恒为 false——表现为按任何键都立刻收起菜单（菜单"点了就消失"
 * 且点不动），踩过一次。
 */
function inRect(point, rect) {
  if (rect === null || rect === undefined) return false
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height
}

/**
 * 处理一次手势：**立刻**决定要不要弹菜单——不取词、不碰剪贴板。
 *
 * 老实现是"先注入 Ctrl+C 读剪贴板，读到了才弹菜单"，于是取词失败就等于菜单呼不出来
 * （DSH 桌面端的 WebView2 窗口里注入的 Ctrl+C 拿不到剪贴板；个别外部应用也偶发同样的问题）。
 * 现在手势一落地就开始 UIA 预读，最多等 MENU_DECIDE_MS 拿一个"这一点上有没有选中文字"的
 * 结论——菜单弹出的条件里再也没有"能不能取到词"这一项。真正的选中文案留到用户**点菜单项**
 * 时才解析（UIA 优先，读不到才注入一次 Ctrl+C 读剪贴板）。
 *
 * @param gesture - 手势（含落点）。
 * @param isCurrent - 这次手势是不是最新的（等待期间用户有没有又划一次）。
 */
async function handleGesture(gesture, isCurrent) {
  state.lastGesture = { ...gesture, at: Date.now() }
  // 落在已有回答窗口的**有效区域**上不算划词（最小化时只剩标题条，下面透明区域不拦）。
  const overMenu = inRect(gesture, menu.rect)
  const overPanel = panels.some((record) => {
    if (record.panel.mode === 'hidden' || record.ui.taskbarMinimized === true) return false
    const rect = panelScreenRect(record)
    return rect !== null && inRect(gesture, rect)
  })
  if (overMenu || overPanel) return
  const selection = {
    text: '',
    /** 这段文字是从哪一步读到的（uia-prefetch / uia-fresh / clipboard / preset）。 */
    textSource: '',
    x: gesture.x,
    y: gesture.y,
    /**
     * 手势**按下**的地方。判断"读到的选区是不是这次手势选出来的"要用它：
     * 菜单收起之后旧选区还留在应用里，光凭落点分不出"这次真选了"和"上次留下的"。
     */
    press: {
      x: Number.isFinite(gesture.downX) ? gesture.downX : gesture.x,
      y: Number.isFinite(gesture.downY) ? gesture.downY : gesture.y,
    },
    at: Date.now(),
    kind: gesture.kind,
    /** 这次划词发生在哪个进程的窗口里（0 = 读不到）：DSH 自己的 → 当前会话，别的 → 新会话。 */
    sourcePid: foregroundPid(),
    /** 手势那一刻的前台窗口句柄：深度读窗口文本时按句柄找，避免卡片挡住落点后读错窗口。 */
    hwnd: api === null ? null : api.GetForegroundWindow(),
    /** 手势那一刻的前台窗口摘要（排障：确认 sourcePid 是谁）。 */
    fg: probeForeground(),
    context: '',
    contextUnit: '',
    contextState: 'idle',
    /** 在途的 UIA 预读（点菜单项时还要等它）。 */
    pending: null,
  }
  // 拖选手势先把手势框记下来：截图/图片/扫描件没有文本层，UIA 与剪贴板都拿不到文字时，
  // 由 OCR 用这块区域兜底（见 beginFromMenu / askSelection）。只算几何，不在这里识别。
  if (gesture.kind === 'drag') selection.ocrRect = ocrRectForGesture(gesture, selection) ?? undefined
  const pending = startProbe(selection)
  deciding = true
  let decision
  let confirm = null
  try {
    decision = await decideMenu(
      pending,
      MENU_DECIDE_MS,
      state.lastMenuSelection,
      gesture.kind,
      gesture.press ?? null,
      state.lastMenuShownAt,
      { x: selection.x, y: selection.y },
    )
    if (decision.open === null) {
      // UIA 说不出话（WPS/Office 的 Qt 版这类不暴露文档文本的应用）：用剪贴板核实一次
      // "到底有没有选中文字"——真选中了会复制出文字，拖动形状/窗口则什么都复制不出来。
      confirm = await confirmByClipboard(selection)
      if (confirm.state === 'text') decision = { open: true, reason: 'clipboard' }
      else if (confirm.state === 'none') decision = { open: false, reason: 'unconfirmed' }
      else {
        // `unknown`（重试后仍超时）/`skipped`：拿不准有没有选中文字。补一次 UIA 读
        // （Ctrl+C 往往把无障碍树焐热了），读到就弹；读不到才按 kind 退回老行为。
        const late = await reprobeSelection(selection)
        decision = late !== null ? { open: true, reason: 'selection-late' } : unknownFallback(gesture.kind)
      }
    }
    // 截图/图片/扫描件：UIA 没有文本层、剪贴板也复制不出文字，但用户确实框选了一块可见
    // 内容 → 把这块区域截下来交给 Windows OCR。只在"确认过没文字"之后才做。
    if (decision.open === false && decision.reason === 'unconfirmed') {
      const rect = ocrRectForGesture(gesture, selection)
      if (rect !== null && foregroundAllowsOcr(confirm)) {
        selection.ocrRect = rect
        decision = { open: true, reason: 'ocr' }
      }
    }
  } finally {
    deciding = false
  }
  state.lastMenuDecision = { open: decision.open, reason: decision.reason, kind: gesture.kind, at: Date.now() }
  // 累计计数（/status 的 `reasonCounts`）：键是 `结论:手势:reason`，例如
  // `closed:double:double-unverified`、`open:drag:selection`、`deferred:drag:unknown`。
  // 为什么要累计而不只留最近 20 条：偶发漏弹（一晚上两三次）很快会被后来的成功划词顶出
  // `recentDecisions`，事后没人能看出"到底是哪一档在吞划词"；双击与拖选分开看，因为两者
  // 不弹的根因不一样。剪贴板核实的失败原因另外记成 `confirm:<reason>`。
  const bucket = `${decision.open === true ? 'open' : decision.open === false ? 'closed' : 'deferred'}:${gesture.kind}:${decision.reason}`
  state.reasonCounts[bucket] = (state.reasonCounts[bucket] ?? 0) + 1
  // 剪贴板核实的失败原因单独计数（timeout = 根本没写进剪贴板，not-text-editing = 复制的是别的格式）。
  const confirmReason = typeof confirm?.reason === 'string' ? confirm.reason : ''
  if (confirmReason !== '') {
    const key = `confirm:${confirmReason}`
    state.reasonCounts[key] = (state.reasonCounts[key] ?? 0) + 1
  }
  state.recentDecisions.push({
    at: state.lastMenuDecision.at,
    kind: gesture.kind,
    distance: Math.round(gesture.distance ?? 0),
    open: decision.open,
    reason: decision.reason,
    /** 探针当时读到了什么（null = 这次是"宽限期也用完"的兜底）。 */
    probe: state.lastProbe === null
      ? null
      : { at: state.lastProbe.at, state: state.lastProbe.state, source: state.lastProbe.source, atGesture: state.lastProbe.atGesture ?? null, selectionLength: state.lastProbe.selectionLength ?? 0, className: state.lastProbe.className ?? '' },
    /** 按下那一刻读到的是什么（判"这次手势有没有选出新东西"的对照面）。 */
    pressProbe: summarizePress(gesture.press ?? null),
    /** UIA 判不了时的剪贴板核实结果（null = 这次 UIA 直接给出了结论，没走核实）。 */
    confirm,
    point: { x: gesture.x, y: gesture.y },
    press: { x: gesture.downX, y: gesture.downY },
  })
  if (state.recentDecisions.length > 20) state.recentDecisions.shift()
  if (!isCurrent()) {
    // 等待期间用户又划了一次：这次的结果过期了，绝不能拿它弹菜单。
    state.lastMenuDecision.superseded = true
    return
  }
  if (!decision.open) return
  // DSH 桌面窗口里的划词交给页内客户端（浮出条 + 侧卡作答），不再弹原生菜单，
  // 否则同一个选区会同时出现两套 UI。需要回退旧行为时设 DSH_SELECTION_MENU_IN_DSH=1。
  if (!MENU_IN_DSH) {
    const owner = await resolveDshDesktopPid().catch(() => 0)
    const dshPids = [owner, process.ppid, process.pid].filter((pid) => pid > 0)
    if (dshPids.includes(Number(selection.sourcePid))) {
      state.lastMenuDecision.suppressed = 'dsh-page'
      return
    }
  }
  // 只弹菜单：回答窗口不受影响（只有点解释/翻译才换里面的内容）
  showMenu(selection)
}

/** 鼠标轮询：手势检测 + 任意键点到别处收起菜单 + Esc 收起菜单。 */
function startHook() {
  // 手势要串行、且只有最新那次作数：一次手势要等 UIA 的"有没有选中文字"结论（最多
  // MENU_DECIDE_MS），这期间用户完全可能又划一次——拿过期的那次去弹菜单，菜单绑的就不是
  // 用户看着选的那段文字。见 gesture.mjs 的 createLatestQueue。
  gestureQueue = createLatestQueue({
    run: (gesture, seq) => handleGesture(gesture, () => gestureQueue.isLatest(seq)),
    onError: (error) => reportError('gesture', error),
  })
  const detector = createGestureDetector({
    // 按下的那一刻拍一张"手势之前的选区"：只有它能把"拖动一个已选中的元素"和"拖选文字"
    // 分开（见 startPressProbe 与 policy.mjs 的 menuDecision）。
    onPress: (press) => startPressProbe(press),
    onGesture: (gesture) => {
      // 快照跟着手势一起进队列：等待期间用户又按了一下的话，这次手势要用的仍是**它自己
      // 按下时**拍的那张，而不是更新鲜的那张。
      gestureQueue.submit({ ...gesture, press: pressSnapshot })
    },
  })
  const buttons = { left: false, right: false, middle: false }
  let escapePressed = false
  const point = {}
  setInterval(() => {
    try {
      if (!api.GetCursorPos(point)) return
      const left = (Number(api.GetAsyncKeyState(VK_LBUTTON)) & 0x8000) !== 0
      const right = (Number(api.GetAsyncKeyState(VK_RBUTTON)) & 0x8000) !== 0
      const middle = (Number(api.GetAsyncKeyState(VK_MBUTTON)) & 0x8000) !== 0
      detector.push({ down: left, x: point.x, y: point.y, time: Date.now() })

      // 任意按键在别处按下 → 菜单收起（点在菜单自己身上不算）
      const anyDown = (left && !buttons.left) || (right && !buttons.right) || (middle && !buttons.middle)
      if (anyDown && menu.visible && !inRect(point, menu.rect)) hideMenu('outside-click')
      buttons.left = left
      buttons.right = right
      buttons.middle = middle

      const escapeDown = (Number(api.GetAsyncKeyState(VK_ESCAPE)) & 0x8000) !== 0
      if (escapeDown && !escapePressed && menu.visible) hideMenu('escape')
      escapePressed = escapeDown
    } catch (error) {
      reportError('poll', error)
    }
  }, POLL_MS).unref?.()
}

// ---------------------------------------------------------------- HTTP（状态 / 验收）

async function readJson(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.trim() === '' ? {} : JSON.parse(raw)
}

function respondJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/**
 * 验收路由里挑一扇窗口：`id` / `index` 指定；都不给就取"最近显示的那扇"。
 * 多窗并存之后 /click、/wheel、/capture 必须能指定目标，否则只能测到最上面一扇。
 */
function panelAt(body) {
  if (body !== null && body !== undefined) {
    const id = Number(body.id)
    if (Number.isFinite(id)) {
      const byId = panels.find((record) => record.id === id)
      if (byId !== undefined) return byId
    }
    const index = Number(body.index)
    if (Number.isInteger(index) && index >= 0 && index < panels.length) return panels[index]
  }
  return activePanel()
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (req.method === 'GET' && url.pathname === '/status') {
    // 没有"活动中"的卡（例如缩在任务栏里）时，退到最后一扇，否则 /status 什么都看不到。
    const primary = activePanel() ?? (panels.length > 0 ? panels[panels.length - 1] : null)
    const primaryUi = primary === null ? createPanelUi() : primary.ui
    const primaryPanel = primary === null
      ? { mode: 'hidden', rect: null, position: null, scale: 1 }
      : primary.panel
    respondJson(res, 200, {
      ok: true,
      hookEnabled: HOOK_ENABLED,
      menuTimeoutMs: MENU_TIMEOUT_MS,
      /** 手势落下后给 UIA 的决策窗口（毫秒）。 */
      menuDecideMs: MENU_DECIDE_MS,
      /** 选区文字的来源策略：auto / uia / clipboard。 */
      textSource: TEXT_SOURCE,
      menu: { visible: menu.visible, ready: menuWindow !== null, rect: menu.rect, scale: menu.scale, hover: menu.hover },
      panel: primaryPanel,
      // 文件对话框：忙不忙 + 最近一次结果（取消/失败都有 reason，不再靠猜）。
      filePicker: { busy: filePickerBusy, last: state.lastPickFile ?? null },
      // 最近一次宿主回的材料摘要（裁剪后的权威数字）：卡片出处行就是按它刷新的。
      lastContext: state.lastContext ?? null,
      askBar: askBar === null
        ? { available: false, open: false, rect: null }
        : { available: true, open: askBar.isOpen(), ownerId: askBarOwner === null ? null : askBarOwner.id, rect: state.askBarRect ?? null },
      // 最近一次截图取词（OCR）：识别慢/失败时看这里，不用再靠猜。
      ocr: ocrLast(),
      // 排障对照：真实矩形（bounds）与窗口内部 state，两者不一致就是"命中区/输入条跑偏"的根。
      win: primary === null || !panelReady(primary)
        ? null
        : { bounds: primary.window.bounds(), state: primary.window.debug(), scale: primary.window.scale() },
      ui: {
        status: primaryUi.status,
        action: primaryUi.action,
        minimized: primaryUi.minimized === true,
        taskbarMinimized: primaryUi.taskbarMinimized === true,
        answerLength: primaryUi.answer.length,
        sourceLength: primaryUi.source.length,
        copyFeedback: primaryUi.copyFeedback,
        sourceLabel: primaryUi.sourceLabel,
        scroll: primaryUi.scroll,
        contentHeight: Math.round(primaryUi.contentHeight),
        viewHeight: Math.round(primaryUi.viewHeight),
      },
      /** 所有回答窗口（多窗并存；旧的 panel/ui 字段取"最近显示的那扇"）。 */
      panels: panels.map((record) => {
        // 每扇卡的真实窗口状态（多卡时"点不中/没反应"就靠这几个字段定位，不再只有 primary 一扇有）。
        // `hits` 是这扇窗最近 8 次 WM_NCHITTEST 的判定（是哪个区、用的哪个原点）——多卡并存时
        // 以前只有 primary 那扇能看到，出问题的那扇偏偏不是它。
        const debug = panelReady(record) ? record.window.debug() : null
        return {
          id: record.id,
          mode: record.panel.mode,
          minimized: record.ui.minimized === true,
          taskbarMinimized: record.ui.taskbarMinimized === true,
          running: record.run !== null,
          filePath: record.filePath ?? null,
          picking: record.picking === true,
          askInput: record.ui.askInput === true,
          win: debug === null
            ? null
            : {
                bounds: record.window.bounds(),
                scale: record.window.scale(),
                visible: debug.visible,
                alive: record.window.alive(),
                hits: debug.hits,
              },
          rect: record.panel.rect,
          position: record.panel.position,
          scale: record.panel.scale,
          /** 用户拖出来的尺寸（**DIP**，跟 rect 的物理像素不是一套数；换算见 panelPixelSize）。 */
          sizeDip: record.panel.size,
          action: record.ui.action,
          status: record.ui.status,
          sourceLength: record.ui.source.length,
          answerLength: record.ui.answer.length,
          scroll: record.ui.scroll,
          contentHeight: Math.round(record.ui.contentHeight),
          viewHeight: Math.round(record.ui.viewHeight),
        }
      }),
      panelCount: panels.length,
      // 原生窗口总数 / 没有被任何记录认领的（清扫若失效，这里会 > 0）。
      windows: {
        total: nativeWindows.size,
        stray: [...nativeWindows].filter((window) => !panels.some((record) => record.window === window)).length,
      },
      maxPanels: MAX_PANELS,
      /**
       * 每个"弹/不弹"结论累计出现几次（偶发不弹时看这个）。键是 `结论:手势:reason`，
       * 例如 `closed:double:double-unverified`、`open:drag:selection`、`deferred:drag:unknown`；
       * 剪贴板核实的失败原因单独记成 `confirm:<reason>`。
       */
      reasonCounts: state.reasonCounts,
      /** 上一次菜单弹出的时刻（同一段文字过一会儿再划要能再弹）。 */
      lastMenuShownAt: state.lastMenuShownAt,
      lastGesture: state.lastGesture,
      /** 最近一次 UIA 探针读到了什么（菜单呼不出来时先看这里）。 */
      lastProbe: state.lastProbe,
      /** 最近一次"按下那一刻"的选区快照（"这次手势有没有选出新东西"的对照面）。 */
      pressProbe: state.lastPressProbe,
      /** 最近一次"用剪贴板核实有没有选中文字"的报告（UIA 判不了时才走这一步）。 */
      lastConfirm: state.lastConfirm,
      /** 最近一次"用剪贴板复核选区原文"的结果（UIA 只给半截时会换掉它）。 */
      lastVerify: state.lastVerify,
      /** 最近一次"弹不弹菜单"的结论与理由。 */
      lastMenuDecision: state.lastMenuDecision,
      /** 最近一次点菜单项之后，用的是哪个来源的文字。 */
      lastResolve: state.lastResolve,
      /** 最近一次「问一问」的分流判定（sourcePid / dshPids / mode / 前台窗口；失败时 mode=agent-failed）。 */
      lastAsk: state.lastAsk,
      /** 此刻的前台窗口（排障：确认 GetForegroundWindow 在这台机器上读得到）。 */
      foreground: probeForeground(),
      /** 最近 20 次"弹不弹"的结论（偶发"划不出来"时按时间顺查看每次的理由）。 */
      recentDecisions: state.recentDecisions,
      /** 上一次菜单收起时绑的那段文字（判断"旧选区"要用它比对）。 */
      lastMenuSelection: { length: state.lastMenuSelection.length, text: state.lastMenuSelection.slice(0, 120) },
      /** 当前菜单绑的那次选区来源（排障「问一问」误判用）。 */
      menuSelection: menu.selection === null
        ? null
        : { sourcePid: menu.selection.sourcePid ?? null, fg: menu.selection.fg ?? null, at: menu.selection.at ?? null },
      /** 最近一次剪贴板兜底取词（只在点菜单项后 UIA 读不到时才有）。 */
      lastCapture: state.lastCapture,
      gestures: gestureQueue === null ? null : gestureQueue.stats(),
      lastMenuDismiss: state.lastMenuDismiss ?? null,
      context: {
        enabled: contextReader !== null,
        /** 这次划词的选区/段落是怎么读到的：reading / ready / none / disabled / error。 */
        state: state.selection === null ? 'idle' : (state.selection.contextState ?? 'idle'),
        unit: state.selection === null ? '' : (state.selection.contextUnit ?? ''),
        /** 这次划词的选中文案长度（UIA 读到、或点菜单项后解析出来的）。 */
        selectionLength: state.selection === null ? 0 : String(state.selection.text ?? '').length,
        length: primaryUi.context.length,
        stats: contextReader === null ? null : contextReader.stats(),
      },
      errors: state.errors.slice(-5),
      dshOrigin: DSH_ORIGIN,
      /** 桌面壳 pid（"问一问"分流用；0 = 还没问到）。 */
      dshDesktopPid,
    })
    return
  }
  if (req.method === 'POST' && url.pathname === '/simulate') {
    void (async () => {
      try {
        const body = await readJson(req)
        const text = clampSelection(String(body.text ?? '选中文本'), MAX_TEXT)
        const work = primaryWorkArea(api)
        const x = typeof body.x === 'number' ? body.x : work.right - 400
        const y = typeof body.y === 'number' ? body.y : 300
        // 造一个"已经读到选区"的划词锚点（跳过手势与 UIA 探针），供验收脚本走完整链路：
        // 弹菜单 → /click 点菜单项 → 直接拿这里的 text 跑一轮。
        const selection = {
          text,
          textSource: 'preset',
          x,
          y,
          at: Date.now(),
          kind: 'simulate',
          // 验收脚本可以指定"这次划词算在谁的窗口里"：'dsh' = 假装在 DSH 里划的
          // （落当前会话）；数字 = 指定进程；缺省 0 = 当别的应用（开新会话）。
          sourcePid: body.sourcePid === 'dsh' ? process.ppid : Number(body.sourcePid) || 0,
          context: typeof body.context === 'string' ? body.context : '',
          contextUnit: '',
          contextState: typeof body.context === 'string' && body.context !== '' ? 'ready' : 'idle',
          pending: null,
        }
        const rect = showMenu(selection)
        respondJson(res, 200, { ok: true, menu: rect })
      } catch (error) {
        reportError('simulate', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  // 验收/排障：在某个屏幕坐标上直接跑一次 UIA 探针，看看"菜单为什么不弹"。
  if (req.method === 'POST' && url.pathname === '/probe') {
    void (async () => {
      try {
        const body = await readJson(req)
        if (contextReader === null) {
          respondJson(res, 200, { ok: false, message: 'context reader disabled' })
          return
        }
        const point = { x: Number(body.x ?? 0), y: Number(body.y ?? 0) }
        const retries = Number.isFinite(body.retries) ? Number(body.retries) : undefined
        // press 可以显式给：验收时用"元素看点 A、手势按在 B"复现"旧选区"那一路
        // （不给就按 point 算，跟真实手势里探针点即落点的老行为一致）。
        const press = typeof body.press === 'object' && body.press !== null
          ? { x: Number(body.press.x ?? point.x), y: Number(body.press.y ?? point.y) }
          : point
        // body.shell === false：验收"非 explorer 前台"那一路（WPS PDF 的 #32769 不能被当成桌面）。
        const result = await contextReader.probe(point, { retries, press, shell: body.shell === false ? false : undefined })
        // 按下那一刻读到的是什么：`pressSelection` 显式给（不带就是"没拍到"那一档），
        // 用来复现"拖动一个已选中的元素"（unchanged-selection）与"真的拖选了文字"这两路。
        // `pressDriftPx` 对应真实时序里"读数到手那一刻指针离按下点多远"，用来复现"拍晚了"
        // 那条（浏览器里 UIA 首查慢，读数回来时已经拖完）。
        const drift = Number(body.pressDriftPx)
        const pressProbe = typeof body.pressSelection === 'string'
          ? { selection: body.pressSelection, ...(Number.isFinite(drift) ? { driftPx: drift } : {}) }
          : null
        const provisional = menuDecision(result, '', { kind: typeof body.kind === 'string' ? body.kind : '', pressProbe })
        // `confirm: true` → UIA 判不了时**真的**跑一次剪贴板核实（会注入 Ctrl+C，仅排障用）；
        // 不传的话 open 为 null 只是"待核实"，不会碰剪贴板。
        const confirm = body.confirm === true && provisional.open === null ? await confirmByClipboard({}) : null
        const decision = confirm === null
          ? provisional
          : confirm.state === 'text'
            ? { open: true, reason: 'clipboard' }
            : confirm.state === 'none'
              ? { open: false, reason: 'unconfirmed' }
              : unknownFallback(typeof body.kind === 'string' ? body.kind : '')
        respondJson(res, 200, {
          ok: true,
          decision,
          selection: result === null ? '' : result.selection,
          context: result === null ? '' : result.text,
          source: result === null ? '' : result.source,
          atGesture: result === null ? null : (result.atGesture ?? null),
          /** 选区矩形（诊断用：看"为什么没弹"时对照着手势落点）。 */
          rects: result === null ? null : (result.rects ?? null),
          className: result === null ? '' : result.className,
          pressProbe,
          confirm,
          stats: contextReader.stats(),
        })
      } catch (error) {
        reportError('probe', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/window') {
    void (async () => {
      try {
        const body = await readJson(req)
        const op = String(body.op ?? '')
        if (op === 'mode') {
          const mode = ['panel', 'hidden'].includes(body.mode) ? body.mode : 'panel'
          if (mode === 'hidden') {
            hideAllPanels()
            respondJson(res, 200, { ok: true, geometry: null, mode: 'hidden', panelCount: panels.length })
            return
          }
          // 缩在任务栏里的卡不属于"活动"，panelAt 找不到时**复用最后一扇**而不是新建，
          // 否则一次恢复就会多出一张卡片（踩过：panels 变成 2）。
          const record = panelAt(body) ?? (panels.length > 0 ? panels[panels.length - 1] : null) ?? createPanel()
          if (record === null) {
            respondJson(res, 500, { ok: false, message: 'koffi / GDI+ 不可用' })
            return
          }
          const geometry = applyPanelMode(record, 'panel')
          respondJson(res, 200, { ok: true, geometry, mode: record.panel.mode, id: record.id, panelCount: panels.length })
          return
        }
        if (op === 'hide-menu') {
          hideMenu('api')
          respondJson(res, 200, { ok: true, menu: menu.visible })
          return
        }
        respondJson(res, 400, { ok: false, message: 'unknown op "' + op + '"' })
      } catch (error) {
        reportError('window', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  // 验收/排障：用**此刻真实的前台窗口**走一遍「问一问」分流（不经过鼠标手势）。
  // 用来在不动鼠标的前提下验证 sourcePid → mode 的判定链路。
  if (req.method === 'POST' && url.pathname === '/ask-foreground') {
    void (async () => {
      try {
        const body = await readJson(req)
        const text = typeof body.text === 'string' && body.text !== '' ? body.text : '前台采样测试'
        const selection = {
          text,
          textSource: 'preset',
          x: 0,
          y: 0,
          at: Date.now(),
          sourcePid: foregroundPid(),
          fg: probeForeground(),
        }
        await askSelection(selection)
        respondJson(res, 200, { ok: true, lastAsk: state.lastAsk })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/click') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? (menu.visible ? 'menu' : 'main'))
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        if (target === 'menu') {
          const row = menuRowAt(cssX, cssY)
          if (row >= 0) {
            runMenuAction(menuActionOf(row))
            respondJson(res, 200, { ok: true, target, row })
            return
          }
          // 没点中任何一段就如实说没点中：以前回 ok:true+row:-1，脚本拿它当成功。
          respondJson(res, 200, { ok: false, target, row, message: 'no menu segment at (' + cssX + ',' + cssY + '); y must be within 4..32 DIP' })
          return
        }
        const record = panelAt(body)
        if (record === null) {
          respondJson(res, 200, { ok: true, target, handled: false, panel: null })
          return
        }
        const handled = clickPanel(record, cssX, cssY, record.ui)
        respondJson(res, 200, { ok: true, target, handled, id: record.id })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/wheel') {
    void (async () => {
      try {
        const body = await readJson(req)
        const delta = Number(body.delta ?? -120)
        const record = panelAt(body)
        if (record === null) {
          respondJson(res, 200, { ok: false, message: 'no panel' })
          return
        }
        const maxScroll = Math.max(0, record.ui.contentHeight - record.ui.viewHeight)
        record.ui.scroll = Math.min(maxScroll, Math.max(0, record.ui.scroll - Math.sign(delta) * 60))
        refreshPanel(record)
        respondJson(res, 200, { ok: true, id: record.id, scroll: record.ui.scroll, maxScroll, rect: record.panel.rect })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/hittest') {
    void (async () => {
      try {
        const body = await readJson(req)
        const target = String(body.target ?? 'main')
        const cssX = Number(body.x ?? 0)
        const cssY = Number(body.y ?? 0)
        if (target === 'menu') {
          respondJson(res, 200, { ok: true, target, zone: 'client', code: hitTestCode('client') })
          return
        }
        const record = panelAt(body)
        if (record === null) {
          respondJson(res, 200, { ok: false, message: 'no panel' })
          return
        }
        const scale = currentPanelSize(record).scale
        const zone = hitZone(record, cssX * scale, cssY * scale)
        // code 是真正回给 Windows 的 WM_NCHITTEST 返回值（10=左 11=右 12=上 15=下，
        // 13/14/16/17 是四个对角）：验收时看这个，别只看语义名字。
        respondJson(res, 200, { ok: true, target, id: record.id, zone, code: hitTestCode(zone) })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/context') {
    void (async () => {
      try {
        const body = await readJson(req)
        if (contextReader === null) {
          respondJson(res, 200, { ok: false, message: 'context reader disabled' })
          return
        }
        const point = { x: Number(body.x ?? 0), y: Number(body.y ?? 0) }
        if (body.diagnose === true) {
          respondJson(res, 200, { ok: true, diagnose: await contextReader.diagnose(point) })
          return
        }
        const expected = typeof body.expected === 'string' ? body.expected : undefined
        respondJson(res, 200, { ok: true, context: await contextReader.read(point, expected), stats: contextReader.stats() })
      } catch (error) {
        reportError('context', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/ocr') {
    void (async () => {
      try {
        const body = await readJson(req)
        const rect = {
          x: Number(body.x ?? 0),
          y: Number(body.y ?? 0),
          width: Number(body.width ?? 0),
          height: Number(body.height ?? 0),
        }
        const result = await ocrScreenRect(api, gdi, rect, {
          timeoutMs: Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : 9000,
        })
        respondJson(res, 200, { ok: true, rect, ...result })
      } catch (error) {
        reportError('ocr', error)
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  if (req.method === 'POST' && url.pathname === '/capture') {
    void (async () => {
      try {
        const body = await readJson(req)
        const file = String(body.file ?? join(tmpdir(), 'dsh-selection-overlay.bmp'))
        const fallbackMain = activePanel() !== null && activePanel().panel.mode !== 'hidden'
        const target = String(body.target ?? (fallbackMain ? 'main' : 'menu'))
        const record = target === 'menu' ? null : panelAt(body)
        const rect = target === 'menu' ? menu.rect : (record === null ? null : record.panel.rect)
        if (rect === null) {
          respondJson(res, 400, { ok: false, message: 'window hidden' })
          return
        }
        const shot = captureScreenRect(api, gdi, rect.x, rect.y, rect.width, rect.height, file)
        respondJson(res, 200, { ok: true, id: record === null ? null : record.id, ...shot })
      } catch (error) {
        respondJson(res, 500, { ok: false, message: String(error?.message ?? error) })
      }
    })()
    return
  }
  respondJson(res, 404, { ok: false, message: 'not found' })
})

server.listen(Number(process.env.DSH_SELECTION_PORT ?? 0), '127.0.0.1', () => {
  const port = server.address().port
  process.stdout.write('dsh-floating-assistant companion (native) listening on http://127.0.0.1:' + port + ' (hook=' + (HOOK_ENABLED ? 'on' : 'off') + ')\n')
  if (api === null || gdi === null) {
    reportError('init', new Error('koffi / GDI+ 不可用：系统级划词已禁用'))
    return
  }
  if (HOOK_ENABLED) startHook()
})

process.on('SIGTERM', () => {
  cancelFilePicker()
  process.exit(0)
})
process.on('SIGINT', () => {
  cancelFilePicker()
  process.exit(0)
})
process.on('uncaughtException', (error) => reportError('uncaught', error))
process.on('unhandledRejection', (error) => reportError('unhandled', error))
