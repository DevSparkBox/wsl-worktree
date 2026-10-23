// 文件树页的符号大纲面板（右侧）
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9971
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(40)} ${d}`) }

const wsl = (cmd) => { try { return execFileSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' }).trim() } catch { return '' } }

const repos = await (await fetch('http://localhost:7801/api/repos')).json()
const rp = (repos.repos || []).find((r) => r.name === 'jm_java')
if (!rp) { console.log('FAIL  找不到 jm_java'); process.exit(1) }

// 带嵌套结构的接口文件（顶层接口 + 内部接口 + 方法）
const JAVA_FILE = 'backend/src/jmpt-common/src/main/java/com/mysoft/jmpt/common/adapter/IMetadataQueryHelper.java'
const exists = wsl(`cd /home/wangy/codes/jm_java && git ls-files --error-unmatch "${JAVA_FILE}" 2>/dev/null`)
if (!exists) { console.log('SKIP  样本文件不存在'); process.exit(0) }

// 找一个不支持大纲的文件（sql）验证空状态
const SQL_FILE = wsl(`cd /home/wangy/codes/jm_java && git ls-files "*.sql" | head -1`)

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1400,860', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\ol-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

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
const errs = []
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description?.slice(0, 160))
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (m, pa = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: pa }))
})
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description?.slice(0, 160) }
  return { value: r?.result?.value }
}
const waitFor = async (expr, timeout = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    const v = await ev(expr)
    if (v.value) return v.value
    await sleep(250)
  }
  return null
}
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 860, deviceScaleFactor: 2, mobile: false })

const open = async (file) => {
  await send('Page.navigate', { url: `http://localhost:7801/tree.html?repo=${rp.id}&sha=HEAD&path=${encodeURIComponent(file)}` })
  await waitFor(`document.querySelectorAll('#t-outline-list .o-node').length > 0`, 25000)
  await sleep(500)
}

await open(JAVA_FILE)

// ---------- 基本渲染 ----------
const base = await ev(`({
  visible: !document.getElementById('t-outline').hidden,
  count: Number(document.getElementById('t-outline-count').textContent || 0),
  nodes: document.querySelectorAll('#t-outline-list .o-node').length,
  types: document.querySelectorAll('.o-icon-type').length,
  fns: document.querySelectorAll('.o-icon-fn').length,
  first: document.querySelector('#t-outline-list .o-node .o-name')?.textContent,
  names: [...document.querySelectorAll('#t-outline-list .o-node .o-name')].map(e => e.textContent),
})`)
check('大纲默认显示', base.value?.visible === true, '')
check('符号数与标题一致', base.value?.count > 0 && base.value?.count === base.value?.nodes,
  `${base.value?.count} 个`)
check('类型与函数都有图标', base.value?.types > 0 && base.value?.fns > 0,
  `${base.value?.types} 类型 / ${base.value?.fns} 函数`)
check('接口方法被提取（; 结尾）', base.value?.names?.includes('getFunctionPageByUrl'),
  base.value?.names?.slice(0, 3).join(', '))

// 嵌套：顶层接口的 paddingLeft 应小于内部接口/方法
const indents = await ev(`[...document.querySelectorAll('#t-outline-list .o-node')].map(n => ({
  pad: parseInt(n.style.paddingLeft, 10),
  name: n.querySelector('.o-name').textContent,
}))`)
const topPad = indents.value?.[0]?.pad
const deeper = indents.value?.filter((x) => x.pad > topPad)
check('嵌套用缩进表达层级', deeper?.length > 0,
  `顶层 ${topPad}px，缩进更深 ${deeper?.length} 个`)
await shot('outline-java.png')

// ---------- 点击跳转 ----------
const clicked = await ev(`(() => {
  const node = [...document.querySelectorAll('#t-outline-list .o-node')].find(n => n.querySelector('.o-icon-fn'))
  if (!node) return null
  node.click()
  return { name: node.querySelector('.o-name').textContent, line: Number(node.dataset.line) }
})()`)
await sleep(800)
const afterClick = await ev(`({
  active: document.querySelector('#t-outline-list .o-node.active .o-name')?.textContent,
  // 引用是面板下方的独立分区，不再内联在符号树里
  refsHidden: document.getElementById('t-outline-refs').hidden,
  refsTitle: document.getElementById('t-refs-sym').textContent,
  refRows: document.querySelectorAll('#t-outline-refs .o-ref').length,
  defMarked: document.querySelectorAll('#t-outline-refs .o-ref-def').length,
  inlineRefs: document.querySelectorAll('#t-outline-list .o-ref').length,
  btnSvg: Boolean(document.querySelector('#t-search-all svg')),
  flashRows: document.querySelectorAll('.o-jump-flash').length,
  bodyScroll: Math.round(document.getElementById('t-file-body').scrollTop),
})`)
check('点符号后大纲高亮它', afterClick.value?.active === clicked.value?.name,
  `${clicked.value?.name}`)
check('点符号后下方出现引用分区',
  afterClick.value?.refsHidden === false && afterClick.value?.refRows > 0,
  `${afterClick.value?.refRows} 行`)
