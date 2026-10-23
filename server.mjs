import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join, dirname, basename, extname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from './lib/config.mjs'
import { git, createLimiter } from './lib/git.mjs'
import { scanRepos, parseWorktreePorcelainZ, parseStatusV2, suggestWorktreePath } from './lib/scan.mjs'
import { parseNumstatZ } from './lib/numstat.mjs'
import * as ops from './lib/ops.mjs'
import { getFileHistory, getHistoryDiff, listFiles } from './lib/history.mjs'
import { listTree, catFile } from './lib/tree.mjs'
import { grepTree } from './lib/grep.mjs'
import { refsAtCommit, listRefTipCommits } from './lib/refs.mjs'
import { compareCommits, compareFile } from './lib/compare.mjs'
import { LOG_FMT, parseLog } from './lib/logfmt.mjs'
import { startClone, getClone, hasRunningClone } from './lib/clone.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cfg = await loadConfig()
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

async function getFileDiff(toplevel, sha, path, mode = 'commit') {
  let args
  if (mode === 'worktree') {
    args = ['diff', '--no-color', '--no-ext-diff', '-U3', 'HEAD', '--', path]
  } else if (mode === 'staged') {
    args = ['diff', '--cached', '--no-color', '--no-ext-diff', '-U3', '--', path]
  } else {
    // 与 getCommitStat 保持同一语义：root 用 show，其余用 diff p1..sha
    const parents = await getParents(toplevel, sha)
    if (parents.length === 0) {
      args = ['show', '--format=', '--no-color', '--no-ext-diff', '-U3', '--find-renames', sha, '--', path]
    } else {
      args = ['diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames', parents[0], sha, '--', path]
    }
  }
  const res = await git(toplevel, args, { maxBytes: cfg.maxPatchBytes, timeout: 30000 })
  return { patch: res.stdout.slice(0, cfg.maxPatchBytes), truncated: res.stdout.length >= cfg.maxPatchBytes, error: res.code === 0 ? null : res.stderr }
}

