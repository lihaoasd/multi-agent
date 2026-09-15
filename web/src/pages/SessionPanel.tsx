import { Alert, Badge, Button, Card, Collapse, Empty, Input, Popconfirm, Select, Space, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { describeError } from '../api/client'
import { approvalApi, type ApprovalView } from '../api/platform'
import { sessionApi, type AgentStatus, type SessionSummary, type StoredEvent } from '../api/sessions'
import { useRealtime } from '../hooks/useRealtime'
import { RightColumn } from './RightColumn'

interface SessionPanelProps {
  readonly projectId: string
}

function eventText(event: StoredEvent): string {
  const payload = event.payload
  if (event.kind === 'message') {
    const text = typeof payload['text'] === 'string' ? payload['text'] : undefined
    if (text !== undefined) return text
    const content = payload['content']
    if (typeof content === 'object' && content !== null) {
      const value = (content as Record<string, unknown>)['text']
      if (typeof value === 'string') return value
    }
    return '（空消息）'
  }
  if (typeof payload['text'] === 'string') return payload['text']
  if (typeof payload['message'] === 'string') return payload['message']
  return JSON.stringify(payload)
}

function isChatEvent(event: StoredEvent): boolean {
  return event.kind === 'message'
}

/**
 * 会话面板（S3：会话 / 单工 / 队列 / WS 实时）。
 * 完整三栏工作台（工作日志折叠、右栏三列表）在 S7 交付；这里先把"能对话、能看见事件与状态"跑通。
 */
export function SessionPanel({ projectId }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [statuses, setStatuses] = useState<AgentStatus[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** 事件 kind 过滤（ui.md §4：仅看对话 / 显示全部事件 / 指定 kind） */
  const [kindFilter, setKindFilter] = useState<'message' | 'all' | string>('message')
  const [approvals, setApprovals] = useState<ApprovalView[]>([])

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
    () =>
      kindFilter === 'all'
        ? events
        : events.filter((event) => (kindFilter === 'message' ? isChatEvent(event) : event.kind === kindFilter)),
    [events, kindFilter],
  )

  /** 工作日志折叠：把连续的"非对话事件"合成一张可展开卡片（默认折叠，ui.md §4） */
  const stream = useMemo(() => {
    const groups: (
      | { readonly kind: 'message'; readonly event: StoredEvent }
      | { readonly kind: 'log'; readonly key: string; readonly events: readonly StoredEvent[] }
    )[] = []
    let buffer: StoredEvent[] = []
    const flush = (): void => {
      if (buffer.length === 0) return
      groups.push({ kind: 'log', key: `log-${buffer[0]?.seq ?? 0}`, events: buffer })
      buffer = []
    }
    for (const event of visibleEvents) {
      if (isChatEvent(event)) {
        flush()
        groups.push({ kind: 'message', event })
      } else {
        buffer.push(event)
      }
    }
    flush()
    return groups
  }, [visibleEvents])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Alert
        type={realtime.connected ? 'success' : 'warning'}
        showIcon
        message={realtime.connected ? '实时通道已连接（事件先落盘后推送）' : '实时通道未连接，正在重试…'}
        description="回复由真实 agent loop 生成（S4 起）：工作日志默认折叠，可用右上角过滤按 kind 查看；右栏三列表实时刷新。"
      />
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <Card size="small" title="会话（每个 Agent 一个）" style={{ width: 280, flex: '0 0 280px' }}>
          {sessions.length === 0 && <Empty description="暂无会话" />}
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {sessions.map((session) => {
              const status = statuses.find((item) => item.sessionId === session.sessionId)
              const active = session.sessionId === activeSessionId
              return (
                <Button
                  key={session.sessionId}
                  type={active ? 'primary' : 'text'}
                  block
                  style={{ textAlign: 'left', height: 'auto', padding: '6px 8px' }}
                  onClick={() => setActiveSessionId(session.sessionId)}
                >
                  <Space size={6} wrap>
                    <Badge
                      status={status?.state === 'working' ? 'processing' : status?.paused ? 'warning' : 'default'}
                      text={session.displayName}
                    />
                    {session.state === 'archived' && <Tag>已归档</Tag>}
                    {(status?.queued ?? 0) > 0 && <Tag color="orange">排队 {status?.queued}</Tag>}
                  </Space>
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {session.lastMessagePreview ?? '（暂无消息）'}
                    </Typography.Text>
                  </div>
                </Button>
              )
            })}
          </Space>
        </Card>

        <Card
          size="small"
          style={{ flex: 1 }}
          title={
            activeSession === undefined ? '会话' : `${activeSession.displayName}｜${activeSession.sessionId}`
          }
          extra={
            <Space>
              <Select
                size="small"
                style={{ width: 150 }}
                value={kindFilter}
                onChange={(value: string) => setKindFilter(value)}
                options={[
                  { value: 'message', label: '仅看对话' },
                  { value: 'all', label: '显示全部事件（折叠）' },
                  { value: 'thought', label: '思考 thought' },
                  { value: 'plan', label: '计划 plan' },
                  { value: 'tool_call', label: '工具调用 tool_call' },
                  { value: 'tool_result', label: '工具结果 tool_result' },
                  { value: 'summary', label: '摘要 summary' },
                  { value: 'turn_start', label: '回合边界' },
                  { value: 'error', label: '错误 error' },
                ]}
              />
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
            </Space>
          }
        >
          <div style={{ maxHeight: 420, overflowY: 'auto', paddingRight: 8 }}>
            {visibleEvents.length === 0 && <Empty description="还没有消息：在下面输入框说点什么" />}
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {stream.map((item) => {
                if (item.kind === 'log') {
                  return (
                    <Collapse
                      key={item.key}
                      size="small"
                      items={[
                        {
                          key: item.key,
                          label: `工作日志 · ${item.events.length} 条（${[...new Set(item.events.map((event) => event.kind))].join('/')}）`,
                          children: (
                            <Space direction="vertical" size={4} style={{ width: '100%' }}>
                              {item.events.map((event) => (
                                <div key={event.seq} style={{ background: '#fafafa', borderRadius: 6, padding: '4px 8px' }}>
                                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                    #{event.seq} · {event.kind} · turn {event.turn}
                                  </Typography.Text>
                                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{eventText(event)}</div>
                                </div>
                              ))}
                            </Space>
                          ),
                        },
                      ]}
                    />
                  )
                }
                const event = item.event
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
                      <div>{eventText(event)}</div>
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

        <div style={{ width: 340, flex: '0 0 340px' }}>
          <RightColumn projectId={projectId} />
        </div>
      </div>
    </Space>
  )
}
