// 提交对比页：选择两个变更集，用「只含有变更文件的树」展示差异
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', '..', 'shots')
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

// A/B 选择器：每侧自带 ▾，点开是最近提交浮层（不再有全局「最近提交」下拉）
// 放在首次加载后验证：后续测试会连续 Page.navigate，正在进行的 fetch 会被中断
await waitFor(`document.getElementById('c-open-a')`, 15000)

const pickerShape = await ev(`({
  openBtns: document.querySelectorAll('.c-pick-open').length,
  legacySelect: Boolean(document.getElementById('c-recent')),
  // A 和 B 用同一个徽标底色（不再一灰一蓝暗示主次）
  sameTagBg: (() => {
    const t = document.querySelectorAll('.c-pick-tag')
    return t.length === 2 && getComputedStyle(t[0]).backgroundColor === getComputedStyle(t[1]).backgroundColor
  })(),
})`)
check('每侧各有自己的展开按钮', pickerShape.value?.openBtns === 2, `${pickerShape.value?.openBtns} 个`)
check('已移除全局「最近提交」下拉', pickerShape.value?.legacySelect === false, '')
check('A/B 徽标样式一致（无主次暗示）', pickerShape.value?.sameTagBg === true, '')

// 点 A 的 ▾
await ev(`document.getElementById('c-open-a').click()`)
const menuOk = await waitFor(`document.querySelectorAll('.c-menu-item').length > 5`, 15000)
const menu = await ev(`({
  visible: !document.getElementById('c-menu').hidden,
  items: document.querySelectorAll('.c-menu-item').length,
  aActive: document.getElementById('c-pick-a').classList.contains('active'),
  bActive: document.getElementById('c-pick-b').classList.contains('active'),
  focused: document.activeElement?.id,
  hasSubject: (document.querySelector('.c-menu-subject')?.textContent || '').length > 3,
  hasWhen: (document.querySelector('.c-menu-when')?.textContent || '').length > 0,
  // 浮层应贴在 A 的下方
  belowA: (() => {
    const a = document.getElementById('c-pick-a').getBoundingClientRect()
    const m = document.getElementById('c-menu').getBoundingClientRect()
    return m.top >= a.bottom - 2 && Math.abs(m.left - a.left) < 40
  })(),
})`)
check('点 ▾ 打开最近提交浮层', menu.value?.visible === true && menu.value?.items > 5,
  `${menu.value?.items} 个提交${menuOk ? '' : '（等待超时）'}`)
check('浮层锚定在被点的那一侧', menu.value?.belowA === true, '')
check('只有被点的一侧高亮', menu.value?.aActive === true && menu.value?.bActive === false, '')
check('浮层自动聚焦搜索框', menu.value?.focused === 'c-menu-search', menu.value?.focused)
check('每条显示标题与时间', menu.value?.hasSubject === true && menu.value?.hasWhen === true, '')

// ref 标签必须有区分度。
// 同一版本号（5.5.13.11）下面往往挂着好几条不同的 hotfix 分支，
// 如果标签只显示版本号，整个列表看起来就「满屏 v5.5.13.11」，分不清是哪个分支。
// 现在显示的是版本号之后的尾段（hotfix/h-tag-5.5.13.11-主项问题修复1020 → 主项问题修复1020）。
const refInfo = await ev(`(() => {
  const labels = [...document.querySelectorAll('.c-menu-ref')].map(e => e.textContent)
  return {
    labels,
    uniq: [...new Set(labels)].length,
    // 只显示版本号的标签（这种才有重复风险）
    versionOnly: labels.filter(t => /^v?\\d+\\.\\d+\\.\\d+(\\.\\d+)?$/.test(t)).length,
    hasTail: labels.some(t => /[\\u4e00-\\u9fa5]/.test(t)),
  }
})()`)
check('ref 标签有区分度（不重复）',
  (refInfo.value?.labels?.length || 0) > 0 &&
  refInfo.value.uniq >= Math.ceil(refInfo.value.labels.length * 0.8),
  `${refInfo.value?.labels?.length} 个标签 / ${refInfo.value?.uniq} 个不同`)
check('分支标签显示尾段而非纯版本号',
  refInfo.value?.hasTail === true &&
  refInfo.value.versionOnly < refInfo.value.labels.length,
  `纯版本号 ${refInfo.value?.versionOnly}/${refInfo.value?.labels?.length}`)

