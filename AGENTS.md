# AGENTS.md

给在本仓库里干活的 AI/人看的操作手册。**功能全貌、设计理由、踩过的坑在 `README.md`（唯一权威文档）**，本文件只讲“怎么改、别踩什么”。

## 这是什么

浏览器里管理 WSL 内所有 git 仓库 worktree 的单页工具。git 全部在 WSL 里执行，Node 原生 HTTP 服务，前端零框架零构建。

- 源码仓库（Windows）：`E:\ai-spaces\tools\wsl-worktree`
- 运行目录（WSL 原生）：`/home/wangy/.local/share/wsl-worktree`
- 服务：http://localhost:7801 （systemd user unit `wsl-worktree`，已 enable）
- `README.md` 里的性能和实测数据都来自本机真实仓库（`~/codes` 下 33 个仓库）

## 运行模型（最容易搞错的地方）

源码在 `/mnt/e`，**服务不是从这里跑的**。改完源码必须同步到 WSL 原生路径并重启：

```bash
wsl -e bash /mnt/e/ai-spaces/tools/wsl-worktree/deploy.sh
```

- `deploy.sh` 逐个文件比对 md5 —— `/mnt/e` 上 `cp -f` 偶发静默失败，校验不是可选项。
- 它只复制 `server.mjs`、`config.json`、`lib/*`、`public/*`、service unit，**不复制测试脚本**（测试脚本按需手动 cp，见下）。
- `config.json` 已 gitignore。新克隆的仓库若没有它，`deploy.sh` 会在 `cp_verify` 处失败退出；先 `cp config.example.json config.json`。
- 不要在 Windows 侧直接 `node server.mjs`：代码里的路径、`git` 调用、`/tmp` 都假定 Linux 环境。
- 改 `public/*` 后同样要 deploy；浏览器强制刷新即可，服务端只设 `cache-control: no-cache`，没有构建产物。

服务管理：

```bash
wsl -e systemctl --user status wsl-worktree
wsl -e systemctl --user restart wsl-worktree
wsl -e journalctl --user -u wsl-worktree -n 50
```

## 技术栈与代码风格

- Node ESM：服务端 `.mjs`，前端 `.js` 用原生 `import`（`import { fuzzyScore } from '/fuzzy.js'`，由静态服务按根路径提供）。
- **没有 `package.json`、没有 node_modules、没有构建、没有 lint、没有框架**。不要为此引入依赖；能零依赖实现就自己写（`highlight.js`、`fuzzy.js`、`tree-model.js` 都是这个原则的产物）。
- 2 空格缩进、单引号、**不写行尾分号**，以 `const` + 箭头函数为主。改代码顺着现有风格，不要整文件重排。
- 注释用中文，只写“为什么”和坑，不复述代码。`README.md` 的写法同理：先讲问题与实测数据，再讲实现。
- UI 全中文，错误文案直接来自后端的 `error`，前端不要硬编码英文提示。
- 前端不引入 innerHTML 信任：拼 HTML 前一律 `esc()`（`app.js` / `history.js` 各有本地实现），文件内容、commit message 都是不可信输入。

## 目录地图

