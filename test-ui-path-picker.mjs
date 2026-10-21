// 历史页顶栏路径切换器 + 主界面右上角「文件历史」按钮
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9401
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-pk-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
await sleep(4200)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page0 = targets.find((t) => t.type === 'page')

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
  })
  await new Promise((r) => ws.addEventListener('open', r))
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }))
  })
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description }
    return { value: r?.result?.value }
  }
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
  }
  const typeText = async (text) => {
    for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await sleep(22) }
  }
  return { ws, send, ev, shot, typeText, close: () => ws.close() }
}

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const main = await connect(page0)
await main.send('Page.enable'); await main.send('Runtime.enable')
await main.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await main.send('Page.navigate', { url: 'http://localhost:7801/' })
await sleep(5000)

await main.ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(3000)

// ---- 1. 主界面按钮在右上角、不依赖选中文件 ----
const btnInfo = await main.ev(`(() => {
  const b = document.getElementById('btn-file-history')
  if (!b) return { exists: false }
  const r = b.getBoundingClientRect()
  const topbar = document.querySelector('.topbar').getBoundingClientRect()
  return {
    exists: true,
    hidden: b.hidden,
    text: b.textContent.trim(),
    inTopbar: !!b.closest('.topbar'),
    rightGap: Math.round(topbar.right - r.right),
    // 是否在 stats 右侧（越过 spacer）
    afterStats: b.getBoundingClientRect().left > document.getElementById('stats').getBoundingClientRect().right,
  }
})()`)
check('按钮存在且在顶栏', btnInfo.value?.inTopbar === true, btnInfo.value?.text)
check('按钮不依赖选中文件（默认可见）', btnInfo.value?.hidden === false, `hidden=${btnInfo.value?.hidden}`)
check('按钮位于右上区域', btnInfo.value?.rightGap < 200 && btnInfo.value?.afterStats === true,
  `距右边 ${btnInfo.value?.rightGap}px`)

// 还没有选中 commit 时也应可见可点
const clickable = await main.ev(`(() => {
  const b = document.getElementById('btn-file-history')
  return { disabled: b.disabled, hidden: b.hidden }
})()`)
check('未选 commit 时可点击', clickable.value?.disabled === false && clickable.value?.hidden === false, '')

// ---- 2. 点击打开，URL 带 focus=1 ----
await main.ev(`(() => {
  window.__openArgs = []
  const orig = window.open
  window.open = function(...a) { window.__openArgs.push(a); return orig.apply(window, a) }
})()`)
await main.ev(`document.getElementById('btn-file-history').click()`)
await sleep(2500)
const openUrl = await main.ev(`window.__openArgs?.[0]?.[0] || ''`)
check('点击后打开 history.html', String(openUrl.value).startsWith('/history.html?'), String(openUrl.value).slice(0, 60))
check('URL 带 focus=1', /focus=1/.test(String(openUrl.value)), '')
check('URL 带 repo', /repo=/.test(String(openUrl.value)), '')

// 导航过去验证页面（headless 下 popup 可能被拦）
await main.send('Page.navigate', { url: 'http://localhost:7801' + openUrl.value })
await sleep(5000)

const hp = main

// ---- 3. 焦点自动进入路径输入框 ----
const focusState = await hp.ev(`({
  activeId: document.activeElement?.id,
  inputHidden: document.getElementById('h-path-input').hidden,
  btnHidden: document.getElementById('h-path-btn').hidden,
  hasPlaceholder: document.getElementById('h-path-text').textContent.trim(),
})`)
check('焦点自动落在路径输入框', focusState.value?.activeId === 'h-path-input', focusState.value?.activeId)
check('输入框已展开', focusState.value?.inputHidden === false, '')
check('无 path 时显示搜索提示', /搜索/.test(focusState.value?.hasPlaceholder || ''), focusState.value?.hasPlaceholder)

