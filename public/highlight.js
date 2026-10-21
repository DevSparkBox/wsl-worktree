/**
 * 轻量语法高亮（零依赖，~300 行）。
 *
 * 为什么不引 highlight.js / Prism：
 *   - 本项目零框架、零构建，加一个几百 KB 的库只为一个只读视图不值
 *   - 只需要「按 token 上色」，不需要完整的语法树
 *   - 自己写还能精确控制哪些语言、只覆盖实际用到的
 *
 * 性能设计（这是关键）：
 *   1) 所有规则用 **sticky 正则**（/y），配合 lastIndex 在任意位置精确匹配，
 *      不需要把整行切成子串再测。
 *   2) 最后有一条「兜底规则」一次吃掉一大段无趣字符（空白、标点），
 *      所以主循环次数 ≈ token 数，而不是字符数。逐字符回退会慢一个数量级。
 *   3) 按行处理 + 跨行状态对象（块注释、字符串未闭合），
 *      这样上层渲染的行号天然对齐。
 *
 * 安全：输出 HTML 前对每个片段做转义，不信任文件内容。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ESC[c])

// ============================================================
// 语言定义
// ============================================================

/** 控制流关键字 —— 用主色（accent） */
const KW_CONTROL = [
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
  'return', 'try', 'catch', 'finally', 'throw', 'throws', 'yield', 'await', 'goto',
]

/** 声明/类型关键字 —— 用紫色 */
const KW_DECL = [
  'class', 'interface', 'enum', 'record', 'extends', 'implements', 'new', 'delete',
  'function', 'func', 'fn', 'def', 'const', 'let', 'var', 'val',
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'volatile', 'transient', 'native', 'sealed', 'async', 'export', 'import', 'from',
  'package', 'using', 'namespace', 'module', 'declare', 'type', 'typedef',
  'this', 'self', 'super', 'extends',
]

/** 基本类型 —— 用青色 */
const KW_TYPE = [
  'void', 'boolean', 'byte', 'char', 'double', 'float', 'int', 'long', 'short',
  'string', 'String', 'bool', 'number', 'any', 'unknown', 'never', 'object',
]

/** 字面量 —— 用橙色 */
const KW_LIT = ['true', 'false', 'null', 'undefined', 'nil', 'None', 'True', 'False']

const SET_CONTROL = new Set(KW_CONTROL)
const SET_DECL = new Set(KW_DECL)
const SET_TYPE = new Set(KW_TYPE)
const SET_LIT = new Set(KW_LIT)

/**
 * 各语言配置。
 *   lineComment：单行注释前缀
 *   blockComment：是否有 /* *\/ 块注释
 *   hashComment：是否有 # 注释（.env / yaml / sh）
 *   strings：引号种类
 */
