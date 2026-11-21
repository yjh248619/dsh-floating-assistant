/**
 * companion/selection.mjs 的单测（纯判据部分）。
 *
 * 为什么单独钉这两条：它们是"这次手势到底有没有选中文字"的最后一道判据，错了的后果不是
 * 报错而是**悄悄拿错文字去回答**——实测踩过：画图里拖选截图时画图弹着错误框，注入的
 * Ctrl+C 把对话框文案（161 字）复制走，被判成"选中了文字"，菜单就拿着错误框的文字弹出来，
 * 图片取词（OCR）那一路永远轮不到。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { isDialogClass, looksLikeDialogCopy } from '../companion/selection.mjs'

test('looksLikeDialogCopy：Windows 对话框的 Ctrl+C 产物要认出来', () => {
  const real = [
    '---------------------------',
    '画图',
    '---------------------------',
    '无法打开文件 "D:\\img\\demo.png"。',
    '---------------------------',
    '确定',
    '---------------------------',
  ].join('\r\n')
  assert.equal(looksLikeDialogCopy(real), true)
  // 只有两条横线夹标题的最小形态
  assert.equal(looksLikeDialogCopy('-----------\n出错\n-----------'), true)
})

test('looksLikeDialogCopy：正常选区（包括正文里带分隔线）不算对话框', () => {
  assert.equal(looksLikeDialogCopy('Goroutines are scheduled by the Go runtime.'), false)
  assert.equal(looksLikeDialogCopy('第一行\n第二行\n第三行'), false)
  // 代码块里的 ---- 出现在行中间，不是"第一行就是横线 + 中间还有横线"
  assert.equal(looksLikeDialogCopy('a\n----\nb'), false)
  // 只有一条横线（Markdown 分隔线）也不算
  assert.equal(looksLikeDialogCopy('标题\n----\n正文'), false)
  // 空/短文本一律不算
  assert.equal(looksLikeDialogCopy(''), false)
  assert.equal(looksLikeDialogCopy('----\n标题'), false)
  assert.equal(looksLikeDialogCopy(null), false)
  assert.equal(looksLikeDialogCopy(undefined), false)
})

test('isDialogClass：只认 Windows 标准对话框类名', () => {
  assert.equal(isDialogClass('#32770'), true)
  assert.equal(isDialogClass('Notepad'), false)
  assert.equal(isDialogClass('Chrome_WidgetWin_1'), false)
  assert.equal(isDialogClass(''), false)
  assert.equal(isDialogClass(null), false)
  assert.equal(isDialogClass(undefined), false)
})
