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

/** 文件名/路径是否属于敏感名单（大小写不敏感）。 */
export function isSensitivePath(filePath) {
  const normalized = String(filePath ?? '').replace(/\//g, '\\')
  const segments = normalized.split('\\').filter((part) => part !== '')
  if (segments.some((part) => SENSITIVE_SEGMENTS.has(part))) return true
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
  if (info.size > MAX_BYTES) {
    return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: true, reason: 'too-large' }
  }
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES))
    await handle.read(buffer, 0, buffer.length, 0)
    if (buffer.includes(0)) return { path: filePath, from: 0, to: 0, text: '', chars: 0, truncated: false, reason: 'binary' }
    const all = buffer.toString('utf8').replace(/\r\n/g, '\n')
    const lines = all.split('\n')
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
    }
  } finally {
    await handle.close()
  }
}

export const FILE_MATERIAL_LIMITS = { maxBytes: MAX_BYTES, maxLines: MAX_LINES, maxChars: MAX_CHARS }