// ---------- 打开 Windows 程序 ----------
/** 命令是否存在（用于判断 WSL 里有没有 code） */
function hasCommand(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function openOnWindows(exe, args) {
  try {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err?.message || err) }
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

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const file = join(here, 'public', posix.normalize(rel).replace(/^(\.\.[/\\])+/, ''))
  if (!file.startsWith(join(here, 'public'))) return json(res, 403, { error: 'forbidden' })
  try {
    const st = await stat(file)
    if (!st.isFile()) throw new Error('not a file')
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' })
    res.end(buf)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const p = url.pathname

  try {
    if (p === '/api/config') {
      return json(res, 200, { roots: cfg.roots, scanMaxDepth: cfg.scanMaxDepth, distro: process.env.WSL_DISTRO_NAME || 'archlinux' })
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

      // 必须落在某个扫描根下：否则能往任意位置写，也能克隆到别的仓库里面
      const roots = (cfg.roots || []).map((r) => r.replace(/\/+$/, ''))
      const inRoot = roots.some((r) => dir.startsWith(`${r}/`))
      if (!inRoot) {
        return json(res, 400, { error: `目标目录必须在扫描根下（${roots.join(' / ')}）` })
      }
      if (hasRunningClone()) {
        return json(res, 409, { error: '已经有一个克隆在进行，等它跑完再试' })
      }

      const id = startClone({
        url: url2,
        dir,
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
      }
      return json(res, 200, job)
    }

    const mWt = p.match(/^\/api\/repos\/([^/]+)\/worktrees$/)
    if (mWt && req.method === 'GET') {
      const toplevel = dec(mWt[1])
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
      const toplevel = dec(mLog[1])
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

    const mCommit = p.match(/^\/api\/repos\/([^/]+)\/commit\/([0-9a-f]{4,40})$/)
    if (mCommit) {
      const toplevel = dec(mCommit[1])
      const data = await getCommitStat(toplevel, mCommit[2])
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    const mDiff = p.match(/^\/api\/repos\/([^/]+)\/diff$/)
    if (mDiff) {
      const toplevel = dec(mDiff[1])
      const sha = url.searchParams.get('sha') || ''
      const path = url.searchParams.get('path') || ''
      const mode = url.searchParams.get('mode') || 'commit'
      const data = await getFileDiff(toplevel, sha, path, mode)
      return json(res, 200, data)
    }

    // ---------- 单文件历史 ----------
    const mHist = p.match(/^\/api\/repos\/([^/]+)\/file-history$/)
    if (mHist) {
      const toplevel = dec(mHist[1])
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
      const toplevel = dec(mHistDiff[1])
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
      const toplevel = dec(mFiles[1])
      const data = await listFiles(toplevel)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 完整文件树（某 commit 的快照） ----------
    const mTree = p.match(/^\/api\/repos\/([^/]+)\/tree$/)
    if (mTree) {
      const toplevel = dec(mTree[1])
      const sha = url.searchParams.get('sha') || 'HEAD'
      const wtPath = url.searchParams.get('wt')
      let cwd = toplevel
      if (wtPath) {
        const wt = await resolveWorktree(toplevel, wtPath)
        if (!wt) return json(res, 400, { error: 'unknown worktree', files: [] })
        cwd = wt.path
      }
      const data = await listTree(cwd, sha)
      if (data.error) return json(res, 500, data)
      return json(res, 200, { ...data, cwd })
    }

    const mCat = p.match(/^\/api\/repos\/([^/]+)\/file-content$/)
    if (mCat) {
      const toplevel = dec(mCat[1])
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
      const data = await catFile(cwd, sha, path)
      if (data.notFound) return json(res, 404, data)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 在某个 commit 的文件树里按内容搜索 ----------
    const mGrep = p.match(/^\/api\/repos\/([^/]+)\/grep$/)
    if (mGrep) {
      const toplevel = dec(mGrep[1])
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
      const toplevel = dec(mRefs[1])
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
      const toplevel = dec(mRefLog[1])
      const data = await listRefTipCommits(toplevel)
      if (data.error) return json(res, 500, data)
      return json(res, 200, data)
    }

    // ---------- 两个提交之间的代码对比 ----------
    // a/b 支持 sha / tag / 分支名 / HEAD~n，内部会 rev-parse 成完整 sha
    const mCmp = p.match(/^\/api\/repos\/([^/]+)\/compare$/)
    if (mCmp) {
      const toplevel = dec(mCmp[1])
      const a = url.searchParams.get('a') || ''
      const b = url.searchParams.get('b') || ''
      if (!a || !b) return json(res, 400, { error: 'a 和 b 都必填', files: [] })
      const data = await compareCommits(toplevel, a, b)
      if (data.error) return json(res, 400, data)
      return json(res, 200, data)
    }

    const mCmpFile = p.match(/^\/api\/repos\/([^/]+)\/compare-file$/)
    if (mCmpFile) {
      const toplevel = dec(mCmpFile[1])
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
      const toplevel = body.toplevel
      const res1 = await git(toplevel, ['worktree', 'prune', '-n', '-v'])
      return json(res, 200, { output: res1.stdout + res1.stderr, code: res1.code })
    }

    // ---------- 写操作 ----------
    if (req.method === 'POST') {
      const action = p.replace(/^\/api\/repos\/[^/]+\//, '')
      const mAct = p.match(/^\/api\/repos\/([^/]+)\/(.+)$/)
      if (mAct) {
        const toplevel = dec(mAct[1])
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
        return json(res, out.ok ? 200 : 409, out)
      }
    }

    const mBranches = p.match(/^\/api\/repos\/([^/]+)\/branches$/)
    if (mBranches) {
      const toplevel = dec(mBranches[1])
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

      if (target === 'explorer') {
        const unc = toUnc(path)
        return json(res, 200, openOnWindows(cfg.windows.explorer, [unc]))
      }
      if (target === 'wt') {
        // wt 路径是可选的（不同机器安装位置不同），没配就明确告知而不是静默失败
        if (!cfg.windows.wt) {
          return json(res, 400, {
            ok: false,
            error: 'config.json 未配置 windows.wt（Windows Terminal 路径），可在其中填上 wt.exe 的绝对路径',
          })
        }
        const unc = toUnc(path)
        const distro = process.env.WSL_DISTRO_NAME || 'archlinux'
        // wt -d <起始目录> wsl.exe -d <distro> --cd <linux path>
        return json(res, 200, openOnWindows(cfg.windows.wt, ['-d', unc, 'wsl.exe', '-d', distro, '--cd', path]))
      }
      if (target === 'vscode') {
        // 两条路：
        //   1. WSL 里有 code 命令（装了 Remote - WSL）→ 直接传 Linux 路径，扩展会自己处理
        //   2. 否则用 Windows 侧的 code.cmd → 必须转成 UNC 路径
        // 顺序不能反：Windows 的 code 拿 Linux 路径是不认的。
        if (hasCommand('code')) {
          try {
            const child = spawn('code', [path], { detached: true, stdio: 'ignore' })
            child.unref()
            return json(res, 200, { ok: true })
          } catch (err) {
            return json(res, 200, { ok: false, error: String(err?.message || err) })
          }
        }
        if (cfg.windows.code) {
          return json(res, 200, openOnWindows(cfg.windows.code, [toUnc(path)]))
        }
        return json(res, 400, {
          ok: false,
          error: '找不到 VS Code：WSL 里没有 code 命令（可装 Remote - WSL），config.json 里也没配 windows.code',
        })
      }
      return json(res, 400, { ok: false, error: 'unknown target' })
    }

    if (p.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    return serveStatic(res, p)
  } catch (err) {
    return json(res, 500, { error: String(err?.stack || err) })
  }
})

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { resolve({}) }
    })
  })
}

function toUnc(p) {
  if (!p) return null
  return '\\\\wsl.localhost\\' + (process.env.WSL_DISTRO_NAME || 'archlinux') + p.replace(/\//g, '\\')
}

server.listen(cfg.port, cfg.host, () => {
  const url = `http://localhost:${cfg.port}`
  console.log(`\n  wsl-worktree  →  ${url}\n  roots: ${cfg.roots.join(', ')}\n`)
})
