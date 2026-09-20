import { Alert, Button, Card, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography, message } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { ApiError, describeError } from '../api/client'
import {
  workApi,
  type ArtifactRecord,
  type FileOwnerRecord,
  type QuestionRecord,
  type TaskRecord,
  type TaskState,
} from '../api/work'
import { projectApi, type InstanceView } from '../api/projects'
import {
  conflictFiles,
  restorePlan,
  rollbackConfirmText,
  rollbackModeText,
  rollbackTone,
  versionRows,
  type ArtifactVersionRow,
} from '../lib/artifact-versions'
import { localClock } from '../lib/time-format'

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
  /** S54/D58：正在查看版本历史的产出物（含最新版本记录）+ 它的全部版本 */
  const [historyFor, setHistoryFor] = useState<ArtifactRecord | null>(null)
  const [history, setHistory] = useState<ArtifactRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyBusy, setHistoryBusy] = useState(false)

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

  /** 打开版本历史（S54/D58）：产出物列表每行只有最新版本，历史要单独拉 `.../versions` */
  const openHistory = async (record: ArtifactRecord): Promise<void> => {
    setHistoryFor(record)
    setHistory([])
    setHistoryLoading(true)
    try {
      setHistory(await workApi.artifactVersions(projectId, record.id))
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setHistoryLoading(false)
    }
  }

  /**
   * 退回此版本（S54/D58）：`mode='restore'` ＝把文件恢复成这一版的内容（撤销它之后的所有版本），
   * 产生一条新版本。文件在该版本之后被外部改过时服务端回 `ERR_CONFLICT` → 二次确认后带 force 重试。
   */
  const revertTo = async (version: number, force: boolean): Promise<void> => {
    if (historyFor === null) return
    setHistoryBusy(true)
    try {
      const updated = await workApi.rollback(projectId, historyFor.id, version, { mode: 'restore', force })
      message.success(`已退回 v${version}：文件恢复为该版本内容，产生新版本 v${updated.version}`)
      const versions = await workApi.artifactVersions(projectId, historyFor.id)
      setHistory(versions)
      setHistoryFor(updated)
      await load()
    } catch (cause) {
      const conflicted = cause instanceof ApiError && cause.code === 'ERR_CONFLICT' ? conflictFiles(cause.detail) : []
      if (conflicted.length > 0) {
        Modal.confirm({
          title: '这些文件在该版本之后被改动过',
          content: `${conflicted.join('、')} 会被覆盖。仍要强制退回吗？`,
          okText: '强制退回',
          okButtonProps: { danger: true },
          cancelText: '取消',
          onOk: () => revertTo(version, true),
        })
      } else {
        setError(describeError(cause))
      }
    } finally {
      setHistoryBusy(false)
    }
  }

  const historyRows = versionRows(history)
  const latestVersion = historyRows[0]?.version ?? 0

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
              width: 120,
              render: (_state: string, record) => <Tag color={rollbackTone(record)}>{rollbackModeText(record)}</Tag>,
            },
            {
              title: '操作',
              width: 130,
              render: (_v, record) => (
                // S54/D58：退回按"版本"走，先看版本历史再挑一版退回（不再有静默 force 的隐式回退）
                <Button size="small" onClick={() => void openHistory(record)}>
                  版本历史
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

      {/* S54/D58：版本历史 + 退回此版本（把文件恢复成这一版的内容，历史版本不删） */}
      <Modal
        open={historyFor !== null}
        title={historyFor === null ? '版本历史' : `版本历史 ·《${historyFor.title}》`}
        footer={null}
        width={860}
        onCancel={() => setHistoryFor(null)}
      >
        <Space direction="vertical" size="small" style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            共 {historyRows.length} 版（最新 v{latestVersion}）。「退回此版本」＝把工作目录里的文件恢复成这一版的内容
            （等于撤销它之后的所有版本），并记为新版本 v{latestVersion + 1}；历史版本不会被删除。
          </Typography.Text>
          <Table<ArtifactVersionRow>
            rowKey="version"
            size="small"
            loading={historyLoading}
            pagination={false}
            dataSource={[...historyRows]}
            columns={[
              {
                title: '版本',
                dataIndex: 'version',
                width: 110,
                render: (version: number, row) => (
                  <Space size={4}>
                    <Typography.Text strong>v{version}</Typography.Text>
                    {row.isCurrent && <Tag color="blue">当前</Tag>}
                  </Space>
                ),
              },
              { title: '状态', dataIndex: 'stateText', width: 110, render: (text: string, row) => <Tag color={row.tone}>{text}</Tag> },
              { title: '提交者', dataIndex: 'submitter', width: 110 },
              { title: '时间', dataIndex: 'ts', width: 150, render: (ts: string) => localClock(ts, { withMs: false }) },
              { title: '变更', width: 100, render: (_v, row) => `+${row.add}/-${row.del}` },
              {
                title: '文件',
                render: (_v, row) => (
                  <Space size={4} wrap>
                    {row.files.map((file) => (
                      <Tag key={`${file.action}-${file.relPath}`}>
                        {file.actionText} {file.relPath}
                      </Tag>
                    ))}
                  </Space>
                ),
              },
              {
                title: '操作',
                width: 120,
                render: (_v, row) =>
                  row.isCurrent ? (
                    <Typography.Text type="secondary">当前版本</Typography.Text>
                  ) : (
                    <Popconfirm
                      title={`退回 v${row.version}？`}
                      description={rollbackConfirmText({
                        target: row.version,
                        nextVersion: latestVersion + 1,
                        plan: restorePlan({ target: row.version, versions: history }),
                      })}
                      okText="退回"
                      cancelText="取消"
                      onConfirm={() => revertTo(row.version, false)}
                    >
                      <Button size="small" danger loading={historyBusy}>
                        退回此版本
                      </Button>
                    </Popconfirm>
                  ),
              },
            ]}
          />
        </Space>
      </Modal>
    </Space>
  )
}
