// ============================================================
// 完整文件树页（某 commit 的快照，仿 fork 的 File Tree）
// URL: /tree.html?repo=<id>&sha=<commit>&wt=<worktree path>&path=<初始文件>
// ============================================================

import { fuzzyScore } from '/fuzzy.js'

const $ = (id) => document.getElementById(id)

const qs = new URLSearchParams(location.search)
const repoId = qs.get('repo') || ''
const wtPath = qs.get('wt') || ''
let sha = qs.get('sha') || 'HEAD'

const state = {
  repo: null,
  commit: null,        // { sha, subject, author, time }
  files: [],           // 扁平文件列表 [{path,size}]
  root: null,          // 树根 {name, path, dirs:Map, files:[]}
  expanded: new Set(), // 展开的目录路径
  selected: null,      // 当前选中文件路径
  filter: '',
  matched: null,       // 过滤命中的路径数组（已按相关度排序）
}

// ---------- 工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

function fmtSize(n) {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

let toastTimer = null
function toast(msg) {
  const el = $('t-toast')
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

/** 打开历史页：与主界面同一个 URL 约定 */
function openHistory(path) {
  if (!path) return
  const params = new URLSearchParams({ repo: repoId, path })
  if (wtPath) params.set('wt', wtPath)
  window.open(`/history.html?${params}`, '_blank', 'noopener')
}

// ============================================================
// 从扁平路径建树
// 只用真实文件做叶子，目录是路径前缀推导出来的。
// 每个文件只存一次（在 dir.files 里），不会重复占用内存。
// ============================================================
function buildTree(files) {
  const root = { name: '', path: '', dirs: new Map(), files: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      if (!node.dirs.has(seg)) {
        node.dirs.set(seg, {
          name: seg,
          path: parts.slice(0, i + 1).join('/'),
          dirs: new Map(),
          files: [],
        })
      }
      node = node.dirs.get(seg)
    }
    node.files.push({ name: parts[parts.length - 1], path: f.path, size: f.size })
  }
  // 排序：目录在前、文件在后，各自按名字（忽略大小写，接近 fork 的观感）
  const sortNode = (node) => {
    for (const d of node.dirs.values()) sortNode(d)
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }
  sortNode(root)
  return root
}

/** 目录下的文件总数（含子目录），用于显示计数 */
function countFiles(node) {
  let n = node.files.length
  for (const d of node.dirs.values()) n += countFiles(d)
  return n
}

// ============================================================
// 渲染
// 18k 文件不能全量铺 DOM，所以只渲染「展开路径上」的节点。
// ============================================================
const ICON_CARET_OPEN =
  '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
  '<path d="M2.5 3.8L5 6.4l2.5-2.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const ICON_CARET_CLOSED =
  '<svg width="9" height="9" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
  '<path d="M3.8 2.5L6.4 5l-2.6 2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const ICON_DIR =
  '<svg class="t-ico" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M1.8 4.1c0-.6.5-1.1 1.1-1.1h2.5l1.3 1.5h6.4c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.9c-.6 0-1.1-.5-1.1-1.1V4.1z" ' +
  'stroke="currentColor" stroke-width="1.2" fill="currentColor" fill-opacity="0.14"/></svg>'

const ICON_FILE =
  '<svg class="t-ico" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<path d="M4 1.8h5l3 3v9.4H4V1.8z" stroke="currentColor" stroke-width="1.2" fill="none"/>' +
  '<path d="M9 1.8v3.2h3" stroke="currentColor" stroke-width="1.2" fill="none"/></svg>'

const ICON_HISTORY =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
  '<circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5"/>' +
  '<path d="M8 4.6V8l2.3 1.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function renderTree() {
  const box = $('t-tree')
  const empty = $('t-tree-empty')
  if (!state.root || !state.files.length) {
    box.replaceChildren()
    empty.hidden = false
    empty.textContent = '这个提交里没有文件。'
    return
  }
  empty.hidden = true

  const frag = document.createDocumentFragment()
  // 过滤模式：只列命中文件，用扁平列表（比展开树更直观，也是 fork 的做法）
  if (state.filter) {
    // matched 是「已排好序的路径数组」，保持这个顺序（文件名的精确/前缀命中排前面）
    const hits = state.matched
    if (!hits || !hits.length) {
      box.replaceChildren()
      empty.hidden = false
      empty.textContent = '没有匹配的文件。'
      return
    }
    for (const p of hits.slice(0, 300)) {
      frag.appendChild(fileRow(p, p.split('/').pop(), String(p), 0, null, true))
    }
    if (hits.length > 300) {
      const more = document.createElement('div')
      more.className = 't-more'
      more.textContent = `另有 ${hits.length - 300} 条未显示，请细化过滤条件`
      frag.appendChild(more)
    }
    box.replaceChildren(frag)
    return
  }

  const walk = (node, depth) => {
    // 目录
    for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
      const isOpen = state.expanded.has(d.path)
      frag.appendChild(dirRow(d, depth, isOpen))
      if (isOpen) walk(d, depth + 1)
    }
    // 文件
    for (const f of node.files) {
      frag.appendChild(fileRow(f.path, f.name, '', depth, f.size))
    }
  }
  walk(state.root, 0)
  box.replaceChildren(frag)
}

