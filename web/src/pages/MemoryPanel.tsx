import { Alert, Button, Card, Input, List, Select, Space, Table, Tag, Typography } from 'antd'
import { useCallback, useEffect, useState } from 'react'
import { describeError } from '../api/client'
import {
  memoryApi,
  type MemoryEntry,
  type MemoryScope,
  type MemoryState,
  type SearchHit,
  type SearchStats,
} from '../api/memory'

const TYPE_LABEL: Record<string, string> = {
  fact: '事实',
  decision: '决策',
  preference: '偏好',
  commitment: '承诺',
  requirement: '需求',
  progress: '进度',
  artifact_index: '产出索引',
}

function hitLocation(hit: SearchHit): string {
  return hit.scope === 'session' ? `${hit.sessionId ?? '?'} #${hit.seq ?? 0}` : `记忆 ${hit.entryId ?? '?'}`
}

/**
 * 记忆与检索面板（S5）：L3 条目只读浏览 + 项目级关键词检索（结果带跳转定位）。
 * 用户（老板）视角：不受可见性限制；Agent 侧检索走 `session_search`/`memory_search` 工具。
 */
export function MemoryPanel({ projectId }: { readonly projectId: string }) {
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [scope, setScope] = useState<MemoryScope | 'all'>('all')
  const [state, setState] = useState<MemoryState | 'all'>('active')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null)
  const [stats, setStats] = useState<SearchStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const listed = await memoryApi.list(projectId, {
        ...(scope === 'all' ? {} : { scope }),
        ...(state === 'all' ? {} : { state }),
      })
      setEntries(listed.entries)
      setStats(await memoryApi.stats(projectId))
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    }
  }, [projectId, scope, state])

  useEffect(() => {
    void load()
  }, [load])

  const runSearch = async (): Promise<void> => {
    if (query.trim().length === 0) {
      setHits(null)
      return
    }
    setBusy(true)
    try {
      const result = await memoryApi.search(projectId, query.trim())
      setHits([...result.sessionHits, ...result.memoryHits])
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const reindex = async (): Promise<void> => {
    setBusy(true)
    try {
      setStats(await memoryApi.reindex(projectId))
      setError(null)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {error !== null && <Alert type="error" showIcon message={error} />}
      <Card
        size="small"
        title="检索（中文按二元组匹配；命中可直接定位到会话 seq）"
        extra={
          <Space>
            <Typography.Text type="secondary">
              {stats === null ? '' : `索引：${stats.documents} 文档 / ${stats.tokens} 词元`}
            </Typography.Text>
            <Button size="small" loading={busy} onClick={() => void reindex()}>
              重建索引
            </Button>
          </Space>
        }
      >
        <Space.Compact style={{ width: '100%' }}>
          <Input.Search
            value={query}
            placeholder="搜索会话与记忆，例如：登录模块"
            onChange={(event) => setQuery(event.target.value)}
            onSearch={() => void runSearch()}
            loading={busy}
            enterButton="检索"
          />
        </Space.Compact>
        {hits !== null && (
          <List
            size="small"
            style={{ marginTop: 12 }}
            dataSource={hits === null ? [] : [...hits]}
            locale={{ emptyText: '没有命中' }}
            renderItem={(hit) => (
              <List.Item>
                <Space direction="vertical" size={2} style={{ width: '100%' }}>
                  <Space size={6}>
                    <Tag color={hit.scope === 'session' ? 'blue' : 'purple'}>
                      {hit.scope === 'session' ? '会话' : '记忆'}
                    </Tag>
                    <Typography.Text code>{hitLocation(hit)}</Typography.Text>
                    {hit.kind !== null && <Tag>{hit.kind}</Tag>}
                    <Typography.Text type="secondary">score={hit.score}</Typography.Text>
                    {hit.tokens.map((token) => (
                      <Tag key={token}>{token}</Tag>
                    ))}
                  </Space>
                  <Typography.Text>{hit.text}</Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      <Card
        size="small"
        title={`记忆条目（${entries.length} 条；全局记忆 + 各角色个人记忆）`}
        extra={
          <Space>
            <Select
              size="small"
              value={scope}
              style={{ width: 120 }}
              onChange={(value) => setScope(value)}
              options={[
                { value: 'all', label: '全部范围' },
                { value: 'global', label: '全局记忆' },
                { value: 'agent', label: '角色记忆' },
              ]}
            />
            <Select
              size="small"
              value={state}
              style={{ width: 120 }}
              onChange={(value) => setState(value)}
              options={[
                { value: 'active', label: '生效中' },
                { value: 'superseded', label: '已被取代' },
                { value: 'all', label: '全部状态' },
              ]}
            />
          </Space>
        }
      >
        <Table<MemoryEntry>
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10 }}
          dataSource={entries}
          columns={[
            { title: '范围', width: 130, render: (_v, record) => (record.scope === 'global' ? '全局' : record.instanceId) },
            { title: '类型', dataIndex: 'type', width: 100, render: (type: string) => TYPE_LABEL[type] ?? type },
            { title: '内容', dataIndex: 'content' },
            {
              title: '来源',
              width: 190,
              render: (_v, record) => (
                <Typography.Text code>{`${record.source.sessionId}#${record.source.seq}`}</Typography.Text>
              ),
            },
            {
              title: '状态',
              width: 100,
              render: (_v, record) =>
                record.state === 'active' ? <Tag color="green">生效中</Tag> : <Tag>已被取代</Tag>,
            },
            {
              title: '标签',
              width: 140,
              render: (_v, record) => (
                <Space size={4} wrap>
                  {record.tags.map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </Space>
              ),
            },
          ]}
        />
      </Card>
      <Typography.Text type="secondary">
        说明：记忆是"跨会话稳定知识"（L3）；会话原文与滚动摘要仍是真相源（L1/L2），可用上方检索按 seq 定位。
      </Typography.Text>
    </Space>
  )
}
