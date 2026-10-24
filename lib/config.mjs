import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeApps, isWsl } from './open.mjs'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 配置文件位置：
 *   - 默认是仓库根目录的 config.json（部署模型 A：直接运行源码）
 *   - WORKTREE_CONFIG 可以指向别处，测试/多实例时用
 *   - 内容含本机绝对路径，已在 .gitignore 里
 */
export function getConfigPath() {
  return process.env.WORKTREE_CONFIG
    ? resolve(process.env.WORKTREE_CONFIG)
    : join(here, '..', 'config.json')
}

// 默认值：不写死任何人的用户名。
// ~ 在 roots 里会被展开，避免仓库里出现 /home/<具体用户名>。
// host 默认只监听本机：这个服务有写操作，不应默认暴露到局域网。
const DEFAULTS = {
  port: 7801,
  // WSL 下 Windows 浏览器通常要通过 0.0.0.0 才能访问 Linux 侧端口；
  // 纯 Linux 默认只监听本机。配置文件里显式写了 host 就以配置为准。
  host: isWsl() ? '0.0.0.0' : '127.0.0.1',
  roots: ['~/codes'],
  scanMaxDepth: 4,
  stateCacheMs: 2000,
  scanCacheMs: 10000,
  maxPatchBytes: 2097152,
  apps: normalizeApps({}),
}

/** 展开 paths 里的 ~ */
function expandHome(p) {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/**
 * 老配置是 windows.{explorer,wt,code}，新配置是 apps.*。
 * 这里做一次映射，保证从 WSL 时代升级上来的 config.json 不用手改。
 */
function legacyApps(windows) {
  if (!windows || typeof windows !== 'object') return {}
  const pick = (v) => (typeof v === 'string' && v.trim() ? { command: v, args: [], pathStyle: 'auto' } : undefined)
  return {
    fileManager: pick(windows.explorer),
    terminal: pick(windows.wt),
    editor: pick(windows.code),
  }
}

export async function loadConfig() {
  const path = getConfigPath()
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    const apps = normalizeApps(parsed.apps || legacyApps(parsed.windows))
    const merged = { ...DEFAULTS, ...parsed, apps }
    merged.roots = (merged.roots || []).map(expandHome)
    return merged
  } catch (err) {
    // config.json 不存在（它是 .gitignore 里的本机配置，克隆后本来就没有）
    // 但如果是 JSON 语法错，必须让用户看见，否则设置页会静默显示默认值
    if (err.code !== 'ENOENT') console.warn(`[config] 读取 ${path} 失败，使用默认值：${err.message}`)
    return { ...DEFAULTS, apps: normalizeApps({}), roots: DEFAULTS.roots.map(expandHome) }
  }
}

/**
 * 设置页只改 apps，不碰端口/roots 这些需要重启的字段。
 * 写临时文件再 rename，避免写一半把配置弄坏。
 */
export async function saveApps(apps) {
  const path = getConfigPath()
  let raw = {}
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // 没有配置文件就用默认值新建
  }
  const normalized = normalizeApps(apps)
  raw.apps = normalized
  // 老的 windows 字段保留：万一用户回退到旧版本还能用；新版本优先读 apps
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
  return normalized
}
