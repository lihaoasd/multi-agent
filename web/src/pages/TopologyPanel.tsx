import { Alert, Button, Card, Empty, Popconfirm, Select, Space, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useRef, useState } from 'react'
import { describeError } from '../api/client'
import { orchestrationApi, type OrchestrationEdge, type OrchestrationGraph, type OrchestrationNode } from '../api/orchestration'
import { projectApi, type InstanceView } from '../api/projects'
import { sessionApi, type AgentStatus } from '../api/sessions'
import { RightColumn } from './RightColumn'
import { useRealtime } from '../hooks/useRealtime'

const CARD_W = 190
const CARD_H = 84
const STATE_LABEL: Record<string, string> = { idle: '空闲', working: '工作中', waiting: '等待中' }

interface TopologyPanelProps {
  readonly projectId: string
  readonly onOpenSession?: (instanceId: string) => void
}

/**
 * 项目页 · 拓扑导航（ui.md §3；2 栏：左画布 + 右三列表）。
 * 画布为**自研轻量 SVG 画布**（无新增依赖）：卡片可拖拽移动、"连线模式"下点击两个节点建边、
 * 选中边可删除；保存为全量提交（带 `version`，冲突提示刷新重试）。
 * 设计候选 React Flow 属 P1 选型；本轮以零依赖实现同样的编辑/保存语义（实现口径已回写 ui.md）。
 */
