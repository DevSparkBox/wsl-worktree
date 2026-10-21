import { git } from './git.mjs'

/**
 * 在某个 commit 的文件树里按内容搜索。
 *
 * 为什么用 `git grep <tree-ish>` 而不是 rg 搜物理目录：
 *   文件树的语义是「这个 commit 当时的快照」。用 rg 搜 worktree 会得到今天的磁盘内容，
 *   在查看旧提交时会给出**错误的答案**（比如文件已改名、已删除、尚未创建）。
 *   `git grep` 直接在对象库里搜，天然是变更集视角。
 *
 * 性能实测（18188 个文件）：
 *   搜普通词 446ms、精确词 82ms、宽正则匹配 6098 文件 194ms。
 *   rg 搜同一目录 43ms —— 只慢一倍，不是数量级差异。
 *
 * 三个实现要点：
 *   1) `-z` 输出：路径与内容之间、多条记录之间都用 \0 分隔，
 *      所以路径里的冒号/空格/换行都不会破坏解析。
 *   2) `core.quotepath=false`：否则中文路径变成 \345\207\275 形式，
 *      前端拿去打开文件会对不上（和文件历史那边踩过同一个坑）。
 *   3) 用户输入默认按**字面量**处理（-F）。搜索框里输 `$(` 这类正则元字符
 *      是很自然的行为，按正则会直接报错或给出意外结果。需要正则时显式开启。
 */

/** 单次搜索最多返回的命中行数，防止宽正则在超大仓库里刷爆内存 */
const MAX_HITS = 2000
/** 单行内容截断长度（搜索结果只需要预览） */
const MAX_LINE_LEN = 400

/**
 * @param {string} cwd      在哪个 worktree 里执行（决定引用可见性）
 * @param {string} sha      commit
 * @param {object} opts
 * @param {string} opts.pattern     搜索内容
 * @param {string} [opts.path]      限定子树（相对仓库根）
 * @param {boolean} [opts.ignoreCase]
 * @param {boolean} [opts.regex]    true 时按正则（-E），默认字面量（-F）
 * @returns {{ files: Array, total: number, truncated: boolean, error?: string }}
 */
export async function grepTree(cwd, sha, opts = {}) {
  const pattern = String(opts.pattern ?? '')
  if (!pattern) return { files: [], total: 0, truncated: false }

  const args = ['grep', '-I', '-n', '-z', '--no-color']
  // 正则 vs 字面量：字面量用 -F，能搜 $ ( ) [ 等字符而不报错
  args.push(opts.regex ? '-E' : '-F')
  if (opts.ignoreCase) args.push('-i')
  args.push('-e', pattern)

  // 先解析 sha，避免把 'HEAD' 这种引用名当成路径歧义
  const rev = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { timeout: 15000 })
  const commit = rev.code === 0 ? rev.stdout.trim() : sha

  args.push(commit, '--')
  if (opts.path) {
    // :(literal) 防止路径里的 [ ] * ? 被当通配符
    args.push(`:(literal)${opts.path}`)
  }

  const res = await git(cwd, args, {
    quotepath: false,
    timeout: 45000,
    maxBytes: 24 * 1024 * 1024,
  })

  // 退出码：0 有命中，1 无命中，>1 出错
  if (res.code === 1) return { files: [], total: 0, truncated: false, sha: commit }
  if (res.code !== 0) {
    return { files: [], total: 0, truncated: false, sha: commit, error: res.stderr || 'git grep 失败' }
  }

  return { ...parseGrepZ(res.stdout, MAX_HITS), sha: commit }
}

/**
 * 解析 `git grep -z -n` 的输出。
 *
 * 实测的字节结构（od -c 确认，和直觉不同）：
 *   <sha>:<path> \0 <lineNo> \0 <content> \n <sha>:<path> \0 ...
 *
 * 也就是：
 *   - 路径和自己后面的 lineNo 之间是 \0（-z 只把「文件名」当作 NUL 结尾字段）
 *   - 但 **content 与下一条记录之间仍然是 \n**
 *   - 并且路径前会带 `<rev>:` 前缀
 *
 * 所以不能简单按 \0 三三分组。正确做法：先按 \n 切记录，再对每条记录
 * 按前两个 \0 切出 path / lineNo / content。
 * path 里的冒号不会造成问题——我们只去掉**第一个** `rev:` 前缀。
 */
function parseGrepZ(stdout, maxHits) {
  const byPath = new Map()
  let total = 0
  let truncated = false

  for (const record of stdout.split('\n')) {
    if (!record) continue
    // path \0 lineNo \0 content
    const z1 = record.indexOf('\0')
    if (z1 < 0) continue
    const z2 = record.indexOf('\0', z1 + 1)
    if (z2 < 0) continue

    let path = record.slice(0, z1)
    const lineNoRaw = record.slice(z1 + 1, z2)
    let content = record.slice(z2 + 1)

    // 去掉 git grep 输出的 `<rev>:` 前缀（只在第一个冒号处切）
    const colon = path.indexOf(':')
    if (colon > 0) path = path.slice(colon + 1)

    const lineNo = Number(lineNoRaw)
    if (!path || !Number.isFinite(lineNo)) continue

    total++
    if (total > maxHits) { truncated = true; break }

    if (content.length > MAX_LINE_LEN) content = content.slice(0, MAX_LINE_LEN)
    content = content.replace(/\r$/, '')

    if (!byPath.has(path)) byPath.set(path, [])
    byPath.get(path).push({ line: lineNo, text: content })
  }

  // 按「命中数降序，再按路径」排序：命中多的文件通常是用户想找的
  const files = [...byPath.entries()]
    .map(([path, hits]) => ({ path, hits }))
    .sort((a, b) => b.hits.length - a.hits.length || a.path.localeCompare(b.path, 'zh'))

  return { files, total: total > maxHits ? maxHits : total, truncated }
}
