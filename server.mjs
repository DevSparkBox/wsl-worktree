import { createServer } from 'node:http'
import { isIP } from 'node:net'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname, basename, extname, posix, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, saveSettings, readSavedConfig, expandRoots } from './lib/config.mjs'
import { git, createLimiter } from './lib/git.mjs'
import { scanRepos, parseWorktreePorcelainZ, parseStatusV2, suggestWorktreePath } from './lib/scan.mjs'
import { parseNumstatZ } from './lib/numstat.mjs'
import * as ops from './lib/ops.mjs'
import { getFileHistory, getHistoryDiff, listFiles } from './lib/history.mjs'
import { listTree, catFile, listWorktreeFiles, readWorktreeFile } from './lib/tree.mjs'
import { getWorktreeChanges } from './lib/changes.mjs'
import { grepTree } from './lib/grep.mjs'
import { refsAtCommit, listRefTipCommits } from './lib/refs.mjs'
import { compareCommits, compareFile } from './lib/compare.mjs'
import { LOG_FMT, parseLog } from './lib/logfmt.mjs'
import { startClone, getClone, hasRunningClone } from './lib/clone.mjs'
import { openTarget, describeApps, normalizeApps, platformInfo } from './lib/open.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = await loadConfig()
const PLATFORM = platformInfo()
const APP_CTX = { isWsl: PLATFORM.platform === 'wsl', distro: PLATFORM.distro }
// 两级限流必须用独立实例，否则外层占满槽位后内层永远拿不到槽 → 死锁
const repoLimit = createLimiter(6)
const statLimit = createLimiter(8)

const enc = (p) => Buffer.from(p, 'utf8').toString('base64url')
const dec = (s) => Buffer.from(s, 'base64url').toString('utf8')

// ---------- 缓存 ----------
let scanCache = { at: 0, data: null }
const stateCache = new Map() // toplevel -> { at, data }

async function getRepos(force = false) {
  const now = Date.now()
  if (!force && scanCache.data && now - scanCache.at < cfg.scanCacheMs) return scanCache.data
  const repos = await scanRepos(cfg.roots, cfg.scanMaxDepth)
  scanCache = { at: now, data: repos }
  return repos
}

async function getWorktrees(toplevel, { withStatus = true } = {}) {
  const cacheKey = withStatus ? toplevel : `list:${toplevel}`
  const ttl = withStatus ? cfg.stateCacheMs : cfg.scanCacheMs
  const now = Date.now()
  const hit = stateCache.get(cacheKey)
  if (hit && now - hit.at < ttl) return hit.data

  const res = await git(toplevel, ['worktree', 'list', '--porcelain', '-z'])
  if (res.code !== 0) {
    const data = { error: res.stderr || `git exit ${res.code}`, worktrees: [] }
    stateCache.set(cacheKey, { at: now, data })
    return data
  }

  const list = parseWorktreePorcelainZ(res.stdout)
  const repoName = basename(toplevel)

  if (withStatus) {
    await Promise.all(
      list.map((wt) =>
        statLimit(async () => {
          if (wt.bare) { wt.dirty = 0; wt.ahead = 0; wt.behind = 0; return }
          const st = await git(wt.path, ['status', '--porcelain=v2', '--branch'], { timeout: 25000 })
          if (st.code === 0) {
            Object.assign(wt, parseStatusV2(st.stdout))
          } else {
            wt.dirty = -1
            wt.statusError = st.stderr.slice(0, 300)
          }
        })
      )
    )
  }

  const data = { repoName, toplevel, worktrees: list }
  stateCache.set(cacheKey, { at: now, data })
  return data
}

// ---------- 日志 / 对比 ----------
/**
 * 提交日志。
 * cwd 决定「在哪个 worktree 里看」：git 的 HEAD、索引、index 都属于单个 worktree，
 * 所以要在某个 worktree 里看它的 HEAD 历史，必须把 cwd 设成那个 worktree 的路径。
 */
async function getLog(cwd, { rev = '--all', skip = 0, count = 200 } = {}) {
  const args = ['log', rev, `--skip=${skip}`, '-n', String(count), `--format=${LOG_FMT}`]
  const res = await git(cwd, args, { timeout: 30000 })
  if (res.code !== 0) return { error: res.stderr, commits: [] }
  return { commits: parseLog(res.stdout) }
}

/**
 * 校验给定路径确实是该仓库的一个 worktree，防止任意路径穿越。
 * 返回规范化后的 worktree 记录；不合法则返回 null。
 */
