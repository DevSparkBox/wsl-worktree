// 顶栏仓库切换器：左栏收起时出现，支持搜索切换
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9344
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-top-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
await sleep(4200)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) } })
await new Promise((r) => ws.addEventListener('open', r))
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description }
  return { value: r?.result?.value }
}
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r?.data) writeFileSync(join(SHOTS, n), Buffer.from(r.data, 'base64')) }
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sleep(180)
}
const typeIn = async (selector, text) => {
  await ev(`(() => { const i = document.querySelector('${selector}'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await sleep(120)
  for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await sleep(26) }
  await sleep(400)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?top=1' })
await sleep(4500)
await ev(`localStorage.removeItem('wsl-worktree.layout.v1')`)
await send('Page.reload')
await sleep(4500)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(32)} ${d}`) }

// 选中一个有 worktree 的仓库
await ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(2500)

// ---- 1. 默认收起时不显示 ----
const initState = await ev(`({
  hidden: document.getElementById('top-repo').hidden,
  leftVisible: document.getElementById('pane-left').getBoundingClientRect().width > 0,
})`)
check('左栏展开时切换器隐藏', initState.value?.hidden === true && initState.value?.leftVisible === true,
  `hidden=${initState.value?.hidden}`)

// ---- 2. 收起左栏后出现 ----
await ev(`document.getElementById('toggle-left').click()`)
await sleep(500)
const shown = await ev(`(() => {
  const box = document.getElementById('top-repo')
  const input = document.getElementById('top-repo-input')
  const r = box.getBoundingClientRect()
  return {
    hidden: box.hidden,
    leftGone: document.getElementById('pane-left').getBoundingClientRect().width === 0,
    value: input.value,
    width: Math.round(r.width),
    inTopbar: !!box.closest('.topbar'),
  }
})()`)
check('收起左栏后出现', shown.value?.hidden === false && shown.value?.leftGone === true, '')
check('显示在页面顶部', shown.value?.inTopbar === true, `宽 ${shown.value?.width}px`)
check('默认显示当前仓库名', shown.value?.value === 'jm_java', shown.value?.value)
await shot('top-repo-closed.png')

// 真实鼠标点击聚焦（element.focus() 在元素已聚焦时不会触发 focus 事件，会漏测）
const clickInput = async (sel) => {
  await ev(`document.activeElement?.blur()`)
  await sleep(150)
  const b = await ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) } })()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.value.x, y: b.value.y, button: 'left', clickCount: 1, buttons: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.value.x, y: b.value.y, button: 'left', clickCount: 1, buttons: 0 })
  await sleep(600)
}

// ---- 3. 聚焦弹出全部仓库 ----
await clickInput('#top-repo-input')
const panelAll = await ev(`(() => {
  const input = document.getElementById('top-repo-input')
  const panel = input.closest('.ac-wrap')?.querySelector('.ac-panel')
  return {
    open: panel ? !panel.hidden : false,
    count: panel ? panel.querySelectorAll('.ac-item').length : 0,
    first: panel?.querySelector('.ac-item .ac-label')?.textContent.trim(),
    selStart: input.selectionStart,
    selEnd: input.selectionEnd,
    len: input.value.length,
  }
})()`)
check('聚焦弹出候选', panelAll.value?.open === true && panelAll.value?.count > 0, `${panelAll.value?.count} 项`)
// 顶层仓库只显示名字，子目录仓库要带目录前缀（如 products/asset），否则同名分不清
const labelShape = await ev(`(() => {
  const panel = document.getElementById('top-repo-input').closest('.ac-wrap').querySelector('.ac-panel')
  const labels = [...panel.querySelectorAll('.ac-item .ac-label')].map(e => e.textContent.trim())
  return {
    total: labels.length,
    withSlash: labels.filter(l => l.includes('/')).length,
    samples: labels.filter(l => l.includes('/')).slice(0, 3),
    topLevel: labels.filter(l => !l.includes('/')).slice(0, 2),
  }
})()`)
check('子目录仓库带目录前缀', labelShape.value?.withSlash > 0, `含 / 的有 ${labelShape.value?.withSlash} 个：${JSON.stringify(labelShape.value?.samples)}`)
check('顶层仓库只显示名字', labelShape.value?.topLevel?.length > 0, JSON.stringify(labelShape.value?.topLevel))
check('聚焦时全选文本', panelAll.value?.selStart === 0 && panelAll.value?.selEnd === panelAll.value?.len,
  `[${panelAll.value?.selStart},${panelAll.value?.selEnd}] / len=${panelAll.value?.len}`)

// ---- 4. 模糊搜索 ----
// 注意：聚焦时列出全部（showAllOnFocus），真正过滤发生在输入之后
await typeIn('#top-repo-input', 'jm_j')
const filtered = await ev(`(() => {
  const panel = document.getElementById('top-repo-input').closest('.ac-wrap').querySelector('.ac-panel')
  return {
    count: panel.querySelectorAll('.ac-item').length,
    labels: [...panel.querySelectorAll('.ac-item .ac-label')].slice(0, 5).map(e => e.textContent.trim()),
    marks: panel.querySelectorAll('mark').length,
  }
})()`)
check('模糊过滤生效', filtered.value?.count > 0 && filtered.value?.count < panelAll.value?.count,
  `${panelAll.value?.count} → ${filtered.value?.count}`)
