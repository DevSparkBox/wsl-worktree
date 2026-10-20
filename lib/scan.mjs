import { readdir, stat, readFile } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { homedir } from 'node:os'

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'target',
  'vendor', '.cache', '.next', '.nuxt', '.gradle', '.idea',
])

/**
 * 在 root 下递归找 git 仓库（工作区根，不含 worktree）。
 * 判定标准：目录下存在 .git 目录，或 .git 文件（worktree/submodule）但**不是** worktree。
 */
export async function scanRepos(roots, maxDepth = 4) {
  const found = []
  const seen = new Set()

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }

    // 本目录是否仓库
    const isRepo = await detectRepo(dir)
    if (isRepo) {
      if (!seen.has(isRepo.toplevel)) {
        seen.add(isRepo.toplevel)
        found.push(isRepo)
      }
      return // 不进仓库内部继续扫（避免把 submodule 当独立仓库）
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (SKIP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      await walk(join(dir, entry.name), depth + 1)
    }
  }

  for (const root of roots) {
    const abs = root.startsWith('~') ? join(homedir(), root.slice(1)) : root
    await walk(abs, 1)
  }

  // 排序：按相对路径
  found.sort((a, b) => a.toplevel.localeCompare(b.toplevel))
  return found
}

async function detectRepo(dir) {
  const dotGit = join(dir, '.git')
  let st
  try {
    st = await stat(dotGit)
  } catch {
    return null
  }

  if (st.isDirectory()) {
    return { toplevel: dir, name: basename(dir), bare: false, kind: 'normal' }
  }

  // .git 是文件 —— 可能是 worktree 或 submodule
  try {
    const content = await readFile(dotGit, 'utf8')
    const m = content.match(/^gitdir:\s*(.+)$/m)
    if (!m) return null
    const gitdir = m[1].trim()
    // worktree 的 gitdir 形如 <main>/.git/worktrees/<name>
    if (gitdir.includes('/.git/worktrees/')) return null // 由父仓库的 worktree list 覆盖
    if (gitdir.includes('/.git/modules/')) return null // submodule，不单列
    return { toplevel: dir, name: basename(dir), bare: false, kind: 'linked' }
  } catch {
    return null
  }
}

/** 解析 `worktree list --porcelain -z`
 *  -z 输出是 \0 分隔的 token 流：['worktree /path', 'HEAD sha', 'branch refs/..', '', 'worktree /path2', ...]
 */
export function parseWorktreePorcelainZ(raw) {
  const tokens = raw.split('\0').filter((t) => t.length > 0)
  const list = []
  let cur = null

  for (const token of tokens) {
    if (token.startsWith('worktree ')) {
      if (cur) list.push(cur)
      cur = { path: token.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false }
      continue
    }
    if (!cur) continue

    if (token.startsWith('HEAD ')) cur.head = token.slice(5)
    else if (token.startsWith('branch ')) cur.branch = token.slice(7).replace(/^refs\/heads\//, '')
    else if (token === 'detached') cur.detached = true
    else if (token === 'bare') cur.bare = true
    else if (token === 'prunable') cur.prunable = true
    else if (token.startsWith('prunable ')) { cur.prunable = true; cur.prunableReason = token.slice(9) }
    else if (token === 'locked') cur.locked = true
    else if (token.startsWith('locked ')) { cur.locked = true; cur.lockReason = token.slice(7) }
  }
  if (cur) list.push(cur)

  // 判断主工作树：第一个，且非 bare 时它就是仓库本体
  list.forEach((wt, i) => { wt.isMain = i === 0 })
  return list
}

/** 解析 `status --porcelain=v2 --branch`，返回脏文件数与 ahead/behind */
export function parseStatusV2(raw) {
  const lines = raw.split('\n')
  let dirty = 0
  let ahead = 0
  let behind = 0
  let detached = false
  let branch = null

  for (const line of lines) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      const v = line.slice('# branch.head '.length)
      if (v === '(detached)') detached = true
      else branch = v
    } else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+)\s+-(\d+)/)
      if (m) { ahead = Number(m[1]); behind = Number(m[2]) }
    } else if (line[0] !== '#') {
      dirty++
    }
  }
  return { dirty, ahead, behind, detached, branch }
}

/** 从 worktree 路径推导新 worktree 的同级路径：<parent>/<repo>-<branchSafe> */
export function suggestWorktreePath(repoToplevel, branch) {
  const parent = dirname(repoToplevel)
  const name = basename(repoToplevel)
  const safe = branch.replace(/\//g, '-').replace(/[^\w\u4e00-\u9fa5.-]/g, '-')
  return join(parent, `${name}-${safe}`)
}
