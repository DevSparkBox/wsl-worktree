// ============================================================
// 文件历史页（独立窗口/标签页）
// URL: /history.html?repo=<id>&path=<path>&wt=<worktree path>&follow=1
// 顶栏的文件路径可点击，改成输入框后按路径模糊搜索切换文件。
// ============================================================

import { fuzzyScore, rankByFuzzy } from '/fuzzy.js'

const $ = (id) => document.getElementById(id)

const qs = new URLSearchParams(location.search)
const repoId = qs.get('repo') || ''
const wtPath = qs.get('wt') || ''

const state = {
  commits: [],       // 全部历史
  filtered: [],      // 过滤后的
  activeSha: null,
  follow: qs.get('follow') !== '0',
  repo: null,
  filePath: qs.get('path') || '',
  allFiles: [],      // 仓库全部已跟踪文件（切文件用）
  filesLoaded: false,
  loadingDiff: false,
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

function fmtDate(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const p = (n) => String(n).padStart(2, '0')
  return sameYear
    ? `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 头像色块：按作者名稳定取色，同一个人始终同色 */
const AVATAR_COLORS = [
  '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c',
  '#ca8a04', '#16a34a', '#0891b2', '#4f46e5', '#9333ea',
]
function avatarFor(name) {
  const s = String(name || '?')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return {
    color: AVATAR_COLORS[h % AVATAR_COLORS.length],
    // 中文取首字，英文取首字母
    text: /[\u4e00-\u9fa5]/.test(s) ? s[0] : s.slice(0, 1).toUpperCase(),
  }
}

let toastTimer = null
function toast(msg) {
  const el = $('h-toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 1800)
}

async function api(path) {
  const res = await fetch(path)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ---------- 渲染列表 ----------
function renderList() {
  const box = $('h-list')
  const empty = $('h-empty')
  const list = state.filtered

  if (!list.length) {
    box.replaceChildren()
    empty.hidden = false
    empty.innerHTML = state.commits.length
      ? '没有匹配的提交，换个过滤词试试。'
      : `这个文件在 <span class="mono">${esc(shortWt())}</span> 的当前分支上没有历史。<br>
         <span style="color:var(--text-faint)">可能它只存在于别的分支，或从未被提交。</span>`
    return
  }
  empty.hidden = true

  const frag = document.createDocumentFragment()
  for (const c of list) {
    const row = document.createElement('div')
    row.className = 'h-row' + (c.sha === state.activeSha ? ' active' : '')
    row.dataset.sha = c.sha

    const av = avatarFor(c.author)
    const pill = c.rename
      ? `<span class="h-pill rename">改名</span>`
      : c.status === 'added' ? `<span class="h-pill add">新增</span>`
      : c.status === 'deleted' ? `<span class="h-pill del">删除</span>`
      : ''
    // 路径只在两种情况下显示：改名（要说明 why 路径变了）、或与当前文件名不同。
    // 同一个文件每行都重复一遍长路径没意义，还挤掉 diff 的位置。
    const pathDiffers = c.pathAtCommit !== state.filePath
    const showFile = c.rename || pathDiffers
    // 改名只显示差异片段（完整两条长路径截断后看不出差别）
    const fileLabel = c.rename
      ? shortRename(c.rename.from, c.rename.to)
      : c.pathAtCommit
    const fileTitle = c.rename ? `${c.rename.from} →\n${c.rename.to}` : c.pathAtCommit
    const statText = c.add == null
      ? '<span style="color:var(--text-faint)">bin</span>'
      : `<span class="plus">+${c.add}</span> <span class="minus">−${c.del}</span>`

    row.innerHTML = `
      <div class="h-avatar" style="background:${av.color}">${esc(av.text)}</div>
      <div class="h-body">
        <div class="h-line1">
          <span class="h-author" title="${esc(c.author)}">${esc(c.author)}</span>
          <span class="h-date">${fmtDate(c.time)}</span>
          <span class="h-stat">${statText}</span>
          <span class="h-sha">${esc(c.sha.slice(0, 7))}</span>
        </div>
        <div class="h-subject" title="${esc(c.subject)}">${esc(c.subject || '(无标题)')}</div>
        ${showFile
          ? `<div class="h-fileline">${pill}<span class="name${c.rename ? ' rename-label' : ''}" title="${esc(fileTitle)}">${esc(fileLabel)}</span></div>`
          : (pill ? `<div class="h-fileline">${pill}<span class="name" style="color:var(--text-faint)">文件被改名</span></div>` : '')}
      </div>`
    row.addEventListener('click', () => selectCommit(c))
    frag.appendChild(row)
  }
  box.replaceChildren(frag)
}

/**
 * 改名行的展示：两条长路径整体截断后看起来几乎一样，反而看不出改了什么。
 * 所以只保留「最后一个 / 之前」的差异部分，例如：
 *   backend/src/platformv2-unit/... → backend/src/jmpt-unit/...
 * 取到第一个不同的路径段为止。
 */
function shortRename(from, to) {
  const a = String(from).split('/')
  const b = String(to).split('/')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  // 反向也去掉相同的尾部（文件名通常相同）
  let ja = a.length - 1
  let jb = b.length - 1
  while (ja > i && jb > i && a[ja] === b[jb]) { ja--; jb-- }

  const trim = (arr, from_, to_) => {
    const mid = arr.slice(from_, to_ + 1).join('/')
    const pre = from_ > 0 ? '…/' : ''
    const post = to_ < arr.length - 1 ? '/…' : ''
    return pre + mid + post
  }
  return `${trim(a, i, ja)} → ${trim(b, i, jb)}`
}

function shortWt() {
  if (!wtPath) return state.repo?.toplevel || ''
  return wtPath.split('/').filter(Boolean).slice(-1)[0] || wtPath
}

// ---------- 选中某条提交，取 diff ----------
async function selectCommit(c) {
  state.activeSha = c.sha
  for (const el of $('h-list').children) {
    el.classList.toggle('active', el.dataset.sha === c.sha)
  }
  $('h-diff-sha').textContent = c.sha.slice(0, 12)
  $('h-diff-subject').textContent = c.subject || '(无标题)'
  $('h-diff-subject').title = c.subject || ''
  $('h-diff-stat').innerHTML = ''
  $('h-copy-sha').disabled = false

  const body = $('h-diff-body')
  body.innerHTML = '<div class="empty">加载 diff…</div>'

  const params = new URLSearchParams({ sha: c.sha, path: c.pathAtCommit })
  if (wtPath) params.set('wt', wtPath)
  try {
    const data = await api(`/api/repos/${repoId}/file-history-diff?${params}`)
    if (state.activeSha !== c.sha) return  // 快速点击时丢弃过期响应
    if (data.error) {
      body.innerHTML = `<div class="empty" style="color:var(--red)">${esc(data.error)}</div>`
      return
    }
    if (!data.patch) {
      body.innerHTML = `<div class="empty">这次提交对文件没有可显示的改动（可能是纯改名或二进制文件）。</div>`
      return
    }
    const { table, add, del } = renderPatchTable(data.patch)
    body.replaceChildren(table)
    if (data.truncated) {
      const t = document.createElement('div')
      t.className = 'empty'
      t.textContent = 'diff 过大，已截断。'
      body.appendChild(t)
    }
    $('h-diff-stat').innerHTML =
      `<span class="plus">+${add}</span> <span class="minus">−${del}</span>`
  } catch (err) {
    body.innerHTML = `<div class="empty" style="color:var(--red)">${esc(err.message)}</div>`
  }
}

/**
 * 把 patch 渲染成带行号的表格。
 * 文件名行（diff --git / index / --- / +++ 等）只保留一行摘要，避免占版面。
 */
function renderPatchTable(patch) {
  const table = document.createElement('table')
  table.className = 'h-patch-table'
  const tbody = document.createElement('tbody')

  let oldNo = 0
  let newNo = 0
  let add = 0
  let del = 0

  for (const line of patch.split('\n')) {
    if (line === '') continue
    const tr = document.createElement('tr')
    let cls = 'ctx'
    let lnOld = ''
    let lnNew = ''
    let text = line

    if (line.startsWith('@@')) {
      cls = 'hunk'
      // @@ -a,b +c,d @@ → 解析出起始行号
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      text = line
    } else if (
      line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ||
      line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') ||
      line.startsWith('similarity') || line.startsWith('rename ') || line.startsWith('old mode') ||
      line.startsWith('new mode') || line.startsWith('Binary files') || line.startsWith('\\ No newline')
    ) {
      cls = 'meta'
    } else if (line.startsWith('+')) {
      cls = 'add'
      lnNew = String(newNo++)
      add++
    } else if (line.startsWith('-')) {
      cls = 'del'
      lnOld = String(oldNo++)
      del++
    } else {
      lnOld = String(oldNo++)
      lnNew = String(newNo++)
    }

    if (cls === 'hunk') {
      tr.className = 'hunk'
      tr.innerHTML = `<td colspan="3">${esc(text)}</td>`
    } else if (cls === 'meta') {
      // diff --git / index / --- / +++ 四行是纯噪音（用户要看的不是这些），
      // 只保留有信息量的行（new file / rename / Binary 等）
      const noisy = line.startsWith('diff ') || line.startsWith('index ') ||
        line.startsWith('--- ') || line.startsWith('+++ ')
      if (noisy) continue
      tr.className = 'meta'
      tr.innerHTML = `<td colspan="3">${esc(text)}</td>`
    } else {
      tr.className = cls
      tr.innerHTML =
        `<td class="ln">${lnOld}</td><td class="ln">${lnNew}</td><td class="code">${esc(text)}</td>`
    }
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return { table, add, del }
}

// ---------- 加载历史 ----------
async function loadHistory({ keepActive = false } = {}) {
  const prevActive = keepActive ? state.activeSha : null
  state.activeSha = null
  $('h-list').innerHTML = '<div class="h-empty">加载历史…</div>'
  $('h-empty').hidden = true
  $('h-diff-body').innerHTML = '<div class="empty">从左侧选择一条提交查看 diff</div>'
  $('h-diff-sha').textContent = ''
  $('h-diff-subject').textContent = ''
  $('h-diff-stat').innerHTML = ''
  $('h-copy-sha').disabled = true

  const params = new URLSearchParams({ path: state.filePath })
  if (wtPath) params.set('wt', wtPath)
  if (!state.follow) params.set('follow', '0')
  try {
    const data = await api(`/api/repos/${repoId}/file-history?${params}`)
    state.commits = data.commits || []
    state.followActual = data.follow
    applyFilter()

    if (!state.commits.length) return
    // 恢复之前选中的那条，否则选第一条
    const keep = prevActive && state.commits.find((c) => c.sha === prevActive)
    selectCommit(keep || state.commits[0])
  } catch (err) {
    $('h-list').replaceChildren()
    const e = $('h-empty')
    e.hidden = false
    e.innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`
  }
}

