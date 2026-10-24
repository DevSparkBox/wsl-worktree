// 内容搜索：接口 + 页面（模式切换 / 结果渲染 / 跳转 / 选项）
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', '..', 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9591
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const REPO = '/home/wangy/codes/jm_java'
const ID = enc(REPO)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const get = async (path) => {
  const t0 = Date.now()
  const r = await fetch(`http://localhost:7801/api/repos/${ID}/grep${path}`)
  return { status: r.status, body: await r.json().catch(() => ({})), ms: Date.now() - t0 }
}

// ============ 接口层 ============
console.log('===== 接口 =====')
let r = await get(`?sha=HEAD&q=AuthorizationHelper`)
check('精确词有命中', r.body.files?.length > 0, `${r.body.files?.length} 文件 · ${r.body.total} 处 · ${r.ms}ms`)
check('hits 结构正确', typeof r.body.files?.[0]?.hits?.[0]?.line === 'number' &&
  typeof r.body.files?.[0]?.hits?.[0]?.text === 'string',
  JSON.stringify(r.body.files?.[0]?.hits?.[0])?.slice(0, 70))
check('路径不带 <sha>: 前缀', !String(r.body.files?.[0]?.path).includes(':'), r.body.files?.[0]?.path?.slice(0, 50))
check('内容不含下一条记录', !/\n[a-f0-9]{40}:/i.test(r.body.files?.[0]?.hits?.[0]?.text || ''),
  JSON.stringify(r.body.files?.[0]?.hits?.[0]?.text)?.slice(0, 60))

// 与命令行结果交叉验证（不写死数字：仓库内容会变，390 这种硬编码必然过时）
const { execFileSync } = await import('node:child_process')
const cliCount = (() => {
  try {
    const out = execFileSync('wsl.exe', ['-e', 'bash', '-lc',
      `cd "${REPO}" && git grep -I -e TODO HEAD | wc -l`], { encoding: 'utf8' })
    return Number(out.trim())
  } catch { return null }
})()
r = await get(`?sha=HEAD&q=TODO`)
check('TODO 命中数与 git grep 命令行一致', cliCount != null && r.body.total === cliCount,
  `API ${r.body.total} vs 命令行 ${cliCount}`)
check('多文件命中', r.body.files?.length > 10, `${r.body.files?.length} 个文件`)

// 无命中
r = await get(`?sha=HEAD&q=ZZZZNOTEXIST999XYZ`)
check('无命中返回空', r.status === 200 && r.body.files?.length === 0 && r.body.total === 0,
  `HTTP ${r.status}, ${r.body.files?.length} 文件`)

// 缺参数
r = await get(`?sha=HEAD`)
check('缺 q 返回 400', r.status === 400, r.body.error)

// 限定路径
const all = await get(`?sha=HEAD&q=class`)
const scoped = await get(`?sha=HEAD&q=class&path=backend/src/jmpt-common`)
check('限定路径缩小范围', scoped.body.total < all.body.total,
  `${all.body.total} → ${scoped.body.total}`)
check('限定路径后结果都在该目录下',
  (scoped.body.files || []).every((f) => f.path.startsWith('backend/src/jmpt-common/')), '')

// 忽略大小写
const cs = await get(`?sha=HEAD&q=authorizationhelper&path=backend/src`)
const ci = await get(`?sha=HEAD&q=authorizationhelper&path=backend/src&i=1`)
check('默认区分大小写', cs.body.total < ci.body.total, `${cs.body.total} → ${ci.body.total}`)

// 字面量 vs 正则
const lit = await get(`?sha=HEAD&q=%24%7B&path=frontend/apps/runtime/src`)
check('字面量能搜正则元字符', lit.body.files?.length > 0, `${lit.body.total} 处`)
const re = await get(`?sha=HEAD&q=public%5Cs%2Bclass%5Cs%2B%5Cw%2BTest&path=backend/src/jmpt-benchmark&re=1`)
check('正则模式可用', re.body.files?.length > 0, `${re.body.total} 处`)

// 中文路径/内容
const cn = await get(`?sha=HEAD&q=%E5%87%BD%E6%95%B0&path=data/sql/initsql`)
check('中文关键词可搜', cn.body.files?.length > 0, `${cn.body.total} 处`)
check('中文路径未被转义',
  (cn.body.files || []).every((f) => !/\\[0-9]{3}/.test(f.path)),
  cn.body.files?.[0]?.path?.slice(-40))

