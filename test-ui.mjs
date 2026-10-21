// 用 CDP 驱动 Edge 做交互验证
import { spawn } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9233

const browser = spawn(EDGE, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000',
  '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-cdp-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(4000)

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

let list = await targets()
const page = list.find((t) => t.type === 'page')
if (!page) { console.error('no page target', list); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg.result ?? msg.error)
  }
})
await new Promise((r) => ws.addEventListener('open', r))

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, { resolve })
    ws.send(JSON.stringify({ id: i, method, params }))
  })

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') }
  return { value: r?.result?.value }
}

async function shot(path) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (!r?.data) return false
  writeFileSync(path, Buffer.from(r.data, 'base64'))
  return true
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?cdp=1' })
await sleep(3500)

const checks = []

// 1. 初始渲染
const repoCount = await evaluate(`document.querySelectorAll('#repo-list .repo').length`)
checks.push(['仓库列表渲染', repoCount.value > 0, `出现了 ${repoCount.value} 个仓库`])

const statText = await evaluate(`document.getElementById('stats').textContent`)
checks.push(['顶栏统计', /仓库/.test(statText.value || ''), statText.value])

// 2. 点击 jm_java
// 注意：页面现在会恢复上次选中的仓库，所以点击可能是「点当前项」——
// 这里不依赖是否发生切换，只要求最终 state.repo 是 jm_java。
const clicked = await evaluate(`(async () => {
  const el = [...document.querySelectorAll('#repo-list .repo')].find(e => e.dataset.toplevel.endsWith('/jm_java'))
  if (!el) return 'not found'
  el.click()
  return 'clicked'
})()`)
await sleep(2200)
checks.push(['点击 jm_java', clicked.value === 'clicked', clicked.value])

const onJmJava = await evaluate(`document.getElementById('main-title').textContent === 'jm_java'`)
checks.push(['当前仓库是 jm_java', onJmJava.value === true, ''])

// worktree 数量随实际使用变化（用户会自己建/删），所以只校验「非空且与选择器一致」
const wtRows = await evaluate(`document.querySelectorAll('#wt-body tr').length`)
checks.push(['worktree 行数', wtRows.value >= 1, `${wtRows.value} 行`])

const branches = await evaluate(`[...document.querySelectorAll('#wt-body tr')].map(tr => tr.children[1]?.textContent.trim())`)
checks.push(['分支列内容', branches.value?.length > 0, JSON.stringify(branches.value)])

const logRows = await evaluate(`document.querySelectorAll('#log-body tr').length`)
checks.push(['日志行数', logRows.value > 0, `${logRows.value} 行`])

// ---- 按 worktree 查看日志 ----
const wtOptions = await evaluate(`[...document.querySelectorAll('#wt-select option')].map(o => o.textContent)`)
checks.push(['worktree 选择器选项数', wtOptions.value?.length === wtRows.value,
  `${wtOptions.value?.length} 项 vs ${wtRows.value} 行`])

const selVal = await evaluate(`document.getElementById('wt-select').value`)
checks.push(['默认选中主工作树', selVal.value?.endsWith('/jm_java'), selVal.value])

const mainFirstSha = await evaluate(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha`)
const mainMeta = await evaluate(`document.getElementById('log-meta').textContent`)
checks.push(['日志 meta 显示 cwd', /jm_java$/.test(mainMeta.value || ''), mainMeta.value])

// 切换到第二个 worktree
const switched = await evaluate(`(() => {
  const sel = document.getElementById('wt-select')
  sel.selectedIndex = 1
  sel.dispatchEvent(new Event('change'))
  return sel.value
})()`)
await sleep(2200)
const wt2FirstSha = await evaluate(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha`)
const wt2Meta = await evaluate(`document.getElementById('log-meta').textContent`)
checks.push(['切换后 cwd 变化', wt2Meta.value !== mainMeta.value, wt2Meta.value])
checks.push(['切换后历史不同', wt2FirstSha.value !== mainFirstSha.value, `${mainFirstSha.value?.slice(0,8)} → ${wt2FirstSha.value?.slice(0,8)}`])

