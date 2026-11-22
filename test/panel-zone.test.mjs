/**
 * companion/native/ui.mjs 的**命中区**纯函数单测：八个方向 + 按钮优先 + 按实际尺寸。
 *
 * README 一直声称这份测试存在（`test/panel-zone.test.mjs`），实际从来没有过。它值得单独钉：
 * 命中区错了不是报错，而是"点了没反应"或者"一点就进系统缩放循环"——真机上很难一眼看出
 * 是哪条边界算错了。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { PANEL, panelButtons, panelHit, panelHitZone } from '../companion/native/ui.mjs'

const STATE = { minimized: false, hoverButton: null, action: 'explain', source: 'x', status: 'done' }
const W = 380
const H = 460

test('八向缩放手柄：四边中点与四个角落都要能认出来', () => {
  assert.equal(panelHitZone(1, H / 2, STATE, W, H), 'resize-left')
  assert.equal(panelHitZone(W - 1, H / 2, STATE, W, H), 'resize-right')
  assert.equal(panelHitZone(W / 2, H - 1, STATE, W, H), 'resize-bottom')
  // 上边最外面 6 DIP 是手柄，再往下才是标题栏拖动
  assert.equal(panelHitZone(W / 2, 1, STATE, W, H), 'resize-top')
  assert.equal(panelHitZone(1, H - 1, STATE, W, H), 'resize-bottomleft')
  assert.equal(panelHitZone(W - 1, H - 1, STATE, W, H), 'resize-bottomright')
})

test('上边：手柄只占最外面 6 DIP，往下就是标题栏拖动', () => {
  assert.equal(panelHitZone(W / 2, 3, STATE, W, H), 'resize-top')
  assert.equal(panelHitZone(W / 2, 20, STATE, W, H), 'caption')
  assert.equal(panelHitZone(W / 2, 100, STATE, W, H), 'client')
})

test('按钮优先于手柄：右侧角落那几个像素必须还是按钮，不能被抓成缩放', () => {
  const buttons = panelButtons(STATE, W)
  const close = buttons.find((box) => box.id === 'close')
  // 关闭按钮的左边/右边各取一个点（含贴右上角那一块）
  assert.equal(panelHitZone(close.x + 2, close.y + 2, STATE, W, H), 'client')
  assert.equal(panelHit(close.x + 2, close.y + 2, STATE, W), 'close')
  // 同一个 x 往下到正文就是 client，不是按钮
  assert.equal(panelHit(close.x + 2, 200, STATE, W), 'body')
})

test('窗口外的点一律 client（否则整块区域变成系统缩放热区）', () => {
  assert.equal(panelHitZone(-5, 100, STATE, W, H), 'client')
  assert.equal(panelHitZone(5, -5, STATE, W, H), 'client')
  assert.equal(panelHitZone(W + 10, 100, STATE, W, H), 'client')
  assert.equal(panelHitZone(100, H + 10, STATE, W, H), 'client')
})

test('折叠态只画标题条：上方可拖动、下方不提供手柄', () => {
  const folded = { ...STATE, minimized: true }
  assert.equal(panelHitZone(W / 2, 10, folded, W, H), 'caption')
  assert.equal(panelHitZone(1, H - 1, folded, W, H), 'client')
  assert.equal(panelHitZone(W - 1, H / 2, folded, W, H), 'client')
})

test('命中区按**实际**尺寸算（不是钉死设计尺寸）', () => {
  const wide = 600
  // 600 宽的窗口右边缘在 599，390 处只是正文
  assert.equal(panelHitZone(wide - 1, H / 2, STATE, wide, H), 'resize-right')
  assert.equal(panelHitZone(390, H / 2, STATE, wide, H), 'client')
  // 按钮跟着实际宽度贴右边
  const buttons = panelButtons(STATE, wide)
  const close = buttons.find((box) => box.id === 'close')
  assert.equal(close.x + close.size <= wide, true)
  assert.equal(panelHit(close.x + 2, close.y + 2, STATE, wide), 'close')
})

test('页脚「停止」只在生成中才存在（命中框由绘制写进 state.stopBox）', () => {
  // 停止框是 paintPanel 在 running 时写进 state 的：宽 54、高 28、贴右侧 16 DIP、
  // 页脚内再往下 6 DIP。命中判断只认这个框，所以这里手动放一份（等价于刚画过一帧）。
  const box = { x: W - PANEL.padding - 54, y: H - PANEL.footerHeight + 6, width: 54, height: 28 }
  const running = { ...STATE, status: 'running', stopBox: box }
  assert.equal(panelHit(box.x + 6, box.y + 10, running, W), 'stop')
  // 已完成态：paintPanel 会把 stopBox 清成 null，同一个点就不再是停止
  const done = { ...STATE, status: 'done', stopBox: null }
  assert.notEqual(panelHit(box.x + 6, box.y + 10, done, W), 'stop')
})
