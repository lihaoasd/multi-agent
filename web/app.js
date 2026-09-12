/**
 * Agent Haness 前端（无构建静态 ESM；M7 工作台 MVP）。
 * 覆盖：项目列表/创建(选目录+勾角色)、团队与会话列表、聊天(WS 流式/历史)、审批、会议、产出物、记忆/纪要。
 */
import { renderMarkdown } from './markdown.js'

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

let projects = []
let current = {
  pid: null,
  sessionId: null,
  team: [],
  approvals: [],
  meetings: [],
  tasks: [],
  questions: [],
  agents: [],
  oldestSeq: null,
  /** 本次已从历史渲染到的最新 seq（用于过滤广播中重复事件） */
  lastRenderedSeq: 0,
  busy: false,
}
let ws = null

/** 会话可读标题：user=角色显示名，meeting=主题/ID。 */
function sessionLabel(s) {
  if (!s) return ''
  if (s.type === 'meeting') {
    const topic = s.meeting?.topic || s.agenda
    return topic ? `会议 · ${topic}` : s.id
  }
  const iid = String(s.id).replace(/^u_/, '')
  const m = current.team.find((t) => t.instanceId === iid)
  return m ? `${m.displayName}（${iid}）` : s.id
}

function setTyping(on) {
  $('#typing').classList.toggle('hidden', !on)
}

function setSendBusy(on) {
  current.busy = on
  // 停用角色的会话输入框为禁用态，忙碌态不能把它打开
  $('#btn-send').disabled = on || $('#msg-text').disabled
}

function setDocTitle(text) {
  document.title = text ? `${text} · Agent Haness` : 'Agent Haness'
}

/**
 * 统一请求封装：**带超时**（默认 10s，防挂死堆积）+ 错误归一化。
 * 之前的版本没有超时，服务端繁忙时请求会一直挂着 → 前端不断重试 → 浏览器连接耗尽
 * （net::ERR_INSUFFICIENT_RESOURCES），所有面板（含提问卡片）都刷新失败。
 */
async function api(path, method = 'GET', body = null, opts = {}) {
  const { timeoutMs = 15000, signal } = opts
  const init = { method, headers: {} }
  if (body) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  if (signal) signal.addEventListener('abort', () => ac.abort(), { once: true })
  try {
    const res = await fetch(`/api${path}`, { ...init, signal: ac.signal })
    const data = await res.json().catch(() => ({}))
    if (!res.ok && data.code) throw new Error(`${data.code}: ${data.message}`)
    return data
  } finally {
    clearTimeout(timer)
  }
}

function toast(msg) {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2600)
}

async function boot() {
  bindGlobal()
  await showProjectsView()
}

/** 页 1：项目列表视图（离开当前项目、断开 WS）。 */
async function showProjectsView() {
  current.pid = null
  current.sessionId = null
  current.busy = false
  if (agentStatusTimer) {
    clearInterval(agentStatusTimer)
    agentStatusTimer = null
  }
  setDocTitle('')
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  $('#layout').classList.add('hidden')
  $('#projects-view').classList.remove('hidden')
  $('#current-project').classList.add('hidden')
  $('#current-project').textContent = ''
  setExportVisible(false)
  $('#attention-wrap').classList.add('hidden')
  $('#attention-modal').classList.add('hidden')
  await refreshProjectList()
}

/** 拉取并渲染项目列表卡片。 */
async function refreshProjectList() {
  try {
    const d = await api('/projects')
    projects = d.projects ?? []
    const grid = $('#project-grid')
    grid.innerHTML = ''
    for (const p of projects) {
      const card = document.createElement('div')
      card.className = 'project-card'
      const name = document.createElement('div')
      name.className = 'project-name'
      name.textContent = p.name
      const meta = document.createElement('div')
      meta.className = 'who'
      meta.textContent = `${p.team?.length ?? 0} 个角色 · ${(p.workdir ?? '').slice(0, 60)}`
      const desc = document.createElement('div')
      desc.className = 'project-desc'
      desc.textContent = p.description || ''
      const enter = document.createElement('button')
      enter.className = 'primary'
      enter.textContent = '进入'
      enter.onclick = () => enterProject(p.id)
      const del = document.createElement('button')
      del.className = 'danger'
      del.textContent = '删除'
      del.onclick = async () => {
        if (
          !confirm(
            `删除项目「${p.name}」的运行时数据（会话/记忆/审批等）？\n你的工作目录不受影响。`,
          )
        )
          return
        try {
          await api(`/projects/${p.id}`, 'DELETE')
          toast('项目已删除')
          await refreshProjectList()
        } catch (e) {
          toast(e.message)
        }
      }
      const actions = document.createElement('div')
      actions.className = 'card-actions'
      actions.appendChild(enter)
      actions.appendChild(del)
      card.appendChild(name)
      card.appendChild(meta)
      if (p.description) card.appendChild(desc)
      card.appendChild(actions)
      grid.appendChild(card)
    }
    $('#project-empty').classList.toggle('hidden', projects.length > 0)
  } catch (e) {
    toast('加载项目失败: ' + e.message)
  }
}

/** 角色状态轮询定时器（进入项目时启动，回项目列表时清理）。 */
let agentStatusTimer = null

/** 页 2：进入某项目的会话工作台。 */
async function enterProject(pid) {
  const p = projects.find((x) => x.id === pid)
  $('#current-project').textContent = p ? ` / ${p.name}` : ` / ${pid}`
  $('#current-project').classList.remove('hidden')
  $('#projects-view').classList.add('hidden')
  $('#layout').classList.remove('hidden')
  setExportVisible(true)
  setDocTitle(p ? p.name : pid)
  await openProject(pid)
}

function setExportVisible(visible) {
  $('#btn-export').classList.toggle('hidden', !visible)
}

function bindGlobal() {
  $('#btn-home').addEventListener('click', () => showProjectsView())
  $('#btn-new-project').addEventListener('click', loadRolePicker)
  // 每次打开弹窗都重新拉角色（容错：失败 toast，避免空列表）
  /** 同步「全选」勾选态（含半选）与已选计数。 */
  function syncRoleAll() {
    const boxes = $$('#w-roles-list input[type="checkbox"]')
    const all = $('#w-role-all')
    const checked = boxes.filter((b) => b.checked).length
    all.checked = boxes.length > 0 && checked === boxes.length
    all.indeterminate = checked > 0 && checked < boxes.length
    all.disabled = boxes.length === 0
    $('#w-role-count').textContent = boxes.length ? `已选 ${checked}/${boxes.length}` : ''
  }

  async function loadRolePicker() {
    const w = $('#wizard')
    w.classList.remove('hidden')
    const box = $('#w-roles-list')
    box.innerHTML = '<div class="who">加载角色…</div>'
    $('#w-role-count').textContent = ''
    try {
      const d = await api('/roles')
      box.innerHTML = ''
      for (const r of d.roles ?? []) {
        const lab = document.createElement('label')
        lab.className = 'role-check'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = r.roleId
        cb.checked = ['pm', 'product', 'dev'].includes(r.roleId)
        cb.addEventListener('change', syncRoleAll)
        lab.appendChild(cb)
        lab.appendChild(document.createTextNode(`${r.name}(${r.roleId})`))
        box.appendChild(lab)
      }
      if (!(d.roles ?? []).length) {
        box.innerHTML = '<div class="who">暂无角色模板（检查服务端 src/shared/roles）</div>'
      }
    } catch (e) {
      box.innerHTML = '<div class="who">角色加载失败：' + escapeHtml(e.message) + '</div>'
    }
    syncRoleAll()
  }
  // 「全选」：一次勾选/取消全部角色（手动增删后由 syncRoleAll 回写半选态）
  $('#w-role-all').addEventListener('change', (e) => {
    for (const cb of $$('#w-roles-list input[type="checkbox"]')) cb.checked = e.target.checked
    syncRoleAll()
  })
  $('#btn-wizard-close').addEventListener('click', () => $('#wizard').classList.add('hidden'))
  $('#btn-create').addEventListener('click', async () => {
    const team = $$('#w-roles-list input:checked').map((c) => ({ roleTemplateId: c.value }))
    if (!team.length) {
      toast('请至少勾选一个角色（如 产品/开发）')
      return
    }
    try {
      const d = await api('/projects', 'POST', {
        name: $('#w-name').value.trim(),
        workdir: $('#w-workdir').value.trim(),
        team,
      })
      toast(`已创建项目 ${d.project.name}，正在进入…`)
      $('#wizard').classList.add('hidden')
      $('#w-name').value = ''
      $('#w-workdir').value = ''
      await refreshProjectList()
      await enterProject(d.project.id)
    } catch (e) {
      toast(e.message)
    }
  })

  $('#btn-send').addEventListener('click', sendMessage)
  $('#btn-load-old').addEventListener('click', loadOlder)
  $('#msg-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })
  // 团队：添加成员 / 弹窗关闭
  $('#btn-add-member').addEventListener('click', openMemberModal)
  $('#btn-member-close').addEventListener('click', () => $('#member-modal').classList.add('hidden'))
  // 会议：发起（主题 + 描述 + 参会人）
  $('#btn-new-meeting').addEventListener('click', openMeetingModal)
  $('#btn-meeting-cancel').addEventListener('click', () =>
    $('#meeting-modal').classList.add('hidden'),
  )
  $('#btn-meeting-create').addEventListener('click', createMeetingFromModal)
  $('#mt-host').addEventListener('change', renderMeetingMemberPicker)
  // Esc 关闭弹窗；点击遮罩关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      for (const m of $$('.modal')) m.classList.add('hidden')
    }
  })
  for (const m of $$('.modal')) {
    m.addEventListener('click', (e) => {
      if (e.target === m) m.classList.add('hidden')
    })
  }

  // 项目导出 zip
  $('#btn-export').addEventListener('click', () => {
    if (!current.pid) return
    window.location.href = `/api/projects/${current.pid}/export`
  })
  // 「需你处理」弹窗（原地操作）
  $('#btn-attention').addEventListener('click', openAttentionModal)
  $('#btn-attention-close').addEventListener('click', () =>
    $('#attention-modal').classList.add('hidden'),
  )

  // 工作目录：文件夹选择器（服务端 fs/browse 逐层浏览）
  $('#btn-pick-dir').addEventListener('click', () => {
    const remembered = localStorage.getItem('haness_last_dir')
    const start = remembered || $('#w-workdir').value.trim() || 'C:\\'
    openDirPicker(start)
  })
  $('#dp-go').addEventListener('click', () => loadDir($('#dp-path').value.trim()))
  $('#dp-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      loadDir($('#dp-path').value.trim())
    }
  })
  $('#dp-up').addEventListener('click', () => loadDir(dirParent(dirState.cur)))
  $('#dp-new').addEventListener('click', newDirHere)
  $('#dp-use').addEventListener('click', () => {
    $('#w-workdir').value = dirState.cur
    localStorage.setItem('haness_last_dir', dirState.cur)
    $('#dir-modal').classList.add('hidden')
  })
  $('#dp-close').addEventListener('click', () => $('#dir-modal').classList.add('hidden'))
}