async function resolveWorktree(toplevel, wtPath) {
  if (!wtPath) return null
  const data = await getWorktrees(toplevel, { withStatus: false })
  const list = data.worktrees || []
  const target = wtPath.replace(/\/+$/, '')
  return list.find((w) => w.path.replace(/\/+$/, '') === target) || null
}

/** 取 commit 的父提交列表 */
async function getParents(toplevel, sha) {
  const res = await git(toplevel, ['show', '-s', '--format=%P', sha])
  if (res.code !== 0) return []
  return res.stdout.trim().split(' ').filter(Boolean)
}

/**
 * 变更文件清单。
 * - root commit（无父）：用 show 的 numstat
 * - merge commit（多父）：取 first-parent 语义（与 Fork 默认一致），diff p1..sha
 * - 普通 commit：diff p1..sha
 * 统一走 diff 而不是 show，因为 `git show <merge>` 默认不出 patch。
 */
async function getCommitStat(toplevel, sha) {
  const parents = await getParents(toplevel, sha)
  let args
  if (parents.length === 0) {
    args = ['show', '--numstat', '--format=', '-z', '--find-renames', sha]
  } else {
    args = ['diff', '--numstat', '-z', '--find-renames', parents[0], sha]
  }
  const res = await git(toplevel, args)
  if (res.code !== 0) return { error: res.stderr, files: [], parents }
  return { files: parseNumstatZ(res.stdout), parents, isMerge: parents.length > 1 }
}

/**
 * 取单文件 diff。
 * @param {string} cwd  在哪个目录跑。worktree / staged 模式必须是**具体的 worktree 路径**，
 *                      不能是 toplevel —— 未提交的改动是各 worktree 独立的一份。
 */
async function getFileDiff(cwd, sha, path, mode = 'commit') {
  let args
  let allowExit1 = false
  if (mode === 'worktree') {
    // 未跟踪文件对 `git diff HEAD` 不可见，得跟 /dev/null 比；这种用法正常返回 1
    const tracked = await git(cwd, ['ls-files', '--error-unmatch', '--', path], { timeout: 8000 })
    if (tracked.code !== 0) {
      args = ['diff', '--no-index', '--no-color', '--no-ext-diff', '-U3', '--', '/dev/null', path]
      allowExit1 = true
    } else {
      args = ['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', path]
    }
  } else if (mode === 'staged') {
    args = ['diff', '--cached', '--no-color', '--no-ext-diff', '-U3', '--', path]
  } else {
    // 与 getCommitStat 保持同一语义：root 用 show，其余用 diff p1..sha
    const parents = await getParents(cwd, sha)
    if (parents.length === 0) {
      args = ['show', '--format=', '--no-color', '--no-ext-diff', '-U3', '--find-renames', sha, '--', path]
    } else {
      args = ['diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames', parents[0], sha, '--', path]
    }
  }
  const res = await git(cwd, args, { maxBytes: cfg.maxPatchBytes, timeout: 30000 })
  const ok = res.code === 0 || (allowExit1 && res.code === 1)
  return { patch: res.stdout.slice(0, cfg.maxPatchBytes), truncated: res.stdout.length >= cfg.maxPatchBytes, error: ok ? null : res.stderr }
}

// ---------- 仓库 / worktree 路径校验 ----------
// 只校验“它是一个 git 仓库根”，不限制必须在 roots 下：
// 接口测试会直接打服务、传临时仓库路径，限制 roots 会把它们全挡掉。
// 作用是把 /etc、普通目录这类明显不合法的 id 拒掉，避免任意路径执行 git。
const repoCheckCache = new Map()
async function verifyRepoPath(raw) {
  if (typeof raw !== 'string') return null
  const p = raw.replace(/\/+$/, '')
  if (!p.startsWith('/')) return null
  const now = Date.now()
  const hit = repoCheckCache.get(p)
  if (hit && now - hit.at < 30000) return hit.ok ? p : null
  const res = await git(p, ['rev-parse', '--show-toplevel'], { timeout: 5000 })
  const ok = res.code === 0 && res.stdout.trim().replace(/\/+$/, '') === p
  // 限制缓存大小：id 来自 URL，不能让随便构造的路径把内存撑爆
  if (repoCheckCache.size > 1000) repoCheckCache.clear()
  repoCheckCache.set(p, { at: now, ok })
  return ok ? p : null
}

