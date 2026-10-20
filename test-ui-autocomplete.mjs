// 自动完成 UI 测试：模糊匹配 / 键盘导航 / tag 模式
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9299

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-ac-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 只取「当前焦点输入框」所在的那一个面板，避免跨面板取到起点输入框的候选
const panelItems = (limit = 5) => `(() => {
  const input = document.activeElement
  const wrap = input?.closest('.ac-wrap')
  const panel = wrap?.querySelector('.ac-panel')
  if (!panel) return { count: 0, labels: [], marks: 0, hidden: true }
  return {
    count: panel.querySelectorAll('.ac-item').length,
    labels: [...panel.querySelectorAll('.ac-item:not(.disabled) .ac-label')].slice(0, ${limit}).map(e => e.textContent.trim()),
    marks: panel.querySelectorAll('mark').length,
    hidden: panel.hidden,
    active: panel.querySelector('.ac-item.active .ac-label')?.textContent.trim(),
  }
})()`
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
// 逐字符输入（真实键盘事件），等面板稳定后再取结果
const type = async (text) => {
  await ev(`(() => { const i = document.activeElement; i.value = ''; i.dispatchEvent(new Event('input', {bubbles:true})) })()`)
  await sleep(120)
  for (const ch of text) {
    await send('Input.dispatchKeyEvent', { type: 'char', text: ch })
    await sleep(26)
  }
  // 逐字输入会触发多次 render，等它彻底稳定
  await sleep(420)
}
const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk })
  await sleep(160)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?ac=1' })
await sleep(4500)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 先单测模糊算法（直接调页面里的函数不可行，改为验证 UI 行为）
await ev(`(() => { const el=[...document.querySelectorAll('#repo-list .repo')].find(e=>e.dataset.toplevel.endsWith('/jm_java')); el&&el.click() })()`)
await sleep(2500)
await ev(`document.getElementById('btn-new-wt').click()`)
await sleep(2000)

// ---- 1. 五种模式 ----
const modes = await ev(`[...document.querySelectorAll('#nw-mode button')].map(b => b.textContent.trim())`)
check('五种创建模式', modes.value?.length === 5 && modes.value.includes('基于 tag'), JSON.stringify(modes.value))

// ---- 2. 焦点在分支输入框时自动弹出候选 ----
const branchInput = await ev(`(() => {
  const i = document.getElementById('nw-branch')
  i.focus()
  i.dispatchEvent(new Event('focus'))
  return { id: i.id, hasWrap: !!i.closest('.ac-wrap') }
})()`)
await sleep(500)
check('分支输入框已接入自动完成', branchInput.value?.hasWrap === true, JSON.stringify(branchInput.value))

const panelOpen = await ev(panelItems(6))
check('聚焦后弹出候选面板', panelOpen.value?.hidden === false && panelOpen.value?.count > 0,
  `${panelOpen.value?.count} 项`)

// ---- 3. 模糊匹配：常见前缀 ----
await ev(`document.getElementById('nw-branch').focus()`)
await type('hotfix')
const r1 = await ev(panelItems(5))
check('前缀匹配 hotfix', r1.value?.labels?.length > 0 && r1.value.labels.every((l) => l.includes('hotfix')),
  JSON.stringify(r1.value?.labels))
check('命中处高亮', r1.value?.marks > 0, `${r1.value?.marks} 处高亮`)

// ---- 4. 模糊匹配：跨段（h5.5.13 命中 hotfix/h-tag-5.5.13.10-xxx）----
// 注意必须在「远程分支」模式测：本地只有 14 个分支，跨段组合主要出现在远程那 184 个
await ev(`document.querySelector('#nw-mode button[data-v=remote]').click()`)
await sleep(900)
await ev(`document.getElementById('nw-branch').focus()`)
await type('h5.5.13')
const r2 = await ev(panelItems(4))
const hit513 = r2.value?.labels?.filter((l) => l.includes('5.5.13') && l.includes('hotfix'))
check('跨段模糊命中 h5.5.13', hit513?.length > 0, JSON.stringify(r2.value?.labels?.slice(0, 2)))
check('跨段命中排在首位', /5\.5\.13/.test(r2.value?.labels?.[0] || ''), r2.value?.labels?.[0]?.slice(0, 40))

// 切回「新分支」模式继续后面的键盘测试
await ev(`document.querySelector('#nw-mode button[data-v=new]').click()`)
await sleep(700)
await ev(`document.getElementById('nw-branch').focus()`)