function applyFilter() {
  const f = $('h-filter').value.trim().toLowerCase()
  state.filtered = !f
    ? state.commits
    : state.commits.filter((c) =>
        c.subject.toLowerCase().includes(f) ||
        c.author.toLowerCase().includes(f) ||
        c.sha.toLowerCase().includes(f))
  renderList()
}

// ---------- 交互绑定 ----------
$('h-filter').addEventListener('input', applyFilter)

$('h-follow').addEventListener('change', (e) => {
  state.follow = e.target.checked
  // 记住选择，下次打开沿用
  const u = new URL(location.href)
  if (state.follow) u.searchParams.delete('follow')
  else u.searchParams.set('follow', '0')
  history.replaceState(null, '', u)
  loadHistory()
})

$('h-copy-sha').addEventListener('click', async () => {
  if (!state.activeSha) return
  try {
    await navigator.clipboard.writeText(state.activeSha)
    toast('已复制 sha')
  } catch {
    toast('复制失败，请手动选择')
  }
})

// 列表宽度拖动
const SPLIT_KEY = 'wsl-worktree.historyListWidth'
;(function initSplitter() {
  const layout = $('h-layout')
  const sp = $('h-splitter')
  let dragging = false

  const saved = Number(localStorage.getItem(SPLIT_KEY))
  if (Number.isFinite(saved) && saved >= 260) {
    layout.style.setProperty('--w-list', `${saved}px`)
  }

  const onMove = (e) => {
    if (!dragging) return
    const rect = layout.getBoundingClientRect()
    const w = Math.min(Math.max(260, e.clientX - rect.left), Math.min(rect.width - 320, window.innerWidth * 0.7))
    layout.style.setProperty('--w-list', `${Math.round(w)}px`)
    e.preventDefault()
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    sp.classList.remove('dragging')
    document.body.style.cursor = ''
    const w = parseInt(getComputedStyle(layout).getPropertyValue('--w-list'), 10)
    if (Number.isFinite(w)) localStorage.setItem(SPLIT_KEY, String(w))
  }
  sp.addEventListener('mousedown', (e) => {
    dragging = true
    sp.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
  })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  sp.addEventListener('dblclick', () => {
    layout.style.setProperty('--w-list', '420px')
    localStorage.setItem(SPLIT_KEY, '420')
  })
})()

