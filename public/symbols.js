/**
 * 从源码里提取符号（类型与函数），供右侧大纲面板使用。
 *
 * 范围约定：**只到类型和函数级别**。不收字段、常量、普通变量——
 * 一个 Service 类可能有 20 个字段混在 60 个方法里，收进来反而更难找东西。
 * C# 属性例外，显示为 `prop`（在 C# 里属性就是成员的常规写法，且与 Java 的
 * getter/setter 地位相当）。
 *
 * 这是**启发式正则**，不是编译器：
 *   - 方法签名跨多行可能漏
 *   - Lombok / 宏 / 源生成器产生的东西源码里没有，提取不到
 *   - 拿到 90~95% 就够导航用，别指望 100%
 *
 * 之所以不用 tree-sitter / LSP：本项目零依赖零构建，
 * 引一套 WASM 语法文件或常驻 language server 不值当。
 *
 * 抽成独立模块的原因同 tree-model.js：纯逻辑可以直接单测，
 * 埋进 tree.js 只能靠 DOM 反推，边界情况根本测不到。
 */

// ---------------------------------------------------------------- 公共工具

/** 跳过注释：逐行扫描时用，避免把注释里的 class/def 当成符号 */
function makeCommentTracker() {
  let inBlock = false
  return (line) => {
    const trimmed = line.trim()
    if (inBlock) {
      if (trimmed.includes('*/')) inBlock = false
      return true
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlock = true
      return true
    }
    return trimmed.startsWith('//')
  }
}

/** 正则里嵌入用户输入的符号名时要转义 */
export function escapeRe(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function indentOf(line) {
  const m = line.match(/^[\t ]*/)
  // tab 按 4 空格算：混用 tab/空格的代码里按字符数算会把层级算错
  return (m ? m[0] : '').replace(/\t/g, '    ').length
}

/**
 * 剥掉行首的注解/特性，返回剩下的部分。
 *
 * 为什么需要：`@Override public int getRuleIndex() {` 这种「注解与声明同行」
 * 的写法很常见（实测 300 个文件里 50 处）。早先整行以 @ 开头就跳过，
 * 这些方法全丢了。
 */
function stripAnnotations(trimmed, { attribute = false } = {}) {
  let s = trimmed.replace(/^(@[A-Za-z_][\w.]*(\([^)]*\))?\s*)+/, '')
  if (attribute) s = s.replace(/^(\[[^\]]*\]\s*)+/, '')
  return s
}

// ---------------------------------------------------------------- Java

const JAVA_MOD = '(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp|sealed|non-sealed)'
const RE_J_TYPE = new RegExp(`^\\s*(?:${JAVA_MOD}\\s+)*(class|interface|enum|record|@interface)\\s+([A-Za-z_$][\\w$]*)`)
// 构造器：访问修饰符 + 类名 + 参数，没有返回类型
const RE_J_CTOR = new RegExp(`^\\s*(?:(?:public|protected|private)\\s+)([A-Z][\\w$]*)\\s*\\([^;{]*\\)\\s*(?:throws\\s+[\\w.,\\s]+)?\\{?\\s*$`)
/**
 * 方法。行尾允许三种：
 *   `{`（含单行体 `{ return 1; }`）  普通方法
 *   `;`  **接口 / 抽象方法**（实测 194 个接口文件全靠这条，早先漏光了）
 *   空   下一行才写 `{`
 */
const RE_J_METHOD = new RegExp(
  '^\\s*(?:' + JAVA_MOD + '\\s+)*' +
  '(?:<[^>]*>\\s*)?' +
  '([A-Za-z_$][\\w$.<>\\[\\],?\\s]*?)\\s+' +
  '([A-Za-z_$][\\w$]*)\\s*' +
  '\\([^)]*\\)\\s*' +
  '(?:throws\\s+[\\w.,\\s]+)?' +
  '(?:\\{.*|;)?\\s*$',
)
const JAVA_NOISE = /^(if|for|while|switch|catch|else|do|try|return|new|throw|assert|case|super|this|synchronized)\b/

export function extractJava(content) {
  const out = []
  const lines = content.split('\n')
  const isComment = makeCommentTracker()
  let className = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line)) continue
    const raw = line.trim()
    if (!raw) continue
    const t = stripAnnotations(raw)
    if (!t) continue // 纯注解行

    const type = t.match(RE_J_TYPE)
    if (type) {
      const kind = type[1] === '@interface' ? 'annotation' : type[1]
      className = type[2]
      out.push({ kind, name: type[2], line: i + 1, indent: indentOf(line) })
      continue
    }
    if (JAVA_NOISE.test(t)) continue

    // 构造器要在方法之前判断：它同样有「名字(参数)」，但没有返回类型
    const ctor = t.match(RE_J_CTOR)
    if (ctor && ctor[1] === className) {
      out.push({ kind: 'constructor', name: ctor[1], line: i + 1, indent: indentOf(line) })
      continue
    }

    const m = t.match(RE_J_METHOD)
    if (m && !JAVA_NOISE.test(m[1]) && !/^(return|new|throw|else)$/.test(m[1].trim())) {
      out.push({ kind: 'method', name: m[2], line: i + 1, indent: indentOf(line), detail: m[1].trim() })
    }
  }
  return out
}

