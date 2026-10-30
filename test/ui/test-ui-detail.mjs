// 详情面板：message、父提交、点文件行展开 diff、全部展开逐个加载。
// 隔离服务 + 系统 Chrome CDP，不依赖本机真实仓库。
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
const TMP = mkdtempSync(join(tmpdir(), 'wt-ui-detail-'))
const CONFIG = join(TMP, 'config.json')
const REPOS = join(TMP, 'repos')
const SHOTS = join(ROOT, 'shots')
mkdirSync(REPOS, { recursive: true })
mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const checks = []
const check = (n, ok, d = '') => {
  checks.push([n, ok, d])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(40)} ${d}`)
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

const repo = join(REPOS, 'demo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'a.txt'), 'one\n')
writeFileSync(join(repo, 'b.txt'), 'two\n')
for (let i = 0; i < 30; i++) writeFileSync(join(repo, `f${String(i).padStart(2, '0')}.txt`), `line ${i}\n`)
git(repo, ['add', '.'])
git(repo, ['commit', '-qm', 'init'])
writeFileSync(join(repo, 'a.txt'), 'one\nchanged\n')
writeFileSync(join(repo, 'b.txt'), 'two\nchanged\n')
for (let i = 0; i < 30; i++) writeFileSync(join(repo, `f${String(i).padStart(2, '0')}.txt`), `line ${i}\nchanged\n`)
git(repo, ['add', '.'])
git(repo, ['commit', '-qm', 'feat: 改两个文件\n\n正文第一行\n正文第二行'])


writeFileSync(CONFIG, JSON.stringify({
  port: PORT,
  host: '127.0.0.1',
  roots: [REPOS],
}, null, 2))

const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
  env: { ...process.env, WORKTREE_CONFIG: CONFIG },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
server.stdout.on('data', (d) => { log += d })
server.stderr.on('data', (d) => { log += d })

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
  `--remote-debugging-port=${CDP_PORT}`,
  '--window-size=1440,900',
  `--user-data-dir=${join(TMP, 'chrome')}`,
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

async function waitFor(expr, timeout = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const r = await ev(`Boolean((${expr}))`)
    if (r.value === true) return true
    await sleep(100)
  }
  return false
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  if (r?.data) writeFileSync(join(SHOTS, name), Buffer.from(r.data, 'base64'))
}

try {
  let up = false
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/config`)).ok) { up = true; break }
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

  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(`document.querySelectorAll('#repo-list .repo').length > 0`)
  const picked = await ev(`(() => {
    const rows = [...document.querySelectorAll('#repo-list .repo')]
    const el = rows.find(e => e.dataset.toplevel.endsWith('/demo'))
    el?.click()
    return { n: rows.length, paths: rows.map(e => e.dataset.toplevel) }
  })()`)
  check('选中测试仓库', (picked.value?.paths || []).some((p) => p === repo),
    `page=${JSON.stringify(picked.value)} repo=${repo}`)
  if (!await waitFor(`[...document.querySelectorAll('#log-body tr[data-sha]')].some(el => el.textContent.includes('feat:'))`, 8000)) {
    const why = await ev(`document.getElementById('log-body')?.textContent?.slice(0, 160) || document.body.textContent.slice(0, 160)`)
    const more = await ev(`({
      repos: document.querySelectorAll('#repo-list .repo').length,
      active: document.querySelector('#repo-list .repo.active')?.dataset.toplevel || '',
      log: document.getElementById('log-empty')?.textContent || '',
      errs: window.__errs,
    })`)
    throw new Error(`日志没有出来：${JSON.stringify(why.value)} ${JSON.stringify(more.value)}`)
  }

  const clicked = await ev(`new Promise((resolve) => {
    const start = Date.now()
    const tick = () => {
      const all = [...document.querySelectorAll('#log-body tr[data-sha]')]
      const tr = all.find(el => el.textContent.includes('feat:'))
      if (tr) {
        tr.querySelector('.sha')?.click()
        resolve({ sha: tr.dataset.sha, n: all.length, text: tr.textContent.slice(0, 40) })
        return
      }
      if (Date.now() - start > 8000) resolve({ sha: '', n: all.length, rows: all.map(el => el.dataset.sha.slice(0, 8)).join(',') })
      else setTimeout(tick, 100)
    }
    tick()
  })`)
  check('点到了目标提交', /^[0-9a-f]{40}$/.test(clicked.value?.sha || ''), JSON.stringify(clicked))
  const shown = await waitFor(`document.querySelector('#detail-body .file-row')`, 8000)
  if (!shown) {
    const why = await ev(`({
      body: document.getElementById('detail-body').textContent.slice(0, 120),
      rows: document.querySelectorAll('#log-body tr[data-sha]').length,
      errs: window.__errs,
    })`)
    check('详情渲染出来', false, `clicked=${JSON.stringify(clicked.value)} ${JSON.stringify(why.value)}`)
  }

  const order = await ev(`(() => {
    const body = document.getElementById('detail-body')
    return [...body.children].map(e => e.className.split(' ')[0])
  })()`)
  check('顺序是 message、父提交、改动文件',
    order.value?.[0] === 'detail-msg' && order.value?.[1] === 'detail-parents' && order.value?.[2] === 'detail-sec-title',
    JSON.stringify(order.value?.slice(0, 4)))

  const msg = await ev(`({
    subject: document.querySelector('.detail-subject')?.textContent,
    body: document.querySelector('.detail-body-text')?.textContent,
  })`)
  check('显示标题和正文', msg.value?.subject === 'feat: 改两个文件' && msg.value?.body === '正文第一行\n正文第二行', JSON.stringify(msg.value))

  const parents = await ev(`document.querySelector('.detail-parents')?.textContent`)
  const parentSha = execFileSync('git', ['rev-parse', `${clicked.value.sha}^`], { cwd: repo, encoding: 'utf8' }).trim()
  check('父提交是短 sha', parents.value?.includes(parentSha.slice(0, 7)),
    `shown=${parents.value} parent=${parentSha.slice(0, 7)}`)

  const before = await ev(`document.querySelectorAll('.patch').length`)
  check('打开提交不自动展开 diff', before.value === 0, String(before.value))

  await ev(`document.querySelector('.file-row')?.click()`)
  const opened = await waitFor(`document.querySelector('.file-row.open') && document.querySelector('.patch span')`)
  check('点文件行展开 diff', opened, '')

  const header = await ev(`document.querySelector('.patch')?.textContent || ''`)
  check('diff 不含命令头', !/^(diff |index |--- |\+\+\+)/m.test(header.value || '') && header.value.includes('changed'), header.value.slice(0, 80))

  await ev(`document.querySelector('.file-row.open')?.click()`)
  const closed = await waitFor(`!document.querySelector('.file-row.open')`)
  check('再点同一行收起', closed, '')

  await ev(`document.querySelector('.file-fold-btn[data-action="expand"]')?.click()`)
  const total = await ev(`document.querySelectorAll('.file-row').length`)
  const all = await waitFor(`document.querySelectorAll('.file-row.open').length === document.querySelectorAll('.file-row').length`, 20000)
  check('全部展开', all, `${total.value} 个文件`)

  // 文件多到需要滚动：下拉框平时藏着，标题吸顶后出现，选中后滚过去并展开
  const jumpHidden = await ev(`getComputedStyle(document.querySelector('.file-jump')).display`)
  check('未吸顶时不下拉框', jumpHidden.value === 'none', jumpHidden.value)
  await ev(`document.getElementById('detail-body').scrollTop = 400`)
  await sleep(100)
  const stuck = await ev(`({
    stuck: document.querySelector('.detail-sec-title').classList.contains('stuck'),
    jump: getComputedStyle(document.querySelector('.file-jump')).display,
    top: document.querySelector('.detail-sec-title').getBoundingClientRect().top,
    scroller: document.getElementById('detail-body').getBoundingClientRect().top,
  })`)
  const shownFile = await ev(`document.querySelector('.file-jump').value`)
  check('滚过后标题吸顶并显示下拉框',
    stuck.value?.stuck === true && stuck.value?.jump === 'block' && Math.abs(stuck.value.top - stuck.value.scroller) < 2,
    JSON.stringify(stuck.value))
  check('下拉框显示当前文件', Boolean(shownFile.value) && shownFile.value !== 'a.txt', shownFile.value)

  await ev(`(() => {
    const sel = document.querySelector('.file-jump')
    sel.value = 'f10.txt'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  const jumped = await waitFor(`document.querySelector('.file-row[data-path="f10.txt"].open')`, 8000)
  const after = await ev(`(() => {
    const row = document.querySelector('.file-row[data-path="f10.txt"]')
    const title = document.querySelector('.detail-sec-title')
    return {
      value: document.querySelector('.file-jump').value,
      gap: Math.round(row.getBoundingClientRect().top - title.getBoundingClientRect().bottom),
    }
  })()`)
  check('选中后滚到该文件并展开', jumped && after.value?.value === 'f10.txt' && Math.abs(after.value.gap) < 3, JSON.stringify(after.value))

  // 最后一个文件滚不到标题正下方，应该停在底部，而不是被重新算回顶部
  await ev(`(() => {
    const sel = document.querySelector('.file-jump')
    sel.value = 'f29.txt'
    sel.dispatchEvent(new Event('change', { bubbles: true }))
  })()`)
  await waitFor(`document.querySelector('.file-row[data-path="f29.txt"].open')`, 8000)
  const tail = await ev(`(() => {
    const scroller = document.getElementById('detail-body')
    const row = document.querySelector('.file-row[data-path="f29.txt"]')
    const box = scroller.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    return {
      atBottom: scroller.scrollTop > scroller.scrollHeight - scroller.clientHeight - 2,
      visible: r.bottom > box.top && r.top < box.bottom,
    }
  })()`)
  check('选中末尾文件停在底部', tail.value?.atBottom === true && tail.value?.visible === true, JSON.stringify(tail.value))

  await ev(`document.getElementById('detail-body').scrollTop = 0`)
  await sleep(100)
  const back = await ev(`document.querySelector('.file-jump').value`)
  check('滚回顶部后下拉框跟着变', back.value === 'a.txt', back.value)
  const painted = await ev(`document.querySelectorAll('.patch').length`)
  check('视口内的 diff 已画出', painted.value > 0 && painted.value <= 32, String(painted.value))

  await ev(`document.querySelector('.file-fold-btn[data-action="collapse"]')?.click()`)
  const collapsed = await waitFor(`document.querySelectorAll('.file-row.open').length === 0`)
  check('全部收起', collapsed, '')

  const errs = await ev(`window.__errs`)
  check('页面无 JS 错误', Array.isArray(errs.value) && errs.value.length === 0, JSON.stringify(errs.value))
  await shot('ui-detail.png')
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
  for (const [n, , d] of fail) console.log(`  ${n}: ${d}`)
}
process.exit(fail.length ? 1 : 0)
