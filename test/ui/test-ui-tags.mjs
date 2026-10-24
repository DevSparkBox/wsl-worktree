// 文件树顶栏的 tag 徽章：接口 + 页面
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', '..', 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9611
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const REPO = '/home/wangy/codes/jm_java'
const ID = enc(REPO)

// 事先查好的样本（见测试准备时的 git 命令）
const SHA_NO_TAG = '7fc0607'                       // 截图里那个，无 tag
const SHA_TWO_TAGS = 'cf4574905abd37ba915b9018f2041bba9b195243'  // 0.1.0.7-BETA / 0.1.0.8-BETA
const SHA_ANNOTATED = 'fbf0ae4b'                   // 0.1.0.1-BETA里程碑版本（annotated）

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const get = async (sha) => {
  const r = await fetch(`http://localhost:7801/api/repos/${ID}/refs-at?sha=${encodeURIComponent(sha)}&wt=${encodeURIComponent(REPO)}`)
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

// ============ 接口层 ============
console.log('===== 接口 =====')
let r = await get('HEAD')
check('HEAD 有 tag', r.body.tags?.length > 0, JSON.stringify(r.body.tags))
check('返回完整 sha', /^[0-9a-f]{40}$/.test(r.body.sha || ''), r.body.sha?.slice(0, 8))

r = await get(SHA_NO_TAG)
check('无 tag 的 commit 返回空数组', r.body.tags?.length === 0, `${r.body.tags?.length} 个`)

r = await get(SHA_TWO_TAGS)
check('多 tag commit 返回全部', r.body.tags?.length === 2,
  (r.body.tags || []).map((t) => t.name).join(', '))
check('tag 按名字排序', r.body.tags?.[0]?.name === '0.1.0.7-BETA', r.body.tags?.[0]?.name)

r = await get(SHA_ANNOTATED)
check('annotated tag 被识别', r.body.tags?.[0]?.annotated === true,
  `${r.body.tags?.[0]?.name} annotated=${r.body.tags?.[0]?.annotated}`)

// 轻量 tag 不应被标成 annotated
r = await get('HEAD')
check('轻量 tag 不标 annotated', r.body.tags?.[0]?.annotated === false,
  `${r.body.tags?.[0]?.name} annotated=${r.body.tags?.[0]?.annotated}`)

// 分支信息：字段必须始终是数组。
// 注意不能断言「>=1 个分支」——主工作树处于 detached 时，HEAD 上本来就没有分支指向，
// 那是环境的正常状态而不是接口出错。
r = await get('HEAD')
check('branches 字段是数组', Array.isArray(r.body.branches), `${r.body.branches?.length} 个`)
if (r.body.branches?.length) {
  check('分支项含 name', typeof r.body.branches[0].name === 'string', r.body.branches[0].name)
}

// 不存在的 commit
r = await get('deadbeefdeadbeef')
check('不存在的 commit 返回 404', r.status === 404, `HTTP ${r.status}`)
check('404 带可读错误', Boolean(r.body.error), r.body.error)

// 非法 wt
const badWt = await fetch(`http://localhost:7801/api/repos/${ID}/refs-at?sha=HEAD&wt=${encodeURIComponent('/nope/x')}`)
check('非法 wt 被拒', badWt.status === 400, `HTTP ${badWt.status}`)

// 短 sha 也能用（前端可能传 7 位）
r = await get(SHA_NO_TAG.slice(0, 7))
check('短 sha 可用', r.status === 200 && /^[0-9a-f]{40}$/.test(r.body.sha || ''),
  r.body.sha?.slice(0, 8))

// ============ 页面层 ============
console.log('\n===== 页面 =====')
const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,900', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\tg-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

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
const open = async (sha) => {
  await send('Page.navigate', {
    url: `http://localhost:7801/tree.html?repo=${ID}&sha=${encodeURIComponent(sha)}&wt=${encodeURIComponent(REPO)}`,
  })
  await sleep(5200)
}

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false })

