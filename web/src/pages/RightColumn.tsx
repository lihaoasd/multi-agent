import { Alert, Badge, Button, Card, Empty, List, Space, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import { approvalApi, type ApprovalView } from '../api/platform'
import { workApi, type QuestionRecord, type TaskRecord } from '../api/work'
import { useRealtime } from '../hooks/useRealtime'

const TASK_STATE_LABEL: Record<string, string> = {
  todo: '待领取',
  in_progress: '进行中',
  done: '已完成',
  blocked: '受阻',
  terminated: '已终止',
}

/**
 * 右栏三列表（ui.md §5）：任务 / 询问（待答）/ 审批（pending）。
 * 三者都是"当前需要用户或 Agent 动作"的入口；WS 事件到达即刷新。
 */
export function RightColumn({ projectId }: { readonly projectId: string }) {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [questions, setQuestions] = useState<QuestionRecord[]>([])
  const [approvals, setApprovals] = useState<ApprovalView[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [taskList, questionList, approvalList] = await Promise.all([
        workApi.tasks(projectId),
        workApi.questions(projectId, 'pending'),
        approvalApi.list(projectId, 'pending'),
      ])
      setTasks(taskList.filter((task) => task.state === 'todo' || task.state === 'in_progress' || task.state === 'blocked'))
      setQuestions(questionList)
      setApprovals(approvalList)
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
        if (
          ['task.updated', 'question.asked', 'question.answered', 'approval.requested', 'approval.decided', 'agent.state'].includes(
            frame.type,
          )
        ) {
          void load()
        }
      },
      [load],
    ),
  )

  const decide = async (approval: ApprovalView, decision: 'approved' | 'rejected'): Promise<void> => {
    try {
      await approvalApi.decide(projectId, approval.id, decision)
      await load()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const answer = async (question: QuestionRecord, itemId: string, choice: string): Promise<void> => {
    try {
      await workApi.answer(projectId, question.id, [{ itemId, choice }])
      await load()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  return (
    <Space direction="vertical" size="small" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

      <Card size="small" title={`任务（${tasks.length}）`} extra={<Button size="small" onClick={() => void load()}>刷新</Button>}>
        {tasks.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待办任务" />
        ) : (
          <List
            size="small"
            dataSource={tasks}
            renderItem={(task) => (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={6} wrap>
                    <Tag color={task.state === 'in_progress' ? 'blue' : task.state === 'blocked' ? 'red' : 'default'}>
                      {TASK_STATE_LABEL[task.state] ?? task.state}
                    </Tag>
                    <Typography.Text strong>{task.title}</Typography.Text>
                  </Space>
                  <Typography.Text type="secondary">
                    {task.creator} → {task.assignee}｜{task.updatedAt.slice(11, 19)}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      <Card size="small" title={`询问（${questions.length}）`}>
        {questions.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待答复提问" />
        ) : (
          questions.map((question) => (
            <Card key={question.id} size="small" type="inner" title={`${question.asker}：${question.title}`}>
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                {question.items.map((item) => (
                  <Space key={item.id} size={4} wrap>
                    <Typography.Text>{item.text}</Typography.Text>
                    {item.options.length > 0 ? (
                      item.options.map((option) => (
                        <Button key={option} size="small" onClick={() => void answer(question, item.id, option)}>
                          {option}
                        </Button>
                      ))
                    ) : (
                      <Button size="small" onClick={() => void answer(question, item.id, '同意')}>
                        同意
                      </Button>
                    )}
                  </Space>
                ))}
              </Space>
            </Card>
          ))
        )}
      </Card>

      <Card size="small" title={`审批（${approvals.length}）`}>
        {approvals.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有待审批动作" />
        ) : (
          approvals.map((approval) => (
            <Card key={approval.id} size="small" type="inner" title={`${approval.actor}：${approval.summary}`}>
              <Space size={6} wrap>
                <Tag color="orange">{approval.kind}</Tag>
                <Button size="small" type="primary" onClick={() => void decide(approval, 'approved')}>
                  批准
                </Button>
                <Button size="small" danger onClick={() => void decide(approval, 'rejected')}>
                  拒绝
                </Button>
              </Space>
            </Card>
          ))
        )}
      </Card>

      <Badge status="processing" text={<Typography.Text type="secondary">实时刷新（WS）</Typography.Text>} />
    </Space>
  )
}