check('引用分区标题是当前符号', afterClick.value?.refsTitle === clicked.value?.name,
  afterClick.value?.refsTitle)
check('引用不再内联在符号树里', afterClick.value?.inlineRefs === 0, '')
check('定义那一行在引用区里被标出', afterClick.value?.defMarked >= 1, '')
check('搜索全部文件按钮带图标', afterClick.value?.btnSvg === true, '')
check('跳转时该行有闪烁高亮', afterClick.value?.flashRows > 0, `${afterClick.value?.flashRows} 行`)

// 点引用行 → 跳到那一行
const refLine = await ev(`(() => {
  const r = document.querySelector('.o-ref')
  if (!r) return null
  r.click()
  return Number(r.dataset.line)
})()`)
await sleep(600)
const afterRefClick = await ev(`({
  flash: Number(document.querySelector('.o-jump-flash')?.dataset.line || 0),
})`)
check('点引用行跳到对应行', afterRefClick.value?.flash === refLine.value,
  `第 ${refLine.value} 行`)

// ---------- 滚动联动 ----------
const before = await ev(`document.querySelector('#t-outline-list .o-node.active .o-name')?.textContent`)
await ev(`document.getElementById('t-file-body').scrollTop = 900`)
await sleep(700)
const after = await ev(`document.querySelector('#t-outline-list .o-node.active .o-name')?.textContent`)
check('滚动代码时大纲跟着高亮', Boolean(before.value) && before.value !== after.value,
  `${before.value} → ${after.value}`)

// ---------- 过滤 ----------
await ev(`(() => {
  const i = document.getElementById('t-outline-filter')
  i.value = 'AppCode'
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(400)
const filtered = await ev(`({
  nodes: document.querySelectorAll('#t-outline-list .o-node').length,
  names: [...document.querySelectorAll('#t-outline-list .o-name')].map(e => e.textContent),
  // 搜索时必须保留树形：祖先节点淡色显示，命中项缩进在其下
  dim: document.querySelectorAll('.o-node.o-dim').length,
  deeper: [...document.querySelectorAll('.o-node')].filter(n => parseInt(n.style.paddingLeft, 10) > 6).length,
  marks: document.querySelectorAll('.o-name mark').length,
  dimPads: [...document.querySelectorAll('.o-node.o-dim')].map(n => parseInt(n.style.paddingLeft, 10)),
})`)
check('过滤后只剩命中的符号',
  filtered.value?.nodes > 0 && filtered.value?.nodes < base.value?.nodes,
  `${base.value?.nodes} → ${filtered.value?.nodes}`)
check('搜索时保留树形结构（命中项有缩进）', filtered.value?.deeper > 0,
  `${filtered.value?.deeper} 个缩进节点`)
check('命中的祖先淡色显示作路径', filtered.value?.dim > 0,
  `${filtered.value?.dim} 个祖先，缩进 ${JSON.stringify(filtered.value?.dimPads)}`)
check('命中文字高亮', filtered.value?.marks > 0, `${filtered.value?.marks} 处`)
await ev(`(() => {
  const i = document.getElementById('t-outline-filter')
  i.value = ''
  i.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(300)

// ---------- 跨文件搜索 ----------
await ev(`document.querySelector('.o-search-all')?.click()`)
await sleep(1200)
const searched = await ev(`({
  searchTab: document.getElementById('t-tab-search').classList.contains('active'),
  query: document.getElementById('t-grep-input').value,
  viewVisible: !document.getElementById('t-view-search').hidden,
})`)
check('跨文件搜索切到搜索视图', searched.value?.searchTab === true && searched.value?.viewVisible === true, '')
check('跨文件搜索填入符号名', /^[A-Za-z_]\w*$/.test(searched.value?.query || ''), searched.value?.query)
check('跨文件搜索触发结果区', searched.value?.viewVisible === true, '')

// ---------- 关闭与重开 ----------
await ev(`document.getElementById('t-outline-close').click()`)
await sleep(300)
check('关闭按钮隐藏面板', (await ev(`document.getElementById('t-outline').hidden`)).value === true, '')
await ev(`document.getElementById('t-btn-outline').click()`)
await sleep(500)
check('顶栏「大纲」按钮可重新打开', (await ev(`document.getElementById('t-outline').hidden`)).value === false, '')

// ---------- 不支持大纲的文件 ----------
if (SQL_FILE) {
  await send('Page.navigate', { url: `http://localhost:7801/tree.html?repo=${rp.id}&sha=HEAD&path=${encodeURIComponent(SQL_FILE)}` })
  await waitFor(`document.querySelector('#t-outline-list .o-empty')`, 20000)
  const sqlView = await ev(`({
    nodes: document.querySelectorAll('#t-outline-list .o-node').length,
    empty: document.querySelector('#t-outline-list .o-empty')?.textContent || '',
    count: document.getElementById('t-outline-count').textContent,
  })`)
  check('不支持的语言显示空状态', sqlView.value?.nodes === 0 && /没有代码符号/.test(sqlView.value?.empty || ''),
    sqlView.value?.empty)
} else {
  console.log('       (没有 sql 文件，跳过不支持语言断言)')
}

check('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | '))

ws.close()
try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