// 非法 wt
const badWt = await fetch(`http://localhost:7801/api/repos/${ID}/grep?sha=HEAD&q=x&wt=${encodeURIComponent('/nope/x')}`)
check('非法 wt 被拒', badWt.status === 400, `HTTP ${badWt.status}`)

// ============ 页面层 ============
console.log('\n===== 页面 =====')
const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1600,950', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\gp-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })
// 等 Edge 起来：轮询 /json/list 而不是死等固定时间（机器忙时 4s 不够）
let targets = null
for (let i = 0; i < 40; i++) {
  await sleep(400)
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    if (list?.some((t) => t.type === 'page')) { targets = list; break }
  } catch {}
}
if (!targets) {
  console.log('FAIL  Edge 调试端口未就绪')
  process.exit(1)
}
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
await send('Page.navigate', { url: `http://localhost:7801/tree.html?repo=${ID}&sha=HEAD&wt=${encodeURIComponent(REPO)}` })
await sleep(6000)

const init = await ev(`({
  treeTab: document.getElementById('t-tab-tree').classList.contains('active'),
  searchViewHidden: document.getElementById('t-view-search').hidden,
  treeVisible: document.getElementById('t-tree').offsetParent !== null,
  placeholder: document.getElementById('t-filter').placeholder,
  legacyModeBtn: Boolean(document.getElementById('t-mode-content')),
})`)
check('默认在文件树视图', init.value?.treeTab === true, init.value?.placeholder)
check('搜索视图默认隐藏', init.value?.searchViewHidden === true, '')
check('默认显示文件树', init.value?.treeVisible === true, '')
check('旧的「路径/内容」分段按钮已移除', init.value?.legacyModeBtn === false, '')

// 切到搜索视图
await ev(`document.getElementById('t-tab-search').click()`)
await sleep(500)
const modeSwitch = await ev(`({
  searchTab: document.getElementById('t-tab-search').classList.contains('active'),
  searchViewVisible: !document.getElementById('t-view-search').hidden,
  treeViewHidden: document.getElementById('t-view-tree').hidden,
  resultsVisible: document.getElementById('t-grep-results').offsetParent !== null,
  focused: document.activeElement?.id,
  placeholder: document.getElementById('t-grep-input').placeholder,
  hint: document.getElementById('t-grep-results').textContent.trim().slice(0, 20),
})`)
check('切到搜索视图', modeSwitch.value?.searchTab === true, modeSwitch.value?.focused)
check('搜索视图显示（含选项栏）', modeSwitch.value?.searchViewVisible === true, modeSwitch.value?.placeholder)
check('文件树视图被隐藏', modeSwitch.value?.treeViewHidden === true, '')
check('结果区显示且有提示', modeSwitch.value?.resultsVisible === true && /输入关键词/.test(modeSwitch.value?.hint || ''),
  modeSwitch.value?.hint)

