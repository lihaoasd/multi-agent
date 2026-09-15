import { Alert, Layout, Menu, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { fetchHealth, type HealthResponse } from './api/health'
import { AgentModule } from './pages/AgentModule'
import { ModelModule } from './pages/ModelModule'
import { ProjectModule } from './pages/ProjectModule'
import { ToolsModule } from './pages/ToolsModule'

const { Header, Content, Sider } = Layout

type ModuleKey = 'project' | 'agent' | 'model' | 'tools'

/**
 * 首页四模块（docs/design/ui.md §1：项目 / Agent / 模型 / 工具），默认进**项目**模块。
 * 已接入：项目（S2）、Agent（S1）、模型（S1）、工具（S4）。
 */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [healthError, setHealthError] = useState<string | null>(null)
  const [active, setActive] = useState<ModuleKey>('project')

  useEffect(() => {
    let cancelled = false
    fetchHealth()
      .then((data) => {
        if (!cancelled) setHealth(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setHealthError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <Typography.Title level={4} style={{ margin: 0, color: '#fff' }}>
          Agent Haness
        </Typography.Title>
        <Typography.Text style={{ color: 'rgba(255,255,255,0.65)' }}>
          {health === null
            ? '连接中…'
            : `v${health.version} · 数据目录 ${health.dataDir} · 联网 ${health.sandboxNetwork}`}
        </Typography.Text>
      </Header>
      <Layout>
        <Sider width={168} theme="light">
          <Menu
            mode="inline"
            selectedKeys={[active]}
            onClick={({ key }) => setActive(key as ModuleKey)}
            items={[
              { key: 'project', label: '项目' },
              { key: 'agent', label: 'Agent' },
              { key: 'model', label: '模型' },
              { key: 'tools', label: '工具' },
            ]}
          />
        </Sider>
        <Content style={{ padding: 24 }}>
          {healthError !== null && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              message="无法连接服务端"
              description={healthError}
            />
          )}
          {active === 'project' && <ProjectModule />}
          {active === 'model' && <ModelModule />}
          {active === 'agent' && <AgentModule />}
          {active === 'tools' && <ToolsModule />}
        </Content>
      </Layout>
    </Layout>
  )
}
