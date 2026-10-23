/**
 * 右侧符号大纲面板。
 *
 * 只负责渲染与交互，符号怎么提取在 symbols.js（纯逻辑、可单测）。
 * 这里通过回调跟宿主页面解耦：跳转、跨文件搜索都由 tree.js 提供。
 *
 * 交互约定：
 *   点符号名  → 跳到定义行，并展开「本文件引用」列表
 *   点折叠箭头 → 折叠/展开子树（默认全展开）
 *   点引用行  → 跳到那一行
 *   底部按钮  → 把符号名交给左侧内容搜索
 */

import { extractSymbols, buildSymbolTree, supportsOutline, findReferences } from '/symbols.js'

/** 这些 kind 算「类型」，用方框图标 + 紫色 */
const TYPE_KINDS = new Set(['class', 'interface', 'enum', 'record', 'struct', 'type', 'delegate', 'annotation'])
/** 引用列表最多列这么多条，其余用「还有 N 处」收尾 */
const REFS_LIMIT = 12

const keyOf = (s) => `${s.line}:${s.name}`

export function createOutline(opts) {
  const {
    containerEl, listEl, countEl, filterEl, footEl,
    jumpToLine, onSearchAll,
  } = opts

  const state = {
    path: '',
    lang: '',
    content: '',
    symbols: [],        // 扁平
    flat: [],           // 渲染顺序（含层级信息），用于滚动联动
    root: null,
    collapsed: new Set(),
    expandedRefs: new Set(),
    activeKey: null,
    filter: '',
    unsupported: false,
  }

  // ---------------------------------------------------------- 渲染

  function render(path, content, lang) {
    state.path = path || ''
    state.content = content || ''
    state.lang = lang || ''
    state.collapsed.clear()
    state.expandedRefs.clear()
    state.activeKey = null
    state.filter = ''
    filterEl.value = ''
    footEl.hidden = true

    if (!supportsOutline(state.lang)) {
      state.symbols = []
      state.flat = []
      state.unsupported = true
      showEmpty(state.content ? '这种文件没有代码符号。' : '')
      countEl.textContent = ''
      return
    }
    state.unsupported = false
    state.symbols = extractSymbols(state.content, state.lang)
    state.root = buildSymbolTree(state.symbols)
    if (!state.symbols.length) {
      showEmpty('没有识别到类型或函数。')
      countEl.textContent = ''
      return
    }
    countEl.textContent = String(state.symbols.length)
    renderList()
  }

  function clear() {
    state.symbols = []
    state.flat = []
    state.root = null
    state.path = ''
    state.content = ''
    listEl.replaceChildren()
    countEl.textContent = ''
    footEl.hidden = true
  }

  function showEmpty(text) {
    listEl.innerHTML = text ? `<div class="o-empty">${escHtml(text)}</div>` : ''
  }

  /**
   * 渲染列表。filter 非空时改成**扁平命中列表**（带 ancestor 前缀），
   * 否则按树的展开状态递归。
   */
  function renderList() {
    listEl.replaceChildren()
    if (!state.root) return

    if (state.filter) {
      const kw = state.filter.toLowerCase()
      const hits = []
      const walk = (node, trail) => {
        for (const c of node.children) {
          const nextTrail = [...trail, c.name]
          if (c.name.toLowerCase().includes(kw)) hits.push({ node: c, trail })
          walk(c, nextTrail)
        }
      }
      walk(state.root, [])
      if (!hits.length) { showEmpty('没有匹配的符号。'); return }
      state.flat = hits.map((h) => h.node)
      const frag = document.createDocumentFragment()
      for (const h of hits) frag.appendChild(nodeRow(h.node, 0, false, h.trail))
      listEl.appendChild(frag)
      return
    }

    state.flat = []
    const frag = document.createDocumentFragment()
    const walk = (node, depth) => {
      for (const c of node.children) {
        state.flat.push(c)
        const key = keyOf(c)
        const isCollapsed = state.collapsed.has(key)
        frag.appendChild(nodeRow(c, depth, isCollapsed))
        if (state.expandedRefs.has(key)) frag.appendChild(refsBlock(c))
        if (c.children.length && !isCollapsed) walk(c, depth + 1)
      }
    }
    walk(state.root, 0)
    listEl.appendChild(frag)
    paintActive()
  }

  function nodeRow(sym, depth, isCollapsed, trail) {
    const el = document.createElement('div')
    const key = keyOf(sym)
    el.className = 'o-node' + (state.activeKey === key ? ' active' : '')
    el.dataset.key = key
    el.dataset.line = String(sym.line)
    el.style.paddingLeft = `${6 + depth * 12}px`
    el.setAttribute('role', 'treeitem')

    const isType = TYPE_KINDS.has(sym.kind)
    const caret = sym.children?.length
      ? `<span class="o-caret" data-act="toggle" title="${isCollapsed ? '展开' : '折叠'}">${isCollapsed ? CARET_CLOSED : CARET_OPEN}</span>`
      : '<span class="o-caret o-caret-empty"></span>'
    const icon = isType ? 'T' : sym.kind === 'prop' ? 'P' : 'ƒ'
    const iconCls = isType ? 'o-icon-type' : sym.kind === 'prop' ? 'o-icon-prop' : 'o-icon-fn'
    const trailText = trail && trail.length ? `${trail[trail.length - 1]}.` : ''
    // 引用数：只在选中过（缓存过）之后才显示，避免一上来给 200 行文件全算一遍
    const refs = state.expandedRefs.has(key) ? findReferences(state.content, sym.name, { defLine: sym.line }) : null
    const badge = refs && refs.length
      ? `<span class="o-refs-badge" title="本文件内出现 ${refs.length} 次">${refs.length}</span>`
      : ''

    el.innerHTML =
      caret +
      `<span class="o-icon ${iconCls}">${icon}</span>` +
      `<span class="o-name" title="${escHtml(sym.name)}${sym.detail ? ` : ${escHtml(sym.detail)}` : ''}">${escHtml(trailText + sym.name)}</span>` +

      badge
    return el
  }

  /** 「本文件引用」展开块 */
  function refsBlock(sym) {
    const box = document.createElement('div')
    box.className = 'o-refs'
    const refs = findReferences(state.content, sym.name, { defLine: sym.line })
    if (!refs.length) {
      box.innerHTML = '<div class="o-ref-more">没有找到其它出现位置</div>'
      return box
    }
    const frag = document.createDocumentFragment()
    for (const r of refs.slice(0, REFS_LIMIT)) {
      const row = document.createElement('div')
      row.className = 'o-ref' + (r.isDef ? ' o-ref-def' : '')
      row.dataset.line = String(r.line)
      row.title = r.text
      row.innerHTML =
        `<span class="o-ref-line">${r.line}</span><span class="o-ref-text">${escHtml(r.text)}</span>`
      frag.appendChild(row)
    }
    if (refs.length > REFS_LIMIT) {
      const more = document.createElement('div')
      more.className = 'o-ref-more'
      more.textContent = `还有 ${refs.length - REFS_LIMIT} 处，用下方按钮搜全部文件`
      frag.appendChild(more)
    }
    box.appendChild(frag)
    return box
  }

  // ---------------------------------------------------------- 选中与跳转

  function paintActive() {
    for (const el of listEl.querySelectorAll('.o-node')) {
      el.classList.toggle('active', el.dataset.key === state.activeKey)
    }
  }

  /** 滚动联动：把某个源码行对应的符号标为当前 */
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
    // 让当前项在面板里可见（但不抢滚动焦点以外的东西）
    const el = listEl.querySelector(`.o-node[data-key="${cssEscape(key)}"]`)
    if (el) {
      const box = listEl.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      if (r.top < box.top + 20) listEl.scrollTop += r.top - box.top - 20
      else if (r.bottom > box.bottom - 8) listEl.scrollTop += r.bottom - box.bottom + 8
    }
  }

  /** 主动选中某个符号（点击时） */
  function selectSymbol(sym) {
    state.activeKey = keyOf(sym)
    const key = state.activeKey
    // 再点一次收起引用
    if (state.expandedRefs.has(key)) state.expandedRefs.delete(key)
    else state.expandedRefs.add(key)
    renderList()
    const el = listEl.querySelector(`.o-node[data-key="${cssEscape(key)}"]`)
    el?.scrollIntoView({ block: 'nearest' })

    // 底部给跨文件搜索按钮
    footEl.hidden = false
    footEl.innerHTML = ''
    const btn = document.createElement('button')
    btn.className = 'o-search-all'
    btn.textContent = `在所有文件中搜索「${sym.name}」`
    btn.title = `用左侧的内容搜索查 ${sym.name}`
    btn.addEventListener('click', () => onSearchAll(sym.name))
    footEl.appendChild(btn)
  }

  // ---------------------------------------------------------- 事件

  listEl.addEventListener('click', (e) => {
    const refRow = e.target.closest('.o-ref')
    if (refRow) {
      const line = Number(refRow.dataset.line)
      if (Number.isFinite(line)) jumpToLine(line)
      return
    }
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
    // 测试用：直接问内部状态
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
