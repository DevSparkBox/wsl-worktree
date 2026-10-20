// 在临时仓库里验证全部写操作（不碰真实仓库）
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/tmp/wt-ops-test'
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
}
const sh = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const BASE = 'http://127.0.0.1:7801'

const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const get = async (p) => {
  const res = await fetch(BASE + p)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')

// ---------- 准备 ----------
rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
const upstreamBare = join(ROOT, 'upstream.git')
const repo = join(ROOT, 'repo')

// 造一个带上游的裸库
sh(ROOT, ['init', '-q', '--bare', '-b', 'main', upstreamBare])
sh(ROOT, ['clone', '-q', upstreamBare, repo])
writeFileSync(join(repo, 'a.txt'), 'a\n')
sh(repo, ['add', '.'])
sh(repo, ['commit', '-qm', 'root'])
sh(repo, ['push', '-qu', 'origin', 'main'])
sh(ROOT, ['clone', '-q', upstreamBare, join(ROOT, 'peer')])  // 用来往上游推新提交

const repoId = enc(repo)
console.log('测试仓库:', repo)

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${detail}`)
}

// ---------- 1. 更新仓库 fetch ----------
{
  const peer = join(ROOT, 'peer')
  writeFileSync(join(peer, 'b.txt'), 'b\n')
  sh(peer, ['add', '.']); sh(peer, ['commit', '-qm', 'peer commit']); sh(peer, ['push', '-q'])

  const r = await post(`/api/repos/${repoId}/fetch`, { prune: true })
  check('fetch 成功', r.status === 200 && r.body.ok, `updated=${JSON.stringify(r.body.updated)}`)
}

// ---------- 2. 更新分支 pull ----------
{
  const r = await post(`/api/repos/${repoId}/pull`, { wt: repo, mode: 'ff-only' })
  check('pull --ff-only 快进', r.status === 200 && r.body.ok, `${r.body.upstream}`)
  const n = sh(repo, ['rev-list', '--count', 'HEAD'])
  check('pull 后提交数增加', Number(n) === 2, `count=${n}`)

  // 无 upstream 的分支
  sh(repo, ['checkout', '-q', '-b', 'no-up'])
  const r2 = await post(`/api/repos/${repoId}/pull`, { wt: repo, mode: 'ff-only' })
  check('无 upstream 被识别', r2.status === 409 && r2.body.reason === 'no-upstream', r2.body.error)
  sh(repo, ['checkout', '-q', 'main'])
  sh(repo, ['branch', '-q', '-D', 'no-up'])
}

// ---------- 3. 切换分支 ----------
{
  sh(repo, ['branch', 'feat-switch'])
  const r = await post(`/api/repos/${repoId}/checkout`, { wt: repo, branch: 'feat-switch' })
  check('checkout 本地分支', r.status === 200 && r.body.ok, `now on ${r.body.branch}`)

  // 远程分支
  const r2 = await post(`/api/repos/${repoId}/checkout`, { wt: repo, branch: 'origin/main' })
  check('checkout 远程分支', r2.status === 200 && r2.body.ok, r2.body.branch || r2.body.error)

  // 切回 main
  await post(`/api/repos/${repoId}/checkout`, { wt: repo, branch: 'main' })

  // 不存在的分支
  const r3 = await post(`/api/repos/${repoId}/checkout`, { wt: repo, branch: 'nope-xxx' })
  check('不存在的分支被拒', r3.status === 409 && !r3.body.ok, (r3.body.error || '').slice(0, 50))
}

// ---------- 4. 创建 worktree ----------
const wtPath = join(ROOT, 'repo-feat-new')
{
  // 分支被占用
  const busy = await post(`/api/repos/${repoId}/worktrees`, { path: join(ROOT, 'x'), branch: 'main', mode: 'existing' })
  check('占用分支被拒', busy.status === 409 && busy.body.reason === 'branch-in-use', (busy.body.error || '').slice(0, 42))

  // 正常创建
  const r = await post(`/api/repos/${repoId}/worktrees`, { path: wtPath, branch: 'feat-new', mode: 'new', base: 'main' })
  check('创建新分支 worktree', r.status === 200 && r.body.ok && existsSync(wtPath), wtPath)

  // 路径已存在
  const dup = await post(`/api/repos/${repoId}/worktrees`, { path: wtPath, branch: 'feat-dup', mode: 'new' })
  check('路径已存在被拒', dup.status === 409 && dup.body.reason === 'path-exists', (dup.body.error || '').slice(0, 40))

  // 仓库内部路径
  const inner = await post(`/api/repos/${repoId}/worktrees`, { path: join(repo, 'nested'), branch: 'feat-in', mode: 'new' })
  check('仓库内路径被拒', inner.status === 409 && !inner.body.ok, (inner.body.error || '').slice(0, 40))

  // 相对路径
  const rel = await post(`/api/repos/${repoId}/worktrees`, { path: 'relative/x', branch: 'feat-rel', mode: 'new' })
  check('相对路径被拒', rel.status === 409, (rel.body.error || '').slice(0, 30))
}

// ---------- 5. 删除 worktree 预检与执行 ----------
{
  // 干净 worktree
  const pre = await post(`/api/repos/${repoId}/worktree-preflight`, { path: wtPath })
  check('预检 clean', pre.body.ok && pre.body.risk === 'clean', `risk=${pre.body.risk} dirty=${pre.body.dirtyCount} unique=${pre.body.unique?.count}`)

  // 造未提交改动
  writeFileSync(join(wtPath, 'dirty.txt'), 'x\n')
  const pre2 = await post(`/api/repos/${repoId}/worktree-preflight`, { path: wtPath })
  check('预检 has-dirty', pre2.body.risk === 'has-dirty', `dirty=${pre2.body.dirtyCount}`)

  // 无 force 应拒绝
  const noForce = await post(`/api/repos/${repoId}/worktree-remove`, { path: wtPath })
  check('脏 worktree 需 force', noForce.status === 409 && noForce.body.reason === 'needs-force', (noForce.body.error || '').slice(0, 40))

  // 造未推送 commit
  sh(wtPath, ['add', '.']); sh(wtPath, ['commit', '-qm', 'unpushed work'])
  const pre3 = await post(`/api/repos/${repoId}/worktree-preflight`, { path: wtPath })
  check('预检 has-unpushed', pre3.body.risk === 'has-unpushed', `unique=${pre3.body.unique?.count}`)

  // 有未推送 commit 时即使 force 也拒绝
  const guarded = await post(`/api/repos/${repoId}/worktree-remove`, { path: wtPath, force: true })
  check('未推送 commit 硬拦', guarded.status === 409 && guarded.body.reason === 'has-unpushed', (guarded.body.error || '').slice(0, 46))
  check('硬拦后目录仍在', existsSync(wtPath), wtPath)

  // 提交到分支后应可删（commit 已被 ref 覆盖）
  sh(wtPath, ['push', '-q', '-u', 'origin', 'feat-new'])
  const pre4 = await post(`/api/repos/${repoId}/worktree-preflight`, { path: wtPath })
  check('推送后预检 clean', pre4.body.risk === 'clean', `risk=${pre4.body.risk}`)

  const del = await post(`/api/repos/${repoId}/worktree-remove`, { path: wtPath, force: true })
  check('删除成功', del.status === 200 && del.body.ok && !existsSync(wtPath), del.body.error || '')
  check('删除后分支保留', sh(repo, ['branch', '--list', 'feat-new']).includes('feat-new'), '分支未丢')

  // 主工作树不可删
  const mainDel = await post(`/api/repos/${repoId}/worktree-preflight`, { path: repo })
  check('主工作树不可删', !mainDel.body.ok && mainDel.body.reason === 'is-main', mainDel.body.error)
}

// ---------- 6. 批量清理陈旧 worktree ----------
{
  // 造 3 个可清理 + 1 个不该清理（脏）
  for (const n of ['stale1', 'stale2', 'stale3']) {
    const p = join(ROOT, `repo-${n}`)
    sh(repo, ['worktree', 'add', '-q', '-b', n, p, 'main'])
    // 用一个 40 天前的空提交，让「陈旧」判定生效（--allow-empty 必须，否则会被判空提交）
    const old = String(Math.floor(Date.now() / 1000) - 40 * 86400)
    execFileSync('git', ['commit', '--allow-empty', '-qm', `old ${n}`, `--date=${old}`], {
      cwd: p,
      env: { ...GIT_ENV, GIT_COMMITTER_DATE: old },
      encoding: 'utf8',
    })
    sh(p, ['push', '-q', '-u', 'origin', n])
  }
  const dirtyPath = join(ROOT, 'repo-keepme')
  sh(repo, ['worktree', 'add', '-q', '-b', 'keepme', dirtyPath, 'main'])
  writeFileSync(join(dirtyPath, 'wip.txt'), 'wip\n')

  // 造一个 prunable
  const prunablePath = join(ROOT, 'repo-gone')
  sh(repo, ['worktree', 'add', '-q', '-b', 'gone', prunablePath, 'main'])
  rmSync(prunablePath, { recursive: true, force: true })

  const scan = await post(`/api/repos/${repoId}/stale-scan`, { staleDays: 7 })
  const cands = (scan.body.candidates || []).map((c) => c.path.split('/').pop())
  const skips = (scan.body.skipped || []).map((s) => `${s.path.split('/').pop()}:${s.skip}`)
  const suggests = (scan.body.candidates || []).filter((c) => c.suggest).map((c) => c.path.split('/').pop())
  check('陈旧扫描有候选', cands.length > 0, `候选=${JSON.stringify(cands)}`)
  check('prunable 进候选', cands.includes('repo-gone'), '目录已删的残留被识别')
  check('脏 worktree 被排除', skips.some((s) => s.startsWith('repo-keepme:dirty')), JSON.stringify(skips))
  check('干净且已推送的进候选', ['repo-stale1', 'repo-stale2', 'repo-stale3'].every((n) => cands.includes(n)), JSON.stringify(cands))
  check('超期被标建议清理', suggests.includes('repo-stale1') && suggests.includes('repo-stale2'), `suggest=${JSON.stringify(suggests)}`)
  check('idleDays 已计算', (scan.body.candidates || []).every((c) => c.prunable || c.idleDays >= 0), 
    (scan.body.candidates || []).map((c) => `${c.branch}:${c.idleDays}d${c.suggest ? '*' : ''}`).join(' '))

  const dry = await post(`/api/repos/${repoId}/stale-clean`, { staleDays: 7, dryRun: true })
  check('dryRun 不实际删除', dry.body.ok && dry.body.dryRun && existsSync(join(ROOT, 'repo-stale1')), `将删 ${dry.body.wouldRemove?.length} 个`)

  const clean = await post(`/api/repos/${repoId}/stale-clean`, { staleDays: 7 })
  check('批量清理执行', clean.body.removed?.length >= 3, `removed=${clean.body.removed?.length} failed=${clean.body.failed?.length}`)
  check('清理后 stale1 消失', !existsSync(join(ROOT, 'repo-stale1')), '')
  check('keepme 未被误删', existsSync(dirtyPath), '脏 worktree 保住')

  const list = sh(repo, ['worktree', 'list'])
  check('keepme 仍在列表', list.includes('repo-keepme'), list.split('\n').length + ' 个 worktree')
}

// ---------- 7. 分支列表 ----------
{
  const r = await get(`/api/repos/${repoId}/branches`)
  check('分支列表有本地', r.body.local?.length > 0, `local=${r.body.local?.length} remote=${r.body.remote?.length}`)
  const withOwner = (r.body.local || []).filter((b) => b.owner)
  check('分支带 worktree 占用标记', withOwner.length > 0, withOwner.map((b) => `${b.name}@${b.owner.split('/').pop()}`).join(', '))
}

// ---------- 汇总 ----------
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) {
  console.log('\n失败项:')
  for (const [n, , d] of fail) console.log(`  ${n}: ${d}`)
}
process.exit(fail.length ? 1 : 0)