const dirState = { cur: '' }
let quickDirs = []

async function openDirPicker(path) {
  $('#dir-modal').classList.remove('hidden')
  renderQuickBar()
  loadDir(path || 'C:\\')
}

/** 常用位置快捷条（主目录 + 可用盘符 + 最近使用的目录）。 */
async function renderQuickBar() {
  const box = $('#dp-quick')
  box.innerHTML = '<span class="who">加载常用位置…</span>'
  try {
    if (!quickDirs.length) {
      const d = await api('/fs/home')
      quickDirs = d.quick ?? []
    }
    const last = localStorage.getItem('haness_last_dir')
    const chips = [...quickDirs]
    if (last && !chips.some((x) => x.toLowerCase() === last.toLowerCase())) chips.push(last)
    box.innerHTML = ''
    for (const p of chips) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'chip'
      b.textContent = p
      b.onclick = () => loadDir(p)
      box.appendChild(b)
    }
  } catch (e) {
    box.innerHTML = '<span class="who">常用位置加载失败</span>'
  }
}

/** 加载并渲染某目录（子目录可单击进入、文件灰显），含面包屑式当前路径。 */
async function loadDir(path) {
  if (!path) return
  dirState.cur = path
  $('#dp-path').value = path
  renderCrumb(path)
  const list = $('#dp-list')
  list.innerHTML = '<li class="who">加载中…</li>'
  try {
    const d = await api(`/fs/browse?path=${encodeURIComponent(path)}`)
    list.innerHTML = ''
    for (const e of d.entries ?? []) {
      const li = document.createElement('li')
      if (e.type === 'dir') {
        const a = document.createElement('a')
        a.href = 'javascript:void(0)'
        a.textContent = `📁 ${e.name}`
        a.title = e.path
        a.onclick = () => loadDir(e.path)
        li.appendChild(a)
        // 双击条目 = 进入（更快的触达方式）
        li.addEventListener('dblclick', () => loadDir(e.path))
      } else {
        li.textContent = `📄 ${e.name}`
        li.className = 'file'
      }
      list.appendChild(li)
    }
    if (!(d.entries ?? []).length) {
      list.innerHTML = '<li class="who">（空目录）</li>'
    }
  } catch (e) {
    list.innerHTML = '<li class="who">访问失败：' + escapeHtml(e.message) + '</li>'
  }
}

/** 当前路径分段面包屑（点某段跳回该层级）。 */
function renderCrumb(p) {
  const box = $('#dp-current')
  box.innerHTML = ''
  const sep = /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? '\\' : '/'
  const parts = p.split(/[\\/]+/).filter(Boolean)
  const segs = []
  let prefix = ''
  if (p === '/') {
    segs.push({ label: '/', path: '/' })
  } else if (p.startsWith('\\\\')) {
    prefix = '\\\\' + (parts[0] ?? '')
    segs.push({ label: prefix, path: prefix })
    parts.shift()
  } else if (/^[A-Za-z]:/.test(p)) {
    prefix = parts.shift() + '\\'
    segs.push({ label: prefix, path: prefix })
  }
  for (const s of parts) {
    const path = prefix ? prefix + s : s
    segs.push({ label: s, path })
    prefix = path + sep
  }
  segs.forEach((seg, i) => {
    const crumb = document.createElement('a')
    crumb.href = 'javascript:void(0)'
    crumb.textContent = seg.label
    crumb.className = i === segs.length - 1 ? 'active' : ''
    if (i < segs.length - 1) {
      crumb.onclick = () => loadDir(seg.path)
    }
    box.appendChild(crumb)
    if (i < segs.length - 1) {
      const s = document.createElement('span')
      s.className = 'sep'
      s.textContent = ' › '
      box.appendChild(s)
    }
  })
}

/** 在当前目录下新建文件夹并进入（用户级 fs/mkdir）。 */
async function newDirHere() {
  const parent = dirState.cur
  const name = prompt('输入新文件夹名称：', '')
  if (!name || !name.trim()) return
  try {
    const d = await api('/fs/mkdir', 'POST', { parent, name: name.trim() })
    toast('已创建文件夹')
    loadDir(d.path)
  } catch (e) {
    toast(e.message)
  }
}

function dirParent(p) {
  const norm = p.replace(/[\\/]+$/, '')
  if (/^[A-Za-z]:$/.test(norm)) return norm + '\\' // 盘符根保持不变
  if (p === '/') return '/'
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'))
  if (i <= 0) return norm
  return norm.slice(0, i)
}

async function openProject(pid) {
  current.pid = pid
  connectWs(pid)
  // 角色状态定时刷新（occupancy 变化未必都有 WS 事件）；走合并调度器，不会堆积
  if (agentStatusTimer) clearInterval(agentStatusTimer)
  agentStatusTimer = setInterval(() => {
    scheduleRefreshAgents()
  }, 5000)
  const team = await api(`/projects/${pid}/team`)
  current.team = team.team ?? []
  renderTeamNav()
  renderMeetingsNav()
  await refreshPanels()
  // 默认打开第一个角色的会话（不再依赖会话列表接口）
  const first = current.team[0]
  if (first) await openSession(pid, `u_${first.instanceId}`)
  else renderEmptyCenter('该项目暂无角色实例。请在左侧“团队”处点击 ＋添加 加入角色。')
}

/** 中央区空态提示（无会话/无角色时）。 */
function renderEmptyCenter(text) {
  $('#composer').classList.add('hidden')
  setTyping(false)
  $('#session-title').textContent = '未打开会话'
  const box = $('#messages')
  box.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'empty'
  div.textContent = text
  box.appendChild(div)
}

/** 角色状态中文名（团队列表用）。 */
const AGENT_STATE_ZH = {
  idle: '空闲',
  working: '工作中',
  meeting: '会议中',
  waiting: '等待你处理',
  disabled: '已停用',
}

/** 拉取团队实时状态（/agents）并刷新左栏团队行。 */
async function refreshAgents() {
  if (!current.pid) return
  const d = await api(`/projects/${current.pid}/agents`).catch(() => null)
  if (!d) return
  current.agents = d.agents ?? []
  renderTeamNav()
}

