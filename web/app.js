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
  await refreshProjects()
  bindGlobal()
  const first = projects[0]
  if (first) await openProject(first.id)
}

async function refreshProjects() {
  try {
    const d = await api('/projects')
    projects = d.projects ?? []
    const sel = $('#project-select')
    sel.innerHTML = ''
    for (const p of projects) {
      const o = document.createElement('option')
      o.value = p.id
      o.textContent = p.name
      sel.appendChild(o)
    }
    $('#layout').classList.remove('hidden')
  } catch (e) {
    toast('加载项目失败: ' + e.message)
  }
}

function bindGlobal() {
  $('#project-select').addEventListener('change', async (e) => {
    if (e.target.value) await openProject(e.target.value)
  })
  $('#btn-new-project').addEventListener('click', async () => {
    const w = $('#wizard')
    w.classList.toggle('hidden')
    if (!w.classList.contains('hidden') && $('#w-roles').childElementCount === 0) {
      const d = await api('/roles')
      const box = $('#w-roles')
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
    }
  })
  $('#btn-wizard-close').addEventListener('click', () => $('#wizard').classList.add('hidden'))
  $('#btn-create').addEventListener('click', async () => {
    const team = $$('#w-roles input:checked').map((c) => ({ roleTemplateId: c.value }))
    try {
      const d = await api('/projects', 'POST', {
        name: $('#w-name').value.trim(),
        workdir: $('#w-workdir').value.trim(),
        team,
      })
      toast(`已创建项目 ${d.project.name}`)
      $('#wizard').classList.add('hidden')
      await refreshProjects()
      await openProject(d.project.id)
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
}

async function openProject(pid) {
  current.pid = pid
  $('#project-select').value = pid
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
}

function renderTeam() {
  const ul = $('#team-list')
  ul.innerHTML = ''
  for (const m of current.team) {
    const li = document.createElement('li')
    li.textContent = `${m.displayName} [${m.instanceId}]${m.enabled ? '' : '（停用）'}`
    ul.appendChild(li)
  }
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
    const [a, m, ar, mem] = await Promise.all([
      api(`/projects/${current.pid}/approvals?status=pending`),
      api(`/projects/${current.pid}/meetings`),
      api(`/projects/${current.pid}/artifacts`),
      api(`/projects/${current.pid}/memories?scope=global`),
    ])
    current.approvals = a.approvals ?? []
    current.meetings = m.meetings ?? []
    current.artifacts = ar.artifacts ?? []
    renderApprovals()
    renderMeetings()
    renderArtifacts()
    renderMemories(mem.entries ?? [])
  } catch {
    /* 面板刷新失败不打扰 */
  }
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
