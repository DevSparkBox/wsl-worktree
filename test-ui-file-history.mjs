// 文件历史：hover 按钮 / 顶部常驻按钮 / 新标签页 / 历史列表 / diff / 改名
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9388
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-hist-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
await sleep(4200)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page0 = targets.find((t) => t.type === 'page')

/** 连接一个 target，返回操作句柄 */
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
  return { ws, send, ev, shot, close: () => ws.close() }
}

const main = await connect(page0)
await main.send('Page.enable'); await main.send('Runtime.enable')
await main.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await main.send('Page.navigate', { url: 'http://localhost:7801/?hist=1' })
await sleep(5000)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 进 jm_java，点一个有改名的文件所在的 commit
await main.ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(3000)

// 找一个「点开后确实有文件改动」的 commit（merge commit 可能没 diff）
let pickedOk = false
let pickedInfo = null
for (let attempt = 0; attempt < 6 && !pickedOk; attempt++) {
  const r = await main.ev(`(() => {
    const rows = [...document.querySelectorAll('#log-body tr[data-sha]')]
    const row = rows[${attempt}]
    if (!row) return { ok: false }
    row.click()
    return { ok: true, sha: row.dataset.sha, count: rows.length }
  })()`)
  pickedInfo = r.value
  if (!r.value?.ok) break
  await sleep(2200)
  const hasFiles = await main.ev(`document.querySelectorAll('#detail-body .file-row').length`)
  if (hasFiles.value > 0) { pickedOk = true; break }
}
check('选中一个 commit', pickedOk, `第 ${pickedInfo?.count} 条候选里找到有改动的`)
await sleep(600)

// ---- 1. 文件行上有历史按钮 ----
const btnInfo = await main.ev(`(() => {
  const rows = [...document.querySelectorAll('#detail-body .file-row')]
  const b = rows[0]?.querySelector('.file-hist-btn')
  if (!b) return { has: false, rows: rows.length }
  const cs = getComputedStyle(b)
  return { has: true, rows: rows.length, opacity: cs.opacity, ariaLabel: b.getAttribute('aria-label') }
})()`)
check('文件行有历史按钮', btnInfo.value?.has === true, `${btnInfo.value?.rows} 个文件行`)
check('默认不可见（opacity 0）', btnInfo.value?.opacity === '0', `opacity=${btnInfo.value?.opacity}`)

// hover 后可见
const hoverState = await main.ev(`(() => {
  const row = document.querySelector('#detail-body .file-row')
  const b = row.querySelector('.file-hist-btn')
  // 直接给行加 hover 无法触发 CSS，改用 mouseover 事件 + :hover 模拟不了，
  // 所以这里检查 CSS 规则是否包含 .file-row:hover .file-hist-btn
  const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
  const rule = rules.find(r => r.selectorText && r.selectorText.includes('.file-row:hover') && r.selectorText.includes('.file-hist-btn'))
  return { found: !!rule, text: rule ? rule.style.opacity : null }
})()`)
check('hover 规则存在且设为可见', hoverState.value?.found === true && hoverState.value?.text === '1',
  `opacity:${hoverState.value?.text}`)

// ---- 2. 顶部常驻按钮 ----
const topBtn = await main.ev(`(() => {
  const b = document.getElementById('btn-file-history')
  return { exists: !!b, hidden: b?.hidden, text: b?.textContent }
})()`)
check('顶部有文件历史按钮', topBtn.value?.exists === true, topBtn.value?.text)
// 选中文件后应显示（openFile 被自动调用加载第一个文件）
await sleep(600)
const topBtnShown = await main.ev(`document.getElementById('btn-file-history').hidden`)
check('选中文件后顶部按钮显示', topBtnShown.value === false, `hidden=${topBtnShown.value}`)

// ---- 3. 点击打开新标签页 ----
const before = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page').length