/** 团队列表 = 与每个成员的一对一会话入口（行内显示实时状态、可停用/启用）。 */
function renderTeamNav() {
  const ul = $('#team-list')
  ul.innerHTML = ''
  for (const m of current.team) {
    const sid = `u_${m.instanceId}`
    const a = (current.agents ?? []).find((x) => x.instanceId === m.instanceId)
    const state = !m.enabled ? 'disabled' : (a?.state ?? 'idle')
    const li = document.createElement('li')
    li.className = 'nav-item'
    if (!m.enabled) li.classList.add('disabled')
    if (sid === current.sessionId) li.classList.add('active')

    const title = document.createElement('span')
    title.className = 'nav-title'
    title.textContent = `${m.displayName}（${m.instanceId}）`
    title.title = a?.currentTask ? `当前任务：${a.currentTask.title}` : ''
    li.appendChild(title)

    // 实时状态：空闲/工作中/会议中/等待你处理/已停用（+ 当前任务提示）
    const st = document.createElement('span')
    st.className = `agent-state state-${state}`
    st.textContent = AGENT_STATE_ZH[state] ?? state
    if (state === 'waiting') st.title = '有需要你处理的提问或审批：点击进入该角色会话'
    else if (a?.currentTask) st.title = `当前任务：${a.currentTask.title}`
    li.appendChild(st)

    const toggle = document.createElement('button')
    toggle.className = 'ghost nav-action'
    toggle.textContent = m.enabled ? '停用' : '启用'
    toggle.title = m.enabled ? '停用该角色（数据保留，可随时启用）' : '重新启用该角色'
    toggle.addEventListener('click', async (ev) => {
      ev.stopPropagation() // 不要触发行点击（进入会话）
      if (
        m.enabled &&
        !confirm(
          `停用「${m.displayName}」？\n停用后该角色不再接活，其会话只读；数据全部保留，可随时启用。`,
        )
      ) {
        return
      }
      try {
        if (m.enabled) await api(`/projects/${current.pid}/team/${m.instanceId}`, 'DELETE')
        else await api(`/projects/${current.pid}/team/${m.instanceId}`, 'PATCH', { enabled: true })
        toast(m.enabled ? '已停用（数据保留，可重新启用）' : '已启用')
        await reloadProjectView({ keepSession: true })
      } catch (e) {
        toast('操作失败：' + e.message)
      }
    })
    li.appendChild(toggle)

    li.addEventListener('click', async () => {
      await openSession(current.pid, sid)
    })
    ul.appendChild(li)
  }
  if (!current.team.length) {
    const div = document.createElement('div')
    div.className = 'empty-tip'
    div.textContent = '（暂无角色，点右上「＋添加」加入角色）'
    ul.appendChild(div)
  }
}

/** 会议列表（左栏）：所有会议，点击进入会议会话。 */
function renderMeetingsNav() {
  const ul = $('#meeting-nav-list')
  ul.innerHTML = ''
  for (const mt of current.meetings ?? []) {
    const li = document.createElement('li')
    li.className = 'nav-item'
    if (mt.id === current.sessionId) li.classList.add('active')
    const title = document.createElement('span')
    title.className = 'nav-title'
    title.textContent = mt.meeting?.topic || mt.id
    title.title = mt.meeting?.desc || ''
    li.appendChild(title)
    const st = document.createElement('span')
    st.className = `badge state-${mt.state}`
    st.textContent = stateZh(mt.state)
    li.appendChild(st)
    li.addEventListener('click', () => openSession(current.pid, mt.id))
    ul.appendChild(li)
  }
  if (!(current.meetings ?? []).length) {
    const div = document.createElement('div')
    div.className = 'empty-tip'
    div.textContent = '（暂无会议，点「＋发起」申请开会）'
    ul.appendChild(div)
  }
}

/** 添加角色弹窗：列出未在团队中的模板（MVP 每模板至多 1 实例）。 */
async function openMemberModal() {
  if (!current.pid) return
  const list = $('#member-list')
  list.innerHTML = '<li class="empty-tip">加载角色…</li>'
  $('#member-modal').classList.remove('hidden')
  try {
    const [d, team] = await Promise.all([api('/roles'), api(`/projects/${current.pid}/team`)])
    const exist = new Set(team.team.map((t) => t.roleTemplateId))
    const addable = (d.roles ?? []).filter((r) => !exist.has(r.roleId))
    list.innerHTML = ''
    for (const r of addable) {
      const li = document.createElement('li')
      const info = document.createElement('span')
      info.textContent = `${r.name}（${r.roleId}）· ${r.description || ''}`.slice(0, 60)
      const add = document.createElement('button')
      add.textContent = '添加'
      add.onclick = async () => {
        try {
          await api(`/projects/${current.pid}/team`, 'POST', { roleTemplateId: r.roleId })
          toast(`已添加 ${r.name}`)
          await reloadProjectView()
          openMemberModal()
        } catch (e) {
          toast(e.message)
        }
      }
      li.appendChild(info)
      li.appendChild(add)
      list.appendChild(li)
    }
    if (!addable.length) {
      list.innerHTML = '<li class="empty-tip">团队已包含全部可用角色模板。</li>'
    }
  } catch (e) {
    list.innerHTML = '<li class="empty-tip">加载失败：' + escapeHtml(e.message) + '</li>'
  }
}

/** 发起会议弹窗：主持人 + 主题 + 描述 + 议题 + 参会成员（至少 1 人）。 */
function openMeetingModal() {
  if (!current.pid) return
  const enabled = current.team.filter((m) => m.enabled)
  if (enabled.length < 2) {
    toast('至少需要 2 个已启用角色才能开会（主持人 + 至少 1 位成员）')
    return
  }
  const host = $('#mt-host')
  host.innerHTML = ''
  for (const m of enabled) {
    const opt = document.createElement('option')
    opt.value = m.instanceId
    opt.textContent = `${m.displayName}（${m.instanceId}）`
    host.appendChild(opt)
  }
  $('#mt-topic').value = ''
  $('#mt-desc').value = ''
  $('#mt-agenda').value = ''
  renderMeetingMemberPicker()
  $('#meeting-modal').classList.remove('hidden')
}

/** 参会成员多选（排除当前主持人，保留已勾选项）。 */
function renderMeetingMemberPicker() {
  const box = $('#mt-members')
  const hostId = $('#mt-host').value
  const picked = new Set($$('#mt-members input:checked').map((c) => c.value))
  box.innerHTML = ''
  let count = 0
  for (const m of current.team) {
    if (!m.enabled || m.instanceId === hostId) continue
    const lab = document.createElement('label')
    lab.className = 'role-check'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.value = m.instanceId
    cb.checked = picked.has(m.instanceId)
    lab.appendChild(cb)
    lab.appendChild(document.createTextNode(`${m.displayName}（${m.instanceId}）`))
    box.appendChild(lab)
    count++
  }
  $('#mt-member-count').textContent = count ? '' : '（无其他已启用角色可参会）'
}

/** 提交发起会议：主题与描述必填，参会成员至少 1 人。 */
async function createMeetingFromModal() {
  const host = $('#mt-host').value
  const topic = $('#mt-topic').value.trim()
  const desc = $('#mt-desc').value.trim()
  const agenda = $('#mt-agenda')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  const members = $$('#mt-members input:checked').map((c) => c.value)
  if (!topic) return toast('请填写会议主题')
  if (!desc) return toast('请填写会议描述（为什么开、期望产出）')
  if (!members.length) return toast('请至少勾选 1 位参会成员')
  try {
    const d = await api(`/projects/${current.pid}/meetings`, 'POST', {
      host,
      topic,
      desc,
      agenda,
      members,
    })
    $('#meeting-modal').classList.add('hidden')
    toast(`会议已发起：${topic}`)
    await refreshPanels()
    await openSession(current.pid, d.meeting.id)
  } catch (e) {
    toast('发起失败：' + e.message)
  }
}

/**
 * 重载项目内团队/会话并刷新两个导航区。
 * opts.keepSession=true 时保持当前打开的会话（停用/启用角色后不跳走）。
 */
async function reloadProjectView(opts = {}) {
  const team = await api(`/projects/${current.pid}/team`)
  current.team = team.team ?? []
  renderTeamNav()
  renderMeetingsNav()
  await refreshPanels()
  const keep = opts.keepSession ? current.sessionId : null
  const fallback = current.team[0] ? `u_${current.team[0].instanceId}` : null
  const target = keep ?? fallback
  if (target) await openSession(current.pid, target)
  else renderEmptyCenter('该项目暂无会话。请在左侧“团队”处点击 ＋添加 加入角色。')
}

const STATE_ZH = {
  queued: '排队中',
  proposed: '征询中',
  open: '进行中',
  blocked_waiting_user: '等你拍板',
  closed: '已结束',
  active: '活跃',
  suspended: '挂起',
  archived: '已归档',
}
function stateZh(s) {
  return STATE_ZH[s] ?? s
}

/** 会话头部小按钮（会议操作）。 */
function shButton(label, cls, onClick) {
  const b = document.createElement('button')
  if (cls) b.className = cls
  b.textContent = label
  b.addEventListener('click', async () => {
    b.disabled = true
    try {
      await onClick()
    } catch (e) {
      toast('操作失败：' + e.message)
    } finally {
      b.disabled = false
    }
  })
  return b
}

