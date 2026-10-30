// 纯逻辑测试：commit message 的拆分。不依赖 git，秒级。
import { parseCommitMessage } from '../../lib/logfmt.mjs'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const onlySubject = parseCommitMessage('feat: 只改标题\n')
check('只有标题', onlySubject.subject === 'feat: 只改标题' && onlySubject.body === '', JSON.stringify(onlySubject))

const withBody = parseCommitMessage('feat: 标题\x1e第一段\n\n第二段\n')
check('标题与正文分开', withBody.subject === 'feat: 标题', withBody.subject)
check('正文保留空行并去掉结尾换行', withBody.body === '第一段\n\n第二段', JSON.stringify(withBody.body))

const empty = parseCommitMessage('')
check('空输出', empty.subject === '' && empty.body === '', JSON.stringify(empty))

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
