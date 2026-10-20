import { stat, readdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { git } from './git.mjs'

/**
 * 写操作层。
 *
 * 设计原则：
 * 1. 所有写操作先做只读预检（preflight），把风险讲清楚再执行；
 * 2. 一律返回 { ok, action, ... } 结构，错误分类给前端做提示文案；
 * 3. 不自动加 --force。要强删必须由调用方显式传 force:true。
 */

// ---------- 通用 ----------

async function pathExists(p) {
  try { await stat(p); return true } catch { return false }
}

async function dirFileCount(p) {
  try {
    const entries = await readdir(p)
    return entries.length
  } catch { return -1 }
}

/** 该分支当前被哪个 worktree 占用 */
async function branchOwner(toplevel, branch) {
  const res = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (res.code !== 0) return null
  const tokens = res.stdout.split('\0').filter(Boolean)
  let cur = null
  for (const t of tokens) {
    if (t.startsWith('worktree ')) cur = { path: t.slice(9), branch: null }
    else if (t.startsWith('branch ') && cur) {
      cur.branch = t.slice(7).replace(/^refs\/heads\//, '')
      if (cur.branch === branch) return cur
    }
  }
  return null
}

/** 某 worktree 的 HEAD 上有多少「不在其它任何 ref 里」的 commit（未被任何分支/tag/远程覆盖） */
async function uniqueCommits(toplevel, wtPath, excludeBranch) {
  const refsRes = await git(toplevel, [
    'for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags',
  ])
  if (refsRes.code !== 0) return { count: 0, list: [] }
  const refs = refsRes.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((r) => !excludeBranch || r !== `refs/heads/${excludeBranch}`)

  if (refs.length === 0) return { count: 0, list: [] }

  const res = await git(wtPath, [
    'log', 'HEAD', '--not', ...refs,
    '--format=%h%x1f%s', '-n', '50',
  ])
  if (res.code !== 0) return { count: 0, list: [] }
  const list = res.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, subject] = line.split('\x1f')
    return { sha, subject }
  })
  return { count: list.length, list }
}

// ---------- 1. 更新仓库（fetch） ----------

/**
 * 更新仓库（fetch）。
 *
 * 特别注意 tag 冲突：
 *   `git fetch --tags` 遇到同名 tag 指向不同 commit 时会
 *     ! [rejected] vX -> vX (would clobber existing tag)
 *   并让整个命令退出码变成 1 —— 但**分支其实已经更新成功了**。
 *   如果直接把 exit 1 当失败，用户会以为什么都没拉下来（这是最初的 bug）。
 *
 *   处理策略：
 *   - 把 tag 冲突单独识别出来，不当成失败
 *   - 默认不覆盖本地 tag（tag 被重打通常意味着发布流程出了问题，
 *     静默覆盖会让本地历史和远端悄悄分叉）；要在选项里显式勾选 forceTags 才覆盖
 *   - 返回 tagConflicts 列表，UI 明确告知「分支已更新，只有这些 tag 没动」
 */
