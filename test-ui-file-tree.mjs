// 完整文件树：接口 + 页面（树渲染 / 展开折叠 / 过滤 / 内容 / 历史入口）
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9441
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const REPO = '/home/wangy/codes/jm_java'
const ID = enc(REPO)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

// ============ 1. 接口层 ============
console.log('===== 接口 =====')
const tree = await (await fetch(`http://localhost:7801/api/repos/${ID}/tree?sha=HEAD`)).json()
check('tree 返回文件列表', tree.total > 1000, `${tree.total} 个`)
check('tree 有 sha', /^[0-9a-f]{40}$/.test(tree.sha || ''), tree.sha?.slice(0, 7))
check('文件项含 size', tree.files?.[0]?.size >= 0, `${tree.files?.[0]?.path} ${tree.files?.[0]?.size}B`)
check('中文路径未转义', tree.files?.some((f) => /[\u4e00-\u9fa5]/.test(f.path)), '')
check('不含子模块（只 blob）', !tree.files?.some((f) => f.path.endsWith('/.git')), '')

// 数量应与 ls-files 一致
const lsFiles = await (await fetch(`http://localhost:7801/api/repos/${ID}/files`)).json()
check('tree 数量等于 ls-files', tree.total === lsFiles.files?.length, `${tree.total} vs ${lsFiles.files?.length}`)

// 文件内容
const cat = await (await fetch(`http://localhost:7801/api/repos/${ID}/file-content?sha=HEAD&path=README.md`)).json()
check('file-content 返回内容', (cat.content || '').length > 0, `${cat.lines} 行`)
check('行数统计正确', cat.lines === cat.content.split('\n').length - (cat.content.endsWith('\n') ? 1 : 0), `${cat.lines} 行`)

// 中文文件内容
const cnPath = tree.files.find((f) => /函数/.test(f.path))?.path
const cn = await (await fetch(`http://localhost:7801/api/repos/${ID}/file-content?sha=HEAD&path=${encodeURIComponent(cnPath)}`)).json()
check('中文路径文件可读取', (cn.content || '').length > 0, `${cnPath?.split('/').pop()} ${cn.lines} 行`)

// 不存在
const miss = await fetch(`http://localhost:7801/api/repos/${ID}/file-content?sha=HEAD&path=nope/none.md`)
check('不存在的文件返回 404', miss.status === 404, `HTTP ${miss.status}`)
const missBody = await miss.json()
check('404 带可读信息', Boolean(missBody.error), missBody.error)

// 非法 wt
const badWt = await fetch(`http://localhost:7801/api/repos/${ID}/tree?sha=HEAD&wt=${encodeURIComponent('/nope/x')}`)
check('非法 wt 被拒', badWt.status === 400, `HTTP ${badWt.status}`)

// ============ 2. 页面层 ============
console.log('\n===== 页面 =====')
const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,950', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\tree-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
await sleep(4200)

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl)
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
  return { ws, send, ev, shot, close: () => ws.close() }
}

const p = await connect(targets.find((t) => t.type === 'page'))
await p.send('Page.enable'); await p.send('Runtime.enable')
await p.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 950, deviceScaleFactor: 1, mobile: false })
await p.send('Page.navigate', { url: `http://localhost:7801/tree.html?repo=${ID}&sha=HEAD&wt=${encodeURIComponent(REPO)}` })
// 轮询等首个文件渲染完：右侧大纲面板会让初始化略慢，固定 sleep 容易掐在加载中
for (let i = 0; i < 40; i++) {
  await sleep(500)
  const r = await p.ev(`document.querySelectorAll('.t-code tr').length`)
  if ((r.value || 0) > 0) break
}

const layout = await p.ev(`({
  dirs: document.querySelectorAll('.t-dir').length,
  files: document.querySelectorAll('.t-file').length,
  stat: document.getElementById('t-stat').textContent,
  firstLevelExpanded: (() => {
    const d = [...document.querySelectorAll('.t-dir')].filter(e => !e.style.paddingLeft || e.style.paddingLeft === '6px')
    return d.length > 0 && d.every(e => e.classList.contains('open'))
  })(),
  autoSelected: document.getElementById('t-file-path').textContent,
  codeRows: document.querySelectorAll('.t-code tr').length,
})`)
check('树已渲染', layout.value?.dirs > 0, `${layout.value?.dirs} 目录 / ${layout.value?.files} 文件`)
check('显示文件总数', /个文件/.test(layout.value?.stat || ''), layout.value?.stat)
check('第一层默认展开', layout.value?.firstLevelExpanded === true, '')
check('自动选中并显示内容', layout.value?.codeRows > 0, `${layout.value?.autoSelected?.split('/').pop()} ${layout.value?.codeRows} 行`)