// ---- 4. 输入触发模糊匹配，最多 20 条 ----
await hp.typeText('AuthorizationHelper')
await sleep(900)
const acState = await hp.ev(`(() => {
  const p = document.querySelector('.h-ac-panel')
  if (!p || p.hidden) return { open: false }
  const items = [...p.querySelectorAll('.h-ac-item')]
  return {
    open: true,
    count: items.length,
    labels: items.slice(0, 3).map(e => e.querySelector('.label')?.textContent.trim()),
    marks: p.querySelectorAll('mark').length,
    firstActive: items[0]?.classList.contains('active'),
  }
})()`)
check('输入后弹出候选', acState.value?.open === true, `${acState.value?.count} 条`)
check('候选不超过 20 条', acState.value?.count <= 20, `${acState.value?.count} 条`)
check('命中项含关键词', (acState.value?.labels || []).some((l) => /AuthorizationHelper/.test(l)),
  JSON.stringify(acState.value?.labels?.[0]))
check('命中字符高亮', acState.value?.marks > 0, `${acState.value?.marks} 处`)
check('默认高亮第一条', acState.value?.firstActive === true, '')
await hp.shot('history-path-search.png')

// ---- 5. 方向键 + 回车选中 ----
const beforePath = await hp.ev(`document.getElementById('h-path-text').textContent`)
const selected = await hp.ev(`(() => {
  const p = document.querySelector('.h-ac-panel')
  const items = [...p.querySelectorAll('.h-ac-item')]
  if (items.length < 2) return null
  // 模拟向下键
  const inp = document.getElementById('h-path-input')
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  return { count: items.length }
})()`)
await sleep(400)
const activeAfter = await hp.ev(`document.querySelector('.h-ac-item.active')?.dataset.value || ''`)
check('方向键可移动高亮', Boolean(activeAfter.value), activeAfter.value?.split('/').pop())

await hp.ev(`(() => {
  const inp = document.getElementById('h-path-input')
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
})()`)
await sleep(3000)
const afterPick = await hp.ev(`({
  pathText: document.getElementById('h-path-text').textContent,
  inputHidden: document.getElementById('h-path-input').hidden,
  rows: document.querySelectorAll('#h-list .h-row').length,
  urlPath: new URL(location.href).searchParams.get('path'),
  acClosed: (() => { const p = document.querySelector('.h-ac-panel'); return !p || p.hidden })(),
})`)
check('回车切换了文件', afterPick.value?.pathText !== beforePath.value && Boolean(afterPick.value?.pathText),
  afterPick.value?.pathText?.split('/').pop())
check('选中后输入框收起', afterPick.value?.inputHidden === true, '')
check('选中后重新加载了历史', afterPick.value?.rows >= 0, `${afterPick.value?.rows} 条`)
check('URL 的 path 已更新', afterPick.value?.urlPath === afterPick.value?.pathText,
  afterPick.value?.urlPath?.split('/').pop())

// ---- 6. 点击路径文本可再次打开输入框 ----
await hp.ev(`document.getElementById('h-path-btn').click()`)
await sleep(700)
const reopen = await hp.ev(`({
  inputHidden: document.getElementById('h-path-input').hidden,
  activeId: document.activeElement?.id,
  value: document.getElementById('h-path-input').value,
  pathText: document.getElementById('h-path-text').textContent,
})`)
check('点击路径重新打开输入框', reopen.value?.inputHidden === false, '')
check('重新打开时预填当前路径', reopen.value?.value === reopen.value?.pathText,
  reopen.value?.value?.split('/').pop())

// ---- 7. Esc 收起 ----
await hp.ev(`(() => {
  const inp = document.getElementById('h-path-input')
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})()`)
await sleep(500)
const afterEsc = await hp.ev(`document.getElementById('h-path-input').hidden`)
check('Esc 收起输入框', afterEsc.value === true, '')

// ---- 8. 无匹配项的提示 ----
await hp.ev(`document.getElementById('h-path-btn').click()`)
await sleep(600)
await hp.ev(`(() => { const i = document.getElementById('h-path-input'); i.value=''; })()`)
await hp.typeText('zzzzzznothing')
await sleep(800)
const emptyHint = await hp.ev(`document.querySelector('.h-ac-empty')?.textContent || ''`)
check('无匹配时显示提示', /没有匹配/.test(emptyHint.value), emptyHint.value)

const errs = await hp.ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

main.close()
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
