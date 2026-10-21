// 提交信息里的 URL 链接化
import { linkify, extractUrls, escHtml } from './public/linkify.js'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const links = (html) => [...html.matchAll(/<a class="ext-link" href="([^"]*)"[^>]*>(.*?)<\/a>/g)]
  .map((m) => ({ href: m[1], text: m[2] }))

// ---------- 基本 ----------
console.log('===== 基本 =====')
let h = linkify('见 https://www.tapd.cn/48824355/s/10440851')
let L = links(h)
check('生成一个链接', L.length === 1, `${L.length} 个`)
check('href 正确', L[0]?.href === 'https://www.tapd.cn/48824355/s/10440851', L[0]?.href)
check('链接文字是 URL 本身', L[0]?.text === 'https://www.tapd.cn/48824355/s/10440851', L[0]?.text)
check('带 target=_blank', /target="_blank"/.test(h), '')
check('带 rel=noopener', /rel="noopener noreferrer"/.test(h), '')
check('前面的文本保留', h.startsWith('见 '), h.slice(0, 8))

// ---------- 多个链接 ----------
console.log('\n===== 多个链接 =====')
h = linkify('两个 https://a.cn/x 和 https://b.cn/y，都看下')
L = links(h)
check('识别两个链接', L.length === 2, `${L.length} 个`)
check('中间文本保留', / 和 /.test(h), '')
check('后面的中文标点保留', h.endsWith('，都看下'), h.slice(-8))

// ---------- 中文标点边界 ----------
console.log('\n===== 中文标点 =====')
h = linkify('详见 https://x.cn/p。')
check('中文句号不入链接', links(h)[0]?.href === 'https://x.cn/p', links(h)[0]?.href)
check('中文句号留在文本里', h.endsWith('。'), '')
h = linkify('（见 https://x.cn/q）')
check('全角括号不入链接', links(h)[0]?.href === 'https://x.cn/q', links(h)[0]?.href)
h = linkify('链接：https://x.cn/r；后面还有字')
check('中文分号不入链接', links(h)[0]?.href === 'https://x.cn/r', links(h)[0]?.href)

// ---------- 尾部标点剥离 ----------
console.log('\n===== 尾部标点 =====')
h = linkify('结尾 https://x.cn/p.')
check('尾部句号剥离', links(h)[0]?.href === 'https://x.cn/p', links(h)[0]?.href)
check('句号留在外面', h.endsWith('.'), '')
h = linkify('括号包裹 (https://x.cn/q)')
check('尾部右括号剥离', links(h)[0]?.href === 'https://x.cn/q', links(h)[0]?.href)

// ---------- 安全 ----------
console.log('\n===== 安全 =====')
h = linkify('javascript:alert(1)')
check('javascript: 不生成链接', links(h).length === 0, h)
h = linkify('data:text/html,<script>x</script>')
check('data: 不生成链接', links(h).length === 0, '')
h = linkify('ftp://x.cn/f')
check('ftp 不生成链接', links(h).length === 0, '')
h = linkify('文本 <img src=x onerror=alert(1)> https://x.cn/a')
check('HTML 标签被转义', !h.includes('<img'), h.includes('&lt;img') ? '已转义' : '未转义!')
check('转义后仍有链接', links(h).length === 1, '')
h = linkify('引号 " https://x.cn/a?x="y" ')
check('引号不进 URL', !links(h)[0]?.href.includes('"'), links(h)[0]?.href)

// ---------- 转义 ----------
console.log('\n===== 转义 =====')
check('escHtml 处理 & < >', escHtml('a<b>&c') === 'a&lt;b&gt;&amp;c', escHtml('a<b>&c'))
h = linkify('https://x.cn/a?b=1&c=2')
check('URL 里的 & 被转义', h.includes('&amp;c=2'), '')
check('但 href 可用（浏览器会解回 &）', links(h)[0]?.href === 'https://x.cn/a?b=1&amp;c=2', links(h)[0]?.href)

// ---------- 无链接 / 空 ----------
console.log('\n===== 边界 =====')
check('无链接原样返回', linkify('正常文本') === '正常文本', linkify('正常文本'))
check('空串返回空', linkify('') === '', '')
check('null 返回空', linkify(null) === '', '')
check('undefined 返回空', linkify(undefined) === '', '')
check('纯 URL 无其他内容', links(linkify('https://x.cn')).length === 1, '')
check('http 也支持', links(linkify('http://x.cn/a')).length === 1, '')

// ---------- 真实提交信息 ----------
console.log('\n===== 真实样例 =====')
const real = '--bug=1381322 --user=余享 售楼管理-机会管理-客户分配页面loaddata请求2条数据较慢花了23秒 https://www.tapd.cn/48824355/s/10440851'
h = linkify(real)
check('真实 TAPD 链接可点', links(h).length === 1 && links(h)[0].href.includes('tapd.cn'), '')
check('前面中文保留完整', h.includes('花了23秒'), '')
check('内容总体不变（去标签后一致）', h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&') === real, '')

// ---------- extractUrls ----------
console.log('\n===== extractUrls =====')
const urls = extractUrls('a https://x.cn/1 b https://y.cn/2. c')
check('提取两个 URL', urls.length === 2, JSON.stringify(urls))
check('不提尾部标点', urls[1] === 'https://y.cn/2', urls[1])
check('空文本返回空数组', extractUrls('').length === 0, '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
