// 提交对比页：选择两个变更集，用「只含有变更文件的树」展示差异
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9761
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用真实大仓库：HEAD~80..HEAD 有 1200+ 变更文件，能压出性能与渲染问题
const A = 'HEAD~80'
const B = 'HEAD'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

// ---------- 接口层 ----------
const repos = await (await fetch('http://localhost:7801/api/repos')).json()
const repo = (repos.repos || []).find((r) => r.name === 'jm_java')
if (!repo) { console.log('FAIL  找不到 jm_java 仓库'); process.exit(1) }
const ID = repo.id
const API = `http://localhost:7801/api/repos/${ID}`

const getCmp = async (a, b) => {
  const r = await fetch(`${API}/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`)
  return { status: r.status, body: await r.json().catch(() => ({})), ms: 0 }
}
const getFile = async (a, b, path, old) => {
  const p = new URLSearchParams({ a, b, path })
  if (old) p.set('old', old)
  const r = await fetch(`${API}/compare-file?${p}`)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

console.log('===== 接口 =====')
let r = await getCmp(A, B)
check('对比返回文件列表', r.status === 200 && r.body.files?.length > 0,
  `${r.body.files?.length} 文件, +${r.body.stats?.add} −${r.body.stats?.del}`)
check('返回解析后的完整 sha', /^[0-9a-f]{40}$/.test(r.body.a || '') && /^[0-9a-f]{40}$/.test(r.body.b || ''),
  `${r.body.a?.slice(0, 8)} → ${r.body.b?.slice(0, 8)}`)
check('统计按状态分组', Object.keys(r.body.stats?.byStatus || {}).length >= 3,
  JSON.stringify(r.body.stats?.byStatus))

const files = r.body.files || []
const withAdd = files.find((f) => !f.binary && f.add > 0)
check('文件条目含增删行数', withAdd && typeof withAdd.del === 'number',
  withAdd ? `${withAdd.path.split('/').pop()} +${withAdd.add} −${withAdd.del}` : '')
check('状态码是单字母', files.every((f) => /^[AMDRCT]$/.test(f.status)),
  [...new Set(files.map((f) => f.status))].join(','))

const ren = files.find((f) => f.status === 'R')
check('改名条目带 oldPath 与相似度', Boolean(ren?.oldPath) && typeof ren?.similar === 'number',
  ren ? `${ren.oldPath} → ${ren.path} (${ren.similar}%)` : '')

const bin = files.find((f) => f.binary)
check('二进制条目标记 binary 且无行数', bin && bin.add === null && bin.del === null,
  bin?.path?.split('/').pop())

// 改名文件的 patch：必须同时传新旧路径，否则会退化成删除/新增
if (ren) {
  const onlyOld = await getFile(A, B, ren.oldPath, '')
  const both = await getFile(A, B, ren.path, ren.oldPath)
  check('只传旧路径会退化成删除', /deleted file/.test(onlyOld.body.patch || ''), '')
  check('同时传新旧路径才显示 rename', /rename from/.test(both.body.patch || ''),
    `similarity ${(both.body.patch || '').match(/similarity index (\d+%)/)?.[1] || '?'}`)
}

const del = files.find((f) => f.status === 'D')
if (del) {
  const d = await getFile(A, B, del.path, '')
  check('删除文件 patch 显示 deleted', /deleted file/.test(d.body.patch || ''), del.path.split('/').pop())
}
const added = files.find((f) => f.status === 'A' && !f.binary)
if (added) {
  const d = await getFile(A, B, added.path, '')
  check('新增文件 patch 显示 new file', /new file/.test(d.body.patch || ''), added.path.split('/').pop())
}

// A == B
r = await getCmp(B, B)
check('A==B 返回空列表', r.status === 200 && r.body.files?.length === 0, `${r.body.files?.length} 文件`)

// 方向：交换 A/B 后增删行数应对调
const fwd = await getCmp(A, B)
const bwd = await getCmp(B, A)
check('交换 A/B 后增删对调',
  bwd.body.stats?.add === fwd.body.stats?.del && bwd.body.stats?.del === fwd.body.stats?.add,
  `+${fwd.body.stats?.add}−${fwd.body.stats?.del} ⟷ +${bwd.body.stats?.add}−${bwd.body.stats?.del}`)

// 无效 rev / 缺参数
r = await getCmp('deadbeefdeadbeef', B)
check('无效 rev 返回 400 且有中文提示', r.status === 400 && /找不到提交/.test(r.body.error || ''), r.body.error)
const miss = await fetch(`${API}/compare?a=${A}`)
check('缺 b 参数返回 400', miss.status === 400, `HTTP ${miss.status}`)

// tag 作 rev
const tagCmp = await getCmp('v5.5.10.55', B)
check('tag 可以当 rev 用', tagCmp.status === 200 && tagCmp.body.files?.length > 0,
  `${tagCmp.body.files?.length} 文件`)

// 中文路径
const cn = files.find((f) => /[\u4e00-\u9fa5]/.test(f.path) && !f.binary)
if (cn) {
  const d = await getFile(A, B, cn.path, cn.oldPath)
  check('中文路径能取到 patch', Boolean(d.body.patch), cn.path.split('/').pop()?.slice(0, 24))
} else {
  console.log('       (这批变更里没有中文路径文件，跳过)')
}

// ---------- 页面层 ----------
console.log('\n===== 页面 =====')
const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,900', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\cmp-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

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
const pageErrs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'warning') {
    pageErrs.push('WARN ' + m.params.args.map(a => a.value || a.description).join(' ').slice(0, 160))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    pageErrs.push(m.params.exceptionDetails?.exception?.description?.slice(0, 160))
  }
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
/** 轮询等待条件成立（比固定 sleep 稳，机器忙时不至于误判） */
const waitFor = async (expr, timeout = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await ev(expr)
    if (v.value) return v.value
    await sleep(250)
  }
  return null
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

