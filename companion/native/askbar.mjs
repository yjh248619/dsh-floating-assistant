/**
 * 「问一问」的输入条 —— 一个真正的 Win32 单行输入窗。
 *
 * 为什么不是自绘：现有回答窗是 `WS_EX_LAYERED | WS_EX_NOACTIVATE` 的 GDI+ 位图，
 * 收不到键盘、也没有 IME 组合串的入口。中文输入法、光标、选区、撤销这些能力
 * 只有系统 EDIT 控件给得完整，所以这里单独开一个**非分层、可激活**的小窗：
 * 父窗只负责位置与背景，输入交给 `EDIT` 子控件，Enter 提交 / Esc 取消。
 *
 * 这一条是「外部应用里也能自由输入」的关键；它不碰现有回答窗，回答窗仍然是
 * 分层 + 不抢焦点，两者互不影响。
 */
import { decodeUtf16 } from '../win32.mjs'

const WS_POPUP = 0x80000000
const WS_CHILD = 0x40000000
const WS_VISIBLE = 0x10000000
const WS_TABSTOP = 0x00010000
const WS_VSCROLL = 0x00200000
const WS_BORDER = 0x00800000
const ES_LEFT = 0x0000
const ES_MULTILINE = 0x0004
const ES_AUTOVSCROLL = 0x0040
const ES_AUTOHSCROLL = 0x0080
const ES_WANTRETURN = 0x1000
const BS_AUTOCHECKBOX = 0x00000003
const BS_PUSHBUTTON = 0x00000000
const SS_ENDELLIPSIS = 0x00008000
const WS_EX_TOPMOST = 0x00000008
const WS_EX_TOOLWINDOW = 0x00000080

const WM_ACTIVATE = 0x0006
const WM_CLOSE = 0x0010
const WM_KEYDOWN = 0x0100
const WM_COMMAND = 0x0111
const WM_CTLCOLOREDIT = 0x0133
const WM_CTLCOLORSTATIC = 0x0138
const WM_SETFONT = 0x0030
const WM_IME_STARTCOMPOSITION = 0x010d
const WM_IME_ENDCOMPOSITION = 0x010e
const WM_IME_COMPOSITION = 0x010f
const EM_SETSEL = 0x00b1
const EM_SETCUEBANNER = 0x1501
const BM_SETCHECK = 0x00f1
const BM_GETCHECK = 0x00f0
const BST_CHECKED = 1
const GWLP_WNDPROC = -4
const SW_HIDE = 0
const SW_SHOW = 5
const SWP_NOACTIVATE = 0x0010
const SWP_SHOWWINDOW = 0x0040
const HWND_TOPMOST = -1
const VK_RETURN = 0x0d
const VK_ESCAPE = 0x1b
const VK_SHIFT = 0x10
const GCS_COMPSTR = 0x0008
const GCS_RESULTSTR = 0x0800
const WA_INACTIVE = 0
const ID_SEND = 1

const WIDTH = 460
const HEIGHT = 190

/**
 * 创建一个可复用的输入条。第一次 open 时才建窗，之后只显隐。
 * @param api - `createWin32()` 的结果（用它的 koffi / 基础 user32 绑定）。
 * @returns `{ open, close, isOpen, destroy }`
 */
