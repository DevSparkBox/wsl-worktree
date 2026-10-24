// 配置加载/写回的纯逻辑测试：老 windows 字段映射、设置页只改 apps。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, saveApps, getConfigPath } from '../../lib/config.mjs'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }

const dir = await mkdtemp(join(tmpdir(), 'wt-config-'))
const file = join(dir, 'config.json')
process.env.WORKTREE_CONFIG = file

try {
  await writeFile(file, JSON.stringify({
    port: 7999,
    windows: { explorer: '/mnt/c/Windows/explorer.exe', wt: '/mnt/c/wt.exe', code: '' },
  }))
  let cfg = await loadConfig()
  check('WORKTREE_CONFIG 生效', getConfigPath() === file, getConfigPath())
  check('老 explorer 映射到 fileManager', cfg.apps.fileManager.command === '/mnt/c/Windows/explorer.exe', JSON.stringify(cfg.apps.fileManager))
  check('老 wt 映射到 terminal', cfg.apps.terminal.command === '/mnt/c/wt.exe', JSON.stringify(cfg.apps.terminal))
  check('空 windows.code 不强塞命令', cfg.apps.editor.command === '', JSON.stringify(cfg.apps.editor))
  check('端口保留', cfg.port === 7999, String(cfg.port))

  const saved = await saveApps({
    fileManager: { command: '/usr/bin/xdg-open', args: ['{path}'], pathStyle: 'native' },
    terminal: { command: '/usr/bin/konsole', args: [], pathStyle: 'auto' },
    editor: { command: '', args: [], pathStyle: 'auto' },
  })
  check('saveApps 返回归一化结果', saved.fileManager.pathStyle === 'native' && saved.editor.command === '', JSON.stringify(saved))

  const raw = JSON.parse(await readFile(file, 'utf8'))
  check('写回保留 port', raw.port === 7999, String(raw.port))
  check('写回保留老 windows', raw.windows?.wt === '/mnt/c/wt.exe', JSON.stringify(raw.windows))
  check('写回 apps 已更新', raw.apps.fileManager.command === '/usr/bin/xdg-open', JSON.stringify(raw.apps.fileManager))
} finally {
  delete process.env.WORKTREE_CONFIG
  await rm(dir, { recursive: true, force: true })
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