/** 会话窗口顶部：会议显示主题/描述/参会人；用户会话隐藏副行。 */
function renderSessionHeader(meta) {
  const sub = $('#session-sub')
  if (meta.type !== 'meeting') {
    $('#session-title').textContent = sessionLabel(meta)
    sub.classList.add('hidden')
    sub.innerHTML = ''
    return
  }
  const mt = meta.meeting ?? {}
  $('#session-title').innerHTML =
    `${escapeHtml(mt.topic || meta.id)} <span class="badge state-${escapeHtml(
      meta.state,
    )}">${escapeHtml(stateZh(meta.state))}</span>`
  const hostName = `${senderName(mt.host)}（${mt.host}）`
  const decisions = mt.memberDecisions ?? {}
  const decisionZh = { accept: '已接受', later: '稍后', decline: '已拒绝' }
  const memberLines = (mt.members ?? []).map((m) => {
    const d = decisions[m]
    return `${escapeHtml(senderName(m))}（${escapeHtml(m)}）${d ? '·' + decisionZh[d] : '·待回应'}`
  })
  const rows = [
    `<div class="sh-row"><span class="sh-label">主持人</span>${escapeHtml(hostName)}</div>`,
    `<div class="sh-row"><span class="sh-label">描述</span>${
      mt.desc ? escapeHtml(mt.desc) : '<span class="who">（未填写）</span>'
    }</div>`,
    `<div class="sh-row"><span class="sh-label">参会人员</span>${escapeHtml(hostName)}（主持）｜${memberLines.join('｜')}｜我（用户）</div>`,
  ]
  // 会议操作入口（用户随时可结束/取消，不必等主持人）
  const actions = document.createElement('div')
  actions.className = 'sh-actions'
  if (meta.state === 'open' || meta.state === 'blocked_waiting_user') {
    actions.appendChild(
      shButton('结束会议并生成纪要', 'primary', async () => {
        await api(`/projects/${current.pid}/meetings/${meta.id}/close`, 'POST', { actor: 'user' })
        toast('会议已结束，纪要已生成')
        await refreshPanels()
        await openSession(current.pid, meta.id)
      }),
    )
  }
  if (meta.state === 'proposed' || meta.state === 'queued') {
    actions.appendChild(
      shButton('取消会议', '', async () => {
        await api(`/projects/${current.pid}/meetings/${meta.id}/cancel`, 'POST', { actor: 'user' })
        toast('会议已取消')
        await refreshPanels()
        await openSession(current.pid, meta.id)
      }),
    )
  }
  if (meta.state === 'closed') {
    actions.appendChild(
      shButton('查看纪要', '', async () => {
        const d = await api(`/projects/${current.pid}/meetings/${meta.id}/minutes`)
        $('#memory-panel').innerHTML = `<pre>${escapeHtml(d.minutes.text)}</pre>`
      }),
    )
  }
  sub.innerHTML = rows.join('')
  sub.appendChild(actions)
  sub.classList.remove('hidden')
}

async function openSession(pid, sid) {
  current.sessionId = sid
  setTyping(false)
  setSendBusy(false)
  renderTeamNav()
  renderMeetingsNav()
  const d = await api(`/projects/${pid}/sessions/${sid}`)
  const meta = d.session
  renderSessionHeader(meta)
  renderQuestions()
  const box = $('#messages')
  box.innerHTML = ''
  streaming = null
  // 重新回放历史：清空工具行配对索引（避免指向已卸载节点）
  toolRowByCallId.clear()
  toolRowPendingByTool.clear()
  const msgs = (d.messages ?? []).filter((e) => e.role !== 'system' && RENDER_KINDS.has(e.kind))
  const allEvents = d.messages ?? []
  let lastSeq = meta.lastSeq ?? 0
  // 翻页用"最早事件 seq"（含不可渲染的 meeting_event 等），否则会议里会出现"点了没反应"
  let oldest = null
  for (const e of allEvents) {
    if (!e.seq) continue
    oldest = oldest === null ? e.seq : Math.min(oldest, e.seq)
  }
  let renderedAny = false
  for (const m of msgs) {
    renderEvent(m)
    renderedAny = true
  }
  if (!renderedAny) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.textContent = '还没有消息。输入内容开始对话。'
    box.appendChild(empty)
  }
  // 已渲染到的最新 seq：用于过滤事件广播中的重复（已从历史渲染过的事件）
  current.lastRenderedSeq = lastSeq
  current.oldestSeq = oldest
  $('#load-old-wrap').classList.toggle('hidden', !oldest || oldest <= 1)
  const composer = $('#composer')
  const input = $('#msg-text')
  if (meta.type === 'user') {
    composer.classList.remove('hidden')
    const iid = String(meta.id).replace(/^u_/, '')
    const member = current.team.find((m) => m.instanceId === iid)
    const off = member && !member.enabled
    input.disabled = !!off
    $('#btn-send').disabled = !!off || current.busy
    input.placeholder = off
      ? '该角色已停用，仅可查看历史；在左侧「团队」点“启用”后可继续'
      : '发消息给 Agent'
  } else {
    composer.classList.add('hidden')
  }
}

/** 提问交互类型中文名。 */
const Q_KIND_ZH = { confirm: '确认', single: '单选', multi: '多选', text: '文本' }

/**
 * 待回答提问卡片（会话内交互，也用于「需你处理」弹窗）：
 * confirm/single → radio；multi → checkbox；text → 输入框；allowText → 附加说明。
 */
function buildQuestionCard(q, opts = {}) {
  const card = document.createElement('div')
  card.className = 'q-card'
  const head = document.createElement('div')
  head.className = 'q-head'
  head.textContent = `❓ ${senderName(q.asker)} 需要你${Q_KIND_ZH[q.kind] ?? q.kind}${
    q.kind === 'confirm' || q.kind === 'text' ? '' : '选择'
  }`
  const text = document.createElement('div')
  text.className = 'q-text'
  text.textContent = q.question
  card.appendChild(head)
  card.appendChild(text)

  const inputs = { choice: null, choices: [], text: null }
  if (q.kind === 'confirm' || q.kind === 'single') {
    const box = document.createElement('div')
    box.className = 'q-options'
    for (const o of q.options ?? []) {
      const lab = document.createElement('label')
      lab.className = 'q-option'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = `q_${q.id}`
      radio.value = o
      radio.addEventListener('change', () => {
        inputs.choice = o
      })
      lab.appendChild(radio)
      lab.appendChild(document.createTextNode(o))
      box.appendChild(lab)
    }
    card.appendChild(box)
  } else if (q.kind === 'multi') {
    const box = document.createElement('div')
    box.className = 'q-options'
    for (const o of q.options ?? []) {
      const lab = document.createElement('label')
      lab.className = 'q-option'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.value = o
      cb.addEventListener('change', () => {
        inputs.choices = [...box.querySelectorAll('input:checked')].map((c) => c.value)
      })
      lab.appendChild(cb)
      lab.appendChild(document.createTextNode(o))
      box.appendChild(lab)
    }
    card.appendChild(box)
  } else {
    const ta = document.createElement('textarea')
    ta.className = 'q-input'
    ta.rows = 2
    ta.placeholder = '请输入你的回答'
    ta.addEventListener('input', () => {
      inputs.text = ta.value
    })
    card.appendChild(ta)
  }
  if (q.allowText && q.kind !== 'text') {
    const note = document.createElement('input')
    note.className = 'q-input'
    note.placeholder = '补充说明（可选）'
    note.addEventListener('input', () => {
      inputs.text = note.value
    })
    card.appendChild(note)
  }

  const row = document.createElement('div')
  row.className = 'q-actions'
  const submit = document.createElement('button')
  submit.className = 'primary'
  submit.textContent = '提交回答'
  submit.addEventListener('click', async () => {
    submit.disabled = true
    const ok = await submitQuestionAnswer(q, inputs, opts)
    submit.disabled = false
    if (ok && opts.compact) $('#attention-modal').classList.add('hidden')
  })
  row.appendChild(submit)
  card.appendChild(row)
  return card
}

/** 提交回答：成功后刷新面板（Agent 回合由服务端唤醒，WS 流式返回）。 */
async function submitQuestionAnswer(q, inputs, opts = {}) {
  const body = {}
  if (q.kind === 'multi') body.choices = inputs.choices
  else if (q.kind === 'text') body.text = String(inputs.text ?? '').trim()
  else body.choice = inputs.choice
  if (q.allowText && q.kind !== 'text' && inputs.text) body.text = String(inputs.text).trim()
  try {
    const d = await api(`/projects/${current.pid}/questions/${q.id}/answer`, 'POST', body)
    toast(d.wakeError ? d.wakeError : `已提交回答，${senderName(q.asker)} 继续处理…`)
    // 本地即时撤下卡片（服务端也会推 question.answered，多标签页一致）
    current.questions = (current.questions ?? []).filter((x) => x.id !== q.id)
    renderQuestions()
    await refreshPanels()
    if (opts.onDone) await opts.onDone()
    return true
  } catch (e) {
    toast('提交失败：' + e.message)
    return false
  }
}

/** 会话窗口内的待回答提问卡片（输入框上方）。 */
function renderQuestions() {
  const zone = $('#question-zone')
  if (!zone) return
  zone.innerHTML = ''
  const list = (current.questions ?? []).filter((q) => q.sessionId === current.sessionId)
  if (!list.length) {
    zone.classList.add('hidden')
    return
  }
  zone.classList.remove('hidden')
  for (const q of list) zone.appendChild(buildQuestionCard(q))
}

