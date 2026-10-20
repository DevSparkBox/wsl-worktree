// 切换分支对话框：tag 分组 / 搜索 / 选中 / detached 输入框自动完成
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9366
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-co-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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
const typeIn = async (sel, text) => {
  await ev(`(() => { const i = document.querySelector('${sel}'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await sleep(140)
  for (const ch of text) { await send('Input.dispatchKeyEvent', { type: 'char', text: ch }); await sleep(26) }
  await sleep(450)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?co=1' })
await sleep(4500)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 选 jm_java（有 tag）
await ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(2600)

// 打开一个 worktree 的切换对话框（用第二行，避开主工作树）
const opened = await ev(`(() => {
  const rows = [...document.querySelectorAll('#wt-body tr')]
  const target = rows.find(r => !r.querySelector('.pill.main'))
  const btn = [...(target?.querySelectorAll('button') || [])].find(b => b.textContent.includes('切换'))
  if (!btn) return { ok: false, rows: rows.length }
  btn.click()
  return { ok: true }
})()`)
check('打开切换分支对话框', opened.value?.ok === true, `rows=${opened.value?.rows}`)
await sleep(2200)

const dlg = await ev(`({
  title: document.getElementById('modal-title').textContent,
  hint: document.querySelector('#co-list')?.previousElementSibling?.textContent
    || document.querySelector('#co-filter')?.placeholder,
  hasDetach: !!document.getElementById('co-detach'),
  detachPlaceholder: document.getElementById('co-detach')?.placeholder,
})`)
check('对话框标题正确', dlg.value?.title === '切换分支', dlg.value?.title)
check('搜索框提示含 tag', /tag/.test(dlg.value?.hint || ''), dlg.value?.hint)
check('detach 输入框提示含 tag', /tag/.test(dlg.value?.detachPlaceholder || ''), dlg.value?.detachPlaceholder)

// ---- 1. 有 tag 分组 ----
const groups = await ev(`(() => {
  const gs = [...document.querySelectorAll('#co-list .branch-group')].map(e => e.textContent.trim())
  const tagRows = [...document.querySelectorAll('#co-list .branch-row.is-tag')]
  return {
    groups: gs,
    tagCount: tagRows.length,
    tagNames: tagRows.slice(0, 4).map(r => r.dataset.name),
    hasTagPill: tagRows.length ? !!tagRows[0].querySelector('.pill.tag, .pill.tag-light') : false,
  }
})()`)
check('出现 tag 分组', (groups.value?.groups || []).some((g) => /^tag/.test(g)), JSON.stringify(groups.value?.groups))
check('tag 行已渲染', groups.value?.tagCount > 0, `${groups.value?.tagCount} 个`)

// ---- 2. 搜索 tag ----
await typeIn('#co-filter', 'v5.5.13')
const searched = await ev(`(() => {
  const tagRows = [...document.querySelectorAll('#co-list .branch-row.is-tag')]
  const allRows = [...document.querySelectorAll('#co-list .branch-row')]
  return {
    tagCount: tagRows.length,
    total: allRows.length,
    names: tagRows.slice(0, 4).map(r => r.dataset.name),
    groups: [...document.querySelectorAll('#co-list .branch-group')].map(e => e.textContent.trim()),
  }
})()`)
check('搜索命中 tag', searched.value?.tagCount > 0, `${searched.value?.tagCount} 个 tag`)
check('命中的 tag 名含 5.5.13', (searched.value?.names || []).every((n) => n.includes('5.5.13')),
  JSON.stringify(searched.value?.names))
await shot('checkout-tag-list.png')

// ---- 3. 点选 tag ----
const pickedTag = await ev(`(() => {
  const row = document.querySelector('#co-list .branch-row.is-tag')
  if (!row) return null
  const name = row.dataset.name
  row.click()
  return {
    name,
    sel: row.classList.contains('sel'),
    tip: document.getElementById('co-picked')?.textContent,
    detachCleared: document.getElementById('co-detach').value === '',
  }
})()`)
await sleep(300)
check('点击 tag 行选中', pickedTag.value?.sel === true, pickedTag.value?.name)
check('提示说明将 detached', /detached/.test(pickedTag.value?.tip || ''), pickedTag.value?.tip?.slice(0, 50))

// ---- 4. detach 输入框自动完成 ----
await ev(`document.getElementById('co-filter').value = ''; document.getElementById('co-filter').dispatchEvent(new Event('input', {bubbles:true}))`)
await sleep(300)
await typeIn('#co-detach', 'v5.5.13')
const acState = await ev(`(() => {
  const input = document.getElementById('co-detach')
  const panel = input.closest('.ac-wrap')?.querySelector('.ac-panel')
  return {
    hasWrap: !!input.closest('.ac-wrap'),
    open: panel ? !panel.hidden : false,
    count: panel ? panel.querySelectorAll('.ac-item').length : 0,
    labels: panel ? [...panel.querySelectorAll('.ac-item .ac-label')].slice(0, 3).map(e => e.textContent.trim()) : [],
  }
})()`)
check('detach 输入框接入自动完成', acState.value?.hasWrap === true, '')
check('搜索后弹出候选', acState.value?.open === true && acState.value?.count > 0, `${acState.value?.count} 项`)
check('候选含 tag 名', (acState.value?.labels || []).some((l) => l.includes('5.5.13')), JSON.stringify(acState.value?.labels))
await shot('checkout-tag-autocomplete.png')

// ---- 5. 选中后清空列表选中态 ----
const afterPick2 = await ev(`(() => {
  const panel = document.getElementById('co-detach').closest('.ac-wrap').querySelector('.ac-panel')
  const it = panel?.querySelector('.ac-item:not(.disabled)')
  if (!it) return null
  const label = it.querySelector('.ac-label').textContent.trim()
  it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return {
    label,
    value: document.getElementById('co-detach').value,
    tip: document.getElementById('co-picked')?.textContent,
    anySel: document.querySelectorAll('#co-list .branch-row.sel').length,
  }
})()`)
await sleep(350)
check('自动完成回填值', afterPick2.value?.value === afterPick2.value?.label,
  `${afterPick2.value?.value} vs ${afterPick2.value?.label}`)
check('回填后清空列表选中态', afterPick2.value?.anySel === 0, `${afterPick2.value?.anySel} 个仍选中`)
check('回填后提示被清空', !afterPick2.value?.tip, `tip=${afterPick2.value?.tip}`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

// 关闭（不做真实切换，避免改动用户仓库状态）
await ev(`document.getElementById('modal-close').click()`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
ws.close(); try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
