/**
 * 原生分层窗口（Layered Window）：无边框、置顶、逐像素透明、圆角/圆形，
 * 窗口就在本进程里，不依赖任何浏览器、不额外起进程。
 *
 * 绘制流程：把一帧画进 32bpp DIB（GDI+）→ UpdateLayeredWindow 带 alpha 贴到屏幕上。
 * 这样圆角与阴影都是抗锯齿的真透明，不是硬边裁剪。
 *
 * 消息循环：用 PeekMessage 轮询而不是阻塞 GetMessage——伴生进程的主线程还要跑
 * HTTP/SSE，不能被阻塞。
 */

const WM = {
  PAINT: 0x000f,
  SETCURSOR: 0x0020,
  ERASEBKGND: 0x0014,
  NCHITTEST: 0x0084,
  LBUTTONDOWN: 0x0201,
  LBUTTONUP: 0x0202,
  CAPTURECHANGED: 0x0215,
  MOUSEMOVE: 0x0200,
  MOUSEWHEEL: 0x020a,
  MOUSELEAVE: 0x02a3,
  RBUTTONDOWN: 0x0204,
  MOVE: 0x0003,
  WINDOWPOSCHANGED: 0x0047,
  ENTERSIZEMOVE: 0x0231,
  EXITSIZEMOVE: 0x0232,
  GETMINMAXINFO: 0x0024,
  SIZE: 0x0005,
  DPICHANGED: 0x02e0,
  CLOSE: 0x0010,
  DESTROY: 0x0002,
}

const HT = {
  CLIENT: 1,
  CAPTION: 2,
  LEFT: 10,
  RIGHT: 11,
  TOP: 12,
  TOPLEFT: 13,
  TOPRIGHT: 14,
  BOTTOM: 15,
  BOTTOMLEFT: 16,
  BOTTOMRIGHT: 17,
}

/**
 * 语义命中区 → `WM_NCHITTEST` 返回值。
 *
 * **八个方向都要映射**：窗口本身是 WS_POPUP、没有 WS_THICKFRAME，但只要命中区返回了
 * HT 边框代码，DefWindowProc 就会起自己的缩放循环（拖动时窗口跟着动、WM_SIZE 回到
 * 我们这边，绘制按新尺寸重排），四边与四角都是同一条路径。
 */
export const HIT_TEST_CODES = {
  caption: HT.CAPTION,
  'resize-left': HT.LEFT,
  'resize-right': HT.RIGHT,
  'resize-top': HT.TOP,
  'resize-bottom': HT.BOTTOM,
  'resize-topleft': HT.TOPLEFT,
  'resize-topright': HT.TOPRIGHT,
  'resize-bottomleft': HT.BOTTOMLEFT,
  'resize-bottomright': HT.BOTTOMRIGHT,
}

/** 语义命中区 → HT 代码（认不出的区按客户区处理）。 */
export function hitTestCode(zone) {
  return HIT_TEST_CODES[zone] ?? HT.CLIENT
}

/**
 * 创建原生浮层窗口。
 * @param options.api - win32.mjs 的 createWin32() 产物（提供 koffi/user32/gdi32）。
 * @param options.gdi - native/gdi.mjs 的 createGdi() 产物。
 * @param options.title - 窗口标题（诊断用）。
 * @param options.onPaint - (painter, width, height, state) => void，state 由 setState 提供。
 * @param options.onHitTest - (x, y, state) => 语义命中区（'caption' | 'client' | 'resize-<方向>'），
 *   决定这一块是拖动、点击还是缩放（八向缩放 = resize-left/right/top/bottom + 四个对角）。
 * @param options.onClick - (x, y, state) => boolean（true 表示已处理，需要重绘）。
 * @param options.onHover - (x, y, state) => boolean（hover 状态是否变化）。
 * @param options.onWheel - (delta, state) => boolean。
 * @param options.onDpiChanged - (scale, suggested) => void，suggested 是系统建议的物理
 *   矩形 `{ x, y, width, height }`（换缩放时由系统算好，已在这里应用），读不出来时是 null。
 *   调用方要做的只有"按新缩放重排 DIP 内容"。
 * @param options.onZOrderChanged - (state) => void，窗口的 z 序变了（点标题栏、拖动循环
 *   都会把窗口抬到最前）时回调；贴在它上面的独立小窗要借此重新压回最上层。
 */
/**
 * koffi 的类型名是**全局**的：同进程里创建第二个窗口时再定义同名结构体会抛
 * "Duplicate type name"（踩过）。所以类型定义集中到模块级、只建一次。
 */
