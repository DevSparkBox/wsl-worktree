// 剪贴板兜底的纯逻辑测试：不碰真实 DOM，用假 window/document 走两条通道。
import { hasAsyncClipboard, copyText } from '../../public/clipboard.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

/** 假 window：只有异步剪贴板通道，记录写进去的文本 */
function fakeSecureWin(result = 'ok') {
  const written = []
  return {
    written,
    isSecureContext: true,
    navigator: {
      clipboard: {
        writeText: async (t) => {
          if (result === 'throw') throw new Error('denied')
          written.push(t)
        },
      },
    },
    document: fakeDoc(() => true),
  }
}

/** 假 window：非安全上下文（http://<IP>），没有 navigator.clipboard */
function fakeInsecureWin(execResult = true) {
  const doc = fakeDoc(() => execResult)
  return { isSecureContext: false, navigator: {}, document: doc, doc }
}

function fakeDoc(exec) {
  const doc = {
    appended: [],
    removed: 0,
    execCalls: 0,
    body: { appendChild: (el) => doc.appended.push(el.value) },
    activeElement: null,
    createElement: () => ({
      value: '',
      style: {},
      setAttribute() {},
      select() {},
      setSelectionRange() {},
      remove() { doc.removed++ },
    }),
    execCommand() {
      doc.execCalls++
      return exec()
    },
  }
  return doc
}

check('安全上下文且 API 存在', hasAsyncClipboard(fakeSecureWin()) === true, '')
check('非安全上下文没有 API', hasAsyncClipboard(fakeInsecureWin()) === false, '')
check('安全上下文但没实现 writeText', hasAsyncClipboard({ isSecureContext: true, navigator: { clipboard: {} } }) === false, '')

const okWin = fakeSecureWin()
check('安全上下文直接用异步 API', (await copyText('abc', okWin)) === true && okWin.written[0] === 'abc', JSON.stringify(okWin.written))

const insecure = fakeInsecureWin(true)
const insecureOk = await copyText('ssh -t host', insecure)
check('非安全上下文退回 execCommand', insecureOk === true && insecure.doc.execCalls === 1, `calls=${insecure.doc.execCalls}`)
check('兜底时 textarea 有内容且被移除', insecure.doc.appended[0] === 'ssh -t host' && insecure.doc.removed === 1, JSON.stringify(insecure.doc.appended))

const deniedWin = fakeSecureWin('throw')
const deniedDoc = fakeDoc(() => true)
deniedWin.document = deniedDoc
check('异步 API 抛错时继续兜底', (await copyText('x', deniedWin)) === true && deniedDoc.execCalls === 1, `calls=${deniedDoc.execCalls}`)

const bothFail = fakeInsecureWin(false)
check('两条通道都失败返回 false', (await copyText('x', bothFail)) === false, '')

const noDoc = { isSecureContext: false, navigator: {}, document: null }
check('没有 document 时返回 false', (await copyText('x', noDoc)) === false, '')

check('空值不抛异常', (await copyText(null, fakeInsecureWin(true))) === true, '')

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
