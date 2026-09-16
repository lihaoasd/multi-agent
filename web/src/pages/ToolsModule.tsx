import { Alert, Button, Card, Descriptions, Modal, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { describeError } from '../api/client'
import { toolApi, type ToolPackageView, type ToolView } from '../api/platform'

/**
 * 工具模块（D19-② / S12）：
 * - 只展示**工具包**列表（MVP 只读，不能制作/卸载）；
 * - 包内工具在「详情」弹窗里查看（不再单列"已注册工具"表格）；
 * - 不再展示 agent loop 策略列表（loop 在选择角色/实例配置时的下拉里可选）。
 */

/** 包内工具 + 注册信息（注册信息来自 `/api/tools`，按名字关联） */
interface PackageToolRow {
  readonly name: string
  readonly registered: boolean
  readonly info?: ToolView
}

export function ToolsModule() {
  const [packages, setPackages] = useState<ToolPackageView[]>([])
  const [tools, setTools] = useState<ToolView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<ToolPackageView | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [packageList, toolList] = await Promise.all([toolApi.packages(), toolApi.tools()])
      setPackages(packageList)
      setTools(toolList)
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toolIndex = useMemo(() => new Map(tools.map((tool) => [tool.name, tool])), [tools])

  const rowsOf = (pkg: ToolPackageView): readonly PackageToolRow[] =>
    pkg.tools.map((item) => {
      const info = toolIndex.get(item.name)
      return { name: item.name, registered: item.registered, ...(info === undefined ? {} : { info }) }
    })

  const unregisteredCount = (pkg: ToolPackageView): number =>
    pkg.tools.filter((item) => !item.registered).length

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Alert
        type="info"
        showIcon
        message="MVP 只展示：不能制作/卸载工具包"
        description="点击任一工具包的「详情」查看该包声明的工具、用途、风险与审批要求；标注「未实现」的工具已随包声明，但当前版本尚未注册；所有工具执行都要经过策略引擎（deny > approval > allow）。"
      />
      <Card size="small" title={`工具包（${packages.length} 个基础包，全员必选）`}>
        <Table<ToolPackageView>
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={packages}
          columns={[
            { title: '包', dataIndex: 'name', width: 140 },
            { title: 'id', dataIndex: 'id', width: 100 },
            { title: '说明', dataIndex: 'description' },
            {
              title: '工具',
              width: 180,
              render: (_value, record) => {
                const missing = unregisteredCount(record)
                return (
                  <Space size={4}>
                    <Tag>{`${record.tools.length} 个`}</Tag>
                    {missing > 0 && <Tag color="default">{`未实现 ${missing}`}</Tag>}
                  </Space>
                )
              },
            },
            { title: '最高风险', dataIndex: 'riskMax', width: 100 },
            { title: '网络', dataIndex: 'network', width: 90 },
            {
              title: '操作',
              width: 90,
              render: (_value, record) => (
                <Button size="small" onClick={() => setDetail(record)}>
                  详情
                </Button>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={detail !== null}
        title={detail === null ? '' : `工具包详情：${detail.name}`}
        width={860}
        footer={null}
        onCancel={() => setDetail(null)}
        destroyOnHidden
      >
        {detail !== null && (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Descriptions column={2} size="small">
              <Descriptions.Item label="包 id">{detail.id}</Descriptions.Item>
              <Descriptions.Item label="名称">{detail.name}</Descriptions.Item>
              <Descriptions.Item label="说明" span={2}>
                {detail.description}
              </Descriptions.Item>
              <Descriptions.Item label="最高风险">{detail.riskMax}</Descriptions.Item>
              <Descriptions.Item label="网络">{detail.network}</Descriptions.Item>
              <Descriptions.Item label="全员必选">{detail.required ? '是' : '否'}</Descriptions.Item>
              <Descriptions.Item label="来源">{detail.source}</Descriptions.Item>
            </Descriptions>
            <Table<PackageToolRow>
              rowKey="name"
              size="small"
              pagination={false}
              dataSource={rowsOf(detail)}
              columns={[
                { title: '工具', dataIndex: 'name', width: 170 },
                {
                  title: '状态',
                  dataIndex: 'registered',
                  width: 90,
                  render: (registered: boolean) =>
                    registered ? <Tag color="green">已注册</Tag> : <Tag color="default">未实现</Tag>,
                },
                {
                  title: '说明',
                  render: (_value, record) => record.info?.description ?? '—',
                },
                {
                  title: '风险',
                  width: 80,
                  render: (_value, record) => record.info?.risk ?? '—',
                },
                {
                  title: '需审批',
                  width: 90,
                  render: (_value, record) =>
                    record.info === undefined ? '—' : record.info.needsApproval ? '是' : '按策略',
                },
                {
                  title: '幂等',
                  width: 70,
                  render: (_value, record) => (record.info === undefined ? '—' : record.info.idempotent ? '是' : '否'),
                },
              ]}
            />
          </Space>
        )}
      </Modal>

      <Typography.Text type="secondary">
        说明：命令执行在项目工作目录内、结构化 argv（不经 shell）；高危命令与联网动作受策略与审批控制。
      </Typography.Text>
    </Space>
  )
}
