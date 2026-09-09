/**
 * Agent Haness 前端（无构建静态 ESM；M7 工作台 MVP）。
 * 覆盖：项目列表/创建(选目录+勾角色)、团队与会话列表、聊天(WS 流式/历史)、审批、会议、产出物、记忆/纪要。
 */
const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]

let projects = []
let current = {
  pid: null,
  sessionId: null,
  team: [],
  sessions: [],
  approvals: [],
  meetings: [],
  artifacts: [],
}
let ws = null

async function api(path, method = 'GET', body = null) {
  const opts = { method, headers: {} }
  if (body) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`/api${path}`, opts)
  const data = await res.json().catch(() => ({}))
  if (!res.ok && data.code) throw new Error(`${data.code}: ${data.message}`)
  return data
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
      card.appendChild(name)
      card.appendChild(meta)
      if (p.description) card.appendChild(desc)
      card.appendChild(enter)
      grid.appendChild(card)
    }
    $('#project-empty').classList.toggle('hidden', projects.length > 0)
  } catch (e) {
    toast('加载项目失败: ' + e.message)
  }
}

/** 页 2：进入某项目的会话工作台。 */
async function enterProject(pid) {
  const p = projects.find((x) => x.id === pid)
  $('#current-project').textContent = p ? ` / ${p.name}` : ` / ${pid}`
  $('#current-project').classList.remove('hidden')
  $('#projects-view').classList.add('hidden')
  $('#layout').classList.remove('hidden')
  setExportVisible(true)
  await openProject(pid)
}

function setExportVisible(visible) {
  $('#btn-export').classList.toggle('hidden', !visible)
}

function bindGlobal() {
  $('#btn-home').addEventListener('click', () => showProjectsView())
  $('#btn-new-project').addEventListener('click', loadRolePicker)
  // 每次打开弹窗都重新拉角色（容错：失败 toast，避免空列表）
  async function loadRolePicker() {
    const w = $('#wizard')
    w.classList.remove('hidden')
    const box = $('#w-roles')
    box.innerHTML = '<li class="who">加载角色…</li>'
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
        lab.appendChild(cb)
        lab.appendChild(document.createTextNode(`${r.name}(${r.roleId})`))
        box.appendChild(lab)
      }
      if (!(d.roles ?? []).length) {
        box.innerHTML = '<li class="who">暂无角色模板（检查服务端 src/shared/roles）</li>'
      }
    } catch (e) {
      box.innerHTML = '<li class="who">角色加载失败：' + escapeHtml(e.message) + '</li>'
    }
  }
  $('#btn-wizard-close').addEventListener('click', () => $('#wizard').classList.add('hidden'))
  $('#btn-create').addEventListener('click', async () => {
    const team = $$('#w-roles input:checked').map((c) => ({ roleTemplateId: c.value }))
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
  $('#msg-text').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  })

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
}

async function openProject(pid) {
  current.pid = pid
  connectWs(pid)
  const [team, sessions] = await Promise.all([
    api(`/projects/${pid}/team`),
    api(`/projects/${pid}/sessions`),
  ])
  current.team = team.team ?? []
  current.sessions = sessions.sessions ?? []
  renderTeam()
  renderSessions()
  await refreshPanels()
  const userSid = current.sessions.find((s) => s.type === 'user')?.id
  if (userSid) await openSession(pid, userSid)
  else renderEmptyCenter('该项目暂无角色实例。请在左侧“团队”处点击 +开发/+产品 添加角色。')
}

/** 中央区空态提示（无会话/无角色时）。 */
function renderEmptyCenter(text) {
  $('#composer').classList.add('hidden')
  $('#session-header').textContent = '未打开会话'
  const box = $('#messages')
  box.innerHTML = ''
  const div = document.createElement('div')
  div.className = 'empty'
  div.textContent = text
  box.appendChild(div)
}

function renderTeam() {
  const ul = $('#team-list')
  ul.innerHTML = ''
  for (const m of current.team) {
    const li = document.createElement('li')
    li.textContent = `${m.displayName} [${m.instanceId}]${m.enabled ? '' : '（停用）'}`
    ul.appendChild(li)
  }
  if (!current.team.length) {
    const li = document.createElement('li')
    li.className = 'who'
    li.textContent = '（暂无角色）'
    ul.appendChild(li)
    // 便捷补加常用角色
    for (const r of [
      ['pm', 'PM'],
      ['product', '产品'],
      ['dev', '开发'],
    ]) {
      const b = document.createElement('button')
      b.textContent = `+${r[1]}`
      b.onclick = async () => {
        try {
          await api(`/projects/${current.pid}/team`, 'POST', { roleTemplateId: r[0] })
          toast(`已添加 ${r[1]}`)
          await reloadProjectView()
        } catch (e) {
          toast(e.message)
        }
      }
      ul.appendChild(b)
    }
  }
}