let cachedTypes = null
function windowTypes(koffi) {
  if (cachedTypes !== null) return cachedTypes
  let wndProcProto = null
  try {
    wndProcProto = koffi.proto('intptr_t __stdcall DST_NW_WndProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  } catch {
    wndProcProto = koffi.pointer('DST_NW_WndProc')
  }
  const RECT = koffi.struct('DST_NW_RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
/** 取 Win32 最后一个错误（贴图失败时排障用）。 */
const GetLastError = koffi.load('kernel32.dll').func('uint32 GetLastError()')
  const POINT = koffi.struct('DST_NW_POINT', { x: 'long', y: 'long' })
  const SIZE = koffi.struct('DST_NW_SIZE', { cx: 'long', cy: 'long' })
  const BLENDFUNCTION = koffi.struct('DST_NW_BLENDFUNCTION', { BlendOp: 'uint8', BlendFlags: 'uint8', SourceConstantAlpha: 'uint8', AlphaFormat: 'uint8' })
  const BITMAPINFOHEADER = koffi.struct('DST_NW_BITMAPINFOHEADER', {
    biSize: 'uint32',
    biWidth: 'long',
    biHeight: 'long',
    biPlanes: 'uint16',
    biBitCount: 'uint16',
    biCompression: 'uint32',
    biSizeImage: 'uint32',
    biXPelsPerMeter: 'long',
    biYPelsPerMeter: 'long',
    biClrUsed: 'uint32',
    biClrImportant: 'uint32',
  })
  const WNDCLASSEXW = koffi.struct('DST_NW_WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: koffi.pointer(wndProcProto ?? 'DST_NW_WndProc'),
    cbClsExtra: 'int',
    cbWndExtra: 'int',
    hInstance: 'void *',
    hIcon: 'void *',
    hCursor: 'void *',
    hbrBackground: 'void *',
    lpszMenuName: 'const char16_t *',
    lpszClassName: 'const char16_t *',
    hIconSm: 'void *',
  })
  const TRACKMOUSEEVENT = koffi.struct('DST_NW_TRACKMOUSEEVENT', { cbSize: 'uint32', dwFlags: 'uint32', hwndTrack: 'void *', dwHoverTime: 'uint32' })
  const MINMAXINFO = koffi.struct('DST_NW_MINMAXINFO', {
    ptReserved: POINT,
    ptMaxSize: POINT,
    ptMaxPosition: POINT,
    ptMinTrackSize: POINT,
    ptMaxTrackSize: POINT,
  })
  const MSG = koffi.struct('DST_NW_MSG', { hwnd: 'void *', message: 'uint32', wParam: 'uintptr_t', lParam: 'intptr_t', time: 'uint32', pt: POINT })
  cachedTypes = { wndProcProto, RECT, POINT, SIZE, BLENDFUNCTION, BITMAPINFOHEADER, WNDCLASSEXW, TRACKMOUSEEVENT, MSG, MINMAXINFO }
  return cachedTypes
}

export function createNativeWindow(options) {
  const { api, gdi } = options
  const koffi = api.koffi
  const user32 = api.user32
  const gdi32 = api.gdi32

  const { wndProcProto, RECT, POINT, SIZE, BLENDFUNCTION, BITMAPINFOHEADER, WNDCLASSEXW, TRACKMOUSEEVENT, MSG, MINMAXINFO } = windowTypes(koffi)

  const u = {
    RegisterClassExW: user32.func('uint16 RegisterClassExW(DST_NW_WNDCLASSEXW *wc)'),
    CreateWindowExW: user32.func('void *CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)'),
    DefWindowProcW: user32.func('intptr_t DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)'),
    DestroyWindow: user32.func('bool DestroyWindow(void *hwnd)'),
    GetModuleHandleW: api.kernel32.func('void *GetModuleHandleW(const char16_t *name)'),
    PeekMessageW: user32.func('bool PeekMessageW(_Out_ DST_NW_MSG *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)'),
    TranslateMessage: user32.func('bool TranslateMessage(DST_NW_MSG *msg)'),
    DispatchMessageW: user32.func('intptr_t DispatchMessageW(DST_NW_MSG *msg)'),
    GetDC: user32.func('void *GetDC(void *hwnd)'),
    ReleaseDC: user32.func('int ReleaseDC(void *hwnd, void *hdc)'),
    BeginPaint: user32.func('void *BeginPaint(void *hwnd, _Out_ DST_NW_RECT *ps)'),
    EndPaint: user32.func('bool EndPaint(void *hwnd, DST_NW_RECT *ps)'),
    InvalidateRect: user32.func('bool InvalidateRect(void *hwnd, DST_NW_RECT *rect, bool erase)'),
    UpdateLayeredWindow: user32.func('bool UpdateLayeredWindow(void *hwnd, void *dstDc, DST_NW_POINT *dst, DST_NW_SIZE *size, void *srcDc, DST_NW_POINT *src, uint32_t key, DST_NW_BLENDFUNCTION *blend, uint32_t flags)'),
    SetWindowPos: user32.func('bool SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
    ShowWindow: user32.func('bool ShowWindow(void *hwnd, int cmd)'),
    SetWindowTextW: user32.func('bool SetWindowTextW(void *hwnd, const char16_t *title)'),
    GetCursorPos: user32.func('bool GetCursorPos(_Out_ DST_NW_POINT *pt)'),
    SetCapture: user32.func('void *SetCapture(void *hwnd)'),
    ReleaseCapture: user32.func('bool ReleaseCapture()'),
    SetCursor: user32.func('void *SetCursor(void *cursor)'),
    LoadCursorW: user32.func('void *LoadCursorW(void *instance, const char16_t *name)'),
    TrackMouseEvent: user32.func('bool TrackMouseEvent(_Inout_ DST_NW_TRACKMOUSEEVENT *event)'),
    GetDpiForWindow: user32.func('uint32 GetDpiForWindow(void *hwnd)'),
    GetWindowRect: user32.func('bool GetWindowRect(void *hwnd, _Out_ DST_NW_RECT *rect)'),
  }
  const g = {
    CreateCompatibleDC: gdi32.func('void *CreateCompatibleDC(void *hdc)'),
    CreateDIBSection: gdi32.func('void *CreateDIBSection(void *hdc, DST_NW_BITMAPINFOHEADER *info, uint32_t usage, _Out_ void **bits, void *section, uint32_t offset)'),
    SelectObject: gdi32.func('void *SelectObject(void *hdc, void *obj)'),
    DeleteObject: gdi32.func('int DeleteObject(void *obj)'),
    DeleteDC: gdi32.func('int DeleteDC(void *hdc)'),
    CreateRoundRectRgn: gdi32.func('void *CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)'),
    CreateEllipticRgn: gdi32.func('void *CreateEllipticRgn(int x1, int y1, int x2, int y2)'),
  }
  const SetWindowRgn = user32.func('int SetWindowRgn(void *hwnd, void *hrgn, bool redraw)')

  const WS_POPUP = 0x80000000
  const WS_EX_LAYERED = 0x00080000
  const WS_EX_TOOLWINDOW = 0x00000080
  const WS_EX_APPWINDOW = 0x00040000
  const WS_EX_TOPMOST = 0x00000008
  const WS_EX_NOACTIVATE = 0x08000000
  const SWP_NOSIZE = 0x0001
  const SWP_NOMOVE = 0x0002
  const SWP_NOZORDER = 0x0004
  const SWP_NOACTIVATE = 0x0010
  const SWP_SHOWWINDOW = 0x0040
  const SW_HIDE = 0
  const SW_SHOWNOACTIVATE = 4
  const SW_MINIMIZE = 6
  const SW_RESTORE = 9
  const SIZE_MINIMIZED = 1
  const GWL_EXSTYLE = -20
  const ULW_ALPHA = 0x00000002
  const AC_SRC_OVER = 0x00
  const AC_SRC_ALPHA = 0x01

  const state = {
    hwnd: null,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    visible: false,
    data: options.initialState ?? {},
    hover: null,
    cursor: 'default',
    tracking: false,
    destroyed: false,
    drag: null,
    /** 是否已经"临时挂上任务栏"（第一次最小化时把 TOOLWINDOW 换成 APPWINDOW）。 */
    taskbar: false,
    /** 此刻是否缩在任务栏（系统真的最小化了，不是自绘的标题条）。 */
    minimized: false,
    /** 用户正在拖着边角改大小（WM_ENTERSIZEMOVE…WM_EXITSIZEMOVE 之间）。 */
    sizing: false,
    /** 最近一次读到的缩放（换屏/换缩放时用来发现"没人通知我"的那种变化）。 */
    scale: null,
    /** 正在处理一次缩放变化（防止重排触发的 WM_SIZE 又进来套娃）。 */
    dpiBusy: false,
  }

  let className = null
  let wndProc = null
  let timer = null
  const message = {}
  /** 最近收到的消息 id（排障用：能看到 Windows 到底发了什么过来）。 */
  const recentMessages = []

  /** 当前缩放（1.0 = 96dpi）。 */
  function scale() {
    try {
      const dpi = Number(u.GetDpiForWindow(state.hwnd))
      return dpi > 0 ? dpi / 96 : 1
    } catch {
      return 1
    }
  }

  /**
   * 发现缩放变了就通知调用方。
   *
   * 为什么不能只靠 `WM_DPICHANGED`：窗口缩在任务栏里的时候不出这个通知，等用户从任务栏
   * 点回来，WM_SIZE 带回的还是旧物理尺寸、旧 DIP 布局——卡片就永远停在"小一号"上
   * （实测：125%→150% 之后仍是 475×575，DIP 只剩 316×383）。所以任何几何消息进来，
   * 都顺手比一下缩放；对不上就按"刚换了缩放"处理。
   *
   * @param hint - 传回给 onDpiChanged 的系统建议矩形（没有就 null）。
   */
  function syncScale(hint = null) {
    const current = scale()
    // 第一次读到缩放只记下来，不通知：那时候调用方正在摆这张卡，没有"从旧缩放换过来"这回事
    // （通知了会多绕一圈 applyPanelMode，虽然结果一样，但没必要）。
    if (state.scale === null) {
      state.scale = current
      return current
    }
    if (Math.abs(current - state.scale) < 0.01) return current
    state.scale = current
    // onDpiChanged 里的重排会再触发 WM_SIZE / WINDOWPOSCHANGED：别让它套娃。
    if (state.dpiBusy) return current
    state.dpiBusy = true
    try {
      options.onDpiChanged?.(current, hint)
    } finally {
      state.dpiBusy = false
    }
    return current
  }

  /** 光标形状（拖动区/缩放区/普通）。 */
  const CURSORS = {
    default: null,
    hand: 32649, // IDC_HAND
    sizeAll: 32646, // IDC_SIZEALL
    sizeNWSE: 32642,
    sizeNESW: 32643,
    sizeWE: 32644,
    sizeNS: 32645,
  }
  function applyCursor(name, force = false) {
    if (!force && state.cursor === name) return
    state.cursor = name
    const id = CURSORS[name]
    if (id === null || id === undefined) return
    const handle = u.LoadCursorW(null, koffi.as(id, 'char16_t *'))
    if (handle !== null) u.SetCursor(handle)
  }

  /**
   * 缩放方向的 HT 代码 → 光标形状。
   *
   * 光标必须自己换：类光标是 null，光靠 DefWindowProc 不保证在无边框弹窗上给出
   * 拉伸指针；而"这条边能不能拉"全靠指针告诉用户（尤其是新加的上边）。
   */
  const RESIZE_CURSORS = {
    [HT.LEFT]: 'sizeWE',
    [HT.RIGHT]: 'sizeWE',
    [HT.TOP]: 'sizeNS',
    [HT.BOTTOM]: 'sizeNS',
    [HT.TOPLEFT]: 'sizeNWSE',
    [HT.BOTTOMRIGHT]: 'sizeNWSE',
    [HT.TOPRIGHT]: 'sizeNESW',
    [HT.BOTTOMLEFT]: 'sizeNESW',
  }

  /** 把一帧画进 DIB 并带 alpha 贴到屏幕。 */
  let paintCount = 0
  /** 最近若干次 WM_NCHITTEST 的判定（排障用：点下去变拉伸时看这里）。 */
  const hitTrace = []
  function recordHit(x, y, localX, localY, zone) {
    hitTrace.push({ at: Date.now(), x, y, localX, localY, zone })
    if (hitTrace.length > 12) hitTrace.shift()
  }
  /** 最近一次贴图的结果（排障用：UpdateLayeredWindow 失败时窗口会停在旧几何上）。 */
  let lastBlit = { ok: null, error: 0, width: 0, height: 0, at: 0 }

  function paint() {
    if (state.hwnd === null || state.destroyed) return
    // 缩进任务栏期间窗口只有"图标尺寸"（实测 199x34），这时候重建位图会把卡片做成一
    // 小块，还原后只剩那一小块可见。最小化状态下不画，等还原后再画。
    if (api.IsIconic(state.hwnd)) return
    paintCount += 1
    // 位置**和尺寸**都以系统里的真实矩形为准（原生拖动期间 state.x/y 由 WM_MOVE 同步，
    // 尺寸则不是每次变化都有 onResized：DPI 变化、外部 SetWindowPos、UpdateLayeredWindow
    // 自己带的尺寸都会改窗口）。这里不同步尺寸的后果是：下一帧按旧尺寸重建位图、再把这个
    // 旧尺寸写回窗口——卡片自己变大变小，而 record.panel.rect 还停在创建时的值，
    // 表现就是「输入条飘到屏幕别处」和「点 ✕ 关不掉」（命中区按窗口算、看到的图按旧尺寸画）。
    const actual = {}
    if (u.GetWindowRect(state.hwnd, actual)) {
      state.x = actual.left
      state.y = actual.top
      const realWidth = actual.right - actual.left
      const realHeight = actual.bottom - actual.top
      if (realWidth > 0 && realHeight > 0) {
        state.width = realWidth
        state.height = realHeight
      }
    }
    const width = Math.max(1, Math.round(state.width))
    const height = Math.max(1, Math.round(state.height))
    const screenDc = u.GetDC(null)
    const memDc = g.CreateCompatibleDC(screenDc)
    const header = {
      biSize: koffi.sizeof(BITMAPINFOHEADER),
      biWidth: width,
      biHeight: -height, // 自上而下
      biPlanes: 1,
      biBitCount: 32,
      biCompression: 0,
      biSizeImage: width * height * 4,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    }
    const bits = [null]
    const dib = g.CreateDIBSection(screenDc, header, 0, bits, null, 0)
    if (dib === null) {
      g.DeleteDC(memDc)
      u.ReleaseDC(null, screenDc)
      return
    }
    const previous = g.SelectObject(memDc, dib)
    try {
      const painter = gdi.painterFromHdc(memDc)
      if (painter !== null) {
        try {
          options.onPaint(painter, width, height, state.data, scale())
        } finally {
          painter.dispose()
        }
      }
      const blend = { BlendOp: AC_SRC_OVER, BlendFlags: 0, SourceConstantAlpha: 255, AlphaFormat: AC_SRC_ALPHA }
      // 传的 dst/size 是**刚从 GetWindowRect 读回来的真实矩形**，不是缓存：
      // 这样贴图既刷新了内容，又不会把窗口拽到旧位置（那正是"点一下卡片就跳/进缩放模式"的根因）。
      // 注意：dst/size 传 NULL 虽然"不动几何"，但窗口尺寸刚变过时会把内容留成空白，实测不可用。
      const dst = { x: Math.round(state.x), y: Math.round(state.y) }
      const size = { cx: width, cy: height }
      const blitOk = u.UpdateLayeredWindow(state.hwnd, screenDc, dst, size, memDc, { x: 0, y: 0 }, 0, blend, ULW_ALPHA)
      // 贴完核对：如果 ULW 把窗口挪偏了，记下来，下一次 /status 就能看到。
      const after = {}
      const moved = u.GetWindowRect(state.hwnd, after)
        && (after.left !== dst.x || after.top !== dst.y || (after.right - after.left) !== width || (after.bottom - after.top) !== height)
      lastBlit = { ok: blitOk, error: blitOk ? 0 : Number(GetLastError()), width, height, moved, at: Date.now() }
    } finally {
      g.SelectObject(memDc, previous)
      g.DeleteObject(dib)
      g.DeleteDC(memDc)
      u.ReleaseDC(null, screenDc)
    }
  }

  /** 请求重绘。 */
  function invalidate() {
    paint()
  }

  /**
   * 让窗口在任务栏里占一个按钮（或撤掉）。
   *
   * 窗口创建时带 WS_EX_TOOLWINDOW：工具窗不进任务栏、不抢焦点，适合划词浮层。
   * 用户点"最小化到任务栏"时才临时换成 WS_EX_APPWINDOW——任务栏多出一个按钮，
   * 点它就能把窗口拉回来。shell 只在窗口显示状态变化时重扫任务栏，所以换完样式
   * 要 hide + show 一次，否则按钮要等到下次窗口隐藏/显示才出现。
   */
  function setTaskbarPresence(on) {
    if (state.hwnd === null || state.taskbar === on) return
    const ex = Number(api.GetWindowLongPtrW(state.hwnd, GWL_EXSTYLE))
    const next = on
      ? (ex & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW
      : (ex | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW
    if (next !== ex) api.SetWindowLongPtrW(state.hwnd, GWL_EXSTYLE, next)
    state.taskbar = on
    u.ShowWindow(state.hwnd, SW_HIDE)
    u.ShowWindow(state.hwnd, SW_SHOWNOACTIVATE)
  }

  /** 真·最小化到 Windows 任务栏（与自绘的"收成标题条"是两件事）。 */
  function minimizeToTaskbar() {
    if (state.hwnd === null || state.destroyed) return false
    if (state.minimized) return true
    setTaskbarPresence(true)
    u.ShowWindow(state.hwnd, SW_MINIMIZE)
    state.minimized = true
    return true
  }

  /** 从任务栏恢复（用户点任务栏按钮时系统自己会还原，这里给 API/脚本用）。 */
  function restoreFromTaskbar() {
    if (state.hwnd === null || state.destroyed) return false
    if (!state.minimized && !api.IsIconic(state.hwnd)) return false
    u.ShowWindow(state.hwnd, SW_RESTORE)
    state.minimized = false
    // 还原后按系统里的真实矩形重建（最小化期间 state 可能被写成图标尺寸）。
    const restored = {}
    if (u.GetWindowRect(state.hwnd, restored)) {
      state.x = restored.left
      state.y = restored.top
      if (restored.right - restored.left > 0) state.width = restored.right - restored.left
      if (restored.bottom - restored.top > 0) state.height = restored.bottom - restored.top
    }
    paint()
    // 还原后把任务栏按钮撤掉：只在"缩在任务栏里"这段时间需要它（延迟一拍，避免在 WM_SIZE 里重入）
    if (state.taskbar) setTimeout(() => { if (!state.minimized && state.taskbar) setTaskbarPresence(false) }, 0)
    return true
  }

  /** 窗口过程。 */
  function handleMessage(hwnd, msg, wParam, lParam) {
    switch (msg) {
      case WM.NCHITTEST: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        const screen = { x, y }
        // 客户区原点必须来自**系统**（GetWindowRect），不能减 state.x/state.y：
        // 状态落后一帧（被系统挪过、贴图改过）时 localX 会算成负数，而负坐标在
        // panelHitZone 里等于"拉伸边"——整张卡于是都成了拉伸区，点一下进缩放循环。
        const origin = {}
        if (u.GetWindowRect(hwnd, origin)) {
          state.x = origin.left
          state.y = origin.top
        }
        const localX = screen.x - Math.round(state.x)
        const localY = screen.y - Math.round(state.y)
        // 只有真正的拖动/缩放区才返回非 HTCLIENT：返回 HTCAPTION 的区域，
        // Windows 会当成标题栏点击处理，**永远不会**把 WM_LBUTTONDOWN 发给客户区
        // （踩过：菜单项因此完全点不动）。
        const zone = options.onHitTest?.(localX, localY, state.data) ?? 'client'
        recordHit(screen.x, screen.y, localX, localY, zone)
        return hitTestCode(zone)
      }
      case WM.SETCURSOR: {
        // 光标形状跟着命中区走：缩放边上要看到对应的双箭头。其余区（按钮、正文、
        // 标题栏）交回 DefWindowProc，保持默认箭头。
        const name = RESIZE_CURSORS[Number(lParam) & 0xffff]
        if (name === undefined) return u.DefWindowProcW(hwnd, msg, wParam, lParam)
        applyCursor(name, true)
        return 1
      }
      case WM.MOUSEMOVE: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (state.drag !== null) {
          // 拖动用**屏幕坐标**算：窗口在光标下移动，客户区坐标会跟着变。
          const cursor = {}
          u.GetCursorPos(cursor)
          const dx = cursor.x - state.drag.screenX
          const dy = cursor.y - state.drag.screenY
          if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return 0
          state.drag.moved = true
          state.x = state.drag.winX + dx
          state.y = state.drag.winY + dy
          u.SetWindowPos(hwnd, -1, Math.round(state.x), Math.round(state.y), 0, 0, SWP_NOSIZE | SWP_NOACTIVATE)
          paint()
          return 0
        }
        if (!state.tracking) {
          state.tracking = true
          u.TrackMouseEvent({ cbSize: koffi.sizeof(TRACKMOUSEEVENT), dwFlags: 0x00000002 /* TME_LEAVE */, hwndTrack: hwnd, dwHoverTime: 0 })
        }
        const changed = options.onHover?.(x, y, state.data) === true
        if (changed) invalidate()
        return 0
      }
      case WM.MOUSELEAVE: {
        state.tracking = false
        if (options.onHover?.(-1, -1, state.data) === true) invalidate()
        return 0
      }
      case WM.LBUTTONDOWN: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        const intent = options.onMouseDown?.(x, y, state.data) ?? 'click'
        state.lastDown = { x, y, intent, at: Date.now() }
        if (intent === 'drag') {
          const cursor = {}
          u.GetCursorPos(cursor)
          state.drag = { screenX: cursor.x, screenY: cursor.y, winX: state.x, winY: state.y, moved: false }
          u.SetCapture(hwnd)
        }
        if (options.onPressed?.(x, y, state.data) === true) invalidate()
        return 0
      }
      case WM.LBUTTONUP: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (state.drag !== null) {
          const drag = state.drag
          state.drag = null
          u.ReleaseCapture()
          if (drag.moved) {
            state.x = Math.round(state.x)
            state.y = Math.round(state.y)
            options.onDragEnd?.(state.x, state.y, state.data)
            return 0
          }
        }
        state.lastUp = { x, y, at: Date.now() }
        const handled = options.onClick?.(x, y, state.data) === true
        state.lastClickHandled = handled
        if (handled) invalidate()
        return 0
      }
      case WM.CAPTURECHANGED:
        state.drag = null
        return 0
      case WM.RBUTTONDOWN: {
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (options.onRightClick?.(x, y, state.data) === true) invalidate()
        return 0
      }
      case WM.MOVE: {
        // 最小化到任务栏时系统会把窗口挪到 (-32000,-32000)（哨兵坐标），
        // 这不是用户拖动，绝不能写回位置，否则保存的坐标会被污染、还原就回不来了。
        if (state.minimized || api.IsIconic(state.hwnd)) return 0
        // 原生拖动（HTCAPTION）期间系统会连续发 WM_MOVE，不跟上的话内部坐标会过期，
        // 下一次重绘就会把窗口"拉回"旧位置（踩过：拖完窗口一滚轮就跳回去）。
        const x = (Number(lParam) & 0xffff) << 16 >> 16
        const y = (Number(lParam) >> 16) << 16 >> 16
        if (x <= -30000 || y <= -30000) return 0
        if (x !== state.x || y !== state.y) {
          state.x = x
          state.y = y
          options.onMoved?.(x, y, state.data)
        }
        return 0
      }
      case WM.EXITSIZEMOVE: {
        if (state.minimized || api.IsIconic(state.hwnd)) return 0
        options.onMoved?.(state.x, state.y, state.data)
        return 0
      }
      case WM.WINDOWPOSCHANGED: {
        // 系统在点标题栏 / 拖动循环里会把窗口抬到最前（这个窗口是 WS_EX_NOACTIVATE，
        // 不激活但照样会被抬高），压在卡片上的输入条就会被卡片盖住——通知调用方压回去。
        options.onZOrderChanged?.(state.data)
        // 换屏/换缩放之后"没人发 WM_DPICHANGED"的场合靠这里补上（见 syncScale）。
        // 缩在任务栏里的窗口坐标是 -32000 的哨兵值，那时候 GetDpiForWindow 代表不了
        // "这张卡在哪块屏"，读了会把卡片误判成换了缩放，所以跳过。
        if (!state.minimized && !api.IsIconic(state.hwnd)) syncScale()
        // ⚠️ 必须交回 DefWindowProc：自己 return 0 的话系统**不再发 WM_SIZE / WM_MOVE**
        // （MSDN 明写），于是"拖边缘改大小不重画、任务栏还原这条链整段失效"。
        return u.DefWindowProcW(hwnd, msg, wParam, lParam)
      }
      case WM.ENTERSIZEMOVE:
        // 用户开始拖着边角改大小：之后这段 WM_SIZE 才算"用户尺寸"。
        state.sizing = true
        return 0
      case WM.EXITSIZEMOVE: {
        state.sizing = false
        if (state.minimized || api.IsIconic(state.hwnd)) return 0
        options.onMoved?.(state.x, state.y, state.data)
        return 0
      }
      case WM.MOUSEWHEEL: {
        const delta = (Number(wParam) >> 16) << 16 >> 16
        if (options.onWheel?.(delta, state.data) === true) invalidate()
        return 0
      }
      case WM.ERASEBKGND:
        return 1
      case WM.PAINT: {
        const ps = {}
        u.BeginPaint(hwnd, ps)
        u.EndPaint(hwnd, ps)
        paint()
        return 0
      }
      case WM.GETMINMAXINFO: {
        // 缩放的下限：不然用户能把浮窗拖成一条线，布局就没法看了（尺寸选项是 DIP）。
        const min = options.minSize
        if (min !== undefined && min !== null) {
          const s = scale()
          const info = koffi.decode(BigInt(lParam), MINMAXINFO)
          info.ptMinTrackSize = { x: Math.round(min.width * s), y: Math.round(min.height * s) }
          koffi.encode(BigInt(lParam), MINMAXINFO, info)
        }
        return 0
      }
      case WM.SIZE: {
        const sizeKind = Number(wParam) & 0xffff
        if (sizeKind === SIZE_MINIMIZED) {
          // 缩进任务栏：窗口被系统收起，UpdateLayeredWindow 对最小化窗口不起作用。
          state.minimized = true
          options.onMinimized?.(state.data)
          return 0
        }
        // ⚠️ 顺序要紧：先把 wasMinimized 取出来并清标志，再判图标尺寸。
        // 反过来的话，"从任务栏还原"那一次 WM_SIZE 会被守卫吞掉——onRestored 不触发、
        // 不重画、taskbarMinimized 也不清，卡片就再也回不来。
        const wasMinimized = state.minimized
        if (wasMinimized) {
          state.minimized = false
          // 先让调用方清掉"在任务栏里"的标志，再重画
          options.onRestored?.(state.data)
          // 用户点任务栏按钮还原时，系统不会走 restoreFromTaskbar()，这里补撤按钮
          if (state.taskbar) setTimeout(() => { if (!state.minimized && state.taskbar) setTaskbarPresence(false) }, 0)
        }
        // 还在图标态（最小化动画中/缩在任务栏里）时，WM_SIZE 带的是"图标尺寸"（实测 199x34）
        if (api.IsIconic(state.hwnd)) return 0
        // 换屏/换缩放之后可能根本没收到 WM_DPICHANGED（缩在任务栏里的窗口就是这样），
        // 还原的这一次 WM_SIZE 是补认缩放的最后机会：先让上层按新缩放重排，再走尺寸流程。
        syncScale()
        const width = Number(lParam) & 0xffff
        const height = (Number(lParam) >> 16) & 0xffff
        // 尺寸合理性：比最小尺寸还小一大截的，一律当图标尺寸丢掉，别把卡片压成一条。
        const minSize = options.minSize
        if (minSize !== undefined && minSize !== null) {
          const s = scale()
          if (width > 0 && height > 0 && (width < minSize.width * s * 0.5 || height < minSize.height * s * 0.5)) return 0
        }
        if (width > 0 && height > 0) {
          state.width = width
          state.height = height
          // 通知调用方：窗口尺寸变了（它要更新对外汇报的矩形与"用户改过的尺寸"）。
          // ⚠️ 第 4 个参数是"这次是不是用户拖出来的"：从任务栏还原、换缩放、程序自己
          // show() 都会来这里，把它们当成"用户尺寸"记下来的话，卡片会把自己锁在错的大小上
          // （实测：150% 下还原的那次 WM_SIZE 把 316×383 记成了用户尺寸）。
          options.onResized?.(width, height, state.data, state.sizing)
          paint()
        } else if (wasMinimized) {
          paint()
        }
        return 0
      }
      case WM.DPICHANGED: {
        // 系统把"换完缩放后这块窗口该占的矩形"（物理像素）放在 lParam 里：不采纳它，
        // 窗口就停在旧的物理尺寸上，而画面里每个尺寸都乘了**新的** scale——DIP 内容被压小
        // （实测 150% 下 380×460 的设计尺寸只剩 317×383，字挤在一起、右下留白）。
        // 缩在任务栏里的窗口没有屏幕矩形，这时候只记缩放、不动几何。
        let suggested = null
        if (!state.minimized && !api.IsIconic(state.hwnd)) {
          try {
            const rect = koffi.decode(BigInt(lParam), RECT)
            const width = rect.right - rect.left
            const height = rect.bottom - rect.top
            if (width > 0 && height > 0) {
              suggested = { x: rect.left, y: rect.top, width, height }
              u.SetWindowPos(hwnd, 0, rect.left, rect.top, width, height, SWP_NOZORDER | SWP_NOACTIVATE)
            }
          } catch (error) {
            // 建议矩形读不出来（不同 koffi 版本对 intptr_t 的表示不同）也要照常重画
            options.onError?.(error)
          }
        }
        // 记下新缩放并通知上层重排（syncScale 保证"同一次变化只通知一次"）。
        syncScale(suggested)
        invalidate()
        return 0
      }
      case WM.CLOSE: {
        // 任务栏右键「关闭窗口」：DefWindowProc 会直接销毁窗口，主进程完全不知情，
        // 留下 record.panel.mode 还是 'panel'、panelReady 恒 false 的死记录——
        // 之后复用这条记录会"点了没反应"，还永久占一个 maxPanels 名额。
        options.onClosed?.(state.data)
        return 0
      }
      case WM.DESTROY:
        state.destroyed = true
        return 0
      default:
        return u.DefWindowProcW(hwnd, msg, wParam, lParam)
    }
  }

  return {
    /** 创建窗口（不可见）。 */
    create() {
      if (state.hwnd !== null) return state.hwnd
      className = options.className ?? 'DshSelectionToolsOverlay'
      // WndProc 里抛出的异常会被 koffi 吞掉、表现为"点了没反应"，所以这里兜住并上报。
      wndProc = koffi.register((hwnd, msg, wParam, lParam) => {
        recentMessages.push(Number(msg))
        if (recentMessages.length > 24) recentMessages.shift()
        try {
          return handleMessage(hwnd, msg, wParam, lParam)
        } catch (error) {
          options.onError?.(error)
          return 0
        }
      }, koffi.pointer(wndProcProto ?? 'DST_NW_WndProc'))
      const wc = {
        cbSize: koffi.sizeof(WNDCLASSEXW),
        style: 0,
        lpfnWndProc: wndProc,
        cbClsExtra: 0,
        cbWndExtra: 0,
        hInstance: u.GetModuleHandleW(null),
        hIcon: null,
        hCursor: null,
        hbrBackground: null,
        lpszMenuName: null,
        lpszClassName: className,
        hIconSm: null,
      }
      u.RegisterClassExW(wc)
      const exStyle = WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_TOPMOST | WS_EX_NOACTIVATE
      const hwnd = u.CreateWindowExW(exStyle, className, options.title ?? 'DSH', WS_POPUP, -32000, -32000, 10, 10, null, null, u.GetModuleHandleW(null), null)
      if (hwnd === null) throw new Error('CreateWindowExW failed')
      state.hwnd = hwnd
      state.destroyed = false
      // 消息泵：PeekMessage 轮询，避免阻塞伴生进程的事件循环
      timer = setInterval(() => {
        try {
          let guard = 0
          while (u.PeekMessageW(message, null, 0, 0, 1 /* PM_REMOVE */) && guard < 200) {
            guard += 1
            u.TranslateMessage(message)
            u.DispatchMessageW(message)
          }
        } catch (error) {
          options.onError?.(error)
        }
      }, 8)
      timer.unref?.()
      return hwnd
    },
    /** 显示并定位（尺寸为物理像素）。 */
    show(x, y, width, height) {
      state.x = x
      state.y = y
      state.width = width
      state.height = height
      state.visible = true
      // 缩在任务栏里的窗口，SetWindowPos 拉不回来，必须先 SW_RESTORE（会触发 WM_SIZE 还原分支）
      if (state.minimized || api.IsIconic(state.hwnd)) {
        u.ShowWindow(state.hwnd, SW_RESTORE)
        state.minimized = false
      }
      u.SetWindowPos(state.hwnd, -1 /* HWND_TOPMOST */, Math.round(x), Math.round(y), Math.round(width), Math.round(height), SWP_NOACTIVATE | SWP_SHOWWINDOW)
      paint()
    },
    hide() {
      state.visible = false
      if (state.hwnd !== null) u.ShowWindow(state.hwnd, SW_HIDE)
    },
    /** 真·最小化到任务栏 / 从任务栏恢复（自绘标题条是另一条路径，见 ui.minimized）。 */
    minimizeToTaskbar,
    restoreFromTaskbar,
    /** 临时挂/撤任务栏按钮（缩进任务栏时用）。 */
    setTaskbarPresence,
    isTaskbarMinimized: () => state.minimized,
    /** 改窗口标题：任务栏按钮的文案就是它（每个面板写自己的动作名）。 */
    setTitle(title) {
      if (state.hwnd === null) return
      try {
        u.SetWindowTextW(state.hwnd, String(title ?? ''))
      } catch {
        // 标题只影响任务栏文案，失败不影响功能
      }
    },
    invalidate,
    scale,
    state,
    /** 当前窗口尺寸（物理像素）。 */
    size: () => ({ width: state.width, height: state.height }),
    /** 内部状态快照（排障用：对照 bounds() 看谁落后了）。 */
    debug: () => ({ x: state.x, y: state.y, width: state.width, height: state.height, visible: state.visible, paints: paintCount, blit: lastBlit, hits: hitTrace.slice(-8) }),
    /** 原生窗口是否还活着（清扫游离窗时用）。 */
    alive: () => state.hwnd !== null && state.destroyed !== true && (api.IsWindow?.(state.hwnd) ?? true),
    /**
     * 当前窗口的真实矩形（物理像素）：直接问系统，不信 state 缓存。
     *
     * 贴在窗口上的独立小窗（问一问输入条）必须用它来定位，否则窗口被系统挪过之后
     * 输入条会停在旧位置。
     */
    bounds: () => {
      if (state.hwnd === null || state.destroyed) return null
      const actual = {}
      if (!u.GetWindowRect(state.hwnd, actual)) return null
      return {
        x: actual.left,
        y: actual.top,
        width: Math.round(actual.right - actual.left),
        height: Math.round(actual.bottom - actual.top),
      }
    },
    /**
     * 更新业务状态并重绘。
     * 就地合并（不换对象）：绘制期间回写的 contentHeight / stopBox 等要向调用方可见。
     */
    setState(patch) {
      Object.assign(state.data, patch)
      invalidate()
    },
    data: () => state.data,
    destroy() {
      if (timer !== null) clearInterval(timer)
      timer = null
      if (state.hwnd !== null) {
        // 最小化/隐藏在任务栏里的窗口，DestroyWindow 可能失败或留下看不见的壳：
        // 先还原、再隐藏、再销毁，最后确认一次，避免"记录没了、窗口还在"的孤儿窗。
        if (api.IsIconic(state.hwnd)) u.ShowWindow(state.hwnd, SW_RESTORE)
        u.ShowWindow(state.hwnd, SW_HIDE)
        u.DestroyWindow(state.hwnd)
        if (api.IsWindow?.(state.hwnd)) u.DestroyWindow(state.hwnd)
      }
      if (wndProc !== null) koffi.unregister(wndProc)
      state.hwnd = null
      state.destroyed = true
    },
    isAlive: () => state.hwnd !== null && !state.destroyed,
    /** 最近收到的窗口消息（排障）。 */
    recentMessages: () => recentMessages.slice(),
    /** 鼠标事件轨迹（排障）。 */
    events: () => ({ down: state.lastDown ?? null, up: state.lastUp ?? null, clickHandled: state.lastClickHandled ?? null }),
    WM,
  }
}