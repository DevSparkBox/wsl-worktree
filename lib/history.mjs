import { git } from './git.mjs'

/**
 * 单文件历史。
 *
 * 三个必须处理的坑（都在真实仓库上验证过）：
 *
 * 1) 改名。文件被改名后，用当前路径查 `git log -- <新路径>` 只能查到改名之后的历史。
 *    `--follow` 能跟到改名之前，但 follow 的路径跟踪是「一次一个文件」的重写逻辑，
 *    和 --skip 分页混用会错乱，所以一次性取全量并设上限。
 *
 * 2) 取 diff 必须用「当时那个路径」。改名前的 commit 里文件叫旧名字，
 *    用新路径去 diff 会得到空结果。所以每条记录都带上 pathAtCommit。
 *
 * 3) 中文/特殊字符路径。git 默认把非 ASCII 转义成 \345\207\275 形式，
 *    界面上是乱码、回传给 diff 也匹配不上。必须 core.quotepath=false。
 *    另外路径里的 [ ] 虽然实测不当通配符，仍统一加 :(literal) 消除歧义。
 */

// 记录分隔：\x01 开头的这行是「提交头」，后面跟一段 --name-status。
// 注意不能直接按 \x01 切分 —— 头字段之间也用 \x01，会切碎。
// 所以用「\n\x01」作为记录边界（头永远出现在行首）。
const FORMAT = '%x01%H%x01%an%x01%ae%x01%at%x01%s'

/** 把 path 转成 pathspec，避免 [ ] * ? 被当通配符 */
const literal = (p) => `:(literal)${p}`

/**
 * 解析 `--numstat -z` 段。
 *
 * -z 模式下改名条目长这样（注意 add/del 后面直接跟 \0，再跟旧路径、新路径）：
 *   0\t0\t\0旧路径\0新路径\0
 * 普通条目：
 *   20\t19\t路径\0
 *
 * 二进制文件 add/del 是 "-\t-\t"。
 * 返回 { status, add, del, oldPath, newPath }
 */
function parseNumstatZ(text) {
  const out = []
  // 尾部 \0\n 之类的空段直接滤掉
  const fields = text.split('\0')
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i].replace(/^\n+/, '')
    if (!f) continue
    const m = f.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s)
    if (!m) continue
    const add = m[1] === '-' ? null : Number(m[1])
    const del = m[2] === '-' ? null : Number(m[2])
    const rest = m[3]

    if (rest === '') {
      // 改名：后面紧跟两段路径
      const oldPath = (fields[i + 1] || '').replace(/\n+$/, '')
      const newPath = (fields[i + 2] || '').replace(/\n+$/, '')
      i += 2
      out.push({ status: 'renamed', add, del, oldPath, newPath })
    } else {
      out.push({ status: 'modified', add, del, path: rest.replace(/\n+$/, '') })
    }
  }
  return out
}

/** 从 numstat 条目推断 git 的 A/M/D 状态（numstat 本身不区分，改名单独标） */


/**
 * 取一个文件的历史。
 * @param {string} cwd          在哪个 worktree 里执行（决定引用可见范围）
 * @param {string} filePath     相对 worktree 根的文件路径
 * @param {{ follow?: boolean, limit?: number, rev?: string }} opts
 */
export async function getFileHistory(cwd, filePath, opts = {}) {
  const follow = opts.follow !== false
  const limit = Math.min(2000, opts.limit || 500)
  const rev = opts.rev || 'HEAD'

  // 用 --numstat -z 而不是 --name-status：
  //   numstat 一次给出「改动行数」，能直接显示 +12 −3，信息密度更高；
  //   -z 模式下改名条目会给出「旧路径\0新路径」两段，不丢改名信息。
  //   而 --name-status 没有行数统计，要显示统计就得多跑一次 git。
  const args = ['log', `--format=${FORMAT}`, '--numstat', '-z', '--no-color']
  if (follow) args.push('--follow')
  args.push('-n', String(limit + 1))
  if (rev && rev !== 'HEAD') args.push(rev)
  args.push('--', literal(filePath))

  const res = await git(cwd, args, { quotepath: false, timeout: 45000 })
  if (res.code !== 0) {
    // --follow 在极少数情况（如文件只存在于其它分支）会失败，退化成不 follow 再试一次
    if (follow) {
      const plain = await git(cwd, ['log', `--format=${FORMAT}`, '--numstat', '-z', '--no-color',
        '-n', String(limit + 1), '--', literal(filePath)], { quotepath: false, timeout: 45000 })
      if (plain.code !== 0) {
        return { commits: [], truncated: false, follow: false, error: plain.stderr || 'git log 失败' }
      }
      return buildResult(plain.stdout, filePath, limit, false)
    }
    return { commits: [], truncated: false, follow: false, error: res.stderr || 'git log 失败' }
  }
  return buildResult(res.stdout, filePath, limit, follow)
}

