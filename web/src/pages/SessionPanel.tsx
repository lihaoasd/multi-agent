import { Alert, Button, Card, Collapse, Empty, Input, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../api/client'
import { approvalApi, type ApprovalView } from '../api/platform'
import { sessionApi, type AgentStatus, type SessionSummary, type StoredEvent } from '../api/sessions'
import { useRealtime } from '../hooks/useRealtime'
import { RightColumn } from './RightColumn'
import { Markdown } from '../components/Markdown'
import { eventRow, isToolFailed, messageTextOf } from '../lib/event-display'
import { runtimeApi } from '../api/runtime'

interface SessionPanelProps {
  readonly projectId: string
  /** 拓扑页点节点带来的聚焦请求（S17）：进入会话页时自动选中该 Agent 的会话；`at` 用于区分重复点击 */
  readonly focus?: { readonly instanceId: string; readonly at: number } | null
}

/** 会话列表里的 Agent 状态文字与颜色（S19；`paused` 叠加显示为「已暂停」） */
const AGENT_STATE_LABEL: Record<string, string> = { idle: '空闲', working: '工作中', waiting: '等待中' }
const AGENT_STATE_COLOR: Record<string, string> = { idle: 'default', working: 'blue', waiting: 'orange' }

function agentState(status: AgentStatus | undefined): { readonly text: string; readonly color: string } {
  if (status?.paused === true) return { text: '已暂停', color: 'purple' }
  const state = status?.state ?? 'idle'
  return { text: AGENT_STATE_LABEL[state] ?? state, color: AGENT_STATE_COLOR[state] ?? 'default' }
}

/** 左右两栏的收起状态（S20）：单机单用户，落 localStorage 记忆；读写异常只影响记忆，不影响功能 */
const COLLAPSE_KEY = 'agent-haness.session-panel-collapsed'

interface CollapsedState {
  readonly left: boolean
  readonly right: boolean
}

function readCollapsed(): CollapsedState {
  try {
    const raw = window.localStorage.getItem(COLLAPSE_KEY)
    if (raw === null) return { left: false, right: false }
    const parsed = JSON.parse(raw) as Partial<CollapsedState>
    return { left: parsed.left === true, right: parsed.right === true }
  } catch {
    return { left: false, right: false }
  }
}

function writeCollapsed(value: CollapsedState): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(value))
  } catch {
    // 隐私模式/配额异常：忽略，只影响跨页记忆
  }
}

/**
 * 会话流展示的事件类别（S22）：对话 + 思考 + 工具调用（含结果）+ 错误；不再有筛选与"工作日志"折叠包装。
 * 事件→文本的映射在 `lib/event-display.ts`（纯函数，带单测；S24 修复字段名不一致导致的"工具不显示"）。
 */
const VISIBLE_KINDS = ['message', 'thought', 'tool_call', 'tool_result', 'error'] as const

/**
 * 会话面板（S3：会话 / 单工 / 队列 / WS 实时；S22：会话流只内联展示对话/思考/工具调用/错误）。
 */