export function TopologyPanel({ projectId, onOpenSession }: TopologyPanelProps) {
  const [graph, setGraph] = useState<OrchestrationGraph | null>(null)
  const [nodes, setNodes] = useState<OrchestrationNode[]>([])
  const [edges, setEdges] = useState<{ id?: string; from: string; to: string }[]>([])
  const [members, setMembers] = useState<InstanceView[]>([])
  const [statuses, setStatuses] = useState<AgentStatus[]>([])
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null)
  const dragRef = useRef<{ instanceId: string; offsetX: number; offsetY: number } | null>(null)

  const load = useCallback(async () => {
    try {
      const [loaded, team, agentStatuses] = await Promise.all([
        orchestrationApi.get(projectId),
        projectApi.listTeam(projectId),
        sessionApi.status(projectId),
      ])
      setGraph(loaded)
      setNodes([...loaded.nodes])
      setEdges(loaded.edges.map((edge: OrchestrationEdge) => ({ id: edge.id, from: edge.from, to: edge.to })))
      setMembers(team)
      setStatuses(agentStatuses)
      setDirty(false)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  useRealtime(
    projectId,
    useCallback(
      (frame: { type: string }) => {
        if (frame.type === 'agent.state') {
          void sessionApi.status(projectId).then(setStatuses).catch(() => undefined)
        }
      },
      [projectId],
    ),
  )

  const save = async (): Promise<void> => {
    if (graph === null) return
    setBusy(true)
    try {
      const saved = await orchestrationApi.save(projectId, { version: graph.version, nodes, edges })
      setGraph(saved)
      setNodes([...saved.nodes])
      setEdges(saved.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })))
      setDirty(false)
      setSelectedEdge(null)
      message.success(`编排图已保存（v${saved.version}）`)
    } catch (cause) {
      setError(`${describeError(cause)}（如为版本冲突，请点"刷新"后重试）`)
    } finally {
      setBusy(false)
    }
  }

  const addNode = (instanceId: string): void => {
    if (nodes.some((node) => node.instanceId === instanceId)) {
      message.info('该 Agent 已在图中')
      return
    }
    setNodes([...nodes, { instanceId, x: 80 + nodes.length * 40, y: 60 + nodes.length * 30, collapsed: false }])
    setDirty(true)
  }

  const connect = (instanceId: string): void => {
    if (connectFrom === null) {
      setConnectFrom(instanceId)
      message.info(`已选择起点 ${instanceId}，请点击目标节点完成连线`)
      return
    }
    if (connectFrom === instanceId) {
      message.warning('不允许自环')
      setConnectFrom(null)
      return
    }
    if (edges.some((edge) => edge.from === connectFrom && edge.to === instanceId)) {
      message.warning('该方向的边已存在')
      setConnectFrom(null)
      return
    }
    setEdges([...edges, { from: connectFrom, to: instanceId }])
    setConnectFrom(null)
    setDirty(true)
  }

  const removeEdge = (index: number): void => {
    setEdges(edges.filter((_edge, position) => position !== index))
    setSelectedEdge(null)
    setDirty(true)
  }

  const statusOf = (instanceId: string): AgentStatus | undefined => statuses.find((item) => item.instanceId === instanceId)
  const memberOf = (instanceId: string): InstanceView | undefined => members.find((item) => item.instanceId === instanceId)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>, node: OrchestrationNode): void => {
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (rect === undefined) return
    dragRef.current = {
      instanceId: node.instanceId,
      offsetX: event.clientX - rect.left - node.x,
      offsetY: event.clientY - rect.top - node.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current
    const rect = event.currentTarget.parentElement?.getBoundingClientRect()
    if (drag === null || rect === undefined) return
    const x = Math.max(0, event.clientX - rect.left - drag.offsetX)
    const y = Math.max(0, event.clientY - rect.top - drag.offsetY)
    setNodes((previous) => previous.map((node) => (node.instanceId === drag.instanceId ? { ...node, x, y } : node)))
    setDirty(true)
  }

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>): void => {
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  if (graph === null) {
    return <Card size="small" loading />
  }

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <Card
        size="small"
        style={{ flex: 1, minWidth: 0 }}
        title={`编排图（v${graph.version}${dirty ? ' · 未保存' : ''}）`}
        extra={
          <Space>
            <Select
              size="small"
              style={{ width: 190 }}
              placeholder="添加 Agent 到图中"
              value={null}
              onChange={(value: string) => addNode(value)}
              options={members
                .filter((member) => !nodes.some((node) => node.instanceId === member.instanceId))
                .map((member) => ({ value: member.instanceId, label: `${member.displayName}（${member.instanceId}）` }))}
            />
            <Button
              size="small"
              type={connectFrom === null ? 'default' : 'primary'}
              onClick={() => setConnectFrom(connectFrom === null ? (nodes[0]?.instanceId ?? null) : null)}
              disabled={nodes.length === 0}
            >
              {connectFrom === null ? '连线模式' : `起点 ${connectFrom}`}
            </Button>
            <Button size="small" onClick={() => void load()} loading={busy}>
              刷新
            </Button>
            <Button size="small" type="primary" onClick={() => void save()} loading={busy} disabled={!dirty}>
              保存
            </Button>
          </Space>
        }
      >
        {error !== null && (
          <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} style={{ marginBottom: 8 }} />
        )}
        {nodes.length === 0 ? (
          <Empty description="从 Agent 库添加成员" />
        ) : (
          <div style={{ position: 'relative', height: 460, overflow: 'auto', border: '1px dashed #d9d9d9', borderRadius: 6 }}>
            <div style={{ position: 'relative', width: 900, height: 620 }}>
              <svg width={900} height={620} style={{ position: 'absolute', inset: 0 }}>
                <defs>
                  <marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto">
                    <path d="M0,0 L10,4 L0,8 Z" fill="#8c8c8c" />
                  </marker>
                </defs>
                {edges.map((edge, index) => {
                  const from = nodes.find((node) => node.instanceId === edge.from)
                  const to = nodes.find((node) => node.instanceId === edge.to)
                  if (from === undefined || to === undefined) return null
                  const x1 = from.x + CARD_W
                  const y1 = from.y + CARD_H / 2
                  const x2 = to.x
                  const y2 = to.y + CARD_H / 2
                  const highlighted = connectFrom !== null && (edge.from === connectFrom || edge.to === connectFrom)
                  return (
                    <g key={edge.id ?? `${edge.from}-${edge.to}-${index}`}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={selectedEdge === (edge.id ?? `${index}`) ? '#1677ff' : highlighted ? '#faad14' : '#8c8c8c'}
                        strokeWidth={selectedEdge === (edge.id ?? `${index}`) ? 3 : 2}
                        markerEnd="url(#arrow)"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setSelectedEdge(edge.id ?? `${index}`)}
                      />
                    </g>
                  )
                })}
              </svg>

              {nodes.map((node) => {
                const status = statusOf(node.instanceId)
                const member = memberOf(node.instanceId)
                const disabled = member?.enabled === false
                return (
                  <div
                    key={node.instanceId}
                    onPointerDown={(event) => onPointerDown(event, node)}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    style={{
                      position: 'absolute',
                      left: node.x,
                      top: node.y,
                      width: CARD_W,
                      height: CARD_H,
                      border: connectFrom === node.instanceId ? '2px solid #1677ff' : '1px solid #d9d9d9',
                      borderRadius: 8,
                      background: disabled ? '#fafafa' : '#fff',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                      padding: 8,
                      cursor: 'grab',
                      opacity: disabled ? 0.6 : 1,
                      userSelect: 'none',
                    }}
                  >
                    <Space direction="vertical" size={0} style={{ width: '100%' }}>
                      <Space size={4} wrap>
                        <Typography.Text strong>{member?.displayName ?? node.instanceId}</Typography.Text>
                        {disabled && <Tag>已停用</Tag>}
                      </Space>
                      <Space size={4} wrap>
                        <Tag color={status?.state === 'working' ? 'blue' : status?.state === 'waiting' ? 'orange' : 'default'}>
                          {STATE_LABEL[status?.state ?? 'idle'] ?? status?.state}
                        </Tag>
                        {status?.paused === true && <Tag color="purple">暂停</Tag>}
                        <Typography.Text type="secondary">队列 {status?.queued ?? 0}</Typography.Text>
                      </Space>
                      <Space size={4}>
                        <Button
                          size="small"
                          type="link"
                          onClick={() => {
                            if (connectFrom !== null) connect(node.instanceId)
                            else onOpenSession?.(node.instanceId)
                          }}
                        >
                          {connectFrom === null ? '打开会话' : '连到这里'}
                        </Button>
                        {status?.paused === true ? (
                          <Button size="small" type="link" onClick={() => void sessionApi.resume(projectId, node.instanceId).then(load)}>
                            继续
                          </Button>
                        ) : (
                          <Popconfirm
                            title="暂停该 Agent？"
                            onConfirm={() => void sessionApi.pause(projectId, node.instanceId).then(load)}
                          >
                            <Button size="small" type="link">
                              暂停
                            </Button>
                          </Popconfirm>
                        )}
                        <Button
                          size="small"
                          type="link"
                          danger
                          onClick={() => {
                            setNodes(nodes.filter((item) => item.instanceId !== node.instanceId))
                            setEdges(edges.filter((edge) => edge.from !== node.instanceId && edge.to !== node.instanceId))
                            setDirty(true)
                          }}
                        >
                          移出图
                        </Button>
                      </Space>
                    </Space>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <Space direction="vertical" size={4} style={{ marginTop: 8, width: '100%' }}>
          <Typography.Text type="secondary">
            边 = "可以委派任务"的关系：Agent 只能沿自己的直接出边派单，越边会被拒绝（`ERR_ORCHESTRATION_EDGE`）；用户不受边约束。
          </Typography.Text>
          <Space size={6} wrap>
            {edges.map((edge, index) => {
              const key = edge.id ?? `${index}`
              return (
                <Tag
                  key={key}
                  color={selectedEdge === key ? 'blue' : 'default'}
                  style={{ cursor: 'pointer' }}
                  onClick={() => setSelectedEdge(key)}
                  closable
                  onClose={() => removeEdge(index)}
                >
                  {edge.from} → {edge.to}
                </Tag>
              )
            })}
            {edges.length === 0 && <Typography.Text type="secondary">还没有委派边：用「连线模式」点击两个节点建立。</Typography.Text>}
          </Space>
        </Space>
      </Card>

      <div style={{ width: 340, flex: '0 0 340px' }}>
        <RightColumn projectId={projectId} />
      </div>
    </div>
  )
}
