// 未提交更改的三个数据源（必须在 WSL 里跑：用 /tmp 造临时仓库）
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { getWorktreeChanges } from '../../lib/changes.mjs'
import { listWorktreeFiles, readWorktreeFile } from '../../lib/tree.mjs'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(40)} ${d}`) }

const TMPBASE = process.env.WT_TEST_TMP || '/tmp'
const TMP = `${TMPBASE}/__pending_${Date.now()}`
const sh = (cmd, cwd) => {
  try {
    return execFileSync('bash', ['-lc', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (e) {
    return String(e.stderr || e.message || '').trim()
  }
}

try {
  // ---------- 造一个有改动的仓库 ----------
  sh(`rm -rf "${TMP}" && mkdir -p "${TMP}"`)
  sh(`git init -q && git config user.email t@t && git config user.name t`, TMP)
  sh(`printf 'line1\\nline2\\n' > tracked.txt && git add . && git commit -q -m init`, TMP)
  // 改已跟踪文件 + 加未跟踪文件 + 删一个文件
  sh(`printf 'line1\\nline2\\nline3\\n' > tracked.txt`, TMP)
  sh(`printf 'brand new\\n' > untracked.txt`, TMP)
  sh(`mkdir -p sub && printf 'x\\ny\\n' > sub/another.txt`, TMP)

  console.log('===== 变更清单 =====')
  const ch = await getWorktreeChanges(TMP)
  const byPath = Object.fromEntries((ch.files || []).map((f) => [f.path, f]))
  check('识别已跟踪文件的改动', byPath['tracked.txt']?.add === 1 && byPath['tracked.txt']?.del === 0,
    JSON.stringify(byPath['tracked.txt']))
  check('未跟踪文件进清单并标 A', byPath['untracked.txt']?.status === 'A', JSON.stringify(byPath['untracked.txt']))
  check('子目录里的新文件也能识别', byPath['sub/another.txt']?.status === 'A', '')
  check('untracked 计数正确', ch.untracked === 2, String(ch.untracked))
  check('noHead 为 false', ch.noHead === false, '')

  // 删除已跟踪文件
  sh(`rm tracked-abandoned.txt 2>/dev/null; printf 'tmp\\n' > gone.txt && git add gone.txt && git commit -q -m add-gone && rm gone.txt`, TMP)
  const ch2 = await getWorktreeChanges(TMP)
  const gone = (ch2.files || []).find((f) => f.path === 'gone.txt')
  check('删除的文件也在清单里（显示为删除行）', Boolean(gone) && gone.del > 0, JSON.stringify(gone))

  console.log('\n===== 工作区文件树 =====')
  const tree = await listWorktreeFiles(TMP)
  const paths = (tree.files || []).map((f) => f.path)
  check('树里含未跟踪文件', paths.includes('untracked.txt') && paths.includes('sub/another.txt'), `${paths.length} 个文件`)
  check('未跟踪文件标 status=A',
    tree.files.find((f) => f.path === 'untracked.txt')?.status === 'A', '')
  check('已删除的文件不进树', !paths.includes('gone.txt'), paths.includes('gone.txt') ? '仍存在' : '已剔除')
  check('已跟踪文件仍在树里', paths.includes('tracked.txt'), '')

  console.log('\n===== 读文件内容 =====')
  const r1 = await readWorktreeFile(TMP, 'tracked.txt')
  check('读改过的工作区内容（不是 HEAD 版本）', /line3/.test(r1.content || ''), (r1.content || '').trim().split('\n').length + ' 行')

  const r2 = await readWorktreeFile(TMP, '../../etc/passwd')
  check('路径穿越被拒', r2.notFound === true && /越界/.test(r2.error || ''), r2.error)

  const r3 = await readWorktreeFile(TMP, '/etc/passwd')
  check('绝对路径穿越被拒', r3.notFound === true, r3.error)

  const r4 = await readWorktreeFile(TMP, 'nope.txt')
  check('不存在的文件返回 notFound', r4.notFound === true, r4.error)

  sh(`printf '\\x00\\x01binary' > bin.dat`, TMP)
  const r5 = await readWorktreeFile(TMP, 'bin.dat')
  check('二进制文件被识别', r5.binary === true, String(r5.size))

  // ---------- 空仓库（没有 HEAD）----------
  console.log('\n===== 空仓库边界 =====')
  const EMPTY = `${TMP}-empty`
  sh(`rm -rf "${EMPTY}" && mkdir -p "${EMPTY}"`)
  sh(`git init -q && printf 'a\\n' > one.txt && printf 'b\\n' > two.txt`, EMPTY)
  const ce = await getWorktreeChanges(EMPTY)
  check('空仓库 noHead 标记', ce.noHead === true, '')
  check('空仓库把所有文件算新增', ce.files.length === 2 && ce.files.every((f) => f.status === 'A'),
    ce.files.map((f) => f.path).join(','))
  const te = await listWorktreeFiles(EMPTY)
  check('空仓库也能列出文件树', te.files.length === 2, `${te.files.length} 个`)
  sh(`rm -rf "${EMPTY}"`)
} finally {
  rmSync(TMP, { recursive: true, force: true })
  check('临时目录已清理', !sh(`test -d "${TMP}" && echo yes || echo no`).includes('yes'), '')
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