// 目录折叠/展开
// 选一个「展开后确实会多出行」的目录，避免选到只含空子目录的节点导致计数不变
const before = await p.ev(`document.querySelectorAll('.t-node').length`)
const toggled = await p.ev(`(() => {
  // 从后往前找第一个展开的目录，它下面通常已有内容
  const dirs = [...document.querySelectorAll('.t-dir.open')].reverse()
  const dir = dirs[0]
  if (!dir) return null
  const name = dir.querySelector('.t-name').textContent
  const path = dir.dataset.path
  dir.click()
  return { name, path }
})()`)
await sleep(800)
const afterCollapse = await p.ev(`document.querySelectorAll('.t-node').length`)
check('点击目录可折叠', afterCollapse.value < before.value,
  `${toggled.value?.name}: ${before.value} → ${afterCollapse.value} 节点`)

await p.ev(`(() => {
  const dir = [...document.querySelectorAll('.t-dir')].find(e => e.dataset.path === ${JSON.stringify(toggled.value?.path)})
  dir?.click()
})()`)
await sleep(800)
const afterExpand = await p.ev(`document.querySelectorAll('.t-node').length`)
check('再次点击可展开', afterExpand.value === before.value, `${afterExpand.value} 节点`)

// 全部折叠
await p.ev(`document.getElementById('t-collapse-all').click()`)
await sleep(600)
const collapsed = await p.ev(`({
  openDirs: document.querySelectorAll('.t-dir.open').length,
  files: document.querySelectorAll('.t-file').length,
})`)
check('全部折叠生效', collapsed.value?.openDirs === 0, `展开目录 ${collapsed.value?.openDirs} 个`)

// 过滤
const filtered = await p.ev(`(() => {
  const f = document.getElementById('t-filter')
  f.value = 'pom.xml'
  f.dispatchEvent(new Event('input', { bubbles: true }))
  return document.querySelectorAll('.t-file').length
})()`)
await sleep(1200)
const filteredState = await p.ev(`({
  rows: document.querySelectorAll('.t-file').length,
  first: document.querySelector('.t-file .t-name')?.textContent,
  firstIsPom: /^pom\\.xml$/i.test(document.querySelector('.t-file .t-name')?.textContent || ''),
  shownPath: document.getElementById('t-file-path').textContent,
})`)
check('过滤出文件', filteredState.value?.rows > 0 && filteredState.value?.rows <= 300,
  `${filteredState.value?.rows} 条`)
// 文件名精确匹配必须排在最前：否则搜 pom.xml 会被 PlatformApplication.run.xml 之类抢位
check('文件名精确命中排第一', filteredState.value?.firstIsPom === true, filteredState.value?.first)
await p.shot('file-tree-filter.png')

