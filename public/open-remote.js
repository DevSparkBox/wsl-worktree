/**
 * 「打开方式：远程」用到的字符串构造。
 *
 * 场景：浏览器在 Windows / macOS，服务跑在另一台 Linux 上。服务器替你启动的
 * 文件管理器 / 终端 / 编辑器只会出现在那台机器的桌面上，所以远程模式只能做两件事：
 *   1. 交给浏览器的自定义协议去唤起本机程序（vscode://）
 *   2. 把命令行塞进剪贴板，用户自己粘到本机终端
 * 两者都是纯字符串拼装，单独成模块方便直接测（和 fuzzy.js / tree-model.js 一样）。
 */

/** SSH 目标：user@host、host、host:port，或 ~/.ssh/config 里的别名 */
const TARGET_RE = /^[A-Za-z0-9_.@:-]+$/

/** 校验 SSH 主机写法。远程模式必须有目标，空串不算合法。 */
export function validSshTarget(value) {
  const v = String(value ?? '').trim()
  if (!v || v.length > 200) return false
  // 只允许会出现在 ssh 参数里的字符：它最终会进 URI 和命令行，不能带空格引号分号
  return TARGET_RE.test(v) && !/^[.:@-]/.test(v)
}

/** 逐段百分号编码，保留 /（VS Code / Zed 都会按 URI 规则解码路径） */
const encodePath = (path) => String(path || '').split('/').map(encodeURIComponent).join('/')

/**
 * VS Code 的 Remote-SSH URI，浏览器跳转就唤起浏览器所在电脑上的 VS Code。
 * 形如 vscode://vscode-remote/ssh-remote+user@host/home/u/proj
 * target 必须是那台电脑上 ssh 能直接用的名字（ssh config 别名或 user@ip）。
 */
export function vscodeRemoteUri(target, path) {
  return `vscode://vscode-remote/ssh-remote+${target}${encodePath(path)}`
}

/**
 * 粘进本机终端用的登录命令：登录后在远端 cd 到目标并起一个交互 shell。
 * 外层单引号在 PowerShell / bash / zsh 里都是「原样传递」，里面再用双引号包路径。
 * 路径里出现引号、$、反斜杠时各终端转义规则不一致，这时宁可只给登录命令，
 * 也不要给一条可能 cd 到错地方的命令。
 */
export function sshCommand(target, path) {
  const p = String(path || '')
  if (!p || /["'`$\\]/.test(p)) return `ssh -t ${target}`
  return `ssh -t ${target} 'cd "${p}" && exec $SHELL'`
}

/**
 * Zed 的远程项目命令。只复制不执行：`zed ssh://` 的支持跟 Zed 版本有关，
 * 让用户先看到完整命令再决定要不要回车。
 */
export function zedRemoteCommand(target, path) {
  return `zed ssh://${target}${encodePath(path)}`
}
