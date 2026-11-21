/**
 * 截图取词：截一块屏幕区域，交给 Windows 自带的 OCR（Windows.Media.Ocr）识别。
 *
 * 为什么用系统 OCR：
 * - `Windows.Media.Ocr` 随 Windows 自带、支持中英文、不联网、没有额外 npm 依赖；
 * - Node 里直接调 WinRT 要额外绑定（代价远大于起一次子进程），所以走 PowerShell 桥。
 *
 * 只在「UIA 读不到文字、剪贴板也拿不到文字」的截图/图片场景调用——正常划词一次都不走这里。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { captureScreenRect } from './capture.mjs'

const SCRIPT = fileURLToPath(new URL('./ocr.ps1', import.meta.url))
/** 太小/太大的选区都没意义：太小的 OCR 不稳，太大的截屏慢、识别也慢。 */
const MIN_EDGE = 8
const MAX_EDGE = 2600

/** CJK 字符（汉字）。OCR 会在汉字之间插空格，识别完要收回去。 */
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/

/**
 * 把 Windows OCR 的原始结果整理成可读文本：
 * - 逐行 trim、丢空行；
 * - 去掉**汉字之间**多出来的空格（Windows OCR 对中文逐字断词时会插空格）。
 */
export function tidyOcrText(raw) {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\u3000]+/g, ' ').trim())
    .filter((line) => line !== '')
  const tidy = lines.map((line) => {
    let text = line
    for (let round = 0; round < 8; round++) {
      const next = text.replace(new RegExp(`(${CJK.source}) (?=${CJK.source})`, 'g'), '$1')
      if (next === text) break
      text = next
    }
    // 汉字与中文标点之间的空格也去掉
    return text.replace(new RegExp(`(${CJK.source}) (?=[，。；：！？、）》」』】…—])`, 'g'), '$1')
  })
  return tidy.join('\n')
}

/**
 * 识别屏幕上的一块矩形。
 *
 * @param api - win32 绑定（`createWin32` 的返回值，需要 `api.koffi`）。
 * @param gdi - GDI+ 绑定（只用于保持签名与 captureScreenRect 一致，可为 null）。
 * @param rect - `{x, y, width, height}`（屏幕物理像素）。
 * @param options.timeoutMs - 子进程超时，默认 9000ms。
 * @returns `{ ok, text, reason, elapsedMs }`：**绝不抛**，失败给 reason。
 */
async function runOcr(api, gdi, rect, options, started) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 9000
  const x = Number(rect?.x)
  const y = Number(rect?.y)
  const width = Number(rect?.width)
  const height = Number(rect?.height)
  if (![x, y, width, height].every((value) => Number.isFinite(value))) return { ok: false, text: '', reason: 'bad-rect', elapsedMs: 0 }
  if (width < MIN_EDGE || height < MIN_EDGE) return { ok: false, text: '', reason: 'too-small', elapsedMs: 0 }
  if (api === null || api === undefined) return { ok: false, text: '', reason: 'no-win32', elapsedMs: 0 }

  let dir = ''
  try {
    dir = mkdtempSync(join(tmpdir(), 'dsh-ocr-'))
    const bmp = join(dir, 'region.bmp')
    // 选区特别大时只截中间那块（OCR 对超大图又慢又差）；坐标仍按原图比例取中。
    let sx = x
    let sy = y
    let sw = width
    let sh = height
    if (sw > MAX_EDGE || sh > MAX_EDGE) {
      const scale = Math.min(MAX_EDGE / sw, MAX_EDGE / sh)
      sw = Math.max(MIN_EDGE, Math.round(sw * scale))
      sh = Math.max(MIN_EDGE, Math.round(sh * scale))
      sx = Math.round(x + (width - sw) / 2)
      sy = Math.round(y + (height - sh) / 2)
    }
    captureScreenRect(api, gdi, sx, sy, sw, sh, bmp)
    const result = await runScript(bmp, timeoutMs)
    if (result.error !== undefined && result.error !== null) {
      return { ok: false, text: '', reason: 'spawn: ' + String(result.error.message ?? result.error), elapsedMs: Date.now() - started }
    }
    const stdout = String(result.stdout ?? '')
    if (stdout.includes('NO_ENGINE')) return { ok: false, text: '', reason: 'no-engine', elapsedMs: Date.now() - started }
    const start = stdout.indexOf('<<<TEXT>>>')
    const end = stdout.indexOf('<<<END>>>')
    if (start < 0 || end < 0) {
      const stderr = String(result.stderr ?? '').trim().split(/\r?\n/).slice(-2).join(' | ')
      return { ok: false, text: '', reason: 'ocr-failed' + (stderr === '' ? '' : ': ' + stderr), elapsedMs: Date.now() - started }
    }
    const text = tidyOcrText(stdout.slice(start + '<<<TEXT>>>'.length, end))
    return { ok: text !== '', text, reason: text === '' ? 'empty' : 'ok', elapsedMs: Date.now() - started }
  } catch (error) {
    return { ok: false, text: '', reason: 'error: ' + String(error?.message ?? error), elapsedMs: Date.now() - started }
  } finally {
    if (dir !== '') {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清不掉不影响结果 */
      }
    }
  }
}


/**
 * 跑一次 ocr.ps1：**异步**，带超时 kill。
 *
 * 以前这里是 spawnSync(timeout: 9000)：识别期间整个 companion 事件循环是停的——鼠标轮询、
 * 卡片重绘、连 /status 与 /click 都没反应（和文件对话框同一类问题）。现在只阻塞这个 Promise。
 * @returns {Promise<{code?:number, stdout:string, stderr:string, error?:Error}>}
 */
function runScript(bmp, timeoutMs) {
  return new Promise((resolve) => {
    let child = null
    let settled = false
    let timer = null
    const finish = (value) => {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, bmp], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      finish({ error, stdout: '', stderr: '' })
      return
    }
    const limit = 2 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < limit) stdout += chunk
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < limit) stderr += chunk
    })
    child.on('error', (error) => finish({ error, stdout, stderr }))
    child.on('close', (code) => finish({ code, stdout, stderr }))
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 已经退出
      }
      finish({ error: new Error('timeout'), stdout, stderr })
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 最近一次 OCR 的状态（/status 用：识别慢/失败时不用再靠猜）。 */
let lastRun = { running: false, at: 0, ok: false, reason: '', elapsedMs: 0 }

export function ocrLast() {
  return { ...lastRun }
}

/**
 * 识别屏幕上的一块矩形（异步版，签名与返回值不变）。
 * @returns {Promise<{ok:boolean, text:string, reason:string, elapsedMs:number}>} —— **绝不抛**。
 */
export async function ocrScreenRect(api, gdi, rect, options = {}) {
  const started = Date.now()
  lastRun = { running: true, at: started, ok: false, reason: '', elapsedMs: 0 }
  let value = null
  try {
    value = await runOcr(api, gdi, rect, options, started)
  } catch (error) {
    value = { ok: false, text: '', reason: 'error: ' + String(error?.message ?? error), elapsedMs: Date.now() - started }
  }
  lastRun = {
    running: false,
    at: Date.now(),
    ok: value.ok === true,
    reason: String(value.reason ?? ''),
    elapsedMs: Number(value.elapsedMs ?? 0),
  }
  return value
}
