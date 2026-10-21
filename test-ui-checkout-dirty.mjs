// 切换分支：本地有改动时给出「强制切换（放弃本地变更）」出口
//
// 安全前提：测试只验证 UI 结构与「二次确认」行为，**不真的执行强制切换**
// （那会丢弃文件内容、改变分支）。force 的实际效果由 test-ops / 手工脚本覆盖。
// 制造的 dirty 状态在 finally 里恢复，并校验恢复干净。
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SHOTS = join(HERE, 'shots')
mkdirSync(SHOTS, { recursive: true })

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9641
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const WT = '/home/wangy/codes/jm_java-worktrees/h-tag-5.5.13.10-主项问题修复1016'
const TARGET_FILE = '.gitignore'
const REPO = '/home/wangy/codes/jm_java'

/** 在 WSL 里跑命令 */
const wsl = (cmd) => execFileSync('wsl.exe', ['-e', 'bash', '-lc', cmd], { encoding: 'utf8' }).toString().trim()
const wslQuiet = (cmd) => { try { return wsl(cmd) } catch { return '' } }

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }

let browser = null
let ws = null

try {
  // 前置：确认干净，并找一个「该文件内容不同」的历史 commit（切过去才会冲突）
  const dirtyBefore = wsl(`cd "${WT}" && git status --porcelain | wc -l`)
  check('起始状态是干净的', Number(dirtyBefore) === 0, `${dirtyBefore} 项改动`)

  const oldSha = wslQuiet(`cd "${WT}" && git rev-parse HEAD~120`).trim()
  const differs = wslQuiet(`cd "${WT}" && test "$(git rev-parse HEAD:${TARGET_FILE})" != "$(git rev-parse ${oldSha}:${TARGET_FILE} 2>/dev/null)" && echo yes || echo no`)
  check('目标文件在该 commit 上内容不同（能触发冲突）', differs === 'yes', `HEAD~120=${oldSha.slice(0, 8)}`)

  // 制造 dirty：往被跟踪文件追加一行
  wsl(`cd "${WT}" && printf '\\n# test-dirty-marker\\n' >> ${TARGET_FILE}`)
  const dirtyNow = wsl(`cd "${WT}" && git status --porcelain | wc -l`)
  check('已制造本地改动', Number(dirtyNow) >= 1, `${dirtyNow} 项`)

  const headBefore = wsl(`cd "${WT}" && git rev-parse HEAD`)

  // ---- 启动浏览器 ----
  browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
    '--window-size=1600,950', `--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\cf-${Date.now()}`, 'about:blank'], { stdio: 'ignore' })

  let targets = null
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      if (list?.some((t) => t.type === 'page')) { targets = list; break }
    } catch {}
  }
  if (!targets) throw new Error('Edge 调试端口未就绪')

  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
  })
  await new Promise((res) => ws.addEventListener('open', res))
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params: params }))
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
  await send('Page.navigate', { url: `http://localhost:7801/#repo=${encodeURIComponent(REPO)}` })
  await sleep(6500)

  // ---- 打开该 worktree 的切换对话框 ----
  const opened = await ev(`(() => {
    const rows = [...document.querySelectorAll('#wt-body tr')]
    const row = rows.find(r => r.textContent.includes('主项问题修复1016'))
    if (!row) return { ok: false, count: rows.length }
    const btn = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '切换')
    if (!btn) return { ok: false, buttons: [...row.querySelectorAll('button')].map(b => b.textContent.trim()) }
    btn.click()
    return { ok: true }
  })()`)
  check('打开「切换分支」对话框', opened.value?.ok === true, opened.value?.buttons ? JSON.stringify(opened.value.buttons) : '')
  await sleep(2200)

  // ---- 填一个「该文件内容不同」的 commit，触发 dirty-conflict ----
  await ev(`(() => {
    const i = document.getElementById('co-detach')
    i.value = ${JSON.stringify(oldSha)}
    i.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(400)
  await ev(`document.querySelector('#modal-foot .btn.primary').click()`)
  await sleep(4500)

  const conflict = await ev(`(() => {
    const result = document.getElementById('co-result')
    const force = result?.querySelector('#co-force')
    return {
      text: (result?.textContent || '').replace(/\\s+/g, ' ').trim(),
      hasFileList: Boolean(result?.querySelector('.filelist')),
      fileListText: (result?.querySelector('.filelist')?.textContent || '').trim().slice(0, 120),
      forceText: force?.textContent?.trim() || null,
      forceIsDanger: force ? /danger/.test(force.className) : false,
      hint: result?.querySelector('.co-force-hint')?.textContent?.trim() || null,
      modalOpen: !document.getElementById('modal').hidden,
    }
  })()`)

  check('提示工作区有未提交改动', /未提交的改动|会被它们挡住/.test(conflict.value?.text || ''), '')
  check('列出会被丢弃的文件', conflict.value?.hasFileList === true,
    conflict.value?.fileListText?.replace(/\s+/g, ' ').slice(0, 60))
  check('说明改动无法恢复', /无法恢复/.test(conflict.value?.text || ''), '')
  check('提供「放弃这些改动并切换」按钮', conflict.value?.forceText === '放弃这些改动并切换',
    conflict.value?.forceText)
  check('按钮用危险色', conflict.value?.forceIsDanger === true, '')
  check('提示需要二次确认', /点击两次/.test(conflict.value?.hint || ''), conflict.value?.hint)
  check('对话框保持打开', conflict.value?.modalOpen === true, '')
  await shot('checkout-dirty-conflict.png')

  // ---- 第一次点击：只「上膛」，不执行 ----
  await ev(`document.getElementById('co-force').click()`)
  await sleep(600)
  const armed = await ev(`(() => {
    const b = document.getElementById('co-force')
    return {
      text: b?.textContent?.trim(),
      armedClass: /armed/.test(b?.className || ''),
      disabled: b?.disabled,
    }
  })()`)
  check('首次点击变「再点一次」确认', /再点一次/.test(armed.value?.text || ''), armed.value?.text)
  check('按钮进入 armed 状态（有醒目描边）', armed.value?.armedClass === true, '')
  check('首次点击不执行切换（按钮未禁用）', armed.value?.disabled === false, '')

  const headAfterArm = wsl(`cd "${WT}" && git rev-parse HEAD`)
  check('仓库 HEAD 未变（没有真的切换）', headAfterArm === headBefore,
    `${headBefore.slice(0, 8)} === ${headAfterArm.slice(0, 8)}`)
  const stillDirty = wsl(`cd "${WT}" && git status --porcelain | wc -l`)
  check('本地改动仍在（没被丢弃）', Number(stillDirty) >= 1, `${stillDirty} 项`)

  // ---- 5 秒后自动复位 ----
  await sleep(5600)
  const disarmed = await ev(`(() => {
    const b = document.getElementById('co-force')
    return { text: b?.textContent?.trim(), armedClass: /armed/.test(b?.className || '') }
  })()`)
  check('等待超时后自动复位', disarmed.value?.text === '放弃这些改动并切换' && disarmed.value?.armedClass === false,
    disarmed.value?.text)

  // ---- 关闭对话框，确认没留下副作用 ----
  await ev(`document.getElementById('modal-close').click()`)
  await sleep(600)
  const modalClosed = await ev(`document.getElementById('modal').hidden`)
  check('关闭对话框', modalClosed.value === true, '')

  const errs = await ev(`window.__errs || []`)
  check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

} finally {
  // ---- 恢复现场：撤销制造的改动 ----
  wslQuiet(`cd "${WT}" && git checkout -- ${TARGET_FILE}`)
  await sleep(400)
  const restored = wslQuiet(`cd "${WT}" && git status --porcelain | wc -l`)
  check('测试结束后工作区已恢复干净', Number(restored) === 0, `${restored} 项改动`)

  try { ws?.close() } catch {}
  try { browser?.kill() } catch {}
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