// 搜索过滤：用一个足够精确的词，命中数一定远小于默认的 100 条上限
// （用 'fix' 这种常见词会命中上百条，被 slice(0,100) 截断，反而看不出过滤生效）
await ev(`(()=>{const i=document.getElementById('c-menu-search');i.value='bug=1383107';i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(450)
const searched = await ev(`({
  items: document.querySelectorAll('.c-menu-item').length,
  subjects: [...document.querySelectorAll('.c-menu-subject')].slice(0,3).map(e=>e.textContent.toLowerCase()),
})`)
check('浮层内搜索按标题过滤', searched.value?.items > 0 && searched.value?.items < 10,
  `命中 ${searched.value?.items} 条`)

// ---------- 按 tag / 分支搜索 ----------
// 只搜最近 50 条的话，老 tag 指向的提交根本不在列表里（v5.5.10.55 是几个月前的）。
// 现在数据源是「最近提交 + 全部 ref 尖端」，并且搜索会匹配 ref 名。
const refLog = await (await fetch(`${API}/ref-log`)).json()
const allRefs = (refLog.commits || []).flatMap((c) => c.refs || [])
const someTag = allRefs.find((r) => /^tag:\s*v?\d/.test(r))?.replace(/^tag:\s*/, '')
const someBranch = allRefs.find((r) => !/^tag:/.test(r) && r.includes('/') && !r.endsWith('/HEAD'))

const searchKw = async (kw) => {
  await ev(`(()=>{const i=document.getElementById('c-menu-search');i.value=${JSON.stringify(kw)};i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  await sleep(450)
  return ev(`({
    count: document.querySelectorAll('.c-menu-item').length,
    firstSha: document.querySelector('.c-menu-item')?.dataset.sha?.slice(0, 8),
    empty: document.querySelector('.c-menu-empty')?.textContent.replace(/\\s+/g, ' ').trim() || '',
  })`)
}

check('数据源包含全部 ref 尖端（不只是最近 50 条）',
  (refLog.commits || []).length > 100,
  `${refLog.commits?.length} 条`)

if (someTag) {
  const byTag = await searchKw(someTag)
  check('能按 tag 搜索', byTag.value?.count > 0,
    `搜「${someTag}」→ ${byTag.value?.count} 条`)
} else {
  console.log('       (仓库里没有 tag，跳过 tag 搜索断言)')
}

if (someBranch) {
  // 用分支名的最后一段（去掉 origin/ 前缀），更贴近用户会输入的片段
  const frag = someBranch.replace(/^origin\//, '').split('/').pop()
  const byBranch = await searchKw(frag)
  check('能按分支名搜索', byBranch.value?.count > 0,
    `搜「${frag}」→ ${byBranch.value?.count} 条`)
} else {
  console.log('       (仓库里没有分支，跳过分支搜索断言)')
}

// 搜不到时给出「按 Enter 直接当版本用」的出路
const noHit = await searchKw('zzz-不存在的关键词-zzz')
check('搜不到时提示可按 Enter 直接用',
  noHit.value?.count === 0 && /按 Enter/.test(noHit.value?.empty || ''),
  noHit.value?.empty?.slice(0, 46))

// Enter 把输入当 rev：HEAD~3 不在索引里，但后端能解析
// 先在搜索框里输入 HEAD~3（此时无匹配），再按 Enter
await ev(`(()=>{const i=document.getElementById('c-menu-search');i.value='HEAD~3';i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(450)
await ev(`document.getElementById('c-menu-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))`)
await waitFor(`document.getElementById('c-menu').hidden`, 20000)
await sleep(1500)
const rawRev = await ev(`({
  aVal: document.getElementById('c-a').value,
  menuHidden: document.getElementById('c-menu').hidden,
  stat: document.getElementById('c-stat').textContent,
})`)
check('无匹配时 Enter 把输入当版本使用',
  rawRev.value?.menuHidden === true && /^[0-9a-f]{6,}$/.test(rawRev.value?.aVal || ''),
  `A = ${rawRev.value?.aVal}`)

// 恢复 A 再继续后面的断言
await ev(`(()=>{const el=document.getElementById('c-a');el.value=${JSON.stringify(A)};el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
await waitFor(`document.getElementById('c-stat').textContent.includes('文件')`, 25000)
await sleep(600)
await ev(`document.getElementById('c-open-a').click()`)
await waitFor(`document.querySelectorAll('.c-menu-item').length > 5`, 15000)
await sleep(400)

// 清空搜索，回到完整 50 条 —— 滚动相关的断言必须在「列表够长」时做
await ev(`(()=>{const i=document.getElementById('c-menu-search');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}))})()`)
await sleep(350)
const fullCount = await ev(`document.querySelectorAll('.c-menu-item').length`)
check('清空搜索恢复完整列表', fullCount.value === menu.value?.items,
  `${searched.value?.items} → ${fullCount.value}`)

// 列表要能滚，而且「滚列表」不能把浮层关掉。
// 曾经有 bug：window 的 scroll 监听用 capture 收所有滚动容器的事件，
// 连浮层列表自己的滚动也算成「页面滚动」→ 一滚就关，表现成「滚轮没反应」。
const scrollable = await ev(`(() => {
  const el = document.getElementById('c-menu-list')
  return { can: el.scrollHeight > el.clientHeight + 4, h: el.scrollHeight, c: el.clientHeight }
})()`)
check('浮层列表内容超出可视区（可滚动）', scrollable.value?.can === true,
  `${scrollable.value?.c}/${scrollable.value?.h}px`)

await ev(`document.getElementById('c-menu-list').scrollTop = 240`)
await sleep(450)
const afterScroll = await ev(`({
  top: document.getElementById('c-menu-list').scrollTop,
  visible: !document.getElementById('c-menu').hidden,
})`)
check('列表内滚动不关闭浮层', afterScroll.value?.top > 0 && afterScroll.value?.visible === true,
  `scrollTop=${afterScroll.value?.top}`)
await ev(`document.getElementById('c-menu-list').scrollTop = 0`)
await sleep(200)

// 点第二条：应填入 A 并重新对比
const pickedSha = await ev(`(()=>{const it=document.querySelectorAll('.c-menu-item')[1]; if(!it) return null; const s=it.dataset.sha; it.click(); return s})()`)
await waitFor(`document.getElementById('c-a').value === ${JSON.stringify((pickedSha.value || '').slice(0, 8))}`, 25000)
await sleep(800)
const afterPick = await ev(`({
  aVal: document.getElementById('c-a').value,
  menuHidden: document.getElementById('c-menu').hidden,
  aActive: document.getElementById('c-pick-a').classList.contains('active'),
})`)
check('点选后填入 A 并关闭浮层',
  afterPick.value?.aVal === (pickedSha.value || '').slice(0, 8) && afterPick.value?.menuHidden === true,
  `${pickedSha.value?.slice(0, 8)} → A`)
check('选中后取消高亮', afterPick.value?.aActive === false, '')

// 点外部关闭
await ev(`document.getElementById('c-open-b').click()`)
await sleep(500)
await ev(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
await sleep(300)
check('点别处关闭浮层', (await ev(`document.getElementById('c-menu').hidden`)).value === true, '')

// Esc 关闭
await ev(`document.getElementById('c-open-a').click()`)
await sleep(400)
await ev(`document.getElementById('c-menu-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`)
await sleep(300)
check('Esc 关闭浮层', (await ev(`document.getElementById('c-menu').hidden`)).value === true, '')

// 页面滚动仍应关闭浮层：锚点跟着滚会错位，与其错着不如关掉
await ev(`document.getElementById('c-open-a').click()`)
await sleep(500)
await ev(`document.querySelector('.t-tree-wrap').scrollTop = 150`)
await sleep(400)
check('页面滚动关闭浮层（避免错位）',
  (await ev(`document.getElementById('c-menu').hidden`)).value === true, '')
await ev(`document.querySelector('.t-tree-wrap').scrollTop = 0`)
await sleep(200)

// 恢复成初始的 A（后续断言依赖初始对比结果）
await ev(`(()=>{const el=document.getElementById('c-a');el.value=${JSON.stringify(A)};el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))})()`)
await waitFor(`document.getElementById('c-stat').textContent.includes('文件')`, 25000)
await sleep(600)

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
