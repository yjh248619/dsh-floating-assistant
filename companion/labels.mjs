/**
 * 卡片出处行（sourceLabel）的拼装。
 *
 * 单独成模块的理由：这段逻辑决定"用户一眼看到这轮到底读了什么"，但它只做字符串拼装、
 * 不碰窗口 —— 抽出来才能单测（以前埋在 main.mjs 里只能靠真机跑图看）。
 */
import { basename } from 'node:path'

/** 字数展示：1000 以内按"N 字"，以上按"12.3k 字"（避免 40 字被画成 0k）。 */
export function formatChars(value) {
  const n = Math.max(0, Math.round(Number(value) || 0))
  if (n < 1000) return `${n} 字`
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)}k 字`
  return `${(n / 1000 / 1000).toFixed(1)}M 字`
}

/**
 * 未读原因 → 卡片上的短标签。
 *
 * 词表要和 lib/material.js 里 prompt 那套说法对得上（那边写"敏感路径，未读取"这类句子，
 * 这边是单行标签，所以更短，但语义一一对应）。
 */
const OMIT_FILE_LABEL = {
  sensitive: '敏感未读',
  'too-large': '过大未读',
  binary: '二进制未读',
  extension: '类型不支持',
  empty: '空文件',
  'not-found': '不存在',
  'read-error': '读取失败',
  dropped: '超预算未读',
  truncated: '已截断',
}

/**
 * 一条 omitted → 「文件（超预算未读）a.ts」。
 *
 * reason 的格式是 `原因[:文件名]`（文件名按 basename 传，Windows 文件名里不会有冒号）。
 * 把文件名放进括号里，是为了让"原因"排在前面 —— 出处行是单行、末尾省略号截断，
 * 原因排后面就会先被吃掉，用户就会以为"读了但没答好"。
 */
export function omitFileLabel(item) {
  const raw = String(item?.reason ?? '')
  const cut = raw.indexOf(':')
  const reason = cut === -1 ? raw : raw.slice(0, cut)
  const name = cut === -1 ? '' : basename(raw.slice(cut + 1))
  const label = OMIT_FILE_LABEL[reason] ?? '未读'
  return name === '' ? `文件（${label}）` : `文件（${label}）${name}`
}

/**
 * 用宿主的权威材料摘要拼出处行。
 *
 * 窗口三态：
 * - 有材料：`窗口 4.0k 字`；被裁过写成 `窗口 4.0k 字/12.3k 字`（送审长度/原文长度，两个口径都摆出来）；
 * - 本来该有但被预算整块丢掉：`窗口太大没带`（说"读到了但没带"，不是"读不到"）；
 * - 读不到：`窗口读不到`。
 *
 * 文件同理：`文件 a.ts 3.0k 字/12.0k 字`（送审/原文），只写原文会让人以为模型拿到了整份。
 *
 * @param base - 出处基名（「① 其他应用」这类固定串）。
 * @param summary - 宿主的 `materialSummary`：`{ mode, window, files, omitted, chars }`。
 * @returns 单行出处行（不带换行）。
 */
export function buildContextLabel(base, summary) {
  const parts = [typeof base === 'string' && base !== '' ? base : '原文']
  const omitted = Array.isArray(summary?.omitted) ? summary.omitted : []
  const window = summary?.window
  if (window !== undefined && window !== null) {
    const chars = Number(window.chars ?? 0)
    const textChars = Number(window.textChars ?? 0)
    if (window.truncated === true && textChars > 0 && textChars < chars) {
      parts.push(`窗口 ${formatChars(textChars)}/${formatChars(chars)}`)
    } else {
      parts.push(chars > 0 ? `窗口 ${formatChars(chars)}` : '窗口读不到')
    }
  } else {
    const why = omitted.find((item) => item?.kind === 'window')
    if (why !== undefined) {
      const reason = String(why.reason ?? '')
      parts.push(reason === 'dropped' ? '窗口太大没带' : reason === 'truncated' ? '窗口已截断' : '窗口读不到')
    }
  }
  const files = Array.isArray(summary?.files) ? summary.files : []
  for (const item of files) {
    const name = typeof item?.path === 'string' ? basename(item.path) : ''
    const chars = Number(item?.chars ?? 0)
    const textChars = Number(item?.textChars ?? 0)
    // 文件也写「送审/原文」两个口径：只写原文会让人以为模型拿到了整份。
    const double = item?.truncated === true && textChars > 0 && textChars < chars
    const size = chars > 0
      ? ' ' + formatChars(double ? textChars : chars) + (double ? '/' + formatChars(chars) : '')
      : ''
    const cut = item?.truncated === true && !double ? '（已截断）' : ''
    parts.push(name === '' ? `文件${size}${cut}` : `文件 ${name}${size}${cut}`)
  }
  // 已经在 files 里列过的（例如"读了但截断"的 big.log）不再按 omitted 重复列一遍。
  const shown = new Set(files.map((item) => (typeof item?.path === 'string' ? basename(item.path) : '')))
  const seen = new Set()
  for (const item of omitted) {
    if (item?.kind !== 'file') continue
    const label = omitFileLabel(item)
    const raw = String(item?.reason ?? '')
    const cut = raw.indexOf(':')
    const name = cut === -1 ? '' : basename(raw.slice(cut + 1))
    if (name !== '' && shown.has(name)) continue
    if (seen.has(label)) continue
    seen.add(label)
    parts.push(label)
  }
  if (summary?.mode === 'deep') parts.push('深度')
  return parts.join(' · ')
}
