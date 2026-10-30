// Worktree — 浏览器客户端（WSL / Linux 共用）
import { fuzzyScore, rankByFuzzy } from '/fuzzy.js'
import { linkify } from '/linkify.js'
import { validSshTarget, vscodeRemoteUri, sshCommand, zedRemoteCommand } from '/open-remote.js'
import { copyText } from '/clipboard.js'
import { prefOfWorktree, pickWorktree } from '/log-wt.js'
const $ = (id) => document.getElementById(id)
const state = {
  repos: [],
  platform: 'linux',   // /api/config：wsl | linux
  distro: '',          // 仅 WSL 有，用来拼 UNC
  repo: null,          // 当前仓库对象
  worktrees: [],
  logWt: null,         // 当前查看日志的 worktree 路径（null = 主工作树）
  commits: [],
  logSkip: 0,
  logCount: 200,
  logRev: 'HEAD',
  logFilter: '',
  commitsAll: [],      // 未过滤的当前批
  logHasMore: false,   // 后端还有下一页（滚动到底自动加载）
  logLoading: false,
  selectedSha: null,
  pending: null,       // 当前 worktree 的未提交改动摘要 { count, add, del, untracked, wt }
  selectedFile: null,
  detailFiles: [],
  openMode: 'local',   // 浏览器端偏好：「打开」按钮调哪台机器的程序（local 本机 / remote 远程）
  openSsh: '',         // 远程模式的 SSH 目标（user@host 或 ~/.ssh/config 别名）
}

const fmtTime = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
const relTime = (ms) => {
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`
  return `${Math.floor(diff / 86400 / 365)} 年前`
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let toastTimer = null
function toast(msg, isErr = false) {
  const el = $('toast')
  el.textContent = msg
  el.className = 'toast' + (isErr ? ' err' : '')
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, isErr ? 6000 : 2200)
}

/**
 * 复制文本并按结果给反馈。
 * 失败时不把文本塞进 toast：toast 2 秒就消失，SSH 命令那么长根本看不清，
 * 所以改成弹一个已全选的只读文本框，用户自己按 Ctrl+C。
 */
async function copyOrShow(text, okMsg) {
  if (await copyText(text)) {
    toast(okMsg)
    return
  }
  showCopyDialog(text)
}

function showCopyDialog(text) {
  const body = document.createElement('div')
  body.innerHTML = `
    <div class="field">
      <label>浏览器不允许自动写剪贴板</label>
      <textarea class="textarea" id="copy-manual" rows="4" readonly spellcheck="false"></textarea>
      <div class="hintline">文本已全选，直接按 Ctrl+C 复制。常见原因：页面是 <code>http://&lt;IP&gt;:7801</code> 这种非安全上下文（只有 https 和 localhost 才有 <code>navigator.clipboard</code>）。</div>
    </div>`
  const ta = body.querySelector('#copy-manual')
  ta.value = text
  openModal({
    title: '手动复制',
    body,
    buttons: [{ label: '关闭' }],
    onMount: () => { ta.focus(); ta.select() },
  })
}

async function api(path, opts) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ---------- repos ----------
async function loadRepos(force = false) {
  $('stats').textContent = '扫描中…'
  try {
    const data = await api(`/api/repos${force ? '?force=1' : ''}`)
    state.repos = data.repos
    renderRepos()
    const wtTotal = state.repos.reduce((n, r) => n + r.count, 0)
    const dirtyTotal = state.repos.reduce((n, r) => n + r.dirtyCount, 0)
    $('stats').textContent = `${state.repos.length} 仓库 · ${wtTotal} worktree${dirtyTotal ? ` · ${dirtyTotal} 有改动` : ''}`
    // 顶栏切换器的候选来自 state.repos，数据刷新后同步当前值与徽章
    if (!$('top-repo').hidden) setTopRepoInputToCurrent()
  } catch (err) {
    $('stats').textContent = '扫描失败'
    toast(`加载仓库失败: ${err.message}`, true)
  }
}

function renderRepos() {
  const filter = $('repo-search').value.trim().toLowerCase()
  const list = $('repo-list')
  const groups = new Map()
  for (const r of state.repos) {
    if (filter && !r.toplevel.toLowerCase().includes(filter)) continue
    const rel = r.toplevel.replace(/^\/home\/[^/]+\/codes\/?/, '').replace(/^\/home\/[^/]+\//, '~/')
    const parts = rel.split('/')
    const group = parts.length > 1 ? parts[0] : ''
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push({ ...r, rel, shortName: parts[parts.length - 1] })
  }

  const frag = document.createDocumentFragment()
  const keys = [...groups.keys()].sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
  for (const key of keys) {
    if (key) {
      const g = document.createElement('div')
      g.className = 'repo-group'
      g.textContent = key
      frag.appendChild(g)
    }
    for (const r of groups.get(key).sort((a, b) => a.shortName.localeCompare(b.shortName))) {
      const el = document.createElement('div')
      el.className = 'repo' + (state.repo?.toplevel === r.toplevel ? ' active' : '')
      el.dataset.toplevel = r.toplevel
      el.title = r.toplevel
      const name = document.createElement('span')
      name.className = 'repo-name'
      name.textContent = r.shortName
      el.appendChild(name)
      if (r.error) {
        const b = document.createElement('span'); b.className = 'badge err'; b.textContent = '!'
        el.appendChild(b)
      } else if (r.extra > 0) {
        const b = document.createElement('span'); b.className = 'badge'; b.textContent = String(r.extra)
        el.appendChild(b)
      }
      if (r.dirtyCount > 0) {
        const b = document.createElement('span'); b.className = 'badge warn'; b.textContent = '●'
        el.appendChild(b)
      }
      frag.appendChild(el)
    }
  }
  list.replaceChildren(frag)
  $('repo-count').textContent = String(state.repos.length)

  if (!state.repos.length) {
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = '未找到仓库'
    list.appendChild(d)
  }
}

$('repo-list').addEventListener('click', (e) => {
  const el = e.target.closest('.repo')
  if (!el) return
  selectRepo(el.dataset.toplevel)
})

// ---------- 记住上次选中的仓库 ----------
// 优先 URL hash（可以分享/收藏某个仓库的直链），其次 localStorage。
// 两者都没有或不匹配时才退回第一个。
const LAST_REPO_KEY = 'wsl-worktree.lastRepo'

function readRepoFromHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, ''))
  if (!h.startsWith('repo=')) return null
  return h.slice('repo='.length) || null
}

function readLastRepo() {
  try { return localStorage.getItem(LAST_REPO_KEY) } catch { return null }
}

function rememberRepo(toplevel) {
  try { localStorage.setItem(LAST_REPO_KEY, toplevel) } catch {}
  // 用 replaceState 而不是改 location.hash：后者会写入历史记录，
  // 用户点浏览器的后退键会在一堆仓库之间来回跳
  const want = `#repo=${encodeURIComponent(toplevel)}`
  if (location.hash !== want) {
    try { history.replaceState(null, '', want) } catch {}
  }
}

/** 从候选里挑出要恢复的仓库：hash 优先，其次 localStorage */
function pickRestoreTarget() {
  const byHash = readRepoFromHash()
  if (byHash && state.repos.some((r) => r.toplevel === byHash)) return byHash

  const byStore = readLastRepo()
  if (byStore) {
    const exact = state.repos.find((r) => r.toplevel === byStore)
    if (exact) return exact.toplevel
    // 兜底：只存了名字（或路径变过）时按名字匹配唯一项
    const byName = state.repos.filter((r) => r.name === byStore)
    if (byName.length === 1) return byName[0].toplevel
  }
  return null
}

async function selectRepo(toplevel, force = false) {
  const repo = state.repos.find((r) => r.toplevel === toplevel)
  if (!repo) return
  state.repo = repo
  state.selectedSha = null
  state.selectedFile = null
  state.logWt = null
  syncFileTreeBtn()
  // 记住这次选择，刷新后能回到这里
  rememberRepo(toplevel)
  renderRepos()
  $('main-title').textContent = repo.name
  $('main-meta').textContent = repo.toplevel
  $('detail-title').textContent = '详情'
  $('detail-meta').textContent = ''
  $('detail-body').innerHTML = '<div class="empty">点击一个提交查看改动文件</div>'
  // 顶栏切换器跟着走（左栏收起时它就是唯一的仓库标识）
  if (!$('top-repo').hidden) setTopRepoInputToCurrent()
  await loadWorktrees(force)
  await loadLog(true)
}

// ---------- worktree 日志选择器 ----------
// 当前看哪个 worktree 的日志只记在浏览器里（localStorage），按仓库各存一份。
// 记录分支而不是只记目录：worktree 删了重建目录会变，分支才是用户想看的那个。
const LOG_WT_KEY = 'wsl-worktree.logWt'

function readLogWtStore() {
  try {
    const all = JSON.parse(localStorage.getItem(LOG_WT_KEY) || '{}')
    return all && typeof all === 'object' ? all : {}
  } catch { return {} }
}

function readLogWtPref(repo = state.repo) {
  if (!repo) return null
  const pref = readLogWtStore()[repo.toplevel]
  return pref && typeof pref === 'object' ? pref : null
}

function writeLogWtPref(wt) {
  if (!state.repo) return
  try {
    const all = readLogWtStore()
    if (wt) all[state.repo.toplevel] = prefOfWorktree(wt)
    else delete all[state.repo.toplevel]
    localStorage.setItem(LOG_WT_KEY, JSON.stringify(all))
  } catch {}
}

/** 把行高亮同步到 state.logWt（下拉框、点击分支名都走这里） */
function syncWtFocus() {
  for (const row of $('wt-body').children) {
    row.classList.toggle('wt-focused', row.dataset.path === state.logWt)
  }
}

function renderWtSelect() {
  const sel = $('wt-select')
  const prev = state.worktrees.find((w) => w.path === state.logWt && !w.prunable)
  const stored = pickWorktree(state.worktrees, readLogWtPref())
  const main = state.worktrees.find((w) => w.isMain && !w.prunable)
  const pick = prev || stored || main || state.worktrees.find((w) => !w.prunable) || null

  const frag = document.createDocumentFragment()
  for (const wt of state.worktrees) {
    const opt = document.createElement('option')
    opt.value = wt.path
    const label = wt.detached
      ? `(detached @ ${(wt.head || '').slice(0, 7)})`
      : (wt.branch || '?')
    opt.textContent = label
    if (wt.isMain) opt.textContent += ' · 主'
    if (wt.dirty > 0) opt.textContent += ` · ${wt.dirty}改`
    if (wt.prunable) { opt.textContent += ' · 已失效'; opt.disabled = true }
    frag.appendChild(opt)
  }
  sel.replaceChildren(frag)
  sel.value = pick?.path ?? ''
  state.logWt = pick?.path ?? null
  // 恢复到的新目录也写回去，下次刷新直接命中
  writeLogWtPref(pick)
  syncWtFocus()
  sel.disabled = state.worktrees.length === 0
  $('rev-select').disabled = state.worktrees.length === 0
}

$('wt-select').addEventListener('change', (e) => {
  state.logWt = e.target.value || null
  writeLogWtPref(state.worktrees.find((w) => w.path === state.logWt) || null)
  syncWtFocus()
  // 切换 worktree 后「当前分支」的含义变了，必须重新拉日志
  loadLog(true)
})

/** 点击分支名 / 下拉框选择 = 把日志切到那个 worktree */
function focusWorktree(wtPath) {
  const wt = state.worktrees.find((w) => w.path === wtPath)
  if (!wt || wt.prunable || state.logWt === wtPath) return
  state.logWt = wtPath
  $('wt-select').value = wtPath
  writeLogWtPref(wt)
  syncWtFocus()
  loadLog(true)
  $('log-scroll').scrollTop = 0
  toast(`日志已切换到 ${wtPath.replace(/^\/home\/[^/]+\//, '~/')}`)
}

// ---------- worktrees ----------
async function loadWorktrees(force = false) {
  if (!state.repo) return
  const body = $('wt-body')
  body.innerHTML = '<tr><td colspan="7" class="empty" style="padding:18px">加载中…</td></tr>'
  try {
    const data = await api(`/api/repos/${state.repo.id}/worktrees${force ? '?force=1' : ''}`)
    state.worktrees = data.worktrees
    renderWorktrees()
    renderWtSelect()
  } catch (err) {
    body.innerHTML = `<tr><td colspan="7" class="empty" style="color:var(--red)">${esc(err.message)}</td></tr>`
  }
}

function renderWorktrees() {
  const body = $('wt-body')
  const frag = document.createDocumentFragment()

  for (const wt of state.worktrees) {
    const tr = document.createElement('tr')
    tr.dataset.path = wt.path
    if (wt.path === state.logWt) tr.className = 'wt-focused'
    tr.title = '点击分支名查看该 worktree 的日志'

    const dot = document.createElement('td')
    if (wt.isMain) dot.innerHTML = '<span class="main-dot" title="主工作树"></span>'
    else if (wt.dirty > 0) dot.innerHTML = '<span class="dirty-dot" title="有未提交改动"></span>'
    else dot.innerHTML = '<span class="clean-dot" title="干净"></span>'
    tr.appendChild(dot)

    const branch = document.createElement('td')
    const bcls = wt.isMain ? 'branch main-branch' : 'branch'
    const label = wt.detached ? `(detached @ ${(wt.head || '').slice(0, 7)})` : (wt.branch || '?')
    branch.innerHTML = `<button type="button" class="${bcls} branch-link" title="切换到该 worktree 的日志：${esc(label)}">${esc(label)}</button>`
    tr.appendChild(branch)

    const path = document.createElement('td')
    path.className = 'path'
    path.title = wt.path
    path.textContent = wt.path.replace(/^\/home\/[^/]+\//, '~/')
    tr.appendChild(path)

    const dirty = document.createElement('td')
    dirty.className = 'num'
    if (wt.dirty > 0) dirty.innerHTML = `<span class="pill dirty">${wt.dirty} 文件</span>`
    else if (wt.dirty === 0) dirty.innerHTML = '<span class="pill clean">干净</span>'
    else dirty.innerHTML = '<span class="pill prunable" title="状态读取失败">?</span>'
    tr.appendChild(dirty)

    const ab = document.createElement('td')
    ab.className = 'num'
    if (wt.ahead || wt.behind) {
      ab.innerHTML = `<span class="ab">${wt.ahead ? `<span class="ahead">↑${wt.ahead}</span>` : ''}${wt.ahead && wt.behind ? ' ' : ''}${wt.behind ? `<span class="behind">↓${wt.behind}</span>` : ''}</span>`
    } else {
      ab.innerHTML = '<span class="ab" style="color:var(--text-faint)">—</span>'
    }
    tr.appendChild(ab)

    const flags = document.createElement('td')
    const pills = []
    if (wt.isMain) pills.push('<span class="pill main">主</span>')
    if (wt.bare) pills.push('<span class="pill bare">bare</span>')
    if (wt.locked) pills.push(`<span class="pill locked" title="${esc(wt.lockReason || '已锁定')}">锁定</span>`)
    if (wt.prunable) pills.push('<span class="pill prunable" title="目录已不存在">待清理</span>')
    flags.innerHTML = pills.join(' ')
    tr.appendChild(flags)

    const actions = document.createElement('td')
    // 行内只留一个「更多」：五个文字按钮平铺会把表格撑得很宽，
    // 每行重复同样的文字，扫视时也很吵。危险操作靠二次确认兜底，不用靠位置防误点。
    actions.innerHTML = `<div class="row-actions">
      <button class="icon-btn" data-act="menu" title="更多操作">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <circle cx="3.2" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.8" cy="8" r="1.25"/>
        </svg>
      </button>
    </div>`
    tr.appendChild(actions)
    frag.appendChild(tr)
  }

  body.replaceChildren(frag)
  $('wt-empty').hidden = state.worktrees.length > 0
  if (!state.worktrees.length) body.innerHTML = ''
}

// ---------- worktree 行的「更多」菜单 ----------
const ROW_ICONS = {
  branch: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.8" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.8" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="6.5" r="1.8" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.3v5.4M11.5 8.3c0 2.2-2 3-4.6 3.4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>',
  pull: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 13h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  folder: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h2.3c.4 0 .8.2 1 .5l.7 1h5A1.5 1.5 0 0 1 14 6v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 12V4.5z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  terminal: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.6 6.4L6.6 8l-2 1.6M8.4 10h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  vscode: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.3 2.2L5.6 7.4 3.4 5.7 2 6.4v3.2l1.4.7 2.2-1.7 5.7 5.2 2.7-1.3V3.5l-2.7-1.3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M11.3 5.2v5.6" stroke="currentColor" stroke-width="1.2"/></svg>',
  zed: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.6 4h8.8l-8.8 8h8.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trash: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

// ---------- 打开方式：本机 / 远程 ----------
// 浏览器在 Windows、服务在另一台 Linux 时，`/api/open` 启动的程序只会出现在
// 那台 Linux 的桌面上。所以这里让用户自己声明「浏览器在哪台机器」，
// 远程模式改用 vscode:// 协议和「复制命令」，完全不经过服务端。
// 偏好只记在 localStorage：它描述的是这台浏览器，不是服务端配置。
const OPEN_MODE_KEY = 'wsl-worktree.openMode'
const OPEN_SSH_KEY = 'wsl-worktree.openSshTarget'

function readPref(key) {
  try { return localStorage.getItem(key) || '' } catch { return '' }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value) } catch {}
}

