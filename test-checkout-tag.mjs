import { execFileSync } from 'node:child_process'

const ROOT = '/tmp/wt-co-tag'
const BASE = 'http://127.0.0.1:7801'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const shTry = (cwd, a) => { try { return sh(cwd, a) } catch { return null } }
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

execFileSync('rm', ['-rf', ROOT]); execFileSync('mkdir', ['-p', ROOT])
const repo = `${ROOT}/repo`
sh(ROOT, ['init', '-q', '-b', 'main', repo])
sh(repo, ['remote', 'add', 'origin', `${ROOT}/x.git`])
execFileSync('bash', ['-c', `echo 1 > ${repo}/f.txt`]); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c1'])
sh(repo, ['tag', '-a', 'v1.0.0', '-m', 'rel 1.0.0'])
execFileSync('bash', ['-c', `echo 2 >> ${repo}/f.txt`]); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c2'])
sh(repo, ['tag', 'v2.0.0'])            // 轻量 tag，指向 c2
execFileSync('bash', ['-c', `echo 3 >> ${repo}/f.txt`]); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c3'])

const c1 = sh(repo, ['rev-parse', 'main~2'])
const c2 = sh(repo, ['rev-parse', 'main~1'])

const wt = `${ROOT}/wt`
sh(repo, ['worktree', 'add', '-q', '--detach', wt, 'main'])
const id = enc(repo)

// ---- 1. 切到 annotated tag ----
const r1 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: 'v1.0.0' })
check('切到 annotated tag', r1.status === 200 && r1.body.ok === true, r1.body.error || '')
check('HEAD 指向 tag 的 commit', sh(wt, ['rev-parse', 'HEAD']) === c1, `${sh(wt, ['rev-parse', 'HEAD']).slice(0, 7)} vs ${c1.slice(0, 7)}`)
check('处于 detached', shTry(wt, ['symbolic-ref', '-q', 'HEAD']) === null, '')

// ---- 2. 切到轻量 tag ----
const r2 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: 'v2.0.0' })
check('切到轻量 tag', r2.status === 200 && r2.body.ok === true, r2.body.error || '')
check('轻量 tag 指向正确', sh(wt, ['rev-parse', 'HEAD']) === c2, `${sh(wt, ['rev-parse', 'HEAD']).slice(0, 7)} vs ${c2.slice(0, 7)}`)

// ---- 3. 切到不存在的 tag ----
const r3 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: 'v9.9.9' })
check('不存在的引用被拒', r3.status === 409 && r3.body.reason === 'ref-not-found', r3.body.reason || r3.body.error)
check('拒绝时给出可读提示', /找不到|更新仓库/.test(r3.body.error || ''), (r3.body.error || '').slice(0, 46))
check('拒绝时 HEAD 未变', sh(wt, ['rev-parse', 'HEAD']) === c2, '')

// ---- 4. tag 与分支同名：必须切到 tag，而不是分支 ----
sh(repo, ['branch', 'same-name', c1])
sh(repo, ['tag', 'same-name', c2])
const r4 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: 'same-name' })
check('同名时成功', r4.status === 200 && r4.body.ok === true, r4.body.error || '')
check('同名时优先 tag（c2 而非 c1）', sh(wt, ['rev-parse', 'HEAD']) === c2,
  `HEAD=${sh(wt, ['rev-parse', 'HEAD']).slice(0, 7)} 期望 ${c2.slice(0, 7)}(tag) 而非 ${c1.slice(0, 7)}(branch)`)
check('同名时仍是 detached', shTry(wt, ['symbolic-ref', '-q', 'HEAD']) === null, '')

// ---- 5. 切到 sha ----
const r5 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: c1.slice(0, 8) })
check('切到 commit sha', r5.status === 200 && r5.body.ok === true, r5.body.error || '')
check('sha 指向正确', sh(wt, ['rev-parse', 'HEAD']) === c1, '')

// ---- 6. 切回分支仍正常 ----
// 注意：main 被主工作树占用，不能切；建一个空闲分支来验证普通分支路径
sh(repo, ['branch', 'idle-branch', c1])
const r6 = await post(`/api/repos/${id}/checkout`, { wt, branch: 'idle-branch' })
check('切到普通分支仍正常', r6.status === 200 && r6.body.ok === true && r6.body.branch === 'idle-branch',
  `branch=${r6.body.branch}`)
check('切回后是 attached', sh(wt, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'idle-branch', '')

// 占用分支应被拒（回归：不能因为加了 tag 支持而破坏占用检查）
const r6b = await post(`/api/repos/${id}/checkout`, { wt, branch: 'main' })
check('被占用的 main 仍被拒', r6b.status === 409 && r6b.body.reason === 'branch-in-use', r6b.body.reason || '')

// ---- 7. tag 名带斜杠 ----
sh(repo, ['tag', '-a', 'release/1.0', '-m', 'x'])
const r7 = await post(`/api/repos/${id}/checkout`, { wt, detachAt: 'release/1.0' })
check('带斜杠的 tag 名可用', r7.status === 200 && r7.body.ok === true, r7.body.error || '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