const LANGS = {
  js: { line: '//', block: true, quotes: ['"', "'", '`'], template: true },
  ts: { line: '//', block: true, quotes: ['"', "'", '`'], template: true },
  jsx: { line: '//', block: true, quotes: ['"', "'", '`'], template: true },
  tsx: { line: '//', block: true, quotes: ['"', "'", '`'], template: true },
  java: { line: '//', block: true, quotes: ['"', "'"], annotation: true },
  cs: { line: '//', block: true, quotes: ['"', "'"], annotation: true },
  c: { line: '//', block: true, quotes: ['"', "'"] },
  cpp: { line: '//', block: true, quotes: ['"', "'"] },
  h: { line: '//', block: true, quotes: ['"', "'"] },
  go: { line: '//', block: true, quotes: ['"', '`'] },
  swift: { line: '//', block: true, quotes: ['"'] },
  kt: { line: '//', block: true, quotes: ['"', "'"] },
  scala: { line: '//', block: true, quotes: ['"', "'"] },
  php: { line: '//', block: true, quotes: ['"', "'"], hashComment: true },
  rs: { line: '//', block: true, quotes: ['"'] },
  json: { line: null, block: false, quotes: ['"'], json: true },
  css: { line: null, block: true, quotes: ['"', "'"], css: true },
  // less/scss/sass 是 CSS 方言，选择器/属性/LESS 变量的规则一样适用
  less: { line: '//', block: true, quotes: ['"', "'"], css: true },
  scss: { line: '//', block: true, quotes: ['"', "'"], css: true },
  sass: { line: '//', block: false, quotes: ['"', "'"], css: true },
  yaml: { line: null, block: false, quotes: ['"', "'"], hashComment: true, yaml: true },
  yml: { line: null, block: false, quotes: ['"', "'"], hashComment: true, yaml: true },
  toml: { line: null, block: false, quotes: ['"', "'"], hashComment: true },
  ini: { line: null, block: false, quotes: ['"'], hashComment: true },
  sh: { line: null, block: false, quotes: ['"', "'"], hashComment: true, shell: true },
  bash: { line: null, block: false, quotes: ['"', "'"], hashComment: true, shell: true },
  zsh: { line: null, block: false, quotes: ['"', "'"], hashComment: true, shell: true },
  py: { line: null, block: false, quotes: ['"', "'"], hashComment: true, python: true },
  rb: { line: null, block: false, quotes: ['"', "'"], hashComment: true },
  sql: { line: '--', block: true, quotes: ["'", '"'], sql: true },
  xml: { line: null, block: true, quotes: ['"', "'"], markup: true },
  html: { line: null, block: true, quotes: ['"', "'"], markup: true },
  vue: { line: '//', block: true, quotes: ['"', "'", '`'], template: true, markup: true },
  md: { line: null, block: false, quotes: [], markdown: true },
  properties: { line: null, block: false, quotes: [], hashComment: true },
  env: { line: null, block: false, quotes: [], hashComment: true },
  dockerfile: { line: null, block: false, quotes: ['"', "'"], hashComment: true },
  makefile: { line: null, block: false, quotes: [], hashComment: true },
}

/** 扩展名 → 语言 key（含特殊文件名） */
const EXT_MAP = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'jsx',
  ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx',
  java: 'java', cs: 'cs',
  c: 'c', h: 'h', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  go: 'go', swift: 'swift', kt: 'kt', kts: 'kt', scala: 'scala', php: 'php', rs: 'rs',
  json: 'json', jsonc: 'json',
  css: 'css', less: 'less', scss: 'scss', sass: 'sass',
  yaml: 'yaml', yml: 'yml',
  toml: 'toml', ini: 'ini', conf: 'ini', config: 'ini',
  sh: 'sh', bash: 'bash', zsh: 'zsh',
  py: 'py', rb: 'rb',
  sql: 'sql',
  xml: 'xml', html: 'html', htm: 'html', svg: 'xml', xsl: 'xml',
  vue: 'vue',
  md: 'md', markdown: 'md',
  properties: 'properties',
  env: 'env',
  gitignore: 'properties',
  dockerignore: 'properties',
}

const FILE_MAP = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'properties',
  '.dockerignore': 'properties',
  '.env': 'env',
  '.editorconfig': 'ini',
}

/**
 * 识别语言。无法识别时返回 null（不高亮，按纯文本显示）。
 * 注意：不认识的扩展名一律不高亮——瞎猜反而会让内容更难读。
 */
export function detectLang(path) {
  const name = String(path).split('/').pop() || ''
  const lower = name.toLowerCase()
  if (FILE_MAP[lower]) return FILE_MAP[lower]
  const m = lower.match(/\.([a-z0-9]+)$/)
  if (!m) return null
  return EXT_MAP[m[1]] || null
}

/** 该语言是否值得高亮（纯文本类型返回 false） */
export function isHighlightable(path) {
  return detectLang(path) != null
}

// ============================================================
// 规则编译
// sticky 正则必须每次调用前设 lastIndex，不能复用「脏」状态。
// ============================================================

/** 每种语言的规则数组，按优先级排列（先匹配的生效） */
const RULE_CACHE = new Map()