export function createAskBar(api, options = {}) {
  if (api === null || api === undefined || api.koffi === undefined) throw new Error('askbar requires the win32 api')
  const koffi = api.koffi
  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')

  const WNDCLASSEXW = koffi.struct('DSA_ASK_WNDCLASSEXW', {
    cbSize: 'uint32',
    style: 'uint32',
    lpfnWndProc: 'void *',
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
  const POINT = koffi.struct('DSA_ASK_POINT', { x: 'int', y: 'int' })
  const MSG = koffi.struct('DSA_ASK_MSG', {
    hwnd: 'void *',
    message: 'uint32',
    wParam: 'uintptr_t',
    lParam: 'intptr_t',
    time: 'uint32',
    pt: POINT,
  })
  // koffi.pointer 需要一个已注册的 proto（或类型）；直接传字符串会因类型未定义而抛错，
  // 这就是之前 askBar 一直为 null、点追问/深度直接走“默认问法重跑”的原因。
  const wndProcProto = koffi.proto('intptr_t __stdcall DSA_ASK_WndProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  const editProcProto = koffi.proto('intptr_t __stdcall DSA_ASK_EditProc(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')

  const CreateWindowExW = user32.func('void *CreateWindowExW(uint32_t exStyle, const char16_t *cls, const char16_t *title, uint32_t style, int x, int y, int w, int h, void *parent, void *menu, void *instance, void *param)')
  const RegisterClassExW = user32.func('uint16 RegisterClassExW(DSA_ASK_WNDCLASSEXW *wc)')
  const DefWindowProcW = user32.func('intptr_t DefWindowProcW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  const GetModuleHandleW = koffi.load('kernel32.dll').func('void *GetModuleHandleW(const char16_t *name)')
  const PeekMessageW = user32.func('bool PeekMessageW(_Out_ DSA_ASK_MSG *msg, void *hwnd, uint32_t min, uint32_t max, uint32_t remove)')
  const TranslateMessage = user32.func('bool TranslateMessage(DSA_ASK_MSG *msg)')
  const DispatchMessageW = user32.func('intptr_t DispatchMessageW(DSA_ASK_MSG *msg)')
  const SetWindowLongPtrW = user32.func('intptr_t SetWindowLongPtrW(void *hwnd, int index, intptr_t value)')
  const CallWindowProcW = user32.func('intptr_t CallWindowProcW(intptr_t prev, void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  const SetWindowTextW = user32.func('bool SetWindowTextW(void *hwnd, const char16_t *text)')
  const GetKeyState = user32.func('int16 GetKeyState(int key)')
  const SetFocus = user32.func('void *SetFocus(void *hwnd)')
  const ShowWindow = user32.func('bool ShowWindow(void *hwnd, int cmd)')
  const SetForegroundWindow = user32.func('bool SetForegroundWindow(void *hwnd)')
  const SetWindowPos = user32.func('bool SetWindowPos(void *hwnd, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)')
  const SendMessageW = user32.func('intptr_t SendMessageW(void *hwnd, uint32_t msg, uintptr_t wParam, intptr_t lParam)')
  const CreateFontW = gdi32.func('void *CreateFontW(int height, int width, int escapement, int orientation, int weight, uint32_t italic, uint32_t underline, uint32_t strikeOut, uint32_t charSet, uint32_t outPrecision, uint32_t clipPrecision, uint32_t quality, uint32_t pitchAndFamily, const char16_t *face)')
  const CreateSolidBrush = gdi32.func('void *CreateSolidBrush(uint32_t color)')
  const SetTextColor = gdi32.func('uint32 SetTextColor(void *hdc, uint32 color)')
  const SetBkColor = gdi32.func('uint32 SetBkColor(void *hdc, uint32 color)')

  let hwnd = null
  let edit = null
  let modeBox = null
  let sendButton = null
  let titleLabel = null
  let summaryLabel = null
  let oldEditProc = 0
  let visible = false
  let composing = false
  let onCancel = null
  let onSubmit = null
  let messageTimer = null
  let font = null
  let editBrush = null
  let bgBrush = null

  const className = 'DshAskInput_' + Math.random().toString(36).slice(2, 10)
  const wndProc = koffi.register((h, msg, wParam, lParam) => {
    try {
      if (msg === WM_ACTIVATE && (Number(wParam) & 0xffff) === WA_INACTIVE) {
        // 点到别处就收起，别留一个孤儿输入条盖在别的应用上。
        if (visible) hide(false)
        return 0
      }
      if (msg === WM_CLOSE) {
        hide(true)
        return 0
      }
      if (msg === WM_COMMAND && sendButton !== null && Number(lParam) === Number(sendButton)) {
        submit()
        return 0
      }
      if (msg === WM_CTLCOLOREDIT) {
        SetTextColor(wParam, 0x00202024)
        SetBkColor(wParam, 0x00ffffff)
        return Number(editBrush)
      }
      if (msg === WM_CTLCOLORSTATIC) {
        SetTextColor(wParam, 0x00606068)
        SetBkColor(wParam, 0x00f7f7f8)
        return Number(bgBrush)
      }
      return DefWindowProcW(h, msg, wParam, lParam)
    } catch (error) {
      options.onError?.(error)
      return 0
    }
  }, koffi.pointer(wndProcProto))

  const editProc = koffi.register((h, msg, wParam, lParam) => {
    try {
      if (msg === WM_IME_STARTCOMPOSITION) {
        composing = true
        return CallWindowProcW(oldEditProc, h, msg, wParam, lParam)
      }
      if (msg === WM_IME_ENDCOMPOSITION) {
        composing = false
        return CallWindowProcW(oldEditProc, h, msg, wParam, lParam)
      }
      if (msg === WM_IME_COMPOSITION) {
        const flags = Number(lParam)
        if ((flags & GCS_RESULTSTR) !== 0) composing = false
        else if ((flags & GCS_COMPSTR) !== 0) composing = true
        return CallWindowProcW(oldEditProc, h, msg, wParam, lParam)
      }
      if (msg === WM_KEYDOWN) {
        const key = Number(wParam)
        if (key === VK_ESCAPE) {
          hide(true)
          return 0
        }
        if (key === VK_RETURN && !composing) {
          const shift = (Number(GetKeyState(VK_SHIFT)) & 0x8000) !== 0
          if (shift) return CallWindowProcW(oldEditProc, h, msg, wParam, lParam)
          submit()
          return 0
        }
      }
      return CallWindowProcW(oldEditProc, h, msg, wParam, lParam)
    } catch (error) {
      options.onError?.(error)
      return 0
    }
  }, koffi.pointer(editProcProto))

  function readText() {
    if (edit === null) return ''
    const buffer = new Uint16Array(4096)
    api.GetWindowTextW(edit, buffer, buffer.length)
    return decodeUtf16(buffer)
  }

  function create() {
    if (hwnd !== null) return
    const instance = GetModuleHandleW(null)
    bgBrush = CreateSolidBrush(0x00f7f7f8)
    editBrush = CreateSolidBrush(0x00ffffff)
    font = CreateFontW(-18, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, 'Microsoft YaHei UI')
    const wc = {
      cbSize: koffi.sizeof(WNDCLASSEXW),
      style: 0,
      lpfnWndProc: wndProc,
      cbClsExtra: 0,
      cbWndExtra: 0,
      hInstance: instance,
      hIcon: null,
      hCursor: null,
      hbrBackground: bgBrush,
      lpszMenuName: null,
      lpszClassName: className,
      hIconSm: null,
    }
    RegisterClassExW(wc)
    hwnd = CreateWindowExW(
      WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
      className,
      'DSH 问一问',
      WS_POPUP,
      -32000,
      -32000,
      WIDTH,
      HEIGHT,
      null,
      null,
      instance,
      null,
    )
    if (hwnd === null) throw new Error('CreateWindowExW(DshAskInput) failed')
    titleLabel = CreateWindowExW(
      0,
      'STATIC',
      '问一问',
      WS_CHILD | WS_VISIBLE,
      14,
      9,
      200,
      22,
      hwnd,
      null,
      instance,
      null,
    )
    summaryLabel = CreateWindowExW(
      0,
      'STATIC',
      '',
      WS_CHILD | WS_VISIBLE | SS_ENDELLIPSIS,
      14,
      32,
      WIDTH - 28,
      18,
      hwnd,
      null,
      instance,
      null,
    )
    edit = CreateWindowExW(
      0,
      'EDIT',
      '',
      WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | ES_LEFT | ES_MULTILINE | ES_AUTOVSCROLL | ES_WANTRETURN,
      14,
      52,
      WIDTH - 28,
      84,
      hwnd,
      null,
      instance,
      null,
    )
    if (edit === null) throw new Error('CreateWindowExW(DshAskEdit) failed')
    modeBox = CreateWindowExW(
      0,
      'BUTTON',
      '深度',
      WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_AUTOCHECKBOX,
      14,
      145,
      78,
      26,
      hwnd,
      null,
      instance,
      null,
    )
    if (modeBox === null) throw new Error('CreateWindowExW(DshAskMode) failed')
    sendButton = CreateWindowExW(
      0,
      'BUTTON',
      '发送',
      WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON,
      WIDTH - 92,
      143,
      78,
      30,
      hwnd,
      null,
      instance,
      null,
    )
    if (sendButton === null) throw new Error('CreateWindowExW(DshAskSend) failed')
    const hint = CreateWindowExW(
      0,
      'STATIC',
      'Enter 发送 · Shift+Enter 换行',
      WS_CHILD | WS_VISIBLE,
      100,
      149,
      250,
      18,
      hwnd,
      null,
      instance,
      null,
    )
    for (const control of [titleLabel, summaryLabel, edit, modeBox, sendButton, hint]) {
      if (control !== null) SendMessageW(control, WM_SETFONT, font, 1)
    }
    const editProcAddress = typeof koffi.address === 'function' ? Number(koffi.address(editProc)) : Number(editProc)
    oldEditProc = SetWindowLongPtrW(edit, GWLP_WNDPROC, editProcAddress)
    messageTimer = setInterval(() => {
      try {
        const msg = {}
        let guard = 0
        while (PeekMessageW(msg, null, 0, 0, 1) && guard < 100) {
          guard += 1
          TranslateMessage(msg)
          DispatchMessageW(msg)
        }
      } catch (error) {
        options.onError?.(error)
      }
    }, 8)
    messageTimer.unref?.()
  }

  function hide(cancelled) {
    if (hwnd === null) return
    visible = false
    composing = false
    ShowWindow(hwnd, SW_HIDE)
    const cancel = onCancel
    onCancel = null
    onSubmit = null
    if (cancelled && typeof cancel === 'function') cancel()
  }

  function submit() {
    const text = readText().trim()
    if (text === '') return
    const handler = onSubmit
    const mode = modeBox !== null && Number(SendMessageW(modeBox, BM_GETCHECK, 0, 0)) === BST_CHECKED ? 'deep' : 'quick'
    hide(false)
    if (typeof handler === 'function') handler(text, mode)
  }

  return {
    /**
     * 显示输入条。
     * @param {{x?:number,y?:number,text?:string,title?:string,summary?:string,mode?:string,onSubmit?:Function,onCancel?:Function}} next
     */
    open(next = {}) {
      create()
      const text = typeof next.text === 'string' ? next.text : ''
      const x = Number.isFinite(next.x) ? Math.round(next.x) : -32000
      const y = Number.isFinite(next.y) ? Math.round(next.y) : -32000
      onSubmit = typeof next.onSubmit === 'function' ? next.onSubmit : null
      onCancel = typeof next.onCancel === 'function' ? next.onCancel : null
      composing = false
      SetWindowTextW(edit, text)
      if (titleLabel !== null) SetWindowTextW(titleLabel, typeof next.title === 'string' && next.title !== '' ? next.title : '问一问')
      if (summaryLabel !== null) SetWindowTextW(summaryLabel, typeof next.summary === 'string' ? next.summary : '')
      if (modeBox !== null) SendMessageW(modeBox, BM_SETCHECK, next.mode === 'deep' ? BST_CHECKED : 0, 0)
      SetWindowPos(hwnd, HWND_TOPMOST, x, y, WIDTH, HEIGHT, SWP_SHOWWINDOW)
      ShowWindow(hwnd, SW_SHOW)
      visible = true
      SetForegroundWindow(hwnd)
      SetFocus(edit)
      SendMessageW(edit, EM_SETSEL, 0, -1)
    },
    close() {
      hide(true)
    },
    isOpen() {
      return visible
    },
    destroy() {
      if (messageTimer !== null) clearInterval(messageTimer)
      messageTimer = null
      if (hwnd !== null) user32.func('bool DestroyWindow(void *hwnd)')(hwnd)
      hwnd = null
      edit = null
      modeBox = null
    },
  }
}
