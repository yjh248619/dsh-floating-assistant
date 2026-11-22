import test from 'node:test'
import assert from 'node:assert/strict'

import { buildContextLabel, formatChars } from '../companion/labels.mjs'

test('formatChars：千以内按字，以上按 k，百万上按 M', () => {
  assert.equal(formatChars(0), '0 字')
  assert.equal(formatChars(40), '40 字')
  assert.equal(formatChars(999), '999 字')
  assert.equal(formatChars(1000), '1.0k 字')
  assert.equal(formatChars(12345), '12.3k 字')
  assert.equal(formatChars(1500000), '1.5M 字')
})

test('buildContextLabel：普通 deep 轮（窗口 + 文件）', () => {
  const label = buildContextLabel('① 其他应用', {
    mode: 'deep',
    window: { chars: 3200, textChars: 3200, truncated: false },
    files: [{ path: 'CompanionUi.mjs', chars: 1500, textChars: 1500, truncated: false }],
    omitted: [],
  })
  // 文件不显示名字/字数，只留一句"已添加文件"
  assert.equal(label, '① 其他应用 · 窗口 3.2k 字 · 已添加文件 · 深度')
})

test('buildContextLabel：窗口被裁过写两个口径', () => {
  const label = buildContextLabel('① 其他应用', {
    mode: 'deep',
    window: { chars: 12300, textChars: 4000, truncated: true },
    files: [],
    omitted: [{ kind: 'window', reason: 'truncated' }],
  })
  assert.equal(label, '① 其他应用 · 窗口 4.0k 字/12.3k 字 · 深度')
})

test('buildContextLabel：窗口被预算整块丢掉 ≠ 读不到', () => {
  const dropped = buildContextLabel('原文', { mode: 'deep', window: null, files: [], omitted: [{ kind: 'window', reason: 'dropped' }] })
  assert.equal(dropped, '原文 · 窗口太大没带 · 深度')
  const unavailable = buildContextLabel('原文', { mode: 'deep', window: null, files: [], omitted: [{ kind: 'window', reason: 'unavailable' }] })
  assert.equal(unavailable, '原文 · 窗口读不到 · 深度')
})

test('buildContextLabel：文件没读成也还是"已添加文件"（细节不占这一行）', () => {
  const label = buildContextLabel('原文', {
    mode: 'deep',
    window: null,
    files: [],
    omitted: [{ kind: 'file', reason: 'sensitive:secret.txt' }, { kind: 'file', reason: 'too-large:big.log' }],
  })
  assert.equal(label, '原文 · 已添加文件 · 深度')
})

test('buildContextLabel：多个文件也只加一句', () => {
  const label = buildContextLabel('原文', {
    mode: 'deep',
    window: null,
    files: [
      { path: 'a.ts', chars: 12000, textChars: 3000, truncated: true },
      { path: 'b.ts', chars: 100, textChars: 100, truncated: false },
    ],
    omitted: [{ kind: 'file', reason: 'truncated:a.ts' }],
  })
  assert.equal(label, '原文 · 已添加文件 · 深度')
})

test('buildContextLabel：quick 轮没有材料就只剩基名', () => {
  assert.equal(buildContextLabel('① DSH', { mode: 'quick', window: null, files: [], omitted: [] }), '① DSH')
})

test('buildContextLabel：空/异常摘要不炸', () => {
  assert.equal(buildContextLabel('', null), '原文')
  assert.equal(buildContextLabel('base', {}), 'base')
  assert.equal(buildContextLabel('base', { files: [{ path: 42 }], omitted: [null, { kind: 'file' }] }), 'base · 已添加文件')
})

test('buildContextLabel：两个数字取整撞车时退回精确值（别写成 4.0k/4.0k）', () => {
  // 4001 与 4000 都四舍五入成 4.0k：这一对数字会变成"读全了"的假象
  const label = buildContextLabel('① 其他应用', { window: { chars: 4001, textChars: 4000, truncated: true }, mode: 'deep' })
  assert.equal(label, '① 其他应用 · 窗口 4000/4001 字 · 深度')
  // 没撞车就还是 k 口径
  const normal = buildContextLabel('① 其他应用', { window: { chars: 12345, textChars: 4000, truncated: true }, mode: 'deep' })
  assert.equal(normal, '① 其他应用 · 窗口 4.0k 字/12.3k 字 · 深度')
})
