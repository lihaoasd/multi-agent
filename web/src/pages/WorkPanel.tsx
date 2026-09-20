import { Alert, Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import {
  workApi,
  type ArtifactRecord,
  type FileOwnerRecord,
  type QuestionRecord,
  type TaskRecord,
  type TaskState,
} from '../api/work'
import { projectApi, type InstanceView } from '../api/projects'

const TASK_STATE_LABEL: Record<TaskState, string> = {
  todo: '待领取',
  in_progress: '进行中',
  done: '已完成',
  // S53/D57：任务不再有「受阻」；这里只为显示既有历史数据
  blocked: '受阻（旧数据）',
  terminated: '已终止',
}

/** 用户可手动改成的状态：不再包含 blocked（服务端也会拒绝） */
const SELECTABLE_TASK_STATES: readonly TaskState[] = ['todo', 'in_progress', 'done', 'terminated']

const ARTIFACT_TYPE_LABEL: Record<string, string> = {
  doc: '文档',
  code: '代码',
  config: '配置',
  test: '测试',
  deploy: '部署',
}

/**
 * 任务 / 询问 / 产出物面板（S6）：用户（老板）视角。
 * - 任务：发布、改状态（终止前平台会先结算未结算改动）、查看归属产出物；
 * - 询问：Agent 待答项就地答复（答复后该 Agent 继续其回合）；
 * - 产出物：版本列表 + 回退（回退即产生 state=reverted 的新版本）+ 署名归属表。
 */
export function WorkPanel({
  projectId,
  onOpenSession,
}: {
  readonly projectId: string
  /** 「到会话里答复」回调（S32）；缺省时只显示提示文字 */
  readonly onOpenSession?: (sessionId: string) => void
}) {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [questions, setQuestions] = useState<QuestionRecord[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([])
  const [owners, setOwners] = useState<FileOwnerRecord[]>([])
  const [members, setMembers] = useState<InstanceView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assignForm] = Form.useForm<{ assignee: string; title: string; desc?: string }>()

  const load = useCallback(async () => {
    try {
      const [taskList, questionList, artifactList, ownerList, team] = await Promise.all([
        workApi.tasks(projectId),
        workApi.questions(projectId),
        workApi.artifacts(projectId, { limit: 50 }),
        workApi.fileOwners(projectId),
        projectApi.listTeam(projectId),
      ])
      setTasks(taskList)
      setQuestions(questionList)
      setArtifacts(artifactList)
      setOwners(ownerList)
      setMembers(team)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await action()
      await load()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

      <Card
        size="small"
        title={`任务（${tasks.length}）`}
        extra={
          <Space>
            <Button size="small" onClick={() => void load()} loading={busy}>
              刷新
            </Button>
            <Button size="small" type="primary" onClick={() => setAssignOpen(true)}>
              派单
            </Button>
          </Space>
        }
      >
        <Table<TaskRecord>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={tasks}
          columns={[
            { title: '任务', dataIndex: 'title' },
            { title: '受派', dataIndex: 'assignee', width: 100 },
            { title: '发起', dataIndex: 'creator', width: 100 },
            {
              title: '状态',
              dataIndex: 'state',
              width: 120,
              render: (state: TaskState) => (
                <Tag color={state === 'in_progress' ? 'blue' : state === 'done' ? 'green' : state === 'blocked' ? 'red' : 'default'}>
                  {TASK_STATE_LABEL[state]}
                </Tag>
              ),
            },
            {
              title: '产出物',
              width: 160,
              render: (_v, record) =>
                record.artifactIds.length === 0 ? (
                  <Typography.Text type="secondary">—</Typography.Text>
                ) : (
                  <Space size={4} wrap>
                    {record.artifactIds.map((id) => (
                      <Tag key={id}>{id}</Tag>
                    ))}
                  </Space>
                ),
            },
            { title: '备注', dataIndex: 'note', render: (note: string | null) => note ?? '—' },
            {
              title: '操作',
              width: 220,
              render: (_v, record) => (
                <Space size={4}>
                  <Select
                    size="small"
                    value={record.state}
                    style={{ width: 110 }}
                    onChange={(value) => void run(() => workApi.setTaskState(projectId, record.id, value as TaskState))}
                    options={SELECTABLE_TASK_STATES.map((state) => ({
                      value: state,
                      label: TASK_STATE_LABEL[state],
                    }))}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Card>

      {/* S32：询问只做提示——答复入口统一在**会话窗口（输入框上方）** */}
      <Card size="small" title={`待答复询问（${questions.filter((item) => item.status === 'pending').length}）`}>
        {questions.filter((item) => item.status === 'pending').length === 0 ? (
          <Typography.Text type="secondary">没有待答复的提问。</Typography.Text>
        ) : (
          questions
            .filter((item) => item.status === 'pending')
            .map((question) => (
              <Card key={question.id} size="small" type="inner" title={`${question.asker}：${question.title}`}>
                <Space size={6} wrap>
                  <Typography.Text type="secondary">答复请到会话窗口（输入框上方）</Typography.Text>
                  {onOpenSession !== undefined && (
                    <Button size="small" onClick={() => onOpenSession(question.sessionId)}>
                      到会话里答复
                    </Button>
                  )}
                </Space>
              </Card>
            ))
        )}
      </Card>

      <Card size="small" title={`产出物（${artifacts.length}）`}>
        <Table<ArtifactRecord>
          rowKey={(record) => `${record.id}-v${record.version}`}
          size="small"
          pagination={false}
          dataSource={artifacts}
          columns={[
            { title: '标题', dataIndex: 'title' },
            { title: '类型', dataIndex: 'type', width: 90, render: (type: string) => ARTIFACT_TYPE_LABEL[type] ?? type },
            { title: '版本', dataIndex: 'version', width: 70, render: (version: number) => `v${version}` },
            { title: '提交者', dataIndex: 'submitter', width: 100 },
            {
              title: '变更',
              width: 110,
              render: (_v, record) => `+${record.diffSummary.add}/-${record.diffSummary.del}`,
            },
            {
              title: '文件',
              render: (_v, record) => (
                <Space size={4} wrap>
                  {record.files.map((file) => (
                    <Tag key={file.relPath}>{file.relPath}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              title: '状态',
              dataIndex: 'state',
              width: 110,
              render: (state: string, record) =>
                state === 'reverted' ? <Tag color="orange">已回退→v{record.revertedTo}</Tag> : <Tag color="green">已登记</Tag>,
            },
            {
              title: '操作',
              width: 110,
              render: (_v, record) => (
                <Button
                  size="small"
                  danger
                  disabled={busy || record.state === 'reverted'}
                  onClick={() => void run(() => workApi.rollback(projectId, record.id, record.version, true))}
                >
                  回退此版本
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Card size="small" title={`文件署名与归属（${owners.length}）`}>
        <Table<FileOwnerRecord>
          rowKey="relPath"
          size="small"
          pagination={{ pageSize: 10 }}
          dataSource={owners}
          columns={[
            { title: '文件', dataIndex: 'relPath' },
            { title: '署名', dataIndex: 'ownerName' },
            { title: 'owner', dataIndex: 'owner', width: 110 },
            { title: '写入次数', dataIndex: 'edits', width: 100 },
            { title: '最近方式', dataIndex: 'via', width: 140 },
          ]}
        />
      </Card>

      <Modal
        open={assignOpen}
        title="派单给某个角色"
        onCancel={() => setAssignOpen(false)}
        onOk={() => {
          void assignForm.validateFields().then(async (values) => {
            await run(() =>
              workApi.createTask(projectId, {
                assignee: values.assignee,
                title: values.title,
                ...(values.desc === undefined ? {} : { desc: values.desc }),
              }),
            )
            setAssignOpen(false)
            assignForm.resetFields()
          })
        }}
        confirmLoading={busy}
      >
        <Form form={assignForm} layout="vertical">
          <Form.Item name="assignee" label="受派人" rules={[{ required: true }]}>
            <Select
              options={members
                .filter((member) => member.enabled)
                .map((member) => ({ value: member.instanceId, label: `${member.displayName}（${member.instanceId}）` }))}
            />
          </Form.Item>
          <Form.Item name="title" label="任务标题" rules={[{ required: true }]}>
            <Input placeholder="如：实现登录模块" />
          </Form.Item>
          <Form.Item name="desc" label="任务说明">
            <Input.TextArea rows={3} placeholder="验收标准、产出要求…" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  )
}