// ---- 5. 无匹配提示 ----
await type('zzzzz-nothing')
const r3 = await ev(`(() => {
  const panel = document.activeElement?.closest('.ac-wrap')?.querySelector('.ac-panel')
  return { empty: panel?.querySelector('.ac-empty')?.textContent, items: panel?.querySelectorAll('.ac-item').length }
})()`)
check('无匹配显示提示', Boolean(r3.value?.empty) && r3.value?.items === 0, r3.value?.empty)

// ---- 6. 键盘导航 ----
// 注意：hotfix 的三个分支里有两个可能已被其它 worktree 占用（会标 disabled），
// 所以先用一个能命中多个「可选」项的查询：切到远程模式（本地分支常被占满）
await ev(`document.querySelector('#nw-mode button[data-v=remote]').click()`)
await sleep(900)
await ev(`document.getElementById('nw-branch').focus()`)
await type('5.5.13')

const navState = (label) => ev(`(() => {
  const panel = document.activeElement?.closest('.ac-wrap')?.querySelector('.ac-panel')
  const act = panel?.querySelector('.ac-item.active')
  const all = panel ? [...panel.querySelectorAll('.ac-item')] : []
  return {
    idx: act ? all.indexOf(act) : -1,
    usable: all.filter(e => !e.classList.contains('disabled')).length,
    label: act?.querySelector('.ac-label')?.textContent.trim(),
  }
})()`)

const s0 = await navState()
check('远程 mode 有多个可选项', s0.value?.usable >= 2, `${s0.value?.usable} 个可选 / ${s0.value?.usable + (s0.value?.idx === -1 ? 0 : 0)}`)
await key('ArrowDown', 'ArrowDown', 40)
const s1 = await navState()
check('方向键选中第一个可选项', s1.value?.idx >= 0, `index=${s1.value?.idx} ${s1.value?.label?.slice(0, 24)}`)

if ((s0.value?.usable || 0) >= 2) {
  await key('ArrowDown', 'ArrowDown', 40)
  const s2 = await navState()
  check('再按方向键移动到下一项', s2.value?.idx > s1.value?.idx, `index ${s1.value?.idx} → ${s2.value?.idx}`)
  await key('ArrowUp', 'ArrowUp', 38)
  const s3 = await navState()
  check('方向键可回退', s3.value?.idx === s1.value?.idx, `index ${s2.value?.idx} → ${s3.value?.idx}`)
} else {
  console.log('   跳过前进用例：只有 1 个可选项目')
}

// 验证 disabled 项会被跳过
const skipInfo = await ev(`(() => {
  const panel = document.activeElement?.closest('.ac-wrap')?.querySelector('.ac-panel')
  const all = panel ? [...panel.querySelectorAll('.ac-item')] : []
  const act = panel?.querySelector('.ac-item.active')
  return { activeIsDisabled: act ? act.classList.contains('disabled') : null, disabledCount: all.filter(e => e.classList.contains('disabled')).length }
})()`)
check('高亮项不会落在禁用项上', skipInfo.value?.activeIsDisabled === false, `disabled=${skipInfo.value?.disabledCount} 个`)

