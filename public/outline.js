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
   * 渲染列表。
   *
   * 搜索时**仍然保持树形**：保留命中节点和它们的祖先，祖先淡色显示作路径上下文。
   * 早先是拍平成「父名.子名」的一行，结果是 260px 里名字被截成
   * `OrganizationDomainService.6...`——既看不出层级也看不出方法名。
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
      // 搜索结果全展开：用户要看的是「命中的都在哪几层」，不是折叠状态
      renderNodes({ children: kids }, 0, frag, kw)
    } else {
      renderNodes(state.root, 0, frag, null)
    }
    listEl.appendChild(frag)
    paintActive()
  }

  /**
   * 按关键词过滤一棵子树，保留命中节点与它们的祖先。
   * 返回新数组（不破坏原树），命中节点带 _matched 标记供渲染区分。
   */
  function filterTree(node, kw) {
    const out = []
    for (const c of node.children) {
      const sub = filterTree(c, kw)
      const matched = c.name.toLowerCase().includes(kw)
      if (matched || sub.length) {
        out.push({ ...c, children: sub, _matched: matched })
      }
    }
    return out
  }

  /**
   * @param {string|null} kw 非 null 表示处于搜索态：忽略折叠、祖先淡色
   */
  function renderNodes(node, depth, frag, kw) {
    for (const c of node.children) {
      state.flat.push(c)
      const key = keyOf(c)
      // 搜索态强制全展开，避免命中项藏在折叠的父节点里看不到
      const isCollapsed = kw ? false : state.collapsed.has(key)
      const dim = Boolean(kw) && c._matched === false
      frag.appendChild(nodeRow(c, depth, isCollapsed, dim, kw))
      if (state.expandedRefs.has(key)) frag.appendChild(refsBlock(c))
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
    // 引用数：只在选中过（缓存过）之后才显示，避免一上来给 200 行文件全算一遍
    const refs = state.expandedRefs.has(key) ? findReferences(state.content, sym.name, { defLine: sym.line }) : null
    const badge = refs && refs.length
      ? `<span class="o-refs-badge" title="本文件内出现 ${refs.length} 次">${refs.length}</span>`
      : ''

    el.innerHTML =
      caret +
      `<span class="o-icon ${iconCls}">${icon}</span>` +
      `<span class="o-name" title="${escHtml(sym.name)}${sym.detail ? ` : ${escHtml(sym.detail)}` : ''}">${markMatch(sym.name, kw)}</span>` +
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

/**
 * 把名字里命中关键词的那一段包成 <mark>。
 * 先按小写找位置，再对原始字符串切片——避免 toLowerCase 改变长度时错位
 * （某些字符小写后长度会变，虽然标识符里基本遇不到，稳妥起见）。
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
