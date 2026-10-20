// 验证 fetch 遇到 tag 冲突时的行为（这是用户实际报的问题）
// 在 /tmp 造一对仓库 + 远端重打 tag，走真实接口
import { execFileSync } from 'node:child_process'

const ROOT = '/tmp/wt-tag-test'
const BASE = 'http://127.0.0.1:7801'
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
}
const sh = (cwd, args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')

const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

// ---------- 造场景 ----------
execFileSync('rm', ['-rf', ROOT])
execFileSync('mkdir', ['-p', ROOT])
const remote = `${ROOT}/remote.git`
const work = `${ROOT}/work`
const clone = `${ROOT}/repo`

sh(ROOT, ['init', '-q', '--bare', '-b', 'main', remote])
sh(ROOT, ['clone', '-q', remote, work])
sh(work, ['checkout', '-q', '-B', 'main'])
execFileSync('bash', ['-c', `echo 1 > ${work}/f.txt`])
sh(work, ['add', '.'])
sh(work, ['commit', '-qm', 'c1'])
sh(work, ['tag', '-a', 'v1.0.0', '-m', 'release 1.0.0'])
sh(work, ['push', '-q', 'origin', 'main', '--tags'])

// 克隆出测试仓库（本地持有旧 tag）
sh(ROOT, ['clone', '-q', remote, clone])

// 远端重打 tag + 加新提交
execFileSync('bash', ['-c', `echo 2 >> ${work}/f.txt`])
sh(work, ['add', '.'])
sh(work, ['commit', '-qm', 'c2'])
sh(work, ['tag', '-f', '-a', 'v1.0.0', '-m', 'release 1.0.0 REWRITTEN'])
sh(work, ['push', '-q', 'origin', 'main'])
sh(work, ['push', '-q', '-f', 'origin', 'v1.0.0'])

const localOldSha = sh(clone, ['rev-parse', 'refs/tags/v1.0.0'])
const remoteNewSha = sh(work, ['rev-parse', 'refs/tags/v1.0.0'])
const mainBefore = sh(clone, ['rev-parse', 'origin/main']).slice(0, 8)

console.log(`本地 tag v1.0.0 = ${localOldSha.slice(0, 8)}`)
console.log(`远端 tag v1.0.0 = ${remoteNewSha.slice(0, 8)}`)
console.log(`本地 origin/main（fetch 前）= ${mainBefore}\n`)

const repoId = enc(clone)

// ---------- 1. 默认 fetch：应成功而非失败，并报 tag 冲突 ----------
const r1 = await post(`/api/repos/${repoId}/fetch`, { prune: true })
check('默认 fetch 不再整体失败', r1.status === 200 && r1.body.ok === true, `status=${r1.status} ok=${r1.body.ok}`)
check('识别出 tag 冲突', (r1.body.tagConflicts || []).some((c) => c.tag === 'v1.0.0'),
  JSON.stringify(r1.body.tagConflicts))
check('标记为部分成功', r1.body.partial === true, `partial=${r1.body.partial}`)

// 关键：分支必须真的更新了
const mainAfter = sh(clone, ['rev-parse', 'origin/main']).slice(0, 8)
check('分支确实已更新', mainAfter !== mainBefore, `origin/main ${mainBefore} → ${mainAfter}`)
check('新提交已拉下来', sh(clone, ['cat-file', '-t', sh(work, ['rev-parse', 'HEAD']).slice(0, 8)]) === 'commit',
  '远端最新 commit 本地已存在')

// 本地 tag 应保持不变
const tagAfterDefault = sh(clone, ['rev-parse', 'refs/tags/v1.0.0'])
check('本地 tag 未被覆盖', tagAfterDefault === localOldSha, tagAfterDefault.slice(0, 8))

// ---------- 2. tag-inspect 能给出两个 sha ----------
const info = await post(`/api/repos/${repoId}/tag-inspect`, { tag: 'v1.0.0' })
check('tag-inspect 返回本地 sha', info.body.localSha === localOldSha, info.body.localSha?.slice(0, 8))
check('tag-inspect 返回远端 sha', info.body.remoteSha === remoteNewSha, info.body.remoteSha?.slice(0, 8))
check('tag-inspect 判定不一致', info.body.same === false, `same=${info.body.same}`)

// ---------- 3. forceTags 覆盖 ----------
const r2 = await post(`/api/repos/${repoId}/fetch`, { prune: true, forceTags: true })
check('forceTags fetch 成功', r2.status === 200 && r2.body.ok === true, `status=${r2.status}`)
const tagAfterForce = sh(clone, ['rev-parse', 'refs/tags/v1.0.0'])
check('强制后 tag 指向远端', tagAfterForce === remoteNewSha, tagAfterForce.slice(0, 8))
check('强制后无冲突残留', (r2.body.tagConflicts || []).length === 0, `conflicts=${r2.body.tagConflicts?.length}`)
check('强制后 partial 为 false', r2.body.partial === false, `partial=${r2.body.partial}`)

// ---------- 4. 认证失败仍应判失败 ----------
const fakeRepo = `${ROOT}/badrepo`
sh(ROOT, ['init', '-q', '-b', 'main', fakeRepo])
sh(fakeRepo, ['remote', 'add', 'origin', 'git@127.0.0.1:1/nonexistent.git'])
const r3 = await post(`/api/repos/${enc(fakeRepo)}/fetch`, { prune: true })
check('真实错误仍判失败', r3.status === 409 || r3.body.ok === false,
  `status=${r3.status} ok=${r3.body.ok} authFailed=${r3.body.authFailed}`)
check('真实错误有错误信息', (r3.body.error || '').length > 0, (r3.body.error || '').slice(0, 60).replace(/\n/g, ' '))

// ---------- 5. 无冲突时 partial 应为 false ----------
const r4 = await post(`/api/repos/${repoId}/fetch`, { prune: true, forceTags: true })
check('无冲突时 updated 正常', r4.body.ok && (r4.body.tagConflicts || []).length === 0,
  `partial=${r4.body.partial}`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('\n失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
