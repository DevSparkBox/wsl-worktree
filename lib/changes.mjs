/**
 * 某个 worktree 的「未提交更改」。
 *
 * 语义是「工作区 + 暂存 vs HEAD」——也就是 commit 之后会包含的全部改动。
 * 一条 `git diff --numstat HEAD` 就能拿到已跟踪文件的增删行数，
 * 但**不含未跟踪文件**，得另外补。
 *
 * 未跟踪文件不给行数：要读文件逐个统计，二进制还没法算，
 * 而且清单只是用来挑文件，行数等真正点开 diff 时再说。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git } from './git.mjs'
import { parseNumstatZ } from './numstat.mjs'

/**
 * @param {string} wtPath worktree 的绝对路径（不是 toplevel：要读的是这个工作区的磁盘状态）
 * @returns {Promise<{files: Array, total: number, untracked: number, noHead: boolean, error?: string}>}
 */
export async function getWorktreeChanges(wtPath) {
  // HEAD 可能不存在（刚 init / clone 完还没提交的空仓库），
  // 这时 `git diff HEAD` 直接报 unknown revision，要退化成「所有文件都是新增」
  const head = await git(wtPath, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeout: 8000 })
  const hasHead = head.code === 0

  const [numstat, others] = await Promise.all([
    hasHead
      ? git(wtPath, ['diff', '--numstat', '-z', '--find-renames', 'HEAD'], { timeout: 20000 })
      : Promise.resolve({ code: 1, stdout: '', stderr: '' }),
    git(wtPath, ['ls-files', '-z', '--others', '--exclude-standard'], {
      timeout: 20000,
      quotepath: false,
      maxBytes: 16 * 1024 * 1024,
    }),
  ])

  if (others.code !== 0) {
    return { files: [], total: 0, untracked: 0, noHead: !hasHead, error: others.stderr }
  }

  const files = hasHead
    ? parseNumstatZ(numstat.stdout).map((f) => ({ ...f, status: 'M' }))
    : []

  // 磁盘上已经没有的标成删除。只看 numstat 判断不了（改文件也可能只有删除行），
  // 必须落到文件系统问一句。改动文件通常几十个，逐个 existsSync 很便宜。
  if (hasHead) {
    for (const f of files) {
      if (!existsSync(join(wtPath, f.path))) f.status = 'D'
    }
  }

  // 空仓库：把所有被跟踪/未跟踪的文件都当新增
  const untrackedPaths = others.stdout.split('\0').filter(Boolean)

  if (!hasHead) {
    const tracked = await git(wtPath, ['ls-files', '-z', '--cached'], {
      timeout: 20000, quotepath: false, maxBytes: 16 * 1024 * 1024,
    })
    const all = [...new Set([...tracked.stdout.split('\0').filter(Boolean), ...untrackedPaths])].sort()
    return {
      files: all.map((path) => ({ path, add: 0, del: 0, binary: false, status: 'A' })),
      total: all.length,
      untracked: all.length,
      noHead: true,
    }
  }

  for (const path of untrackedPaths.sort()) {
    files.push({ path, add: 0, del: 0, binary: false, status: 'A' })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    files,
    total: files.length,
    untracked: untrackedPaths.length,
    noHead: false,
  }
}
