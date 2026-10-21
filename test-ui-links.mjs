// UI：commit message 里的 URL 可点击 / 不误触发选中
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9561
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const REPO = '/home/wangy/codes/jm_java'
const ID = enc(REPO)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,950', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\lk-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
await sleep(4200)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
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

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })

// ============ 主界面日志表 ============
console.log('===== 日志表 =====')
await send('Page.navigate', { url: 'http://localhost:7801/' })
await sleep(5200)
await ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(3200)

const logLinks = await ev(`({
  count: document.querySelectorAll('#log-body a.ext-link').length,
  rows: document.querySelectorAll('#log-body tr[data-sha]').length,
  sampleHref: document.querySelector('#log-body a.ext-link')?.getAttribute('href'),
  sampleText: document.querySelector('#log-body a.ext-link')?.textContent,
  target: document.querySelector('#log-body a.ext-link')?.target,
  rel: document.querySelector('#log-body a.ext-link')?.rel,
  color: (() => {
    const a = document.querySelector('#log-body a.ext-link')
    return a ? getComputedStyle(a).color : null
  })(),
})`)
check('日志表出现外链', logLinks.value?.count > 0, `${logLinks.value?.count} 个 / ${logLinks.value?.rows} 行`)
check('href 是完整 URL', /^https?:\/\//.test(logLinks.value?.sampleHref || ''), logLinks.value?.sampleHref)
check('链接文本即 URL', logLinks.value?.sampleText?.startsWith('https://'), logLinks.value?.sampleText?.slice(0, 40))
check('新标签打开', logLinks.value?.target === '_blank', logLinks.value?.target)
check('带 noopener', /noopener/.test(logLinks.value?.rel || ''), logLinks.value?.rel)
check('链接有色（非默认文字色）', logLinks.value?.color !== 'rgb(31, 35, 40)', logLinks.value?.color)

// 点链接不选中 commit
const beforeTitle = await ev(`document.getElementById('detail-title').textContent`)
await ev(`document.querySelector('#log-body a.ext-link').click()`)
await sleep(800)
const afterLinkClick = await ev(`({
  title: document.getElementById('detail-title').textContent,
  selected: document.querySelectorAll('#log-body tr.selected').length,
})`)
// ev() 返回 { value }，beforeTitle 也要取 .value 才是字符串
check('点链接不选中 commit',
  afterLinkClick.value?.selected === 0 && afterLinkClick.value?.title === beforeTitle.value,
  `标题=${afterLinkClick.value?.title} 选中=${afterLinkClick.value?.selected}`)

// 点行仍正常选中
await ev(`document.querySelectorAll('#log-body tr[data-sha]')[1].click()`)
await sleep(2200)
const afterRowClick = await ev(`({
  title: document.getElementById('detail-title').textContent,
  selected: document.querySelectorAll('#log-body tr.selected').length,
  detailLinks: document.querySelectorAll('#detail-body a.ext-link').length,
})`)
check('点行仍能选中 commit', afterRowClick.value?.selected === 1, `${afterRowClick.value?.selected} 行选中`)
check('详情面板的表头也有链接', afterRowClick.value?.detailLinks > 0, `${afterRowClick.value?.detailLinks} 个`)

// 详情面板链接的属性
const detailLink = await ev(`(() => {
  const a = document.querySelector('#detail-body a.ext-link')
  return a ? { href: a.getAttribute('href'), target: a.target, rel: a.rel } : null
})()`)
check('详情面板链接可点且新标签打开',
  detailLink.value?.target === '_blank' && /^https?:/.test(detailLink.value?.href || ''),
  detailLink.value?.href?.slice(0, 46))

// 链接文本与原始 subject 的 URL 一致（不能改字符）
const sameUrl = await ev(`(() => {
  const tr = document.querySelectorAll('#log-body tr[data-sha]')[1]
  const subject = tr.querySelector('.subject')
  const a = subject?.querySelector('a.ext-link')
  if (!a) return null
  // 去掉链接后的剩余文本应等于「原 subject 去掉该 URL」
  const full = subject.textContent
  const url = a.textContent
  return { full, url, ok: full.includes(url) }
})()`)
check('链接文本是原 subject 的子串', sameUrl.value?.ok === true, sameUrl.value?.url?.slice(0, 46))

await shot('log-links.png')

// ============ 历史页 ============
console.log('\n===== 历史页 =====')
const javaFile = (await (await fetch(`http://localhost:7801/api/repos/${ID}/tree?sha=HEAD`)).json())
  .files.find((f) => /\.java$/.test(f.path) && f.size > 1000 && f.size < 20000)

await send('Page.navigate', {
  url: `http://localhost:7801/history.html?repo=${ID}&path=${encodeURIComponent(javaFile.path)}&wt=${encodeURIComponent(REPO)}`,
})
await sleep(5200)

const histLinks = await ev(`({
  rows: document.querySelectorAll('#h-list .h-row').length,
  links: document.querySelectorAll('#h-list a.ext-link').length,
  target: document.querySelector('#h-list a.ext-link')?.target,
})`)
check('历史页渲染提交', histLinks.value?.rows > 0, `${histLinks.value?.rows} 条`)

if (histLinks.value?.links > 0) {
  check('历史页也有外链', histLinks.value?.links > 0, `${histLinks.value?.links} 个`)
  check('历史页链接新标签打开', histLinks.value?.target === '_blank', histLinks.value?.target)

  // 点链接不切换选中项
  const beforeActive = await ev(`document.querySelector('#h-list .h-row.active')?.dataset.sha || ''`)
  await ev(`document.querySelector('#h-list a.ext-link').click()`)
  await sleep(900)
  const afterActive = await ev(`document.querySelector('#h-list .h-row.active')?.dataset.sha || ''`)
  check('历史页点链接不切换选中', beforeActive.value === afterActive.value,
    `${String(beforeActive.value).slice(0, 7)} → ${String(afterActive.value).slice(0, 7)}`)
} else {
  console.log('       (该文件历史里的提交没有带 URL，跳过外链断言)')
}

const errs = await ev(`window.__errs || []`)
check('历史页无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
