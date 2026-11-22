/**
 * 页脚状态文案（`panelStatusText`）的单测。
 *
 * 为什么单独钉：这段文案决定"用户以为卡死了没有"。模型先吐 reasoning，首个正文增量常常要等
 * 10~20 秒；这期间页脚必须显示**在动**（秒数在走），否则用户会去点关闭。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { panelStatusText } from '../companion/native/ui.mjs'

test('首字还没来：页脚走秒（1 秒以内不显示 0s）', () => {
  const state = { status: 'running', thinkingSince: 1000 }
  assert.equal(panelStatusText(state, 1200), '思考中…')
  assert.equal(panelStatusText(state, 2000), '思考中 · 1s')
  assert.equal(panelStatusText(state, 13000), '思考中 · 12s')
  // 秒数是整数、不会因为重绘抖动成小数
  assert.equal(panelStatusText(state, 1500), '思考中 · 1s')
})

test('收到 reasoning 字数就改写字数（比秒数更有信息量）', () => {
  const state = { status: 'running', thinkingSince: 1000, reasoningChars: 1200 }
  assert.equal(panelStatusText(state, 9000), '思考中 · 1.2k 字')
  const small = { status: 'running', thinkingSince: 1000, reasoningChars: 40 }
  assert.equal(panelStatusText(small, 9000), '思考中 · 40 字')
})

test('没有等待起点时退回原来的「正在生成…」', () => {
  assert.equal(panelStatusText({ status: 'running' }), '正在生成…')
  assert.equal(panelStatusText({ status: 'running', thinkingSince: null }), '正在生成…')
})

test('其余状态照旧：读取选区 / 已完成 / 已停止 / 失败 / 就绪', () => {
  assert.equal(panelStatusText({ status: 'reading' }), '正在读取选区…')
  assert.equal(panelStatusText({ status: 'done' }), '已完成')
  assert.equal(panelStatusText({ status: 'stopped' }), '已停止')
  assert.equal(panelStatusText({ status: 'error', error: 'model call failed' }), '生成失败 · model call failed')
  assert.equal(panelStatusText({ status: 'error' }), '生成失败')
  assert.equal(panelStatusText({ status: 'idle' }), '就绪')
  assert.equal(panelStatusText(null), '就绪')
})
