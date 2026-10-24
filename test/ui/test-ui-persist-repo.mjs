// 刷新后恢复上次选中的仓库
import { spawn } from 'node:child_process'

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PORT = 9377
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = spawn(EDGE, ['--headless', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${PORT}`,
  '--window-size=1500,1000', '--user-data-dir=C:\\Users\\wangy\\AppData\\Local\\Temp\\edge-persist-' + Date.now(), 'about:blank'], { stdio: 'ignore' })
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

await send('Page.enable'); await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: 'http://localhost:7801/?persist=1' })
await sleep(5000)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }

const current = () => ev(`({
  title: document.getElementById('main-title').textContent,
  meta: document.getElementById('main-meta').textContent,
  hash: location.hash,
  hashDecoded: decodeURIComponent(location.hash || ''),
  hashDecoded: decodeURIComponent(location.hash || ''),
  stored: localStorage.getItem('wsl-worktree.lastRepo'),
})`)

// 先清干净
await ev(`localStorage.removeItem('wsl-worktree.lastRepo'); history.replaceState(null,'',location.pathname)`)
await send('Page.reload')
await sleep(5000)

// ---- 1. 首次访问（无记录）→ 选中第一个 ----
const fresh = await current()
const repoCount = await ev(`document.querySelectorAll('#repo-list .repo').length`)
check('首次访问有仓库列表', repoCount.value > 0, `${repoCount.value} 个`)
check('首次访问写入记录', Boolean(fresh.value?.stored), fresh.value?.stored?.split('/').pop())
check('首次访问 hash 已设置', /^#repo=/.test(fresh.value?.hash || ''), fresh.value?.hash?.slice(0, 40))
const firstTitle = fresh.value?.title

// ---- 2. 切换到另一个仓库 ----
const switched = await ev(`(() => {
  const items = [...document.querySelectorAll('#repo-list .repo')]
  const target = items.find(e => e.dataset.toplevel.endsWith('/jm_net'))
    || items.find(e => e.dataset.toplevel !== document.querySelector('#repo-list .repo.active')?.dataset.toplevel)
  if (!target) return null
  const name = target.querySelector('.repo-name').textContent
  target.click()
  return { name, toplevel: target.dataset.toplevel }
})()`)
await sleep(3000)
check('切换后有目标仓库', Boolean(switched.value), switched.value?.name)
const afterSwitch = await current()
check('切换后标题更新', afterSwitch.value?.title === switched.value?.name, afterSwitch.value?.title)
check('切换后记录更新', afterSwitch.value?.stored === switched.value?.toplevel, afterSwitch.value?.stored)
check('切换后 hash 更新', afterSwitch.value?.hashDecoded === `#repo=${switched.value?.toplevel}`, afterSwitch.value?.hashDecoded?.slice(0, 50))
check('确实换了仓库', afterSwitch.value?.title !== firstTitle, `${firstTitle} → ${afterSwitch.value?.title}`)

// ---- 3. 刷新后应恢复（核心用例）----
await send('Page.reload')
await sleep(5000)
const afterReload = await current()
check('刷新后仍是上次的仓库', afterReload.value?.title === switched.value?.name,
  `${afterReload.value?.title}（期望 ${switched.value?.name}）`)
check('刷新后不是第一个', afterReload.value?.title !== firstTitle,
  `第一个=${firstTitle} 当前=${afterReload.value?.title}`)
check('刷新后 hash 保持', afterReload.value?.hashDecoded === `#repo=${switched.value?.toplevel}`, afterReload.value?.hashDecoded?.slice(0, 50))

// 左侧列表高亮也要对
const activeRow = await ev(`document.querySelector('#repo-list .repo.active')?.dataset.toplevel`)
check('左侧列表高亮同步', activeRow.value === switched.value?.toplevel, activeRow.value)

// ---- 4. 再换一个，连续刷新两次 ----
const third = await ev(`(() => {
  const items = [...document.querySelectorAll('#repo-list .repo')]
  const t = items.find(e => e.dataset.toplevel.endsWith('/javasdk')) || items[3]
  if (!t) return null
  t.click()
  return { name: t.querySelector('.repo-name').textContent, toplevel: t.dataset.toplevel }
})()`)
await sleep(2800)
await send('Page.reload'); await sleep(4800)
const r1 = await current()
check('第二次切换后刷新仍正确', r1.value?.title === third.value?.name, r1.value?.title)
await send('Page.reload'); await sleep(4800)
const r2 = await current()
check('连续两次刷新仍正确', r2.value?.title === third.value?.name, r2.value?.title)

// ---- 5. 直接带 hash 打开（分享链接）----
const shareTarget = switched.value?.toplevel
await send('Page.navigate', { url: `http://localhost:7801/?x=1#repo=${encodeURIComponent(shareTarget)}` })
await sleep(5200)
const viaHash = await current()
check('带 hash 打开直接定位', viaHash.value?.title === switched.value?.name,
  `${viaHash.value?.title}（期望 ${switched.value?.name}）`)

// ---- 6. hash 指向不存在的仓库 → 回退且纠正 hash ----
await send('Page.navigate', { url: 'http://localhost:7801/?x=2#repo=' + encodeURIComponent('/nonexistent/repo-xyz') })
await sleep(5200)
const badHash = await current()
check('无效 hash 仍能正常显示', Boolean(badHash.value?.title), badHash.value?.title)
check('无效 hash 被纠正为有效值', (badHash.value?.hashDecoded || '').startsWith('#repo=/') && !badHash.value.hashDecoded.includes('nonexistent'),
  badHash.value?.hashDecoded?.slice(0, 50))

// ---- 7. localStorage 里的值失效 → 回退第一个 ----
await ev(`localStorage.setItem('wsl-worktree.lastRepo', '/gone/away'); history.replaceState(null,'',location.pathname)`)
await send('Page.reload')
await sleep(5000)
const stale = await current()
check('失效记录时回退到可用仓库', Boolean(stale.value?.title), stale.value?.title)
check('失效记录被覆盖为有效值', (stale.value?.stored || '').startsWith('/home/'), stale.value?.stored)

// ---- 8. hashchange 联动 ----
await send('Page.navigate', { url: 'http://localhost:7801/?x=3' })
await sleep(5000)
const beforeHc = await current()
const hcTarget = beforeHc.value?.title === 'jm_java' ? '/home/wangy/codes/jm_net' : '/home/wangy/codes/jm_java'
await ev(`location.hash = 'repo=' + encodeURIComponent('${hcTarget}')`)
await sleep(3000)
const afterHc = await current()
check('手改 hash 触发切换', afterHc.value?.stored === hcTarget, `${beforeHc.value?.title} → ${afterHc.value?.title}`)

// ---- 9. hash 与 localStorage 冲突时，hash 优先 ----
await ev(`localStorage.setItem('wsl-worktree.lastRepo', '/home/wangy/codes/jm_java')`)
await send('Page.navigate', { url: 'http://localhost:7801/?x=4#repo=' + encodeURIComponent('/home/wangy/codes/jm_net') })
await sleep(5200)
const conflict = await current()
check('冲突时 hash 优先于 localStorage', conflict.value?.title === 'jm_net',
  `hash=jm_net 存储=jm_java 实际=${conflict.value?.title}`)

const errs = await ev(`window.__errs || []`)
check('无 JS 错误', (errs.value || []).length === 0, JSON.stringify(errs.value))

await ev(`localStorage.removeItem('wsl-worktree.lastRepo')`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
ws.close(); try { browser.kill() } catch {}
process.exit(fail.length ? 1 : 0)