// 有 tag 的 commit
await open('HEAD')
const withTag = await ev(`({
  commit: document.getElementById('t-commit').textContent,
  hidden: document.getElementById('t-tags').hidden,
  tags: [...document.querySelectorAll('.t-tag')].map(e => e.textContent),
  title: document.querySelector('.t-tag')?.title || '',
  // 位置：应该在 commit 之后、spacer 之前
  afterCommit: (() => {
    const c = document.getElementById('t-commit').getBoundingClientRect()
    const t = document.getElementById('t-tags').getBoundingClientRect()
    return t.left > c.left
  })(),
  color: (() => {
    const el = document.querySelector('.t-tag')
    return el ? getComputedStyle(el).color : null
  })(),
})`)
check('有 tag 时显示徽章', withTag.value?.hidden === false && withTag.value?.tags?.length > 0,
  withTag.value?.tags?.join(', '))
check('徽章显示完整 tag 名', /^v?\d/.test(withTag.value?.tags?.[0] || ''), withTag.value?.tags?.[0])
check('位于 commit 之后', withTag.value?.afterCommit === true, '')
check('hover 有说明（区分 annotated/轻量）', /tag/.test(withTag.value?.title || ''), withTag.value?.title?.slice(0, 30))
check('徽章有独立配色', withTag.value?.color && withTag.value?.color !== 'rgb(31, 35, 40)',
  withTag.value?.color)
await shot('t-tags-with.png')

// 无 tag 的 commit（截图里那个）
await open(SHA_NO_TAG)
const noTag = await ev(`({
  commit: document.getElementById('t-commit').textContent,
  hidden: document.getElementById('t-tags').hidden,
  count: document.querySelectorAll('.t-tag').length,
  // 确认没有占位空隙
  width: Math.round(document.getElementById('t-tags').getBoundingClientRect().width),
})`)
check('无 tag 时隐藏徽章区', noTag.value?.hidden === true && noTag.value?.count === 0, '')
check('无 tag 时不占宽度', noTag.value?.width === 0, `${noTag.value?.width}px`)
await shot('t-tags-none.png')

// 多 tag
await open(SHA_TWO_TAGS)
const twoTags = await ev(`({
  tags: [...document.querySelectorAll('.t-tag')].map(e => e.textContent),
  more: document.querySelector('.t-tag-more')?.textContent || null,
})`)
check('多 tag 全部显示（≤3 个时不折叠）', twoTags.value?.tags?.length === 2,
  twoTags.value?.tags?.join(', '))
check('两个 tag 都可见', (twoTags.value?.tags || []).every((t) => /BETA/.test(t)), '')

// annotated tag 用不同样式
await open(SHA_ANNOTATED)
const ann = await ev(`({
  tags: [...document.querySelectorAll('.t-tag')].map(e => e.textContent),
  annCount: document.querySelectorAll('.t-tag-ann').length,
  annBg: (() => {
    const el = document.querySelector('.t-tag-ann')
    return el ? getComputedStyle(el).backgroundColor : null
  })(),
  plainTags: document.querySelectorAll('.t-tag:not(.t-tag-ann):not(.t-tag-more)').length,
})`)
check('annotated tag 有专属样式', ann.value?.annCount === 1,
  `${ann.value?.tags?.[0]}（实色背景 ${ann.value?.annBg}）`)
check('annotated 有背景色（与轻量 tag 区分）',
  ann.value?.annBg && ann.value?.annBg !== 'rgba(0, 0, 0, 0)', ann.value?.annBg)

// tag 显示不影响其他内容
const others = await ev(`({
  treeLoaded: document.querySelectorAll('.t-dir').length > 0,
  statShown: /个文件/.test(document.getElementById('t-stat').textContent),
  codeShown: document.querySelectorAll('.t-code tr').length > 0,
})`)
check('树正常加载', others.value?.treeLoaded === true, '')
check('文件数统计正常', others.value?.statShown === true, '')
check('文件内容正常显示', others.value?.codeShown === true, '')

// 切换文件不影响 tag
await ev(`(() => { const f=[...document.querySelectorAll('.t-file')][2]; f && f.click() })()`)
await sleep(1800)
const afterSwitch = await ev(`({
  tags: [...document.querySelectorAll('.t-tag')].map(e => e.textContent),
  path: document.getElementById('t-file-path').textContent,
})`)
check('切换文件后 tag 仍在', afterSwitch.value?.tags?.length > 0, `${afterSwitch.value?.tags?.join(', ')}`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

ws.close(); try { browser.kill() } catch {}
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
