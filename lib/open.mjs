/**
 * 打开外部程序（文件管理器 / 终端 / 编辑器）。
 *
 * 这个模块同时服务两种运行环境：
 *   - WSL：程序可能装在 Windows 侧（explorer.exe / wt.exe / code.cmd），
 *     路径要转成 \\wsl.localhost\<distro>\... 才能被 Windows 程序识别
 *   - 纯 Linux：程序是原生可执行文件，直接传 Linux 路径
 *
 * 判断依据只有“配置里的命令是不是 Windows 程序”和“当前是不是 WSL”，
 * 不依赖调用方写死平台。
 */

import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { release } from 'node:os'

const KINDS = ['fileManager', 'terminal', 'editor', 'zed']
const PATH_STYLES = new Set(['auto', 'native', 'windows'])

// 检测不到时的中文名和示例路径：给设置页/接口错误用，避免在函数里堆三元表达式
// label 里的前导空格是给中文与拉丁字母之间留的间距（“没有找到 Zed”）
const KIND_LABELS = {
  fileManager: ['文件管理器', '/usr/bin/xdg-open'],
  terminal: ['终端', '/usr/bin/konsole'],
  editor: ['编辑器', '/usr/bin/code'],
  zed: [' Zed', '/usr/bin/zed'],
}

const LINUX_FILE_MANAGERS = ['xdg-open', 'dolphin', 'nautilus', 'thunar', 'nemo', 'pcmanfm']
const LINUX_TERMINALS = [
  'konsole',
  'gnome-terminal',
  'xfce4-terminal',
  'kitty',
  'alacritty',
  'wezterm',
  'foot',
  'xterm',
]
const LINUX_EDITORS = ['code', 'codium', 'cursor']
// Zed 的 Linux 包同时提供 zed 和 zeditor 两个名字（zeditor 用于只开编辑器窗口）
const ZED_EDITORS = ['zed', 'zeditor']

/** 当前是否运行在 WSL 里。WSL_DISTRO_NAME 最可靠，release 兜底。 */
export function isWsl(env = process.env) {
  if (env.WSL_DISTRO_NAME) return true
  return /microsoft|wsl/i.test(release())
}