// 键盘：j / k 上下切换，方便连续扫历史
document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.matches('input, textarea')) return
  if (e.key !== 'j' && e.key !== 'k') return
  const list = state.filtered
  if (!list.length) return
  const idx = list.findIndex((c) => c.sha === state.activeSha)
  const next = e.key === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1)
  if (next === idx) return
  e.preventDefault()
  selectCommit(list[next])
  // 把选中行滚进视野
  const row = $('h-list').querySelector(`.h-row[data-sha="${CSS.escape(list[next].sha)}"]`)
  if (row?.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
})

// ============================================================
// 顶栏文件路径切换器
// 平时显示为文本，点击变成输入框；输入时按路径模糊匹配前 20 条。
// ============================================================
const PATH_LIMIT = 20

/** 把当前文件路径同步到顶栏和文档标题、URL */
function syncPathUI() {
  const el = $('h-path-text')
  el.textContent = state.filePath
  el.style.color = ''   // 清掉「搜索文件…」占位时的灰色
  $('h-path-btn').title = `${state.filePath}\n（点击切换文件）`
  document.title = `History · ${state.filePath.split('/').pop()}`
  // URL 跟着变，这样切完文件可以直接收藏/分享
  const u = new URL(location.href)
  u.searchParams.set('path', state.filePath)
  history.replaceState(null, '', u)
}

