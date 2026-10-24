// 更新分支对话框：操作完成后按钮退出高亮（避免「已是最新但按钮还亮着」的误解）
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', '..', 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9631
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用截图里那个仓库：它的 worktree 已经是最新，正好复现用户报的场景
const REPO = '/home/wangy/codes/product_diff_for_update/java_product_diff_for_update'
const BRANCH = 'feature/f-升级检测初始化'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,950', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\pd-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

let targets = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    if (list?.some((t) => t.type === 'page')) { targets = list; break }
  } catch {}
}
if (!targets) { console.log('FAIL  Edge 未就绪'); process.exit(1) }

const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
})
await new Promise((res) => ws.addEventListener('open', res))
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async (expr) => {
  const rr = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (rr?.exceptionDetails) return { error: rr.exceptionDetails.exception?.description }
  return { value: rr?.result?.value }
}
const shot = async (name) => {
  const rr = await send('Page.captureScreenshot', { format: 'png' })
  if (rr?.data) writeFileSync(join(SHOTS, name), Buffer.from(rr.data, 'base64'))
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })

// 直接带 hash 打开该仓库
await send('Page.navigate', { url: `http://localhost:7801/#repo=${encodeURIComponent(REPO)}` })
await sleep(6500)

const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('#wt-body tr')]
  const row = rows.find(r => r.textContent.includes(${JSON.stringify(BRANCH)}))
  if (!row) return { ok: false, count: rows.length }
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '拉取')
  if (!btn) return { ok: false, buttons: [...row.querySelectorAll('button')].map(b => b.textContent.trim()) }
  btn.click()
  return { ok: true }
})()`)
check('打开「更新分支」对话框', opened.value?.ok === true, opened.value?.buttons ? JSON.stringify(opened.value.buttons) : '')
await sleep(1600)

// 初始状态：主按钮是 primary（蓝色高亮）
const initial = await ev(`({
  title: document.getElementById('modal-title').textContent,
  primaryText: document.querySelector('#modal-foot .btn.primary')?.textContent,
  primaryBg: (() => { const el = document.querySelector('#modal-foot .btn.primary'); return el ? getComputedStyle(el).backgroundColor : null })(),
  btnCount: document.querySelectorAll('#modal-foot .btn').length,
  segDisabled: document.querySelector('#pull-mode')?.classList.contains('disabled'),
})`)
check('对话框标题正确', /^更新分支/.test(initial.value?.title || ''), initial.value?.title)
check('初始主按钮是「开始更新」', initial.value?.primaryText === '开始更新', initial.value?.primaryText)
check('初始主按钮高亮（蓝底）', initial.value?.primaryBg === 'rgb(37, 99, 235)', initial.value?.primaryBg)
check('初始合并方式可选', initial.value?.segDisabled === false, '')

// 点「开始更新」：该 worktree 已是最新
await ev(`document.querySelector('#modal-foot .btn.primary').click()`)
await sleep(6500)

const after = await ev(`(() => {
  const btns = [...document.querySelectorAll('#modal-foot .btn')]
  const close = btns.find(b => b.textContent.trim() === '关闭')
  const result = document.getElementById('pull-result')
  const note = result?.querySelector('.note')
  return {
    // 文案：应说「已经是最新」而不是「更新完成」
    hasUptodate: /已经是最新|已是最新/.test(result?.textContent || ''),
    hasUpdated: /更新完成/.test(result?.textContent || ''),
    mentionUpstream: /上游/.test(result?.textContent || ''),
    noteClass: note?.className || '',
    // 按钮：主按钮应变「关闭」且不再是 primary
    hasClose: Boolean(close),
    closeClass: close?.className || '',
    closeBg: close ? getComputedStyle(close).backgroundColor : null,
    // 不应再有 primary 按钮
    primaryCount: document.querySelectorAll('#modal-foot .btn.primary').length,
    // 取消按钮应隐藏
    cancelHidden: (() => { const c = btns.find(b => b.textContent.trim() === '取消'); return c ? c.hidden : null })(),
    // 合并方式应置灰
    segDisabled: document.getElementById('pull-mode')?.classList.contains('disabled'),
    modalOpen: !document.getElementById('modal').hidden,
    // 原始输出仍然可看
    hasOutput: /up to date|Already/i.test(result?.textContent || ''),
  }
})()`)

check('文案显示「已是最新」', after.value?.hasUptodate === true, '')
check('文案不再说「更新完成」', after.value?.hasUpdated === false, '')
check('文案带上游分支信息', after.value?.mentionUpstream === true, '')
check('note 用中性样式（非 ok 绿）', after.value?.noteClass === 'note', after.value?.noteClass)
check('主按钮改成「关闭」', after.value?.hasClose === true, '')
check('按钮退出高亮（不再是 primary）',
  after.value?.primaryCount === 0 && after.value?.closeBg !== 'rgb(37, 99, 235)',
  `class="${after.value?.closeClass}" bg=${after.value?.closeBg}`)
check('取消按钮隐藏', after.value?.cancelHidden === true, '')
check('合并方式置灰不可改', after.value?.segDisabled === true, '')
check('对话框保持打开（可看输出）', after.value?.modalOpen === true, '')
check('git 原始输出仍可见', after.value?.hasOutput === true, '')
await shot('pull-uptodate.png')

// 点「关闭」应能关掉
await ev(`(() => { const b = [...document.querySelectorAll('#modal-foot .btn')].find(x => x.textContent.trim() === '关闭'); b && b.click() })()`)
await sleep(900)
const closed = await ev(`document.getElementById('modal').hidden`)
check('点「关闭」能关闭对话框', closed.value === true, '')

// 再开一次：状态要复位（不能记住上次的「关闭」）
await ev(`(() => {
  const rows = [...document.querySelectorAll('#wt-body tr')]
  const row = rows.find(r => r.textContent.includes(${JSON.stringify(BRANCH)}))
  const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '拉取')
  btn?.click()
})()`)
await sleep(1600)
const reopened = await ev(`({
  primaryText: document.querySelector('#modal-foot .btn.primary')?.textContent,
  cancelHidden: (() => { const c = [...document.querySelectorAll('#modal-foot .btn')].find(b => b.textContent.trim() === '取消'); return c ? c.hidden : null })(),
  segDisabled: document.getElementById('pull-mode')?.classList.contains('disabled'),
})`)
check('重新打开后按钮复位为「开始更新」', reopened.value?.primaryText === '开始更新', reopened.value?.primaryText)
check('重新打开后取消按钮恢复', reopened.value?.cancelHidden === false, '')
check('重新打开后合并方式可选', reopened.value?.segDisabled === false, '')

// 关掉对话框再收尾，避免影响后续用例
await ev(`document.getElementById('modal-close').click()`)
await sleep(400)
const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
