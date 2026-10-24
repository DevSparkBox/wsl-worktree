// 语法高亮：语言识别 / token 分类 / 转义安全 / 性能
import { detectLang, highlightLine, highlightLines, createState } from '../../public/highlight.js'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(34)} ${d}`) }

// 把 HTML 还原成纯文本，验证「高亮不改变内容」
const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
// 提取某个 class 的片段
const segs = (h, cls) => [...h.matchAll(new RegExp(`<span class="hl-${cls}">([^<]*)<\\/span>`, 'g'))].map((m) => m[1])

// ============ 1. 语言识别 ============
console.log('===== 语言识别 =====')
check('ts 识别', detectLang('a/b/c.ts') === 'ts', detectLang('a/b/c.ts'))
check('java 识别', detectLang('Foo.java') === 'java', detectLang('Foo.java'))
check('vue 识别', detectLang('x.vue') === 'vue', detectLang('x.vue'))
check('less 识别', detectLang('x.less') === 'less', detectLang('x.less'))
check('md 识别', detectLang('README.md') === 'md', detectLang('README.md'))
check('.gitignore 特殊名', detectLang('.gitignore') === 'properties', detectLang('.gitignore'))
check('Dockerfile 特殊名', detectLang('Dockerfile') === 'dockerfile', detectLang('Dockerfile'))
check('大写扩展名', detectLang('A.JAVA') === 'java', detectLang('A.JAVA'))
check('未知扩展名不高亮', detectLang('x.unknownext') === null, String(detectLang('x.unknownext')))
check('无扩展名不高亮', detectLang('LICENSE') === null, String(detectLang('LICENSE')))
check('png 不高亮', detectLang('a.png') === null, String(detectLang('a.png')))

// ============ 2. token 分类 ============
console.log('\n===== token 分类 =====')
let h = highlightLines('public class Foo {', 'java').join('')
check('类关键字', segs(h, 'decl').includes('class'), segs(h, 'decl').join(','))
check('修饰符', segs(h, 'decl').includes('public'), segs(h, 'decl').join(','))

h = highlightLines('const x = 42;', 'ts').join('')
check('声明关键字', segs(h, 'decl').includes('const'), segs(h, 'decl').join(','))
check('数字高亮', segs(h, 'num').includes('42'), segs(h, 'num').join(','))

h = highlightLines('if (a) return true;', 'js').join('')
check('控制流关键字', segs(h, 'ctrl').includes('if') && segs(h, 'ctrl').includes('return'),
  segs(h, 'ctrl').join(','))
check('布尔字面量', segs(h, 'lit').includes('true'), segs(h, 'lit').join(','))

h = highlightLines('int x = 1; // 注释', 'java').join('')
check('类型关键字', segs(h, 'type').includes('int'), segs(h, 'type').join(','))
check('行注释', segs(h, 'com').some((s) => s.includes('注释')), segs(h, 'com').join('|'))

h = highlightLines('const s = "hello";', 'ts').join('')
check('双引号字符串', segs(h, 'str').some((s) => s.includes('hello')), segs(h, 'str').join('|'))

h = highlightLines("const s = 'hi';", 'ts').join('')
check('单引号字符串', segs(h, 'str').some((s) => s.includes('hi')), segs(h, 'str').join('|'))

h = highlightLines('@Override public void run() {}', 'java').join('')
check('注解高亮', segs(h, 'ann').includes('@Override'), segs(h, 'ann').join(','))

// CSS / LESS
h = highlightLines('.ellipsis { display: none; }', 'less').join('')
check('LESS 选择器', segs(h, 'sel').some((s) => s.includes('ellipsis')), segs(h, 'sel').join(','))
check('LESS 属性名', segs(h, 'prop').includes('display'), segs(h, 'prop').join(','))
h = highlightLines('  color: #fff;', 'less').join('')
check('十六进制颜色当数字而非选择器',
  segs(h, 'num').includes('#fff') && !segs(h, 'sel').includes('#fff'), segs(h, 'num').join(','))
h = highlightLines('@base: 12px;', 'less').join('')
check('LESS 变量', segs(h, 'var').includes('@base'), segs(h, 'var').join(','))
h = highlightLines('#main .cls { }', 'css').join('')
check('id 选择器', segs(h, 'sel').some((s) => s.includes('#main')), segs(h, 'sel').join(','))
check('scss 也走 CSS 规则', (() => {
  const x = highlightLines('.a { color: #eee; }', 'scss').join('')
  return segs(x, 'sel').length > 0 && segs(x, 'prop').length > 0
})(), '')

// Markdown
h = highlightLines('# 标题\n- 项\n**粗**\n`code`', 'md').join('\n')
check('MD 标题', segs(h, 'md-h').some((s) => s.includes('标题')), segs(h, 'md-h').join(','))
check('MD 列表项', segs(h, 'md-li').length > 0, segs(h, 'md-li').join(','))
check('MD 粗体', segs(h, 'md-b').length > 0, '')
check('MD 行内代码', segs(h, 'md-code').length > 0, '')

// SQL / YAML
h = highlightLines("SELECT * FROM t WHERE a = 'x' -- note", 'sql').join('')
check('SQL 注释', segs(h, 'com').some((s) => s.includes('note')), segs(h, 'com').join(','))
h = highlightLines('key: value # c', 'yaml').join('')
check('YAML 注释', segs(h, 'com').some((s) => s.includes('c')), segs(h, 'com').join(','))

// ============ 3. 跨行状态 ============
console.log('\n===== 跨行状态 =====')
const blockLines = highlightLines('/* 第一行\n第二行\n第三行 */\nint x;', 'java')
check('块注释首行', blockLines[0].includes('hl-com'), '')
check('块注释中间行仍高亮', blockLines[1].includes('hl-com'), blockLines[1].slice(0, 40))
check('块注释末行闭合', blockLines[2].includes('hl-com'), '')
check('块注释后恢复正常', !blockLines[3].includes('hl-com') && blockLines[3].includes('hl-type'),
  blockLines[3].slice(0, 50))

const st = createState()
highlightLine('/* 未闭合', 'java', st)
check('未闭合块注释写入状态', st.inBlock === true, String(st.inBlock))
highlightLine('还在注释里 */ code', 'java', st)
check('闭合后状态复位', st.inBlock === false, String(st.inBlock))

// ============ 4. 安全：必须转义 ============
console.log('\n===== 转义安全 =====')
h = highlightLines('const s = "<script>alert(1)</script>";', 'ts').join('')
check('字符串中的标签被转义', !h.includes('<script>'), h.includes('&lt;script&gt;') ? '已转义' : '未转义!')
h = highlightLines('a < b && c > d', 'js').join('')
check('比较符被转义', h.includes('&lt;') && h.includes('&amp;&amp;'), '')
h = highlightLines('<div class="x">', 'html').join('')
check('HTML 标签名高亮', segs(h, 'tag').some((s) => s.includes('div')), segs(h, 'tag').join(','))
check('HTML 属性高亮', segs(h, 'attr').includes('class'), segs(h, 'attr').join(','))

// ============ 5. 内容保真 ============
console.log('\n===== 内容保真 =====')
const samples = [
  ['const a = `tpl ${x}`', 'ts'],
  ['int[] arr = {1,2,3};', 'java'],
  ['SELECT * FROM t WHERE a = "x" -- c', 'sql'],
  ['# Title\n- item\n**bold**', 'md'],
  ['a { color: #fff; }', 'css'],
  ['<a href="x">t</a>', 'xml'],
  ['key: value # comment', 'yaml'],
  ['中文内容 + emoji 🎉 + 特殊符号 ±×÷', 'md'],
  ['tab\there\tand  spaces', 'js'],
]
let allSame = true
for (const [src, lang] of samples) {
  for (const line of src.split('\n')) {
    const got = strip(highlightLine(line, lang, createState()))
    if (got !== line) {
      allSame = false
      console.log(`  内容不一致 [${lang}]: ${JSON.stringify(line)} → ${JSON.stringify(got)}`)
    }
  }
}
check('高亮不改变任何内容', allSame, `${samples.length} 组样本`)

// ============ 6. 边界 ============
console.log('\n===== 边界 =====')
check('空行不崩溃', highlightLine('', 'js', createState()) === '', '')
check('未知语言安全返回', highlightLine('a<b>', 'nolang', createState()) !== undefined, '')
const nur = highlightLine('<>&', null, createState())
check('无语言时也转义', nur === '&lt;&gt;&amp;', nur)
check('只有空白', highlightLine('   ', 'js', createState()) === '   ', '')
check('超长单行不死循环', (() => {
  const t0 = Date.now()
  highlightLine('x'.repeat(20000), 'js', createState())
  return Date.now() - t0 < 3000
})(), '')
check('大量引号不死循环', (() => {
  const t0 = Date.now()
  highlightLine('"'.repeat(500), 'ts', createState())
  return Date.now() - t0 < 3000
})(), '')

// ============ 7. 性能 ============
console.log('\n===== 性能 =====')
const javaSrc = `package com.example;
import java.util.List;
/** 文档注释 */
public class Demo<T> extends Base implements Runnable {
  private static final String NAME = "demo";
  private final List<String> items;
  public Demo(List<String> items) { this.items = items; }
  @Override
  public void run() {
    for (int i = 0; i < items.size(); i++) {
      if (items.get(i) != null && i % 2 == 0) {
        System.out.println("item: " + items.get(i));
      }
    }
  }
}`.repeat(40)   // ~4400 行

const lines = javaSrc.split('\n')
const t0 = Date.now()
highlightLines(javaSrc, 'java')
const ms = Date.now() - t0
console.log(`  ${lines.length} 行 Java: ${ms}ms`)
check('4000+ 行高亮 < 800ms', ms < 800, `${ms}ms`)

// TS 大文件
const tsSrc = `import { ref } from 'vue'
export default defineComponent({
  name: 'X',
  setup() {
    const count = ref<number>(0)
    const inc = () => { count.value++ }
    return { count, inc }
  }
})`.repeat(60)
const t1 = Date.now()
highlightLines(tsSrc, 'ts')
const ms2 = Date.now() - t1
console.log(`  ${tsSrc.split('\n').length} 行 TS: ${ms2}ms`)
check('TS 高亮 < 500ms', ms2 < 500, `${ms2}ms`)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
if (fail.length) { console.log('失败:'); for (const [n, , d] of fail) console.log(`  ${n}: ${d}`) }
process.exit(fail.length ? 1 : 0)
