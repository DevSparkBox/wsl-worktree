/**
 * 克隆仓库。
 *
 * 和别的 git 操作不一样：clone 是**长任务**（几万文件的仓库要几分钟），
 * 不能用 execFile 等它跑完再返回 HTTP 响应。所以做成后台 job：
 *   startClone() → jobId，前端轮询 getClone(jobId) 拿进度。
 *
 * 进度从 `git clone --progress` 的 stderr 里解析。git 用 \r 原地刷新同一行，
 * 所以按 [\r\n] 切分，最后一段可能不完整，留到下次再拼。
 *
 * 环境变量与 lib/git.mjs 保持一致：把所有可能弹交互的通道都堵死
 * （GIT_TERMINAL_PROMPT=0 / ASKPASS=true），否则遇到要密码的仓库会一直挂着。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_EDITOR: 'true',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_ASKPASS: 'true',
  SSH_ASKPASS: 'true',
  GIT_MERGE_AUTOEDIT: 'no',
}

/** 阶段名翻成中文，界面上直接显示 */
const PHASE_LABEL = {
  'Enumerating objects': '统计对象',
  'Counting objects': '计数对象',
  'Compressing objects': '压缩对象',
  'Receiving objects': '接收数据',
  'Resolving deltas': '解析差异',
  'Updating files': '检出文件',
  'Updating working tree': '检出文件',
}

// git 的进度行：`Receiving objects:  45% (1200/2666), 3.2 MiB | 1.1 MiB/s`
const RE_PROGRESS = /(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Updating files|Updating working tree)\s*:?\s*(\d+)%/
const RE_RATE = /(\d+(?:\.\d+)?\s*[KMG]iB\s*\|\s*\d+(?:\.\d+)?\s*[KMG]iB\/s)/

const jobs = new Map()
let seq = 0

/** 完成的任务保留一段时间供前端查询，之后清掉 */
const KEEP_MS = 5 * 60 * 1000
const MAX_JOBS = 30
const DEFAULT_TIMEOUT = 10 * 60 * 1000

/**
 * 解析一行 git 进度输出。
 *
 * 输入形如：`Receiving objects:  45% (1200/2666), 3.2 MiB | 1.1 MiB/s`
 * 命中返回 { phase, percent, rate }；不是进度行返回 null。
 *
 * 单独抽出来是因为这是唯一有解析逻辑的地方，埋进 startClone 里没法单测。
 */
export function parseProgressLine(line) {
  const m = String(line || '').match(RE_PROGRESS)
  if (!m) return null
  const r = String(line).match(RE_RATE)
  return {
    phase: PHASE_LABEL[m[1]] || m[1],
    percent: Math.min(100, Number(m[2])),
    rate: r ? r[1] : '',
  }
}

/** 把一段 stderr 按 \r / \n 切成完整的行，返回 [lines, 残留] */
export function splitProgressChunk(buf) {
  const parts = String(buf || '').split(/[\r\n]/)
  const rest = parts.pop() || ''
  return [parts, rest]
}

function gc() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > KEEP_MS) jobs.delete(id)
  }
  // 兜底：太多了就丢最老的（按 startedAt）
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt)
    for (const j of sorted.slice(0, jobs.size - MAX_JOBS)) {
      if (j.status !== 'running') jobs.delete(j.id)
    }
  }
}

/** 从 stderr 里挑一条人能看懂的错误 */
function pickError(job) {
  const lines = job.tail.filter(Boolean)
  const fatal = lines.filter((l) => /^(fatal|error):/i.test(l))
  if (fatal.length) return fatal[fatal.length - 1].replace(/^(fatal|error):\s*/i, '')
  if (lines.length) return lines[lines.length - 1]
  return '克隆失败（git 没有给出原因）'
}

/**
 * 启动克隆。
 * @param {{url:string, dir:string, depth1?:boolean, submodules?:boolean, timeoutMs?:number}} opts
 * @returns {string} jobId
 */
export function startClone(opts) {
  const { url, dir, depth1 = false, submodules = false } = opts
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT

  const id = `cl${++seq}-${Date.now().toString(36)}`
  const job = {
    id,
    url,
    dir,
    status: 'running',
    phase: '准备中',
    percent: 0,
    rate: '',
    error: '',
    tail: [],
    startedAt: Date.now(),
    finishedAt: 0,
    proc: null,
  }
  jobs.set(id, job)
  gc()

  // 目标已存在就别跑了——git 也会报错，但这样能立刻反馈
  if (existsSync(dir)) {
    job.status = 'error'
    job.error = `目标目录已存在：${dir}`
    job.finishedAt = Date.now()
    return id
  }

  const args = ['clone', '--progress']
  if (depth1) args.push('--depth', '1')
  if (submodules) args.push('--recurse-submodules')
  args.push(url, dir)

  let timedOut = false
  let buf = ''

  const pushTail = (line) => {
    const t = line.trim()
    if (!t) return
    // 进度行不放进 tail（它每几十毫秒刷一次，会淹没有用信息）
    if (RE_PROGRESS.test(t)) return
    job.tail.push(t)
    if (job.tail.length > 40) job.tail.shift()
  }

  const parseLine = (line) => {
    const prog = parseProgressLine(line)
    if (prog) {
      job.phase = prog.phase
      job.percent = prog.percent
      if (prog.rate) job.rate = prog.rate
      return
    }
    pushTail(line)
  }

  try {
    job.proc = spawn('git', args, { env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    job.status = 'error'
    job.error = `无法启动 git：${e.message}`
    job.finishedAt = Date.now()
    return id
  }

  job.proc.stderr.on('data', (chunk) => {
    buf += chunk.toString()
    // git 用 \r 原地刷新，必须两种分隔符都切；最后一段可能不完整，留到下次
    const [lines, rest] = splitProgressChunk(buf)
    buf = rest
    for (const line of lines) parseLine(line)
  })
  job.proc.stdout.on('data', () => {}) // 不吃会堵

  const timer = setTimeout(() => {
    timedOut = true
    try { job.proc.kill('SIGTERM') } catch {}
    // 给 5 秒收尾，还不走就强杀
    setTimeout(() => { try { job.proc?.kill('SIGKILL') } catch {} }, 5000)
  }, timeoutMs)

  job.proc.on('error', (e) => {
    clearTimeout(timer)
    job.status = 'error'
    job.error = `git 进程出错：${e.message}`
    job.finishedAt = Date.now()
    job.proc = null
  })

  job.proc.on('close', (code) => {
    clearTimeout(timer)
    if (buf) parseLine(buf)
    job.proc = null
    job.finishedAt = Date.now()

    if (timedOut) {
      job.status = 'timeout'
      job.error = `超过 ${Math.round(timeoutMs / 60000)} 分钟还没完成，已中止。网络慢的话可以勾选浅克隆。`
      return
    }
    if (code === 0) {
      job.status = 'done'
      job.phase = '完成'
      job.percent = 100
      return
    }
    job.status = 'error'
    job.error = pickError(job)
  })

  return id
}

/** 查状态。不返回 proc，那样 JSON 序列化会炸 */
export function getClone(id) {
  const job = jobs.get(id)
  if (!job) return null
  return {
    id: job.id,
    url: job.url,
    dir: job.dir,
    status: job.status,
    phase: job.phase,
    percent: job.percent,
    rate: job.rate,
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    elapsedMs: (job.finishedAt || Date.now()) - job.startedAt,
    tail: job.tail.slice(-8),
  }
}

/** 有没有正在跑的克隆（前端判断是否要禁用入口） */
export function hasRunningClone() {
  for (const j of jobs.values()) if (j.status === 'running') return true
  return false
}