const go = async (a, b) => {
  await send('Page.navigate', { url: `http://localhost:7801/compare.html?repo=${ID}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}` })
  await waitFor(`document.querySelectorAll('#c-tree .t-file').length > 0`, 25000)
  await sleep(400)
}

await go(A, B)

const init = await ev(`({
  repo: document.getElementById('c-repo').textContent,
  stat: document.getElementById('c-stat').textContent.trim(),
  files: document.querySelectorAll('#c-tree .t-file').length,
  dirs: document.querySelectorAll('#c-tree .t-dir').length,
  filters: [...document.querySelectorAll('.c-filter-btn')].map(b => b.dataset.status + ':' + b.querySelector('.c-filter-count')?.textContent),
  selected: document.querySelector('#c-tree .t-file.active')?.dataset.path,
  filePath: document.getElementById('c-file-path').textContent,
  patchRows: document.querySelectorAll('#c-file-body .h-patch-table tr').length,
})`)
check('树只包含变更文件', init.value?.files > 0 && init.value?.files === (await getCmp(A, B)).body.files.length,
  `${init.value?.files} 文件 / ${init.value?.dirs} 目录`)
check('顶栏显示统计与耗时', /文件/.test(init.value?.stat || '') && /ms/.test(init.value?.stat || ''),
  init.value?.stat)
check('筛选按钮按状态给出数量', (init.value?.filters || []).length >= 4,
  (init.value?.filters || []).join(' '))
check('默认选中第一个文件并显示 diff',
  Boolean(init.value?.selected) && init.value?.patchRows > 0,
  `${init.value?.filePath?.split('/').pop()} (${init.value?.patchRows} 行)`)
const dirOpen = await ev(`document.querySelectorAll('#c-tree .t-dir.open').length`)
const dirAll = await ev(`document.querySelectorAll('#c-tree .t-dir').length`)
check('默认全部展开', dirOpen.value === dirAll.value && dirAll.value > 0,
  `${dirOpen.value}/${dirAll.value} 个目录展开`)
await shot('compare-page.png')