/**
 * 提问推送（WS `question.asked`/`question.answered`）：服务端落盘后即时下行。
 * - 当前会话：把记录插进本地列表并**零请求**渲染卡片（不再等轮询）；
 * - 别的角色会话：toast 提示 + 刷新「需你处理」角标（用户切到该会话即可见卡片）。
 */
function handleQuestionPush(e) {
  const p = e.payload ?? {}
  if (e.type === 'question.asked') {
    const rec = p.record
    if (rec && rec.id) {
      const list = current.questions ?? []
      current.questions = list.some((q) => q.id === rec.id) ? list : [rec, ...list]
      if (rec.sessionId === current.sessionId) {
        renderQuestions()
      } else {
        toast(`${senderName(rec.asker)} 有问题要问你，点顶部「需你处理」查看`)
      }
    }
  } else {
    current.questions = (current.questions ?? []).filter((q) => q.id !== p.questionId)
    if (e.sessionId === current.sessionId) renderQuestions()
  }
  scheduleRefreshPanels()
  scheduleRefreshAgents()
}

function senderName(sender) {
  if (!sender || sender === 'user') return '我'
  const iid = String(sender).replace(/^u_/, '')
  const m = current.team.find((t) => t.instanceId === iid)
  return m ? m.displayName : sender
}

/** 历史可渲染事件 kind（thought=思考/plan=计划/tool=审计/message=消息/meeting_event=会议过程）。 */
const RENDER_KINDS = new Set([
  'message',
  'thought',
  'plan',
  'tool_call',
  'tool_result',
  'meeting_event',
])

/** 把一条 log 事件渲染进消息流（openSession/loadOlder 共用）。 */
function renderEvent(m) {
  const who = m.sender && m.sender !== 'user' ? senderName(m.sender) : '我'
  if (m.kind === 'message') {
    // 平台注入的系统消息（会议开场/邀请、任务唤醒）不显示成"我的发言"
    if (m.payload?.system === true || m.sender === 'system') {
      appendSystemNote(m.content?.text ?? '')
      return
    }
    appendMessage(who, m.content?.text ?? '', m.role === 'user' ? 'user' : 'agent')
  } else if (m.kind === 'thought') {
    appendThinkNode(who, m.content?.text ?? '')
  } else if (m.kind === 'plan') {
    const steps = Array.isArray(m.payload?.steps)
      ? m.payload.steps.map((s) => (s && s.title ? s.title : String(s)))
      : []
    appendPlan(who, steps)
  } else if (m.kind === 'meeting_event') {
    appendMeetingEvent(m.payload ?? {})
  } else if (m.kind === 'tool_call' || m.kind === 'tool_result') {
    appendToolAudit(who, m)
  }
}

/** 平台系统提示（居中灰字，不是任何人的发言）。 */
function appendSystemNote(text) {
  const box = $('#messages')
  const div = document.createElement('div')
  div.className = 'msg system'
  div.textContent = `系统：${text}`
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
  return div
}

function appendMessage(who, text, cls) {
  const box = $('#messages')
  const div = document.createElement('div')
  div.className = `msg ${cls}`
  const whoEl = document.createElement('div')
  whoEl.className = 'who'
  whoEl.textContent = who
  const body = document.createElement('div')
  fillMessageBody(body, text, cls === 'agent')
  div.appendChild(whoEl)
  div.appendChild(body)
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
  return body
}

/** 消息正文填充：助手回复渲染 Markdown（已转义），其余纯文本。 */
function fillMessageBody(el, text, asMarkdown) {
  if (asMarkdown) el.innerHTML = renderMarkdown(text ?? '')
  else el.textContent = text ?? ''
  return el
}

/**
 * 构造思考块：**默认折叠**（只显示一行「🧠 思考过程（N 字）」，点击展开/收起）。
 * 历史回放与实时流式共用；实时流式下即使未展开也会更新字数。
 */
function createThinkBlock(who, opts = {}) {
  const wrap = document.createElement('div')
  wrap.className = 'msg think'
  const head = document.createElement('div')
  head.className = 'think-head'
  const body = document.createElement('div')
  body.className = 'think-body hidden'
  const state = { who, open: false, live: !!opts.live, chars: 0 }

  const renderHead = () => {
    const arrow = state.open ? '▾' : '▸'
    const label = state.live ? '思考中…' : '思考过程'
    const count = state.chars ? `（${state.chars} 字）` : ''
    head.textContent = `${state.who} · ${arrow} 🧠 ${label}${count}`
    head.title = state.open ? '点击收起思考过程' : '点击展开思考过程'
  }
  head.addEventListener('click', () => {
    state.open = !state.open
    body.classList.toggle('hidden', !state.open)
    renderHead()
  })
  wrap.appendChild(head)
  wrap.appendChild(body)
  renderHead()

  return {
    wrap,
    head,
    body,
    /** 设置完整文本（历史回放） */
    setText(text) {
      const t = text || ''
      body.textContent = t || '（无文本）'
      state.chars = t.length
      renderHead()
    },
    /** 追加流式增量（默认折叠时不展开，仅更新字数） */
    append(delta) {
      const d = delta ?? ''
      state.chars += d.length
      body.textContent += d
      renderHead()
    },
    /** 流结束：标题从「思考中…」收敛为「思考过程」 */
    finish() {
      state.live = false
      state.chars = state.chars || body.textContent.length
      renderHead()
    },
  }
}

/** 历史回放：追加一个思考块（默认折叠），返回其 DOM 节点。 */
function appendThinkNode(who, text) {
  const box = $('#messages')
  const block = createThinkBlock(who)
  block.setText(text)
  box.appendChild(block.wrap)
  box.scrollTop = box.scrollHeight
  return block.wrap
}

/** 计划/行动行：告知用户 agent 将要干什么。 */
function appendPlan(who, steps) {
  const box = $('#messages')
  const div = document.createElement('div')
  div.className = 'msg plan'
  const label = document.createElement('span')
  label.className = 'activity-label'
  label.textContent = `${who} 计划`
  const text = document.createElement('span')
  text.textContent = steps.length ? steps.join(' → ') : '开始执行…'
  div.appendChild(label)
  div.appendChild(text)
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
  return div
}

/** 工具调用行文案（进行中）。 */
function toolCallDetail(p) {
  const tool = String(p.tool ?? '工具')
  const input = p.input ?? {}
  if (input.assignee)
    return `${tool} → ${input.assignee}：${String(input.title ?? '').slice(0, 60)}`
  return `${tool}(${briefJson(input)})`
}

/** 工具结果文案（合并进同一行）。 */
function toolResultDetail(p) {
  const tool = String(p.tool ?? '工具')
  const mark = p.ok === false ? '✗' : '✓'
  if (p.taskId)
    return `${tool} → ${mark} ${String(p.taskId)}${p.assignee ? ' → ' + p.assignee : ''}`
  const tail = String(p.summary ?? p.reason ?? p.code ?? '')
  return `${tool} → ${mark}${tail ? ' ' + tail.slice(0, 120) : ''}`
}

function briefJson(obj) {
  try {
    return JSON.stringify(obj).slice(0, 100)
  } catch {
    return ''
  }
}

/** 已渲染的工具行索引：callId → 行；无 callId 的老日志/平台动作按 tool 名配对。 */
const toolRowByCallId = new Map()
const toolRowPendingByTool = new Map()

/**
 * 工具审计行：**一次调用只占一行**——tool_call 建行（进行中），
 * 对应的 tool_result 回写同一行（✓/✗ + 结果摘要），不再出现"将执行/已执行"两行。
 * 返回 { node, merged }：merged=true 表示结果已并入既有行（调用方不要再插入新行）。
 */
function renderToolAudit(who, e) {
  const p = e.payload ?? {}
  const tool = String(p.tool ?? '工具')
  if (e.kind === 'tool_result') {
    const callId = p.callId ? String(p.callId) : null
    let hit = callId ? toolRowByCallId.get(callId) : null
    if (hit) {
      toolRowByCallId.delete(callId)
      const queue = toolRowPendingByTool.get(tool)
      const idx = queue ? queue.indexOf(hit) : -1
      if (queue && idx >= 0) queue.splice(idx, 1) // 已配对，移出待配对队列
    }
    if (!hit) {
      const queue = toolRowPendingByTool.get(tool)
      if (queue && queue.length) hit = queue.shift()
    }
    if (hit && hit.row && document.body.contains(hit.row)) {
      hit.row.classList.remove('running')
      hit.row.classList.add(p.ok === false ? 'failed' : 'done')
      hit.detail.textContent = toolResultDetail(p)
      hit.row.title = JSON.stringify(p)
      return { node: hit.row, merged: true }
    }
  }
  const div = document.createElement('div')
  div.className = 'msg audit' + (e.kind === 'tool_call' ? ' running' : '')
  const label = document.createElement('span')
  label.className = 'activity-label'
  label.textContent = `🛠 ${who}`
  const detail = document.createElement('span')
  detail.textContent = e.kind === 'tool_call' ? toolCallDetail(p) : toolResultDetail(p)
  div.title = JSON.stringify(p)
  div.appendChild(label)
  div.appendChild(detail)
  if (e.kind === 'tool_call') {
    const entry = { row: div, detail }
    if (p.callId) toolRowByCallId.set(String(p.callId), entry)
    const queue = toolRowPendingByTool.get(tool) ?? []
    queue.push(entry)
    toolRowPendingByTool.set(tool, queue)
  }
  return { node: div, merged: false }
}

