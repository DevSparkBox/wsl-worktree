// 设置页：扫描根目录、缓存上限、外部工具。
// 端口和监听地址只读：它们决定服务怎么监听，属于安全边界，只能手改 config.json 后重启。

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const KINDS = [
  {
    key: 'fileManager',
    label: '文件管理器',
    hint: 'WSL 下留空会找 explorer.exe，Linux 下留空会找 xdg-open / Dolphin。路径会自动转成 Windows UNC 或保留 Linux 原生路径。',
  },
  {
    key: 'terminal',
    label: '终端',
    hint: 'Konsole 用 --workdir {path}，GNOME Terminal 用 --working-directory {path}。留空会自动选择，WSL 下优先 Windows Terminal。',
  },
  {
    key: 'editor',
    label: '编辑器',
    hint: '留空会依次找 code / codium / cursor。WSL 下 Windows 的 code.cmd 会自动使用 UNC 路径；原生 code 使用 Linux 路径。',
  },
  {
    key: 'zed',
    label: 'Zed',
    hint: '留空会找 zed / zeditor。Zed 是 Linux 原生程序，默认参数就是路径本身；不认 Windows 的 zed.exe，WSL 里请用装在发行版内的 zed。',
  },
]

const STYLES = [
  ['auto', '自动（推荐）'],
  ['native', 'Linux 原生路径'],
  ['windows', 'Windows UNC 路径'],
]

