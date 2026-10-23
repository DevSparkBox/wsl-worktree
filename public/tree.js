// ============================================================
// 完整文件树页（某 commit 的快照，仿 fork 的 File Tree）
// URL: /tree.html?repo=<id>&sha=<commit>&wt=<worktree path>&path=<初始文件>
// ============================================================

import { fuzzyScore } from '/fuzzy.js'
import { buildTree, countFiles, displayChainName } from '/tree-model.js'
import { initSplitter } from '/splitter.js'
import { detectLang, highlightLines } from '/highlight.js'
import { createOutline } from '/outline.js'

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
  // 是否把单链目录合并成一行（VS Code 的 compact folders）。默认开，可关掉对比
  compact: (() => {
    try {
      const v = localStorage.getItem('wsl-worktree.treeCompact')
      return v === null ? true : v === '1'
    } catch { return true }
  })(),
  // 是否启用语法高亮。默认开
  highlight: (() => {
    try {
      const v = localStorage.getItem('wsl-worktree.treeHighlight')
      return v === null ? true : v === '1'
    } catch { return true }
  })(),
  // 上一次渲染用的内容，切换高亮时直接重渲染，不必重新请求
  lastContent: null,
  // ---- 搜索 ----
  mode: 'path',        // 'path' 路径过滤 | 'content' 内容搜索
  grep: null,          // 最近的搜索结果 { files, total, truncated }
  grepBusy: false,
  grepQuery: '',       // 上一次实际执行的查询（用于丢弃过期响应）
  scopePath: '',       // 「限当前目录」用的目录
  jumpLine: null,      // 打开文件后要跳到的行号（来自搜索命中）
  // ---- 符号大纲 ----
  outlineVisible: (() => {
    try {
      const v = localStorage.getItem('wsl-worktree.outlineVisible')
      return v === null ? true : v === '1'
    } catch { return true }
  })(),
  lineEls: null,       // 当前文件所有行的 tr，用于滚动联动
  lineTops: null,      // 上述行的 offsetTop，二分查找当前行
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
  // 压缩过的节点：名字里带了被折叠的层级（用 / 连接），hover 显示完整链
  const compressed = Array.isArray(d.aliases) && d.aliases.length > 0
  const shown = compressed ? displayChainName(d.name) : d.name
  el.innerHTML =
    `<span class="t-caret">${isOpen ? ICON_CARET_OPEN : ICON_CARET_CLOSED}</span>` +
    ICON_DIR +
    `<span class="t-name${compressed ? ' t-name-compressed' : ''}"${compressed ? ` title="${esc(d.name)}"` : ''}>${esc(shown)}</span>` +
    `<span class="t-count">${countFiles(d)}</span>`
  el.addEventListener('click', () => {
    // 记下当前点中的目录，供内容搜索的「限当前目录」使用
    state.scopePath = d.path
    if (state.expanded.has(d.path)) {
      state.expanded.delete(d.path)
    } else {
      // 一次展开：压缩已经把单链合并成一行，所以展开后直接就能看到
      // 分叉点或文件——不需要再逐层点。
      // 但有一种情况要补：子层如果也是「唯一子目录 + 无文件」，它可能
      // 本身没被压缩（因为压缩是自上而下做的），这里顺带打开。
      expandChain(d)
    }
    renderTree()
  })
  return el
}

/**
 * 展开一个目录，并顺带打开下面所有「唯一子目录且无文件」的层级。
 * 压缩只处理了「从父节点开始的链」，如果子层的链头自己不是被压缩节点，
 * 一次点击仍要连带展开，否则用户还是要连点。
 */