check('命中项含 jm_j', (filtered.value?.labels || []).some((l) => l.includes('jm_j')),
  JSON.stringify(filtered.value?.labels?.slice(0, 2)))
check('命中高亮', filtered.value?.marks > 0, `${filtered.value?.marks} 处`)
await shot('top-repo-search.png')

// ---- 5. 选中并切换 ----
const target = await ev(`(() => {
  const panel = document.getElementById('top-repo-input').closest('.ac-wrap').querySelector('.ac-panel')
  const items = [...panel.querySelectorAll('.ac-item:not(.disabled)')]
  const pick = items.find(e => e.querySelector('.ac-label').textContent.includes('jm_net')) || items[0]
  const label = pick.querySelector('.ac-label').textContent.trim()
  pick.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return label
})()`)
await sleep(2600)
const afterPick = await ev(`({
  inputValue: document.getElementById('top-repo-input').value,
  mainTitle: document.getElementById('main-title').textContent,
  mainMeta: document.getElementById('main-meta').textContent,
  repoActive: document.querySelector('#repo-list .repo.active')?.dataset.toplevel,
})`)
check('切换后主区更新', afterPick.value?.mainTitle === afterPick.value?.inputValue,
  `标题=${afterPick.value?.mainTitle} 输入框=${afterPick.value?.inputValue}`)
check('左侧列表同步高亮', afterPick.value?.repoActive?.endsWith(afterPick.value?.mainTitle || '-'),
  afterPick.value?.repoActive)

// ---- 6. 键盘选择 ----
await clickInput('#top-repo-input')
await sleep(400)
await typeIn('#top-repo-input', 'asset')
await key('ArrowDown', 'ArrowDown', 40)
const kbActive = await ev(`(() => {
  const panel = document.getElementById('top-repo-input').closest('.ac-wrap').querySelector('.ac-panel')
  return panel?.querySelector('.ac-item.active .ac-label')?.textContent.trim()
})()`)
check('方向键可选中', Boolean(kbActive.value), kbActive.value)
await key('Enter', 'Enter', 13)
await sleep(2500)
const afterEnter = await ev(`({
  title: document.getElementById('main-title').textContent,
  panelHidden: document.getElementById('top-repo-input').closest('.ac-wrap').querySelector('.ac-panel').hidden,
})`)
check('Enter 完成切换', afterEnter.value?.title && afterEnter.value?.title !== afterPick.value?.mainTitle,
  `→ ${afterEnter.value?.title}`)
check('切换后面板关闭', afterEnter.value?.panelHidden === true, '')

// ---- 7. Esc 还原 ----
await clickInput('#top-repo-input')
await sleep(300)
await typeIn('#top-repo-input', 'zzz')
await key('Escape', 'Escape', 27)  // 第一次关面板
await sleep(250)
await key('Escape', 'Escape', 27)  // 第二次还原
await sleep(400)
const afterEsc = await ev(`({
  value: document.getElementById('top-repo-input').value,
  title: document.getElementById('main-title').textContent,
})`)
check('Esc 还原为当前仓库名', afterEsc.value?.value === afterEsc.value?.title,
  `输入框=${afterEsc.value?.value} 标题=${afterEsc.value?.title}`)

// ---- 8. 失焦还原 ----
await ev(`(() => {
  const i = document.getElementById('top-repo-input')
  i.focus(); i.value = 'half-typed'; i.dispatchEvent(new Event('input', {bubbles:true}))
  i.blur()
})()`)
await sleep(400)
const afterBlur = await ev(`({
  value: document.getElementById('top-repo-input').value,
  title: document.getElementById('main-title').textContent,
})`)
check('失焦还原为当前仓库名', afterBlur.value?.value === afterBlur.value?.title,
  `${afterBlur.value?.value}`)

// ---- 9. 重新展开左栏后隐藏 ----
await ev(`document.getElementById('toggle-left').click()`)
await sleep(500)
const backOpen = await ev(`({
  hidden: document.getElementById('top-repo').hidden,
  leftVisible: document.getElementById('pane-left').getBoundingClientRect().width > 0,
})`)
check('展开左栏后切换器隐藏', backOpen.value?.hidden === true && backOpen.value?.leftVisible === true, '')

// ---- 10. 状态持久化：刷新后仍收起则仍显示 ----
await ev(`document.getElementById('toggle-left').click()`)
await sleep(400)
await send('Page.reload')
await sleep(4500)
const afterReload = await ev(`({
  hidden: document.getElementById('top-repo').hidden,
  leftGone: document.getElementById('pane-left').getBoundingClientRect().width === 0,
  value: document.getElementById('top-repo-input').value,
})`)
check('刷新后收起状态仍显示切换器', afterReload.value?.hidden === false && afterReload.value?.leftGone === true,
  `value=${afterReload.value?.value}`)

// ---- 11. 快捷键 / 在收起时聚焦切换器 ----
await ev(`document.activeElement?.blur()`)
await key('/', 'Slash', 191)
await sleep(400)
const afterSlash = await ev(`({
  focus: document.activeElement?.id,
  leftStillHidden: document.getElementById('pane-left').getBoundingClientRect().width === 0,
})`)
check('/ 聚焦切换器而非展开左栏', afterSlash.value?.focus === 'top-repo-input' && afterSlash.value?.leftStillHidden === true,
  `focus=${afterSlash.value?.focus}`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

await ev(`localStorage.removeItem('wsl-worktree.layout.v1')`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
ws.close(); try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
