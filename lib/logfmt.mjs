/**
 * commit log 的输出格式与解析。
 *
 * 从 server.mjs 抽出来：对比页的「最近提交」除了最近 N 条，
 * 还要把**所有 tag / 分支尖端**也拉进来（否则搜不到老 tag 指向的提交）。
 * 两处用同一个格式，解析逻辑只写一份。
 *
 * 用 %x1f（0x1F）分隔字段、%x1e（0x1E）分隔记录：
 * 这两个控制字符不会出现在 commit message 里，比 | 或 tab 安全。
 */

export const LOG_FMT = '%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e'

/** 单条提交的完整 message（标题 + 正文）。详情面板才需要，不放进每页 200 条的日志里。 */
export const MESSAGE_FMT = '%s%x1e%b'

export function parseLog(raw) {
  return raw
    .split('\x1e')
    .map((s) => s.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [sha, parents, author, email, at, refs, ...rest] = rec.split('\x1f')
      return {
        sha,
        parents: parents ? parents.split(' ').filter(Boolean) : [],
        author,
        email,
        time: Number(at) * 1000,
        // %D 形如 `HEAD -> main, tag: v5.5.13.13, origin/main`
        refs: refs ? refs.split(', ').filter(Boolean) : [],
        subject: rest.join('\x1f'),
      }
    })
}

/**
 * 拆 `%s%x1e%b`。正文里的换行原样保留；git 会在末尾补一个换行，这里去掉。
 * subject 里不会出现 0x1E，所以只按第一次出现的分隔符切开。
 */
export function parseCommitMessage(raw) {
  const text = String(raw || '').replace(/\n$/, '')
  const i = text.indexOf('\x1e')
  if (i < 0) return { subject: text, body: '' }
  return { subject: text.slice(0, i), body: text.slice(i + 1).replace(/\n$/, '') }
}