// 记录 window.open 的调用参数（headless 下 popup 可能被拦，先抓调用）
await main.ev(`(() => {
  window.__openArgs = []
  const orig = window.open
  window.open = function(...a) { window.__openArgs.push(a); return orig.apply(window, a) }
})()`)
await main.ev(`document.querySelector('#detail-body .file-row .file-hist-btn').click()`)
await sleep(2500)

const openArgs = await main.ev(`window.__openArgs`)
check('调用了 window.open', (openArgs.value || []).length === 1, JSON.stringify(openArgs.value?.[0]?.slice(1)))
const url = openArgs.value?.[0]?.[0] || ''
check('URL 是 history.html', url.startsWith('/history.html?'), url.slice(0, 70))
check('URL 含 repo/path/wt', /repo=/.test(url) && /path=/.test(url) && /wt=/.test(url),
  new URL(url, 'http://x').searchParams.get('path')?.slice(-32))

// 检查是否真的开了新 target。
// headless 模式下 window.open 常被拦（不会创建 target），所以这里不硬性要求：
// 若没开，就直接用抓到的 URL 导航到历史页，继续验证页面本身。
await sleep(1500)
const after = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json())
const newPage = after.find((t) => t.type === 'page' && t.url.includes('history.html'))
const popupWorked = Boolean(newPage)
console.log(`       (headless popup: ${popupWorked ? '已打开' : '被拦截'}，将直接导航验证页面)`)
if (!popupWorked) {
  // 用同一 target 导航到历史页
  await main.send('Page.navigate', { url: 'http://localhost:7801' + url })
  await sleep(4500)
}

