/**
 * 模糊匹配打分，主界面和历史页共用同一份实现。
 *
 * 返回 null 表示不匹配，数字越大越相关。
 *
 * 输入「h5.5.13」要能命中「hotfix/h-tag-5.5.13.10-xxx」，这是实际使用中最常见的形式：
 * 记得开头几个字母 + 版本号。
 *
 * 匹配分三级，按优先级：
 *   1. 整体连续子串（含前缀）         —— 最精确
 *   2. 按分隔符切段后，逐段「段内前缀」匹配，允许跳过中间段
 *   3. 纯子序列（字符按序出现）
 * 三级都失败才返回 null。
 */
export function fuzzyScore(query, text) {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()

  if (t === q) return 1000
  if (t.startsWith(q)) return 900 - Math.min(150, t.length - q.length)

  // ---- 1. 连续子串 ----
  const idx = t.indexOf(q)
  if (idx >= 0) {
    const atSegment = idx === 0 || /[/\-_.]/.test(t[idx - 1])
    return (atSegment ? 720 : 640) - Math.min(120, idx)
  }

  // ---- 2. 切段匹配 ----
  // 把查询按分隔符切成片段，每个片段要求在某一段里「以它开头」或「包含它」，
  // 段可以跳过（h → hotfix 段，5.5.13 → 后面的 5.5.13.10 段）。
  //
  // 还要处理这种情况：查询片段跨了段边界。
  // 比如查 'h5.5.13' 切出 ['h5','5','13']，但 'h5' 里 h 属于 hotfix、5 属于 5.5.13——
  // 单纯按段比对会失败。做法是：片段匹配不上时，允许退化为「只取首字符」
  // 去匹配段首（h → hotfix），剩余部分留给后面的段继续匹配。
  const segs = t.split(/[/\-_.]+/).filter(Boolean)
  const qParts = q.split(/[/\-_.]+/).filter(Boolean)

  if (qParts.length >= 1 && segs.length >= 1) {
    let si = 0          // 当前搜索起始段
    let score = 560
    let ok = true
    let firstMatchedAt = -1

    for (let pi = 0; pi < qParts.length; pi++) {
      const part = qParts[pi]
      let found = -1
      let exact = false

      // 先按整段找
      for (let i = si; i < segs.length; i++) {
        if (segs[i].startsWith(part)) { found = i; exact = true; break }
        if (segs[i].includes(part)) { found = i; exact = false; break }
      }

      // 找不到时：如果片段是多字符且首字符能匹配某段段首，拆开重试
      // 'h5' → 'h'（命中 hotfix）+ 剩余 '5' 插到下一个位置继续
      if (found < 0 && part.length > 1) {
        const head = part[0]
        for (let i = si; i < segs.length; i++) {
          if (segs[i].startsWith(head)) {
            found = i
            exact = false
            // 把剩余部分作为新的片段插到当前片段之后
            const rest = part.slice(1)
            if (rest) qParts.splice(pi + 1, 0, rest)
            break
          }
        }
      }

      if (found < 0) { ok = false; break }
      if (pi === 0) firstMatchedAt = found
      si = found + 1          // 后续片段只能从后面找，保证顺序
      if (exact) score += 14
    }

    if (ok && firstMatchedAt >= 0) {
      // 命中的段越靠前越好；跳过的段越多扣分越多
      score -= firstMatchedAt * 6
      score -= Math.max(0, segs.length - qParts.length) * 2
      return Math.max(200, score)
    }
  }

  // ---- 3. 纯子序列兜底 ----
  // 只对较长的查询启用：查询太短（1-2 字符）时子序列会命中大量无关项，
  // 比如 'tmp' 里 t/m/p 能在 'release/...jmpt_java...' 里按序找到，纯噪声。
  if (q.length < 3) return null

  let ti = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, ti)
    if (found < 0) return null
    gaps += found - ti
    ti = found + 1
  }
  // 子序列要求相当紧凑，否则不如不提示
  if (gaps > q.length * 6) return null
  return Math.max(50, 300 - Math.min(240, gaps))
}

/**
 * 按模糊分数排序并取前 N 条。
 * 文件路径列表用这个，避免每个调用点各写一遍排序逻辑。
 */
export function rankByFuzzy(query, items, limit = 20, keyOf = (x) => x) {
  const q = String(query || '').trim()
  if (!q) return []
  const scored = []
  for (const it of items) {
    const s = fuzzyScore(q, keyOf(it))
    if (s != null) scored.push({ it, s })
  }
  scored.sort((a, b) => b.s - a.s)
  return scored.slice(0, limit).map((x) => x.it)
}