/** 重载项目内团队/会话并回默认会话（加成员后调用）。 */
async function reloadProjectView() {
  const [team, sessions] = await Promise.all([
    api(`/projects/${current.pid}/team`),
    api(`/projects/${current.pid}/sessions`),
  ])
  current.team = team.team ?? []
  current.sessions = sessions.sessions ?? []
  renderTeam()
  renderSessions()
  await refreshPanels()
  const userSid = current.sessions.find((s) => s.type === 'user')?.id
  if (userSid) await openSession(current.pid, userSid)
}

function renderSessions() {
  const ul = $('#session-list')
  ul.innerHTML = ''
  for (const s of current.sessions) {
    const li = document.createElement('li')
    const unread = Number(s.unread ?? 0) > 0 ? ` <span class="badge">${s.unread}</span>` : ''
    li.textContent = `${s.id}${unread}`
    li.dataset.sid = s.id
    li.addEventListener('click', () => openSession(current.pid, s.id))
    if (s.id === current.sessionId) li.classList.add('active')
    ul.appendChild(li)
  }
}

async function openSession(pid, sid) {
  current.sessionId = sid
  renderSessions()
  const d = await api(`/projects/${pid}/sessions/${sid}`)
  const meta = d.session
  $('#session-header').textContent = `${meta.id} · ${meta.type} · ${meta.state}`
  const box = $('#messages')
  box.innerHTML = ''
  const msgs = (d.messages ?? []).filter((e) => e.kind === 'message')
  let lastSeq = meta.lastSeq ?? 0
  for (const m of msgs) {
    if (m.role === 'system') continue
    appendMessage(
      m.role === 'user' ? '我' : m.sender,
      m.content?.text ?? '',
      m.role === 'user' ? 'user' : 'agent',
    )
    if (m.seq) lastSeq = Math.max(lastSeq, m.seq)
  }
  // 打开即已读（读回执 → 未读清零）
  await api(`/projects/${pid}/sessions/${sid}/read`, 'POST', { seq: lastSeq }).catch(
    () => undefined,
  )
  // 重连增量锚点
  current.seenSeq = lastSeq
  if (meta.type === 'user') $('#composer').classList.remove('hidden')
  else $('#composer').classList.add('hidden')
}

function appendMessage(who, text, cls) {
  const box = $('#messages')
  const div = document.createElement('div')
  div.className = `msg ${cls}`
  const whoEl = document.createElement('div')
  whoEl.className = 'who'
  whoEl.textContent = who
  const body = document.createElement('div')
  body.textContent = text
  div.appendChild(whoEl)
  div.appendChild(body)
  box.appendChild(div)
  box.scrollTop = box.scrollHeight
  return body
}

let wsReconnectDelay = 1000