state.openMode = readPref(OPEN_MODE_KEY) === 'remote' ? 'remote' : 'local'
state.openSsh = readPref(OPEN_SSH_KEY)

function renderOpenMode() {
  const btn = $('btn-open-mode')
  const remote = state.openMode === 'remote'
  btn.textContent = `打开方式：${remote ? '远程' : '本机'}`
  btn.title = remote
    ? `VS Code / Zed / 终端在浏览器所在的电脑上打开（SSH ${state.openSsh || '未设置'}）`
    : '这些按钮调用这台服务器上的程序；浏览器不在服务器上时切到「远程」'
  btn.classList.toggle('remote', remote)
}

function setOpenMode(mode) {
  state.openMode = mode === 'remote' ? 'remote' : 'local'
  writePref(OPEN_MODE_KEY, state.openMode)
  renderOpenMode()
  toast(state.openMode === 'remote' ? '打开方式：远程（我的电脑，走 SSH）' : '打开方式：本机（服务器桌面）')
}

function openRemoteDialog() {
  const body = document.createElement('div')
  body.innerHTML = `
    <div class="field">
      <label>SSH 主机</label>
      <input class="input" id="remote-ssh" value="${esc(state.openSsh)}" placeholder="user@192.168.1.9 或 ~/.ssh/config 里的别名" autocomplete="off" spellcheck="false">
      <div class="hintline" id="remote-hint">这台电脑上 <code>ssh</code> 能直接用的名字。VS Code 用同一个名字走 Remote-SSH，命令里的 ssh 也用它。</div>
    </div>`

  const input = body.querySelector('#remote-ssh')
  const hint = body.querySelector('#remote-hint')
  const HINT = hint.textContent

  input.addEventListener('input', () => {
    hint.textContent = HINT
    hint.classList.remove('err')
  })

  return openModal({
    title: '远程打开设置',
    body,
    buttons: [
      { label: '取消' },
      {
        label: '保存',
        kind: 'primary',
        onClick: () => {
          const v = input.value.trim()
          if (!validSshTarget(v)) {
            hint.textContent = '只能填 ssh 能直接用的目标：字母、数字和 . _ - @ :，不要带空格或引号'
            hint.classList.add('err')
            input.focus()
            return false
          }
          state.openSsh = v
          writePref(OPEN_SSH_KEY, v)
          renderOpenMode()
          return true
        },
      },
    ],
  })
}

$('btn-open-mode').addEventListener('click', (e) => {
  const mark = (v) => (state.openMode === v ? '✓  ' : '')
  openRowMenu(e.currentTarget, [
    {
      label: `${mark('local')}本机（服务器桌面）`,
      onClick: () => setOpenMode('local'),
    },
    {
      label: `${mark('remote')}远程（我的电脑，走 SSH）`,
      onClick: () => {
        // 远程必须知道连哪台机器，没配过就直接弹配置框
        const needTarget = !state.openSsh
        setOpenMode('remote')
        if (needTarget) openRemoteDialog()
      },
    },
    { sep: true },
    { label: '设置 SSH 主机…', onClick: () => openRemoteDialog() },
  ])
})

renderOpenMode()

let rowMenuEl = null

function closeRowMenu() {
  if (rowMenuEl) { rowMenuEl.remove(); rowMenuEl = null }
  document.removeEventListener('mousedown', onRowMenuOutside, true)
  window.removeEventListener('scroll', closeRowMenu, true)
  window.removeEventListener('resize', closeRowMenu)
}

function onRowMenuOutside(e) {
  if (rowMenuEl && !rowMenuEl.contains(e.target)) closeRowMenu()
}

/**
 * 在按钮下方弹出菜单。
 * 用 fixed 定位挂到 body 上：表格容器是 overflow:auto，
 * 直接放在行里会被裁掉一半。
 */
function openRowMenu(anchor, items) {
  closeRowMenu()
  const el = document.createElement('div')
  el.className = 'row-menu'

  for (const it of items) {
    if (it.sep) {
      const sep = document.createElement('div')
      sep.className = 'row-menu-sep'
      el.appendChild(sep)
      continue
    }
    const btn = document.createElement('button')
    btn.className = 'row-menu-item' + (it.danger ? ' danger' : '')
    btn.disabled = Boolean(it.disabled)
    btn.title = it.title || ''
    const icon = document.createElement('span')
    icon.className = 'rmi-icon'
    icon.innerHTML = it.icon || ''
    const label = document.createElement('span')
    label.className = 'rmi-label'
    label.textContent = it.label
    btn.appendChild(icon)
    btn.appendChild(label)
    if (it.disabled && it.reason) {
      const why = document.createElement('span')
      why.className = 'rmi-why'
      why.textContent = it.reason
      btn.appendChild(why)
    }
    btn.addEventListener('click', () => {
      closeRowMenu()
      it.onClick()
    })
    el.appendChild(btn)
  }

  document.body.appendChild(el)

  const r = anchor.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  // 右对齐按钮，下方展开；下面放不下就翻到上方
  let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))
  let top = r.bottom + 4
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4)
  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`

  rowMenuEl = el
  // 延迟绑定：否则打开菜单的这一次点击会立刻把它关掉
  setTimeout(() => {
    document.addEventListener('mousedown', onRowMenuOutside, true)
    window.addEventListener('scroll', closeRowMenu, true)
    window.addEventListener('resize', closeRowMenu)
  }, 0)
}

/** 一行 worktree 能做的操作 */
function buildWtMenu(wt) {
  const blocked = wt.prunable
  const openTo = (target) => async () => {
    try {
      const r = await api('/api/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target, path: wt.path }),
      })
      if (!r.ok) toast(`打开失败：${r.error || ''}`, true)
    } catch (err) {
      toast(`打开失败：${err.message}`, true)
    }
  }

  const remote = state.openMode === 'remote'
  /** 远程模式：没配 SSH 目标就先弹配置，别让点下去只得到一条报错 */
  const withTarget = (fn) => () => {
    if (!state.openSsh) {
      toast('先设置 SSH 主机，例如 user@192.168.1.9', true)
      openRemoteDialog()
      return
    }
    fn(state.openSsh)
  }

  // 远程模式没有文件管理器：Windows 的资源管理器打不开 Linux 目录（除非另外配了 SMB）
  const openItems = remote
    ? [
        {
          icon: ROW_ICONS.vscode,
          label: '用 VS Code 远程打开',
          onClick: withTarget((ssh) => {
            // 自定义协议交给浏览器所在电脑处理，成功与否这边观察不到
            location.href = vscodeRemoteUri(ssh, wt.path)
          }),
        },
        {
          icon: ROW_ICONS.zed,
          label: '复制 Zed 远程命令',
          onClick: withTarget((ssh) => copyOrShow(zedRemoteCommand(ssh, wt.path), '已复制 Zed 远程命令')),
        },
        {
          icon: ROW_ICONS.terminal,
          label: '复制 SSH 登录命令',
          onClick: withTarget((ssh) => copyOrShow(sshCommand(ssh, wt.path), '已复制 SSH 登录命令')),
        },
      ]
    : [
        { icon: ROW_ICONS.vscode, label: '用 VS Code 打开', onClick: openTo('vscode') },
        { icon: ROW_ICONS.zed, label: '用 Zed 打开', onClick: openTo('zed') },
        { icon: ROW_ICONS.folder, label: '打开文件管理器', onClick: openTo('explorer') },
        { icon: ROW_ICONS.terminal, label: '在终端中打开', onClick: openTo('wt') },
      ]

  return [
    {
      icon: ROW_ICONS.branch,
      label: '切换分支',
      disabled: blocked,
      reason: blocked ? '目录不存在' : '',
      onClick: () => openCheckoutDialog(wt),
    },
    {
      icon: ROW_ICONS.pull,
      label: '拉取上游',
      disabled: blocked || wt.detached,
      reason: wt.detached ? '游离 HEAD' : blocked ? '目录不存在' : '',
      onClick: () => openPullDialog(wt),
    },
    { sep: true },
    ...openItems,
    { sep: true },
    {
      icon: ROW_ICONS.folder,
      label: '复制路径',
      onClick: () => copyOrShow(wt.path, '已复制路径'),
    },
    // UNC 只在 WSL 下有意义；纯 Linux 隐藏，避免误导
    ...(state.platform === 'wsl' && state.distro
      ? [{
          icon: ROW_ICONS.folder,
          label: '复制 Windows 路径',
          onClick: () => {
            copyOrShow(`\\\\wsl.localhost\\${state.distro}${wt.path.replace(/\//g, '\\')}`, '已复制 Windows 路径')
          },
        }]
      : []),
    { sep: true },
    // 主工作区不能删（删了等于删仓库本身），禁掉并说明原因
    {
      icon: ROW_ICONS.trash,
      label: '删除 worktree',
      danger: true,
      disabled: wt.isMain,
      reason: wt.isMain ? '主工作区' : '',
      onClick: () => openRemoveDialog(wt),
    },
  ]
}

