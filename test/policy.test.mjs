/**
 * companion/policy.mjs 的单测：菜单"弹不弹"的每一条 reason 都钉在这里。
 *
 * 为什么值得单独钉：这条判断吞掉一次划词，用户只会看到"这次没反应"——没有异常、没有日志，
 * 事后只能靠 /status 里一句 reason 猜。把每个分支和它的边界（时间窗、drift、矩形挪动）
 * 都写成用例，改阈值/改顺序时才敢动。
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  menuDecision,
  unknownFallback,
  pickSelection,
  ocrRectForGesture,
  panelPixelSize,
  panelDipSize,
  PRESS_SETTLE_SLOP,
  SELECTION_MOVE_SLOP,
  STALE_REOPEN_MS,
} from '../companion/policy.mjs'

/** 造一个选区矩形。 */
function rect(left, top, right, bottom) {
  return { left, top, right, bottom }
}

/** 造一个"读到了选区"的探针结果（默认手势落在选区上）。 */
function probe(selection, extra = {}) {
  return { selection, source: 'point', atGesture: null, rects: null, ...extra }
}

const RECT = rect(100, 100, 300, 120)

test('常量：阈值是外部文档（README）与 /status 依赖的值，改动必须显式', () => {
  assert.equal(PRESS_SETTLE_SLOP, 12)
  assert.equal(SELECTION_MOVE_SLOP, 6)
  assert.equal(STALE_REOPEN_MS, 4000)
})

// ---------------------------------------------------------------- 原有分支不回归

test('probe 为 null：不表态（open=null），交给剪贴板核实', () => {
  assert.deepEqual(menuDecision(null, ''), { open: null, reason: 'unknown' })
  assert.deepEqual(menuDecision(undefined, '', { reason: 'timeout' }), { open: null, reason: 'timeout' })
})

test('shell：落在桌面/任务栏这类系统外壳上，不弹', () => {
  assert.deepEqual(menuDecision(probe('', { source: 'shell' }), ''), { open: false, reason: 'shell' })
})

test('普通元素报不出选区：不表态，不能当成"没在选文字"', () => {
  assert.deepEqual(menuDecision(probe(''), '上次那段'), { open: null, reason: 'unknown' })
})

test('selection：手势碰到这段选区就弹', () => {
  assert.deepEqual(menuDecision(probe('要解释的句子', { atGesture: true }), ''), { open: true, reason: 'selection' })
})