export function SessionPanel({ projectId, focus = null }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [statuses, setStatuses] = useState<AgentStatus[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<ApprovalView[]>([])
  /** 已应用过的聚焦令牌（S17）：只在匹配到目标会话时记录，避免会话列表刷新时覆盖用户的手动选择 */
  const appliedFocusRef = useRef<number | null>(null)
  /** 左右两栏收起状态（S20）：收起后把宽度让给聊天区 */
  const [collapsed, setCollapsed] = useState<CollapsedState>(readCollapsed)

  const toggleCollapsed = (side: 'left' | 'right'): void => {
    setCollapsed((previous) => {
      const next: CollapsedState = { ...previous, [side]: !previous[side] }
      writeCollapsed(next)
      return next
    })
  }

  const refreshApprovals = useCallback(async () => {
    try {
      setApprovals(await approvalApi.list(projectId, 'pending'))
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  const decide = async (approval: ApprovalView, decision: 'approved' | 'rejected'): Promise<void> => {
    try {
      await approvalApi.decide(projectId, approval.id, decision, decision === 'rejected' ? '用户在会话面板拒绝' : undefined)
      message.success(decision === 'approved' ? '已批准，Agent 将继续执行' : '已拒绝，Agent 将调整方案')
      await refreshApprovals()
      await refreshStatuses()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const refreshStatuses = useCallback(async () => {
    try {
      setStatuses(await sessionApi.status(projectId))
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  const loadSessions = useCallback(async () => {
    try {
      const list = await sessionApi.list(projectId)
      setSessions(list)
      setActiveSessionId((current) => current ?? list[0]?.sessionId ?? null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  const loadEvents = useCallback(
    async (sessionId: string) => {
      try {
        const detail = await sessionApi.detail(projectId, sessionId, 200)
        setEvents(detail.events)
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [projectId],
  )

  useEffect(() => {
    void loadSessions()
    void refreshStatuses()
    void refreshApprovals()
  }, [loadSessions, refreshStatuses, refreshApprovals])

  useEffect(() => {
    if (activeSessionId !== null) void loadEvents(activeSessionId)
  }, [activeSessionId, loadEvents])

  // 拓扑页点节点带来的聚焦（S17）：按 instanceId 选中对应会话；未加载到该会话时等下一次列表更新再试
  useEffect(() => {
    if (focus === null) return
    if (appliedFocusRef.current === focus.at) return
    const target = sessions.find((session) => session.instanceId === focus.instanceId)
    if (target === undefined) return
    appliedFocusRef.current = focus.at
    setActiveSessionId(target.sessionId)
  }, [focus, sessions])

  // WS：只订阅当前项目的帧；收到本会话事件就增量拉取（简单可靠，避免前端去重逻辑）
  const realtime = useRealtime(
    projectId,
    useCallback(
      (frame) => {
        if (frame.type === 'event.appended' && frame.payload['sessionId'] === activeSessionId) {
          const seq = Number(frame.payload['seq'])
          void sessionApi
            .log(projectId, String(activeSessionId), { fromSeq: seq })
            .then((delta) => {
              setEvents((previous) => {
                const known = new Set(previous.map((event) => event.seq))
                const fresh = delta.filter((event) => !known.has(event.seq))
                return fresh.length === 0 ? previous : [...previous, ...fresh].sort((a, b) => a.seq - b.seq)
              })
            })
            .catch(() => undefined)
        }
        if (frame.type === 'agent.state' || frame.type === 'team.updated') void refreshStatuses()
        if (frame.type === 'approval.requested' || frame.type === 'approval.decided') void refreshApprovals()
      },
      [activeSessionId, projectId, refreshStatuses, refreshApprovals],
    ),
  )

  const activeStatus = useMemo(
    () => statuses.find((status) => status.sessionId === activeSessionId),
    [statuses, activeSessionId],
  )

  const activeSession = useMemo(
    () => sessions.find((session) => session.sessionId === activeSessionId),
    [sessions, activeSessionId],
  )

  const send = async (): Promise<void> => {
    if (activeSessionId === null) return
    const text = draft.trim()
    if (text.length === 0) return
    setBusy(true)
    try {
      const result = await sessionApi.send(projectId, activeSessionId, text)
      setDraft('')
      if (result.queued) {
        message.info('该 Agent 正在工作或已暂停，消息已排队，稍后处理')
      }
      await loadEvents(activeSessionId)
      await refreshStatuses()
    } catch (cause) {
      message.error(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const togglePause = async (): Promise<void> => {
    if (activeSession === undefined) return
    try {
      if (activeStatus?.paused === true) {
        const result = await sessionApi.resume(projectId, activeSession.instanceId)
        message.success(`已恢复，补处理 ${result.handled} 条排队消息`)
      } else {
        await sessionApi.pause(projectId, activeSession.instanceId)
        message.success('已暂停：不再领新任务（当前回合到可中断点挂起）')
      }
      await refreshStatuses()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const visibleEvents = useMemo(
    () => events.filter((event) => (VISIBLE_KINDS as readonly string[]).includes(event.kind)),
    [events],
  )

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      {/* 连接正常不提示（S16 用户口径）：只保留"坏消息"——断开/重连中才出现，避免常驻占版面 */}
      {!realtime.connected && <Alert type="warning" showIcon message="实时通道未连接，正在重试…" />}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        {collapsed.left ? (
          <Tooltip title="展开会话列表" placement="right">
            <Button
              size="small"
              type="text"
              onClick={() => toggleCollapsed('left')}
              style={{ flex: '0 0 auto', height: 'auto', padding: '8px 6px', writingMode: 'vertical-rl' }}
            >
              会话列表 ›
            </Button>
          </Tooltip>
        ) : (
          <Card
            size="small"
            title="会话（每个 Agent 一个）"
            style={{ width: 280, flex: '0 0 280px' }}
            extra={
              <Tooltip title="收起会话列表（把宽度让给聊天区）">
                <Button size="small" type="text" onClick={() => toggleCollapsed('left')}>
                  ‹ 收起
                </Button>
              </Tooltip>
            }
          >
            {sessions.length === 0 && <Empty description="暂无会话" />}
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              {sessions.map((session) => {
                const status = statuses.find((item) => item.sessionId === session.sessionId)
                const active = session.sessionId === activeSessionId
                const state = agentState(status)
                return (
                  <Button
                    key={session.sessionId}
                    type={active ? 'default' : 'text'}
                    block
                    style={{
                      textAlign: 'left',
                      height: 'auto',
                      padding: '6px 8px',
                      background: active ? '#e6f4ff' : undefined,
                      borderColor: active ? '#91caff' : undefined,
                    }}
                    onClick={() => setActiveSessionId(session.sessionId)}
                  >
                    {/* S19：只显示 Agent 名称与状态（不再显示最后一条消息/任务文本与排队数） */}
                    <Space size={6} wrap>
                      <Typography.Text strong>{session.displayName}</Typography.Text>
                      <Tag color={state.color}>{state.text}</Tag>
                      {session.state === 'archived' && <Tag>已归档</Tag>}
                    </Space>
                  </Button>
                )
              })}
            </Space>
          </Card>
        )}

        <Card
          size="small"
          style={{ flex: 1 }}
          title={
            activeSession === undefined ? '会话' : `${activeSession.displayName}｜${activeSession.sessionId}`
          }
          extra={
            <Space>
              <Popconfirm
                title="开启新对话？"
                description="清空该 Agent 的全部历史消息，重新开始。"
                onConfirm={async () => {
                  if (activeSessionId === null) return
                  try {
                    await sessionApi.reset(projectId, activeSessionId)
                    message.success('已开启新对话')
                    setEvents([])
                    await loadSessions()
                  } catch (cause) {
                    message.error(describeError(cause))
                  }
                }}
              >
                <Button size="small">新对话</Button>
              </Popconfirm>
              <Button size="small" onClick={() => activeSessionId !== null && void loadEvents(activeSessionId)}>
                刷新
              </Button>
              <Popconfirm
                title={activeStatus?.paused === true ? '恢复该 Agent？' : '暂停该 Agent？'}
                description={activeStatus?.paused === true ? '将立刻补处理排队消息' : '不再领新任务，当前回合到可中断点挂起'}
                onConfirm={() => void togglePause()}
              >
                <Button size="small" danger={activeStatus?.paused !== true}>
                  {activeStatus?.paused === true ? '恢复' : '暂停'}
                </Button>
              </Popconfirm>
              <Popconfirm
                title="停止生成？"
                description="停止当前回合的输出；队列中的消息保留，任务不受影响。"
                onConfirm={() =>
                  void runtimeApi
                    .stop(projectId, activeSession?.instanceId ?? '', 'turn')
                    .then(() => message.success('已请求停止当前回合'))
                    .catch((cause: unknown) => message.error(describeError(cause)))
                }
              >
                <Button size="small">停止生成</Button>
              </Popconfirm>
            </Space>
          }
        >
          {/* 消息区高度自适应视口（S20）：原来写死 420px，1080p 屏上白白浪费约 500px */}
          <div style={{ maxHeight: 'calc(100vh - 350px)', minHeight: 300, overflowY: 'auto', paddingRight: 8 }}>
            {visibleEvents.length === 0 && <Empty description="还没有内容：在下面输入框说点什么" />}
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {visibleEvents.map((event) => {
                if (event.kind === 'message') {
                  const role = String(event.payload['role'] ?? '')
                  const align = role === 'user' ? 'flex-end' : 'flex-start'
                  const background = role === 'user' ? '#e6f4ff' : '#f6ffed'
                  return (
                    <div key={event.seq} style={{ display: 'flex', justifyContent: align }}>
                      <div
                        style={{
                          background,
                          borderRadius: 6,
                          padding: '6px 10px',
                          maxWidth: '80%',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          #{event.seq} · {event.kind}
                          {role.length > 0 ? ` · ${role}` : ''} · turn {event.turn}
                        </Typography.Text>
                        {/* S23：对话消息按 Markdown 渲染（自研零依赖，不注入 HTML） */}
                        <Markdown text={messageTextOf(event)} />
                      </div>
                    </div>
                  )
                }
                // S22：思考 / 工具调用 / 工具结果 / 错误直接内联展示（不再折叠成"工作日志"）
                // S24：字段名与生产者 strategies.ts 对齐；S26：工具结果条目只显示工具名（正文与序号不显示）
                const failed = isToolFailed(event)
                const row = eventRow(event)
                const tone =
                  event.kind === 'error' || failed
                    ? { background: '#fff2f0', border: '1px solid #ffccc7' }
                    : event.kind === 'tool_call'
                      ? { background: '#f0f5ff', border: '1px solid #d6e4ff' }
                      : { background: '#fafafa', border: '1px solid #f0f0f0' }
                return (
                  <div key={event.seq} style={{ display: 'flex', justifyContent: 'flex-start' }}>
                    <div
                      style={{
                        ...tone,
                        borderRadius: 6,
                        padding: '4px 8px',
                        maxWidth: '85%',
                        whiteSpace: 'pre-wrap',
                        fontSize: 12,
                      }}
                    >
                      {row.showMeta ? (
                        row.bodyMode === 'collapsed' ? (
                          // S28：工具调用参数默认折叠（点标题展开看参数结构）
                          <Collapse
                            ghost
                            size="small"
                            style={{ background: 'transparent' }}
                            items={[
                              {
                                key: String(event.seq),
                                label: (
                                  <Typography.Text style={{ fontSize: 12 }}>
                                    {row.label} · #{event.seq} · turn {event.turn}
                                  </Typography.Text>
                                ),
                                children: (
                                  <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                    {row.body}
                                  </pre>
                                ),
                              },
                            ]}
                          />
                        ) : (
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {row.label} · #{event.seq} · turn {event.turn}
                          </Typography.Text>
                        )
                      ) : (
                        <span style={{ fontWeight: failed ? 600 : 400 }}>{row.label}</span>
                      )}
                      {row.body !== null && row.bodyMode === 'inline' && (
                        <div style={{ whiteSpace: 'pre-wrap' }}>{row.body}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </Space>
          </div>
          {approvals.length > 0 && (
            <Card size="small" title={`待审批（${approvals.length}）`} style={{ marginTop: 12 }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {approvals.map((approval) => (
                  <div key={approval.id} style={{ border: '1px solid #ffe58f', background: '#fffbe6', borderRadius: 6, padding: 8 }}>
                    <Space size={6} wrap>
                      <Tag color="orange">{approval.kind}</Tag>
                      <Typography.Text strong>{approval.summary}</Typography.Text>
                      <Typography.Text type="secondary">触发者 {approval.actor}</Typography.Text>
                    </Space>
                    <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 4 }}>{approval.detail}</div>
                    <Space size={6} style={{ marginTop: 6 }}>
                      <Button size="small" type="primary" onClick={() => void decide(approval, 'approved')}>
                        批准
                      </Button>
                      <Button size="small" danger onClick={() => void decide(approval, 'rejected')}>
                        拒绝
                      </Button>
                    </Space>
                  </div>
                ))}
              </Space>
            </Card>
          )}
          <Space.Compact style={{ width: '100%', marginTop: 12 }}>
            <Input.TextArea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="发送即让该 Agent 开工（忙时自动排队）"
              autoSize={{ minRows: 1, maxRows: 4 }}
              onPressEnter={(event) => {
                if (!event.shiftKey) {
                  event.preventDefault()
                  void send()
                }
              }}
            />
            <Button type="primary" loading={busy} onClick={() => void send()} disabled={activeSession?.state === 'archived'}>
              发送
            </Button>
          </Space.Compact>
          {activeStatus !== undefined && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              状态：{activeStatus.state}
              {activeStatus.paused ? '（已暂停）' : ''}｜排队 {activeStatus.queued} 条｜会话进度 #
              {activeSession?.lastSeq ?? 0}
            </Typography.Text>
          )}
        </Card>

        {collapsed.right ? (
          <Tooltip title="展开右栏（任务 / 询问 / 审批）" placement="left">
            <Button
              size="small"
              type="text"
              onClick={() => toggleCollapsed('right')}
              style={{ flex: '0 0 auto', height: 'auto', padding: '8px 6px', writingMode: 'vertical-rl' }}
            >
              ‹ 任务·询问·审批
            </Button>
          </Tooltip>
        ) : (
          <div style={{ width: 340, flex: '0 0 340px' }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
              <Tooltip title="收起右栏（把宽度让给聊天区）">
                <Button size="small" type="text" onClick={() => toggleCollapsed('right')}>
                  收起 ›
                </Button>
              </Tooltip>
            </div>
            <RightColumn projectId={projectId} />
          </div>
        )}
      </div>
    </Space>
  )
}
