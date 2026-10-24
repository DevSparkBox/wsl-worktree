// 克隆仓库：进度解析 + 接口 + 端到端
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { parseProgressLine, splitProgressChunk } from './lib/clone.mjs'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(40)} ${d}`) }

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (args, cwd) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const API = process.env.BASE || 'http://localhost:7801'

// ---------- 1. 进度解析（纯逻辑）----------
console.log('===== 进度解析 =====')
const p1 = parseProgressLine('Receiving objects:  45% (1200/2666), 3.2 MiB | 1.1 MiB/s')
check('解析接收数据', p1?.phase === '接收数据' && p1?.percent === 45, JSON.stringify(p1))
check('解析速率', /MiB/.test(p1?.rate || ''), p1?.rate)

const p2 = parseProgressLine('Resolving deltas: 100% (800/800), done.')
check('解析到最后阶段', p2?.phase === '解析差异' && p2?.percent === 100, JSON.stringify(p2))

check('非进度行返回 null', parseProgressLine('Cloning into \'/x\'...') === null, '')
check('空行返回 null', parseProgressLine('') === null, '')
check('百分比不超 100', parseProgressLine('Receiving objects: 120%')?.percent === 100, '')

const [lines1, rest1] = splitProgressChunk('a\rb\nc')
check('按 \\r 和 \\n 切分', JSON.stringify(lines1) === JSON.stringify(['a', 'b']), JSON.stringify(lines1))
check('不完整的尾段留作残留', rest1 === 'c', rest1)
const [lines2, rest2] = splitProgressChunk('a\r\nb\r')
check('末段为空时残留为空', lines2.length >= 2 && rest2 === '', `${JSON.stringify(lines2)} rest=${JSON.stringify(rest2)}`)

// ---------- 2. 接口校验 ----------
console.log('\n===== 接口校验 =====')
const post = async (body) => {
  const r = await fetch(`${API}/api/clone`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}

const cfg = await (await fetch(`${API}/api/config`)).json()
const ROOT = (cfg.roots || [])[0]
if (!ROOT) { console.log('FAIL  没有扫描根'); process.exit(1) }

let r = await post({ dir: `${ROOT}/x` })
check('缺 url 返回 400', r.status === 400, r.body.error)

r = await post({ url: '/tmp/x', dir: 'relative/path' })
check('相对路径返回 400', r.status === 400, r.body.error)

r = await post({ url: '/tmp/x', dir: '/tmp/__outside' })
check('扫描根之外返回 400', r.status === 400, r.body.error)

// ---------- 3. 端到端 ----------
console.log('\n===== 端到端 =====')
const TS = Date.now()
const TMPBASE = process.env.WT_TEST_TMP || '/tmp'
const SRC = `${TMPBASE}/__clone_src_${TS}`
const DST = `${ROOT}/__clone_dst_${TS}`

let ok = true
try {
  // 造一个极小的源仓库：只要有一个提交，clone 能成功即可
  rmSync(SRC, { recursive: true, force: true })
  mkdirSync(SRC, { recursive: true })
  git(['init', '-q'], SRC)
  git(['commit', '--allow-empty', '-q', '-m', 'init'], SRC)

  r = await post({ url: SRC, dir: DST })
  check('启动克隆返回 202 和 jobId', r.status === 202 && Boolean(r.body.id), `${r.status} ${r.body.id || r.body.error}`)

  let job = null
  const t0 = Date.now()
  for (let i = 0; i < 200; i++) {
    await sleep(200)
    job = await (await fetch(`${API}/api/clone/${r.body.id}`)).json()
    if (job.status !== 'running') break
  }
  check('克隆完成', job?.status === 'done', `${job?.status} ${job?.error || ''} (${Date.now() - t0}ms)`)
  check('进度到 100%', job?.percent === 100, `${job?.percent}%`)
  check('目标目录已生成', existsSync(`${DST}/.git`), DST.split('/').pop())

  const repos = await (await fetch(`${API}/api/repos`)).json()
  check('新仓库出现在列表（扫描缓存已失效）',
    Boolean((repos.repos || []).find((x) => x.toplevel === DST)), '')

  // 同一个目标再来一次 → 409
  const dup = await post({ url: SRC, dir: DST })
  check('目标已存在返回 409', dup.status === 409, dup.body.error)
} catch (e) {
  ok = false
  check('端到端流程未抛异常', false, e.message)
} finally {
  // 无论成败都清干净：测试产物不能留在用户仓库目录里
  rmSync(DST, { recursive: true, force: true })
  rmSync(SRC, { recursive: true, force: true })
  check('测试产物已清理', !existsSync(DST), '')
  const after = await (await fetch(`${API}/api/repos?force=1`)).json()
  check('清理后不在仓库列表', !(after.repos || []).find((x) => x.toplevel === DST), '')
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length || !ok ? 1 : 0)
