/**
 * 卡片出处行（sourceLabel）的拼装。
 *
 * 单独成模块的理由：这段逻辑决定"用户一眼看到这轮到底读了什么"，但它只做字符串拼装、
 * 不碰窗口 —— 抽出来才能单测（以前埋在 main.mjs 里只能靠真机跑图看）。
 *
 * 排版原则：出处行是**单行、末尾省略号**，宽约 324 DIP（≈34 个全角字）。
 * 所以只放"这轮大概带了什么"，不放文件名、不放每个文件的字数——那些会先把
 * 最有用的信息挤到省略号里，而且文件名本身也不该一直摊在屏幕上。
 */
/** 字数展示：1000 以内按"N 字"，以上按"12.3k 字"（避免 40 字被画成 0k）。 */
export function formatChars(value) {
  const n = Math.max(0, Math.round(Number(value) || 0))
  if (n < 1000) return `${n} 字`
  if (n < 1000 * 1000) return `${(n / 1000).toFixed(1)}k 字`
  return `${(n / 1000 / 1000).toFixed(1)}M 字`
}

/**
 * 用宿主的权威材料摘要拼出处行。
 *
 * 窗口三态：
 * - 有材料：`窗口 4.0k 字`；被裁过写成 `窗口 4.0k 字/12.3k 字`（送审长度/原文长度，两个口径都摆出来）；
 * - 本来该有但被预算整块丢掉：`窗口太大没带`（说"读到了但没带"，不是"读不到"）；
 * - 读不到：`窗口读不到`。
 *
 * 文件只写一句 `已添加文件`：不放文件名、不放字数、也不逐条列未读原因——
 * 那些细节留给 `/status` 与"没能读取"那节 prompt，卡片这一行只回答"这轮带没带文件"。
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
  const fileOmitted = omitted.some((item) => item?.kind === 'file')
  if (files.length > 0 || fileOmitted) parts.push('已添加文件')
  if (summary?.mode === 'deep') parts.push('深度')
  return parts.join(' · ')
}