$('wt-body').addEventListener('click', async (e) => {
  // 点分支名切日志；放在「更多」按钮判断之前，两者互不重叠
  const branchBtn = e.target.closest('.branch-link')
  if (branchBtn) {
    focusWorktree(branchBtn.closest('tr')?.dataset.path)
    return
  }
  const btn = e.target.closest('.icon-btn')
  if (!btn || btn.disabled) return
  const tr = btn.closest('tr')
  const path = tr.dataset.path
  const act = btn.dataset.act
  const wt = state.worktrees.find((w) => w.path === path)
  if (!wt) return

  if (act === 'menu') { openRowMenu(btn, buildWtMenu(wt)); return }
  if (act === 'checkout') return openCheckoutDialog(wt)
  if (act === 'pull') return openPullDialog(wt)
  if (act === 'remove') return openRemoveDialog(wt)
  if (act === 'copy') {
    await copyOrShow(path, '已复制路径')
    return
  }
  try {
    const r = await api('/api/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: act, path }) })
    if (!r.ok) toast(`打开失败: ${r.error || ''}`, true)
  } catch (err) {
    toast(`打开失败: ${err.message}`, true)
  }
})

// ---------- log ----------
/**
 * 取当前日志 worktree 的未提交改动摘要（只用来在日志顶部显示一行）。
 * 失败不影响日志本身，返回 null 就不显示那一行。
 */
async function loadPending() {
  if (!state.repo) return null
  // logWt 为 null 表示主工作树
  const wt = state.logWt || state.repo.toplevel
  if (!wt) return null
  try {
    const d = await api(`/api/repos/${state.repo.id}/commit/WORKTREE?wt=${encodeURIComponent(wt)}`)
    const files = d.files || []
    if (!files.length) return null
    return {
      wt,
      count: files.length,
      add: files.reduce((n, f) => n + (f.add || 0), 0),
      del: files.reduce((n, f) => n + (f.del || 0), 0),
      untracked: d.untracked || 0,
      noHead: Boolean(d.noHead),
    }
  } catch {
    return null
  }
}

let logSeq = 0

async function loadLog(reset = false) {
  if (!state.repo) return
  // 加载更多时直接吞掉重复触发；reset 可以打断在飞的请求（切 worktree / 刷新）
  if (!reset && (state.logLoading || !state.logHasMore)) return
  if (reset) {
    state.logSkip = 0
    state.commitsAll = []
    state.logHasMore = true
  }
  const seq = ++logSeq
  state.logLoading = true
  const body = $('log-body')
  const refreshBtn = $('btn-log-refresh')
  if (reset) {
    body.innerHTML = '<tr><td colspan="4" class="empty" style="padding:18px">加载中…</td></tr>'
    refreshBtn.classList.add('spinning')
  }
  try {
    const params = new URLSearchParams({
      rev: state.logRev,
      skip: String(state.logSkip),
      count: String(state.logCount),
    })
    if (state.logWt) params.set('wt', state.logWt)
    // 未提交改动和日志并行取：它只是顶部的一行提示，不该拖慢日志
    const [data, pending] = await Promise.all([
      api(`/api/repos/${state.repo.id}/log?${params}`),
      loadPending(),
    ])
    // 期间又切了 worktree / 点了刷新：丢弃过期响应，别把两次结果拼在一起
    if (seq !== logSeq) return
    state.pending = pending
    if (reset) state.commitsAll = data.commits
    else state.commitsAll = state.commitsAll.concat(data.commits)
    state.logSkip = state.commitsAll.length
    state.logHasMore = data.commits.length >= state.logCount
    // 把实际执行的 cwd 显示出来，方便确认看的是哪个 worktree
    $('log-meta').textContent = data.cwd ? data.cwd.replace(/^\/home\/[^/]+\//, '~/') : ''
    renderLog()
  } catch (err) {
    if (seq !== logSeq) return
    body.innerHTML = `<tr><td colspan="4" class="empty" style="color:var(--red)">${esc(err.message)}</td></tr>`
    $('log-meta').textContent = ''
    state.logHasMore = false
  } finally {
    if (seq === logSeq) {
      state.logLoading = false
      refreshBtn.classList.remove('spinning')
    }
  }
}

function renderLog() {
  const body = $('log-body')
  const filter = state.logFilter.toLowerCase()
  const commits = filter
    ? state.commitsAll.filter((c) =>
        c.sha.startsWith(filter) ||
        c.subject.toLowerCase().includes(filter) ||
        c.author.toLowerCase().includes(filter))
    : state.commitsAll

  const frag = document.createDocumentFragment()

  // 未提交的更改：只在实际有改动、且没在过滤时显示。
  // 过滤是在提交里搜关键字，插一行不属于任何提交的记录会让人以为它命中了。
  if (state.pending && !filter) {
    const p = state.pending
    const tr = document.createElement('tr')
    tr.className = 'log-pending' + (state.selectedSha === 'WORKTREE' ? ' selected' : '')
    tr.dataset.sha = 'WORKTREE'
    const stat = p.add || p.del
      ? `<span class="plus">+${p.add}</span> <span class="minus">−${p.del}</span>`
      : ''
    const newPart = p.untracked ? ` · 其中 ${p.untracked} 个新文件` : ''
    tr.innerHTML = `<td colspan="4">
      <span class="pending-dot" aria-hidden="true"></span>
      <span class="pending-label">未提交的更改</span>
      <span class="pending-stat">${p.count} 个文件${newPart}</span>
      <span class="pending-diff">${stat}</span>
    </td>`
    frag.appendChild(tr)
  }

  for (const c of commits) {
    const tr = document.createElement('tr')
    tr.dataset.sha = c.sha
    if (c.sha === state.selectedSha) tr.className = 'selected'
    const refsHtml = c.refs.map((r) => {
      const isHead = /^HEAD/.test(r)
      const isTag = /^tag:/.test(r)
      const cls = isHead ? 'ref-head' : isTag ? 'ref-tag' : 'ref-br'
      return `<span class="ref-tag ${cls}">${esc(r.replace(/^tag: /, '').replace(/^HEAD -> /, ''))}</span>`
    }).join('')
    tr.innerHTML = `
      <td><span class="sha" title="${c.sha}">${c.sha.slice(0, 7)}</span></td>
      <td class="time" title="${fmtTime(c.time)}">${relTime(c.time)}</td>
      <td class="author" title="${esc(c.email)}">${esc(c.author)}</td>
      <td class="subject" title="${esc(c.subject)}">${refsHtml ? refsHtml + ' ' : ''}${linkify(c.subject)}</td>`
    frag.appendChild(tr)
  }
  body.replaceChildren(frag)
  $('log-empty').hidden = commits.length > 0
  if (!commits.length) body.innerHTML = ''
}

$('log-body').addEventListener('click', (e) => {
  // 点的是提交信息里的外链：让它正常打开，不要顺带选中 commit
  // （置顶冒泡会让 <tr> 的处理也跑一遍，看起来像「点链接却跳了详情」）
  if (e.target.closest('a.ext-link')) return
  const tr = e.target.closest('tr[data-sha]')
  if (!tr) return
  selectCommit(tr.dataset.sha)
})

$('log-filter').addEventListener('input', (e) => {
  state.logFilter = e.target.value.trim()
  renderLog()
})

$('rev-select').addEventListener('change', (e) => {
  state.logRev = e.target.value
  loadLog(true)
})

$('btn-log-refresh').addEventListener('click', () => {
  if (state.repo) loadLog(true)
})

// 滚动到底部时继续加载下一页，替代原来的「加载更多」按钮
$('log-scroll').addEventListener('scroll', () => {
  if (!state.logHasMore || state.logLoading) return
  const el = $('log-scroll')
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 80) loadLog(false)
}, { passive: true })

// 全部展开后只画视口附近的 diff，滚到哪画到哪。
// 「改动文件」行吸到顶部时才露出文件下拉框。offsetTop 不随滚动变化，
// 只能比它和滚动容器的可视位置：message 还在上面时两者是错开的。
function syncFileJump() {
  const scroller = $('detail-body')
  const title = scroller.querySelector('.detail-sec-title')
  if (!title) return
  const stuck = scroller.scrollTop > 0
    && title.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 1
  title.classList.toggle('stuck', stuck)
  // 下拉框显示标题栏下面当前那一行的文件，而不是固定的占位文字
  const jump = title.querySelector('.file-jump')
  if (!jump || document.activeElement === jump) return
  const line = title.getBoundingClientRect().bottom + 1
  const row = [...scroller.querySelectorAll('.file-row')].find((el) => el.getBoundingClientRect().bottom > line)
  if (row) jump.value = row.dataset.path
}
$('detail-body').addEventListener('scroll', () => {
  syncFileJump()
  // 跳转对齐期间拆掉视口外的 diff 会让行的位置变矮，刚算好的滚动距离立刻失效
  if (!pinning) paintVisiblePatches()
}, { passive: true })

// ---------- commit detail ----------
async function selectCommit(sha) {
  const isPending = sha === 'WORKTREE'
  state.selectedSha = sha
  state.selectedFile = null
  // 上一个提交还在逐个展开的任务作废，别把 diff 写到新的详情里
  expandGen++
  syncFileTreeBtn()
  // 窄屏时把详情抽屉滑出（同步顶栏按钮状态，走同一个开关避免状态不一致）
  if (window.matchMedia('(max-width: 1180px)').matches && $('layout').classList.contains('hide-right')) {
    document.getElementById('toggle-right').click()
  }
  for (const tr of $('log-body').children) {
    tr.classList.toggle('selected', tr.dataset.sha === sha)
  }
  const c = isPending ? null : state.commitsAll.find((x) => x.sha === sha)
  if (isPending) {
    $('detail-title').textContent = '未提交'
    $('detail-meta').textContent = (state.pending?.wt || '').replace(/^\/home\/[^/]+\//, '~/')
  } else {
    $('detail-title').textContent = sha.slice(0, 7)
    $('detail-meta').textContent = c ? `${c.author} · ${fmtTime(c.time)}` : ''
  }
  $('detail-body').innerHTML = '<div class="empty">加载中…</div>'
  try {
    // 工作区的改动必须指定 worktree：主工作树和各 worktree 各有一份
    const q = isPending && state.pending?.wt ? `?wt=${encodeURIComponent(state.pending.wt)}` : ''
    const data = await api(`/api/repos/${state.repo.id}/commit/${sha}${q}`)
    state.detailFiles = data.files
    renderFileList(c, data.files, data)
  } catch (err) {
    $('detail-body').innerHTML = `<div class="empty" style="color:var(--red)">${esc(err.message)}</div>`
  }
}

function renderFileList(commit, files, detail = {}) {
  const body = $('detail-body')
  const frag = document.createDocumentFragment()

  if (commit) {
    // message 单独一块，不要用 section 标题的粘性样式：那会压住后面的文件列表。
    // 标题用日志里已有的 subject；正文只在详情接口里取，没有就只显示标题。
    const head = document.createElement('div')
    head.className = 'detail-msg'
    const subject = document.createElement('div')
    subject.className = 'detail-subject'
    // 提交信息里的外链要可点击（内部常用的 TAPD / Jira 链接）
    subject.innerHTML = linkify(detail.subject || commit.subject || '(无标题)')
    head.appendChild(subject)
    if (detail.body) {
      const msgBody = document.createElement('div')
      msgBody.className = 'detail-body-text'
      msgBody.innerHTML = linkify(detail.body)
      head.appendChild(msgBody)
    }
    frag.appendChild(head)

    const parents = detail.parents?.length ? detail.parents : commit.parents
    const meta = document.createElement('div')
    meta.className = 'detail-parents'
    meta.innerHTML = parents.length
      ? `父提交 ${parents.map((p) => `<span class="mono">${p.slice(0, 7)}</span>`).join(' ')}`
      : '初始提交'
    frag.appendChild(meta)
  }

  const sec = document.createElement('div')
  sec.className = 'detail-sec-title'
  const label = document.createElement('span')
  label.textContent = (state.selectedSha === 'WORKTREE' ? '未提交的文件' : '改动文件') + ` (${files.length})`
  sec.appendChild(label)
  if (files.length) {
    const actions = document.createElement('span')
    actions.className = 'detail-sec-actions'
    actions.appendChild(fileFoldBtn('expand', '全部展开'))
    actions.appendChild(fileFoldBtn('collapse', '全部收起'))
    sec.appendChild(actions)
    // 只在这一行吸到滚动容器顶部时显示：平时文件列表就在下面，不需要再选一次
    const jump = document.createElement('select')
    jump.className = 'select file-jump'
    jump.title = '切换文件'
    jump.setAttribute('aria-label', '切换文件')
    for (const f of files) {
      const opt = document.createElement('option')
      opt.value = f.path
      opt.textContent = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
      jump.appendChild(opt)
    }
    sec.appendChild(jump)
  }
  frag.appendChild(sec)

  if (!files.length) {
    const d = document.createElement('div')
    d.className = 'empty'
    d.textContent = '无文件改动'
    frag.appendChild(d)
  }

  for (const f of files) {
    const row = document.createElement('div')
    row.className = 'file-row'
    row.dataset.path = f.path
    const stat = f.binary
      ? '<span style="color:var(--text-faint)">bin</span>'
      : `<span class="plus">+${f.add}</span> <span class="minus">−${f.del}</span>`
    const label = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path
    // 行尾的「历史」图标：hover 才显形，避免干扰「点整行展开 diff」
    row.innerHTML = `<span class="file-caret" aria-hidden="true"></span>` +
      `<span class="file-path" title="${esc(label)}">${esc(f.path)}</span>` +
      `<span class="file-stat">${stat}</span>` +
      `<button class="file-hist-btn" title="查看该文件的提交历史（新标签页）" aria-label="文件历史">` +
      `<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">` +
      `<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/>` +
      `<path d="M8 4.8V8l2.2 1.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></button>`
    frag.appendChild(row)

    // diff 跟在自己的文件行下面，点一次展开、再点收起；多个文件可以同时展开
    const holder = document.createElement('div')
    holder.className = 'patch-holder'
    holder.hidden = true
    frag.appendChild(holder)
  }

  body.replaceChildren(frag)
}

/** 「改动文件」标题旁的展开/收起。chevrons 是编辑器里通用的折叠图标。 */
function fileFoldBtn(action, title) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'icon-btn file-fold-btn'
  btn.dataset.action = action
  btn.title = title
  btn.setAttribute('aria-label', title)
  btn.innerHTML = action === 'expand'
    ? '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M4.5 3.5 8 6.5 11.5 3.5M4.5 8.5 8 11.5 11.5 8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
      '<path d="M4.5 6.5 8 3.5 11.5 6.5M4.5 11.5 8 8.5 11.5 11.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  return btn
}

function collapseFile(rowEl) {
  const holder = rowEl.nextElementSibling
  if (!holder || !holder.classList.contains('patch-holder') || holder.hidden) return
  holder.hidden = true
  rowEl.classList.remove('open')
  if (state.selectedFile === rowEl.dataset.path) state.selectedFile = null
}

/** 展开一个文件的 diff。同一路径只拉一次。paint=false 时只占位，等滚进视口再画。 */
async function expandFile(rowEl, { paint = true, gen } = {}) {
  const holder = rowEl.nextElementSibling
  if (!holder || !holder.classList.contains('patch-holder')) return
  const path = rowEl.dataset.path
  rowEl.classList.add('open')
  holder.hidden = false
  state.selectedFile = path
  if (holder.dataset.loaded === path) {
    if (paint) paintHolder(holder)
    return
  }
  holder.dataset.loaded = ''
  holder.textContent = ''
  holder.appendChild(Object.assign(document.createElement('div'), { className: 'empty', textContent: '加载 diff…' }))
  try {
    // 未提交的 diff 要在具体 worktree 里跑
    const wtq = state.selectedSha === 'WORKTREE' && state.pending?.wt ? `&wt=${encodeURIComponent(state.pending.wt)}` : ''
    const data = await api(`/api/repos/${state.repo.id}/diff?sha=${state.selectedSha}&path=${encodeURIComponent(path)}${wtq}`)
    // 期间换了提交或点了全部收起：结果作废，别写进已经换掉的详情里
    if (!holder.isConnected || (gen !== undefined && gen !== expandGen)) return
    holder.dataset.patch = data.patch || ''
    holder.dataset.truncated = data.truncated ? '1' : ''
    holder.dataset.loaded = path
    holder.dataset.painted = ''
    if (paint) paintHolder(holder)
  } catch (err) {
    if (!holder.isConnected) return
    holder.textContent = ''
    const d = document.createElement('div')
    d.className = 'empty'
    d.style.color = 'var(--red)'
    d.textContent = err.message
    holder.appendChild(d)
  }
}

/** 视口外的大 diff 先不建 DOM，滚回来再画，避免一次展开把页面撑死。 */
function paintHolder(holder) {
  if (holder.dataset.painted === '1' || holder.dataset.loaded === '') return
  const box = renderPatch(holder.dataset.patch || '', holder.dataset.truncated === '1')
  holder.textContent = ''
  holder.appendChild(box)
  holder.dataset.painted = '1'
}

function releaseHolder(holder) {
  if (holder.dataset.painted !== '1') return
  holder.textContent = ''
  holder.dataset.painted = ''
}

/** 点文件行：已展开则收起，否则在该行下方展开 diff。 */
function toggleFile(rowEl) {
  const holder = rowEl.nextElementSibling
  if (holder && !holder.hidden) collapseFile(rowEl)
  else expandFile(rowEl)
}

// 全部展开按小批量拉：一个一个拉时，点下拉框跳到后面的文件要等前面全部回来。
// 同时画几百份 DOM 才会卡死，所以这里并发 4 个、只存文本不画。
// 换提交或点「全部收起」时 generation 加一，在飞的请求结果直接丢弃。
let expandGen = 0
let expandAllDone = Promise.resolve()
async function expandAllFiles() {
  const gen = ++expandGen
  let resolveDone
  expandAllDone = new Promise((r) => { resolveDone = r })
  try {
    const rows = [...$('detail-body').querySelectorAll('.file-row')]
    for (let i = 0; i < rows.length; i += 4) {
      if (gen !== expandGen) return
      await Promise.all(rows.slice(i, i + 4).map((row) => expandFile(row, { paint: false, gen })))
    }
    if (gen === expandGen) paintVisiblePatches()
  } finally {
    resolveDone()
  }
}

// 跳转对齐期间不能边滚边拆 DOM，否则行的位置一直变，算出来的滚动距离是旧的
let pinning = false
function paintVisiblePatches() {
  if (pinning) return
  const scroller = $('detail-body')
  const top = scroller.scrollTop
  const bottom = top + scroller.clientHeight
  const margin = scroller.clientHeight
  for (const holder of scroller.querySelectorAll('.patch-holder')) {
    if (holder.hidden || !holder.dataset.loaded) continue
    const y = holder.offsetTop
    const h = holder.offsetHeight || 24
    if (y + h < top - margin || y > bottom + margin) releaseHolder(holder)
    else paintHolder(holder)
  }
}

function setAllFiles(open) {
  expandGen++
  if (!open) {
    for (const row of $('detail-body').querySelectorAll('.file-row')) collapseFile(row)
    return
  }
  expandAllFiles()
}

/**
 * 把文件行滚到吸顶标题正下方。
 * 末尾几个文件滚不到那么靠上，滚动会被夹在底部。这时不能用夹住后的位置再算一次，
 * 否则差值又变成「要往上滚」，页面就跳回顶部了。滚不到就停在底部。
 */
function alignFileRow(row) {
  const scroller = $('detail-body')
  const title = scroller.querySelector('.detail-sec-title')
  const stuck = scroller.scrollTop > 0
    && title.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 1
  const titleH = stuck ? title.offsetHeight : title.scrollHeight
  const want = scroller.scrollTop
    + row.getBoundingClientRect().top
    - scroller.getBoundingClientRect().top
    - titleH
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
  const next = Math.max(0, Math.min(want, max))
  if (Math.abs(scroller.scrollTop - next) > 1) scroller.scrollTop = next
}

/** 吸顶后的下拉框：滚到该文件行并展开。滚完重置，下一次还能选同一个文件。 */
async function jumpToFile(path) {
  const scroller = $('detail-body')
  const row = [...scroller.querySelectorAll('.file-row')].find((el) => el.dataset.path === path)
  const jump = scroller.querySelector('.file-jump')
  if (!row) return
  pinning = true
  try {
  // 全部展开还在拉时，行的位置一直在变，等它拉完再对齐
  await expandAllDone
  if (!row.isConnected) return
  // 滚出视口的 diff 只留了占位，行的位置是矮的，按它算会停在半路。
  // 还在加载的只能用占位高度，画得动的先画回来。
  for (const holder of scroller.querySelectorAll('.patch-holder')) {
    if (!holder.hidden && holder.dataset.loaded) paintHolder(holder)
  }
  alignFileRow(row)
  await expandFile(row)
  // expandFile 在数据回来后才画 DOM，画完这一帧行的位置才稳定
  await new Promise((r) => requestAnimationFrame(r))
  alignFileRow(row)
  if (jump) jump.value = path
  } finally {
    pinning = false
    paintVisiblePatches()
  }
}

$('detail-body').addEventListener('change', (e) => {
  if (!e.target.classList.contains('file-jump')) return
  if (e.target.value) jumpToFile(e.target.value)
})

$('detail-body').addEventListener('click', (e) => {
  const foldBtn = e.target.closest('.file-fold-btn')
  if (foldBtn) {
    setAllFiles(foldBtn.dataset.action === 'expand')
    return
  }
  // 先判历史按钮：它在 .file-row 内部，不拦的话会同时触发展开 diff
  const histBtn = e.target.closest('.file-hist-btn')
  if (histBtn) {
    e.stopPropagation()
    const row = histBtn.closest('.file-row')
    if (row) openFileHistory(row.dataset.path)
    return
  }
  const row = e.target.closest('.file-row')
  if (row) toggleFile(row)
})

// ---------- 文件历史（新标签页） ----------
/**
 * 打开单文件历史页。
 * wt 参数必须带上：--follow 和 diff 都要在确定的 worktree 里执行，
 * 且要跟日志区当前选择的 worktree 保持一致，否则「在哪个分支上看历史」会不一致。
 *
 * focus=1：让历史页打开后把焦点放进顶栏的路径输入框（用户可以直接搜别的文件）。
 * 没有已选文件时也要能开——历史页会以当前仓库根为起点，路径框可搜全部文件。
 */
function openFileHistory(path, { focus = false } = {}) {
  if (!state.repo) {
    toast('先选择一个仓库', true)
    return
  }
  const params = new URLSearchParams({ repo: state.repo.id })
  const target = path || state.selectedFile
  if (target) params.set('path', target)
  const wt = state.logWt || state.worktrees?.find((w) => w.isMain)?.path || state.repo.toplevel
  if (wt) params.set('wt', wt)
  if (focus) params.set('focus', '1')
  window.open(`/history.html?${params}`, '_blank', 'noopener')
}

// 顶栏右上角按钮：不依赖是否已选中文件，焦点自动进入路径输入框
$('btn-settings').addEventListener('click', () => {
  window.open('/settings.html', '_blank', 'noopener')
})

$('btn-file-history').addEventListener('click', () => {
  openFileHistory(null, { focus: true })
})

// ---------- 完整文件树（新标签页） ----------
/**
 * 打开某提交的完整文件树。
 * 与「改动文件」不同，这是整仓库在该提交时的快照（ls-tree）。
 * path 可选：有值时定位到该文件，方便从文件行直接跳过去看上下文。
 */
function openFileTree(sha, path) {
  if (!state.repo || !sha) return
  const params = new URLSearchParams({ repo: state.repo.id, sha })
  const wt = state.logWt || state.worktrees?.find((w) => w.isMain)?.path || state.repo.toplevel
  if (wt) params.set('wt', wt)
  if (path) params.set('path', path)
  window.open(`/tree.html?${params}`, '_blank', 'noopener')
}

$('btn-file-tree').addEventListener('click', () => {
  if (!state.selectedSha) return
  // 带上当前选中的文件，进去就能看到它在整个仓库里的位置
  openFileTree(state.selectedSha, state.selectedFile || null)
})

/** 「文件树」按钮只在选中了 commit 时出现 */
function syncFileTreeBtn() {
  const btn = $('btn-file-tree')
  if (!btn) return
  btn.hidden = !state.selectedSha
}

$('detail-close').addEventListener('click', () => setPanel('right', false))

/** diff --git / index / --- / +++ 这些头部命令行对看改动没有用，展开后只留 hunk 和增删行 */
function isDiffHeader(line) {
  return line.startsWith('diff ') || line.startsWith('index ') ||
    line.startsWith('---') || line.startsWith('+++') ||
    line.startsWith('new file') || line.startsWith('deleted file') ||
    line.startsWith('similarity') || line.startsWith('rename ') ||
    line.startsWith('old mode') || line.startsWith('new mode') ||
    line.startsWith('Binary files')
}

function renderPatch(patch, truncated) {
  const box = document.createElement('pre')
  box.className = 'patch'
  const lines = (patch || '').split('\n').filter((line) => !isDiffHeader(line))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  if (!lines.length) {
    box.innerHTML = '<span class="meta">(无内容，可能是二进制文件或纯重命名)</span>'
    return box
  }
  const frag = document.createDocumentFragment()
  for (const line of lines) {
    const span = document.createElement('span')
    if (line.startsWith('@@')) span.className = 'hunk'
    else if (line.startsWith('+')) span.className = 'add'
    else if (line.startsWith('-')) span.className = 'del'
    else span.className = 'ctx'
    span.textContent = line + '\n'
    frag.appendChild(span)
  }
  if (truncated) {
    const t = document.createElement('span')
    t.className = 'meta'
    t.textContent = '\n… diff 过大已截断'
    frag.appendChild(t)
  }
  box.appendChild(frag)
  return box
}

// ---------- topbar ----------
$('btn-refresh').addEventListener('click', async () => {
  await loadRepos(true)
  if (state.repo) await selectRepo(state.repo.toplevel, true)
})
$('repo-search').addEventListener('input', renderRepos)

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, select, textarea')) return
  if (e.target instanceof Element && e.target.isContentEditable) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (!$('modal').hidden) return
  if (e.key === 'r') { e.preventDefault(); $('btn-refresh').click() }
  if (e.key === '/') {
    e.preventDefault()
    // 左栏收起时先展开再聚焦。
    // 注意：layoutState 在本文件后面才声明（const，有 TDZ），
    // 左栏收起时不要强行展开，直接聚焦顶栏的仓库切换器（更好的交互：不改变布局）
    if ($('layout').classList.contains('hide-left')) {
      $('top-repo-input')?.focus()
    } else {
      $('repo-search').focus()
    }
  }
})

