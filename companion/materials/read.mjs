/**
 * L3 文件材料：路径校验 + 只读切片。
 *
 * 这里不跑命令、不递归扫目录、不猜路径。调用方必须给一个“已确认的根”，
 * 这里只负责：realpath 后确认仍在根内、挡敏感文件/二进制/超大文件、按行取一段。
 */
import { open, realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize, resolve, sep } from 'node:path'

const MAX_BYTES = 256 * 1024
const MAX_LINES = 400
const MAX_CHARS = 8000

/**
 * 常见二进制/文档容器的**魔数**：按扩展名放行不代表内容是文本（把 .jpg 改名成 .txt 很常见）。
 * 以前只靠"有没有 NUL 字节"判断，JPEG/PNG 这类不含 NUL 的文件会被当文本读成乱码。
 */
const MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'png'],
  [[0xff, 0xd8, 0xff], 'jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'gif'],
  [[0x25, 0x50, 0x44, 0x46], 'pdf'],
  [[0x50, 0x4b, 0x03, 0x04], 'zip'],
  [[0x42, 0x4d], 'bmp'],
  [[0x7f, 0x45, 0x4c, 0x46], 'elf'],
  [[0x4d, 0x5a], 'exe'],
]

/** 前几个字节对得上魔数就返回格式名，否则 null。 */
export function sniffBinary(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  for (const [bytes, name] of MAGIC) {
    if (buf.length < bytes.length) continue
    let hit = true
    for (let i = 0; i < bytes.length; i += 1) {
      if (buf[i] !== bytes[i]) { hit = false; break }
    }
    if (hit) return name
  }
  return null
}

/** 一段文本里 U+FFFD（解码失败的替换字符）有几个。 */
function countReplacement(text) {
  let count = 0
  for (const ch of text) if (ch === '\uFFFD') count += 1
  return count
}

/** 用指定编码解码；ICU 里没有这个编码时返回 null。 */
function decodeAs(encoding, buffer) {
  try {
    return new TextDecoder(encoding).decode(buffer)
  } catch {
    return null
  }
}

/**
 * 把文件字节解成文本。
 *
 * 为什么需要它：以前直接 `buffer.toString('utf8')`，GBK/GB2312 的中文（Windows 记事本
 * 默认另存就是这类）会被解成一串 U+FFFD 而**不报错**——`reason` 还是成功，乱码原样进 prompt，
 * 模型对着乱码作答（实测：90 字节的 GB2312 文件读出 7 个替换字符）。现在的顺序：
 *
 * 1. 魔数/ NUL → 判成二进制，不读；
 * 2. BOM → UTF-8 / UTF-16LE / UTF-16BE（记事本的"Unicode"就是带 BOM 的 UTF-16）；
 * 3. 纯 UTF-8 能干净解出来（零替换字符）就用它；
 * 4. 否则试 GB18030（GBK/GB2312 的超集，Node 自带 ICU）：替换字符更少就采信，
 *    并把 `encoding` 如实报出去（`/status`、prompt 的"没能读取"都能看到）。
 *
 * @returns `{ text, encoding }`；判成二进制时返回 null。
 */
export function decodeText(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? [])
  if (buf.length === 0) return { text: '', encoding: 'utf-8' }
  const magic = sniffBinary(buf)
  if (magic !== null) return null
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const text = decodeAs('utf-16le', buf.subarray(2))
    if (text !== null) return { text, encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const text = decodeAs('utf-16be', buf.subarray(2))
    if (text !== null) return { text, encoding: 'utf-16be' }
  }
  if (buf.includes(0)) return null
  const utf8 = buf.toString('utf8')
  const bad = countReplacement(utf8)
  if (bad === 0) return { text: utf8, encoding: 'utf-8' }
  // GB18030 几乎能"硬解"任何字节序列（随机字节会解成一堆生僻汉字），所以判据必须收紧：
  // 只有**一个替换字符都没有**时才采信它。否则两份都是垃圾，老实标成 utf-8? 让调用方拒绝。
  const gb = decodeAs('gb18030', buf)
  if (gb !== null && countReplacement(gb) === 0) return { text: gb, encoding: 'gb18030' }
  return { text: utf8, encoding: 'utf-8?' }
}

const EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.java', '.kt',
  '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.rb', '.php', '.swift', '.scala',
  '.json', '.jsonc', '.md', '.mdx', '.txt', '.yml', '.yaml', '.toml', '.ini', '.cfg',
  '.css', '.scss', '.less', '.html', '.htm', '.vue', '.svelte', '.sql', '.sh', '.ps1',
  '.tex', '.bib', '.cls', '.sty', '.ltx', '.csv', '.log',
])