/** 懒加载仓库全部文件（第一次点开切换器时才取，避免白等 18k 文件的请求） */
async function ensureFiles() {
  if (state.filesLoaded) return state.allFiles
  try {
    const data = await api(`/api/repos/${repoId}/files`)
    state.allFiles = data.files || []
    state.filesLoaded = true
  } catch {
    state.allFiles = []
  }
  return state.allFiles
}

let pathAC = null

/** 打开输入框并聚焦（主界面点「文件历史」时也是走这里） */
async function openPathInput({ selectAll = true } = {}) {
  const btn = $('h-path-btn')
  const input = $('h-path-input')
  btn.hidden = true
  input.hidden = false
  // 输入框里放当前路径作为起点，方便「基于当前路径改几个字符」
  input.value = state.filePath || ''
  input.focus()
  if (selectAll && state.filePath) requestAnimationFrame(() => input.select())

  // 首次打开时把全部文件取回来（18k 文件的 ls-files 也就几十毫秒），
  // 之后输入就有即时候选
  await ensureFiles()
}

function closePathInput() {
  const btn = $('h-path-btn')
  const input = $('h-path-input')
  if (input.hidden) return
  input.hidden = true
  btn.hidden = false
  // 输入框内容始终清空：它显示的是「查询词」，不是当前路径。
  // 当前路径由 #h-path-text 负责显示，两者不该混在一起。
  input.value = ''
  if (pathAC) pathAC.close()
}

