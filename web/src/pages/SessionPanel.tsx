import { Alert, Button, Card, Empty, Input, Popconfirm, Segmented, Space, Spin, Switch, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeError } from '../api/client'
import { approvalApi, type ApprovalView } from '../api/platform'
import { workApi, type QuestionRecord } from '../api/work'
import { sessionApi, type AgentStatus, type SessionSummary, type StoredEvent } from '../api/sessions'
import { useRealtime } from '../hooks/useRealtime'
import { RightColumn } from './RightColumn'
import { QuestionCarousel } from '../components/QuestionCarousel'
import { EventRowView } from '../components/EventRowView'
import { traceLine } from '../lib/event-display'
import { agentStateView } from '../lib/agent-state'
import { composerStatus } from '../lib/composer-status'
import { pendingForSession } from '../lib/session-pending'
import { isSending, withSending, withoutSending } from '../lib/sending'

interface SessionPanelProps {
  readonly projectId: string
  /** 拓扑页点节点带来的聚焦请求（S17）：进入会话页时自动选中该 Agent 的会话；`at` 用于区分重复点击 */
  readonly focus?: { readonly instanceId: string; readonly at: number } | null
}

/** 会话列表里的 Agent 状态文字与颜色（S19；S38/D41 起与拓扑/细条共用 `agentStateView`） */
function agentState(status: AgentStatus | undefined): { readonly text: string; readonly color: string } {
  return agentStateView(status)
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
/** 会话流显示的事件（S22/D28 去掉筛选；S44/D47 把 `plan` 加回来——计划是各步之间可见的分界） */
const VISIBLE_KINDS = ['message', 'thought', 'tool_call', 'tool_result', 'error', 'plan'] as const

/**
 * 会话面板（S3：会话 / 单工 / 队列 / WS 实时；S22：会话流只内联展示对话/思考/工具调用/错误）。
 */
export function SessionPanel({ projectId, focus = null }: SessionPanelProps) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  /** 当前会话 id 的"最新值"引用：给异步回调（发送/加载）判断"响应回来时还是不是同一个会话"（S46/D49） */
  const activeSessionRef = useRef<string | null>(null)
  activeSessionRef.current = activeSessionId
  const [events, setEvents] = useState<StoredEvent[]>([])
  const [statuses, setStatuses] = useState<AgentStatus[]>([])
  const [draft, setDraft] = useState('')
  /** S46/D49：发送中标记按**会话**记（给 A 发消息时 B 的发送按钮不受影响） */
  const [sending, setSending] = useState<readonly string[]>([])
  const busy = isSending(sending, activeSessionId)
  const [error, setError] = useState<string | null>(null)
  const [approvals, setApprovals] = useState<ApprovalView[]>([])
  /** 会话窗口视图（S35）：`chat` = 对话视图；`trace` = 详细日志（原始事件全量） */
  const [viewMode, setViewMode] = useState<'chat' | 'trace'>('chat')
  /** 详细日志里是否展开原始 payload JSON */
  const [showRawPayload, setShowRawPayload] = useState(false)
  /** 待答复询问（S32）：在本会话窗口（输入框上方）答复；逐题作答的草稿由 `QuestionCarousel` 自己管（S33） */
  const [questions, setQuestions] = useState<QuestionRecord[]>([])
  /** S42/D45：最近是否收到流式增量（`message.chunk`）——用于"模型正在输出" */
  const [streaming, setStreaming] = useState(false)
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

  /** 待答复询问（S32）：**在输入框上方就地答复**；右栏只做提示 */
  const refreshQuestions = useCallback(async () => {
    try {
      setQuestions(await workApi.questions(projectId, 'pending'))
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  const answerQuestion = async (
    question: QuestionRecord,
    answers: readonly { readonly itemId: string; readonly choice?: string | null; readonly text?: string | null }[],
  ): Promise<void> => {
    try {
      await workApi.answer(projectId, question.id, answers)
      message.success('已答复，Agent 将继续')
      await refreshQuestions()
      if (activeSessionId !== null) await loadEvents(activeSessionId)
      await refreshStatuses()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

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
        // S46/D49：期间用户可能切到别的会话——迟到的响应不能把当前会话的事件流覆盖掉
        if (activeSessionRef.current !== sessionId) return
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
    void refreshQuestions()
  }, [loadSessions, refreshStatuses, refreshApprovals, refreshQuestions])

  useEffect(() => {
    if (activeSessionId !== null) void loadEvents(activeSessionId)
    // S42/D45：切会话时把"正在输出"重置（上一个会话的流式增量与本会话无关）
    setStreaming(false)
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
          // 有事件落盘 = 这一轮调用已经结束（或进了下一步工具），不再是"正在吐字"
          setStreaming(false)
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
        // S42/D45：模型正在流式输出（平台本来就推 message.chunk，此前没人消费）
        if (frame.type === 'message.chunk' && frame.payload['sessionId'] === activeSessionId) {
          setStreaming(true)
        }
        // S38/D41：询问/审批一到就刷新状态——"进入等待"没有 agent.state 帧（帧由 dispatcher 发），
        // 原先只认 agent.state，于是 Agent 明明在等答复，左栏还挂着上一个「工作中」
        if (
          frame.type === 'agent.state' ||
          frame.type === 'team.updated' ||
          frame.type === 'question.asked' ||
          frame.type === 'question.answered' ||
          frame.type === 'approval.requested' ||
          frame.type === 'approval.decided'
        ) {
          void refreshStatuses()
        }
        if (frame.type === 'approval.requested' || frame.type === 'approval.decided') void refreshApprovals()
        if (frame.type === 'question.asked' || frame.type === 'question.answered') void refreshQuestions()
      },
      [activeSessionId, projectId, refreshStatuses, refreshApprovals, refreshQuestions],
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

  /** 只显示**当前会话**的待答询问（S32：答复入口在会话窗口内） */
  const sessionQuestions = useMemo(
    () => pendingForSession(questions, activeSessionId),
    [questions, activeSessionId],
  )

  /**
   * S45/D48：审批卡也只显示**当前会话**的（原先渲染项目全量 → A 角色的审批会出现在 B 角色的窗口里）。
   * 项目级视角仍在右栏「审批」列表。
   */
  const sessionApprovals = useMemo(
    () => pendingForSession(approvals, activeSessionId),
    [approvals, activeSessionId],
  )

  /** 申请者显示名（会话列表/状态投影同源；查不到就退回 instanceId） */
  const nameOf = useCallback(
    (instanceId: string): string =>
      sessions.find((session) => session.instanceId === instanceId)?.displayName ??
      statuses.find((status) => status.instanceId === instanceId)?.displayName ??
      instanceId,
    [sessions, statuses],
  )

  /** S42/D45：输入框上方"现在在干什么"——状态投影 + 事件尾巴 + 流式增量三者合成 */
  const composer = useMemo(
    () =>
      composerStatus({
        status: activeStatus,
        events,
        streaming,
        hasPendingQuestion: sessionQuestions.length > 0,
      }),
    [activeStatus, events, streaming, sessionQuestions.length],
  )

  /**
   * 消息区滚动跟随（S34）：默认**跟住最后一条消息**；用户手动往上翻时不打扰，
   * 一旦回到底部附近就恢复跟随（阈值 40px）。
   */
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [stickToBottom, setStickToBottom] = useState(true)

  const onScroll = useCallback(() => {
    const node = scrollRef.current
    if (node === null) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    setStickToBottom(distance < 40)
  }, [])

  const send = async (): Promise<void> => {
    if (activeSessionId === null) return
    const sessionId = activeSessionId
    // S46/D49：发送中标记**按会话**记——给 A 发消息不该让 B 的发送按钮也转圈（会话相互独立）
    if (busy) return
    const text = draft.trim()
    if (text.length === 0) return

    // S31：**立刻清空输入框**（乐观）。
    // 为什么不能等接口返回再清：`POST /messages` 在服务端会 `await drain(...)`，
    // 即**整个回合跑完才响应**（模型调用 + 工具，可能几十秒）——等它返回再清空，
    // 输入框会在整轮期间一直留着刚发出去的文字，发送按钮也一直转圈。
    setDraft('')
    setSending((previous) => withSending(previous, sessionId))
    try {
      const result = await sessionApi.send(projectId, sessionId, text)
      if (result.queued) {
        message.info('该 Agent 正在工作或已暂停，消息已排队，稍后处理')
      }
      await loadEvents(sessionId)
      await refreshStatuses()
    } catch (cause) {
      // 只有发送失败才把文字放回去；期间用户若已重新输入，则不覆盖他的新内容
      setDraft((current) => (current.length === 0 ? text : current))
      message.error(describeError(cause))
    } finally {
      setSending((previous) => withoutSending(previous, sessionId))
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

  /** S34：新内容到达时**跟住最后一条消息**；S35：切换视图/展开 payload 时也要跟随 */
  useEffect(() => {
    const node = scrollRef.current
    if (node === null || !stickToBottom) return
    node.scrollTop = node.scrollHeight
  }, [events, visibleEvents, viewMode, showRawPayload, stickToBottom])

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
          // S34：会话卡片**占满视口剩余高度**（自己成为 flex 列），消息区随屏幕伸缩、输入框钉在底部
          style={{ flex: 1, display: 'flex', flexDirection: 'column', height: 'calc(100vh - 270px)', minHeight: 360 }}
          styles={{ body: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } }}
          title={
            activeSession === undefined ? (
              '会话'
            ) : (
              <Space size={8} wrap>
                <span>{`${activeSession.displayName}｜${activeSession.sessionId}`}</span>
                {/* S51/D54：领取后就地显示"正在执行的任务"（用户口径：会话顶部显示当前任务） */}
                {activeStatus?.currentTask != null && (
                  <Tooltip title={`任务 ${activeStatus.currentTask.id}｜${activeStatus.currentTask.state}`}>
                    <Tag color="blue" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      正在执行：{activeStatus.currentTask.title}
                    </Tag>
                  </Tooltip>
                )}
              </Space>
            )
          }
          extra={
            <Space>
              {/* S35：对话 / 详细日志（trace）切换；详细日志可再展开原始 payload */}
              <Segmented
                size="small"
                value={viewMode}
                onChange={(value) => setViewMode(value as 'chat' | 'trace')}
                options={[
                  { label: '对话', value: 'chat' },
                  { label: '详细日志', value: 'trace' },
                ]}
              />
              {viewMode === 'trace' && (
                <Tooltip title="每行附加完整 payload（原始 JSON）">
                  <Switch size="small" checked={showRawPayload} onChange={setShowRawPayload} />
                </Tooltip>
              )}
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
                description={
                  activeStatus?.paused === true
                    ? '将立刻补处理排队消息'
                    : // S49/D52：暂停不再中途切断模型调用——当前这一轮 loop 跑完即停止
                      '不再领新任务；当前这一轮 loop 跑完就停止生成，之后点「恢复」继续'
                }
                onConfirm={() => void togglePause()}
              >
                <Button size="small" danger={activeStatus?.paused !== true}>
                  {activeStatus?.paused === true ? '恢复' : '暂停'}
                </Button>
              </Popconfirm>
            </Space>
          }
        >
          {/* S20：消息区随视口自适应；S34：改为 flex 撑满卡片剩余高度 + **自动跟随最后一条消息** */}
          <div
            ref={scrollRef}
            onScroll={onScroll}
            style={{ flex: 1, minHeight: 200, overflowY: 'auto', paddingRight: 8 }}
          >
            {/* S35：详细日志视图——原始事件全量（含 plan/turn/state/summary/artifact/approval），可展开 payload */}
            {viewMode === 'trace' ? (
              events.length === 0 ? (
                <Empty description="该会话还没有事件" />
              ) : (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {events.map((event) => {
                    const line = traceLine(event)
                    return (
                      <div key={event.seq} style={{ border: '1px solid #f0f0f0', background: '#fafafa', borderRadius: 6, padding: '4px 8px' }}>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {line.head}
                        </Typography.Text>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{line.text}</div>
                        {showRawPayload && (
                          <pre style={{ margin: '4px 0 0', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        )}
                      </div>
                    )
                  })}
                </Space>
              )
            ) : visibleEvents.length === 0 ? (
              <Empty description="还没有内容：在下面输入框说点什么" />
            ) : (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {visibleEvents.map((event) => (
                <EventRowView key={event.seq} event={event} />
              ))}
            </Space>
            )}
          </div>
          {sessionApprovals.length > 0 && (
            <Card size="small" title={`待审批（${sessionApprovals.length}）`} style={{ marginTop: 12 }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {sessionApprovals.map((approval) => (
                  <div key={approval.id} style={{ border: '1px solid #ffe58f', background: '#fffbe6', borderRadius: 6, padding: 8 }}>
                    <Space size={6} wrap>
                      <Tag color="orange">{approval.kind}</Tag>
                      <Typography.Text strong>{approval.summary}</Typography.Text>
                      {/* S45/D48：是"谁"申请的（显示名，而不是 instanceId） */}
                      <Typography.Text type="secondary">申请者 {nameOf(approval.actor)}</Typography.Text>
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
          {/* S32：询问卡在**输入框上方**就地答复；S33：一次一题、卡片左右滑动、攒齐提交；右栏只做提示 */}
          {sessionQuestions.length > 0 && (
            <Card size="small" title={`待答复询问（${sessionQuestions.length}）`} style={{ marginTop: 12 }}>
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                {sessionQuestions.map((question) => (
                  <QuestionCarousel
                    key={question.id}
                    question={question}
                    onSubmit={(answers) => answerQuestion(question, answers)}
                  />
                ))}
              </Space>
            </Card>
          )}
          {/* S42/D45：输入框上方一句话说清"现在在干什么"（调工具 / 模型在跑 / 等你答复 / 排队） */}
          {composer !== null && (
            <Space size={6} style={{ marginTop: 12 }}>
              {composer.spinner && <Spin size="small" />}
              <Typography.Text
                type={composer.tone === 'waiting' ? 'warning' : 'secondary'}
                style={{ fontSize: 12 }}
              >
                {composer.text}
              </Typography.Text>
            </Space>
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
              状态：{agentState(activeStatus).text}｜排队 {activeStatus.queued} 条｜会话进度 #
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
            <RightColumn projectId={projectId} onOpenSession={(sessionId) => setActiveSessionId(sessionId)} />
          </div>
        )}
      </div>
    </Space>
  )
}