/** 工具/系统动作审计行（追加到消息流末尾）。 */
function appendToolAudit(who, e) {
  const box = $('#messages')
  const { node, merged } = renderToolAudit(who, e)
  if (!merged) box.appendChild(node)
  box.scrollTop = box.scrollHeight
  return node
}

/** 正在流式输出的元素：思考块与助手回复气泡**各自独立**（不合并进同一条消息）。 */
let streaming = null

/** 把消息区滚到底。 */
function scrollBottom() {
  const box = $('#messages')
  box.scrollTop = box.scrollHeight
}

/** 取当前 sender 的流式状态；换 sender（换回合/换人）则重置。 */
function streamState(sender) {
  if (!streaming || streaming.sender !== sender) {
    streaming = {
      sender,
      who: '',
      think: null,
      thinkApi: null,
      answer: null,
      answerBody: null,
    }
  }
  if (!streaming.who) {
    streaming.who = sender && sender !== 'user' ? senderName(sender) : 'Agent'
  }
  return streaming
}

/** 思考块：独立于助手回复单独成块（默认折叠；先思考后回复时插在回复之前）。 */
function ensureThinkBlock(sender) {
  const st = streamState(sender)
  if (st.think && document.body.contains(st.think)) return st
  const box = $('#messages')
  const block = createThinkBlock(st.who, { live: true })
  if (st.answer && document.body.contains(st.answer)) box.insertBefore(block.wrap, st.answer)
  else box.appendChild(block.wrap)
  st.think = block.wrap
  st.thinkApi = block
  scrollBottom()
  return st
}

/** 助手回复气泡：与思考块分开的独立块；正文按 Markdown 渲染。 */
function ensureAnswerBlock(sender) {
  const st = streamState(sender)
  if (st.answer && document.body.contains(st.answer)) return st
  const box = $('#messages')
  const wrap = document.createElement('div')
  wrap.className = 'msg agent'
  const whoEl = document.createElement('div')
  whoEl.className = 'who'
  whoEl.textContent = st.who
  const body = document.createElement('div')
  body.className = 'stream-body'
  wrap.appendChild(whoEl)
  wrap.appendChild(body)
  box.appendChild(wrap)
  st.answer = wrap
  st.answerBody = body
  st.raw = ''
  scrollBottom()
  return st
}

/** 流式增量重渲染 Markdown（按帧节流，避免每个分片全量重排）。 */
function renderStreamMarkdown(st) {
  if (!st.answerBody) return
  if (st.renderPending) return
  st.renderPending = true
  const run = () => {
    st.renderPending = false
    st.answerBody.innerHTML = renderMarkdown(st.raw ?? '')
    scrollBottom()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 0)
}

/**
 * 结束当前流式正文气泡（遇到 plan/tool 等过程事件时调用）。
 * 之后的正文会**另起一个气泡**，保证「过程 → 正文」按时间顺序排列，
 * 不会出现"工具行之后的新文本被追加到工具行上方的旧气泡里"。
 */
function sealAnswerStream() {
  if (!streaming || !streaming.answerBody) return
  streaming.answerBody.innerHTML = renderMarkdown(streaming.raw ?? '')
  streaming.answer = null
  streaming.answerBody = null
  streaming.raw = ''
}

let wsReconnectDelay = 1000

