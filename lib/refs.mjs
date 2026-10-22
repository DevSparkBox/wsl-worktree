import { git } from './git.mjs'
import { LOG_FMT, parseLog } from './logfmt.mjs'

/**
 * 查询某个 commit 上指向它的引用（主要是 tag，也带分支）。
 *
 * 用途：文件树顶栏显示「这个变更集对应哪个发布版本」。
 *
 * 两个要点：
 *
 * 1) **必须用 `--points-at`，不能比较对象 sha**。
 *    annotated tag 的对象类型是 `tag`（指向 tag object 再指向 commit），
 *    轻量 tag 的对象类型是 `commit`。自己拿 tag 对象 sha 去和 commit sha 比
 *    会把 annotated tag 全部漏掉。`git tag --points-at <commit>` 会正确处理两种情况。
 *
 * 2) 性能：`for-each-ref --points-at` 实测 9ms，可以在打开页面时直接查，不需要缓存。
 */
export async function refsAtCommit(cwd, sha) {
  const rev = await git(cwd, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], { timeout: 15000 })
  if (rev.code !== 0) return { sha, tags: [], branches: [], error: `找不到这个提交：${sha}` }
  const commit = rev.stdout.trim()

  // 一次拿全部 ref，再按 refs/tags / refs/heads / refs/remotes 分类。
  // 用 for-each-ref 而不是分别调 `git tag` + `git branch`：一次进程，且能拿到 objecttype。
  const res = await git(cwd, [
    'for-each-ref',
    `--points-at=${commit}`,
    '--format=%(refname)%00%(objecttype)%00%(refname:short)',
  ], { quotepath: false, timeout: 20000 })

  if (res.code !== 0) {
    return { sha: commit, tags: [], branches: [], error: res.stderr || 'for-each-ref 失败' }
  }

  const tags = []
  const branches = []
  for (const line of res.stdout.split('\n')) {
    if (!line) continue
    const [full, objtype, short] = line.split('\0')
    if (!full || !short) continue
    if (full.startsWith('refs/tags/')) {
      // objecttype：'tag' = annotated（带说明/tagger），'commit' = 轻量 tag
      tags.push({ name: short, annotated: objtype === 'tag' })
    } else if (full.startsWith('refs/heads/')) {
      branches.push({ name: short, remote: false })
    } else if (full.startsWith('refs/remotes/')) {
      branches.push({ name: short, remote: true })
    }
  }

  // tag 按名字排序，让 v5.5.10.55 这类版本号看起来稳定
  tags.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  branches.sort((a, b) => a.name.localeCompare(b.name, 'zh'))

  return { sha: commit, tags, branches }
}

/**
 * 所有 ref（本地分支 / 远程分支 / tag）**直接指向**的提交。
 *
 * 用途：对比页的「最近提交」列表。只给最近 N 条的话，老 tag（比如三个月前的
 * v5.5.10.55）根本不在列表里，用户想按 tag 找提交就搜不到。
 *
 * 实现用 `git log --all --no-walk=unsorted`：
 *   --all        覆盖 refs/heads + refs/remotes + refs/tags
 *   --no-walk    只输出这些 ref 指向的提交本身，不展开历史
 * 一条命令拿全，而且 %D 会自动带上 decorate（`tag: v5.5.10.55, origin/main`），
 * 与 getLog 的格式完全一致，可以直接复用 parseLog。
 *
 * 实测 jm_java（1881 tag + 195 分支 → 1917 个不同提交）耗时 48ms。
 *
 * 注意：返回的是「ref 尖端」，不是全部历史。用户想找某个不在任何 ref 上、
 * 也不在最近 N 条里的提交，应该直接粘贴 sha——那种情况本来也不该靠搜索。
 */
export async function listRefTipCommits(cwd, { maxBytes = 32 * 1024 * 1024 } = {}) {
  const res = await git(cwd, [
    'log', '--all', '--no-walk=unsorted', `--format=${LOG_FMT}`,
  ], { timeout: 30000, maxBytes })
  if (res.code !== 0) return { commits: [], error: res.stderr || 'git log 失败' }

  const commits = parseLog(res.stdout)
  // 按提交时间倒序：--no-walk 的顺序取决于 ref 遍历顺序，对用户没意义
  commits.sort((a, b) => b.time - a.time)
  return { commits, truncated: res.stdout.length >= maxBytes }
}
