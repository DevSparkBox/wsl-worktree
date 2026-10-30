// 日志 worktree 选择的纯逻辑：负责「记住的分支/目录」到「当前 worktree 列表」的映射。
// 分支优先于目录：worktree 目录可以删了重建，分支才是用户想看的那个历史。

/** 生成要存进 localStorage 的偏好；null 表示不记 */
export function prefOfWorktree(wt) {
  if (!wt) return null
  return { branch: wt.branch || '', path: wt.path || '' }
}

/** 按偏好在当前列表里找 worktree；找不到返回 null，由调用方回退到主工作树 */
export function pickWorktree(worktrees, pref) {
  if (!pref || !Array.isArray(worktrees)) return null
  const usable = worktrees.filter((w) => w && !w.prunable)
  if (pref.branch) {
    const byBranch = usable.find((w) => w.branch === pref.branch)
    if (byBranch) return byBranch
  }
  if (pref.path) {
    const byPath = usable.find((w) => w.path === pref.path)
    if (byPath) return byPath
  }
  return null
}
