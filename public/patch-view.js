/**
 * unified patch → 带行号的表格。
 *
 * 从 history.js 抽出来，供「文件历史」和「提交对比」两个页面共用。
 * 逻辑保持原样：解析 @@ 头拿到起始行号，逐行判断新增/删除/上下文。
 */
import { escHtml as esc } from '/linkify.js'

/**
 * @param {string} patch  `git diff` 的输出（不含颜色）
 * @returns {{ table: HTMLTableElement, add: number, del: number }}
 */
export function renderPatchTable(patch) {
  const table = document.createElement('table')
  table.className = 'h-patch-table'
  const tbody = document.createElement('tbody')

  let oldNo = 0
  let newNo = 0
  let add = 0
  let del = 0

  for (const line of String(patch ?? '').split('\n')) {
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

/** 只数增删行，不建 DOM（用于「加载中」先显示大概规模时可选） */
export function countPatch(patch) {
  let add = 0
  let del = 0
  for (const line of String(patch ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) add++
    else if (line.startsWith('-')) del++
  }
  return { add, del }
}
