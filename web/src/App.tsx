import { Alert, Card, Descriptions, Layout, Spin, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { fetchHealth, type HealthResponse } from './api/health'

const { Header, Content } = Layout

/**
 * S0 空壳：只验证"前端 → 服务端 /health"链路与主题骨架。
 * 首页四模块（项目 / Agent / 模型 / 工具）在 S1 起逐步接入（docs/design/ui.md §2）。
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchHealth()
      .then((data) => {
        if (!cancelled) setHealth(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center' }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
          Agent Haness
        </Typography.Title>
      </Header>
      <Content style={{ padding: 24, maxWidth: 960, margin: '0 auto', width: '100%' }}>
        <Card title="服务状态">
          {error !== null && <Alert type="error" showIcon message="无法连接服务端" description={error} />}
          {error === null && health === null && <Spin tip="加载中…" />}
          {health !== null && (
            <Descriptions column={1} size="small">
              <Descriptions.Item label="状态">{health.status}</Descriptions.Item>
              <Descriptions.Item label="应用">{`${health.name} v${health.version}`}</Descriptions.Item>
              <Descriptions.Item label="运行时长">{`${Math.round(health.uptimeMs / 1000)} 秒`}</Descriptions.Item>
              <Descriptions.Item label="数据目录">{health.dataDir}</Descriptions.Item>
              <Descriptions.Item label="联网模式">{health.sandboxNetwork}</Descriptions.Item>
            </Descriptions>
          )}
        </Card>
        <Typography.Paragraph type="secondary" style={{ marginTop: 16 }}>
          当前为 S0 脚手架阶段：仅服务骨架与依赖门禁。四模块界面（项目 / Agent / 模型 / 工具）随后续阶段接入。
        </Typography.Paragraph>
      </Content>
    </Layout>
  )
}
