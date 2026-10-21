/**
 * 从扁平文件列表建目录树，可选把「单链目录」压平成一行。
 *
 * 抽成独立模块的原因：这段是纯逻辑，能直接单元测试；
 * 埋在 tree.js 里只能靠 DOM 反推验证，容易漏边界。
 */

/**
 * @param {Array<{path: string, size: number|null}>} files
 * @param {boolean} compact  是否合并单链目录
 * @returns 树根 { name, path, dirs: Map, files: [] }
 */
export function buildTree(files, compact = true) {
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
  // 目录在前、文件在后，各自按名字排序
  const sortNode = (node) => {
    for (const d of node.dirs.values()) sortNode(d)
    node.files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  }
  sortNode(root)
  if (compact) compressSingleChain(root)
  return root
}

/**
 * 把「单链目录」压平成一行（VS Code 的 compact folders 行为）。
 *
 * 规则：节点自身没有文件、且只有一个子目录 → 把那个子目录并进来。
 * 循环到「有文件」或「子目录不止一个」为止。
 *
 *   com → mysoft → jmpt（jmpt 有 benchmark / common 两个子目录）
 *   com 合并成 com/mysoft，再合并成 com/mysoft/jmpt，停在 jmpt。
 *
 * 分叉点本身是并进链里的——它仍是「唯一的一条路」，只是到了尽头才分开。
 *
 * 不压缩的两种情况（压了会让人看不懂层级）：
 *   - 自身有文件：这是「真目录」，压掉会让那些文件看起来挂错位置
 *   - 有两个以上子目录：本来就分叉了
 *
 * 合并后 `path` 取链末级的真实路径（展开状态按它记），
 * `aliases` 记下所有被折叠掉的中间层路径——locatePath 需要反查。
 */
function compressSingleChain(node) {
  for (const d of node.dirs.values()) {
    while (d.files.length === 0 && d.dirs.size === 1) {
      const only = [...d.dirs.values()][0]
      // 用 "/" 不用 "."：点号会让 .claude/commands 看起来像文件名
      d.name = `${d.name}/${only.name}`
      d.aliases = d.aliases || []
      d.aliases.push(d.path, only.path)
      d.path = only.path
      d.dirs = only.dirs
      d.files = only.files
    }
    compressSingleChain(d)
  }
}

/** 目录下的文件总数（含子目录） */
export function countFiles(node) {
  let n = node.files.length
  for (const d of node.dirs.values()) n += countFiles(d)
  return n
}

/**
 * 压缩链的显示名。
 * 层级多时整条链会很长（src/main/java/com/mysoft/jmpt/benchmark 有 6 段），
 * 把侧栏吃满、挤掉别的目录。所以超过 4 段时中间省略，保留头尾两段——
 * 靠开头（src）和结尾（benchmark）就能定位。完整名字放 title。
 */
export function displayChainName(full) {
  const segs = String(full).split('/')
  if (segs.length <= 4) return full
  return `${segs[0]}/…/${segs.slice(-2).join('/')}`
}
