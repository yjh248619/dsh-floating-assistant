import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { confirmPick, decodeText, isAllowedExtension, isSensitivePath, readFileSlice, resolveWithinRoots, sniffBinary } from '../companion/materials/read.mjs'

test('isSensitivePath：密钥/环境文件与系统目录', () => {
  assert.equal(isSensitivePath('C:\\repo\\.env'), true)
  assert.equal(isSensitivePath('C:\\repo\\.env.local'), true)
  assert.equal(isSensitivePath('C:\\repo\\id_rsa'), true)
  assert.equal(isSensitivePath('C:\\repo\\cert.pem'), true)
  assert.equal(isSensitivePath('C:\\repo\\.git\\config'), true)
  assert.equal(isSensitivePath('C:\\repo\\src\\a.ts'), false)
  assert.equal(isSensitivePath('C:\\repo\\main.tex'), false)
  assert.equal(isAllowedExtension('C:\\repo\\main.tex'), true)
})

test('isSensitivePath：Windows 路径不区分大小写', () => {
  assert.equal(isSensitivePath('C:\\WINDOWS\\Temp\\notes.txt'), true)
  assert.equal(isSensitivePath('C:\\Windows\\System32\\drivers\\etc\\hosts.txt'), true)
  assert.equal(isSensitivePath('C:\\Users\\yan\\.SSH\\config.txt'), true)
  assert.equal(isSensitivePath('D:\\proj\\NODE_MODULES\\x\\index.js'), true)
  assert.equal(isSensitivePath('C:\\Users\\yan\\AppData\\Local\\Temp\\a.txt'), true)
  // 正常路径不受影响（只是大小写变了而已）
  assert.equal(isSensitivePath('D:\\proj\\SRC\\a.ts'), false)
})

test('resolveWithinRoots：根内允许，根外/敏感文件拒绝', async () => {
  const root = await mkdtemp('D:\\划词助手\\dsh-material-')
  const outsideDir = await mkdtemp('D:\\划词助手\\dsh-material-out-')
  try {
    const inside = join(root, 'a.ts')
    const outside = join(outsideDir, 'b.ts')
    const env = join(root, '.env')
    await writeFile(inside, 'const a = 1\n', 'utf8')
    await writeFile(outside, 'const b = 2\n', 'utf8')
    await writeFile(env, 'SECRET=1\n', 'utf8')

    const ok = await resolveWithinRoots(inside, [root])
    assert.equal(ok.ok, true)
    const out = await resolveWithinRoots(outside, [root])
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'outside-root')
    const secret = await resolveWithinRoots(env, [root])
    assert.equal(secret.ok, false)
    assert.equal(secret.reason, 'sensitive')
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('readFileSlice：文末换行不算一行（行号不越界）', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-material-'))
  try {
    const thirty = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join('\n') + '\n'
    const file = join(root, 'thirty.txt')
    await writeFile(file, thirty, 'utf8')
    const slice = await readFileSlice(file, 1, 400)
    assert.equal(slice.from, 1)
    assert.equal(slice.to, 30)
    assert.equal(slice.truncated, false)
    assert.equal(slice.text.trimEnd().split('\n').length, 30)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readFileSlice：按行取片段并标记截断', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-material-'))
  try {
    const file = join(root, 'a.ts')
    await writeFile(file, 'line1\nline2\nline3\nline4\n', 'utf8')
    const slice = await readFileSlice(file, 2, 3)
    assert.equal(slice.from, 2)
    assert.equal(slice.to, 3)
    assert.match(slice.text, /^line2\nline3$/)
    assert.equal(slice.truncated, true)
    assert.equal(slice.encoding, 'utf-8')
    const empty = join(root, 'empty.txt')
    await writeFile(empty, '', 'utf8')
    const emptySlice = await readFileSlice(empty)
    assert.equal(emptySlice.reason, 'empty')
    assert.equal(emptySlice.text, '')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- 编码嗅探（实测踩过：GBK 静默乱码）

test('decodeText：BOM 决定 UTF-8 / UTF-16 的读法', () => {
  const utf8Bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文一', 'utf8')])
  assert.deepEqual(decodeText(utf8Bom), { text: '中文一', encoding: 'utf-8-bom' })
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文二', 'utf16le')])
  assert.deepEqual(decodeText(utf16le), { text: '中文二', encoding: 'utf-16le' })
  const utf16beBody = Buffer.from('中文三', 'utf16le')
  for (let i = 0; i + 1 < utf16beBody.length; i += 2) { const t = utf16beBody[i]; utf16beBody[i] = utf16beBody[i + 1]; utf16beBody[i + 1] = t }
  const utf16be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody])
  assert.deepEqual(decodeText(utf16be), { text: '中文三', encoding: 'utf-16be' })
})

test('decodeText：GBK/GB2312 要能解成正确的中文，而不是一串替换字符', () => {
  // "中文测试" 的 GB2312 字节
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4])
  const decoded = decodeText(gbk)
  assert.equal(decoded.text, '中文测试')
  assert.equal(decoded.encoding, 'gb18030')
  assert.equal(decoded.text.includes('\uFFFD'), false)
  // 纯 ASCII 仍按 UTF-8（不要因为"GBK 也能解"就改变正常文件的行为）
  assert.deepEqual(decodeText(Buffer.from('plain ascii', 'utf8')), { text: 'plain ascii', encoding: 'utf-8' })
})