function dirRow(d, depth, isOpen) {
  const el = document.createElement('div')
  el.className = 't-node t-dir' + (isOpen ? ' open' : '')
  el.dataset.path = d.path
  el.setAttribute('role', 'treeitem')
  el.setAttribute('aria-expanded', String(isOpen))
  el.style.paddingLeft = `${6 + depth * 13}px`
  el.innerHTML =
    `<span class="t-caret">${isOpen ? ICON_CARET_OPEN : ICON_CARET_CLOSED}</span>` +
    ICON_DIR +
    `<span class="t-name">${esc(d.name)}</span>` +
    `<span class="t-count">${countFiles(d)}</span>`
  el.addEventListener('click', () => {
    if (state.expanded.has(d.path)) state.expanded.delete(d.path)
    else state.expanded.add(d.path)
    renderTree()
  })
  return el
}

function fileRow(path, name, title, depth = 0, size = null, showDir = false) {
  const el = document.createElement('div')
  el.className = 't-node t-file' + (path === state.selected ? ' active' : '')
  el.dataset.path = path
  el.setAttribute('role', 'treeitem')
  el.style.paddingLeft = `${6 + depth * 13}px`
  el.title = title || path
  // 过滤模式下没有层级可依，必须把目录放到行内，否则一堆同名 README.md 无法区分
  const dirLabel = showDir ? path.slice(0, Math.max(0, path.length - name.length - 1)) : ''
  el.innerHTML =
    `<span class="t-caret t-caret-hidden"></span>` +
    ICON_FILE +
    `<span class="t-name">${esc(name)}</span>` +
    (dirLabel ? `<span class="t-dir-hint" title="${esc(dirLabel)}">${esc(dirLabel)}</span>` : '') +
    // 大小放在图标左侧：hover 出图标时，大小先让位消失，避免两列挤在一起
    (size != null ? `<span class="t-size">${fmtSize(size)}</span>` : '') +
    `<span class="t-node-actions">` +
    `<button class="t-hist-btn" title="查看该文件的提交历史（新标签页）" aria-label="文件历史">${ICON_HISTORY}</button>` +
    `</span>`
  el.addEventListener('click', (e) => {
    // 历史按钮在行内，先判断再走选中逻辑
    if (e.target.closest('.t-hist-btn')) {
      e.stopPropagation()
      openHistory(path)
      return
    }
    selectFile(path)
  })
  return el
}

// ============================================================
// 右侧文件内容
// ============================================================
async function selectFile(path) {
  state.selected = path
  // 只更新选中态的类，不整棵树重渲染（18k 文件的树重渲染会明显卡）
  for (const el of $('t-tree').querySelectorAll('.t-file')) {
    el.classList.toggle('active', el.dataset.path === path)
  }

  $('t-file-path').textContent = path
  $('t-file-path').title = path
  $('t-file-meta').textContent = ''
  $('t-btn-history').hidden = false
  $('t-btn-copy-path').hidden = false

  const body = $('t-file-body')
  body.innerHTML = '<div class="t-empty" style="padding:24px 16px">加载中…</div>'

  const params = new URLSearchParams({ sha, path })
  if (wtPath) params.set('wt', wtPath)
  try {
    const data = await api(`/api/repos/${repoId}/file-content?${params}`)
    // 快速点击时丢弃过期响应
    if (state.selected !== path) return

    if (data.binary) {
      $('t-file-meta').textContent = `二进制 · ${fmtSize(data.size)}`
      body.innerHTML = `<div class="t-empty" style="padding:24px 16px">二进制文件（${esc(fmtSize(data.size))}），不显示内容。</div>`
      return
    }
    if (data.tooLarge) {
      $('t-file-meta').textContent = `过大 · ${fmtSize(data.size)}`
      body.innerHTML = `<div class="t-empty" style="padding:24px 16px">文件过大（${esc(fmtSize(data.size))}，上限 ${esc(fmtSize(data.maxBytes))}），不在浏览器内展示。</div>`
      return
    }
    if (data.content == null) {
      body.innerHTML = `<div class="t-empty" style="padding:24px 16px;color:var(--red)">${esc(data.error || '读取失败')}</div>`
      return
    }

    $('t-file-meta').textContent = `${data.lines} 行 · ${fmtSize(data.size)}`
    body.replaceChildren(renderCode(data.content, path))
    body.scrollTop = 0
    if (data.truncated) {
      const t = document.createElement('div')
      t.className = 't-empty'
      t.style.padding = '8px 16px'
      t.textContent = '内容过大，已截断。'
      body.appendChild(t)
    }
  } catch (err) {
    body.innerHTML = `<div class="t-empty" style="padding:24px 16px;color:var(--red)">${esc(err.message)}</div>`
  }
}

