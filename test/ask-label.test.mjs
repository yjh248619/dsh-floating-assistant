import test from 'node:test'
import assert from 'node:assert/strict'

import { buildContextLabel, formatChars, omitFileLabel } from '../companion/labels.mjs'

test('formatChars：千以内按字，以上按 k，百万上按 M', () => {
  assert.equal(formatChars(0), '0 字')
  assert.equal(formatChars(40), '40 字')
  assert.equal(formatChars(999), '999 字')
  assert.equal(formatChars(1000), '1.0k 字')
  assert.equal(formatChars(12345), '12.3k 字')
  assert.equal(formatChars(1500000), '1.5M 字')
})

test('omitFileLabel：原因在前、文件名在后', () => {
  assert.equal(omitFileLabel({ kind: 'file', reason: 'sensitive:a.ts' }), '文件（敏感未读）a.ts')
  assert.equal(omitFileLabel({ kind: 'file', reason: 'dropped:C:\\deep\\dir\\b.ts' }), '文件（超预算未读）b.ts')
  assert.equal(omitFileLabel({ kind: 'file', reason: 'sensitive' }), '文件（敏感未读）')
  assert.equal(omitFileLabel({ kind: 'file', reason: 'weird' }), '文件（未读）')
})

test('buildContextLabel：普通 deep 轮', () => {
  const label = buildContextLabel('① 其他应用', {
    mode: 'deep',
    window: { chars: 3200, textChars: 3200, truncated: false },
    files: [{ path: 'a.ts', chars: 1500, textChars: 1500, truncated: false }],
    omitted: [],
  })
  assert.equal(label, '① 其他应用 · 窗口 3.2k 字 · 文件 a.ts 1.5k 字 · 深度')
})

test('buildContextLabel：窗口与文件都写「送审/原文」两个口径', () => {
  const label = buildContextLabel('① 其他应用', {
    mode: 'deep',
    window: { chars: 12300, textChars: 4000, truncated: true },
    files: [{ path: 'CompanionUi.mjs', chars: 12000, textChars: 3000, truncated: true }],
    omitted: [{ kind: 'window', reason: 'truncated' }, { kind: 'file', reason: 'truncated:CompanionUi.mjs' }],
  })
  assert.equal(label, '① 其他应用 · 窗口 4.0k 字/12.3k 字 · 文件 CompanionUi.mjs 3.0k 字/12.0k 字 · 深度')
})

test('buildContextLabel：窗口被预算整块丢掉 ≠ 读不到', () => {
  const dropped = buildContextLabel('原文', { mode: 'deep', window: null, files: [], omitted: [{ kind: 'window', reason: 'dropped' }] })
  assert.equal(dropped, '原文 · 窗口太大没带 · 深度')
  const unavailable = buildContextLabel('原文', { mode: 'deep', window: null, files: [], omitted: [{ kind: 'window', reason: 'unavailable' }] })
  assert.equal(unavailable, '原文 · 窗口读不到 · 深度')
})

test('buildContextLabel：读不到的文件也保留文件名', () => {
  const label = buildContextLabel('原文', {
    mode: 'deep',
    window: null,
    files: [{ path: 'big.log', chars: 3000, truncated: true }],
    omitted: [{ kind: 'file', reason: 'truncated:big.log' }, { kind: 'file', reason: 'sensitive:secret.txt' }],
  })
  // 没有 textChars 时退回单数 +（已截断）；同名的 truncated 不再重复列
  assert.equal(label, '原文 · 文件 big.log 3.0k 字（已截断） · 文件（敏感未读）secret.txt · 深度')
})

test('buildContextLabel：quick 轮没有材料就只剩基名', () => {
  assert.equal(buildContextLabel('① DSH', { mode: 'quick', window: null, files: [], omitted: [] }), '① DSH')
})

test('buildContextLabel：空/异常摘要不炸', () => {
  assert.equal(buildContextLabel('', null), '原文')
  assert.equal(buildContextLabel('base', {}), 'base')
  assert.equal(buildContextLabel('base', { files: [{ path: 42 }], omitted: [null, { kind: 'file' }] }), 'base · 文件 · 文件（未读）')
})