// ---------- init ----------
async function init() {
  try {
    const cfg = await api('/api/config')
    state.roots = cfg.roots || []
    state.platform = cfg.platform || 'linux'
    state.distro = cfg.distro || ''
    $('roots').textContent = cfg.roots.join(', ')
  } catch {}
  await loadRepos()

  if (!state.repos.length) return

  const restored = pickRestoreTarget()
  if (restored) {
    await selectRepo(restored)
    // hash 里的仓库不存在（比如仓库被删了）时，把 hash 纠正为实际选中的
    const hashTarget = readRepoFromHash()
    if (hashTarget && hashTarget !== restored) rememberRepo(restored)
    return
  }

  // 没有历史记录：选第一个可用仓库
  if (!state.repo) {
    const first = state.repos.find((r) => !r.error) || state.repos[0]
    if (first) await selectRepo(first.toplevel)
  }
}

// 用户手改 hash 或从收藏夹进来（hashchange）时跟着切换。
// 只处理 repo= 形式，其它 hash 忽略。
window.addEventListener('hashchange', () => {
  const target = readRepoFromHash()
  if (!target) return
  if (state.repo?.toplevel === target) return
  if (!state.repos.some((r) => r.toplevel === target)) return
  selectRepo(target)
})

init()

// ============================================================
// 对话框基座
// ============================================================
let modalResolve = null

function closeModal(result = null) {
  $('modal').hidden = true
  const r = modalResolve
  modalResolve = null
  if (r) r(result)
}

$('modal-close').addEventListener('click', () => closeModal(null))
$('modal').addEventListener('mousedown', (e) => {
  if (e.target === $('modal')) closeModal(null)
})

/**
 * 打开对话框。
 * @param {{title, body: string|HTMLElement, buttons: Array, wide?: boolean, onMount?: Function}} opt
 * buttons: [{ label, kind: 'primary'|'danger'|'', id?, disabled?, onClick?(ctx) }]
 */
function openModal(opt) {
  return new Promise((resolve) => {
    modalResolve = resolve
    $('modal-title').textContent = opt.title
    $('modal-box').className = 'modal' + (opt.wide ? ' wide' : '')

    const body = $('modal-body')
    body.replaceChildren()
    if (typeof opt.body === 'string') body.innerHTML = opt.body
    else if (opt.body) body.appendChild(opt.body)

    const foot = $('modal-foot')
    foot.replaceChildren()
    const ctx = { close: closeModal, body, foot, setBusy }

    for (const b of opt.buttons || []) {
      if (b.type === 'left') {
        const span = document.createElement('span')
        span.className = 'left'
        span.innerHTML = b.html || ''
        foot.appendChild(span)
        continue
      }
      const btn = document.createElement('button')
      btn.className = `btn ${b.kind || ''}`.trim()
      btn.textContent = b.label
      if (b.id) btn.id = b.id
      if (b.disabled) btn.disabled = true
      btn.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(ctx)
          if (r !== false) closeModal(r ?? true)
        } else {
          closeModal(true)
        }
      })
      foot.appendChild(btn)
    }

    $('modal').hidden = false
    if (opt.onMount) opt.onMount(ctx)

    // 自动聚焦第一个输入框
    const first = body.querySelector('input, textarea, select')
    if (first) first.focus()
  })
}

function setBusy(btn, busy, label) {
  if (!btn) return
  btn.disabled = busy
  if (busy) {
    btn.dataset.label = btn.textContent
    btn.innerHTML = `<span class="spinner"></span> ${label || '处理中…'}`
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label
  }
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('modal').hidden) { e.preventDefault(); closeModal(null) }
})