function connectWs(pid) {
  if (ws) ws.close()
  const open = () => {
    ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?projectId=${pid}`,
    )
    ws.onopen = () => {
      wsReconnectDelay = 1000
    }
    ws.onmessage = (evt) => {
      const e = JSON.parse(evt.data)
      // 提问推送：**在会话过滤之前**处理——别的角色会话里的提问也要能提示到用户
      if (e.type === 'question.asked' || e.type === 'question.answered') {
        handleQuestionPush(e)
        return
      }
      if (e.sessionId && e.sessionId !== current.sessionId) {
        // 其它会话的事件（别的角色在各自会话里干活）当前不需要在界面上反映，直接忽略
        return
      }
      if (e.type === 'message.chunk') {
        // 助手回复：独立气泡（与思考块分开）；正文按 Markdown 渲染
        setTyping(false)
        const st = ensureAnswerBlock(e.payload?.sender)
        st.raw = (st.raw ?? '') + (e.payload.delta ?? '')
        renderStreamMarkdown(st)
      } else if (e.type === 'thought.chunk') {
        // 思考：独立块（纯文本、默认折叠；未展开时只更新字数）
        const st = ensureThinkBlock(e.payload?.sender)
        st.thinkApi.append(e.payload.delta ?? '')
        scrollBottom()
      } else if (e.type === 'message.commit') {
        streaming?.thinkApi?.finish()
        if (streaming?.answerBody) {
          streaming.answerBody.innerHTML = renderMarkdown(streaming.raw ?? '')
        }
        streaming = null
        current.lastRenderedSeq = Math.max(current.lastRenderedSeq, Number(e.payload?.seq ?? 0))
        setTyping(false)
        setSendBusy(false)
        scheduleRefreshPanels()
      } else if (e.type === 'event.appended') {
        // 增量事件（plan/tool/thought 等）：seq 已渲染过则跳过，防重复
        const p = e.payload ?? {}
        const seq = Number(p.seq ?? 0)
        if (seq > 0 && seq <= current.lastRenderedSeq) return
        if (seq > 0) current.lastRenderedSeq = seq
        if (p.kind === 'plan') {
          sealAnswerStream()
          const who = p.sender && p.sender !== 'user' ? senderName(p.sender) : 'Agent'
          const steps = Array.isArray(p.steps)
            ? p.steps.map((s) => (s && s.title ? s.title : String(s)))
            : []
          appendPlan(who, steps)
        } else if (p.kind === 'tool_call' || p.kind === 'tool_result') {
          // 过程事件出现 = 当前正文段落结束：封口后再追加工具行，
          // 之后的正文会另起气泡 → 与后端落盘顺序（过程 → 正文）一致
          sealAnswerStream()
          appendToolAudit(p.sender && p.sender !== 'user' ? senderName(p.sender) : 'Agent', {
            kind: p.kind,
            sender: p.sender,
            payload: p,
          })
        } else if (p.kind === 'meeting_event') {
          appendMeetingEvent(p)
        }
        // message/thought 由流式或历史渲染负责，仅刷新面板（合并刷新，避免风暴）
        scheduleRefreshPanels()
      } else if (e.type === 'agent.state') {
        // 角色状态变化（开工/入会/空闲）→ 刷新左栏团队状态（合并刷新）
        scheduleRefreshAgents()
      } else if (e.type === 'session.updated') {
        scheduleRefreshPanels()
      }
    }
    ws.onclose = () => {
      if (current.pid !== pid) return
      setTimeout(() => {
        if (current.pid !== pid) return
        toast(`连接断开，${wsReconnectDelay / 1000}s 后重连…`)
        connectWs(pid)
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, 8000)
      }, wsReconnectDelay)
    }
  }
  open()
}

/** 去重调度器：同类刷新同时只允许一个在飞；期间只记一次待办，跑完再排一次。 */
function createCoalesced(delayMs, run) {
  let timer = null
  let running = false
  let again = false
  const fire = () => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = true
    void Promise.resolve(run())
      .catch(() => undefined)
      .finally(() => {
        running = false
        if (again) {
          again = false
          fire()
        }
      })
  }
  return () => {
    if (timer) return
    timer = setTimeout(fire, delayMs)
  }
}

const scheduleRefreshPanels = createCoalesced(1200, () => refreshPanels())
const scheduleRefreshAgents = createCoalesced(5000, () => refreshAgents())

/** 会议事件中文名（会议会话里作为过程行展示）。 */
const MEETING_ACTION_ZH = {
  create: '发起会议',
  respond: '回应邀请',
  open: '会议开始',
  lineup: '阵容确认',
  round: '点名发言',
  ask_user: '请求拍板',
  user_answer: '用户拍板',
  cancel: '取消会议',
  close: '结束会议',
  interject: '用户插话',
  promote_queued: '排队转征询',
}

/** 会议事件行（谁 做了什么 + 细节）。 */
function appendMeetingEvent(p) {
  const box = $('#messages')
  const div = document.createElement('div')
  div.className = 'msg audit meeting-event'
  const label = document.createElement('span')
  label.className = 'activity-label'
  label.textContent = '📋 会议'
  const actor = p.member ?? p.actor ?? p.host ?? ''
  const detail = [
    MEETING_ACTION_ZH[String(p.action)] ?? String(p.action ?? ''),
    actor ? `${senderName(actor)}（${actor}）` : '',
    p.decision ? String(p.decision) : '',
    p.topic ? `「${String(p.topic).slice(0, 40)}」` : '',
    Array.isArray(p.members) ? `参会：${p.members.join('、')}` : '',
    p.question ? `：${String(p.question).slice(0, 60)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const text = document.createElement('span')
  text.textContent = detail
  div.title = JSON.stringify(p)
  div.appendChild(label)
  div.appendChild(text)
  box.appendChild(div)
  scrollBottom()
  return div
}

async function sendMessage() {
  const text = $('#msg-text').value.trim()
  if (!text || !current.pid || !current.sessionId || current.busy) return
  if ($('#msg-text').disabled) {
    toast('该角色已停用，仅可查看历史；请先在左侧「团队」启用')
    return
  }
  $('#msg-text').value = ''
  appendMessage('我', text, 'user')
  setSendBusy(true)
  setTyping(true)
  try {
    await api(`/projects/${current.pid}/sessions/${current.sessionId}/messages`, 'POST', {
      text,
    })
  } catch (e) {
    toast(e.message)
    setTyping(false)
    setSendBusy(false)
  }
}

/** 加载更早消息（beforeSeq 向前翻页）。 */
async function loadOlder() {
  const pid = current.pid
  const sid = current.sessionId
  const before = current.oldestSeq
  if (!pid || !sid || before == null || before <= 1) return
  const btn = $('#btn-load-old')
  btn.disabled = true
  btn.textContent = '加载中…'
  try {
    const d = await api(`/projects/${pid}/sessions/${sid}?beforeSeq=${before}&limit=50`)
    const box = $('#messages')
    const fetched = (d.messages ?? []).filter((e) => e.seq && e.seq < before)
    // 翻页位置用**所有事件**推进（会议里前面多是 meeting_event），渲染只挑可渲染类型
    const olderAll = fetched.sort((a, b) => a.seq - b.seq)
    const older = olderAll.filter((e) => e.role !== 'system' && RENDER_KINDS.has(e.kind))
    for (const m of older) {
      const top = box.firstChild
      const beforeEl = top && top.nodeType === 1 ? top : null
      if (m.kind === 'message') {
        if (m.payload?.system === true || m.sender === 'system') {
          const note = document.createElement('div')
          note.className = 'msg system'
          note.textContent = `系统：${m.content?.text ?? ''}`
          box.insertBefore(note, beforeEl)
          continue
        }
        const div = document.createElement('div')
        div.className = `msg ${m.role === 'user' ? 'user' : 'agent'}`
        const whoEl = document.createElement('div')
        whoEl.className = 'who'
        whoEl.textContent = m.role === 'user' ? '我' : senderName(m.sender)
        const body = document.createElement('div')
        fillMessageBody(body, m.content?.text ?? '', m.role !== 'user')
        div.appendChild(whoEl)
        div.appendChild(body)
        box.insertBefore(div, beforeEl)
      } else if (m.kind === 'meeting_event') {
        const node = buildMeetingEventNode(m.payload ?? {})
        box.insertBefore(node, beforeEl)
      } else {
        // thought/plan/tool：独立块
        const who = m.sender && m.sender !== 'user' ? senderName(m.sender) : '我'
        if (m.kind === 'thought') {
          box.insertBefore(buildThinkNode(who, m.content?.text ?? ''), beforeEl)
        } else if (m.kind === 'plan') {
          const steps = Array.isArray(m.payload?.steps)
            ? m.payload.steps.map((s) => (s && s.title ? s.title : String(s)))
            : []
          box.insertBefore(buildPlanNode(who, steps), beforeEl)
        } else {
          // tool_result 会并入对应调用行；merged 时返回 null（无需插入新节点）
          const node = buildToolNode(who, m)
          if (node) box.insertBefore(node, beforeEl)
        }
      }
    }
    if (olderAll.length) {
      current.oldestSeq = olderAll[0].seq
      $('#load-old-wrap').classList.toggle('hidden', olderAll[0].seq <= 1)
    } else {
      // 已经到最前面了：给个反馈并收起按钮（此前点"没反应"）
      toast('已经是最早的消息了')
      $('#load-old-wrap').classList.add('hidden')
    }
  } catch (e) {
    toast('加载更早消息失败: ' + e.message)
  } finally {
    btn.disabled = false
    btn.textContent = '加载更早消息'
  }
}

/** 构造会议事件节点（用于前向翻页插入）。 */
function buildMeetingEventNode(p) {
  const div = document.createElement('div')
  div.className = 'msg audit meeting-event'
  const label = document.createElement('span')
  label.className = 'activity-label'
  label.textContent = '📋 会议'
  const actor = p.member ?? p.actor ?? p.host ?? ''
  const text = document.createElement('span')
  text.textContent = [
    MEETING_ACTION_ZH[String(p.action)] ?? String(p.action ?? ''),
    actor ? `${senderName(String(actor))}（${String(actor)}）` : '',
    p.decision ? String(p.decision) : '',
    Array.isArray(p.members) ? `参会：${p.members.join('、')}` : '',
    p.question ? `：${String(p.question).slice(0, 60)}` : '',
  ]
    .filter(Boolean)
    .join(' ')
  div.title = JSON.stringify(p)
  div.appendChild(label)
  div.appendChild(text)
  return div
}

/** 构造独立思考块节点（用于前向翻页插入；默认折叠）。 */
function buildThinkNode(who, text) {
  const block = createThinkBlock(who)
  block.setText(text)
  return block.wrap
}

/** 构造计划节点（用于前向翻页插入）。 */
function buildPlanNode(who, steps) {
  const div = document.createElement('div')
  div.className = 'msg plan'
  const label = document.createElement('span')
  label.className = 'activity-label'
  label.textContent = `${who} 计划`
  const text = document.createElement('span')
  text.textContent = steps.length ? steps.join(' → ') : '开始执行…'
  div.appendChild(label)
  div.appendChild(text)
  return div
}

/** 构造审计行节点（用于前向翻页插入）。 */
/** 构造审计行节点（用于前向翻页插入；结果会并入对应的调用行）。 */
function buildToolNode(who, e) {
  const { node, merged } = renderToolAudit(who, e)
  return merged ? null : node
}

async function refreshPanels() {
  if (!current.pid) return
  const pid = current.pid
  // 各面板**互相独立**：任一接口失败（网络/旧版本服务）都不能让其它面板（尤其提问卡片）不刷新
  const get = (p) => api(p).catch(() => null)
  const [a, m, mem, att, tk, qs, ag] = await Promise.all([
    get(`/projects/${pid}/approvals?status=pending`),
    get(`/projects/${pid}/meetings`),
    get(`/projects/${pid}/memories?scope=global`),
    get(`/projects/${pid}/needs-attention`),
    get(`/projects/${pid}/tasks`),
    get(`/projects/${pid}/questions?status=pending`),
    get(`/projects/${pid}/agents`),
  ])
  if (current.pid !== pid) return // 期间已切换项目/会话
  if (a) {
    current.approvals = a.approvals ?? []
    renderApprovals()
  }
  if (m) {
    current.meetings = m.meetings ?? []
    renderMeetings()
    renderMeetingsNav()
  }
  if (tk) {
    current.tasks = tk.tasks ?? []
    renderTasks()
  }
  if (qs) {
    current.questions = qs.questions ?? []
    renderQuestions() // 角色提问卡片（待回答）——独立渲染，不依赖其它面板
  }
  if (ag) {
    current.agents = ag.agents ?? []
    renderTeamNav()
  }
  if (mem) renderMemories(mem.entries ?? [])
  if (att) {
    const items = att.items ?? []
    const wrap = $('#attention-wrap')
    if (items.length) {
      wrap.classList.remove('hidden')
      $('#attention-count').textContent = items.length
    } else {
      wrap.classList.add('hidden')
    }
  }
}

/** 任务状态中文名（任务面板用；状态由角色自己汇报）。 */
const TASK_STATE_ZH = {
  todo: '排队',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
  terminated: '已终止',
}

function renderTasks() {
  const ul = $('#task-list')
  ul.innerHTML = ''
  const tasks = current.tasks ?? []
  if (!tasks.length) {
    const li = document.createElement('div')
    li.className = 'empty-tip'
    li.textContent = '（暂无任务）'
    ul.appendChild(li)
    return
  }
  for (const t of tasks.slice(0, 12)) {
    const li = document.createElement('div')
    li.className = 'task-item'
    const state = document.createElement('span')
    state.className = `state task-state state-${t.state}`
    state.textContent = TASK_STATE_ZH[t.state] ?? t.state
    const title = document.createElement('span')
    title.textContent = `${t.title} → ${t.assignee}`
    title.title = `${t.id}\n${t.desc ?? ''}`
    li.appendChild(state)
    li.appendChild(title)
    ul.appendChild(li)
  }
  // 状态由角色自己汇报（task_update / 会话里报告），用户只查看
  const tip = document.createElement('div')
  tip.className = 'empty-tip'
  tip.textContent = '状态由角色自行汇报（开工/完成/受阻），你无需手动点击'
  ul.appendChild(tip)
}

async function openAttentionModal() {
  const d = await api(`/projects/${current.pid}/needs-attention`)
  const items = d.items ?? []
  const ul = $('#attention-items')
  ul.innerHTML = ''
  for (const it of items) {
    const li = document.createElement('li')
    const KIND_LABEL = { approval: '审批', meeting: '会议', question: '提问' }
    const title = document.createElement('span')
    title.className = 'att-title'
    title.textContent = `[${KIND_LABEL[it.kind] ?? it.kind}] ${it.title}`
    li.appendChild(title)
    if (it.kind === 'approval') {
      const ok = document.createElement('button')
      ok.className = 'primary'
      ok.textContent = '批准'
      ok.onclick = async () => {
        await api(`/projects/${current.pid}/approvals/${it.approvalId}/decide`, 'POST', {
          decision: 'approved',
        })
        toast('已批准')
        await refreshPanels()
        openAttentionModal()
      }
      const no = document.createElement('button')
      no.textContent = '拒绝'
      no.onclick = async () => {
        await api(`/projects/${current.pid}/approvals/${it.approvalId}/decide`, 'POST', {
          decision: 'rejected',
        })
        toast('已拒绝')
        await refreshPanels()
        openAttentionModal()
      }
      li.appendChild(ok)
      li.appendChild(no)
    } else if (it.kind === 'meeting') {
      const ok = document.createElement('button')
      ok.className = 'primary'
      ok.textContent = '拍板：批准'
      ok.onclick = async () => {
        await api(`/projects/${current.pid}/meetings/${it.meetingId}/decision`, 'POST', {
          questionId: it.questionId,
          text: '批准',
        })
        toast('已拍板')
        await refreshPanels()
        openAttentionModal()
      }
      li.appendChild(ok)
    } else if (it.kind === 'question') {
      // 直接就地交互（单选/多选/确认/文本）；找不到详情时提供跳转
      const q = (current.questions ?? []).find((x) => x.id === it.questionId)
      li.classList.add('att-question')
      if (q) {
        li.appendChild(
          buildQuestionCard(q, {
            compact: true,
            onDone: () => openAttentionModal(),
          }),
        )
      } else {
        const go = document.createElement('button')
        go.className = 'primary'
        go.textContent = '去会话回答'
        go.onclick = async () => {
          $('#attention-modal').classList.add('hidden')
          if (it.sessionId) await openSession(current.pid, it.sessionId)
        }
        li.appendChild(go)
      }
    }
    ul.appendChild(li)
  }
  if (!items.length) {
    const empty = document.createElement('li')
    empty.textContent = '（暂无待办）'
    ul.appendChild(empty)
  }
  $('#attention-modal').classList.remove('hidden')
}

function renderApprovals() {
  const ul = $('#approval-list')
  ul.innerHTML = ''
  $('#approval-count').textContent = current.approvals.length || ''
  if (!current.approvals.length) {
    const li = document.createElement('div')
    li.className = 'empty-tip'
    li.textContent = '（暂无待审批）'
    ul.appendChild(li)
    return
  }
  for (const ap of current.approvals) {
    const li = document.createElement('div')
    li.className = 'approval'
    li.innerHTML = `<div><b>${ap.summary}</b></div><div class="who">${ap.actor} · ${ap.kind}</div>`
    const ok = document.createElement('button')
    ok.textContent = '批准'
    ok.className = 'primary'
    ok.onclick = async () => {
      await api(`/projects/${current.pid}/approvals/${ap.id}/decide`, 'POST', {
        decision: 'approved',
      })
      await refreshPanels()
    }
    const no = document.createElement('button')
    no.textContent = '拒绝'
    no.onclick = async () => {
      await api(`/projects/${current.pid}/approvals/${ap.id}/decide`, 'POST', {
        decision: 'rejected',
      })
      await refreshPanels()
    }
    li.appendChild(ok)
    li.appendChild(no)
    ul.appendChild(li)
  }
}

/** 右栏「当前会议」：只显示当前打开的会议及其控制（全部会议在左栏「会议」）。 */
function renderMeetings() {
  const ul = $('#meeting-list')
  ul.innerHTML = ''
  const ma = $('#meeting-actions')
  ma.innerHTML = ''
  const active = (current.meetings ?? []).filter((x) => x.id === current.sessionId)
  if (!active.length) {
    const hint = document.createElement('div')
    hint.className = 'empty-tip'
    hint.textContent = '（未打开会议：在左侧「会议」里选择，或点「＋发起」申请开会）'
    ul.appendChild(hint)
    return
  }
  for (const mt of active) {
    const li = document.createElement('div')
    li.className = 'meeting-item'
    const state = mt.state
    const hostName = current.team.find((t) => t.instanceId === mt.meeting?.host)?.displayName
    li.innerHTML = `<b>${mt.meeting?.topic ?? mt.id}</b> <span class="badge state-${state}">${stateZh(
      state,
    )}</span><br/>
      <span class="who">主持人 ${hostName ?? mt.meeting?.host ?? mt.host}</span>`
    if (state === 'proposed' && current.team.length) {
      const acc = document.createElement('button')
      acc.textContent = '成员接受'
      acc.onclick = async () => {
        const member = current.team.find((t) => t.instanceId !== mt.meeting?.host)?.instanceId
        if (!member) return
        await api(`/projects/${current.pid}/meetings/${mt.id}/respond`, 'POST', {
          member,
          decision: 'accept',
        })
        await refreshPanels()
      }
      li.appendChild(acc)
    }
    if (state === 'open') {
      const ask = document.createElement('button')
      ask.textContent = '请求拍板'
      ask.onclick = async () => {
        await api(`/projects/${current.pid}/meetings/${mt.id}/ask`, 'POST', {
          asker: mt.meeting?.host,
          question: '是否批准该方案？',
          options: ['批准', '暂缓'],
        })
        await refreshPanels()
      }
      li.appendChild(ask)
      // 点名成员发言（轮次）
      const members = (mt.meeting?.members ?? []).filter((m) => m !== mt.meeting?.host)
      if (members.length) {
        const talk = document.createElement('button')
        talk.textContent = `点名 ${members[0]} 发言`
        talk.onclick = async () => {
          await api(`/projects/${current.pid}/meetings/${mt.id}/talk`, 'POST', {
            host: mt.meeting?.host,
            member: members[0],
          })
          await refreshPanels()
        }
        li.appendChild(talk)
      }
    }
    if (state === 'blocked_waiting_user') {
      const ok = document.createElement('button')
      ok.className = 'primary'
      ok.textContent = '拍板：批准'
      ok.onclick = async () => {
        const q = mt.meeting?.decisionPoints?.find((d) => d.status === 'pending')
        if (q) {
          await api(`/projects/${current.pid}/meetings/${mt.id}/decision`, 'POST', {
            questionId: q.id,
            choice: '批准',
            text: '批准',
          })
          await refreshPanels()
        }
      }
      li.appendChild(ok)
    }
    if (state === 'open' || state === 'blocked_waiting_user') {
      const close = document.createElement('button')
      close.textContent = '结束会议'
      close.onclick = async () => {
        await api(`/projects/${current.pid}/meetings/${mt.id}/close`, 'POST', { actor: 'user' })
        await refreshPanels()
      }
      li.appendChild(close)
    }
    if (state === 'closed') {
      const min = document.createElement('button')
      min.textContent = '查看纪要'
      min.onclick = async () => {
        const d = await api(`/projects/${current.pid}/meetings/${mt.id}/minutes`)
        $('#memory-panel').innerHTML = `<pre>${escapeHtml(d.minutes.text)}</pre>`
      }
      li.appendChild(min)
      const regen = document.createElement('button')
      regen.textContent = '重新生成纪要'
      regen.onclick = async () => {
        const d = await api(
          `/projects/${current.pid}/meetings/${mt.id}/regenerate-minutes`,
          'POST',
          {},
        )
        $('#memory-panel').innerHTML = `<pre>${escapeHtml(d.minutes.text)}</pre>`
        toast('纪要已重新生成')
      }
      li.appendChild(regen)
    }
    ul.appendChild(li)
  }
}

function renderMemories(entries) {
  const box = $('#memory-panel')
  if (!entries.length) {
    box.innerHTML = '<div class="empty-tip">（暂无全局记忆/纪要）</div>'
    return
  }
  box.innerHTML = '<h5>全局记忆（最新）</h5>'
  for (const e of entries.slice(0, 5)) {
    const div = document.createElement('div')
    div.className = 'who'
    div.textContent = `[${e.type}] ${e.content.slice(0, 120)}`
    box.appendChild(div)
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

window.__current = () => current
boot().catch((e) => toast('初始化失败: ' + e.message))