function expandChain(d) {
  let cur = d
  let guard = 0
  while (guard++ < 50) {
    state.expanded.add(cur.path)
    // 自身有文件或已分叉 → 这一层就是用户要看的内容层，停止
    if (cur.files.length > 0 || cur.dirs.size !== 1) break
    cur = [...cur.dirs.values()][0]
  }
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
/**
 * @param {string} path
 * @param {{jumpLine?: number|null}} [opts]
 *        jumpLine：打开后滚到该行并高亮（内容搜索点命中行时用）
 */
// ============================================================
// 右侧符号大纲
// ============================================================

/** 缓存行元素与位置：滚动联动要二分查找「当前在第几行」 */
function cacheLineEls() {
  const rows = [...$('t-file-body').querySelectorAll('tr[data-line]')]
  state.lineEls = rows
  // offsetTop 在同一个 offsetParent 下才可比；这里都挂在同一个表里，够用
  state.lineTops = rows.map((el) => el.offsetTop)
}

/** 跳到某一行并闪一下，让人看清落点 */
function jumpToLine(line) {
  const body = $('t-file-body')
  const row = body.querySelector(`tr[data-line="${line}"]`)
  if (!row) return
  row.scrollIntoView({ block: 'center' })
  // 取消上一次的定时器：连续点同一行时，前一个 setTimeout 会把刚加上的
  // class 提前摘掉，闪烁看起来时有时无
  if (row._flashTimer) clearTimeout(row._flashTimer)
  row.classList.remove('o-jump-flash')
  void row.offsetWidth // 强制回流，否则动画不会重放
  row.classList.add('o-jump-flash')
  row._flashTimer = setTimeout(() => {
    row.classList.remove('o-jump-flash')
    row._flashTimer = null
  }, 1400)
}

/** 大纲底部按钮：把这个符号名交给左侧的内容搜索（等价于在那儿手输） */
function searchInAllFiles(name) {
  if (!name) return
  setMode('content')
  $('t-filter').value = name
  runGrep(name)
}

const outline = createOutline({
  containerEl: $('t-outline'),
  listEl: $('t-outline-list'),
  countEl: $('t-outline-count'),
  filterEl: $('t-outline-filter'),
  footEl: $('t-outline-foot'),
  jumpToLine,
  onSearchAll: searchInAllFiles,
})

function setOutlineVisible(v) {
  state.outlineVisible = v
  $('t-outline').hidden = !v
  try { localStorage.setItem('wsl-worktree.outlineVisible', v ? '1' : '0') } catch {}
  // 打开时按当前滚动位置对齐一次，避免高亮还停在旧位置
  if (v) syncOutlineToScroll()
}

/** 把源码滚动位置换算成「当前符号」，交给大纲高亮 */
function syncOutlineToScroll() {
  if ($('t-outline').hidden) return
  const tops = state.lineTops
  if (!tops || !tops.length) return
  const y = $('t-file-body').scrollTop + 10
  // 二分找最后一个 offsetTop <= y 的行
  let lo = 0
  let hi = tops.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid] <= y) { ans = mid; lo = mid + 1 } else { hi = mid - 1 }
  }
  outline.syncToLine(ans + 1)
}

let outlineRaf = 0
$('t-file-body').addEventListener('scroll', () => {
  if (outlineRaf || $('t-outline').hidden) return
  outlineRaf = requestAnimationFrame(() => {
    outlineRaf = 0
    syncOutlineToScroll()
  })
}, { passive: true })

$('t-btn-outline').addEventListener('click', () => setOutlineVisible($('t-outline').hidden))
$('t-outline-close').addEventListener('click', () => setOutlineVisible(false))