// ============================================================
// 写操作 API
// ============================================================
async function act(path, body) {
  const res = await fetch(`/api/repos/${state.repo.id}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, ...data }
}

async function refreshAfterWrite() {
  if (!state.repo) return
  await loadWorktrees(true)
  if (state.logWt) await loadLog(true)
  // 顶栏统计也可能是旧的
  loadRepos()
}

// ============================================================
// 1. 更新仓库（fetch）
// ============================================================
$('btn-fetch').addEventListener('click', async () => {
  if (!state.repo) return
  await runFetch({ forceTags: false })
})

// 打开对比页：默认对比所选提交与其父提交（没选就用 HEAD~1..HEAD）
$('btn-compare').addEventListener('click', () => {
  if (!state.repo) return
  const b = state.selectedSha || 'HEAD'
  const a = state.selectedSha ? `${state.selectedSha}~1` : 'HEAD~1'
  const url = `/compare.html?repo=${encodeURIComponent(state.repo.id)}&a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`
  window.open(url, '_blank')
})

async function runFetch({ forceTags = false } = {}) {
  if (!state.repo) return
  const btn = $('btn-fetch')
  setBusy(btn, true, 'fetch 中…')
  let r
  try {
    r = await act('fetch', { prune: true, forceTags })
  } finally {
    setBusy(btn, false)
  }
  await refreshAfterWrite()

  // ---- 失败 ----
  if (!r.ok) {
    openModal({
      title: '更新失败',
      body: `<div class="note danger">${
        r.authFailed
          ? '认证失败。可能是 SSH key 或账号凭据过期，先在终端里手动 fetch 一次确认。'
          : 'fetch 失败，分支和 tag 都没能更新。'
      }</div>
      <div class="filelist">${esc((r.error || '').slice(-3000))}</div>`,
      buttons: [{ label: '关闭' }],
    })
    return
  }

  const nUpd = r.updated?.length || 0
  const conflicts = r.tagConflicts || []

  // ---- 完全成功，无 tag 冲突 ----
  if (conflicts.length === 0) {
    toast(nUpd ? `已更新 ${nUpd} 个引用` : '已是最新，无更新')
    if (nUpd) {
      openModal({
        title: `更新完成 · ${state.repo.name}`,
        body: `<div class="note ok">以下引用有更新：</div>
               <div class="filelist">${r.updated.map((l) => esc(l)).join('\n')}</div>`,
        buttons: [{ label: '知道了', kind: 'primary' }],
      })
    }
    return
  }

  // ---- 部分成功：分支已更新，但有 tag 被远端重打 ----
  toast(`分支已更新，${conflicts.length} 个 tag 因远端重打而未同步`, true)

  // 拉出每个 tag 的本地/远端 commit，让用户能判断
  const detail = await Promise.all(
    conflicts.map(async (c) => {
      try {
        const info = await act('tag-inspect', { tag: c.tag })
        return { tag: c.tag, localSha: info.localSha, remoteSha: info.remoteSha }
      } catch {
        return { tag: c.tag, localSha: null, remoteSha: null }
      }
    })
  )

  const rows = detail.map((d) => `
    <tr>
      <td><span class="mono">${esc(d.tag)}</span></td>
      <td><span class="mono sha">${d.localSha ? d.localSha.slice(0, 8) : '—'}</span></td>
      <td><span class="mono sha">${d.remoteSha ? d.remoteSha.slice(0, 8) : '—'}</span></td>
    </tr>`).join('')

  const body = document.createElement('div')
  body.innerHTML = `
    <div class="note warn">
      <strong>分支已经更新完成</strong>，但有 ${conflicts.length} 个 tag 在远端被重新指向了别的提交，
      本地同名 tag 与之不同 —— git 默认拒绝覆盖，所以这些 tag 保持原样。
    </div>
    <table class="stale-tbl" style="table-layout:auto">
      <thead><tr><th>tag</th><th>本地指向</th><th>远端指向</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="field" style="margin-top:14px">
      <label>要不要用远端的 tag 覆盖本地？</label>
      <div class="hintline">
        tag 被重打通常说明发布流程出了问题。覆盖后本地这个 tag 会指向新提交，
        已经基于旧 tag 构建的产物就对不上了。除非你确认远端是对的，否则建议保留本地，去问一下发版的人。
      </div>
    </div>
    ${nUpd ? `<div class="field"><label>本次已更新的引用</label>
      <div class="filelist">${r.updated.map((l) => esc(l)).join('\n')}</div></div>` : ''}`

  await openModal({
    title: `tag 冲突 · ${state.repo.name}`,
    body,
    wide: true,
    buttons: [
      { label: '保留本地 tag', kind: 'primary' },
      {
        label: '用远端覆盖',
        kind: 'danger',
        onClick: async (ctx) => {
          const b = ctx.foot.querySelector('.btn.danger')
          setBusy(b, true, '强制更新中…')
          try {
            const r2 = await act('fetch', { prune: true, forceTags: true })
            setBusy(b, false)
            await refreshAfterWrite()
            if (r2.ok) {
              toast('已用远端 tag 覆盖本地')
              return true
            }
            body.insertAdjacentHTML('afterbegin',
              `<div class="note danger">强制更新失败：${esc((r2.error || '').slice(0, 800))}</div>`)
            return false
          } catch (e) {
            setBusy(b, false)
            body.insertAdjacentHTML('afterbegin', `<div class="note danger">${esc(String(e.message))}</div>`)
            return false
          }
        },
      },
    ],
  })
}

// ============================================================
// 2. 更新分支（pull） / 3. 切换分支（checkout）
// 都针对某个具体 worktree，从行操作按钮进入
// ============================================================
async function openPullDialog(wt) {
  const wtName = wt.path.replace(/^\/home\/[^/]+\//, '~/')
  const body = document.createElement('div')
  body.innerHTML = `
    <dl class="kv">
      <dt>worktree</dt><dd>${esc(wt.path)}</dd>
      <dt>分支</dt><dd>${esc(wt.branch || '(detached)')}</dd>
    </dl>
    <div class="field">
      <label>合并方式</label>
      <div class="seg" id="pull-mode">
        <button data-v="ff-only" class="on">仅快进（推荐）</button>
        <button data-v="rebase">变基</button>
      </div>
      <div class="hintline" id="pull-hint">只在能快进时更新，无法快进会直接失败，最安全。</div>
    </div>
    <div id="pull-result"></div>`

  const HINTS = {
    'ff-only': '只在能快进时更新，无法快进会直接失败，最安全。',
    rebase: '把本地提交挪到远程之上，历史保持线性。会产生新 commit hash。',
  }

  // 一旦 pull 成功，主按钮就该退出「可执行」状态：
  // 否则会出现「输出已经说已是最新，按钮还亮着蓝底」，让人以为没成功、
  // 或者以为还要再点一次。
  let done = false

  await openModal({
    title: `更新分支 · ${wt.branch || 'detached'}`,
    body,
    buttons: [
      { type: 'left', html: `git pull` },
      { label: '取消' },
      {
        label: '开始更新',
        kind: 'primary',
        onClick: async (ctx) => {
          // 已完成：这个按钮现在叫「关闭」，点它就是关掉对话框
          if (done) return true

          // 注意：底栏第一个 .btn 是「取消」，主按钮要靠 .primary 定位
          const btn = ctx.foot.querySelector('.btn.primary')
          const cancelBtn = ctx.foot.querySelector('.btn:not(.primary)')
          const mode = body.querySelector('#pull-mode .on')?.dataset.v || 'ff-only'
          setBusy(btn, true, 'pull 中…')
          const r = await act('pull', { wt: wt.path, mode })
          setBusy(btn, false)
          await refreshAfterWrite()

          if (r.ok) {
            done = true
            const changed = r.changed !== false
            if (changed) {
              const n = r.incoming || 0
              body.querySelector('#pull-result').innerHTML =
                `<div class="note ok">更新完成，拉取了 <strong>${n}</strong> 个提交（${esc(r.mode)}）· 上游 <code>${esc(r.upstream)}</code></div>` +
                `<div class="filelist">${esc((r.output || '').slice(-1500))}</div>`
            } else {
              // 「已是最新」不是失败，但也不该看起来像刚做成一件事
              body.querySelector('#pull-result').innerHTML =
                `<div class="note">已经是最新，没有需要更新的提交（${esc(r.mode)}）· 上游 <code>${esc(r.upstream)}</code></div>` +
                `<div class="filelist">${esc((r.output || '').slice(-1200))}</div>`
            }
            // 主按钮退场：去掉 primary 高亮 + 改文案，避免误以为还要再点
            btn.textContent = '关闭'
            btn.className = 'btn'
            btn.dataset.label = '关闭'
            // 取消按钮此时多余，隐藏
            if (cancelBtn) cancelBtn.hidden = true
            // 合并方式也不该再改（改了也不会生效）
            const seg = body.querySelector('#pull-mode')
            if (seg) seg.classList.add('disabled')
            return false // 留在对话框让用户看结果
          }

          const reasonText = {
            'no-upstream': '当前分支没有上游分支，无法 pull。可先用「切换分支」切到有跟踪的分支。',
            diverged: '本地和远程已分叉，无法快进。可以改用「变基」方式。',
            conflict: '出现冲突。请到终端处理：<code>git status</code> 查看冲突文件，解决后 <code>git rebase --continue</code> 或 <code>git merge --continue</code>，也可 <code>--abort</code> 放弃。',
            failed: 'pull 失败',
          }[r.reason] || 'pull 失败'

          body.querySelector('#pull-result').innerHTML =
            `<div class="note danger">${reasonText}</div>` +
            (r.error ? `<div class="filelist">${esc(r.error.slice(-2000))}</div>` : '')
          return false
        },
      },
    ],
    onMount: () => {
      const seg = body.querySelector('#pull-mode')
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]')
        if (!b) return
        for (const x of seg.children) x.classList.toggle('on', x === b)
        body.querySelector('#pull-hint').textContent = HINTS[b.dataset.v]
      })
    },
  })
}

/**
 * dirty 冲突时的出口：告知会丢什么，并允许「放弃本地改动强制切换」。
 *
 * 用二次点击（arm）而不是直接执行：切分支丢改动不可撤销，一次误点的代价太大。
 * 5 秒内没有第二次点击就自动复位，避免长期停在「待确认」状态下被误触。
 */
function renderDirtyConflict(r, container, runCheckout) {
  const files = Array.isArray(r.dirtyFiles) ? r.dirtyFiles : []
  const CODE_LABEL = {
    M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', T: '类型变更', '?': '未跟踪',
  }
  const fileLines = files.map((f) => {
    const c = (f.code || '').trim()
    const label = CODE_LABEL[c[0]] || c || '改动'
    return `${esc(f.path)}   ${esc(label)}`
  }).join('\n')

  container.innerHTML = `
    <div class="note danger">
      工作区有 <strong>${files.length}</strong> 个文件有未提交的改动，直接切换会被它们挡住。
      强制切换会<strong>丢弃这些改动，且无法恢复</strong>。
      如果要保留，请先提交或 <code>git stash</code>。
    </div>
    ${files.length ? `
      <div class="field">
        <label>会被丢弃的改动（共 ${files.length} 个文件）</label>
        <div class="filelist">${fileLines}</div>
      </div>` : ''}
    <div class="field co-force-row">
      <button class="btn danger" id="co-force">放弃这些改动并切换</button>
      <span class="hintline co-force-hint">需要点击两次确认</span>
    </div>`

  const btn = container.querySelector('#co-force')
  let armed = false
  let timer = null

  const disarm = () => {
    armed = false
    clearTimeout(timer)
    timer = null
    btn.textContent = '放弃这些改动并切换'
    btn.classList.remove('armed')
  }

  btn.addEventListener('click', async () => {
    if (btn.disabled) return
    if (!armed) {
      armed = true
      btn.textContent = '确认放弃改动？再点一次'
      btn.classList.add('armed')
      timer = setTimeout(disarm, 5000)
      return
    }
    disarm()
    btn.disabled = true
    const rr = await runCheckout(btn, true)
    if (rr === 'ok') {
      closeModal(true)
      return
    }
    btn.disabled = false
    container.insertAdjacentHTML('beforeend',
      `<div class="note danger" style="margin-top:8px">强制切换仍然失败：${esc((rr.error || '').slice(0, 600))}</div>`)
  })
}

async function openCheckoutDialog(wt) {
  const body = document.createElement('div')
  body.innerHTML = `
    <dl class="kv">
      <dt>worktree</dt><dd>${esc(wt.path)}</dd>
      <dt>当前分支</dt><dd>${esc(wt.branch || '(detached)')}</dd>
    </dl>
    <div class="field">
      <label>目标分支 / tag</label>
      <input class="input" id="co-filter" placeholder="搜索分支或 tag…" autocomplete="off">
      <div id="co-list" class="branch-pick" style="height:300px;overflow:auto;margin-top:6px;border:1px solid var(--border);border-radius:5px"></div>
      <div class="hintline"><span id="co-picked" style="color:var(--accent)"></span> 点一行即选中；「占用」表示该分支已被别的 worktree 检出，不能再切。</div>
    </div>
    <div class="field">
      <label>或切到指定提交（detached 状态）</label>
      <input class="input" id="co-detach" placeholder="tag / 分支名 / commit sha，留空则不使用" autocomplete="off" spellcheck="false">
      <div class="hintline">切到 tag 或 commit 后会处于 detached 状态（不算在任何分支上）。输入框可模糊搜索 tag 和分支。</div>
    </div>
    <div id="co-result"></div>`

  let picked = null
  let branches = { local: [], remote: [], tags: [] }
  let detachAC = null

  /** 是否为 tag 选中（tag 与分支走不同的后端参数） */
  let pickedKind = null

  const renderList = (filter = '') => {
    const box = body.querySelector('#co-list')
    const f = filter.trim()
    const match = (b) => {
      if (!f) return true
      return fuzzyScore(f, b.name) != null
    }
    const locals = branches.local.filter(match)
    const remotes = branches.remote.filter(match)
    const tags = branches.tags.filter(match)

    if (!locals.length && !remotes.length && !tags.length) {
      box.innerHTML = '<div class="empty" style="padding:14px">无匹配分支或 tag</div>'
      return
    }

    box.replaceChildren()

    /** 点击行：统一处理「选中了什么」 */
    const bindPick = (row, { value, kind, label }) => {
      row.addEventListener('click', () => {
        for (const x of box.querySelectorAll('.branch-row')) x.classList.toggle('sel', x === row)
        picked = value
        pickedKind = kind
        body.querySelector('#co-detach').value = ''
        if (detachAC) detachAC.close()
        const tip = body.querySelector('#co-picked')
        if (tip) {
          tip.textContent = kind === 'tag'
            ? `已选 tag：${label}（将以 detached 状态检出）`
            : `已选：${label}`
        }
      })
    }

    const addGroup = (title, list) => {
      if (!list.length) return
      const g = document.createElement('div')
      g.className = 'branch-group'
      g.textContent = `${title} (${list.length})`
      box.appendChild(g)
      for (const b of list) {
        const isTag = b.kind === 'tag'
        const occupiedByOther = !isTag && b.owner && b.owner.replace(/\/+$/, '') !== wt.path.replace(/\/+$/, '')
        const row = document.createElement('div')
        row.className = 'branch-row' + (occupiedByOther ? ' busy' : '') + (b.isHead ? ' is-head' : '') + (isTag ? ' is-tag' : '')
        row.dataset.name = b.name
        row.innerHTML = `
          <span class="mono">${esc(b.name)}</span>
          ${b.isHead ? '<span class="pill main">当前</span>' : ''}
          ${isTag ? `<span class="mono sha" style="font-size:10.5px;color:var(--text-faint)">${esc((b.sha || '').slice(0, 7))}</span>` : ''}
          ${isTag ? `<span class="pill ${b.annotated ? 'tag' : 'tag-light'}">${b.annotated ? 'tag' : '轻量 tag'}</span>` : ''}
          ${occupiedByOther ? `<span class="pill locked" title="已被 ${esc(b.owner)} 检出">占用</span>` : ''}
          <span class="branch-time">${b.time ? relTime(b.time) : ''}</span>`
        if (!occupiedByOther && !b.isHead) {
          bindPick(row, { value: b.name, kind: isTag ? 'tag' : 'branch', label: b.name })
        }
        box.appendChild(row)
      }
    }
    // tag 放在最前：远程分支动辄上百条，把 tag 挤到最下面基本等于看不见
    if (f) {
      addGroup('tag', tags.slice(0, 60))
    } else {
      addGroup('tag（最近 30 个，输入可搜全部）', tags.slice(0, 30))
    }
    addGroup('本地分支', locals)
    addGroup('远程分支', remotes)
  }

  /**
   * 执行一次切换。
   * @param force true 时带 force:true，后端会 `checkout -f` 丢弃本地改动
   * @returns 'ok' | 失败结果对象
   */
  const runCheckout = async (btn, force) => {
    const detach = body.querySelector('#co-detach').value.trim()
    // tag 一律走 detachAt（detached 检出）；分支走 branch
    const payload = detach
      ? { wt: wt.path, detachAt: detach }
      : pickedKind === 'tag'
        ? { wt: wt.path, detachAt: picked }
        : { wt: wt.path, branch: picked }
    if (force) payload.force = true

    setBusy(btn, true, force ? '强制切换中…' : '切换中…')
    const r = await act('checkout', payload)
    setBusy(btn, false)
    await refreshAfterWrite()

    if (r.ok) {
      toast(r.branch === 'HEAD' ? '已 detached 检出' : `已切到 ${r.branch}`)
      return 'ok'
    }
    return r
  }

  await openModal({
    title: '切换分支',
    body,
    wide: true,
    buttons: [
      { label: '取消' },
      {
        label: '切换',
        kind: 'primary',
        onClick: async (ctx) => {
          const btn = ctx.foot.querySelector('.btn.primary')
          const detach = body.querySelector('#co-detach').value.trim()
          if (!picked && !detach) {
            body.querySelector('#co-result').innerHTML = '<div class="note warn">请选择分支 / tag，或填写提交</div>'
            return false
          }

          const r = await runCheckout(btn, false)
          if (r === 'ok') return true

          const result = body.querySelector('#co-result')

          // 本地有未提交改动：给「强制切换（放弃本地变更）」的出口。
          // 这是破坏性操作，所以要把「会丢哪些文件」明确列出来，并且要求二次点击确认。
          if (r.reason === 'dirty-conflict') {
            renderDirtyConflict(r, result, runCheckout)
            return false
          }

          const reasonText = {
            'branch-in-use': `该分支已被别的 worktree 占用：<code>${esc(r.ownerPath || '')}</code>。要到那个 worktree 里去用，或先删掉它。`,
            'ref-not-found': '找不到这个 tag / 分支 / 提交。',
            failed: '切换失败',
          }[r.reason] || '切换失败'
          result.innerHTML =
            `<div class="note danger">${reasonText}</div>` +
            (r.error ? `<div class="filelist">${esc(r.error.slice(-1500))}</div>` : '')
          return false
        },
      },
    ],
    onMount: async () => {
      const listBox = body.querySelector('#co-list')
      listBox.innerHTML = '<div class="empty" style="padding:14px">加载分支…</div>'
      try {
        // 带上 wt：让「当前分支」标的是这个 worktree 的，而不是主工作树的。
        // 主工作树 detached 时，不传就完全看不出当前在哪。
        const data = await api(`/api/repos/${state.repo.id}/branches?wt=${encodeURIComponent(wt.path)}`)
        branches = { local: data.local || [], remote: data.remote || [], tags: data.tags || [] }
        renderList()
      } catch (err) {
        listBox.innerHTML = `<div class="empty" style="color:var(--red)">${esc(err.message)}</div>`
      }
      body.querySelector('#co-filter').addEventListener('input', (e) => renderList(e.target.value))

      // 「切到指定提交」输入框：可搜索 tag / 分支 / sha
      const detachInput = body.querySelector('#co-detach')
      detachAC = attachAutocomplete(detachInput, {
        getItems: () => [
          ...branches.tags.map((t) => ({
            value: t.name,
            label: t.name,
            right: relTime(t.time),
            badge: t.annotated ? 'tag' : '轻量',
            raw: t,
          })),
          ...branches.local.map((b) => ({
            value: b.name,
            label: b.name,
            right: relTime(b.time),
            badge: '本地',
            badgeKind: 'main',
            raw: b,
          })),
        ],
        emptyHint: '没有匹配的 tag 或分支',
        onPick: (item) => {
          // 从自动完成选了东西，清掉列表里的选中状态，避免两个来源打架
          picked = null
          pickedKind = null
          for (const x of body.querySelectorAll('.branch-row')) x.classList.remove('sel')
          const tip = body.querySelector('#co-picked')
          if (tip) tip.textContent = ''
        },
      })

      detachInput.addEventListener('input', (e) => {
        if (e.target.value.trim()) {
          picked = null
          pickedKind = null
          for (const x of body.querySelectorAll('.branch-row')) x.classList.remove('sel')
          const tip = body.querySelector('#co-picked')
          if (tip) tip.textContent = ''
        }
      })
    },
  })
}

// ============================================================
// 4. 创建 worktree
// ============================================================
$('btn-new-wt').addEventListener('click', async () => {
  if (!state.repo) return
  const repoName = state.repo.name
  const repoParent = state.repo.toplevel.replace(/\/[^/]+$/, '')

  const body = document.createElement('div')
  body.innerHTML = `
    <div class="field">
      <label>创建方式</label>
      <div class="seg" id="nw-mode">
        <button data-v="new" class="on">新分支</button>
        <button data-v="existing">现有分支</button>
        <button data-v="remote">远程分支</button>
        <button data-v="tag">基于 tag</button>
        <button data-v="detach">指定提交</button>
      </div>
    </div>
    <div class="field" id="nw-branch-field">
      <label id="nw-branch-label">分支名</label>
      <input class="input" id="nw-branch" placeholder="feature/my-task" autocomplete="off" spellcheck="false">
      <div class="hintline" id="nw-branch-hint">基于下方起点新建分支。可用 / 分层。</div>
    </div>
    <div class="field" id="nw-base-field">
      <label id="nw-base-label">起点</label>
      <input class="input" id="nw-base" value="HEAD" autocomplete="off" spellcheck="false">
      <div class="hintline" id="nw-base-hint">可以是分支名、tag 或 commit sha。默认当前 HEAD。</div>
    </div>
    <div class="field" id="nw-tag-branch-field" hidden>
      <label class="checkline" style="padding:0">
        <input type="checkbox" id="nw-tag-mkbranch">
        <span>同时创建一个新分支（否则以 detached 状态检出）</span>
      </label>
      <input class="input" id="nw-tag-branch" placeholder="从该 tag 拉出的新分支名" autocomplete="off" spellcheck="false" hidden style="margin-top:8px">
    </div>
    <div class="field">
      <label>目标路径</label>
      <input class="input" id="nw-path" autocomplete="off" spellcheck="false">
      <div class="hintline" id="nw-path-hint">按分支名自动生成，可手改。必须是绝对路径且不存在。</div>
    </div>
    <div id="nw-result"></div>`

  const MODE_CFG = {
    new: {
      label: '分支名（新建）',
      hint: '基于下方起点新建分支。可用 / 分层。输入时会模糊匹配已有分支名，避免重名。',
      showBase: true,
      placeholder: 'feature/my-task',
      baseLabel: '起点',
      baseHint: '可以是分支名、tag 或 commit sha。默认当前 HEAD。',
      source: 'local',
    },
    existing: {
      label: '选择本地分支',
      hint: '该分支不能被其它 worktree 占用。输入可模糊匹配。',
      showBase: false,
      placeholder: 'feature/existing',
      source: 'local',
    },
    remote: {
      label: '远程分支',
      hint: '输入可模糊匹配远程分支（会自动去掉 origin/ 建同名本地跟踪分支）。',
      showBase: false,
      placeholder: 'feature/remote-x',
      source: 'remote',
    },
    tag: {
      label: '选择 tag',
      hint: '按 tag 检出。默认 detached 状态；勾选下方可直接建一个分支来改代码。',
      showBase: false,
      placeholder: 'v5.5.13.10',
      source: 'tag',
    },
    detach: {
      label: '提交（可留空用 HEAD）',
      hint: '留空则用 HEAD。检出后处于 detached 状态。',
      showBase: true,
      placeholder: '',
      baseLabel: '起点',
      baseHint: '分支名、tag 或 commit sha。',
      source: 'all',
    },
  }

  let mode = 'new'

  // 分支数据（首次打开时拉一次，后续复用）
  let branchData = { local: [], remote: [], tags: [] }
  const dataReady = (async () => {
    try {
      const d = await api(`/api/repos/${state.repo.id}/branches`)
      branchData = { local: d.local || [], remote: d.remote || [], tags: d.tags || [] }
    } catch (e) {
      body.querySelector('#nw-result').innerHTML = `<div class="note warn">分支列表加载失败：${esc(e.message)}</div>`
    }
  })()

  const relT = (t) => (t ? relTime(t) : '')

  /** 按当前模式给出自动完成候选 */
  const itemsFor = (source) => {
    const mk = (list, opts = {}) => list.map((b) => ({
      value: opts.strip ? b.name.replace(opts.strip, '') : b.name,
      label: b.name,
      right: relT(b.time),
      badge: opts.badgeOf ? opts.badgeOf(b) : b.owner ? '占用' : '',
      badgeKind: b.owner ? 'locked' : '',
      // 被别的 worktree 占用的分支不能选（创建/切换都会失败）
      disabled: Boolean(b.owner && b.owner !== (state.logWt || '')),
      raw: b,
    }))

    if (source === 'local') return mk(branchData.local)
    if (source === 'remote') return mk(branchData.remote.filter((b) => !/\/HEAD$/.test(b.name)), { strip: /^[^/]+\// })
    if (source === 'tag') {
      return branchData.tags.map((t) => ({
        value: t.name,
        label: t.name,
        right: relT(t.time),
        badge: t.annotated ? 'annotated' : '',
        raw: t,
      }))
    }
    // all：本地分支 + 远程 + tag，供 detached 用
    return [
      ...mk(branchData.local, { badgeOf: () => '本地', badgeKind: 'main' }),
      ...mk(branchData.remote.filter((b) => !/\/HEAD$/.test(b.name)), { badgeOf: () => '远程' }),
      ...branchData.tags.slice(0, 80).map((t) => ({
        value: t.name, label: t.name, right: relT(t.time), badge: 'tag', raw: t,
      })),
    ]
  }

  const branchInput = body.querySelector('#nw-branch')
  const baseInput = body.querySelector('#nw-base')

  // 分支输入框：按模式给不同候选
  const branchAC = attachAutocomplete(branchInput, {
    getItems: () => itemsFor(MODE_CFG[mode].source),
    emptyHint: '没有匹配的分支或 tag',
    onPick: () => syncPath(),
  })

  // 起点输入框：分支 + tag + 历史提交
  let baseCommits = []
  const baseAC = attachAutocomplete(baseInput, {
    getItems: () => [
      ...itemsFor('local'),
      ...branchData.tags.slice(0, 80).map((t) => ({
        value: t.name, label: t.name, right: relT(t.time), badge: 'tag', raw: t,
      })),
      ...baseCommits.map((c) => ({
        value: c.sha, label: `${c.sha.slice(0, 7)}  ${c.subject}`, right: relT(c.time), badge: 'commit',
      })),
    ],
    emptyHint: '没有匹配的分支 / tag / 提交',
  })

  // 延迟加载近期提交，避免打开对话框时卡顿
  setTimeout(async () => {
    try {
      const rev = state.logWt ? `wt=${encodeURIComponent(state.logWt)}&` : ''
      const d = await api(`/api/repos/${state.repo.id}/log?${rev}rev=HEAD&count=50&skip=0`)
      baseCommits = d.commits || []
    } catch {}
  }, 300)

  const syncPath = () => {
    const br = branchInput.value.trim()
    const tagBranch = body.querySelector('#nw-tag-branch')?.value.trim() || ''
    const pathEl = body.querySelector('#nw-path')

    if (mode === 'tag') {
      const base = br || 'tag'
      const namePart = body.querySelector('#nw-tag-mkbranch')?.checked && tagBranch ? tagBranch : base
      pathEl.value = `${repoParent}/${repoName}-${safeName(namePart)}`
      return
    }
    if (mode === 'detach' && !br) {
      pathEl.value = `${repoParent}/${repoName}-detached`
      return
    }
    if (!br) return
    pathEl.value = `${repoParent}/${repoName}-${safeName(br)}`
  }

  await openModal({
    title: `新建 worktree · ${repoName}`,
    body,
    wide: true,
    buttons: [
      { type: 'left', html: `git worktree add` },
      { label: '取消' },
      {
        label: '创建',
        kind: 'primary',
        onClick: async (ctx) => {
          const btn = ctx.foot.querySelector('.btn.primary')
          const path = body.querySelector('#nw-path').value.trim()
          const branch = branchInput.value.trim()
          const base = baseInput.value.trim()
          const res = body.querySelector('#nw-result')
          const mkBranch = body.querySelector('#nw-tag-mkbranch')?.checked
          const tagBranch = body.querySelector('#nw-tag-branch')?.value.trim() || ''

          if (mode === 'tag') {
            if (!branch) { res.innerHTML = '<div class="note warn">请选择或输入 tag 名</div>'; return false }
            if (mkBranch && !tagBranch) { res.innerHTML = '<div class="note warn">勾选了创建分支，请填写分支名</div>'; return false }
          } else if (mode !== 'detach' && !branch) {
            res.innerHTML = '<div class="note warn">请填写分支名</div>'
            return false
          }
          if (!path) { res.innerHTML = '<div class="note warn">请填写目标路径</div>'; return false }

          setBusy(btn, true, '创建中…')
          const payload = mode === 'tag'
            ? { path, mode: 'tag', base: branch, branch: mkBranch ? tagBranch : '' }
            : { path, branch, mode, base }
          const r = await act('worktrees', payload)
          setBusy(btn, false)
          await refreshAfterWrite()

          if (r.ok) {
            toast(mode === 'tag' && !mkBranch ? `已按 tag ${branch} 检出（detached）` : '已创建 worktree')
            return true
          }
          const reasonText = {
            'branch-in-use': '该分支已被别的 worktree 占用。',
            'branch-exists': '本地已有同名分支，请改用「现有分支」。',
            'path-exists': '目标路径已存在，换个名字。',
            'tag-not-found': '本地没有这个 tag，可能还没 fetch 到。先点「更新仓库」。',
          }[r.reason] || '创建失败'
          res.innerHTML = `<div class="note danger">${reasonText}</div>` +
            (r.error ? `<div class="filelist">${esc(r.error.slice(-1500))}</div>` : '')
          return false
        },
      },
    ],
    onMount: () => {
      const seg = body.querySelector('#nw-mode')
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-v]')
        if (!b) return
        mode = b.dataset.v
        for (const x of seg.children) x.classList.toggle('on', x === b)
        const cfg = MODE_CFG[mode]
        body.querySelector('#nw-branch-label').textContent = cfg.label
        body.querySelector('#nw-branch-hint').textContent = cfg.hint
        branchInput.placeholder = cfg.placeholder
        branchInput.value = ''
        body.querySelector('#nw-base-field').hidden = !cfg.showBase
        if (cfg.baseLabel) body.querySelector('#nw-base-label').textContent = cfg.baseLabel
        if (cfg.baseHint) body.querySelector('#nw-base-hint').textContent = cfg.baseHint
        body.querySelector('#nw-tag-branch-field').hidden = mode !== 'tag'
        syncPath()
        branchAC.close()
      })

      branchInput.addEventListener('input', syncPath)

      // tag 模式：勾选建分支时显示分支名输入框
      const cb = body.querySelector('#nw-tag-mkbranch')
      const tb = body.querySelector('#nw-tag-branch')
      cb.addEventListener('change', () => {
        tb.hidden = !cb.checked
        if (cb.checked && !tb.value) tb.value = ''
        if (cb.checked) tb.focus()
        syncPath()
      })
      tb.addEventListener('input', syncPath)
      // tag 分支名也支持自动完成（提示已有分支，避免重名）
      attachAutocomplete(tb, {
        getItems: () => itemsFor('local'),
        emptyHint: '没有匹配的分支',
      })

      // 数据到位后刷新候选
      dataReady.then(() => {
        branchAC.refresh?.()
      })

      syncPath()
    },
  })
})

/** 分支名转目录名：去掉 origin/ 前缀，/ 换成 -，剔除不安全字符 */
function safeName(br) {
  return br
    .replace(/^(origin|upstream)\//, '')
    .replace(/\//g, '-')
    .replace(/[^\w\u4e00-\u9fa5.-]/g, '-')
}

// ============================================================
// 5. 删除 worktree（含预检确认）
// ============================================================
async function openRemoveDialog(wt) {
  const pre = await act('worktree-preflight', { path: wt.path })
  const body = document.createElement('div')

  if (!pre.ok) {
    body.innerHTML = `<div class="note danger">${esc(pre.error || '无法删除')}</div>`
    return openModal({
      title: '无法删除',
      body,
      buttons: [{ label: '关闭', kind: 'primary' }],
    })
  }

  const riskCfg = {
    clean: { cls: 'ok', text: '干净且无未推送提交，删除不会丢失任何东西。分支会保留。' },
    'has-dirty': { cls: 'warn', text: `有 ${pre.dirtyCount} 个未提交改动，删除后这些改动会永久丢失。` },
    'has-unpushed': { cls: 'danger', text: `HEAD 上有 ${pre.unique.count} 个提交不在任何分支/远程/tag 上，属于不可恢复的丢失。` },
    locked: { cls: 'warn', text: '该 worktree 已锁定。' },
  }
  const risk = riskCfg[pre.risk] || riskCfg.clean

  const dirtyList = (pre.dirtyFiles || []).slice(0, 60).join('\n')
  const uniqueList = (pre.unique?.list || []).map((c) => `${c.sha}  ${c.subject}`).join('\n')

  body.innerHTML = `
    <div class="note ${risk.cls}">${risk.text}</div>
    <dl class="kv">
      <dt>worktree</dt><dd>${esc(pre.path)}</dd>
      <dt>分支</dt><dd>${esc(pre.branch || '(detached)')}</dd>
      <dt>状态</dt><dd>${pre.prunable ? '目录已不存在（仅注册残留）' : pre.dirtyCount > 0 ? `${pre.dirtyCount} 个改动` : '干净'}</dd>
    </dl>
    ${pre.unique?.count > 0 ? `<div class="field"><label>不在任何引用上的提交（会丢失）</label><div class="filelist">${esc(uniqueList)}</div></div>` : ''}
    ${pre.dirtyCount > 0 ? `<div class="field"><label>未提交改动（会丢失）</label><div class="filelist">${esc(dirtyList)}</div></div>` : ''}
    ${pre.dirtyCount > 0 && pre.unique?.count === 0 ? `
      <label class="checkline">
        <input type="checkbox" id="rm-confirm">
        <span>我确认丢弃上述 ${pre.dirtyCount} 个未提交改动</span>
      </label>` : ''}
    ${pre.unique?.count > 0 ? `
      <div class="note danger">这类删除我这边不提供。请先把这些提交推到远程或合并到某个分支，再来删除。</div>` : ''}
    <div id="rm-result"></div>`

  const canDelete = !(pre.unique?.count > 0)
  const needCheck = pre.dirtyCount > 0 && pre.unique?.count === 0

  await openModal({
    title: `删除 worktree · ${pre.branch || 'detached'}`,
    body,
    buttons: [
      { label: '取消' },
      {
        label: '删除',
        kind: 'danger',
        disabled: !canDelete || needCheck,
        onClick: async (ctx) => {
          const btn = ctx.foot.querySelector('.btn.danger')
          setBusy(btn, true, '删除中…')
          const r = await act('worktree-remove', { path: pre.path, force: pre.dirtyCount > 0 || pre.prunable })
          setBusy(btn, false)
          await refreshAfterWrite()
          if (r.ok) {
            toast('已删除 worktree，分支保留')
            return true
          }
          body.querySelector('#rm-result').innerHTML =
            `<div class="note danger">${esc(r.error || '删除失败')}</div>`
          return false
        },
      },
    ],
    onMount: () => {
      const cb = body.querySelector('#rm-confirm')
      if (cb) {
        cb.addEventListener('change', () => {
          const btn = document.querySelector('#modal-foot .btn.danger')
          if (btn) btn.disabled = !cb.checked
        })
      }
    },
  })
}

// ============================================================
// 6. 批量清理陈旧 worktree
// ============================================================
$('btn-stale').addEventListener('click', async () => {
  if (!state.repo) return
  const btn = $('btn-stale')
  setBusy(btn, true, '扫描中…')

  const body = document.createElement('div')
  body.innerHTML = '<div class="empty" style="padding:26px"><span class="spinner"></span> 扫描中…</div>'

  let staleDays = 7
  let picked = new Set()
  let syncFooter = () => {}

  const scanAndRender = async () => {
    body.innerHTML = '<div class="empty" style="padding:26px"><span class="spinner"></span> 扫描中…</div>'
    const r = await act('stale-scan', { staleDays })
    if (!r.ok) {
      body.innerHTML = `<div class="note danger">${esc(r.error || '扫描失败')}</div>`
      return
    }

    const cands = r.candidates || []
    const skips = r.skipped || []
    picked = new Set(cands.filter((c) => c.suggest).map((c) => c.path))

    if (cands.length === 0) {
      body.innerHTML = `
        <div class="note ok">没有可清理的 worktree。</div>
        <div class="note info">「可清理」的条件是：非主工作树、未锁定、工作区干净、且 HEAD 上的提交都已被某个分支/远程覆盖。<br>
        满足这些条件时，删除不会丢任何东西 —— 分支和提交都还在。</div>
        ${skips.length ? renderSkipped(skips) : ''}`
      return
    }

    const rows = cands.map((c) => {
      const ageCell = c.prunable
        ? '<span class="age gone">目录已删</span>'
        : c.idleDays == null
          ? '<span class="age">—</span>'
          : `<span class="age ${c.suggest ? 'cold' : 'hot'}">${c.idleDays} 天</span>`
      return `<tr data-path="${esc(c.path)}" class="${picked.has(c.path) ? 'pick' : ''}">
        <td><input type="checkbox" ${picked.has(c.path) ? 'checked' : ''} ${c.prunable ? '' : ''}></td>
        <td><span class="mono">${esc(c.branch || '(detached)')}</span></td>
        <td><span class="dirlink" title="${esc(c.path)}">${esc(c.path.replace(/^\/home\/[^/]+\//, '~/'))}</span></td>
        <td>${ageCell}</td>
        <td>${c.prunable ? '<span class="pill prunable">残留</span>' : c.suggest ? '<span class="pill warn">建议清理</span>' : '<span class="pill clean">可清理</span>'}</td>
      </tr>`
    }).join('')

    body.innerHTML = `
      <div class="note info">
        只列出<strong>删除后不会丢任何东西</strong>的 worktree：工作区干净，且 HEAD 上的提交都已在某个分支/远程/tag 上。
        删除后分支保留，代码不丢。
      </div>
      <table class="stale-tbl">
        <thead><tr>
          <th style="width:26px"><input type="checkbox" id="stale-all"></th>
          <th>分支</th><th>目录</th><th style="width:74px">闲置</th><th style="width:82px">判定</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="stale-opts">
        <label>闲置阈值
          <select class="select" id="stale-days">
            ${[3, 7, 14, 30].map((d) => `<option value="${d}" ${d === staleDays ? 'selected' : ''}>${d} 天</option>`).join('')}
          </select>
        </label>
        <span class="muted">仅用于标记「建议清理」，不影响可选范围</span>
      </div>
      ${skips.length ? renderSkipped(skips) : ''}
      <div id="stale-result"></div>`

    // 绑定
    const all = body.querySelector('#stale-all')
    const syncAll = () => {
      const boxes = [...body.querySelectorAll('.stale-tbl tbody input[type=checkbox]')]
      all.checked = boxes.length > 0 && boxes.every((b) => b.checked)
      all.indeterminate = boxes.some((b) => b.checked) && !all.checked
      syncFooter()
    }
    all.addEventListener('change', () => {
      const boxes = [...body.querySelectorAll('.stale-tbl tbody input[type=checkbox]')]
      for (const b of boxes) {
        b.checked = all.checked
        const tr = b.closest('tr')
        tr.classList.toggle('pick', b.checked)
        const p = tr.dataset.path
        if (b.checked) picked.add(p); else picked.delete(p)
      }
      all.indeterminate = false
      syncAll()
    })
    for (const tr of body.querySelectorAll('.stale-tbl tbody tr')) {
      const cb = tr.querySelector('input[type=checkbox]')
      const toggle = () => {
        tr.classList.toggle('pick', cb.checked)
        const p = tr.dataset.path
        if (cb.checked) picked.add(p); else picked.delete(p)
        syncAll()
      }
      cb.addEventListener('change', toggle)
      tr.addEventListener('click', (e) => {
        if (e.target === cb) return
        cb.checked = !cb.checked
        toggle()
      })
    }
    syncAll()

    body.querySelector('#stale-days').addEventListener('change', (e) => {
      staleDays = Number(e.target.value)
      scanAndRender()
    })

    syncFooter()
  }

  await scanAndRender()

  await openModal({
    title: `清理陈旧 worktree · ${state.repo.name}`,
    body,
    wide: true,
    buttons: [
      { type: 'left', html: `<span id="stale-count"></span>` },
      { label: '取消' },
      {
        label: '删除',
        kind: 'danger',
        onClick: async (ctx) => {
          if (picked.size === 0) return false
          const btnRun = ctx.foot.querySelector('.btn.danger')
          const paths = [...picked]
          setBusy(btnRun, true, '删除中…')
          const r = await act('stale-clean', { staleDays, paths })
          setBusy(btnRun, false)
          await refreshAfterWrite()

          if (r.removed?.length) {
            toast(`已清理 ${r.removed.length} 个 worktree`)
            return true
          }
          body.querySelector('#stale-result').innerHTML =
            `<div class="note danger">${esc(r.failed?.[0]?.error || r.error || '清理失败')}</div>`
          return false
        },
      },
    ],
    onMount: () => {
      // 选中变化时直接同步页脚，不用轮询
      syncFooter = () => {
        const btnRun = $('modal-foot').querySelector('.btn.danger')
        if (btnRun) {
          btnRun.disabled = picked.size === 0
          btnRun.textContent = picked.size ? `删除 ${picked.size} 个` : '删除'
        }
        const c = $('stale-count')
        if (c) c.textContent = picked.size ? `已选 ${picked.size} 个` : ''
      }
      syncFooter()
    },
  })
  setBusy(btn, false)
})

function renderSkipped(skips) {
  const items = skips.map((s) => `
    <div class="skipped-item">
      <span class="mono">${esc(s.branch || '(detached)')}</span>
      <span class="r">${esc(s.skipText || s.skip)}</span>
    </div>`).join('')
  return `<details class="skipped-wrap">
    <summary>${skips.length} 个未列为候选（点开看原因）</summary>
    <div style="margin-top:7px">${items}</div>
  </details>`
}

// ============================================================
// 三栏布局：折叠开关 + 拖动调整宽度（持久化到 localStorage）
// ============================================================
const LAYOUT_KEY = 'wsl-worktree.layout.v1'
const LAYOUT_LIMITS = {
  left: { min: 140, max: 460, def: 220 },
  right: { min: 240, max: 900, def: 380 },
}
// 中间面板至少要留这么宽，拖动时不越过它
const CENTER_MIN = 420

const layoutState = {
  left: true,      // 左侧面板是否展开
  right: true,     // 右侧面板是否展开
  wLeft: LAYOUT_LIMITS.left.def,
  wRight: LAYOUT_LIMITS.right.def,
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

function applyLayout({ animate = false } = {}) {
  const layout = $('layout')
  const total = layout.clientWidth

  // 动态收紧上限：不能把中间区域压没
  const availForSides = Math.max(0, total - CENTER_MIN - (layoutState.left ? 5 : 0) - (layoutState.right ? 5 : 0))
  const maxRight = Math.min(LAYOUT_LIMITS.right.max, Math.max(0, availForSides - (layoutState.left ? LAYOUT_LIMITS.left.min : 0)))
  const maxLeft = Math.min(LAYOUT_LIMITS.left.max, Math.max(0, availForSides - (layoutState.right ? LAYOUT_LIMITS.right.min : 0)))

  layoutState.wLeft = clamp(layoutState.wLeft, LAYOUT_LIMITS.left.min, Math.max(LAYOUT_LIMITS.left.min, maxLeft))
  layoutState.wRight = clamp(layoutState.wRight, LAYOUT_LIMITS.right.min, Math.max(LAYOUT_LIMITS.right.min, maxRight))

  layout.style.setProperty('--w-left', `${layoutState.wLeft}px`)
  layout.style.setProperty('--w-right', `${layoutState.wRight}px`)
  layout.classList.toggle('hide-left', !layoutState.left)
  layout.classList.toggle('hide-right', !layoutState.right)

  $('toggle-left').classList.toggle('off', !layoutState.left)
  $('toggle-right').classList.toggle('off', !layoutState.right)
  $('toggle-left').setAttribute('aria-pressed', String(layoutState.left))
  $('toggle-right').setAttribute('aria-pressed', String(layoutState.right))

  // 窄屏下右侧是浮层，用 .hide 控制显隐（与 .hide-right 各管一段）
  const narrow = window.matchMedia('(max-width: 1180px)').matches
  $('detail').classList.toggle('hide', narrow && !layoutState.right)

  // 左栏收起时，顶栏出现仓库切换器（否则没有入口换仓库）
  syncTopRepoPicker(!layoutState.left)
}

/**
 * 顶栏仓库切换器：仅当左侧面板收起时显示。
 * 复用 attachAutocomplete，所以模糊匹配 / 键盘导航行为和新建对话框一致。
 */
let topRepoAC = null

function syncTopRepoPicker(show) {
  const box = $('top-repo')
  if (!box) return
  const wasHidden = box.hidden
  box.hidden = !show
  if (show) {
    refreshTopRepoPicker()
    // 从隐藏变为可见时同步当前仓库名，避免显示旧值
    if (wasHidden) setTopRepoInputToCurrent()
  }
}

function setTopRepoInputToCurrent() {
  const input = $('top-repo-input')
  if (!input) return
  input.value = state.repo ? state.repo.name : ''
  const badge = $('top-repo-badge')
  if (badge) {
    const extra = state.repo?.extra || 0
    const dirty = state.repo?.dirtyCount || 0
    badge.textContent = extra > 0 ? `+${extra}${dirty ? ' ●' : ''}` : dirty ? '●' : ''
    badge.className = 'top-repo-badge' + (dirty ? ' warn' : '')
  }
}

/** 候选来自 state.repos，按「目录/仓库名」展示，右侧显示 worktree 数 */
function refreshTopRepoPicker() {
  if (!topRepoAC) {
    const input = $('top-repo-input')
    topRepoAC = attachAutocomplete(input, {
      getItems: () =>
        state.repos.map((r) => {
          // 相对路径：~/codes/products/asset → products/asset；顶层仓库只显示名字
          const rel = r.toplevel.replace(/^\/home\/[^/]+\/codes\/?/, '').replace(/^\/home\/[^/]+\//, '~/')
          return {
            value: r.name,
            // 目录下的仓库要带上目录前缀，否则 products/asset 与另一处的 asset 分不清
            label: rel || r.name,
            right: r.extra > 0 ? `${r.count} wt` : '',
            badge: r.dirtyCount > 0 ? '●' : '',
            badgeKind: 'warn',
            raw: r,
          }
        }),
      // 同名仓库（不同目录下）时按 label 也能区分，所以选中后回读 raw 的 toplevel
      onPick: (item) => {
        const target = item.raw
        if (target) {
          selectRepo(target.toplevel)
          setTopRepoInputToCurrent()
        }
      },
      emptyHint: '没有匹配的仓库',
      // 输入框预填的是当前仓库名，聚焦时应列出全部仓库而不是只匹配自己
      showAllOnFocus: true,
    })

    // 聚焦即全选由 attachAutocomplete 内部处理（showAllOnFocus 分支）
    // 失焦时如果没有有效选择，恢复显示当前仓库名（避免留半截查询词）
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (!state.repo) return
        const v = input.value.trim()
        const exact = state.repos.find((r) => r.name === v || r.toplevel === v)
        if (!exact) setTopRepoInputToCurrent()
      }, 150)
    })

    // 面板已关时按 Esc：还原成当前仓库名（第二次 Esc 才生效，第一次留给关面板）
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      const panelOpen = input.closest('.ac-wrap')?.querySelector('.ac-panel')?.hidden === false
      if (panelOpen) return
      e.preventDefault()
      setTopRepoInputToCurrent()
      input.blur()
    })
  }
  return topRepoAC
}



function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({
      left: layoutState.left,
      right: layoutState.right,
      wLeft: layoutState.wLeft,
      wRight: layoutState.wRight,
    }))
  } catch {}
}

function loadLayout() {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY)
    if (!raw) return
    const v = JSON.parse(raw)
    if (typeof v.left === 'boolean') layoutState.left = v.left
    if (typeof v.right === 'boolean') layoutState.right = v.right
    if (Number.isFinite(v.wLeft)) layoutState.wLeft = v.wLeft
    if (Number.isFinite(v.wRight)) layoutState.wRight = v.wRight
  } catch {}
}

/** 展开/收起某一侧 */
function setPanel(side, open) {
  layoutState[side] = open
  applyLayout()
  saveLayout()
  if (open) {
    // 展开后把焦点给到面板，方便继续操作
    const target = side === 'left' ? $('repo-search') : $('detail-body')
    requestAnimationFrame(() => target?.focus?.({ preventScroll: true }))
  }
}

$('toggle-left').addEventListener('click', () => setPanel('left', !layoutState.left))
$('toggle-right').addEventListener('click', () => setPanel('right', !layoutState.right))

/**
 * 绑定一根分隔条的拖拽。
 * 用 pointer events + setPointerCapture，鼠标拖出窗口也不会丢事件。
 */
function bindSplitter(el, side) {
  const hint = $('resize-hint')
  let startX = 0
  let startW = 0
  let dragging = false

  const onMove = (e) => {
    if (!dragging) return
    const dx = e.clientX - startX
    // 左侧向右拖 = 变宽；右侧向左拖 = 变宽（方向相反）
    const raw = side === 'left' ? startW + dx : startW - dx
    const lim = LAYOUT_LIMITS[side]
    const total = $('layout').clientWidth
    const otherW = side === 'left'
      ? (layoutState.right ? layoutState.wRight : 0)
      : (layoutState.left ? layoutState.wLeft : 0)
    // 中间区域不能小于 CENTER_MIN
    const maxByCenter = total - otherW - CENTER_MIN - 10
    const next = clamp(raw, lim.min, Math.min(lim.max, Math.max(lim.min, maxByCenter)))

    if (side === 'left') layoutState.wLeft = next
    else layoutState.wRight = next

    $('layout').style.setProperty(side === 'left' ? '--w-left' : '--w-right', `${next}px`)

    hint.textContent = `${Math.round(next)} px`
    const rect = el.getBoundingClientRect()
    hint.style.left = `${rect.left + rect.width / 2 + 12}px`
    hint.hidden = false
    e.preventDefault()
  }

  const onUp = (e) => {
    if (!dragging) return
    dragging = false
    el.classList.remove('dragging')
    document.body.classList.remove('resizing')
    hint.hidden = true
    try { el.releasePointerCapture(e.pointerId) } catch {}
    saveLayout()
    applyLayout() // 收一次边界，防止窗口缩放后宽度越界
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    dragging = true
    startX = e.clientX
    startW = side === 'left' ? layoutState.wLeft : layoutState.wRight
    el.classList.add('dragging')
    document.body.classList.add('resizing')
    try { el.setPointerCapture(e.pointerId) } catch {}
    e.preventDefault()
  })

  el.addEventListener('pointermove', onMove)
  el.addEventListener('pointerup', onUp)
  el.addEventListener('pointercancel', onUp)

  // 双击复位默认宽度
  el.addEventListener('dblclick', () => {
    const lim = LAYOUT_LIMITS[side]
    if (side === 'left') layoutState.wLeft = lim.def
    else layoutState.wRight = lim.def
    applyLayout()
    saveLayout()
    toast(`${side === 'left' ? '左侧' : '右侧'}面板宽度已复位`)
  })

  // 键盘可访问性：左右方向键微调
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = e.shiftKey ? 40 : 8
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const delta = side === 'left' ? dir * step : -dir * step
    const key = side === 'left' ? 'wLeft' : 'wRight'
    const lim = LAYOUT_LIMITS[side]
    layoutState[key] = clamp(layoutState[key] + delta, lim.min, lim.max)
    applyLayout()
    saveLayout()
  })
  el.tabIndex = 0
}

bindSplitter($('split-left'), 'left')
bindSplitter($('split-right'), 'right')

// 窗口尺寸变化时重新收敛宽度
let resizeTimer = null
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => applyLayout(), 80)
})

// 快捷键：[ 左面板，] 右面板
document.addEventListener('keydown', (e) => {
  // target 可能不是元素（程序化 dispatch 到 document 时），要做类型防护
  if (e.target instanceof Element && e.target.matches('input, textarea, select')) return
  if (e.target instanceof Element && e.target.isContentEditable) return
  if ($('modal').hidden === false) return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '[') { e.preventDefault(); setPanel('left', !layoutState.left) }
  if (e.key === ']') { e.preventDefault(); setPanel('right', !layoutState.right) }
})

loadLayout()

// 首帧之后再应用一次：此时 layout.clientWidth 才是真实值
requestAnimationFrame(() => {
  applyLayout()
  if (document.fonts?.ready) document.fonts.ready.then(() => applyLayout())
})

// ============================================================
// 自动完成输入框（分支 / tag / 提交）
// ============================================================

/**
 * 给 input 绑定自动完成下拉。
 * @param {HTMLInputElement} input
 * @param {{ getItems: () => Array<{value, label?, right?, badge?, badgeKind?, disabled?}>,
 *           onPick?: (item) => void,
 *           minChars?: number,
 *           emptyHint?: string,
 *           showAllOnFocus?: boolean  聚焦时忽略输入框里已有的值，直接列出全部候选
 *         }} opt
 */
function attachAutocomplete(input, opt) {
  const wrap = document.createElement('div')
  wrap.className = 'ac-wrap'
  input.parentNode.insertBefore(wrap, input)
  wrap.appendChild(input)

  const panel = document.createElement('div')
  panel.className = 'ac-panel'
  panel.hidden = true
  wrap.appendChild(panel)

  let items = []      // 当前展示的候选
  let active = -1
  let suppress = false

  const close = () => { panel.hidden = true; active = -1 }

  // 面板空间不足时向上翻，避免遮住下方字段（对话框高度有限）
  const placePanel = () => {
    const rect = input.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom
    const above = rect.top
    // 需要大概 240px；下面不够且上面更宽裕就翻到上方
    if (below < 240 && above > below) {
      panel.style.top = 'auto'
      panel.style.bottom = 'calc(100% + 2px)'
      panel.classList.add('up')
    } else {
      panel.style.top = 'calc(100% + 2px)'
      panel.style.bottom = 'auto'
      panel.classList.remove('up')
    }
  }

  const render = (list) => {
    items = list
    if (!list.length) {
      panel.innerHTML = `<div class="ac-empty">${esc(opt.emptyHint || '无匹配项')}</div>`
      panel.hidden = false
      placePanel()
      return
    }
    panel.replaceChildren()
    list.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'ac-item' + (it.disabled ? ' disabled' : '') + (i === active ? ' active' : '')
      // data-value：方便外部（如历史页的路径框）在 Enter 时取当前高亮项
      row.dataset.value = it.value
      row.innerHTML = `
        <span class="ac-label">${highlight(it.label ?? it.value, input.value)}</span>
        ${it.badge ? `<span class="pill ${it.badgeKind || ''}">${esc(it.badge)}</span>` : ''}
        ${it.right ? `<span class="ac-right">${esc(it.right)}</span>` : ''}`
      row.addEventListener('mousedown', (e) => {
        // 用 mousedown 而不是 click：click 会先触发 input 的 blur，导致面板已关闭
        e.preventDefault()
        if (it.disabled) return
        pick(it)
      })
      panel.appendChild(row)
    })
    panel.hidden = false
    placePanel()
  }

  const pick = (it) => {
    suppress = true
    input.value = it.value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    suppress = false
    close()
    if (opt.onPick) opt.onPick(it)
  }

  const open = (opts = {}) => {
    if (suppress) return
    // showAllOnFocus：输入框里预填的是「当前值」而不是「查询词」，
    // 聚焦时应当列出全部候选，而不是拿当前值去过滤（否则只能看到自己那一项）。
    const ignoreValue = opts.ignoreValue === true
    const q = ignoreValue ? '' : input.value.trim()
    if (!ignoreValue && opt.minChars && q.length < opt.minChars) { close(); return }
    const all = opt.getItems() || []
    if (!q) {
      // 空输入：展示默认列表（按时间排序的前 N 个）
      render(all.slice(0, 40))
      return
    }
    const scored = []
    for (const it of all) {
      const s1 = fuzzyScore(q, it.value)
      const s2 = it.label && it.label !== it.value ? fuzzyScore(q, it.label) : null
      const s = s1 == null ? s2 : s2 == null ? s1 : Math.max(s1, s2)
      if (s != null) scored.push({ it, s })
    }
    scored.sort((a, b) => b.s - a.s)
    render(scored.slice(0, 40).map((x) => x.it))
  }

  const move = (delta) => {
    // 只在「可选」的下标里移动，避免 disabled 项干扰索引
    const idxs = items.map((x, i) => (x.disabled ? -1 : i)).filter((i) => i >= 0)
    if (!idxs.length) return
    const cur = idxs.indexOf(active)
    const next = cur < 0
      ? (delta > 0 ? 0 : idxs.length - 1)
      : (cur + delta + idxs.length) % idxs.length
    active = idxs[next]

    for (const [i, el] of [...panel.children].entries()) {
      el.classList.toggle('active', i === active)
    }
    const el = panel.children[active]
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' })
  }

  input.addEventListener('input', () => open())
  input.addEventListener('focus', () => {
    if (opt.showAllOnFocus) {
      // 先全选原有文本（用户多半想直接改），再列出全部候选
      requestAnimationFrame(() => {
        try { input.select() } catch {}
      })
      open({ ignoreValue: true })
    } else {
      open()
    }
  })
  input.addEventListener('blur', () => setTimeout(close, 120))
  input.addEventListener('keydown', (e) => {
    if (panel.hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); open() }
      return
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
    else if (e.key === 'Enter') {
      if (active >= 0 && items[active] && !items[active].disabled) {
        e.preventDefault()
        e.stopPropagation()
        pick(items[active])
      } else if (!panel.hidden) {
        // 有候选但没选中：避免回车直接提交表单
        close()
      }
    } else if (e.key === 'Escape') {
      if (!panel.hidden) { e.stopPropagation(); close() }
    } else if (e.key === 'Tab') {
      if (active >= 0 && items[active] && !items[active].disabled) {
        e.preventDefault()
        pick(items[active])
      } else {
        close()
      }
    }
  })

  return { close, refresh: open }
}

/** 把输入串在文本里高亮出来（仅连续子串，模糊时不高亮以免误导） */
function highlight(text, query) {
  const safe = esc(text)
  const q = (query || '').trim()
  if (!q) return safe
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return safe
  const before = esc(text.slice(0, idx))
  const hit = esc(text.slice(idx, idx + q.length))
  const after = esc(text.slice(idx + q.length))
  return `${before}<mark>${hit}</mark>${after}`
}

// ============================================================
// 克隆仓库
// ============================================================
/**
 * 从 URL 推目录名：
 *   git@host:team/repo.git        → repo
 *   https://host/team/repo.git/   → repo
 *   ssh://git@host:22/t/a.git     → a
 * 取最后一个 / 或 : 之后的段，去掉 .git。
 */
function repoNameFromUrl(url) {
  let s = String(url || '').trim().replace(/[/\s]+$/, '')
  s = s.replace(/\.git$/i, '')
  const seg = s.split(/[/:]/).filter(Boolean).pop() || ''
  // 允许字母数字和 . _ -，其他一律去掉（防止把奇怪字符带进路径）
  return seg.replace(/[^\w.-]/g, '')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询克隆任务，直到成功/失败 */
async function pollClone(id, onProgress, timeoutMs = 12 * 60 * 1000) {
  const t0 = Date.now()
  for (;;) {
    if (Date.now() - t0 > timeoutMs) throw new Error('等待克隆结果超时')
    await sleep(500)
    const r = await fetch(`/api/clone/${id}`)
    if (!r.ok) {
      const d = await r.json().catch(() => ({}))
      throw new Error(d.error || `HTTP ${r.status}`)
    }
    const job = await r.json()
    onProgress(job)
    if (job.status === 'done') return job
    if (job.status !== 'running') throw new Error(job.error || '克隆失败')
  }
}

async function openCloneDialog() {
  const roots = state.roots?.length ? state.roots : (await api('/api/config').catch(() => ({}))).roots || []
  if (!roots.length) { toast('没有配置扫描根目录，先检查 config.json', true); return }

  const body = document.createElement('div')
  body.innerHTML = `
    <div class="field">
      <label>仓库地址</label>
      <input class="input" id="cl-url" placeholder="git@gitlab.example.com:team/repo.git" autocomplete="off" spellcheck="false">
      <div class="hintline">HTTPS 和 SSH 都行，用系统里已配置的凭证。</div>
    </div>
    <div class="field">
      <label>克隆到</label>
      ${roots.length > 1
        ? `<select class="input" id="cl-root">${roots.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}</select>`
        : `<input class="input" id="cl-root" value="${esc(roots[0])}" readonly>`}
      <input class="input" id="cl-dir" placeholder="目录名" autocomplete="off" spellcheck="false" style="margin-top:6px">
      <div class="hintline" id="cl-path"></div>
    </div>
    <div class="field">
      <label class="checkline"><input type="checkbox" id="cl-depth"> <span>浅克隆（<code>--depth 1</code>，只要最新一次提交）</span></label>
      <label class="checkline"><input type="checkbox" id="cl-sub"> <span>同时初始化子模块（<code>--recurse-submodules</code>）</span></label>
    </div>
    <div class="cl-progress" id="cl-progress" hidden>
      <div class="cl-phase" id="cl-phase">准备中</div>
      <div class="cl-bar"><div class="cl-fill" id="cl-fill"></div></div>
      <div class="cl-meta" id="cl-meta"></div>
    </div>
    <div class="cl-err" id="cl-err" hidden></div>`

  const urlEl = body.querySelector('#cl-url')
  const rootEl = body.querySelector('#cl-root')
  const dirEl = body.querySelector('#cl-dir')
  const pathEl = body.querySelector('#cl-path')
  const depthEl = body.querySelector('#cl-depth')
  const subEl = body.querySelector('#cl-sub')
  const progEl = body.querySelector('#cl-progress')
  const fillEl = body.querySelector('#cl-fill')
  const phaseEl = body.querySelector('#cl-phase')
  const metaEl = body.querySelector('#cl-meta')
  const errEl = body.querySelector('#cl-err')

  // 用户手动改过目录名之后，就不再被 URL 推导覆盖
  let dirTouched = false

  const refreshPath = () => {
    const name = dirEl.value.trim()
    const root = String(rootEl.value || '').replace(/\/+$/, '')
    pathEl.textContent = name ? `→ ${root}/${name}` : ''
    errEl.hidden = true
  }

  urlEl.addEventListener('input', () => {
    if (!dirTouched) dirEl.value = repoNameFromUrl(urlEl.value)
    refreshPath()
  })
  dirEl.addEventListener('input', () => { dirTouched = true; refreshPath() })
  rootEl.addEventListener('change', refreshPath)

  const res = await openModal({
    title: '克隆仓库',
    wide: true,
    body,
    buttons: [
      { label: '取消', onClick: (ctx) => ctx.close(null) },
      {
        label: '克隆',
        kind: 'primary',
        id: 'cl-go',
        onClick: async () => {
          const url = urlEl.value.trim()
          const name = dirEl.value.trim()
          const root = String(rootEl.value || '').replace(/\/+$/, '')

          if (!url) { errEl.hidden = false; errEl.textContent = '请填仓库地址'; return false }
          if (!name) { errEl.hidden = false; errEl.textContent = '请填目录名'; return false }
          if (/[/\\]/.test(name) || name === '.' || name === '..') {
            errEl.hidden = false
            errEl.textContent = '目录名不能包含 / 或 \\'
            return false
          }

          const btn = $('cl-go')
          setBusy(btn, true, '克隆中…')
          progEl.hidden = false
          errEl.hidden = true
          fillEl.style.width = '0%'
          phaseEl.textContent = '准备中'
          metaEl.textContent = ''

          try {
            const r = await fetch('/api/clone', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ url, dir: `${root}/${name}`, depth1: depthEl.checked, submodules: subEl.checked }),
            })
            const data = await r.json().catch(() => ({}))
            if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)

            const job = await pollClone(data.id, (j) => {
              fillEl.style.width = `${j.percent || 0}%`
              phaseEl.textContent = j.phase || '克隆中'
              metaEl.textContent = [
                `${j.percent || 0}%`,
                j.rate || '',
                j.status === 'running' ? '' : `${Math.round(j.elapsedMs / 1000)}s`,
              ].filter(Boolean).join(' · ')
            })
            setBusy(btn, false)
            return { cloned: true, dir: job.dir }
          } catch (e) {
            setBusy(btn, false)
            errEl.hidden = false
            errEl.textContent = e.message
            return false // 不关对话框，用户可以直接改地址重试
          }
        },
      },
    ],
  })

  if (!res?.cloned) return
  toast('克隆完成')
  // 后端在 job 完成时已经让扫描缓存失效，这里直接强制刷一次
  await loadRepos(true)
  const target = state.repos.find((r) => r.toplevel === res.dir)
  if (target) await selectRepo(target.id)
}

$('btn-clone').addEventListener('click', () => {
  openCloneDialog().catch((e) => toast(e.message, true))
})

