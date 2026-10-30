// 纯 Linux UI 测试：日志区按分支切换、浏览器记住分支、滚动自动加载、刷新按钮。
//
// 自己造 450 个提交 + 一个 feat worktree，起隔离服务，用系统 Chrome 的 CDP 驱动。
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..')
const CHROME = process.env.CHROME || [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].find((p) => existsSync(p))
if (!CHROME) {
  console.error('找不到 Chrome/Chromium，可用 CHROME=/path/to/chrome 指定')
  process.exit(1)
}

const PORT = Number(process.env.UI_PORT || 7817)
const CDP_PORT = Number(process.env.CDP_PORT || 9238)
const TMP = mkdtempSync(join(tmpdir(), 'wt-ui-log-switch-'))
const CONFIG = join(TMP, 'config.json')
const REPOS = join(TMP, 'repos')
const WT_FEAT = join(TMP, 'wt-feat')
const SHOTS = join(ROOT, 'shots')
mkdirSync(REPOS, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (n, ok, d = '') => {
  checks.push([n, ok, d])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(42)} ${d}`)
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()
}

// 450 个提交：默认一页 200 条，滚动两次才能加载完
const repo = join(REPOS, 'demo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'a.txt'), 'hello\n')
git(repo, ['add', '.'])
git(repo, ['commit', '-qm', 'init'])
for (let i = 1; i <= 449; i++) git(repo, ['commit', '--allow-empty', '-qm', `main c${i}`])
const mainSha = git(repo, ['rev-parse', 'HEAD'])

git(repo, ['branch', 'feat-x'])
git(repo, ['worktree', 'add', '-q', WT_FEAT, 'feat-x'])
git(WT_FEAT, ['commit', '--allow-empty', '-qm', 'feat only'])
const featSha = git(WT_FEAT, ['rev-parse', 'HEAD'])

writeFileSync(CONFIG, JSON.stringify({
  port: PORT,
  host: '127.0.0.1',
  roots: [REPOS],
}, null, 2))

const serverLog = join(TMP, 'server.log')
const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: { ...process.env, WORKTREE_CONFIG: CONFIG },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })

const chromeDir = join(TMP, 'chrome')
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=1440,900',
  `--user-data-dir=${chromeDir}`,
  'about:blank',
], { stdio: 'ignore' })

let ws
let id = 0
const pending = new Map()
let send

async function waitForPage() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(250)
  }
  return null
}

async function ev(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
  return { value: r?.result?.value }
}

async function waitFor(expr, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const r = await ev(`Boolean(${expr})`)
    if (r.value === true) return true
    await sleep(100)
  }
  return false
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
}

const firstLogSha = () => ev(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha`)
const logMeta = () => ev(`document.getElementById('log-meta').textContent`)
const logRows = () => ev(`document.querySelectorAll('#log-body tr[data-sha]').length`)

