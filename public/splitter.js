/**
 * 左右分栏的拖动分隔线。
 *
 * 从 tree.js 抽出来，供文件树页和对比页共用。
 * 宽度记在 localStorage，双击复位。
 *
 * @param {object} opt
 * @param {HTMLElement} opt.layout     CSS 变量 --w-tree 挂在它上面
 * @param {HTMLElement} opt.splitter   分隔条
 * @param {string} opt.storageKey      localStorage 键（两个页面各记各的）
 * @param {number} [opt.defaultWidth]
 */
export function initSplitter({ layout, splitter, storageKey, defaultWidth = 320 }) {
  if (!layout || !splitter) return
  let dragging = false

  const saved = Number(localStorage.getItem(storageKey))
  if (Number.isFinite(saved) && saved >= 200) {
    layout.style.setProperty('--w-tree', `${saved}px`)
  } else {
    layout.style.setProperty('--w-tree', `${defaultWidth}px`)
  }

  const onMove = (e) => {
    if (!dragging) return
    const rect = layout.getBoundingClientRect()
    // 下限 200（再窄树就看不清了），上限同时受「右边至少留 320」和「窗口 60%」约束
    const w = Math.min(
      Math.max(200, e.clientX - rect.left),
      Math.min(rect.width - 320, window.innerWidth * 0.6),
    )
    layout.style.setProperty('--w-tree', `${Math.round(w)}px`)
    e.preventDefault()
  }

  const onUp = () => {
    if (!dragging) return
    dragging = false
    splitter.classList.remove('dragging')
    document.body.style.cursor = ''
    const w = parseInt(getComputedStyle(layout).getPropertyValue('--w-tree'), 10)
    if (Number.isFinite(w)) localStorage.setItem(storageKey, String(w))
  }

  splitter.addEventListener('mousedown', (e) => {
    dragging = true
    splitter.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    e.preventDefault()
  })
  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  splitter.addEventListener('dblclick', () => {
    layout.style.setProperty('--w-tree', `${defaultWidth}px`)
    localStorage.setItem(storageKey, String(defaultWidth))
  })
}
