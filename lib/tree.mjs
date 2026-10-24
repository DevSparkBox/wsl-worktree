import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { git } from './git.mjs'

/**
 * 某个 commit 的完整文件树 + 文件内容读取（仿 fork 的 File Tree 页）。
 *
 * 与「改动文件」的区别：Fork 的 File Tree 是**整个仓库在该提交时的快照**，
 * 不是只列有改动的文件。所以用 ls-tree 而不是 diff。
 *
 * 三个注意点：
 * 1) 用 -z 分隔，避免中文/空格路径被转义或拆错（与 history.mjs 同一套理由）。
 * 2) 用 --full-tree，否则在子目录执行时会只输出该子树。
 * 3) 目录不单独列出（ls-tree -r 只给文件），前端按路径前缀自己建树——
 *    这样一棵树只有真实文件，不会出现空目录节点。
 */

/**
 * 列出某 commit 的全部文件。
 * @returns {{ files: Array<{path, size, mode, binary}>, sha: string, total: number }}
 */
export async function listTree(cwd, sha) {
  // 先把引用解析成完整 sha：前端会拿它显示短 sha，也用来拼 file-content 的请求。
  // 传 HEAD 或分支名时如果不解析，界面上就会显示 "HEAD"。
  let resolved = sha
  const rev = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { timeout: 15000 })
  if (rev.code === 0) resolved = rev.stdout.trim()
  else return { files: [], sha, total: 0, error: `找不到这个提交：${sha}` }

  const res = await git(cwd, ['ls-tree', '-r', '-l', '-z', '--full-tree', resolved], {
    quotepath: false,
    timeout: 45000,
    // 18k 文件的输出接近 2MB，放宽上限
    maxBytes: 32 * 1024 * 1024,
  })
  if (res.code !== 0) {
    return { files: [], sha: resolved, total: 0, error: res.stderr || 'git ls-tree 失败' }
  }

  const files = []
  // -z 模式：每条以 \0 结尾，格式为
  //   <mode> SP <type> SP <object> SP* <size> TAB <path>
  for (const rec of res.stdout.split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const meta = rec.slice(0, tab)
    const path = rec.slice(tab + 1)
    // meta 用空白分隔，但 size 宽度是右对齐的，可能有多个空格
    const m = meta.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\s+(-|\d+)$/)
    if (!m) continue
    const mode = m[1]
    const type = m[2]
    if (type !== 'blob') continue   // 跳过子模块（commit 类型）
    const size = m[4] === '-' ? null : Number(m[4])
    files.push({
      path,
      size,
      mode,
      // 权限位 120000 是符号链接；160000 是子模块（上面已跳过）
      symlink: mode === '120000',
    })
  }

  return { files, sha: resolved, total: files.length }
}

/**
 * 读取某 commit 里某个文件的内容。
 *
 * 这是「查看文件快照」，与 diff 是两回事：Fork 的 File Tree 右侧就显示原文。
 * 二进制文件不返回内容（避免把几 MB 的图片塞进 JSON），只回 { binary: true }。
 */
export async function catFile(cwd, sha, path, opts = {}) {
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024

  // 先看大小和是否二进制，避免把大文件整个读进内存
  const info = await git(cwd, ['cat-file', '-s', `${sha}:${path}`], { timeout: 15000 })
  if (info.code !== 0) {
    return { error: `在这个提交里找不到该文件：${path}`, notFound: true }
  }
  const size = Number(info.stdout.trim()) || 0
  if (size > maxBytes) {
    return { tooLarge: true, size, maxBytes }
  }

  // -c core.quotepath=false 对 :path 形式没影响，但保留一致的调用习惯
  const res = await git(cwd, ['show', `${sha}:${path}`], {
    quotepath: false,
    timeout: 30000,
    maxBytes: maxBytes + 1024,
  })
  if (res.code !== 0) {
    return { error: res.stderr || '读取失败' }
  }

  const buf = Buffer.from(res.stdout, 'utf8')
  // 二进制判定：出现 NUL 字节即认为不是文本
  const isBinary = buf.includes(0)
  if (isBinary) {
    return { binary: true, size }
  }

  return {
    content: res.stdout,
    size,
    truncated: res.stdout.length >= maxBytes,
    lines: res.stdout ? res.stdout.split('\n').length - (res.stdout.endsWith('\n') ? 1 : 0) : 0,
  }
}