async function fetchRepo(toplevel, { prune = true, forceTags = false, onProgress } = {}) {
  const args = ['fetch', '--all', '--tags', '--progress']
  if (prune) args.push('--prune')
  // --force 让 tag 也被强制更新（等价于 git fetch -f --tags）
  if (forceTags) args.push('--force')

  const res = await git(toplevel, args, { timeout: 180000, onStderr: onProgress })
  const stderr = res.stderr || ''
  const stdout = res.stdout || ''

  // 从 git 输出里提取 tag 冲突（stderr 的 rejected 行）
  const tagConflicts = []
  for (const line of stderr.split('\n')) {
    // 形如： ! [rejected]        v5.5.12.9  -> v5.5.12.9  (would clobber existing tag)
    const m = line.match(/!\s+\[rejected\]\s+(\S+)\s+->\s+(\S+)\s+\((would clobber existing tag|already exists)\)/)
    if (m) tagConflicts.push({ tag: m[2] || m[1], reason: m[3] })
  }

  const authFailed = /Authentication failed|Permission denied|could not read Username|Permission denied \(publickey/i.test(stderr)
  // 除了 tag 冲突之外还有别的错误行吗？
  const otherErrors = stderr
    .split('\n')
    .map((s) => s.trim())
    .filter((l) => /^(error|fatal):/i.test(l))

  const lines = stderr.split('\n').map((s) => s.trim()).filter(Boolean)
  const updated = lines.filter((l) => /->|\[new |\[tag /.test(l) && !/rejected/.test(l))

  // 分支/引用层面的真实失败
  const hardFail = res.code !== 0 && otherErrors.length > 0
  if (hardFail || (res.code !== 0 && tagConflicts.length === 0)) {
    return {
      ok: false,
      action: 'fetch',
      error: (stderr || `git exit ${res.code}`).slice(-4000),
      authFailed,
      tagConflicts,
    }
  }

  // 走到这里：要么完全成功，要么只有 tag 冲突（分支已更新）
  return {
    ok: true,
    action: 'fetch',
    // 有 tag 冲突时不算完全干净
    partial: tagConflicts.length > 0 && !forceTags,
    updated,
    tagConflicts,
    forceTags,
    raw: stderr.slice(-4000),
  }
}

/**
 * 单独查一个 tag 在本地和远端分别指向哪个 commit，用于冲突时给用户判断依据。
 */
async function inspectTag(toplevel, tag) {
  const local = await git(toplevel, ['rev-parse', `refs/tags/${tag}`])
  const remote = await git(toplevel, ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { timeout: 60000 })
  const localSha = local.code === 0 ? local.stdout.trim() : null
  // ls-remote 输出形如 "90e03c0b...\trefs/tags/v5.5.12.9"
  const remoteSha = remote.code === 0 && remote.stdout.trim() ? remote.stdout.trim().split(/\s+/)[0] : null
  return { tag, localSha, remoteSha, same: Boolean(localSha && remoteSha && localSha === remoteSha) }
}

// ---------- 2. 更新分支（pull） ----------

/**
 * @param mode 'ff-only' | 'rebase' | 'merge'
 * ff-only 最安全；分叉时会失败并提示改用 rebase
 */
async function pullBranch(wtPath, { mode = 'ff-only', onProgress } = {}) {
  // 先确认有 upstream
  const up = await git(wtPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (up.code !== 0) {
    return { ok: false, action: 'pull', reason: 'no-upstream', error: '当前分支没有设置上游分支，无法 pull' }
  }
  const upstream = up.stdout.trim()

  const args = ['pull', '--progress']
  if (mode === 'ff-only') args.push('--ff-only')
  else if (mode === 'rebase') args.push('--rebase', '--no-autostash')
  else args.push('--no-rebase', '--no-edit')

  const res = await git(wtPath, args, { timeout: 180000, onStderr: onProgress })
  if (res.code !== 0) {
    const diverged = /Not possible to fast-forward|diverging branches/i.test(res.stderr)
    const conflict = /CONFLICT|Automatic merge failed|needs merge/i.test(res.stderr + res.stdout)
    return {
      ok: false,
      action: 'pull',
      reason: conflict ? 'conflict' : diverged ? 'diverged' : 'failed',
      upstream,
      error: (res.stderr || res.stdout).slice(-3000),
    }
  }
  return { ok: true, action: 'pull', mode, upstream, output: (res.stdout + res.stderr).slice(-2000) }
}

// ---------- 3. 切换分支（checkout） ----------

/**
 * 在指定 worktree 内切分支。
 * - 支持本地分支、远程分支（自动建 tracking）、detached（传 commit）
 * - 分支被别的 worktree 占用时明确拒绝
 */
async function checkoutBranch(wtPath, { branch, detachAt, create, startPoint } = {}) {
  if (!branch && !detachAt) return { ok: false, action: 'checkout', error: 'branch 或 detachAt 必填' }

  // 前置：该分支是否被其它 worktree 占用
  const repoTop = (await git(wtPath, ['rev-parse', '--show-toplevel'])).stdout.trim() || wtPath
  const commonDir = (await git(wtPath, ['rev-parse', '--git-common-dir'])).stdout.trim()
  const repoRoot = commonDir ? dirname(commonDir.startsWith('/') ? commonDir : join(wtPath, commonDir)) : repoTop

  if (branch) {
    const owner = await branchOwner(repoRoot, branch)
    if (owner && owner.path.replace(/\/+$/, '') !== wtPath.replace(/\/+$/, '')) {
      return {
        ok: false,
        action: 'checkout',
        reason: 'branch-in-use',
        error: `分支 ${branch} 已被 worktree 占用：${owner.path}`,
        ownerPath: owner.path,
      }
    }
  }

  let args
  if (detachAt) {
    // detachAt 可能是 tag / 分支名 / sha。
    // tag 必须用完整引用 refs/tags/<name>：否则遇到「本地分支与 tag 同名」时，
    // git 的消歧顺序会把我们带到分支上（refs/tags 优先于 refs/heads，
    // 但一旦有歧义 git 可能直接报错，行为不稳定）。显式写全引用最可靠。
    const asTag = await git(wtPath, ['rev-parse', '--verify', '--quiet', `refs/tags/${detachAt}`])
    if (asTag.code === 0) {
      args = ['checkout', '--detach', `refs/tags/${detachAt}`]
    } else {
      // 不是 tag：确认这个引用确实存在，否则给明确报错而不是转述 git 的模糊提示
      const exists = await git(wtPath, ['rev-parse', '--verify', '--quiet', detachAt])
      if (exists.code !== 0) {
        const branchHit = await git(wtPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${detachAt}`])
        if (branchHit.code !== 0) {
          return {
            ok: false,
            action: 'checkout',
            reason: 'ref-not-found',
            error: `找不到 tag / 分支 / 提交：${detachAt}（如果 tag 在远端新建，先点「更新仓库」）`,
          }
        }
      }
      args = ['checkout', '--detach', detachAt]
    }
  } else if (create) {
    args = ['checkout', '-b', branch, ...(startPoint ? [startPoint] : [])]
  } else {
    // 远程分支要建成 tracking 分支，而不是 detached
    // 判定：传进来的是 refs/remotes 里的引用（如 origin/feat1）
    const isRemote = (await git(wtPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/${branch}`])).code === 0
    if (isRemote) {
      const short = branch.replace(/^[^/]+\//, '')
      const localExists = (await git(wtPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${short}`])).code === 0
      if (localExists) {
        // 本地已有同名分支：直接切本地，避免 -b 冲突
        args = ['checkout', short]
      } else {
        args = ['checkout', '-b', short, '--track', branch]
      }
    } else {
      args = ['checkout', branch]
    }
  }

  const res = await git(wtPath, args, { timeout: 120000 })
  if (res.code !== 0) {
    const dirty = /would be overwritten|Please commit your changes or stash/i.test(res.stderr)
    return {
      ok: false,
      action: 'checkout',
      reason: dirty ? 'dirty-conflict' : 'failed',
      error: (res.stderr || res.stdout).slice(-2000),
    }
  }
  const head = await git(wtPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const up = await git(wtPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return {
    ok: true,
    action: 'checkout',
    branch: head.stdout.trim(),
    upstream: up.code === 0 ? up.stdout.trim() : null,
    output: (res.stdout + res.stderr).slice(-1000),
  }
}

// ---------- 4. 创建 worktree ----------

async function createWorktree(toplevel, { path, branch, mode = 'existing', base, lock = false, lockReason = '' }) {
  if (!path) return { ok: false, action: 'create', error: '目标路径必填' }
  if (!path.startsWith('/')) return { ok: false, action: 'create', error: '目标路径必须是绝对路径' }

  // 防呆：不要在仓库内部创建
  const repoAbs = toplevel.replace(/\/+$/, '')
  if (path.startsWith(repoAbs + '/')) {
    return { ok: false, action: 'create', error: '不能在仓库目录内部创建 worktree' }
  }

  if (await pathExists(path)) {
    const n = await dirFileCount(path)
    return { ok: false, action: 'create', reason: 'path-exists', error: `目标路径已存在${n > 0 ? `（含 ${n} 项内容）` : '（空目录）'}` }
  }

  const args = ['worktree', 'add']
  if (mode === 'existing') {
    if (!branch) return { ok: false, action: 'create', error: 'mode=existing 需要 branch' }
    const owner = await branchOwner(toplevel, branch)
    if (owner) {
      return { ok: false, action: 'create', reason: 'branch-in-use', error: `分支 ${branch} 已被占用：${owner.path}` }
    }
    args.push(path, branch)
  } else if (mode === 'new') {
    if (!branch) return { ok: false, action: 'create', error: 'mode=new 需要 branch' }
    // 同名分支已存在则拒绝，避免 -b 报错信息不友好
    const exists = await git(toplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (exists.code === 0) {
      return { ok: false, action: 'create', reason: 'branch-exists', error: `本地分支 ${branch} 已存在，请改用「现有分支」` }
    }
    args.push('-b', branch, path, base || 'HEAD')
  } else if (mode === 'remote') {
    if (!branch) return { ok: false, action: 'create', error: 'mode=remote 需要 branch' }
    args.push('--track', '-b', branch.replace(/^origin\//, ''), path, branch)
  } else if (mode === 'tag') {
    // 基于 tag 创建：
    //   默认 detached —— 直接检出 tag 指向的 commit，不建分支（看历史/复现问题最常用）
    //   若给了 branch，则从 tag 新建一个分支再检出（要在 tag 基础上改代码时用）
    if (!base) return { ok: false, action: 'create', error: 'mode=tag 需要 base（tag 名）' }
    const tagRef = `refs/tags/${base}`
    const tagExists = await git(toplevel, ['rev-parse', '--verify', '--quiet', tagRef])
    if (tagExists.code !== 0) {
      return { ok: false, action: 'create', reason: 'tag-not-found', error: `本地没有 tag：${base}（可能需要先更新仓库）` }
    }
    if (branch) {
      // 从 tag 建分支
      const exists = await git(toplevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      if (exists.code === 0) {
        return { ok: false, action: 'create', reason: 'branch-exists', error: `本地分支 ${branch} 已存在` }
      }
      const owner = await branchOwner(toplevel, branch)
      if (owner) {
        return { ok: false, action: 'create', reason: 'branch-in-use', error: `分支 ${branch} 已被占用：${owner.path}` }
      }
      args.push('-b', branch, path, tagRef)
    } else {
      args.push('--detach', path, tagRef)
    }
  } else if (mode === 'detach') {
    args.push('--detach', path, base || 'HEAD')
  } else {
    return { ok: false, action: 'create', error: `未知 mode: ${mode}` }
  }

  const res = await git(toplevel, args, { timeout: 120000 })
  if (res.code !== 0) {
    return { ok: false, action: 'create', error: (res.stderr || res.stdout).slice(-3000) }
  }

  if (lock) {
    const lr = ['worktree', 'lock', path]
    if (lockReason) lr.push('--reason', lockReason)
    await git(toplevel, lr)
  }

  return { ok: true, action: 'create', path, output: (res.stdout + res.stderr).slice(-1000) }
}

// ---------- 5. 删除 worktree ----------

/**
 * 预检：返回删除会丢失什么。
 * 不改动任何东西，只读。
 */
async function preflightRemove(toplevel, wtPath) {
  const clean = wtPath.replace(/\/+$/, '')
  const listRes = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (listRes.code !== 0) return { ok: false, error: listRes.stderr }

  const tokens = listRes.stdout.split('\0').filter(Boolean)
  let target = null
  let cur = null
  const all = []
  for (const t of tokens) {
    if (t.startsWith('worktree ')) {
      cur = { path: t.slice(9), branch: null, detached: false, locked: false, prunable: false, isMain: all.length === 0 }
      all.push(cur)
    } else if (cur) {
      if (t.startsWith('branch ')) cur.branch = t.slice(7).replace(/^refs\/heads\//, '')
      else if (t === 'detached') cur.detached = true
      else if (t === 'locked' || t.startsWith('locked ')) cur.locked = true
      else if (t === 'prunable' || t.startsWith('prunable ')) cur.prunable = true
    }
  }
  target = all.find((w) => w.path.replace(/\/+$/, '') === clean)
  if (!target) return { ok: false, error: 'worktree 不存在' }
  if (target.isMain) return { ok: false, reason: 'is-main', error: '主工作树不能删除（那是仓库本身）' }

  const result = {
    ok: true,
    path: target.path,
    branch: target.branch,
    detached: target.detached,
    locked: target.locked,
    prunable: target.prunable,
    exists: await pathExists(target.path),
    dirtyFiles: [],
    dirtyCount: 0,
    unique: { count: 0, list: [] },
  }

  if (result.exists && !target.prunable) {
    const st = await git(target.path, ['status', '--porcelain=v2'])
    if (st.code === 0) {
      result.dirtyFiles = st.stdout.split('\n').filter((l) => l && !l.startsWith('#')).slice(0, 100)
      result.dirtyCount = st.stdout.split('\n').filter((l) => l && !l.startsWith('#')).length
    }
    // 未被任何其他 ref 覆盖的 commit
    result.unique = await uniqueCommits(toplevel, target.path, target.branch)
  }

  // 风险等级：影响前端确认强度
  if (result.unique.count > 0) result.risk = 'has-unpushed'
  else if (result.dirtyCount > 0) result.risk = 'has-dirty'
  else if (result.locked) result.risk = 'locked'
  else result.risk = 'clean'

  return result
}

async function removeWorktree(toplevel, wtPath, { force = false } = {}) {
  const pre = await preflightRemove(toplevel, wtPath)
  if (!pre.ok) return { ok: false, action: 'remove', ...pre }

  // 锁定的必须先 unlock（git 的行为，提前给出清晰提示）
  if (pre.locked && !force) {
    return { ok: false, action: 'remove', reason: 'locked', error: '该 worktree 已锁定，请先解锁', pre }
  }

  // 有未推送 commit 时，即使 force 也不删 —— 这是数据丢失，不做
  if (pre.unique.count > 0) {
    return {
      ok: false,
      action: 'remove',
      reason: 'has-unpushed',
      error: `该 worktree 的 HEAD 有 ${pre.unique.count} 个提交不在任何分支/远程/tag 上，删除后无法找回`,
      pre,
    }
  }

  // 有未提交改动时必须显式 force
  if (pre.dirtyCount > 0 && !force) {
    return {
      ok: false,
      action: 'remove',
      reason: 'needs-force',
      error: `有 ${pre.dirtyCount} 个未提交改动，需要确认强制删除`,
      pre,
    }
  }

  const args = ['worktree', 'remove']
  if (pre.dirtyCount > 0 || force) args.push('--force')
  if (pre.locked) args.push('--force', '--force') // 锁定需双 force
  args.push(pre.path)

  const res = await git(toplevel, args, { timeout: 60000 })
  if (res.code !== 0) {
    return { ok: false, action: 'remove', error: (res.stderr || res.stdout).slice(-2000), pre }
  }
  return { ok: true, action: 'remove', path: pre.path, branch: pre.branch, dirtyCount: pre.dirtyCount, output: (res.stderr || res.stdout).slice(-800) }
}

// ---------- 6. 批量清理陈旧 worktree ----------

/**
 * 陈旧 worktree 扫描。
 *
 * 判定口径（重要）：
 *   「可安全删除」只看两件事 —— 工作区干净 + HEAD 上没有不被任何 ref 覆盖的 commit。
 *   这两个条件都满足时，删掉 worktree 不丢任何东西（分支还在、提交还在），
 *   与它「多久没动」无关。
 *
 *   时间（idleDays）只用于**排序和标记**，不作为过滤条件。
 *   原因：worktree 里的文件 mtime 在 clone/worktree add 时就是"现在"，
 *   拿 mtime 当活跃度会把所有新建 worktree 都判成活跃，等于这个维度失效。
 *   真正有意义的活跃度是「这个分支上次提交是什么时候」，即 HEAD commit 时间。
 *
 *   所以这里返回全部候选，前端按 idleDays 倒序，超过 staleDays 的标为「建议清理」。
 */
async function findStaleWorktrees(toplevel, { staleDays = 7 } = {}) {
  const raw = await getWtRaw(toplevel)
  if (!raw) return { ok: false, error: '无法读取 worktree 列表' }

  const nowSec = Math.floor(Date.now() / 1000)
  const cutoff = nowSec - staleDays * 86400
  const candidates = []
  const skipped = []

  for (const wt of raw) {
    if (wt.isMain) continue
    const item = {
      path: wt.path,
      branch: wt.branch,
      detached: wt.detached,
      locked: wt.locked,
      prunable: wt.prunable,
      head: wt.head,
      reasons: [],
    }

    if (wt.locked) { skipped.push({ ...item, skip: 'locked', skipText: '已锁定' }); continue }

    if (wt.prunable) {
      item.reasons.push('prunable')
      item.idleDays = null
      item.suggest = true
      item.headTime = null
      candidates.push(item)
      continue
    }

    if (!(await pathExists(wt.path))) {
      skipped.push({ ...item, skip: 'missing', skipText: '目录不存在（可 prune）' })
      continue
    }

    const st = await git(wt.path, ['status', '--porcelain=v2'], { timeout: 25000 })
    const dirtyCount = st.code === 0 ? st.stdout.split('\n').filter((l) => l && !l.startsWith('#')).length : -1
    if (dirtyCount !== 0) {
      skipped.push({
        ...item,
        skip: dirtyCount > 0 ? 'dirty' : 'status-error',
        skipText: dirtyCount > 0 ? `有 ${dirtyCount} 个未提交改动` : '状态读取失败',
        dirtyCount,
      })
      continue
    }

    const uniq = await uniqueCommits(toplevel, wt.path, wt.branch)
    if (uniq.count > 0) {
      skipped.push({
        ...item,
        skip: 'has-unpushed',
        skipText: `${uniq.count} 个提交未被任何分支/远程覆盖`,
        uniqueCount: uniq.count,
        uniqueList: uniq.list.slice(0, 5),
      })
      continue
    }

    // 分支最后提交时间 = 真实活跃度
    const headTime = await headCommitTime(wt.path)
    item.headTime = headTime
    item.idleDays = headTime ? Math.floor((nowSec - headTime) / 86400) : null
    item.reasons.push('clean+covered')
    item.suggest = headTime ? headTime < cutoff : false
    candidates.push(item)
  }

  // 最久没动的排前面
  candidates.sort((a, b) => {
    if (a.prunable && !b.prunable) return -1
    if (b.prunable && !a.prunable) return 1
    return (a.headTime ?? 0) - (b.headTime ?? 0)
  })

  return {
    ok: true,
    staleDays,
    candidates,
    skipped,
    suggestedCount: candidates.filter((c) => c.suggest).length,
  }
}

async function headCommitTime(wtPath) {
  const res = await git(wtPath, ['log', '-1', '--format=%ct', 'HEAD'], { timeout: 15000 })
  if (res.code !== 0) return null
  const ts = Number(res.stdout.trim())
  return ts > 0 ? ts : null
}

async function getWtRaw(toplevel) {
  const listRes = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (listRes.code !== 0) return null
  const tokens = listRes.stdout.split('\0').filter(Boolean)
  const all = []
  let cur = null
  for (const t of tokens) {
    if (t.startsWith('worktree ')) {
      cur = { path: t.slice(9), head: null, branch: null, detached: false, locked: false, prunable: false, isMain: all.length === 0 }
      all.push(cur)
    } else if (cur) {
      if (t.startsWith('HEAD ')) cur.head = t.slice(5)
      else if (t.startsWith('branch ')) cur.branch = t.slice(7).replace(/^refs\/heads\//, '')
      else if (t === 'detached') cur.detached = true
      else if (t === 'locked' || t.startsWith('locked ')) cur.locked = true
      else if (t === 'prunable' || t.startsWith('prunable ')) cur.prunable = true
    }
  }
  return all
}

async function cleanStale(toplevel, { paths = [], staleDays = 7, dryRun = false } = {}) {
  const scan = await findStaleWorktrees(toplevel, { staleDays })
  if (!scan.ok) return scan

  // 只允许操作 scan 认定的候选，防止前端传任意路径
  const allowed = new Map(scan.candidates.map((c) => [c.path, c]))
  const targets = paths.length ? paths.filter((p) => allowed.has(p)) : scan.candidates.map((c) => c.path)
  const rejected = paths.filter((p) => !allowed.has(p))

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      wouldRemove: targets.map((p) => {
        const c = allowed.get(p)
        return { path: p, branch: c.branch, idleDays: c.idleDays, prunable: c.prunable }
      }),
      rejected,
      candidates: scan.candidates,
    }
  }

  const removed = []
  const failed = []
  for (const p of targets) {
    const c = allowed.get(p)
    // prunable 的目录已不存在，直接 prune 即可
    if (c.prunable) {
      const pr = await git(toplevel, ['worktree', 'prune', '-v'])
      if (pr.code === 0) removed.push({ path: p, branch: c.branch, reasons: c.reasons })
      else failed.push({ path: p, error: (pr.stderr || pr.stdout).slice(-400) })
      continue
    }
    const res = await git(toplevel, ['worktree', 'remove', '--force', p], { timeout: 60000 })
    if (res.code === 0) removed.push({ path: p, branch: c.branch, idleDays: c.idleDays, reasons: c.reasons })
    else failed.push({ path: p, error: (res.stderr || res.stdout).slice(-500) })
  }
  // 收尾再 prune 一次，清掉可能新产生的失效记录
  await git(toplevel, ['worktree', 'prune', '-v'])
  return { ok: failed.length === 0, removed, failed, rejected }
}

// ---------- 7. 分支列表（给切换/创建对话框用） ----------

async function listBranches(toplevel) {
  // 注意：不能用 %(refname:short) —— 当分支名本身形如 "heads/xxx" 时，
  // short 会输出 "heads/xxx"，与去掉前缀后的结果无法区分，还会产生 "heads/" 和 "origin/" 这种伪分支。
  // 也不能用 %1f —— 旧版 git 不认这个格式符，会原样输出。用 %00 最稳。
  const res = await git(toplevel, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(upstream)%00%(HEAD)',
    'refs/heads', 'refs/remotes',
  ], { timeout: 20000 })
  if (res.code !== 0) return { local: [], remote: [], error: res.stderr }

  const owners = new Map()
  const wtRaw = await getWtRaw(toplevel)
  for (const w of wtRaw || []) if (w.branch) owners.set(w.branch, w.path)

  const local = []
  const remote = []
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    // %(HEAD) 为空时 git 会输出 "\0 " （NUL 后跟空格），所以每段都要 trim
    const parts = line.split('\0').map((s) => s.trim())
    const [full, sha, ts, upstream, isHead] = parts
    if (!full) continue

    let name
    let kind
    if (full.startsWith('refs/heads/')) {
      name = full.slice('refs/heads/'.length)
      kind = 'local'
    } else if (full.startsWith('refs/remotes/')) {
      name = full.slice('refs/remotes/'.length)
      kind = 'remote'
      if (name.endsWith('/HEAD')) continue  // origin/HEAD 这类符号引用跳过
    } else {
      continue
    }
    if (!name) continue

    const item = {
      name,
      kind,
      sha,
      time: Number(ts) * 1000,
      upstream: upstream ? upstream.replace(/^refs\/remotes\//, '') : null,
      isHead: isHead === '*',
      owner: owners.get(name) || null,
    }
    if (kind === 'local') local.push(item)
    else remote.push(item)
  }
  local.sort((a, b) => b.time - a.time)
  remote.sort((a, b) => b.time - a.time)

  // tag 也要一起返回：创建 worktree 时可以基于 tag 检出
  return { local, remote, tags: await listTags(toplevel) }
}

/**
 * 列出 tag。用于「基于 tag 创建 worktree」和自动完成。
 * 轻量 tag 的 objectname 直接指向 commit；annotated tag 指向 tag 对象，
 * 用 %(*objectname) 拿它剥离后的 commit（轻量 tag 时为空，回退到 objectname）。
 */
async function listTags(toplevel) {
  const res = await git(toplevel, [
    'for-each-ref',
    '--format=%(refname)%00%(objectname:short)%00%(*objectname:short)%00%(creatordate:unix)',
    'refs/tags',
  ], { timeout: 20000 })
  if (res.code !== 0) return []

  const tags = []
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    const [full, objSha, peeledSha, ts] = line.split('\0').map((s) => s.trim())
    if (!full || !full.startsWith('refs/tags/')) continue
    const name = full.slice('refs/tags/'.length)
    if (!name) continue
    tags.push({
      name,
      kind: 'tag',
      sha: peeledSha || objSha,       // 指向的 commit
      annotated: Boolean(peeledSha),   // 有 peeled 就是 annotated tag
      time: Number(ts) * 1000,
    })
  }
  tags.sort((a, b) => b.time - a.time)
  return tags
}

export {
  fetchRepo,
  inspectTag,
  pullBranch,
  checkoutBranch,
  createWorktree,
  preflightRemove,
  removeWorktree,
  findStaleWorktrees,
  cleanStale,
  listBranches,
  listTags,
  branchOwner,
  pathExists,
}
