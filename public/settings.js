// 设置页：只维护外部工具（文件管理器 / 终端 / 编辑器）的路径与参数。
// 其余配置（端口、扫描根）需要改 config.json 并重启，放在这个页面之外。

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
]

const STYLES = [
  ['auto', '自动（推荐）'],
  ['native', 'Linux 原生路径'],
  ['windows', 'Windows UNC 路径'],
]

async function api(path, opts) {
  const res = await fetch(path, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
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

function render(data) {
  $('settings-platform').textContent =
    data.platform === 'wsl' ? `WSL${data.distro ? ` · ${data.distro}` : ''}` : 'Linux'

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
}

function collect() {
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

let messageTimer = 0

function message(text, isErr = false) {
  const el = $('settings-msg')
  el.textContent = text
  el.className = 'settings-msg' + (isErr ? ' err' : '')
  el.hidden = false
  clearTimeout(messageTimer)
  messageTimer = setTimeout(() => { el.hidden = true }, isErr ? 6000 : 2500)
}

let current = { platform: 'linux', distro: '', apps: {}, resolved: {} }

async function load() {
  try {
    current = await api('/api/settings')
    render(current)
  } catch (err) {
    message(`读取设置失败：${err.message}`, true)
  }
}

$('settings-save').addEventListener('click', async () => {
  const btn = $('settings-save')
  btn.disabled = true
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apps: collect() }),
    })
    current = { ...current, ...data }
    render(current)
    message('已保存。打开 worktree 时会使用新配置。')
  } catch (err) {
    message(`保存失败：${err.message}`, true)
  } finally {
    btn.disabled = false
  }
})

$('settings-reload').addEventListener('click', load)

load()