async function selectFile(path, opts = {}) {
  state.selected = path
  state.jumpLine = opts.jumpLine ?? null
  // 只更新选中态的类，不整棵树重渲染（18k 文件的树重渲染会明显卡）
  for (const el of $('t-tree').querySelectorAll('.t-file')) {
    el.classList.toggle('active', el.dataset.path === path)
  }
  // 搜索结果里也标出当前文件
  for (const el of $('t-grep-results').querySelectorAll('.t-grep-file')) {
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
      outline.clear()
      state.lineEls = null
      state.lineTops = null
      return
    }
    if (data.tooLarge) {
      $('t-file-meta').textContent = `过大 · ${fmtSize(data.size)}`
      body.innerHTML = `<div class="t-empty" style="padding:24px 16px">文件过大（${esc(fmtSize(data.size))}，上限 ${esc(fmtSize(data.maxBytes))}），不在浏览器内展示。</div>`
      outline.clear()
      state.lineEls = null
      state.lineTops = null
      return
    }
    if (data.content == null) {
      body.innerHTML = `<div class="t-empty" style="padding:24px 16px;color:var(--red)">${esc(data.error || '读取失败')}</div>`
      outline.clear()
      state.lineEls = null
      state.lineTops = null
      return
    }

    // 显示语言名，让人知道当前应用了什么语法规则（识别不出时不显示）
    const lang = detectLang(path)
    const langLabel = lang ? ` · ${LANG_LABEL[lang] || lang}` : ''
    $('t-file-meta').textContent = `${data.lines} 行 · ${fmtSize(data.size)}${langLabel}`
    // 缓存内容：切换高亮开关时直接重渲染，不用再请求一次
    state.lastContent = data.content
    const jump = opts.jumpLine
    body.replaceChildren(renderCode(data.content, path, jump))
    // 大纲要在 DOM 落地后再算：行元素位置得等布局完成
    outline.render(path, data.content, lang)
    cacheLineEls()
    if (jump) {
      // 滚动到命中行并居中，让上下文可见
      const row = body.querySelector(`tr[data-line="${jump}"]`)
      if (row?.scrollIntoView) row.scrollIntoView({ block: 'center' })
      else body.scrollTop = 0
    } else {
      body.scrollTop = 0
    }
    // 滚动位置定下来后再对齐一次大纲高亮
    syncOutlineToScroll()
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
/** 超过这个行数就不高亮——大文件上色后再塞 DOM，滚动会明显卡 */
const HIGHLIGHT_MAX_LINES = 5000
/** 超过这个字节数也不高亮（纯文本更快） */
const HIGHLIGHT_MAX_BYTES = 512 * 1024

/** 语言 key → 界面上显示的名字 */
const LANG_LABEL = {
  js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
  java: 'Java', cs: 'C#', c: 'C', cpp: 'C++', h: 'C header',
  go: 'Go', swift: 'Swift', kt: 'Kotlin', scala: 'Scala', php: 'PHP', rs: 'Rust',
  json: 'JSON', css: 'CSS', less: 'Less', scss: 'SCSS', sass: 'Sass',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML', ini: 'INI',
  sh: 'Shell', bash: 'Bash', zsh: 'Zsh', py: 'Python', rb: 'Ruby',
  sql: 'SQL', xml: 'XML', html: 'HTML', vue: 'Vue', md: 'Markdown',
  properties: 'Properties', env: 'Env', dockerfile: 'Dockerfile', makefile: 'Makefile',
}

function renderCode(content, path, jumpLine = null) {
  const wrap = document.createElement('div')
  wrap.className = 't-code-wrap'

  const lines = content.split('\n')
  // 末尾换行会split出一个空串，去掉它避免显示多余空行
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()

  const lang = detectLang(path)
  // 大文件不高亮：高亮本身很快（600 行 4ms），但生成的 span 数会让
  // 浏览器的布局/滚动变慢，得不偿失
  const useHL = state.highlight && lang &&
    lines.length <= HIGHLIGHT_MAX_LINES && content.length <= HIGHLIGHT_MAX_BYTES

  // 一次算出全部行的高亮结果，跨行状态（块注释）由 highlightLines 统一维护
  let rendered = null
  if (useHL) {
    try {
      rendered = highlightLines(content, lang)
      // 行数必须对得上，否则说明拆分口径不一致，退回纯文本更安全
      if (rendered.length !== lines.length) rendered = null
    } catch {
      rendered = null
    }
  }

  const table = document.createElement('table')
  table.className = 't-code' + (useHL && rendered ? ' has-hl' : '')
  const tbody = document.createElement('tbody')
  const frag = document.createDocumentFragment()

  for (let i = 0; i < lines.length; i++) {
    const tr = document.createElement('tr')
    // 行号挂到 data-line 上：搜索命中跳转时靠它定位
    tr.dataset.line = String(i + 1)
    if (jumpLine && i + 1 === jumpLine) tr.className = 'hit-line'
    const tdNo = document.createElement('td')
    tdNo.className = 'ln'
    tdNo.textContent = String(i + 1)
    const tdCode = document.createElement('td')
    tdCode.className = 'code'
    if (rendered) {
      // highlightLines 内部已对每个片段做 HTML 转义，这里可以安全用 innerHTML
      tdCode.innerHTML = rendered[i] || '&nbsp;'
    } else {
      // 纯文本路径：用 textContent，绝不解析 HTML
      tdCode.textContent = lines[i] || '\u00a0'
    }
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

// ============================================================
// 内容搜索（git grep）
//
// 与路径过滤的区别：路径过滤只看文件名/路径，不发请求；
// 内容搜索是真的在这个 commit 的对象库里 grep，慢一些但有真实结果。
// 两者用同一个输入框，靠模式切换区分。
// ============================================================
let grepTimer = null
let grepSeq = 0

/** 切换 路径 / 内容 模式 */
function setMode(mode) {
  if (state.mode === mode) return
  state.mode = mode
  $('t-mode-path').classList.toggle('active', mode === 'path')
  $('t-mode-content').classList.toggle('active', mode === 'content')
  $('t-grep-bar').hidden = mode !== 'content'
  $('t-filter').placeholder = mode === 'content' ? '搜索文件内容…' : '过滤路径…'
  $('t-filter').value = ''
  state.filter = ''
  state.matched = null
  state.grep = null
  state.grepQuery = ''

  if (mode === 'content') {
    // 内容模式：隐藏树，等用户输入
    $('t-tree').hidden = true
    $('t-tree-empty').hidden = true
    showGrepPlaceholder()
  } else {
    // 回到路径模式：恢复树
    $('t-tree').hidden = false
    $('t-grep-results').hidden = true
    renderTree()
  }
  $('t-filter').focus()
}

function showGrepPlaceholder(text) {
  const box = $('t-grep-results')
  box.hidden = false
  box.innerHTML = `<div class="t-grep-empty">${esc(text ||
    '输入关键词搜索文件内容。搜索范围是这个提交的快照，不是当前磁盘。')}</div>`
  $('t-grep-stat').textContent = ''
}

/** 执行搜索（带防抖） */
function scheduleGrep() {
  clearTimeout(grepTimer)
  const q = $('t-filter').value.trim()
  if (!q) {
    state.grep = null
    state.grepQuery = ''
    showGrepPlaceholder()
    return
  }
  // 输入停顿 260ms 再发请求，避免逐字符打服务
  grepTimer = setTimeout(() => runGrep(q), 260)
}

async function runGrep(q) {
  const seq = ++grepSeq
  state.grepQuery = q
  state.grepBusy = true
  const box = $('t-grep-results')
  box.hidden = false
  $('t-tree').hidden = true
  box.innerHTML = '<div class="t-grep-empty">搜索中…</div>'
  $('t-grep-stat').textContent = ''

  const params = new URLSearchParams({ sha, q })
  if (wtPath) params.set('wt', wtPath)
  if ($('t-grep-icase').checked) params.set('i', '1')
  if ($('t-grep-regex').checked) params.set('re', '1')
  // 限当前目录：只有在树里点过目录、且开关打开时才生效
  if ($('t-grep-scope').checked && state.scopePath) params.set('path', state.scopePath)

  const t0 = performance.now()
  try {
    const data = await api(`/api/repos/${repoId}/grep?${params}`)
    // 丢弃过期响应：用户可能已经改了关键词
    if (seq !== grepSeq || state.grepQuery !== q) return
    state.grep = data
    state.grepBusy = false
    renderGrepResults(data, Math.round(performance.now() - t0))
  } catch (err) {
    if (seq !== grepSeq) return
    state.grepBusy = false
    box.innerHTML = `<div class="t-grep-empty" style="color:var(--red)">${esc(err.message)}</div>`
  }
}

function renderGrepResults(data, elapsedMs) {
  const box = $('t-grep-results')
  box.hidden = false
  $('t-tree').hidden = true

  const files = data.files || []
  if (!files.length) {
    box.innerHTML = `<div class="t-grep-empty">没有匹配的文件内容。<br>
      <span style="color:var(--text-faint)">换个关键词，或确认搜索范围（当前限定在 <code>${esc(state.scopePath || '全仓库')}</code>）。</span></div>`
    $('t-grep-stat').textContent = `0 个文件 · ${elapsedMs}ms`
    return
  }

  $('t-grep-stat').textContent =
    `${files.length} 个文件 · ${data.total} 处` + (data.truncated ? ' · 已截断' : '') + ` · ${elapsedMs}ms`

  const frag = document.createDocumentFragment()
  // 顶层给一个「全部折叠/展开」式的汇总行
  const sum = document.createElement('div')
  sum.className = 't-grep-sum'
  sum.textContent = `${files.length} 个文件命中，共 ${data.total} 处`
  frag.appendChild(sum)

  for (const f of files) {
    const group = document.createElement('div')
    group.className = 't-grep-file'
    group.dataset.path = f.path

    const head = document.createElement('div')
    head.className = 't-grep-filehead'
    head.innerHTML =
      `<span class="t-grep-fname">${esc(f.path.split('/').pop())}</span>` +
      `<span class="t-grep-fdir" title="${esc(f.path)}">${esc(shortDir(f.path))}</span>` +
      `<span class="t-grep-count">${f.hits.length}</span>`
    // 点文件名表头：打开文件但不跳行
    head.addEventListener('click', () => {
      state.jumpLine = f.hits[0]?.line ?? null
      selectFile(f.path)
    })
    group.appendChild(head)

    for (const h of f.hits) {
      const row = document.createElement('div')
      row.className = 't-grep-hit'
      row.dataset.line = String(h.line)
      row.dataset.path = f.path
      // 把命中的关键词标出来（用当前查询当子串，正则模式下可能标不准，
      // 所以只在字面量模式下做标记）
      const marked = $('t-grep-regex').checked
        ? esc(h.text)
        : markText(h.text, $('t-filter').value.trim(), $('t-grep-icase').checked)
      row.innerHTML =
        `<span class="t-grep-ln">${h.line}</span>` +
        `<span class="t-grep-code">${marked}</span>`
      row.addEventListener('click', () => {
        state.jumpLine = h.line
        selectFile(f.path, { jumpLine: h.line })
      })
      group.appendChild(row)
    }
    frag.appendChild(group)
  }
  box.replaceChildren(frag)
}

/** 目录部分：只显示末两级，长路径中间省略 */
function shortDir(p) {
  const parts = String(p).split('/')
  if (parts.length <= 1) return ''
  const dir = parts.slice(0, -1)
  if (dir.length <= 2) return dir.join('/')
  return '…/' + dir.slice(-2).join('/')
}

/** 在命中行里高亮关键词（按字面量，不区分是否为词首） */
function markText(text, q, ignoreCase) {
  if (!q) return esc(text)
  const hay = ignoreCase ? text.toLowerCase() : text
  const needle = ignoreCase ? q.toLowerCase() : q
  let out = ''
  let from = 0
  while (true) {
    const idx = hay.indexOf(needle, from)
    if (idx < 0) break
    out += esc(text.slice(from, idx))
    out += `<mark>${esc(text.slice(idx, idx + needle.length))}</mark>`
    from = idx + needle.length
    if (needle.length === 0) break
  }
  out += esc(text.slice(from))
  return out
}

/**
 * 自动展开「初始文件」所在的目录链，让它可见。
 *
 * 压缩后目录树的层级和路径不再一一对应（com.mysoft.jmpt.benchmark 一个节点
 * 覆盖了 4 层路径），所以不能按路径前缀简单递推——要沿真实树走一遍，
 * 每到一个目录就判断「目标文件在不在它下面」。
 */
function revealPath(path) {
  if (!state.root) return
  const walk = (node, prefix) => {
    for (const d of node.dirs.values()) {
      // d.path 是链末级的真实路径；用它判断目标是否在这个目录下
      if (!path.startsWith(d.path + '/')) continue
      state.expanded.add(d.path)
      walk(d, d.path)
    }
  }
  walk(state.root, '')
}

// ============================================================
// 布局：拖动分隔线
// ============================================================
// 布局：拖动分隔线（实现见 splitter.js，与对比页共用）
initSplitter({
  layout: $('t-layout'),
  splitter: $('t-splitter'),
  storageKey: 'wsl-worktree.treeWidth',
  defaultWidth: 320,
})

// ---------- 事件绑定 ----------
// 输入框：按模式分发（路径过滤是纯前端，内容搜索要打接口）
$('t-filter').addEventListener('input', () => {
  if (state.mode === 'content') scheduleGrep()
  else applyFilter()
})
$('t-filter').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.target.value = ''
    if (state.mode === 'content') {
      state.grep = null
      state.grepQuery = ''
      showGrepPlaceholder()
    } else {
      applyFilter()
    }
  }
  // Enter：内容模式下立即搜（不等防抖）
  if (e.key === 'Enter' && state.mode === 'content') {
    e.preventDefault()
    clearTimeout(grepTimer)
    const q = $('t-filter').value.trim()
    if (q) runGrep(q)
  }
})

