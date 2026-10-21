// 目录树构建 + 单链压缩（纯逻辑，不开浏览器）
import { buildTree, countFiles, displayChainName } from './public/tree-model.js'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

/** 按路径在树里找目录节点 */
const find = (node, path) => {
  for (const d of node.dirs.values()) {
    if (d.path === path) return d
    const r = find(d, path)
    if (r) return r
  }
  return null
}
/** 树扁平化，方便看结构 */
const flat = (node, depth = 0, out = []) => {
  for (const d of [...node.dirs.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    out.push({ depth, type: 'dir', name: d.name, path: d.path, files: d.files.length, dirs: d.dirs.size, compressed: !!d.aliases })
    flat(d, depth + 1, out)
  }
  for (const f of node.files) out.push({ depth, type: 'file', name: f.name, path: f.path })
  return out
}

// ---------- 1. 单链压缩 ----------
console.log('===== 单链压缩 =====')
const single = buildTree([
  { path: 'com/mysoft/jmpt/benchmark/A.java', size: 1 },
])
let root = single
let bm = find(root, 'com/mysoft/jmpt/benchmark')
check('四级单链压成一行', bm?.name === 'com/mysoft/jmpt/benchmark', bm?.name)
check('压缩后 path 是末级', bm?.path === 'com/mysoft/jmpt/benchmark', bm?.path)
check('记下被折叠的路径', bm?.aliases?.length === 6, `${bm?.aliases?.length} 条`)
check('压缩节点保留文件', bm?.files.length === 1, `${bm?.files.length} 个`)

// ---------- 2. 分叉点 ----------
console.log('\n===== 分叉点 =====')
root = buildTree([
  { path: 'com/mysoft/jmpt/benchmark/A.java', size: 1 },
  { path: 'com/mysoft/jmpt/common/C.java', size: 3 },
])
const fork = find(root, 'com/mysoft/jmpt')
check('压缩到分叉点为止', fork?.name === 'com/mysoft/jmpt', fork?.name)
check('分叉点是页面上的一行', fork?.dirs.size === 2, `${fork?.dirs.size} 个子目录`)
check('两个分叉子目录名可见',
  [...(fork?.dirs.values() || [])].map((x) => x.name).sort().join(',') === 'benchmark,common',
  [...(fork?.dirs.values() || [])].map((x) => x.name).join(','))

// ---------- 3. 有文件的目录不压缩 ----------
console.log('\n===== 不压缩的情况 =====')
root = buildTree([
  { path: 'keep/own.txt', size: 1 },
  { path: 'keep/only/child/E.java', size: 2 },
])
const keep = find(root, 'keep')
check('自身有文件 → 不压缩', keep?.name === 'keep', keep?.name)
check('其下的单链仍会被压缩', find(root, 'keep/only/child')?.name === 'only/child',
  find(root, 'keep/only/child')?.name)

// 多子目录
root = buildTree([
  { path: 'a/x/1.txt', size: 1 },
  { path: 'a/y/2.txt', size: 1 },
])
check('多子目录 → 不压缩', find(root, 'a')?.name === 'a', find(root, 'a')?.name)

// ---------- 4. 点号开头的目录 ----------
console.log('\n===== 点号开头的目录 =====')
root = buildTree([
  { path: '.claude/commands/a.md', size: 1 },
  { path: '.run/x.xml', size: 1 },
])
const cl = find(root, '.claude/commands')
check('用 / 连接而非点号', cl?.name === '.claude/commands', cl?.name)
check('不会变成 .claude.commands 的假扩展名外观', !String(cl?.name).includes('.claude.'), cl?.name)

// ---------- 5. 关闭压缩 ----------
console.log('\n===== 关闭压缩 =====')
root = buildTree([{ path: 'com/mysoft/A.java', size: 1 }], false)
check('compact=false 保持逐层', find(root, 'com')?.name === 'com', find(root, 'com')?.name)
check('无压缩标记', !find(root, 'com')?.aliases, String(find(root, 'com')?.aliases))

// ---------- 6. 文件计数 ----------
console.log('\n===== 计数 =====')
root = buildTree([
  { path: 'a/1.txt', size: 1 },
  { path: 'a/b/2.txt', size: 1 },
  { path: 'a/b/c/3.txt', size: 1 },
])
check('目录计数含子目录', countFiles(find(root, 'a')) === 3, String(countFiles(find(root, 'a'))))
check('叶子目录计数正确', countFiles(find(root, 'a/b/c')) === 1, String(countFiles(find(root, 'a/b/c'))))

// ---------- 7. 显示名截断 ----------
console.log('\n===== 显示名 =====')
check('4 段以内不截断', displayChainName('a/b/c/d') === 'a/b/c/d', displayChainName('a/b/c/d'))
check('超过 4 段中间省略', displayChainName('src/main/java/com/mysoft/x') === 'src/…/mysoft/x',
  displayChainName('src/main/java/com/mysoft/x'))
check('长链保留头尾', displayChainName('src/main/java/com/mysoft/jmpt/benchmark') === 'src/…/jmpt/benchmark',
  displayChainName('src/main/java/com/mysoft/jmpt/benchmark'))
check('单段不变', displayChainName('abc') === 'abc', displayChainName('abc'))

// ---------- 8. 真实结构（截图里的那棵树）----------
console.log('\n===== 真实路径 =====')
root = buildTree([
  { path: 'backend/src/jmpt-benchmark/src/main/java/com/mysoft/jmpt/benchmark/constant/A.java', size: 1 },
  { path: 'backend/src/jmpt-benchmark/src/main/java/com/mysoft/jmpt/benchmark/metadata/B.java', size: 1 },
  { path: 'backend/src/jmpt-common/src/main/java/com/mysoft/jmpt/common/C.java', size: 1 },
])
const rows = flat(root)
const chainRows = rows.filter((r) => r.compressed)
console.log('压缩行:', chainRows.map((r) => `${'  '.repeat(r.depth)}${r.name}`).join(' | '))
check('识别出压缩链', chainRows.length >= 3, `${chainRows.length} 个`)
// backend/src 是分叉点（下有两个 jmpt-*），它自己压成一行后断开；
// 各子分支内部的 src/main/java/com/... 再各自压成一行
check('顶层压缩到分叉点', chainRows.some((r) => r.name === 'backend/src'),
  chainRows.map((r) => r.name).join(' ; ').slice(0, 70))
check('分支内部继续压缩',
  chainRows.some((r) => r.name === 'jmpt-benchmark/src/main/java/com/mysoft/jmpt/benchmark'),
  chainRows.filter((r) => r.depth > 0).map((r) => r.name).join(' ; ').slice(0, 70))
// 层级深度应显著下降：原始 11 层 → 压缩后更少
const maxDepth = Math.max(...rows.map((r) => r.depth))
check('层级深度下降（≤6）', maxDepth <= 6, `最深 ${maxDepth} 层`)

// 所有文件仍能在树上找到（压缩不能丢文件）
const allFiles = []
function collect(node) {
  for (const f of node.files) allFiles.push(f.path)
  for (const d of node.dirs.values()) collect(d)
}
collect(root)
check('压缩后文件不丢失', allFiles.length === 3, `${allFiles.length} 个`)
check('文件仍可按下标定位', allFiles.includes('backend/src/jmpt-common/src/main/java/com/mysoft/jmpt/common/C.java'), '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
