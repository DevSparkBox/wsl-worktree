/**
 * 复制到剪贴板。
 *
 * 为什么不能只用 navigator.clipboard：它只在「安全上下文」里存在——
 * 浏览器在 Windows、服务跑在另一台 Linux 时，页面是 http://192.168.x.x:7801，
 * 既不是 https 也不是 localhost，`navigator.clipboard` 直接是 undefined
 * （实测：http://127.0.0.1:7801 有，http://<局域网 IP>:7801 没有）。
 * 所以退回 document.execCommand('copy')：虽然已废弃，但在非安全上下文里仍然可用。
 * 两条路都失败时返回 false，由调用方决定怎么把文本交给用户。
 */

/** 能不能用异步剪贴板 API（安全上下文 + 浏览器实现了它） */
export function hasAsyncClipboard(win = globalThis) {
  return Boolean(win?.isSecureContext) && typeof win?.navigator?.clipboard?.writeText === 'function'
}

/** 复制文本，成功返回 true。不抛异常。 */
export async function copyText(text, win = globalThis) {
  const str = String(text ?? '')
  if (hasAsyncClipboard(win)) {
    try {
      await win.navigator.clipboard.writeText(str)
      return true
    } catch {
      // 权限被拒或文档失焦：继续试老办法，不要直接放弃
    }
  }
  return execCommandCopy(str, win?.document)
}

function execCommandCopy(text, doc) {
  if (!doc?.body || typeof doc.execCommand !== 'function') return false
  // 必须挂在文档里、且不是 display:none / hidden，否则部分浏览器里 execCommand 会失败；
  // 用固定定位挪出视口，避免页面跟着滚动或闪一下
  const ta = doc.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;opacity:0'
  const prev = doc.activeElement
  doc.body.appendChild(ta)
  let ok = false
  try {
    ta.select()
    ta.setSelectionRange(0, text.length)
    ok = doc.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  // 焦点被我们抢走了，还给原来的元素（否则键盘快捷键会失效）
  if (prev && typeof prev.focus === 'function') prev.focus()
  return ok
}