// Enter 填入当前高亮项
const beforeEnter = await ev(`(() => {
  const panel = document.activeElement?.closest('.ac-wrap')?.querySelector('.ac-panel')
  return panel?.querySelector('.ac-item.active .ac-label')?.textContent.trim()
})()`)
await key('Enter', 'Enter', 13)
await sleep(300)
const filled = await ev(`(() => {
  const panel = document.activeElement?.closest('.ac-wrap')?.querySelector('.ac-panel')
  return {
    value: document.getElementById('nw-branch').value,
    panelHidden: panel ? panel.hidden : true,
    path: document.getElementById('nw-path').value,
  }
})()`)
check('Enter 填入当前高亮项（远程去掉 origin/）',
  filled.value?.value === beforeEnter.value?.replace(/^[^/]+\//, ''),
  `${filled.value?.value?.slice(0, 30)} ← 高亮项 ${beforeEnter.value?.slice(0, 34)}`)
check('选中后面板关闭', filled.value?.panelHidden === true, '')
check('路径随之更新', filled.value?.path?.includes('jm_java-'), filled.value?.path)

// 回到新分支模式继续后面的用例
await ev(`document.querySelector('#nw-mode button[data-v=new]').click()`)
await sleep(600)

// ---- 7. Esc 关闭面板但不关闭对话框 ----
await ev(`document.getElementById('nw-branch').focus()`)
await type('hot')
await key('Escape', 'Escape', 27)
const afterEsc = await ev(`(() => { const p = document.getElementById('nw-branch').closest('.ac-wrap').querySelector('.ac-panel'); return { panelHidden: p.hidden, modalOpen: !document.getElementById('modal').hidden } })()`)
check('Esc 只关面板', afterEsc.value?.panelHidden === true && afterEsc.value?.modalOpen === true, JSON.stringify(afterEsc.value))

// ---- 8. 远程分支模式：自动去掉 origin/ 前缀 ----
await ev(`document.querySelector('#nw-mode button[data-v=remote]').click()`)
await sleep(900)
await ev(`document.getElementById('nw-branch').focus()`)
await type('5.5.13')
const remoteItems = await ev(panelItems(4)).then(r => ({ value: r.value?.labels }))
check('远程模式有候选', remoteItems.value?.length > 0, JSON.stringify(remoteItems.value?.slice(0, 2)))

// 选一个远程分支，value 应不含 origin/
const remotePick = await ev(`(() => {
  const panel = document.getElementById('nw-branch').closest('.ac-wrap').querySelector('.ac-panel')
  const it = panel?.querySelector('.ac-item:not(.disabled)')
  if (!it) return null
  const label = it.querySelector('.ac-label').textContent.trim()
  it.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  return { label, value: document.getElementById('nw-branch').value }
})()`)
await sleep(400)
check('远程分支值去掉 origin/', remotePick.value && !remotePick.value.value.startsWith('origin/'),
  `${remotePick.value?.label} → ${remotePick.value?.value}`)
await shot('ac-remote.png')

// ---- 9. tag 模式 ----
await ev(`document.querySelector('#nw-mode button[data-v=tag]').click()`)
await sleep(700)
const tagMode = await ev(`({
  tagFieldVisible: !document.getElementById('nw-tag-branch-field').hidden,
  mkbranch: !!document.getElementById('nw-tag-mkbranch'),
  label: document.getElementById('nw-branch-label').textContent,
})`)
check('tag 模式字段就位', tagMode.value?.tagFieldVisible && tagMode.value?.mkbranch, JSON.stringify(tagMode.value))
check('tag 模式标签正确', /tag/i.test(tagMode.value?.label || ''), tagMode.value?.label)

await ev(`document.getElementById('nw-branch').focus()`)
await type('v5')
const tagItems = await ev(panelItems(5)).then(r => ({ value: r.value?.labels }))
check('tag 模式列出 tag', tagItems.value?.length > 0 && tagItems.value.every((t) => /^v/i.test(t)),
  JSON.stringify(tagItems.value?.slice(0, 3)))
await shot('ac-tag.png')

// 勾选建分支 → 出现分支输入框
await ev(`(() => {
  const cb = document.getElementById('nw-tag-mkbranch')
  cb.checked = true
  cb.dispatchEvent(new Event('change', { bubbles: true }))
})()`)
await sleep(300)
const withBranch = await ev(`!document.getElementById('nw-tag-branch').hidden`)
check('勾选后显示分支输入框', withBranch.value === true, '')

// ---- 10. 现有分支模式 ----
await ev(`document.querySelector('#nw-mode button[data-v=existing]').click()`)
await sleep(600)
await ev(`document.getElementById('nw-branch').focus()`)
const existingItems = await ev(`document.querySelectorAll('.ac-item').length`)
check('现有分支模式有候选', existingItems.value > 0, `${existingItems.value} 项`)

// 被占用的分支应禁用
const busyCount = await ev(`document.querySelectorAll('.ac-item.disabled').length`)
check('被占用分支标记禁用', busyCount.value > 0, `${busyCount.value} 个禁用`)

// ---- 11. 起点输入框也能自动完成 ----
await ev(`document.querySelector('#nw-mode button[data-v=new]').click()`)
await sleep(500)
await ev(`document.getElementById('nw-base').focus()`)
await sleep(400)
const baseAC = await ev(`(() => {
  const inputs = [...document.querySelectorAll('.ac-wrap')]
  return { wrapped: inputs.length, panels: document.querySelectorAll('.ac-panel').length }
})()`)
check('起点输入框也有自动完成', baseAC.value?.wrapped >= 2, `${baseAC.value?.wrapped} 个自动完成框`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

await ev(`document.getElementById('modal-close').click()`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
ws.close(); try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
