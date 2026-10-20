// 三栏布局：折叠 / 拖拽 / 持久化 验证
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9255

const browser = spawn(EDGE, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000',
  '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-cdp-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(4200)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return { value: r?.result?.value }
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
}
// 真实鼠标拖拽（CDP Input 事件，走 pointer events）
async function drag(fromX, fromY, toX, toY, steps = 12) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: fromX, y: fromY, button: 'left', clickCount: 1, buttons: 1 })
  for (let i = 1; i <= steps; i++) {
    const x = Math.round(fromX + ((toX - fromX) * i) / steps)
    const y = Math.round(fromY + ((toY - fromY) * i) / steps)
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
    await sleep(16)
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: toY, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(220)
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?layout=1' })
await sleep(4200)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(30)} ${d}`) }

// 清掉可能残留的旧偏好
await ev(`localStorage.removeItem('wsl-worktree.layout.v1')`)
await send('Page.reload')
await sleep(4000)

// 选中一个仓库让内容充实
await ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(2500)

// ---------- 初始状态 ----------
const init = await ev(`(() => {
  const l = document.getElementById('layout')
  const cs = getComputedStyle(l)
  const left = document.getElementById('pane-left').getBoundingClientRect()
  const main = document.querySelector('.pane-main').getBoundingClientRect()
  const right = document.getElementById('detail').getBoundingClientRect()
  return {
    cols: cs.gridTemplateColumns,
    leftW: Math.round(left.width), mainW: Math.round(main.width), rightW: Math.round(right.width),
    leftVisible: left.width > 0, rightVisible: right.width > 0,
    splitLeftW: document.getElementById('split-left').getBoundingClientRect().width,
  }
})()`)
check('初始三栏都在', init.value?.leftVisible && init.value?.rightVisible,
  `左${init.value?.leftW} 中${init.value?.mainW} 右${init.value?.rightW}`)
check('分隔条有宽度', init.value?.splitLeftW > 0, `${init.value?.splitLeftW}px`)
await shot('layout-3col.png')

// ---------- 收起左侧 ----------
await ev(`document.getElementById('toggle-left').click()`)
await sleep(400)
const afterHideLeft = await ev(`(() => ({
  leftW: Math.round(document.getElementById('pane-left').getBoundingClientRect().width),
  splitGone: getComputedStyle(document.getElementById('split-left')).display === 'none',
  mainW: Math.round(document.querySelector('.pane-main').getBoundingClientRect().width),
  toggleOff: document.getElementById('toggle-left').classList.contains('off'),
  rightStill: Math.round(document.getElementById('detail').getBoundingClientRect().width),
}))()`)
check('收起左侧面板', afterHideLeft.value?.leftW === 0 && afterHideLeft.value?.splitGone, `左=${afterHideLeft.value?.leftW}`)
check('中栏变宽', afterHideLeft.value?.mainW > init.value?.mainW, `${init.value?.mainW} → ${afterHideLeft.value?.mainW}`)
check('右栏不受影响', afterHideLeft.value?.rightStill === init.value?.rightW, `${afterHideLeft.value?.rightStill}`)
check('按钮显示为关闭态', afterHideLeft.value?.toggleOff === true, '')
await shot('layout-hide-left.png')

// ---------- 收起右侧（两侧都收起 = 只有中栏）----------
await ev(`document.getElementById('toggle-right').click()`)
await sleep(400)
const afterBoth = await ev(`(() => ({
  rightW: Math.round(document.getElementById('detail').getBoundingClientRect().width),
  rightGone: getComputedStyle(document.getElementById('detail')).display === 'none',
  cols: getComputedStyle(document.getElementById('layout')).gridTemplateColumns,
  mainW: Math.round(document.querySelector('.pane-main').getBoundingClientRect().width),
}))()`)
check('收起右侧面板', afterBoth.value?.rightGone === true, `右=${afterBoth.value?.rightW}`)
check('两侧收起只剩中栏', afterBoth.value?.mainW > 1500, `中栏=${afterBoth.value?.mainW}px`)
await shot('layout-main-only.png')

// ---------- 全部展开，测试拖拽 ----------
await ev(`document.getElementById('toggle-left').click(); document.getElementById('toggle-right').click()`)
await sleep(500)

const sp = await ev(`(() => {
  const r = document.getElementById('split-left').getBoundingClientRect()
  return { x: Math.round(r.left + r.width/2), y: 500, w: Math.round(document.getElementById('pane-left').getBoundingClientRect().width) }
})()`)
// 向右拖 120px
await drag(sp.value.x, sp.value.y, sp.value.x + 120, sp.value.y)
const afterDragLeft = await ev(`(() => ({
  leftW: Math.round(document.getElementById('pane-left').getBoundingClientRect().width),
  cssVar: document.getElementById('layout').style.getPropertyValue('--w-left'),
  hintHidden: document.getElementById('resize-hint').hidden,
}))()`)
check('拖动左分隔条加宽', Math.abs(afterDragLeft.value?.leftW - (sp.value.w + 120)) <= 3,
  `${sp.value.w} → ${afterDragLeft.value?.leftW} (期望 ${sp.value.w + 120})`)
check('拖动后提示条隐藏', afterDragLeft.value?.hintHidden === true, '')
await shot('layout-drag-left.png')

// 右侧向左拖 150px（加宽右侧）
const sp2 = await ev(`(() => {
  const r = document.getElementById('split-right').getBoundingClientRect()
  return { x: Math.round(r.left + r.width/2), y: 500, w: Math.round(document.getElementById('detail').getBoundingClientRect().width) }
})()`)
await drag(sp2.value.x, sp2.value.y, sp2.value.x - 150, sp2.value.y)
const afterDragRight = await ev(`Math.round(document.getElementById('detail').getBoundingClientRect().width)`)
check('拖动右分隔条加宽', Math.abs(afterDragRight.value - (sp2.value.w + 150)) <= 3,
  `${sp2.value.w} → ${afterDragRight.value} (期望 ${sp2.value.w + 150})`)
await shot('layout-drag-right.png')

// ---------- 最小/最大约束 ----------
// 把左栏往左拖到极限（应停在下限）
await drag(260, 500, 20, 500)
const minLeft = await ev(`Math.round(document.getElementById('pane-left').getBoundingClientRect().width)`)
check('左栏不会小于下限', minLeft.value >= 138, `${minLeft.value}px (min=140)`)

// 把左栏往右猛拖（不能把中栏压没）
const bigDrag = await ev(`(() => {
  const r = document.getElementById('split-left').getBoundingClientRect()
  return { x: Math.round(r.left + r.width/2) }
})()`)
await drag(bigDrag.value.x, 500, 1500, 500)
const afterBig = await ev(`(() => ({
  leftW: Math.round(document.getElementById('pane-left').getBoundingClientRect().width),
  mainW: Math.round(document.querySelector('.pane-main').getBoundingClientRect().width),
}))()`)
check('中栏保留最小宽度', afterBig.value?.mainW >= 400, `左=${afterBig.value?.leftW} 中=${afterBig.value?.mainW} (min 420)`)

// ---------- 双击复位 ----------
await ev(`(() => {
  const el = document.getElementById('split-left')
  el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
})()`)
await sleep(300)
const afterReset = await ev(`Math.round(document.getElementById('pane-left').getBoundingClientRect().width)`)
check('双击复位默认宽度', Math.abs(afterReset.value - 220) <= 2, `${afterReset.value}px (def 220)`)

// ---------- 持久化 ----------
const persisted = await ev(`localStorage.getItem('wsl-worktree.layout.v1')`)
let pj = {}
try { pj = JSON.parse(persisted.value) } catch {}
check('宽度写入 localStorage', Number.isFinite(pj.wLeft) && Number.isFinite(pj.wRight), persisted.value)

// 改一个自定义宽度后刷新，应保持
await ev(`(() => {
  const el = document.getElementById('split-right')
  const r = el.getBoundingClientRect()
  // 直接调 setPanel 不行，这里模拟键盘微调
  el.focus()
  for (let i = 0; i < 5; i++) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
})()`)
await sleep(400)
const afterKeys = await ev(`Math.round(document.getElementById('detail').getBoundingClientRect().width)`)
await send('Page.reload')
await sleep(4200)
const afterReload = await ev(`(() => ({
  leftW: Math.round(document.getElementById('pane-left').getBoundingClientRect().width),
  rightW: Math.round(document.getElementById('detail').getBoundingClientRect().width),
  leftVisible: document.getElementById('pane-left').getBoundingClientRect().width > 0,
  rightVisible: document.getElementById('detail').getBoundingClientRect().width > 0,
}))()`)
check('刷新后宽度保持', Math.abs(afterReload.value?.rightW - afterKeys.value) <= 2,
  `键盘调整后=${afterKeys.value} 刷新后=${afterReload.value?.rightW}`)
check('刷新后三栏都在', afterReload.value?.leftVisible && afterReload.value?.rightVisible,
  `左${afterReload.value?.leftW} 右${afterReload.value?.rightW}`)

// ---------- 折叠状态持久化 ----------
await ev(`document.getElementById('toggle-left').click()`)
await sleep(300)
await send('Page.reload')
await sleep(4200)
const afterReloadCollapsed = await ev(`(() => ({
  leftGone: document.getElementById('pane-left').getBoundingClientRect().width === 0,
  toggleOff: document.getElementById('toggle-left').classList.contains('off'),
}))()`)
check('收起状态刷新后保持', afterReloadCollapsed.value?.leftGone && afterReloadCollapsed.value?.toggleOff, '')

// ---------- 快捷键 ----------
// 先明确确保左栏处于展开状态（前面的用例会改变它）
await ev(`(() => {
  if (document.getElementById('layout').classList.contains('hide-left')) {
    document.getElementById('toggle-left').click()
  }
})()`)
await sleep(350)
const beforeKey = await ev(`document.getElementById('pane-left').getBoundingClientRect().width`)
const focusInfo = await ev(`({ tag: document.activeElement?.tagName, id: document.activeElement?.id, cls: document.activeElement?.className })`)
if (beforeKey.value === 0) { console.log('  前置失败：左栏未展开，跳过快捷键用例'); }
console.log(`     按键前焦点: ${JSON.stringify(focusInfo.value)}`)

// 焦点若在输入框/可编辑元素，keydown 会被我们的处理器主动忽略，先失焦
await ev(`document.activeElement?.blur?.()`)
await sleep(120)

// 用 CDP 真实按键（dispatch 到 document 时 e.target 是 document 而非元素）
await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, nativeVirtualKeyCode: 219 })
await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '[', code: 'BracketLeft', windowsVirtualKeyCode: 219, nativeVirtualKeyCode: 219 })
await sleep(450)
const afterKeyBracket = await ev(`document.getElementById('pane-left').getBoundingClientRect().width === 0`)
check('快捷键 [ 收起左栏', afterKeyBracket.value === true, `按键前=${beforeKey.value}`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

// 复原
await ev(`localStorage.removeItem('wsl-worktree.layout.v1')`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('\n失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }

ws.close()
try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
