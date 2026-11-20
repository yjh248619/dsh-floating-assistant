import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isSensitivePath, readFileSlice, resolveWithinRoots } from '../companion/materials/read.mjs'

test('isSensitivePath：密钥/环境文件与系统目录', () => {
  assert.equal(isSensitivePath('C:\\repo\\.env'), true)
  assert.equal(isSensitivePath('C:\\repo\\.env.local'), true)
  assert.equal(isSensitivePath('C:\\repo\\id_rsa'), true)
  assert.equal(isSensitivePath('C:\\repo\\cert.pem'), true)
  assert.equal(isSensitivePath('C:\\repo\\.git\\config'), true)
  assert.equal(isSensitivePath('C:\\repo\\src\\a.ts'), false)
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
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
