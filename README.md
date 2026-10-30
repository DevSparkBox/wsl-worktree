# Worktree — 浏览器版 git worktree 管理器

浏览器里管理本机所有 git 仓库的 worktree。**WSL 和纯 Linux 用同一套代码**：WSL 下可以调 Windows 的 explorer.exe / wt.exe / code.cmd，纯 Linux 下用 xdg-open / Konsole / code / zed；git 全程在本机执行，毫秒级；UI 是标准浏览器交互，不用学新快捷键。

**打开：** http://localhost:7801

扫描根目录、缓存、补丁上限和外部工具路径可以在页面右上角「设置」里维护；端口和监听地址只读，只能改 `config.json` 后重启。

---

## 符号大纲

文件树页右侧的 Symbols 面板：列出当前文件的**类型和函数**，点一下跳到定义行。

```
┌─ Symbols  150 ──────────── ✕ ┐
│ [过滤符号…              ⌘R] │
│ T MetadataAjaxDesignerApp…  │
│   ƒ validationFormulaType   │
│   ƒ getFunctionPageMetadata │
│ ▾ ƒ constructControlFields  │   ← 函数里嵌函数时逐层缩进
│     ƒ innerHelper           │
├─────────────────────────────┤
│ 引用 · getFunctionPageMetadata │   ← 独立分区，固定 40% 高
│ 249  public void getFunction…│
│ 347  setFunctionPageMetadat…│
│ ┌─────────────────────────┐ │
│ │ 🔍 在所有文件中搜索        │ │
│ └─────────────────────────┘ │
└─────────────────────────────┘
```

**操作**

| 动作 | 行为 |
|---|---|
| 点符号名 | 代码区滚到该行并闪烁一下，下方引用区刷新成这个符号 |
| 点引用行 | 跳到那一行 |
| 点折叠箭头 | 折叠/展开子树（默认全展开；搜索态不显示，因为强制展开） |
| 滚动代码 | 大纲自动高亮当前所在符号 |
| 过滤框 | 在全部符号里按名字过滤，**保留树形**（命中项 + 淡色的祖先） |
| 底部按钮 | 把符号名交给左侧搜索视图，等价于在那儿手输 |
| 顶栏「大纲」/ ✕ | 显示或隐藏面板（记住选择） |

符号名右边的数字是**本文件内的出现次数**（>1 才显示）。整份文件只扫一遍算出所有符号的计数，
不是每个符号单独扫——170 个符号 × 7000 行各自扫一遍是上百万次匹配。

### 提取范围：只到类型和函数

不收字段、常量、普通变量——一个 Service 类可能有 20 个字段混在 60 个方法里，收进来反而更难找东西。

C# 属性例外，显示为 `prop`（在 C# 里属性就是成员的常规写法，与 Java 的 getter/setter 地位相当）。

| 语言 | 类型节点 | 函数节点 |
|---|---|---|
| Java | class / interface / enum / record / @interface | 方法、构造器 |
| C# | class / interface / struct / enum / record / delegate | 方法、构造器、局部函数、属性（prop） |
| TS / TSX / JS / JSX | class / interface / type / enum | function、箭头函数常量、类方法 |
| Vue | script 块内同上 | 同上（不含 template 里的组件引用） |
| Python | class | def（含 async） |
| Go | type（struct/interface） | func（带 receiver 的挂到对应 type 下） |
| Markdown | 标题（`#` ~ `###`，最多 3 级） | — |

Markdown 的层级直接用标题级别：`level` 换算成缩进 `(level-1)*2`，复用同一套缩进建树。
跳过代码围栏里的 `#` 和文件头的 YAML frontmatter——这两处最容易误判成标题。

### 层级怎么来的

靠**缩进**建树，不用大括号配对——方法体里的 `{` 会把深度算乱：

```
维护祖先栈，遇到 indent 不比栈顶深的就弹栈
```

Java 实测 7302 行 → 150 个节点（1 个类 + 149 个方法），2 层；TS 里函数套函数能到 3–4 层。

Go 是例外：函数缩进都是 0，靠 `func (b *Builder) Build()` 的 receiver 挂到同名 `type Builder` 下。

### 两层引用（这也是难点所在）

| 范围 | 做法 | 精度 |
|---|---|---|
| **本文件** | `\bname\b` 正则扫描，列在面板下方的独立分区 | 文本级，注释/字符串里的同名也算 |
| **跨文件** | 分区底部按钮 → 左侧搜索视图（git grep） | 复用现有搜索，作用于当前提交快照 |

**引用为什么不做成符号树里的内联展开**：行内插进去会把树打断（符号、引用行、符号交替出现），
层级和「这个符号有几处」两件事混在一起，符号一多几乎没法用。改成面板下方的固定分区后，
符号树始终完整，切换符号时下方内容刷新，两者的分工清楚。

之所以不自己实现跨文件引用：语义级准确引用需要 LSP 或索引，成本完全不是一个量级。
文本级近似误报多，反而干扰判断——不如交给用户已经熟悉的搜索。

### 这是启发式，不是编译器

| 能提到 | 提不到 |
|---|---|
| `public void foo() {` | 方法签名跨多行 |
| `public void foo();`（接口方法） | Lombok / 宏 / 源生成器产生的方法（源码里没有） |
| `@Override public int x() {`（注解同行） | 匿名内部类、Lambda 里的东西（本来也不算符号） |
| `int Foo() => 1;`（C# 表达式体方法） | 写错缩进的代码（层级会乱） |
| 泛型 / 数组 / throws 的返回类型 | |

拿到 90–95% 就够导航用。真需要 100% 准确得引入 tree-sitter 或常驻 language server，那会破坏本项目零依赖零构建的前提。

### 性能

| 场景 | 数据 |
|---|---|
| 单文件提取 | < 5ms（内容已在内存，不用请求后端） |
| 7302 行 / 150 符号 渲染 + 高亮 + 大纲 | 约 1.4s（主要是代码高亮，大纲只占几十 ms） |
| 滚动联动 | requestAnimationFrame 节流 + 二分查行 |

---

## 提交对比

选两个提交（sha / tag / 分支名都行），看两者之间的代码差异。**左侧树只列出有变更的文件**——这是它与文件树页的根本区别：数据源是 `git diff`，不是 `ls-tree` 的全量清单。

```
┌───────────────────────────────────────────────────────────┐
│ 仓库  A:[HEAD~80 ▾]  ⇄  B:[HEAD ▾]      1254 文件 +270k −24k│
├──────────────────┬────────────────────────────────────────┤
│ 全部1254 M892 …  │  .run/jmpt.run.xml → backend/…          │
│ ▾ .run           │  改名 75% · +5 −6                       │
│   M Platform…    │  ┌────────────────────────────────────┐ │
│     +3 −12       │  │ similarity index 75%                │ │
│ ▾ backend/src 577│  │ rename from .run/jmpt.run.xml       │ │
│   ▸ R jmpt.run...│  │ @@ -6,13 +6,12 @@                   │ │
└──────────────────┴────────────────────────────────────────┘
```

**入口**：主界面工具栏「对比」（默认对比所选提交与其父提交，没选就 `HEAD~1..HEAD`），或直接开 `compare.html?repo=<id>&a=<rev>&b=<rev>`。

**操作**

| 操作 | 说明 |
|---|---|
| A / B 输入框 | 可粘贴 sha / tag / 分支名 / `HEAD~n`，回车生效；悬停显示完整 sha + 提交标题 |
| 输入框右侧 ▾ | 展开提交浮层，点一条即选中并立即对比 |
| 输入框内按 ↓ | 直接开列表，↑↓ 移动、Enter 选中、Esc 关闭 |
| 浮层内搜索 | 匹配 **sha 前缀 / 提交信息 / tag 名 / 分支名** |
| 搜索无结果时按 Enter | 把输入内容直接当版本用（`HEAD~5`、分支名、索引外的 sha 都行） |
| ⇄ | 交换 A 和 B（增删行数会对调） |
| 状态筛选 | 只列真实出现的状态（M/A/D/R），可多选；「全部」清空筛选 |
| 过滤框 | 按路径模糊匹配，扁平列出命中 |
| 折叠按钮 | 全部折叠 / 全部展开（默认全展开） |

**A/B 选择器为什么做成「每侧自带 ▾」**

最早的版本是「两个输入框 + 一个全局『最近提交』下拉」，下拉填到哪个框取决于**最后聚焦的输入框**——这是隐式约定，没人能猜对。现在每侧的 ▾ 自包含，浮层锚定在被点的那一侧，语义明确。

另外两条调整：

- **A 和 B 用同一个徽标底色**。之前 A 灰、B 蓝，会让人误以为 B 更「主要」或「更新」，但它们只是两个对等的端点。
- **浮层里的 ref 标签收着显示**。完整 ref（`origin/hotfix/h-tag-5.5.13.11-主项问题修复1020`）塞进小徽章只会变成「origin/hotfix-」，所以分级降级：真 tag 原样显示（紫色），分支名里带版本号就取**版本号之后的尾段**（`h-tag-5.5.13.11-主项问题修复1020` → `主项问题修复1020`，灰色），都没有才留最后一段。完整名放 title。
  注意不能只显示版本号——同一个版本号底下往往挂着好几条不同的 hotfix 分支，那样整列看起来全是 `v5.5.13.11`，信息量为零。

### 浮层里的提交从哪来

```
最近 50 条提交（git log）
  + 全部 tag / 分支尖端（git log --all --no-walk）
  → 按 sha 合并去重 → 按时间倒序
```

只给最近 50 条的话，老 tag 指向的提交根本不在列表里——比如 `v5.5.10.55` 是几个月前的，用户想按 tag 找就永远搜不到。

`git log --all --no-walk=unsorted` 一条命令就能拿到全部 ref 尖端，而且 `%D` 自带 decorate（`tag: v5.5.10.55, origin/main`），格式与普通 log 完全一致，可以直接复用同一个解析函数。jm_java（1881 tag + 195 分支 → 1917 个不同提交）实测 **48ms**。

数据源约 2000 条，默认只渲染前 100 条，搜索在全部数据里过滤——纯前端，无请求。

搜不到时会提示「按 Enter 直接把「xxx」当作版本使用」：输入的可能本来就是合法 rev（`HEAD~5`、分支名、或者不在 ref 上的 sha），没必要因为列表里没有就拦住。

### 三个实现要点

**① 两条 git 命令并行，各自补齐对方缺的信息**

```bash
git diff --find-renames --name-status -z A B   # 状态 A/M/D/R、改名相似度、旧新路径
git diff --find-renames --numstat   -z A B     # 增删行数
```

- `--numstat` 能给出「+12」但分不清「新增文件」和「修改 +12」
- `--name-status` 有状态但没有行数
- 想用 `--raw --numstat` 一次拿全？不行，git 只输出前者

实测 `HEAD~80..HEAD`（1254 文件）两次并行约 **550ms**。

**② 改名文件的 patch 必须同时传新旧路径**

这是最容易漏的点，实测结果：

| 传给 `git diff -- <path>` | 显示成 |
|---|---|
| 只旧路径 | `deleted file` |
| 只新路径 | `new file` |
| **新旧都传** | `similarity 75% / rename from → to` |

所以变更条目要保留 `oldPath`，`compare-file` 接口的两个路径一起传。

**③ `-z` 的 name-status 格式**

```
M \0 path \0 M \0 path \0 ...        # 普通
R075 \0 old \0 new \0                # 改名（相似度跟在 R 后面）
```

不能按 `\t` 切——路径里可能含 tab。也不能只按 `\0` 平铺，改名记录要多吃两个 token。

### 交互细节

- **树默认全展开**：只有有变更的目录才在树里，本身已很稀疏（1254 文件对应 777 目录）；折叠起来反而要点很多次
- **目录节点显示**：变更文件数 + 该目录下增删行合计
- **改名文件挂在「新路径」**：与 B 的文件树一致，树上标 `R`，tooltip 和右侧标题显示 `旧 → 新`
- **二进制文件**：树上标 `BIN`（不显示行数），右侧提示无法逐行对比
- **超大 patch**：2MB 截断并提示
- **A == B**：直接提示「两个提交的内容完全相同」，不渲染空树

### 复用