// 最近提交下拉：放在首次加载后验证。
// 后续测试会连续 Page.navigate，正在进行的 fetch 会被浏览器中断（Failed to fetch），
// 那不是功能问题。
const recentOk = await waitFor(`document.querySelectorAll('#c-recent option').length > 5`, 15000)
const recentCount = await ev(`document.querySelectorAll('#c-recent option').length`)
check('最近提交下拉已填充', recentCount.value > 5,
  `${recentCount.value} 个 option${recentOk ? '' : '（等待超时）'}`)
if (!recentOk) {
  const diag = await ev(`({html: document.getElementById('c-recent')?.outerHTML?.slice(0,90), repo: document.getElementById('c-repo')?.textContent})`)
  console.log('       诊断:', JSON.stringify(diag.value ?? diag.error))
}

// 状态筛选：只看新增
const beforeAll = init.value?.files
await ev(`[...document.querySelectorAll('.c-filter-btn')].find(b=>b.dataset.status==='A').click()`)
await sleep(500)
const onlyA = await ev(`({
  files: document.querySelectorAll('#c-tree .t-file').length,
  badges: [...new Set([...document.querySelectorAll('#c-tree .t-file .c-badge')].map(b=>b.textContent))],
  on: [...document.querySelectorAll('.c-filter-btn.on')].map(b=>b.dataset.status),
})`)
check('筛选「新增」只剩 A 文件', onlyA.value?.files > 0 && onlyA.value?.files < beforeAll &&
  onlyA.value?.badges?.every(b => b === 'A' || b === 'BIN') && onlyA.value?.badges?.includes('A'),
  `${beforeAll} → ${onlyA.value?.files} 文件, 徽章 ${JSON.stringify(onlyA.value?.badges)}`)

// 点「全部」必须真的恢复（曾经的 bug：把 '' 加进集合，导致仍在筛选）
await ev(`[...document.querySelectorAll('.c-filter-btn')].find(b=>b.dataset.status==='').click()`)
await sleep(600)
const restored = await ev(`document.querySelectorAll('#c-tree .t-file').length`)
check('点「全部」恢复所有文件', restored.value === beforeAll, `${onlyA.value?.files} → ${restored.value}`)