async function resolveRepo(id) {
  try {
    return await verifyRepoPath(dec(id))
  } catch {
    return null
  }
}

// /api/open 只允许打开扫描结果里的 worktree，避免拿它当任意路径启动器
let worktreePathCache = { at: 0, data: null }
async function knownWorktreePaths() {
  const now = Date.now()
  if (worktreePathCache.data && now - worktreePathCache.at < 10000) return worktreePathCache.data
  const repos = await getRepos()
  const set = new Set()
  await Promise.all(
    repos.map((r) =>
      repoLimit(async () => {
        const d = await getWorktrees(r.toplevel, { withStatus: false })
        for (const w of d.worktrees || []) set.add(resolve(w.path))
      })
    )
  )
  worktreePathCache = { at: now, data: set }
  return set
}

// ---------- 请求校验 ----------
const MAX_BODY_BYTES = 1024 * 1024
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])
const WILDCARD = new Set(['0.0.0.0', '::', ''])

function hostName(value) {
  return String(value || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase()
}

/**
 * DNS rebinding 的核心是：攻击者让 evil.com 解析到 127.0.0.1，
 * 浏览器请求里的 Host / Origin 都是 evil.com。只比较 Origin 和 Host 相等没有用，
 * 所以即使绑定 0.0.0.0（WSL / 局域网），也只接受 localhost、IP 字面量或配置里的主机名。
 */
function hostAllowed(host, configured) {
  if (!host) return true // 非浏览器客户端（curl --http1.0 等）不带 Host，后面还有 Origin/JSON 校验
  if (LOOPBACK.has(host)) return true
  if (configured && !WILDCARD.has(configured) && host === configured) return true
  return isIP(host) !== 0
}

/**
 * 这个服务有写操作，默认只监听本机。
 * - POST 必须是 application/json：跨站表单发不了这个 Content-Type，
 *   浏览器会先发 preflight，而本服务不返回 CORS 头，从而挡住 CSRF
 * - 同源 Origin / Sec-Fetch-Site 再校验一层
 * - 始终校验 Host，挡住 DNS rebinding；0.0.0.0 只意味着端口对外，不代表任意域名可信
 */
function checkRequest(req) {
  if (req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '').toLowerCase()
    if (!ct.startsWith('application/json')) {
      return { code: 415, error: '请求必须是 application/json' }
    }
    const origin = req.headers.origin
    if (origin) {
      let oh
      try {
        oh = new URL(origin).host
      } catch {
        return { code: 403, error: '非法 Origin' }
      }
      if (oh !== req.headers.host) return { code: 403, error: '跨站请求被拒绝' }
    }
    const site = req.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      return { code: 403, error: '跨站请求被拒绝' }
    }
  }
  const configured = hostName(cfg.host)
  const host = hostName(req.headers.host)
  if (!hostAllowed(host, configured)) return { code: 403, error: 'Host 不被允许' }
  return null
}

// ---------- 设置页 ----------
/**
 * 设置页同时需要「磁盘上的值」和「当前进程真正在用的值」：
 * port / host 只读，手改配置后必须重启，所以这两项可能不一致，要让页面能提示出来。
 */