| 路径 | 职责 |
|---|---|
| `server.mjs` | HTTP 服务、路由、缓存、并发限流；静态文件只服务 `public/` |
| `lib/git.mjs` | 唯一的 git 调用入口（spawn 数组传参 + 防交互挂起 + 超时/字节上限）、`createLimiter` |
| `lib/config.mjs` | 配置加载，无 `config.json` 时全用默认值 |
| `lib/scan.mjs` | 仓库扫描、`worktree list --porcelain -z` / `status --porcelain=v2` 解析、路径建议 |
| `lib/numstat.mjs` | `--numstat -z` 解析（含重命名双 token） |
| `lib/ops.mjs` | 全部写操作 + 预检 + 风险判定（fetch/pull/checkout/create/remove/stale） |
| `lib/history.mjs` | 单文件历史（`--follow`、改名路径、统计）、`ls-files` |
| `lib/tree.mjs` | 某 commit 的完整文件树与文件内容（`ls-tree -r -l -z`、`cat-file`） |
| `lib/grep.mjs` | 在提交快照里搜内容（`git grep`），命中上限截断 |
| `lib/refs.mjs` | `for-each-ref --points-at` 查某 commit 上的 tag/分支；`listRefTipCommits` 取所有 ref 尖端（`log --all --no-walk`） |
| `lib/logfmt.mjs` | commit log 的输出格式（`%x1f` 分隔 + `%x1e` 记录）与解析，server / refs 共用 |
| `lib/compare.mjs` | 两个提交之间的变更清单与单文件 patch（改名文件必须把新旧路径都传给 git） |
| `public/index.html` + `app.js` + `style.css` | 主界面：三栏（仓库/worktree+日志/详情）、对话框、布局持久化 |
| `public/history.html` + `history.js` + `history.css` | 单文件历史页（独立标签页） |
| `public/tree.html` + `tree.js` + `tree.css` | 完整文件树页（独立标签页），含右侧符号大纲 |
| `public/compare.html` + `compare.js` + `compare.css` | 提交对比页（选两个变更集，树只列有变更的文件） |
| `public/symbols.js` | 从源码提取类型/函数 + 缩进建树（纯逻辑，可单测） |
| `public/outline.js` | 符号大纲面板：渲染、跳转、本文件引用、滚动联动 |
| `public/patch-view.js` | unified patch → 带行号表格（历史页 / 对比页共用） |
| `public/splitter.js` | 左右分栏拖动（文件树页 / 对比页共用） |
| `public/fuzzy.js` | 模糊匹配，主界面/历史页/文件树共用 |
| `public/linkify.js` | commit message URL 转链接（协议白名单 + 转义） |
| `public/tree-model.js` | 纯逻辑建树 + 单链目录压缩 |
| `public/highlight.js` | 零依赖语法高亮（sticky 正则 + 兜底扫描） |
| `test-*.mjs` | 验收测试，接口级 / UI 级 / 纯逻辑级 |
| `shots/` | 测试截图产物，gitignored |

## 改一个功能的标准流程

1. **逻辑下沉到 `lib/`**：能纯函数化的（解析、建树、打分）单独成模块，方便直接测。
2. **加路由**：在 `server.mjs` 里加 `mXxx = p.match(...)`。注意：
   - 同一路径可能同时有 GET / POST，**先判 `req.method`**，否则 POST 会被 GET 分支吞掉（历史上真出过“创建成功了但没创建”）。
   - 所有以 `:id` 为参数的接口先 `dec()`；`id` 是 toplevel 路径的 base64url，不能直接用原始路径。
   - 凡是接收 `wt` 参数的，必须过 `resolveWorktree()` 校验，禁止任意路径。
   - 路由要放在 `if (p.startsWith('/api/'))` 的 404 兜底之前。
   - 写操作统一返回 `{ ok, action, reason?, error? }`，成功 200、业务拒绝 409（前端靠 `reason` 出文案），并在成功后清掉 `stateCache` / `scanCache`。
3. **前端**：新页面放 `public/`，独立 HTML + JS + CSS 一组；`public/` 之外的文件不会被服务。长耗时的次要信息（如 refs）拆成并行请求，不要拖慢主内容。
4. **补测试**（见下），**补 README**：新功能加一节，接口加进 API 表，测试命令加进「测试」清单，新坑写进「实现中踩到的坑」或「边界情况处理」表。
5. `deploy.sh` 后手工在浏览器过一遍，再跑相关测试。

## git 调用的硬规则

全部经 `lib/git.mjs` 的 `git(cwd, args, opts)`，`args` 永远是数组，**禁止拼 shell 字符串**（路径含空格/中文/方括号）。

- 路径类输出一律 `-z` 解析，并按格式手工处理：
  - `worktree list --porcelain -z` 是 `\0` 分隔的 token 流，不是空行分块；`head`/`branch` 等字段要 `.trim()`（`%(HEAD)` 为空时 git 会输出 `\0 `）。
  - `numstat -z` 的重命名是 `0\t0\t\0old\0new\0` 两个额外 token。
  - `-z` 之外的 `{old => new}` 格式不要用。
- 中文件名必须 `quotepath: false`（`git()` 的 `opts.quotepath`），pathspec 用 `:(literal)`，否则中文/方括号路径会错位。
- 字段分隔用 `%00` / `%x1f` / `%x1e`，**不要用 `%1f`**（旧 git 原样输出）；分支名用完整 `%(refname)` 再手工剥前缀，不要依赖 `%(refname:short)`。
- `git log` 分页参数分开传：`-n 200`，不能写 `-n=200`。
- merge commit 的改动取 first-parent：`git diff <p1> <sha>`；root commit 用 `git show`。不要指望 `git show <merge>` 出 patch。
- 两级并发不能共用一个 limiter（`repoLimit` / `statLimit` 必须分开），否则外层占槽等内层会死锁。
- 判断 worktree 活跃度用**分支 HEAD 提交时间**，不要用文件 mtime（`worktree add` 瞬间所有文件 mtime 都是“现在”）。
- 需要新增长操作时透传 `timeout` / `maxBytes`，依赖 `git()` 已注入的 `GIT_TERMINAL_PROMPT=0`、`GIT_EDITOR=true` 等防止交互挂起。