// ---- 4. 历史页内容 ----
let hist = null
if (popupWorked && newPage) {
  hist = await connect(newPage)
  await hist.send('Page.enable'); await hist.send('Runtime.enable')
  await hist.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  await sleep(4000)
} else {
  // 同 target 已导航过去，main 句柄继续可用
  await main.send('Page.enable'); await main.send('Runtime.enable')
  await main.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 950, deviceScaleFactor: 1, mobile: false })
  await sleep(1200)
  hist = main
}
if (hist) {
  const layout = await hist.ev(`({
    rows: document.querySelectorAll('#h-list .h-row').length,
    repo: document.getElementById('h-repo').textContent,
    path: document.getElementById('h-path').textContent,
    wt: document.getElementById('h-wt').textContent,
    title: document.title,
    hasDiffTable: !!document.querySelector('#h-diff-body .h-patch-table'),
    diffRows: document.querySelectorAll('#h-diff-body .h-patch-table tr').length,
    followChecked: document.getElementById('h-follow').checked,
  })`)
  check('历史页有提交列表', layout.value?.rows > 0, `${layout.value?.rows} 条`)
  check('显示仓库名', Boolean(layout.value?.repo), layout.value?.repo)
  check('显示文件路径', (layout.value?.path || '').length > 0, layout.value?.path?.slice(-40))
  check('显示 worktree', Boolean(layout.value?.wt), layout.value?.wt)
  check('默认加载首条 diff', layout.value?.hasDiffTable === true, `${layout.value?.diffRows} 行`)
  check('跟踪改名默认开启', layout.value?.followChecked === true, '')
  check('页面标题含文件名', (layout.value?.title || '').includes('.sql') || (layout.value?.title || '').includes('.'), layout.value?.title)

  // 行号
  const lineNos = await hist.ev(`(() => {
    const rows = [...document.querySelectorAll('#h-diff-body .h-patch-table tr.add, #h-diff-body .h-patch-table tr.del, #h-diff-body .h-patch-table tr.ctx')]
    const withLn = rows.filter(r => r.querySelectorAll('td.ln').length === 2)
    return { total: rows.length, withLn: withLn.length }
  })()`)
  check('diff 有双行号', lineNos.value?.withLn > 0 && lineNos.value?.withLn === lineNos.value?.total,
    `${lineNos.value?.withLn}/${lineNos.value?.total}`)

  // 选中第一条的 diff 有 +/− 统计
  const stat = await hist.ev(`document.getElementById('h-diff-stat').textContent`)
  check('显示改动统计', /\+/.test(stat.value || '') || /−/.test(stat.value || ''), stat.value)

  await hist.shot('file-history.png')

  // ---- 5. 点第二条：diff 跟着变 ----
  const second = await hist.ev(`(() => {
    const rows = [...document.querySelectorAll('#h-list .h-row')]
    if (rows.length < 2) return null
    const firstSha = rows[0].dataset.sha
    rows[1].click()
    return { firstSha, secondSha: rows[1].dataset.sha }
  })()`)
  await sleep(1800)
  const afterSecond = await hist.ev(`({
    active: document.querySelector('#h-list .h-row.active')?.dataset.sha,
    diffSha: document.getElementById('h-diff-sha').textContent,
    hasTable: !!document.querySelector('#h-diff-body .h-patch-table'),
  })`)
  check('点第二条后高亮切换', afterSecond.value?.active === second.value?.secondSha, '')
  check('点第二条后 diff 更新', afterSecond.value?.hasTable === true, `sha=${afterSecond.value?.diffSha}`)

  // ---- 6. 过滤 ----
  const filtered = await hist.ev(`(() => {
    const f = document.getElementById('h-filter')
    f.value = 'zzz-nothing'
    f.dispatchEvent(new Event('input', { bubbles: true }))
    const none = document.querySelectorAll('#h-list .h-row').length
    f.value = ''
    f.dispatchEvent(new Event('input', { bubbles: true }))
    return { none, all: document.querySelectorAll('#h-list .h-row').length }
  })()`)
  check('过滤可清空列表', filtered.value?.none === 0, `过滤后 ${filtered.value?.none} 条`)
  check('清空过滤可恢复', filtered.value?.all > 0, `${filtered.value?.all} 条`)

  // ---- 7. 改名标记 ----
  const renameInfo = await hist.ev(`(() => {
    const rows = [...document.querySelectorAll('#h-list .h-row')]
    const withPill = rows.filter(r => r.querySelector('.h-pill.rename'))
    return {
      total: rows.length,
      renamed: withPill.length,
      sample: withPill[0]?.querySelector('.h-fileline .name')?.textContent.trim(),
    }
  })()`)
  check('改名条目有标记', renameInfo.value?.renamed > 0, `${renameInfo.value?.renamed} 条改名`)
  check('改名条目显示 old → new', (renameInfo.value?.sample || '').includes('→'), renameInfo.value?.sample?.slice(0, 60))

  // ---- 8. 关掉跟踪改名应减少条目 ----
  const beforeCount = renameInfo.value?.total || 0
  await hist.ev(`(() => { const c = document.getElementById('h-follow'); c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await sleep(2500)
  const afterNoFollow = await hist.ev(`document.querySelectorAll('#h-list .h-row').length`)
  check('关闭跟踪改名后条目减少', afterNoFollow.value < beforeCount,
    `${beforeCount} → ${afterNoFollow.value}`)

  // 恢复
  await hist.ev(`(() => { const c = document.getElementById('h-follow'); c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })) })()`)
  await sleep(2000)

  const errs = await hist.ev(`window.__errs || []`)
  check('历史页无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))
  if (hist !== main) hist.close()
} else {
  check('历史页有提交列表', false, '新标签页未打开')
}

// ---- 9. 无 JS 错误 ----
// 注意：popup 被拦时 main 已导航到历史页，此时它检查的其实是历史页，故只在 popup 成功时单独查主界面
if (popupWorked) {
  const mainErrs = await main.ev(`window.__errs || []`)
  check('主界面无 JS 错误', (mainErrs.value || []).length === 0, JSON.stringify(mainErrs.value))
} else {
  console.log('       (popup 被拦，主界面已在导航中，跳过主界面错误检查)')
}

main.close()
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