test('selection：拖选没碰到，但文字跟上次菜单那段不同，照弹', () => {
  const decision = menuDecision(probe('新选的一段', { atGesture: false }), '上次那段')
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

test('unchanged-selection：按下就是这段、松开还是它，且矩形跟着挪了 → 拖对象，不弹', () => {
  const decision = menuDecision(
    probe('形状里的文字', { atGesture: true, rects: [rect(200, 200, 400, 240)] }),
    '',
    { pressProbe: { selection: '形状里的文字', driftPx: 0, rects: [RECT] } },
  )
  assert.deepEqual(decision, { open: false, reason: 'unchanged-selection' })
})

test('unchanged-selection：按下快照可信、矩形原地没动 → 是重划同一段，不判 unchanged', () => {
  const decision = menuDecision(
    probe('同一段', { atGesture: true, rects: [RECT] }),
    '',
    { pressProbe: { selection: '同一段', driftPx: 0, rects: [RECT] } },
  )
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

test('unchanged-selection：矩形信息不全时仍按 unchanged 处理（老行为，别把拖形状放进来）', () => {
  const decision = menuDecision(
    probe('同一段', { atGesture: true, rects: null }),
    '',
    { pressProbe: { selection: '同一段', driftPx: 3, rects: null } },
  )
  assert.deepEqual(decision, { open: false, reason: 'unchanged-selection' })
})

test('stale-selection：同一段、手势没碰到、也没超过时间窗 → 上次留下的旧选区，不弹', () => {
  const decision = menuDecision(probe('旧选区', { atGesture: false }), '旧选区', {
    lastShownAt: null,
    now: 100_000,
  })
  assert.deepEqual(decision, { open: false, reason: 'stale-selection' })
})

test('double-not-at-gesture：双击读到文字却没命中选区，不弹（文字不同也不行）', () => {
  const decision = menuDecision(probe('别处的一段', { atGesture: false }), '上次那段', { kind: 'double' })
  assert.deepEqual(decision, { open: false, reason: 'double-not-at-gesture' })
})

// ---------------------------------------------------------------- 按下快照不可信时放行

test('按下快照拍晚了（drift 超限）：不能判 unchanged，放行', () => {
  const decision = menuDecision(
    probe('拖出来的这段', { atGesture: true }),
    '',
    { pressProbe: { selection: '拖出来的这段', driftPx: PRESS_SETTLE_SLOP + 1 } },
  )
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

test('没有按下快照（null）：不能判 unchanged，放行', () => {
  const decision = menuDecision(probe('拖出来的这段', { atGesture: true }), '', { pressProbe: null })
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

test('drift 量不到（非有限）：说不准，不能判 unchanged，放行', () => {
  for (const driftPx of [null, undefined, Number.NaN, 'unknown']) {
    const decision = menuDecision(
      probe('同一段', { atGesture: true, rects: [RECT] }),
      '',
      { pressProbe: { selection: '同一段', driftPx, rects: [RECT] } },
    )
    assert.deepEqual(decision, { open: true, reason: 'selection' }, `driftPx=${String(driftPx)}`)
  }
})

test('drift 量不到、但矩形明确跟着挪了：仍是拖对象（保留 office 保护）', () => {
  const decision = menuDecision(
    probe('形状里的文字', { atGesture: true, rects: [rect(400, 300, 600, 340)] }),
    '',
    { pressProbe: { selection: '形状里的文字', driftPx: null, rects: [RECT] } },
  )
  assert.deepEqual(decision, { open: false, reason: 'unchanged-selection' })
})

test('按下快照里没有文字：unchanged 分支直接不参与（少一条判据不影响别的分支）', () => {
  const decision = menuDecision(
    probe('同一段', { atGesture: true }),
    '',
    { pressProbe: { selection: '   ', driftPx: 0 } },
  )
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

// ---------------------------------------------------------------- selection-reopen 时间窗

const NOW = 1_700_000_000_000

test('selection-reopen：同一段文字，距上次菜单超过 STALE_REOPEN_MS → 重新弹', () => {
  const decision = menuDecision(probe('同一段', { atGesture: false }), '同一段', {
    lastShownAt: NOW - STALE_REOPEN_MS - 1,
    now: NOW,
  })
  assert.deepEqual(decision, { open: true, reason: 'selection-reopen' })
})

test('selection-reopen：刚好等于时间窗还是 stale（边界用 >，不用 >=）', () => {
  const decision = menuDecision(probe('同一段', { atGesture: false }), '同一段', {
    lastShownAt: NOW - STALE_REOPEN_MS,
    now: NOW,
  })
  assert.deepEqual(decision, { open: false, reason: 'stale-selection' })
})

test('selection-reopen：窗口内的重复划词仍然 stale（菜单刚收起，别原地一拖又弹）', () => {
  const decision = menuDecision(probe('同一段', { atGesture: false }), '同一段', {
    lastShownAt: NOW - 1000,
    now: NOW,
  })
  assert.deepEqual(decision, { open: false, reason: 'stale-selection' })
})

test('selection-reopen：老调用方不传 lastShownAt → 行为跟改动前一致（stale）', () => {
  assert.deepEqual(
    menuDecision(probe('同一段', { atGesture: false }), '同一段'),
    { open: false, reason: 'stale-selection' },
  )
  assert.deepEqual(
    menuDecision(probe('同一段', { atGesture: false }), '同一段', { lastShownAt: null, now: NOW }),
    { open: false, reason: 'stale-selection' },
  )
})

test('selection-reopen：lastShownAt 在未来（时钟回拨）不放大放行', () => {
  const decision = menuDecision(probe('同一段', { atGesture: false }), '同一段', {
    lastShownAt: NOW + 5000,
    now: NOW,
  })
  assert.deepEqual(decision, { open: false, reason: 'stale-selection' })
})

test('selection-reopen：文字变了就走 selection，不占用 reopen 这一档', () => {
  const decision = menuDecision(probe('另一段', { atGesture: false }), '同一段', {
    lastShownAt: NOW - STALE_REOPEN_MS * 2,
    now: NOW,
  })
  assert.deepEqual(decision, { open: true, reason: 'selection' })
})

test('selection-reopen：staleReopenMs 可覆盖（负数/非有限值忽略，回落到常量）', () => {
  const far = { lastShownAt: NOW - 5000, now: NOW }
  assert.deepEqual(
    menuDecision(probe('同一段', { atGesture: false }), '同一段', { ...far, staleReopenMs: 10_000 }),
    { open: false, reason: 'stale-selection' },
  )
  assert.deepEqual(
    menuDecision(probe('同一段', { atGesture: false }), '同一段', { ...far, staleReopenMs: 1000 }),
    { open: true, reason: 'selection-reopen' },
  )
  assert.deepEqual(
    menuDecision(probe('同一段', { atGesture: false }), '同一段', { ...far, staleReopenMs: -1 }),
    { open: true, reason: 'selection-reopen' },
  )
})

test('selection-reopen：now 缺省时用 Date.now()（不传也能工作）', () => {
  const decision = menuDecision(probe('同一段', { atGesture: false }), '同一段', {
    lastShownAt: Date.now() - STALE_REOPEN_MS - 60_000,
  })
  assert.deepEqual(decision, { open: true, reason: 'selection-reopen' })
})

// ---------------------------------------------------------------- unknownFallback

test('unknownFallback：双击不弹、拖选照弹（老行为，兜底只在核不出结论时用）', () => {
  assert.deepEqual(unknownFallback('double'), { open: false, reason: 'double-unverified' })
  assert.deepEqual(unknownFallback('drag'), { open: true, reason: 'unknown' })
  assert.deepEqual(unknownFallback(undefined), { open: true, reason: 'unknown' })
})

// ---------------------------------------------------------------- pickSelection

test('pickSelection：按优先级取第一个非空来源，文字保持原样', () => {
  const picked = pickSelection([
    { source: 'uia-prefetch', text: '  ' },
    { source: 'uia-fresh', text: ' 第一行\n第二行 ' },
    { source: 'clipboard', text: '不该用到' },
  ])
  assert.deepEqual(picked, { text: ' 第一行\n第二行 ', source: 'uia-fresh' })
})

test('pickSelection：空数组/非数组/全空 → null；source 缺失记 unknown', () => {
  assert.equal(pickSelection([]), null)
  assert.equal(pickSelection(null), null)
  assert.equal(pickSelection([{ text: '' }, { text: '\n\t' }]), null)
  assert.deepEqual(pickSelection([{ text: '留下' }]), { text: '留下', source: 'unknown' })
})

// ---------------------------------------------------------------- OCR 取词矩形

test('ocrRectForGesture：按真实手势形状取"按下点 → 松开点"的外接框', () => {
  // 真实手势：x/y 是松开点、downX/downY 是按下点、at 是时间戳（不是点！）
  const gesture = { kind: 'drag', x: 1020, y: 434, downX: 300, downY: 380, at: 1795284426264, press: { x: 300, y: 380 } }
  assert.deepEqual(ocrRectForGesture(gesture), { x: 300, y: 380, width: 720, height: 54 })
  // 反方向拖（从右下往左上）也要归一化成左上角 + 正宽高
  assert.deepEqual(ocrRectForGesture({ x: 300, y: 380, downX: 1020, downY: 434 }), { x: 300, y: 380, width: 720, height: 54 })
  // 老形状 at:{x,y} 仍然认
  assert.deepEqual(ocrRectForGesture({ at: { x: 500, y: 500 }, downX: 300, downY: 300 }), { x: 300, y: 300, width: 200, height: 200 })
  // 缺按下点时用 press / selection 兜底
  assert.deepEqual(ocrRectForGesture({ x: 400, y: 400, press: { x: 100, y: 100 } }), { x: 100, y: 100, width: 300, height: 300 })
  assert.deepEqual(ocrRectForGesture({ x: 400, y: 400 }, { x: 100, y: 100 }), { x: 100, y: 100, width: 300, height: 300 })
})

test('ocrRectForGesture：太小的框、缺坐标、空手势一律 null', () => {
  // 单击/双击误判：外接框不足 48px
  assert.equal(ocrRectForGesture({ x: 100, y: 100, downX: 105, downY: 100 }), null)
  assert.equal(ocrRectForGesture({ x: 400, y: 400, downX: 300, downY: 300 }, null, 200), null)
  assert.equal(ocrRectForGesture(null), null)
  assert.equal(ocrRectForGesture(undefined), null)
  // at 是时间戳（老 bug 的现场）：不能把数字当点，坐标拿不到就 null
  assert.equal(ocrRectForGesture({ at: 1795284426264, x: NaN, y: NaN }), null)
})

// ---------------------------------------------------------------- 尺寸换算（DIP ⇄ 物理像素）

test('panelPixelSize：同一份 DIP 在任何缩放下都还是那个 DIP', () => {
  const design = { width: 380, height: 460 }
  assert.deepEqual(panelPixelSize(design, 1), { width: 380, height: 460 })
  assert.deepEqual(panelPixelSize(design, 1.25), { width: 475, height: 575 })
  assert.deepEqual(panelPixelSize(design, 1.5), { width: 570, height: 690 })
  // 用户拖过的尺寸也走同一条路（不是整数 DIP 也要按目标屏现算）
  assert.deepEqual(panelPixelSize({ width: 412.5, height: 333.33 }, 1.5), { width: 619, height: 500 })
})

test('panelPixelSize：缩放/尺寸缺失按 1 与非正数处理，不返回负数尺寸', () => {
  assert.equal(panelPixelSize(null, 1.5), null)
  assert.equal(panelPixelSize(undefined, 1), null)
  assert.equal(panelPixelSize({ width: 0, height: 460 }, 1.5), null)
  assert.equal(panelPixelSize({ width: 380, height: -1 }, 1.5), null)
  // scale 是 0/NaN/字符串时退回 1，而不是算出 0 宽
  assert.deepEqual(panelPixelSize({ width: 380, height: 460 }, 0), { width: 380, height: 460 })
  assert.deepEqual(panelPixelSize({ width: 380, height: 460 }, NaN), { width: 380, height: 460 })
  assert.deepEqual(panelPixelSize({ width: 380, height: 460 }, '1.5'), { width: 570, height: 690 })
})

test('panelDipSize：物理 → DIP 取两位小数，换算回物理像素稳定（不漂）', () => {
  assert.deepEqual(panelDipSize({ width: 475, height: 575 }, 1.25), { width: 380, height: 460 })
  // 316.666… → 316.67 → 475（不走样）
  const dip = panelDipSize({ width: 475, height: 575 }, 1.5)
  assert.deepEqual(dip, { width: 316.67, height: 383.33 })
  assert.deepEqual(panelPixelSize(dip, 1.5), { width: 475, height: 575 })
  // 125% ↔ 150% ↔ 100% 来回切：DIP 尺寸是唯一真值，切几次都还是同一个
  let roundTrip = { width: 456, height: 552 }
  for (const s of [1.25, 1.5, 1.25, 1.0, 1.5]) roundTrip = panelDipSize(panelPixelSize(roundTrip, s), s)
  assert.deepEqual(roundTrip, { width: 456, height: 552 })
})

test('panelDipSize：空值/非正数 → null', () => {
  assert.equal(panelDipSize(null, 1.5), null)
  assert.equal(panelDipSize({ width: 0, height: 10 }, 1.5), null)
  assert.deepEqual(panelDipSize({ width: 10, height: 10 }, 0), { width: 10, height: 10 })
})