// ---------------------------------------------------------------- TypeScript / JavaScript

const RE_T_FUNC = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/
const RE_T_CLASS = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/
const RE_T_IFACE = /^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/
const RE_T_TYPE = /^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/
const RE_T_ENUM = /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/
// const foo = () => / const foo = async () => / const foo = function
const RE_T_ARROW = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/
// 类内方法：靠 indent > 0 判断，正则不重复校验缩进
const RE_T_METHOD = /^(?:(?:public|private|protected|static|async|readonly|override|get|set)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\s*[{=]/

export function extractJsTs(content) {
  const out = []
  const lines = content.split('\n')
  const isComment = makeCommentTracker()

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line)) continue
    const t = line.trim()
    if (!t) continue
    const indent = indentOf(line)

    let m = t.match(RE_T_FUNC)
    if (m) { out.push({ kind: 'function', name: m[1], line: i + 1, indent }); continue }
    m = t.match(RE_T_CLASS)
    if (m) { out.push({ kind: 'class', name: m[1], line: i + 1, indent }); continue }
    m = t.match(RE_T_IFACE)
    if (m) { out.push({ kind: 'interface', name: m[1], line: i + 1, indent }); continue }
    m = t.match(RE_T_TYPE)
    if (m) { out.push({ kind: 'type', name: m[1], line: i + 1, indent }); continue }
    m = t.match(RE_T_ENUM)
    if (m) { out.push({ kind: 'enum', name: m[1], line: i + 1, indent }); continue }
    m = t.match(RE_T_ARROW)
    if (m) { out.push({ kind: 'function', name: m[1], line: i + 1, indent }); continue }

    // 类内方法：只在缩进 > 0 时尝试，避免把顶层调用当成方法
    if (indent > 0) {
      m = t.match(RE_T_METHOD)
      if (m && !/^(if|for|while|switch|catch|return|new|throw|else|await|yield|typeof|delete)$/.test(m[1])) {
        out.push({ kind: 'method', name: m[1], line: i + 1, indent })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- C#

const CS_MOD = '(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|virtual|override|new|extern|async|ref)'
// delegate 是「delegate 返回类型 名字」，比其他类型多一段
const RE_CS_TYPE = new RegExp(`^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${CS_MOD}\\s+)*(class|interface|struct|enum|record|delegate)\\s+(?:[\\w.<>\\[\\],?]+\\s+)?([A-Za-z_]\\w*)`)
const RE_CS_METHOD = new RegExp(
  '^\\s*(?:' + CS_MOD + '\\s+)*' +
  '(?:<[^>]+>\\s*)?' +
  '([A-Za-z_][\\w.<>\\[\\],?\\s]*?)\\s+' +
  '([A-Za-z_]\\w*)\\s*' +
  '\\([^)]*\\)\\s*' +
  '(?:where\\s+[^{;]+)?' +
  '(?:\\{.*|=>.*|;)?\\s*$',
)
// 属性：public string Name { get; set; } / public int Age => 1;
const RE_CS_PROP = new RegExp(
  '^\\s*(?:' + CS_MOD + '\\s+)*' +
  '(?:<[^>]+>\\s*)?' +
  '([A-Za-z_][\\w.<>\\[\\],?]*)\\s+' +
  '([A-Za-z_]\\w*)\\s*' +
  '(?:\\{\\s*(?:get|set|init)\\b|=>)',
)
const RE_CS_CTOR = new RegExp(`^\\s*(?:${CS_MOD}\\s+)*([A-Z]\\w*)\\s*\\([^)]*\\)\\s*(?::\\s*(?:base|this)\\s*\\([^)]*\\))?\\s*(?:\\{|=>)?\\s*$`)

/**
 * 方法匹配的**第一组**（返回类型位置）不能是这些词。
 *
 * 起因是两个真实误报：
 *   `throw new BusinessLogicException("...")` → 返回类型位置是 "throw new"
 *   `from a in (from i in ...)`              → 返回类型位置是 "from a"
 * 两组都满足「X Y(...)」的形状，只看方法名根本筛不掉——
 * 名字分别是 BusinessLogicException 和 in，都像标识符。
 * 所以必须检查返回类型那一段的开头词。
 *
 * select/where/group/orderby 是 C# LINQ 的查询子句，常写成
 * `select new Dto() { ... }`，同样是「词 + 名字 + 括号」的形状。
 */
const CS_STMT_HEAD = /^(if|for|foreach|while|switch|catch|else|do|try|case|default|break|continue|goto|return|throw|new|from|where|select|group|orderby|let|join|in|on|equals|into|var|await|yield|using|lock|checked|unchecked|fixed|stackalloc|nameof|typeof|sizeof|default)\b/

export function extractCsharp(content) {
  const out = []
  const lines = content.split('\n')
  const isComment = makeCommentTracker()
  let className = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (isComment(line)) continue
    const raw = line.trim()
    if (!raw) continue
    // C# 的特性写在方括号里，可能和声明同行
    const t = stripAnnotations(raw, { attribute: true })
    if (!t) continue

    const type = t.match(RE_CS_TYPE)
    if (type) {
      className = type[2]
      out.push({ kind: type[1], name: type[2], line: i + 1, indent: indentOf(line) })
      continue
    }
    // 构造器先于方法：它没有返回类型
    const ctor = t.match(RE_CS_CTOR)
    if (ctor && ctor[1] === className) {
      out.push({ kind: 'constructor', name: ctor[1], line: i + 1, indent: indentOf(line) })
      continue
    }
    const m = t.match(RE_CS_METHOD)
    // 关键：检查**返回类型位置**（m[1]），不是方法名。
    // throw new Foo() / from a in (…) / select new Dto() 的名字都像标识符，
    // 只有返回类型那一段暴露了它是语句。
    if (m && !CS_STMT_HEAD.test(m[1].trim())) {
      out.push({ kind: 'method', name: m[2], line: i + 1, indent: indentOf(line), detail: m[1].trim() })
      continue
    }
    // 属性：按约定显示（C# 里属性就是常规成员写法）
    const p = t.match(RE_CS_PROP)
    if (p && p[2] !== className) {
      out.push({ kind: 'prop', name: p[2], line: i + 1, indent: indentOf(line), detail: p[1].trim() })
    }
  }
  return out
}

// ---------------------------------------------------------------- Go

const RE_GO_FUNC = /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)/
const RE_GO_TYPE = /^type\s+([A-Za-z_]\w*)\s+(struct|interface|func|map|\[|\w)/

/**
 * Go 没有嵌套函数，缩进建树连不上，所以靠 receiver 关联：
 *   func (b *Builder) Build()  →  挂到 type Builder 下
 */
export function extractGo(content) {
  const out = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    let m = t.match(RE_GO_FUNC)
    if (m) {
      // receiver 形如 `b *Builder` 或 `b Builder`，取类型名
      let receiver = null
      if (m[1]) {
        const parts = m[1].trim().split(/\s+/)
        receiver = (parts[parts.length - 1] || '').replace(/^\*/, '')
      }
      out.push({ kind: 'func', name: m[2], line: i + 1, indent: indentOf(lines[i]), receiver })
      continue
    }
    m = t.match(RE_GO_TYPE)
    if (m) out.push({ kind: 'type', name: m[1], line: i + 1, indent: indentOf(lines[i]), detail: m[2] })
  }
  return out
}

// ---------------------------------------------------------------- Python

const RE_PY_DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/
const RE_PY_CLASS = /^(\s*)class\s+([A-Za-z_]\w*)/

export function extractPython(content) {
  const out = []
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    // 装饰器行跳过（@property / @staticmethod 等），def 在下一行
    if (t.startsWith('@')) continue
    let m = line.match(RE_PY_CLASS)
    if (m) { out.push({ kind: 'class', name: m[2], line: i + 1, indent: indentOf(line) }); continue }
    m = line.match(RE_PY_DEF)
    if (m) out.push({ kind: 'function', name: m[2], line: i + 1, indent: indentOf(line) })
  }
  return out
}

