// 外部程序打开逻辑的纯函数测试：不启动任何 GUI，只验证命令/参数/路径样式。
import {
  isWsl,
  isWindowsTool,
  normalizeApps,
  resolveApp,
  buildLaunch,
  toUnc,
  platformInfo,
} from './lib/open.mjs'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

const linux = { isWsl: false, distro: '' }
const wsl = { isWsl: true, distro: 'archlinux' }

const apps = normalizeApps({
  fileManager: { command: '/usr/bin/xdg-open', args: [], pathStyle: 'auto' },
  terminal: { command: '/usr/bin/konsole', args: [], pathStyle: 'auto' },
  editor: { command: '/usr/bin/code', args: [], pathStyle: 'auto' },
})

const linuxFm = buildLaunch(apps, 'fileManager', '/home/u/codes/repo', linux)
check('Linux 文件管理器用原生路径', linuxFm.command === '/usr/bin/xdg-open' && linuxFm.args[0] === '/home/u/codes/repo', JSON.stringify(linuxFm))

const linuxTerm = buildLaunch(apps, 'terminal', '/home/u/codes/repo', linux)
check('Konsole 自动加 --workdir', linuxTerm.command === '/usr/bin/konsole' && JSON.stringify(linuxTerm.args) === JSON.stringify(['--workdir', '/home/u/codes/repo']), JSON.stringify(linuxTerm))

const wslFm = buildLaunch(
  normalizeApps({ fileManager: { command: '/mnt/c/Windows/explorer.exe', args: [], pathStyle: 'auto' } }),
  'fileManager',
  '/home/u/codes/repo',
  wsl
)
check('WSL explorer 转 UNC', wslFm.args[0] === '\\\\wsl.localhost\\archlinux\\home\\u\\codes\\repo', JSON.stringify(wslFm))

const wslEditor = buildLaunch(
  normalizeApps({ editor: { command: '/usr/bin/code', args: [], pathStyle: 'auto' } }),
  'editor',
  '/home/u/codes/repo',
  wsl
)
check('WSL 原生 code 保留 Linux 路径', wslEditor.args[0] === '/home/u/codes/repo', JSON.stringify(wslEditor))

const wslCmdEditor = buildLaunch(
  normalizeApps({ editor: { command: '/mnt/c/Program Files/Microsoft VS Code/bin/code.cmd', args: [], pathStyle: 'auto' } }),
  'editor',
  '/home/u/codes/repo',
  wsl
)
check('code.cmd 走 cmd.exe', wslCmdEditor.command === 'cmd.exe' && wslCmdEditor.args[0] === '/c', JSON.stringify(wslCmdEditor))
check('code.cmd 参数是 UNC', wslCmdEditor.args[2] === '\\\\wsl.localhost\\archlinux\\home\\u\\codes\\repo', JSON.stringify(wslCmdEditor.args))

const wt = buildLaunch(
  normalizeApps({ terminal: { command: '/mnt/c/Users/u/AppData/Local/Microsoft/WindowsApps/wt.exe', args: [], pathStyle: 'auto' } }),
  'terminal',
  '/home/u/codes/repo',
  wsl
)
check('wt 用 -d UNC 拉起 wsl.exe', wt.args[0] === '-d' && wt.args[1].startsWith('\\\\wsl.localhost\\') && wt.args.includes('wsl.exe'), JSON.stringify(wt.args))

const explicit = buildLaunch(
  normalizeApps({ terminal: { command: '/usr/bin/konsole', args: ['--workdir={path}', '--hold'], pathStyle: 'auto' } }),
  'terminal',
  '/home/u/codes/repo',
  linux
)
check('显式参数替换 {path}', JSON.stringify(explicit.args) === JSON.stringify(['--workdir=/home/u/codes/repo', '--hold']), JSON.stringify(explicit.args))

const forced = buildLaunch(
  normalizeApps({ fileManager: { command: '/usr/bin/xdg-open', args: [], pathStyle: 'windows' } }),
  'fileManager',
  '/home/u/codes/repo',
  linux
)
check('Linux 禁止强制 UNC', Boolean(forced.error), forced.error || '')

check('toUnc 拼 distro', toUnc('/home/u/a b', 'Ubuntu') === '\\\\wsl.localhost\\Ubuntu\\home\\u\\a b', toUnc('/home/u/a b', 'Ubuntu'))
check('isWindowsTool 识别 exe', isWindowsTool('/mnt/c/x.exe') && isWindowsTool('code.cmd') && !isWindowsTool('/usr/bin/code'), '')
check('platformInfo 识别 WSL 环境变量', platformInfo({ WSL_DISTRO_NAME: 'archlinux' }).platform === 'wsl', '')
check('isWsl 默认 Linux', isWsl({}) === false || process.env.WSL_DISTRO_NAME, String(isWsl({})))

const stringApp = normalizeApps({ editor: '/usr/bin/code' })
check('字符串写法归一化', stringApp.editor.command === '/usr/bin/code' && stringApp.editor.pathStyle === 'auto', JSON.stringify(stringApp.editor))

// 自动检测依赖 PATH；临时清空，模拟“什么都没装”的机器
const oldPath = process.env.PATH
process.env.PATH = '/nonexistent-path-for-test'
try {
  const noEditor = resolveApp(normalizeApps({ editor: { command: '' } }), 'editor', linux)
  check('找不到编辑器时报中文错误', Boolean(noEditor.error) && /编辑器/.test(noEditor.error), noEditor.error || '')

  const missingPath = buildLaunch(
    normalizeApps({ editor: { command: '', args: [], pathStyle: 'auto' } }),
    'editor',
    '/home/u/codes/repo',
    linux
  )
  check('命令缺失时不抛异常', Boolean(missingPath.error), missingPath.error || '')
} finally {
  process.env.PATH = oldPath
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
