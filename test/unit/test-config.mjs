// 配置加载/写回的纯逻辑测试：老 windows 字段映射、设置页写回、校验与坏配置回退。
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadConfig,
  saveApps,
  saveSettings,
  validateSettings,
  readSavedConfig,
  getConfigPath,
} from '../../lib/config.mjs'

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(38)} ${d}`) }
const rejects = async (fn) => {
  try { await fn() } catch (err) { return err }
  return null
}

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

  // ---- 设置页：只读字段、roots 校验、通用配置写回 ----
  let err = await rejects(() => validateSettings({ port: 7802 }))
  check('拒绝通过设置页改端口', err?.field === 'port', err?.message)
  err = await rejects(() => validateSettings({ host: '0.0.0.0' }))
  check('拒绝通过设置页改 host', err?.field === 'host', err?.message)
  err = await rejects(() => validateSettings({ roots: [] }))
  check('roots 不允许为空', err?.field === 'roots', err?.message)
  err = await rejects(() => validateSettings({ roots: ['/'] }))
  check('roots 不允许是 /', err?.field === 'roots', err?.message)
  err = await rejects(() => validateSettings({ roots: [join(dir, 'nope')] }))
  check('roots 必须存在', err?.field === 'roots', err?.message)
  err = await rejects(() => validateSettings({ scanMaxDepth: 0 }))
  check('扫描深度范围校验', err?.field === 'scanMaxDepth', err?.message)
  err = await rejects(() => validateSettings({ maxPatchBytes: '2048' }))
  check('数字字段拒绝字符串', err?.field === 'maxPatchBytes', err?.message)
  err = await rejects(() => validateSettings({ typo: 1 }))
  check('拒绝未知配置项', err?.field === 'typo', err?.message)

  const savedGeneral = await saveSettings({
    config: {
      roots: [dir],
      scanMaxDepth: 6,
      stateCacheMs: 100,
      scanCacheMs: 200,
      maxPatchBytes: 1048576,
    },
  })
  check('saveSettings 返回通用配置', savedGeneral.config.scanMaxDepth === 6 && savedGeneral.config.roots[0] === dir, JSON.stringify(savedGeneral.config))

  const rawGeneral = JSON.parse(await readFile(file, 'utf8'))
  check('通用配置写回文件', rawGeneral.scanMaxDepth === 6 && rawGeneral.roots[0] === dir, JSON.stringify(rawGeneral))
  check('通用配置写回保留 apps', rawGeneral.apps.fileManager.command === '/usr/bin/xdg-open', JSON.stringify(rawGeneral.apps?.fileManager))
  check('通用配置写回保留 windows', rawGeneral.windows?.wt === '/mnt/c/wt.exe', JSON.stringify(rawGeneral.windows))

  // 只保存 apps 时不能把刚写的通用配置覆盖回默认
  await saveSettings({
    apps: {
      fileManager: { command: '/usr/bin/nautilus', args: [], pathStyle: 'native' },
      terminal: { command: '', args: [], pathStyle: 'auto' },
      editor: { command: '', args: [], pathStyle: 'auto' },
    },
  })
  const rawApps = JSON.parse(await readFile(file, 'utf8'))
  check('apps 写回保留通用配置', rawApps.scanMaxDepth === 6 && rawApps.scanCacheMs === 200, JSON.stringify(rawApps))

  // ~ 写法要原样落盘、读回时再展开
  const savedHome = await saveSettings({ config: { roots: ['~'] } })
  check('roots 落盘保留 ~', savedHome.config.roots[0] === '~', JSON.stringify(savedHome.config.roots))
  const loadedHome = await loadConfig()
  check('加载时展开 ~', loadedHome.roots[0] !== '~' && loadedHome.roots[0].startsWith('/'), loadedHome.roots[0])

  const view = await readSavedConfig()
  check('readSavedConfig 返回路径', view.path === file && view.error === null, `${view.path} ${view.error || ''}`)

  // ---- 坏配置：能显示错误、拒绝写入、启动回退默认 ----
  await writeFile(file, '{ 坏掉的 json')
  const broken = await readSavedConfig()
  check('坏配置读取出错', Boolean(broken.error), broken.error)
  err = await rejects(() => saveSettings({ apps: {} }))
  check('坏配置拒绝写入', Boolean(err) && !String(err.message).includes('ENOENT'), err?.message)
  const fallback = await loadConfig()
  check('坏配置启动回退默认端口', fallback.port === 7801, String(fallback.port))
  check('坏配置启动回退默认 roots', fallback.roots[0].startsWith('/'), fallback.roots[0])
} finally {
  delete process.env.WORKTREE_CONFIG
  await rm(dir, { recursive: true, force: true })
}

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
