// 新增能力的 UI 交互测试（CDP 驱动 Edge）
// 只做只读操作 + 在临时仓库上做写操作，绝不碰真实仓库
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9244
const ROOT = '/tmp/wt-ui-test'

// ---------- 造临时仓库 ----------
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

const WSL = (cmd) => execFileSync('wsl.exe', ['-d', 'archlinux', '-e', 'bash', '-lc', cmd], { encoding: 'utf8' })
WSL(`rm -rf ${ROOT} && mkdir -p ${ROOT} && git init -q -b main ${ROOT}/repo && cd ${ROOT}/repo && echo a>a.txt && git add . && git -c user.email=t@t -c user.name=t commit -qm root && git branch feat-a && git branch feat-b && git worktree add -q ${ROOT}/repo-feat-a feat-a && git worktree add -q ${ROOT}/repo-feat-b feat-b`)

// 让测试仓库出现在扫描根里：改 config 不现实，直接用已存在的方式 —— 通过 URL 打开
// 该仓库不在 ~/codes 下，所以直接在浏览器里用接口测试 + 真仓库的只读 UI 测试

const browser = spawn(EDGE, [
  '--headless', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${PORT}`,
  '--window-size=1600,1000',
  '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-cdp-' + Date.now(),
  'about:blank',
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(4000)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return { value: r?.result?.value }
}
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?ops=1' })
await sleep(4000)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 收集页面异常
await evaluate(`window.__errs = []; window.addEventListener('error', e => window.__errs.push(String(e.message)))`)

// ---------- 选中一个有多 worktree 的仓库 ----------
await evaluate(`(() => {
  const el = [...document.querySelectorAll('#repo-list .repo')].find(e => e.dataset.toplevel.endsWith('/jm_java'))
  el && el.click()
})()`)
await sleep(2500)

const btns = await evaluate(`['btn-compare','btn-fetch','btn-new-wt','btn-stale'].map(i => { const b = document.getElementById(i); return b ? b.textContent.trim() : null })`)
check('工具栏四个按钮存在', btns.value?.every(Boolean), JSON.stringify(btns.value))

// 「对比」入口：点开应打开 compare.html，且带上 repo 与 a/b
const cmpOpen = await evaluate(`(() => {
  const seen = []
  const orig = window.open
  window.open = (u) => { seen.push(u); return null }
  document.getElementById('btn-compare').click()
  window.open = orig
  return seen[0] || null
})()`)
check('对比按钮打开 compare 页',
  /\/compare\.html\?repo=/.test(cmpOpen.value || '') && /[?&]a=/.test(cmpOpen.value || '') && /[?&]b=/.test(cmpOpen.value || ''),
  cmpOpen.value?.replace(/^.*compare/, 'compare').slice(0, 60))

const rowActs = await evaluate(`[...document.querySelectorAll('#wt-body tr:first-child .icon-btn')].map(b => b.textContent.trim() + (b.disabled ? '(禁)' : ''))`)
check('行操作含 切换/拉取/删除', ['切换', '拉取', '删除'].every((k) => rowActs.value?.some((x) => x.startsWith(k))), JSON.stringify(rowActs.value))

const mainRemoveDisabled = await evaluate(`document.querySelector('#wt-body tr:first-child .icon-btn[data-act=remove]')?.disabled`)
check('主工作树删除按钮禁用', mainRemoveDisabled.value === true, String(mainRemoveDisabled.value))

await shot('ops-toolbar.png')

// ---------- 切换分支对话框 ----------
// 优先选一个「在分支上」的 worktree：detached 的没有当前分支，无法验证 is-head。
await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#wt-body tr')]
  const pick = rows.find((tr) => !/detached/i.test(tr.textContent))
    || rows[1] || rows[0]
  pick?.querySelector('.icon-btn[data-act=checkout]')?.click()
})()`)
await sleep(2000)
const coTitle = await evaluate(`document.getElementById('modal-title').textContent`)
const coRows = await evaluate(`document.querySelectorAll('.branch-row').length`)
const coBusy = await evaluate(`document.querySelectorAll('.branch-row.busy').length`)
const coHead = await evaluate(`document.querySelectorAll('.branch-row.is-head').length`)
check('切换分支对话框打开', /切换分支/.test(coTitle.value || ''), coTitle.value)
check('分支列表已加载', coRows.value > 0, `${coRows.value} 个分支`)
// 「占用」只会在「分支被别的 worktree 检出」时出现。环境里只剩一个分支 worktree 时
// 本来就没有占用项，所以这里不硬性要求 >0，而是校验「busy 行与 locked 标记一一对应」。
const busyLocked = await evaluate(`document.querySelectorAll('.branch-row.busy .pill.locked').length`)
check('占用行带 locked 标记', coBusy.value === busyLocked.value,
  `busy=${coBusy.value} locked=${busyLocked.value}`)
// detached 的 worktree 没有「当前分支」，此时 is-head 为 0 才是对的
if (/detached/i.test(coTitle.value || '')) {
  check('detached 工作树无当前分支标记（符合预期）', coHead.value === 0, `${coHead.value} 个 is-head`)
} else {
  check('当前分支被标记', coHead.value >= 1, `${coHead.value} 个 is-head`)
}
await shot('ops-checkout.png')

// 搜索过滤
const coFiltered = await evaluate(`(() => {
  const i = document.getElementById('co-filter')
  i.value = 'hotfix'
  i.dispatchEvent(new Event('input'))
  return document.querySelectorAll('.branch-row').length
})()`)
check('分支搜索生效', coFiltered.value < coRows.value && coFiltered.value > 0, `${coRows.value} → ${coFiltered.value}`)
await evaluate(`document.getElementById('modal-close').click()`)
await sleep(400)

// ---------- 拉取对话框 ----------
await evaluate(`(() => {
  const b = document.querySelectorAll('#wt-body tr')[1].querySelector('.icon-btn[data-act=pull]')
  if (b && !b.disabled) { b.click(); return 'clicked' }
  return 'disabled'
})()`)
await sleep(1500)
const pullTitle = await evaluate(`document.getElementById('modal-title').textContent`)
const pullModes = await evaluate(`[...document.querySelectorAll('#pull-mode button')].map(b => b.textContent.trim())`)
check('拉取对话框打开', /更新分支/.test(pullTitle.value || ''), pullTitle.value)
check('有两种合并方式', pullModes.value?.length === 2, JSON.stringify(pullModes.value))
const hintBefore = await evaluate(`document.getElementById('pull-hint')?.textContent`)
await evaluate(`document.querySelector('#pull-mode button[data-v=rebase]').click()`)
const hintAfter = await evaluate(`document.getElementById('pull-hint')?.textContent`)
check('切换方式时提示联动', hintBefore.value !== hintAfter.value, hintAfter.value?.slice(0, 30))
await shot('ops-pull.png')
await evaluate(`document.getElementById('modal-close').click()`)
await sleep(400)

// ---------- 新建 worktree 对话框 ----------
const repoParent = await evaluate(`document.getElementById('main-meta').textContent.replace(/\\/[^/]+$/, '')`)
await evaluate(`document.getElementById('btn-new-wt').click()`)
await sleep(1200)
const nwTitle = await evaluate(`document.getElementById('modal-title').textContent`)
check('新建对话框打开', /新建 worktree/.test(nwTitle.value || ''), nwTitle.value)

const nwModes = await evaluate(`[...document.querySelectorAll('#nw-mode button')].map(b => b.textContent.trim())`)
check('五种创建方式（含基于 tag）', nwModes.value?.length === 5 && nwModes.value.includes('基于 tag'), JSON.stringify(nwModes.value))

// 输入分支名，路径应自动生成
const autoPath = await evaluate(`(() => {
  const i = document.getElementById('nw-branch')
  i.value = 'feature/test-xyz'
  i.dispatchEvent(new Event('input'))
  return document.getElementById('nw-path').value
})()`)
check('路径按分支自动生成', autoPath.value?.endsWith('jm_java-feature-test-xyz'), autoPath.value)

// 切到 detach 模式，起点输入框应显示
const baseHiddenInNew = await evaluate(`document.getElementById('nw-base-field').hidden`)
await evaluate(`document.querySelector('#nw-mode button[data-v=detach]').click()`)
const baseHiddenInDetach = await evaluate(`document.getElementById('nw-base-field').hidden`)
check('detach 模式显示起点', baseHiddenInDetach.value === false, `new:${baseHiddenInNew.value} detach:${baseHiddenInDetach.value}`)

await evaluate(`document.querySelector('#nw-mode button[data-v=new]').click()`)
await shot('ops-new-wt.png')
await evaluate(`document.getElementById('modal-close').click()`)
await sleep(400)

// ---------- 删除对话框（预检） ----------
await evaluate(`(() => {
  const rows = document.querySelectorAll('#wt-body tr')
  for (const tr of rows) {
    const b = tr.querySelector('.icon-btn[data-act=remove]')
    if (b && !b.disabled) { b.click(); return }
  }
})()`)
await sleep(2500)
const rmTitle = await evaluate(`document.getElementById('modal-title').textContent`)
const rmNote = await evaluate(`document.querySelector('#modal-body .note')?.textContent`)
const rmHasKv = await evaluate(`!!document.querySelector('#modal-body .kv')`)
const rmDangerBtn = await evaluate(`document.querySelector('#modal-foot .btn.danger')?.textContent`)
check('删除对话框打开', /删除 worktree/.test(rmTitle.value || ''), rmTitle.value)
check('显示风险说明', (rmNote.value || '').length > 8, (rmNote.value || '').slice(0, 46))
check('显示 worktree 元信息', rmHasKv.value === true, '')
check('有删除按钮', rmDangerBtn.value === '删除', rmDangerBtn.value)
await shot('ops-remove.png')
await evaluate(`document.getElementById('modal-close').click()`)
await sleep(400)

// ---------- 陈旧清理对话框 ----------
await evaluate(`document.getElementById('btn-stale').click()`)
await sleep(3000)
const stTitle = await evaluate(`document.getElementById('modal-title').textContent`)
check('清理对话框打开', /清理陈旧 worktree/.test(stTitle.value || ''), stTitle.value)

const stShape = await evaluate(`({
  hasTable: !!document.querySelector('.stale-tbl'),
  hasAll: !!document.getElementById('stale-all'),
  hasDays: !!document.getElementById('stale-days'),
  rows: document.querySelectorAll('.stale-tbl tbody tr').length,
  noteText: (document.querySelector('#modal-body .note')?.textContent || '').slice(0, 60),
})`)
// 没有陈旧项时对话框只显示空状态（不渲染表格和过滤控件），这是合理的产品行为，
// 所以按「有候选 / 无候选」两种情况分别校验，而不是硬性要求表格结构。
if (stShape.value?.rows === 0) {
  check('无陈旧项时显示空状态', /没有可清理/.test(stShape.value?.noteText || ''),
    stShape.value?.noteText)
} else {
  check('清理对话框结构完整', stShape.value?.hasAll && stShape.value?.hasDays,
    JSON.stringify(stShape.value?.noteText))
}
console.log(`     候选行数: ${stShape.value?.rows}`)
await shot('ops-stale.png')

// 全选/取消
if (stShape.value?.rows > 0) {
  const selState = await evaluate(`(() => {
    const all = document.getElementById('stale-all')
    all.checked = true
    all.dispatchEvent(new Event('change'))
    return {
      picked: document.querySelectorAll('.stale-tbl tbody tr.pick').length,
      btn: document.querySelector('#modal-foot .btn.danger')?.textContent,
    }
  })()`)
  check('全选生效', selState.value?.picked === stShape.value.rows, `picked=${selState.value?.picked}/${stShape.value.rows}`)
  check('按钮显示数量', /删除 \d+ 个/.test(selState.value?.btn || ''), selState.value?.btn)

  const cleared = await evaluate(`(() => {
    const all = document.getElementById('stale-all')
    all.checked = false
    all.dispatchEvent(new Event('change'))
    return document.querySelectorAll('.stale-tbl tbody tr.pick').length
  })()`)
  check('取消全选生效', cleared.value === 0, `${cleared.value} 个仍选中`)
}
await evaluate(`document.getElementById('modal-close').click()`)
await sleep(400)

// ---------- 页面无 JS 错误 ----------
const errs = await evaluate(`window.__errs || []`)
check('无页面 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
ws.close()
try { browser.kill() } catch {}
WSL(`rm -rf ${ROOT}`)
process.exit(fail.length ? 1 : 0)