/** 带行号的代码块。不做语法高亮（fork 那个也只是纯文本 + 行号）。 */
function renderCode(content, path) {
  const wrap = document.createElement('div')
  wrap.className = 't-code-wrap'

  const lines = content.split('\n')
  // 末尾换行会split出一个空串，去掉它避免显示多余空行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const table = document.createElement('table')
  table.className = 't-code'
  const tbody = document.createElement('tbody')
  const frag = document.createDocumentFragment()

  for (let i = 0; i < lines.length; i++) {
    const tr = document.createElement('tr')
    const tdNo = document.createElement('td')
    tdNo.className = 'ln'
    tdNo.textContent = String(i + 1)
    const tdCode = document.createElement('td')
    tdCode.className = 'code'
    // 用 textContent 而不是 innerHTML：内容里可能有任何字符，不解析 HTML
    tdCode.textContent = lines[i] || '\u00a0'
    tr.appendChild(tdNo)
    tr.appendChild(tdCode)
    frag.appendChild(tr)
  }
  tbody.appendChild(frag)
  table.appendChild(tbody)
  wrap.appendChild(table)
  return wrap
}

// ============================================================
// 过滤
// ============================================================
function applyFilter() {
  const q = $('t-filter').value.trim()
  state.filter = q
  if (!q) {
    state.matched = null
    renderTree()
    return
  }

  // 两级排序，避免「搜 pom.xml 却列出 PlatformApplication.run.xml」这类误命中：
  //   1. 文件名完全等于查询 	最高
  //   2. 文件名以查询开头 / 文件名包含查询
  //   3. 路径模糊匹配（fuzzyScore，能处理缩写、跨段）
  // 单纯用 fuzzyScore 时，'pom.xml' 会切成 pom + xml 两段，
  // 'PlatformApplication.run.xml' 里 'p' 命中 Platform 段首、'xml' 命中 run.xml 段，
  // 得分反而超过真正的 pom.xml。所以文件名优先。
  const ql = q.toLowerCase()
  const scored = []
  for (const f of state.files) {
    const name = f.path.split('/').pop().toLowerCase()
    let rank = null

    if (name === ql) rank = 3000
    else if (name.startsWith(ql)) rank = 2500 - Math.min(200, name.length - ql.length)
    else if (name.includes(ql)) rank = 2000 - Math.min(200, name.indexOf(ql))
    else {
      const pathScore = fuzzyScore(q, f.path)
      if (pathScore != null) rank = pathScore
    }
    if (rank != null) scored.push([f.path, rank])
  }
  scored.sort((a, b) => b[1] - a[1])
  // 存成「有序路径数组」：渲染时直接按这个顺序铺，不再重新排序
  state.matched = scored.map((x) => x[0])
  renderTree()
  // 过滤结果里默认选中第一条，省一次点击
  const first = scored[0]?.[0]
  if (first && first !== state.selected) selectFile(first)
}

/** 自动展开「初始文件」所在的目录链，让它可见 */
function revealPath(path) {
  const parts = path.split('/')
  // 只展开到末两级之前：完整展开会让很深的路径把树撑得很难找
  for (let i = 1; i < parts.length; i++) {
    state.expanded.add(parts.slice(0, i).join('/'))
  }
}

