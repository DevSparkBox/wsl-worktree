// ============================================================
// 提交对比页（独立页面）
// URL: /compare.html?repo=<id>&a=<rev>&b=<rev>
//
// 左侧树只包含「有变更的文件」——这是本页与文件树页的根本区别：
// 数据源是 git diff 的结果，不是 ls-tree 的全量清单。
// ============================================================

import { escHtml as esc } from '/linkify.js'
import { fuzzyScore } from '/fuzzy.js'
import { buildTree, countFiles, displayChainName } from '/tree-model.js'
import { renderPatchTable } from '/patch-view.js'
import { initSplitter } from '/splitter.js'

const $ = (id) => document.getElementById(id)
const qs = new URLSearchParams(location.search)

const ICON_DIR =
  '<svg class="t-ico" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M2 4.2c0-.7.6-1.3 1.3-1.3h2.6l1.4 1.6h5.4c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.3-1.3 1.3H3.3c-.7 0-1.3-.6-1.3-1.3V4.2z" ' +
  'stroke="currentColor" stroke-width="1.3" fill="none"/></svg>'

const ICON_FILE =
  '<svg class="t-ico" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M3.5 2.5h6L12.5 5.5v8h-9v-11z" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
  '<path d="M9.3 2.6v3.2h3.1" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>'

const CARET_CLOSED =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CARET_OPEN =
  '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** 状态 → 中文 + CSS 变体，用于徽章和筛选按钮 */
const STATUS_META = {
  M: { label: '修改', cls: 'm' },
  A: { label: '新增', cls: 'a' },
  D: { label: '删除', cls: 'd' },
  R: { label: '改名', cls: 'r' },
  C: { label: '复制', cls: 'r' },
  T: { label: '类型变更', cls: 'm' },
}

const state = {
  repo: null,
  a: qs.get('a') || 'HEAD~1',
  b: qs.get('b') || 'HEAD',
  files: [],
  stats: null,
  root: null,
  byPath: new Map(),   // path → 变更条目（树节点里只放了 path，信息靠它查）
  collapsed: new Set(), // 默认全展开，所以记「已折叠」
  filter: '',
  statusFilter: new Set(), // 空 = 全部
  selected: null,
  seq: 0,
  lastPickInput: 'c-a',
}

