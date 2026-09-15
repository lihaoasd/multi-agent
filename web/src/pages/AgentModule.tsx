import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { agentTemplateApi, type AgentTemplateView, type TemplatePatch } from '../api/agentTemplates'
import { describeError } from '../api/client'
import { modelConfigApi, type ModelView } from '../api/modelConfig'

const LOOP_STRATEGIES = [
  { value: 'direct', label: 'direct（单轮直答）' },
  { value: 'reflective', label: 'reflective（生成-自查-修订）' },
  { value: 'plan-execute', label: 'plan-execute（计划-执行）' },
]

interface EditFormValues {
  systemPrompt: string
  strategy: string
  maxIterations?: number
  toolBudget?: number
  stepModelOverride?: string
  defaultModel?: string
}

/**
 * Agent 模块（首页）：模板库展示 + 本轮开放的三项配置（提示词 / loop / 模型）。
 * 内置模板只读，须"基于内置复制新建"（D16-⑤ / agent-templates.md §4）。
 */
export function AgentModule() {
  const [templates, setTemplates] = useState<AgentTemplateView[]>([])
  const [models, setModels] = useState<ModelView[]>([])
  const [scenario, setScenario] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [detail, setDetail] = useState<AgentTemplateView | null>(null)
  const [copySource, setCopySource] = useState<AgentTemplateView | null>(null)
  const [history, setHistory] = useState<string[] | null>(null)
  const [editForm] = Form.useForm<EditFormValues>()
  const [copyForm] = Form.useForm<{ roleId: string; name: string }>()

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [templateList, modelList] = await Promise.all([
        agentTemplateApi.list(scenario),
        modelConfigApi.listModels(),
      ])
      setTemplates(templateList)
      setModels(modelList)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoading(false)
    }
  }, [scenario])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const modelOptions = models
    .filter((model) => model.enabled)
    .map((model) => ({ value: model.id, label: `${model.displayName}（${model.providerName}）` }))

  const openEdit = (template: AgentTemplateView): void => {
    setDetail(template)
    const params = template.defaultLoop.params as { maxIterations?: number; toolBudget?: number; stepModelOverride?: string }
    editForm.setFieldsValue({
      systemPrompt: template.systemPrompt,
      strategy: template.defaultLoop.strategy,
      maxIterations: params.maxIterations,
      toolBudget: params.toolBudget,
      stepModelOverride: params.stepModelOverride,
      defaultModel: template.defaultModel ?? undefined,
    })
  }

  const saveEdit = async (): Promise<void> => {
    if (detail === null) return
    const values = await editForm.validateFields()
    const params: Record<string, unknown> = {}
    if (values.maxIterations !== undefined) params['maxIterations'] = values.maxIterations
    if (values.toolBudget !== undefined) params['toolBudget'] = values.toolBudget
    if (values.stepModelOverride !== undefined) params['stepModelOverride'] = values.stepModelOverride
    const patch: TemplatePatch = {
      systemPrompt: values.systemPrompt,
      defaultLoop: { strategy: values.strategy, params },
      defaultModel: values.defaultModel ?? null,
    }
    try {
      const updated = await agentTemplateApi.update(detail.roleId, patch)
      message.success('已保存；将影响此后新建的实例')
      setDetail(updated)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const submitCopy = async (): Promise<void> => {
    const values = await copyForm.validateFields()
    if (copySource === null) return
    try {
      await agentTemplateApi.create({ roleId: values.roleId, copyFrom: copySource.roleId, name: values.name })
      message.success('已基于模板复制新建')
      setCopySource(null)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const toggleEnabled = async (template: AgentTemplateView, enabled: boolean): Promise<void> => {
    try {
      await agentTemplateApi.setEnabled(template.roleId, enabled)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const showHistory = async (template: AgentTemplateView): Promise<void> => {
    try {
      setHistory(await agentTemplateApi.history(template.roleId))
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message="Agent 模板加载失败" description={error} />}
      <Alert
        type="info"
        showIcon
        message="本轮开放三项配置：提示词 / agent loop / 模型"
        description="模板编辑只影响此后新建的实例（实例创建时快照）；工具与工具包挂载仍只读。内置模板不可原地修改，请用「复制新建」。"
      />

      <Card
        title="Agent 模板库"
        extra={
          <Space>
            <Select
              allowClear
              placeholder="全部场景"
              style={{ width: 160 }}
              value={scenario}
              onChange={(value?: string) => setScenario(value)}
              options={[
                { value: 'software', label: 'software' },
                { value: 'general', label: 'general（预留）' },
              ]}
            />
            <Button onClick={() => void refresh()} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      >
        <Table<AgentTemplateView>
          rowKey="roleId"
          size="small"
          dataSource={templates}
          pagination={false}
          columns={[
            { title: 'roleId', dataIndex: 'roleId', width: 110 },
            { title: '名称', dataIndex: 'name', width: 150 },
            { title: '分类', dataIndex: 'category', width: 120 },
            { title: '场景', dataIndex: 'scenario', width: 100, render: (value: string) => <Tag>{value}</Tag> },
            {
              title: '默认模型',
              dataIndex: 'defaultModel',
              render: (_value, record) =>
                record.defaultModel === null ? (
                  '—'
                ) : (
                  <Space size={4}>
                    <Tag color={record.defaultModelAvailable ? 'green' : 'red'}>
                      {record.defaultModelLabel ?? record.defaultModel}
                    </Tag>
                    {!record.defaultModelAvailable && <Typography.Text type="danger">模型不可用</Typography.Text>}
                  </Space>
                ),
            },
            { title: 'loop', dataIndex: 'defaultLoop', render: (loop: { strategy: string }) => <Tag>{loop.strategy}</Tag> },
            {
              title: '来源',
              dataIndex: 'source',
              width: 90,
              render: (value: string) => <Tag color={value === 'builtin' ? 'blue' : 'gold'}>{value}</Tag>,
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 80,
              render: (enabled: boolean, record) =>
                record.source === 'builtin' ? (
                  <Tag>固定</Tag>
                ) : (
                  <Switch size="small" checked={enabled} onChange={(checked) => void toggleEnabled(record, checked)} />
                ),
            },
            {
              title: '操作',
              width: 240,
              render: (_value, record) => (
                <Space size={4}>
                  <Button size="small" onClick={() => openEdit(record)}>
                    {record.editable ? '编辑' : '查看'}
                  </Button>
                  <Button
                    size="small"
                    onClick={() => {
                      setCopySource(record)
                      copyForm.setFieldsValue({ roleId: `${record.roleId}-copy`, name: `${record.name}（副本）` })
                    }}
                  >
                    复制新建
                  </Button>
                  <Button size="small" onClick={() => void showHistory(record)}>
                    历史
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        open={detail !== null}
        title={detail === null ? '' : `${detail.name}（${detail.roleId}）`}
        width={720}
        onClose={() => setDetail(null)}
        extra={
          detail?.editable === true ? (
            <Button type="primary" onClick={() => void saveEdit()}>
              保存
            </Button>
          ) : (
            <Tag>只读预览</Tag>
          )
        }
      >
        {detail !== null && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions column={1} size="small">
              <Descriptions.Item label="职责">{detail.description || '—'}</Descriptions.Item>
              <Descriptions.Item label="场景">{detail.scenario}</Descriptions.Item>
              <Descriptions.Item label="工具包">{detail.packages.join('、')}</Descriptions.Item>
              <Descriptions.Item label="产出类型">{detail.artifactTypes.join('、') || '—'}</Descriptions.Item>
            </Descriptions>
            <Form form={editForm} layout="vertical" disabled={!detail.editable}>
              <Form.Item
                name="systemPrompt"
                label="系统提示词"
                rules={[{ required: true, message: '提示词不能为空' }]}
                extra="仅第 1 段（角色配置段）可编辑；平台注入段由运行期追加"
              >
                <Input.TextArea rows={12} />
              </Form.Item>
              <Space size="middle" wrap>
                <Form.Item name="strategy" label="loop 策略" rules={[{ required: true }]}>
                  <Select style={{ width: 240 }} options={LOOP_STRATEGIES} />
                </Form.Item>
                <Form.Item name="maxIterations" label="maxIterations（1~20）">
                  <InputNumber min={1} max={20} />
                </Form.Item>
                <Form.Item name="toolBudget" label="toolBudget（0~200）">
                  <InputNumber min={0} max={200} />
                </Form.Item>
                <Form.Item name="stepModelOverride" label="步骤级模型覆盖">
                  <Select allowClear style={{ width: 240 }} options={modelOptions} />
                </Form.Item>
                <Form.Item name="defaultModel" label="默认模型">
                  <Select allowClear style={{ width: 240 }} options={modelOptions} />
                </Form.Item>
              </Space>
            </Form>
            {detail.editable && (
              <Typography.Text type="secondary">
                保存后仅影响此后新建的实例；既有实例保留创建时的快照。
              </Typography.Text>
            )}
          </Space>
        )}
      </Drawer>

      <Modal
        open={copySource !== null}
        title={copySource === null ? '复制新建' : `基于「${copySource.name}」复制新建`}
        onCancel={() => setCopySource(null)}
        onOk={() => void submitCopy()}
        okText="创建"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={copyForm} layout="vertical">
          <Form.Item
            name="roleId"
            label="新 roleId"
            rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{1,31}$/, message: '小写字母/数字/连字符' }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={history !== null}
        title="配置历史快照"
        onCancel={() => setHistory(null)}
        footer={null}
      >
        {history === null || history.length === 0 ? (
          <Typography.Text type="secondary">暂无历史快照（只有用户模板在保存时留痕）</Typography.Text>
        ) : (
          <Space direction="vertical">
            {history.map((file) => (
              <Typography.Text key={file} code>
                {file}
              </Typography.Text>
            ))}
          </Space>
        )}
      </Modal>
    </Space>
  )
}