async function settingsPayload() {
  const saved = await readSavedConfig()
  const effective = {
    port: cfg.port,
    host: cfg.host,
    roots: cfg.roots,
    scanMaxDepth: cfg.scanMaxDepth,
    stateCacheMs: cfg.stateCacheMs,
    scanCacheMs: cfg.scanCacheMs,
    maxPatchBytes: cfg.maxPatchBytes,
  }
  const restartRequired = []
  if (saved.config.port !== effective.port) restartRequired.push('port')
  if (saved.config.host !== effective.host) restartRequired.push('host')

  return {
    platform: PLATFORM.platform,
    distro: PLATFORM.distro,
    apps: cfg.apps,
    resolved: describeApps(cfg.apps, APP_CTX),
    configPath: saved.path,
    config: saved.config,
    effective,
    restartRequired,
    configError: saved.error,
  }
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' })
  res.end(buf)
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const publicRoot = join(here, 'public')
  const file = join(publicRoot, posix.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (file !== publicRoot && !file.startsWith(publicRoot + sep)) {
    return json(res, 403, { error: 'forbidden' })
  }
  try {
    const st = await stat(file)
    if (!st.isFile()) throw new Error('not a file')
    // ETag 让刷新时走 304；前端文件很小，但少读一次磁盘总是好的
    const etag = `"${st.size.toString(16)}-${Math.trunc(st.mtimeMs).toString(16)}"`
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { etag, 'cache-control': 'no-cache' })
      res.end()
      return
    }
    const buf = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
      etag,
    })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  let url
  try {
    // 固定 base，不用 Host 拼 URL：Host 是不可信输入，畸形值会让 new URL 抛异常
    url = new URL(req.url, 'http://localhost')
  } catch {
    return json(res, 400, { error: '非法请求路径' })
  }
  const p = url.pathname

  try {
    const blocked = checkRequest(req)
    if (blocked) return json(res, blocked.code, { error: blocked.error })

    if (p === '/api/config') {
      return json(res, 200, {
        roots: cfg.roots,
        scanMaxDepth: cfg.scanMaxDepth,
        platform: PLATFORM.platform,
        distro: PLATFORM.platform === 'wsl' ? PLATFORM.distro : null,
      })
    }

    // ---------- 设置：扫描/缓存 + 外部工具路径 ----------
    // port / host 只读：保存时明确拒绝，避免网页一键把写接口暴露到局域网
    if (p === '/api/settings') {
      if (req.method === 'GET') {
        return json(res, 200, await settingsPayload())
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const apps = body.apps === undefined ? undefined : normalizeApps(body.apps || {})

        if (apps !== undefined) {
          for (const [kind, app] of Object.entries(apps)) {
            if (app.command.length > 1000 || /[\0\r\n]/.test(app.command)) {
              return json(res, 400, { ok: false, field: `cmd-${kind}`, error: `${kind} 的命令不合法` })
            }
            if (app.args.length > 32 || app.args.some((a) => a.length > 1000 || /[\0\r\n]/.test(a))) {
              return json(res, 400, { ok: false, field: `args-${kind}`, error: `${kind} 的参数不合法` })
            }
          }
        }

        let saved
        try {
          saved = await saveSettings({ apps, config: body.config })
        } catch (err) {
          // 校验错带 field（前端能定位到输入框），读写文件失败或配置 JSON 坏了走 409
          return json(res, err.field ? 400 : 409, { ok: false, field: err.field, error: err.message })
        }

        if (apps !== undefined) cfg.apps = saved.apps
        if (body.config !== undefined) {
          cfg.roots = expandRoots(saved.config.roots)
          cfg.scanMaxDepth = saved.config.scanMaxDepth
          cfg.stateCacheMs = saved.config.stateCacheMs
          cfg.scanCacheMs = saved.config.scanCacheMs
          cfg.maxPatchBytes = saved.config.maxPatchBytes
          // roots / 深度变了，旧扫描结果立刻作废，否则页面看起来“保存了没反应”
          scanCache = { at: 0, data: null }
          stateCache.clear()
        }
        worktreePathCache = { at: 0, data: null }

        return json(res, 200, { ok: true, ...(await settingsPayload()) })
      }
      return json(res, 405, { ok: false, error: 'method not allowed' })
    }

    if (p === '/api/repos') {
      const force = url.searchParams.get('force') === '1'
      if (force) scanCache = { at: 0, data: null }
      const repos = await getRepos(force)
      // 只取 worktree 列表（不跑 status），保证整体扫描在百毫秒级；
      // 脏标记复用已选中过仓库的缓存
      const withMeta = await Promise.all(
        repos.map((r) =>
          repoLimit(async () => {
            const listData = await getWorktrees(r.toplevel, { withStatus: false })
            const total = listData.worktrees?.length ?? 0
            const cached = stateCache.get(r.toplevel)?.data
            const dirtyCount = cached ? (cached.worktrees || []).filter((w) => w.dirty > 0).length : 0
            const known = Boolean(cached)
            return {
              ...r,
              id: enc(r.toplevel),
              count: total,
              extra: Math.max(0, total - 1),
              dirtyCount,
              known,
              error: listData.error || null,
            }
          })
        )
      )
      return json(res, 200, { repos: withMeta })
    }

    // ---------- 克隆仓库 ----------
    // clone 是长任务，POST 只负责启动并返回 jobId，进度靠 GET 轮询
    if (p === '/api/clone' && req.method === 'POST') {
      const body = await readBody(req)
      const url2 = String(body.url || '').trim()
      const dir = String(body.dir || '').trim()

      if (!url2) return json(res, 400, { error: '缺少仓库地址' })
      if (!dir.startsWith('/')) return json(res, 400, { error: '目标目录必须是绝对路径' })
      if (dir === '/' || dir.endsWith('/')) return json(res, 400, { error: '目标目录不能以 / 结尾' })

      // 必须落在某个扫描根下：否则能往任意位置写，也能克隆到别的仓库里面。
      // 先 resolve 再比较，避免 root/../evil 绕过前缀检查。
      const dirAbs = resolve(dir)
      const roots = (cfg.roots || []).map((r) => resolve(r))
      const inRoot = roots.some((r) => dirAbs.startsWith(`${r}${sep}`))
      if (!inRoot) {
        return json(res, 400, { error: `目标目录必须在扫描根下（${roots.join(' / ')}）` })
      }
      if (hasRunningClone()) {
        return json(res, 409, { error: '已经有一个克隆在进行，等它跑完再试' })
      }

      const id = startClone({
        url: url2,
        dir: dirAbs,
        depth1: Boolean(body.depth1),
        submodules: Boolean(body.submodules),
      })
      // startClone 内部会做「目标已存在」这类同步预检，失败的直接报给前端，
      // 不用让它先拿 jobId 再轮询一次才知道
      const job = getClone(id)
      if (job.status === 'error') return json(res, 409, { error: job.error, id })
      return json(res, 202, { id })
    }

    const mClone = p.match(/^\/api\/clone\/([\w-]+)$/)
    if (mClone && req.method === 'GET') {
      const job = getClone(mClone[1])
      if (!job) return json(res, 404, { error: '没有这个克隆任务' })
      // 克隆完成后让仓库扫描缓存失效，下次 /api/repos 能立刻看到新仓库
      if (job.status === 'done' && scanCache.data) {
        scanCache = { at: 0, data: null }
        stateCache.clear()
        worktreePathCache = { at: 0, data: null }
      }
      return json(res, 200, job)
    }

    const mWt = p.match(/^\/api\/repos\/([^/]+)\/worktrees$/)
    if (mWt && req.method === 'GET') {
      const toplevel = await resolveRepo(mWt[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const force = url.searchParams.get('force') === '1'
      if (force) { stateCache.delete(toplevel); stateCache.delete(`list:${toplevel}`) }
      const data = await getWorktrees(toplevel)
      if (data.error) return json(res, 500, { error: data.error })
      // 附加分支建议路径
      for (const wt of data.worktrees) wt.suggestedPath = suggestWorktreePath(data.toplevel, wt.branch || 'detached')
      return json(res, 200, data)
    }

    const mLog = p.match(/^\/api\/repos\/([^/]+)\/log$/)
    if (mLog) {
      const toplevel = await resolveRepo(mLog[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const rev = url.searchParams.get('rev') || '--all'
      const skip = Number(url.searchParams.get('skip') || 0)
      const count = Math.min(500, Number(url.searchParams.get('count') || 200))
      // wt 参数：指定在哪个 worktree 里执行 git log（决定 HEAD 指向）
      // 注意 all=1 时用 --all 跨全部引用，与 cwd 无关，但仍需校验路径合法性
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', commits: [] })
        cwd = wt.path
      }
      const data = await getLog(cwd, { rev, skip, count })
      if (data.error) return json(res, 500, data)
      return json(res, 200, { ...data, cwd })
    }

    const mCommit = p.match(/^\/api\/repos\/([^/]+)\/commit\/([0-9a-f]{4,40}|WORKTREE)$/)
    if (mCommit) {
      const toplevel = await resolveRepo(mCommit[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      if (mCommit[2] === 'WORKTREE') {
        // 工作区：必须在具体的 worktree 里跑，各 worktree 的未提交改动互相独立
        const wtParam = url.searchParams.get('wt')
        const wt = wtParam ? await resolveWorktree(toplevel, wtParam) : { path: toplevel }
        if (!wt) return json(res, 400, { error: 'unknown worktree', files: [] })
        const data = await getWorktreeChanges(wt.path)
        if (data.error) return json(res, 500, data)
        return json(res, 200, { ...data, sha: 'WORKTREE', parents: [], worktree: wt.path })
      }
      const data = await getCommitStat(toplevel, mCommit[2])
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    const mDiff = p.match(/^\/api\/repos\/([^/]+)\/diff$/)
    if (mDiff) {
      const toplevel = await resolveRepo(mDiff[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || ''
      const path = url.searchParams.get('path') || ''
      // 未提交改动的 diff 必须在具体 worktree 里跑（各 worktree 一份）
      const wtParam = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtParam) {
        const wt = await resolveWorktree(toplevel, wtParam)
        if (!wt) return json(res, 400, { error: 'unknown worktree', patch: '' })
        cwd = wt.path
      }
      const mode = url.searchParams.get('mode') || (sha === 'WORKTREE' ? 'worktree' : 'commit')
      const data = await getFileDiff(cwd, sha, path, mode)
      return json(res, 200, data)
    }

    // ---------- 单文件历史 ----------
    const mHist = p.match(/^\/api\/repos\/([^/]+)\/file-history$/)
    if (mHist) {
      const toplevel = await resolveRepo(mHist[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const filePath = url.searchParams.get('path') || ''
      if (!filePath) return json(res, 400, { error: 'path required', commits: [] })
      const follow = url.searchParams.get('follow') !== '0'
      const rev = url.searchParams.get('rev') || 'HEAD'
      // wt：在哪个 worktree 里查（和日志区的选择保持一致，决定 HEAD 与可见引用）
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', commits: [] })
        cwd = wt.path
      }
      const data = await getFileHistory(cwd, filePath, { follow, rev })
      if (data.error) return json(res, 500, data)
      return json(res, 200, { ...data, cwd, path: filePath })
    }

    const mHistDiff = p.match(/^\/api\/repos\/([^/]+)\/file-history-diff$/)
    if (mHistDiff) {
      const toplevel = await resolveRepo(mHistDiff[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || ''
      const pathAtCommit = url.searchParams.get('path') || ''
      if (!sha || !pathAtCommit) return json(res, 400, { error: 'sha and path required' })
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree' })
        cwd = wt.path
      }
      const data = await getHistoryDiff(cwd, sha, pathAtCommit, { maxBytes: cfg.maxPatchBytes })
      return json(res, 200, data)
    }

    // 文件列表：给「粘贴路径」的自动完成用。按仓库整体缓存（与 worktree 无关）
    const mFiles = p.match(/^\/api\/repos\/([^/]+)\/files$/)
    if (mFiles) {
      const toplevel = await resolveRepo(mFiles[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const data = await listFiles(toplevel)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 完整文件树（某 commit 的快照） ----------
    const mTree = p.match(/^\/api\/repos\/([^/]+)\/tree$/)
    if (mTree) {
      const toplevel = await resolveRepo(mTree[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || 'HEAD'
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', files: [] })
        cwd = wt.path
      }
      const data = sha === 'WORKTREE' ? await listWorktreeFiles(cwd) : await listTree(cwd, sha)
      if (data.error) return json(res, 500, data)
      return json(res, 200, { ...data, cwd })
    }

    const mCat = p.match(/^\/api\/repos\/([^/]+)\/file-content$/)
    if (mCat) {
      const toplevel = await resolveRepo(mCat[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || 'HEAD'
      const path = url.searchParams.get('path') || ''
      if (!path) return json(res, 400, { error: 'path required' })
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree' })
        cwd = wt.path
      }
      // 工作区视图读磁盘：用户改了什么就显示什么，不是索引也不是某个提交
      const data = sha === 'WORKTREE'
        ? await readWorktreeFile(cwd, path, cfg.maxPatchBytes)
        : await catFile(cwd, sha, path)
      if (data.notFound) return json(res, 404, data)
      if (data.tooLarge) return json(res, 200, data)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 在某个 commit 的文件树里按内容搜索 ----------
    const mGrep = p.match(/^\/api\/repos\/([^/]+)\/grep$/)
    if (mGrep) {
      const toplevel = await resolveRepo(mGrep[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || 'HEAD'
      const pattern = url.searchParams.get('q') || ''
      if (!pattern) return json(res, 400, { error: 'q required', files: [] })
      const subPath = url.searchParams.get('path') || ''
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', files: [] })
        cwd = wt.path
      }
      const data = await grepTree(cwd, sha, {
        pattern,
        path: subPath,
        ignoreCase: url.searchParams.get('i') === '1',
        regex: url.searchParams.get('re') === '1',
      })
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 某个 commit 上的 refs（tag / 分支） ----------
    const mRefs = p.match(/^\/api\/repos\/([^/]+)\/refs-at$/)
    if (mRefs) {
      const toplevel = await resolveRepo(mRefs[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const sha = url.searchParams.get('sha') || 'HEAD'
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', tags: [], branches: [] })
        cwd = wt.path
      }
      const data = await refsAtCommit(cwd, sha)
      if (data.error) return json(res, 404, data)
      return json(res, 200, data)
    }

    // ---------- 所有 ref 尖端的提交（给对比页的「最近提交」搜索用） ----------
    // 只给最近 N 条的话，老 tag 指向的提交搜不到
    const mRefLog = p.match(/^\/api\/repos\/([^/]+)\/ref-log$/)
    if (mRefLog) {
      const toplevel = await resolveRepo(mRefLog[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const data = await listRefTipCommits(toplevel)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 两个提交之间的代码对比 ----------
    // a/b 支持 sha / tag / 分支名 / HEAD~n，内部会 rev-parse 成完整 sha
    const mCmp = p.match(/^\/api\/repos\/([^/]+)\/compare$/)
    if (mCmp) {
      const toplevel = await resolveRepo(mCmp[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const a = url.searchParams.get('a') || ''
      const b = url.searchParams.get('b') || ''
      if (!a || !b) return json(res, 400, { error: 'a 和 b 都必填', files: [] })
      const data = await compareCommits(toplevel, a, b)
      if (data.error) return json(res, 400, data)
      return json(res, 200, data)
    }

    const mCmpFile = p.match(/^\/api\/repos\/([^/]+)\/compare-file$/)
    if (mCmpFile) {
      const toplevel = await resolveRepo(mCmpFile[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const a = url.searchParams.get('a') || ''
      const b = url.searchParams.get('b') || ''
      const path = url.searchParams.get('path') || ''
      const oldPath = url.searchParams.get('old') || ''
      if (!a || !b || !path) return json(res, 400, { error: 'a / b / path 都必填' })
      const data = await compareFile(toplevel, a, b, path, oldPath)
      if (data.error) return json(res, 400, data)
      return json(res, 200, data)
    }

    if (p === '/api/prune-dryrun' && req.method === 'POST') {
      const body = await readBody(req)
      const toplevel = await verifyRepoPath(String(body.toplevel || ''))
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      const res1 = await git(toplevel, ['worktree', 'prune', '-n', '-v'])
      return json(res, 200, { output: res1.stdout + res1.stderr, code: res1.code })
    }

    // ---------- 写操作 ----------
    if (req.method === 'POST') {
      const mAct = p.match(/^\/api\/repos\/([^/]+)\/(.+)$/)
      if (mAct) {
        const toplevel = await resolveRepo(mAct[1])
        if (!toplevel) return json(res, 404, { error: 'unknown repo' })
        const body = await readBody(req)
        let out

        // 更新仓库：fetch
        if (mAct[2] === 'fetch') {
          out = await ops.fetchRepo(toplevel, {
            prune: body.prune !== false,
            forceTags: Boolean(body.forceTags),
          })
        }
        // 查询某个 tag 的本地/远端指向（tag 冲突时给用户判断依据）
        else if (mAct[2] === 'tag-inspect') {
          out = { ok: true, ...(await ops.inspectTag(toplevel, String(body.tag || ''))) }
        }
        // 更新分支：pull
        else if (mAct[2] === 'pull') {
          const wt = await resolveWorktree(toplevel, body.wt)
          if (!wt) return json(res, 400, { ok: false, error: 'unknown worktree' })
          out = await ops.pullBranch(wt.path, { mode: body.mode || 'ff-only' })
        }
        // 切换分支
        else if (mAct[2] === 'checkout') {
          const wt = await resolveWorktree(toplevel, body.wt)
          if (!wt) return json(res, 400, { ok: false, error: 'unknown worktree' })
          out = await ops.checkoutBranch(wt.path, {
            branch: body.branch,
            detachAt: body.detachAt,
            create: body.create,
            startPoint: body.startPoint,
            // 只有前端明确确认「放弃本地变更」时才为 true
            force: body.force === true,
          })
        }
        // 创建 worktree
        else if (mAct[2] === 'worktrees') {
          out = await ops.createWorktree(toplevel, {
            path: body.path,
            branch: body.branch,
            mode: body.mode,
            base: body.base,
            lock: body.lock,
            lockReason: body.lockReason,
          })
        }
        // 删除 worktree 预检
        else if (mAct[2] === 'worktree-preflight') {
          out = await ops.preflightRemove(toplevel, body.path)
        }
        // 删除 worktree
        else if (mAct[2] === 'worktree-remove') {
          out = await ops.removeWorktree(toplevel, body.path, { force: Boolean(body.force) })
        }
        // 陈旧扫描
        else if (mAct[2] === 'stale-scan') {
          out = await ops.findStaleWorktrees(toplevel, { staleDays: Number(body.staleDays) || 7 })
        }
        // 批量清理
        else if (mAct[2] === 'stale-clean') {
          out = await ops.cleanStale(toplevel, {
            paths: Array.isArray(body.paths) ? body.paths : [],
            staleDays: Number(body.staleDays) || 7,
            dryRun: Boolean(body.dryRun),
          })
        } else {
          return json(res, 404, { ok: false, error: `unknown action: ${mAct[2]}` })
        }

        // 写操作后让缓存失效
        stateCache.delete(toplevel)
        stateCache.delete(`list:${toplevel}`)
        scanCache = { at: 0, data: null }
        worktreePathCache = { at: 0, data: null }
        return json(res, out.ok ? 200 : 409, out)
      }
    }

    const mBranches = p.match(/^\/api\/repos\/([^/]+)\/branches$/)
    if (mBranches) {
      const toplevel = await resolveRepo(mBranches[1])
      if (!toplevel) return json(res, 404, { error: 'unknown repo' })
      // wt 可选：传了就以该 worktree 为视角算「当前分支」，
      // 这样主工作树 detached 时，别的工作树仍能正确标出自己的当前分支。
      const wtPath = url.searchParams.get('wt')
      let wt = null
      if (wtPath) {
        wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', local: [], remote: [], tags: [] })
      }
      const data = await ops.listBranches(toplevel, { wtPath: wt?.path })
      return json(res, 200, data)
    }

    if (p === '/api/open' && req.method === 'POST') {
      const body = await readBody(req)
      const target = body.target
      const path = body.path
      if (!path || typeof path !== 'string') return json(res, 400, { ok: false, error: 'path required' })

      // 前端沿用旧的 target 名，这里映射到三类程序；设置页也接受新名字
      const kind = {
        explorer: 'fileManager',
        fileManager: 'fileManager',
        wt: 'terminal',
        terminal: 'terminal',
        vscode: 'editor',
        editor: 'editor',
      }[target]
      if (!kind) return json(res, 400, { ok: false, error: 'unknown target' })

      // 只允许打开扫描结果里的 worktree，避免把接口当任意路径启动器
      const abs = resolve(path)
      const allowed = await knownWorktreePaths()
      if (![...allowed].some((p2) => resolve(p2) === abs)) {
        return json(res, 400, { ok: false, error: '路径不是已识别的 worktree' })
      }

      const out = await openTarget(cfg.apps, kind, abs, APP_CTX)
      return json(res, 200, out)
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    // 浏览器默认会要 favicon.ico；没有就 204，避免控制台多一条 404
    if (p === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'max-age=86400' })
      res.end()
      return
    }

    return serveStatic(req, res, p)
  } catch (err) {
    // 500 不把 stack 回给浏览器：里面有绝对路径和内部结构
    console.error('[server]', err)
    return json(res, err?.status && err.status < 500 ? err.status : 500, {
      error: err?.status && err.status < 500 ? String(err.message || err) : '服务器内部错误',
    })
  }
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return
      size += c.length
      if (size > MAX_BODY_BYTES) {
        tooLarge = true
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) {
        const err = new Error('请求体过大')
        err.status = 413
        reject(err)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        // 空 body / 非 JSON 一律当空对象，具体校验交给路由
        resolve({})
      }
    })
    req.on('error', reject)
  })
}

// 监听失败（端口被占）要给出明确日志，而不是让 systemd 无声重启
server.on('error', (err) => {
  console.error(`[server] 监听 ${cfg.host}:${cfg.port} 失败：${err.message}`)
  process.exit(1)
})

// systemd stop / Ctrl-C 时先停 HTTP；detached 打开的 Konsole 等由 KillMode=process 保证不被 kill
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}

server.listen(cfg.port, cfg.host, () => {
  const url = `http://localhost:${cfg.port}`
  console.log(`\n  wsl-worktree  →  ${url}`)
  console.log(`  platform: ${PLATFORM.platform}${PLATFORM.distro ? ` (${PLATFORM.distro})` : ''}`)
  console.log(`  roots: ${cfg.roots.join(', ')}\n`)
})
