// 设置页接口：只读项拒绝、roots 校验、通用配置写回与热生效。
// 只在 test-api.sh 的隔离服务上跑：会真的改 config.json。
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = process.env.BASE || 'http://127.0.0.1:7801'
const TMP = process.env.WT_TEST_TMP
if (!TMP) {
  console.error('需要 WT_TEST_TMP（由 test/api/test-api.sh 提供），避免改到生产配置')
  process.exit(1)
}

const checks = []
const check = (n, ok, d = '') => { checks.push([n, ok, d]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(36)} ${d}`) }

const get = async (p) => {
  const res = await fetch(BASE + p)
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const post = async (p, body) => {
  const res = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const NEW_ROOT = join(TMP, 'settings-root')
mkdirSync(NEW_ROOT, { recursive: true })

const first = await get('/api/settings')
const original = first.body
const path = original.configPath
if (!path || !path.startsWith(TMP)) {
  console.error(`配置文件不在测试目录下（${path}），拒绝继续`)
  process.exit(1)
}

check('返回配置文件路径', path.startsWith(TMP), path)
check('返回只读端口', Number.isInteger(original.config.port) && original.config.port === original.effective.port, JSON.stringify(original.effective))
check('初始无需重启', Array.isArray(original.restartRequired) && original.restartRequired.length === 0, JSON.stringify(original.restartRequired))
check('返回全部可编辑项', ['roots', 'scanMaxDepth', 'stateCacheMs', 'scanCacheMs', 'maxPatchBytes'].every((k) => k in original.config), '')

const originalFile = readFileSync(path, 'utf8')
const beforeRaw = JSON.parse(originalFile)
const originalApps = original.apps

let r = await post('/api/settings', { config: { roots: [NEW_ROOT], scanMaxDepth: 5, stateCacheMs: 123, scanCacheMs: 456, maxPatchBytes: 1048576 } })
check('保存通用配置 200', r.status === 200 && r.body.ok === true, r.body.error || '')
check('响应立即生效', r.body.effective?.scanMaxDepth === 5 && r.body.effective?.roots?.[0] === NEW_ROOT, JSON.stringify(r.body.effective))

const savedRaw = JSON.parse(readFileSync(path, 'utf8'))
check('写回 roots', savedRaw.roots?.[0] === NEW_ROOT, JSON.stringify(savedRaw.roots))
check('写回缓存/上限', savedRaw.stateCacheMs === 123 && savedRaw.scanCacheMs === 456 && savedRaw.maxPatchBytes === 1048576, JSON.stringify(savedRaw))
check('写回保留 apps', savedRaw.apps?.fileManager?.command === beforeRaw.apps?.fileManager?.command, JSON.stringify(savedRaw.apps?.fileManager))
check('写回保留未知字段', savedRaw.port === beforeRaw.port && savedRaw.host === beforeRaw.host, `port=${savedRaw.port} host=${savedRaw.host}`)

r = await post('/api/settings', { config: { roots: [NEW_ROOT], scanMaxDepth: 4, stateCacheMs: 2000, scanCacheMs: 10000, maxPatchBytes: 2097152, port: 7802 } })
check('拒绝改端口', r.status === 400 && r.body.field === 'port', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { config: { roots: [NEW_ROOT], scanMaxDepth: 4, stateCacheMs: 2000, scanCacheMs: 10000, maxPatchBytes: 2097152, host: '0.0.0.0' } })
check('拒绝改 host', r.status === 400 && r.body.field === 'host', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { config: { roots: [] } })
check('roots 不允许为空', r.status === 400 && r.body.field === 'roots', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { config: { roots: ['/'] } })
check('roots 不允许是 /', r.status === 400 && r.body.field === 'roots', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { config: { roots: [join(TMP, 'not-exist')] } })
check('roots 必须存在', r.status === 400 && r.body.field === 'roots', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { config: { roots: [NEW_ROOT], scanDepth: 4 } })
check('拒绝未知配置项', r.status === 400 && r.body.field === 'scanDepth', `${r.status} ${r.body.error || ''}`)

r = await post('/api/settings', { apps: originalApps })
check('只存 apps 不覆盖通用配置', r.status === 200 && r.body.config?.scanMaxDepth === 5, JSON.stringify(r.body.config))

// 手工改配置（模拟直接编辑 config.json）后，页面应能提示待重启，但运行值不变
const manual = JSON.parse(readFileSync(path, 'utf8'))
manual.port = Number(manual.port) + 1
writeFileSync(path, `${JSON.stringify(manual, null, 2)}\n`)
const pending = await get('/api/settings')
check('手工改端口提示需重启', pending.body.restartRequired?.includes('port') === true, JSON.stringify(pending.body.restartRequired))
check('待重启时运行值不变', pending.body.effective.port === original.effective.port, `${pending.body.effective.port}`)
writeFileSync(path, originalFile)

// 收尾：把隔离配置恢复成原样，避免影响后续脚本
const restored = await post('/api/settings', {
  config: {
    roots: original.config.roots,
    scanMaxDepth: original.config.scanMaxDepth,
    stateCacheMs: original.config.stateCacheMs,
    scanCacheMs: original.config.scanCacheMs,
    maxPatchBytes: original.config.maxPatchBytes,
  },
  apps: originalApps,
})
check('恢复初始配置', restored.status === 200 && restored.body.config?.scanMaxDepth === original.config.scanMaxDepth, restored.body.error || '')

const final = await get('/api/settings')
check('恢复后无需重启', final.body.restartRequired?.length === 0, JSON.stringify(final.body.restartRequired))
rmSync(NEW_ROOT, { recursive: true, force: true })

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