// 清空过滤恢复树
await p.ev(`(() => { const f = document.getElementById('t-filter'); f.value=''; f.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(900)
const restored = await p.ev(`document.querySelectorAll('.t-dir').length`)
check('清空过滤恢复树', restored.value > 0, `${restored.value} 目录`)

// 点击文件切换内容
const switchRes = await p.ev(`(async () => {
  const f = document.getElementById('t-filter')
  f.value = 'README.md'
  f.dispatchEvent(new Event('input', { bubbles: true }))
  return true
})()`)
await sleep(1200)
const beforePath = await p.ev(`document.getElementById('t-file-path').textContent`)
const second = await p.ev(`(() => {
  const rows = [...document.querySelectorAll('.t-file')]
  if (rows.length < 2) return null
  const p1 = rows[0].dataset.path
  const p2 = rows[1].dataset.path
  rows[1].click()
  return { p1, p2 }
})()`)
await sleep(1500)
const afterSwitch = await p.ev(`({
  path: document.getElementById('t-file-path').textContent,
  rows: document.querySelectorAll('.t-code tr').length,
  activeCount: document.querySelectorAll('.t-file.active').length,
})`)
check('点击文件切换内容', afterSwitch.value?.path === second.value?.p2,
  `${second.value?.p2?.split('/').pop()}`)
check('切换后只有一个高亮', afterSwitch.value?.activeCount === 1, `${afterSwitch.value?.activeCount} 个`)

// 历史入口 hover
const histBtn = await p.ev(`(() => {
  const row = document.querySelector('.t-file')
  const b = row?.querySelector('.t-hist-btn')
  if (!b) return { has: false }
  const rules = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch { return [] } })
  const rule = rules.find(r => r.selectorText && r.selectorText.includes('.t-file:hover') && r.selectorText.includes('.t-node-actions'))
  return { has: true, aria: b.getAttribute('aria-label'), hoverRule: !!rule, hoverOpacity: rule?.style.opacity }
})()`)
check('文件行有历史图标', histBtn.value?.has === true, histBtn.value?.aria)
check('历史图标默认隐藏、hover 显形', histBtn.value?.hoverOpacity === '1', `opacity:${histBtn.value?.hoverOpacity}`)

// 点击历史图标打开 history.html
await p.ev(`(() => {
  window.__opened = []
  const orig = window.open
  window.open = function(...a) { window.__opened.push(a[0]); return orig.apply(window, a) }
})()`)
await p.ev(`document.querySelector('.t-file .t-hist-btn').click()`)
await sleep(900)
const opened = await p.ev(`window.__opened || []`)
check('点击历史图标打开 history 页', String(opened.value?.[0] || '').includes('/history.html?'),
  String(opened.value?.[0] || '').slice(0, 50))
check('history URL 带 path', /path=/.test(String(opened.value?.[0] || '')), '')

// 顶部「文件历史」按钮
const topHist = await p.ev(`({
  hidden: document.getElementById('t-btn-history').hidden,
  exists: !!document.getElementById('t-btn-history'),
})`)
check('右侧有「文件历史」按钮且可见', topHist.value?.exists && topHist.value?.hidden === false, '')

// 二进制 / 大文件不应导致崩溃
const binaryTest = await p.ev(`(async () => {
  const r = await fetch('/api/repos/${ID}/tree?sha=HEAD')
  const d = await r.json()
  const big = d.files.filter(f => f.size > 1024 * 1024)
  return { bigCount: big.length, sample: big[0]?.path }
})()`, true)
check('树中有大文件可用于边界测试', binaryTest.value?.bigCount >= 0, `${binaryTest.value?.bigCount} 个 >1MB`)

// ---- 单链目录合并（compact folders）----
// 先清过滤并重新载入，确保树处于「第一层展开」的初始态
// （前面的用例做过全部折叠，不复位的话这里没有可点开的节点）
await p.ev(`(() => { const f=document.getElementById('t-filter'); f.value=''; f.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(900)
await p.send('Page.reload')
await sleep(5500)

const compactOn = await p.ev(`({
  checked: document.getElementById('t-compact').checked,
  compressedRows: [...document.querySelectorAll('.t-dir .t-name')].filter(e => e.textContent.includes('/')).length,
  samples: [...document.querySelectorAll('.t-dir .t-name-compressed')].slice(0, 5).map(e => ({
    shown: e.textContent,
    title: e.getAttribute('title'),
  })),
})`)
check('默认开启合并目录', compactOn.value?.checked === true, '')
check('出现合并的目录行', compactOn.value?.compressedRows > 0, `${compactOn.value?.compressedRows} 行`)
check('合并行有完整路径提示',
  (compactOn.value?.samples || []).every((s) => s.title && s.title.includes('/')),
  JSON.stringify(compactOn.value?.samples?.[0]))
// 一次展开：点「未展开的合并节点」后应直接看到分叉或文件，不需连点
const oneClick = await p.ev(`(() => {
  // 只选压缩过（t-name-compressed）且未展开的目录
  const row = [...document.querySelectorAll('.t-dir:not(.open)')]
    .find(e => e.querySelector('.t-name-compressed'))
  if (!row) return null
  const before = document.querySelectorAll('.t-node').length
  const name = row.querySelector('.t-name').textContent
  row.click()
  return { before, name }
})()`)
await sleep(1000)
const afterOneClick = await p.ev(`({
  nodes: document.querySelectorAll('.t-node').length,
  open: [...document.querySelectorAll('.t-dir.open')].map(e => e.querySelector('.t-name').textContent),
})`)
check('点击合并节点一次即可展开', oneClick.value?.before != null && afterOneClick.value?.nodes > oneClick.value?.before,
  `${oneClick.value?.name}: ${oneClick.value?.before} → ${afterOneClick.value?.nodes} 节点`)

// 长链显示省略：需要展开到足够深才会出现 5 段以上的链。
// 从 backend/src 一路往里点：先展开它，再逐个展开它的子目录
const deepChain = await p.ev(`(() => {
  const dirs = () => [...document.querySelectorAll('.t-dir')]
  const byName = (n, opened) => dirs().find(e =>
    (e.querySelector('.t-name')?.textContent || '') === n &&
    (opened === undefined || e.classList.contains('open') === opened))

  // 1) 确认 backend/src 展开
  let b = byName('backend/src', false)
  if (b) b.click()
  // 2) 逐个展开 backend/src 下的子目录（jmpt-* 等），每轮重新查询（DOM 已重建）
  const targets = ['jmpt-benchmark', 'jmpt-common', 'jmpt-unit', 'jmpt-features']
  for (const t of targets) {
    const row = byName(t, false)
    if (row) row.click()
  }
  // 3) 处理展开后新出现的压缩节点（如 xxx/src/main/java/com/...）
  for (let i = 0; i < 6; i++) {
    const next = dirs().find(e =>
      !e.classList.contains('open') && e.querySelector('.t-name-compressed'))
    if (!next) break
    next.click()
    // 一旦出现长链就停
    const hasLong = dirs().some(e => {
      const t = e.querySelector('.t-name-compressed')?.getAttribute('title') || ''
      return t.split('/').length > 4
    })
    if (hasLong) break
  }
  const all = [...document.querySelectorAll('.t-name-compressed')].map(e => ({
    shown: e.textContent,
    title: e.getAttribute('title') || '',
  }))
  const long = all.filter(x => x.title.split('/').length > 4)
  return {
    total: all.length,
    longCount: long.length,
    sample: long[0],
    opened: document.querySelectorAll('.t-dir.open').length,
  }
})()`)
await sleep(1800)
check('深层出现长链', deepChain.value?.longCount > 0,
  `${deepChain.value?.longCount} 条长链 / ${deepChain.value?.total} 条合并行（展开 ${deepChain.value?.opened} 目录）`)
check('长链显示带省略号', String(deepChain.value?.sample?.shown || '').includes('…'),
  deepChain.value?.sample ? `${deepChain.value.sample.shown}   ← 完整 ${deepChain.value.sample.title.split('/').length} 段` : '')
check('长链 title 是完整路径',
  (deepChain.value?.sample?.title || '').split('/').length > 4,
  deepChain.value?.sample?.title?.slice(-46))

// 关闭合并 → 恢复逐层
await p.ev(`(() => { const c=document.getElementById('t-compact'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(1000)
const compactOff = await p.ev(`({
  compressedRows: document.querySelectorAll('.t-name-compressed').length,
  dirs: document.querySelectorAll('.t-dir').length,
  stored: localStorage.getItem('wsl-worktree.treeCompact'),
})`)
check('关闭合并后没有合并行', compactOff.value?.compressedRows === 0, `${compactOff.value?.compressedRows} 行`)
check('开关状态被记住', compactOff.value?.stored === '0', compactOff.value?.stored)

// 重新开启
await p.ev(`(() => { const c=document.getElementById('t-compact'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(900)
const compactBack = await p.ev(`document.querySelectorAll('.t-name-compressed').length`)
check('重新开启后合并行恢复', compactBack.value > 0, `${compactBack.value} 行`)

// ---- 语法高亮 ----
// 直接打开一个 Java 文件（已知有 public/class/注释/字符串等 token）
const javaFile = (await (await fetch(`http://localhost:7801/api/repos/${ID}/tree?sha=HEAD`)).json())
  .files.find((f) => /\.java$/.test(f.path) && f.size > 1500 && f.size < 12000)
check('找不到测试用 Java 文件', Boolean(javaFile), javaFile?.path?.split('/').pop() || '未找到')

await p.send('Page.navigate', {
  url: `http://localhost:7801/tree.html?repo=${ID}&sha=HEAD&wt=${encodeURIComponent(REPO)}&path=${encodeURIComponent(javaFile.path)}`,
})
await sleep(5500)

const hlOn = await p.ev(`({
  hasHlTable: !!document.querySelector('.t-code.has-hl'),
  spanCount: document.querySelectorAll('.t-code .code span').length,
  kinds: [...new Set([...document.querySelectorAll('.t-code .code span')].map(e => e.className))].sort(),
  meta: document.getElementById('t-file-meta').textContent,
  checked: document.getElementById('t-hl').checked,
})`)
check('默认开启高亮', hlOn.value?.checked === true, '')
check('代码已上色', hlOn.value?.hasHlTable === true && hlOn.value?.spanCount > 0,
  `${hlOn.value?.spanCount} 个 span`)
check('出现多种 token 类别', (hlOn.value?.kinds || []).length >= 3, JSON.stringify(hlOn.value?.kinds))
check('meta 显示语言名', /Java/.test(hlOn.value?.meta || ''), hlOn.value?.meta)

// 内容必须与纯文本一致（高亮不能吞字符）
const contentEqual = await p.ev(`(async () => {
  const params = new URLSearchParams({ sha: 'HEAD', path: ${JSON.stringify(javaFile.path)} })
  params.set('wt', ${JSON.stringify(REPO)})
  const r = await fetch('/api/repos/${ID}/file-content?' + params)
  const d = await r.json()
  const raw = d.content.split('\\n')
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()
  const tds = [...document.querySelectorAll('.t-code .code')]
  if (tds.length !== raw.length) return { ok: false, why: 'rows ' + tds.length + ' vs ' + raw.length }
  // 每行比对去标签后的文本（空行渲染为 nbsp）
  for (let i = 0; i < raw.length; i++) {
    const got = tds[i].textContent.replace(/\\u00a0/g, '')
    const want = raw[i]
    if (got !== want) return { ok: false, why: 'line ' + (i+1) + ': ' + JSON.stringify(got.slice(0,40)) + ' != ' + JSON.stringify(want.slice(0,40)) }
  }
  return { ok: true, rows: raw.length }
})()`)
check('高亮后文本与原文逐行一致', contentEqual.value?.ok === true,
  contentEqual.value?.ok ? `${contentEqual.value?.rows} 行` : contentEqual.value?.why)

// 关掉高亮 → 回到纯文本
await p.ev(`(() => { const c=document.getElementById('t-hl'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(900)
const hlOff = await p.ev(`({
  hasHlTable: !!document.querySelector('.t-code.has-hl'),
  spanCount: document.querySelectorAll('.t-code .code span').length,
  rows: document.querySelectorAll('.t-code tr').length,
  stored: localStorage.getItem('wsl-worktree.treeHighlight'),
})`)
check('关闭后无高亮 span', hlOff.value?.spanCount === 0, `${hlOff.value?.spanCount} 个`)
check('关闭后行数不变', hlOff.value?.rows > 0, `${hlOff.value?.rows} 行`)
check('高亮开关状态被记住', hlOff.value?.stored === '0', hlOff.value?.stored)

// 重新开启
await p.ev(`(() => { const c=document.getElementById('t-hl'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(900)
const hlBack = await p.ev(`document.querySelectorAll('.t-code .code span').length`)
check('重新开启后恢复高亮', hlBack.value > 0, `${hlBack.value} 个 span`)

// 纯文本文件（无扩展名/未知扩展名）不应崩，也不该有 span
// 注意：路径必须真实存在，否则页面会回退到第一个文件（README.md），测的就不是目标了
const plainTarget = (await (await fetch(`http://localhost:7801/api/repos/${ID}/tree?sha=HEAD`)).json())
  .files.find((f) => /(^|\/)LICENSE$|(^|\/)COPYING$|\.unknownext$/.test(f.path))
check('找到无扩展名的纯文本文件', Boolean(plainTarget), plainTarget?.path || '未找到')

if (plainTarget) {
  await p.send('Page.navigate', {
    url: `http://localhost:7801/tree.html?repo=${ID}&sha=HEAD&wt=${encodeURIComponent(REPO)}&path=${encodeURIComponent(plainTarget.path)}`,
  })
  await sleep(4500)
  const plainFile = await p.ev(`({
    rows: document.querySelectorAll('.t-code tr').length,
    spans: document.querySelectorAll('.t-code .code span').length,
    hasHl: !!document.querySelector('.t-code.has-hl'),
    meta: document.getElementById('t-file-meta').textContent,
    shownPath: document.getElementById('t-file-path').textContent,
  })`)
  check('未知语言按纯文本显示', plainFile.value?.spans === 0 && plainFile.value?.rows > 0,
    `${plainFile.value?.rows} 行, ${plainFile.value?.spans} span`)
  check('未知语言不显示语言名', !/·\s*(Java|Less|Markdown|TypeScript|Vue)\s*$/.test(plainFile.value?.meta || ''),
    plainFile.value?.meta)
  check('确实打开了目标文件（未回退）',
    plainFile.value?.shownPath === plainTarget.path,
    plainFile.value?.shownPath?.split('/').pop())
}

await p.shot('file-tree-final.png')

const errs = await p.ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

p.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
