import { git } from './git.mjs'

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
