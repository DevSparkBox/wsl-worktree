/**
 * 右侧符号大纲面板。
 *
 * 只负责渲染与交互，符号怎么提取在 symbols.js（纯逻辑、可单测）。
 * 这里通过回调跟宿主页面解耦：跳转、跨文件搜索都由 tree.js 提供。
 *
 * 布局分两段：
 *   上：符号树（可过滤、可折叠）
 *   下：当前符号的引用（独立分区，固定高度，没选中符号时整段隐藏）
 *
 * 引用不内联在符号树里，是因为行内插进去会把树打断：层级和「这个符号有几处」
 * 两件事混在一起，符号一多就没法用了。
 *
 * 交互约定：
 *   点符号   → 跳到定义行，下方引用区刷新成该符号
 *   点引用行 → 跳到那一行
 *   折叠箭头 → 折叠/展开子树（搜索态不显示，因为强制全展开）
 *   底部按钮 → 把符号名交给左侧搜索
 */

import { extractSymbols, buildSymbolTree, supportsOutline, findReferences, escapeRe } from '/symbols.js'

/** 这些 kind 算「类型」，用方框图标 + 紫色 */
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record', 'struct', 'type', 'delegate', 'annotation'])
/** 引用区最多列这么多条，其余用「还有 N 处」收尾 */
const REFS_LIMIT = 60

const keyOf = (s) => `${s.line}:${s.name}`

/**
 * 一次扫描算出所有符号在本文件里的出现次数。
 *
 * 不能对每个符号分别 findReferences：170 个符号 × 7000 行 = 上百万次匹配。
 * 这里把全部符号名拼成一个正则，全文扫一遍就都有了。
 * 名字按长度降序排列，避免 `getFoo` 抢走 `getFooBar` 的匹配。
 */
function buildRefCounts(content, symbols) {
  const counts = new Map()
  const names = [...new Set(symbols.map((s) => s.name).filter(Boolean))]
  if (!names.length) return counts
  names.sort((a, b) => b.length - a.length)
  for (const n of names) counts.set(n, 0)
  let re
  try {
    re = new RegExp(`\\b(${names.map(escapeRe).join('|')})\\b`, 'g')
  } catch {
    return counts
  }
  for (const line of content.split('\n')) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(line)) !== null) {
      counts.set(m[1], (counts.get(m[1]) || 0) + 1)
      // 零宽匹配保护：正则不可能零宽，但加着防止未来改动引入死循环
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }
  return counts
}