/** 切换到另一个文件：重载历史 */
async function switchToFile(path) {
  if (!path) return
  const changed = path !== state.filePath
  closePathInput()   // 内部已清空输入框
  if (!changed) {
    // 同一个文件：只把输入框收起来，不重新请求
    syncPathUI()
    return
  }
  state.filePath = path
  syncPathUI()
  await loadHistory()
}

/**
 * 历史页专用的轻量自动完成。
 * 不复用主界面那个（在 app.js 里、没导出），这里只需要「输入→列候选→上下键→回车选中」，
 * 外加把命中字符高亮，实现约 60 行，比把通用组件搬过来更省事。
 */
function attachHistoryAutocomplete(input, opt) {
  const panel = document.createElement('div')
  panel.className = 'h-ac-panel'
  panel.hidden = true
  document.body.appendChild(panel)

  let items = []
  let active = 0
  let suppress = false

  const close = () => { panel.hidden = true; active = 0 }
  const isOpen = () => !panel.hidden

  const place = () => {
    const r = input.getBoundingClientRect()
    panel.style.left = `${Math.round(r.left)}px`
    panel.style.top = `${Math.round(r.bottom + 2)}px`
    // 宽度跟输入框对齐；内容更长时由 CSS 的 max-width + 自适应撑开
    panel.style.width = `${Math.round(Math.max(r.width, 340))}px`
  }

  /** 高亮命中的字符（按子序列标记，和模糊匹配的口径一致） */
  const highlight = (text, query) => {
    const q = String(query || '').trim().toLowerCase()
    if (!q) return esc(text)
    const t = String(text)
    const tl = t.toLowerCase()
    const hit = new Set()
    let ti = 0
    for (const ch of q) {
      const f = tl.indexOf(ch, ti)
      if (f < 0) break
      hit.add(f)
      ti = f + 1
    }
    let out = ''
    for (let i = 0; i < t.length; i++) {
      out += hit.has(i) ? `<mark>${esc(t[i])}</mark>` : esc(t[i])
    }
    return out
  }

  const render = (list) => {
    if (!list.length) {
      panel.innerHTML = `<div class="h-ac-empty">${esc(opt.emptyHint || '无匹配')}</div>`
      panel.hidden = false
      place()
      return
    }
    panel.replaceChildren()
    list.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'h-ac-item' + (i === active ? ' active' : '')
      row.dataset.value = it.value
      row.innerHTML = `<span class="label">${highlight(it.label ?? it.value, input.value)}</span>`
      row.addEventListener('mousedown', (e) => {
        // mousedown：click 会先让 input blur 把面板关掉
        e.preventDefault()
        pick(it)
      })
      panel.appendChild(row)
    })
    panel.hidden = false
    place()
  }

  const pick = (it) => {
    suppress = true
    input.value = it.value
    suppress = false
    close()
    if (opt.onPick) opt.onPick(it)
  }

  const refresh = () => {
    if (suppress) return
    const q = input.value.trim()
    if (!q) { close(); return }
    items = opt.getItems() || []
    // 默认高亮第一条，这样直接回车就能选中
    active = 0
    render(items)
  }

  input.addEventListener('input', refresh)
  input.addEventListener('focus', () => { if (input.value.trim()) refresh() })

  input.addEventListener('keydown', (e) => {
    if (!isOpen()) {
      if (e.key === 'ArrowDown' && input.value.trim()) { e.preventDefault(); refresh() }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      active = Math.min(items.length - 1, active + 1)
      render(items)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      active = Math.max(0, active - 1)
      render(items)
    } else if (e.key === 'Enter') {
      // 有候选时回车选中它；没有候选则交给调用方自行处理（比如按路径直接切）
      if (items[active]) {
        e.preventDefault()
        e.stopImmediatePropagation()
        pick(items[active])
      }
    } else if (e.key === 'Escape') {
      // 第一次 Esc 关面板，且不阻止冒泡 —— 让外层的处理顺带把输入框也收起来。
      // 这样用户按一次 Esc 就回到文本态，不用按两次。
      if (isOpen()) { e.preventDefault(); close() }
    }
  }, true)   // capture：抢在外层 keydown 处理之前

  window.addEventListener('scroll', () => { if (isOpen()) place() }, true)
  window.addEventListener('resize', () => { if (isOpen()) place() })

  return { close, isOpen }
}