test('decodeText：图片/压缩包魔数、NUL、两种编码都解不干净 → 二进制或标记', () => {
  assert.equal(decodeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])), null)
  assert.equal(decodeText(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x41, 0x42])), null)
  assert.equal(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00])), null)
  assert.equal(decodeText(Buffer.from([0x41, 0x00, 0x42, 0x00])), null)
  // 随机高位字节：UTF-8 与 GB18030 都只剩替换字符 → 如实标成 utf-8?
  const junk = Buffer.from([0x81, 0x82, 0x83, 0x84, 0x85])
  assert.equal(decodeText(junk).encoding, 'utf-8?')
})

test('sniffBinary：只认明确的容器魔数', () => {
  assert.equal(sniffBinary(Buffer.from('%PDF-1.7')), 'pdf')
  assert.equal(sniffBinary(Buffer.from('GIF89a')), 'gif')
  assert.equal(sniffBinary(Buffer.from('MZ\x90\x00')), 'exe')
  assert.equal(sniffBinary(Buffer.from('hello world')), null)
  assert.equal(sniffBinary(Buffer.alloc(0)), null)
})

// ---------------------------------------------------------------- 根限制（P1-8：有单测、生产零调用的那段）

test('confirmPick：根取文件真实路径的所在目录，敏感/类型/UNC 当场拒', async () => {
  const root = await mkdtemp('D:\\划词助手\\dsh-material-')
  try {
    const file = join(root, 'a.ts')
    await writeFile(file, 'const a = 1\n', 'utf8')
    const ok = await confirmPick(file)
    assert.equal(ok.ok, true)
    assert.equal(ok.root.toLowerCase(), root.toLowerCase())
    assert.equal(ok.path.toLowerCase(), file.toLowerCase())

    const secret = join(root, '.env')
    await writeFile(secret, 'SECRET=1\n', 'utf8')
    const denied = await confirmPick(secret)
    assert.deepEqual([denied.ok, denied.reason], [false, 'sensitive'])

    const exe = await confirmPick(join(root, 'a.exe'))
    assert.deepEqual([exe.ok, exe.reason], [false, 'extension'])

    const unc = await confirmPick('\\\\server\\share\\a.ts')
    assert.deepEqual([unc.ok, unc.reason], [false, 'unc'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoots：根丢了（空/未设置）就不放行', async () => {
  const root = await mkdtemp('D:\\划词助手\\dsh-material-')
  try {
    const file = join(root, 'a.ts')
    await writeFile(file, 'x\n', 'utf8')
    const empty = await resolveWithinRoots(file, [])
    assert.equal(empty.ok, false)
    assert.equal(empty.reason, 'outside-root')
    const missing = await resolveWithinRoots(file, null)
    assert.equal(missing.ok, false)
    assert.equal(missing.reason, 'outside-root')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolveWithinRoots：链接/目录联接按真实路径判，名字无害也不算通过', async (t) => {
  const root = await mkdtemp('D:\\划词助手\\dsh-material-')
  const outside = await mkdtemp('D:\\划词助手\\dsh-material-out-')
  const linkOut = join(root, 'link')
  const linkSys = join(root, 'sys')
  try {
    const notes = join(outside, 'notes.txt')
    await writeFile(notes, 'hello\n', 'utf8')
    try {
      await symlink(outside, linkOut, 'junction')
    } catch {
      t.skip('这台机器建不了目录联接')
      return
    }
    // 名字看着完全无害（root\link\notes.txt：.txt、没有敏感段），真实目标在根外。
    const escaped = await resolveWithinRoots(join(linkOut, 'notes.txt'), [root])
    assert.equal(escaped.ok, false)
    assert.equal(escaped.reason, 'outside-root')

    // 真实目标落在敏感目录（AppData）：必须按**真实路径**判成 sensitive。
    // 旧实现只判调用方给的字符串，这里会一路放行到 outside-root（甚至 ok）——这条断言就是回归闸。
    const appdata = join(outside, 'AppData')
    await mkdir(appdata, { recursive: true })
    await writeFile(join(appdata, 'notes.ini'), 'x=1\n', 'utf8')
    try {
      await symlink(appdata, linkSys, 'junction')
    } catch {
      return
    }
    const sensitive = await resolveWithinRoots(join(linkSys, 'notes.ini'), [root])
    assert.equal(sensitive.ok, false)
    assert.equal(sensitive.reason, 'sensitive')
  } finally {
    for (const link of [linkOut, linkSys]) {
      try {
        await unlink(link)
      } catch {
        // 联接没建成 / 已经没了
      }
    }
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