// 模式切换
$('t-mode-path').addEventListener('click', () => setMode('path'))
$('t-mode-content').addEventListener('click', () => setMode('content'))

// 搜索选项变化后重新执行（限当前目录、忽略大小写、正则都会影响结果）
for (const id of ['t-grep-icase', 't-grep-regex', 't-grep-scope']) {
  $(id).addEventListener('change', () => {
    const q = $('t-filter').value.trim()
    if (q) runGrep(q)
  })
}

$('t-collapse-all').addEventListener('click', () => {
  state.expanded.clear()
  renderTree()
  toast('已全部折叠')
})

// 「合并目录」开关：关掉后恢复原始的逐层展开形态
$('t-compact').addEventListener('change', (e) => {
  state.compact = e.target.checked
  try { localStorage.setItem('wsl-worktree.treeCompact', state.compact ? '1' : '0') } catch {}
  // 重建树。展开状态保留：压缩节点的 path 是链末级，切换后仍能对上；
  // 原先展开的中间层在压缩模式下已经不存在，会被自然忽略。
  state.root = buildTree(state.files, state.compact)
  renderTree()
  // 重建后把选中项滚回视野，否则画面会跳走
  if (state.selected) {
    const el = $('t-tree').querySelector(`.t-file[data-path="${CSS.escape(state.selected)}"]`)
    if (el?.scrollIntoView) el.scrollIntoView({ block: 'center' })
  }
})