export function wslDistro(env = process.env) {
  if (env.WSL_DISTRO_NAME) return env.WSL_DISTRO_NAME
  // systemd 服务不会继承登录 shell 的 WSL_DISTRO_NAME；从 wslpath 的输出里反推，
  // 否则前端拿不到发行版名，UNC 复制和 wt.exe 的 -d 参数都会缺一块。
  try {
    const out = execFileSync('wslpath', ['-w', '/'], { encoding: 'utf8', timeout: 2000 }).trim()
    const m = out.match(/^\\\\wsl(?:\$|\.localhost)?\\([^\\]+)/)
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

/** 配置里的命令是不是 Windows 侧程序 */
export function isWindowsTool(command) {
  if (!command) return false
  return /\.(exe|cmd|bat)$/i.test(command) || /^\/mnt\/[a-z]\//i.test(command)
}

/** 需要 cmd.exe /c 才能执行的批处理 */
function isBatchFile(command) {
  return /\.(cmd|bat)$/i.test(command || '')
}

/** PATH 里找命令；找不到返回空串。只用于自动检测。 */
function which(name) {
  try {
    const out = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  } catch {
    return ''
  }
}

/** WSL 下 Windows 程序不一定在 Linux PATH 里，用 cmd.exe where 再找一次 */
function findWindowsCommand(name) {
  const direct = which(name)
  if (direct) return direct
  try {
    const out = execFileSync('cmd.exe', ['/c', 'where', name], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  } catch {
    return ''
  }
}

function findWindowsTerminal() {
  return findWindowsCommand('wt.exe')
}

/** 终端 emulator 的默认参数模板；用户显式配置了 args 时不会被调用 */
function terminalArgsFor(command) {
  const name = basename(command || '').toLowerCase()
  if (name.includes('konsole')) return ['--workdir', '{path}']
  if (name.includes('gnome-terminal')) return ['--working-directory', '{path}']
  if (name.includes('xfce4-terminal')) return ['--working-directory={path}']
  if (name.includes('kitty')) return ['--directory', '{path}']
  if (name.includes('alacritty')) return ['--working-directory', '{path}']
  if (name.includes('wezterm')) return ['start', '--cwd', '{path}']
  if (name.includes('foot')) return ['--working-directory={path}']
  // xterm 没有工作目录参数，用 sh -c 切目录；path 走位置参数，不拼进命令串
  if (name.includes('xterm')) return ['-e', 'sh', '-c', 'cd "$1" && exec "$SHELL"', 'sh', '{path}']
  return ['{path}']
}

function detectCommand(kind, ctx) {
  if (kind === 'fileManager') {
    if (ctx.isWsl) {
      const explorer = which('explorer.exe') || (existsSync('/mnt/c/Windows/explorer.exe') ? '/mnt/c/Windows/explorer.exe' : '')
      if (explorer) return explorer
    }
    return LINUX_FILE_MANAGERS.map(which).find(Boolean) || ''
  }
  if (kind === 'editor') {
    const native = LINUX_EDITORS.map(which).find(Boolean)
    if (native) return native
    // WSL 下如果只装了 Windows 版 VS Code，可能只有 code.cmd
    if (ctx.isWsl) return findWindowsCommand('code.cmd')
    return ''
  }
  // zed：只认 Linux 原生程序。Windows 版 Zed 没有能接 UNC 路径的启动器，
  // 填 zed.exe 会打开一个空窗口，不如直接判失败让用户看到提示。
  if (kind === 'zed') return ZED_EDITORS.map(which).find(Boolean) || ''
  // terminal：WSL 优先 Windows Terminal；否则用原生终端（含 $TERMINAL）
  if (ctx.isWsl) {
    const wt = findWindowsTerminal()
    if (wt) return wt
  }
  const fromEnv = process.env.TERMINAL ? which(process.env.TERMINAL) : ''
  if (fromEnv) return fromEnv
  return LINUX_TERMINALS.map(which).find(Boolean) || ''
}

function normalizeOne(value) {
  if (typeof value === 'string') return { command: value, args: [], pathStyle: 'auto' }
  return {
    command: String(value?.command || ''),
    args: Array.isArray(value?.args) ? value.args.map((a) => String(a)) : [],
    pathStyle: PATH_STYLES.has(value?.pathStyle) ? value.pathStyle : 'auto',
  }
}

/** 把配置文件里的 apps 统一成 { command, args, pathStyle } */
export function normalizeApps(raw = {}) {
  const out = {}
  for (const kind of KINDS) out[kind] = normalizeOne(raw[kind])
  return out
}

/**
 * 解析某个目标最终要执行的命令。
 * 只在 command 为空时才做自动检测，用户配置永远优先。
 */
export function resolveApp(apps, kind, ctx = platformInfo()) {
  const app = normalizeOne(apps?.[kind])
  let command = app.command.trim()
  let args = app.args.slice()
  const explicitArgs = args.length > 0
  let detected = false

  if (!command) {
    command = detectCommand(kind, ctx)
    detected = true
    if (!command) {
      const [label, example] = KIND_LABELS[kind] || [kind, '']
      return { error: `没有找到${label}：请在设置里填可执行文件路径（例如 ${example}）` }
    }
  }

  if (!args.length) {
    args = kind === 'terminal' ? terminalArgsFor(command) : ['{path}']
  }

  let pathStyle = app.pathStyle
  if (pathStyle === 'auto') {
    pathStyle = ctx.isWsl && isWindowsTool(command) ? 'windows' : 'native'
  }
  if (pathStyle === 'windows' && !ctx.isWsl) {
    return { error: '当前不是 WSL，不能使用 Windows UNC 路径；请把路径样式改成“原生”' }
  }

  return { command, args, pathStyle, detected, explicitArgs }
}

/**
 * 生成最终 spawn 的参数。
 * path 是 Linux 路径；是否转 UNC 由 pathStyle 决定。
 */
export function buildLaunch(apps, kind, path, ctx = platformInfo()) {
  const app = resolveApp(apps, kind, ctx)
  if (app.error) return app

  const command = app.command
  const name = basename(command).toLowerCase()
  const argPath = app.pathStyle === 'windows' ? toUnc(path, ctx.distro) : path

  // Windows Terminal 的默认行为不只是“传一个目录”：它要再拉起 wsl.exe 并 cd。
  // 用户显式写了带 {path} 的参数时不覆盖，留给用户自己控制。
  if (kind === 'terminal' && ctx.isWsl && name === 'wt.exe' && !app.explicitArgs) {
    const unc = toUnc(path, ctx.distro)
    const args = ['-d', unc, 'wsl.exe']
    if (ctx.distro) args.push('-d', ctx.distro)
    args.push('--cd', path)
    return { command, args, pathStyle: 'windows', detected: app.detected }
  }

  let args = app.args.map((a) => a.replaceAll('{path}', argPath))

  // .cmd / .bat 不能直接 exec，交给 cmd.exe。WSL interop 下 cmd.exe 在 PATH 里。
  if (isBatchFile(command)) {
    return { command: 'cmd.exe', args: ['/c', command, ...args], pathStyle: app.pathStyle, detected: app.detected }
  }

  return { command, args, pathStyle: app.pathStyle, detected: app.detected }
}

/** Linux 路径转 Windows UNC。没有 distro 时尝试 wslpath。 */
export function toUnc(path, distro = wslDistro()) {
  if (!path) return ''
  if (distro) return `\\\\wsl.localhost\\${distro}${path.replace(/\//g, '\\')}`
  try {
    return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim()
  } catch {
    return path
  }
}

/** 后台启动 GUI 程序。等 spawn 事件再返回，ENOENT 能报给调用方。 */
export function launchDetached(command, args) {
  return new Promise((resolve) => {
    let settled = false
    let child
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore' })
    } catch (err) {
      resolve({ ok: false, error: `启动 ${command} 失败：${err.message}` })
      return
    }
    child.once('error', (err) => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: `启动 ${command} 失败：${err.message}` })
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      child.unref()
      resolve({ ok: true })
    })
  })
}

export async function openTarget(apps, kind, path, ctx) {
  const built = buildLaunch(apps, kind, path, ctx)
  if (built.error) return { ok: false, error: built.error }
  return launchDetached(built.command, built.args)
}

/** 给设置页展示“自动检测到什么” */
export function describeApps(apps, ctx = platformInfo()) {
  const out = {}
  for (const kind of KINDS) {
    const app = resolveApp(apps, kind, ctx)
    out[kind] = app.error
      ? { error: app.error, pathStyle: 'auto', args: [] }
      : { command: app.command, args: app.args, pathStyle: app.pathStyle, detected: app.detected }
  }
  return out
}

export function platformInfo(env = process.env) {
  const wsl = isWsl(env)
  return {
    platform: wsl ? 'wsl' : 'linux',
    distro: wsl ? wslDistro(env) : '',
  }
}
