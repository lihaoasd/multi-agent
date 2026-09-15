import { Alert, Badge, Button, Card, Empty, Input, Popconfirm, Space, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { describeError } from '../api/client'
import { sessionApi, type AgentStatus, type SessionSummary, type StoredEvent } from '../api/sessions'
import { useRealtime } from '../hooks/useRealtime'

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
  const [showAllKinds, setShowAllKinds] = useState(true)

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
  }, [loadSessions, refreshStatuses])

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
      },
      [activeSessionId, projectId, refreshStatuses],
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

  const visibleEvents = showAllKinds ? events : events.filter(isChatEvent)

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Alert
        type={realtime.connected ? 'success' : 'warning'}
        showIcon
        message={realtime.connected ? '实时通道已连接（事件先落盘后推送）' : '实时通道未连接，正在重试…'}
        description="当前为 S3 阶段：回复由占位回合执行器生成，S4 接入真实 agent loop 后会替换为模型输出。"
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
              <Button size="small" onClick={() => setShowAllKinds((value) => !value)}>
                {showAllKinds ? '仅看对话' : '显示全部事件'}
              </Button>
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
              {visibleEvents.map((event) => {
                const role = String(event.payload['role'] ?? '')
                const align = role === 'user' ? 'flex-end' : 'flex-start'
                const background = role === 'user' ? '#e6f4ff' : isChatEvent(event) ? '#f6ffed' : '#fafafa'
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
      </div>
    </Space>
  )
}
