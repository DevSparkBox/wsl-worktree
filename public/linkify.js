/**
 * 把纯文本里的 URL 变成可点击链接。
 *
 * 使用场景：commit message 里普遍带 TAPD / Jira / GitHub 链接
 * （实测 jm_java 里 60 条提交 27 个 www.tapd.cn 链接），
 * 纯文本只能复制粘贴，很不方便。
 *
 * 三个安全/正确性要点：
 *
 * 1) **只放行 http/https**。绝不因为文本里有 javascript: 就生成链接。
 *    这里用白名单而不是黑名单：只接受这两种协议。
 *
 * 2) **文本必须转义**。返回的是 HTML，直接插进 innerHTML，
 *    文件内容/提交信息都是不可信输入。
 *
 * 3) **中文标点要当边界**。URL 后面常紧跟「，」「）」这类全角标点，
 *    它们不属于链接。只在这些字符处截断，而不是截掉 URL 里的合法字符。
 */

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c])
}

/**
 * URL 匹配。
 * - 只认 http:// 和 https://
 * - 排除空白、尖括号、引号（这些在 HTML/文本里本来就该断开）
 * - 排除全角标点（中文句号、逗号、括号等），否则会吞掉后面的中文
 */
const URL_RE = /https?:\/\/[^\s<>"'`，。；：！？、（）【】《》「」]+/gi

/** 链接末尾常见的「属于句子不属于 URL」的字符，需要剥掉（且不重复剥） */
const TRAILING = /[.,;:!?)\]}>]+$/

/**
 * @param {string} text 纯文本
 * @returns {string} 转义后的 HTML，URL 部分为 <a>
 */
export function linkify(text) {
  const src = String(text ?? '')
  if (!src) return ''

  let out = ''
  let last = 0
  URL_RE.lastIndex = 0

  let m
  while ((m = URL_RE.exec(src)) !== null) {
    let url = m[0]
    // 剥掉尾部标点（例如 "见 https://x.com/a." 里的句号）
    const trimmed = url.replace(TRAILING, '')
    const tail = url.slice(trimmed.length)
    url = trimmed

    // 协议白名单：URL_RE 已经只匹配 http(s)，这里再确认一次，
    // 防止将来改正则时漏掉（防御性）
    let safe = false
    try {
      const u = new URL(url)
      safe = u.protocol === 'http:' || u.protocol === 'https:'
    } catch {
      safe = false
    }

    out += escHtml(src.slice(last, m.index))
    if (safe && url) {
      out += `<a class="ext-link" href="${escHtml(url)}" target="_blank" rel="noopener noreferrer"` +
        ` title="${escHtml(url)}">${escHtml(url)}</a>`
    } else {
      out += escHtml(url)
    }
    out += escHtml(tail)
    last = m.index + m[0].length
  }
  out += escHtml(src.slice(last))
  return out
}

/**
 * 提取文本里的所有 URL（用于「复制链接」等场景，或统计）。
 */
export function extractUrls(text) {
  const src = String(text ?? '')
  const out = []
  URL_RE.lastIndex = 0
  let m
  while ((m = URL_RE.exec(src)) !== null) {
    const url = m[0].replace(TRAILING, '')
    try {
      const u = new URL(url)
      if (u.protocol === 'http:' || u.protocol === 'https:') out.push(url)
    } catch {}
  }
  return out
}
