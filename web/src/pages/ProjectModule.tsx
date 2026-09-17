import {
  Alert,
  Button,
  Card,
  Checkbox,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Steps,
  Switch,
  Tabs,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { agentTemplateApi, type AgentTemplateView } from '../api/agentTemplates'
import { describeError } from '../api/client'
import { modelConfigApi, type ModelView } from '../api/modelConfig'
import { promptPreviewApi, type PromptPreviewView } from '../api/platform'
import { SessionPanel } from './SessionPanel'
import { MemoryPanel } from './MemoryPanel'
import { WorkPanel } from './WorkPanel'
import { TopologyPanel } from './TopologyPanel'
import { runtimeApi } from '../api/runtime'
import { projectApi, type BrowseResult, type InstanceView, type ProjectSummary, type WorkdirInspection } from '../api/projects'

const LOOP_STRATEGIES = [
  { value: 'direct', label: 'direct' },
  { value: 'reflective', label: 'reflective' },
  { value: 'plan-execute', label: 'plan-execute' },
]

interface WizardValues {
  name: string
  description?: string
  members: string[]
}

interface InstanceFormValues {
  displayName: string
  prompt?: string
  strategy: string
  maxIterations?: number
  toolBudget?: number
  model?: string
}

/** 目录浏览器（用户级 API，绕过 Agent 沙箱）：逐层浏览 + 选择当前目录 */
function DirectoryPicker(props: {
  open: boolean
  onCancel: () => void
  onPick: (path: string, inspection: WorkdirInspection) => void
}) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null)
  const [inspection, setInspection] = useState<WorkdirInspection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [includeHidden, setIncludeHidden] = useState(false)

  const load = useCallback(
    async (path: string | null) => {
      try {
        const result = await projectApi.browse(path, includeHidden)
        setBrowse(result)
        setError(null)
        if (result.path !== null) setInspection(await projectApi.inspect(result.path))
      } catch (cause) {
        setError(describeError(cause))
      }
    },
    [includeHidden],
  )

  useEffect(() => {
    if (props.open) void load(null)
  }, [props.open, load])

  return (
    <Modal
      open={props.open}
      title="选择项目工作目录"
      width={720}
      onCancel={props.onCancel}
      okText="使用此目录"
      cancelText="取消"
      okButtonProps={{ disabled: browse?.path === null || browse === null || inspection?.writable !== true }}
      onOk={() => {
        if (browse?.path != null && inspection !== null) props.onPick(browse.path, inspection)
      }}
    >
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space wrap>
          <Button size="small" disabled={browse?.parent == null} onClick={() => void load(browse?.parent ?? null)}>
            上级
          </Button>
          <Button size="small" onClick={() => void load(browse?.path ?? null)}>
            刷新
          </Button>
          <Checkbox checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)}>
            显示隐藏目录
          </Checkbox>
          <Typography.Text code>{browse?.path ?? '（根列表）'}</Typography.Text>
        </Space>
        {error !== null && <Alert type="error" showIcon message={error} />}
        {inspection !== null && (
          <Typography.Text type="secondary">
            类型：{inspection.kind === 'existing-repo' ? '已有内容的目录' : '空目录'}｜条目 {inspection.entryCount}｜
            {inspection.writable ? '可写' : '不可写（不能作为工作目录）'}
          </Typography.Text>
        )}
        <Table
          size="small"
          rowKey="path"
          pagination={false}
          dataSource={browse?.entries ?? []}
          locale={{ emptyText: <Empty description="该目录下没有可显示的条目" /> }}
          onRow={(record) => ({
            onClick: () => {
              if (record.isDirectory) void load(record.path)
            },
            style: { cursor: record.isDirectory ? 'pointer' : 'default' },
          })}
          columns={[
            {
              title: '名称',
              dataIndex: 'name',
              render: (name: string, record) => (
                <Space size={4}>
                  <Typography.Text>{name}</Typography.Text>
                  {record.isRepo && <Tag color="blue">repo</Tag>}
                </Space>
              ),
            },
            {
              title: '类型',
              dataIndex: 'isDirectory',
              width: 100,
              render: (isDirectory: boolean) => (isDirectory ? '目录' : '文件'),
            },
          ]}
        />
      </Space>
    </Modal>
  )
}