`patch-view.js`（patch → 表格，与文件历史页共用）、`splitter.js`（左右拖动，与文件树页共用）、`tree-model.js`（建树 + 单链目录压缩）、`tree.css` / `history.css` 的节点与 diff 样式。

---

## 布局

左中右三栏，都能自由调整：

| 操作 | 方式 |
|---|---|
| 收起/展开左侧 | 顶栏左侧图标按钮，或快捷键 `[` |
| 收起/展开右侧 | 顶栏右侧图标按钮，或快捷键 `]`，或详情面板右上角 `✕` |
| 调整左侧宽度 | 拖动左侧分隔线；双击复位 220px；聚焦后用 `←` `→` 微调（`Shift` 加速） |
| 调整右侧宽度 | 拖动右侧分隔线；双击复位 380px；同上键盘微调 |

宽度和折叠状态都存 `localStorage`（key `wsl-worktree.layout.v1`），刷新后保持。

### 提交信息里的 URL 可点击

commit message 里普遍带工单链接（实测 `jm_java` 的 60 条提交里有 27 个 `www.tapd.cn` 链接），纯文本只能复制粘贴。现在自动转成链接，**新标签页打开**。

三处都生效：提交日志表、详情面板的提交摘要、文件历史页的列表。

**三条实现规则**（`public/linkify.js`）：

**① 只放行 http/https，且用白名单**

```js
URL_RE = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」]+/gi
// 还要再 new URL() 校验一次协议
```

`javascript:alert(1)`、`data:text/html,...`、`ftp://` 都不会变成链接。用白名单而非黑名单——将来改正则也不会漏。

**② 中文标点当 URL 边界**

`详见 https://x.cn/p。` 里那个「。」不属于链接。半角空白/尖括号/引号也算边界，但**全角标点必须单独列出来**，否则会把后面的中文一起吞进 URL。

尾部残留的 `.,;:!?)]}` 再剥一次（`见 https://x.cn/p.` 里的句号）。

**③ 文本必须转义**

返回的是 HTML，直接进 `innerHTML`。提交信息是不可信输入，`& < > " '` 全部转义，URL 本身也转义（`?a=1&b=2` → `&amp;`）。

**点击不能误触发选中**

日志表整行可点击（选中 commit），链接在行内。所以在行点击处理里先判断：

```js
if (e.target.closest('a.ext-link')) return
```

否则点链接会「打开新标签页 + 顺带切换右侧详情」，体验很怪。文件历史页同理。

**可见性**：链接用主题蓝 + hover 出现下划线，`word-break: break-all` 防止长 URL 撑破窄表格列。日志表的列宽有限，长链接会截断显示，但 `title` 有完整地址。

---

### 记住当前仓库

刷新、重开标签页都会回到上次看的仓库，而不是每次跳回第一个。

**两处持久化，hash 优先**：

| 来源 | 用途 |
|---|---|
| `location.hash` = `#repo=<urlencoded toplevel>` | 主来源。可以**直接分享/收藏某个仓库的直链** |
| `localStorage` key `wsl-worktree.lastRepo` | 兜底。hash 被清掉时仍能恢复 |

恢复顺序：hash 命中 → localStorage 命中 → 第一个可用仓库。

**实现细节**：

- 写 hash 用 `history.replaceState` 而不是 `location.hash = ...`。后者会把每次切仓库都压进浏览历史，用户点后退键会在一堆仓库之间来回跳。
- hash 里的仓库不存在（仓库被删/改名）时，回退到可用仓库并把 hash 纠正为实际值。
- localStorage 里存的值失效时，先按完整路径匹配，再尝试按仓库名唯一匹配，都不行才回退。
- 监听 `hashchange`：手改地址栏 hash 或从收藏夹进入时也会切换。
- 左侧列表、顶栏切换器、hashchange 三个入口最终都走 `selectRepo`，写入逻辑只在这一处，不会出现某个入口忘记记录。