try {
  let up = false
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/config`)
      if (res.ok) { up = true; break }
    } catch {}
    await sleep(100)
  }
  if (!up) throw new Error(`测试服务未启动：\n${log}`)

  const page = await waitForPage()
  if (!page) throw new Error('Chrome CDP 未就绪')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result ?? m.error)
      pending.delete(m.id)
    }
  })
  send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__errs = [];
      window.addEventListener('error', (e) => window.__errs.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__errs.push(String(e.reason)));`,
  })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(`document.querySelectorAll('#repo-list .repo').length > 0`)
  await waitFor(`document.querySelectorAll('#wt-body tr[data-path]').length >= 2`)
  await waitFor(`document.querySelectorAll('#log-body tr[data-sha]').length > 0`)

  // ---- 1. 入口和默认状态 ----
  const controls = await ev(`({
    more: !!document.getElementById('btn-more'),
    refresh: !!document.getElementById('btn-log-refresh'),
    refreshTitle: document.getElementById('btn-log-refresh')?.title,
    branchLinks: document.querySelectorAll('#wt-body .branch-link').length,
  })`)
  check('旧的「加载更多」按钮已移除', controls.value?.more === false, String(controls.value?.more))
  check('刷新按钮是图标 + tips', controls.value?.refresh === true && controls.value?.refreshTitle === '刷新日志', JSON.stringify(controls.value))
  check('每行分支名都是切换入口', controls.value?.branchLinks === 2, `${controls.value?.branchLinks} 个`)
  check('默认停在主工作树', (await firstLogSha()).value === mainSha, (await firstLogSha()).value)

  // ---- 2. 点击分支名切换 ----
  await ev(`[...document.querySelectorAll('#wt-body .branch-link')].find((b) => b.textContent.trim() === 'feat-x')?.click()`)
  const switched = await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(featSha)}`)
  check('点分支名切到该 worktree 的日志', switched, (await firstLogSha()).value)
  const meta = await logMeta()
  check('日志 cwd 跟着切换', (meta.value || '').includes('wt-feat'), meta.value)
  const focused = await ev(`document.querySelector('#wt-body tr.wt-focused')?.dataset.path`)
  check('切换行出现高亮', focused.value === WT_FEAT, focused.value)

  const stored = await ev(`JSON.parse(localStorage.getItem('wsl-worktree.logWt') || '{}')`)
  const saved = stored.value?.[repo]
  check('当前分支记进浏览器', saved?.branch === 'feat-x', JSON.stringify(saved))

  // 双击不再切换：先切回主工作树，再双击 feat 行，日志应保持主工作树
  await ev(`[...document.querySelectorAll('#wt-body .branch-link')].find((b) => b.textContent.trim() === 'main')?.click()`)
  await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(mainSha)}`)
  await ev(`(() => {
    const tr = [...document.querySelectorAll('#wt-body tr[data-path]')].find((r) => r.dataset.path === ${JSON.stringify(WT_FEAT)})
    tr.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  })()`)
  await sleep(700)
  check('双击行不再切换日志', (await firstLogSha()).value === mainSha, (await firstLogSha()).value)

  // ---- 3. 刷新后恢复记住的分支 ----
  await ev(`[...document.querySelectorAll('#wt-body .branch-link')].find((b) => b.textContent.trim() === 'feat-x')?.click()`)
  await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(featSha)}`)
  await send('Page.reload')
  await waitFor(`document.querySelectorAll('#wt-body tr[data-path]').length >= 2`)
  const restored = await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(featSha)}`)
  check('刷新后恢复上次的分支', restored, (await firstLogSha()).value)
  const restoredMeta = await logMeta()
  check('刷新后日志 cwd 仍是该 worktree', (restoredMeta.value || '').includes('wt-feat'), restoredMeta.value)
  const restoredFocus = await ev(`document.querySelector('#wt-body tr.wt-focused')?.dataset.path`)
  check('刷新后行高亮同步', restoredFocus.value === WT_FEAT, restoredFocus.value)

  // ---- 4. 刷新按钮拉到新提交 ----
  git(WT_FEAT, ['commit', '--allow-empty', '-qm', 'feat after refresh'])
  const featSha2 = git(WT_FEAT, ['rev-parse', 'HEAD'])
  const stale = await firstLogSha()
  check('刷新前日志还是旧 HEAD', stale.value === featSha, stale.value)
  await ev(`document.getElementById('btn-log-refresh').click()`)
  const refreshed = await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(featSha2)}`)
  check('点刷新按钮拉到新提交', refreshed, (await firstLogSha()).value)

  // ---- 5. 滚动到底自动加载 ----
  await ev(`[...document.querySelectorAll('#wt-body .branch-link')].find((b) => b.textContent.trim() === 'main')?.click()`)
  await waitFor(`document.querySelector('#log-body tr[data-sha]')?.dataset.sha === ${JSON.stringify(mainSha)}`)
  check('主工作树先加载第一页', (await logRows()).value === 200, `${(await logRows()).value} 条`)

  const scrollToBottom = () => ev(`(() => {
    const el = document.getElementById('log-scroll')
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })()`)
  await scrollToBottom()
  const page2 = await waitFor(`document.querySelectorAll('#log-body tr[data-sha]').length === 400`)
  check('滚到底自动加载第二页', page2, `${(await logRows()).value} 条`)
  await scrollToBottom()
  const page3 = await waitFor(`document.querySelectorAll('#log-body tr[data-sha]').length === 450`)
  check('继续滚动加载最后一页', page3, `${(await logRows()).value} 条`)

  const errs = await ev(`window.__errs`)
  check('页面无 JS 错误', Array.isArray(errs.value) && errs.value.length === 0, JSON.stringify(errs.value))
  await shot('ui-log-switch-linux.png')
} catch (err) {
  check('UI 流程未抛异常', false, err.message)
} finally {
  try { ws?.close() } catch {}
  chrome.kill('SIGKILL')
  server.kill('SIGTERM')
  await sleep(300)
  rmSync(TMP, { recursive: true, force: true })
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) {
  console.log('失败:')
  for (const [n, , d] of fail) console.log(`  ${n}: ${d}`)
}
process.exit(fail.length ? 1 : 0)
