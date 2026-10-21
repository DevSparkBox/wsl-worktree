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