// ============================================================
// 布局：拖动分隔线
// ============================================================
const SPLIT_KEY = 'wsl-worktree.treeWidth'
;(function initSplitter() {
  const layout = $('t-layout')
  const sp = $('t-splitter')
  let dragging = false

  const saved = Number(localStorage.getItem(SPLIT_KEY))
  if (Number.isFinite(saved) && saved >= 200) {
    layout.style.setProperty('--w-tree', `${saved}px`)
  }

  const onMove = (e) => {
    if (!dragging) return
    const rect = layout.getBoundingClientRect()
    const w = Math.min(Math.max(200, e.clientX - rect.left), Math.min(rect.width - 320, window.innerWidth * 0.6))
    layout.style.setProperty('--w-tree', `${Math.round(w)}px`)
    e.preventDefault()
  }
  const onUp = () => {
    if (!dragging) return
    dragging = false
    sp.classList.remove('dragging')
    document.body.style.cursor = ''
    const w = parseInt(getComputedStyle(layout).getPropertyValue('--w-tree'), 10)
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
    layout.style.setProperty('--w-tree', '320px')
    localStorage.setItem(SPLIT_KEY, '320')
  })
})()

// ---------- 事件绑定 ----------
$('t-filter').addEventListener('input', applyFilter)
$('t-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = ''
    applyFilter()
  }
})

$('t-collapse-all').addEventListener('click', () => {
  state.expanded.clear()
  renderTree()
  toast('已全部折叠')
})

$('t-btn-history').addEventListener('click', () => {
  if (state.selected) openHistory(state.selected)
})

$('t-btn-copy-path').addEventListener('click', async () => {
  if (!state.selected) return
  try {
    await navigator.clipboard.writeText(state.selected)
    toast('已复制路径')
  } catch {
    toast('复制失败')
  }
})

// ---------- 初始化 ----------
async function init() {
  if (!repoId) {
    document.body.innerHTML =
      '<div class="t-empty" style="padding:40px">缺少参数：需要 repo。<br>请从主界面详情面板右上角进入。</div>'
    return
  }
  $('t-wt').textContent = wtPath ? wtPath.split('/').filter(Boolean).slice(-1)[0] : ''
  $('t-wt').title = wtPath || ''
  $('t-commit').textContent = sha === 'HEAD' ? 'HEAD' : sha.slice(0, 7)

  // 仓库名 + commit 信息
  try {
    const data = await api('/api/repos')
    const repo = (data.repos || []).find((r) => r.id === repoId)
    if (repo) {
      state.repo = repo
      $('t-repo').textContent = repo.name
    }
  } catch {}

  if (sha && sha !== 'HEAD') {
    try {
      const c = await api(`/api/repos/${repoId}/commit/${sha}`)
      // commit 接口不返回 subject，从日志里取更靠谱；这里先留空，下面补
    } catch {}
  }

  // 树
  $('t-tree').innerHTML = '<div class="t-empty">加载文件树…</div>'
  const params = new URLSearchParams({ sha })
  if (wtPath) params.set('wt', wtPath)
  try {
    const data = await api(`/api/repos/${repoId}/tree?${params}`)
    state.files = data.files || []
    sha = data.sha || sha
    state.root = buildTree(state.files)
    $('t-commit').textContent = sha.slice(0, 7)
    $('t-stat').textContent = `${state.files.length} 个文件`
    document.title = `File Tree · ${state.repo?.name || ''}`
    renderTree()

    // 初始文件：URL 带 path 就定位过去，否则选第一个文件
    const initial = qs.get('path')
    if (initial && state.files.some((f) => f.path === initial)) {
      revealPath(initial)
      renderTree()
      selectFile(initial)
      scrollToSelected()
    } else {
      // 没有指定文件时，展开第一层目录——否则打开后只有一列折叠的目录名，
      // 用户得自己点开才知道里面有什么。
      for (const d of state.root.dirs.values()) {
        state.expanded.add(d.path)
      }
      renderTree()
      if (state.files.length) selectFile(state.files[0].path)
    }
  } catch (err) {
    $('t-tree').innerHTML = `<div class="t-empty" style="color:var(--red);padding:14px">${esc(err.message)}</div>`
  }
}

function scrollToSelected() {
  const el = $('t-tree').querySelector(`.t-file[data-path="${CSS.escape(state.selected)}"]`)
  if (el?.scrollIntoView) el.scrollIntoView({ block: 'center' })
}

init()