async function api(path, opts) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`)
    err.field = data.field
    throw err
  }
  return data
}

function option(value, label, current) {
  return `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`
}

function detectedText(resolved) {
  if (!resolved) return ''
  if (resolved.error) return resolved.error
  return `${resolved.command || ''} ${(resolved.args || []).join(' ')}`.trim()
}

function renderNotice(data) {
  const el = $('settings-notice')
  const lines = []
  let isErr = false

  if (data.configError) {
    isErr = true
    lines.push(`配置文件读不出来：${data.configError}。请先修好 ${data.configPath || 'config.json'}，否则保存会被拒绝。`)
  }

  const pending = data.restartRequired || []
  if (pending.length) {
    const saved = data.config || {}
    const effective = data.effective || {}
    const parts = []
    if (pending.includes('port')) parts.push(`端口 ${effective.port} → ${saved.port}`)
    if (pending.includes('host')) parts.push(`监听地址 ${effective.host || '默认'} → ${saved.host || '默认'}`)
    lines.push(`配置文件里的${parts.join('、')}已变更，重启服务后生效。`)
  }

  el.hidden = lines.length === 0
  el.className = 'settings-notice' + (isErr ? ' err' : '')
  el.textContent = lines.join('\n')
}

function render(data) {
  const cfg = data.config || {}
  const effective = data.effective || {}

  $('settings-platform').textContent =
    data.platform === 'wsl' ? `WSL${data.distro ? ` · ${data.distro}` : ''}` : 'Linux'

  $('settings-config-path').textContent = data.configPath || ''
  $('settings-port').textContent = String(effective.port ?? '')
  $('settings-host').textContent = effective.host || '（默认）'
  $('settings-restart-badge').hidden = !(data.restartRequired || []).length
  renderNotice(data)

  $('roots').value = (cfg.roots || []).join('\n')
  $('scanMaxDepth').value = cfg.scanMaxDepth ?? ''
  $('stateCacheMs').value = cfg.stateCacheMs ?? ''
  $('scanCacheMs').value = cfg.scanCacheMs ?? ''
  $('maxPatchBytes').value = cfg.maxPatchBytes ?? ''

  $('settings-apps').innerHTML = KINDS.map(({ key, label, hint }) => {
    const app = data.apps?.[key] || { command: '', args: [], pathStyle: 'auto' }
    const resolved = data.resolved?.[key] || {}
    const detected = detectedText(resolved)
    return `
      <section class="settings-card">
        <div class="settings-card-head">
          <h2>${esc(label)}</h2>
          <span class="settings-detected" title="${esc(detected)}">${esc(detected || '未检测到可执行文件')}</span>
        </div>
        <p class="settings-hint">${esc(hint)}</p>
        <label class="settings-field">
          <span>命令</span>
          <input id="cmd-${key}" value="${esc(app.command || '')}" placeholder="留空自动检测" spellcheck="false" autocomplete="off">
        </label>
        <label class="settings-field">
          <span>参数</span>
          <textarea id="args-${key}" rows="3" placeholder="留空自动；每行一个参数，{path} 代表目标路径" spellcheck="false">${esc((app.args || []).join('\n'))}</textarea>
        </label>
        <label class="settings-field">
          <span>路径样式</span>
          <select id="style-${key}">
            ${STYLES.map(([value, text]) => option(value, text, app.pathStyle || 'auto')).join('')}
          </select>
        </label>
      </section>`
  }).join('')

  // 配置文件坏了就禁止保存：saveSettings 会拒绝覆盖，提前禁用比点了才报错更清楚
  $('settings-save').disabled = Boolean(data.configError)
}

function collectApps() {
  const apps = {}
  for (const { key } of KINDS) {
    apps[key] = {
      command: $(`cmd-${key}`).value.trim(),
      args: $(`args-${key}`).value
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      pathStyle: $(`style-${key}`).value,
    }
  }
  return apps
}

function collectConfig() {
  return {
    roots: $('roots').value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    scanMaxDepth: Number($('scanMaxDepth').value),
    stateCacheMs: Number($('stateCacheMs').value),
    scanCacheMs: Number($('scanCacheMs').value),
    maxPatchBytes: Number($('maxPatchBytes').value),
  }
}

/**
 * 只提交改过的项：否则默认 roots（比如还没建的 ~/codes）会让「只改编辑器」也保存失败。
 * 保存时后端只对提交了的字段做校验。
 */
function collectConfigPatch() {
  const next = collectConfig()
  const saved = current.config || {}
  const patch = {}
  for (const key of Object.keys(next)) {
    const before = key === 'roots' ? (saved.roots || []) : saved[key]
    if (JSON.stringify(before) !== JSON.stringify(next[key])) patch[key] = next[key]
  }
  return patch
}

function clearInvalid() {
  document.querySelectorAll('.settings-field .invalid').forEach((el) => el.classList.remove('invalid'))
}

function markInvalid(field) {
  const el = field ? $(field) : null
  if (!el) return
  el.classList.add('invalid')
  el.focus()
}

let messageTimer = 0

function message(text, isErr = false) {
  const el = $('settings-msg')
  el.textContent = text
  el.className = 'settings-msg' + (isErr ? ' err' : '')
  el.hidden = false
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => { el.hidden = true }, isErr ? 6000 : 2500)
}

let current = {
  platform: 'linux',
  distro: '',
  apps: {},
  resolved: {},
  config: {},
  effective: {},
  restartRequired: [],
  configPath: '',
  configError: null,
}

async function load() {
  try {
    current = await api('/api/settings')
    clearInvalid()
    render(current)
  } catch (err) {
    message(`读取设置失败：${err.message}`, true)
  }
}

$('settings-save').addEventListener('click', async () => {
  const btn = $('settings-save')
  btn.disabled = true
  clearInvalid()
  try {
    const payload = { apps: collectApps() }
    const config = collectConfigPatch()
    if (Object.keys(config).length) payload.config = config
    const data = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    current = data
    render(current)
    message('已保存。扫描根目录、缓存与外部工具立即生效；端口和监听地址仍需手改配置文件后重启。')
  } catch (err) {
    if (err.field) markInvalid(err.field)
    message(`保存失败：${err.message}`, true)
  } finally {
    btn.disabled = Boolean(current.configError)
  }
})

$('settings-reload').addEventListener('click', load)

document.addEventListener('input', (e) => {
  if (e.target instanceof Element) e.target.classList.remove('invalid')
})

load()