// ---------------------------------------------------------------- Vue 单文件组件

/**
 * Vue 只提取 <script> 块里的符号，行号按整个文件算（方便跳转）。
 * template 里的东西（组件、指令）语义不同，混进大纲反而乱。
 */
export function extractVue(content) {
  const lines = content.split('\n')
  let start = -1
  let end = -1
  for (let i = 0; i < lines.length; i++) {
    if (start < 0 && /^\s*<script\b/.test(lines[i])) { start = i; continue }
    if (start >= 0 && /<\/script>/.test(lines[i])) { end = i; break }
  }
  if (start < 0) return []
  if (end < 0) end = lines.length - 1

  const inner = lines.slice(start + 1, end).join('\n')
  // script 内容第一行在文件里的行号是 start + 2
  return extractJsTs(inner).map((s) => ({ ...s, line: s.line + start + 1 }))
}

// ---------------------------------------------------------------- Markdown

/**
 * Markdown 只提标题（ATX `#`），并且**最多到 3 级**。
 *
 * 层级直接用标题级别表达：把 level 换算成缩进（(level-1)*2），
 * 这样能复用统一的缩进建树，不用给 md 单写一套。
 *
 * 两个必须跳过的地方：
 *   - 代码围栏（``` / ~~~）里的 `# 注释` 不是标题
 *   - 文件开头的 YAML frontmatter（`---` 包起来那段）
 */