export function createOutline(opts) {
  const {
    containerEl, listEl, countEl, filterEl,
    refsEl, refsTitleEl, refsListEl, searchAllBtn,
    jumpToLine, onSearchAll,
  } = opts

  const state = {
    path: '',
    lang: '',
    content: '',
    symbols: [],        // 扁平
    flat: [],           // 当前渲染出来的节点（滚动联动用）
    root: null,
    collapsed: new Set(),
    refCounts: new Map(), // 符号名 → 本文件出现次数
    activeSym: null,    // 当前选中的符号（引用区显示它的引用）
    activeKey: null,
    filter: '',
  }

  // ---------------------------------------------------------- 渲染

  function render(path, content, lang) {
    state.path = path || ''
    state.content = content || ''
    state.lang = lang || ''
    state.collapsed.clear()
    state.refCounts = new Map()
    state.activeSym = null
    state.activeKey = null
    state.filter = ''
    filterEl.value = ''
    hideRefs()

    if (!supportsOutline(state.lang)) {
      state.symbols = []
      state.flat = []
      state.root = null
      showEmpty(state.content ? '这种文件没有代码符号。' : '')
      countEl.textContent = ''
      return
    }
    state.symbols = extractSymbols(state.content, state.lang)
    state.root = buildSymbolTree(state.symbols)
    if (!state.symbols.length) {
      state.flat = []
      showEmpty('没有识别到类型或函数。')
      countEl.textContent = ''
      return
    }
    state.refCounts = buildRefCounts(state.content, state.symbols)
    countEl.textContent = String(state.symbols.length)
    renderList()
  }

  function clear() {
    state.symbols = []
    state.flat = []
    state.root = null
    state.path = ''
    state.content = ''
    state.activeSym = null
    state.activeKey = null
    state.refCounts = new Map()
    listEl.replaceChildren()
    countEl.textContent = ''
    hideRefs()
  }

  function showEmpty(text) {
    listEl.innerHTML = text ? `<div class="o-empty">${escHtml(text)}</div>` : ''
  }

  /**
   * 渲染列表。
   *
   * 搜索时**仍保持树形**：保留命中节点和它们的祖先，祖先淡色显示作路径上下文。
   * 早先拍平成「父名.子名」的一行，260px 里被截成 `OrganizationDomainService.6...`，
   * 既看不出层级也看不出方法名。
   */
  function renderList() {
    listEl.replaceChildren()
    if (!state.root) return
    state.flat = []
    const frag = document.createDocumentFragment()

    if (state.filter) {
      const kw = state.filter.toLowerCase()
      const kids = filterTree(state.root, kw)
      if (!kids.length) { showEmpty('没有匹配的符号。'); return }
      // 搜索结果全展开：用户要看「命中的都在哪几层」，不是折叠状态
      renderNodes({ children: kids }, 0, frag, kw)
    } else {
      renderNodes(state.root, 0, frag, null)
    }
    listEl.appendChild(frag)
    paintActive()
  }

  /** 按关键词过滤子树，保留命中节点与它们的祖先 */
  function filterTree(node, kw) {
    const out = []
    for (const c of node.children) {
      const sub = filterTree(c, kw)
      const matched = c.name.toLowerCase().includes(kw)
      if (matched || sub.length) out.push({ ...c, children: sub, _matched: matched })
    }
    return out
  }

  /** @param {string|null} kw 非 null 表示搜索态：忽略折叠、祖先淡色 */
  function renderNodes(node, depth, frag, kw) {
    for (const c of node.children) {
      state.flat.push(c)
      const key = keyOf(c)
      const isCollapsed = kw ? false : state.collapsed.has(key)
      const dim = Boolean(kw) && c._matched === false
      frag.appendChild(nodeRow(c, depth, isCollapsed, dim, kw))
      if (c.children.length && !isCollapsed) renderNodes(c, depth + 1, frag, kw)
    }
  }

  function nodeRow(sym, depth, isCollapsed, dim, kw) {
    const el = document.createElement('div')
    const key = keyOf(sym)
    el.className = 'o-node'
      + (state.activeKey === key ? ' active' : '')
      + (dim ? ' o-dim' : '')
    el.dataset.key = key
    el.dataset.line = String(sym.line)
    el.style.paddingLeft = `${6 + depth * 12}px`
    el.setAttribute('role', 'treeitem')

    const isType = TYPE_KINDS.has(sym.kind)
    // 搜索态全部强制展开，折叠箭头点了不会有反应——干脆不显示，免得误导
    const showCaret = !kw && sym.children?.length
    const caret = showCaret
      ? `<span class="o-caret" data-act="toggle" title="${isCollapsed ? '展开' : '折叠'}">${isCollapsed ? CARET_CLOSED : CARET_OPEN}</span>`
      : '<span class="o-caret o-caret-empty"></span>'
    const icon = isType ? 'T' : sym.kind === 'prop' ? 'P' : 'ƒ'
    const iconCls = isType ? 'o-icon-type' : sym.kind === 'prop' ? 'o-icon-prop' : 'o-icon-fn'

    // 引用数：只在 >1 时显示，避免每个符号后面都挂个「1」
    const n = state.refCounts.get(sym.name) || 0
    const badge = n > 1 ? `<span class="o-refs-count-badge" title="本文件内 ${n} 处">${n}</span>` : ''

    el.innerHTML =
      caret +
      `<span class="o-icon ${iconCls}">${icon}</span>` +
      `<span class="o-name" title="${escHtml(sym.name)}${sym.detail ? ` : ${escHtml(sym.detail)}` : ''}">${markMatch(sym.name, kw)}</span>` +
      badge
    return el
  }

  // ---------------------------------------------------------- 引用分区

  function showRefs(sym) {
    const refs = findReferences(state.content, sym.name, { defLine: sym.line })

    refsEl.hidden = false
    refsTitleEl.textContent = sym.name
    refsTitleEl.title = sym.name
    refsListEl.replaceChildren()

    if (!refs.length) {
      refsListEl.innerHTML = '<div class="o-refs-empty">这个文件里没有出现位置</div>'
      return
    }

    const frag = document.createDocumentFragment()
    for (const r of refs.slice(0, REFS_LIMIT)) {
      const row = document.createElement('div')
      row.className = 'o-ref' + (r.isDef ? ' o-ref-def' : '')
      row.dataset.line = String(r.line)
      row.title = r.text
      row.innerHTML = `<span class="o-ref-line">${r.line}</span><span class="o-ref-text">${escHtml(r.text)}</span>`
      frag.appendChild(row)
    }
    if (refs.length > REFS_LIMIT) {
      const more = document.createElement('div')
      more.className = 'o-refs-more'
      more.textContent = `还有 ${refs.length - REFS_LIMIT} 处，用下方按钮搜全部文件`
      frag.appendChild(more)
    }
    refsListEl.appendChild(frag)

    // 让定义那一行在引用区里可见
    const defRow = refsListEl.querySelector('.o-ref-def')
    refsListEl.scrollTop = defRow ? Math.max(0, defRow.offsetTop - 8) : 0
  }

  function hideRefs() {
    refsEl.hidden = true
    refsTitleEl.textContent = ''
    refsListEl.replaceChildren()
    state.activeSym = null
  }

  // ---------------------------------------------------------- 选中与跳转

  function paintActive() {
    for (const el of listEl.querySelectorAll('.o-node')) {
      el.classList.toggle('active', el.dataset.key === state.activeKey)
    }
  }

  /** 滚动联动：把某个源码行对应的符号标为当前（不改变引用区） */
  function syncToLine(line) {
    if (!state.flat.length) return
    let target = null
    for (const s of state.flat) {
      if (s.line <= line) target = s
      else break
    }
    if (!target) return
    const key = keyOf(target)
    if (key === state.activeKey) return
    state.activeKey = key
    paintActive()
    scrollNodeIntoView(key)
  }

  function scrollNodeIntoView(key) {
    const el = listEl.querySelector(`.o-node[data-key="${cssEscape(key)}"]`)
    if (!el) return
    const box = listEl.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.top < box.top + 20) listEl.scrollTop += r.top - box.top - 20
    else if (r.bottom > box.bottom - 8) listEl.scrollTop += r.bottom - box.bottom + 8
  }

  /** 主动选中某个符号（点击时） */
  function selectSymbol(sym) {
    state.activeSym = sym
    state.activeKey = keyOf(sym)
    paintActive()
    scrollNodeIntoView(state.activeKey)
    showRefs(sym)
  }

  // ---------------------------------------------------------- 事件

  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.o-node')
    if (!row) return
    const key = row.dataset.key
    const sym = state.flat.find((s) => keyOf(s) === key)
    if (!sym) return

    // 点折叠箭头只切折叠，不跳转
    if (e.target.closest('[data-act="toggle"]')) {
      if (state.collapsed.has(key)) state.collapsed.delete(key)
      else state.collapsed.add(key)
      renderList()
      return
    }
    selectSymbol(sym)
    jumpToLine(sym.line)
  })

  // 引用行点击 → 跳到那一行
  refsListEl.addEventListener('click', (e) => {
    const row = e.target.closest('.o-ref')
    if (!row) return
    const line = Number(row.dataset.line)
    if (Number.isFinite(line)) jumpToLine(line)
  })

  searchAllBtn.addEventListener('click', () => {
    if (state.activeSym) onSearchAll(state.activeSym.name)
  })

  filterEl.addEventListener('input', () => {
    state.filter = filterEl.value.trim()
    renderList()
  })
  filterEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.target.value = ''
      state.filter = ''
      renderList()
    }
  })

  return {
    render,
    clear,
    syncToLine,
    setVisible(v) { containerEl.hidden = !v },
    isSupported: () => supportsOutline(state.lang),
    symbolCount: () => state.symbols.length,
    _state: state,
  }
}

// ---------------------------------------------------------------- 小工具

const CARET_OPEN =
  '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M2.5 4.5L6 8l3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CARET_CLOSED =
  '<svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M4.5 2.5L8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/**
 * 把名字里命中关键词的那一段包成 <mark>。
 * 先按小写找位置，再对原始字符串切片，避免大小写转换改变长度时错位。
 */
function markMatch(name, kw) {
  if (!kw) return escHtml(name)
  const i = String(name).toLowerCase().indexOf(kw)
  if (i < 0) return escHtml(name)
  return escHtml(name.slice(0, i)) +
    '<mark>' + escHtml(name.slice(i, i + kw.length)) + '</mark>' +
    escHtml(name.slice(i + kw.length))
}

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c])
}

/** 符号名可能含 $ 等字符，拼进选择器前转义 */
function cssEscape(s) {
  if (window.CSS?.escape) return window.CSS.escape(s)
  return String(s).replace(/[^\w-]/g, (c) => `\\${c}`)
}