// 过滤
await ev(`(()=>{const i=document.getElementById('c-filter');i.value='pom.xml';i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(700)
const filtered = await ev(`({
  rows: document.querySelectorAll('#c-tree .t-file').length,
  names: [...document.querySelectorAll('#c-tree .t-file .t-name')].map(e=>e.textContent),
})`)
check('过滤后只剩匹配文件', filtered.value?.rows > 0 &&
  filtered.value?.names?.some((n) => /pom\.xml/i.test(n)),
  `${filtered.value?.rows} 行`)
await ev(`(()=>{const i=document.getElementById('c-filter');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(600)
check('清空过滤恢复', (await ev(`document.querySelectorAll('#c-tree .t-file').length`)).value === beforeAll, '')

// 折叠 / 展开
await ev(`document.getElementById('c-collapse').click()`)
await sleep(600)
const collapsed = await ev(`document.querySelectorAll('#c-tree .t-node').length`)
check('折叠后只剩顶层目录', collapsed.value < 50 && collapsed.value > 0, `${collapsed.value} 节点`)
await ev(`document.getElementById('c-collapse').click()`)
await sleep(900)
const expanded = await ev(`document.querySelectorAll('#c-tree .t-file').length`)
check('再点恢复全展开', expanded.value === beforeAll, `${expanded.value} 文件`)
await shot('compare-page.png')

// 改名文件：路径显示 old → new，diff 含 rename
const renClicked = await ev(`(()=>{
  const el=[...document.querySelectorAll('#c-tree .t-file')].find(e=>e.querySelector('.c-badge-r'))
  if(!el) return null
  el.click(); return el.dataset.path
})()`)
if (renClicked.value) {
  await sleep(2000)
  const renView = await ev(`({
    path: document.getElementById('c-file-path').textContent,
    status: document.getElementById('c-file-status').textContent,
    body: document.getElementById('c-file-body').textContent,
  })`)
  check('改名文件路径显示旧 → 新', /→/.test(renView.value?.path || ''), renView.value?.path)
  check('改名文件状态显示相似度', /改名\s*\d+%/.test(renView.value?.status || ''), renView.value?.status)
  check('改名文件 diff 含 rename from', /rename from/.test(renView.value?.body || ''), '')
} else {
  console.log('       (这批变更里没有改名文件，跳过)')
}

// 二进制
const binClicked = await ev(`(()=>{
  const el=[...document.querySelectorAll('#c-tree .t-file')].find(e=>e.querySelector('.c-badge-bin'))
  if(!el) return null
  el.click(); return el.dataset.path
})()`)
if (binClicked.value) {
  await sleep(800)
  const binView = await ev(`({
    meta: document.getElementById('c-file-meta').textContent,
    body: document.getElementById('c-file-body').textContent.trim(),
  })`)
  check('二进制文件不展示逐行差异', /二进制/.test(binView.value?.meta || '') &&
    /二进制文件/.test(binView.value?.body || ''), binView.value?.meta)
} else {
  console.log('       (这批变更里没有二进制文件，跳过)')
}

// 交换 A/B：方向反转，增删对调
const beforeSwap = await ev(`({a:document.getElementById('c-a').value, b:document.getElementById('c-b').value, stat:document.getElementById('c-stat').textContent})`)
await ev(`document.getElementById('c-swap').click()`)
await waitFor(`document.getElementById('c-a').value !== ${JSON.stringify(beforeSwap.value?.a)}`, 25000)
await sleep(600)
const afterSwap = await ev(`({a:document.getElementById('c-a').value, b:document.getElementById('c-b').value, stat:document.getElementById('c-stat').textContent})`)
check('交换按钮对调 A/B', afterSwap.value?.a === beforeSwap.value?.b && afterSwap.value?.b === beforeSwap.value?.a,
  `${beforeSwap.value?.a}⇄${beforeSwap.value?.b} → ${afterSwap.value?.a}⇄${afterSwap.value?.b}`)
await ev(`document.getElementById('c-swap').click()`)
await sleep(2500)

// A == B 空状态
await go(B, B)
const same = await ev(`({
  empty: document.getElementById('c-empty').textContent,
  files: document.querySelectorAll('#c-tree .t-file').length,
  filtersHidden: document.getElementById('c-filters').hidden,
})`)
check('A==B 显示「完全相同」', /完全相同/.test(same.value?.empty || '') && same.value?.files === 0,
  same.value?.empty)

// 无效 rev
await send('Page.navigate', { url: `http://localhost:7801/compare.html?repo=${ID}&a=deadbeefdeadbeef&b=HEAD` })
await waitFor(`/找不到提交/.test(document.getElementById('c-empty').textContent||'')`, 20000)
const bad = await ev(`document.getElementById('c-empty').textContent`)
check('无效 rev 显示中文错误', /找不到提交/.test(bad.value || ''), bad.value)

// 分栏拖动：宽度记忆
// 用事件派发而不是 CDP 的 Input 模拟——headless 下 Input 的鼠标事件不稳定，
// 而这里真正要验证的是 mousedown/mousemove 的监听逻辑。
const splitBefore = await ev(`Math.round(document.querySelector('.t-tree-pane').getBoundingClientRect().width)`)
await ev(`(() => {
  const sp = document.getElementById('c-splitter')
  const r = sp.getBoundingClientRect()
  const x = Math.round(r.left + r.width / 2)
  const y = Math.round(r.top + r.height / 2)
  sp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x + 90, clientY: y }))
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  return true
})()`)
await sleep(400)
const splitAfter = await ev(`Math.round(document.querySelector('.t-tree-pane').getBoundingClientRect().width)`)
check('分隔条可拖动', splitAfter.value > splitBefore.value + 40,
  `${splitBefore.value} → ${splitAfter.value}px`)

const hardErrs = pageErrs.filter(e => !e.startsWith('WARN '))
check('无 JS 异常', hardErrs.length === 0, hardErrs.slice(0, 2).join(' | '))
const warns = pageErrs.filter(e => e.startsWith('WARN '))
if (warns.length) console.log('       警告:', warns.slice(0, 2).join(' | '))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
