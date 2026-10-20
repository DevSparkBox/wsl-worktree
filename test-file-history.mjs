// 单文件历史接口：改名跟踪 / 当时路径 / 中文路径 / 统计
import { execFileSync } from 'node:child_process'

const ROOT = '/tmp/wt-filehist'
const BASE = 'http://127.0.0.1:7801'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const sh = (cwd, a) => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim()
const enc = (s) => Buffer.from(s, 'utf8').toString('base64url')
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => ({})) } }

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

execFileSync('rm', ['-rf', ROOT]); execFileSync('mkdir', ['-p', ROOT])
const repo = `${ROOT}/repo`
sh(ROOT, ['init', '-q', '-b', 'main', repo])
sh(repo, ['remote', 'add', 'origin', `${ROOT}/x.git`])
const w = (p, c) => { execFileSync('bash', ['-c', `mkdir -p "$(dirname '${repo}/${p}')" && printf '%s' '${c}' > '${repo}/${p}'`]) }

// c1: 建 old/name.txt
w('old/name.txt', 'a\nb\nc\n'); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c1 创建'])
const c1 = sh(repo, ['rev-parse', 'HEAD'])

// c2: 修改
w('old/name.txt', 'a\nB\nc\nd\n'); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c2 修改'])
const c2 = sh(repo, ['rev-parse', 'HEAD'])

// c3: 改名 old/ → new/
execFileSync('bash', ['-c', `cd '${repo}' && mkdir -p new && git mv old/name.txt new/name.txt`])
sh(repo, ['commit', '-qm', 'c3 改名'])
const c3 = sh(repo, ['rev-parse', 'HEAD'])

// c4: 改名后再改
w('new/name.txt', 'a\nB\nc\nd\ne\n'); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c4 再改'])
const c4 = sh(repo, ['rev-parse', 'HEAD'])

// c5: 中文文件
w('中文/说明 文档.txt', '你好\n'); sh(repo, ['add', '.']); sh(repo, ['commit', '-qm', 'c5 中文'])
const c5 = sh(repo, ['rev-parse', 'HEAD'])

const id = enc(repo)
const hp = (path, extra = '') => `/api/repos/${id}/file-history?path=${encodeURIComponent(path)}${extra}`

// ---- 1. 基本历史 ----
const r1 = await get(hp('new/name.txt'))
check('返回 200', r1.status === 200, '')
check('默认跟踪改名', r1.body.follow === true, `follow=${r1.body.follow}`)
check('含改名前的提交（4 条）', r1.body.commits?.length === 4, `${r1.body.commits?.length} 条`)
check('按时间倒序', r1.body.commits?.[0]?.sha === c4, r1.body.commits?.[0]?.sha?.slice(0, 7))
check('最新一条是修改', r1.body.commits?.[0]?.status === 'modified', r1.body.commits?.[0]?.status)
check('最早一条标记新增', r1.body.commits?.[3]?.status === 'added', r1.body.commits?.[3]?.status)

// ---- 2. 改名事件 ----
const ren = r1.body.commits?.find((c) => c.rename)
check('识别出改名事件', Boolean(ren), ren ? ren.sha.slice(0, 7) : '未找到')
check('改名 from/to 正确', ren?.rename?.from === 'old/name.txt' && ren?.rename?.to === 'new/name.txt',
  `${ren?.rename?.from} → ${ren?.rename?.to}`)

// ---- 3. 改名前的提交带旧路径 ----
const before = r1.body.commits?.find((c) => c.sha === c1)
check('改名前的记录用旧路径', before?.pathAtCommit === 'old/name.txt', before?.pathAtCommit)

// ---- 4. 用当时路径取 diff 有内容；用新路径取为空 ----
const d1 = await get(`/api/repos/${id}/file-history-diff?sha=${c2}&path=${encodeURIComponent('old/name.txt')}`)
check('旧路径能取到 diff', (d1.body.patch || '').length > 0, `${(d1.body.patch || '').length} 字节`)
check('diff 含改动内容', /\+B/.test(d1.body.patch || ''), '')

const d2 = await get(`/api/repos/${id}/file-history-diff?sha=${c2}&path=${encodeURIComponent('new/name.txt')}`)
check('新路径取改名前的 diff 为空', (d2.body.patch || '').length === 0, `${(d2.body.patch || '').length} 字节`)

// ---- 5. 统计 ----
const c2rec = r1.body.commits?.find((c) => c.sha === c2)
check('有增删统计', typeof c2rec?.add === 'number' && typeof c2rec?.del === 'number',
  `+${c2rec?.add} −${c2rec?.del}`)
check('c2 统计正确（+2 −1）', c2rec?.add === 2 && c2rec?.del === 1, `+${c2rec?.add} −${c2rec?.del}`)

// ---- 6. 中文 + 空格路径 ----
const r2 = await get(hp('中文/说明 文档.txt'))
check('中文+空格路径可查', r2.status === 200 && r2.body.commits?.length === 1, `${r2.body.commits?.length} 条`)
check('路径未被转义（原样返回）', r2.body.commits?.[0]?.pathAtCommit === '中文/说明 文档.txt',
  r2.body.commits?.[0]?.pathAtCommit)

// ---- 7. 关掉 follow：只剩改名后 ----
const r3 = await get(hp('new/name.txt', '&follow=0'))
check('follow=0 只剩改名后（2 条）', r3.body.commits?.length === 2, `${r3.body.commits?.length} 条`)
check('follow=0 无改名标记', !r3.body.commits?.some((c) => c.rename), '')

// ---- 8. 不存在的文件 ----
const r4 = await get(hp('does/not/exist.txt'))
check('不存在的文件返回空列表', r4.status === 200 && (r4.body.commits || []).length === 0,
  `${r4.body.commits?.length} 条`)

// ---- 9. 缺参数 ----
const r5 = await get(`/api/repos/${id}/file-history`)
check('缺 path 返回 400', r5.status === 400, r5.body.error)

// ---- 10. 非法 worktree ----
const r6 = await get(hp('new/name.txt', '&wt=' + encodeURIComponent('/nope/x')))
check('非法 wt 被拒', r6.status === 400, r6.body.error)

// ---- 11. 文件列表 ----
const r7 = await get(`/api/repos/${id}/files`)
check('files 接口返回文件', r7.body.files?.length >= 2, `${r7.body.files?.length} 个`)
check('文件列表含中文文件', r7.body.files?.includes('中文/说明 文档.txt'), '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
