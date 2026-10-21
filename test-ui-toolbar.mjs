// 顶栏/日志表的两处布局修复：
//   1) 日志表的 ref 标签放到摘要文本「前面」（宽度窄时不会被截断遮住）
//   2) 顶栏按钮在容器变窄时不换行（「更新仓库」不会变成竖排的「更新仓/库」）
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9681
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 仓库名很长，最能压出「按钮被挤到换行」的场景
const REPO = '/home/wangy/codes/product_diff_for_update/java_product_diff_for_update'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1440,860', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\tb-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

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
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `http://localhost:7801/#repo=${encodeURIComponent(REPO)}` })
await sleep(7000)

// ============ 1. ref 标签在文本前面 ============
console.log('===== ref 标签位置 =====')
const refOrder = await ev(`(() => {
  const rows = [...document.querySelectorAll('#log-body tr[data-sha]')]
  const withRef = rows.find(r => r.querySelector('.subject .ref-tag'))
  if (!withRef) return null
  const td = withRef.querySelector('.subject')
  // 取所有「元素或非空文本节点」，看它们的先后顺序
  const seq = [...td.childNodes]
    .filter(n => n.nodeType === 1 || (n.nodeType === 3 && n.textContent.trim()))
    .map(n => n.nodeType === 3
      ? { kind: 'text', text: n.textContent.trim().slice(0, 16) }
      : { kind: n.classList.contains('ref-tag') ? 'ref' : 'other', text: n.textContent.trim().slice(0, 24) })
  return {
    seq,
    firstIsRef: seq[0]?.kind === 'ref',
    refCount: seq.filter(s => s.kind === 'ref').length,
    // 第一个 ref 是否在文本之前
    refIndex: seq.findIndex(s => s.kind === 'ref'),
    textIndex: seq.findIndex(s => s.kind === 'text'),
  }
})()`)
check('日志行里有 ref 标签', refOrder.value?.refCount > 0, `${refOrder.value?.refCount} 个`)
check('ref 出现在摘要文本之前',
  refOrder.value?.firstIsRef === true &&
  refOrder.value?.refIndex >= 0 &&
  refOrder.value?.refIndex < refOrder.value?.textIndex,
  `顺序: ${(refOrder.value?.seq || []).map((s) => `${s.kind}:${s.text}`).join(' → ').slice(0, 80)}`)

// ref 靠左意味着：单元格可用宽度被压缩时它仍在可视区（不会被 ellipsis 吃掉）
const refVisible = await ev(`(() => {
  const td = [...document.querySelectorAll('#log-body tr[data-sha] .subject')]
    .find(x => x.querySelector('.ref-tag'))
  if (!td) return null
  const ref = td.querySelector('.ref-tag')
  const rr = ref.getBoundingClientRect()
  const tr = td.getBoundingClientRect()
  // 单元格自身有 padding-left，ref 贴的是「内容区」左边界而不是边框
  const padLeft = parseFloat(getComputedStyle(td).paddingLeft) || 0
  return {
    offset: Math.round(rr.left - tr.left),
    padLeft: Math.round(padLeft),
    // 落在内容区起点（允许 2px 误差）
    atContentLeft: Math.abs((rr.left - tr.left) - padLeft) <= 2,
    visible: rr.width > 0 && rr.right <= tr.right + 1,
  }
})()`)
check('ref 紧贴单元格内容区左侧', refVisible.value?.atContentLeft === true,
  `偏移 ${refVisible.value?.offset}px / padding ${refVisible.value?.padLeft}px`)
check('ref 完整可见（未被裁切）', refVisible.value?.visible === true, '')

// ============ 2. 顶栏按钮不换行 ============
console.log('\n===== 顶栏按钮 =====')

/** 读取三个按钮的排版：高度、行数、是否 nowrap */
const readButtons = () => ev(`(() => {
  const ids = ['btn-fetch', 'btn-new-wt', 'btn-stale']
  return ids.map((id) => {
    const el = document.getElementById(id)
    if (!el) return { id, missing: true }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const lh = parseFloat(cs.lineHeight) || 16
    const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    return {
      id,
      text: el.textContent.trim(),
      h: Math.round(r.height),
      w: Math.round(r.width),
      // 内容高度 / 行高 ≈ 行数；>1.4 说明换行了
      lines: Math.round((r.height - padV) / lh),
      nowrap: cs.whiteSpace,
      flex: cs.flex,
    }
  })
})()`)

for (const width of [1440, 1200, 1100]) {
  await send('Emulation.setDeviceMetricsOverride', { width, height: 860, deviceScaleFactor: 1, mobile: false })
  await sleep(1200)
  const btns = await readButtons()
  const list = btns.value || []
  check(`${width}px: 三个按钮都在`, list.length === 3 && list.every((b) => !b.missing),
    list.map((b) => b.text).join(' / '))
  check(`${width}px: 文案不换行（单行）`, list.every((b) => b.lines === 1),
    list.map((b) => `${b.text}:${b.lines}行`).join(', '))
  check(`${width}px: white-space 为 nowrap`, list.every((b) => b.nowrap === 'nowrap'),
    list[0]?.nowrap)
}

// 按钮不被 flex 压缩：宽度应等于其内容自然宽度（flex: 0 0 auto）
const noShrink = await ev(`(() => {
  const el = document.getElementById('btn-new-wt')
  const cs = getComputedStyle(el)
  // flex-shrink 为 0 表示不参与收缩
  return { flex: cs.flex, shrink: cs.flexShrink, basis: cs.flexBasis }
})()`)
check('按钮不参与 flex 收缩', noShrink.value?.shrink === '0',
  `flex=${noShrink.value?.flex}`)

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false })
await sleep(1000)
await shot('fix-toolbar-1440.png')

// ============ 3. 回归：ref 与链接近没有互相破坏 ============
console.log('\n===== 回归 =====')
const bothWork = await ev(`(() => {
  const td = [...document.querySelectorAll('#log-body tr[data-sha] .subject')]
    .find(x => x.querySelector('.ref-tag'))
  if (!td) return null
  return {
    hasRef: Boolean(td.querySelector('.ref-tag')),
    // 摘要文本仍然存在
    textLen: td.textContent.replace(td.querySelector('.ref-tag')?.textContent || '', '').trim().length,
  }
})()`)
check('ref 与摘要文本共存', bothWork.value?.hasRef === true && bothWork.value?.textLen > 0,
  `${bothWork.value?.textLen} 字`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