function connectWs(pid) {
  if (ws) ws.close()
  let streaming = null
  const open = () => {
    ws = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?projectId=${pid}`,
    )
    ws.onopen = () => {
      wsReconnectDelay = 1000
    }
    ws.onmessage = (evt) => {
      const e = JSON.parse(evt.data)
      if (e.sessionId && e.sessionId !== current.sessionId) {
        refreshUnread().catch(() => undefined)
        return
      }
      if (e.type === 'message.chunk') {
        if (!streaming) {
          streaming = appendMessage('Agent…', '', 'agent')
        }
        streaming.textContent += e.payload.delta ?? ''
      } else if (e.type === 'message.commit') {
        streaming = null
        current.seenSeq = e.payload?.seq ?? current.seenSeq
        refreshPanels()
      } else if (e.type === 'session.updated' || e.type === 'event.appended') {
        refreshPanels().catch(() => undefined)
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

// 刷新未读（会话列表徽标）
async function refreshUnread() {
  if (!current.pid) return
  const s = await api(`/projects/${current.pid}/sessions`).catch(() => null)
  if (!s) return
  current.sessions = s.sessions ?? []
  renderSessions()
}

async function sendMessage() {
  const text = $('#msg-text').value.trim()
  if (!text || !current.pid || !current.sessionId) return
  $('#msg-text').value = ''
  appendMessage('我', text, 'user')
  await api(`/projects/${current.pid}/sessions/${current.sessionId}/messages`, 'POST', { text })
  await refreshPanels()
}

async function refreshPanels() {
  if (!current.pid) return
  try {
    const [a, m, ar, mem, att, tk] = await Promise.all([
      api(`/projects/${current.pid}/approvals?status=pending`),
      api(`/projects/${current.pid}/meetings`),
      api(`/projects/${current.pid}/artifacts`),
      api(`/projects/${current.pid}/memories?scope=global`),
      api(`/projects/${current.pid}/needs-attention`),
      api(`/projects/${current.pid}/tasks`),
    ])
    current.approvals = a.approvals ?? []
    current.meetings = m.meetings ?? []
    current.artifacts = ar.artifacts ?? []
    current.tasks = tk.tasks ?? []
    renderApprovals()
    renderMeetings()
    renderArtifacts()
    renderMemories(mem.entries ?? [])
    renderTasks()
    const items = att.items ?? []
    const wrap = $('#attention-wrap')
    if (items.length) {
      wrap.classList.remove('hidden')
      $('#attention-count').textContent = items.length
    } else {
      wrap.classList.add('hidden')
    }
  } catch {
    /* 面板刷新失败不打扰 */
  }
}

function renderTasks() {
  const ul = $('#task-list')
  ul.innerHTML = ''
  const tasks = current.tasks ?? []
  if (!tasks.length) return
  for (const t of tasks.slice(0, 12)) {
    const li = document.createElement('div')
    li.className = 'task-item'
    const title = document.createElement('span')
    title.textContent = `${t.title} → ${t.assignee}`
    title.title = `${t.id}\n${t.desc ?? ''}`
    const state = document.createElement('span')
    state.className = 'state'
    state.textContent = t.state
    li.appendChild(state)
    li.appendChild(title)
    if (t.state === 'todo') {
      li.appendChild(actionBtn('开工', async () => setTask(t, 'in_progress')))
    } else if (t.state === 'in_progress') {
      li.appendChild(actionBtn('完成', async () => setTask(t, 'done')))
      li.appendChild(actionBtn('终止', async () => setTask(t, 'terminated')))
    }
    ul.appendChild(li)
  }
  function actionBtn(label, fn) {
    const b = document.createElement('button')
    b.textContent = label
    b.onclick = async () => {
      try {
        await fn()
        toast('任务状态已更新')
        await refreshPanels()
      } catch (e) {
        toast(e.message)
      }
    }
    return b
  }
}

async function setTask(t, state) {
  await api(`/projects/${current.pid}/tasks/${t.id}`, 'PATCH', { state, actor: 'user' })
}

async function openAttentionModal() {
  const d = await api(`/projects/${current.pid}/needs-attention`)
  const items = d.items ?? []
  const ul = $('#attention-items')
  ul.innerHTML = ''
  for (const it of items) {
    const li = document.createElement('li')
    const title = document.createElement('span')
    title.className = 'att-title'
    title.textContent = `[${it.kind === 'approval' ? '审批' : '会议'}] ${it.title}`
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

function renderMeetings() {
  const ul = $('#meeting-list')
  ul.innerHTML = ''
  const ma = $('#meeting-actions')
  ma.innerHTML = ''
  // 从团队取主持人+成员（简化：第一个 agent 主持，其余作成员）
  if (current.team.length >= 2) {
    const b = document.createElement('button')
    b.textContent = '发起会议(评审)'
    b.onclick = async () => {
      const [host, ...members] = current.team.map((t) => t.instanceId)
      const d = await api(`/projects/${current.pid}/meetings`, 'POST', {
        host,
        topic: '进度评审',
        members: members.slice(0, 1),
      })
      const mid = d.meeting.id
      const second = members.slice(1)[0]
      if (second) {
        await api(`/projects/${current.pid}/meetings/${mid}/respond`, 'POST', {
          member: second,
          decision: 'accept',
        })
      }
      await refreshPanels()
    }
    ma.appendChild(b)
  }
  for (const mt of current.meetings) {
    const li = document.createElement('div')
    li.className = 'meeting-item'
    const state = mt.state
    li.innerHTML = `<b>${mt.meeting?.topic ?? mt.id}</b> <span class="badge">${state}</span><br/>
      <span class="who">主持人 ${mt.meeting?.host ?? mt.host}</span>`
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

function renderArtifacts() {
  const ul = $('#artifact-list')
  ul.innerHTML = ''
  for (const a of current.artifacts.slice(0, 20)) {
    const li = document.createElement('div')
    li.className = 'artifact-item'
    li.innerHTML = `<b>${a.title}</b> <span class="badge">${a.state}</span><br/>
      <span class="who">v${a.version} · ${a.submitter} · ${a.type}</span>`
    if (a.state !== 'reverted') {
      const rb = document.createElement('button')
      rb.textContent = '回退'
      rb.onclick = async () => {
        await api(`/projects/${current.pid}/artifacts/${a.id}/rollback`, 'POST', {})
        toast('已回退')
        await refreshPanels()
      }
      li.appendChild(rb)
    }
    ul.appendChild(li)
  }
}

function renderMemories(entries) {
  if (!entries.length) return
  const box = $('#memory-panel')
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
