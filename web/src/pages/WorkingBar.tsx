import { Badge, Button, Card, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import { runtimeApi, type RuntimeSnapshot } from '../api/runtime'
import { useRealtime } from '../hooks/useRealtime'

/**
 * 顶部「n 个 Agent 正在工作」细条（D17-⑥ / ui.md）：显示占用中的 Agent、当前任务与最近 plan 状态；
 * 提供「停止生成」（停当前回合输出、队列保留）与「停止任务」（终止当前任务并结算快照）。
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
      message.success(
        scope === 'turn'
          ? `已停止生成（队列保留 ${result.queued} 条）`
          : result.taskId === null
            ? '没有进行中的任务'
            : `已终止任务 ${result.taskId}${result.settledArtifactId === null ? '' : `，已结算快照 ${result.settledArtifactId}`}`,
      )
      await load()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const working = snapshot?.working ?? []

  return (
    <Card size="small" styles={{ body: { padding: '8px 12px' } }}>
      <Space size={12} wrap>
        <Badge
          status={working.length > 0 ? 'processing' : 'default'}
          text={
            <Typography.Text strong>
              {working.length === 0 ? '当前没有 Agent 在工作' : `${working.length} 个 Agent 正在工作`}
            </Typography.Text>
          }
        />
        {working.map((agent) => (
          <Space key={agent.instanceId} size={6} wrap>
            <Typography.Text>{agent.displayName}</Typography.Text>
            <Tag color={agent.state === 'waiting' ? 'orange' : 'blue'}>{agent.state}</Tag>
            {agent.paused && <Tag color="purple">暂停</Tag>}
            {agent.taskTitle !== null && <Tag>任务：{agent.taskTitle}</Tag>}
            {agent.planStatus !== null && <Tag color="geekblue">plan {agent.planStatus}</Tag>}
            {agent.queued > 0 && <Tag color="orange">队列 {agent.queued}</Tag>}
            {agent.unfinishedTurn !== null && <Tag color="red">未完成回合 {agent.unfinishedTurn}</Tag>}
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