function buildResult(stdout, filePath, limit, follow) {
  const commits = []
  // \x01 同时用于「记录边界」和「头部字段分隔」，不能简单 split。
  // 真正的记录边界特征是：\x01 后面紧跟 40 位 hex（完整 sha）。
  // 所以用正则把「\x01 + sha」作为分隔锚点，各段自行补回 sha。
  const parts = stdout.split(/(?=\x01[0-9a-f]{40}\x01)/)
  for (const part of parts) {
    let body = part
    if (!body.startsWith('\x01')) continue
    body = body.slice(1)   // 去掉记录边界那个 \x01，后面的 sha 就是首字段
    if (!body.trim()) continue
    const headerEnd = body.indexOf('\0')
    const header = headerEnd >= 0 ? body.slice(0, headerEnd) : body.split('\n')[0]
    const rest = headerEnd >= 0 ? body.slice(headerEnd) : ''
    const [sha, author, email, ts, ...subjectParts] = header.split('\x01')
    if (!sha || sha.length < 7) continue
    const subject = subjectParts.join('\x01')

    const entries = parseNumstatZ(rest)

    let pathAtCommit = filePath
    let rename = null
    let add = null
    let del = null
    if (entries.length) {
      const ren = entries.find((e) => e.status === 'renamed')
      if (ren) {
        rename = { from: ren.oldPath, to: ren.newPath }
        pathAtCommit = ren.newPath || filePath
        add = ren.add
        del = ren.del
      } else {
        pathAtCommit = entries[0].path || filePath
        add = entries[0].add
        del = entries[0].del
      }
    }

    commits.push({
      sha,
      author,
      email,
      time: Number(ts) * 1000,
      subject,
      pathAtCommit,
      rename,
      add,
      del,
      // 新增/修改/改名：numstat 不直接给 A/M/D，最后一条（最早的历史）判定为「新增」
      status: rename ? 'renamed' : 'modified',
    })
    if (commits.length > limit) break
  }

  const truncated = commits.length > limit
  if (truncated) commits.length = limit
  // 最早那条且是纯新增（没有父提交改过）时标为「新增」
  const last = commits[commits.length - 1]
  if (last && last.add != null && last.del === 0) last.status = 'added'
  return { commits, truncated, follow }
}

/**
 * 取某个 commit 里该文件的 diff。
 * pathAtCommit 必须用历史记录里的「当时路径」，否则改名前的提交会拿到空 diff。
 */
export async function getHistoryDiff(cwd, sha, pathAtCommit, opts = {}) {
  const maxBytes = opts.maxBytes || 2 * 1024 * 1024
  const parents = await git(cwd, ['rev-list', '--parents', '-n', '1', sha], { timeout: 15000 })
  const parts = parents.stdout.trim().split(/\s+/).filter(Boolean)
  const isRoot = parts.length <= 1

  const args = isRoot
    ? ['show', '--format=', '--no-color', '--no-ext-diff', '-U3', '--find-renames', sha, '--', literal(pathAtCommit)]
    : ['diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames', parts[1], sha, '--', literal(pathAtCommit)]

  const res = await git(cwd, args, { quotepath: false, timeout: 30000, maxBytes })
  return {
    patch: res.stdout.slice(0, maxBytes),
    truncated: res.stdout.length >= maxBytes,
    error: res.code === 0 ? null : res.stderr,
  }
}

/** 列出仓库全部已跟踪文件（给「粘贴路径」的自动完成用） */
export async function listFiles(cwd) {
  const res = await git(cwd, ['ls-files', '-z'], { quotepath: false, timeout: 30000 })
  if (res.code !== 0) return { files: [], error: res.stderr }
  return { files: res.stdout.split('\0').filter(Boolean) }
}
