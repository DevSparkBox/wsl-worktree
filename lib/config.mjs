import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises'
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

// 设置页可写的字段。port / host 故意不在里面：它们决定服务怎么监听，属于安全边界，
// 只允许手改 config.json 后重启，避免在网页上一键把写接口暴露到局域网。
export const EDITABLE_KEYS = ['roots', 'scanMaxDepth', 'stateCacheMs', 'scanCacheMs', 'maxPatchBytes']

const LIMITS = {
  scanMaxDepth: [1, 12],
  stateCacheMs: [0, 60000],
  scanCacheMs: [0, 600000],
  maxPatchBytes: [65536, 67108864],
}

const LABELS = {
  scanMaxDepth: '扫描深度',
  stateCacheMs: '状态缓存时间',
  scanCacheMs: '扫描缓存时间',
  maxPatchBytes: '补丁大小上限',
}

// 启动读取时用更宽的范围：老配置里可能有设置页不允许的值，不能静默改掉；
// 只有明显非法（类型错、负数）才回退默认值。
const LOAD_LIMITS = {
  port: [1, 65535],
  scanMaxDepth: [1, 64],
  stateCacheMs: [0, 3600000],
  scanCacheMs: [0, 3600000],
  maxPatchBytes: [1024, 268435456],
}

/** 展开 paths 里的 ~ */
function expandHome(p) {
  if (p === '~') return homedir()
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

/** 运行时用：把 roots 里的 ~ 展开成绝对路径 */
export function expandRoots(roots) {
  return (roots || []).map(expandHome)
}

function intIn(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function isRootText(value) {
  return typeof value === 'string' && (value === '~' || value.startsWith('/') || value.startsWith('~/'))
}

/** roots 只要结构合法就保留（不在这里 stat，避免启动被慢盘拖住） */
function rootsWellFormed(roots) {
  if (!Array.isArray(roots) || roots.length === 0) return false
  return roots.every((r) => isRootText(r) && resolve(expandHome(r)) !== '/')
}

/**
 * 从原始 JSON 里挑出配置字段并做防御性回退。
 * 手工改配置写错值时，服务要能起来（回退默认值 + 日志），不能直接崩。
 */
function savedConfig(raw = {}) {
  return {
    port: intIn(raw.port, ...LOAD_LIMITS.port) ? raw.port : DEFAULTS.port,
    host: typeof raw.host === 'string' ? raw.host : DEFAULTS.host,
    roots: rootsWellFormed(raw.roots) ? raw.roots : [...DEFAULTS.roots],
    scanMaxDepth: intIn(raw.scanMaxDepth, ...LOAD_LIMITS.scanMaxDepth) ? raw.scanMaxDepth : DEFAULTS.scanMaxDepth,
    stateCacheMs: intIn(raw.stateCacheMs, ...LOAD_LIMITS.stateCacheMs) ? raw.stateCacheMs : DEFAULTS.stateCacheMs,
    scanCacheMs: intIn(raw.scanCacheMs, ...LOAD_LIMITS.scanCacheMs) ? raw.scanCacheMs : DEFAULTS.scanCacheMs,
    maxPatchBytes: intIn(raw.maxPatchBytes, ...LOAD_LIMITS.maxPatchBytes) ? raw.maxPatchBytes : DEFAULTS.maxPatchBytes,
  }
}

function warnFallbacks(raw, picked) {
  for (const key of Object.keys(picked)) {
    if (raw[key] === undefined) continue
    if (JSON.stringify(raw[key]) !== JSON.stringify(picked[key])) {
      console.warn(`[config] ${key} 不合法或超出范围，已回退默认值`)
    }
  }
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件顶层不是 JSON 对象')
    }
    const apps = normalizeApps(parsed.apps || legacyApps(parsed.windows))
    const general = savedConfig(parsed)
    warnFallbacks(parsed, general)
    return {
      ...parsed,
      ...general,
      // 内存里始终用展开后的绝对路径，写回时仍用文件里的原始写法（比如 ~/codes）
      roots: expandRoots(general.roots),
      apps,
    }
  } catch (err) {
    // config.json 不存在（它是 .gitignore 里的本机配置，克隆后本来就没有）
    // 但如果是 JSON 语法错，必须让用户看见，否则设置页会静默显示默认值
    if (err.code !== 'ENOENT') console.warn(`[config] 读取 ${path} 失败，使用默认值：${err.message}`)
    return { ...DEFAULTS, apps: normalizeApps({}), roots: expandRoots(DEFAULTS.roots) }
  }
}

/**
 * 读磁盘上的配置，给设置页做「已保存值」展示。
 * 和 loadConfig 不同：这里不展开 ~，也不改运行中的 cfg；读坏了返回 error 而不是抛异常。
 */
