import { spawn } from 'node:child_process'

const DEFAULT_TIMEOUT = 20000

/**
 * 统一 git 调用入口。
 * 一律用数组传参，绝不拼 shell 字符串 —— 路径可能含空格、中文、引号。
 *
 * opts.quotepath === false 时关掉路径转义（默认 git 会把中文变成 \345\207\275）。
 * 这个仓库有中文/方括号文件名，不关掉的话界面显示乱码，且路径回传给 diff 时对不上。
 */
export function git(cwd, args, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT
  const prefix = ['--no-optional-locks']
  if (opts.quotepath === false) prefix.push('-c', 'core.quotepath=false')
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('git', [...prefix, ...args], {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // 任何需要编辑器/分页/交互确认的操作都不许阻塞
          GIT_EDITOR: 'true',
          GIT_PAGER: 'cat',
          PAGER: 'cat',
          GIT_ASKPASS: 'true',
          SSH_ASKPASS: 'true',
          GIT_MERGE_AUTOEDIT: 'no',
          LC_ALL: 'C',
          LANG: 'C',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) })
      return
    }

    const out = []
    const errOut = []
    let settled = false
    let size = 0
    const cap = opts.maxBytes ?? 8 * 1024 * 1024

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch {}
      resolve({ code: -1, stdout: Buffer.concat(out).toString('utf8'), stderr: `timeout after ${timeout}ms` })
    }, timeout)

    child.stdout.on('data', (buf) => {
      size += buf.length
      if (size > cap) return
      out.push(buf)
    })
    child.stderr.on('data', (buf) => errOut.push(buf))

    // 长操作（fetch / clone / pull）的进度回调，供 SSE 实时推进度
    if (typeof opts.onStderr === 'function') {
      child.stderr.on('data', (buf) => {
        try { opts.onStderr(buf.toString('utf8')) } catch {}
      })
    }

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout: '', stderr: String(err?.message || err) })
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errOut).toString('utf8').trim(),
      })
    })
  })
}

/** 简单并发限制器 */
export function createLimiter(concurrency) {
  let active = 0
  const queue = []
  const pump = () => {
    if (active >= concurrency || queue.length === 0) return
    active++
    const { fn, resolve, reject } = queue.shift()
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--
        pump()
      })
  }
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject })
      pump()
    })
}
