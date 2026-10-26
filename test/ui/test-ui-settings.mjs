// 纯 Linux UI 冒烟测试：设置页保存 + 主界面按平台显示复制菜单。
//
// 不依赖 Playwright / Edge / WSL / jm_java：自己起隔离服务，用系统 Chrome 的 CDP。
// 这是新 UI 测试的模板；旧的 test-ui-*.mjs 仍需要单独迁移。
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const PORT = Number(process.env.UI_PORT || 7816)
const CDP_PORT = Number(process.env.CDP_PORT || 9237)
const TMP = mkdtempSync(join(tmpdir(), 'wt-ui-settings-'))
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

// 一个能出现在扫描结果里的最小仓库
const repo = join(REPOS, 'demo')
mkdirSync(repo, { recursive: true })
git(repo, ['init', '-q', '-b', 'main'])
writeFileSync(join(repo, 'a.txt'), 'hello\n')
git(repo, ['add', '.'])
git(repo, ['commit', '-qm', 'init'])

writeFileSync(CONFIG, JSON.stringify({
  port: PORT,
  host: '127.0.0.1',
  roots: [REPOS],
  apps: {
    fileManager: { command: '', args: [], pathStyle: 'auto' },
    terminal: { command: '', args: [], pathStyle: 'auto' },
    editor: { command: '', args: [], pathStyle: 'auto' },
  },
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

async function waitFor(expr, timeout = 8000) {
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

try {
  // 等服务起来
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

  // ---------- 设置页 ----------
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/settings.html` })
  await waitFor(`document.getElementById('cmd-editor')`)
  const platform = await ev(`document.getElementById('settings-platform').textContent`)
  check('设置页显示平台', /Linux/.test(platform.value || ''), platform.value)
  const cards = await ev(`document.querySelectorAll('.settings-card').length`)
  check('设置卡片数量', cards.value === 6, `${cards.value} 张`)
  const configPath = await ev(`document.getElementById('settings-config-path').textContent`)
  check('显示配置文件路径', configPath.value === CONFIG, configPath.value)

  const readonly = await ev(`({
    port: document.getElementById('settings-port').textContent,
    host: document.getElementById('settings-host').textContent,
    tag: document.getElementById('settings-port').tagName,
  })`)
  check('端口只读展示', readonly.value?.port === String(PORT) && readonly.value?.tag === 'CODE', JSON.stringify(readonly.value))
  check('监听地址只读展示', readonly.value?.host === '127.0.0.1', JSON.stringify(readonly.value))

  const general = await ev(`({
    roots: document.getElementById('roots').value,
    depth: document.getElementById('scanMaxDepth').value,
    stateCache: document.getElementById('stateCacheMs').value,
  })`)
  check('通用配置预填', general.value?.roots.includes(REPOS) && general.value?.depth === '4', JSON.stringify(general.value))

  const detected = await ev(`[...document.querySelectorAll('.settings-detected')].map(x => x.textContent)`)
  check('自动检测结果显示', (detected.value || []).some((x) => x.includes('/')), JSON.stringify(detected.value))

  await ev(`(() => {
    document.getElementById('scanMaxDepth').value = '7'
    document.getElementById('stateCacheMs').value = '321'
    document.getElementById('cmd-editor').value = '/bin/true'
    document.getElementById('args-editor').value = '{path}\\n--flag'
    document.getElementById('style-editor').value = 'native'
    document.getElementById('settings-save').click()
  })()`)
  const saved = await waitFor(`document.getElementById('settings-msg') && !document.getElementById('settings-msg').hidden`)
  check('保存提示出现', saved, '')

  const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'))
  check('设置写回 config.json', cfg.apps?.editor?.command === '/bin/true' && cfg.apps.editor.args.length === 2, JSON.stringify(cfg.apps?.editor))
  check('通用配置写回 config.json', cfg.scanMaxDepth === 7 && cfg.stateCacheMs === 321, `depth=${cfg.scanMaxDepth} ttl=${cfg.stateCacheMs}`)
  check('其他字段未丢', cfg.port === PORT && cfg.host === '127.0.0.1' && cfg.roots?.[0] === REPOS, `port=${cfg.port}`)
  await shot('ui-settings-page.png')

  // ---------- 主界面 ----------
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` })
  await waitFor(`document.getElementById('btn-settings')`)
  const title = await ev(`document.title`)
  check('主界面标题', title.value === 'Worktree', title.value)
  const settingsBtn = await ev(`document.getElementById('btn-settings')?.textContent`)
  check('主界面有设置入口', settingsBtn.value === '设置', settingsBtn.value)

  await waitFor(`document.querySelectorAll('#repo-list .repo').length > 0`)
  await ev(`[...document.querySelectorAll('#repo-list .repo')].find(e => e.dataset.toplevel.endsWith('/demo'))?.click()`)
  await waitFor(`document.querySelectorAll('#wt-body tr[data-path]').length > 0`)
  await ev(`document.querySelector('#wt-body tr[data-path] [data-act="menu"]')?.click()`)
  await waitFor(`document.querySelector('.row-menu')`)
  const labels = await ev(`[...document.querySelectorAll('.row-menu .rmi-label')].map(x => x.textContent)`)
  check('菜单有原生复制路径', (labels.value || []).includes('复制路径'), JSON.stringify(labels.value))
  check('纯 Linux 不显示 Windows 路径', !(labels.value || []).includes('复制 Windows 路径'), JSON.stringify(labels.value))
  check('菜单有文件管理器/终端/编辑器', ['打开文件管理器', '在终端中打开', '用 VS Code 打开'].every((x) => (labels.value || []).includes(x)), '')
  const errs = await ev(`window.__errs`)
  check('页面无 JS 错误', Array.isArray(errs.value) && errs.value.length === 0, JSON.stringify(errs.value))
  await shot('ui-settings-linux.png')
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