function buildRules(langKey) {
  const cfg = LANGS[langKey]
  if (!cfg) return null

  const rules = []

  // ---- 1. 跨行块注释的延续（由 state 驱动，见 tokenizeLine）----

  // ---- 2. 单行注释 ----
  if (cfg.line) {
    // 行注释吃到行尾（转义前缀里的特殊字符）
    const p = cfg.line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    rules.push({ re: new RegExp(`${p}.*$`, 'y'), cls: 'com' })
  }
  if (cfg.hashComment) {
    rules.push({ re: /#.*$/y, cls: 'com' })
  }
  if (cfg.sql) {
    rules.push({ re: /--.*$/y, cls: 'com' })
  }

  // ---- 3. 块注释开始 ----
  if (cfg.block) {
    rules.push({ re: /\/\*[\s\S]*?(?:\*\/|$)/y, cls: 'com' })
  }

  // ---- 4. 字符串 ----
  // 双引号/单引号：处理反斜杠转义，允许不闭合（跨行由 state 标记）
  if (cfg.quotes.includes('"')) rules.push({ re: /"(?:[^"\\]|\\.)*"?/y, cls: 'str' })
  if (cfg.quotes.includes("'")) rules.push({ re: /'(?:[^'\\]|\\.)*'?/y, cls: 'str' })
  if (cfg.quotes.includes('`')) rules.push({ re: /`(?:[^`\\]|\\.)*`?/y, cls: 'str' })

  // ---- 5. Java/C# 注解 ----
  if (cfg.annotation) rules.push({ re: /@[A-Za-z_][\w.]*/y, cls: 'ann' })

  // ---- 6. 数字（含十六进制、浮点、下划线分隔、单位后缀）----
  rules.push({
    re: /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?)[a-zA-Z]{0,3}/y,
    cls: 'num',
  })

  // ---- 7. Markdown 行首结构 ----
  if (cfg.markdown) {
    rules.push({ re: /^#{1,6}\s.*$/my, cls: 'md-h' })
    rules.push({ re: /^\s*[-*+]\s/y, cls: 'md-li' })
    rules.push({ re: /^\s*\d+\.\s/y, cls: 'md-li' })
    rules.push({ re: /^\s*>\s.*$/my, cls: 'md-quo' })
    rules.push({ re: /^```[\s\S]*$/my, cls: 'md-code' })
    rules.push({ re: /\*\*[^*\n]+\*\*/y, cls: 'md-b' })
    rules.push({ re: /`[^`\n]+`/y, cls: 'md-code' })
    rules.push({ re: /\[[^\]\n]*\]\([^)\n]*\)/y, cls: 'md-link' })
  }

  // ---- 8. Markup（XML/HTML）标签 ----
  if (cfg.markup) {
    rules.push({ re: /<\/?[A-Za-z][\w:.-]*/y, cls: 'tag' })
    rules.push({ re: /\/?>/y, cls: 'tag' })
    rules.push({ re: /<!--[\s\S]*?(?:-->|$)/y, cls: 'com' })
    // 标签内的属性名
    rules.push({ re: /[A-Za-z_][\w:-]*(?=\s*=)/y, cls: 'attr' })
  }

  // ---- 9. CSS/LESS 选择器与属性 ----
  if (cfg.css) {
    // 颜色值要先于选择器：#fff 是颜色不是 id 选择器，#333 也不能被拆成 # + 数字。
    // 三种形式：#abc / #aabbcc / #aabbccdd，允许 3~8 位十六进制
    rules.push({ re: /#[0-9a-fA-F]{3,8}\b/y, cls: 'num' })
    rules.push({ re: /[.#][A-Za-z_][\w-]*/y, cls: 'sel' })
    rules.push({ re: /@[A-Za-z_][\w-]*/y, cls: 'var' })
    // 属性名后面跟冒号；前面排除掉已经是选择器/变量的情况（靠顺序保证）
    rules.push({ re: /[A-Za-z-]+(?=\s*:)/y, cls: 'prop' })
  }

  // ---- 10. 标识符（最后，因为最宽泛）----
  // 注意：这里不给 cls，改用 resolve，由 keywordClass 决定用它上什么色。
  // 如果同时给 cls='ident'，会先命中 cls 分支、绕过关键字查表。
  rules.push({ re: /[A-Za-z_$][\w$]*/y, cls: null, resolve: true })
  if (cfg.css) {
    // CSS 里带 - 的名字（font-size）也要整体识别
    rules.push({ re: /--?[A-Za-z][\w-]*/y, cls: 'prop' })
  }

  // ---- 11. 兜底：一次吃掉一大段无需着色的字符（性能关键）----
  // 包含空白、常见标点、括号等。不匹配引号/斜杠/井号/数字/字母，
  // 那些交给上面的规则。这样主循环次数≈token 数而非字符数。
  rules.push({ re: /[^\w$"'`/#@\d-]+/y, cls: null })

  return rules
}

function getRules(langKey) {
  if (!RULE_CACHE.has(langKey)) RULE_CACHE.set(langKey, buildRules(langKey))
  return RULE_CACHE.get(langKey)
}

/** 标识符 → 关键字类别。都不是则返回 null（普通标识符，不上色） */
function keywordClass(word) {
  if (SET_CONTROL.has(word)) return 'ctrl'
  if (SET_DECL.has(word)) return 'decl'
  if (SET_TYPE.has(word)) return 'type'
  if (SET_LIT.has(word)) return 'lit'
  return null
}

/** 创建一份高亮状态（跨行传递：块注释、未闭合字符串） */
export function createState() {
  return { inBlock: false }
}

/**
 * 高亮一行，返回转义好的 HTML 片段。
 * @param {string} line   单行文本（不含换行符）
 * @param {string} langKey 语言 key（来自 detectLang）
 * @param {object} state  跨行状态，会把未闭合的块注释带到下一行
 */
export function highlightLine(line, langKey, state) {
  const rules = getRules(langKey)
  if (!rules || !line) return esc(line || '')

  const out = []
  let pos = 0
  let plainStart = 0

  const flush = (end) => {
    if (end > plainStart) out.push(esc(line.slice(plainStart, end)))
  }

  // 上一行留下了未闭合的块注释：先消费到 */ 或行尾
  if (state.inBlock) {
    const close = line.indexOf('*/')
    if (close < 0) {
      return `<span class="hl-com">${esc(line)}</span>`
    }
    out.push(`<span class="hl-com">${esc(line.slice(0, close + 2))}</span>`)
    state.inBlock = false
    pos = close + 2
    plainStart = pos
  }

  const cfg = LANGS[langKey]
  let guard = 0
  while (pos < line.length) {
    // 防御：正则若出现零宽匹配会死循环
    if (guard++ > line.length * 4 + 2000) break

    let matched = false
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i]
      r.re.lastIndex = pos
      const m = r.re.exec(line)
      if (!m || m[0].length === 0) continue

      const text = m[0]
      flush(pos)

      if (r.cls) {
        out.push(`<span class="hl-${r.cls}">${esc(text)}</span>`)
      } else if (r.resolve) {
        // 标识符：查关键字表，落到 ctrl / decl / type / lit，都不是就当普通标识符
        // （不加 span，减少 DOM 节点数——大多数 token 是普通标识符）
        const kw = keywordClass(text)
        if (kw) out.push(`<span class="hl-${kw}">${esc(text)}</span>`)
        else out.push(esc(text))
      } else {
        out.push(esc(text))
      }
      pos += text.length
      plainStart = pos

      // 块注释未闭合 → 记到 state，下一行继续
      if (r.cls === 'com' && cfg?.block && text.startsWith('/*') && !text.includes('*/')) {
        state.inBlock = true
      }
      matched = true
      break
    }

    if (!matched) {
      // 当前字符没有规则命中（比如孤立的引号、被切开的符号），当作纯文本推进
      pos++
      // plainStart 不动，下一次 flush 会把它带出去
    }
  }
  flush(line.length)
  return out.join('')
}

/**
 * 高亮整段文本，返回每行 HTML 的数组。
 * 与逐行调用 highlightLine 的区别：这里统一维护跨行状态。
 */
export function highlightLines(text, langKey) {
  const state = createState()
  const lines = String(text).split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => highlightLine(l, langKey, state))
}