// 输入搜索
await ev(`(() => { const i=document.getElementById('t-grep-input'); i.value='AuthorizationHelper'; i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(2200)
const searched = await ev(`({
  files: document.querySelectorAll('.t-grep-file').length,
  hits: document.querySelectorAll('.t-grep-hit').length,
  marks: document.querySelectorAll('.t-grep-hit mark').length,
  stat: document.getElementById('t-grep-stat').textContent,
  treeVisible: document.getElementById('t-tree').offsetParent !== null,
  firstName: document.querySelector('.t-grep-fname')?.textContent,
  firstLine: document.querySelector('.t-grep-ln')?.textContent,
})`)
check('渲染出文件分组', searched.value?.files > 0, `${searched.value?.files} 个文件`)
check('渲染出命中行', searched.value?.hits > 0, `${searched.value?.hits} 处`)
check('关键词被高亮', searched.value?.marks > 0, `${searched.value?.marks} 处标记`)
check('统计信息显示耗时', /ms/.test(searched.value?.stat || ''), searched.value?.stat)
check('搜索时树保持隐藏', searched.value?.treeVisible === false, '')
check('命中行带行号', /^\d+$/.test(searched.value?.firstLine || ''), searched.value?.firstLine)
await shot('tree-grep.png')

// 点击命中行 → 跳转
const clicked = await ev(`(() => {
  const row = document.querySelector('.t-grep-hit')
  const line = row.dataset.line
  const path = row.dataset.path
  row.click()
  return { line, path }
})()`)
await sleep(2600)
const jumped = await ev(`(() => {
  const tr = document.querySelector('.t-code tr.hit-line')
  const body = document.getElementById('t-file-body')
  const br = body.getBoundingClientRect()
  const trr = tr?.getBoundingClientRect()
  return {
    openedPath: document.getElementById('t-file-path').textContent,
    hitLine: tr?.dataset.line,
    visible: trr ? (trr.top >= br.top - 8 && trr.bottom <= br.bottom + 8) : false,
  }
})()`)
check('点击命中打开对应文件', jumped.value?.openedPath === clicked.value?.path,
  jumped.value?.openedPath?.split('/').pop())
check('跳转到命中行', jumped.value?.hitLine === clicked.value?.line,
  `行 ${jumped.value?.hitLine}（期望 ${clicked.value?.line}）`)
check('命中行滚动到可视区', jumped.value?.visible === true, '')
await shot('tree-grep-jump.png')

// 选项：忽略大小写
// 注意：必须用一个大小写敏感的查询词——像 AuthorizationHelper 这种
// 各处写法完全一致的名字，勾不勾忽略大小写结果都一样，测不出问题。
// 实测 backend/src 下 'todo'：敏感 149 处，不敏感 498 处。
await ev(`(() => { const i=document.getElementById('t-grep-input'); i.value='todo'; i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(2400)
const beforeIcase = await ev(`({
  hits: document.querySelectorAll('.t-grep-hit').length,
  stat: document.getElementById('t-grep-stat').textContent,
})`)
await ev(`(() => { const c=document.getElementById('t-grep-icase'); c.checked=true; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(2600)
const icase = await ev(`({
  hits: document.querySelectorAll('.t-grep-hit').length,
  stat: document.getElementById('t-grep-stat').textContent,
})`)
check('切换忽略大小写后重新搜索（命中变多）', icase.value?.hits > beforeIcase.value?.hits,
  `${beforeIcase.value?.hits} → ${icase.value?.hits} 处`)
// 复原
await ev(`(() => { const c=document.getElementById('t-grep-icase'); c.checked=false; c.dispatchEvent(new Event('change',{bubbles:true})) })()`)
await sleep(2200)

// 无命中提示
await ev(`(() => { const i=document.getElementById('t-grep-input'); i.value='ZZZZNOPE999'; i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(2200)
const noHit = await ev(`({
  empty: document.querySelector('.t-grep-empty')?.textContent || '',
  files: document.querySelectorAll('.t-grep-file').length,
  stat: document.getElementById('t-grep-stat').textContent,
})`)
check('无命中显示提示', noHit.value?.files === 0 && /没有匹配/.test(noHit.value?.empty || ''),
  noHit.value?.empty?.slice(0, 30))

// Esc 清空
await ev(`document.getElementById('t-grep-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(500)
const escaped = await ev(`({
  value: document.getElementById('t-grep-input').value,
  hint: document.getElementById('t-grep-results').textContent.trim().slice(0, 12),
})`)
check('Esc 清空并回到提示', escaped.value?.value === '' && /输入关键词/.test(escaped.value?.hint || ''),
  escaped.value?.hint)

// 切回文件树视图
await ev(`document.getElementById('t-tab-tree').click()`)
await sleep(700)
const backPath = await ev(`({
  treeVisible: document.getElementById('t-tree').offsetParent !== null,
  resultsVisible: document.getElementById('t-grep-results').offsetParent !== null,
  searchViewHidden: document.getElementById('t-view-search').hidden,
  dirs: document.querySelectorAll('.t-dir').length,
  placeholder: document.getElementById('t-filter').placeholder,
})`)
check('切回文件树视图恢复树', backPath.value?.treeVisible === true && backPath.value?.dirs > 0,
  `${backPath.value?.dirs} 个目录`)
check('切回后隐藏结果区', backPath.value?.resultsVisible === false, '')
check('切回后隐藏搜索视图（含选项栏）', backPath.value?.searchViewHidden === true, '')

// 路径过滤仍然工作（回归）
await ev(`(() => { const i=document.getElementById('t-filter'); i.value='pom.xml'; i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
await sleep(1200)
const pathFilter = await ev(`({
  files: document.querySelectorAll('.t-file').length,
  first: document.querySelector('.t-file .t-name')?.textContent,
})`)
check('路径过滤未被破坏', pathFilter.value?.files > 0, `${pathFilter.value?.files} 个文件`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
