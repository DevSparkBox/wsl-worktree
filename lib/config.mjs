import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

// 默认值：不写死任何人的用户名。
// ~ 在 roots 里会被展开，避免仓库里出现 /home/<具体用户名>。
const DEFAULTS = {
  port: 7801,
  host: '0.0.0.0',
  roots: ['~/codes'],
  scanMaxDepth: 4,
  stateCacheMs: 8000,
  scanCacheMs: 30000,
  maxPatchBytes: 2097152,
  windows: {
    explorer: '/mnt/c/Windows/explorer.exe',
    wt: '',   // 留空则不启用 Windows Terminal 按钮，由 config.json 自行填
    // VS Code 的可执行文件（Windows 侧 code.cmd）。
    // 留空时只用 WSL 里的 code 命令（装了 Remote - WSL 就有）
    code: '',
  },
}

/** 展开 paths 里的 ~ */
function expandHome(p) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p
}

export async function loadConfig() {
  const path = join(here, '..', 'config.json')
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULTS, ...parsed, windows: { ...DEFAULTS.windows, ...(parsed.windows || {}) } }
    merged.roots = (merged.roots || []).map(expandHome)
    return merged
  } catch {
    // config.json 不存在（它是 .gitignore 里的本机配置，克隆后本来就没有）
    return { ...DEFAULTS, roots: DEFAULTS.roots.map(expandHome) }
  }
}
