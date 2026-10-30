// 日志 worktree 选择逻辑：记住的偏好如何映射回当前列表
import { prefOfWorktree, pickWorktree } from '../../public/log-wt.js'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(40)} ${d}`) }

const WTS = [
  { path: '/r/main', branch: 'main', isMain: true, prunable: false },
  { path: '/r/wt-feat', branch: 'feat/x', prunable: false },
  { path: '/r/wt-detached', branch: null, detached: true, prunable: false },
  { path: '/r/wt-gone', branch: 'old', prunable: true },
]

check('偏好记录分支和目录', JSON.stringify(prefOfWorktree(WTS[1])) === JSON.stringify({ branch: 'feat/x', path: '/r/wt-feat' }),
  JSON.stringify(prefOfWorktree(WTS[1])))
check('detached 偏好只记目录', JSON.stringify(prefOfWorktree(WTS[2])) === JSON.stringify({ branch: '', path: '/r/wt-detached' }),
  JSON.stringify(prefOfWorktree(WTS[2])))
check('没有 worktree 时偏好为 null', prefOfWorktree(null) === null)

check('按分支找到', pickWorktree(WTS, { branch: 'feat/x', path: '/r/old-path' })?.path === '/r/wt-feat')
check('分支优先于目录', pickWorktree(WTS, { branch: 'feat/x', path: '/r/main' })?.path === '/r/wt-feat')
check('分支换了目录也能找到', pickWorktree(WTS, { branch: 'main', path: '/r/deleted' })?.path === '/r/main')
check('分支不在时按目录兜底', pickWorktree(WTS, { branch: 'renamed', path: '/r/wt-feat' })?.path === '/r/wt-feat')
check('detached 只能按目录', pickWorktree(WTS, { branch: '', path: '/r/wt-detached' })?.path === '/r/wt-detached')
check('失效 worktree 不选中', pickWorktree(WTS, { branch: 'old', path: '/r/wt-gone' }) === null)
check('偏好为空时返回 null', pickWorktree(WTS, null) === null)
check('偏好完全匹配不上时返回 null', pickWorktree(WTS, { branch: 'nope', path: '/r/nope' }) === null)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