$('t-btn-history').addEventListener('click', () => {
  if (state.selected) openHistory(state.selected)
})

// 高亮开关：立即重渲染当前文件（用缓存内容，不重新请求）
$('t-hl').addEventListener('change', (e) => {
  state.highlight = e.target.checked
  try { localStorage.setItem('wsl-worktree.treeHighlight', state.highlight ? '1' : '0') } catch {}
  if (state.lastContent == null || !state.selected) return
  const body = $('t-file-body')
  const keepScroll = body.scrollTop
  body.replaceChildren(renderCode(state.lastContent, state.selected))
  body.scrollTop = keepScroll
  // 行元素重建了，大纲的行缓存和滚动联动都要跟着刷新
  cacheLineEls()
  syncOutlineToScroll()
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

/**
 * 加载并渲染该 commit 上的 tag。
 *
 * 为什么单独请求而不塞进 /tree 接口：
 * 打开文件树时树接口要传 1.8 万个文件（约 160ms），而 refs 只要 10ms。
 * 合并会让「已能显示树」被「查 tag」拖慢；分开则可以并行，且 tag 失败也不影响树。
 */
async function loadRefs(commitSha) {
  const box = $('t-tags')
  box.replaceChildren()
  const params = new URLSearchParams({ sha: commitSha })
  if (wtPath) params.set('wt', wtPath)
  try {
    const data = await api(`/api/repos/${repoId}/refs-at?${params}`)
    const tags = data.tags || []
    if (!tags.length) {
      box.hidden = true
      return
    }
    // 标签多时（比如一次打了好几个 tag）只显示前 3 个，其余折叠成 +N
    const MAX = 3
    const shown = tags.slice(0, MAX)
    const frag = document.createDocumentFragment()
    for (const t of shown) {
      const el = document.createElement('span')
      el.className = 't-tag' + (t.annotated ? ' t-tag-ann' : '')
      el.textContent = t.name
      el.title = t.annotated
        ? `annotated tag：${t.name}（带说明与打 tag 信息）`
        : `轻量 tag：${t.name}`
      frag.appendChild(el)
    }
    if (tags.length > MAX) {
      const more = document.createElement('span')
      more.className = 't-tag t-tag-more'
      more.textContent = `+${tags.length - MAX}`
      more.title = tags.map((t) => t.name).join('\n')
      frag.appendChild(more)
    }
    box.replaceChildren(frag)
    box.hidden = false
  } catch {
    // 查不到 tag 不是错误，静默不显示即可
    box.hidden = true
  }
}

// ---------- 初始化 ----------
async function init() {
  if (!repoId) {
    document.body.innerHTML =
      '<div class="t-empty" style="padding:40px">缺少参数：需要 repo。<br>请从主界面详情面板右上角进入。</div>'
    return
  }
  $('t-wt').textContent = wtPath ? wtPath.split('/').filter(Boolean).slice(-1)[0] : ''
  $('t-compact').checked = state.compact
  $('t-hl').checked = state.highlight
  // 大纲默认展开（记住上次的选择）
  setOutlineVisible(state.outlineVisible)
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

  // tag 查询和树加载并行：两者互不依赖，树要 160ms、refs 只要 10ms，
  // 串行会让 tag 白等。tag 失败不影响树，所以不 await 它。
  loadRefs(sha)

  try {
    const data = await api(`/api/repos/${repoId}/tree?${params}`)
    state.files = data.files || []
    sha = data.sha || sha
    state.root = buildTree(state.files, state.compact)
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