const SENSITIVE_NAMES = new Set([
  '.env', '.env.local', '.env.production', '.env.development', 'id_rsa', 'id_ed25519',
  'id_ecdsa', 'id_dsa', 'credentials', 'credentials.json', 'secrets.json',
])
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.jks', '.keystore'])
const SENSITIVE_SEGMENTS = new Set(['.git', '.ssh', '.gnupg', 'node_modules', 'AppData', 'Windows', 'Program Files', 'Program Files (x86)'])
/** 路径段按小写比对：Windows 路径不区分大小写，`C:\\WINDOWS\\…`、`.SSH`、`NODE_MODULES` 都是一样的东西。 */
const SENSITIVE_SEGMENTS_LOWER = new Set([...SENSITIVE_SEGMENTS].map((name) => name.toLowerCase()))

/** 文件名/路径是否属于敏感名单（大小写不敏感）。 */
export function isSensitivePath(filePath) {
  const normalized = String(filePath ?? '').replace(/\//g, '\\')
  const segments = normalized.split('\\').filter((part) => part !== '')
  if (segments.some((part) => SENSITIVE_SEGMENTS_LOWER.has(part.toLowerCase()))) return true
  const base = (segments[segments.length - 1] ?? '').toLowerCase()
  if (SENSITIVE_NAMES.has(base)) return true
  if (SENSITIVE_EXTENSIONS.has(extname(base))) return true
  return base.endsWith('.env') || base.startsWith('.env.')
}

/** 扩展名是否允许作为代码/文本材料。 */
export function isAllowedExtension(filePath) {
  return EXTENSIONS.has(extname(String(filePath ?? '')).toLowerCase())
}

/**
 * 把一个候选路径收进已确认的根。
 * @param candidate - 绝对路径（调用方负责只传绝对路径）。
 * @param roots - 已确认的根目录（绝对路径）。
 * @returns `{ ok:true, path }` 或 `{ ok:false, reason }`。
 */
export async function resolveWithinRoots(candidate, roots) {
  if (typeof candidate !== 'string' || candidate.trim() === '') return { ok: false, reason: 'empty-path' }
  if (!isAbsolute(candidate)) return { ok: false, reason: 'not-absolute' }
  if (/^\\\\|^\/\//.test(candidate)) return { ok: false, reason: 'unc' }
  if (isSensitivePath(candidate)) return { ok: false, reason: 'sensitive' }
  if (!isAllowedExtension(candidate)) return { ok: false, reason: 'extension' }
  let real
  try {
    real = await realpath(normalize(candidate))
  } catch {
    return { ok: false, reason: 'not-found' }
  }
  const list = Array.isArray(roots) ? roots : []
  for (const root of list) {
    if (typeof root !== 'string' || root.trim() === '') continue
    let realRoot
    try {
      realRoot = await realpath(normalize(root))
    } catch {
      continue
    }
    const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep
    if (real === realRoot || real.toLowerCase().startsWith(prefix.toLowerCase())) {
      return { ok: true, path: real, root: realRoot }
    }
  }
  return { ok: false, reason: 'outside-root' }
}

/**
 * 读文件的一段（按行号，1 起）。
 * @param filePath - 已通过 resolveWithinRoots 的绝对路径。
 * @param from - 起始行（1 起；0 表示从头）。
 * @param to - 结束行（含；0 表示不设上限）。
 * @returns `{ path, from, to, text, chars, truncated, reason? }`
 */
export async function readFileSlice(filePath, from = 0, to = 0) {
  const info = await stat(filePath)
  if (!info.isFile()) return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: false, reason: 'not-file' }
  if (info.size === 0) return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: false, reason: 'empty' }
  if (info.size > MAX_BYTES) {
    return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: true, reason: 'too-large' }
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    // 编码在这里统一收口：魔数/NUL → 二进制；BOM → UTF-8/UTF-16；否则先 UTF-8、必要时 GB18030。
    const decoded = decodeText(buffer)
    if (decoded === null) return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: false, reason: 'binary', encoding: '' }
    const all = decoded.text.replace(/\r\n/g, '\n')
    // 文末的换行会多切出一个空元素：不剔掉的话"30 行 + 尾换行"会被数成 31 行，
    // 报给用户的 `to` 就越界、`truncated` 也会假报（实测踩过）。
    const lines = all.split('\n')
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    const start = Math.max(0, (from > 0 ? from : 1) - 1)
    const end = to > 0 ? Math.min(lines.length, to) : lines.length
    const slice = lines.slice(start, end)
    let text = slice.join('\n')
    let truncated = end < lines.length
    if (text.length > MAX_CHARS) {
      text = text.slice(0, MAX_CHARS)
      truncated = true
    }
    const actualFrom = start + 1
    const actualTo = Math.min(end, start + slice.length)
    return {
      path: filePath,
      from: actualFrom,
      to: actualTo,
      text,
      chars: text.length,
      truncated,
      reason: truncated ? 'truncated' : '',
      /** 实际用哪种编码解出来的（`/status` 与"没能读取"那节会用到）。 */
      encoding: decoded.encoding,
    }
  } finally {
    await handle.close()
  }
}

export const FILE_MATERIAL_LIMITS = { maxBytes: MAX_BYTES, maxLines: MAX_LINES, maxChars: MAX_CHARS }
