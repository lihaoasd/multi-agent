import {
  Alert,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError, referrerLabels } from '../api/client'
import {
  modelConfigApi,
  type ModelPresetView,
  type ModelView,
  type ProviderKind,
  type ProviderView,
  type UnconfiguredAgentRef,
} from '../api/modelConfig'

const KIND_OPTIONS: { value: ProviderKind; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama（本地）' },
]

interface ProviderFormValues {
  presetId?: string
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  credentialMode: 'file' | 'env'
  credentialValue?: string
  credentialEnvName?: string
  timeoutMs?: number
}

export function ModelModule() {
  const [presets, setPresets] = useState<ModelPresetView[]>([])
  const [providers, setProviders] = useState<ProviderView[]>([])
  const [models, setModels] = useState<ModelView[]>([])
  /** 未配置模型的 Agent（S11 起展示计数；S14 起只能靠模板默认/实例覆盖消除） */
  const [unconfiguredAgents, setUnconfiguredAgents] = useState<readonly UnconfiguredAgentRef[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [providerForm] = Form.useForm<ProviderFormValues>()
  const [editingProvider, setEditingProvider] = useState<ProviderView | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [modelForm] = Form.useForm<{ id: string; providerId: string; model: string; displayName?: string; reasoning?: boolean }>()
  const [modelModalOpen, setModelModalOpen] = useState(false)
  const [discoverProvider, setDiscoverProvider] = useState<ProviderView | null>(null)
  const [discovered, setDiscovered] = useState<string[]>([])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [presetList, providerList, modelList, overview] = await Promise.all([
        modelConfigApi.listPresets(),
        modelConfigApi.listProviders(),
        modelConfigApi.listModels(),
        modelConfigApi.overview(),
      ])
      setPresets(presetList)
      setProviders(providerList)
      setModels(modelList)
      setUnconfiguredAgents(overview.unconfiguredAgents.items)
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

  const openCreateProvider = (preset?: ModelPresetView): void => {
    setEditingProvider(null)
    providerForm.setFieldsValue({
      presetId: preset?.presetId,
      id: preset?.presetId ?? '',
      name: preset?.name ?? '',
      kind: preset?.kind ?? 'openai-compatible',
      baseUrl: preset?.baseUrl ?? '',
      credentialMode: 'file',
      credentialValue: '',
      credentialEnvName: '',
      timeoutMs: 60000,
    })
    setDrawerOpen(true)
  }

  const openEditProvider = (provider: ProviderView): void => {
    setEditingProvider(provider)
    providerForm.setFieldsValue({
      presetId: provider.presetId ?? undefined,
      id: provider.id,
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      credentialMode: provider.credential.mode,
      credentialValue: '',
      credentialEnvName: provider.credential.envName ?? '',
      timeoutMs: provider.timeoutMs ?? 60000,
    })
    setDrawerOpen(true)
  }

  const submitProvider = async (): Promise<void> => {
    const values = await providerForm.validateFields()
    const credential =
      values.credentialMode === 'env'
        ? { mode: 'env' as const, envName: values.credentialEnvName ?? '' }
        : values.credentialValue === undefined || values.credentialValue === ''
          ? undefined // 编辑时省略=保持原值
          : { mode: 'file' as const, value: values.credentialValue }
    try {
      if (editingProvider === null) {
        await modelConfigApi.createProvider({
          id: values.id,
          name: values.name,
          kind: values.kind,
          baseUrl: values.baseUrl,
          ...(credential === undefined ? {} : { credential }),
          presetId: values.presetId ?? null,
          ...(values.timeoutMs === undefined ? {} : { timeoutMs: values.timeoutMs }),
        })
        message.success('供应商已创建')
      } else {
        await modelConfigApi.updateProvider(editingProvider.id, {
          name: values.name,
          kind: values.kind,
          baseUrl: values.baseUrl,
          ...(credential === undefined ? {} : { credential }),
          ...(values.timeoutMs === undefined ? {} : { timeoutMs: values.timeoutMs }),
        })
        message.success('供应商已更新（即时生效，无需重启）')
      }
      setDrawerOpen(false)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const testProvider = async (provider: ProviderView): Promise<void> => {
    try {
      const result = await modelConfigApi.testProvider(provider.id, 'models')
      message.success(`连通性正常（${result.latencyMs} ms，${result.models?.length ?? 0} 个模型）`)
    } catch (cause) {
      message.error(`连通性测试失败：${describeError(cause)}`)
    }
  }

  const removeProvider = async (provider: ProviderView): Promise<void> => {
    try {
      await modelConfigApi.deleteProvider(provider.id)
      message.success('供应商已删除')
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const openDiscover = async (provider: ProviderView): Promise<void> => {
    try {
      const result = await modelConfigApi.discoverModels(provider.id)
      setDiscovered(result.models)
      setDiscoverProvider(provider)
      if (result.models.length === 0) message.info('该供应商未返回任何模型，请手工添加')
    } catch (cause) {
      message.error(`拉取模型列表失败：${describeError(cause)}`)
    }
  }

  const importDiscovered = async (): Promise<void> => {
    if (discoverProvider === null) return
    try {
      const result = await modelConfigApi.bulkCreateModels(
        discoverProvider.id,
        discovered.map((model) => ({ model })),
      )
      message.success(`已登记 ${result.created.length} 个模型${result.skipped.length > 0 ? `，跳过 ${result.skipped.length} 个已存在` : ''}`)
      setDiscoverProvider(null)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const submitModel = async (): Promise<void> => {
    const values = await modelForm.validateFields()
    try {
      // S40/D43：「思考」勾选 → 能力标记（后端据此决定是否下发思考参数）
      const { reasoning, ...rest } = values
      await modelConfigApi.createModel({
        ...rest,
        capabilities: ['chat', 'stream', 'tools', ...(reasoning === true ? ['reasoning'] : [])],
      })
      message.success('模型条目已创建')
      setModelModalOpen(false)
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  /** S40/D43：开关模型条目的「思考」能力（后端据此决定要不要下发思考参数） */
  const toggleReasoning = async (model: ModelView, enabled: boolean): Promise<void> => {
    const next = model.capabilities.filter((item) => item !== 'reasoning')
    try {
      await modelConfigApi.updateModel(model.id, {
        capabilities: enabled ? [...next, 'reasoning'] : next,
      })
      message.success(enabled ? '已启用思考：请求会带思考参数，思考内容显示在会话流' : '已关闭思考')
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  const toggleModel = async (model: ModelView, enabled: boolean): Promise<void> => {    try {
      await modelConfigApi.updateModel(model.id, { enabled })
      await refresh()
    } catch (cause) {
      const labels = referrerLabels(
        cause instanceof Error && 'detail' in cause
          ? ((cause as { detail?: Record<string, unknown> }).detail ?? undefined)
          : undefined,
      )
      if (labels.length > 0) {
        Modal.confirm({
          title: '该模型被引用，仍要停用吗？',
          content: `引用者：${labels.join('、')}。停用后这些角色在运行期会报 ERR_MODEL。`,
          okText: '停用',
          cancelText: '取消',
          onOk: async () => {
            await modelConfigApi.updateModel(model.id, { enabled, confirm: true })
            await refresh()
          },
        })
      } else {
        message.error(describeError(cause))
      }
    }
  }

  const removeModel = async (model: ModelView): Promise<void> => {
    try {
      await modelConfigApi.deleteModel(model.id)
      message.success('模型条目已删除')
      await refresh()
    } catch (cause) {
      message.error(describeError(cause))
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message="模型配置加载失败" description={error} />}
      <Alert
        type="info"
        showIcon
        message="密钥安全"
        description="密钥只存本机 data/model-config.json（不入库）或引用环境变量；页面与接口均只显示掩码。删除被引用的供应商/模型会被拒绝。"
      />

      <Card
        title="供应商"
        extra={
          <Space>
            <Button onClick={() => void refresh()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" onClick={() => openCreateProvider()}>
              新增供应商
            </Button>
          </Space>
        }
      >
        <Space size="small" wrap style={{ marginBottom: 12 }}>
          {presets.map((preset) => (
            <Tooltip key={preset.presetId} title={`${preset.kind} · ${preset.baseUrl || '—'} · ${preset.credentialHint}`}>
              <Button size="small" onClick={() => openCreateProvider(preset)}>
                + {preset.name}
              </Button>
            </Tooltip>
          ))}
        </Space>

        <Table<ProviderView>
          rowKey="id"
          size="small"
          dataSource={providers}
          pagination={false}
          columns={[
            { title: 'id', dataIndex: 'id', width: 140 },
            { title: '名称', dataIndex: 'name' },
            { title: '协议', dataIndex: 'kind', width: 150, render: (kind: ProviderKind) => <Tag>{kind}</Tag> },
            { title: 'baseUrl', dataIndex: 'baseUrl', ellipsis: true },
            {
              title: '密钥',
              dataIndex: 'credential',
              width: 180,
              render: (_value, record) => (
                <Space size={4}>
                  <Tag color={record.credential.hasValue ? 'green' : 'default'}>{record.credential.mode}</Tag>
                  <Typography.Text code>{record.credential.masked || '—'}</Typography.Text>
                </Space>
              ),
            },
            { title: '模型数', dataIndex: 'modelCount', width: 80 },
            {
              title: '操作',
              width: 280,
              render: (_value, record) => (
                <Space size={4}>
                  <Button size="small" onClick={() => void testProvider(record)}>
                    测试连接
                  </Button>
                  <Button size="small" onClick={() => void openDiscover(record)}>
                    拉取模型
                  </Button>
                  <Button size="small" onClick={() => openEditProvider(record)}>
                    编辑
                  </Button>
                  <Button size="small" danger onClick={() => void removeProvider(record)}>
                    删除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Card
        title="模型条目"
        extra={
          <Button
            type="primary"
            onClick={() => {
              modelForm.setFieldsValue({ id: '', providerId: providers[0]?.id ?? '', model: '', displayName: '' })
              setModelModalOpen(true)
            }}
          >
            新增模型
          </Button>
        }
      >
        <Table<ModelView>
          rowKey="id"
          size="small"
          dataSource={models}
          pagination={false}
          columns={[
            { title: 'id', dataIndex: 'id', width: 180 },
            { title: '真实模型名', dataIndex: 'model' },
            { title: '展示名', dataIndex: 'displayName' },
            { title: '供应商', dataIndex: 'providerName', width: 160 },
            {
              title: '能力',
              dataIndex: 'capabilities',
              render: (capabilities: readonly string[]) => (
                <Space size={4}>
                  {capabilities.map((item) => (
                    <Tag key={item}>{item}</Tag>
                  ))}
                </Space>
              ),
            },
            {
              // S40/D43：勾上「思考」→ 请求带思考参数 + 思考落进会话流；显示 [reasoning] 标识
              title: '思考',
              dataIndex: 'capabilities',
              width: 90,
              render: (capabilities: readonly string[], record) => (
                <Tooltip title="启用思考模式：请求带该协议的思考参数，思考内容显示在会话流「思考」条目（模型不支持就不要开）">
                  <Switch
                    size="small"
                    checked={capabilities.includes('reasoning')}
                    onChange={(checked) => void toggleReasoning(record, checked)}
                  />
                </Tooltip>
              ),
            },
            {
              title: '被引用',
              dataIndex: 'referrers',
              render: (referrers: readonly string[]) =>
                referrers.length === 0 ? '—' : referrers.map((item) => <Tag key={item}>{item}</Tag>),
            },
            {
              title: '启用',
              dataIndex: 'enabled',
              width: 90,
              render: (enabled: boolean, record) => (
                <Switch
                  size="small"
                  checked={enabled}
                  onChange={(checked) => void toggleModel(record, checked)}
                />
              ),
            },
            {
              title: '操作',
              width: 90,
              render: (_value, record) => (
                <Button size="small" danger onClick={() => void removeModel(record)}>
                  删除
                </Button>
              ),
            },
          ]}
        />
      </Card>

      {/* S14：原「默认路由」卡片（全局默认模型 + plan/act/critique 步骤覆盖）已随该功能删除；
          未配置模型只能通过「Agent 模块批量配模板默认模型」或「项目内实例覆盖」解决 */}
      {unconfiguredAgents.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`当前有 ${unconfiguredAgents.length} 个 Agent 未配置模型`}
          description={`这些 Agent 启动回合会报 ERR_MODEL。请到「Agent」模块勾选模板并一键配置默认模型（影响此后新建实例），或在项目内为既有实例选择模型（生效链只有两级：实例覆盖 → 模板快照）。未配置示例：${unconfiguredAgents
            .slice(0, 3)
            .map((item) => `${item.projectName}/${item.displayName}`)
            .join('、')}${unconfiguredAgents.length > 3 ? ' …' : ''}`}
        />
      )}

      <Modal
        open={drawerOpen}
        title={editingProvider === null ? '新增供应商' : `编辑供应商：${editingProvider.name}`}
        onCancel={() => setDrawerOpen(false)}
        onOk={() => void submitProvider()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={providerForm} layout="vertical">
          <Form.Item name="presetId" label="预置模板">
            <Select
              allowClear
              placeholder="选择预置（可预填协议与地址）"
              options={presets.map((preset) => ({ value: preset.presetId, label: `${preset.name}（${preset.kind}）` }))}
              onChange={(presetId?: string) => {
                const preset = presets.find((item) => item.presetId === presetId)
                if (preset === undefined) return
                providerForm.setFieldsValue({
                  id: preset.presetId,
                  name: preset.name,
                  kind: preset.kind,
                  baseUrl: preset.baseUrl,
                })
              }}
            />
          </Form.Item>
          <Form.Item name="id" label="id" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{1,31}$/, message: '小写字母/数字/连字符，2~32 位' }]}>
            <Input disabled={editingProvider !== null} placeholder="deepseek" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="DeepSeek" />
          </Form.Item>
          <Form.Item name="kind" label="协议" rules={[{ required: true }]}>
            <Select options={KIND_OPTIONS} />
          </Form.Item>
          <Form.Item name="baseUrl" label="baseUrl" rules={[{ required: true }]}>
            <Input placeholder="https://api.deepseek.com/v1" />
          </Form.Item>
          <Form.Item name="credentialMode" label="凭证方式" rules={[{ required: true }]}>
            <Select
              options={[
                { value: 'file', label: '明文存本机（data/model-config.json，不入库）' },
                { value: 'env', label: '引用环境变量' },
              ]}
            />
          </Form.Item>
          <Form.Item noStyle shouldUpdate={(prev, next) => prev.credentialMode !== next.credentialMode}>
            {({ getFieldValue }) =>
              getFieldValue('credentialMode') === 'env' ? (
                <Form.Item name="credentialEnvName" label="环境变量名" rules={[{ required: true }]}>
                  <Input placeholder="DEEPSEEK_API_KEY" />
                </Form.Item>
              ) : (
                <Form.Item name="credentialValue" label="密钥" extra="编辑时留空表示保持原值">
                  <Input.Password placeholder="sk-…" autoComplete="off" />
                </Form.Item>
              )
            }
          </Form.Item>
          <Form.Item
            name="timeoutMs"
            label="空闲超时（毫秒）"
            // S52/D55：这是"多久没有数据到达算失败"，不是整个请求的总时长——长输出不会被砍
            extra="多久没收到数据算失败（不是总时长上限）；模型边想边写很久也不会被中断，卡住才超时"
          >
            <InputNumber min={1000} max={600000} step={1000} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={modelModalOpen}
        title="新增模型条目"
        onCancel={() => setModelModalOpen(false)}
        onOk={() => void submitModel()}
        okText="保存"
        cancelText="取消"
        destroyOnHidden
      >
        <Form form={modelForm} layout="vertical">
          <Form.Item name="id" label="id" rules={[{ required: true, pattern: /^[a-z0-9][a-z0-9-]{1,31}$/, message: '小写字母/数字/连字符，2~32 位' }]}>
            <Input placeholder="deepseek-chat" />
          </Form.Item>
          <Form.Item name="providerId" label="供应商" rules={[{ required: true }]}>
            <Select options={providers.map((provider) => ({ value: provider.id, label: provider.name }))} />
          </Form.Item>
          <Form.Item name="model" label="真实模型名" rules={[{ required: true }]}>
            <Input placeholder="deepseek-chat（火山方舟填推理接入点 id）" />
          </Form.Item>
          <Form.Item name="displayName" label="展示名">
            <Input placeholder="DeepSeek Chat" />
          </Form.Item>
          {/* S40/D43：勾选后请求会带上该协议的思考参数（openai-compatible 用 reasoning_effort，
              ollama 用 think，gemini 用 includeThoughts，anthropic 用 thinking），
              且模型返回的思考会落到会话流的「思考」条目里 */}
          <Form.Item
            name="reasoning"
            label="思考（think）"
            valuePropName="checked"
            extra="该模型支持思考/思维链时勾选：请求会带思考参数，思考内容显示在会话流「思考」条目（不确定就别勾——陌生参数可能被厂商拒绝）"
          >
            <Checkbox>启用思考模式</Checkbox>
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={discoverProvider !== null}
        title={`从 ${discoverProvider?.name ?? ''} 拉取到 ${discovered.length} 个模型`}
        onCancel={() => setDiscoverProvider(null)}
        onOk={() => void importDiscovered()}
        okText="全部登记"
        cancelText="取消"
      >
        <Space wrap size={4}>
          {discovered.map((model) => (
            <Tag key={model}>{model}</Tag>
          ))}
        </Space>
      </Modal>
    </Space>
  )
}
