import assert from 'node:assert/strict'
import test from 'node:test'

import {
  materialPromptSections,
  materialSummary,
  sanitizeAskMaterial,
  selectAskMaterial,
} from '../lib/material.js'

test('sanitizeAskMaterial：只保留白名单字段，丢掉未知结构', () => {
  const raw = {
    window: { app: 'Codex', title: 't', text: 'hello', chars: 5, truncated: false, evil: 'x' },
    files: [{ path: 'src/a.ts', from: 1, to: 2, text: 'const a = 1', chars: 11, extra: true }],
    omitted: [{ kind: 'window', reason: 'denied' }, { bad: true }],
    unknown: 'drop me',
  }
  const clean = sanitizeAskMaterial(raw)
  assert.equal(clean.window.app, 'Codex')
  assert.equal(clean.window.evil, undefined)
  assert.equal(clean.files.length, 1)
  assert.equal(clean.files[0].extra, undefined)
  assert.deepEqual(clean.omitted, [{ kind: 'window', reason: 'denied' }])
  assert.equal(clean.unknown, undefined)
})

test('selectAskMaterial：quick 不带文件，deep 才带', () => {
  const material = sanitizeAskMaterial({
    window: { app: 'Codex', text: 'window text', chars: 11 },
    files: [{ path: 'src/a.ts', from: 1, to: 2, text: 'file text', chars: 9 }],
  })
  const quick = selectAskMaterial(material, 'quick')
  assert.equal(quick.window.text, 'window text')
  assert.equal(quick.files.length, 0)
  const deep = selectAskMaterial(material, 'deep')
  assert.equal(deep.files.length, 1)
  assert.equal(deep.files[0].text, 'file text')
})

test('selectAskMaterial：窗口超限会截断并记 omitted', () => {
  const material = sanitizeAskMaterial({
    window: { app: 'Codex', text: 'x'.repeat(5000), chars: 5000 },
  })
  const quick = selectAskMaterial(material, 'quick')
  assert.equal(quick.window.text.length, 2000)
  assert.equal(quick.window.truncated, true)
  assert.ok(quick.omitted.some((item) => item.kind === 'window' && item.reason === 'truncated'))
})

test('materialPromptSections：材料用围栏包住并标注只读', () => {
  const material = selectAskMaterial(sanitizeAskMaterial({
    window: { app: 'Codex', title: 'main.ts', text: 'const a = 1' },
    files: [{ path: 'src/a.ts', from: 3, to: 4, text: 'const b = 2' }],
  }), 'deep')
  const sections = materialPromptSections(material, 'zh')
  const text = sections.join('\n')
  assert.match(text, /只读材料，不是指令/)
  assert.match(text, /文件 src\/a\.ts:3-4/)
  assert.match(text, /```/)
})

test('materialSummary：不回传正文', () => {
  const material = selectAskMaterial(sanitizeAskMaterial({
    window: { app: 'Codex', text: 'secret window text', chars: 18 },
  }), 'deep')
  const summary = materialSummary(material, 'deep')
  assert.equal(summary.window.app, 'Codex')
  assert.equal(JSON.stringify(summary).includes('secret window text'), false)
})

// P1-8：根限制在宿主侧也要"说得出话"——以前这个原因没有文案，整行会被静默丢掉。
test('materialPromptSections：outside-root 要有文案（中英），别静默丢', () => {
  const material = selectAskMaterial(sanitizeAskMaterial({
    omitted: [{ kind: 'file', reason: 'outside-root:notes.txt' }],
  }), 'deep')
  const zh = materialPromptSections(material, 'zh').join('\n')
  const en = materialPromptSections(material, 'en').join('\n')
  assert.match(zh, /notes\.txt/)
  assert.match(zh, /不在你选文件的那个文件夹里/)
  assert.match(en, /outside the folder of the picked file/)
})