function initPathPicker() {
  const btn = $('h-path-btn')
  const input = $('h-path-input')

  btn.addEventListener('click', () => openPathInput())

  pathAC = attachHistoryAutocomplete(input, {
    emptyHint: '没有匹配的文件',
    getItems: () => {
      const q = input.value.trim()
      if (!q) return []
      // 取前 20 条：模糊分排序后截断
      return rankByFuzzy(q, state.allFiles, PATH_LIMIT).map((p) => ({
        value: p,
        // 只显示文件名 + 末两级目录：完整长路径在这里没有信息量
        label: shortPath(p),
        raw: p,
      }))
    },
    onPick: (item) => {
      if (item?.raw) switchToFile(item.raw)
    },
  })

  // 键盘补充处理（Escape/Enter 有候选时已被 attachHistoryAutocomplete 的 capture 阶段拦掉，
  // 这里只处理「没有候选」的情况）
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePathInput()
      return
    }
    if (e.key === 'Enter') {
      const v = input.value.trim()
      if (!v) return
      e.preventDefault()
      // 没有候选时：允许直接输入完整路径回车切换，否则取最佳模糊匹配
      const exact = state.allFiles.includes(v)
      const best = exact ? v : rankByFuzzy(v, state.allFiles, 1)[0]
      if (best) switchToFile(best)
      else toast('没有匹配的文件')
    }
  })

  // 失焦收起（延迟，让点击候选先生效）
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement === input) return
      closePathInput()
    }, 160)
  })
}

/** 文件路径的短名：末两级 + 文件名，例如 .../intercept/applicationnav/Foo.java */
function shortPath(p) {
  const parts = String(p).split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}

// ---------- 初始化 ----------
async function init() {
  if (!repoId) {
    document.body.innerHTML =
      '<div class="h-empty" style="padding:40px">缺少参数：需要 repo。<br>请从主界面右上角的「文件历史」进入。</div>'
    return
  }
  $('h-wt').textContent = shortWt()
  $('h-wt').title = wtPath || ''
  $('h-follow').checked = state.follow
  initPathPicker()

  // 仓库名：尽量从 /api/repos 里取，失败就显示 id 尾部
  try {
    const data = await api('/api/repos')
    const repo = (data.repos || []).find((r) => r.id === repoId)
    if (repo) {
      state.repo = repo
      $('h-repo').textContent = repo.name
      $('h-wt').textContent = shortWt()
    }
  } catch {}

  // 没有 path：从右上角按钮进来，先把文件列表准备好，直接让用户输入
  if (!state.filePath) {
    await ensureFiles()
    // 用仓库里第一个文件占位，避免整页空白；用户一输入就会被替换
    if (state.allFiles.length) {
      // 不自动选中任何文件，只把提示写在路径框里
      $('h-path-text').textContent = '搜索文件…'
      $('h-path-text').style.color = 'var(--text-faint)'
      $('h-path-btn').title = '点击或直接输入路径搜索文件'
      document.title = 'History'
      $('h-list').innerHTML = '<div class="h-empty">在上方输入路径或文件名，选择一个文件查看它的提交历史。</div>'
      $('h-diff-body').innerHTML = '<div class="h-empty">尚未选择文件。</div>'
      await openPathInput({ selectAll: false })
      $('h-path-input').value = ''
      $('h-path-input').placeholder = '输入路径或文件名，模糊搜索…'
      return
    }
  }

  syncPathUI()

  // 从主界面「文件历史」按钮进来时带了 focus=1，直接把焦点放到路径框
  if (qs.get('focus') === '1') {
    await openPathInput()
  }

  await loadHistory()
}

init()
