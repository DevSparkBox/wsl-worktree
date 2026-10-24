// 验证「按 worktree 查看日志」
const BASE = process.env.BASE || 'http://127.0.0.1:7801'
const get = async (p) => {
  const res = await fetch(BASE + p)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const repos = (await get('/api/repos')).body.repos
const repo = repos.find((r) => r.name === 'jm_java')
console.log('仓库:', repo.toplevel, ' id=', repo.id)

const wt = (await get(`/api/repos/${repo.id}/worktrees`)).body.worktrees
console.log('\nworktree 列表:')
for (const w of wt) console.log(`  ${w.isMain ? '[主]' : '    '} ${String(w.branch ?? 'detached').padEnd(48)} ${w.head?.slice(0, 8)}  ${w.path}`)

console.log('\n===== 每个 worktree 的 HEAD 日志首条 =====')
const results = []
for (const w of wt) {
  const r = await get(`/api/repos/${repo.id}/log?rev=HEAD&count=3&wt=${encodeURIComponent(w.path)}`)
  const first = r.body.commits?.[0]
  console.log(`\n${w.isMain ? '[主]' : '   '} ${w.branch ?? 'detached'}`)
  console.log(`    cwd=${r.body.cwd}`)
  console.log(`    status=${r.status} 首条=${first ? first.sha.slice(0, 8) + ' ' + first.subject.slice(0, 42) : '(空)'}`)
  if (!first) console.log('    error=', r.body.error)
  results.push({ path: w.path, branch: w.branch, head: w.head, first: first?.sha })
}

console.log('\n===== 一致性检查 =====')
let ok = true
for (const r of results) {
  const match = r.first === r.head
  console.log(`${match ? 'PASS' : 'FAIL'} ${String(r.branch ?? 'detached').padEnd(48)} log首条=${r.first?.slice(0, 8)} worktree.head=${r.head?.slice(0, 8)}`)
  if (!match) ok = false
}

// 各 worktree 的首条应当不同（除非确实指向同一 commit）
const distinct = new Set(results.map((r) => r.first))
console.log(`\n首条 commit 去重后 ${distinct.size} 个 / 共 ${results.length} 个 worktree`)
if (distinct.size === 1) console.log('⚠ 所有 worktree 指向同一 commit，无法证明隔离（属正常，取决于仓库状态）')
else console.log('✓ 不同 worktree 返回不同历史，隔离生效')

console.log('\n===== --all 跨分支视图 =====')
const allMain = await get(`/api/repos/${repo.id}/log?rev=--all&count=5&wt=${encodeURIComponent(wt[0].path)}`)
const allWt2 = await get(`/api/repos/${repo.id}/log?rev=--all&count=5&wt=${encodeURIComponent(wt[1].path)}`)
const same = JSON.stringify(allMain.body.commits.map((c) => c.sha)) === JSON.stringify(allWt2.body.commits.map((c) => c.sha))
console.log(`--all 在两个 worktree 下结果相同: ${same ? 'PASS' : 'FAIL'}（--all 与 cwd 无关，应相同）`)

console.log('\n===== 非法路径必须拒绝 =====')
const bad = await get(`/api/repos/${repo.id}/log?rev=HEAD&count=3&wt=${encodeURIComponent('/etc')}`)
console.log(`wt=/etc → ${bad.status} ${JSON.stringify(bad.body)}`)
console.log(bad.status === 400 ? 'PASS 拒绝' : 'FAIL 未拒绝')

process.exit(ok && bad.status === 400 ? 0 : 1)