export async function readSavedConfig() {
  const path = getConfigPath()
  try {
    const raw = JSON.parse(await readFile(path, 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('配置文件顶层不是 JSON 对象')
    }
    return { path, config: savedConfig(raw), error: null }
  } catch (err) {
    if (err.code === 'ENOENT') return { path, config: savedConfig({}), error: null }
    return { path, config: savedConfig({}), error: err.message }
  }
}

function fieldError(field, message) {
  const err = new Error(message)
  err.field = field
  return err
}

/** 设置页提交的 roots：必须是至少一个、真实存在的目录；文件里保留用户写的 ~/ 形式 */
async function normalizeRoots(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw fieldError('roots', '至少需要保留一个扫描根目录')
  }
  if (input.length > 10) {
    throw fieldError('roots', '扫描根目录最多 10 个')
  }

  const out = []
  const seen = new Set()
  for (const item of input) {
    if (typeof item !== 'string') throw fieldError('roots', '扫描根目录必须是字符串')
    const raw = item.trim()
    if (!raw) throw fieldError('roots', '扫描根目录不能为空')
    if (!isRootText(raw)) {
      throw fieldError('roots', `扫描根目录必须是绝对路径或 ~/ 开头：${raw}`)
    }

    const abs = expandHome(raw)
    if (resolve(abs) === '/') throw fieldError('roots', '不能把 / 作为扫描根目录')

    let st
    try {
      st = await stat(abs)
    } catch {
      throw fieldError('roots', `扫描根目录不存在：${raw}`)
    }
    if (!st.isDirectory()) throw fieldError('roots', `扫描根目录不是目录：${raw}`)

    // 同一条路径的 ~/x 和 /home/u/x 视为重复，保留第一次的写法
    const key = resolve(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(raw)
  }
  return out
}

/** 只做校验和归一化，不落盘。端口/host 在这里被明确拒绝。 */
export async function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw fieldError('config', '配置格式不对')
  }
  for (const key of Object.keys(input)) {
    if (key === 'port' || key === 'host') {
      throw fieldError(key, '端口和监听地址是只读项，只能手改 config.json 后重启')
    }
    if (!EDITABLE_KEYS.includes(key)) {
      throw fieldError(key, `不认识的配置项：${key}`)
    }
  }

  const out = {}
  if ('roots' in input) out.roots = await normalizeRoots(input.roots)
  for (const key of EDITABLE_KEYS) {
    if (key === 'roots' || !(key in input)) continue
    const [min, max] = LIMITS[key]
    const value = input[key]
    if (!Number.isInteger(value) || value < min || value > max) {
      throw fieldError(key, `${LABELS[key]}必须是 ${min}–${max} 之间的整数`)
    }
    out[key] = value
  }
  return out
}

// 写回串行化：设置页可能开多个标签页，读-改-写不能交错，否则后保存的会丢掉前一个的字段
let writeChain = Promise.resolve()

/**
 * 只写设置页允许改的字段，未知字段（老 windows 等）原样保留。
 * 先写临时文件再 rename，避免写一半把配置弄坏。
 * 配置文件本身 JSON 坏了时拒绝写入，不能拿空对象把用户其他配置覆盖掉。
 */
export async function saveSettings({ apps, config } = {}) {
  if (apps === undefined && config === undefined) throw new Error('没有要保存的配置')
  const normalizedApps = apps === undefined ? undefined : normalizeApps(apps)
  const normalizedConfig = config === undefined ? undefined : await validateSettings(config)

  const run = async () => {
    const path = getConfigPath()
    let raw
    try {
      raw = JSON.parse(await readFile(path, 'utf8'))
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('配置文件顶层不是 JSON 对象')
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`配置文件读取失败，未写入：${err.message}`)
      raw = {}
    }

    if (normalizedApps !== undefined) raw.apps = normalizedApps
    if (normalizedConfig !== undefined) Object.assign(raw, normalizedConfig)

    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${process.pid}`
    // 配置里可能有家目录路径；新建文件用 600，别让同机其他用户顺手读到
    await writeFile(tmp, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)

    return {
      apps: normalizeApps(raw.apps || legacyApps(raw.windows)),
      config: savedConfig(raw),
    }
  }

  const pending = writeChain.then(run, run)
  // 前一次失败不能卡死后面的保存；错误仍然抛给当前调用方
  writeChain = pending.catch(() => {})
  return pending
}

/** 兼容旧接口：设置页最初只保存外部工具 */
export async function saveApps(apps) {
  return (await saveSettings({ apps })).apps
}