/**
 * 列出某个 worktree **磁盘上的实际文件**（工作区视图）。
 *
 * 和 listTree 的区别：ls-tree 读对象库，这个读磁盘。
 * 三份名单拼出来：
 *   cached   索引里的全部文件
 *   deleted  索引里有、磁盘上已经没了 → 从树里剔除（树表达「现在有什么」）
 *   others   未跟踪文件 → 保留并标 new
 *
 * 不给文件大小：18k 文件逐个 stat 要几百毫秒，而大小在树里只是装饰。
 *
 * @returns {{ files: Array<{path, size, binary, status}>, sha: string, total: number }}
 */
export async function listWorktreeFiles(cwd) {
  const opts = { timeout: 30000, quotepath: false, maxBytes: 32 * 1024 * 1024 }
  const [cached, deleted, others] = await Promise.all([
    git(cwd, ['ls-files', '-z', '--cached'], opts),
    git(cwd, ['ls-files', '-z', '--deleted'], opts),
    git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], opts),
  ])

  if (cached.code !== 0) {
    return { files: [], sha: 'WORKTREE', total: 0, error: cached.stderr || 'git ls-files 失败' }
  }

  const deletedSet = new Set(deleted.stdout.split('\0').filter(Boolean))
  const untracked = others.stdout.split('\0').filter(Boolean)
  const untrackedSet = new Set(untracked)

  const files = []
  for (const path of cached.stdout.split('\0')) {
    if (!path || deletedSet.has(path)) continue
    files.push({ path, size: 0, binary: false, status: untrackedSet.has(path) ? 'A' : '' })
  }
  for (const path of untracked) {
    files.push({ path, size: 0, binary: false, status: 'A' })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))

  return { files, sha: 'WORKTREE', total: files.length, isWorktree: true }
}

/**
 * 读工作区里的文件内容（磁盘实际内容，不是索引也不是提交）。
 *
 * 必须做路径校验：这里直接把 path 拼到 worktree 根上读磁盘，
 * 传个 `../../etc/passwd` 就能读到仓库外的东西。
 *
 * @returns {{content?, size?, truncated?, lines?, binary?, error?, notFound?}}
 */
export async function readWorktreeFile(cwd, relPath, maxBytes = 1024 * 1024) {
  let root
  try {
    root = await realpath(resolve(cwd))
  } catch {
    return { notFound: true, error: 'worktree 不存在' }
  }
  const full = resolve(root, relPath)
  // 落点必须在 worktree 里（含等于根的情况一律拒绝：那是目录不是文件）
  if (full !== root && !full.startsWith(root + sep)) {
    return { error: '路径越界', notFound: true }
  }
  try {
    // 符号链接可能指向仓库外：先 realpath 再做一次越界判断。
    // Linux 上仓库里出现 symlink 很常见，不校验就等于开放任意文件读取。
    const real = await realpath(full)
    if (real !== root && !real.startsWith(root + sep)) {
      return { error: '路径越界', notFound: true }
    }
    const st = await stat(real)
    if (!st.isFile()) return { error: '不是文件', notFound: true }
    const size = st.size
    // 先看大小再读，避免一个 10GB 文件把服务内存打满
    if (size > maxBytes) return { tooLarge: true, size, maxBytes, error: '文件过大' }
    const buf = await readFile(real)
    if (buf.length > maxBytes) return { tooLarge: true, size: buf.length, maxBytes, error: '文件过大' }
    if (buf.includes(0)) return { binary: true, size }
    const text = buf.toString('utf8')
    return {
      content: text,
      size,
      truncated: false,
      lines: text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0,
    }
  } catch (e) {
    if (e.code === 'ENOENT') return { notFound: true, error: '文件不存在' }
    return { error: String(e.message || e) }
  }
}
