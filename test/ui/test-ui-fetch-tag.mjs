// UI 验证：fetch 遇到 tag 冲突时的对话框
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, '..', '..', 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9288
const ROOT = '/tmp/wt-tagui'

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()

// 造 tag 冲突的仓库，放到扫描根之外的 /tmp，用 UI 测不方便 —— 所以直接改 config 扫描它不现实。
// 改用：把临时仓库放进一个测试根目录，临时覆盖扫描根不方便。
// 折中方案：直接打开页面，用 javasdk 这个真实仓库（它就有 tag 冲突），只点「更新仓库」并验证对话框。
// 但绝不能让它真的覆盖 tag —— 默认路径不覆盖，安全。

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-tag-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await sleep(4200)

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const page = list.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) } })
await new Promise((r) => ws.addEventListener('open', r))
const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })) })
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r?.exceptionDetails) return { error: r.exceptionDetails.exception?.description }
  return { value: r?.result?.value }
}
const shot = async (n) => { const r = await send('Page.captureScreenshot', { format: 'png' }); if (r?.data) writeFileSync(join(SHOTS, n), Buffer.from(r.data, 'base64')) }

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?tagui=1' })
await sleep(4200)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 选中 javasdk（有 tag 冲突的真实仓库）
const picked = await ev(`(() => {
  const el = [...document.querySelectorAll('#repo-list .repo')].find(e => e.dataset.toplevel.endsWith('/javasdk'))
  if (!el) return 'not found'
  el.click()
  return 'ok'
})()`)
check('选中 javasdk 仓库', picked.value === 'ok', picked.value)
await sleep(2500)

// 点「更新仓库」，走默认路径（不覆盖 tag）
await ev(`document.getElementById('btn-fetch').click()`)
await sleep(1200)

// 等待对话框出现（fetch 可能要几秒）
let modalTitle = ''
for (let i = 0; i < 40; i++) {
  const t = await ev(`document.getElementById('modal').hidden ? null : document.getElementById('modal-title').textContent`)
  if (t.value) { modalTitle = t.value; break }
  await sleep(500)
}
check('弹出对话框', Boolean(modalTitle), modalTitle)

const isTagConflict = /tag 冲突/.test(modalTitle)
const isFail = /更新失败/.test(modalTitle)
check('不再显示「更新失败」', !isFail, `标题=${modalTitle}`)
check('显示 tag 冲突对话框', isTagConflict, `标题=${modalTitle}`)

if (isTagConflict) {
  const content = await ev(`({
    note: (document.querySelector('#modal-body .note.warn')?.textContent || '').replace(/\\s+/g,' ').trim().slice(0,80),
    rows: [...document.querySelectorAll('.stale-tbl tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim())),
    hasForceBtn: !!document.querySelector('#modal-foot .btn.danger'),
    forceLabel: document.querySelector('#modal-foot .btn.danger')?.textContent,
    keepLabel: document.querySelector('#modal-foot .btn.primary')?.textContent,
  })`)
  check('说明分支已更新', /分支已经更新完成/.test(content.value?.note || ''), content.value?.note)
  check('列出冲突 tag 与两个 sha', (content.value?.rows || []).length >= 1 && content.value.rows[0].length === 3,
    JSON.stringify(content.value?.rows))
  check('有「保留本地」默认按钮', content.value?.keepLabel === '保留本地 tag', content.value?.keepLabel)
  check('有「覆盖」危险按钮', content.value?.hasForceBtn === true && content.value?.forceLabel === '用远端覆盖', content.value?.forceLabel)
  await shot('fetch-tag-conflict.png')
}

// 关闭（保留本地），确认 tag 没被改
await ev(`document.getElementById('modal-close').click()`)
await sleep(400)
const stillOld = execFileSync('wsl.exe', ['-d', 'archlinux', '-e', 'bash', '-lc',
  'git -C /home/wangy/codes/javasdk rev-parse refs/tags/v5.5.12.9'], { encoding: 'utf8' }).trim()
check('保留本地后 tag 未变', stillOld.startsWith('a8b0994e'), stillOld.slice(0, 8))

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
ws.close(); try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
