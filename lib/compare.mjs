import { git } from './git.mjs'
import { parseNumstatZ } from './numstat.mjs'

/**
 * 两个提交之间的代码对比。
 *
 * 数据源是两次 `git diff`（并行）：
 *   --name-status  给出 A/M/D/R 状态、改名相似度、旧新路径
 *   --numstat      给出行数增减
 * 两者信息互补，缺一不可：
 *   - numstat 能区分「新增 12 行」还是「修改 +12」，但给不出状态，
 *     也分不清「新增文件」和「整段新写的旧文件」
 *   - name-status 有状态，但没有行数
 *
 * 为什么不用 `--raw --numstat` 合并成一次：git diff 不接受两个统计格式
 * 同时输出，试过只会得到前者。两次并行各 ~0.5s，比串行省一半。
 */

/** 单次对比最多列出的变更文件数，防止 A..B 跨几百个提交时返回几万条 */
const MAX_FILES = 5000
/** 单文件 patch 上限 */
const PATCH_MAX_BYTES = 2 * 1024 * 1024

/**
 * 解析 `git diff --name-status -z`。
 *
 * -z 下格式是「状态 \0 路径 \0 ...」，改名/复制多一段旧路径：
 *   `R075 \0 old \0 new \0`
 * 非 -z 时是 `R075\told\tnew`，所以**不能按 \t 切**（路径里可能含 tab）。
 */
export function parseNameStatusZ(raw) {
  const tokens = String(raw || '').split('\0')
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!code) continue
    const c = code[0]
    if (c === 'R' || c === 'C') {
      const oldPath = tokens[++i]
      const newPath = tokens[++i]
      if (!newPath) break
      out.push({
        status: c,
        similar: Number(code.slice(1)) || 0,
        oldPath,
        path: newPath,
      })
    } else {
      const p = tokens[++i]
      if (!p) break
      out.push({ status: c, similar: null, oldPath: null, path: p })
    }
  }
  return out
}

/** 把 rev（sha / tag / branch / HEAD~n）解析成完整 commit sha */
async function resolveRev(cwd, rev) {
  const res = await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { timeout: 15000 })
  if (res.code !== 0) return null
  return res.stdout.trim()
}

/**
 * 列出 A→B 的变更文件。
 *
 * @returns {{ a: string, b: string, files: Array, stats: object, truncated: boolean, error?: string }}
 */
export async function compareCommits(cwd, revA, revB) {
  const [a, b] = await Promise.all([resolveRev(cwd, revA), resolveRev(cwd, revB)])
  if (!a) return { a: null, b, files: [], stats: emptyStats(), truncated: false, error: `找不到提交：${revA}` }
  if (!b) return { a, b: null, files: [], stats: emptyStats(), truncated: false, error: `找不到提交：${revB}` }

  const base = ['diff', '--no-color', '--no-ext-diff', '--find-renames']

  const [ns, num] = await Promise.all([
    git(cwd, [...base, '--name-status', '-z', a, b], {
      quotepath: false, timeout: 60000, maxBytes: 32 * 1024 * 1024,
    }),
    git(cwd, [...base, '--numstat', '-z', a, b], {
      quotepath: false, timeout: 60000, maxBytes: 32 * 1024 * 1024,
    }),
  ])

  if (ns.code !== 0) {
    return { a, b, files: [], stats: emptyStats(), truncated: false, error: ns.stderr || 'git diff 失败' }
  }

  const statusList = parseNameStatusZ(ns.stdout)
  // numstat 以「新路径」为键（改名记录里 path 就是新路径）
  const numMap = new Map()
  if (num.code === 0) {
    for (const f of parseNumstatZ(num.stdout)) numMap.set(f.path, f)
  }

  const total = statusList.length
  const truncated = total > MAX_FILES
  const picked = truncated ? statusList.slice(0, MAX_FILES) : statusList

  const files = picked.map((s) => {
    const n = numMap.get(s.path)
    return {
      path: s.path,
      oldPath: s.oldPath,
      status: s.status,
      similar: s.similar,
      add: n && !n.binary ? (n.add ?? 0) : null,
      del: n && !n.binary ? (n.del ?? 0) : null,
      binary: n ? Boolean(n.binary) : false,
    }
  })

  return { a, b, files, stats: summarize(files), truncated }
}

function emptyStats() {
  return { files: 0, add: 0, del: 0, byStatus: {} }
}

/** 统计：文件数、增删行、按状态分组（界面上做筛选要用） */
function summarize(files) {
  const byStatus = {}
  let add = 0
  let del = 0
  for (const f of files) {
    byStatus[f.status] = (byStatus[f.status] || 0) + 1
    if (f.add != null) add += f.add
    if (f.del != null) del += f.del
  }
  return { files: files.length, add, del, byStatus }
}

/**
 * 单个文件在 A→B 之间的 patch。
 *
 * 改名文件必须把**新旧路径都传给 git**，否则结果会退化：
 *   只传旧路径 → 显示成 deleted file
 *   只传新路径 → 显示成 new file
 *   两个都传   → 才显示 similarity / rename from / rename to
 * 这是实测出来的，容易漏。
 */
export async function compareFile(cwd, revA, revB, path, oldPath) {
  const [a, b] = await Promise.all([resolveRev(cwd, revA), resolveRev(cwd, revB)])
  if (!a || !b) return { error: `找不到提交：${!a ? revA : revB}` }

  const paths = oldPath && oldPath !== path ? [oldPath, path] : [path]
  const args = [
    'diff', '--no-color', '--no-ext-diff', '-U3', '--find-renames',
    a, b, '--', ...paths.map((p) => `:(literal)${p}`),
  ]

  const res = await git(cwd, args, {
    quotepath: false, timeout: 60000, maxBytes: PATCH_MAX_BYTES,
  })
  if (res.code !== 0) return { error: res.stderr || 'git diff 失败', a, b }

  return {
    a,
    b,
    path,
    oldPath: oldPath || null,
    patch: res.stdout.slice(0, PATCH_MAX_BYTES),
    truncated: res.stdout.length >= PATCH_MAX_BYTES,
  }
}
