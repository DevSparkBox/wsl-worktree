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
  // A/B 选择器
  commits: [],        // 提交索引：最近 N 条 + 全部 tag/分支尖端（浮层数据源）
  menuSide: null,     // 'a' | 'b'，浮层锚定到哪一侧
  menuItems: [],      // 当前浮层里渲染出的条目
  menuIndex: -1,      // 键盘高亮位置
  resolvedA: null,    // 后端解析出的完整 sha，用于给输入框挂 subject 提示
  resolvedB: null,
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

/**
 * 提交索引：最近 N 条 + **所有 tag / 分支尖端**。
 *
 * 只用最近 50 条的话，老 tag 指向的提交根本不在列表里——比如 v5.5.10.55
 * 是几个月前的，用户想按 tag 找就搜不到。ref-log 覆盖了全部 1917 个 ref 尖端
 * （jm_java 实测 103ms），合并后按时间倒序。
 *
 * 只依赖 URL 里的 repo id，不必等 /api/repos 返回，所以可以和它并行发。
 */
async function loadCommitIndex(repoId) {
  if (!repoId) return
  // 页面卸载/跳转时主动中断，避免控制台出现无意义的 "Failed to fetch"
  const ac = new AbortController()
  const onLeave = () => ac.abort()
  window.addEventListener('pagehide', onLeave, { once: true })
  try {
    const [recentRes, refRes] = await Promise.all([
      fetch(`/api/repos/${repoId}/log?count=50`, { signal: ac.signal }),
      // ref-log 失败也不致命：至少还有最近 50 条可用
      fetch(`/api/repos/${repoId}/ref-log`, { signal: ac.signal }).catch(() => null),
    ])
    if (!recentRes.ok) throw new Error(`HTTP ${recentRes.status}`)
    const recent = (await recentRes.json()).commits || []
    let refTips = []
    if (refRes && refRes.ok) {
      try { refTips = (await refRes.json()).commits || [] } catch {}
    }

    // 以 sha 合并：两边都可能包含对方没有的条目
    const bySha = new Map()
    for (const c of refTips) bySha.set(c.sha, { ...c })
    for (const c of recent) {
      const cur = bySha.get(c.sha)
      if (cur) {
        // %D 的 decorate 在新旧提交上可能略有差异，取并集
        cur.refs = [...new Set([...(cur.refs || []), ...(c.refs || [])])]
      } else {
        bySha.set(c.sha, { ...c })
      }
    }
    state.commits = [...bySha.values()].sort((a, b) => b.time - a.time)

    // 浮层已经打开（用户点得比请求快）时补渲染
    if (state.menuSide) {
      renderMenu($('c-menu-search').value)
      $('c-menu-search').focus()
    }
    // 已解析出的 A/B 补上 subject 提示
    decoratePick('a', state.resolvedA)
    decoratePick('b', state.resolvedB)
  } catch (e) {
    // 被主动中断不算错误；其他原因至少要能在 console 里看到
    if (e?.name !== 'AbortError') console.warn('[compare] 提交列表加载失败：', e?.message || e)
    if (state.menuSide) {
      $('c-menu-list').innerHTML = '<div class="c-menu-empty">提交列表加载失败，仍可直接粘贴 sha / tag</div>'
    }
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
  state.resolvedA = data.a || null
  state.resolvedB = data.b || null
  $('c-a').value = shortSha(data.a)
  $('c-b').value = shortSha(data.b)
  // 输入框只有 8 位 sha，鼠标悬停能看到完整 sha + 提交标题，确认选对了没有
  decoratePick('a', data.a)
  decoratePick('b', data.b)
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

// ---------- A / B 选择器：输入框 + 最近提交浮层 ----------
//
// 早先是「两个输入框 + 一个全局『最近提交』下拉」，下拉填到哪个框取决于
// 最后聚焦的输入框——这是隐式约定，用户不知道会填哪边。现在每侧自带 ▾，
// 浮层锚定在被点的那一侧，语义明确。

function relTime(ms) {
  if (!ms) return ''
  const diff = (Date.now() - ms) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`
  if (diff < 86400 * 365) return `${Math.floor(diff / 86400 / 30)} 个月前`
  return `${Math.floor(diff / 86400 / 365)} 年前`
}

const pickEl = (side) => $(side === 'a' ? 'c-pick-a' : 'c-pick-b')
const inputEl = (side) => $(side === 'a' ? 'c-a' : 'c-b')

/**
 * 浮层里那一小块 ref 标签显示什么。
 *
 * 完整 ref 往往很长（origin/hotfix/h-tag-5.5.13.11-主项问题修复1020），
 * 塞进小徽章只会变成「…/h-tag-5.5.13.11-主项…」。但也不能只截版本号——
 * 同一个版本号下面往往挂着好几条不同的 hotfix 分支，全显示成 v5.5.13.11
 * 会让列表看起来「满屏重复标签」，反而分不清是哪个分支。
 *
 * 所以显示**各分支真正不同的部分**：
 *   1. 真 tag → 原样（tag 名短且唯一，是「发布版本」的强信号）
 *   2. 分支名带版本号 → 取版本号之后的尾巴
 *      hotfix/h-tag-5.5.13.11-主项问题修复1020 → 主项问题修复1020
 *      太长交给 CSS ellipsis 截，不在这里手工拼 …
 *   3. 其余 → 去掉 origin/ 后的最后一段
 * 完整名字始终放在 title 里。
 *
 * 返回 { text, kind }，kind 用来区分 tag（紫）和分支（灰）。
 */
function pickRefLabel(refs) {
  // refs 里 tag 可能带 "tag: " 前缀（`refs-at` / log 接口的格式），先归一化再判断，
  // 否则 `tag: v5.5.13.13` 不匹配版本号正则，会被当成普通分支（颜色也标错）。
  // `%D` 还会把「HEAD 指向当前分支」写成 `HEAD -> main`，只保留分支名。
  const entries = (refs || [])
    .map((r) => {
      const isTag = /^tag:\s*/.test(r)
      let name = String(r).replace(/^tag:\s*/, '')
      if (/^HEAD -> /.test(name)) name = name.replace(/^HEAD -> /, '')
      else if (name === 'HEAD') return null // 纯 detached HEAD，没有信息量
      return name ? { name, isTag } : null
    })
    .filter(Boolean)
  if (!entries.length) return null

  // tag 一般不含 "/"；加这个条件避免把名为 `5.5.13.11-xxx` 的分支误判成 tag
  const tag = entries.find((e) => e.isTag || (!e.name.includes('/') && /^v?\d+\.\d+/.test(e.name)))
  if (tag) return { text: tag.name, kind: 'tag' }

  const br = entries[0].name.replace(/^origin\//, '').replace(/^tags\//, '')

  // 版本号之后的尾巴：h-tag-5.5.13.11-主项问题修复1020 → 主项问题修复1020
  // 用非贪婪匹配到第一个完整版本号，再把紧跟的分隔符（- 或 _）吃掉。
  const m = br.match(/^(.*?)(\d+\.\d+\.\d+(?:\.\d+)?)[-_]?(.+)$/)
  if (m && m[3] && m[3].trim().length >= 2) {
    return { text: m[3].trim(), kind: 'branch' }
  }
  // 没有版本号的普通分支
  if (br.length <= 18) return { text: br, kind: 'branch' }
  const segs = br.split('/').filter(Boolean)
  return { text: segs[segs.length - 1] || br, kind: 'branch' }
}

function renderMenu(q = '') {
  const list = $('c-menu-list')
  const kw = q.trim().toLowerCase()
  const cur = inputEl(state.menuSide || 'a').value.trim()

  if (!state.commits.length) {
    list.innerHTML = '<div class="c-menu-empty">加载中…</div>'
    return
  }

  // 匹配 sha 前缀 / 提交信息 / **ref 名（tag 与分支）**
  // 只匹配前两者的话，输入 `v5.5.10.55` 这种 tag 是搜不到的——
  // tag 名往往不出现在提交信息里。
  const items = state.commits
    .filter((c) => !kw
      || c.sha.toLowerCase().startsWith(kw)
      || String(c.subject || '').toLowerCase().includes(kw)
      || (c.refs || []).some((r) => r.toLowerCase().includes(kw)))
    .slice(0, 100)

  if (!items.length) {
    // 搜不到时给出出路：输入的东西可能本身就是一个合法 rev（HEAD~5、分支名等）
    const raw = q.trim()
    list.innerHTML = raw
      ? `<div class="c-menu-empty">没有匹配的提交<br>
           <span class="c-menu-hint">按 Enter 直接把「${esc(raw)}」当作版本使用</span></div>`
      : '<div class="c-menu-empty">没有匹配的提交</div>'
    state.menuItems = []
    updateMenuFoot(0, Boolean(kw))
    return
  }

  list.innerHTML = items.map((c) => {
    // 当前这一侧已选中的那条给个静态标记，展开时能立刻确认「我现在选的是哪个」
    const isCur = cur.length >= 6 && c.sha.startsWith(cur)
    const ref = pickRefLabel(c.refs)
    return `<div class="c-menu-item${isCur ? ' current' : ''}" data-sha="${esc(c.sha)}" role="option">
      <span class="c-menu-sha">${esc(c.sha.slice(0, 8))}</span>
      ${ref ? `<span class="c-menu-ref c-menu-ref-${ref.kind}" title="${esc(c.refs.join(', '))}">${esc(ref.text)}</span>` : ''}
      <span class="c-menu-subject">${esc(c.subject || '(无标题)')}</span>
      <span class="c-menu-when">${esc(relTime(c.time))}</span>
    </div>`
  }).join('')

  state.menuItems = items
  state.menuIndex = -1
  list.scrollTop = 0
  updateMenuFoot(items.length, Boolean(kw))
}

/**
 * 浮层底部提示：说明搜索范围。
 * 数据源是「最近提交 + 全部 tag/分支尖端」，不是全部历史——
 * 不写清楚用户会以为搜不到就是没有。
 */
function updateMenuFoot(shown, isFiltered = false) {
  const el = $('c-menu-foot')
  const total = state.commits.length
  if (!total) { el.textContent = ''; return }
  const scope = `共 ${total} 条（最近提交 + 全部 tag/分支尖端）`
  if (isFiltered) {
    // 搜索时的数字是「命中数」，不是「前 N 条」，措辞要区分开
    el.textContent = `匹配 ${shown} 条 · ${scope}`
  } else {
    el.textContent = shown < total ? `显示前 ${shown} 条 · ${scope}` : scope
  }
}

function placeMenu(side) {
  const anchor = pickEl(side)
  const r = anchor.getBoundingClientRect()
  const menu = $('c-menu')
  const w = menu.offsetWidth || 420
  // 默认左对齐锚点；右侧放不下就往左挪，别被视口切掉
  const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
  menu.style.left = `${Math.round(left)}px`
  menu.style.top = `${Math.round(r.bottom + 4)}px`
}

function openMenu(side) {
  state.menuSide = side
  pickEl('a').classList.toggle('active', side === 'a')
  pickEl('b').classList.toggle('active', side === 'b')
  $('c-menu').hidden = false
  $('c-menu-search').value = ''
  renderMenu('')
  placeMenu(side)
  if (state.commits.length) $('c-menu-search').focus()
}

function closeMenu() {
  $('c-menu').hidden = true
  state.menuSide = null
  state.menuIndex = -1
  pickEl('a').classList.remove('active')
  pickEl('b').classList.remove('active')
}

/** 选中一条：填进当前这一侧并立即对比 */
function pickCommit(sha) {
  const side = state.menuSide
  if (!side) return
  inputEl(side).value = sha.slice(0, 8)
  closeMenu()
  applyFromInputs()
}

/** 直接把用户输入当成版本用（搜索无匹配时按 Enter） */
function pickRawRev(rev) {
  const side = state.menuSide
  if (!side) return
  inputEl(side).value = rev
  closeMenu()
  applyFromInputs()
}

function applyFromInputs() {
  const a = $('c-a').value.trim()
  const b = $('c-b').value.trim()
  // 空值直接拦住：否则会变成空 rev，报错信息不如这一步清晰
  if (!a || !b) { toast('A 和 B 都要填'); return }
  setAb(a, b)
}

/** 把解析出的完整 sha 对应的提交标题挂到输入框 title 上 */
function decoratePick(side, fullSha) {
  const el = inputEl(side)
  if (!fullSha) return
  const c = state.commits.find((x) => x.sha === fullSha)
  el.title = c ? `${fullSha}\n${c.subject || ''}\n${c.author || ''}` : fullSha
}

function moveMenuActive(delta) {
  const items = [...$('c-menu-list').querySelectorAll('.c-menu-item')]
  if (!items.length) return
  state.menuIndex = Math.max(0, Math.min(items.length - 1, state.menuIndex + delta))
  items.forEach((el, i) => el.classList.toggle('active', i === state.menuIndex))
  const cur = items[state.menuIndex]
  cur.scrollIntoView({ block: 'nearest' })
}

function setupPickers() {
  for (const side of ['a', 'b']) {
    const el = inputEl(side)
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        closeMenu()
        applyFromInputs()
      } else if (e.key === 'ArrowDown') {
        // ↓ 直接开列表，比先去点 ▾ 顺手
        e.preventDefault()
        openMenu(side)
        moveMenuActive(1)
      }
    })
    // 点输入框空白处不自动展开（会挡住正在编辑的内容），但高亮这一侧
    el.addEventListener('focus', () => {
      pickEl('a').classList.toggle('active', side === 'a')
      pickEl('b').classList.toggle('active', side === 'b')
    })

    $(side === 'a' ? 'c-open-a' : 'c-open-b').addEventListener('click', (e) => {
      e.stopPropagation()
      if (state.menuSide === side) closeMenu()
      else openMenu(side)
    })
  }

  // 浮层内：搜索、键盘导航、点选
  $('c-menu-search').addEventListener('input', (e) => renderMenu(e.target.value))
  $('c-menu-search').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveMenuActive(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveMenuActive(-1) }
    else if (e.key === 'Enter') {
      e.preventDefault()
      const items = state.menuItems || []
      const target = items[state.menuIndex] || items[0]
      if (target) {
        pickCommit(target.sha)
        return
      }
      // 一条都没匹配上：把输入内容当成 rev 直接用
      // （HEAD~5、分支名、或者不在索引里的 sha，后端都能 rev-parse）
      const raw = $('c-menu-search').value.trim()
      if (raw) pickRawRev(raw)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      closeMenu()
      inputEl(state.menuSide || 'a')?.focus()
    }
  })

  $('c-menu-list').addEventListener('click', (e) => {
    const item = e.target.closest('.c-menu-item')
    if (item) pickCommit(item.dataset.sha)
  })

  // 点别处关闭。
  // e.target 不一定是 Element（document 本身、SVG 内外的一些节点），
  // 直接调 closest 会抛 "closest is not a function"。
  document.addEventListener('mousedown', (e) => {
    if ($('c-menu').hidden) return
    const t = e.target instanceof Element ? e.target : null
    if (t && t.closest('#c-menu')) return
    if (t && (t.closest('#c-pick-a') || t.closest('#c-pick-b'))) return
    closeMenu()
  })

  // 窗口变化时浮层位置会失效，直接关掉比错位好
  window.addEventListener('resize', () => { if (state.menuSide) closeMenu() })

  // 锚点跟着页面滚动会错位，所以滚动时关闭浮层。
  // 但必须用 capture 才能收到「任意滚动容器」的事件，而 capture 同时也会
  // 捕获浮层列表自己的滚动——那样用户一滚列表就把浮层关了（表现成
  // 「滚轮没反应」）。所以先排除浮层内部的滚动。
  window.addEventListener('scroll', (e) => {
    if (!state.menuSide) return
    const t = e.target
    if (t instanceof Element && t.closest('#c-menu')) return
    closeMenu()
  }, true)

  $('c-swap').addEventListener('click', () => {
    const a = $('c-a').value.trim()
    const b = $('c-b').value.trim()
    if (!a || !b) return
    setAb(b, a)
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
  const commitIndexPromise = loadCommitIndex(qs.get('repo'))

  try {
    await loadRepoInfo()
    await loadCompare()
  } catch (err) {
    $('c-empty').hidden = false
    $('c-empty').textContent = err.message
    $('c-empty').style.color = 'var(--red)'
  }
  // 下拉晚一点填完没关系，不阻塞主内容
  commitIndexPromise.catch(() => {})
})()
