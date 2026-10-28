// 远程模式（浏览器在另一台电脑上）的字符串构造：纯函数，不启动任何外部程序。
import {
  validSshTarget,
  vscodeRemoteUri,
  sshCommand,
  zedRemoteCommand,
} from '../../public/open-remote.js'

const checks = []
const check = (name, ok, detail = '') => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`)
}

check('接受 user@ip', validSshTarget('user@192.168.1.9'), '')
check('接受 ssh 别名与端口', validSshTarget('dev-box') && validSshTarget('host:2222'), '')
check('空串不合法', !validSshTarget('') && !validSshTarget('   '), '')
check('带空格/分号不合法', !validSshTarget('user@ho st') && !validSshTarget('h;rm -rf'), '')
check('超长不合法', !validSshTarget('a'.repeat(201)), '')
check('首字符是分隔符不合法', !validSshTarget('@host') && !validSshTarget('/host'), '')

const uri = vscodeRemoteUri('user@host', '/data/codes/a b')
check('VS Code URI 形式', uri === 'vscode://vscode-remote/ssh-remote+user@host/data/codes/a%20b', uri)
check('VS Code URI 编码中文', vscodeRemoteUri('h', '/data/代码/x') === 'vscode://vscode-remote/ssh-remote+h/data/%E4%BB%A3%E7%A0%81/x', vscodeRemoteUri('h', '/data/代码/x'))

const ssh = sshCommand('user@host', '/data/codes/a b')
check('ssh 命令带 cd', ssh === `ssh -t user@host 'cd "/data/codes/a b" && exec $SHELL'`, ssh)
check('路径含引号时退化为只登录', sshCommand('h', "/data/it's") === 'ssh -t h' && sshCommand('h', '/data/a$b') === 'ssh -t h', sshCommand('h', "/data/it's"))
check('路径为空时只登录', sshCommand('h', '') === 'ssh -t h', '')

const zed = zedRemoteCommand('user@host', '/data/codes/a b')
check('Zed 远程命令编码路径', zed === 'zed ssh://user@host/data/codes/a%20b', zed)

const fail = checks.filter((c) => !c[1])
console.log(`\n${checks.length - fail.length}/${checks.length} 通过`)
process.exit(fail.length ? 1 : 0)
