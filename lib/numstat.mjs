import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'

/** 解析 `show --numstat --format= -z --find-renames`
 *
 * -z 下记录以 \0 分隔，重命名记录形如：
 *    "0\t0\t\0oldpath\0newpath\0"
 * 普通记录形如：
 *    "12\t0\tpath\0"
 */
export function parseNumstatZ(raw) {
  const tokens = raw.split('\0')
  const files = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue
    const m = t.match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/)
    if (!m) continue

    const add = m[1] === '-' ? null : Number(m[1])
    const del = m[2] === '-' ? null : Number(m[2])
    const binary = m[1] === '-' || m[2] === '-'
    const path = m[3]

    if (path === '') {
      // rename / copy：后续两个 token 是 old 与 new
      const oldPath = tokens[++i] ?? null
      const newPath = tokens[++i] ?? null
      if (!newPath) continue
      files.push({ add, del, binary, path: newPath, oldPath })
    } else {
      files.push({ add, del, binary, path, oldPath: null })
    }
  }
  return files
}
