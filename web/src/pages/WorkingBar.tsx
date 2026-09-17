import { Badge, Button, Card, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import { runtimeApi, type RuntimeSnapshot } from '../api/runtime'
import { useRealtime } from '../hooks/useRealtime'
import { stopTaskFeedback, stopTurnFeedback } from '../lib/stop-feedback'

/**
 * 运行细条（S15 起挂在「拓扑」页的编排图顶部，不再横跨项目页两个导航）：显示占用中的 Agent、当前任务与最近 plan 状态；
 * 提供「停止生成」（停当前回合输出、队列保留）与「停止任务」（终止当前任务并结算快照）。
 * **空闲不渲染**：没有 Agent 在工作时整条不出现（无内容可停）。更细的终止入口在右栏任务列表（改状态为 `terminated`）。
 */
export function WorkingBar({ projectId }: { readonly projectId: string }) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setSnapshot(await runtimeApi.snapshot(projectId))
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
        if (['agent.state', 'task.updated', 'question.asked', 'approval.requested', 'turn.end'].includes(frame.type)) void load()
      },
      [load],
    ),
  )

  const stop = async (instanceId: string, scope: 'turn' | 'task'): Promise<void> => {
    try {
      const result = await runtimeApi.stop(projectId, instanceId, scope)
      // S37：如实反馈（空闲时"停止生成"没停到东西要说清楚，而不是报成功）
      const feedback = scope === 'turn' ? stopTurnFeedback(result) : stopTaskFeedback(result)
      message[feedback.kind](feedback.text)
      await load()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const working = snapshot?.working ?? []

  // 空闲不渲染（S15 用户口径）：没有 Agent 在工作就没有可停的东西，不做空态占位。
  if (working.length === 0) return null

  return (
    <Card size="small" style={{ marginBottom: 12 }} styles={{ body: { padding: '8px 12px' } }}>
      <Space size={12} wrap>
        <Badge
          status="processing"
          text={<Typography.Text strong>{`${working.length} 个 Agent 正在工作`}</Typography.Text>}
        />
        {working.map((agent) => (
          <Space key={agent.instanceId} size={6} wrap>
            <Typography.Text>{agent.displayName}</Typography.Text>
            <Tag color={agent.state === 'waiting' ? 'orange' : 'blue'}>{agent.state}</Tag>
            {agent.paused && <Tag color="purple">暂停</Tag>}
            {agent.taskTitle !== null && <Tag>任务：{agent.taskTitle}</Tag>}
            {agent.planStatus !== null && <Tag color="geekblue">plan {agent.planStatus}</Tag>}
            {agent.queued > 0 && <Tag color="orange">队列 {agent.queued}</Tag>}
            <Tooltip title="停当前回合输出（队列保留，任务继续）">
              <Button size="small" onClick={() => void stop(agent.instanceId, 'turn')}>
                停止生成
              </Button>
            </Tooltip>
            <Popconfirm
              title="终止该 Agent 的当前任务？"
              description="存在未结算改动时会先结算为可回退的产出物快照。"
              onConfirm={() => void stop(agent.instanceId, 'task')}
            >
              <Button size="small" danger>
                停止任务
              </Button>
            </Popconfirm>
          </Space>
        ))}
        {snapshot !== null && (
          <Typography.Text type="secondary">
            空闲 {snapshot.idle}｜暂停 {snapshot.paused}｜队列合计 {snapshot.queuedTotal}
          </Typography.Text>
        )}
        {error !== null && <Typography.Text type="danger">{error}</Typography.Text>}
        <Button size="small" onClick={() => void load()}>
          刷新
        </Button>
      </Space>
    </Card>
  )
}
