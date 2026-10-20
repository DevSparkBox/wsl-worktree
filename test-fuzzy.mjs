// 从 app.js 抠出 fuzzyScore 单独验证（快，不用开浏览器）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'public', 'app.js'), 'utf8')
const start = src.indexOf('function fuzzyScore')
const end = src.indexOf('\n}\n', src.indexOf('return Math.max(50, 300')) + 3
const fuzzyScore = new Function(`${src.slice(start, end)}; return fuzzyScore;`)()

// 真实分支名（来自用户仓库）
const branches = [
  'hotfix/h-tag-5.5.10.54-问题修复0723',
  'hotfix/h-tag-5.5.13.10-主项问题修复1016',
  'hotfix/h-tag-5.5.13.10-建模Agents功能移植_1015',
  'tmp/v5.5.10.55-20260810145720',
  'tmp/v5.5.3.46-20260920101502',
  'v5.5.3.46',
  'release/487399-jmpt_java-jmpt_java-R',
  'release/494026-jmpt_java-jmpt_java-R',
  'feature/f-4-5版本转换适配',
  'origin/hotfix/h-tag-5.5.13.11-主项问题修复1020',
]

const rank = (q) => branches
  .map((b) => ({ b, s: fuzzyScore(q, b) }))
  .filter((x) => x.s != null)
  .sort((a, b) => b.s - a.s)

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(30)} ${d}`) }

// ---- 正例 ----
const cases = [
  ['hotfix', (r) => r.length === 4 && r.every((x) => x.b.includes('hotfix')), '前缀命中全部 hotfix'],
  ['h5.5.13', (r) => r.length > 0 && r[0].b.includes('5.5.13') && r[0].b.includes('hotfix'), 'h + 版本号（最常见记法）'],
  ['5.5.13', (r) => r.length >= 3 && r[0].b.includes('5.5.13'), '纯版本号'],
  ['h-tag-5.5.13', (r) => r.length > 0 && r[0].b.includes('h-tag-5.5.13'), '完整片段'],
  ['建模', (r) => r.length === 1 && r[0].b.includes('建模'), '中文'],
  ['1016', (r) => r.length === 1 && r[0].b.endsWith('1016'), '数字尾号'],
  ['tmp', (r) => r.length === 2 && r.every((x) => x.b.startsWith('tmp/')), 'tmp 前缀无噪声'],
  ['rel', (r) => r.length === 2 && r.every((x) => x.b.startsWith('release/')), 'release 缩写'],
  ['v5.5.3', (r) => r.length >= 2 && r[0].b === 'v5.5.3.46', '短版本优先精确'],
  ['f45', (r) => r.length === 1 && r[0].b.includes('feature'), '跨段缩写'],
]

console.log('===== 模糊匹配正例 =====')
for (const [q, test, desc] of cases) {
  const r = rank(q)
  check(q, test(r), `${desc} → ${r.length} 个${r.length ? '，首位 ' + r[0].b.slice(0, 32) : ''}`)
}

// ---- 排序合理性 ----
console.log('\n===== 排序合理性 =====')
{
  const r = rank('v5.5.3')
  check('精确名排在模糊命中前', r[0].b === 'v5.5.3.46', `${r[0].b} > ${r[1]?.b}`)
}
{
  const r = rank('hotfix')
  check('顶层 hotfix 排在 origin/ 前', !r[0].b.startsWith('origin/'), r[0].b.slice(0, 40))
}
{
  const r = rank('5.5.13')
  const top = r.filter((x) => x.b.includes('5.5.13.10'))
  check('同版本多条并列', top.length >= 2, `${top.length} 个 5.5.13.10`)
}

// ---- 负例 ----
console.log('\n===== 负例（不该命中）=====')
for (const q of ['zzzz', 'qqqqq', '不存在的分支', 'tmpzzz']) {
  const r = rank(q)
  check(`${q} 无命中`, r.length === 0, r.length ? `命中 ${r.map((x) => x.b).slice(0, 2)}` : '')
}

// ---- 边界 ----
console.log('\n===== 边界 =====')
check('空查询不崩溃', fuzzyScore('', 'anything') === 0, '')
check('完全相同得最高分', fuzzyScore('v5.5.3.46', 'v5.5.3.46') === 1000, '')
check('超长查询不匹配', fuzzyScore('x'.repeat(200), 'abc') === null, '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
