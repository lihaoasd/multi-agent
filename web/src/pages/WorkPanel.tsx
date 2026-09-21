import { Alert, Button, Card, Space, Table, Tag, Typography } from 'antd'
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

const TASK_STATE_LABEL: Record<TaskState, string> = {
  todo: '待领取',
  in_progress: '进行中',
  done: '已完成',
  // S53/D57：任务不再有「受阻」；这里只为显示既有历史数据
  blocked: '受阻（旧数据）',
  terminated: '已终止',
}

const ARTIFACT_TYPE_LABEL: Record<string, string> = {
  doc: '文档',
  code: '代码',
  config: '配置',
  test: '测试',
  deploy: '部署',
}

/**
 * 任务 / 询问 / 产出物面板（S6）：用户（老板）视角，**只读**。
 * - 任务（**S57/D61**）：只展示（派发与状态流转由角色驱动：PM 按职能派单、受派人 task_claim/task_update 汇报）——
 *   不再提供用户派单与改状态入口；要人工干预可走 API/脚本（`POST /tasks`、`PATCH /tasks/:tid`）。
 * - 产出物（**S56/D60**）：只展示（登记免审批；回退入口已按用户要求删除，接口/Agent 工具仍在）。
 * - 询问：待答项只做提示，答复入口在会话窗口（输入框上方，S32）。
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
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [taskList, questionList, artifactList, ownerList] = await Promise.all([
        workApi.tasks(projectId),
        workApi.questions(projectId),
        workApi.artifacts(projectId, { limit: 50 }),
        workApi.fileOwners(projectId),
      ])
      setTasks(taskList)
      setQuestions(questionList)
      setArtifacts(artifactList)
      setOwners(ownerList)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} closable onClose={() => setError(null)} />}

      <Card
        size="small"
        title={`任务（${tasks.length}）`}
        extra={
          <Button size="small" onClick={() => void load()}>
            刷新
          </Button>
        }
      >
        {/* S57/D61：用户只读——不派单、不改状态；派发与流转由角色驱动（PM 按职能派单、受派人领取/汇报） */}
        <Typography.Text type="secondary">
          任务由角色按职能派发与推进（派单走 PM、领取/汇报走受派人）；本面板只读，人工干预请用 API。
        </Typography.Text>
        <Table<TaskRecord>
          rowKey="id"
          size="small"
          pagination={false}
          style={{ marginTop: 8 }}
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
              width: 120,
              render: (state: string, record) =>
                state === 'reverted' ? <Tag color="orange">已回退→v{record.revertedTo}</Tag> : <Tag color="green">已登记</Tag>,
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
    </Space>
  )
}
