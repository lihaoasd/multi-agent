import { Alert, Button, Space, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import { runtimeApi, type UnfinishedTurn } from '../api/runtime'
import { useRealtime } from '../hooks/useRealtime'

/**
 * 未完成回合横幅（D17-⑤ / ui.md §4）：
 * 缺 `turn_end` 的回合重开/重连后标「未完成」，提供**三选**（汇报中断点 / 继续执行 / 忽略）
 * 与**补全**按钮（被截断的回复）；选择结果写盘后不再重复提示。
 */
export function RecoveryBanner({
  projectId,
  sessionId,
  onResolved,
}: {
  readonly projectId: string
  readonly sessionId: string
  readonly onResolved?: () => void
}) {
  const [unfinished, setUnfinished] = useState<UnfinishedTurn | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const found = await runtimeApi.sessionUnfinished(projectId, sessionId)
      setUnfinished(found !== null && found.resolvedBy === null ? found : null)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId, sessionId])

  useEffect(() => {
    void load()
  }, [load])

  useRealtime(
    projectId,
    useCallback(
      (frame: { type: string }) => {
        if (frame.type === 'agent.state' || frame.type === 'event.appended') void load()
      },
      [load],
    ),
  )

  const resolve = async (action: 'report' | 'continue' | 'ignore' | 'complete'): Promise<void> => {
    if (unfinished === null) return
    setBusy(true)
    try {
      const result = await runtimeApi.resolve(projectId, sessionId, unfinished.turn, action)
      message.success(result.resumed ? '已唤醒该 Agent 处理未完成回合' : result.text)
      setUnfinished(null)
      onResolved?.()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  if (unfinished === null && error === null) return null

  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}
      {unfinished !== null && (
        <Alert
          type="warning"
          showIcon
          message={
            <Space size={6} wrap>
              <span>未完成回合（turn {unfinished.turn}）</span>
              {unfinished.loopStep !== null && <Tag>{unfinished.loopStep}</Tag>}
              {unfinished.lastPlan !== null && (
                <Tag color="orange">
                  plan {unfinished.lastPlan.steps} 步 · {unfinished.lastPlan.status ?? '未知状态'}
                </Tag>
              )}
              <Typography.Text type="secondary">开始于 {unfinished.startedAt.slice(11, 19)}</Typography.Text>
            </Space>
          }
          description={
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Typography.Text>
                该回合缺 `turn_end`（进程/浏览器中断）。平台**不自动续跑**，请选择：汇报中断点 / 继续执行 / 忽略；
                若上一次回复被截断，可直接「补全」。
              </Typography.Text>
              <Space size={6} wrap>
                <Button size="small" type="primary" loading={busy} onClick={() => void resolve('report')}>
                  汇报中断点
                </Button>
                <Button size="small" loading={busy} onClick={() => void resolve('continue')}>
                  继续执行
                </Button>
                <Button size="small" loading={busy} onClick={() => void resolve('complete')}>
                  补全上次回复
                </Button>
                <Button size="small" danger loading={busy} onClick={() => void resolve('ignore')}>
                  忽略
                </Button>
              </Space>
            </Space>
          }
        />
      )}
    </Space>
  )
}