async function api(path) {
  const res = await fetch(path)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function toast(msg) {
  const t = $('c-toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(t._timer)
  t._timer = setTimeout(() => { t.hidden = true }, 2200)
}

/** 270080 → 270.1k，让 +/− 在窄列里也放得下 */
function fmtNum(n) {
  if (n == null) return '—'
  if (n < 1000) return String(n)
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

/** 短 sha 显示 */
const shortSha = (s) => (s ? String(s).slice(0, 8) : '')

// ============================================================
// 加载
// ============================================================
async function loadRepoInfo() {
  const repos = await api('/api/repos')
  const repo = (repos.repos || []).find((r) => r.id === qs.get('repo'))
  if (!repo) throw new Error('找不到这个仓库')
  state.repo = repo
  $('c-repo').textContent = repo.name
  $('c-repo').title = repo.toplevel
  $('c-back').href = `/tree.html?repo=${encodeURIComponent(repo.id)}&sha=${encodeURIComponent(state.b)}`
  document.title = `Compare · ${repo.name}`
}

/** 最近提交，填「从最近提交里选」下拉。
 * 只需要 URL 里的 repo id，不必等 /api/repos 返回，所以可以和它并行发。 */
async function loadRecent(repoId) {
  if (!repoId) return
  // 页面卸载/跳转时主动中断，避免控制台出现无意义的 "Failed to fetch"
  const ac = new AbortController()
  const onLeave = () => ac.abort()
  window.addEventListener('pagehide', onLeave, { once: true })
  try {
    const res = await fetch(`/api/repos/${repoId}/log?count=50`, { signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const d = await res.json()
    const sel = $('c-recent')
    for (const c of d.commits || []) {
      const opt = document.createElement('option')
      opt.value = c.sha
      const refs = (c.refs || []).length ? `  [${c.refs.join(', ')}]` : ''
      opt.textContent = `${c.sha.slice(0, 8)}  ${String(c.subject || '').slice(0, 60)}${refs}`
      sel.appendChild(opt)
    }
  } catch (e) {
    // 被主动中断不算错误；其他原因至少要能在 console 里看到
    if (e?.name !== 'AbortError') console.warn('[compare] 最近提交加载失败：', e?.message || e)
  } finally {
    window.removeEventListener('pagehide', onLeave)
  }
}

async function loadCompare() {
  const box = $('c-tree')
  const empty = $('c-empty')
  box.replaceChildren()
  empty.hidden = false
  empty.textContent = '正在对比…'
  $('c-stat').textContent = ''

  const params = new URLSearchParams({ a: state.a, b: state.b })
  const t0 = performance.now()
  let data
  try {
    data = await api(`/api/repos/${state.repo.id}/compare?${params}`)
  } catch (err) {
    empty.textContent = err.message
    empty.style.color = 'var(--red)'
    $('c-filters').hidden = true
    return
  }
  empty.style.color = ''

  state.files = data.files || []
  state.stats = data.stats || { files: 0, add: 0, del: 0, byStatus: {} }
  state.a = shortSha(data.a) || state.a
  state.b = shortSha(data.b) || state.b
  $('c-a').value = shortSha(data.a)
  $('c-b').value = shortSha(data.b)
  syncUrl()

  const ms = Math.round(performance.now() - t0)
  $('c-stat').innerHTML =
    state.stats.files
      ? `<strong>${state.stats.files}</strong> 文件 · <span class="c-add">+${fmtNum(state.stats.add)}</span> <span class="c-del">−${fmtNum(state.stats.del)}</span> · ${ms}ms`
      : `无变更 · ${ms}ms`

  if (!state.files.length) {
    state.root = null
    empty.hidden = false
    empty.textContent = '两个提交的内容完全相同，没有差异。'
    $('c-filters').hidden = true
    $('c-file-path').textContent = ''
    $('c-file-meta').textContent = ''
    $('c-file-status').innerHTML = ''
    $('c-file-body').innerHTML =
      '<div class="t-empty" style="padding:24px 16px">没有需要展示的变更。</div>'
    return
  }

  // 树：复用 tree-model 的建树 + 单链目录压缩。
  // 只喂 path，状态和行数放在 byPath 里按需查（buildTree 会丢掉额外字段）。
  state.byPath = new Map(state.files.map((f) => [f.path, f]))
  state.root = buildTree(state.files.map((f) => ({ path: f.path, size: null })), true)
  state.collapsed.clear()

  renderStatusFilters()
  renderTree()
  // 默认选中第一个变更文件，省一次点击
  const first = state.files.find((f) => !state.statusFilter.size || state.statusFilter.has(f.status))
  if (first) selectFile(first.path)
}

// ============================================================
// 状态筛选
// ============================================================
function renderStatusFilters() {
  const box = $('c-filters')
  const by = state.stats?.byStatus || {}
  // 只列真实出现的状态：一个纯改名的对比没必要显示「新增」按钮
  const order = ['M', 'A', 'D', 'R', 'C', 'T'].filter((s) => by[s])
  if (!order.length) {
    box.hidden = true
    return
  }
  box.hidden = false
  const frag = document.createDocumentFragment()

  const addBtn = (key, label, cls, count) => {
    const b = document.createElement('button')
    // 「全部」没有状态码（key === ''），它的 on 态是「没有任何筛选」
    const isOn = key === '' ? state.statusFilter.size === 0 : state.statusFilter.has(key)
    b.className = `c-filter-btn${cls ? ` c-badge-${cls}` : ''}${isOn ? ' on' : ''}`
    b.dataset.status = key
    b.innerHTML = `${esc(label)}<span class="c-filter-count">${count}</span>`
    b.addEventListener('click', () => {
      // 注意：「全部」必须 clear，不能走 toggle。
      // 早先写成 add('')，集合变成 {'A',''}，size 非 0 于是仍然只在筛 A，
      // 用户点「全部」却什么都没恢复。
      if (key === '') {
        state.statusFilter.clear()
      } else if (state.statusFilter.has(key)) {
        state.statusFilter.delete(key)
      } else {
        state.statusFilter.add(key)
      }
      renderStatusFilters()
      renderTree()
    })
    frag.appendChild(b)
  }

  addBtn('', '全部', '', state.stats.files)
  for (const s of order) {
    const meta = STATUS_META[s] || { label: s, cls: 'm' }
    addBtn(s, s, meta.cls, by[s])
  }
  box.replaceChildren(frag)
}

/** 当前参与展示的条目（受状态筛选影响） */
function visibleFiles() {
  if (!state.statusFilter.size) return state.files
  return state.files.filter((f) => state.statusFilter.has(f.status))
}

// ============================================================
// 树渲染
// ============================================================
/** 目录节点上的统计：变更文件数 + 增删行 */
function aggregate(node) {
  let count = node.files.length
  let add = 0
  let del = 0
  for (const f of node.files) {
    const e = state.byPath.get(f.path)
    if (e) {
      if (e.add != null) add += e.add
      if (e.del != null) del += e.del
    }
  }
  for (const d of node.dirs.values()) {
    const sub = d._agg || (d._agg = aggregate(d))
    count += sub.count
    add += sub.add
    del += sub.del
  }
  return { count, add, del }
}

function renderTree() {
  const box = $('c-tree')
  const empty = $('c-empty')
  if (!state.root) {
    box.replaceChildren()
    return
  }

  const frag = document.createDocumentFragment()

  // 过滤模式：扁平列表（同文件树页的做法，同名文件靠目录标签区分）
  if (state.filter) {
    const q = state.filter.toLowerCase()
    const scored = []
    for (const f of visibleFiles()) {
      const name = f.path.split('/').pop().toLowerCase()
      let rank = null
      if (name.includes(q)) rank = 3000 - Math.min(200, name.indexOf(q))
      else if (state.statusFilter.size && !state.statusFilter.has(f.status)) continue
      else {
        const s = fuzzyScore(state.filter, f.path)
        if (s != null) rank = s
      }
      if (rank != null) scored.push([f, rank])
    }
    scored.sort((a, b) => b[1] - a[1])
    if (!scored.length) {
      box.replaceChildren()
      empty.hidden = false
      empty.textContent = '没有匹配的变更文件。'
      return
    }
    for (const [f] of scored.slice(0, 300)) frag.appendChild(fileRow(f, 0, true))
    if (scored.length > 300) {
      const more = document.createElement('div')
      more.className = 't-more'
      more.textContent = `另有 ${scored.length - 300} 条未显示，请细化过滤条件`
      frag.appendChild(more)
    }
    box.replaceChildren(frag)
    empty.hidden = true
    return
  }

  // 目录树：默认全展开（没有变更的目录本来就不在树里，树已经很稀疏）
  const walk = (node, depth) => {
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      const agg = d._agg || (d._agg = aggregate(d))
      if (!agg.count) continue
      const isOpen = !state.collapsed.has(d.path)
      frag.appendChild(dirRow(d, agg, depth, isOpen))
      if (isOpen) walk(d, depth + 1)
    }
    for (const f of node.files) {
      const e = state.byPath.get(f.path)
      if (!e) continue
      if (state.statusFilter.size && !state.statusFilter.has(e.status)) continue
      frag.appendChild(fileRow(e, depth, false, f.name))
    }
  }
  walk(state.root, 0)
  box.replaceChildren(frag)
  empty.hidden = true
}

function dirRow(d, agg, depth, isOpen) {
  const el = document.createElement('div')
  el.className = 't-node t-dir' + (isOpen ? ' open' : '')
  el.dataset.path = d.path
  el.setAttribute('role', 'treeitem')
  el.setAttribute('aria-expanded', String(isOpen))
  el.style.paddingLeft = `${6 + depth * 13}px`
  const compressed = Array.isArray(d.aliases) && d.aliases.length > 0
  const shown = compressed ? displayChainName(d.name) : d.name
  el.innerHTML =
    `<span class="t-caret">${isOpen ? CARET_OPEN : CARET_CLOSED}</span>` +
    ICON_DIR +
    `<span class="t-name${compressed ? ' t-name-compressed' : ''}"${compressed ? ` title="${esc(d.name)}"` : ''}>${esc(shown)}</span>` +
    `<span class="t-count">${agg.count}</span>` +
    linesCell(agg.add, agg.del)
  el.addEventListener('click', () => {
    if (state.collapsed.has(d.path)) state.collapsed.delete(d.path)
    else state.collapsed.add(d.path)
    renderTree()
  })
  return el
}

function fileRow(f, depth, showDir, name) {
  const el = document.createElement('div')
  el.className = 't-node t-file' + (f.path === state.selected ? ' active' : '')
  el.dataset.path = f.path
  el.setAttribute('role', 'treeitem')
  el.style.paddingLeft = `${6 + depth * 13}px`
  el.title = f.oldPath ? `${f.oldPath}\n→ ${f.path}` : f.path
  const base = name || f.path.split('/').pop()
  // 过滤模式没有层级，把目录塞到行内，否则一堆同名文件分不清
  const dirLabel = showDir ? f.path.slice(0, Math.max(0, f.path.length - base.length - 1)) : ''
  const meta = STATUS_META[f.status] || { label: f.status, cls: 'm' }
  el.innerHTML =
    `<span class="t-caret t-caret-hidden"></span>` +
    ICON_FILE +
    `<span class="t-name">${esc(base)}</span>` +
    (dirLabel ? `<span class="t-dir-hint" title="${esc(dirLabel)}">${esc(dirLabel)}</span>` : '') +
    `<span class="c-badge c-badge-${meta.cls}" title="${esc(meta.label)}">${esc(f.status)}</span>` +
    (f.binary
      ? '<span class="c-badge c-badge-bin">BIN</span>'
      : linesCell(f.add, f.del))
  el.addEventListener('click', () => selectFile(f.path))
  return el
}

/** +N −N 单元格。二进制没有行数，留空由 BIN 徽章代替 */
function linesCell(add, del) {
  if (add == null && del == null) return '<span class="c-lines"></span>'
  const a = add ? `<span class="c-add">+${fmtNum(add)}</span>` : ''
  const d = del ? `<span class="c-del">−${fmtNum(del)}</span>` : ''
  return `<span class="c-lines">${a}${d}</span>`
}

// ============================================================
// 右侧 diff
// ============================================================
async function selectFile(path) {
  const entry = state.byPath.get(path)
  if (!entry) return
  state.selected = path
  // 只切选中态，不整树重渲染（上千节点时重渲染会明显卡）
  for (const el of $('c-tree').querySelectorAll('.t-file')) {
    el.classList.toggle('active', el.dataset.path === path)
  }

  const meta = STATUS_META[entry.status] || { label: entry.status, cls: 'm' }
  $('c-file-path').textContent = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path
  $('c-file-path').title = $('c-file-path').textContent
  $('c-file-status').className = `c-file-status c-badge-${meta.cls}`
  $('c-file-status').textContent = meta.label + (entry.similar != null ? ` ${entry.similar}%` : '')
  $('c-file-meta').innerHTML = entry.binary
    ? '二进制'
    : `<span class="c-add">+${fmtNum(entry.add)}</span> <span class="c-del">−${fmtNum(entry.del)}</span>`

  const body = $('c-file-body')
  const seq = ++state.seq

  if (entry.binary) {
    body.innerHTML = '<div class="t-empty" style="padding:24px 16px">二进制文件，无法显示逐行差异。</div>'
    return
  }

  body.innerHTML = '<div class="t-empty" style="padding:24px 16px">加载 diff…</div>'
  const params = new URLSearchParams({ a: state.a, b: state.b, path: entry.path })
  // 改名文件必须把旧路径一起传给后端：只给一边会退化成「新增」或「删除」
  if (entry.oldPath) params.set('old', entry.oldPath)

  try {
    const data = await api(`/api/repos/${state.repo.id}/compare-file?${params}`)
    if (seq !== state.seq) return // 快速点击时丢弃过期响应
    if (!data.patch) {
      body.innerHTML = '<div class="t-empty" style="padding:24px 16px">这个文件在两个提交之间没有内容差异（可能只是改名或模式变更）。</div>'
      return
    }
    const { table } = renderPatchTable(data.patch)
    body.replaceChildren(table)
    if (data.truncated) {
      const t = document.createElement('div')
      t.className = 't-empty'
      t.style.padding = '8px 16px'
      t.textContent = 'diff 过大，已截断。'
      body.appendChild(t)
    }
  } catch (err) {
    if (seq !== state.seq) return
    body.innerHTML = `<div class="t-empty" style="padding:24px 16px;color:var(--red)">${esc(err.message)}</div>`
  }
}

// ============================================================
// A/B 交互
// ============================================================
function syncUrl() {
  const p = new URLSearchParams({ repo: state.repo.id, a: state.a, b: state.b })
  history.replaceState(null, '', `/compare.html?${p}`)
}

function setAb(a, b) {
  state.a = a
  state.b = b
  $('c-a').value = a
  $('c-b').value = b
  loadCompare()
}

function setupPickers() {
  for (const id of ['c-a', 'c-b']) {
    const el = $(id)
    // 记下最后聚焦的输入框，「最近提交」下拉就往它里面填
    el.addEventListener('focus', () => { state.lastPickInput = id })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        // 空值不让提交：否则会变成空 rev，报错信息不如直接拦住
        const a = $('c-a').value.trim()
        const b = $('c-b').value.trim()
        if (!a || !b) { toast('A 和 B 都要填'); return }
        setAb(a, b)
      }
    })
  }

  $('c-swap').addEventListener('click', () => {
    const a = $('c-a').value.trim()
    const b = $('c-b').value.trim()
    if (!a || !b) return
    setAb(b, a)
  })

  $('c-recent').addEventListener('change', (e) => {
    const v = e.target.value
    if (!v) return
    $(state.lastPickInput).value = v.slice(0, 8)
    e.target.value = ''
  })

  // 过滤
  let timer = null
  $('c-filter').addEventListener('input', (e) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      state.filter = e.target.value.trim()
      renderTree()
    }, 120)
  })
  $('c-filter').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = ''
      state.filter = ''
      renderTree()
    }
  })

  // 全部折叠 / 展开
  $('c-collapse').addEventListener('click', () => {
    if (!state.root) return
    const dirs = []
    const walk = (n) => {
      for (const d of n.dirs.values()) { dirs.push(d.path); walk(d) }
    }
    walk(state.root)
    const allCollapsed = dirs.length > 0 && dirs.every((p) => state.collapsed.has(p))
    state.collapsed.clear()
    if (!allCollapsed) for (const p of dirs) state.collapsed.add(p)
    renderTree()
    toast(allCollapsed ? '已全部展开' : '已全部折叠')
  })
}

// ============================================================
// 启动
// ============================================================
;(async () => {
  initSplitter({
    layout: $('c-layout'),
    splitter: $('c-splitter'),
    storageKey: 'wsl-worktree.compareTreeWidth',
    defaultWidth: 380,
  })
  setupPickers()

  if (!qs.get('repo')) {
    $('c-empty').hidden = false
    $('c-empty').textContent = '缺少 repo 参数。请从主界面选择一个仓库再进入。'
    return
  }

  $('c-a').value = state.a
  $('c-b').value = state.b

  // 最近提交和仓库信息并行拉：loadRecent 只依赖 URL 里的 repo id
  const recentPromise = loadRecent(qs.get('repo'))

  try {
    await loadRepoInfo()
    await loadCompare()
  } catch (err) {
    $('c-empty').hidden = false
    $('c-empty').textContent = err.message
    $('c-empty').style.color = 'var(--red)'
  }
  // 下拉晚一点填完没关系，不阻塞主内容
  recentPromise.catch(() => {})
})()
