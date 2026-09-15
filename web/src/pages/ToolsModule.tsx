import { Alert, Card, Space, Table, Tag, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { describeError } from '../api/client'
import { toolApi, type ToolPackageView, type ToolView } from '../api/platform'

/** 工具模块（D19-②：MVP 只展示；`registered=false` 表示"已声明但当前版本不可用"） */
export function ToolsModule() {
  const [packages, setPackages] = useState<ToolPackageView[]>([])
  const [tools, setTools] = useState<ToolView[]>([])
  const [loops, setLoops] = useState<Array<{ name: string; description: string }>>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const [packageList, toolList, loopList] = await Promise.all([toolApi.packages(), toolApi.tools(), toolApi.loops()])
        setPackages(packageList)
        setTools(toolList)
        setLoops(loopList)
      } catch (cause) {
        setError(describeError(cause))
      }
    })()
  }, [])

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Alert
        type="info"
        showIcon
        message="MVP 只展示：不能制作/卸载工具包"
        description="标注「未实现」的工具已随包声明，但当前版本尚未注册（S5/S6 逐步补齐）；所有工具执行都要经过策略引擎（deny > approval > allow）。"
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
              dataIndex: 'tools',
              render: (list: ToolPackageView['tools']) => (
                <Space size={4} wrap>
                  {list.map((tool) => (
                    <Tag key={tool.name} color={tool.registered ? 'green' : 'default'}>
                      {tool.name}
                      {tool.registered ? '' : '（未实现）'}
                    </Tag>
                  ))}
                </Space>
              ),
            },
            { title: '最高风险', dataIndex: 'riskMax', width: 100 },
            { title: '网络', dataIndex: 'network', width: 90 },
          ]}
        />
      </Card>
      <Card size="small" title="agent loop 策略（可选）">
        <Table
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={loops}
          columns={[
            { title: '策略', dataIndex: 'name', width: 160 },
            { title: '说明', dataIndex: 'description' },
          ]}
        />
      </Card>
      <Card size="small" title={`已注册工具（${tools.length} 个）`}>
        <Table<ToolView>
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={tools}
          columns={[
            { title: '工具', dataIndex: 'name', width: 160 },
            { title: '包', dataIndex: 'package', width: 100 },
            { title: '说明', dataIndex: 'description' },
            { title: '风险', dataIndex: 'risk', width: 80 },
            { title: '需审批', dataIndex: 'needsApproval', width: 90, render: (value: boolean) => (value ? '是' : '按策略') },
            { title: '幂等', dataIndex: 'idempotent', width: 70, render: (value: boolean) => (value ? '是' : '否') },
          ]}
        />
      </Card>
      <Typography.Text type="secondary">
        说明：命令执行在项目工作目录内、结构化 argv（不经 shell）；高危命令与联网动作受策略与审批控制。
      </Typography.Text>
    </Space>
  )
}