// 双击 worktree 行切换
// 不能固定 rows[2]：worktree 数量随使用变化，环境里只有 2 个时索引越界
// （returns undefined 会让后面的 .replace 抛错）。
const dblClicked = await evaluate(`(() => {
  const rows = document.querySelectorAll('#wt-body tr[data-path]')
  if (!rows.length) return ''
  const target = rows[2] || rows[rows.length - 1]
  target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  return target.dataset.path
})()`)
await sleep(2200)
const dblMeta = await evaluate(`document.getElementById('log-meta').textContent`)
const dblFocus = await evaluate(`document.querySelector('#wt-body tr.wt-focused')?.dataset.path`)
checks.push(['双击行切换日志',
  Boolean(dblClicked.value) && dblMeta.value?.includes(String(dblClicked.value).replace(/^\/home\/[^/]+\//, '~/')),
  dblMeta.value])
checks.push(['切换行高亮', dblFocus.value === dblClicked.value, dblFocus.value?.split('/').pop()])

// 全部分支视图在两个 worktree 下应一致
const allInWt1 = await evaluate(`(async () => {
  const sel = document.getElementById('wt-select'); sel.selectedIndex = 0; sel.dispatchEvent(new Event('change'))
  const rev = document.getElementById('rev-select'); rev.value = '--all'; rev.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 1500))
  return [...document.querySelectorAll('#log-body tr[data-sha]')].slice(0,3).map(t => t.dataset.sha).join(',')
})()`)
const allInWt2 = await evaluate(`(async () => {
  const sel = document.getElementById('wt-select'); sel.selectedIndex = 2; sel.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 1500))
  return [...document.querySelectorAll('#log-body tr[data-sha]')].slice(0,3).map(t => t.dataset.sha).join(',')
})()`)
checks.push(['--all 与 worktree 无关', allInWt1.value === allInWt2.value && !!allInWt1.value, `${allInWt1.value?.slice(0,26)} == ${allInWt2.value?.slice(0,26)}`])

// 回到「当前分支」+ 主工作树，恢复常规视图供截图
await evaluate(`(async () => {
  const rev = document.getElementById('rev-select'); rev.value = 'HEAD'; rev.dispatchEvent(new Event('change'))
  const sel = document.getElementById('wt-select'); sel.selectedIndex = 1; sel.dispatchEvent(new Event('change'))
  await new Promise(r => setTimeout(r, 1500))
})()`)
await sleep(800)

// 3. 截图 worktree 视图
await shot(join(SHOTS, 'wt.png'))

// 4. 点击第一个 commit
const commitClicked = await evaluate(`(() => {
  const tr = document.querySelector('#log-body tr[data-sha]')
  if (!tr) return 'no commit'
  tr.querySelector('.sha').click()
  return tr.dataset.sha
})()`)
await sleep(2500)
checks.push(['点击 commit', /^[0-9a-f]{40}$/.test(commitClicked.value || ''), (commitClicked.value || '').slice(0, 10)])

const fileRows = await evaluate(`document.querySelectorAll('.file-row').length`)
checks.push(['文件清单渲染', fileRows.value > 0, `${fileRows.value} 个文件`])

const patchLines = await evaluate(`document.querySelectorAll('.patch span').length`)
checks.push(['diff 渲染', patchLines.value > 0, `${patchLines.value} 行`])

const detailTitle = await evaluate(`document.getElementById('detail-title').textContent`)
checks.push(['详情标题', detailTitle.value?.length >= 7, detailTitle.value])

await shot(join(SHOTS, 'detail.png'))

// 5. 点击第二个文件，确认 diff 切换
const switchFile = await evaluate(`(() => {
  const rows = document.querySelectorAll('.file-row')
  if (rows.length < 2) return 'only one file'
  rows[1].click()
  return rows[1].dataset.path
})()`)
await sleep(1500)
const activePath = await evaluate(`document.querySelector('.file-row.active')?.dataset.path`)
checks.push(['切换文件', switchFile.value === activePath.value, `${(switchFile.value||'').slice(0,50)}`])
await shot(join(SHOTS, 'file2.png'))

// 6. 过滤日志
const filtered = await evaluate(`(() => {
  const input = document.getElementById('log-filter')
  input.value = 'fix'
  input.dispatchEvent(new Event('input'))
  return document.querySelectorAll('#log-body tr').length
})()`)
checks.push(['日志过滤 fix', filtered.value > 0 && filtered.value < 200, `${filtered.value} 行`])

// 7. 仓库过滤
const repoFiltered = await evaluate(`(() => {
  const input = document.getElementById('repo-search')
  input.value = 'jm_'
  input.dispatchEvent(new Event('input'))
  return document.querySelectorAll('#repo-list .repo').length
})()`)
checks.push(['仓库过滤 jm_', repoFiltered.value > 0, `${repoFiltered.value} 个`])

console.log('\n===== 交互验证 =====')
let pass = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${detail ?? ''}`)
  if (ok) pass++
}
console.log(`\n${pass}/${checks.length} 通过`)

// 收集控制台错误
const errs = await evaluate(`window.__errs || []`)
if (errs.value?.length) console.log('页面错误:', errs.value)

ws.close()
try { browser.kill() } catch {}
process.exit(pass === checks.length ? 0 : 1)