/**
 * 系统提示词预览弹窗（S29 抽成组件）。
 * ⚠️ 它必须挂在**两个分支**里：详情页（`current !== null`）与项目列表页都有触发入口，
 * 此前只挂在项目列表分支，导致详情页点「提示词预览」只改 state、弹窗没挂载 = "点击没反应"。
 */
function PromptPreviewModal({
  preview,
  onClose,
}: {
  readonly preview: PromptPreviewView | null
  readonly onClose: () => void
}) {
  return (
    <Modal
      open={preview !== null}
      title="系统提示词预览（与运行期同源，不落盘）"
      width={760}
      onCancel={onClose}
      footer={null}
    >
      {preview !== null && (
        <Space direction="vertical" style={{ width: '100%' }}>
          {preview.blocks.map((block) => (
            <Card key={block.id} size="small" title={`${block.title}（origin=${block.origin}）`}>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>
                {block.text}
              </Typography.Paragraph>
            </Card>
          ))}
        </Space>
      )}
    </Modal>
  )
}

export function ProjectModule() {
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [templates, setTemplates] = useState<AgentTemplateView[]>([])
  const [models, setModels] = useState<ModelView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardStep, setWizardStep] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selectedWorkdir, setSelectedWorkdir] = useState<{ path: string; inspection: WorkdirInspection } | null>(null)
  const [wizardForm] = Form.useForm<WizardValues>()
  const [current, setCurrent] = useState<ProjectSummary | null>(null)
  const [activeTab, setActiveTab] = useState('topology')
  /** 拓扑页点节点带来的会话聚焦请求（S17）：`at` 作为幂等令牌，重复点同一节点也能再次聚焦 */
  const [sessionFocus, setSessionFocus] = useState<{ instanceId: string; at: number } | null>(null)
  const [instances, setInstances] = useState<InstanceView[]>([])
  const [instanceForm] = Form.useForm<InstanceFormValues>()
  const [editing, setEditing] = useState<InstanceView | null>(null)
  const [preview, setPreview] = useState<PromptPreviewView | null>(null)

  const showPreview = async (instance: InstanceView): Promise<void> => {
    if (current === null) return
    try {
      setPreview(await promptPreviewApi.preview(current.id, instance.instanceId))
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [projectList, templateList, modelList] = await Promise.all([
        projectApi.list(),
        agentTemplateApi.list(),
        modelConfigApi.listModels(),
      ])
      setProjects(projectList)
      setTemplates(templateList)
      setModels(modelList)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const loadTeam = useCallback(async (projectId: string) => {
    try {
      setInstances(await projectApi.listTeam(projectId))
    } catch (cause) {
      message.error(describeError(cause))
    }
  }, [])

  const modelOptions = models
    .filter((model) => model.enabled)
    .map((model) => ({ value: model.id, label: `${model.displayName}（${model.providerName}）` }))

  const openWizard = (): void => {
    wizardForm.setFieldsValue({
      name: '',
      description: '',
      members: templates.filter((template) => template.source === 'builtin' && template.enabled).map((t) => t.roleId),
    })
    setSelectedWorkdir(null)
    setWizardStep(0)
    setWizardOpen(true)
  }

  const submitWizard = async (): Promise<void> => {
    const values = await wizardForm.validateFields()
    if (selectedWorkdir === null) {
      message.warning('请先选择项目工作目录')
      return
    }
    try {
      const created = await projectApi.create({
        name: values.name,
        ...(values.description === undefined || values.description === '' ? {} : { description: values.description }),
        workdir: selectedWorkdir.path,
        members: (values.members ?? []).map((roleTemplateId) => ({ roleTemplateId })),
      })
      message.success(`项目已创建：${created.name}（成员 ${created.team.length} 个）`)
      setWizardOpen(false)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const openProject = async (project: ProjectSummary): Promise<void> => {
    setCurrent(project)
    await loadTeam(project.id)
  }

  const removeProject = async (project: ProjectSummary): Promise<void> => {
    Modal.confirm({
      title: `删除项目「${project.name}」？`,
      content: '只删除平台运行时数据（会话/记忆/配置），不影响你的工作目录与其中文件。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        await projectApi.remove(project.id)
        message.success('项目已删除（工作目录未受影响）')
        setCurrent(null)
        await refresh()
      },
    })
  }

  const openInstance = (instance: InstanceView): void => {
    setEditing(instance)
    const params = instance.effective.loop.params as { maxIterations?: number; toolBudget?: number }
    instanceForm.setFieldsValue({
      displayName: instance.displayName,
      prompt: instance.effective.systemPrompt,
      strategy: instance.effective.loop.strategy,
      maxIterations: params.maxIterations,
      toolBudget: params.toolBudget,
      model: instance.effective.model ?? undefined,
    })
  }

  const saveInstance = async (): Promise<void> => {
    if (editing === null || current === null) return
    const values = await instanceForm.validateFields()
    const params: Record<string, unknown> = {}
    if (values.maxIterations !== undefined) params['maxIterations'] = values.maxIterations
    if (values.toolBudget !== undefined) params['toolBudget'] = values.toolBudget
    try {
      await projectApi.patchInstance(current.id, editing.instanceId, {
        displayName: values.displayName,
        prompt: values.prompt ?? null,
        model: values.model ?? null,
        loop: { strategy: values.strategy, params },
      })
      message.success('实例配置已保存（下一回合生效）')
      setEditing(null)
      await loadTeam(current.id)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const resetInstance = async (instance: InstanceView): Promise<void> => {
    if (current === null) return
    try {
      await projectApi.patchInstance(current.id, instance.instanceId, { prompt: null, model: null, loop: null })
      message.success('已恢复为模板快照')
      await loadTeam(current.id)
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const toggleInstance = async (instance: InstanceView, enabled: boolean): Promise<void> => {
    if (current === null) return
    try {
      if (enabled) await projectApi.enableInstance(current.id, instance.instanceId)
      else await projectApi.disableInstance(current.id, instance.instanceId)
      await loadTeam(current.id)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  if (current !== null) {
    return (
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Space>
            <Button onClick={() => setCurrent(null)}>← 返回项目列表</Button>
            <Typography.Title level={5} style={{ margin: 0 }}>
              {current.name}
            </Typography.Title>
            <Tag>{current.workdirKind === 'empty' ? '空目录' : '已有内容'}</Tag>
          </Space>
          <Tooltip title="只导出运行时项目文件夹（会话/记忆/产出物/任务），不含工作目录。">
            <Button
              size="small"
              onClick={() => {
                window.location.href = runtimeApi.exportUrl(current.id)
              }}
            >
              导出项目数据（zip）
            </Button>
          </Tooltip>
        </Space>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            {
              key: 'topology',
              label: '拓扑',
              children: (
                <TopologyPanel
                  projectId={current.id}
                  onOpenSession={(instanceId) => {
                    setSessionFocus({ instanceId, at: Date.now() })
                    setActiveTab('session')
                  }}
                />
              ),
            },
            {
              key: 'team',
              label: '团队与配置',
              children: (
                <Card size="small" title="团队与实例配置（提示词 / loop / 模型）">
          <Table<InstanceView>
            rowKey="instanceId"
            size="small"
            dataSource={instances}
            pagination={false}
            columns={[
              { title: '实例', dataIndex: 'instanceId', width: 110 },
              { title: '显示名', dataIndex: 'displayName', width: 150 },
              {
                title: '模板',
                dataIndex: 'templateName',
                render: (name: string, record) => (
                  <Space size={4}>
                    <Typography.Text>{name}</Typography.Text>
                    {record.templateMissing && <Tag color="red">模板已移除</Tag>}
                  </Space>
                ),
              },
              {
                title: '有效模型',
                dataIndex: 'effectiveModelLabel',
                render: (_value, record) => (
                  <Tag color={record.effectiveModelAvailable ? 'green' : 'red'}>
                    {record.effectiveModelLabel ?? record.effective.model ?? '未配置'}
                  </Tag>
                ),
              },
              { title: 'loop', render: (_value, record) => <Tag>{record.effective.loop.strategy}</Tag> },
              {
                title: '覆盖',
                dataIndex: 'overrides',
                render: (overrides: readonly string[]) =>
                  overrides.length === 0 ? (
                    <Typography.Text type="secondary">跟随快照</Typography.Text>
                  ) : (
                    overrides.map((item) => <Tag key={item}>{item}</Tag>)
                  ),
              },
              { title: '配置版本', dataIndex: 'configVersion', width: 90 },
              {
                title: '启用',
                dataIndex: 'enabled',
                width: 80,
                render: (enabled: boolean, record) => (
                  <Switch size="small" checked={enabled} onChange={(checked) => void toggleInstance(record, checked)} />
                ),
              },
              {
                title: '操作',
                width: 180,
                render: (_value, record) => (
                  <Space size={4}>
                    <Button size="small" onClick={() => openInstance(record)}>
                      覆盖配置
                    </Button>
                    <Button size="small" onClick={() => void resetInstance(record)}>
                      恢复快照
                    </Button>
                    <Button size="small" onClick={() => void showPreview(record)}>
                      提示词预览
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
                </Card>
              ),
            },
            {
              key: 'session',
              label: '会话',
              children: <SessionPanel projectId={current.id} focus={sessionFocus} />,
            },
            {
              key: 'memory',
              label: '记忆与检索',
              children: <MemoryPanel projectId={current.id} />,
            },
            {
              key: 'work',
              label: '任务与产出物',
              children: <WorkPanel projectId={current.id} />,
            },
          ]}
        />

        <Drawer
          open={editing !== null}
          width={680}
          title={editing === null ? '' : `覆盖配置：${editing.displayName}`}
          onClose={() => setEditing(null)}
          extra={
            <Button type="primary" onClick={() => void saveInstance()}>
              保存
            </Button>
          }
        >
          {editing !== null && (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Alert
                type="info"
                showIcon
                message="实例配置只影响这个 Agent"
                description="模板快照不受影响；改动在下一回合生效，运行中的回合到可中断点。留空并保存可回到快照。"
              />
              <Form form={instanceForm} layout="vertical">
                <Form.Item name="displayName" label="显示名" rules={[{ required: true }]}>
                  <Input />
                </Form.Item>
                <Form.Item name="prompt" label="系统提示词（覆盖模板快照）">
                  <Input.TextArea rows={10} />
                </Form.Item>
                <Space wrap size="middle">
                  <Form.Item name="strategy" label="loop 策略" rules={[{ required: true }]}>
                    <Select style={{ width: 180 }} options={LOOP_STRATEGIES} />
                  </Form.Item>
                  <Form.Item name="maxIterations" label="maxIterations">
                    <InputNumber min={1} max={20} />
                  </Form.Item>
                  <Form.Item name="toolBudget" label="toolBudget">
                    <InputNumber min={0} max={200} />
                  </Form.Item>
                  <Form.Item name="model" label="模型">
                    <Select allowClear style={{ width: 240 }} options={modelOptions} />
                  </Form.Item>
                </Space>
              </Form>
            </Space>
          )}
        </Drawer>
        {/* S29：预览弹窗两个分支都要挂（此前只在项目列表分支 → 详情页点击无反应） */}
        <PromptPreviewModal preview={preview} onClose={() => setPreview(null)} />
      </Space>
    )
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message="项目列表加载失败" description={error} />}
      <Card
        title="项目"
        extra={
          <Space>
            <Button onClick={() => void refresh()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" onClick={openWizard}>
              创建项目
            </Button>
          </Space>
        }
      >
        <Table<ProjectSummary>
          rowKey="id"
          size="small"
          dataSource={projects}
          pagination={false}
          locale={{ emptyText: <Empty description="还没有项目：点右上角「创建项目」开始" /> }}
          columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '描述', dataIndex: 'description', ellipsis: true },
            { title: '工作目录', dataIndex: 'workdir', ellipsis: true },
            {
              title: '类型',
              dataIndex: 'workdirKind',
              width: 110,
              render: (kind: string) => <Tag>{kind === 'empty' ? '空目录' : '已有内容'}</Tag>,
            },
            {
              title: '成员',
              width: 100,
              render: (_value, record) => `${record.enabledCount}/${record.memberCount}`,
            },
            {
              title: '操作',
              width: 160,
              render: (_value, record) => (
                <Space size={4}>
                  <Button size="small" type="primary" ghost onClick={() => void openProject(record)}>
                    打开
                  </Button>
                  <Button size="small" danger onClick={() => void removeProject(record)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <PromptPreviewModal preview={preview} onClose={() => setPreview(null)} />

      <Modal
        open={wizardOpen}
        title="创建项目"
        width={720}
        onCancel={() => setWizardOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setWizardStep((step) => Math.max(0, step - 1))} disabled={wizardStep === 0}>
              上一步
            </Button>
            {wizardStep < 2 ? (
              <Button
                type="primary"
                onClick={async () => {
                  if (wizardStep === 0) {
                    try {
                      await wizardForm.validateFields(['name'])
                    } catch {
                      return
                    }
                  }
                  if (wizardStep === 1 && selectedWorkdir === null) {
                    message.warning('请先选择项目工作目录')
                    return
                  }
                  setWizardStep((step) => step + 1)
                }}
              >
                下一步
              </Button>
            ) : (
              <Button type="primary" onClick={() => void submitWizard()}>
                创建
              </Button>
            )}
          </Space>
        }
      >
        <Steps
          size="small"
          current={wizardStep}
          items={[{ title: '基本信息' }, { title: '选择目录' }, { title: '勾选角色' }]}
        />
        <Form form={wizardForm} layout="vertical" style={{ marginTop: 16 }}>
          <div style={{ display: wizardStep === 0 ? 'block' : 'none' }}>
            <Form.Item name="name" label="项目名称" rules={[{ required: true, message: '请输入项目名称' }]}>
              <Input placeholder="例如：本地待办清单 Web 应用" maxLength={60} />
            </Form.Item>
            <Form.Item name="description" label="描述">
              <Input.TextArea rows={3} maxLength={500} />
            </Form.Item>
          </div>
          <div style={{ display: wizardStep === 1 ? 'block' : 'none' }}>
            <Space direction="vertical" style={{ width: '100%' }}>
              <Space>
                <Button onClick={() => setPickerOpen(true)}>浏览目录…</Button>
                {selectedWorkdir !== null && <Typography.Text code>{selectedWorkdir.path}</Typography.Text>}
              </Space>
              {selectedWorkdir !== null && (
                <Typography.Text type="secondary">
                  类型：{selectedWorkdir.inspection.kind === 'empty' ? '空目录' : '已有内容'}｜条目{' '}
                  {selectedWorkdir.inspection.entryCount}｜{selectedWorkdir.inspection.writable ? '可写' : '不可写'}
                </Typography.Text>
              )}
            </Space>
          </div>
          <div style={{ display: wizardStep === 2 ? 'block' : 'none' }}>
            <Form.Item name="members" label="团队成员（默认全选 8 个内置模板）">
              <Checkbox.Group
                options={templates
                  .filter((template) => template.source === 'builtin' && template.enabled)
                  .map((template) => ({ label: `${template.name}（${template.roleId}）`, value: template.roleId }))}
              />
            </Form.Item>
          </div>
        </Form>
      </Modal>

      <DirectoryPicker
        open={pickerOpen}
        onCancel={() => setPickerOpen(false)}
        onPick={(path, inspection) => {
          setSelectedWorkdir({ path, inspection })
          setPickerOpen(false)
        }}
      />
    </Space>
  )
}