export function extractMarkdown(content) {
  const out = []
  const lines = content.split('\n')
  let inFence = false
  let inFront = false
  let seenBody = false

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()

    // frontmatter 只在文件最开头
    if (!seenBody && i === 0 && /^---\s*$/.test(t)) { inFront = true; continue }
    if (inFront) {
      if (/^(---|\.\.\.)\s*$/.test(t)) inFront = false
      continue
    }
    if (t) seenBody = true

    // 代码围栏：进出都靠它，围栏内的 # 一律不算
    if (/^(`{3,}|~{3,})/.test(t)) { inFence = !inFence; continue }
    if (inFence) continue

    const m = t.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!m) continue
    const level = m[1].length
    if (level > 3) continue // 只要到 3 级

    const name = m[2].trim()
    if (!name) continue
    out.push({
      kind: 'heading',
      name,
      line: i + 1,
      indent: (level - 1) * 2,
      detail: `h${level}`,
    })
  }
  return out
}

// ---------------------------------------------------------------- 分派

const EXTRACTORS = {
  java: extractJava,
  cs: extractCsharp,
  ts: extractJsTs,
  tsx: extractJsTs,
  js: extractJsTs,
  jsx: extractJsTs,
  mjs: extractJsTs,
  cjs: extractJsTs,
  go: extractGo,
  py: extractPython,
  vue: extractVue,
  md: extractMarkdown,
  markdown: extractMarkdown,
}

/** 当前语言是否支持大纲 */
export function supportsOutline(lang) {
  return Boolean(EXTRACTORS[lang])
}

/**
 * @param {string} content 文件全文
 * @param {string} lang    detectLang() 的结果（java / ts / cs / vue / ...）
 * @returns {Array<{kind, name, line, indent, detail?, receiver?}>} 按行号升序的扁平列表
 */
export function extractSymbols(content, lang) {
  const fn = EXTRACTORS[lang]
  if (!fn) return []
  try {
    return fn(content).sort((a, b) => a.line - b.line)
  } catch {
    // 正则万一在怪文件上跑挂，退化成「没有大纲」而不是整个页面报错
    return []
  }
}

// ---------------------------------------------------------------- 建树

/**
 * 扁平符号列表 → 嵌套树（大纲面板要树形展示）。
 *
 * 靠**缩进**定层级：维护一个祖先栈，遇到 indent 不比栈顶深的就弹栈。
 * 不用大括号配对是因为方法体里的 `{` 会让深度算乱；缩进对
 * Java / C# / TS / Python 都成立，且写错缩进的代码本来也少见。
 *
 * Go 是例外：函数缩进都是 0，靠 receiver 挂到同名 type 下。
 *
 * @returns {{ children: Array }}
 */
export function buildSymbolTree(symbols) {
  const root = { children: [], indent: -1 }
  const stack = [root]
  const typeByName = new Map()

  for (const s of symbols) {
    // Go：带 receiver 的方法直接挂到对应类型下
    if (s.receiver && typeByName.has(s.receiver)) {
      typeByName.get(s.receiver).children.push({ ...s, children: [] })
      continue
    }
    while (stack.length > 1 && stack[stack.length - 1].indent >= s.indent) stack.pop()
    const node = { ...s, children: [] }
    stack[stack.length - 1].children.push(node)
    stack.push(node)
    if (s.kind === 'type' || s.kind === 'struct' || s.kind === 'interface' || s.kind === 'class') {
      typeByName.set(s.name, node)
    }
  }
  return root
}

// ---------------------------------------------------------------- 引用（本文件内）

/**
 * 在**当前文件**里找某个符号的引用位置。
 *
 * 用词边界 `\bname\b` 匹配，会包含定义那一行本身（标 isDef 供界面区分）。
 * 不解析语法，所以字符串/注释里的同名文本也会算进来——这是文本级近似，
 * 与「本文件」这个范围的定位一致；跨文件那种交给 git grep。
 *
 * @returns {Array<{line: number, text: string, isDef: boolean}>}
 */
export function findReferences(content, name, { defLine = 0, max = 500 } = {}) {
  const lines = content.split('\n')
  const re = new RegExp(`\\b${escapeRe(name)}\\b`)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      out.push({
        line: i + 1,
        text: lines[i].trim().slice(0, 160),
        isDef: i + 1 === defLine,
      })
      if (out.length >= max) break
    }
  }
  return out
}
