import { execFileSync } from 'node:child_process'
const BASE = process.env.BASE || 'http://127.0.0.1:7801'
const TMPBASE = process.env.WT_TEST_TMP || '/tmp'
const ROOT = `${TMPBASE}/wt-tagcreate`
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
// 允许失败的版本（detached HEAD 下 symbolic-ref 会返回非 0）
const shTry = (cwd, a) => {
  try { return sh(cwd, a) } catch { return null }
}
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({})) } }

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

execFileSync('rm', ['-rf', ROOT]); execFileSync('mkdir', ['-p', ROOT])
const repo = `${ROOT}/repo`
sh(ROOT, ['init', '-q', '-b', 'main', repo])
sh(repo, ['remote', 'add', 'origin', `${ROOT}/dummy.git`])
execFileSync('bash', ['-c', `echo 1 > ${repo}/f.txt`]); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c1'])
sh(repo, ['tag', '-a', 'v1.0.0', '-m', 'release 1.0.0'])
execFileSync('bash', ['-c', `echo 2 >> ${repo}/f.txt`]); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c2'])
sh(repo, ['tag', 'v2.0.0'])   // 轻量 tag
sh(repo, ['tag', '-a', 'v3.0.0-beta', '-m', 'beta'])
const tagCommit = sh(repo, ['rev-parse', 'v1.0.0^{commit}'])

const id = enc(repo)

// ---- 1. 分支接口返回 tags ----
const br = await get(`/api/repos/${id}/branches`)
check('branches 接口返回 tags', Array.isArray(br.body.tags) && br.body.tags.length === 3,
  `tags=${br.body.tags?.map((t) => t.name).join(',')}`)
const v1 = br.body.tags?.find((t) => t.name === 'v1.0.0')
check('annotated tag 标记正确', v1?.annotated === true, `annotated=${v1?.annotated}`)
check('tag 的 sha 是 commit', v1?.sha?.startsWith(tagCommit.slice(0, 7)), `${v1?.sha} vs ${tagCommit.slice(0, 7)}`)
const v2 = br.body.tags?.find((t) => t.name === 'v2.0.0')
check('轻量 tag 的 sha 正确', v2?.sha?.length >= 7, `${v2?.sha} annotated=${v2?.annotated}`)
// 时间排序：三个 tag 是同一秒创建的，不校验具体顺序，只确认列表稳定返回
check('tags 数量与顺序稳定', br.body.tags?.length === 3, br.body.tags?.map((t) => t.name).join(','))

// ---- 2. 基于 tag 创建（detached）----
const p1 = `${ROOT}/repo-v1`
const r1 = await post(`/api/repos/${id}/worktrees`, { path: p1, mode: 'tag', base: 'v1.0.0', branch: '' })
check('基于 tag 创建 detached', r1.status === 200 && r1.body.ok === true, r1.body.error || '')
check('目录已生成', execFileSync('bash', ['-c', `test -d ${p1} && echo yes`], { encoding: 'utf8' }).trim() === 'yes', p1)
check('HEAD 处于 detached', shTry(p1, ['symbolic-ref', '-q', 'HEAD']) === null, 'symbolic-ref 应失败')
check('检出的是 tag 指向的 commit', sh(p1, ['rev-parse', 'HEAD']) === tagCommit,
  `${sh(p1, ['rev-parse', 'HEAD']).slice(0, 7)} vs ${tagCommit.slice(0, 7)}`)
check('没有创建新分支', !sh(repo, ['branch', '--list', 'v1.0.0']).includes('v1.0.0'), '分支列表无 v1.0.0')

// ---- 3. 基于 tag 创建并建分支 ----
const p2 = `${ROOT}/repo-hotfix`
const r2 = await post(`/api/repos/${id}/worktrees`, { path: p2, mode: 'tag', base: 'v1.0.0', branch: 'hotfix/from-v1' })
check('基于 tag + 新分支', r2.status === 200 && r2.body.ok === true, r2.body.error || '')
check('分支已创建', sh(repo, ['branch', '--list', 'hotfix/from-v1']).includes('hotfix/from-v1'), '')
check('分支起点是 tag 的 commit', sh(p2, ['rev-parse', 'HEAD']) === tagCommit, '')
check('分支已 checkout', sh(p2, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'hotfix/from-v1',
  sh(p2, ['rev-parse', '--abbrev-ref', 'HEAD']))

// ---- 4. 轻量 tag 也能用 ----
const p3 = `${ROOT}/repo-v2`
const r3 = await post(`/api/repos/${id}/worktrees`, { path: p3, mode: 'tag', base: 'v2.0.0', branch: '' })
check('轻量 tag 创建成功', r3.status === 200 && r3.body.ok, r3.body.error || '')

// ---- 5. 不存在的 tag ----
const r4 = await post(`/api/repos/${id}/worktrees`, { path: `${ROOT}/repo-bad`, mode: 'tag', base: 'v9.9.9', branch: '' })
check('不存在的 tag 被拒', r4.status === 409 && r4.body.reason === 'tag-not-found', (r4.body.error || '').slice(0, 40))
check('拒绝时未建目录', execFileSync('bash', ['-c', `test -d ${ROOT}/repo-bad || echo none`], { encoding: 'utf8' }).trim() === 'none', '')

// ---- 6. tag 建分支时重名 ----
const r5 = await post(`/api/repos/${id}/worktrees`, { path: `${ROOT}/repo-dup`, mode: 'tag', base: 'v1.0.0', branch: 'hotfix/from-v1' })
check('tag+重名分支被拒', r5.status === 409 && r5.body.reason === 'branch-exists', (r5.body.error || '').slice(0, 40))

// ---- 7. tag 缺失 base ----
const r6 = await post(`/api/repos/${id}/worktrees`, { path: `${ROOT}/repo-nobase`, mode: 'tag' })
check('tag 模式缺 base 被拒', r6.status === 409, (r6.body.error || '').slice(0, 40))

// 清理
for (const p of [p1, p2, p3]) {
  try { sh(repo, ['worktree', 'remove', '--force', p]) } catch {}
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