日志区「当前在哪个 worktree / 分支上看历史」也按仓库记在 localStorage，刷新后恢复，见「[查看指定 worktree 的提交日志](#查看指定-worktree-的提交日志)」。

### 窄宽度下的排版

窗口变窄时有两处容易出问题，都已处理：

**① 顶栏按钮不能换行**

`flex` 容器空间不足时会按比例压缩所有子项。按钮被压到「最宽单字」的宽度后，`更新仓库` 会变成竖排的「更新仓 / 库」。

```css
.btn { white-space: nowrap; }          /* 文字不换行 */
.pane-head > .btn { flex: none; }      /* 按钮不参与收缩 */
```

收缩的活交给旁边的 `.hint`（仓库路径）——它本来就有 `overflow: hidden` + `text-overflow: ellipsis`。仓库名过长时也截断（`max-width: 34%`），让位给按钮。

实测 1440 / 1200 / 1100 三个宽度下三个按钮都是单行（`rows: 1`）。

**② 日志表的 ref 标签要放在摘要文本「前面」**

```
改前： 修复登录超时问题  [origin/h-tag-5.5.13.11]      ← 窄列时被 ellipsis 吃掉
改后： [origin/h-tag-5.5.13.11]  修复登录超时问题
```

`subject` 单元格是 `white-space: nowrap` + `text-overflow: ellipsis`，标签放在后面时一旦超宽就被截断，用户看不到当前在哪个分支/tag 上。放前面能保证它始终可见。

顺带：`.ref-tag` 的间距从 `margin-left` 改成 `margin-right`——标签现在总在开头，左边距会让它距单元格边缘多出 3px 空白。

### 左栏收起后的仓库切换器

左栏一收起，仓库列表这个唯一入口就没了。所以此时顶栏会出现一个仓库切换器（`#top-repo`），位置在 logo 右侧：

- 显示当前仓库名 + worktree 数徽章（`+3`）/ 脏标记（`●`）
- **聚焦即列出全部 33 个仓库**，并全选文本（直接输入就覆盖）
- 支持模糊匹配，复用 `fuzzyScore`，和新建对话框同一套算法
- 候选标签：顶层仓库只显示名字（`jm_java`），子目录仓库带目录前缀（`products/asset`）——否则同名分不清
- `↓` `↑` 选择、`Enter` 切换、第一次 `Esc` 关面板、第二次 `Esc` 还原当前名
- 失焦时若输入的不是有效仓库名，自动还原（避免留半截查询词）
- 左栏重新展开后自动隐藏

相关快捷键：`/` 在左栏收起时聚焦顶栏切换器（不再强行展开左栏）。

**实现注意**：这个输入框预填的是「当前仓库名」而不是「查询词」，所以聚焦时不能拿它去过滤——否则只会看到自己那一项。为此给通用组件加了 `showAllOnFocus: true` 选项，聚焦时走 `open({ ignoreValue: true })`。

**约束**：
- 左栏 140–460px，右栏 240–900px
- 中间区域永远保留至少 420px，拖到极限会停住而不是把中栏压没
- 窗口变窄时宽度自动收敛，不会出现横向溢出
- 窗口宽度 ≤1180px 时右侧面板自动变成浮层抽屉，点开 commit 时滑出

**折叠的实现方式**（改代码时注意）：面板隐藏用的是 `display: none`，而 `display:none` 的 grid item **不占轨道**，后面的元素会往前顺移。所以 `.layout` 的 `grid-template-columns` 必须按折叠状态切换成 3 列 / 1 列，不能只把某一列设成 0：

```css
.layout            { grid-template-columns: var(--w-left) 5px 1fr 5px var(--w-right); }
.layout.hide-left  { grid-template-columns: 1fr 5px var(--w-right); }
.layout.hide-right { grid-template-columns: var(--w-left) 5px 1fr; }
.layout.hide-left.hide-right { grid-template-columns: 1fr; }
```

---

## 功能

### 只读

| 功能 | 说明 |
|---|---|
| 跨仓库总览 | 左侧列表，按目录分组，显示 worktree 数徽章与脏标记 |
| worktree 表格 | 分支、路径、改动文件数、ahead/behind、主/锁定/待清理徽章 |
| 行内「更多」菜单 | VS Code / Zed / 资源管理器 / 终端 / 复制 UNC 路径 / 删除 worktree（红色，二次确认）；浏览器不在服务器上时换成远程打开，见「[远程访问](#远程访问浏览器不在服务器上)」 |
| 提交日志 | 分页 200 条，**滚动到底自动加载**；右上角图标刷新；**点分支名或下拉框切换 worktree**；`当前分支` / `全部分支` 切换；message/sha/作者 过滤 |
| 工单链接可点 | commit message 里的 http(s) URL 自动变链接，新标签页打开 |
| 变更对比 | 点 commit → 文件清单（+/- 行数，含重命名）→ 点文件行展开/收起着色 diff（可同时展开多个） |
| 单文件历史 | 文件行 hover 时钟图标，或顶栏右上角「文件历史」→ 新标签页（列表 + diff 双栏，支持改名跟踪） |
| 完整文件树 | 详情面板右上角「文件树」→ 新标签页（整仓库快照，左树右内容，仿 fork） |
| 合并单链目录 | 文件树默认把 com/mysoft/jmpt 这类单链压成一行，可开关 |
| 发布标签 | 文件树顶栏显示指向该提交的 tag（轻量/annotated 样式区分） |
| **提交对比** | 选两个提交，左侧树只列出有变更的文件，右侧看单文件 diff |
| **未提交的更改** | 日志顶部一行，点开看未提交文件清单 + diff；文件树可切到「工作区」看当前磁盘状态 |
| **克隆仓库** | 从远程地址克隆到扫描根下，实时进度，完成后自动入列表 |
| **未提交的更改** | 日志顶部一行，点开看未提交文件清单 + diff；文件树可切到「工作区」看磁盘当前状态 |
| **符号大纲** | 文件树页右侧列出当前文件的类型与函数，树形嵌套、点击跳转、滚动联动 |
| 内容搜索 | 左侧切到「搜索」视图，在提交快照里 grep 并跳转到命中行 |
| 语法高亮 | 文件内容按语言上色（TS/JS/Java/Vue/LESS/MD/SQL/XML 等），可开关 |
| 切换查看的文件 | 历史页顶栏点击文件路径 → 输入框 → 路径模糊搜索前 20 条 |
| 键盘 | `r` 刷新，`/` 聚焦仓库搜索（左栏收起时聚焦顶栏切换器），`[` `]` 开关左右面板 |

#### 切换分支遇到本地改动：给「放弃本地变更」的出口

`git checkout` 在工作区有改动、且目标分支会覆盖这些文件时会直接失败。原本只提示「请先提交或 stash」，没有别的办法，用户只能去终端。

现在的处理：**列出会被丢弃的文件 + 提供强制切换按钮，但要求点两次**。

```
工作区有 1 个文件有未提交的改动，直接切换会被它们挡住。
强制切换会丢弃这些改动，且无法恢复。如果要保留，请先提交或 git stash。

会被丢弃的改动（共 1 个文件）
  .gitignore   修改

[放弃这些改动并切换]   需要点击两次确认
```

- 第一次点击 → 按钮变成「确认放弃改动？再点一次」并加红色描边（armed）
- 5 秒内没再点就自动复位，避免长期停在「待确认」被误触
- 后端 `checkoutBranch(..., { force: true })` 会在参数里插 `-f`

**`-f` 的边界**（实测确认）：丢弃工作区**和暂存区**的改动，但**不删未跟踪文件**。

```
force 切换后：
  f.txt        → 变成目标分支的内容（本地改动丢失）
  newfile.txt  → 仍然存在（未跟踪，不受影响）
```

**告知的文件列表**取的是当前所有未提交改动（`git status --porcelain=v1 -z`），不完全是 git 拒绝覆盖的那几个。对「放弃本地变更」这个语义来说，用户需要知道的正是这些。

**为什么要求点两次**：切分支丢改动不可撤销，一次误点的代价太大。这比嵌套一个确认弹窗更轻，也比「点一次就丢」安全。

### 写操作

| 功能 | 入口 | 底层命令 |
|---|---|---|
| **更新仓库** | 工具栏「更新仓库」 | `git fetch --all --tags --prune --progress` |
| **更新分支** | 行内「拉取」 | `git pull --ff-only` 或 `--rebase` |
| **切换分支** | 行内「切换」 | `git checkout <branch>` / `-b` / `--track` / `--detach refs/tags/<tag>` |
| **创建 worktree** | 工具栏「新建 worktree」 | `git worktree add` 五种模式（含基于 tag） |
| **删除 worktree** | 行内「删除」 | `git worktree remove [--force]` |
| **批量清理** | 工具栏「清理陈旧」 | `git worktree remove --force` + `prune` |

#### 更新分支对话框：操作完成后按钮要「退场」

`git pull` 在已是最新时**仍然退出码 0**，输出里只有一句 `Already up to date.`。最初的实现只要 `ok` 就显示「更新完成」，而且对话框保持打开、主按钮一直是蓝色高亮——用户会以为「没成功」或者「还要再点一次」。

现在的处理：

| 情况 | 文案 | 按钮 |
|---|---|---|
| 拉到了新提交 | 更新完成，拉取了 **N** 个提交 · 上游 `origin/xxx` | 变「关闭」、去掉 primary 高亮 |
| 已是最新 | 已经是最新，没有需要更新的提交 · 上游 `origin/xxx` | 同上 |
| 失败 | 按原因给提示，可重试 | 保持 primary，可再次点击 |

同时：取消按钮隐藏（已完成，留着没意义）、合并方式置灰（再改也不会生效）。

**怎么判断「有没有真的更新」**：不解析 `Already up to date.` 文本（会随 git 版本、是否 rebase 变化），而是比较 pull 前后的 `HEAD`：

```js
const beforeRev = await git(wtPath, ['rev-parse', 'HEAD'])
const res = await git(wtPath, args)
const afterRev = await git(wtPath, ['rev-parse', 'HEAD'])
const changed = beforeRev !== afterRev
```

有变化时再用 `git rev-list --count before..after` 算拉了几个提交。

有一个状态复位细节：对话框里的「已完成」标志是闭包变量，关闭后重新打开会重新初始化，所以不会记住上次的「关闭」状态（有测试覆盖）。


**未做**：cherry-pick、SSE 自动刷新、lock/unlock 的独立入口。

---

## fetch 的 tag 冲突处理

这是一个实际踩到的坑，值得单独说明。

### 现象

点「更新仓库」报失败：

```
! [rejected] v5.5.12.9  -> v5.5.12.9  (would clobber existing tag)
```

### 真相

远端把这个 tag 重新指向了别的提交，本地同名 tag 与之不同。git 默认拒绝覆盖，并且**让整个 fetch 退出码变成 1**。

但这里最关键的一点是：**分支其实已经更新成功了**。退出码 1 只代表 tag 那部分被拒。最初我按退出码判定，于是界面显示"更新失败"，让用户以为一条都没拉下来——这比真正的失败更糟，因为它会让人放弃重新拉取。

实测确认：

```
本地 v5.5.12.9 (annotated) → 66bbc0c1
远端 v5.5.12.9             → 90e03c0b
```

### 现在的处理

1. **按输出内容解析，而不是只看退出码**。用正则识别 `! [rejected] x -> x (would clobber existing tag)`，把它单独归类为 tag 冲突，不计入失败。
2. **默认不覆盖本地 tag**。tag 被重打通常意味着发布流程出了问题；静默覆盖会让本地历史和远端悄悄分叉，已经基于旧 tag 构建的产物就对不上了。
3. **界面明确告知"分支已更新"**，并列出每个冲突 tag 的本地 sha 与远端 sha，让人能判断谁对。
4. **覆盖需要显式点红色按钮**，且按钮文案是「用远端覆盖」而不是「确定」，避免手滑。
5. 新增 `tag-inspect` 接口，用 `git ls-remote` 拿远端指向，用于对话框展示。

返回结构：

```js
{
  ok: true,           // 分支层面成功
  partial: true,      // 有 tag 未同步
  updated: [...],     // 实际更新了哪些引用
  tagConflicts: [{ tag: 'v5.5.12.9', reason: 'would clobber existing tag' }]
}
```

要完全同步 tag，传 `forceTags: true`（等价于 `git fetch --force --tags`）。

### 判定逻辑（容易写错的地方）

```js
// 不能这样：res.code !== 0 就判失败 —— tag 冲突时分支已更新
const hardFail = res.code !== 0 && otherErrors.length > 0   // 有 error:/fatal: 行
if (hardFail || (res.code !== 0 && tagConflicts.length === 0)) return { ok: false }
```

`otherErrors` 只统计以 `error:` / `fatal:` 开头的行，`! [rejected]` 不算——它后面跟的是 `(would clobber existing tag)` 这种说明，不是错误前缀。

---

## 完整文件树（独立标签页）

看**某个提交当时的整个仓库**长什么样（不是只列改动文件）。入口在详情面板顶部右侧的「文件树」按钮，选中 commit 后出现。

新标签页打开 `/tree.html`，仿 fork 的 File Tree：左树右内容。

### 与「改动文件」的区别

| | 内容 | 来源 |
|---|---|---|
| 改动文件 | 只有这个 commit 动过的文件 | `diff --numstat` |
| 文件树 | 整个仓库在该提交时的快照 | `ls-tree -r` |

### 页面特征

- 树默认展开第一层（否则打开后只有一列折叠目录，得自己点才知道里面有什么）
- 目录显示文件计数；文件显示大小，**hover 时大小让位给历史图标**，避免两列挤在一起
- 每个文件行 hover 出现时钟图标 → 新标签页打开该文件的 history 页
- 右侧显示文件内容（带行号），不做语法高亮（与 fork 一致）
- 从文件行进来时 URL 带 `path`，进去自动定位并展开所在目录链
- 过滤框支持模糊匹配，结果用**扁平列表**
- 分隔线可拖动，宽度记在 `localStorage`

### 顶栏的发布标签

顶栏短 sha 后面会显示**指向该提交的 tag**（绿色徽章），一眼能看出这个变更集对应哪个发布版本。没有 tag 时整块隐藏、不占宽度。

```
File Tree  jm_java  cf45749  [0.1.0.7-BETA] [0.1.0.8-BETA]        …  1129 个文件
```

- 轻量 tag：绿色描边
- annotated tag：绿色实色填充（表示带说明和 tagger 信息）
- 超过 3 个时折叠成 `+N`，hover 显示完整列表
- hover 单个徽章有 tooltip 说明类型

**实现要点**

```bash
git for-each-ref --points-at=<commit> --format=%(refname)%00%(objecttype)%00%(refname:short)
```

**必须用 `--points-at`，不能自己比较 sha**。annotated tag 的对象类型是 `tag`（tag object → commit），轻量 tag 是 `commit`。如果拿 tag 对象的 sha 去和 commit sha 比，annotated tag 会全部漏掉。`--points-at` 内部会正确处理解引用。

实测性能 9–19ms，所以打开页面时直接查，不需要缓存。

**为什么不合并进 `/tree` 接口**：树接口要传 1.8 万个文件（约 160ms），refs 只要 10ms。合并会让「已能显示树」被「查 tag」拖慢。所以分成独立请求并行发，而且 tag 查询失败不影响树（静默不显示）。

**接口**：`GET /api/repos/:id/refs-at?sha=&wt=` → `{ sha, tags: [{name, annotated}], branches: [{name, remote}] }`

### 语法高亮

右侧的文件内容带语法高亮，零依赖（`public/highlight.js`，约 300 行）。

**为什么自己写而不引 highlight.js / Prism**：本项目零框架零构建，为一个只读视图加几百 KB 的库不值；而且只需要「按 token 上色」，不需要语法树。自己写还能只覆盖实际用到的语言。

**支持范围**（按你仓库的实际分布定）：

| 类型 | 占比 | 类型 | 占比 |
|---|---|---|---|
| TS/JS（含 jsx/tsx） | 39% | JSON | 1.4% |
| Java | 17% | SQL | 0.4% |
| Vue | 14% | XML/HTML | 1.1% |
| LESS/SCSS/CSS | 6.5% | C# | 0.4% |
| Markdown | 3.7% | YAML/INI/TOML/sh/py 等 | 少量 |

**颜色只用 5 个色系**，全部映射到现有 CSS 变量，避免和整体观感割裂：

| token | 颜色 |
|---|---|
| 控制流关键字（if/return/for） | 主题蓝 `--accent` |
| 声明/修饰符（class/public/const） | 紫 `--purple` |
| 类型（int/String/void） | 青 `#0f766e` |
| 字符串 | 绿 `--green` |
| 数字 / 字面量 / 注解 / 颜色值 | 琥珀 `#b45309` |
| 注释 | 灰 + 斜体，退到背景里 |
| 标签（HTML/Vue） / 选择器 | 红 `--red` |
| 属性名 | 蓝 `--accent` |

**性能**：这是自己写 tokenizer 时最需要设计的地方。

所有规则用 **sticky 正则**（`/y`）+ `lastIndex`，在任意位置精确匹配，不用把行切成子串。
最后一条是**兜底规则**一次吃掉大段无趣字符（空白、标点）：

```js
rules.push({ re: /[^\w$"'`/#@\d-]+/y, cls: null })
```

所以主循环次数 ≈ token 数，而不是字符数。实测 600 行 Java **4ms**、480 行 TS **2ms**。

逐字符回退的写法会慢一个数量级——一开始我差点写成那样。

**大文件自动关闭**：超过 5000 行或 512KB 不高亮。高亮本身很快，但生成的 span 数会让浏览器的布局和滚动变慢，得不偿失（仓库里有 10 个文件超过 200KB，最大 11.9MB）。

**安全**：输出前对每个片段做 HTML 转义（`& < >`）。纯文本路径用 `textContent`，绝不解析 HTML。测试里专门验证了 `"<script>alert(1)</script>"` 会被转义。

**内容保真**：高亮只加 `<span>`，不改任何字符。有测试逐行比对「去标签后的文本」与原文完全一致（92 行 Java 逐行验证）。

**可关闭**：文件头有「高亮」开关，状态存 `localStorage`。关闭后用纯文本显示，行数不变。

**识别的坑**：

- **LESS/SCSS 也要走 CSS 规则**。一开始只给 `css` 设了 `css: true`，导致 LESS 文件里选择器、属性名全都不上色——它们只是 CSS 方言。
- **十六进制颜色不能当选择器**。`#fff` 会被 `[.#][A-Za-z_][\w-]*` 当成 id 选择器，`#333` 因为首字符是数字根本不匹配。所以颜色规则（`#[0-9a-fA-F]{3,8}`）必须排在选择器规则**之前**。
- **标识符规则不能同时给 `cls` 和 `resolve`**。写了 `{ cls: 'ident', resolve: true }` 时，`if (r.cls)` 分支会先命中，关键字查表永远不执行，所有关键字都变成普通标识符色。改成 `cls: null` 才触发 `resolve`。
- 认不出的扩展名**不高亮**，不瞎猜——猜错比不上色更难读。

### 内容搜索（git grep）

左侧顶部有两个**视图**，点「文件树 / 搜索」切换：

| 视图 | 行为 | 是否发请求 |
|---|---|---|
| 文件树 | 按文件名/路径模糊过滤，只缩窄树 | 否，纯前端 |
| 搜索 | 在当前提交的文件内容里 grep | 是 |

早先是「一个输入框 + 路径/内容分段按钮」，切换时改同一个框的 placeholder。问题是：
两种操作的**语义、控件、结果形态**都不一样（一个即时筛文件名，一个是后端扫整个快照），
却共用一个输入框，用户经常搞不清自己输的东西到底在搜什么；「合并目录」这种纯视图选项
也混在同一行里。

现在各视图只带自己的控件：文件树视图是「过滤框 + 合并目录 + 全部折叠」，
搜索视图是「搜索框 + 大小写/正则/限目录」。切换 tab 时焦点跟着走。

**为什么用 `git grep` 而不是 `rg` 搜物理目录**

这是本功能最关键的技术选择。文件树的语义是「这个 commit 当时的快照」：

```bash
git grep -I -n -z --no-color -F -e <pattern> <commit> -- <path>
```

它直接在**对象库**里搜，不需要检出文件。而 `rg` 搜的是 worktree 的磁盘内容，在查看旧提交时会给出**错误答案**——文件可能已改名、已删除、尚未创建。

实测证据：在 2026 年 1 月的旧 commit 上搜 `STUFF`，能搜到 `MySQL/[1-1][01]STUFF函数.sql`——这个路径在当前 worktree 里已经改名为 `mysql/`。

**性能对比**（18188 个文件）：

| 操作 | 耗时 |
|---|---|
| `git grep` 搜普通词（390 处命中） | 446ms |
| `git grep` 精确词（2 文件命中） | 82ms |
| `git grep` 宽正则匹配 6098 文件 | 194ms |
| `rg` 搜同一目录（同条件） | 43ms |

只慢一倍，不是数量级差异——两者都是逐文件扫描，git grep 的数据源是打包的 object（有 delta 压缩，实际 I/O 反而更少）。所以**不需要退到「搜 worktree 目录」的方案**。

**三个实现坑**

**① `-z` 的输出格式和直觉不同**

按理说 `-z` 应该是 `path\0lineNo\0content\0`，但实际用 `od -c` 看字节是：

```
<sha>:<path> \0 <lineNo> \0 <content> \n <sha>:<path> \0 ...
```

也就是路径和行号之间是 `\0`，但**记录之间仍然是 `\n`**，而且路径前带 `<rev>:` 前缀。

所以不能简单按 `\0` 三三分组（试过，content 里会混入下一条记录）。正确做法：先按 `\n` 切记录，每条再按前两个 `\0` 切。路径去掉**第一个**冒号前的部分（路径本身可能含冒号）。

**② 中文路径要 `core.quotepath=false`**

和文件历史那边同一个坑。不加的话搜到的是 `[1-1][01]STUFF\345\207\275\346\225\260.sql`，前端拿这个路径去打开文件会对不上。

**③ 用户输入默认按字面量（`-F`）**

搜索框里输入 `$(`、`[` 这类正则元字符是很自然的行为，按正则会直接报错。所以默认 `-F`，需要正则时勾选「正则」（切到 `-E`）。

**界面细节**

- 选项栏：忽略大小写、正则、**限当前目录**（勾选后只用树里最后点中的那个目录）
- 结果按文件分组，文件名 + 末两级目录 + 命中数；命中关键词用 `<mark>` 高亮
- **点命中行 → 右侧打开该文件、滚到该行、整行高亮**（`tr.hit-line`）
- 输入防抖 260ms，避免逐字符打服务；Enter 立即搜
- 顶部显示 `N 个文件 · M 处 · 耗时ms`，命中超过 2000 处标记「已截断」

**一处 CSS 陷阱**：`.t-tree { display: block }` 会让 `hidden` 属性失效——显式写了 `display` 的元素，浏览器默认的 `[hidden] { display: none }` 优先级更低。结果就是代码里 `tree.hidden = true` 生效了，但树照样显示。必须补 `.t-tree[hidden] { display: none }`。

### 单链目录合并（compact folders）

Java 项目的路径经常是 `com/mysoft/jmpt/benchmark` 这种每级只有一个子目录的长链，
原样铺出来要连点十几次才能看到内容层。所以默认把单链合并成一行（VS Code 行为）：

```
合并前（12 层）                                    合并后（6 层）
backend                                            backend/src
  src                                                ├ jmpt-benchmark
    jmpt-benchmark                                   │   src/main/java/com/mysoft/jmpt/benchmark
      src                                            │     ├ constant
        main                                         │     └ metadata
          java                                       ├ jmpt-common
            com                                      │   src/…/jmpt/common
              mysoft                                 │     ├ abstraction
                jmpt                                 │     └ adapter
                  benchmark                          └ jmpt-unit
                    ├ constant
                    └ metadata
```

**合并规则**：节点自身没有文件、且只有一个子目录 → 把子目录并进来，循环到「有文件」或「子目录不止一个」为止。

- **分叉点本身会并入链名**：`com` → `com/mysoft` → `com/mysoft/jmpt`，停在 jmpt（它有 benchmark/common 两个子目录）
- **自身有文件时不合并**：那是「真目录」，压掉会让文件看起来挂错位置
- **用 `/` 而不是 `.` 连接**：`.claude/commands` 若写成 `.claude.commands` 会被误读成文件名（假扩展名）

**长链二次压缩**：超过 4 段时中间省略，保留头尾两段——`src/main/java/com/mysoft/jmpt/common`
显示为 `src/…/jmpt/common`。靠开头（src）和结尾（common）就能定位，完整名字在 `title` 里。

**一次展开**：合并已经把单链压成一行，所以点一下就能看到分叉点或文件，不用逐层点。
`expandChain` 还会顺带打开下面仍是单链的层级（压缩是从父节点开始的，子层的链头可能没被压）。

**可关闭**：树头部有「合并目录」开关，关掉恢复逐层展开。状态存 `localStorage`。

**实现注意**：压缩后 `path` 取链末级的真实路径（展开状态按它记），
`aliases` 记下所有被折叠掉的中间层路径。`revealPath`（定位初始文件）必须沿真实树走、
用 `d.path` 判断目标是否在目录下，不能按路径前缀递推——压缩后层级和路径不再一一对应。

树构建逻辑抽到 `public/tree-model.js`（纯函数），由 `test/unit/test-tree-model.mjs` 直接单测。

### 三个验证过的点

**① 性能：18k 文件 96ms**

```
git ls-tree -r -l -z --full-tree <sha>   → 18188 条，96ms
```

但**不能全量铺 DOM**。所以树只渲染「已展开路径上」的节点：默认展开第一层后只有 35 个目录 + 28 个文件在 DOM 里。

**② `ls-tree -r` 只给文件，目录要前端自己推**

不会出现空目录节点（git 不存空目录），所以按路径前缀在 `buildTree` 里推导目录是安全且准确的。

**③ 过滤排序必须「文件名优先」**

只用 `fuzzyScore` 会出问题。实测搜 `pom.xml` 时：

```
fuzzyScore('pom.xml', 'PlatformApplication.run.xml')
```

查询被切成 `pom` + `xml` 两段，`pom` 的 `p` 命中 `Platform` 段首、`xml` 命中 `run.xml` 段，得分**超过真正同名的 pom.xml**。结果前三行全是 `.run.xml` 文件。

改成三级优先：

```js
if (name === ql) rank = 3000                    // 文件名完全相同
else if (name.startsWith(ql)) rank = 2500 - …   // 文件名前缀
else if (name.includes(ql)) rank = 2000 - …     // 文件名包含
else rank = fuzzyScore(q, f.path)               // 兜底：路径模糊匹配
```

**④ 过滤结果必须显示目录**

树形模式下靠层级区分同名文件，过滤成扁平列表后这个信息就丢了。实测搜 `README.md` 出 20 多条，每行都只显示 `README.md`，完全无法区分。

所以过滤行额外显示所在目录（`backend/src/jcxx/light/cs`），且文件名不被压缩（`flex: 0 0 auto`），目录用 `direction: rtl` 从右侧截断保留末级。

---

## 单文件历史（独立标签页）

查一个文件的完整演变过程。入口有两个，行为略有不同：

| 入口 | 说明 |
|---|---|
| 提交详情的文件行 | 行尾时钟图标，**hover 才显形**（不干扰「点整行展开 diff」）。直接打开**该文件**的历史 |
| 顶栏右上角 | 「文件历史」按钮，**常驻可见**（不依赖是否选中文件）。打开历史页并把**焦点放进路径输入框** |

点击后都在**新标签页**打开 `/history.html`，左右双栏：左边是提交列表，右边是选中那次的 diff。

### 顶栏的路径切换器

历史页顶栏显示的文件路径是**可点击的**：点一下变成输入框，输入时按路径模糊匹配（`fuzzyScore`，与主界面同一套），**最多列出 20 条**。

- 候选显示末两级 + 文件名（`…/intercept/applicationnav/Foo.java`），完整长路径在这里没有信息量
- `↑`/`↓` 选择，`Enter` 切换，`Esc` 一次收起（同时关面板和输入框）
- 选中后：输入框收起、路径更新、URL 的 `path` 同步、历史列表重新加载
- 没有高亮候选时按 `Enter`：支持直接贴完整路径，或取最佳模糊匹配
- 全部文件从 `GET /api/repos/:id/files` 取（18k 文件 `ls-files` 约几十毫秒），首次点开时懒加载

**从右上角按钮进入**（URL 带 `focus=1`）时：

- 若当前已选中文件，就打开那个文件的​历史，同时聚焦路径框方便切走
- 若还没选文件，路径框显示「搜索文件…」，列表区提示「在上方输入路径或文件名」，不加载任何历史

**`fuzzyScore` 已抽到 `public/fuzzy.js`**，主界面和历史页共用同一份实现（之前在主界面 app.js 里，历史页没法 import）。

### 页面特征

- 列表每条：作者色块（同名同色）+ 日期 + `+增 −删` + sha + 摘要
- 路径**只在必要时显示**：改名时显示差异片段（`…/platformv2-unit/… → …/jmpt-unit/…`），或路径与当前不同才显示。同一文件每行重复长路径没意义
- diff 带**双行号**，`j`/`k` 键上下切换
- 顶部可关「跟踪改名」，关掉后只剩改名之后的历史
- 分隔线可拖动，宽度记在 `localStorage`

### 三个必须处理的坑（都在真实仓库上验证过）

**① 取 diff 必须用「当时那个路径」**

文件改名后，改名前的 commit 里它叫旧名字。用新路径去 diff 会得到**空结果**——不是报错，是静默空。

实测（`old/name.txt` → `new/name.txt`）：

```
用旧路径 old/name.txt 取 c2 的 diff → 140 字节 ✓
用新路径 new/name.txt 取 c2 的 diff →   0 字节 ✗
```

所以每条历史记录都带 `pathAtCommit`，diff 接口用它而不是用户传入的当前路径：

```js
const params = new URLSearchParams({ sha: c.sha, path: c.pathAtCommit })
```

**② 中文路径会被转义**

这个仓库有大量中文文件名。git 默认把非 ASCII 转成 `\345\207\275` 形式，界面上是乱码，回传给 diff 时路径也对不上。

```bash
$ git log --name-only -- "data/.../[1-1][01]STUFF函数.sql"
"data/.../[1-1][01]STUFF\345\207\275\346\225\260.sql"    # 转义了

$ git -c core.quotepath=false log --name-only -- ...
data/.../[1-1][01]STUFF函数.sql                          # 正确
```

`lib/git.mjs` 因此加了 `quotepath: false` 选项，内部注入 `-c core.quotepath=false`。注意项目里设了 `LC_ALL=C`，实测该选项在 C locale 下仍然有效。

另外路径统一加 `:(literal)` 前缀，防 `[ ]` `*` `?` 被当通配符（实测这个仓库的 `[1-1][01]` 形态不传也不会错，但加着更稳）。

**③ 解析 `--numstat -z` 的输出格式**

用 numstat 而不是 name-status，是因为要显示 `+12 −3`（name-status 没有行数，得多跑一次 git）。`-z` 模式下改名条目长这样：

```
0\t0\t\0旧路径\0新路径\0
20\t19\t路径\0
```

两个坑：

- **记录边界不是 `\n\x01`**。`-z` 模式路径以 `\0` 结尾、不产生换行，下一条头部直接跟在 `\0` 后面，所以不能用换行做分隔。
- **`\x01` 同时用于记录边界和字段分隔**，直接 split 会把一个提交切成 4 段。正确做法是按「`\x01` 后紧跟 40 位 hex」做锚点切分：

```js
const parts = stdout.split(/(?=\x01[0-9a-f]{40}\x01)/)
```

**④ `--follow` 不能分页**

`--follow` 内部会重写路径跟踪逻辑，和 `--skip` 混用会错乱。所以一次性取全量、上限 500 条（超出标记 `truncated`），不做「加载更多」。

---

## 切换分支：支持 tag

「切换」对话框里可以切到分支，也可以切到 tag（进入 detached 状态）。

### 三个入口

| 方式 | 说明 |
|---|---|
| 列表里的 tag 分组 | 排在**最前面**（远程分支动辄一两百条，tag 放后面等于看不见）。每行显示 commit sha、`tag` / `轻量 tag` 徽章、相对时间 |
| 顶部搜索框 | 用 `fuzzyScore` 同时过滤本地分支、远程分支、tag。比如输 `5.5.13` 能列出所有相关 tag |
| 底部「或切到指定提交」 | 接入自动完成，可模糊搜索 tag / 本地分支，也支持直接粘贴 sha |

选中 tag 时提示文字会明确写「将以 detached 状态检出」，因为 tag 不是一个分支，切过去之后新提交不属于任何分支。

### 为什么不直接用 `git checkout <tag>`

遇到**同名 tag 和分支**时，git 的消歧行为不稳定。`git checkout same-name` 在既有 `refs/heads/same-name` 又有 `refs/tags/same-name` 时会走哪边，取决于 git 版本和具体的引用解析顺序，可能报错也可能静默选一个。

所以后端对 detachAt 做了显式判定：

```js
const asTag = await git(wtPath, ['rev-parse', '--verify', '--quiet', `refs/tags/${detachAt}`])
if (asTag.code === 0) {
  args = ['checkout', '--detach', `refs/tags/${detachAt}`]   // 写全引用，零歧义
} else {
  // 不是 tag：先确认引用存在，否则给可读报错
  const exists = await git(wtPath, ['rev-parse', '--verify', '--quiet', detachAt])
  if (exists.code !== 0) return { ok: false, reason: 'ref-not-found', ... }
  args = ['checkout', '--detach', detachAt]
}
```

实测验证：同时存在分支 `same-name`（指向 c1）和 tag `same-name`（指向 c2）时，传入 `same-name` 稳定切到 **c2**（tag），且处于 detached。

### 引用不存在时的报错

不再转述 git 的模糊提示，而是给明确信息：

```
找不到 tag / 分支 / 提交：v9.9.9（如果 tag 在远端新建，先点「更新仓库」）
```

---

## 新建 worktree：自动完成与 tag 支持

### 五种创建方式

| 模式 | 说明 | 底层命令 |
|---|---|---|
| 新分支 | 从起点新建分支并检出 | `worktree add -b <br> <path> <base>` |
| 现有分支 | 检出已存在的本地分支（不能已被占用） | `worktree add <path> <br>` |
| 远程分支 | 自动去掉 `origin/` 建同名跟踪分支 | `worktree add --track -b <br> <path> <remote>` |
| **基于 tag** | 默认 detached 检出；可勾选同时建分支 | `worktree add --detach <path> refs/tags/<t>` |
| 指定提交 | 检出任意 commit / 分支 / tag | `worktree add --detach <path> <ref>` |

### 自动完成

分支名输入框、「起点」输入框、tag 模式的分支名输入框都接入了同一个自动完成组件（`attachAutocomplete`）。

**支持的输入形式**：

| 输入 | 命中 | 说明 |
|---|---|---|
| `hotfix` | `hotfix/h-tag-5.5.13.10-xxx` | 前缀 / 连续子串 |
| `h5.5.13` | `hotfix/h-tag-5.5.13.10-xxx` | **跨段**：`h` 匹配 `hotfix`，`5.5.13` 匹配后面 |
| `5.5.13` | 同上 | 纯版本号 |
| `建模` | `...-建模Agents功能移植_1015` | 中文 |
| `1016` | `...-问题修复1016` | 数字尾号 |
| `rel` | `release/487399-...` | 缩写 |

**键盘**：`↓` `↑` 移动（自动跳过被占用的分支）、`Enter` / `Tab` 选中、`Esc` 只关面板不关对话框。

**排序**：完全相同 1000 分 → 前缀 900 → 连续子串 720/640 → 跨段 560 → 子序列 300。同级时短名优先（`v5.5.3.46` 排在 `tmp/v5.5.3.46-xxx` 前面）。

### 模糊匹配的三个坑

**坑 1：跨段输入最常见，但按段比对会失败**

查 `h5.5.13` 时按 `/ - .` 切成 `['h5','5','13']`，但 `h5` 里的 `h` 属于 `hotfix` 段、`5` 属于 `5.5.13` 段。单纯按段比对直接返回 null。

解法：片段整段匹配失败且长度 > 1 时，拆成「首字符」+「剩余」，首字符去匹配段首，剩余插回队列继续匹配：

```js
if (found < 0 && part.length > 1) {
  const head = part[0]
  for (let i = si; i < segs.length; i++) {
    if (segs[i].startsWith(head)) {
      found = i
      if (part.slice(1)) qParts.splice(pi + 1, 0, part.slice(1))  // 剩余部分插回
      break
    }
  }
}
```

**坑 2：纯子序列兜底会引入大量噪声**

`tmp` 三个字符能在 `release/487399-jmpt_java-jmpt_java-R` 里按序找到（`j-m-p-t`… 顺序是 t→m→p），于是两个 release 分支也被列出来。实测这一条就产生了 2 条无关项。

解法：子序列只对长度 ≥ 3 的查询启用，且要求 `gaps <= query.length * 6`（字符必须相当紧凑地出现）。

**坑 3：被占用的分支不能选**

已被其它 worktree 检出的分支，创建/切换都会失败。所以在候选里标「占用」并设为 `disabled`，方向键移动时用「可选项索引表」跳过它们：

```js
const idxs = items.map((x, i) => (x.disabled ? -1 : i)).filter((i) => i >= 0)
const cur = idxs.indexOf(active)
const next = cur < 0 ? (delta > 0 ? 0 : idxs.length - 1) : (cur + delta + idxs.length) % idxs.length
active = idxs[next]
```

### 基于 tag 创建

后端 `mode: 'tag'` 的两种形态：

```js
// 只检出（默认）—— 看历史、复现某个版本的问题
{ path, mode: 'tag', base: 'v5.5.13.10', branch: '' }
// → git worktree add --detach <path> refs/tags/v5.5.13.10

// 同时建分支 —— 要在该版本基础上改代码（发 hotfix）
{ path, mode: 'tag', base: 'v5.5.13.10', branch: 'hotfix/from-5.5.13.10' }
// → git worktree add -b <branch> <path> refs/tags/v5.5.13.10
```

前置校验：

- tag 不存在 → 409 `tag-not-found`，提示「先更新仓库」
- 分支重名 → 409 `branch-exists`
- 分支被占用 → 409 `branch-in-use`

`/api/repos/:id/branches` 现在同时返回 `tags`，用 `%(*objectname)` 拿 annotated tag 剥离后的 commit：

```bash
git for-each-ref --format='%(refname)%00%(objectname:short)%00%(*objectname:short)%00%(creatordate:unix)' refs/tags
```

轻量 tag 的 `%(*objectname)` 为空，回退用 `%(objectname)`；有值说明是 annotated tag，界面标 `annotated`。

---

## 写操作的安全设计

这个工具定位是"轻量"，但删除不可逆。所有写操作遵循同一套规则。

### 1. 删除前置预检，把风险讲清楚

点「删除」不会直接删。先调 `worktree-preflight`，返回四档风险：

| risk | 含义 | 行为 |
|---|---|---|
| `clean` | 工作区干净，HEAD 上无独有 commit | 直接可删，分支保留 |
| `has-dirty` | 有未提交改动 | 列出全部改动文件，必须勾选确认框才能删 |
| `has-unpushed` | HEAD 有提交不在任何 `refs/heads`、`refs/remotes`、`refs/tags` 上 | **不提供删除**。即使传 `force:true` 也拒绝 |
| `locked` | 已锁定 | 提示先解锁 |

`has-unpushed` 的判定方式（实测有效）：

```bash
# 列出 HEAD 上所有不在其它引用上的提交
git -C <wt> log HEAD --not <除自身分支外的所有 refs> --format=%h%x1f%s
```

这是唯一能准确回答"删了会不会丢提交"的办法。`@{u}` 只能看上游，分支没设 upstream 就失效。

### 2. 路径与分支校验

- 创建时拒绝相对路径、拒绝在仓库目录内部创建
- 目标路径已存在则拒绝，并报告里面有几项内容
- 分支被其它 worktree 占用时拒绝，并指出是哪个 worktree

### 3. 绝不自动加 `--force`

`force` 只能由前端在用户显式确认后传。后端不猜测意图。

### 4. 杜绝 git 交互式挂起

`lib/git.mjs` 固定注入这些环境变量，防止 `pull --no-rebase` 之类操作弹出编辑器卡住进程：

```
GIT_EDITOR=true  GIT_PAGER=cat  GIT_ASKPASS=true  GIT_MERGE_AUTOEDIT=no
GIT_TERMINAL_PROMPT=0
```

---

## 批量清理的判定口径（重要）

「陈旧」没按常见的"多久没动"来做，因为那个口径在你的环境里是失效的：

> worktree 里文件的 mtime 在 `worktree add` 的瞬间就是"现在"。
> 所以**刚创建但从未使用的 worktree 看上去比一个三个月没碰的老 worktree 更"新"**。

真正的过滤条件是**「删了会不会丢东西」**，与时间无关：

```
可清理 = 非主工作树
       AND 未锁定
       AND 工作区干净（无未提交改动）
       AND HEAD 上的提交都已被某个 ref 覆盖
```

满足这四条时，删除不丢任何代码 —— 分支还在，提交还在。

时间只用于**标记和排序**：

- `idleDays` = 该分支最后一次提交距今多少天（不是文件 mtime）
- 超过阈值的打「建议清理」标签并**默认勾选**
- 未超期的打「可清理」但不默认勾选

界面上分两处呈现：候选列表（可删）+ 折叠的「未列为候选」列表（附排除原因）。

实测你的真实仓库：

```
jm_java  候选 1 个
           hotfix/...-主项问题修复1016        闲置=3天   suggest=false
         排除 2 个
           hotfix/...-建模Agents功能移植_1015  8 个提交未被任何分支/远程覆盖
           tmp/v5.5.3.46-...               有 1 个未提交改动

jm_net   候选 2 个（都是 detached，闲置 32 天 / 9 天，均 suggest=true）
```

---

## 查看指定 worktree 的提交日志

有三种方式，效果等价：

1. **顶部下拉框** `提交日志` 左边 —— 列出该仓库全部 worktree（带 `· 主` 标记和 `· N改` 脏文件数）
2. **点击 worktree 表格里的分支名** —— 直接把日志切到那个 worktree，该行出现蓝色竖条；双击行不再触发切换
3. **URL 参数**：`GET /api/repos/:id/log?rev=HEAD&wt=<worktree 绝对路径>`

选过的 worktree 会记在浏览器里（localStorage key `wsl-worktree.logWt`，按仓库各存一份），刷新或重开标签页后自动恢复。恢复时**先按分支名匹配，再按目录兜底** —— worktree 删掉重建目录会变，分支才是用户想看的那个；两者都匹配不上时回退主工作树。

日志区右上角的**刷新图标**（hover 有提示）重新拉取当前 worktree 的日志和未提交改动摘要。翻页没有按钮：滚到列表底部再继续滚，会自动加载下一页，直到某页不足 200 条为止。

右上角的灰色小字会显示当前的 git 工作目录（`~/codes/jm_java-worktrees/xxx`），用来确认看的是哪个。

### 两种视图语义的区别

| 视图 | 含义 |
|---|---|
| **当前分支**（`rev=HEAD`）| 该 worktree 自己的 HEAD 历史。**各 worktree 结果不同** —— 这是"看指定 worktree 日志"的正确姿势 |
| **全部分支**（`rev=--all`）| 跨所有引用的完整历史。**各 worktree 结果相同**，因为 `--all` 遍历的是共享的 `refs/`，与 cwd 无关 |

选「全部分支」时切 worktree 不会有变化，这不是 bug —— worktree 之间共享同一个对象库和 refs，只有 HEAD、索引、工作区是各自的。

### 为什么必须切 cwd

`git log HEAD` 中的 `HEAD` 属于**单个 worktree**（`.git/worktrees/<name>/HEAD`）。在主仓库目录下执行，永远只能拿到主工作树的 HEAD。要看待某个 worktree 的 HEAD，必须把 git 的 cwd 设成那个目录：

```bash
git -C /home/wangy/codes/jm_java-worktrees/xxx log HEAD
```

后端 `/api/repos/:id/log` 的 `wt` 参数做的就是这件事。传参会先经 `resolveWorktree()` 校验必须是该仓库已注册的 worktree，`wt=/etc` 之类返回 400。

### 验证结果

`test/api/test-log-per-wt.mjs`（接口级）实测 jm_java 的 4 个 worktree：

```
[主] tmp/v5.5.10.55-...        log首条=f262fa06  worktree.head=f262fa06  PASS
     hotfix/...-主项问题修复1016   log首条=e73da026  worktree.head=e73da026  PASS
     hotfix/...-建模Agents移植     log首条=32c13970  worktree.head=32c13970  PASS
     tmp/v5.5.3.46-...          log首条=b5866c56  worktree.head=b5866c56  PASS

首条 commit 去重后 4 个 / 共 4 个 worktree   → 隔离生效
--all 在两个 worktree 下结果相同: PASS      → 符合预期
wt=/etc → 400 unknown worktree              → 拒绝越权
```

---

## 实测性能

| 操作 | 耗时 |
|---|---|
| 扫描 33 个仓库（全部 `worktree list`）| **141 ms** |
| 单仓库 4 个 worktree 含 status | **84 ms** |
| `log -n 200`（jm_java，大仓库）| **6 ms** |
| commit 文件清单（43 个文件）| **11 ms** |
| 单文件 diff | **5–8 ms** |
| 进程常驻内存 | 17 MB |

对比：Fork + wslgit 桥接一次刷新 5.8 秒。

---

## 文件结构

```
wsl-worktree/
├── server.mjs              HTTP 服务 + 路由
├── config.json             本机配置（不入库，从 config.example.json 复制）
├── config.example.json     配置模板
├── install.sh              安装/更新 systemd user 服务（模型 A：直接跑源码）
├── deploy.sh               兼容旧命令，等同于 install.sh
├── wsl-worktree.service.in systemd user unit 模板
├── .gitattributes          行尾锁 LF
├── .gitignore              排除 shots/、config.json 等
├── lib/
│   ├── git.mjs             spawn 封装 + 并发限流 + 防交互挂起
│   ├── config.mjs          配置加载 + 设置页写回
│   ├── open.mjs            WSL/Linux 外部程序打开（UNC / xdg-open / 终端参数）
│   ├── scan.mjs            仓库扫描 + porcelain 解析
│   ├── numstat.mjs         numstat -z 解析（含重命名）
│   ├── ops.mjs             全部写操作（fetch/pull/checkout/create/remove/stale）
│   ├── history.mjs         单文件历史（--follow / 改名路径 / numstat -z 解析）
│   ├── tree.mjs            完整文件树（ls-tree -r -l -z / 文件内容读取）
│   ├── grep.mjs            在 commit 快照里按内容搜索（git grep -z 解析）
│   ├── refs.mjs            查 commit 上指向它的 tag / 分支（for-each-ref --points-at）
│   ├── compare.mjs         两个提交之间的变更清单与单文件 patch
│   ├── clone.mjs           克隆任务（长任务走 job + 轮询，解析 git 进度）
│   ├── changes.mjs         某个 worktree 的未提交改动（diff HEAD + 未跟踪）
│   └── logfmt.mjs          commit log 的输出格式与解析（多处共用）
├── public/
    ├── index.html          单页骨架
    ├── style.css           浅色主题
    ├── app.js              全部交互逻辑 + 对话框，零框架
    ├── open-remote.js      远程打开（vscode:// URI / ssh 命令）的字符串构造，纯函数
    ├── clipboard.js        复制到剪贴板（异步 API + execCommand 兜底），全站共用
    ├── settings.html        设置页：扫描/缓存/外部工具，只读端口与 host
    ├── settings.css         设置页样式
    ├── settings.js          设置页逻辑
    ├── fuzzy.js            模糊匹配（fuzzyScore / rankByFuzzy）
    ├── linkify.js          commit message 里的 URL 转链接（白名单 + 转义）
    ├── history.html        单文件历史页（独立标签页）
    ├── history.css         历史页样式（双栏）
    ├── history.js          历史页逻辑
    ├── symbols.js          从源码提取符号（类型/函数）+ 缩进建树
    ├── outline.js          右侧大纲面板：渲染、跳转、引用、滚动联动
    ├── patch-view.js       unified patch → 带行号表格（历史页 / 对比页共用）
    ├── splitter.js         左右分栏拖动（文件树页 / 对比页共用）
    ├── compare.html        提交对比页
    ├── compare.css         对比页样式
    └── compare.js          对比页逻辑
└── test/
    ├── unit/               纯逻辑测试（不打服务、不开浏览器）
    ├── api/                接口级测试；test-api.sh 是总入口
    └── ui/                 浏览器 UI 测试（CDP）
```

测试脚本按类型放在 `test/` 下，跑法见文末「测试」。

### 部署：直接跑源码（模型 A）

服务直接从源码目录启动，不再复制到 `~/.local/share/wsl-worktree`。改完源码重启即可，不会出现“源码改了、跑的还是旧副本”。

```bash
bash install.sh          # 首次安装 / 更新服务（自动找 node、生成 unit、重启）
# 旧命令仍可用，等价于上面这条：
bash deploy.sh
```

- `install.sh` 会把当前源码路径和 node 绝对路径写进 `~/.config/systemd/user/wsl-worktree.service`。
- WSL 和纯 Linux 通用；WSL 下如果仓库在 `/mnt/c`、`/mnt/e`，脚本会提示 git 扫描会变慢，建议把仓库放到 WSL 原生路径。
- 旧的 `~/.local/share/wsl-worktree` 不再使用，确认无误后可手动删除。
- 没有 systemd 的环境（部分 WSL 发行版）脚本会打印前台运行命令：`node server.mjs`。

---

## 配置

`config.json` **不在仓库里**（它含本机绝对路径，已列入 `.gitignore`）。克隆后从模板复制一份：

```bash
cp config.example.json config.json
# 改 roots（至少一个）；roots/深度/缓存/补丁上限/外部工具也能在「设置」页里改
```

```json
{
  "port": 7801,
  "roots": ["/home/wangy/codes"],
  "scanMaxDepth": 4,
  "stateCacheMs": 2000,
  "scanCacheMs": 10000,
  "maxPatchBytes": 2097152,
  "apps": {
    "fileManager": { "command": "", "args": [], "pathStyle": "auto" },
    "terminal":    { "command": "", "args": [], "pathStyle": "auto" },
    "editor":      { "command": "", "args": [], "pathStyle": "auto" }
  }
}
```

- `roots`：扫描根目录，至少一个（「设置」页最多 10 个）。支持 `~/codes`，会展开为当前用户家目录；不允许 `/`
- `scanMaxDepth`：递归深度（「设置」页范围 1–12）
- `stateCacheMs` / `scanCacheMs`：status 与仓库列表的缓存时间，0–60s / 0–600s
- `maxPatchBytes`：单个 patch / 文件内容的字节上限，64 KiB–64 MiB
- `host`：不写时纯 Linux 监听 `127.0.0.1`（只允许本机），WSL 监听 `0.0.0.0`（Windows 浏览器通常要通过这个地址访问 WSL 端口）。显式写在 config.json 里的值优先。即使监听 `0.0.0.0`，Host 也只接受 `localhost`、IP 字面量或配置里的主机名（防 DNS rebinding）；局域网访问请直接用 IP，注意暴露风险
- `port` / `host` 是**只读项**，设置页只展示不写入；它们决定服务怎么监听，必须手改配置后重启
- `apps`：四类外部程序（文件管理器 / 终端 / 编辑器 / Zed）。`command` 留空 = 自动检测；`args` 里 `{path}` 会替换成目标路径；`pathStyle` 为 `auto` / `native` / `windows`
  - WSL：`explorer.exe`、`wt.exe`、`code.cmd` 自动用 `\\wsl.localhost\<distro>\...`；Linux 原生程序用 `/home/...`
  - 纯 Linux：`xdg-open` / `dolphin` / `konsole` / `code` / `zed` 都用原生路径
  - Zed 单独一类（`apps.zed`）：留空会找 `zed` / `zeditor`，默认参数就是路径本身。只认 Linux 原生程序——Windows 版 `zed.exe` 接不了 WSL 路径，所以不做 Windows 侧检测
  - 终端留空时按命令自动补参数：Konsole `--workdir {path}`、GNOME Terminal `--working-directory {path}`、Windows Terminal 用 `wt -d <unc> wsl.exe -d <distro> --cd <path>`
- 旧的 `windows.explorer` / `windows.wt` / `windows.code` 仍然能读：没有 `apps` 时会自动映射成 `fileManager` / `terminal` / `editor`

**没有 `config.json` 也能跑**：端口 7801、roots 为 `~/codes`、外部程序全自动检测；监听地址纯 Linux 默认 `127.0.0.1`，WSL 默认 `0.0.0.0`。

`roots` / `scanMaxDepth` / 缓存 / `maxPatchBytes` / `apps` 在「设置」页保存后**立即生效**；`port` / `host` 只能手改 `config.json`，**重启后生效**。直接手改 `config.json` 的其他字段也需要重启。

---

## 设置页

右上角「设置」打开 `/settings.html`，分四块：

| 区块 | 字段 | 生效方式 |
|---|---|---|
| 扫描 | 根目录（至少一个，支持 `~/`，最多 10 个）、扫描深度 | 保存立即生效 |
| 高级 | `stateCacheMs`、`scanCacheMs`、`maxPatchBytes` | 保存立即生效 |
| 服务 | 端口、监听地址 | **只读**；手改 `config.json` 后重启 |
| 外部工具 | 命令、参数、路径样式 | 保存立即生效 |

页面顶部显示配置文件绝对路径；如果文件 JSON 坏了，会显示错误并禁用保存，后端也不会拿空对象覆盖用户的其他配置。

外部工具字段的说明：

| 字段 | 说明 |
|---|---|
| 命令 | 可执行文件绝对路径；留空 = 自动检测 |
| 参数 | 一行一个，`{path}` 会替换成 worktree 路径；留空时按程序补默认参数 |
| 路径样式 | `自动` / `Linux 原生路径` / `Windows UNC 路径` |

保存走 `POST /api/settings`，body 是 `{ apps?, config? }`：`config` 只接受 `roots` / `scanMaxDepth` / `stateCacheMs` / `scanCacheMs` / `maxPatchBytes`，传 `port` / `host` 会直接 400。保存后扫描缓存立即作废。设置页会显示当前平台和自动检测到的命令；检测不到时在卡片右上角给出原因。

几个例子：

```json
{
  "apps": {
    "terminal": { "command": "/usr/bin/konsole", "args": ["--workdir", "{path}"], "pathStyle": "auto" },
    "editor": { "command": "/usr/bin/code", "args": [], "pathStyle": "auto" },
    "zed": { "command": "/usr/bin/zed", "args": [], "pathStyle": "auto" },
    "fileManager": { "command": "", "args": [], "pathStyle": "auto" }
  }
}
```

WSL 下如果填 Windows 程序（`explorer.exe`、`code.cmd`、`wt.exe`），`pathStyle: auto` 会自动把路径转成 `\\wsl.localhost\<distro>\...`；`.cmd` / `.bat` 会经 `cmd.exe /c` 启动。纯 Linux 下填 `xdg-open` / `dolphin` / `konsole` / `code` 即可，路径保持 `/home/...`。

---

## WSL 与纯 Linux 的差异

| 能力 | WSL | 纯 Linux |
|---|---|---|
| 平台识别 | `WSL_DISTRO_NAME` / `/proc/sys/kernel/osrelease` | 默认 `linux` |
| 文件管理器 | 优先 `explorer.exe`（UNC） | `xdg-open` / `dolphin` / `nautilus` / `thunar` |
| 终端 | 优先 Windows Terminal（`wt -d <unc> wsl.exe --cd <path>`），也可用 Konsole 等 | `$TERMINAL` / Konsole / GNOME Terminal / kitty / alacritty / wezterm / foot / xterm |
| 编辑器 | 原生 `code` 用 Linux 路径；Windows `code.cmd` 用 UNC | `code` / `codium` / `cursor`，原生路径 |
| Zed | 原生 `zed`（要装在发行版内；Windows 版接不了 WSL 路径） | `zed` / `zeditor`，原生路径 |
| 服务 | systemd user（发行版需启用 systemd），否则前台跑 | systemd user，`install.sh` 自动生成 unit |

代码只在一个地方分支：`lib/open.mjs`。服务端和前端共用 `/api/config` 返回的 `platform` / `distro`；前端在纯 Linux 下隐藏「复制 Windows 路径」，只显示原生「复制路径」。

---

## 远程访问（浏览器不在服务器上）

典型场景：浏览器开在 Windows 上，服务跑在另一台 Linux 上。这时点「用 VS Code 打开」，`/api/open` 拉起的是**那台 Linux 桌面上的** VS Code（或者干脆没有图形会话，进程直接退出），你在 Windows 这边什么都看不到。服务器没法替你启动另一台机器上的程序，这是浏览器沙箱的边界，不是配置问题。

所以右上角有个「打开方式：本机 / 远程」：

| 入口 | 本机（默认） | 远程 |
|---|---|---|
| VS Code | `POST /api/open` → 服务器上的 `code` | 跳转 `vscode://vscode-remote/ssh-remote+<SSH 目标><路径>`，由浏览器所在电脑的 VS Code + Remote-SSH 接管 |
| Zed | 服务器上的 `zed` | 「复制 Zed 远程命令」→ `zed ssh://<SSH 目标><路径>` |
| 终端 | 服务器上的终端 | 「复制 SSH 登录命令」→ `ssh -t <SSH 目标> 'cd "<路径>" && exec $SHELL'` |
| 文件管理器 | 服务器上的文件管理器 | 不提供（Windows 资源管理器打不开 Linux 路径，除非另配 SMB） |

**偏好只存在浏览器里**，不进 `config.json`：

- `wsl-worktree.openMode`：`local` / `remote`
- `wsl-worktree.openSshTarget`：`user@host`、`host`、`host:port`，或 `~/.ssh/config` 里的别名

换浏览器 / 换电脑要重设——这是对的：它描述的是「这个浏览器在哪台机器上」，不是服务端的属性。服务端也不该去猜客户端 IP（loopback 判断在同机代理、NAT、容器转发下都不可靠）。

几个实现上的取舍：

- SSH 目标只允许 `[A-Za-z0-9_.@:-]`，因为它会被拼进 URI 和命令行，带空格分号引号一律拒绝，并在输入框下方标红说明。
- VS Code 的 URI 是纯浏览器跳转，服务端无法知道有没有真的打开；协议没注册时浏览器自己会问一句。VS Code 那边要能用同一个名字 `ssh`（Remote-SSH 的 `ssh-remote+<名字>` 走的就是它）。
- Zed 和终端只**复制命令**不执行：`zed ssh://` 的支持跟 Zed 版本有关，用户可以看清命令再决定回车。
- 路径里出现引号、`$`、反斜杠时，SSH 命令退化成只登录（`ssh -t <目标>`），不拼 `cd`——PowerShell / bash / cmd 的转义规则不一致，给一条"看起来对但会 cd 到错地方"的命令更糟。
- 远程模式下本地的那几项直接不显示，而不是点了才报错。

### 为什么「复制命令」会失败（页面是 http://<IP>）

`navigator.clipboard` **只在安全上下文里存在**：https 或 localhost 才有。从 Windows 打开 `http://192.168.x.x:7801` 时它不是"拒绝"，而是整个 `undefined`，直接 `undefined.writeText` 抛 TypeError。实测同一个页面：

```
http://127.0.0.1:7801/  → isSecureContext true,  navigator.clipboard 有
http://10.20.57.6:7801/ → isSecureContext false, navigator.clipboard undefined
```

`public/clipboard.js` 的 `copyText()` 因此分两条路：

1. 安全上下文 → `navigator.clipboard.writeText`
2. 否则（或第 1 步抛错）→ 临时 `textarea` + `document.execCommand('copy')`。这个 API 已废弃，但在非安全上下文里仍然可用（已用真实鼠标手势在 `http://<LAN IP>:7801` 上实测返回 true）。

两条都失败时**不会**把文本塞进 toast（toast 2 秒就消失，长命令根本看不清），而是弹一个已聚焦、已全选的只读文本框，让用户 Ctrl+C。

页面继续用 http：给一个内网工具加证书的维护成本比这个兜底高。

字符串拼装全在 `public/open-remote.js`（纯函数，无 DOM），主界面只负责按 `openMode` 换菜单项。

---

## 仓库与提交

本目录是一个独立 git 仓库（`main` 分支）。几个约定：

**行尾锁死为 LF**（`.gitattributes`）。这个项目可能在 Windows 编辑、在 WSL / 纯 Linux 执行，如果 `install.sh` 被转成 CRLF，在 Linux 里会报 `bad interpreter: /usr/bin/env bash^M`，极难排查。所以：

```
* text=auto eol=lf
*.sh text eol=lf
```

**不入库的内容**：

| 路径 | 原因 |
|---|---|
| `shots/` | UI 测试截图，每次跑测试都重新生成 |
| `config.json` | 含本机绝对路径，用 `config.example.json` 作模板 |
| `*.log` / `node_modules/` / `.?.mjs` | 运行产物、依赖、一次性调试脚本 |

截图不入库，`.git` 体积随提交历史增长。

## API

| 端点 | 说明 |
|---|---|
| `GET /api/config` | 当前配置 + `platform`（`wsl` / `linux`）+ WSL 发行版名 |
| `GET /api/settings` | 已保存配置 + 运行中的值 + 外部程序自动检测结果 + 配置文件路径（设置页用） |
| `POST /api/settings` | `{apps?, config?}`：`config` 只接受 `roots`/`scanMaxDepth`/`stateCacheMs`/`scanCacheMs`/`maxPatchBytes`；`port`/`host` 只读 |
| `GET /api/repos[?force=1]` | 仓库列表 + worktree 计数 |
| `GET /api/repos/:id/worktrees[?force=1]` | worktree 详情（含 status） |
| `GET /api/repos/:id/log?rev=&skip=&count=&wt=` | 提交日志，`wt` 指定在哪个 worktree 里执行 |
| `GET /api/repos/:id/commit/:sha` | commit 的文件清单 |
| `GET /api/repos/:id/diff?sha=&path=&mode=` | 单文件 patch |
| `GET /api/repos/:id/branches[?wt=]` | 本地 + 远程分支 + tag；传 `wt` 时「当前分支」按该 worktree 算，不传则按主工作树 |
| `GET /api/repos/:id/file-history?path=&wt=&follow=0&rev=` | 单文件历史（含 pathAtCommit / 增删统计 / 改名信息） |
| `GET /api/repos/:id/file-history-diff?sha=&path=&wt=` | 某个 commit 里该文件的 diff（path 必须是当时的路径） |
| `GET /api/repos/:id/tree?sha=&wt=` | 某提交的完整文件树（sha 会解析成完整值） |
| `GET /api/repos/:id/file-content?sha=&path=&wt=` | 某提交里某文件的内容（二进制/超大文件单独标记） |
| `GET /api/repos/:id/grep?sha=&q=&path=&i=1&re=1` | 在提交快照里按内容搜索（git grep） |
| `GET /api/repos/:id/commit/WORKTREE?wt=` | 未提交改动清单（工作区+暂存 vs HEAD） |
| `POST /api/clone` | 启动克隆任务，body: { url, dir, depth1?, submodules? } → { id } |
| `GET /api/clone/:id` | 查克隆进度 { status, phase, percent, rate, error } |
| `GET /api/repos/:id/ref-log` | 全部 tag / 分支尖端指向的提交（对比页搜索用） |
| `GET /api/repos/:id/compare?a=&b=` | 两提交间的变更文件（状态/增删/改名），rev 支持 sha/tag/分支 |
| `GET /api/repos/:id/compare-file?a=&b=&path=&old=` | 单文件 patch；改名文件必须同时传 old |
| `GET /api/repos/:id/refs-at?sha=&wt=` | 该提交上的 tag 与分支（annotated 会标记） |
| `GET /api/repos/:id/files` | 全部已跟踪文件（git ls-files） |
| `POST /api/open` | `{target:'fileManager'\|'terminal'\|'editor'\|'zed', path}`；兼容旧名 `explorer` / `wt` / `vscode`。`path` 必须是扫描结果里的 worktree |

写操作（全部 `POST`，路径前缀 `/api/repos/:id/`）：

| 端点 | body | 说明 |
|---|---|---|
| `fetch` | `{prune?:bool, forceTags?:bool}` | 更新仓库所有远程；`forceTags` 才会覆盖被重打的 tag |
| `tag-inspect` | `{tag}` | 查某 tag 的本地/远端 sha（冲突时用于展示）|
| `pull` | `{wt, mode:'ff-only'\|'rebase'\|'merge'}` | 更新某个 worktree 的分支；返回 `changed` / `incoming` / `before` / `after` 供界面区分「已是最新」 |
| `checkout` | `{wt, branch?, detachAt?, create?, startPoint?, force?}` | 切换分支；`detachAt` 可传 tag 名（后端写成 `refs/tags/<tag>` 消除歧义）/ 分支名 / sha；`force:true` 会 `checkout -f` 丢弃本地改动 |
| `worktrees` | `{path, branch, mode:'new'\|'existing'\|'remote'\|'tag'\|'detach', base?, lock?}` | 创建；`mode:'tag'` 时 `base` 为 tag 名，`branch` 非空则同时建分支 |
| `worktree-preflight` | `{path}` | 删除前预检（只读） |
| `worktree-remove` | `{path, force?}` | 删除 |
| `stale-scan` | `{staleDays?}` | 扫描可清理项 |
| `stale-clean` | `{paths?, staleDays?, dryRun?}` | 批量清理 |

写操作返回 `200`（成功）或 `409`（业务拒绝），body 里 `reason` 字段给出具体原因（`branch-in-use` / `path-exists` / `needs-force` / `has-unpushed` / `diverged` / `no-upstream` / `conflict` / `is-main` 等），前端据此渲染中文提示。

`:id` 是 toplevel 路径的 base64url —— 路径含中文/空格，不能用原始字符串做 URL 段。服务端会校验它是真正的 git 仓库根；`/api/open` 还会校验路径来自扫描结果，避免被当成任意路径启动器。

安全默认值：监听 `127.0.0.1`；所有 `POST` 必须是 `application/json`，并校验同源 `Origin` / `Sec-Fetch-Site`；请求体上限 1MB；静态文件带 ETag。

---

## 服务管理

```bash
systemctl --user status wsl-worktree    # 状态
systemctl --user restart wsl-worktree   # 重启
systemctl --user stop wsl-worktree      # 停止
journalctl --user -u wsl-worktree -n 50 # 日志
```

`install.sh` 会 enable 服务，登录后自动运行。WSL 用 systemd 需要该发行版启用 systemd；没有的话直接前台跑 `node server.mjs`。

几个部署细节：

- unit 里 `Environment=PATH=<node目录>:/usr/local/bin:/usr/bin`，nvm 装的 node 不会因为 systemd 的 PATH 而找不到
- `KillMode=process`：服务重启时不会把已经打开的 Konsole / Dolphin 一起杀掉
- 需要 `SSH_AUTH_SOCK`、`DBUS_SESSION_BUS_ADDRESS` 等桌面会话变量时，写进 `~/.config/wsl-worktree/env`（systemd `EnvironmentFile`，可选）
- 纯 Linux 下如果服务在登录前启动、拿不到 Wayland/X11 变量，把 `loginctl enable-linger $USER` 打开，或把变量放进上面的 env 文件

---

## 实现中踩到的坑（都已修复，改代码时注意）

1. **两级限流不能共用一个 limiter**
   `/api/repos` 外层持槽等内层 status，共用一个实例会死锁 —— 表现为请求永久挂起。必须 `repoLimit` / `statLimit` 分开。

2. **`git log -n=200` 是错的**
   长选项带等号只对 `--skip=` 这类有效，`-n` 必须 `-n 200` 分开传，否则 `fatal: '=5': not an integer`。

3. **`git show <merge-commit>` 默认不出 patch**
   查看 merge commit 的改动必须取 first-parent 语义：`git diff <p1> <sha>`。root commit 反过来要用 `git show`。`getCommitStat` / `getFileDiff` 现在都先取 parents 再分支处理。

4. **`worktree list --porcelain -z` 不是空行分块**
   `-z` 下是 `\0` 分隔的 token 流（`worktree /path\0HEAD sha\0branch refs/..\0\0`），解析逻辑与默认格式完全不同。`prunable <reason>` 和 `locked <reason>` 都带后半段。

5. **`numstat -z` 的重命名是两个额外 token**
   `0\t0\t\0oldpath\0newpath\0`。不能用非 `-z` 的 `{old => new}` 格式。

6. **`table-layout: fixed` 配 `max-width:1px` 会重叠**
   标准的 `max-width:1px` 省略号技巧只在 auto 布局下成立。fixed 布局改成 `td { overflow:hidden; text-overflow:ellipsis }`。

7. **`td` 需要显式 `overflow: hidden`**
   fixed 布局下 `td` 内容超宽会溢出到相邻列，视觉上是文字重叠。

8. **`%(refname:short)` 会产生伪分支 `heads/`、`origin/`**
   当分支名本身形如 `heads/xxx` 或远程名恰好构成前缀时，`:short` 的消歧输出无法与去前缀结果区分。必须用完整 `%(refname)` 再手工剥 `refs/heads/` / `refs/remotes/` 前缀。

9. **`%(HEAD)` 为空时 git 输出 `\0 ` （NUL + 空格）**
   用 `\0` 做字段分隔符时，最后一段不是空串而是 `" "`。每段都要 `.trim()`，否则 `isEmpty` 判断和后续字段都会错位 —— 表现为某些分支 mysteriously 消失。

10. **`%1f` 不是可靠的格式分隔符**
    旧版 git 不识别 `%1f`，会原样输出字面量 `%1f`，把整行糊成一列。用 `%00`。

11. **GET 路由必须先判 method**
    `/worktrees` 同时是 GET（列表）和 POST（创建）。路由只匹配路径不判 method 时，POST 会被 GET 分支吞掉，返回 200 + 列表数据，前端看起来"创建成功了但没创建"。

12. **用文件 mtime 判断 worktree 活跃度是错的**
    `worktree add` 的瞬间所有文件 mtime 都是"现在"，刚创建的空 worktree 比三个月没动的老 worktree 更"新"。活跃度要用分支 HEAD 提交时间。

---

## 边界情况处理

| 场景 | 表现 |
|---|---|
| detached HEAD | 分支列显示 `(detached @ abc1234)`；拉取按钮禁用 |
| bare 仓库 | 状态列显示 `bare` 徽章 |
| 手删了 worktree 目录 | 状态列显示 `待清理`；清理对话框中标为「残留」 |
| 锁定 | 状态列显示 `锁定`，hover 显示原因；不可删 |
| status 读取失败 | 改动列显示 `?`，不中断整表 |
| 路径含空格/中文 | 全程 `-z` 解析 + spawn 数组传参 |
| 窄屏（<1180px）| 详情面板变右侧抽屉，点 commit 自动滑出；表格横向滚动 |
| 分支被占用 | 切换/创建时明确报错并指出占用它的 worktree |
| 分支无 upstream | 拉取时提示 `no-upstream`，不静默失败 |
| 拉取时已经是最新 | 文案明确「已经是最新」，主按钮退成「关闭」不再高亮，避免误以为没成功 |
| 切分支时本地有改动 | 列出会丢的文件，提供「放弃这些改动并切换」，需点两次确认；`-f` 不动未跟踪文件 |
| 窗口变窄 | 顶栏按钮不换行（nowrap + flex:none），收缩交给仓库路径做省略 |
| 日志摘要很长 | ref 标签排在文本前面，不会被 ellipsis 吃掉 |
| 主工作树 detached | 切分支对话框仍能标出目标 worktree 自己的当前分支（`branches?wt=`） |
| 本地远程已分叉 | `--ff-only` 报 `diverged`，可改用变基 |
| 认证失败 | 提示"在终端里执行一次 fetch 以缓存凭据" |
| 远端重打了 tag | **不算失败**：分支照常更新，对话框列出冲突 tag 的本地/远端 sha，默认保留本地 |
| tag 与分支同名 | 切换/创建时优先当 tag 处理（写全 `refs/tags/<tag>`），行为确定 |
| 切到 tag / commit | 处于 detached 状态，界面明确提示；新建或创建 worktree 也支持 |
| 有未推送提交的 worktree | 拒绝删除，列出那些 commit |
| commit 里带 URL | 自动变可点链接，新标签页打开；点链接不会误选中 commit |
| commit 里含 `javascript:` / `data:` | 不生成链接（协议白名单） |
| URL 后面紧跟中文标点 | 「。」「，」「）」等视为边界，不进 URL |
| 文件被改名后查历史 | `--follow` 追到改名前；每条记录带当时的路径，diff 才不会空 |
| 中文 / 含空格 / 方括号的文件名 | `core.quotepath=false` + `:(literal)` pathspec，全程不转义 |
| 文件从未提交过 | 历史页明确提示「当前分支上没有历史」，区别于加载失败 |
| 点历史条目时有多个请求在飞 | 用 sha 比对丢弃过期响应，避免快速点击时 diff 串台 |
| 路径搜索输入过于精确 | 只匹配到 1 条也正常显示；无匹配显示「没有匹配的文件」 |
| 历史页没带 path 打开 | 路径框显示「搜索文件…」，列表提示先选文件，不加载历史 |
| 路径框打开但没输入就按 Esc | 一次收起（面板未展开时不拦截事件，直接交给外层处理） |
| 文件树里 18k 文件 | 只渲染展开路径上的节点；默认展开第一层 35 目录 + 28 文件 |
| 打开超大文件（>512KB） | 不高亮、按纯文本显示；>2MB 直接提示不展示 |
| 文件内容里有 `<script>` | 高亮输出前全部转义；纯文本路径用 textContent |
| 认不出扩展名（LICENSE 等） | 不高亮，不显示语言名，不瞎猜 |
| 在旧提交里搜内容 | `git grep <commit>` 搜对象库，结果与那次提交一致（不是今天的磁盘） |
| 搜索词含 `$(` `[` 等正则元字符 | 默认按字面量（`-F`），不会报错；需要正则时勾选 |
| 搜索命中过多（>2000 处） | 截断并标记「已截断」，避免宽正则刷爆内存 |
| 中文路径的搜索结果 | `core.quotepath=false`，路径原样返回，可直接用于打开文件 |
| 提交上没有 tag | 徽章整块隐藏，不留空白 |
| annotated tag | 用 `--points-at` 识别（不是比较 sha），实色填充区分于轻量 tag |
| 一个提交带多个 tag | 显示前 3 个，其余折叠成 `+N`（hover 看全部） |
| 短 sha 查 tag | 接口内部 `rev-parse` 解析，传 `7fc0607` 也能用 |
| 文件树里搜同名文件 | 文件名精确/前缀命中优先于路径模糊分；过滤结果行内显示所在目录 |
| 每级只有一个子目录的长链 | 默认合并成一行（`com/mysoft/jmpt`），长链中间省略为 `src/…/common` |
| 目录既有文件又有唯一子目录 | 不合并（那是「真目录」），只合并其下的纯目录链 |
| 定位到深层文件 | 自动展开所在链；压缩后按真实 `path` 逐层判断，不按路径前缀递推 |
| 文件树里的大文件 / 二进制 | 超大（>2MB）提示不在浏览器展示；二进制只看大小，不塞进 JSON |
| 左栏收起 | 顶栏出现仓库切换器（带模糊搜索），不丢失换仓库的入口 |
| 同名仓库在不同目录 | 顶栏候选显示目录前缀（`products/asset`）区分 |
| 刷新页面 | 回到上次选中的仓库（hash 优先，localStorage 兜底），不再跳回第一个 |
| 上次的仓库被删除 | 自动回退到可用仓库，并把 URL hash 纠正为实际值 |
| 用带 `#repo=` 的链接打开 | 直接定位到该仓库，可用于收藏/分享 |

---

## 测试

```bash
# 纯逻辑（秒级，WSL / Linux 都能跑）
node test/unit/test-fuzzy.mjs
node test/unit/test-tree-model.mjs
node test/unit/test-highlight.mjs
node test/unit/test-linkify.mjs
node test/unit/test-symbols.mjs
node test/unit/test-open.mjs
node test/unit/test-config.mjs
node test/unit/test-log-wt.mjs
node test/unit/test-logfmt.mjs

# 接口级：自带隔离服务（7813）+ 临时仓库，跑完自动清理
bash test/api/test-api.sh

# 只跑某一组接口测试（先按 test-api.sh 的方式起服务，临时目录仍在仓库根的 .test-run）
BASE=http://127.0.0.1:7813 WT_TEST_TMP=$PWD/.test-run node test/api/test-ops.mjs

# Linux UI 冒烟：设置页保存 + 主界面菜单，以及日志切换/记忆/滚动加载（系统 Chrome，零依赖）
node test/ui/test-ui-settings.mjs
node test/ui/test-ui-log-switch.mjs
```

- `test/unit/test-clipboard.mjs`：`public/clipboard.js` 的兜底逻辑，用假 window / document 覆盖安全上下文、非安全上下文、异步 API 抛错、两条通道都失败、没有 document。
- `test/unit/test-open-remote.mjs`：`public/open-remote.js` 的纯函数测试，覆盖 SSH 目标校验（空串/空格/分号/超长）、VS Code URI 与中文路径编码、SSH 命令的引号退化、Zed 远程命令。
- `test/unit/test-open.mjs`：`lib/open.mjs` 的纯函数测试，覆盖 Linux 原生路径、WSL UNC、`code.cmd`、`wt.exe` 特殊参数、Zed 默认参数、`{path}` 替换、非法路径样式。
- `test/api/test-api.sh`：依次跑 `test-ops` / `test-file-history` / `test-fetch-tag` / `test-tag-create` / `test-checkout-tag` / `test-pending` / `test-clone` / `test-settings`。临时目录用 `WT_TEST_TMP` 指定（默认在仓库根 `.test-run/`），不写死 `/tmp`（服务和测试进程可能不在同一个 mount namespace）。
- `test/api/test-log-per-wt.mjs` 只调 API，但依赖本机真实 `jm_java` 仓库和 worktree；没有就跳过。
- `test/ui/test-ui-settings.mjs` 是纯 Linux UI 测试：自动起隔离服务 + 系统 Chrome 的 CDP，验证设置页只读端口/host、配置文件路径、通用配置与四类工具保存落盘、主界面菜单按平台显示。可用 `CHROME=/path/to/chrome`、`UI_PORT`、`CDP_PORT` 覆盖。
- `test/ui/test-ui-log-switch.mjs` 也是纯 Linux UI 测试：造 450 个提交 + 一个 feat worktree，验证点分支名切换日志、双击不再切换、刷新后恢复记住的分支、刷新按钮拉到新 HEAD、滚到底自动翻页。同样支持 `CHROME` / `UI_PORT` / `CDP_PORT`。
- `test/unit/test-log-wt.mjs`：`public/log-wt.js` 的纯函数测试，覆盖按分支优先/目录兜底、detached、失效 worktree 回退。
- `test/unit/test-logfmt.mjs`：`parseCommitMessage` 的纯函数测试，覆盖只有标题、标题加正文、空输出。
- **`test/ui/` 下的旧脚本（`test-ui.mjs` 等、`test-layout.mjs`）仍是旧环境**：CDP 驱动 Edge、通过 `wsl.exe` 造仓库、部分依赖 `jm_java`。迁移到纯 Linux 需要抽公共启动器（Chrome / Chromium + 本地 fixture），这是后续工作；纯 Linux 上先以接口测试、上面两个 `test-ui-*.mjs` 和手工页面验证为准。
- UI 脚本结束前断言 `window.__errs` 为空；布局类测试用 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 发真实事件。

## 下一步

- **cherry-pick**：跨 worktree 摘提交 + 冲突三按钮处置
- **SSE 自动刷新**：文件变动推送，替代手动 `r`
- **lock / unlock 独立入口**（后端 `worktree lock` 已可用，缺 UI）
- **深色模式**
- **`j/k` 键盘导航**

试的时候重点看：**对话框的措辞够不够清楚、清理判定符不符合直觉、还缺什么**。