## 写操作的安全底线（不要为了让测试通过而放松）

- 删除先预检（`worktree-preflight`），四档风险必须原样呈现；`has-unpushed` 即使 `force:true` 也拒绝。
- 后端**绝不自动加 `--force`**，`force` 只能来自用户显式确认。
- 创建时校验：相对路径、仓库内部路径、目标已存在、分支被占用（要报出占用它的 worktree）。
- 批量清理的口径是「删了会不会丢东西」，不是「多久没动」：非主工作树 + 未锁定 + 干净 + HEAD 提交已被某个 ref 覆盖。
- 后端负责判定与中文解释，前端只做展示和二次确认。

## 测试

三类脚本，跑法不同：

- **纯逻辑**（`test-fuzzy.mjs`、`test-tree-model.mjs`、`test-highlight.mjs`、`test-linkify.mjs`、`test-symbols.mjs`）：Windows 或 WSL 都能跑，秒级。
- **接口级**（`test-ops.mjs`、`test-fetch-tag.mjs`、`test-tag-create.mjs`、`test-checkout-tag.mjs`、`test-file-history.mjs`）：**必须在 WSL 里跑**，它们用 `/tmp` 绝对路径造临时仓库；Windows 侧 node 会把路径变成 `\tmp\...`。脚本本身放在源码目录，需要先 cp 到运行目录再执行：

  ```bash
  wsl -e bash -c 'cd /home/wangy/.local/share/wsl-worktree && cp /mnt/e/ai-spaces/tools/wsl-worktree/test-ops.mjs . && node test-ops.mjs'
  ```

- **UI 级**（其余 `test-ui-*.mjs`、`test-layout.mjs`）：**在 Windows 里跑**，用 CDP 驱动 Edge headless 打开 `http://localhost:7801` 真实点击/输入，截图写进 `shots/`。每个脚本自带独立的调试端口（9233/9255/…），需要 Edge 装在 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；需要造临时仓库的 UI 脚本通过 `execFileSync('wsl.exe', ['-d','archlinux','-e','bash','-lc', ...])` 委托给 WSL。少数脚本会用真实仓库（如 `/home/wangy/codes/jm_java`）和真实 worktree，跑前确认环境，跑后自行恢复（脚本里用 finally 收尾）。
- **`test-log-per-wt.mjs`** 只调 API、不造仓库，但依赖本机真实 `jm_java` 及其 worktree 存在。

测前先 `deploy.sh`，否则测的是旧代码。测试脚本统一约定：

```js
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }
// …末尾
const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
```

- 每条断言都要能在失败时从 `detail` 看出原因；不写“只打印不判定”的检查。
- UI 脚本结束前断言 `window.__errs` 为空（页面装了 `error` 监听）。
- 测试脚本是验收证据，**不要删、不要改成永远通过**。UI 测试要真实点击/输入，布局类测试用 `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` 发真实事件。

## 不要做

- 不要提交 `shots/`、`config.json`、`node_modules/`、`*.log`、`.?.mjs`（一次性排查脚本用这个命名，用完删）。
- 不要改行尾：全仓库锁 LF（`.gitattributes`）。`deploy.sh` 变成 CRLF 会在 WSL 里报 `bad interpreter: /usr/bin/env bash^M`。
- 不要引入 package.json / 依赖 / 构建步骤 / 前端框架，除非有无法回避的理由并同步更新 README。
- 不要把绝对路径、用户名写进源码（配置走 `config.json`，默认值可用 `~/codes`）。
- 不要在生产路径上做破坏性手工实验；写操作测试一律在 `/tmp` 造的临时仓库里做。

## 提交风格

```
feat: 文件树顶栏显示该提交的发布标签（tag）
fix: 更新分支对话框在「已是最新」时的误导性高亮
docs: 补充配置与仓库约定说明
```

`feat:` / `fix:` / `docs:` + 中文短句，说清“用户看到的变化”，不写实现细节。

## 出问题先看

- 服务日志：`journalctl --user -u wsl-worktree -n 50`
- 接口是否旧代码：`deploy.sh` 是否真的成功（md5 校验有无 WARN）
- 数据不刷新：`scanCacheMs` / `stateCacheMs`；要强制刷新给请求加 `?force=1`
- 前端报错：Edge DevTools Console；UI 测试脚本里的 `window.__errs`
- 具体历史坑清单：`README.md` →「实现中踩到的坑」「边界情况处理」
